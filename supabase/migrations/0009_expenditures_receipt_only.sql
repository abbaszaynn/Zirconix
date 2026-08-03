-- Zirconix — an expenditure is controlled by its receipt, nothing else
--
-- Expenditures no longer have an approval path at any amount. That makes the
-- receipt the ONLY thing standing between a claim and the books, so the guards
-- around it (0002) become load-bearing rather than belt-and-braces:
--
--   expenditures_require_receipt      deferred to COMMIT, so log_expenditure()
--                                     can write the row and its receipt together
--                                     while a bare INSERT still fails
--   attachments_guard_receipt_deletion  the last receipt cannot be removed
--
-- Neither is touched here. They are what this change leans on.

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

  new.entered_by    := v_me;        -- authorship is not client input
  new.receipt_count := 0;           -- set by sync_receipt_count() when one lands
  new.status        := 'auto_confirmed';

  return new;
end;
$$;

comment on function public.stamp_expenditure() is
  'Records an expenditure immediately. The receipt is the control; there is no approval step at any amount.';

-- ─────────────────────────────────────────────────────────────────────────────
-- log_expenditure: same as before, plus a refusal to spend a rejected advance
--
-- A rejected transfer is a record that money should NOT have moved. Accounting
-- against it would launder a refused transfer into the books as legitimate spend.
--
-- A transfer still awaiting its vote is allowed: the money has physically
-- changed hands, and a director who spent it today should be able to log the
-- receipt today rather than wait on his colleagues.
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
set search_path = ''
as $$
declare
  v_me     uuid := public.current_director_id();
  v_entity uuid;
  v_to     uuid;
  v_status public.entry_status;
  v_exp    public.expenditures;
  v_att    jsonb;
begin
  if v_me is null then
    raise exception 'no active director record for the current session'
      using errcode = 'insufficient_privilege';
  end if;

  if p_attachments is null or jsonb_array_length(p_attachments) = 0 then
    raise exception 'a receipt or payment confirmation is required for every expenditure'
      using errcode = 'integrity_constraint_violation';
  end if;

  select d.entity_id, d.to_director_id, d.status
    into v_entity, v_to, v_status
  from public.disbursements d where d.id = p_disbursement_id;

  if v_entity is null then
    raise exception 'that advance does not exist, or is not yours to see'
      using errcode = 'no_data_found';
  end if;

  if v_status = 'rejected' then
    raise exception 'that transfer was rejected; you cannot account for money the board refused'
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
      v_att ->> 'sha256', v_me
    );
  end loop;

  select * into v_exp from public.expenditures where id = v_exp.id;
  return v_exp;
end;
$$;

revoke execute on function
  public.log_expenditure(uuid, numeric, text, text, date, jsonb, text) from public;
grant execute on function
  public.log_expenditure(uuid, numeric, text, text, date, jsonb, text)
  to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- v_transfer_votes — what the approvals screen reads
--
-- security_invoker so RLS applies to the caller, matching the other three views.
-- ─────────────────────────────────────────────────────────────────────────────

create view public.v_transfer_votes
with (security_invoker = on) as
select
  d.id              as disbursement_id,
  d.entity_id,
  d.amount,
  d.status,
  d.required_votes,
  d.approval_count,
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
  -- One person acting as both sender and recipient counts once, so the shortfall
  -- has to be made up by an extra independent. Mirrors tally_disbursement_votes().
  (select count(distinct p)
     from unnest(array[d.recorded_by, d.to_director_id]) p)::int as principals,
  exists (
    select 1 from public.approvals a
    where a.disbursement_id = d.id
      and a.approver_id = d.recorded_by and a.decision = 'approved'
  ) as sender_voted,
  exists (
    select 1 from public.approvals a
    where a.disbursement_id = d.id
      and a.approver_id = d.to_director_id and a.decision = 'approved'
  ) as recipient_voted,
  (select count(*) from public.approvals a
    where a.disbursement_id = d.id
      and a.decision = 'approved'
      and a.approver_id <> d.recorded_by
      and a.approver_id <> d.to_director_id)::int as independent_votes,
  greatest(
    d.required_votes
      - (select count(distinct p) from unnest(array[d.recorded_by, d.to_director_id]) p)::int,
    0
  )::int as independents_required
from public.disbursements d
join public.accounts    acct on acct.id = d.from_account_id
join public.directors   rec  on rec.id  = d.to_director_id
join public.directors   snd  on snd.id  = d.recorded_by
join public.budget_lines bl  on bl.id   = d.budget_line_id;

grant select on public.v_transfer_votes to authenticated;
