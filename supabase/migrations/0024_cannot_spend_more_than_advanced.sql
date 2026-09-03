-- Zirconix — an advance cannot be spent past its own amount
--
-- How 514,772 got booked against 294,000: nothing stopped it. log_expenditure()
-- checked the receipt, the advance's status, and who was asking — never whether
-- the amount fitted inside the advance. The form said as much in its own hint:
-- "It will be recorded, but it will show as an unexplained gap."
--
-- That is the right stance for UNDER-spending. Money advanced and not yet
-- accounted for is a real, ordinary state, and flagging rather than blocking it
-- is deliberate. OVER-spending is a different thing: an expenditure discharges
-- an advance, and you cannot discharge more than you were given. A director who
-- genuinely spent his own money is owed a reimbursement — that is another
-- advance, recorded and voted on like any other, not a bigger number typed
-- against an existing one.
--
-- Enforced as a trigger rather than inside log_expenditure() alone, because the
-- expenditures INSERT policy (is_entity_member AND can_write) means a client can
-- reach the table directly; a check that only lives in the RPC is a check that
-- can be walked around.

create or replace function public.guard_expenditure_within_advance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_advance  numeric;
  v_already  numeric;
begin
  -- FOR UPDATE serialises two expenditures racing against the same advance;
  -- without it both could read the same "already spent" total and both pass.
  select d.amount into v_advance
  from public.disbursements d
  where d.id = new.disbursement_id
  for update;

  if v_advance is null then
    return new;   -- the FK will reject this anyway
  end if;

  select coalesce(sum(e.amount), 0) into v_already
  from public.expenditures e
  where e.disbursement_id = new.disbursement_id
    and e.status <> 'rejected'
    and e.id <> new.id;

  if v_already + new.amount > v_advance then
    raise exception
      'that would put % against an advance of % (% already accounted for). '
      'You cannot account for more than you were given — if you spent your own money, '
      'it needs to be recorded as a further transfer to you first.',
      public.format_pkr(v_already + new.amount),
      public.format_pkr(v_advance),
      public.format_pkr(v_already)
      using errcode = 'integrity_constraint_violation';
  end if;

  return new;
end;
$$;

create trigger expenditures_within_advance
  before insert on public.expenditures
  for each row execute function public.guard_expenditure_within_advance();

-- Note on existing data: this does not retroactively remove the 220,772 already
-- over-accounted against Sabi-ul-Hassan's advances. Those rows are history and
-- are dealt with by deleting the duplicates, not by a migration silently
-- rewriting somebody's ledger.
