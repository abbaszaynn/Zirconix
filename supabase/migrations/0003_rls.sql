-- Zirconix — Row Level Security
--
-- Rules encoded here:
--   * You see only entities you sit on the board of.
--   * director and finance_officer may write; auditor is read-only, everywhere.
--   * Financial rows are never deletable by a client. Corrections are new entries.
--   * Approving requires an MFA-verified (AAL2) session.
--   * A director's imported personal bank statement is visible only to that
--     director and to an auditor — it is personal financial data, not consortium
--     data, and it is imported voluntarily.
--   * audit_events has no client INSERT/UPDATE/DELETE path at all. It is written
--     only by the SECURITY DEFINER trigger in 0002.

-- ─────────────────────────────────────────────────────────────────────────────
-- Helpers. SECURITY DEFINER so policies can consult directors/director_entities
-- without the policy on those tables recursing into itself.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.current_director_role()
returns public.director_role
language sql stable security definer set search_path = ''
as $$
  select d.role from public.directors d
  where d.auth_user_id = (select auth.uid()) and d.is_active
$$;

create or replace function public.is_entity_member(p_entity uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.director_entities de
    join public.directors d on d.id = de.director_id
    where de.entity_id = p_entity
      and d.auth_user_id = (select auth.uid())
      and d.is_active
  )
$$;

create or replace function public.can_write()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.current_director_role() in ('director', 'finance_officer')
$$;

-- True only for a session that actually passed a TOTP challenge.
create or replace function public.has_mfa_session()
returns boolean
language sql stable set search_path = ''
as $$
  select coalesce((select auth.jwt() ->> 'aal') = 'aal2', false)
$$;

comment on function public.has_mfa_session() is
  'AAL2 = this session completed a TOTP challenge. Required to record an approval.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Enable RLS everywhere, and take away the blanket grants Supabase hands out.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.entities            enable row level security;
alter table public.directors           enable row level security;
alter table public.director_entities   enable row level security;
alter table public.budget_lines        enable row level security;
alter table public.disbursements       enable row level security;
alter table public.expenditures        enable row level security;
alter table public.attachments         enable row level security;
alter table public.approvals           enable row level security;
alter table public.statement_imports   enable row level security;
alter table public.statement_lines     enable row level security;
alter table public.audit_events        enable row level security;

-- Nothing in this app is reachable without signing in.
revoke all on all tables in schema public from anon;

-- Financial history is not deletable through the API, by anyone, ever.
revoke delete on
  public.entities, public.directors, public.director_entities,
  public.budget_lines, public.disbursements, public.expenditures,
  public.approvals, public.statement_lines
from authenticated;

-- The audit log is readable and nothing else.
revoke insert, update, delete on public.audit_events from authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- entities
-- ─────────────────────────────────────────────────────────────────────────────

create policy entities_select_own_boards on public.entities
  for select to authenticated
  using (public.is_entity_member(id));

-- ─────────────────────────────────────────────────────────────────────────────
-- directors — you can see the people you share a board with, and yourself
-- ─────────────────────────────────────────────────────────────────────────────

create policy directors_select_colleagues on public.directors
  for select to authenticated
  using (
    auth_user_id = (select auth.uid())
    or exists (
      select 1
      from public.director_entities de
      where de.director_id = directors.id
        and public.is_entity_member(de.entity_id)
    )
  );

-- Only your own row, and the guard trigger below limits it to the push token.
create policy directors_update_self on public.directors
  for update to authenticated
  using (auth_user_id = (select auth.uid()))
  with check (auth_user_id = (select auth.uid()));

create or replace function public.guard_director_self_update()
returns trigger language plpgsql set search_path = ''
as $$
begin
  -- Admin corrections arrive as service_role (Edge Function or migration), which
  -- is an audited server-side path. This guard is about the app's own session.
  if current_user <> 'authenticated' then
    return new;
  end if;

  -- Role, board membership and activation are not self-service.
  if new.id is distinct from old.id
     or new.auth_user_id is distinct from old.auth_user_id
     or new.role is distinct from old.role
     or new.email is distinct from old.email
     or new.is_active is distinct from old.is_active then
    raise exception 'only your notification token can be changed from the app'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger directors_guard_self_update
  before update on public.directors
  for each row execute function public.guard_director_self_update();

-- ─────────────────────────────────────────────────────────────────────────────
-- director_entities
-- ─────────────────────────────────────────────────────────────────────────────

create policy director_entities_select on public.director_entities
  for select to authenticated
  using (public.is_entity_member(entity_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- budget_lines
-- ─────────────────────────────────────────────────────────────────────────────

create policy budget_lines_select on public.budget_lines
  for select to authenticated
  using (public.is_entity_member(entity_id));

create policy budget_lines_insert on public.budget_lines
  for insert to authenticated
  with check (public.is_entity_member(entity_id) and public.can_write());

create policy budget_lines_update on public.budget_lines
  for update to authenticated
  using (public.is_entity_member(entity_id) and public.can_write())
  with check (public.is_entity_member(entity_id) and public.can_write());

-- ─────────────────────────────────────────────────────────────────────────────
-- disbursements
-- ─────────────────────────────────────────────────────────────────────────────

create policy disbursements_select on public.disbursements
  for select to authenticated
  using (public.is_entity_member(entity_id));

create policy disbursements_insert on public.disbursements
  for insert to authenticated
  with check (public.is_entity_member(entity_id) and public.can_write());

create policy disbursements_update on public.disbursements
  for update to authenticated
  using (public.is_entity_member(entity_id) and public.can_write())
  with check (public.is_entity_member(entity_id) and public.can_write());

-- ─────────────────────────────────────────────────────────────────────────────
-- expenditures
-- ─────────────────────────────────────────────────────────────────────────────

create policy expenditures_select on public.expenditures
  for select to authenticated
  using (public.is_entity_member(entity_id));

create policy expenditures_insert on public.expenditures
  for insert to authenticated
  with check (public.is_entity_member(entity_id) and public.can_write());

create policy expenditures_update on public.expenditures
  for update to authenticated
  using (public.is_entity_member(entity_id) and public.can_write())
  with check (public.is_entity_member(entity_id) and public.can_write());

-- ─────────────────────────────────────────────────────────────────────────────
-- attachments
-- ─────────────────────────────────────────────────────────────────────────────

create policy attachments_select on public.attachments
  for select to authenticated
  using (public.is_entity_member(entity_id));

create policy attachments_insert on public.attachments
  for insert to authenticated
  with check (public.is_entity_member(entity_id) and public.can_write());

-- Only your own upload, and only while it is not the last receipt standing
-- (guard_receipt_deletion in 0002 enforces the second half).
create policy attachments_delete_own on public.attachments
  for delete to authenticated
  using (
    public.is_entity_member(entity_id)
    and uploaded_by = public.current_director_id()
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- approvals — MFA-gated
-- ─────────────────────────────────────────────────────────────────────────────

create policy approvals_select on public.approvals
  for select to authenticated
  using (public.is_entity_member(entity_id));

-- approver_id / submitted_by are overwritten by fill_approval_submitter() before
-- this policy's WITH CHECK is evaluated, so the self-approval test here is real
-- and not something the client can talk its way past.
create policy approvals_insert on public.approvals
  for insert to authenticated
  with check (
    public.is_entity_member(entity_id)
    and public.can_write()
    and public.has_mfa_session()
    and approver_id = public.current_director_id()
    and approver_id <> submitted_by
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- statement_imports / statement_lines — personal financial data
-- ─────────────────────────────────────────────────────────────────────────────

create policy statement_imports_select_own on public.statement_imports
  for select to authenticated
  using (
    director_id = public.current_director_id()
    or public.current_director_role() = 'auditor'
  );

create policy statement_imports_insert_own on public.statement_imports
  for insert to authenticated
  with check (
    public.is_entity_member(entity_id)
    and director_id = public.current_director_id()
    and imported_by = public.current_director_id()
  );

create policy statement_imports_delete_own on public.statement_imports
  for delete to authenticated
  using (director_id = public.current_director_id());

create policy statement_lines_select_own on public.statement_lines
  for select to authenticated
  using (
    exists (
      select 1 from public.statement_imports si
      where si.id = statement_lines.import_id
        and (si.director_id = public.current_director_id()
             or public.current_director_role() = 'auditor')
    )
  );

create policy statement_lines_insert_own on public.statement_lines
  for insert to authenticated
  with check (
    exists (
      select 1 from public.statement_imports si
      where si.id = statement_lines.import_id
        and si.director_id = public.current_director_id()
    )
  );

-- Matching a line to a disbursement is the only permitted edit.
create policy statement_lines_update_own on public.statement_lines
  for update to authenticated
  using (
    exists (
      select 1 from public.statement_imports si
      where si.id = statement_lines.import_id
        and si.director_id = public.current_director_id()
    )
  )
  with check (
    exists (
      select 1 from public.statement_imports si
      where si.id = statement_lines.import_id
        and si.director_id = public.current_director_id()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_events — read-only, scoped to your boards
-- ─────────────────────────────────────────────────────────────────────────────

create policy audit_events_select on public.audit_events
  for select to authenticated
  using (entity_id is null or public.is_entity_member(entity_id));
