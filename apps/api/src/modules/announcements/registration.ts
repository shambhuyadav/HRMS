// Company events and ticker messages (CL-021, CL-022; migration 0290_company_events_ticker). Everyone reads what is for them on their
// dashboard; the HR Administrator keeps the events and messages. Nothing here is about an employee, so both are operational.
import type { PermissionKey } from '../access/baseline.js';
import type { ModuleRegistration } from '../registry-types.js';

export const ANNOUNCEMENT_READ: PermissionKey = 'announcement.read.operational';
export const ANNOUNCEMENT_MANAGE: PermissionKey = 'announcement.manage.operational';
const reader = { defaultDuties: [ANNOUNCEMENT_READ] };

export const announcementsRegistration: ModuleRegistration = {
  key: 'announcements',
  active: true,
  roleGrants: {
    HR_ADMINISTRATOR: { defaultDuties: [ANNOUNCEMENT_READ, ANNOUNCEMENT_MANAGE] },
    SYSTEM_ADMINISTRATOR: reader,
    REPORTING_MANAGER: reader,
    EMPLOYEE: reader,
    PAYROLL_OPERATOR: reader,
    PAYROLL_APPROVER: reader,
    FINANCE_REVIEWER: reader,
    EXPENSE_FINANCE_APPROVER: reader,
    TREASURY_OPERATOR: reader,
    TREASURY_APPROVER: reader,
    RECRUITER: reader,
    APPRAISAL_REVIEWER: reader,
    TRAINING_COORDINATOR: reader,
    AUDITOR: reader,
  },
  operationalFieldGroups: [{ resource: 'announcement', fieldGroup: 'operational' }],
};
