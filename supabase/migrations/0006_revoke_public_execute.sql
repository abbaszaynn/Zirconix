-- Zirconix — close the PUBLIC execute grant on the RLS helpers
--
-- 0005 revoked EXECUTE from `anon`, which did nothing: Postgres grants EXECUTE
-- on a new function to the PUBLIC pseudo-role, and `anon` inherits it. Revoking
-- from a role that never held a direct grant leaves the inherited one intact.
--
-- The one that actually mattered is verify_audit_chain(): it is SECURITY DEFINER
-- and reads every row of audit_events, so an unauthenticated caller could learn
-- how many audit events exist across both companies.
--
-- Safe to revoke from PUBLIC because `authenticated` is granted explicitly below,
-- and RLS policies evaluate as the calling role — which is `authenticated`.

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.current_director_id()',
    'public.current_director_role()',
    'public.is_entity_member(uuid)',
    'public.can_write()',
    'public.has_mfa_session()',
    'public.storage_entity_id(text)',
    'public.approval_threshold()',
    'public.verify_audit_chain(bigint)',
    'public.log_expenditure(uuid, numeric, text, text, date, jsonb, text)',
    'public.decide_approval(text, uuid, public.approval_decision, text)'
  ]
  loop
    execute format('revoke execute on function %s from public', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end;
$$;

-- Stop the same hole reappearing for anything added later.
alter default privileges in schema public revoke execute on functions from public;

-- public.rls_auto_enable() is deliberately untouched. It is Supabase's own event
-- trigger that auto-enables RLS on newly created tables. It returns
-- `event_trigger`, which PostgREST cannot invoke, so the linter's warning about
-- it is a false positive — and it is a safety net worth keeping.
