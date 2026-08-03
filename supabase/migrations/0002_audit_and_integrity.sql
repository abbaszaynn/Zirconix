-- Zirconix — audit chain and integrity guards
--
-- Everything in this file exists so that the controls cannot be bypassed by a
-- client, however the client is written or whoever holds the anon key:
--
--   1. audit_events is append-only and hash-chained. Tampering with history is
--      detectable because every row's hash covers the previous row's hash.
--   2. The PKR 10 lac threshold is decided by the database on INSERT. A client
--      cannot submit a 50 lac expenditure pre-marked 'confirmed'.
--   3. entered_by / recorded_by are stamped from the session, not accepted from
--      the client. You cannot log an expenditure as somebody else.
--   4. status only moves through the approval function. Direct UPDATEs are refused.
--   5. A non-rejected expenditure can never be committed without a receipt, and a
--      receipt cannot be deleted out from under one.

-- ─────────────────────────────────────────────────────────────────────────────
-- Who is acting
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.current_director_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.id
  from public.directors d
  where d.auth_user_id = (select auth.uid())
    and d.is_active
$$;

comment on function public.current_director_id() is
  'directors.id for the signed-in user, or null. SECURITY DEFINER so it can be used inside RLS policies without recursion.';

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_events — append-only, hash-chained
-- ─────────────────────────────────────────────────────────────────────────────

create table public.audit_events (
  id          bigint generated always as identity primary key,
  entity_id   uuid,
  actor_id    uuid,
  action      text not null check (action in ('insert', 'update', 'delete')),
  table_name  text not null,
  record_id   uuid,
  before      jsonb,
  after       jsonb,
  created_at  timestamptz not null default now(),
  prev_hash   text not null,
  hash        text not null
);

create index audit_events_entity_idx on public.audit_events (entity_id, id desc);
create index audit_events_actor_idx on public.audit_events (actor_id, id desc);
create index audit_events_record_idx on public.audit_events (table_name, record_id);
create index audit_events_created_idx on public.audit_events (created_at desc);

-- Append-only, enforced by trigger rather than by permissions alone, because
-- permissions can be granted and triggers have to be deliberately disabled.
create or replace function public.audit_events_reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'audit_events is append-only; % is not permitted on the audit log', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger audit_events_no_update
  before update on public.audit_events
  for each statement execute function public.audit_events_reject_mutation();

create trigger audit_events_no_delete
  before delete on public.audit_events
  for each statement execute function public.audit_events_reject_mutation();

create trigger audit_events_no_truncate
  before truncate on public.audit_events
  for each statement execute function public.audit_events_reject_mutation();

-- The chain writer.
create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before  jsonb;
  v_after   jsonb;
  v_record  uuid;
  v_entity  uuid;
  v_actor   uuid;
  v_prev    text;
  v_payload text;
  v_at      timestamptz := clock_timestamp();
begin
  v_before := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_after  := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;

  -- Bookkeeping-only updates (a receipt landing, updated_at ticking) are already
  -- represented by the attachments INSERT event. Don't log them twice.
  if tg_op = 'UPDATE'
     and (v_before - 'receipt_count' - 'updated_at')
       = (v_after  - 'receipt_count' - 'updated_at') then
    return null;
  end if;

  v_record := coalesce((v_after ->> 'id')::uuid, (v_before ->> 'id')::uuid);
  v_entity := coalesce((v_after ->> 'entity_id')::uuid, (v_before ->> 'entity_id')::uuid);
  v_actor  := public.current_director_id();

  -- Serialise appends so two concurrent writers cannot both chain off the same
  -- predecessor and fork the history.
  perform pg_advisory_xact_lock(hashtext('zirconix.audit_chain'));

  select ae.hash into v_prev
  from public.audit_events ae
  order by ae.id desc
  limit 1;

  v_prev := coalesce(v_prev, repeat('0', 64));  -- genesis

  v_payload := concat_ws(
    '|',
    v_prev,
    lower(tg_op),
    tg_table_name,
    coalesce(v_record::text, ''),
    coalesce(v_actor::text, ''),
    coalesce(v_entity::text, ''),
    coalesce(v_before::text, ''),
    coalesce(v_after::text, ''),
    -- Explicit UTC format string, not ::text — the default rendering of a
    -- timestamptz depends on the session's TimeZone and DateStyle, which would
    -- make the same row hash differently for different readers.
    to_char(v_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')
  );

  insert into public.audit_events
    (entity_id, actor_id, action, table_name, record_id, before, after, created_at, prev_hash, hash)
  values
    (v_entity, v_actor, lower(tg_op), tg_table_name, v_record, v_before, v_after, v_at, v_prev,
     encode(extensions.digest(v_payload, 'sha256'), 'hex'));

  return null;
end;
$$;

-- Attach to every table that carries financial meaning.
create trigger audit_entities
  after insert or update or delete on public.entities
  for each row execute function public.audit_row_change();
create trigger audit_directors
  after insert or update or delete on public.directors
  for each row execute function public.audit_row_change();
create trigger audit_director_entities
  after insert or update or delete on public.director_entities
  for each row execute function public.audit_row_change();
create trigger audit_budget_lines
  after insert or update or delete on public.budget_lines
  for each row execute function public.audit_row_change();
create trigger audit_disbursements
  after insert or update or delete on public.disbursements
  for each row execute function public.audit_row_change();
create trigger audit_expenditures
  after insert or update or delete on public.expenditures
  for each row execute function public.audit_row_change();
create trigger audit_attachments
  after insert or update or delete on public.attachments
  for each row execute function public.audit_row_change();
create trigger audit_approvals
  after insert or update or delete on public.approvals
  for each row execute function public.audit_row_change();
create trigger audit_statement_imports
  after insert or update or delete on public.statement_imports
  for each row execute function public.audit_row_change();

-- Chain verifier. Recomputes every hash from genesis and reports the first break.
create or replace function public.verify_audit_chain(p_from bigint default 0)
returns table (ok boolean, checked bigint, first_bad_id bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r         record;
  v_prev    text := repeat('0', 64);
  v_count   bigint := 0;
  v_bad     bigint := null;
  v_payload text;
begin
  for r in
    select * from public.audit_events where id > p_from order by id
  loop
    if v_count = 0 and p_from > 0 then
      v_prev := r.prev_hash;  -- partial verification trusts its starting point
    end if;

    v_payload := concat_ws(
      '|', v_prev, r.action, r.table_name,
      coalesce(r.record_id::text, ''), coalesce(r.actor_id::text, ''),
      coalesce(r.entity_id::text, ''), coalesce(r.before::text, ''),
      coalesce(r.after::text, ''),
      to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')
    );

    if r.prev_hash is distinct from v_prev
       or r.hash is distinct from encode(extensions.digest(v_payload, 'sha256'), 'hex') then
      v_bad := r.id;
      exit;
    end if;

    v_prev  := r.hash;
    v_count := v_count + 1;
  end loop;

  return query select v_bad is null, v_count, v_bad;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Threshold + authorship, decided by the database
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.stamp_expenditure()
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

  new.entered_by := v_me;                       -- authorship is not client input
  new.receipt_count := 0;
  new.status := case
    when new.amount >= public.approval_threshold() then 'pending_approval'
    else 'auto_confirmed'
  end;                                          -- neither is confirmation

  return new;
end;
$$;

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

  new.recorded_by := v_me;
  new.status := case
    when new.amount >= public.approval_threshold() then 'pending_approval'
    else 'auto_confirmed'
  end;

  return new;
end;
$$;

create trigger expenditures_stamp
  before insert on public.expenditures
  for each row execute function public.stamp_expenditure();

create trigger disbursements_stamp
  before insert on public.disbursements
  for each row execute function public.stamp_disbursement();

-- Financial fields are immutable after the fact. Corrections are new entries, so
-- the original stays visible — that is the whole point of an accountability log.
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
     or new.entity_id is distinct from old.entity_id
     or new.created_at is distinct from old.created_at then
    raise exception 'amount, entity and creation time are immutable on % (record %)',
      tg_table_name, old.id
      using errcode = 'integrity_constraint_violation';
  end if;

  -- These have to be NESTED, not `if tg_table_name = 'x' and new.col ...`.
  -- plpgsql hands the whole boolean expression to SQL as one unit, so a column
  -- reference in the second half is resolved even when the table test in the
  -- first half is false — and this trigger is shared by two tables whose columns
  -- differ. Flattening these conditions raises 'record "new" has no field ...'.
  if tg_table_name = 'expenditures' then
    if new.disbursement_id is distinct from old.disbursement_id
       or new.entered_by is distinct from old.entered_by then
      raise exception 'the source disbursement and the author of an expenditure are immutable'
        using errcode = 'integrity_constraint_violation';
    end if;

  elsif tg_table_name = 'disbursements' then
    if new.budget_line_id is distinct from old.budget_line_id
       or new.recorded_by is distinct from old.recorded_by
       or new.to_director_id is distinct from old.to_director_id then
      raise exception 'the budget line, recipient and recorder of a disbursement are immutable'
        using errcode = 'integrity_constraint_violation';
    end if;
  end if;

  -- status only moves inside public.decide_approval()
  if new.status is distinct from old.status and not v_privileged then
    raise exception 'status changes only through the approval process, not by direct update'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger expenditures_guard_update
  before update on public.expenditures
  for each row execute function public.guard_financial_update();

create trigger disbursements_guard_update
  before update on public.disbursements
  for each row execute function public.guard_financial_update();

-- ─────────────────────────────────────────────────────────────────────────────
-- Receipt required — no exceptions
-- ─────────────────────────────────────────────────────────────────────────────

-- Keeps the denormalised counter honest for list views.
create or replace function public.sync_receipt_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exp uuid := coalesce(new.expenditure_id, old.expenditure_id);
begin
  if v_exp is not null then
    update public.expenditures e
    set receipt_count = (
      select count(*) from public.attachments a where a.expenditure_id = v_exp
    )
    where e.id = v_exp;
  end if;
  return null;
end;
$$;

create trigger attachments_sync_receipt_count
  after insert or delete on public.attachments
  for each row execute function public.sync_receipt_count();

-- DEFERRABLE: fires at COMMIT, not at statement time. That is what lets
-- log_expenditure() insert the expenditure and its receipt in one transaction,
-- while a bare INSERT with no receipt still fails when its transaction commits.
create or replace function public.require_receipt()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'rejected' then
    return null;  -- a rejected entry is a record of a refusal, not a claim
  end if;

  if not exists (select 1 from public.attachments a where a.expenditure_id = new.id) then
    raise exception
      'every expenditure must have a receipt or payment confirmation attached (expenditure %)',
      new.id
      using errcode = 'integrity_constraint_violation';
  end if;

  return null;
end;
$$;

create constraint trigger expenditures_require_receipt
  after insert or update on public.expenditures
  deferrable initially deferred
  for each row execute function public.require_receipt();

-- And the receipt cannot be removed afterwards to leave a bare claim behind.
create or replace function public.guard_receipt_deletion()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_remaining integer;
  v_status public.entry_status;
begin
  if old.expenditure_id is null then
    return old;
  end if;

  select e.status into v_status
  from public.expenditures e where e.id = old.expenditure_id;

  if v_status is null or v_status = 'rejected' then
    return old;
  end if;

  select count(*) into v_remaining
  from public.attachments a
  where a.expenditure_id = old.expenditure_id and a.id <> old.id;

  if v_remaining = 0 then
    raise exception
      'cannot remove the last receipt from expenditure % — it would leave an unsupported claim',
      old.expenditure_id
      using errcode = 'integrity_constraint_violation';
  end if;

  return old;
end;
$$;

create trigger attachments_guard_receipt_deletion
  before delete on public.attachments
  for each row execute function public.guard_receipt_deletion();

-- ─────────────────────────────────────────────────────────────────────────────
-- Approvals: the submitter is read from the target row, never from the client
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.fill_approval_submitter()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.expenditure_id is not null then
    select e.entered_by, e.entity_id into new.submitted_by, new.entity_id
    from public.expenditures e where e.id = new.expenditure_id;
  else
    select d.recorded_by, d.entity_id into new.submitted_by, new.entity_id
    from public.disbursements d where d.id = new.disbursement_id;
  end if;

  if new.submitted_by is null then
    raise exception 'approval target does not exist';
  end if;

  new.approver_id := coalesce(public.current_director_id(), new.approver_id);

  -- The CHECK constraint approvals_approver_is_not_submitter catches this too;
  -- raising here gives the app a message a director can actually act on.
  if new.approver_id = new.submitted_by then
    raise exception 'you cannot approve an entry you submitted yourself'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger approvals_fill_submitter
  before insert on public.approvals
  for each row execute function public.fill_approval_submitter();

-- Decisions are historical facts.
create or replace function public.approvals_reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'an approval decision cannot be % once recorded', lower(tg_op)
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger approvals_no_update
  before update on public.approvals
  for each statement execute function public.approvals_reject_mutation();

create trigger approvals_no_delete
  before delete on public.approvals
  for each statement execute function public.approvals_reject_mutation();
