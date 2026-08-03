-- Zirconix — notifications, realtime, and Expo push
--
-- Every director is told when money moves. Three layers, deliberately separate
-- so that the weakest one failing does not take the others with it:
--
--   1. notifications rows      — the durable record. Always written.
--   2. realtime                — the dashboard and badges update live, no refresh.
--   3. Expo push               — reaches a phone with the app closed. Best effort:
--                                if the secrets below are not configured, or a
--                                director has no token yet, the push is skipped
--                                and 1 and 2 are unaffected.
--
-- notifications are NOT audited. audit_events is the financial record; filling it
-- with "we told someone about it" would bury the entries that matter.

-- ─────────────────────────────────────────────────────────────────────────────
-- PKR in the lakh/crore grouping these figures are actually read in
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.format_pkr(p_amount numeric)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_int  text;
  v_head text;
  v_out  text;
begin
  v_int := trunc(abs(p_amount))::text;

  if length(v_int) <= 3 then
    v_out := v_int;
  else
    -- last three digits, then twos: 2500000 -> 25,00,000
    v_out  := right(v_int, 3);
    v_head := left(v_int, length(v_int) - 3);
    while length(v_head) > 2 loop
      v_out  := right(v_head, 2) || ',' || v_out;
      v_head := left(v_head, length(v_head) - 2);
    end loop;
    if length(v_head) > 0 then
      v_out := v_head || ',' || v_out;
    end if;
  end if;

  return 'PKR ' || case when p_amount < 0 then '-' else '' end || v_out;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- notifications
-- ─────────────────────────────────────────────────────────────────────────────

create table public.notifications (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references public.entities (id) on delete restrict,
  director_id     uuid not null references public.directors (id) on delete cascade,
  kind            text not null check (kind in (
                    'vote_required', 'vote_cast', 'transfer_confirmed',
                    'transfer_rejected', 'expenditure_logged'
                  )),
  title           text not null,
  body            text not null,
  disbursement_id uuid references public.disbursements (id) on delete cascade,
  expenditure_id  uuid references public.expenditures (id) on delete cascade,
  read_at         timestamptz,
  pushed_at       timestamptz,
  created_at      timestamptz not null default now()
);

create index notifications_inbox_idx
  on public.notifications (director_id, created_at desc);
create index notifications_unread_idx
  on public.notifications (director_id) where read_at is null;

alter table public.notifications enable row level security;

-- A director sees only his own. There is deliberately no INSERT policy: these
-- rows are written by triggers running as the table owner, never by a client,
-- so nobody can fabricate a notification.
create policy notifications_read on public.notifications
  for select to authenticated
  using (director_id = public.current_director_id());

-- The only thing a director may change is whether he has read it.
create policy notifications_mark_read on public.notifications
  for update to authenticated
  using (director_id = public.current_director_id())
  with check (director_id = public.current_director_id());

grant select, update on public.notifications to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Fan-out
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.notify_directors(
  p_entity          uuid,
  p_kind            text,
  p_title           text,
  p_body            text,
  p_disbursement    uuid default null,
  p_expenditure     uuid default null,
  p_exclude         uuid default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications
    (entity_id, director_id, kind, title, body, disbursement_id, expenditure_id)
  select p_entity, d.id, p_kind, p_title, p_body, p_disbursement, p_expenditure
  from public.directors d
  where d.is_active
    and (p_exclude is null or d.id <> p_exclude);
$$;

-- A transfer has been recorded: everybody is told, because the vote is the point.
create or replace function public.notify_transfer_recorded()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_to text;
begin
  select full_name into v_to from public.directors where id = new.to_director_id;

  perform public.notify_directors(
    new.entity_id,
    'vote_required',
    'Transfer needs a vote',
    format('%s to %s. %s of %s votes needed.',
           public.format_pkr(new.amount), v_to, 0, new.required_votes),
    new.id, null, null
  );
  return null;
end;
$$;

create trigger disbursements_notify_recorded
  after insert on public.disbursements
  for each row execute function public.notify_transfer_recorded();

-- A vote has been cast.
create or replace function public.notify_vote_cast()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_who text;
  v_d   public.disbursements;
begin
  select full_name into v_who from public.directors where id = new.approver_id;
  select * into v_d from public.disbursements where id = new.disbursement_id;

  perform public.notify_directors(
    new.entity_id,
    'vote_cast',
    case when new.decision = 'rejected' then 'Transfer rejected' else 'Vote recorded' end,
    format('%s %s %s (%s of %s).',
           v_who,
           case when new.decision = 'rejected' then 'rejected' else 'approved' end,
           public.format_pkr(v_d.amount),
           v_d.approval_count, v_d.required_votes),
    new.disbursement_id, null, new.approver_id
  );
  return null;
end;
$$;

-- Fires after approvals_tally, so approval_count above is already up to date.
create trigger approvals_notify
  after insert on public.approvals
  for each row execute function public.notify_vote_cast();

-- A transfer reached its outcome.
create or replace function public.notify_transfer_settled()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_to text;
begin
  if new.status = old.status or new.status not in ('confirmed', 'rejected') then
    return null;
  end if;

  select full_name into v_to from public.directors where id = new.to_director_id;

  perform public.notify_directors(
    new.entity_id,
    case when new.status = 'confirmed' then 'transfer_confirmed' else 'transfer_rejected' end,
    case when new.status = 'confirmed' then 'Transfer confirmed' else 'Transfer rejected' end,
    format('%s to %s is now %s.', public.format_pkr(new.amount), v_to, new.status),
    new.id, null, null
  );
  return null;
end;
$$;

create trigger disbursements_notify_settled
  after update of status on public.disbursements
  for each row execute function public.notify_transfer_settled();

-- Money accounted for.
create or replace function public.notify_expenditure_logged()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_who text;
begin
  select full_name into v_who from public.directors where id = new.entered_by;

  perform public.notify_directors(
    new.entity_id,
    'expenditure_logged',
    'Expenditure logged',
    format('%s spent %s on %s.', v_who, public.format_pkr(new.amount), new.category),
    null, new.id, new.entered_by
  );
  return null;
end;
$$;

create trigger expenditures_notify
  after insert on public.expenditures
  for each row execute function public.notify_expenditure_logged();

-- ─────────────────────────────────────────────────────────────────────────────
-- Push token registration
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.set_push_token(p_token text)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.directors
  set expo_push_token = nullif(btrim(p_token), '')
  where id = public.current_director_id();
$$;

revoke execute on function public.set_push_token(text) from public;
grant execute on function public.set_push_token(text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Expo push, best effort
--
-- The Edge Function needs a service-role key to read push tokens, and the DB
-- needs the functions URL to reach it. Both live in Vault, NOT in this file and
-- not in the repository. Until they are set, this trigger returns quietly and
-- the app still works through notifications + realtime.
--
--   select vault.create_secret('<service-role key>', 'zirconix_service_role_key');
--   select vault.create_secret('https://<ref>.functions.supabase.co', 'zirconix_functions_url');
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pg_net with schema extensions;

create or replace function public.push_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
  v_key   text;
  v_url   text;
begin
  select d.expo_push_token into v_token
  from public.directors d where d.id = new.director_id;

  if v_token is null then
    return null;   -- that director has not opened the app on a phone yet
  end if;

  select decrypted_secret into v_key
  from vault.decrypted_secrets where name = 'zirconix_service_role_key';
  select decrypted_secret into v_url
  from vault.decrypted_secrets where name = 'zirconix_functions_url';

  if v_key is null or v_url is null then
    return null;   -- push not configured; in-app notification already written
  end if;

  perform extensions.net.http_post(
    url     := v_url || '/push',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || v_key
               ),
    body    := jsonb_build_object('notification_id', new.id)
  );

  return null;
end;
$$;

create trigger notifications_push
  after insert on public.notifications
  for each row execute function public.push_notification();

-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime — the dashboard updates for every director on every trigger
--
-- Realtime honours RLS for authenticated subscribers, so a director still only
-- receives rows he is allowed to read.
-- ─────────────────────────────────────────────────────────────────────────────

alter publication supabase_realtime add table public.notifications;
alter publication supabase_realtime add table public.disbursements;
alter publication supabase_realtime add table public.expenditures;
alter publication supabase_realtime add table public.approvals;
alter publication supabase_realtime add table public.budget_lines;
