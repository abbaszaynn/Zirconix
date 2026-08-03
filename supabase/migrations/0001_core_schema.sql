-- Zirconix — core schema
--
-- Accounting model: IMPREST / CASH ADVANCE.
--   A disbursement moves money (outside this app) from a company to a director and
--   creates an OBLIGATION that director must account for. Expenditures backed by a
--   receipt DISCHARGE that obligation. This app never moves money; it records money
--   that already moved.
--
-- Money columns are numeric(18,2) in PKR. numeric is exact — never use float here.

create extension if not exists pgcrypto with schema extensions;

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────────

create type public.director_role as enum ('director', 'finance_officer', 'auditor');

create type public.disbursement_method as enum ('bank_transfer', 'cash');

-- auto_confirmed  : below threshold, confirmed on submission, still fully logged
-- pending_approval: at/above threshold, awaiting a second director
-- confirmed       : approved by a second director
-- rejected        : declined by a second director
create type public.entry_status as enum (
  'auto_confirmed', 'pending_approval', 'confirmed', 'rejected'
);

create type public.approval_decision as enum ('approved', 'rejected');

create type public.attachment_kind as enum (
  'receipt_photo', 'receipt_pdf', 'payment_confirmation', 'transfer_proof'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Approval threshold
--
-- Deliberately a function, not a settings row: changing the control that governs
-- two live companies should require a migration in version control, not an UPDATE
-- someone can issue at runtime.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.approval_threshold()
returns numeric
language sql
immutable
parallel safe
set search_path = ''
as $$ select 1000000::numeric $$;  -- PKR 10 lac

comment on function public.approval_threshold() is
  'Any single disbursement or expenditure at or above this PKR amount requires approval from a second director.';

-- ─────────────────────────────────────────────────────────────────────────────
-- entities — the two consortium companies
--
-- tenant_id is reserved for a possible future multi-tenant split. It is nullable
-- and unused in the pilot; it exists so the schema can extend without a rewrite.
-- ─────────────────────────────────────────────────────────────────────────────

create table public.entities (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid,
  name        text not null unique,
  legal_name  text not null,
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- directors — the 8 people
--
-- id is this app's own key, NOT auth.users.id, so director records can be created
-- before those people have signed up. auth_user_id links them once they do.
-- ─────────────────────────────────────────────────────────────────────────────

create table public.directors (
  id              uuid primary key default gen_random_uuid(),
  auth_user_id    uuid unique references auth.users (id) on delete set null,
  full_name       text not null,
  email           text not null unique check (position('@' in email) > 1),
  role            public.director_role not null default 'director',
  is_active       boolean not null default true,
  expo_push_token text,
  created_at      timestamptz not null default now()
);

create index directors_auth_user_id_idx on public.directors (auth_user_id);

-- Which boards each director sits on. Directors on both boards get two rows.
create table public.director_entities (
  director_id uuid not null references public.directors (id) on delete cascade,
  entity_id   uuid not null references public.entities (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (director_id, entity_id)
);

create index director_entities_entity_idx on public.director_entities (entity_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- budget_lines — allocation, per entity / period / project / category / owner
-- ─────────────────────────────────────────────────────────────────────────────

create table public.budget_lines (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references public.entities (id) on delete restrict,
  owner_director_id uuid not null references public.directors (id) on delete restrict,
  period           text not null,          -- e.g. 'Q3 2026'
  project          text,                   -- e.g. 'Shigar Valley Exploration'
  category         text not null,          -- e.g. 'Equipment'
  allocated_amount numeric(18, 2) not null check (allocated_amount > 0),
  created_by       uuid not null references public.directors (id) on delete restrict,
  created_at       timestamptz not null default now(),

  -- Lets child tables carry entity_id and have it guaranteed consistent by a
  -- composite foreign key rather than by a trigger (see disbursements below).
  unique (id, entity_id)
);

create unique index budget_lines_unique_allocation_idx
  on public.budget_lines (entity_id, period, coalesce(project, ''), category, owner_director_id);

create index budget_lines_entity_period_idx on public.budget_lines (entity_id, period);
create index budget_lines_owner_idx on public.budget_lines (owner_director_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- disbursements — money handed to a director; creates the obligation
-- ─────────────────────────────────────────────────────────────────────────────

create table public.disbursements (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null,
  budget_line_id   uuid not null,
  -- The director who receives the money and is accountable for spending it.
  to_director_id   uuid not null references public.directors (id) on delete restrict,
  amount           numeric(18, 2) not null check (amount > 0),
  method           public.disbursement_method not null,
  -- Personal account reference (store a masked tail, e.g. 'HBL ****4471') or 'cash'.
  disbursed_to_ref text not null,
  disbursed_on     date not null,
  note             text,
  status           public.entry_status not null default 'auto_confirmed',
  recorded_by      uuid not null references public.directors (id) on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- entity_id can never drift from the budget line's entity
  foreign key (budget_line_id, entity_id)
    references public.budget_lines (id, entity_id) on delete restrict,

  unique (id, entity_id)
);

create index disbursements_entity_idx on public.disbursements (entity_id);
create index disbursements_budget_line_idx on public.disbursements (budget_line_id);
create index disbursements_to_director_idx on public.disbursements (to_director_id);
create index disbursements_status_idx on public.disbursements (status)
  where status = 'pending_approval';

-- ─────────────────────────────────────────────────────────────────────────────
-- expenditures — a director spending money he was disbursed; discharges obligation
--
-- receipt_count is maintained by a trigger on attachments and is guarded by a
-- DEFERRABLE constraint trigger (0002) so a receiptless expenditure can never be
-- committed. It is denormalised on purpose: the guard has to be cheap.
-- ─────────────────────────────────────────────────────────────────────────────

create table public.expenditures (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null,
  disbursement_id uuid not null,
  amount          numeric(18, 2) not null check (amount > 0),
  category        text not null,
  payee           text not null check (length(btrim(payee)) > 0),
  note            text,
  spent_on        date not null,
  status          public.entry_status not null default 'auto_confirmed',
  receipt_count   integer not null default 0 check (receipt_count >= 0),
  entered_by      uuid not null references public.directors (id) on delete restrict,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  foreign key (disbursement_id, entity_id)
    references public.disbursements (id, entity_id) on delete restrict,

  unique (id, entity_id)
);

create index expenditures_entity_idx on public.expenditures (entity_id);
create index expenditures_disbursement_idx on public.expenditures (disbursement_id);
create index expenditures_entered_by_idx on public.expenditures (entered_by);
create index expenditures_spent_on_idx on public.expenditures (entity_id, spent_on desc);
create index expenditures_pending_idx on public.expenditures (status)
  where status = 'pending_approval';

-- ─────────────────────────────────────────────────────────────────────────────
-- attachments — receipts and payment confirmations in Supabase Storage
--
-- Attaches to exactly one of an expenditure or a disbursement.
-- ─────────────────────────────────────────────────────────────────────────────

create table public.attachments (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references public.entities (id) on delete restrict,
  expenditure_id  uuid,
  disbursement_id uuid,
  kind            public.attachment_kind not null,
  storage_path    text not null unique,
  mime_type       text not null,
  byte_size       integer check (byte_size is null or byte_size > 0),
  sha256          text,
  uploaded_by     uuid not null references public.directors (id) on delete restrict,
  created_at      timestamptz not null default now(),

  foreign key (expenditure_id, entity_id)
    references public.expenditures (id, entity_id) on delete cascade,
  foreign key (disbursement_id, entity_id)
    references public.disbursements (id, entity_id) on delete cascade,

  constraint attachments_exactly_one_parent check (
    (expenditure_id is not null)::int + (disbursement_id is not null)::int = 1
  )
);

create index attachments_expenditure_idx on public.attachments (expenditure_id);
create index attachments_disbursement_idx on public.attachments (disbursement_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- approvals — the decision record for at/above-threshold entries
--
-- submitted_by is denormalised from the target row specifically so the database
-- itself can refuse self-approval in a CHECK constraint. A trigger (0002) fills
-- it from the target row, so a client cannot forge it.
-- ─────────────────────────────────────────────────────────────────────────────

create table public.approvals (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references public.entities (id) on delete restrict,
  expenditure_id  uuid,
  disbursement_id uuid,
  submitted_by    uuid not null references public.directors (id) on delete restrict,
  approver_id     uuid not null references public.directors (id) on delete restrict,
  decision        public.approval_decision not null,
  reason          text,
  decided_at      timestamptz not null default now(),
  created_at      timestamptz not null default now(),

  foreign key (expenditure_id, entity_id)
    references public.expenditures (id, entity_id) on delete restrict,
  foreign key (disbursement_id, entity_id)
    references public.disbursements (id, entity_id) on delete restrict,

  constraint approvals_exactly_one_target check (
    (expenditure_id is not null)::int + (disbursement_id is not null)::int = 1
  ),

  -- THE separation-of-duties rule. Not UI-level. Not application-level.
  constraint approvals_approver_is_not_submitter check (approver_id <> submitted_by),

  -- A rejection must say why.
  constraint approvals_rejection_needs_reason check (
    decision <> 'rejected' or length(btrim(coalesce(reason, ''))) > 0
  )
);

-- One decision per target. Re-deciding requires a new entry, not an overwrite.
create unique index approvals_one_per_expenditure_idx
  on public.approvals (expenditure_id) where expenditure_id is not null;
create unique index approvals_one_per_disbursement_idx
  on public.approvals (disbursement_id) where disbursement_id is not null;

create index approvals_approver_idx on public.approvals (approver_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- statement_imports / statement_lines — optional personal bank statement pass
--
-- SECONDARY check only. The primary control is always: every expenditure has a
-- receipt. These rows only help confirm a bank-transfer disbursement landed.
-- ─────────────────────────────────────────────────────────────────────────────

create table public.statement_imports (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references public.entities (id) on delete restrict,
  director_id   uuid not null references public.directors (id) on delete restrict,
  source_filename text not null,
  storage_path  text unique,
  period_start  date,
  period_end    date,
  row_count     integer not null default 0 check (row_count >= 0),
  imported_by   uuid not null references public.directors (id) on delete restrict,
  created_at    timestamptz not null default now(),

  unique (id, entity_id),
  constraint statement_imports_period_ordered check (
    period_start is null or period_end is null or period_start <= period_end
  )
);

create table public.statement_lines (
  id                     uuid primary key default gen_random_uuid(),
  entity_id              uuid not null,
  import_id              uuid not null,
  txn_date               date not null,
  description            text not null,
  -- debit = money leaving the personal account, credit = money arriving
  debit                  numeric(18, 2) check (debit is null or debit >= 0),
  credit                 numeric(18, 2) check (credit is null or credit >= 0),
  balance                numeric(18, 2),
  matched_disbursement_id uuid,
  match_confidence       numeric(4, 3) check (
                           match_confidence is null
                           or (match_confidence >= 0 and match_confidence <= 1)
                         ),
  matched_by             uuid references public.directors (id) on delete set null,
  matched_at             timestamptz,
  created_at             timestamptz not null default now(),

  foreign key (import_id, entity_id)
    references public.statement_imports (id, entity_id) on delete cascade,
  foreign key (matched_disbursement_id, entity_id)
    references public.disbursements (id, entity_id) on delete set null,

  constraint statement_lines_one_direction check (
    (debit is not null)::int + (credit is not null)::int = 1
  )
);

create index statement_lines_import_idx on public.statement_lines (import_id);
create index statement_lines_match_idx on public.statement_lines (matched_disbursement_id);
create index statement_lines_date_idx on public.statement_lines (entity_id, txn_date desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at maintenance
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger disbursements_set_updated_at
  before update on public.disbursements
  for each row execute function public.set_updated_at();

create trigger expenditures_set_updated_at
  before update on public.expenditures
  for each row execute function public.set_updated_at();
