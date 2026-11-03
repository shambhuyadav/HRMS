-- 0110 Leave type and policy maintenance guards (FR-024 "overlapping mappings are rejected or resolved by a documented
-- priority"; BR-010; DF05; ZT09 "overlap or ambiguity rejects").
--
-- Documented priority: for an employee, leave type and date, among the revisions in force the mapping with the most
-- dimensions set wins (leave/service.ts selectPolicy). The one thing that priority cannot resolve is a tie, which needs
-- two revisions in force in overlapping periods with mappings of the same number of dimensions that one employee could
-- match together (each dimension empty on one side, or equal). Such a pair is rejected here, whatever path activates it.
-- A retired revision stays in force until its effective end, so that back-dated requests and accrual keep selecting it;
-- retired without an end, it never applies again.

-- The other revisions of the policy's leave type that tie with it for some employee.
create function hrms_leave_policy_conflicts(p_company uuid, p_policy uuid) returns table (policy_id uuid, revision integer) language sql stable as $$
  select distinct o.id, o.revision
    from leave_policy me
    join leave_policy o on o.company_id = me.company_id and o.leave_type_id = me.leave_type_id and o.id <> me.id
    join leave_policy_mapping a on a.company_id = me.company_id and a.policy_id = me.id
    join leave_policy_mapping b on b.company_id = o.company_id and b.policy_id = o.id
   where me.company_id = p_company and me.id = p_policy
     and (o.state = 'ACTIVE' or (o.state = 'RETIRED' and o.effective_to is not null))
     and daterange(me.effective_from, me.effective_to, '[)') && daterange(o.effective_from, o.effective_to, '[)')
     and num_nonnulls(a.employment_type_id, a.grade_id, a.location_id) = num_nonnulls(b.employment_type_id, b.grade_id, b.location_id)
     and (a.employment_type_id is null or b.employment_type_id is null or a.employment_type_id = b.employment_type_id)
     and (a.grade_id is null or b.grade_id is null or a.grade_id = b.grade_id)
     and (a.location_id is null or b.location_id is null or a.location_id = b.location_id)
$$;

-- After the row changed, so the check sees its new period. Policy changes of one leave type are serialised on the type,
-- so two concurrent activations cannot each miss the other; "no key update" does not block references to the type.
create function hrms_leave_policy_no_overlap() returns trigger language plpgsql as $$
begin
  if new.state = 'DRAFT' or (new.state = 'RETIRED' and new.effective_to is null) then
    return null;
  end if;
  perform 1 from leave_type where company_id = new.company_id and id = new.leave_type_id for no key update;
  if exists (select 1 from hrms_leave_policy_conflicts(new.company_id, new.id)) then
    raise exception 'leave policy % overlaps another revision of its leave type at the same priority', new.id using errcode = '23514';
  end if;
  return null;
end $$;
create trigger leave_policy_no_overlap after insert or update of state, effective_from, effective_to on leave_policy
  for each row execute function hrms_leave_policy_no_overlap();

-- An activated revision's period may only come to an earlier end; whoever wrote a draft does not activate it (0007 checks
-- the creator, this also covers a later editor).
create function hrms_leave_policy_transition() returns trigger language plpgsql as $$
begin
  if old.state = 'DRAFT' and new.state <> 'DRAFT' and old.updated_by is not null and old.updated_by = new.activated_by then
    raise exception 'the last editor of a leave policy draft cannot activate it' using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' then
    if old.state = 'RETIRED' and old.effective_to is null and new.effective_to is not null then
      raise exception 'a retired leave policy without an end stays out of force' using errcode = '23514';
    end if;
    if old.effective_to is not null and new.state = 'ACTIVE' and (new.effective_to is null or new.effective_to > old.effective_to) then
      raise exception 'the period of an activated leave policy may only end earlier' using errcode = '23514';
    end if;
    if old.effective_to is not null and new.state = 'RETIRED' and new.effective_to > old.effective_to then
      raise exception 'the period of an activated leave policy may only end earlier' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger leave_policy_transition before update on leave_policy for each row execute function hrms_leave_policy_transition();

-- Mappings are part of the draft (0007, provision.ts): once a revision left DRAFT they never change. After the row
-- changed, so an insert that ON CONFLICT DO NOTHING skips (provisioning run again) is no change.
create function hrms_leave_policy_mapping_draft_only() returns trigger language plpgsql as $$
declare
  c uuid := case tg_op when 'DELETE' then old.company_id else new.company_id end;
  p uuid := case tg_op when 'DELETE' then old.policy_id else new.policy_id end;
begin
  if exists (select 1 from leave_policy where company_id = c and id = p and state <> 'DRAFT') then
    raise exception 'the mappings of an activated leave policy are immutable; create a new revision' using errcode = '23514';
  end if;
  return null;
end $$;
create trigger leave_policy_mapping_draft_only after insert or update or delete on leave_policy_mapping
  for each row execute function hrms_leave_policy_mapping_draft_only();

-- Balances and pay rest on a leave type's identity: its code, unit and paid flag are fixed at creation.
create function hrms_leave_type_identity() returns trigger language plpgsql as $$
begin
  if (new.code, new.unit, new.paid) is distinct from (old.code, old.unit, old.paid) then
    raise exception 'the code, unit and paid flag of a leave type are fixed; create a new leave type' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger leave_type_identity before update on leave_type for each row execute function hrms_leave_type_identity();
