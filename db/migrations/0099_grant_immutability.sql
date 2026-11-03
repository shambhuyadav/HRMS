-- 0099 Direct writes cannot create or widen an approved grant (CI09 "Approved_by is the actual independent authorised
-- actor, not a freely editable attribution field. No assignment becomes usable before approved grant creation commits";
-- DB016, DB017, DB109 "active: true only after independent parent approval"; CI24; C4 own privilege grant).
--
--   role_assignment             starts PENDING and moves only PENDING -> ACTIVE, PENDING -> REVOKED, ACTIVE -> REVOKED.
--                               Approval names an approver who holds the approval duty, stamped with the transaction
--                               time. Once a row leaves PENDING its user, role, scope, start, purpose and approval are
--                               fixed, and its end may only come earlier.
--   role_scope_filter           no delete (a deleted filter widens a filtered scope to company-wide); no insert or update
--                               once the parent left PENDING.
--   role_assignment_permission  no insert once the parent left PENDING. After that only deactivation or an earlier end;
--                               activation happens only in the transaction that approves the parent.
--
-- Bootstrap: the first administrator has nobody to approve them, so a session may opt in with the setting
-- hrms.grant_bootstrap = 'on' (transaction-local through access/provision.ts withGrantBootstrap: the development seed).
-- A row inserted or changed that way is marked bootstrapped for good, so an access review can list every grant that did
-- not go through proposal and approval. The application's serving and worker paths never set it (a test scans the
-- source). The other checks on these tables, including 0098's C2 matrix, have no bootstrap exception.
--
-- LIMIT, stated plainly: the application connects with one database role that also owns these tables. These triggers
-- stop mistakes, application bugs and anyone writing plain SQL through a path that does not opt in. They do not stop a
-- holder of that role who means to get past them: such a session can set the bootstrap setting, disable or drop the
-- triggers, or stage a "real" approval by naming a user who holds the duty. Stopping that needs a separate migration
-- role that owns the tables and a serving role that cannot alter them, and an independent audit copy.

create function hrms_grant_bootstrap_on() returns boolean language sql stable as $$
  select coalesce(current_setting('hrms.grant_bootstrap', true), 'off') = 'on'
$$;

-- Existing rows that never went through a proposal (no requester recorded) are marked; versions are not bumped.
alter table role_assignment add column bootstrapped boolean not null default false;
alter table role_assignment disable trigger role_assignment_touch;
update role_assignment set bootstrapped = true where state <> 'PENDING' and created_by is null;
alter table role_assignment enable trigger role_assignment_touch;

create function hrms_role_assignment_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if hrms_grant_bootstrap_on() then
      new.bootstrapped := new.state <> 'PENDING';
      return new;
    end if;
    if new.state <> 'PENDING' then
      raise exception 'a role assignment starts PENDING; it becomes active only through independent approval' using errcode = '23514';
    end if;
    if new.approved_by is not null or new.approved_at is not null then
      raise exception 'a pending role assignment has no approver' using errcode = '23514';
    end if;
    if new.created_by is null then
      raise exception 'a role assignment proposal names its requester' using errcode = '23514';
    end if;
    new.bootstrapped := false;
    return new;
  end if;

  if hrms_grant_bootstrap_on() then
    new.bootstrapped := true;
    return new;
  end if;
  if new.bootstrapped is distinct from old.bootstrapped then
    raise exception 'the bootstrap marker of a role assignment is fixed' using errcode = '23514';
  end if;

  if old.state = 'PENDING' and new.state = 'PENDING' then
    if new.approved_by is not null or new.approved_at is not null then
      raise exception 'a pending role assignment has no approver' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.state <> old.state and not ((old.state = 'PENDING' and new.state in ('ACTIVE', 'REVOKED')) or (old.state = 'ACTIVE' and new.state = 'REVOKED')) then
    raise exception 'role assignment state % -> % is not allowed', old.state, new.state using errcode = '23514';
  end if;
  if (new.user_id, new.role_id, new.scope_kind, new.effective_from, new.purpose)
     is distinct from (old.user_id, old.role_id, old.scope_kind, old.effective_from, old.purpose) then
    raise exception 'an approved or ended role assignment keeps its user, role, scope, start and purpose' using errcode = '23514';
  end if;
  if old.effective_to is not null and (new.effective_to is null or new.effective_to > old.effective_to) then
    raise exception 'the end of a role assignment may only come earlier' using errcode = '23514';
  end if;
  if old.state = 'REVOKED' and new.decision_reason is distinct from old.decision_reason then
    raise exception 'the reason of an ended role assignment is fixed' using errcode = '23514';
  end if;

  if old.state = 'PENDING' and new.state = 'ACTIVE' then
    if new.approved_at is distinct from now() then
      raise exception 'an approval is stamped with the time of the approving transaction' using errcode = '23514';
    end if;
    -- CI09: the actual authorised actor. Containment and independence checks stay with the service and the CHECKs (0001).
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
      raise exception 'the approver does not hold the role-grant approval duty' using errcode = '23514';
    end if;
  elsif (new.approved_by, new.approved_at) is distinct from (old.approved_by, old.approved_at) then
    raise exception 'approved_by and approved_at are fixed once set' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger role_assignment_guard before insert or update on role_assignment
  for each row execute function hrms_role_assignment_guard();

-- The parent is share-locked, so a filter or allowlist entry can never slip in while the grant is being approved.
create function hrms_role_scope_filter_guard() returns trigger language plpgsql as $$
declare
  parent_state text;
begin
  if hrms_grant_bootstrap_on() then
    return new;
  end if;
  select state into parent_state from role_assignment where company_id = new.company_id and id = new.role_assignment_id for share;
  if parent_state is distinct from 'PENDING' then
    raise exception 'scope filters are fixed once the grant leaves PENDING' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and new.role_assignment_id is distinct from old.role_assignment_id then
    raise exception 'a scope filter stays with its assignment' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger role_scope_filter_guard before insert or update on role_scope_filter
  for each row execute function hrms_role_scope_filter_guard();
create trigger role_scope_filter_no_delete before delete on role_scope_filter
  for each row execute function hrms_no_delete();

create function hrms_role_assignment_permission_guard() returns trigger language plpgsql as $$
declare
  parent role_assignment%rowtype;
begin
  if hrms_grant_bootstrap_on() then
    return new;
  end if;
  select * into parent from role_assignment where company_id = new.company_id and id = new.role_assignment_id for share;
  if parent.state is distinct from 'PENDING' then
    if tg_op = 'INSERT' then
      raise exception 'the allowlist is fixed once the grant leaves PENDING' using errcode = '23514';
    end if;
    if (new.role_assignment_id, new.permission_id, new.effective_from) is distinct from (old.role_assignment_id, old.permission_id, old.effective_from) then
      raise exception 'an allowlist entry keeps its assignment, permission and start' using errcode = '23514';
    end if;
    if old.effective_to is not null and (new.effective_to is null or new.effective_to > old.effective_to) then
      raise exception 'the end of an allowlist entry may only come earlier' using errcode = '23514';
    end if;
    -- now() is the transaction time, which the approval stamped: a later transaction cannot switch an entry back on.
    if new.active and not old.active and not (parent.state = 'ACTIVE' and parent.approved_at = now()) then
      raise exception 'an allowlist entry is activated only by the approval of its grant' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger role_assignment_permission_guard before insert or update on role_assignment_permission
  for each row execute function hrms_role_assignment_permission_guard();

-- A row trigger does not see TRUNCATE; a truncated filter table would widen every filtered scope at once.
create function hrms_no_truncate() returns trigger language plpgsql as $$
begin
  raise exception '% cannot be truncated', tg_table_name using errcode = '23514';
end $$;

create trigger role_assignment_no_truncate before truncate on role_assignment for each statement execute function hrms_no_truncate();
create trigger role_scope_filter_no_truncate before truncate on role_scope_filter for each statement execute function hrms_no_truncate();
create trigger role_assignment_permission_no_truncate before truncate on role_assignment_permission for each statement execute function hrms_no_truncate();
