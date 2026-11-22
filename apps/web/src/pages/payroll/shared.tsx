// Shared parts of the payroll screens: keys, routes, query keys, styles, labels and the salary hold and stop shapes.

import { type ReactNode, useMemo, useRef } from 'react';
import { ApiError, formatAmount, idempotencyKey, readable } from '../../api';
import { type MeContext, useSession } from '../../session';
import { Badge } from '../../ui';
import type { RunDetail } from './types';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (registration.ts of payroll and payroll-outputs; each route's requireAccess)
// ---------------------------------------------------------------------------------------------------------

export const OWN_PAYSLIP = 'payslip.read.payslip';
export const OWN_LOAN_READ = 'own_loan.read.loan';
export const OWN_LOAN_REQUEST = 'own_loan.request.loan';
export const CONFIG_READ = 'payroll_config.read.operational';
export const RUN_READ_STATUS = 'payroll_run.read.operational';
export const RUN_READ_AMOUNT = 'payroll_run.read.amount';
export const RUN_PREPARE = 'payroll_run.prepare.amount';
export const RUN_REVIEW = 'payroll_run.review.amount';
export const RUN_APPROVE = 'payroll_run.approve.amount';
export const RUN_PROCESS = 'payroll_run.process.amount';
export const RUN_CANCEL = 'payroll_run.cancel.amount';
export const OUTPUT_READ = 'payroll_output.read.amount';
export const OUTPUT_PUBLISH = 'payroll_output.publish.amount';
export const TEMPLATE_READ = 'payroll_bank_template.read.operational';
export const BANK_READ = 'payroll_bank.read.amount';
export const BANK_PREPARE = 'payroll_bank.prepare.amount';
export const BANK_AUTHORIZE = 'payroll_bank.authorize.amount';
export const BANK_FILE = 'payroll_bank.download.bank';
export const BANK_OUTCOME = 'payroll_bank.record_outcome.amount';
export const LOAN_READ = 'payroll_loan.read.loan';
export const LOAN_DECIDE = 'payroll_loan.decide.loan';
export const LOAN_REQUEST = 'payroll_loan.request.loan';
export const LOAN_DISBURSE = 'payroll_loan.disburse.loan';
export const LOAN_RECOVER = 'payroll_loan.recover.loan';
export const INPUT_READ = 'payroll_input.read.amount';
export const INPUT_PREPARE = 'payroll_input.prepare.amount';
export const INPUT_APPROVE = 'payroll_input.approve.amount';
export const TEMPLATE_MANAGE = 'payroll_bank_template.manage.operational';
export const TEMPLATE_VALIDATE = 'payroll_bank_template.validate.operational';
export const TEMPLATE_ACTIVATE = 'payroll_bank_template.activate.operational';
export const REPORT_READ = 'payroll_report.read.amount';
/** The report catalogue exports of a run's register, reconciliation and comparison (POST /v1/reports; migration 0069). */
export const REPORT_EXPORT = 'payroll_report.export.amount';
export const STATUTORY_READ = 'payroll_statutory.read.operational';
/** Choosing an employee (employee search) and their evidence documents (released and verified) use these modules' keys. */
export const EMPLOYEE_LIST = 'employee.list.operational';
export const DOCUMENT_READ = 'document.read.document';

export const PATHS = {
  runs: '/payroll/runs',
  run: (id: string) => `/payroll/runs/${encodeURIComponent(id)}`,
  reports: (id: string) => `/payroll/runs/${encodeURIComponent(id)}/reports`,
  decisions: '/payroll/run-decisions',
  manifest: (id: string) => `/payroll/manifests/${encodeURIComponent(id)}`,
  loans: '/payroll/loans',
  loanUpload: '/payroll/loans/upload',
  holds: '/payroll/holds',
  stopUpload: '/payroll/holds/stop-upload',
  inputs: '/payroll/inputs',
  templates: '/payroll/bank-templates',
  statutory: '/payroll/statutory-outputs',
  calendars: '/payroll/calendars',
  calendar: (id: string) => `/payroll/calendars/${encodeURIComponent(id)}`,
  heads: '/payroll/heads',
  salaryComponents: '/payroll/salary-components',
};

/** The money pattern of the payroll routes (a decimal string; the server checks the currency's minor unit). */
export const MONEY = /^\d{1,15}(\.\d{1,4})?$/;
export const MONTH = /^\d{4}-\d{2}$/;

// ---------------------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------------------

/**
 * Query keys carry the selected company and role assignment: the app keeps one query cache across role switches, and
 * a confidential answer given to one assignment must never be shown under another, not even while the new one loads.
 */
export function useKeys() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(
    () => ({
      ownPayslips: ['payroll-own-payslips', context] as const,
      ownPayslipFile: (id: string) => ['payroll-own-payslips', context, 'file', id] as const,
      ownHolds: ['payroll-own-holds', context] as const,
      ownLoans: ['payroll-own-loans', context] as const,
      runsAll: ['payroll-runs', context] as const,
      runs: (state: string) => ['payroll-runs', context, state] as const,
      runAll: ['payroll-run', context] as const,
      run: (id: string) => ['payroll-run', context, id] as const,
      records: (id: string, after: string | null, onlyExceptions: boolean) => ['payroll-run', context, id, 'records', after, onlyExceptions] as const,
      components: (id: string) => ['payroll-run', context, id, 'components'] as const,
      runTasks: ['payroll-run-tasks', context] as const,
      calendars: ['payroll-calendars', context] as const,
      runPayslips: (id: string) => ['payroll-run', context, id, 'payslips'] as const,
      templates: ['payroll-bank-templates', context] as const,
      manifests: (runId: string) => ['payroll-run', context, runId, 'manifests'] as const,
      manifestAll: ['payroll-manifest', context] as const,
      manifest: (id: string) => ['payroll-manifest', context, id] as const,
      lines: (id: string, after: number) => ['payroll-manifest', context, id, 'lines', after] as const,
      loansAll: ['payroll-loans', context] as const,
      loans: (state: string) => ['payroll-loans', context, state] as const,
      loan: (id: string) => ['payroll-loans', context, 'detail', id] as const,
      holdTasks: ['payroll-hold-tasks', context] as const,
      holds: (state: string) => ['payroll-holds', context, state] as const,
      stopTasks: ['payroll-stop-tasks', context] as const,
      stops: ['payroll-stops', context] as const,
      inputBatchesAll: ['payroll-input-batches', context] as const,
      inputBatches: (state: string) => ['payroll-input-batches', context, 'list', state] as const,
      inputBatch: (id: string) => ['payroll-input-batches', context, 'detail', id] as const,
      inputTasks: ['payroll-input-batches', context, 'tasks'] as const,
      criteria: ['payroll-hold-criteria', context] as const,
      hold: (id: string) => ['payroll-hold-detail', context, id] as const,
      holdBalance: (recordId: string) => ['payroll-hold-balance', context, recordId] as const,
      template: (id: string) => ['payroll-bank-templates', context, 'detail', id] as const,
      templateSample: (id: string) => ['payroll-bank-templates', context, 'sample', id] as const,
      reportsAll: ['payroll-report', context] as const,
      register: (runId: string, after: string) => ['payroll-report', context, runId, 'register', after] as const,
      disbursement: (runId: string) => ['payroll-report', context, runId, 'disbursement'] as const,
      comparison: (runId: string) => ['payroll-report', context, runId, 'comparison'] as const,
      journal: (runId: string) => ['payroll-report', context, runId, 'journal'] as const,
      statutoryRegister: (runId: string, code: string, after: string) => ['payroll-report', context, runId, 'statutory-register', code, after] as const,
      reportExport: (id: string) => ['payroll-report-export', context, id] as const,
      statutory: ['payroll-statutory', context] as const,
      employeeSearch: (term: string) => ['payroll-employee-search', context, term] as const,
      documents: (employeeId: string) => ['payroll-evidence-documents', context, employeeId] as const,
      calendar: (id: string) => ['payroll-calendars', context, 'detail', id] as const,
      payComponents: ['payroll-pay-components', context] as const,
      heads: ['payroll-heads', context] as const,
      paidDayPolicies: ['payroll-paid-day-policies', context] as const,
      salaryHistory: (employeeId: string) => ['payroll-salary-history', context, employeeId] as const,
      salaryComponents: (arrangementId: string) => ['payroll-salary-components', context, arrangementId] as const,
    }),
    [context],
  );
}

/**
 * One idempotency key per intended action: the same action (same target and content) resent after a lost answer
 * reuses its key, so it is never applied twice; any other action, or one after a definite answer, gets a new key.
 */
export function useIntentKey(prefix: string) {
  const last = useRef<{ intent: string; key: string; lost: boolean } | null>(null);
  return useMemo(
    () => ({
      key(intent: string): string {
        const prior = last.current;
        const key = prior !== null && prior.lost && prior.intent === intent ? prior.key : idempotencyKey(prefix);
        last.current = { intent, key, lost: false };
        return key;
      },
      settle(error: unknown) {
        if (last.current) last.current.lost = error !== null && error !== undefined && !(error instanceof ApiError);
      },
    }),
    [prefix],
  );
}

/** A textarea keeps a readable width in a one-column form, as the old `.stack > label > textarea` rule had it. */
export const READABLE_WIDTH = 'max-w-[560px]';

export const canReadRuns = (can: (p: string) => boolean) => can(RUN_READ_STATUS) || can(RUN_READ_AMOUNT);
export const ownContext = (me: MeContext | null) => me !== null && me.scopeKind === 'OWN' && me.employeeId !== null;

/** An amount string exactly as the API returned it, formatted for reading (never parsed for arithmetic). */
export const money = (value: string | null | undefined, currency?: string | null) => (currency ? formatAmount(value, currency) : formatAmount(value, '').trim());

export const RUN_STATE: Record<string, string> = {
  DRAFT: 'Draft',
  CALCULATED: 'Calculated',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved, not yet processed',
  PROCESSED_LOCKED: 'Processed and locked',
  RETURNED: 'Returned (replaced by a new revision)',
  CANCELLED: 'Cancelled',
};
export const BATCH_STATE: Record<string, string> = {
  VALIDATED: 'Prepared, waiting for authorisation',
  AUTHORIZED: 'Authorised: amounts reserved, file not issued yet',
  ISSUED: 'Bank file issued (not a payment)',
  CANCELLED: 'Cancelled',
};
/** Only CONFIRMED reads as paid: a file, a reservation or a submission is never a payment (DF07). */
export const PAYMENT_STATE: Record<string, string> = {
  READY: 'Ready, not reserved',
  RESERVED: 'Reserved, not paid',
  SUBMITTED: 'Submitted to the bank, not confirmed',
  UNKNOWN: 'Outcome unknown, still reserved',
  CONFIRMED: 'Paid: confirmed from bank evidence',
  FAILED: 'Failed, not paid',
  CANCELLED: 'Cancelled, not paid',
  REVERSED: 'Reversed: the confirmed payment came back',
};
export const OUTCOME_LABEL: Record<string, string> = {
  SUBMITTED: 'Submitted to the bank',
  UNKNOWN: 'Outcome unknown (keeps the reservation)',
  CONFIRMED: 'Confirmed paid by the bank',
  FAILED: 'Failed (frees the reservation)',
  CANCELLED: 'Cancelled (frees the reservation)',
};
/** The outcome transitions the API accepts (bank.ts FROM). */
export const OUTCOME_FROM: Record<string, readonly string[]> = {
  SUBMITTED: ['RESERVED'],
  UNKNOWN: ['RESERVED', 'SUBMITTED'],
  CONFIRMED: ['RESERVED', 'SUBMITTED', 'UNKNOWN'],
  FAILED: ['RESERVED', 'SUBMITTED', 'UNKNOWN'],
  CANCELLED: ['RESERVED', 'SUBMITTED', 'UNKNOWN'],
};
export const LOAN_STATE: Record<string, string> = {
  REQUESTED: 'Requested, waiting for a decision',
  APPROVED: 'Approved, not disbursed yet',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
  CANCELLED: 'Cancelled',
  DISBURSED: 'Disbursed, being recovered',
  CLOSED: 'Closed',
};
export const LOAN_KIND: Record<string, string> = { LOAN: 'Loan', ADVANCE: 'Salary advance' };
export const HEAD_TYPE: Record<string, string> = { EARNING: 'Earning', REIMBURSEMENT: 'Reimbursement', DEDUCTION: 'Deduction', EMPLOYER_CONTRIBUTION: 'Employer contribution' };
export const TASK_STEP: Record<string, string> = { REVIEW: 'Review', APPROVAL: 'Approval', COVER: 'Covering approval' };

export const label = (map: Record<string, string>, code: string | null | undefined) => (code ? (map[code] ?? readable(code)) : '—');

export function Status({ map, code }: { map: Record<string, string>; code: string | null | undefined }) {
  const tone = code === 'CONFIRMED' ? 'good' : code === 'FAILED' || code === 'REJECTED' ? 'bad' : 'neutral';
  return <Badge tone={tone}>{label(map, code)}</Badge>;
}

export function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function involvement(run: RunDetail, userId: string | undefined): string[] {
  if (!userId) return [];
  const parts: string[] = [];
  if (run.createdBy === userId) parts.push('created');
  if (run.preparedBy === userId) parts.push('calculated');
  if (run.reviewedBy === userId) parts.push('reviewed');
  if (run.approvedBy === userId) parts.push('approved');
  return parts;
}

export const HOLD_READ = 'payroll_hold.read.hold';
export const HOLD_DECIDE = 'payroll_hold.decide.hold';
export const HOLD_RELEASE = 'payroll_hold.release.hold';
export const STOP_READ = 'payroll_stop.read.hold';
export const STOP_DECIDE = 'payroll_stop.decide.hold';
export const STOP_PROPOSE = 'payroll_stop.propose.hold';
export const HOLD_PROPOSE = 'payroll_hold.propose.hold';
export const HOLD_DEFINE = 'payroll_hold.define_criterion.hold';
export const HOLD_ACTIVATE = 'payroll_hold.activate_criterion.hold';

export interface Hold {
  id: string;
  holdKind: string;
  state: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  runId: string;
  runRevision: number;
  periodCode: string;
  criterionCode: string | null;
  reason: string | null;
  scope: string;
  holdAmount: string | null;
  currencyCode: string;
  effectiveDate: string | null;
  reviewDueOn: string | null;
  releaseCriterion: string | null;
  proposedAt: string | null;
  proposedBy: string | null;
  releasedAt: string | null;
  version: number;
}
/** H7 held salary totals of one currency over every hold the list matches (GET /v1/payroll/holds `totals`). */
export interface HoldTotals {
  currencyCode: string;
  reserved: string;
  confirmed: string;
  /** I-80: held salary still owed until its payment is confirmed, counted once per payroll record. */
  outstanding?: string;
}
export interface SalaryStop {
  id: string;
  periodCode: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  mode: string;
  approvedMode: string | null;
  criterionCode: string | null;
  reason: string;
  releaseCriterion: string | null;
  evidenceReference: string | null;
  state: string;
  proposedBy: string;
  decidedAt: string | null;
  createdAt: string;
  version: number;
}

export const HOLD_STATE: Record<string, string> = {
  PROPOSED: 'Proposed, waiting for a decision',
  APPROVED_ACTIVE: 'Active: payment withheld',
  EXPIRED_REVIEW: 'Review date passed: still withheld, needs review',
  RELEASED: 'Released',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};
export const HOLD_KIND: Record<string, string> = { POLICY_HOLD: 'Salary hold', PAYMENT_SAFETY_BLOCK: 'Bank safety block' };
export const STOP_MODE: Record<string, string> = { HOLD_DISBURSEMENT: 'Withhold payment (calculated, not paid)', EXCLUDE_CALCULATION: 'Leave out of the calculation' };
export const STOP_STATE: Record<string, string> = { SUBMITTED: 'Waiting for a decision', APPROVED: 'Approved', APPLIED: 'Applied to the run', REJECTED: 'Rejected', WITHDRAWN: 'Withdrawn', REVOKED: 'Revoked' };
