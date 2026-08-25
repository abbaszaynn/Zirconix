-- 0016_expenditure_delete_policy.sql
-- Allow directors to delete expenditures (e.g. to remove duplicate entries)

create policy expenditures_delete on public.expenditures
  for delete to authenticated
  using (public.is_entity_member(entity_id) and public.can_write());
