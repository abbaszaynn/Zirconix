-- Zirconix — one consortium, many source accounts
--
-- Durr Mines and Zircon Mines were modelled as two separate entities, each with
-- its own board and its own RLS scope. They are now a single entity: one board,
-- one budget, one dashboard every director sees.
--
-- The two companies do not disappear — they become ACCOUNTS. A disbursement now
-- records which company account the money left from, which is the distinction
-- that actually matters day to day. `method` (bank_transfer / cash) is unchanged
-- and orthogonal: you pick the account it came out of, and how it was handed over.
--
-- The entity_id columns stay. Collapsing them to one value now, rather than
-- ripping the column out of eleven tables and every RLS policy, keeps this
-- migration small and leaves the door open if the consortium ever splits again.
--
-- ORDERING NOTE — every DDL statement in this file comes BEFORE the DO block at
-- the bottom. The merge needs `set constraints all deferred`, and once a
-- transaction has pending deferred trigger events, Postgres refuses any further
-- ALTER TABLE / CREATE INDEX on the tables involved:
--   55006: cannot ALTER TABLE "disbursements" because it has pending trigger events
-- So the schema is fully in place first, and the data moves last.

-- ─────────────────────────────────────────────────────────────────────────────
-- accounts — where money comes FROM
-- ─────────────────────────────────────────────────────────────────────────────

create table public.accounts (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references public.entities (id) on delete restrict,
  name        text not null,
  kind        text not null default 'bank' check (kind in ('bank', 'cash_box')),
  -- Masked tail only, e.g. 'HBL ****4471'. Never a full account number.
  bank_label  text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),

  unique (entity_id, name),
  unique (id, entity_id)
);

create index accounts_entity_idx on public.accounts (entity_id) where is_active;

comment on table public.accounts is
  'Company source accounts. Durr Mines and Zircon Mines are rows here, not separate entities.';

-- One account per company, carrying the name the entity used to have.
insert into public.accounts (entity_id, name, kind)
select e.id, e.name, 'bank' from public.entities e;

-- ─────────────────────────────────────────────────────────────────────────────
-- disbursements gain a source account
--
-- Backfilled while entity_id still says which company paid, so NOT NULL and the
-- composite key can both be applied here — before the merge moves anything.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.disbursements add column from_account_id uuid;

update public.disbursements d
set from_account_id = a.id
from public.accounts a
where a.entity_id = d.entity_id;

alter table public.disbursements
  alter column from_account_id set not null,
  add constraint disbursements_from_account_id_entity_id_fkey
    foreign key (from_account_id, entity_id)
    references public.accounts (id, entity_id) on delete restrict
    deferrable initially immediate;

create index disbursements_from_account_idx on public.disbursements (from_account_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- accounts: audit, RLS, grants
-- ─────────────────────────────────────────────────────────────────────────────

create trigger audit_accounts
  after insert or update or delete on public.accounts
  for each row execute function public.audit_row_change();

alter table public.accounts enable row level security;

create policy accounts_read on public.accounts
  for select to authenticated
  using (public.is_entity_member(entity_id));

-- Adding or retiring a company account is a structural change, not day-to-day
-- data entry, so it stays with the people who can already write budget lines.
create policy accounts_write on public.accounts
  for insert to authenticated
  with check (public.is_entity_member(entity_id) and public.can_write());

create policy accounts_update on public.accounts
  for update to authenticated
  using (public.is_entity_member(entity_id) and public.can_write())
  with check (public.is_entity_member(entity_id) and public.can_write());

grant select, insert, update on public.accounts to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Make the entity-scoped composite keys deferrable
--
-- Every one of these spans a parent and child that must move to the new entity
-- together. With immediate checking there is no ordering that satisfies them all
-- mid-merge: update the parent and the children dangle, update the children and
-- they point at a row that does not exist yet. Deferring to COMMIT is the honest
-- fix, and leaving them deferrable afterwards costs nothing.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.approvals
  drop constraint approvals_disbursement_id_entity_id_fkey,
  add  constraint approvals_disbursement_id_entity_id_fkey
       foreign key (disbursement_id, entity_id)
       references public.disbursements (id, entity_id) on delete restrict
       deferrable initially immediate,
  drop constraint approvals_expenditure_id_entity_id_fkey,
  add  constraint approvals_expenditure_id_entity_id_fkey
       foreign key (expenditure_id, entity_id)
       references public.expenditures (id, entity_id) on delete restrict
       deferrable initially immediate;

alter table public.attachments
  drop constraint attachments_disbursement_id_entity_id_fkey,
  add  constraint attachments_disbursement_id_entity_id_fkey
       foreign key (disbursement_id, entity_id)
       references public.disbursements (id, entity_id) on delete cascade
       deferrable initially immediate,
  drop constraint attachments_expenditure_id_entity_id_fkey,
  add  constraint attachments_expenditure_id_entity_id_fkey
       foreign key (expenditure_id, entity_id)
       references public.expenditures (id, entity_id) on delete cascade
       deferrable initially immediate;

alter table public.disbursements
  drop constraint disbursements_budget_line_id_entity_id_fkey,
  add  constraint disbursements_budget_line_id_entity_id_fkey
       foreign key (budget_line_id, entity_id)
       references public.budget_lines (id, entity_id) on delete restrict
       deferrable initially immediate;

alter table public.expenditures
  drop constraint expenditures_disbursement_id_entity_id_fkey,
  add  constraint expenditures_disbursement_id_entity_id_fkey
       foreign key (disbursement_id, entity_id)
       references public.disbursements (id, entity_id) on delete restrict
       deferrable initially immediate;

alter table public.statement_lines
  drop constraint statement_lines_import_id_entity_id_fkey,
  add  constraint statement_lines_import_id_entity_id_fkey
       foreign key (import_id, entity_id)
       references public.statement_imports (id, entity_id) on delete cascade
       deferrable initially immediate,
  drop constraint statement_lines_matched_disbursement_id_entity_id_fkey,
  add  constraint statement_lines_matched_disbursement_id_entity_id_fkey
       foreign key (matched_disbursement_id, entity_id)
       references public.disbursements (id, entity_id) on delete set null
       deferrable initially immediate;

-- ─────────────────────────────────────────────────────────────────────────────
-- Let the existing privileged-transition escape hatch cover entity_id
--
-- guard_financial_update() already recognises zirconix.privileged_transition for
-- status moves. Extending it to entity_id is how this migration reparents the
-- financial records without disabling the trigger — DISABLE TRIGGER is DDL, and
-- DDL is exactly what the deferred constraints below make impossible.
--
-- amount and created_at remain immutable unconditionally. The flag is only ever
-- set by SECURITY DEFINER functions and by migrations; PostgREST gives a client
-- no way to issue a bare SET.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.guard_financial_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_privileged boolean := coalesce(
    current_setting('zirconix.privileged_transition', true) = 'on', false
  );
begin
  if new.amount is distinct from old.amount
     or new.created_at is distinct from old.created_at then
    raise exception 'amount and creation time are immutable on % (record %)',
      tg_table_name, old.id
      using errcode = 'integrity_constraint_violation';
  end if;

  if new.entity_id is distinct from old.entity_id and not v_privileged then
    raise exception 'entity is immutable on % (record %)', tg_table_name, old.id
      using errcode = 'integrity_constraint_violation';
  end if;

  -- These have to be NESTED, not `if tg_table_name = 'x' and new.col ...`.
  -- plpgsql hands the whole boolean expression to SQL as one unit, so a column
  -- reference in the second half is resolved even when the table test in the
  -- first half is false — and this trigger is shared by two tables whose columns
  -- differ. Flattening these conditions raises 'record "new" has no field ...'.
  if tg_table_name = 'expenditures' then
    if new.disbursement_id is distinct from old.disbursement_id
       or new.entered_by is distinct from old.entered_by then
      raise exception 'the source disbursement and the author of an expenditure are immutable'
        using errcode = 'integrity_constraint_violation';
    end if;

  elsif tg_table_name = 'disbursements' then
    if new.budget_line_id is distinct from old.budget_line_id
       or new.recorded_by is distinct from old.recorded_by
       or new.to_director_id is distinct from old.to_director_id
       or (new.from_account_id is distinct from old.from_account_id and not v_privileged) then
      raise exception 'the budget line, source account, recipient and recorder of a disbursement are immutable'
        using errcode = 'integrity_constraint_violation';
    end if;
  end if;

  if new.status is distinct from old.status and not v_privileged then
    raise exception 'status changes only through the approval process, not by direct update'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The merge itself — data only, no DDL past this point
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  v_target uuid;
begin
  -- Oldest entity wins, so the surviving id is the one already in any exports.
  select id into v_target from public.entities order by created_at, name limit 1;

  perform set_config('zirconix.privileged_transition', 'on', true);  -- txn-local
  set constraints all deferred;

  update public.budget_lines      set entity_id = v_target where entity_id <> v_target;
  update public.disbursements     set entity_id = v_target where entity_id <> v_target;
  update public.expenditures      set entity_id = v_target where entity_id <> v_target;
  update public.attachments       set entity_id = v_target where entity_id <> v_target;
  update public.statement_imports set entity_id = v_target where entity_id <> v_target;
  update public.statement_lines   set entity_id = v_target where entity_id <> v_target;
  update public.accounts          set entity_id = v_target where entity_id <> v_target;

  -- approvals_no_update is a STATEMENT-level trigger: it raises on an UPDATE
  -- matching zero rows just as readily as on one matching thousands. Guarding
  -- the statement keeps approval decisions immutable instead of poking a hole
  -- in that guarantee for a migration that has nothing to move.
  if exists (select 1 from public.approvals where entity_id <> v_target) then
    raise exception 'approvals exist on a non-surviving entity; merge them deliberately';
  end if;

  -- One board now, so every active person sits on it. Rebuilt rather than
  -- merged, because (director_id, entity_id) would collide for anyone who was
  -- already on both boards.
  delete from public.director_entities;
  insert into public.director_entities (director_id, entity_id)
  select d.id, v_target from public.directors d where d.is_active;

  update public.entities
  set name       = 'Durr Mines & Minerals · Zircon Mines',
      legal_name = 'Durr Mines & Minerals (Pvt) Ltd and Zircon Mines (Pvt) Ltd'
  where id = v_target;

  delete from public.entities where id <> v_target;
end;
$$;
