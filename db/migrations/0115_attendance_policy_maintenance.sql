-- 0115 Attendance policy maintenance guards (FR-020 "the policy screen exposes thresholds"; BR-009; DF05 "grace is
-- configurable"; C4 independent activation).
--
-- For an employee and date, among the revisions in force the mapping with the most dimensions set wins (attendance/service.ts
-- selectAttendancePolicy). The one thing that priority cannot resolve is a tie, which would make processing fail with
-- POLICY_AMBIGUOUS: two revisions in force in overlapping periods with mappings of the same number of dimensions that one
-- employee could match together. Such a pair is rejected here, whatever path activates it. A retired revision stays in
-- force until its effective end, so that reprocessing an earlier day keeps selecting it; retired without an end, it never
-- applies again. Policy changes of one company run one after another (the same advisory key as attendance/policies.ts).

-- The other revisions in force that tie with this one for some employee.
create function hrms_attendance_policy_conflicts(p_company uuid, p_policy uuid) returns table (policy_id uuid) language sql stable as $$
  select distinct o.id
    from attendance_policy me
    join attendance_policy o on o.company_id = me.company_id and o.id <> me.id
    join attendance_policy_mapping a on a.company_id = me.company_id and a.policy_id = me.id
    join attendance_policy_mapping b on b.company_id = o.company_id and b.policy_id = o.id
   where me.company_id = p_company and me.id = p_policy
     and (o.state = 'ACTIVE' or (o.state = 'RETIRED' and o.effective_to is not null))
     and daterange(me.effective_from, me.effective_to, '[)') && daterange(o.effective_from, o.effective_to, '[)')
     and num_nonnulls(a.grade_id, a.location_id) = num_nonnulls(b.grade_id, b.location_id)
     and (a.grade_id is null or b.grade_id is null or a.grade_id = b.grade_id)
     and (a.location_id is null or b.location_id is null or a.location_id = b.location_id)
$$;

create function hrms_attendance_policy_no_overlap() returns trigger language plpgsql as $$
begin
  if new.state = 'DRAFT' or (new.state = 'RETIRED' and new.effective_to is null) then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('attendance:policy:' || new.company_id::text, 0));
  if exists (select 1 from hrms_attendance_policy_conflicts(new.company_id, new.id)) then
    raise exception 'attendance policy % overlaps another revision in force at the same priority', new.id using errcode = '23514';
  end if;
  return null;
end $$;
create trigger attendance_policy_no_overlap after insert or update of state, effective_from, effective_to on attendance_policy
  for each row execute function hrms_attendance_policy_no_overlap();

-- Whoever last edited a draft does not activate it (0008 checks the creator). An activated revision's period may only
-- come to an earlier end, and one retired without an end stays out of force.
create function hrms_attendance_policy_transition() returns trigger language plpgsql as $$
begin
  if old.state = 'DRAFT' and new.state <> 'DRAFT' and old.updated_by is not null and old.updated_by = new.activated_by then
    raise exception 'the last editor of an attendance policy draft cannot activate it' using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' then
    if new.state = 'DRAFT' then
      raise exception 'an activated attendance policy does not return to draft' using errcode = '23514';
    end if;
    if old.state = 'RETIRED' and (new.state <> 'RETIRED' or (old.effective_to is null and new.effective_to is not null)) then
      raise exception 'a retired attendance policy stays retired' using errcode = '23514';
    end if;
    if old.effective_to is not null and (new.effective_to is null or new.effective_to > old.effective_to) then
      raise exception 'the period of an activated attendance policy may only end earlier' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger attendance_policy_transition before update on attendance_policy for each row execute function hrms_attendance_policy_transition();

-- Mappings are part of the draft: once a revision left DRAFT they never change. After the row changed, so an insert that
-- ON CONFLICT DO NOTHING skips (provisioning run again) is no change.
create function hrms_attendance_policy_mapping_draft_only() returns trigger language plpgsql as $$
declare
  c uuid := case tg_op when 'DELETE' then old.company_id else new.company_id end;
  p uuid := case tg_op when 'DELETE' then old.policy_id else new.policy_id end;
begin
  if exists (select 1 from attendance_policy where company_id = c and id = p and state <> 'DRAFT') then
    raise exception 'the mappings of an activated attendance policy are immutable; create a new revision' using errcode = '23514';
  end if;
  return null;
end $$;
create trigger attendance_policy_mapping_draft_only after insert or update or delete on attendance_policy_mapping
  for each row execute function hrms_attendance_policy_mapping_draft_only();
