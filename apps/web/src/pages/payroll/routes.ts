// Navigation exports of the payroll module: its screens, its My ESS panels and its decision queues.

import type { ComponentType } from 'react';
import type { EssPanel, ScreenRoute } from '../../screens';
import { TemplatesScreen } from './bank-templates';
import { SALARY_READ } from './config';
import { CalendarScreen, CalendarsScreen } from './config-calendars';
import { HeadsScreen } from './config-heads';
import { SalaryComponentsScreen } from './config-salary-components';
import { MyLoansPanel, MyPayslipsPanel } from './ess';
import { LoanDecisionQueue, LoansScreen } from './loans';
import { ManifestScreen } from './manifests';
import { HoldDecisionQueue, InputDecisionQueue, RunApprovalQueue, RunReviewQueue, StopDecisionQueue } from './queues';
import { RunReportsScreen, StatutoryScreen } from './reports';
import { RunScreen } from './run-detail';
import { RunsScreen } from './runs';
import { HoldsScreen, InputsScreen, RunDecisionsScreen } from './screens';
import { BANK_READ, CONFIG_READ, HOLD_DECIDE, HOLD_READ, INPUT_APPROVE, INPUT_READ, LOAN_DECIDE, LOAN_READ, LOAN_REQUEST, PATHS, REPORT_READ, RUN_APPROVE, RUN_READ_AMOUNT, RUN_READ_STATUS, RUN_REVIEW, STATUTORY_READ, STOP_DECIDE, STOP_PROPOSE, TEMPLATE_READ } from './shared';
import { LoanUploadScreen, StopUploadScreen } from './uploads';

// ---------------------------------------------------------------------------------------------------------
// Exports for the navigation step (App.tsx wires these)
// ---------------------------------------------------------------------------------------------------------

/**
 * Screens of the payroll module; detail screens are reached through links (nav: false). The run list accepts either
 * run read group (operational status or amounts), so its menu entry is keyed to the operational one the payroll,
 * finance and treasury roles hold; amounts, records and outputs appear only for the confidential grants.
 */
export const PAYROLL_SCREENS: ScreenRoute[] = [
  { path: PATHS.runs, title: 'Payroll runs', permission: RUN_READ_STATUS, nav: true, component: RunsScreen },
  { path: '/payroll/runs/:id', title: 'Payroll run', permission: RUN_READ_STATUS, nav: false, component: RunScreen },
  { path: PATHS.decisions, title: 'Payroll run decisions', permission: RUN_READ_AMOUNT, nav: true, component: RunDecisionsScreen },
  { path: '/payroll/manifests/:id', title: 'Bank manifest', permission: BANK_READ, nav: false, component: ManifestScreen },
  { path: PATHS.loans, title: 'Loans and advances', permission: LOAN_READ, nav: true, component: LoansScreen },
  { path: PATHS.loanUpload, title: 'Loan and advance upload', permission: LOAN_REQUEST, nav: true, component: LoanUploadScreen },
  { path: PATHS.holds, title: 'Salary holds and stops', permission: HOLD_READ, nav: true, component: HoldsScreen },
  { path: PATHS.stopUpload, title: 'Salary stop upload', permission: STOP_PROPOSE, nav: true, component: StopUploadScreen },
  { path: PATHS.inputs, title: 'Payroll inputs', permission: INPUT_READ, nav: true, component: InputsScreen },
  { path: PATHS.templates, title: 'Bank file templates', permission: TEMPLATE_READ, nav: true, component: TemplatesScreen },
  { path: '/payroll/runs/:id/reports', title: 'Payroll reports', permission: REPORT_READ, nav: false, component: RunReportsScreen },
  { path: PATHS.statutory, title: 'Statutory outputs', permission: STATUTORY_READ, nav: true, component: StatutoryScreen },
  { path: PATHS.calendars, title: 'Payroll calendars', permission: CONFIG_READ, nav: true, component: CalendarsScreen },
  { path: '/payroll/calendars/:id', title: 'Payroll calendar', permission: CONFIG_READ, nav: false, component: CalendarScreen },
  { path: PATHS.heads, title: 'Pay heads', permission: CONFIG_READ, nav: true, component: HeadsScreen },
  { path: PATHS.salaryComponents, title: 'Salary components', permission: SALARY_READ, nav: true, component: SalaryComponentsScreen },
];

/** H3 TN06 (own issued payslips) and TN15 (own loans and advances) in the Employee OWN context. */
export const PAYROLL_ESS_PANELS: EssPanel[] = [
  { tabId: 'TN06', component: MyPayslipsPanel },
  { tabId: 'TN15', component: MyLoansPanel },
];

/**
 * Decision queues, also shown on the run decisions and loans screens. Run tasks are listed by
 * GET /v1/payroll/runs/tasks/mine (payroll_run.read.amount) and decided with each step's own duty: review
 * (payroll_run.review.amount), approval and covering approval (payroll_run.approve.amount). Loan requests are
 * listed by GET /v1/payroll-outputs/loans?state=REQUESTED and decided with payroll_loan.decide.loan. Salary holds and
 * salary stops are listed by their tasks/mine routes (the hold and stop read duties) and decided with
 * payroll_hold.decide.hold and payroll_stop.decide.hold. Input batches are listed by GET
 * /v1/payroll/input-batches/tasks/mine (payroll_input.read.amount) and decided with payroll_input.approve.amount.
 */
export const PAYROLL_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [
  { permission: RUN_REVIEW, title: 'Payroll run reviews', component: RunReviewQueue },
  { permission: RUN_APPROVE, title: 'Payroll run approvals', component: RunApprovalQueue },
  { permission: LOAN_DECIDE, title: 'Loan requests', component: LoanDecisionQueue },
  { permission: HOLD_DECIDE, title: 'Salary holds', component: HoldDecisionQueue },
  { permission: STOP_DECIDE, title: 'Salary stops', component: StopDecisionQueue },
  { permission: INPUT_APPROVE, title: 'Payroll input batches', component: InputDecisionQueue },
];
