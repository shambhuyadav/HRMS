-- 0081 Confirmation policy maintenance (FR-080; BR-029 "Policy versions are dated; select exactly one applicable
-- policy"; DF11 "Equal-priority overlapping policies are rejected").
-- A case takes the most specific policy that applies on the employee's start date: the one with the most applicability
-- dimensions set (employment type, grade, location; confirmation/service.ts). Two policies with the same number of
-- dimensions whose applicability can meet (in every dimension one of them is unset or both name the same value) and
-- whose effective periods overlap would leave that choice ambiguous for some employee, so such a policy is refused when
-- it is written (exclusion_violation, answered 409). Policy writes of one company are serialised by an advisory lock, so
-- two concurrent writes cannot both pass; opening a case takes the same lock in shared mode, so a case is never opened
-- from a policy that is being changed. Rows recorded before this guard are not re-checked, and a change that only
-- narrows a policy (same applicability, a start no earlier, an end no later) is always allowed, so an ambiguity recorded
-- earlier can still be resolved by retiring one of the policies.

-- The first equally specific policy that could apply to the same employee on an overlapping date, if any.
create function hrms_confirmation_policy_conflict(
  p_company uuid, p_id uuid, p_type uuid, p_grade uuid, p_location uuid, p_from date, p_to date
) returns uuid language sql stable as $$
  select o.id
    from confirmation_policy o
   where o.company_id = p_company and o.id is distinct from p_id
     and num_nonnulls(o.employment_type_id, o.grade_id, o.location_id) = num_nonnulls(p_type, p_grade, p_location)
     and (o.employment_type_id is null or p_type is null or o.employment_type_id = p_type)
     and (o.grade_id is null or p_grade is null or o.grade_id = p_grade)
     and (o.location_id is null or p_location is null or o.location_id = p_location)
     and daterange(o.effective_from, o.effective_to) && daterange(p_from, p_to)
   order by o.code, o.revision
   limit 1
$$;

create function hrms_confirmation_policy_overlap_guard() returns trigger language plpgsql as $$
declare
  other uuid;
begin
  -- An impossible period is the 0009 check's to refuse (BEFORE triggers run first; daterange would fail on it).
  if new.effective_to is not null and new.effective_to <= new.effective_from then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and (new.employment_type_id, new.grade_id, new.location_id) is not distinct from (old.employment_type_id, old.grade_id, old.location_id)
     and new.effective_from >= old.effective_from
     and coalesce(new.effective_to, 'infinity'::date) <= coalesce(old.effective_to, 'infinity'::date) then
    return new; -- narrowing only: no new overlap is possible
  end if;
  perform pg_advisory_xact_lock(hashtextextended('confirmation-policy:' || new.company_id::text, 0));
  -- Inserting a code and revision that exist is the unique constraint's to answer: a BEFORE trigger also runs for a row
  -- that `on conflict do nothing` then drops (provisioning an already provisioned company).
  if tg_op = 'INSERT' and exists (select 1 from confirmation_policy c where c.company_id = new.company_id and c.code = new.code and c.revision = new.revision) then
    return new;
  end if;
  select hrms_confirmation_policy_conflict(new.company_id, new.id, new.employment_type_id, new.grade_id, new.location_id,
                                           new.effective_from, new.effective_to)
    into other;
  if other is not null then
    raise exception 'an equally specific confirmation policy applies to the same employees on overlapping dates' using errcode = '23P01';
  end if;
  return new;
end $$;

create trigger confirmation_policy_overlap_guard before insert or update on confirmation_policy
  for each row execute function hrms_confirmation_policy_overlap_guard();

-- A policy's cases by start date: whether it is in use, and the latest start date a retirement or a new revision must
-- stay after.
create index employee_confirmation_policy_start_idx on employee_confirmation (company_id, policy_id, start_date);
