-- 0124 Celebration access and the operational report rights (FR-093; section 11.2; DF12 "active company employees who have
-- celebration access"; FR-083; BR-032; FR-002 "export rights separately for each module"; DF02 "seed only the specified role
-- duties").
--
--   celebration.read      DF12's celebration access: who may receive a published celebration. A default duty of new
--                         Employee assignments (modules/access/baseline.ts).
--   celebration.export    UPCOMING_CELEBRATIONS, section 11.2 "owner-approved scoped audience only": a ceiling of the HR
--                         Administrator role, no default duty, so nobody holds it until a grant is approved.
--   notification.export   NOTIFICATION_DELIVERY, section 11.2 "restricted notification/support authority": a ceiling of the
--                         System Administrator role, no default duty.
--   biometric.export      BIOMETRIC_SYNC and BIOMETRIC_SYNC_EXCEPTIONS, section 11.2 "restricted integration administrator":
--                         a ceiling of the System Administrator role (C6's bundle is held there), no default duty.
--
-- Ceilings in companies that already exist; a ceiling grants nothing by itself. No assignment changes here: an approved
-- assignment's allowlist stays frozen (0099), so until a company grants celebration.read to its existing Employee
-- assignments, their holders receive no celebrations. That fails closed, and it is said in the decision register.
insert into permission (resource, action, field_group) values
  ('celebration', 'read', 'operational'),
  ('celebration', 'export', 'operational'),
  ('notification', 'export', 'operational'),
  ('biometric', 'export', 'operational');

insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join permission p on (r.code, p.resource, p.action, p.field_group) in (
    ('EMPLOYEE', 'celebration', 'read', 'operational'),
    ('HR_ADMINISTRATOR', 'celebration', 'export', 'operational'),
    ('SYSTEM_ADMINISTRATOR', 'notification', 'export', 'operational'),
    ('SYSTEM_ADMINISTRATOR', 'biometric', 'export', 'operational'))
on conflict (company_id, role_id, permission_id) do nothing;

-- DF12 publishes name, work department and event type only; both are operational fields (DF02). A new resource has no
-- classification until a policy row says so (BR-043), so existing companies get the row provisioning gives a new one, under
-- the approver and date of their employee operational policy.
insert into confidential_field_policy (company_id, resource_code, field_group, classification, effective_from, approved_by, approved_at, created_by)
select cfp.company_id, 'celebration', 'operational', 'OPERATIONAL', cfp.effective_from, cfp.approved_by, now(), cfp.approved_by
  from confidential_field_policy cfp
 where cfp.resource_code = 'employee' and cfp.field_group = 'operational' and cfp.effective_to is null
   and not exists (select 1 from confidential_field_policy x where x.company_id = cfp.company_id and x.resource_code = 'celebration' and x.field_group = 'operational');
