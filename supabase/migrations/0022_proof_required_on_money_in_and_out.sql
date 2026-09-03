-- Zirconix — money moving in or out now needs proof attached, like spending does
--
-- Expenditures have required a receipt since 0002. Deposits (capital coming in)
-- and disbursements (money going out to a director) did not — the two ends of
-- the ledger where the largest amounts move were the two that took somebody's
-- word for it.
--
-- Same shape as the expenditure rule: the attachment is written in the same
-- transaction as the row it supports, a DEFERRABLE constraint trigger checks at
-- COMMIT, and the last remaining proof cannot be deleted afterwards.
--
-- ONE DELIBERATE DIFFERENCE: these fire on INSERT only, not on UPDATE.
-- require_receipt fires on both, which is safe for expenditures because every
-- expenditure has always had one. Ten disbursements and five deposits already
-- exist without proof, and a disbursement row is UPDATEd on every single vote
-- by tally_disbursement_votes — an insert-or-update check would make those
-- grandfathered rows unvotable, breaking approvals outright. New money needs
-- proof; history is left as it stands rather than rewritten or blocked.

alter table public.attachments
  add column deposit_id uuid references public.account_deposits (id) on delete cascade;

create index attachments_deposit_idx on public.attachments (deposit_id);

alter table public.attachments
  drop constraint attachments_exactly_one_parent,
  add constraint attachments_exactly_one_parent check (
    (expenditure_id is not null)::int
  + (disbursement_id is not null)::int
  + (deposit_id is not null)::int = 1
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Proof required
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.require_transfer_proof()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.attachments a where a.disbursement_id = new.id) then
    raise exception
      'a transfer needs proof attached — the bank confirmation, or a photo of the cash handover (transfer %)',
      new.id
      using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end;
$$;

create constraint trigger disbursements_require_proof
  after insert on public.disbursements
  deferrable initially deferred
  for each row execute function public.require_transfer_proof();

create or replace function public.require_deposit_proof()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.attachments a where a.deposit_id = new.id) then
    raise exception
      'incoming funds need proof attached — the deposit slip or bank confirmation (deposit %)',
      new.id
      using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end;
$$;

create constraint trigger account_deposits_require_proof
  after insert on public.account_deposits
  deferrable initially deferred
  for each row execute function public.require_deposit_proof();

-- The proof cannot be stripped afterwards, same as a receipt cannot.
create or replace function public.guard_proof_deletion()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_remaining integer;
begin
  if old.disbursement_id is not null then
    select count(*) into v_remaining
    from public.attachments a
    where a.disbursement_id = old.disbursement_id and a.id <> old.id;

    if v_remaining = 0 and exists (
      select 1 from public.disbursements d
      where d.id = old.disbursement_id and d.status <> 'rejected'
    ) then
      raise exception
        'cannot remove the last proof from transfer % — it would leave an unsupported movement of money',
        old.disbursement_id
        using errcode = 'integrity_constraint_violation';
    end if;
  end if;

  if old.deposit_id is not null then
    select count(*) into v_remaining
    from public.attachments a
    where a.deposit_id = old.deposit_id and a.id <> old.id;

    if v_remaining = 0 and exists (
      select 1 from public.account_deposits dep where dep.id = old.deposit_id
    ) then
      raise exception
        'cannot remove the last proof from deposit % — it would leave an unsupported movement of money',
        old.deposit_id
        using errcode = 'integrity_constraint_violation';
    end if;
  end if;

  return old;
end;
$$;

create trigger attachments_guard_proof_deletion
  before delete on public.attachments
  for each row execute function public.guard_proof_deletion();

-- ─────────────────────────────────────────────────────────────────────────────
-- Atomic writes: the row and its proof, or neither
-- ─────────────────────────────────────────────────────────────────────────────

-- Dropped, not replaced: the new signature takes an extra p_attachments
-- argument, so CREATE OR REPLACE would leave the old ten-argument version
-- sitting there as a callable overload — and that one writes a disbursement
-- with no proof at all. Removing it is what actually closes the gap.
drop function if exists public.record_disbursement_auto_budget(
  uuid, text, uuid, uuid, numeric, public.disbursement_method, text, date, text, uuid);

create or replace function public.record_disbursement_auto_budget(
  p_entity_id        uuid,
  p_category         text,
  p_from_account_id  uuid,
  p_to_director_id   uuid,
  p_amount           numeric,
  p_method           public.disbursement_method,
  p_disbursed_to_ref text,
  p_disbursed_on     date,
  p_note             text,
  p_recorded_by      uuid,
  p_attachments      jsonb default null
)
returns public.disbursements
language plpgsql
set search_path = ''
as $$
declare
  v_budget_line_id uuid;
  v_period         text;
  v_me             uuid := public.current_director_id();
  v_result         public.disbursements;
  v_att            jsonb;
begin
  if v_me is null then
    raise exception 'no active director record for the current session'
      using errcode = 'insufficient_privilege';
  end if;

  if p_attachments is null or jsonb_array_length(p_attachments) = 0 then
    raise exception 'proof of the transfer is required — attach the bank confirmation or a photo of the handover'
      using errcode = 'integrity_constraint_violation';
  end if;

  v_period := to_char(current_date, 'FMMonth YYYY');

  select id into v_budget_line_id from public.budget_lines
  where entity_id = p_entity_id and period = v_period and category = p_category
  limit 1;

  if v_budget_line_id is null then
    insert into public.budget_lines (entity_id, owner_director_id, period, project,
                                     category, allocated_amount, created_by)
    values (p_entity_id, p_to_director_id, v_period, 'Operations', p_category, 999999999, v_me)
    returning id into v_budget_line_id;
  end if;

  insert into public.disbursements (
    entity_id, budget_line_id, from_account_id, to_director_id,
    amount, method, disbursed_to_ref, disbursed_on, note, recorded_by
  ) values (
    p_entity_id, v_budget_line_id, p_from_account_id, p_to_director_id,
    p_amount, p_method, p_disbursed_to_ref, p_disbursed_on, p_note, v_me
  ) returning * into v_result;

  for v_att in select * from jsonb_array_elements(p_attachments)
  loop
    insert into public.attachments
      (entity_id, disbursement_id, kind, storage_path, mime_type, byte_size, uploaded_by)
    values (
      p_entity_id, v_result.id,
      coalesce((v_att ->> 'kind')::public.attachment_kind, 'transfer_proof'),
      v_att ->> 'storage_path',
      coalesce(v_att ->> 'mime_type', 'application/octet-stream'),
      nullif(v_att ->> 'byte_size', '')::integer,
      v_me
    );
  end loop;

  return v_result;
end;
$$;

create or replace function public.record_deposit(
  p_entity_id            uuid,
  p_to_account_id        uuid,
  p_amount               numeric,
  p_source_type          public.deposit_source,
  p_source_director_id   uuid,
  p_source_investor_name text,
  p_deposit_date         date,
  p_attachments          jsonb default null
)
returns public.account_deposits
language plpgsql
set search_path = ''
as $$
declare
  v_me     uuid := public.current_director_id();
  v_result public.account_deposits;
  v_att    jsonb;
begin
  if v_me is null then
    raise exception 'no active director record for the current session'
      using errcode = 'insufficient_privilege';
  end if;

  if p_attachments is null or jsonb_array_length(p_attachments) = 0 then
    raise exception 'proof of the deposit is required — attach the slip or bank confirmation'
      using errcode = 'integrity_constraint_violation';
  end if;

  insert into public.account_deposits (
    entity_id, to_account_id, amount, source_type,
    source_director_id, source_investor_name, deposit_date, recorded_by
  ) values (
    p_entity_id, p_to_account_id, p_amount, p_source_type,
    p_source_director_id, p_source_investor_name, p_deposit_date, v_me
  ) returning * into v_result;

  for v_att in select * from jsonb_array_elements(p_attachments)
  loop
    insert into public.attachments
      (entity_id, deposit_id, kind, storage_path, mime_type, byte_size, uploaded_by)
    values (
      p_entity_id, v_result.id,
      coalesce((v_att ->> 'kind')::public.attachment_kind, 'transfer_proof'),
      v_att ->> 'storage_path',
      coalesce(v_att ->> 'mime_type', 'application/octet-stream'),
      nullif(v_att ->> 'byte_size', '')::integer,
      v_me
    );
  end loop;

  return v_result;
end;
$$;

revoke execute on function public.record_disbursement_auto_budget(
  uuid, text, uuid, uuid, numeric, public.disbursement_method, text, date, text, uuid, jsonb)
  from public, anon;
grant execute on function public.record_disbursement_auto_budget(
  uuid, text, uuid, uuid, numeric, public.disbursement_method, text, date, text, uuid, jsonb)
  to authenticated, service_role;

revoke execute on function public.record_deposit(
  uuid, uuid, numeric, public.deposit_source, uuid, text, date, jsonb) from public, anon;
grant execute on function public.record_deposit(
  uuid, uuid, numeric, public.deposit_source, uuid, text, date, jsonb)
  to authenticated, service_role;
