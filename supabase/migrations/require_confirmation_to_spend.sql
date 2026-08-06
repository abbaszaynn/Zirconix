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
      v_att ->> 'sha256', v_me
    );
  end loop;

  select * into v_exp from public.expenditures where id = v_exp.id;
  return v_exp;
end;
$$;
