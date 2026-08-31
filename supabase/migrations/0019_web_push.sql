-- Zirconix — Web Push: notifications reach a director even with the browser
-- tab closed, on any browser/device where they granted permission.
--
-- Distinct from the existing Expo push path (native iOS/Android app), which
-- this leaves untouched. A browser subscription has a different shape (an
-- endpoint URL plus two keys, not a single opaque token) and, unlike
-- expo_push_token, a director can reasonably have several — one per browser
-- per device — so this is its own table rather than a column on directors.

create table public.web_push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  director_id uuid not null references public.directors (id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth_key    text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);

create index web_push_subscriptions_director_idx on public.web_push_subscriptions (director_id);

alter table public.web_push_subscriptions enable row level security;

create policy web_push_subscriptions_read on public.web_push_subscriptions
  for select to authenticated
  using (director_id = public.current_director_id());

-- No direct INSERT/UPDATE/DELETE policy — save_web_push_subscription() below
-- is SECURITY DEFINER and is the only way to write these, so a subscription
-- can never be registered against, or read out from under, another director.

create or replace function public.save_web_push_subscription(
  p_endpoint   text,
  p_p256dh     text,
  p_auth       text,
  p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := public.current_director_id();
begin
  if v_me is null then
    raise exception 'no active director record for the current session'
      using errcode = 'insufficient_privilege';
  end if;

  -- Re-subscribing (permission re-granted, browser storage cleared and
  -- reissued the same endpoint, etc.) updates in place rather than erroring
  -- on the unique constraint.
  insert into public.web_push_subscriptions (director_id, endpoint, p256dh, auth_key, user_agent)
  values (v_me, p_endpoint, p_p256dh, p_auth, p_user_agent)
  on conflict (endpoint) do update
    set director_id = excluded.director_id,
        p256dh       = excluded.p256dh,
        auth_key     = excluded.auth_key,
        user_agent   = excluded.user_agent,
        created_at   = now();
end;
$$;

-- Both PUBLIC and anon explicitly: see 0018 for why REVOKE ... FROM PUBLIC
-- alone is not enough — this codebase's migration pipeline has repeatedly
-- handed brand-new functions a direct grant to anon regardless.
revoke execute on function public.save_web_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.save_web_push_subscription(text, text, text, text)
  to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- push_notification(): now also carries the VAPID keypair to the edge function
--
-- The function's own supabase-js client talks over PostgREST, which does not
-- expose the vault schema — vault.decrypted_secrets is only reachable from
-- inside Postgres. So, same as zirconix_service_role_key / zirconix_functions_url
-- already do, the keys are read here and handed to the edge function in the
-- request body rather than the function fetching them itself.
-- ─────────────────────────────────────────────────────────────────────────────

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

  perform extensions.net.http_post(
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

  return null;
end;
$$;
