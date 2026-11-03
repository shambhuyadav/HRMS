-- 0089 Separation of duties on direct writes and the reroute of an open approval task.
--
-- Own-record guards (RBAC instruction "Apply all C4 separation-of-duty rules even when a user holds multiple roles"; C4
-- self approval; DF02 "Admin status does not bypass these checks"; ZT04): nobody amends their own attendance, credits
-- their own leave, records their own salary or changes a reporting line that names themselves. "Own" is a link in any
-- period, as the approval decision guard applies it (0002), so a former self-link still counts. A write that names no
-- actor (created_by null: provisioning, the development seed, test fixtures) cannot be checked here.
--
-- Reroute (C4 "owner-approved rerouting creates new task with history"): a new task on the same step replaces the old,
-- which stays as SUPERSEDED. Who may reroute is an open owner decision, so workflow.reroute_task is catalogued in no
-- role's ceiling: nobody can hold it until the owner decides (workflow/engine.ts rerouteTask).

create function hrms_is_own_employee(p_company uuid, p_user uuid, p_employee uuid) returns boolean language sql stable as $$
  select p_user is not null and exists (
    select 1 from user_employee_link l
     where l.company_id = p_company and l.user_id = p_user and l.employee_id = p_employee)
$$;

-- FR-021 amendments: the amendment row is the attendance record's change evidence, written by every amendment path.
create function hrms_attendance_amendment_not_own() returns trigger language plpgsql as $$
declare
  subject uuid;
begin
  select r.employee_id into subject from attendance_record r where r.company_id = new.company_id and r.id = new.attendance_record_id;
  if hrms_is_own_employee(new.company_id, new.actor_id, subject) then
    raise exception 'nobody amends their own attendance' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger attendance_amendment_not_own before insert on attendance_amendment
  for each row execute function hrms_attendance_amendment_not_own();

-- FR-025 manual credits only: reservations and consumption of one's own leave follow one's own requests, and accrual is
-- computed for every employee by the run, not chosen by the person who starts it.
create function hrms_leave_movement_not_own() returns trigger language plpgsql as $$
begin
  if hrms_is_own_employee(new.company_id, new.created_by, new.employee_id) then
    raise exception 'nobody posts an opening balance or adjustment to their own leave' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger leave_movement_not_own before insert on leave_movement
  for each row when (new.movement_kind in ('OPENING', 'ADJUSTMENT'))
  execute function hrms_leave_movement_not_own();

-- Every salary arrangement: an initial salary and an applied increment alike.
create function hrms_salary_arrangement_not_own() returns trigger language plpgsql as $$
begin
  if hrms_is_own_employee(new.company_id, new.created_by, new.employee_id) then
    raise exception 'nobody records their own salary' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger salary_arrangement_not_own before insert on salary_arrangement
  for each row execute function hrms_salary_arrangement_not_own();

-- A reporting line naming the actor widens their TEAM scope; one on their own record picks their own approver.
create function hrms_manager_assignment_not_own() returns trigger language plpgsql as $$
declare
  actor uuid := case tg_op when 'INSERT' then new.created_by else new.updated_by end;
begin
  if hrms_is_own_employee(new.company_id, actor, new.employee_id) or hrms_is_own_employee(new.company_id, actor, new.manager_employee_id) then
    raise exception 'nobody sets a reporting line of their own record or names themselves as a manager' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger manager_assignment_not_own before insert or update of employee_id, manager_employee_id on manager_assignment
  for each row execute function hrms_manager_assignment_not_own();

-- One open task per step replaces one task per step and assignee: a reporting line may change back, so the same person
-- can receive the step again, and two reroutes can never leave two open tasks.
do $$
declare
  c text;
begin
  select conname into c
    from pg_constraint
   where conrelid = 'approval_task'::regclass and contype = 'u'
     and (select array_agg(a.attname::text order by a.attname::text)
            from unnest(conkey) k join pg_attribute a on a.attrelid = conrelid and a.attnum = k)
         = array['assignee_user_id', 'company_id', 'instance_id', 'step_id'];
  execute format('alter table approval_task drop constraint %I', c);
end $$;
create unique index approval_task_one_open_per_step_uq on approval_task (company_id, instance_id, step_id) where state = 'PENDING';

-- The rule that routed the first step when a module overrode it (DF05 old back-dated requests go to HR), so a reroute of
-- that step selects by the same rule.
alter table approval_instance add column selection_override text
  check (selection_override in ('DIRECT_MANAGER', 'HR_FALLBACK_LIST', 'PERMISSION_IN_SCOPE'));

insert into permission (resource, action, field_group) values ('workflow', 'reroute_task', 'operational');
