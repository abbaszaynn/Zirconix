-- Zirconix — a director's advances are one pool, not separate buckets
--
-- 6,000 + 10,000 + 15,000 to the same director was three disbursement rows,
-- each with its own remaining balance, and log_expenditure() made the
-- director pick which one to charge against. That is correct as a LEDGER —
-- each transfer is still its own voted, audited row — but wrong as something
-- a director has to think about while spending: he was given 31,000 in total
-- and should be able to draw against 31,000 in total.
--
-- The ledger does not change. What changes is that guard_expenditure_within_
-- advance() now caps against the SUM of a director's live advances rather
-- than the single advance an expenditure happens to be attached to, and
-- log_expenditure() no longer takes p_disbursement_id from the client — it
-- picks one of the director's live advances itself, purely as the FK anchor
-- every expenditure still needs. Which one is arbitrary bookkeeping now; the
-- real number a director sees is the pool.

-- ─────────────────────────────────────────────────────────────────────────────
-- The cap, pool-wide
--
-- FOR UPDATE now locks every one of the director's live advance rows, not
-- just the one the new expenditure is attached to — two expenditures racing
-- against the same POOL (even against different advances within it) must not
-- both read the pool before either commits.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.guard_expenditure_within_advance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_director uuid;
  v_pool     numeric;
  v_already  numeric;
begin
  select d.to_director_id into v_director
  from public.disbursements d
  where d.id = new.disbursement_id;

  if v_director is null then
    return new;   -- the FK will reject this anyway
  end if;

  perform 1
  from public.disbursements d
  where d.to_director_id = v_director
    and d.status in ('confirmed', 'auto_confirmed')
    and d.voided_at is null
  for update;

  select coalesce(sum(d.amount), 0) into v_pool
  from public.disbursements d
  where d.to_director_id = v_director
    and d.status in ('confirmed', 'auto_confirmed')
    and d.voided_at is null;

  select coalesce(sum(e.amount), 0) into v_already
  from public.expenditures e
  join public.disbursements d on d.id = e.disbursement_id
  where d.to_director_id = v_director
    and e.status <> 'rejected'
    and e.id <> new.id;

  if v_already + new.amount > v_pool then
    raise exception
      'that would put % against a total of % advanced to this director (% already accounted for '
      'across all of it). You cannot account for more than was given in total — if you spent your '
      'own money, it needs to be recorded as a further transfer first.',
      public.format_pkr(v_already + new.amount),
      public.format_pkr(v_pool),
      public.format_pkr(v_already)
      using errcode = 'integrity_constraint_violation';
  end if;

  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- log_expenditure — the director no longer names an advance, only himself
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists public.log_expenditure(uuid, numeric, text, text, date, jsonb, text);

create or replace function public.log_expenditure(
  p_director_id uuid,
  p_amount      numeric,
  p_category    text,
  p_payee       text,
  p_spent_on    date,
  p_attachments jsonb,
  p_note        text default null
)
returns public.expenditures
language plpgsql
set search_path = ''
as $$
declare
  v_me              uuid := public.current_director_id();
  v_disbursement_id uuid;
  v_entity          uuid;
  v_exp             public.expenditures;
  v_att             jsonb;
begin
  if v_me is null then
    raise exception 'no active director record for the current session'
      using errcode = 'insufficient_privilege';
  end if;

  if p_attachments is null or jsonb_array_length(p_attachments) = 0 then
    raise exception 'a receipt or payment confirmation is required for every expenditure'
      using errcode = 'integrity_constraint_violation';
  end if;

  if p_director_id <> v_me and public.current_director_role() <> 'finance_officer' then
    raise exception
      'you can only log an expenditure against your own advances (or, as a finance officer, another director''s)'
      using errcode = 'insufficient_privilege';
  end if;

  -- Any live advance to this director anchors the FK; the oldest is as good
  -- a choice as any, since the cap above is pool-wide, not per-row.
  select d.id, d.entity_id into v_disbursement_id, v_entity
  from public.disbursements d
  where d.to_director_id = p_director_id
    and d.status in ('confirmed', 'auto_confirmed')
    and d.voided_at is null
  order by d.created_at
  limit 1;

  if v_disbursement_id is null then
    raise exception 'no advance has been confirmed for that director yet'
      using errcode = 'no_data_found';
  end if;

  insert into public.expenditures
    (entity_id, disbursement_id, amount, category, payee, note, spent_on, entered_by)
  values
    (v_entity, v_disbursement_id, p_amount, p_category, p_payee, p_note, p_spent_on, v_me)
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
  public.log_expenditure(uuid, numeric, text, text, date, jsonb, text) from public, anon;
grant execute on function
  public.log_expenditure(uuid, numeric, text, text, date, jsonb, text)
  to authenticated, service_role;
