-- 0090 Delegation lifecycle: request, independent approval, early end, and the checks a delegated decision must pass.
--
-- BRD: FR-003 ("time-limited, auditable and limited to assigned request types"), FR-068 ("approved period, request
-- category and equivalent reviewer authority"), DF03 line 4911 ("inclusive start/exclusive end timestamps, maximum 30
-- calendar days per grant, same-company/current-record/action limits and no redelegation. Delegation cannot introduce
-- Admin eligibility or confidential field grants"), DB018 ("No self delegation; no privilege escalation; delegate must
-- hold applicable base permission and scope; original entitlement remains required"), C4 "Delegated task", CI10, ZT04, ZT05.
--
-- A delegation starts PENDING and is live only as ACTIVE inside its window. Its state moves PENDING -> ACTIVE, REJECTED or
-- WITHDRAWN, and ACTIVE -> ENDED; natural expiry changes nothing on the row (the window simply passes), so its parties,
-- permission, window and approval stay as they were approved. DB018 "approved_by required" holds for every delegation
-- that was ever usable: only a request that never became usable has no approver.
--
-- A delegation names the delegator assignment it was requested from (C1: action and row scope come from one assignment),
-- so it never carries a scope that assignment does not hold.
--
-- Decisions: hrms_approval_decision_guard is replaced with the checks of C4 "Delegated task". Reads: serving code asks
-- hrms_delegated_task_live, so a delegation that ended stops reads as well as decisions (C1; ZT05).
--
-- This file sorts before 0098-0115, so a new database applies it first while an existing one applies it last. It uses
-- only objects of 0089 and earlier when it runs; the bootstrap setting of 0099 is read at run time inside a trigger.

insert into permission (resource, action, field_group) values ('access', 'delegate', 'operational');

-- A row written before this migration named its approver, so it stays usable as far as its state goes. New rows start PENDING.
alter table delegation
  alter column approved_by drop not null,
  add column state                   text not null default 'ACTIVE',
  add column delegator_assignment_id uuid,
  add column purpose                 text,
  add column approved_at             timestamptz,
  add column decided_by              uuid references user_account (id) on delete restrict,
  add column decided_at              timestamptz,
  add column decision_reason         text,
  add column ended_by                uuid references user_account (id) on delete restrict,
  add column ended_at                timestamptz,
  add column end_reason              text;
alter table delegation alter column state set default 'PENDING';

alter table delegation
  add constraint delegation_state_check check (state in ('PENDING', 'ACTIVE', 'REJECTED', 'WITHDRAWN', 'ENDED')),
  add constraint delegation_assignment_fk foreign key (company_id, delegator_assignment_id) references role_assignment (company_id, id) on delete restrict,
  -- DB018 "approved_by required": a usable delegation always names its approver; a request that never became usable has none.
  add constraint delegation_approver_check check (case when state in ('ACTIVE', 'ENDED') then approved_by is not null else approved_by is null and approved_at is null end),
  -- DF03 "preparer differs from their approver"; DF02 "Grant preparer/approver duties to different people"; C4 own privilege grant.
  add constraint delegation_approver_not_delegator check (approved_by <> delegator_user_id),
  add constraint delegation_approver_not_requester check (approved_by <> created_by),
  add constraint delegation_rejection_check check (state <> 'REJECTED' or (decided_by is not null and decided_at is not null and decision_reason is not null and btrim(decision_reason) <> '')),
  add constraint delegation_end_check check (state not in ('WITHDRAWN', 'ENDED') or (ended_by is not null and ended_at is not null and end_reason is not null and btrim(end_reason) <> '')),
  -- One step has one assignee, so one delegator and permission have one open delegation at any instant.
  add constraint delegation_one_open_per_period exclude using gist (
    company_id with =, delegator_user_id with =, permission_id with =, tstzrange(effective_from, effective_to, '[)') with &&
  ) where (state in ('PENDING', 'ACTIVE'));

create index delegation_delegate_idx on delegation (company_id, delegate_user_id);
create index approval_task_open_delegation_idx on approval_task (company_id, delegation_id) where delegation_id is not null and state = 'PENDING';

create function hrms_access_rank(p_class text) returns integer language sql immutable as $$
  select case p_class when 'ADMIN' then 2 when 'MANAGER' then 1 else 0 end
$$;

/*
 * The delegation is live at p_at and the delegator's named assignment still holds the delegated permission (C4 "delegator
 * authority remains active"; DB018 "original entitlement remains required"). With an owner: that same assignment also covers
 * the owner in row scope and the delegator is not linked to the owner in any period (FR-068 "widen the original reviewer's
 * scope"; C4 self approval). Row scope is the rule of engine.ts scopeCovers: company within its filters, team over a current
 * direct report, assigned (a delegated task is what confers it), never own. Without an owner only the permission counts.
 *
 * One key lookup at a time rather than one join: reads call this per delegated task, and each step here has a unique or
 * exclusion index, whatever the statistics say. Written as a single statement it ran for many seconds on a small test database.
 */
create function hrms_delegation_covers(p_company uuid, p_delegation uuid, p_owner uuid, p_at timestamptz) returns boolean language plpgsql stable cost 1000 as $$
declare
  dl delegation%rowtype;
  ra role_assignment%rowtype;
  day date;
begin
  select * into dl from delegation where company_id = p_company and id = p_delegation;
  if not found or dl.state <> 'ACTIVE' or dl.effective_from > p_at or dl.effective_to <= p_at then
    return false;
  end if;
  if not exists (select 1 from company c where c.id = p_company and c.active) then
    return false;
  end if;
  if not exists (select 1 from user_account u where u.id = dl.delegator_user_id and u.active) then
    return false;
  end if;
  select * into ra from role_assignment a where a.company_id = p_company and a.id = dl.delegator_assignment_id and a.user_id = dl.delegator_user_id;
  if not found or ra.state <> 'ACTIVE' or ra.effective_from > p_at or (ra.effective_to is not null and ra.effective_to <= p_at) then
    return false;
  end if;
  if not exists (select 1 from role r where r.company_id = p_company and r.id = ra.role_id and r.active) then
    return false;
  end if;
  if not exists (select 1 from role_permission rp where rp.company_id = p_company and rp.role_id = ra.role_id and rp.permission_id = dl.permission_id and rp.effect = 'ALLOW') then
    return false;
  end if;
  if not exists (
    select 1 from role_assignment_permission rap
     where rap.company_id = p_company and rap.role_assignment_id = ra.id and rap.permission_id = dl.permission_id and rap.active
       and rap.effective_from <= p_at and (rap.effective_to is null or rap.effective_to > p_at)
  ) then
    return false;
  end if;
  if p_owner is null then
    return true;
  end if;

  if exists (select 1 from user_employee_link own where own.company_id = p_company and own.user_id = dl.delegator_user_id and own.employee_id = p_owner) then
    return false;
  end if;
  day := hrms_business_date(p_company, p_at);
  if ra.scope_kind = 'TEAM' then
    if not exists (
      select 1 from manager_assignment ma
        join user_employee_link l on l.company_id = ma.company_id and l.employee_id = ma.manager_employee_id and l.user_id = ra.user_id
                                 and l.effective_from <= day and (l.effective_to is null or l.effective_to > day)
       where ma.company_id = p_company and ma.employee_id = p_owner
         and ma.effective_from <= day and (ma.effective_to is null or ma.effective_to > day)
    ) then
      return false;
    end if;
  elsif ra.scope_kind not in ('COMPANY', 'ASSIGNED') then
    return false;
  end if;
  -- BR-006: values OR within a dimension, dimensions AND, all from this one assignment.
  if exists (select 1 from role_scope_filter f where f.company_id = p_company and f.role_assignment_id = ra.id and f.dimension in ('DEPARTMENT', 'LOCATION'))
     and not exists (
       select 1 from employment_assignment ea
        where ea.company_id = p_company and ea.employee_id = p_owner
          and ea.effective_from <= day and (ea.effective_to is null or ea.effective_to > day)
          and (not exists (select 1 from role_scope_filter f where f.company_id = p_company and f.role_assignment_id = ra.id and f.dimension = 'DEPARTMENT')
               or ea.department_id in (select f.department_id from role_scope_filter f where f.company_id = p_company and f.role_assignment_id = ra.id and f.dimension = 'DEPARTMENT'))
          and (not exists (select 1 from role_scope_filter f where f.company_id = p_company and f.role_assignment_id = ra.id and f.dimension = 'LOCATION')
               or ea.location_id in (select f.location_id from role_scope_filter f where f.company_id = p_company and f.role_assignment_id = ra.id and f.dimension = 'LOCATION'))
     ) then
    return false;
  end if;
  if exists (select 1 from role_scope_filter f where f.company_id = p_company and f.role_assignment_id = ra.id and f.dimension = 'EMPLOYEE')
     and not exists (select 1 from role_scope_filter f where f.company_id = p_company and f.role_assignment_id = ra.id and f.dimension = 'EMPLOYEE' and f.employee_id = p_owner) then
    return false;
  end if;
  return true;
end $$;

/*
 * A delegated task's assignee may still read and decide it: the task's delegation names its assignee and its step's
 * permission (CI10; C4 "permission matches") and is live for the transaction's owner (hrms_delegation_covers). Serving code
 * asks this only for a task that has a delegation (authorize.ts taskDelegationLive). The cost keeps it behind cheaper conditions.
 */
create function hrms_delegated_task_live(p_company uuid, p_task uuid, p_at timestamptz) returns boolean language plpgsql stable cost 1000 as $$
declare
  t approval_task%rowtype;
  dl delegation%rowtype;
  owner_employee uuid;
begin
  select * into t from approval_task where company_id = p_company and id = p_task;
  if not found or t.delegation_id is null then
    return false;
  end if;
  select * into dl from delegation where company_id = p_company and id = t.delegation_id;
  if not found or dl.delegate_user_id <> t.assignee_user_id
     or dl.permission_id <> (select s.permission_id from workflow_step s where s.company_id = p_company and s.id = t.step_id) then
    return false;
  end if;
  select bt.owner_employee_id into owner_employee
    from approval_instance i join business_transaction bt on bt.company_id = i.company_id and bt.id = i.transaction_id
   where i.company_id = p_company and i.id = t.instance_id;
  return hrms_delegation_covers(p_company, dl.id, owner_employee, p_at);
end $$;

-- CI10 "delegates cannot delegate again": within one permission, nobody who is a delegate in a period delegates in that
-- period, and nobody who delegates in a period is a delegate in it. Serialised per company and permission. Requests count
-- as well as approved delegations, so a chain can only form at insert: an approval never creates one.
create function hrms_delegation_no_chain(p_row delegation) returns void language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('delegation:' || p_row.company_id::text || ':' || p_row.permission_id::text, 0));
  if exists (
    select 1 from delegation o
     where o.company_id = p_row.company_id and o.permission_id = p_row.permission_id and o.id <> p_row.id
       and o.state in ('PENDING', 'ACTIVE')
       and (o.delegate_user_id = p_row.delegator_user_id or o.delegator_user_id = p_row.delegate_user_id)
       and tstzrange(o.effective_from, o.effective_to, '[)') && tstzrange(p_row.effective_from, p_row.effective_to, '[)')
  ) then
    raise exception 'a delegate cannot delegate again' using errcode = '23514';
  end if;
end $$;

-- As 0099 does for grants: direct writes cannot create or widen an approved delegation. The bootstrap setting (0099) lets a
-- fixture write a row directly; the CHECKs, the exclusion and the no-chain rule still bind it.
create function hrms_delegation_guard() returns trigger language plpgsql as $$
declare
  bootstrap boolean := hrms_grant_bootstrap_on();
begin
  if tg_op = 'INSERT' then
    if bootstrap then
      if new.approved_by is not null and new.state = 'PENDING' then
        new.state := 'ACTIVE';
      end if;
    else
      if new.state <> 'PENDING' then
        raise exception 'a delegation starts PENDING; it becomes usable only through independent approval' using errcode = '23514';
      end if;
      if new.approved_by is not null or new.approved_at is not null then
        raise exception 'a pending delegation has no approver' using errcode = '23514';
      end if;
      if new.created_by is null or new.delegator_assignment_id is null then
        raise exception 'a delegation request names its requester and the delegator assignment' using errcode = '23514';
      end if;
    end if;
    if new.delegator_assignment_id is not null and not exists (
      select 1 from role_assignment a where a.company_id = new.company_id and a.id = new.delegator_assignment_id and a.user_id = new.delegator_user_id
    ) then
      raise exception 'the delegator assignment belongs to the delegator' using errcode = '23514';
    end if;
    if new.state in ('PENDING', 'ACTIVE') then
      perform hrms_delegation_no_chain(new);
    end if;
    return new;
  end if;

  if bootstrap then
    return new;
  end if;
  if (new.delegator_user_id, new.delegate_user_id, new.permission_id, new.effective_from, new.effective_to, new.delegator_assignment_id, new.purpose, new.created_by)
     is distinct from (old.delegator_user_id, old.delegate_user_id, old.permission_id, old.effective_from, old.effective_to, old.delegator_assignment_id, old.purpose, old.created_by) then
    raise exception 'a delegation keeps its parties, permission, window and request' using errcode = '23514';
  end if;
  if new.state = old.state then
    if (new.approved_by, new.approved_at, new.decided_by, new.decided_at, new.decision_reason, new.ended_by, new.ended_at, new.end_reason)
       is distinct from (old.approved_by, old.approved_at, old.decided_by, old.decided_at, old.decision_reason, old.ended_by, old.ended_at, old.end_reason) then
      raise exception 'the decision and end of a delegation are fixed once recorded' using errcode = '23514';
    end if;
    return new;
  end if;
  if not ((old.state = 'PENDING' and new.state in ('ACTIVE', 'REJECTED', 'WITHDRAWN')) or (old.state = 'ACTIVE' and new.state = 'ENDED')) then
    raise exception 'delegation state % -> % is not allowed', old.state, new.state using errcode = '23514';
  end if;
  if new.state = 'ACTIVE' then
    if new.approved_at is distinct from now() then
      raise exception 'an approval is stamped with the time of the approving transaction' using errcode = '23514';
    end if;
    -- The actual authorised actor (CI09 by analogy): the duty that approves a grant, in company scope. Independence from
    -- the delegator, delegate and requester is in the CHECKs.
    if not exists (
      select 1
        from role_assignment a
        join user_account u on u.id = a.user_id and u.active
        join role r on r.company_id = a.company_id and r.id = a.role_id and r.active
        join permission p on p.resource = 'access' and p.action = 'approve_role_grant' and p.field_group = 'operational'
        join role_permission rp on rp.company_id = a.company_id and rp.role_id = a.role_id and rp.permission_id = p.id and rp.effect = 'ALLOW'
        join role_assignment_permission rap on rap.company_id = a.company_id and rap.role_assignment_id = a.id and rap.permission_id = p.id and rap.active
         and rap.effective_from <= now() and (rap.effective_to is null or rap.effective_to > now())
       where a.company_id = new.company_id and a.user_id = new.approved_by and a.state = 'ACTIVE' and a.scope_kind = 'COMPANY'
         and a.effective_from <= now() and (a.effective_to is null or a.effective_to > now())
    ) then
      raise exception 'the approver does not hold the approval duty' using errcode = '23514';
    end if;
  elsif new.state = 'ENDED' and new.ended_at is distinct from now() then
    raise exception 'an early end is stamped with the time of the ending transaction' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger delegation_guard before insert or update on delegation
  for each row execute function hrms_delegation_guard();

-- C4 at the data layer, now with C4 "Delegated task" in full. The row share locks order a decision against an early end.
create or replace function hrms_approval_decision_guard() returns trigger language plpgsql as $$
declare
  t approval_task%rowtype;
  i approval_instance%rowtype;
  bt business_transaction%rowtype;
  asg role_assignment%rowtype;
  d delegation%rowtype;
begin
  select * into t from approval_task where company_id = new.company_id and id = new.task_id for update;
  select * into i from approval_instance where company_id = new.company_id and id = t.instance_id;
  select * into bt from business_transaction where company_id = new.company_id and id = i.transaction_id;
  select * into asg from role_assignment where company_id = new.company_id and id = new.acting_assignment_id;

  if t.state <> 'PENDING' or i.state <> 'ACTIVE' then
    raise exception 'task is not open for decision' using errcode = '23514';
  end if;
  if i.transaction_revision <> bt.revision then
    raise exception 'decision targets a superseded revision' using errcode = '23514';
  end if;
  if new.expected_version <> bt.version then
    raise exception 'stale transaction version' using errcode = '40001';
  end if;
  if asg.user_id <> new.actor_user_id or asg.state <> 'ACTIVE'
     or new.occurred_at < asg.effective_from or (asg.effective_to is not null and new.occurred_at >= asg.effective_to) then
    raise exception 'acting assignment is not active for this actor' using errcode = '23514';
  end if;
  if bt.owner_employee_id is not null and exists (
    select 1 from user_employee_link l
     where l.company_id = new.company_id and l.user_id = new.actor_user_id and l.employee_id = bt.owner_employee_id
  ) then
    raise exception 'self decision is prohibited' using errcode = '23514';
  end if;
  if t.delegation_id is not null then
    select * into d from delegation where company_id = new.company_id and id = t.delegation_id for share;
    if d.state <> 'ACTIVE' or new.occurred_at < d.effective_from or new.occurred_at >= d.effective_to then
      raise exception 'delegation is not effective' using errcode = '23514';
    end if;
    if bt.owner_employee_id is not null and exists (
      select 1 from user_employee_link l
       where l.company_id = new.company_id and l.user_id = d.delegator_user_id and l.employee_id = bt.owner_employee_id
    ) then
      raise exception 'delegated self decision is prohibited' using errcode = '23514';
    end if;
    if d.permission_id <> (select s.permission_id from workflow_step s where s.company_id = new.company_id and s.id = t.step_id) then
      raise exception 'the delegated permission is not this step''s permission' using errcode = '23514';
    end if;
    if not hrms_delegation_covers(new.company_id, d.id, bt.owner_employee_id, new.occurred_at) then
      raise exception 'the delegator no longer holds this authority for this record' using errcode = '23514';
    end if;
    -- DF03 "cannot introduce Admin eligibility"; FR-068 "equivalent reviewer authority".
    if hrms_access_rank((select r.access_class from role r where r.company_id = asg.company_id and r.id = asg.role_id))
       < hrms_access_rank((select r.access_class from role_assignment a join role r on r.company_id = a.company_id and r.id = a.role_id
                            where a.company_id = new.company_id and a.id = d.delegator_assignment_id)) then
      raise exception 'the acting assignment is not of equivalent authority' using errcode = '23514';
    end if;
    -- C4 "no conflict": the requester or preparer of this transaction never decides it through a delegation.
    if new.actor_user_id = any(i.excluded_user_ids) or new.actor_user_id = i.created_by or new.actor_user_id = bt.created_by then
      raise exception 'a requester cannot decide through a delegation' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
