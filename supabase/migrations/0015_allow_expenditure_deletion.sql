-- Allow authors to delete their own expenditures
create policy expenditures_delete_own on public.expenditures
  for delete to authenticated
  using (
    entity_id in (select entity_id from public.director_entities where director_id = auth.uid())
    and entered_by = auth.uid()
  );

-- We must bypass the 'guard_receipt_deletion' when the entire expenditure is being deleted,
-- otherwise the ON DELETE CASCADE on attachments fails because it thinks we're leaving an unsupported claim.

create or replace function public.before_expenditure_delete()
returns trigger
language plpgsql
as $$
begin
  -- set a local flag so attachments trigger knows we are deleting the expenditure
  perform set_config('zirconix.deleting_expenditure', 'on', true);
  return old;
end;
$$;

create trigger expenditures_set_deleting_flag
  before delete on public.expenditures
  for each row execute function public.before_expenditure_delete();

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

  -- Allow deletion if we are cascading from an expenditure delete
  if current_setting('zirconix.deleting_expenditure', true) = 'on' then
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
