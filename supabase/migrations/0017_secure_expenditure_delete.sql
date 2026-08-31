-- Zirconix — close the "any director can delete/edit anyone's expenditure" hole
--
-- Two policies were layered on top of each other trying to let a director
-- delete his own log, and between them they landed on the opposite of what was
-- intended:
--
--   expenditures_delete_own (0015): `entered_by = auth.uid()`
--     entered_by is a directors.id. auth.uid() is an auth.users id. These are
--     two different UUID spaces — a director's row id was never meant to equal
--     the Supabase auth user id that signed them in. This predicate is FALSE
--     for every row, always, so the policy grants nobody anything. (The
--     correct comparison is entered_by = current_director_id(), the
--     SECURITY DEFINER helper that exists specifically to do this translation
--     — attachments_delete_own already uses it correctly.)
--
--   expenditures_delete (0016): `is_entity_member(entity_id) AND can_write()`
--     Added because the policy above appeared to do nothing. This one has no
--     ownership clause at all, so it does the opposite: ANY director or
--     finance officer can delete ANY OTHER director's expenditure.
--
-- RLS policies are OR'd together, so live today: policy 0015 contributes
-- nothing, policy 0016 lets any of the 8 directors erase any of the others'
-- spending log. expenditures_update has the identical shape of hole — no
-- ownership clause, same fix applies.
--
-- Fix: deletion moves behind a SECURITY DEFINER RPC, the same pattern already
-- used for log_expenditure and cast_disbursement_vote, so there is exactly one
-- codepath and it cannot be bypassed by calling the table directly. Update
-- stays as a direct table policy (simpler, and guard_financial_update already
-- pins amount/entity/author/source), just with the ownership clause it should
-- have had from the start.

drop policy if exists expenditures_delete_own on public.expenditures;
drop policy if exists expenditures_delete on public.expenditures;

drop policy expenditures_update on public.expenditures;

create policy expenditures_update on public.expenditures
  for update to authenticated
  using (is_entity_member(entity_id) and can_write() and entered_by = current_director_id())
  with check (is_entity_member(entity_id) and can_write() and entered_by = current_director_id());

-- No DELETE policy is added back. With none, RLS denies every direct client
-- delete on this table — the only way in is delete_own_expenditure() below.

create or replace function public.delete_own_expenditure(p_expenditure_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me         uuid := public.current_director_id();
  v_entered_by uuid;
begin
  if v_me is null then
    raise exception 'no active director record for the current session'
      using errcode = 'insufficient_privilege';
  end if;

  select entered_by into v_entered_by
  from public.expenditures
  where id = p_expenditure_id;

  if v_entered_by is null then
    raise exception 'that expenditure does not exist, or is not yours to see'
      using errcode = 'no_data_found';
  end if;

  if v_entered_by <> v_me then
    raise exception 'you can only delete an expenditure you logged yourself'
      using errcode = 'insufficient_privilege';
  end if;

  -- Cascades to its attachment(s). expenditures_set_deleting_flag (0015) sets
  -- zirconix.deleting_expenditure before this fires, so guard_receipt_deletion
  -- recognises the receipt is leaving together with the claim it supports,
  -- rather than being stripped out from under a claim that stays.
  delete from public.expenditures where id = p_expenditure_id;

  -- Nothing else to reverse: v_disbursement_balance.spent and
  -- v_director_accountability.total_accounted / outstanding are live SUMs over
  -- the expenditures table, so the moment this row is gone its amount is back
  -- off every balance and gap figure without any separate bookkeeping step.

  -- The deletion is not a way to make the fact disappear. audit_row_change()
  -- still writes a DELETE event carrying the full row as `before`, hash-chained
  -- like every other entry — who deleted what, and exactly what it said,
  -- stays in the permanent record even though the live table no longer shows it.
end;
$$;

revoke execute on function public.delete_own_expenditure(uuid) from public;
grant execute on function public.delete_own_expenditure(uuid) to authenticated, service_role;
