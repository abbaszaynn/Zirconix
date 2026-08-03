-- Zirconix — transfers now require a vote of confidence
--
-- Previously: a transfer under PKR 10 lac auto-confirmed, and one above it needed
-- a single other director. Now every transfer to a director is voted on:
--
--   under PKR 10 lac   2 votes  — the sender and the recipient
--   PKR 10 lac and up  4 votes  — sender, recipient, and two independent directors
--
-- WHAT THIS TRADES AWAY, deliberately and on the record: the sender now votes on
-- his own transfer, so the old separation-of-duties rule (approvals_approver_is_
-- not_submitter, a CHECK constraint) has to go. The replacement control is that
-- confirmation requires BOTH principals plus, above the threshold, two directors
-- with no stake in it. Nobody can move money alone.
--
-- The self-transfer hole this opens is closed explicitly: if the sender and the
-- recipient are the same person they are ONE principal, not two, so an extra
-- independent vote is required to make up the number. See v_principals below —
-- without it, a director could record a transfer to himself and confirm it with
-- a single vote.

-- ─────────────────────────────────────────────────────────────────────────────
-- Schema
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.disbursements
  add column required_votes smallint not null default 2
    check (required_votes between 2 and 8),
  add column approval_count smallint not null default 0
    check (approval_count >= 0);

comment on column public.disbursements.required_votes is
  'Total approvals needed. 2 below the threshold, 4 at or above it. Set by trigger, never by the client.';

-- The old rule. Its replacement is the multi-signature tally in
-- tally_disbursement_votes(), which cannot be satisfied by one person.
alter table public.approvals
  drop constraint approvals_approver_is_not_submitter;

-- One decision per transfer becomes one decision per director per transfer.
drop index public.approvals_one_per_disbursement_idx;

create unique index approvals_one_vote_per_director_idx
  on public.approvals (disbursement_id, approver_id)
  where disbursement_id is not null;

alter table public.approvals
  add column voter_role text
    check (voter_role is null or voter_role in ('sender', 'recipient', 'independent'));

comment on column public.approvals.voter_role is
  'Why this director was entitled to vote. Display only — the tally works off ids, so a self-transfer cannot count twice.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Every transfer starts pending, and the database decides how many votes it needs
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.stamp_disbursement()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_me uuid := public.current_director_id();
begin
  if v_me is null then
    raise exception 'no active director record for the current session'
      using errcode = 'insufficient_privilege';
  end if;

  new.recorded_by    := v_me;          -- authorship is not client input
  new.status         := 'pending_approval';
  new.approval_count := 0;
  new.required_votes := case
    when new.amount >= public.approval_threshold() then 4
    else 2
  end;

  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Who may vote, and in what capacity
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.fill_approval_submitter()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recorded_by uuid;
  v_recipient   uuid;
  v_role        public.director_role;
begin
  if new.expenditure_id is not null then
    -- Expenditures are receipt-backed and no longer go through approval at all.
    raise exception 'expenditures are not approved; a receipt is the control'
      using errcode = 'insufficient_privilege';
  end if;

  select d.recorded_by, d.to_director_id, d.entity_id
    into v_recorded_by, v_recipient, new.entity_id
  from public.disbursements d
  where d.id = new.disbursement_id;

  if v_recorded_by is null then
    raise exception 'transfer does not exist';
  end if;

  new.submitted_by := v_recorded_by;
  new.approver_id  := coalesce(public.current_director_id(), new.approver_id);

  select d.role into v_role
  from public.directors d
  where d.id = new.approver_id and d.is_active;

  if v_role is null then
    raise exception 'only an active director may vote on a transfer'
      using errcode = 'insufficient_privilege';
  end if;

  if v_role = 'auditor' then
    raise exception 'an auditor has read-only access and cannot vote on a transfer'
      using errcode = 'insufficient_privilege';
  end if;

  -- Sender wins the label when one person is both. The tally works off ids, so
  -- the labelling here never affects whether the transfer can confirm.
  new.voter_role := case
    when new.approver_id = v_recorded_by then 'sender'
    when new.approver_id = v_recipient   then 'recipient'
    else 'independent'
  end;

  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The tally
--
-- A trigger rather than logic inside the RPC, so that a vote inserted directly
-- through PostgREST counts exactly the same as one cast through the function.
-- There is no path that records a vote without re-deciding the outcome.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.tally_disbursement_votes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d            public.disbursements;
  v_prev         text;
  v_sender_ok    boolean;
  v_recipient_ok boolean;
  v_independents integer;
  v_rejected     boolean;
  v_approved     integer;
  v_principals   integer;
  v_status       public.entry_status;
begin
  select * into v_d from public.disbursements where id = new.disbursement_id;
  if not found then
    return null;
  end if;

  select
    bool_or(a.decision = 'rejected'),
    count(*) filter (where a.decision = 'approved'),
    bool_or(a.decision = 'approved' and a.approver_id = v_d.recorded_by),
    bool_or(a.decision = 'approved' and a.approver_id = v_d.to_director_id),
    count(*) filter (where a.decision = 'approved'
                       and a.approver_id <> v_d.recorded_by
                       and a.approver_id <> v_d.to_director_id)
  into v_rejected, v_approved, v_sender_ok, v_recipient_ok, v_independents
  from public.approvals a
  where a.disbursement_id = v_d.id;

  -- A transfer a director made to himself has ONE principal, so it needs an
  -- extra independent to reach the same total. Without this, self-transfer plus
  -- one vote would satisfy both "sender approved" and "recipient approved".
  v_principals := (
    select count(distinct p) from unnest(array[v_d.recorded_by, v_d.to_director_id]) p
  );

  v_status := case
    when coalesce(v_rejected, false) then 'rejected'
    when coalesce(v_sender_ok, false)
     and coalesce(v_recipient_ok, false)
     and v_independents >= greatest(v_d.required_votes - v_principals, 0)
      then 'confirmed'
    else 'pending_approval'
  end;

  -- Save and restore rather than blindly clearing: this trigger can run inside
  -- a caller that already holds the flag, and stamping it 'off' underneath them
  -- would re-arm the guard mid-transaction.
  v_prev := current_setting('zirconix.privileged_transition', true);
  perform set_config('zirconix.privileged_transition', 'on', true);

  update public.disbursements
  set approval_count = v_approved,
      status         = v_status
  where id = v_d.id;

  perform set_config('zirconix.privileged_transition', coalesce(v_prev, ''), true);

  return null;
end;
$$;

create trigger approvals_tally
  after insert on public.approvals
  for each row execute function public.tally_disbursement_votes();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: the self-approval clause goes, MFA stays
-- ─────────────────────────────────────────────────────────────────────────────

drop policy approvals_insert on public.approvals;

create policy approvals_insert on public.approvals
  for insert to authenticated
  with check (
    public.is_entity_member(entity_id)
    and public.can_write()
    and public.has_mfa_session()
    and approver_id = public.current_director_id()
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- cast_disbursement_vote — what the app calls
-- ─────────────────────────────────────────────────────────────────────────────

-- Dropped by name rather than by signature: decide_approval covered both
-- expenditures and disbursements, and only one of those is still approved.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'decide_approval'
  loop
    execute format('drop function %s', r.sig);
  end loop;
end;
$$;

create or replace function public.cast_disbursement_vote(
  p_disbursement_id uuid,
  p_decision        public.approval_decision,
  p_reason          text default null
)
returns public.disbursements
language plpgsql
security invoker      -- RLS decides whether this director may vote at all
set search_path = ''
as $$
declare
  v_me uuid := public.current_director_id();
  v_d  public.disbursements;
begin
  if v_me is null then
    raise exception 'no active director record for the current session'
      using errcode = 'insufficient_privilege';
  end if;

  if not public.has_mfa_session() then
    raise exception 'two-step verification is required before you can vote on a transfer'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_d from public.disbursements where id = p_disbursement_id;
  if not found then
    raise exception 'that transfer does not exist, or you cannot see it';
  end if;

  if v_d.status in ('confirmed', 'rejected') then
    raise exception 'this transfer is already %; a decision cannot be revisited', v_d.status
      using errcode = 'integrity_constraint_violation';
  end if;

  insert into public.approvals (entity_id, disbursement_id, approver_id, decision, reason)
  values (v_d.entity_id, v_d.id, v_me, p_decision, p_reason);

  -- Re-read: approvals_tally has already moved the status by this point.
  select * into v_d from public.disbursements where id = p_disbursement_id;
  return v_d;
end;
$$;

revoke execute on function public.cast_disbursement_vote(uuid, public.approval_decision, text) from public;
grant execute on function public.cast_disbursement_vote(uuid, public.approval_decision, text)
  to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Existing transfers move back into the vote
--
-- Both were recorded under the old rule and auto-confirmed for being under the
-- threshold. Under the new rule nothing is confirmed without a vote, and leaving
-- them marked confirmed would misrepresent money that nobody has actually
-- attested to.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  v_prev text := current_setting('zirconix.privileged_transition', true);
begin
  perform set_config('zirconix.privileged_transition', 'on', true);

  update public.disbursements
  set status         = 'pending_approval',
      approval_count = 0,
      required_votes = case when amount >= public.approval_threshold() then 4 else 2 end
  where status <> 'rejected';

  perform set_config('zirconix.privileged_transition', coalesce(v_prev, ''), true);
end;
$$;
