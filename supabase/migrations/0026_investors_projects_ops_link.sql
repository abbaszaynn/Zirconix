-- 0026: investors, projects, and a read-only link for the operations platform.
--
-- Zirconix stays the one book of money. This adds:
--   * projects    (e.g. Project Hilal Abad), each optionally linked to the
--                 operations platform's project id;
--   * investors   and their commitments per project;
--   * tags        saying which investor/project a deposit belongs to and which
--                 project a transfer was for. Money rows themselves are not
--                 touched (they are immutable); spending belongs to a project
--                 through the transfer it was paid from.
--   * schema ops  read-only summaries for the operations platform, readable
--                 by one role (ops_reader) that has no access to any table.
--
-- After applying, enable the reader once, from the SQL editor:
--   alter role ops_reader with login password '<long random password>';
-- and give the operations platform:
--   ZIRCONIX_DATABASE_URL=postgres://ops_reader.<project-ref>:<password>@<session-pooler-host>:5432/postgres?sslmode=require

-- ── Projects ─────────────────────────────────────────────────────────────────
create table public.projects (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references public.entities(id),
  code           text not null unique check (code ~ '^[a-z0-9-]{2,40}$'),
  name           text not null,
  status         text not null default 'active' check (status in ('planning','active','paused','closed')),
  ops_project_id uuid unique,             -- the operations platform's project id
  created_by     uuid not null default public.current_director_id() references public.directors(id),
  created_at     timestamptz not null default now()
);

-- ── Investors and what they committed ───────────────────────────────────────
create table public.investors (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references public.entities(id),
  name       text not null,
  email      text,
  phone      text,
  notes      text,
  created_by uuid not null default public.current_director_id() references public.directors(id),
  created_at timestamptz not null default now()
);

create table public.investor_commitments (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references public.entities(id),
  investor_id      uuid not null references public.investors(id),
  project_id       uuid not null references public.projects(id),
  committed_amount numeric(18,2) not null check (committed_amount > 0),
  agreement_date   date,
  share_percent    numeric(6,3) check (share_percent > 0 and share_percent <= 100),
  note             text,
  created_by       uuid not null default public.current_director_id() references public.directors(id),
  created_at       timestamptz not null default now(),
  unique (investor_id, project_id)
);

-- ── Tags on money (money rows stay immutable) ────────────────────────────────
create table public.deposit_allocations (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references public.entities(id),
  deposit_id  uuid not null unique references public.account_deposits(id),
  investor_id uuid references public.investors(id),
  project_id  uuid references public.projects(id),
  tagged_by   uuid not null default public.current_director_id() references public.directors(id),
  created_at  timestamptz not null default now(),
  check (investor_id is not null or project_id is not null)
);

create table public.disbursement_projects (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references public.entities(id),
  disbursement_id uuid not null unique references public.disbursements(id),
  project_id      uuid not null references public.projects(id),
  tagged_by       uuid not null default public.current_director_id() references public.directors(id),
  created_at      timestamptz not null default now()
);

-- Every change is in the hash-chained audit log, like the rest of Zirconix.
create trigger audit_projects             after insert or update or delete on public.projects             for each row execute function public.audit_row_change();
create trigger audit_investors            after insert or update or delete on public.investors            for each row execute function public.audit_row_change();
create trigger audit_investor_commitments after insert or update or delete on public.investor_commitments for each row execute function public.audit_row_change();
create trigger audit_deposit_allocations  after insert or update or delete on public.deposit_allocations  for each row execute function public.audit_row_change();
create trigger audit_disbursement_projects after insert or update or delete on public.disbursement_projects for each row execute function public.audit_row_change();

-- ── Row-level security: members read; finance officers maintain ─────────────
alter table public.projects              enable row level security;
alter table public.investors             enable row level security;
alter table public.investor_commitments  enable row level security;
alter table public.deposit_allocations   enable row level security;
alter table public.disbursement_projects enable row level security;

do $$
declare t text;
begin
  foreach t in array array['projects','investors','investor_commitments','deposit_allocations','disbursement_projects'] loop
    execute format('create policy %I on public.%I for select to authenticated using (public.is_entity_member(entity_id))', t || '_read', t);
    execute format($p$create policy %I on public.%I for insert to authenticated
                     with check (public.is_entity_member(entity_id) and public.current_director_role() = 'finance_officer')$p$, t || '_insert', t);
    execute format($p$create policy %I on public.%I for update to authenticated
                     using (public.is_entity_member(entity_id) and public.current_director_role() = 'finance_officer')
                     with check (public.is_entity_member(entity_id) and public.current_director_role() = 'finance_officer')$p$, t || '_update', t);
    execute format($p$create policy %I on public.%I for delete to authenticated
                     using (public.is_entity_member(entity_id) and public.current_director_role() = 'finance_officer')$p$, t || '_delete', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- ── Read-only summaries for the operations platform ──────────────────────────
create schema ops;
revoke all on schema ops from public;

-- Live money: deposits and non-voided, non-rejected transfers.
create view ops.accounts as
  select a.id, a.name, a.kind, a.bank_label, a.is_active,
         coalesce((select sum(d.amount) from public.account_deposits d where d.to_account_id = a.id), 0)::numeric(18,2) as deposited,
         coalesce((select sum(t.amount) from public.disbursements t
                   where t.from_account_id = a.id and t.voided_at is null and t.status <> 'rejected'), 0)::numeric(18,2) as transferred_out,
         (coalesce((select sum(d.amount) from public.account_deposits d where d.to_account_id = a.id), 0)
          - coalesce((select sum(t.amount) from public.disbursements t
                      where t.from_account_id = a.id and t.voided_at is null and t.status <> 'rejected'), 0))::numeric(18,2) as balance
  from public.accounts a;

create view ops.projects as
  select id, code, name, status, ops_project_id from public.projects;

create view ops.investors as
  select id, name, email, phone from public.investors;

create view ops.commitments as
  select c.investor_id, c.project_id, c.committed_amount, c.agreement_date, c.share_percent
  from public.investor_commitments c;

-- Every deposit, with its investor/project tag when it has one.
create view ops.deposits as
  select d.id, d.deposit_date, d.amount, d.to_account_id as account_id, a.name as account_name, d.source_type::text as source_type,
         coalesce(i.name, d.source_investor_name, sd.full_name) as source_name,
         al.investor_id, al.project_id, d.created_at
  from public.account_deposits d
  join public.accounts a on a.id = d.to_account_id
  left join public.deposit_allocations al on al.deposit_id = d.id
  left join public.investors i on i.id = al.investor_id
  left join public.directors sd on sd.id = d.source_director_id;

-- Spending lines charged to a project (through the transfer they were paid from).
create view ops.project_spending as
  select dp.project_id, e.id, e.spent_on, e.category, e.payee, e.amount, e.receipt_count,
         dr.full_name as spent_by, e.created_at
  from public.expenditures e
  join public.disbursements t on t.id = e.disbursement_id
  join public.disbursement_projects dp on dp.disbursement_id = t.id
  join public.directors dr on dr.id = e.entered_by
  where t.voided_at is null and t.status <> 'rejected' and e.status <> 'rejected';

-- Per project: money in, money sent to directors, receipted spending, what is left.
create view ops.project_finance as
  select p.id as project_id, p.code, p.name, p.status, p.ops_project_id,
         coalesce((select sum(d.amount) from public.account_deposits d
                   join public.deposit_allocations al on al.deposit_id = d.id where al.project_id = p.id), 0)::numeric(18,2) as invested,
         coalesce((select sum(c.committed_amount) from public.investor_commitments c where c.project_id = p.id), 0)::numeric(18,2) as committed,
         coalesce((select sum(t.amount) from public.disbursements t
                   join public.disbursement_projects dp on dp.disbursement_id = t.id
                   where dp.project_id = p.id and t.voided_at is null and t.status <> 'rejected'), 0)::numeric(18,2) as transferred,
         coalesce((select sum(s.amount) from ops.project_spending s where s.project_id = p.id), 0)::numeric(18,2) as spent
  from public.projects p;

-- One reader, views only. It owns nothing and cannot see any table directly.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ops_reader') then
    create role ops_reader nologin;
  end if;
end $$;
grant usage on schema ops to ops_reader;
grant select on all tables in schema ops to ops_reader;
alter default privileges in schema ops grant select on tables to ops_reader;
alter role ops_reader set search_path = ops;
alter role ops_reader set default_transaction_read_only = on;
