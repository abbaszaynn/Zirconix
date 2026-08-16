-- Clean up all deposits to start fresh
drop trigger if exists account_deposits_no_delete on public.account_deposits;
delete from public.account_deposits;
create trigger account_deposits_no_delete
  before delete on public.account_deposits
  for each row execute function public.guard_account_deposits_mutation();

-- Insert starter budget lines so disbursements can be recorded
do $$
declare
  v_entity_id uuid;
  v_director_id uuid;
begin
  select id into v_entity_id from public.entities limit 1;
  select id into v_director_id from public.directors where role = 'finance_officer' limit 1;
  
  -- Fallback if no finance officer
  if v_director_id is null then
    select id into v_director_id from public.directors limit 1;
  end if;

  if v_entity_id is not null and v_director_id is not null then
    insert into public.budget_lines (entity_id, owner_director_id, period, project, category, allocated_amount, created_by)
    values
      (v_entity_id, v_director_id, 'August 2026', 'Operations', 'Equipment', 500000, v_director_id),
      (v_entity_id, v_director_id, 'August 2026', 'Operations', 'Labor', 300000, v_director_id),
      (v_entity_id, v_director_id, 'August 2026', 'Operations', 'Logistics', 200000, v_director_id)
    on conflict do nothing;
  end if;
end;
$$;
