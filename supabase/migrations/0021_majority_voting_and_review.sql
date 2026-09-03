-- Zirconix — majority voting, with rejection raising a review rather than killing
--
-- The old rule was unanimity-of-four-specific-people: sender + recipient + two
-- independents all had to approve, and a SINGLE rejection from anyone
-- terminated the transfer outright. In practice that meant one director could
-- veto money the rest of the board had already backed.
--
-- The new rule is a straight majority of the board:
--
--   4 approvals   -> confirmed. The recipient can spend against it immediately.
--   4 rejections  -> rejected. Terminal, by majority against.
--   any rejection -> under_review, a FLAG carried alongside the status rather
--                    than replacing it. A confirmed transfer that someone has
--                    since objected to stays confirmed and spendable, but is
--                    visibly flagged until the board resolves it.
--
-- under_review is deliberately a separate boolean and not a new entry_status
-- value, because "confirmed AND disputed" is exactly the state being asked for
-- and a single status column cannot hold both.
--
-- Who votes no longer matters, only how many — so the old sender/recipient/
-- independent bookkeeping falls away. The self-transfer hole that logic
-- existed to close (0008, test D1) stays closed for free: one director is one
-- vote, so a transfer recorded to yourself still needs three other people.

create or replace function public.approval_majority()
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $$ select 4 $$;

comment on function public.approval_majority() is
  'Votes needed to settle a transfer: 4 approvals confirms it, 4 rejections rejects it. Fixed deliberately — changing the board size does not silently change the threshold.';

alter table public.disbursements
  add column rejection_count smallint not null default 0 check (rejection_count >= 0),
  add column under_review    boolean  not null default false;

comment on column public.disbursements.under_review is
  'At least one director objected. Independent of status: a confirmed transfer can be under review and remains spendable while the objection is resolved.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Protect the new columns
--
-- disbursements_update is is_entity_member AND can_write, so without this any
-- director could UPDATE the row directly and quietly clear under_review or
-- rewrite rejection_count. Both are tally output, not user input — only the
-- privileged transition (the tally trigger) may move them.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.guard_financial_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_privileged boolean := coalesce(
    current_setting('zirconix.privileged_transition', true) = 'on', false
  );
begin
  if new.amount is distinct from old.amount
     or new.created_at is distinct from old.created_at then
    raise exception 'amount and creation time are immutable on % (record %)',
      tg_table_name, old.id
      using errcode = 'integrity_constraint_violation';
  end if;

  if new.entity_id is distinct from old.entity_id and not v_privileged then
    raise exception 'entity is immutable on % (record %)', tg_table_name, old.id
      using errcode = 'integrity_constraint_violation';
  end if;

  if tg_table_name = 'expenditures' then
    if new.disbursement_id is distinct from old.disbursement_id
       or new.entered_by is distinct from old.entered_by then
      raise exception 'the source disbursement and the author of an expenditure are immutable'
        using errcode = 'integrity_constraint_violation';
    end if;

  elsif tg_table_name = 'disbursements' then
    if new.budget_line_id is distinct from old.budget_line_id
       or new.recorded_by is distinct from old.recorded_by
       or new.to_director_id is distinct from old.to_director_id
       or (new.from_account_id is distinct from old.from_account_id and not v_privileged) then
      raise exception 'the budget line, source account, recipient and recorder of a disbursement are immutable'
        using errcode = 'integrity_constraint_violation';
    end if;

    if not v_privileged and (
         new.approval_count  is distinct from old.approval_count
      or new.rejection_count is distinct from old.rejection_count
      or new.under_review    is distinct from old.under_review
      or new.required_votes  is distinct from old.required_votes
    ) then
      raise exception 'vote tallies are set by the approval process, not by direct update'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  if new.status is distinct from old.status and not v_privileged then
    raise exception 'status changes only through the approval process, not by direct update'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The tally
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.tally_disbursement_votes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d        public.disbursements;
  v_prev     text;
  v_approved integer;
  v_rejected integer;
  v_status   public.entry_status;
  v_review   boolean;
  v_majority integer := public.approval_majority();
begin
  select * into v_d from public.disbursements where id = new.disbursement_id;
  if not found then
    return null;
  end if;

  select
    count(*) filter (where a.decision = 'approved'),
    count(*) filter (where a.decision = 'rejected')
  into v_approved, v_rejected
  from public.approvals a
  where a.disbursement_id = v_d.id;

  if v_rejected >= v_majority then
    -- Majority against. Terminal, and nothing left to review.
    v_status := 'rejected';
    v_review := false;
  elsif v_approved >= v_majority then
    v_status := 'confirmed';
    v_review := v_rejected > 0;
  else
    v_status := 'pending_approval';
    v_review := v_rejected > 0;
  end if;

  v_prev := current_setting('zirconix.privileged_transition', true);
  perform set_config('zirconix.privileged_transition', 'on', true);

  update public.disbursements
  set approval_count  = v_approved,
      rejection_count = v_rejected,
      under_review    = v_review,
      status          = v_status
  where id = v_d.id;

  perform set_config('zirconix.privileged_transition', coalesce(v_prev, ''), true);

  return null;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Voting stays open on a confirmed transfer
--
-- Raising an objection after the fourth approval is the whole point of the
-- review state — so only a majority rejection is terminal.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.cast_disbursement_vote(
  p_disbursement_id uuid,
  p_decision        public.approval_decision,
  p_reason          text default null
)
returns public.disbursements
language plpgsql
security invoker
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

  if v_d.status = 'rejected' then
    raise exception 'this transfer was rejected by majority; it cannot be voted on again'
      using errcode = 'integrity_constraint_violation';
  end if;

  insert into public.approvals (entity_id, disbursement_id, approver_id, decision, reason)
  values (v_d.entity_id, v_d.id, v_me, p_decision, p_reason);

  select * into v_d from public.disbursements where id = p_disbursement_id;
  return v_d;
end;
$$;

revoke execute on function public.cast_disbursement_vote(uuid, public.approval_decision, text)
  from public, anon;
grant execute on function public.cast_disbursement_vote(uuid, public.approval_decision, text)
  to authenticated, service_role;
revoke execute on function public.approval_majority() from public, anon;
grant execute on function public.approval_majority() to authenticated, service_role;

-- Settlement notice now also fires when an objection is raised or cleared,
-- not only on a status change — a rejection against an already-confirmed
-- transfer moves only under_review.
drop trigger if exists disbursements_notify_settled on public.disbursements;

create or replace function public.notify_transfer_settled()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_to text;
begin
  select full_name into v_to from public.directors where id = new.to_director_id;

  if new.under_review and not old.under_review then
    perform public.notify_directors(
      new.entity_id, 'vote_cast', 'Transfer under review',
      format('%s to %s has been objected to and needs the board to resolve it.',
             public.format_pkr(new.amount), v_to),
      new.id, null, null);
    return null;
  end if;

  if new.status = old.status or new.status not in ('confirmed', 'rejected') then
    return null;
  end if;

  perform public.notify_directors(
    new.entity_id,
    case when new.status = 'confirmed' then 'transfer_confirmed' else 'transfer_rejected' end,
    case when new.status = 'confirmed' then 'Transfer confirmed' else 'Transfer rejected' end,
    format('%s to %s is now %s.', public.format_pkr(new.amount), v_to, new.status),
    new.id, null, null);
  return null;
end;
$$;

create trigger disbursements_notify_settled
  after update of status, under_review on public.disbursements
  for each row execute function public.notify_transfer_settled();

-- ─────────────────────────────────────────────────────────────────────────────
-- v_transfer_votes, rebuilt around counts rather than roles
--
-- Carries the objections themselves, so the board can see WHY something is
-- under review without a second round trip.
-- ─────────────────────────────────────────────────────────────────────────────

drop view if exists public.v_transfer_votes;

create view public.v_transfer_votes
with (security_invoker = on) as
select
  d.id              as disbursement_id,
  d.entity_id,
  d.amount,
  d.status,
  d.under_review,
  d.required_votes,
  d.approval_count,
  d.rejection_count,
  d.method,
  d.disbursed_on,
  d.note,
  d.from_account_id,
  acct.name         as account_name,
  d.to_director_id,
  rec.full_name     as recipient_name,
  d.recorded_by,
  snd.full_name     as sender_name,
  bl.category,
  bl.period,
  (
    select jsonb_agg(jsonb_build_object(
             'name', dd.full_name,
             'reason', a.reason,
             'at', a.decided_at
           ) order by a.decided_at)
    from public.approvals a
    join public.directors dd on dd.id = a.approver_id
    where a.disbursement_id = d.id and a.decision = 'rejected'
  ) as objections
from public.disbursements d
join public.accounts     acct on acct.id = d.from_account_id
join public.directors    rec  on rec.id  = d.to_director_id
join public.directors    snd  on snd.id  = d.recorded_by
join public.budget_lines bl   on bl.id   = d.budget_line_id;

grant select on public.v_transfer_votes to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Re-decide every open transfer under the new rule
--
-- One existing transfer had 4 approvals and 1 rejection, and was marked
-- rejected because the old rule let a single objection override the board.
-- That is precisely the case this change exists to fix, so it is re-decided
-- here: confirmed, and flagged under_review so the objection is not lost.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  r        record;
  v_prev   text := current_setting('zirconix.privileged_transition', true);
  v_major  integer := public.approval_majority();
begin
  perform set_config('zirconix.privileged_transition', 'on', true);

  for r in
    select d.id,
           count(*) filter (where a.decision = 'approved') as approved,
           count(*) filter (where a.decision = 'rejected') as rejected
    from public.disbursements d
    left join public.approvals a on a.disbursement_id = d.id
    group by d.id
  loop
    update public.disbursements
    set approval_count  = r.approved,
        rejection_count = r.rejected,
        required_votes  = v_major,
        under_review    = (r.rejected > 0 and r.rejected < v_major),
        status = case
                   when r.rejected >= v_major then 'rejected'::public.entry_status
                   when r.approved >= v_major then 'confirmed'::public.entry_status
                   else 'pending_approval'::public.entry_status
                 end
    where id = r.id;
  end loop;

  perform set_config('zirconix.privileged_transition', coalesce(v_prev, ''), true);
end;
$$;
