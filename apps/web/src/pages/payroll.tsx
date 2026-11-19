// Payroll (FR-028 to FR-034, FR-038, FR-102, FR-107; H2; H3 TN06 and TN15; DF02; DF07; I-28; I-32).
// My ESS (Employee OWN context): TN06 the employee's own issued payslips, with earned, held, reserved and paid shown
// apart exactly as the API returns them, and the notice that publication is not payment; TN15 own loans and advances
// with their schedule and balance as returned, a request form and the withdrawal of an undecided own request.
// HR (an eligible HR Administrator assignment): payroll runs (list, start a run from a previewed scope, detail with
// revision, members, exceptions and their resolution, totals and the prior-period comparison as returned) and the
// actions each state offers, each gated by its own key; the review and approval decision queues; for a processed run,
// payslip publishing and bank manifests (preparation, independent authorisation, the restricted file, outcomes from
// evidence and reversals); the loan decision queue and the loan request upload (LOAN_REQUESTS_V1, the shared batch
// screens of records.tsx); salary hold and salary stop decisions and hold release, salary stop proposals one at a time
// and by upload (SALARY_STOPS_V1, the same shared batch screens), with the H7 reserved and confirmed totals of
// every matching hold; the run reports (register, reconciliation, comparison) and their report catalogue exports (CSV
// or XLSX, under the export key).
// Configuration (payroll_config.* duties; I-28, no defaults, so nothing is prefilled): payroll calendars with their
// monthly periods and independent activation, the paid-day policy, pay components and effective-dated head revisions
// (independently activated; rule-pack heads labelled as blocking); the salary components of an arrangement (salary
// grants), shown as returned and set once.
// The server authorises every call and decides every rule (independence, scope, state); this screen only hides what
// the selected assignment cannot use and explains refusals in plain words. Money is confidential: only what the API
// returned is rendered, as its strings through formatAmount, and nothing is computed in the browser. Nothing is called
// paid unless the API reports a CONFIRMED payment.
export { statutoryNote } from './payroll/ess';
export { PAYROLL_ESS_PANELS, PAYROLL_SCREENS, PAYROLL_TASK_QUEUES } from './payroll/routes';
