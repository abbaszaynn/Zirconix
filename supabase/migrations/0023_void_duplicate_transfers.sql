-- Zirconix — voiding a transfer that should never have been recorded
--
-- A transfer can be wrong in two entirely different ways, and the app only had
-- a word for one of them:
--
--   rejected  the board voted it down. A real decision about real money.
--   voided    it should not be in the ledger at all — a duplicate, a typo, an
--             entry against the wrong director. Nothing was decided; the row
--             is simply not a movement of money.
--
-- Collapsing the second into the first misrepresents the record. The case that
-- prompted this: 75,000 was recorded to a director, one director rejected it
-- while explicitly testing the voting system ("Just to check this voting
-- system ... i approve"), and the same 75,000 was then recorded a second time.
-- Two rows, one actual payment. Marking the duplicate "rejected by the board"
-- would put a decision in the minutes that nobody made.
--
-- Voided rows stay in the table and in the audit chain — the void itself is an
-- UPDATE, so audit_row_change records who voided what, when, and why. They are
-- excluded from every balance.

alter table public.disbursements
  add column voided_at   timestamptz,
  add column voided_by   uuid references public.directors (id) on delete restrict,
  add column void_reason text,
  add constraint disbursements_void_is_explained check (
    voided_at is null
    or (voided_by is not null and length(btrim(coalesce(void_reason, ''))) > 0)
  );

comment on column public.disbursements.voided_at is
  'Set when the entry itself was a mistake (duplicate, wrong director). Distinct from a rejected vote, which is a real decision. Voided rows count towards nothing.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Only void_disbursement() may set these
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
      tg_table_name, old.id using errcode = 'integrity_constraint_violation';
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

    if not v_privileged and (
         new.voided_at   is distinct from old.voided_at
      or new.voided_by   is distinct from old.voided_by
      or new.void_reason is distinct from old.void_reason
    ) then
      raise exception 'a transfer is voided through void_disbursement(), not by direct update'
        using errcode = 'insufficient_privilege';
    end if;

    -- A void is final. Un-voiding would let a mistake be quietly reinstated.
    if old.voided_at is not null and new.voided_at is null then
      raise exception 'a voided transfer cannot be un-voided; record a new one instead'
        using errcode = 'integrity_constraint_violation';
    end if;
  end if;

  if new.status is distinct from old.status and not v_privileged then
    raise exception 'status changes only through the approval process, not by direct update'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

-- A voided transfer is settled. Votes must not resurrect it.
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
  if not found or v_d.voided_at is not null then
    return null;
  end if;

  select count(*) filter (where a.decision = 'approved'),
         count(*) filter (where a.decision = 'rejected')
  into v_approved, v_rejected
  from public.approvals a where a.disbursement_id = v_d.id;

  if v_rejected >= v_majority then
    v_status := 'rejected'; v_review := false;
  elsif v_approved >= v_majority then
    v_status := 'confirmed'; v_review := v_rejected > 0;
  else
    v_status := 'pending_approval'; v_review := v_rejected > 0;
  end if;

  v_prev := current_setting('zirconix.privileged_transition', true);
  perform set_config('zirconix.privileged_transition', 'on', true);

  update public.disbursements
  set approval_count = v_approved, rejection_count = v_rejected,
      under_review = v_review, status = v_status
  where id = v_d.id;

  perform set_config('zirconix.privileged_transition', coalesce(v_prev, ''), true);
  return null;
end;
$$;

create or replace function public.void_disbursement(
  p_disbursement_id uuid,
  p_reason          text
)
returns public.disbursements
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   uuid := public.current_director_id();
  v_role public.director_role := public.current_director_role();
  v_d    public.disbursements;
  v_prev text;
  v_spent integer;
begin
  if v_me is null then
    raise exception 'no active director record for the current session'
      using errcode = 'insufficient_privilege';
  end if;

  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'say why this transfer is being voided — it stays in the audit log'
      using errcode = 'integrity_constraint_violation';
  end if;

  select * into v_d from public.disbursements where id = p_disbursement_id;
  if not found then
    raise exception 'that transfer does not exist, or you cannot see it'
      using errcode = 'no_data_found';
  end if;

  if v_d.voided_at is not null then
    raise exception 'that transfer is already voided'
      using errcode = 'integrity_constraint_violation';
  end if;

  -- Only the person who recorded it, or a finance officer, may void it.
  if v_d.recorded_by <> v_me and v_role <> 'finance_officer' then
    raise exception 'only the director who recorded this transfer, or a finance officer, can void it'
      using errcode = 'insufficient_privilege';
  end if;

  -- Voiding an advance somebody has already spent against would strand real,
  -- receipted expenditures with no source. Those have to be dealt with first.
  select count(*) into v_spent
  from public.expenditures e
  where e.disbursement_id = p_disbursement_id and e.status <> 'rejected';

  if v_spent > 0 then
    raise exception
      'cannot void this transfer — % expenditure(s) have already been logged against it',
      v_spent
      using errcode = 'integrity_constraint_violation';
  end if;

  v_prev := current_setting('zirconix.privileged_transition', true);
  perform set_config('zirconix.privileged_transition', 'on', true);

  update public.disbursements
  set voided_at   = now(),
      voided_by   = v_me,
      void_reason = btrim(p_reason),
      under_review = false
  where id = p_disbursement_id
  returning * into v_d;

  perform set_config('zirconix.privileged_transition', coalesce(v_prev, ''), true);

  return v_d;
end;
$$;

revoke execute on function public.void_disbursement(uuid, text) from public, anon;
grant execute on function public.void_disbursement(uuid, text) to authenticated, service_role;

-- Spending against a voided advance makes no sense either.
create or replace function public.log_expenditure(
  p_disbursement_id uuid, p_amount numeric, p_category text, p_payee text,
  p_spent_on date, p_attachments jsonb, p_note text default null)
returns public.expenditures
language plpgsql
set search_path = ''
as $$
declare
  v_me uuid := public.current_director_id();
  v_entity uuid; v_to uuid; v_status public.entry_status; v_voided timestamptz;
  v_exp public.expenditures; v_att jsonb;
begin
  if v_me is null then
    raise exception 'no active director record for the current session'
      using errcode = 'insufficient_privilege';
  end if;

  if p_attachments is null or jsonb_array_length(p_attachments) = 0 then
    raise exception 'a receipt or payment confirmation is required for every expenditure'
      using errcode = 'integrity_constraint_violation';
  end if;

  select d.entity_id, d.to_director_id, d.status, d.voided_at
    into v_entity, v_to, v_status, v_voided
  from public.disbursements d where d.id = p_disbursement_id;

  if v_entity is null then
    raise exception 'that advance does not exist, or is not yours to see'
      using errcode = 'no_data_found';
  end if;

  if v_voided is not null then
    raise exception 'that transfer was voided; you cannot account against it'
      using errcode = 'integrity_constraint_violation';
  end if;

  if v_status not in ('confirmed', 'auto_confirmed') then
    raise exception 'that transfer is not confirmed yet; you can only log expenditures against a fully approved budget'
      using errcode = 'integrity_constraint_violation';
  end if;

  if v_to <> v_me and public.current_director_role() <> 'finance_officer' then
    raise exception
      'this advance was given to another director; only they (or a finance officer) can account for it'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.expenditures
    (entity_id, disbursement_id, amount, category, payee, note, spent_on, entered_by)
  values
    (v_entity, p_disbursement_id, p_amount, p_category, p_payee, p_note, p_spent_on, v_me)
  returning * into v_exp;

  for v_att in select * from jsonb_array_elements(p_attachments)
  loop
    insert into public.attachments
      (entity_id, expenditure_id, kind, storage_path, mime_type, byte_size, sha256, uploaded_by)
    values (
      v_entity, v_exp.id,
      coalesce((v_att ->> 'kind')::public.attachment_kind, 'receipt_photo'),
      v_att ->> 'storage_path',
      coalesce(v_att ->> 'mime_type', 'application/octet-stream'),
      nullif(v_att ->> 'byte_size', '')::integer,
      v_att ->> 'sha256', v_me);
  end loop;

  select * into v_exp from public.expenditures where id = v_exp.id;
  return v_exp;
end;
$$;

revoke execute on function
  public.log_expenditure(uuid, numeric, text, text, date, jsonb, text) from public, anon;
grant execute on function
  public.log_expenditure(uuid, numeric, text, text, date, jsonb, text)
  to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Voided money counts towards nothing
-- ─────────────────────────────────────────────────────────────────────────────

create or replace view public.v_budget_summary
with (security_invoker = on) as
select budget_line_id, entity_id, period, project, category, owner_director_id,
       allocated_amount, disbursed_amount, spent_amount,
       allocated_amount - disbursed_amount as undisbursed_amount,
       disbursed_amount - spent_amount     as unaccounted_amount,
       allocated_amount - spent_amount     as available_amount
from (
  select bl.id as budget_line_id, bl.entity_id, bl.period, bl.project, bl.category,
         bl.owner_director_id, bl.allocated_amount,
         coalesce((select sum(ds.amount) from public.disbursements ds
                    where ds.budget_line_id = bl.id
                      and ds.status <> 'rejected'
                      and ds.voided_at is null), 0)::numeric(18,2) as disbursed_amount,
         coalesce((select sum(e.amount) from public.expenditures e
                     join public.disbursements ds2 on ds2.id = e.disbursement_id
                    where ds2.budget_line_id = bl.id
                      and e.status <> 'rejected'
                      and ds2.voided_at is null), 0)::numeric(18,2) as spent_amount
  from public.budget_lines bl
) s;

create or replace view public.v_director_accountability
with (security_invoker = on) as
select ds.entity_id,
       ds.to_director_id as director_id,
       count(*) as advance_count,
       coalesce(sum(ds.amount), 0)::numeric(18,2)        as total_disbursed,
       coalesce(sum(acc.receipted), 0)::numeric(18,2)    as total_accounted,
       coalesce(sum(acc.unreceipted), 0)::numeric(18,2)  as claimed_without_receipt,
       (coalesce(sum(ds.amount), 0) - coalesce(sum(acc.receipted), 0))::numeric(18,2) as outstanding
from public.disbursements ds
left join lateral (
  select coalesce(sum(e.amount) filter (where e.receipt_count > 0), 0)  as receipted,
         coalesce(sum(e.amount) filter (where e.receipt_count = 0), 0)  as unreceipted
  from public.expenditures e
  where e.disbursement_id = ds.id and e.status <> 'rejected'
) acc on true
where ds.status <> 'rejected' and ds.voided_at is null
group by ds.entity_id, ds.to_director_id;

create or replace view public.v_disbursement_balance
with (security_invoker = on) as
select ds.id as disbursement_id, ds.entity_id, ds.budget_line_id, ds.to_director_id,
       ds.amount as advanced, ds.method, ds.disbursed_on, ds.status,
       coalesce((select sum(e.amount) from public.expenditures e
                  where e.disbursement_id = ds.id and e.status <> 'rejected'), 0)::numeric(18,2) as spent,
       (ds.amount - coalesce((select sum(e.amount) from public.expenditures e
                               where e.disbursement_id = ds.id and e.status <> 'rejected'), 0))::numeric(18,2) as remaining
from public.disbursements ds
where ds.voided_at is null;

drop view if exists public.v_transfer_votes;

create view public.v_transfer_votes
with (security_invoker = on) as
select d.id as disbursement_id, d.entity_id, d.amount, d.status, d.under_review,
       d.required_votes, d.approval_count, d.rejection_count,
       d.method, d.disbursed_on, d.note, d.from_account_id,
       acct.name as account_name, d.to_director_id, rec.full_name as recipient_name,
       d.recorded_by, snd.full_name as sender_name, bl.category, bl.period,
       (select jsonb_agg(jsonb_build_object('name', dd.full_name, 'reason', a.reason, 'at', a.decided_at)
                 order by a.decided_at)
          from public.approvals a join public.directors dd on dd.id = a.approver_id
         where a.disbursement_id = d.id and a.decision = 'rejected') as objections
from public.disbursements d
join public.accounts     acct on acct.id = d.from_account_id
join public.directors    rec  on rec.id  = d.to_director_id
join public.directors    snd  on snd.id  = d.recorded_by
join public.budget_lines bl   on bl.id   = d.budget_line_id
where d.voided_at is null;

grant select on public.v_transfer_votes to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- The duplicate this was written for
--
-- 75,000 recorded to Daniyal Ali twice on 16 August for the same Hilalabad
-- transport: once at 10:08 by bank transfer, again at 12:17 in cash. One
-- payment, two rows. The earlier row is the one that was re-sent, and nothing
-- has been spent against it, so it voids cleanly.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  v_prev text := current_setting('zirconix.privileged_transition', true);
  v_fo   uuid;
begin
  select id into v_fo from public.directors
  where role = 'finance_officer' and is_active limit 1;

  perform set_config('zirconix.privileged_transition', 'on', true);

  update public.disbursements
  set voided_at    = now(),
      voided_by    = v_fo,
      void_reason  = 'Duplicate entry. The same 75,000 to Daniyal Ali for Hilalabad transport '
                     || 'was recorded again at 12:17 the same day and that record stands. '
                     || 'Only one payment was made.',
      under_review = false
  where id = 'b6753edd-0ff1-4e56-9b25-936a573f17b6'
    and voided_at is null;

  perform set_config('zirconix.privileged_transition', coalesce(v_prev, ''), true);
end;
$$;
