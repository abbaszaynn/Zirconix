-- Zirconix — a vote notification must not depend on trigger firing order
--
-- 0010 assumed approvals_notify would run after approvals_tally and could
-- therefore read disbursements.approval_count. It does not. Postgres fires
-- per-row triggers of the same timing in NAME order, and 'approvals_notify'
-- sorts before 'approvals_tally', so every notification reported the count from
-- before the vote it was announcing:
--
--   "Abbas Zayn approved PKR 25,00,000 (0 of 4)."   <- should have been 1 of 4
--
-- Renaming the trigger to sort later would fix the symptom and leave the trap in
-- place for whoever adds the next trigger. Counting the approvals directly makes
-- the notification correct regardless of order.

create or replace function public.notify_vote_cast()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_who      text;
  v_d        public.disbursements;
  v_approved integer;
begin
  select full_name into v_who from public.directors where id = new.approver_id;
  select * into v_d from public.disbursements where id = new.disbursement_id;

  -- Counted here rather than read from disbursements.approval_count, which the
  -- tally trigger may not have written yet.
  select count(*) filter (where a.decision = 'approved')
  into v_approved
  from public.approvals a
  where a.disbursement_id = new.disbursement_id;

  perform public.notify_directors(
    new.entity_id,
    'vote_cast',
    case when new.decision = 'rejected' then 'Transfer rejected' else 'Vote recorded' end,
    case
      when new.decision = 'rejected' then
        format('%s rejected %s.', v_who, public.format_pkr(v_d.amount))
      else
        format('%s approved %s. %s of %s votes in.',
               v_who, public.format_pkr(v_d.amount), v_approved, v_d.required_votes)
    end,
    new.disbursement_id, null, new.approver_id
  );
  return null;
end;
$$;

-- While here: "0 of 4 votes needed" read as though nothing was required.
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
    'Transfer needs your vote',
    format('%s to %s. %s votes required before it is confirmed.',
           public.format_pkr(new.amount), v_to, new.required_votes),
    new.id, null, null
  );
  return null;
end;
$$;
