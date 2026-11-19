// Leave administration (FR-024, FR-025; BR-010; E06): leave types, policy revisions with their effective period and
// grade, location and employment-type mappings, independent activation and retirement, the mapped-policy export, the
// employees listed before accrual and the employee leave ledger. A warning is always in words as well as colour
// (FR-024 "with text as well as colour"). Every value comes from the person filling the form: the page proposes none but
// the zero carry DF05 states. The server re-checks every duty and rule; this page only offers what the role can do.
//
// Decided under owner delegation, 6 Nov 2026 (I-78 item 3): a revision names the month its leave year starts (no default:
// without it nothing expires), and the year-end run expires what is held above the carry cap on the year's last day.
export { MONTHLY_BALANCE_TEMPLATE } from './leave-admin/balances';
export { MONTHS } from './leave-admin/policies';
export { LEAVE_ADMIN_SCREENS } from './leave-admin/routes';
export { keepOnPage, ReportExport } from './leave-admin/shared';
export type { PolicyRevision } from './leave-admin/shared';
