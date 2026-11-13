-- 0310 The user access register (BRD role matrix: "System Administrator | Assigned-company configuration, access reviews and
-- system exceptions"; the source system's User Master and User Rights menus).
--
--   access.export   USER_ACCESS (modules/access/reports.ts): every role assignment of the company with its account, linked
--                   employee code and name, role, scope, restriction counts, state, dates, requester and approver. Access
--                   metadata only, the same as the user and grant lists the role already reads, so it is a ceiling and a
--                   default duty of the System Administrator role (modules/access/baseline.ts ACCESS_ADMIN).
--
-- The resource `access` is already classified OPERATIONAL in every company (its read_users duty depends on it), so no policy
-- row is added. An approved assignment's allowlist stays frozen (0099): an existing System Administrator assignment receives
-- the new duty through the one-time refresh the owner authorised after each deploy (deploy/scripts/refresh-duties.sh), which
-- adds only duties released after the assignment was approved.
insert into permission (resource, action, field_group) values ('access', 'export', 'operational')
on conflict (resource, action, field_group) do nothing;

insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join permission p on p.resource = 'access' and p.action = 'export' and p.field_group = 'operational'
 where r.code = 'SYSTEM_ADMINISTRATOR'
on conflict (company_id, role_id, permission_id) do nothing;
