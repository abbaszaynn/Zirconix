-- Zirconix — account deposits (incoming funds)
--
-- Tracks incoming capital from directors or external investors into company accounts.
-- These funds can then be disbursed to directors for operations.

create type public.deposit_source as enum ('director', 'investor');

create table public.account_deposits (
  id                   uuid primary key default gen_random_uuid(),
  entity_id            uuid not null references public.entities (id) on delete restrict,
  to_account_id        uuid not null,
  amount               numeric(18,2) not null check (amount > 0),
  source_type          public.deposit_source not null,
  source_director_id   uuid references public.directors (id) on delete restrict,
  source_investor_name text,
  recorded_by          uuid not null references public.directors (id) on delete restrict,
  deposit_date         date not null,
  created_at           timestamptz not null default now(),

  constraint account_deposits_source_check check (
    (source_type = 'director' and source_director_id is not null and source_investor_name is null) or
    (source_type = 'investor' and source_investor_name is not null and btrim(source_investor_name) <> '' and source_director_id is null)
  ),

  -- Must be attached to an account belonging to the same entity
  constraint account_deposits_to_account_id_entity_id_fkey
    foreign key (to_account_id, entity_id)
    references public.accounts (id, entity_id) on delete restrict
    deferrable initially immediate
);

create index account_deposits_entity_idx on public.account_deposits (entity_id, deposit_date desc);
create index account_deposits_to_account_idx on public.account_deposits (to_account_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit, RLS, and Grants
-- ─────────────────────────────────────────────────────────────────────────────

create trigger audit_account_deposits
  after insert or update or delete on public.account_deposits
  for each row execute function public.audit_row_change();

-- Immutability guard: Deposits cannot be updated or deleted, they form a strict ledger.
-- To reverse a mistake, a negative manual adjustment would be required (or DB admin access).
create or replace function public.guard_account_deposits_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'account deposits are immutable; insert a new record to adjust'
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger account_deposits_no_update
  before update on public.account_deposits
  for each row execute function public.guard_account_deposits_mutation();

create trigger account_deposits_no_delete
  before delete on public.account_deposits
  for each row execute function public.guard_account_deposits_mutation();

alter table public.account_deposits enable row level security;

-- Read: Any active director can see deposits for their entity.
create policy account_deposits_read on public.account_deposits
  for select to authenticated
  using (public.is_entity_member(entity_id));

-- Write: Only a finance officer can insert incoming funds.
create policy account_deposits_write on public.account_deposits
  for insert to authenticated
  with check (
    public.is_entity_member(entity_id)
    and public.current_director_role() = 'finance_officer'
    and recorded_by = public.current_director_id()
  );

grant select, insert on public.account_deposits to authenticated;
