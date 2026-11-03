-- 0093 My Team export, member detail grants and the failed-integration widget (FR-095, FR-097; DF02; DF16; F2; ZT27).
--
-- team.export is the permission of the report catalogue's My Team export (MY_TEAM), like every report's <resource>.export.
-- It is a ceiling of the Reporting Manager, not a default duty: C2 and C3 name no export duty for the role.
-- team.read_history opens the member detail's Employment and Reporting and History tabs and nothing else; a default duty
-- of new Reporting Manager assignments. employee.read_history stays HR's: it also opens the employee history route.
--
-- Ceilings of the Reporting Manager in companies that already exist (modules/access/baseline.ts provisions new ones). A
-- ceiling is the most a role can be granted and grants nothing by itself; no assignment changes here, and an approved
-- assignment's allowlist stays frozen (0099), so an existing manager gains these only through a new approved grant:
--   team.read_history.operational, team.export.operational   as above;
--   salary.read.salary, document.read.document   DF02 "off by default ... independent approval and a named business
--     purpose": confidential, granted per assignment, never default duties.
insert into permission (resource, action, field_group) values ('team', 'export', 'operational'), ('team', 'read_history', 'operational');

insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join permission p
    on (p.resource, p.action, p.field_group) in (('team', 'export', 'operational'), ('team', 'read_history', 'operational'), ('salary', 'read', 'salary'), ('document', 'read', 'document'))
 where r.code = 'REPORTING_MANAGER'
on conflict (company_id, role_id, permission_id) do nothing;

-- F2 "Failed integration runs" now counts biometric_sync_run, so the widget follows the biometric read grant instead of the
-- account administration grant. A widget a company has since pointed elsewhere is left alone. hrms_touch() manages the
-- version and updated_at of these rows.
update role_dashboard_widget w
   set permission_id = biometric.id
  from role_dashboard_definition d
  join role r on r.company_id = d.company_id and r.id = d.role_id
  join permission biometric on biometric.resource = 'biometric' and biometric.action = 'read' and biometric.field_group = 'operational'
  join permission users on users.resource = 'access' and users.action = 'read_users' and users.field_group = 'operational'
 where d.company_id = w.company_id and d.id = w.dashboard_id and d.dashboard_code = 'HOME'
   and r.code = 'SYSTEM_ADMINISTRATOR' and w.widget_code = 'FAILED_INTEGRATIONS' and w.permission_id = users.id;
