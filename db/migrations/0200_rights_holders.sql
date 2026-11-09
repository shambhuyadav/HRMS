-- 0200 Who holds which rights (I-84 items 1, 2 and 6; decided under owner delegation, 6 Nov 2026; docs/10 B1, B2, B6; C3 "privileged
-- change approved and logged, no own approval"; C4 "owner-approved rerouting creates new task with history"; C6; FR-066; FR-067).
--
-- Ceilings of the HR Administrator role in companies that already exist; provisioning gives a new company the same
-- (modules/access/baseline.ts). A ceiling grants nothing by itself:
--   workflow.reroute_task       a default duty of new HR Administrator assignments (operational: the rule picks the new reviewer).
--   access.approve_role_grant   ceiling only, never a default duty: an HR Administrator assignment granted it is an eligible approver
--   access.read_users           of a change to the System Administrator role (whose holders may not decide it, 0132), and checks
--                               grants the System Administrator proposes. Independence stays with the database (0099, 0132).
-- Rows already there (an earlier approved ALLOW, or a DENY) are kept as they are.
--
-- GO-LIVE NOTE: an approved assignment's allowlist is fixed (0099), so existing HR Administrator and Reporting Manager assignments do not
-- gain the new default duties (workflow.reroute_task, access.delegate, notification.approve_rules); a company that wants them grants
-- them through a newly approved assignment.
insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join permission p on (p.resource, p.action, p.field_group) in (
    ('workflow', 'reroute_task', 'operational'),
    ('access', 'approve_role_grant', 'operational'),
    ('access', 'read_users', 'operational'))
 where r.code = 'HR_ADMINISTRATOR'
on conflict (company_id, role_id, permission_id) do nothing;
