// Reporting: dated reporting settings, the operational claim-state list, the dashboard's recent activity and the salary
// progression chart (I-83, decided under owner delegation, 6 Nov 2026; BR-045; FR-096; FR-097; DF17; FR-038). Migration
// 0196_reporting_settings.sql.
//
// Both permissions are operational. reporting_setting.manage is HR's configuration duty (the small-count threshold, the recent
// activity window, the progression chart's default span), changed only by a dated, audited revision. expense_state.read opens
// the claim-state list behind the Finance Reviewer's and Expense Finance Approver's figures (I-62 item 4): claim identity,
// claimant, state and an exception mark, never amounts, purpose, merchant, receipts or reasons (DF02). The salary progression
// chart adds no permission: it needs the confidential salary.read and salary.history_read grants of one eligible Admin or
// Manager assignment, which are never default duties.
import type { ModuleRegistration } from '../registry-types.js';

export const reportingRegistration: ModuleRegistration = {
  key: 'reporting',
  active: true,
  roleGrants: {
    HR_ADMINISTRATOR: { defaultDuties: ['reporting_setting.manage.operational'] },
    FINANCE_REVIEWER: { defaultDuties: ['expense_state.read.operational'] },
    EXPENSE_FINANCE_APPROVER: { defaultDuties: ['expense_state.read.operational'] },
  },
  operationalFieldGroups: [
    { resource: 'reporting_setting', fieldGroup: 'operational' },
    { resource: 'expense_state', fieldGroup: 'operational' },
  ],
};
