-- Zirconix — push_notification() was calling a function that does not exist
--
-- extensions.net.http_post(...) is not valid Postgres syntax for "the net
-- schema's http_post, and net happens to live alongside pg_net's other bits
-- in extensions" — Postgres reads a three-part reference as
-- database.schema.function, and rejected it outright:
--
--   0A000: cross-database references are not implemented: extensions.net.http_post
--
-- pg_net installs http_post directly in its own `net` schema, not nested
-- under `extensions`. The correct call is net.http_post(...).
--
-- This was DORMANT, not merely broken: push_notification() returns early
-- whenever zirconix_service_role_key / zirconix_functions_url are unset, and
-- they were unset from the day this was first written until just now. The
-- moment they were set, the very next INSERT into notifications would have
-- reached the bad call and RAISED — and because this is an unguarded PERFORM
-- inside an AFTER INSERT trigger, that exception would propagate all the way
-- back through notify_expenditure_logged() / notify_transfer_recorded() /
-- etc. and abort the disbursement or expenditure INSERT that triggered it in
-- the first place. Push delivery failing was one query away from silently
-- taking down real financial entries.
--
-- Fixed at the source (net.http_post, not extensions.net.http_post) and also
-- wrapped in its own exception handler, so this invariant is enforced by the
-- code rather than merely stated in a comment: nothing about push delivery —
-- wrong schema, pg_net disabled, a network failure, anything — can ever again
-- prevent the notification row (or the disbursement/expenditure that caused
-- it) from committing. Push is best-effort by design; now it fails that way
-- in practice too.

create or replace function public.push_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key         text;
  v_url         text;
  v_vapid_pub   text;
  v_vapid_priv  text;
begin
  select decrypted_secret into v_key
  from vault.decrypted_secrets where name = 'zirconix_service_role_key';
  select decrypted_secret into v_url
  from vault.decrypted_secrets where name = 'zirconix_functions_url';

  if v_key is null or v_url is null then
    return null;   -- push not configured; in-app notification already written
  end if;

  select decrypted_secret into v_vapid_pub
  from vault.decrypted_secrets where name = 'zirconix_vapid_public_key';
  select decrypted_secret into v_vapid_priv
  from vault.decrypted_secrets where name = 'zirconix_vapid_private_key';

  begin
    perform net.http_post(
      url     := v_url || '/push',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'Authorization', 'Bearer ' || v_key
                 ),
      body    := jsonb_build_object(
                   'notification_id', new.id,
                   'vapid_public_key', v_vapid_pub,
                   'vapid_private_key', v_vapid_priv
                 )
    );
  exception when others then
    raise warning 'push_notification: delivery attempt failed for notification %: %', new.id, sqlerrm;
  end;

  return null;
end;
$$;
