-- Zirconix — write RPCs, reporting views, storage buckets
--
-- Both RPCs are SECURITY INVOKER on purpose. They exist for ATOMICITY, not for
-- privilege: every row they touch is still filtered by the same RLS policies the
-- client would hit directly. Nothing here is a way around a control.

-- ─────────────────────────────────────────────────────────────────────────────
-- log_expenditure — expenditure + its receipt, in one transaction
--
-- This is the only sane way to satisfy "every expenditure has a receipt". A
-- two-call client sequence (insert row, then attach receipt) can always be
-- interrupted between the calls and leave an unsupported claim behind. Here the
-- deferred constraint trigger from 0002 checks at COMMIT, by which point either
-- both rows exist or neither does.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.log_expenditure(
  p_disbursement_id uuid,
  p_amount          numeric,
  p_category        text,
  p_payee           text,
  p_spent_on        date,
  p_attachments     jsonb,
  p_note            text default null
)
returns public.expenditures
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_me       uuid := public.current_director_id();
  v_entity   uuid;
  v_to       uuid;
  v_exp      public.expenditures;
  v_att      jsonb;
begin
  if v_me is null then
    raise exception 'no active director record for the current session'
      using errcode = 'insufficient_privilege';
  end if;

  if p_attachments is null or jsonb_array_length(p_attachments) = 0 then
    raise exception 'a receipt or payment confirmation is required for every expenditure'
      using errcode = 'integrity_constraint_violation';
  end if;

  -- Subject to RLS: you can only spend against a disbursement you can see.
  select d.entity_id, d.to_director_id
    into v_entity, v_to
  from public.disbursements d
  where d.id = p_disbursement_id;

  if v_entity is null then
    raise exception 'that disbursement does not exist, or is not yours to see'
      using errcode = 'no_data_found';
  end if;

  -- Imprest accounting: the person who took the advance is the person who has to
  -- account for it. A finance_officer may record on a director's behalf.
  if v_to <> v_me and public.current_director_role() <> 'finance_officer' then
    raise exception
      'this advance was disbursed to another director; only they (or a finance officer) can account for it'
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
      v_entity,
      v_exp.id,
      coalesce((v_att ->> 'kind')::public.attachment_kind, 'receipt_photo'),
      v_att ->> 'storage_path',
      coalesce(v_att ->> 'mime_type', 'application/octet-stream'),
      nullif(v_att ->> 'byte_size', '')::integer,
      v_att ->> 'sha256',
      v_me
    );
  end loop;

  -- Re-read so the caller gets the trigger-decided status and receipt_count.
  select * into v_exp from public.expenditures where id = v_exp.id;
  return v_exp;
end;
$$;

comment on function public.log_expenditure is
  'Records an expenditure together with its receipt atomically. The only supported way to create an expenditure.';

-- ─────────────────────────────────────────────────────────────────────────────
-- decide_approval — the second-director decision
--
-- Also SECURITY INVOKER. The self-approval block, the entity scope, the write
-- role and the MFA requirement are all enforced by the approvals_insert RLS
-- policy and the CHECK constraint, not by this function trusting itself.
--
-- The one privilege it takes is a transaction-local flag permitting the status
-- column to move — set_config is not reachable from a PostgREST client, so this
-- cannot be replayed by hand against a plain UPDATE.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.decide_approval(
  p_target_type text,
  p_target_id   uuid,
  p_decision    public.approval_decision,
  p_reason      text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_me        uuid := public.current_director_id();
  v_status    public.entry_status;
  v_submitter uuid;
  v_new       public.entry_status;
begin
  if v_me is null then
    raise exception 'no active director record for the current session'
      using errcode = 'insufficient_privilege';
  end if;

  if p_target_type not in ('expenditure', 'disbursement') then
    raise exception 'unknown approval target type: %', p_target_type;
  end if;

  if not public.has_mfa_session() then
    raise exception 'approving an entry requires a session verified with your authenticator app'
      using errcode = 'insufficient_privilege';
  end if;

  if p_decision = 'rejected' and length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'a rejection must include a reason';
  end if;

  if p_target_type = 'expenditure' then
    select e.status, e.entered_by into v_status, v_submitter
    from public.expenditures e where e.id = p_target_id;
  else
    select d.status, d.recorded_by into v_status, v_submitter
    from public.disbursements d where d.id = p_target_id;
  end if;

  if v_status is null then
    raise exception 'that entry does not exist, or is not yours to see'
      using errcode = 'no_data_found';
  end if;

  if v_status <> 'pending_approval' then
    raise exception 'this entry is already %, there is nothing to decide', v_status;
  end if;

  if v_submitter = v_me then
    raise exception 'you cannot approve an entry you submitted yourself'
      using errcode = 'insufficient_privilege';
  end if;

  v_new := case p_decision when 'approved' then 'confirmed' else 'rejected' end;

  perform set_config('zirconix.privileged_transition', 'on', true);

  if p_target_type = 'expenditure' then
    update public.expenditures set status = v_new where id = p_target_id;
    insert into public.approvals (expenditure_id, submitted_by, approver_id, decision, reason, entity_id)
    values (p_target_id, v_submitter, v_me, p_decision, p_reason,
            (select entity_id from public.expenditures where id = p_target_id));
  else
    update public.disbursements set status = v_new where id = p_target_id;
    insert into public.approvals (disbursement_id, submitted_by, approver_id, decision, reason, entity_id)
    values (p_target_id, v_submitter, v_me, p_decision, p_reason,
            (select entity_id from public.disbursements where id = p_target_id));
  end if;

  perform set_config('zirconix.privileged_transition', 'off', true);

  return jsonb_build_object(
    'target_type', p_target_type,
    'target_id',   p_target_id,
    'status',      v_new,
    'decided_by',  v_me
  );
end;
$$;

-- Neither RPC has any meaning for a signed-out caller.
revoke execute on function public.log_expenditure(uuid, numeric, text, text, date, jsonb, text) from anon;
revoke execute on function public.decide_approval(text, uuid, public.approval_decision, text) from anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- Reporting views
--
-- security_invoker = on so RLS follows through the view. Without it a view runs
-- as its owner and would happily hand a director the other company's numbers.
-- ─────────────────────────────────────────────────────────────────────────────

create view public.v_budget_summary with (security_invoker = on) as
select
  s.*,
  (s.allocated_amount - s.disbursed_amount)          as undisbursed_amount,
  (s.disbursed_amount - s.spent_amount)              as unaccounted_amount,
  (s.allocated_amount - s.spent_amount)              as available_amount
from (
  select
    bl.id                as budget_line_id,
    bl.entity_id,
    bl.period,
    bl.project,
    bl.category,
    bl.owner_director_id,
    bl.allocated_amount,
    coalesce((
      select sum(ds.amount)
      from public.disbursements ds
      where ds.budget_line_id = bl.id
        and ds.status <> 'rejected'
    ), 0)::numeric(18, 2) as disbursed_amount,
    coalesce((
      select sum(e.amount)
      from public.expenditures e
      join public.disbursements ds2 on ds2.id = e.disbursement_id
      where ds2.budget_line_id = bl.id
        and e.status <> 'rejected'
    ), 0)::numeric(18, 2) as spent_amount
  from public.budget_lines bl
) s;

comment on view public.v_budget_summary is
  'Allocated / disbursed / spent per budget line. unaccounted_amount is money that left the company but has not yet been explained by a receipted expenditure.';

-- The accountability view. This is the number the pilot exists to produce.
create view public.v_director_accountability with (security_invoker = on) as
select
  ds.entity_id,
  ds.to_director_id                                        as director_id,
  count(*)                                                 as advance_count,
  coalesce(sum(ds.amount), 0)::numeric(18, 2)              as total_disbursed,
  coalesce(sum(acc.receipted), 0)::numeric(18, 2)          as total_accounted,
  coalesce(sum(acc.unreceipted), 0)::numeric(18, 2)        as claimed_without_receipt,
  (coalesce(sum(ds.amount), 0) - coalesce(sum(acc.receipted), 0))::numeric(18, 2)
                                                           as outstanding
from public.disbursements ds
left join lateral (
  select
    coalesce(sum(e.amount) filter (where e.receipt_count > 0), 0) as receipted,
    coalesce(sum(e.amount) filter (where e.receipt_count = 0), 0) as unreceipted
  from public.expenditures e
  where e.disbursement_id = ds.id
    and e.status <> 'rejected'
) acc on true
where ds.status <> 'rejected'
group by ds.entity_id, ds.to_director_id;

comment on view public.v_director_accountability is
  'Per director per entity: money advanced, money explained by receipted expenditure, and the outstanding gap. A non-zero outstanding is a visible flag, not an error.';

-- Per-advance balance, for the expenditure form.
create view public.v_disbursement_balance with (security_invoker = on) as
select
  ds.id                                       as disbursement_id,
  ds.entity_id,
  ds.budget_line_id,
  ds.to_director_id,
  ds.amount                                   as advanced,
  ds.method,
  ds.disbursed_on,
  ds.status,
  coalesce((
    select sum(e.amount) from public.expenditures e
    where e.disbursement_id = ds.id and e.status <> 'rejected'
  ), 0)::numeric(18, 2)                       as spent,
  (ds.amount - coalesce((
    select sum(e.amount) from public.expenditures e
    where e.disbursement_id = ds.id and e.status <> 'rejected'
  ), 0))::numeric(18, 2)                      as remaining
from public.disbursements ds;

-- ─────────────────────────────────────────────────────────────────────────────
-- Storage
-- ─────────────────────────────────────────────────────────────────────────────

-- 5 MB ceiling. Receipts are compressed client-side to ~1600px / 70% JPEG, which
-- lands around 150–400 KB; the ceiling is only there to stop an accidental
-- full-resolution upload eating the 1 GB free-tier allowance.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts', 'receipts', false, 5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'statements', 'statements', false, 10485760,
  array['text/csv', 'application/pdf', 'text/plain']
)
on conflict (id) do nothing;

-- Receipt object keys are '<entity_id>/<yyyy>/<uuid>.<ext>'. This reads the
-- entity out of the key safely — a non-uuid first segment yields null, and
-- is_entity_member(null) is false, so a malformed key grants nothing.
create or replace function public.storage_entity_id(p_name text)
returns uuid
language sql immutable set search_path = ''
as $$
  select case
    when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(p_name, '/', 1)::uuid
  end
$$;

create policy receipts_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'receipts'
    and public.is_entity_member(public.storage_entity_id(name))
  );

create policy receipts_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'receipts'
    and public.is_entity_member(public.storage_entity_id(name))
    and public.can_write()
  );

-- Statement object keys are '<director_id>/<uuid>.<ext>' — your own drawer only.
create policy statements_select_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'statements'
    and split_part(name, '/', 1) = public.current_director_id()::text
  );

create policy statements_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'statements'
    and split_part(name, '/', 1) = public.current_director_id()::text
  );

create policy statements_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'statements'
    and split_part(name, '/', 1) = public.current_director_id()::text
  );
