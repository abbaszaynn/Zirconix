-- This script updates the system so that ALL budget allocations/disbursements
-- require 4 votes (sender, recipient, and 2 independent directors),
-- regardless of the amount.

-- 1. Override the stamping function to always set required_votes to 4
create or replace function public.stamp_disbursement()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_me uuid := public.current_director_id();
begin
  if v_me is null then
    raise exception 'no active director record for the current session'
      using errcode = 'insufficient_privilege';
  end if;

  new.recorded_by    := v_me;
  new.status         := 'pending_approval';
  new.approval_count := 0;
  new.required_votes := 4; -- Always require 4 votes (sender, recipient, and 2 independent directors)

  return new;
end;
$$;

-- 2. Retroactively update all existing pending transfers to also require 4 votes
do $$
declare
  v_prev text := current_setting('zirconix.privileged_transition', true);
begin
  perform set_config('zirconix.privileged_transition', 'on', true);

  update public.disbursements
  set required_votes = 4
  where status <> 'rejected';

  perform set_config('zirconix.privileged_transition', coalesce(v_prev, ''), true);
end;
$$;
