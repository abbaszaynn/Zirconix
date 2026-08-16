create or replace function public.record_disbursement_auto_budget(
  p_entity_id uuid,
  p_category text,
  p_from_account_id uuid,
  p_to_director_id uuid,
  p_amount numeric,
  p_method public.disbursement_method,
  p_disbursed_to_ref text,
  p_disbursed_on date,
  p_note text,
  p_recorded_by uuid
) returns public.disbursements as $$
declare
  v_budget_line_id uuid;
  v_period text;
  v_result public.disbursements;
begin
  -- Use the current month as the period e.g. "August 2026"
  v_period := to_char(current_date, 'FMMonth YYYY');

  -- Try to find an existing budget line for this period and category
  select id into v_budget_line_id from public.budget_lines
  where entity_id = p_entity_id and period = v_period and category = p_category
  limit 1;

  -- If not found, auto-create a budget line with an arbitrary large allocation
  if v_budget_line_id is null then
    insert into public.budget_lines (entity_id, owner_director_id, period, project, category, allocated_amount, created_by)
    values (p_entity_id, p_to_director_id, v_period, 'Operations', p_category, 999999999, p_recorded_by)
    returning id into v_budget_line_id;
  end if;

  -- Now insert the disbursement
  insert into public.disbursements (
    entity_id, budget_line_id, from_account_id, to_director_id, 
    amount, method, disbursed_to_ref, disbursed_on, note, recorded_by
  ) values (
    p_entity_id, v_budget_line_id, p_from_account_id, p_to_director_id,
    p_amount, p_method, p_disbursed_to_ref, p_disbursed_on, p_note, p_recorded_by
  ) returning * into v_result;

  return v_result;
end;
$$ language plpgsql security invoker;
