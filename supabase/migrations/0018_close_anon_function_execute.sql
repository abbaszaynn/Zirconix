-- Zirconix — close a recurring "anon can call it" gap on RPC functions
--
-- Found while fixing expenditure deletion: delete_own_expenditure() came back
-- from has_function_privilege('anon', ..., 'EXECUTE') = true, immediately after
-- being created with the same "revoke from public, grant to authenticated"
-- pattern used everywhere else in this codebase (0006, 0008, 0009). That
-- pattern has a gap: REVOKE ... FROM PUBLIC removes the privilege PUBLIC holds;
-- it does nothing to a privilege granted directly TO anon. Something in this
-- project's migration path keeps handing new functions a direct anon grant at
-- creation time, independent of the PUBLIC default — checked, and it is not
-- limited to functions written in this session: cast_disbursement_vote (0008)
-- has the exact same gap despite using the identical revoke-then-grant lines.
-- Functions fixed directly by name in 0006 (log_expenditure, verify_audit_chain,
-- the RLS helpers) are still clean, so the gap is specifically "anything created
-- or replaced since, using only the public-revoke idiom."
--
-- Practical exposure was limited — every SECURITY DEFINER function on the list
-- opens with a current_director_id() check that raises for anon (no director
-- row, no session), and every SECURITY INVOKER one still has to clear RLS,
-- which independently requires a director identity. Nothing here is a "can
-- delete anyone's data unauthenticated" hole. But relying on the function body
-- to reject anon, when the intent was for anon to never reach EXECUTE in the
-- first place, is exactly the gap 0006 already closed once — it should not
-- have been able to reopen silently.
--
-- Fix: revoke from PUBLIC and anon on every function in the schema, then
-- re-grant EXECUTE to authenticated (+ service_role) on exactly the functions a
-- signed-in client is meant to call directly. Trigger functions get no re-grant
-- — they run as part of the trigger mechanism, not via a direct RPC call, so an
-- EXECUTE grant to authenticated was never load-bearing for them.

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
  end loop;
end;
$$;

-- The direct-call surface: functions a signed-in director's client is meant to
-- invoke, either as an RPC or implicitly as an RLS policy predicate.
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
    'public.cast_disbursement_vote(uuid, public.approval_decision, text)',
    'public.delete_own_expenditure(uuid)',
    'public.set_push_token(text)',
    'public.record_disbursement_auto_budget(uuid, text, uuid, uuid, numeric, public.disbursement_method, text, date, text, uuid)',
    'public.format_pkr(numeric)'
  ]
  loop
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end;
$$;

-- Stops the automatic-PUBLIC-grant half of this from reappearing for anything
-- created later by the role running this migration. It does not reach anon —
-- that is why the loop above exists and why this alone was not sufficient.
alter default privileges in schema public revoke execute on functions from public;
