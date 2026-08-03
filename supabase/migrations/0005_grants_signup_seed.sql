-- Zirconix — function grants, invite-only signup linkage, pilot seed data

-- ─────────────────────────────────────────────────────────────────────────────
-- Function grants
--
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and Supabase
-- exposes every public-schema function at /rest/v1/rpc/<name>. That means the
-- trigger functions were reachable as API endpoints. They are useless when called
-- that way (no TG_OP), but a SECURITY DEFINER function should never be reachable
-- by a caller it was not written for.
-- ─────────────────────────────────────────────────────────────────────────────

revoke execute on all functions in schema public from anon;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.set_updated_at()',
    'public.audit_events_reject_mutation()',
    'public.audit_row_change()',
    'public.stamp_expenditure()',
    'public.stamp_disbursement()',
    'public.guard_financial_update()',
    'public.sync_receipt_count()',
    'public.require_receipt()',
    'public.guard_receipt_deletion()',
    'public.fill_approval_submitter()',
    'public.approvals_reject_mutation()',
    'public.guard_director_self_update()'
  ]
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
  end loop;
end;
$$;

-- These are consulted by RLS policies, which evaluate as the calling role, so
-- `authenticated` must keep EXECUTE or every policy using them fails closed.
grant execute on function
  public.current_director_id(),
  public.current_director_role(),
  public.is_entity_member(uuid),
  public.can_write(),
  public.has_mfa_session(),
  public.storage_entity_id(text),
  public.approval_threshold(),
  public.verify_audit_chain(bigint)
to authenticated;

grant execute on function
  public.log_expenditure(uuid, numeric, text, text, date, jsonb, text),
  public.decide_approval(text, uuid, public.approval_decision, text)
to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Invite-only signup
--
-- Director records are created here, by migration, ahead of anyone signing up.
-- When a person registers, they are linked to their pre-existing record by email.
-- Someone who signs up with an email that is not on the list gets a valid auth
-- account with no director row — and therefore, under RLS, sees nothing at all.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.link_auth_user_to_director()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.directors d
  set auth_user_id = new.id
  where lower(d.email) = lower(new.email)
    and d.auth_user_id is null;

  return new;
end;
$$;

create trigger on_auth_user_created_link_director
  after insert on auth.users
  for each row execute function public.link_auth_user_to_director();

revoke execute on function public.link_auth_user_to_director() from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Pilot seed
--
-- The eight director rows below are PLACEHOLDERS except seat 1. Replace the names
-- and emails with the real directors before the pilot starts — an email here is
-- what grants access, so a wrong address is a real access-control mistake.
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.entities (name, legal_name) values
  ('Durr Mines',   'Durr Mines & Minerals Pvt Ltd'),
  ('Zircon Mines', 'Zircon Mines Pvt Ltd')
on conflict (name) do nothing;

insert into public.directors (full_name, email, role) values
  ('Abbas Zayn',            'abbaszayn827@gmail.com',   'director'),
  ('Director 2 (placeholder)', 'director2@example.invalid', 'director'),
  ('Director 3 (placeholder)', 'director3@example.invalid', 'director'),
  ('Director 4 (placeholder)', 'director4@example.invalid', 'director'),
  ('Director 5 (placeholder)', 'director5@example.invalid', 'director'),
  ('Director 6 (placeholder)', 'director6@example.invalid', 'director'),
  ('Finance Officer (placeholder)', 'finance@example.invalid', 'finance_officer'),
  ('Auditor (placeholder)',   'auditor@example.invalid',  'auditor')
on conflict (email) do nothing;

-- Seat 1 and the finance officer / auditor sit on both boards; the rest are split
-- between the two companies. Adjust to the real board composition.
insert into public.director_entities (director_id, entity_id)
select d.id, e.id
from public.directors d
cross join public.entities e
where d.email in ('abbaszayn827@gmail.com', 'finance@example.invalid', 'auditor@example.invalid')
on conflict do nothing;

insert into public.director_entities (director_id, entity_id)
select d.id, e.id
from public.directors d
join public.entities e on e.name = 'Durr Mines'
where d.email in ('director2@example.invalid', 'director3@example.invalid', 'director4@example.invalid')
on conflict do nothing;

insert into public.director_entities (director_id, entity_id)
select d.id, e.id
from public.directors d
join public.entities e on e.name = 'Zircon Mines'
where d.email in ('director4@example.invalid', 'director5@example.invalid', 'director6@example.invalid')
on conflict do nothing;

-- Zircon Mines — Shigar Valley Exploration — Q3 2026 — PKR 8,000,000
insert into public.budget_lines
  (entity_id, owner_director_id, period, project, category, allocated_amount, created_by)
select
  e.id, owner.id, 'Q3 2026', 'Shigar Valley Exploration', v.category, v.amount, owner.id
from public.entities e
cross join (select id from public.directors where email = 'abbaszayn827@gmail.com') owner
cross join (values
  ('Equipment',                  2800000::numeric),
  ('Site operations & labor',    2200000::numeric),
  ('Transport & logistics',      1400000::numeric),
  ('Lease & regulatory fees',    1000000::numeric),
  ('Contingency',                 600000::numeric)
) as v(category, amount)
where e.name = 'Zircon Mines'
on conflict do nothing;
