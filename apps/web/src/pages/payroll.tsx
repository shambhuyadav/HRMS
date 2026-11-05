// Payroll (FR-028 to FR-034, FR-038, FR-102, FR-107; H2; H3 TN06 and TN15; DF02; DF07; I-28; I-32).
// My ESS (Employee OWN context): TN06 the employee's own issued payslips, with earned, held, reserved and paid shown
// apart exactly as the API returns them, and the notice that publication is not payment; TN15 own loans and advances
// with their schedule and balance as returned, a request form and the withdrawal of an undecided own request.
// HR (an eligible HR Administrator assignment): payroll runs (list, start a run from a previewed scope, detail with
// revision, members, exceptions and their resolution, totals and the prior-period comparison as returned) and the
// actions each state offers, each gated by its own key; the review and approval decision queues; for a processed run,
// payslip publishing and bank manifests (preparation, independent authorisation, the restricted file, outcomes from
// evidence and reversals); the loan decision queue and the loan request upload (LOAN_REQUESTS_V1, the shared batch
// screens of records.tsx); salary hold and salary stop decisions and hold release (their
// proposals need verified evidence documents and are not offered here), with the H7 reserved and confirmed totals of
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentType, type CSSProperties, type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, download, fileToBase64, formatAmount, formatDate, idempotencyKey, localDate, pinSession } from '../api';
import { isReportRefusal } from '../report-failures';
import type { EssPanel, ScreenRoute } from '../screens';
import { type MeContext, useSession } from '../session';
import { Badge, Empty, LIST_PAGE_SIZE, Pager, pageParams, Section } from '../ui';
import { DelegatedBadge } from './delegations';
import { HeldBatchCheck, ImportBatches, type ImportJob, ImportJobView, type ImportTemplate, TemplateDownload, useBatchFollowUp } from './records';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (registration.ts of payroll and payroll-outputs; each route's requireAccess)
// ---------------------------------------------------------------------------------------------------------

const OWN_PAYSLIP = 'payslip.read.payslip';
const OWN_LOAN_READ = 'own_loan.read.loan';
const OWN_LOAN_REQUEST = 'own_loan.request.loan';
const CONFIG_READ = 'payroll_config.read.operational';
const RUN_READ_STATUS = 'payroll_run.read.operational';
const RUN_READ_AMOUNT = 'payroll_run.read.amount';
const RUN_PREPARE = 'payroll_run.prepare.amount';
const RUN_REVIEW = 'payroll_run.review.amount';
const RUN_APPROVE = 'payroll_run.approve.amount';
const RUN_PROCESS = 'payroll_run.process.amount';
const RUN_CANCEL = 'payroll_run.cancel.amount';
const OUTPUT_READ = 'payroll_output.read.amount';
const OUTPUT_PUBLISH = 'payroll_output.publish.amount';
const TEMPLATE_READ = 'payroll_bank_template.read.operational';
const BANK_READ = 'payroll_bank.read.amount';
const BANK_PREPARE = 'payroll_bank.prepare.amount';
const BANK_AUTHORIZE = 'payroll_bank.authorize.amount';
const BANK_FILE = 'payroll_bank.download.bank';
const BANK_OUTCOME = 'payroll_bank.record_outcome.amount';
const LOAN_READ = 'payroll_loan.read.loan';
const LOAN_DECIDE = 'payroll_loan.decide.loan';
const LOAN_REQUEST = 'payroll_loan.request.loan';
const LOAN_DISBURSE = 'payroll_loan.disburse.loan';
const LOAN_RECOVER = 'payroll_loan.recover.loan';
const INPUT_READ = 'payroll_input.read.amount';
const INPUT_PREPARE = 'payroll_input.prepare.amount';
const INPUT_APPROVE = 'payroll_input.approve.amount';
const TEMPLATE_MANAGE = 'payroll_bank_template.manage.operational';
const TEMPLATE_VALIDATE = 'payroll_bank_template.validate.operational';
const TEMPLATE_ACTIVATE = 'payroll_bank_template.activate.operational';
const REPORT_READ = 'payroll_report.read.amount';
/** The report catalogue exports of a run's register, reconciliation and comparison (POST /v1/reports; migration 0069). */
const REPORT_EXPORT = 'payroll_report.export.amount';
const STATUTORY_READ = 'payroll_statutory.read.operational';
/** Choosing an employee (employee search) and their evidence documents (released and verified) use these modules' keys. */
const EMPLOYEE_LIST = 'employee.list.operational';
const DOCUMENT_READ = 'document.read.document';

const PATHS = {
  runs: '/payroll/runs',
  run: (id: string) => `/payroll/runs/${encodeURIComponent(id)}`,
  reports: (id: string) => `/payroll/runs/${encodeURIComponent(id)}/reports`,
  decisions: '/payroll/run-decisions',
  manifest: (id: string) => `/payroll/manifests/${encodeURIComponent(id)}`,
  loans: '/payroll/loans',
  loanUpload: '/payroll/loans/upload',
  inputs: '/payroll/inputs',
  templates: '/payroll/bank-templates',
  statutory: '/payroll/statutory-outputs',
  calendars: '/payroll/calendars',
  calendar: (id: string) => `/payroll/calendars/${encodeURIComponent(id)}`,
  heads: '/payroll/heads',
  salaryComponents: '/payroll/salary-components',
};

/** The money pattern of the payroll routes (a decimal string; the server checks the currency's minor unit). */
const MONEY = /^\d{1,15}(\.\d{1,4})?$/;
const MONTH = /^\d{4}-\d{2}$/;

// ---------------------------------------------------------------------------------------------------------
// API shapes (as the routes return them)
// ---------------------------------------------------------------------------------------------------------

interface OwnPayslip {
  id: string;
  periodCode: string;
  version: number;
  publicationState: string;
  label: string;
  issuedAt: string;
  supersededAt: string | null;
  /** Present for the current (ISSUED) version only. */
  payment: { earned: string | null; held: string; reserved: string; paid: string } | null;
}
interface OwnPayslips {
  items: OwnPayslip[];
  form16?: { status: string; code?: string };
}

interface Installment {
  sequence: number;
  dueMonth: string;
  amount: string;
}
interface LoanRecovery {
  id: string;
  periodCode: string;
  runId: string;
  amount: string;
  recognisedAt: string;
}
interface OwnLoan {
  id: string;
  loanKind: string;
  requestOrigin: string;
  currencyCode: string;
  principal: string;
  purpose: string;
  state: string;
  requestedAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
  disbursementDate: string | null;
  recovered: string;
  /** Deducted by processed payroll, not yet recognised as a recovery; `outstanding` is already net of it. */
  awaitingRecognition?: string;
  outstanding: string;
  closedAt: string | null;
  version: number;
  installments: Installment[];
  recoveries: LoanRecovery[];
}
interface OwnLoans {
  items: OwnLoan[];
  interest?: { status: string };
  earlySettlement?: { status: string };
}
interface Loan extends Omit<OwnLoan, 'installments' | 'recoveries'> {
  employeeId: string;
  employeeCode: string;
  recoveryHead: string | null;
  disbursementReference: string | null;
  closeReason: string | null;
  requestedBy: string;
  decidedBy: string | null;
  disbursedBy: string | null;
  installments?: Installment[];
  recoveries?: LoanRecovery[];
}

interface RunRow {
  id: string;
  lineageId: string;
  revision: number;
  state: string;
  periodCode: string;
  periodId: string;
  calendarCode: string;
  memberCount: number;
  unresolvedExceptions: number;
  createdAt: string;
  processedAt: string | null;
  version: number;
}
interface RunTotals {
  currencyCode: string;
  records: number;
  paidUnits: string | null;
  earnings: string | null;
  reimbursements: string | null;
  gross: string | null;
  deductions: string | null;
  net: string | null;
  employerContributions: string | null;
}
interface RunDetail {
  id: string;
  lineageId: string;
  revision: number;
  supersedesRunId: string | null;
  successorRunId: string | null;
  state: string;
  calendarCode: string;
  period: { id: string; periodCode: string; financialYear: string; serviceStart: string; serviceEnd: string; inputCutoff: string | null; paymentDate: string | null; daysInMonth: number };
  currencyCode: string;
  members: { included: number; excluded: number };
  progress: {
    calculation: { started: boolean; members: number; calculated: number; chunks: number; complete: boolean };
    processing: { started: boolean; records: number; frozen: number; chunks: number; complete: boolean };
  };
  records: Record<string, number>;
  exceptions: { blocking: number; unresolved: number; warnings: number };
  createdBy: string;
  preparedBy: string | null;
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  approvalStage: { state: string } | null;
  covers: { employeeId: string; coveredRole: string; state: string }[];
  processingStartedAt: string | null;
  processedAt: string | null;
  processedBy: string | null;
  lockVersion: number | null;
  closedAt: string | null;
  paymentStatus: string;
  decisions: { transactionKind: string; action: string; decision: string; decidedAt: string }[];
  /** Confidential (payroll_run.read.amount): present only for granted callers. */
  closeReason?: string | null;
  scopeComplete?: boolean;
  totals?: RunTotals[];
  createdAt: string;
  version: number;
}
interface RunException {
  id: string;
  code: string;
  severity: string;
  resolvable: boolean;
  detail: unknown;
  resolvedAt: string | null;
  resolvedBy: string | null;
}
interface RunRecord {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  calculationStatus: string;
  paidUnits: string | null;
  currencyCode: string;
  gross: string | null;
  deductions: string | null;
  net: string | null;
  priorNet: string | null;
  salaryStopMode: string | null;
  bankStatus: string | null;
  exceptions: RunException[];
}
interface RunComponents {
  runId: string;
  basis: string;
  priorPeriodCode: string | null;
  items: { componentCode: string; headType: string; current: string; prior: string; difference: string }[];
}
interface RunTask {
  taskId: string;
  step: string;
  run: { id: string; revision: number; state: string; periodCode: string; coveredEmployeeId: string | null } | null;
}
interface RunDecided {
  runId: string;
  state: string;
  step?: string;
  nextRunId?: string;
  coversRequired?: number;
  replayed: boolean;
}
interface Calendar {
  id: string;
  code: string;
  name: string;
  currencyCode: string;
  state: string;
  periods: { id: string; periodCode: string; serviceStart: string; serviceEnd: string; paymentDate: string | null }[];
}
interface ScopePreview {
  periodId: string;
  periodCode: string;
  memberCount: number;
  members: { employeeId: string; employeeCode: string; displayName: string }[];
  membersTruncated: boolean;
  notIncludedCount: number;
  notIncludedByReason: Record<string, number>;
  scopeToken: string;
}
interface IssuedOutput {
  id: string;
  employeeCode: string;
  periodCode: string;
  version: number;
  publicationState: string;
  issuedAt: string | null;
  fileName: string | null;
  supersededAt: string | null;
  rowVersion: number;
}
interface PublishResult {
  runId: string;
  published: number;
  remaining: number;
  ownRecordLeftForAnotherPublisher: number;
  done: boolean;
}
interface BankTemplate {
  id: string;
  templateCode: string;
  templateVersion: number;
  name: string;
  currencyCode: string;
  testOnly: boolean;
  state: string;
}
interface BankPreview {
  label: string;
  payable: boolean;
  currencyCode: string;
  lineCount: number;
  totalAmount: string | null;
  excluded: { held: number; heldBySalaryStop?: number; reservedOrPaid: number; nothingPayable: number };
  errors: BankRowError[];
}
interface BankRowError {
  lineSequence: number | null;
  employeeCode?: string;
  code: string;
  source?: string;
}
interface ManifestRow {
  id: string;
  templateCode: string;
  templateVersion: number;
  batchRevision: number;
  state: string;
  lineCount: number;
  totalAmount: string | null;
  currencyCode: string;
  preparedAt: string | null;
  authorizedAt: string | null;
  issuedAt: string | null;
  version: number;
}
interface Manifest extends ManifestRow {
  runId: string;
  testOnly: boolean;
  supersedesBatchId: string | null;
  paymentDate: string | null;
  manifestHash: string;
  excluded: { held?: number; heldBySalaryStop?: number; reservedOrPaid?: number; nothingPayable?: number; excludedByPreparer?: number; excludedEmployeeCodes?: string[] } | null;
  preparedBy: string;
  authorizedBy: string | null;
  contentHash: string | null;
  fileName: string | null;
  cancelledAt: string | null;
  ledger: { paymentState: string; lines: number; amount: string | null; netConfirmed: string | null }[];
}
interface BankLine {
  id: string;
  lineSequence: number;
  allocationKey: string;
  employeeCode: string;
  holdId: string | null;
  amount: string;
  currencyCode: string;
  paymentState: string;
  confirmedAmount: string;
  reversedAmount: string;
}

// ---------------------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------------------

/**
 * Query keys carry the selected company and role assignment: the app keeps one query cache across role switches, and
 * a confidential answer given to one assignment must never be shown under another, not even while the new one loads.
 */
function useKeys() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(
    () => ({
      ownPayslips: ['payroll-own-payslips', context] as const,
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
function useIntentKey(prefix: string) {
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

const SCROLL: CSSProperties = { overflowX: 'auto' };
const H3: CSSProperties = { fontSize: '1rem', margin: '0.75rem 0 0.25rem' };
const FLUSH: CSSProperties = { margin: '0.25rem 0' };
const PLAIN_LIST: CSSProperties = { listStyle: 'none', padding: 0, margin: 0 };
const TEXTAREA: CSSProperties = { font: 'inherit', padding: '0.4rem 0.5rem', border: '1px solid var(--line)', borderRadius: 6, color: 'var(--text)', resize: 'vertical' };
const GROUP: CSSProperties = { border: 'none', margin: 0, padding: 0, minWidth: 0 };

/** A refusal or bad request will not change on retry; only transient failures are retried (once). */
const retryTransient = (failureCount: number, error: Error) => !(error instanceof ApiError && error.status < 500) && failureCount < 1;
const canReadRuns = (can: (p: string) => boolean) => can(RUN_READ_STATUS) || can(RUN_READ_AMOUNT);
const ownContext = (me: MeContext | null) => me !== null && me.scopeKind === 'OWN' && me.employeeId !== null;

function readable(code: string): string {
  const text = code.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** An amount string exactly as the API returned it, formatted for reading (never parsed for arithmetic). */
const money = (value: string | null | undefined, currency?: string | null) => (currency ? formatAmount(value, currency) : formatAmount(value, '').trim());

const RUN_STATE: Record<string, string> = {
  DRAFT: 'Draft',
  CALCULATED: 'Calculated',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved, not yet processed',
  PROCESSED_LOCKED: 'Processed and locked',
  RETURNED: 'Returned (replaced by a new revision)',
  CANCELLED: 'Cancelled',
};
const BATCH_STATE: Record<string, string> = {
  VALIDATED: 'Prepared, waiting for authorisation',
  AUTHORIZED: 'Authorised: amounts reserved, file not issued yet',
  ISSUED: 'Bank file issued (not a payment)',
  CANCELLED: 'Cancelled',
};
/** Only CONFIRMED reads as paid: a file, a reservation or a submission is never a payment (DF07). */
const PAYMENT_STATE: Record<string, string> = {
  READY: 'Ready, not reserved',
  RESERVED: 'Reserved, not paid',
  SUBMITTED: 'Submitted to the bank, not confirmed',
  UNKNOWN: 'Outcome unknown, still reserved',
  CONFIRMED: 'Paid: confirmed from bank evidence',
  FAILED: 'Failed, not paid',
  CANCELLED: 'Cancelled, not paid',
  REVERSED: 'Reversed: the confirmed payment came back',
};
const OUTCOME_LABEL: Record<string, string> = {
  SUBMITTED: 'Submitted to the bank',
  UNKNOWN: 'Outcome unknown (keeps the reservation)',
  CONFIRMED: 'Confirmed paid by the bank',
  FAILED: 'Failed (frees the reservation)',
  CANCELLED: 'Cancelled (frees the reservation)',
};
/** The outcome transitions the API accepts (bank.ts FROM). */
const OUTCOME_FROM: Record<string, readonly string[]> = {
  SUBMITTED: ['RESERVED'],
  UNKNOWN: ['RESERVED', 'SUBMITTED'],
  CONFIRMED: ['RESERVED', 'SUBMITTED', 'UNKNOWN'],
  FAILED: ['RESERVED', 'SUBMITTED', 'UNKNOWN'],
  CANCELLED: ['RESERVED', 'SUBMITTED', 'UNKNOWN'],
};
const LOAN_STATE: Record<string, string> = {
  REQUESTED: 'Requested, waiting for a decision',
  APPROVED: 'Approved, not disbursed yet',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
  CANCELLED: 'Cancelled',
  DISBURSED: 'Disbursed, being recovered',
  CLOSED: 'Closed',
};
const LOAN_KIND: Record<string, string> = { LOAN: 'Loan', ADVANCE: 'Salary advance' };
const HEAD_TYPE: Record<string, string> = { EARNING: 'Earning', REIMBURSEMENT: 'Reimbursement', DEDUCTION: 'Deduction', EMPLOYER_CONTRIBUTION: 'Employer contribution' };
const TASK_STEP: Record<string, string> = { REVIEW: 'Review', APPROVAL: 'Approval', COVER: 'Covering approval' };

const label = (map: Record<string, string>, code: string | null | undefined) => (code ? (map[code] ?? readable(code)) : '—');

function Status({ map, code }: { map: Record<string, string>; code: string | null | undefined }) {
  const tone = code === 'CONFIRMED' ? 'good' : code === 'FAILED' || code === 'REJECTED' ? 'bad' : 'neutral';
  return <Badge tone={tone}>{label(map, code)}</Badge>;
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Refusals in plain words
// ---------------------------------------------------------------------------------------------------------

type Act =
  | 'read'
  | 'own'
  | 'download'
  | 'export'
  | 'loan-request'
  | 'loan-upload'
  | 'loan-withdraw'
  | 'loan-decide'
  | 'run-start'
  | 'run'
  | 'process'
  | 'run-decision'
  | 'resolve'
  | 'publish'
  | 'prepare'
  | 'authorize'
  | 'manifest'
  | 'outcome'
  | 'reverse'
  | 'hold-decide'
  | 'hold-release'
  | 'input'
  | 'input-decide'
  | 'input-reverse'
  | 'upload'
  | 'stop-propose'
  | 'stop-act'
  | 'hold-propose'
  | 'hold-act'
  | 'criterion'
  | 'template'
  | 'template-validate'
  | 'template-activate'
  | 'loan-cancel'
  | 'disburse'
  | 'recover'
  | 'verify'
  | 'reissue'
  | 'exclude'
  | 'calendar'
  | 'calendar-activate'
  | 'period'
  | 'pay-component'
  | 'head'
  | 'head-activate'
  | 'policy'
  | 'policy-activate'
  | 'salary-components';

/** Actions that carry an idempotency or evidence key: resending the same one after a lost answer is safe. */
const KEYED: ReadonlySet<Act> = new Set<Act>(['loan-request', 'loan-upload', 'run-decision', 'outcome', 'reverse', 'input', 'upload', 'input-decide', 'stop-propose', 'hold-propose', 'disburse']);

const NOT_INDEPENDENT: Partial<Record<Act, string>> = {
  authorize:
    'You cannot authorise this payment: the preparer of a manifest, and whoever created, calculated, reviewed or approved its payroll run, never authorise its release. Someone independent must do it.',
  outcome: 'You cannot record this payment outcome: the preparer of the manifest and whoever took part in its payroll run never record its outcomes. Someone independent must do it.',
  reverse: 'You cannot record this reversal: the preparer of the manifest and whoever took part in its payroll run never record its outcomes or reversals.',
  'run-decision': 'You cannot take this step: the creator, preparer, reviewer and approver of a payroll run are different people.',
  process: 'You cannot process this run: its creator and preparer never process it.',
  resolve: 'You cannot resolve this exception: the creator and preparer of a run never resolve its exceptions.',
  'loan-decide': 'You cannot decide this loan: whoever entered the request never decides it.',
  'hold-decide': 'You cannot decide this: its maker, and whoever took part in its payroll run, never decide it.',
  'hold-release': 'You cannot release this hold: its maker, whoever took part in its payroll run and the approver of the bank change never release it.',
  'input-decide': 'You cannot decide this batch: its preparer never decides it.',
  'input-reverse': 'You cannot reverse these lines: the preparer of a batch never reverses them.',
  'template-validate': 'You cannot validate this sample: the author of a template never validates it.',
  'template-activate': 'You cannot activate this template: its author never activates it.',
  'hold-act': 'You cannot renew this review: the maker of a hold, and whoever took part in its payroll run, never renew it.',
  'stop-act': 'You cannot revoke this salary stop: its maker never revokes it.',
  disburse: 'You cannot record this disbursement: the requester and the decider of a loan never record it.',
  'loan-cancel': 'You cannot cancel this loan: whoever entered the request never decides or cancels it.',
};

/** Refusal texts that depend on the action (the same code means something else elsewhere). */
const ACT_REFUSALS: Partial<Record<Act, Record<string, string>>> = {
  input: { NOT_PREPARER: 'Only the preparer of this batch submits or cancels it.' },
  'input-reverse': {
    RUN_IN_PROGRESS: 'A payroll run including these employees has been calculated: return it to a new draft revision first, then reverse the lines.',
    INPUT_CONSUMED: 'A processed run has used this input: a correction follows as a linked adjustment in a later period.',
    NOT_A_LINE: 'These lines are no longer all part of this batch: reload it and try again.',
    SELF_ACTION_NOT_ALLOWED: 'A selected line is your own input: another approver reverses it.',
  },
  // The report catalogue (report/service.ts): request refusals and generation failure codes.
  export: {
    UNKNOWN_REPORT: 'This export is not available.',
    SCOPE_INCOMPLETE: 'The reconciliation is a company figure: someone whose scope covers every record of the run exports it.',
    ACCESS_REVOKED: 'Your access changed after the request, so nothing was generated.',
    REPORT_UNAVAILABLE: 'This export is no longer available, so nothing was generated.',
  },
  // The shared batch import (imports/batch.ts, jobs.ts) answering the LOAN_REQUESTS_V1 upload.
  'loan-upload': {
    INVALID_HEADER: 'The file does not use the LOAN_REQUESTS_V1 header: download the template and keep exactly its header line.',
    INVALID_FILE: 'The file is not a valid UTF-8 CSV file.',
    EMPTY_FILE: 'The file has no rows below the header.',
    FILE_SIZE: 'An upload file is between 1 byte and 10 MB.',
    TOO_MANY_ROWS: 'At most 10,000 rows per upload: split the file.',
    FILE_QUARANTINED: 'The malware scan flagged the file as unsafe: nothing in it was read and no loan was requested.',
    IDEMPOTENCY_KEY_IN_USE: 'That upload key is already in use. Choose the file again and validate it.',
  },
  'stop-propose': { EVIDENCE_REQUIRED: 'Give the evidence reference and choose at least one released, verified document of the employee.' },
  'hold-propose': { EVIDENCE_REQUIRED: 'Give the evidence reference and choose at least one released, verified document of the employee.' },
  disburse: {
    EVIDENCE_REQUIRED: 'Give the evidence reference and choose the released, verified document of the disbursement.',
    EVIDENCE_KEY_REUSED: 'This evidence key already recorded another disbursement.',
  },
  criterion: { EVIDENCE_REQUIRED: 'Give the evidence reference of the criterion.' },
  calendar: { NAME_REQUIRED: 'Give the calendar name.' },
  'pay-component': { NAME_REQUIRED: 'Give the component name.' },
  period: { INVALID_CODE: 'The period code is letters, digits, dashes and underscores, starting with a letter or digit.' },
  'calendar-activate': { SELF_APPROVAL: 'You created this calendar, so someone else activates it.' },
  'head-activate': { SELF_APPROVAL: 'You wrote this head revision, so someone else activates it.' },
  'policy-activate': { SELF_APPROVAL: 'You wrote this policy, so someone else activates it.' },
  policy: { INVALID_AMOUNT: 'Unpaid units are zero to one day, with at most two decimals (an absent day more than zero).' },
  'salary-components': {
    INVALID_AMOUNT: 'Each amount is zero or more, with at most four decimals.',
    SELF_ACTION_NOT_ALLOWED: 'You cannot see or set the salary components of your own arrangement in this role; another authorised person does that.',
  },
};

/** Row problems of an input batch or upload (codes per row from the API). */
const ROW_TEXT: Record<string, string> = {
  UNKNOWN_EMPLOYEE: 'Employee not found in your scope',
  SELF_NOT_ALLOWED: 'Your own input is entered by someone else',
  NOT_EMPLOYED_IN_PERIOD: 'Not employed in the period',
  INPUT_HEAD_INVALID: 'Not an active pay component valued from inputs',
  UNKNOWN_INPUT_KIND: 'Unknown input kind',
  DATE_OUTSIDE_PERIOD: 'Effective date outside the period',
  INVALID_REFERENCE: 'Reference not valid',
  DUPLICATE_REFERENCE: 'Reference already used in this period',
  WRONG_CELL_COUNT: 'Wrong number of cells',
  BATCH_REJECTED: 'Valid, but not saved because other rows failed',
};

const REFUSALS: Record<string, string> = {
  FORBIDDEN: 'The selected role is not permitted to do this.',
  EMPLOYEE_CONTEXT_REQUIRED: 'Select your Employee role to see your own payroll documents.',
  STALE_VERSION: 'It changed since it was loaded. It has been reloaded: check it and try again.',
  INVALID_STATE: 'This is not possible in its current state. It has been reloaded.',
  SCOPE_INCOMPLETE: 'This includes employees outside your scope: someone whose scope covers all of them must handle it.',
  SELF_ACTION_NOT_ALLOWED: 'You cannot act on your own payroll record in this role; another authorised person does that.',
  TASK_CLOSED: 'This task has already been decided.',
  IDEMPOTENCY_KEY_REUSED: 'That request key was already used for something else. Send the action again.',
  INVALID_IDEMPOTENCY_KEY: 'The request key was not accepted. Send the action again.',
  REASON_REQUIRED: 'Give a reason.',
  ALREADY_CALCULATED: 'This revision has already been calculated: return it to a new revision to calculate again.',
  CALCULATION_IN_PROGRESS: 'The preparer who started this calculation continues it.',
  NO_MEMBERS: 'The run has no members to calculate.',
  SCOPE_CHANGED: 'The members of this scope changed since the preview. Preview the scope again and confirm it.',
  UNKNOWN_FILTER: 'A scope filter value does not exist.',
  NOT_PREPARER: 'Only the preparer who calculated this revision submits it for review.',
  EXCEPTIONS_UNRESOLVED: 'Blocking exceptions must be resolved, or the employees left out through a new revision, first.',
  NOT_APPROVED: 'Only an independently approved run can be processed.',
  INPUTS_CHANGED: 'Inputs were approved after the calculation: return the run to calculate a new revision.',
  SALARY_STOPS_CHANGED: 'Salary stops changed after the calculation: return the run to calculate a new revision.',
  LOAN_BALANCE_CHANGED: 'A loan changed after the calculation, so a recovery line is no longer covered: return the run to calculate a new revision.',
  PROCESSING_STARTED: 'Processing has started: the revision can only be completed.',
  RUN_LOCKED: 'A processed run cannot be cancelled; corrections follow as linked adjustments in a later run.',
  NOT_CALCULATED: 'This revision has no completed calculation.',
  NOT_A_MEMBER: 'Every employee left out must be an included member of the run.',
  NOT_RESOLVABLE: 'This exception needs corrected data and a new revision (or the employee left out), not a resolution note.',
  ALREADY_RESOLVED: 'This exception has already been resolved.',
  RUN_NOT_PROCESSED: 'This needs a processed (locked) payroll run.',
  TEMPLATE_NOT_ACTIVE: 'The bank file template is not active. Choose an activated template (or cancel this manifest and prepare it again).',
  TEST_TEMPLATE_NOT_ACTIVATABLE: 'A test-only template is never used in production.',
  CURRENCY_MISMATCH: 'The template pays in a different currency from the run.',
  MANIFEST_OPEN: 'A prepared manifest of this run is waiting for authorisation: authorise or cancel it first.',
  INVALID_SUPERSEDED_MANIFEST: 'A replacement must refer to an earlier manifest of the same run.',
  NOTHING_PAYABLE: 'Nothing is ready to pay in this run: every amount is held, reserved or already paid.',
  BANK_FILE_VALIDATION_FAILED: 'Some rows are not valid, so nothing was prepared. Correct the bank details or leave those employees out.',
  MANIFEST_STALE: 'Holds, payments or bank instructions changed since the manifest was prepared. Cancel it and prepare a new one.',
  NOT_AUTHORIZED: 'Only an authorised manifest has a payable file and payment outcomes.',
  NOT_ISSUED: 'Issue the file of the authorised manifest first.',
  FILE_INTEGRITY_FAILED: 'The stored file does not match its recorded fingerprint, so it was not given out. Report this to the administrator.',
  FILE_NOT_ISSUED: 'Before the bank file is issued, only a cancellation can be recorded.',
  INVALID_TRANSITION: 'This outcome is not possible from the line’s current payment state.',
  EVIDENCE_KEY_REUSED: 'This evidence key already recorded a different outcome.',
  EVIDENCE_KEY_REQUIRED: 'Every outcome carries its evidence key. Send it again.',
  EVIDENCE_REQUIRED: 'Give the evidence reference.',
  DUPLICATE_LINE: 'A line can appear only once per request.',
  EXCEEDS_CONFIRMED: 'A reversal cannot exceed the confirmed amount that is not reversed yet.',
  INVALID_AMOUNT: 'Enter a positive amount with no more decimals than the currency allows.',
  INTEREST_NOT_CONFIGURED: 'No approved interest rate is configured, so loans carry no interest.',
  CURRENCY_NOT_CONFIGURED: 'No active payroll calendar pays in this currency.',
  PURPOSE_REQUIRED: 'Give the purpose of the request.',
  NOT_REQUESTER: 'Only the person who made the request can withdraw it.',
  NOT_INDEPENDENT: 'Someone independent must do this.',
  RECOVERY_HEAD_REQUIRED: 'Name an active deduction head valued from inputs as the recovery head.',
  RECOVERY_HEAD_IN_USE: 'Another live loan of this employee is recovered through the same head.',
  SCHEDULE_REQUIRED: 'An approval fixes the recovery schedule: add at least one instalment.',
  SCHEDULE_NOT_BALANCED: 'The instalments must recover exactly the principal.',
  INVALID_DUE_MONTH: 'Instalments fall due one per month, in increasing months, from the current month on.',
  HOLD_CRITERION_NOT_ACTIVE: 'The hold criterion is no longer active: the proposal must be withdrawn and proposed again under the active criterion.',
  MODE_NOT_CONFIRMED: 'Confirm the stop mode you approve.',
  BANK_NOT_VERIFIED: 'A bank safety block is released only once a valid approved bank instruction is on record.',
  RUN_IN_PROGRESS: 'A payroll run of this period is already being calculated; the stop can no longer change it.',
  PERIOD_PROCESSED: 'The period’s payroll is already processed.',
  INPUT_CUTOFF_PASSED: 'The input cutoff of this period has passed: enter the input for a later period.',
  INVALID_LINES: 'Some lines are not valid, so nothing was saved.',
  UPLOAD_QUARANTINED: 'The malware scan flagged the file as unsafe: it was quarantined and not read. Nothing was saved.',
  SCAN_UNAVAILABLE: 'The file could not be scanned for malware just now, so it was not read and nothing was saved. Try again later.',
  INVALID_FILE: 'The file is not a valid UTF-8 CSV file.',
  INVALID_TEMPLATE: 'The file does not use the PAYROLL_INPUTS_V1 header.',
  EMPTY_FILE: 'The file is empty or has no lines.',
  FILE_TOO_LARGE: 'The file is larger than 10 MB.',
  TOO_MANY_ROWS: 'At most 10,000 rows per upload.',
  STOP_EXISTS: 'The employee already has a salary stop for this period.',
  NOT_A_HOLD: 'Leaving an employee out of the calculation is not a payment hold: it takes no hold criterion or release criterion.',
  RELEASE_CRITERION_REQUIRED: 'Give the release criterion: what must happen for the payment to be released.',
  TOO_MUCH_EVIDENCE: 'Attach at most 10 evidence documents.',
  INVALID_EVIDENCE: 'The evidence must be documents of the employee concerned.',
  EVIDENCE_NOT_VERIFIED: 'The evidence must be released by the malware scan and verified by an independent reviewer.',
  ONE_EVIDENCE_DOCUMENT: 'A disbursement is evidenced by exactly one released, verified document.',
  NOT_MAKER: 'Only the maker of a proposal withdraws it.',
  PARTIAL_HOLD_DISABLED: 'This criterion allows only a hold of the full unpaid net pay.',
  EFFECTIVE_DATE_IN_PAST: 'A hold takes effect today or later.',
  REVIEW_DATE_INVALID: 'The review date is outside the allowed interval: on or after the effective date and within the criterion’s longest review interval (for a renewal, counted from today).',
  AMOUNT_NOT_ALLOWED: 'A full hold takes the whole unpaid, unreserved amount: give an amount only for a partial hold.',
  NOTHING_TO_HOLD: 'Nothing of this record is unpaid and unreserved, so there is nothing to hold.',
  HOLD_EXCEEDS_UNRESERVED: 'A hold is at most the unpaid, unreserved amount of the record.',
  INVALID_CODE: 'The code is not valid: capital letters, digits and underscores, starting with a letter.',
  NOT_A_HOLD_CRITERION: 'This situation is never a salary hold criterion (a missing timesheet, an input discrepancy, a separation or a bank problem).',
  SELF_APPROVAL: 'You wrote this criterion, so someone else activates it.',
  APPLICABILITY_REQUIRED: 'Describe when the criterion applies.',
  VALIDATION_REQUIRED: 'Give the validation reference.',
  INVALID_CURRENCY: 'The currency is a three-letter ISO code.',
  NAME_REQUIRED: 'Give the template name.',
  BANK_SPECIFICATION_REQUIRED: 'Give the reference of the bank’s specification.',
  SAMPLE_INVALID: 'The sample cannot be produced under this field mapping: create a corrected version.',
  SAMPLE_MISMATCH: 'The sample you checked is not the current sample of this template version. Generate it again and check it.',
  SAMPLE_NOT_VALIDATED: 'A template is activated only after an independent sample validation.',
  VALIDATION_REFERENCE_REQUIRED: 'Give the validation reference.',
  NOT_CONFIGURED: 'Not configured.',
  DISBURSEMENT_IN_FUTURE: 'A disbursement is recorded once it has happened: the date cannot be in the future.',
  // Payroll configuration (FR-028 to FR-030, FR-032; I-28)
  INVALID_DATE: 'A date is missing or not valid.',
  CALENDAR_EXISTS: 'A payroll calendar with this code already exists.',
  NO_PERIODS: 'Add the calendar’s periods before it is activated.',
  SERVICE_PERIOD_NOT_A_MONTH: 'A service period is one whole calendar month, from its first to its last day (DF05 proration uses the days of that month).',
  CUTOFF_AFTER_PAYMENT: 'The input cutoff must be on or before the payment date.',
  INVALID_FINANCIAL_YEAR: 'The financial year label is letters, digits, dashes, slashes and underscores.',
  PERIOD_EXISTS: 'The calendar already has this period code, or another of its periods covers these dates.',
  PERIOD_IN_USE: 'This period is fixed: payroll runs, inputs or salary stops already use it, so its dates can no longer change.',
  CALENDAR_NOT_ACTIVE: 'The payroll calendar of this period is not active.',
  COMPONENT_EXISTS: 'A pay component with this code already exists.',
  UNKNOWN_COMPONENT: 'No active pay component has this code.',
  DEFINITION_INCOMPLETE: 'A head in use needs its type, calculation basis, rounding, tax treatment and display sequence.',
  KIND_MISMATCH: 'The head type does not match the pay component: deduction heads use deduction components; earnings, reimbursements and employer contributions use earning components.',
  UNKNOWN_TAX_TREATMENT: 'The tax treatment is not an active value of the company’s payroll tax treatment list.',
  RULE_PACK_REQUIRED: 'A rule-pack head names the rule pack that will calculate it (capital letters, digits and underscores).',
  BASE_NOT_ALLOWED: 'Only a rule-pack head names a rule pack and base heads.',
  DISCONTINUATION_HAS_NO_DEFINITION: 'A revision that discontinues a head carries no definition: leave the type, basis, tax treatment and base heads empty.',
  MISSING_DEFINITION: 'A rule-pack head names a base head that is not defined and in use on that date (a missing definition), so it cannot be activated.',
  CYCLIC_DEFINITION: 'The head would depend on itself through its base heads (a cyclic definition), so it cannot be saved or activated.',
  COMPONENT_INACTIVE: 'The pay component is not active.',
  UNITS_REQUIRED: 'State the unpaid part of a reviewed absent day and of a half day.',
  UNITS_NOT_ALLOWED: 'Unpaid units apply only when reviewed attendance is valued.',
  COMPONENTS_ALREADY_SET: 'The components of this arrangement are already set. They are set once: a change is a new salary arrangement through the salary master.',
  COMPONENTS_REQUIRED: 'Give at least one component.',
  DUPLICATE_COMPONENT: 'Each pay component appears once.',
  COMPONENT_BASIS_NOT_MONTHLY: 'A fixed head needs a monthly salary component amount: an annual amount under a fixed head blocks the employee’s calculation.',
  RULE_PACK_NOT_CONFIGURED: 'A rule-pack head applies and no rule pack is configured, so the employee is blocked until the head is left out through a new revision.',
};

/** Where a configuration refusal points (line, component, base head, date), as the API names it. */
function configDetail(error: ApiError): string {
  if (!['MISSING_DEFINITION', 'CYCLIC_DEFINITION', 'UNKNOWN_COMPONENT', 'DUPLICATE_COMPONENT'].includes(error.code)) return '';
  const d = (error.details ?? {}) as { componentCode?: string | null; baseComponentCode?: string | null; date?: string | null; line?: number | null };
  const parts = [
    d.line ? `line ${d.line}` : null,
    d.componentCode ? `pay component ${d.componentCode}` : null,
    d.baseComponentCode ? `base ${d.baseComponentCode}` : null,
    d.date ? `on ${formatDate(d.date)}` : null,
  ].filter((x): x is string => x !== null);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

const SELF_INCLUDED: Partial<Record<Act, string>> = {
  prepare: 'Your own salary would be in this manifest, so someone else must prepare it.',
  authorize: 'Your own salary is in this manifest, so someone else must authorise it.',
};

function refusalText(error: unknown, act: Act): string | null {
  if (!error) return null;
  if (!(error instanceof ApiError)) {
    return KEYED.has(act)
      ? 'No answer came back, so it may or may not have been recorded. Send the same again: it carries the same key and is never applied twice.'
      : 'No answer came back, so it may or may not have been done. Reload and check before trying again.';
  }
  const specific = ACT_REFUSALS[act]?.[error.code];
  if (specific) return specific;
  // The definition check names the setting that is wrong in plain words.
  if (error.code === 'INVALID_TEMPLATE_DEFINITION') return `The field mapping is not valid: ${error.message}.`;
  if (error.code === 'NOT_INDEPENDENT') return NOT_INDEPENDENT[act] ?? REFUSALS.NOT_INDEPENDENT!;
  if (error.code === 'SELF_INCLUDED') return SELF_INCLUDED[act] ?? 'Your own salary is in this manifest, so someone else must handle it.';
  if (error.code === 'SELF_ACTION_NOT_ALLOWED' && (act === 'outcome' || act === 'reverse')) return 'You cannot record the outcome of your own payment.';
  if (error.status === 404 || error.code === 'NOT_FOUND') {
    return act === 'own' || act === 'download' ? 'It is not among your own records.' : 'It is not available in the selected role’s scope, or it no longer exists.';
  }
  const known = REFUSALS[error.code];
  const where = configDetail(error);
  if (known) return where && known.endsWith('.') ? `${known.slice(0, -1)}${where}.` : `${known}${where}`;
  return error.status === 403 ? REFUSALS.FORBIDDEN! : null;
}

function Problem({ error, act }: { error: unknown; act: Act }) {
  if (!error) return null;
  const text = refusalText(error, act);
  const e = error instanceof ApiError ? error : null;
  const details = (e?.details ?? {}) as { errors?: (BankRowError & { row?: number })[]; exceptions?: { code: string; n: number }[]; expected?: string[] };
  return (
    <div role="alert" className="error">
      {text ?? e?.message ?? 'Something went wrong.'}
      {Array.isArray(details.errors) && details.errors.length > 0 && (
        <ul>
          {details.errors.map((x, i) => (
            <li key={i}>
              {x.employeeCode ? `${x.employeeCode}: ` : ''}
              {label(ROW_TEXT, x.code)}
              {x.lineSequence ? ` (row ${x.lineSequence})` : x.row ? ` (row ${x.row})` : ''}
            </li>
          ))}
        </ul>
      )}
      {Array.isArray(details.expected) && <p style={FLUSH}>{`Expected header: ${details.expected.join(',')}`}</p>}
      {Array.isArray(details.exceptions) && details.exceptions.length > 0 && (
        <ul>
          {details.exceptions.map((x) => (
            <li key={x.code}>
              {readable(x.code)}: {x.n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A small form that sends one reason; it clears after success and keeps the text after a failure. */
function ReasonForm({
  name,
  field,
  button,
  busy,
  disabled = false,
  danger = false,
  onSend,
}: {
  name: string;
  field: string;
  button: string;
  busy: boolean;
  disabled?: boolean;
  danger?: boolean;
  onSend: (reason: string) => Promise<unknown>;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = reason.trim();
    if (!text) {
      setMissing(true);
      return;
    }
    setMissing(false);
    onSend(text).then(
      () => setReason(''),
      () => undefined,
    );
  };
  return (
    <form onSubmit={submit} aria-label={name} className="stack" style={{ marginTop: '0.5rem' }}>
      <label htmlFor={id}>
        {field}
        <textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
      </label>
      {missing && (
        <p role="alert" className="error">
          Give a reason first.
        </p>
      )}
      <div className="row">
        <button type="submit" className={danger ? 'danger' : 'secondary'} disabled={busy || disabled}>
          {button}
        </button>
      </div>
    </form>
  );
}

// =========================================================================================================
// My ESS TN06: own issued payslips
// =========================================================================================================

function OwnOnly({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Section title={title}>
      <p className="hint">{children}</p>
    </Section>
  );
}

function MyPayslipsPanel() {
  const { me, can } = useSession();
  if (!me) return <p className="hint">Loading your role…</p>;
  if (!ownContext(me)) return <OwnOnly title="My payslips">Your own payslips are shown in your Employee role. Switch to it to see them.</OwnOnly>;
  if (!can(OWN_PAYSLIP)) return <OwnOnly title="My payslips">Your Employee role does not include payslips; contact HR.</OwnOnly>;
  return (
    <>
      <OwnPayslipList />
      <OwnHoldStatus />
    </>
  );
}

/** GET /v1/me/payroll-holds (H7): the status of the employee's own held salary; never a reason or an amount. */
interface OwnHold {
  id: string;
  periodCode: string;
  state: 'ON_HOLD' | 'RELEASED';
  heldFrom: string;
  releasedAt: string | null;
}

/**
 * H7 "employee sees own permitted reason/status" (TN06): the period, ON_HOLD or RELEASED and the dates. Which reason
 * text an employee may see is an owner decision, so no reason is shown; the held amount is on the payslip above.
 */
function OwnHoldStatus() {
  const keys = useKeys();
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: [...keys.ownHolds, page],
    queryFn: () => api<{ items: OwnHold[]; total?: number }>(`/v1/me/payroll-holds?${pageParams(page)}`),
    retry: retryTransient,
  });
  const data = list.data;
  return (
    <Section title="My salary payment holds">
      <p className="hint">A hold withholds payment of earned salary; it never reduces what you earned. Only the status and dates are shown here.</p>
      {list.isPending && <p className="hint">Loading your salary payment holds…</p>}
      {list.error && <Problem error={list.error} act="own" />}
      {data && data.items.length === 0 && <Empty>No payment of your salary is or was on hold.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="My salary payment holds">
            <thead>
              <tr>
                <th>Period</th>
                <th>Status</th>
                <th>Held from</th>
                <th>Released</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((h) => (
                <tr key={h.id}>
                  <td>{h.periodCode}</td>
                  <td>{h.state === 'RELEASED' ? <Badge tone="good">Released for payment</Badge> : <Badge tone="warn">On hold</Badge>}</td>
                  <td>{formatDate(h.heldFrom)}</td>
                  <td>{h.releasedAt ? formatDate(h.releasedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={data.total ?? data.items.length} onPage={setPage} label="Salary hold pages" noun="hold" />}
    </Section>
  );
}

function OwnPayslipList() {
  const keys = useKeys();
  const list = useQuery({ queryKey: keys.ownPayslips, queryFn: () => api<OwnPayslips>('/v1/me/payslips'), retry: retryTransient });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const fetchFile = async (p: OwnPayslip) => {
    if (busyId) return;
    setBusyId(p.id);
    setFailure(null);
    try {
      await download(`/v1/me/payslips/${encodeURIComponent(p.id)}/file`);
    } catch (e) {
      setFailure(e);
    } finally {
      setBusyId(null);
    }
  };
  const data = list.data;
  return (
    <Section title="My payslips">
      <p role="note" className="hint">
        Publication of a payslip does not mean the salary has been paid. Earned is your frozen net pay; held is withheld under an approved hold; reserved is in a bank file being paid;
        paid is only what confirmed payment evidence shows.
      </p>
      {list.isPending && <p className="hint">Loading your payslips…</p>}
      {list.error && <Problem error={list.error} act="own" />}
      {data && data.items.length === 0 && <Empty>No payslip has been issued to you yet.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="My payslips">
            <thead>
              <tr>
                <th>Period</th>
                <th>Version</th>
                <th>Status</th>
                <th>Issued</th>
                <th>Earned</th>
                <th>Held</th>
                <th>Reserved</th>
                <th>Paid (confirmed)</th>
                <th>File</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id}>
                  <td>{p.periodCode}</td>
                  <td>{p.version}</td>
                  <td>
                    {p.publicationState === 'SUPERSEDED' ? (
                      <Badge tone="warn">{`Replaced by a later version${p.supersededAt ? ` on ${formatDate(p.supersededAt)}` : ''}`}</Badge>
                    ) : (
                      <Badge>Current version</Badge>
                    )}
                  </td>
                  <td>{formatDate(p.issuedAt)}</td>
                  {p.payment ? (
                    <>
                      <td>{money(p.payment.earned)}</td>
                      <td>{money(p.payment.held)}</td>
                      <td>{money(p.payment.reserved)}</td>
                      <td>{money(p.payment.paid)}</td>
                    </>
                  ) : (
                    <td colSpan={4}>See the current version</td>
                  )}
                  <td>
                    <button type="button" className="secondary" disabled={busyId !== null} onClick={() => void fetchFile(p)} aria-label={`Download payslip ${p.periodCode} version ${p.version}`}>
                      {busyId === p.id ? 'Downloading…' : 'Download'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {failure !== null && <Problem error={failure} act="download" />}
      {data?.form16?.status === 'NOT_CONFIGURED' && <p className="hint">Form 16 is not available: no statutory Form 16 template is configured yet.</p>}
    </Section>
  );
}

// =========================================================================================================
// My ESS TN15: own loans and advances
// =========================================================================================================

function MyLoansPanel() {
  const { me, can } = useSession();
  if (!me) return <p className="hint">Loading your role…</p>;
  if (!ownContext(me)) return <OwnOnly title="My loans and advances">Your own loans are shown in your Employee role. Switch to it to see or request them.</OwnOnly>;
  if (!can(OWN_LOAN_READ) && !can(OWN_LOAN_REQUEST)) return <OwnOnly title="My loans and advances">Your Employee role does not include loans; contact HR.</OwnOnly>;
  return (
    <div className="stack">
      {can(OWN_LOAN_READ) && <OwnLoanList canWithdraw={can(OWN_LOAN_REQUEST)} />}
      {can(OWN_LOAN_REQUEST) && <LoanRequestForm />}
    </div>
  );
}

function OwnLoanList({ canWithdraw }: { canWithdraw: boolean }) {
  const keys = useKeys();
  const list = useQuery({ queryKey: keys.ownLoans, queryFn: () => api<OwnLoans>('/v1/me/loans'), retry: retryTransient });
  const [note, setNote] = useState<string | null>(null);
  const data = list.data;
  return (
    <Section title="My loans and advances">
      {list.isPending && <p className="hint">Loading your loans…</p>}
      {list.error && <Problem error={list.error} act="own" />}
      {data?.interest?.status === 'NOT_CONFIGURED' && <p className="hint">Loans carry no interest: no approved interest rate is configured.</p>}
      {data?.earlySettlement?.status === 'NOT_CONFIGURED' && <p className="hint">Early settlement is not available: no settlement rule is configured.</p>}
      {note && (
        <p role="status" className="ok">
          {note}
        </p>
      )}
      {data && data.items.length === 0 && <Empty>You have no loans or advances.</Empty>}
      {data && data.items.length > 0 && (
        <ul style={PLAIN_LIST} className="stack">
          {data.items.map((l) => (
            <OwnLoanItem key={l.id} loan={l} canWithdraw={canWithdraw} onWithdrawn={() => setNote('Your request was withdrawn.')} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function ScheduleTables({ loan, name }: { loan: { currencyCode: string; installments?: Installment[]; recoveries?: LoanRecovery[] }; name: string }) {
  return (
    <>
      {loan.installments && loan.installments.length > 0 ? (
        <div style={SCROLL}>
          <table aria-label={`Recovery schedule of ${name}`}>
            <thead>
              <tr>
                <th>Instalment</th>
                <th>Due month</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {loan.installments.map((i) => (
                <tr key={i.sequence}>
                  <td>{i.sequence}</td>
                  <td>{i.dueMonth}</td>
                  <td>{money(i.amount, loan.currencyCode)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="hint">No recovery schedule yet: it is fixed when the request is approved.</p>
      )}
      {loan.recoveries && loan.recoveries.length > 0 && (
        <div style={SCROLL}>
          <table aria-label={`Recoveries of ${name}`}>
            <thead>
              <tr>
                <th>Payroll period</th>
                <th>Recovered</th>
                <th>Recognised</th>
              </tr>
            </thead>
            <tbody>
              {loan.recoveries.map((r) => (
                <tr key={r.id}>
                  <td>{r.periodCode}</td>
                  <td>{money(r.amount, loan.currencyCode)}</td>
                  <td>{formatDate(r.recognisedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function OwnLoanItem({ loan, canWithdraw, onWithdrawn }: { loan: OwnLoan; canWithdraw: boolean; onWithdrawn: () => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const titleId = useId();
  const name = `${label(LOAN_KIND, loan.loanKind)} requested ${formatDate(loan.requestedAt)}`;
  const withdraw = useMutation({
    mutationFn: (reason: string) => api<OwnLoan>(`/v1/me/loans/${encodeURIComponent(loan.id)}/withdraw`, { body: { reason, expectedVersion: loan.version } }),
    onSuccess: () => onWithdrawn(),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.ownLoans }),
  });
  // Only the requester withdraws, and only while undecided: an own request is one made in the Employee context.
  const withdrawable = canWithdraw && loan.state === 'REQUESTED' && loan.requestOrigin === 'EMPLOYEE';
  return (
    <li aria-labelledby={titleId} className="card">
      <h3 id={titleId} style={H3}>
        {name}
      </h3>
      <dl className="kv">
        <Fact term="State">
          <Status map={LOAN_STATE} code={loan.state} />
        </Fact>
        <Fact term="Principal">{money(loan.principal, loan.currencyCode)}</Fact>
        <Fact term="Recovered">{money(loan.recovered, loan.currencyCode)}</Fact>
        {/[1-9]/.test(loan.awaitingRecognition ?? '') && <Fact term="Deducted, not yet recognised">{money(loan.awaitingRecognition!, loan.currencyCode)}</Fact>}
        <Fact term="Outstanding balance">{money(loan.outstanding, loan.currencyCode)}</Fact>
        <Fact term="Purpose">{loan.purpose}</Fact>
        <Fact term="Requested by">{loan.requestOrigin === 'EMPLOYEE' ? 'You' : 'HR, for you'}</Fact>
        {loan.decidedAt && <Fact term="Decided">{formatDate(loan.decidedAt)}</Fact>}
        {loan.decisionReason && <Fact term="Decision reason">{loan.decisionReason}</Fact>}
        {loan.disbursementDate && <Fact term="Disbursed">{formatDate(loan.disbursementDate)}</Fact>}
        {loan.closedAt && <Fact term="Closed">{formatDate(loan.closedAt)}</Fact>}
      </dl>
      <ScheduleTables loan={loan} name={name} />
      {withdrawable && (
        <ReasonForm
          name={`Withdraw ${name}`}
          field="Reason for withdrawing"
          button={withdraw.isPending ? 'Withdrawing…' : 'Withdraw the request'}
          busy={withdraw.isPending}
          danger
          onSend={(reason) => withdraw.mutateAsync(reason)}
        />
      )}
      <Problem error={withdraw.error} act="loan-withdraw" />
    </li>
  );
}

function LoanRequestForm() {
  const keys = useKeys();
  const qc = useQueryClient();
  const intent = useIntentKey('own-loan');
  const [kind, setKind] = useState('LOAN');
  const [currency, setCurrency] = useState('');
  const [principal, setPrincipal] = useState('');
  const [purpose, setPurpose] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: (body: { loanKind: string; currencyCode: string; principal: string; purpose: string; idempotencyKey: string }) =>
      api<OwnLoan & { replayed: boolean }>('/v1/me/loans', { body }),
    onSettled: (_data, error) => {
      intent.settle(error);
      void qc.invalidateQueries({ queryKey: keys.ownLoans });
    },
    onSuccess: (result) => {
      setKind('LOAN');
      setCurrency('');
      setPrincipal('');
      setPurpose('');
      setDone(result.replayed ? 'This request had already been received; nothing was sent twice.' : 'Your request was sent for an independent decision.');
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (send.isPending) return;
    setDone(null);
    const cur = currency.trim().toUpperCase();
    const amt = principal.trim();
    const text = purpose.trim();
    if (!/^[A-Z]{3}$/.test(cur)) return setProblem('Enter the currency as its three-letter code.');
    if (!MONEY.test(amt) || /^0+(\.0+)?$/.test(amt)) return setProblem('Enter the amount as a positive number, for example 25000.00.');
    if (!text) return setProblem('Give the purpose of the request.');
    setProblem(null);
    send.reset();
    const content = { loanKind: kind, currencyCode: cur, principal: amt, purpose: text };
    send.mutate({ ...content, idempotencyKey: intent.key(JSON.stringify(content)) });
  };
  return (
    <Section title="Request a loan or advance">
      <p className="hint">An independent HR administrator decides the request and fixes the recovery schedule. No interest is charged.</p>
      <form onSubmit={submit} aria-label="Request a loan or advance" className="grid-form">
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="LOAN">Loan</option>
            <option value="ADVANCE">Salary advance</option>
          </select>
        </label>
        <label>
          Currency (three-letter code)
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} autoComplete="off" />
        </label>
        <label>
          Amount
          <input value={principal} onChange={(e) => setPrincipal(e.target.value)} inputMode="decimal" autoComplete="off" />
        </label>
        <label className="wide">
          Purpose
          <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
        </label>
        <div className="wide row">
          <button type="submit" disabled={send.isPending}>
            {send.isPending ? 'Sending…' : 'Send the request'}
          </button>
        </div>
      </form>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <Problem error={send.error} act="loan-request" />
      {done && (
        <p role="status" className="ok">
          {done}
        </p>
      )}
    </Section>
  );
}

// =========================================================================================================
// Payroll runs: list and start
// =========================================================================================================

const RUN_FILTERS = ['DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED', 'PROCESSED_LOCKED', 'RETURNED', 'CANCELLED'];

function RunsScreen() {
  const { can } = useSession();
  if (!canReadRuns(can)) {
    return (
      <Section title="Payroll runs">
        <Empty>The selected role cannot see payroll runs.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      <RunList />
      {can(RUN_PREPARE) && <NewRun />}
    </div>
  );
}

function RunList() {
  const keys = useKeys();
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  // FR-056: one page at a time; `total` counts every run revision the selected role may see.
  const runs = useQuery({
    queryKey: [...keys.runs(state), page],
    queryFn: () => api<{ items: RunRow[]; total?: number }>(`/v1/payroll/runs?${state ? `state=${encodeURIComponent(state)}&` : ''}${pageParams(page)}`),
    retry: retryTransient,
  });
  return (
    <Section
      title="Payroll runs"
      actions={
        <label className="inline">
          State
          <select
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {RUN_FILTERS.map((s) => (
              <option key={s} value={s}>
                {label(RUN_STATE, s)}
              </option>
            ))}
          </select>
        </label>
      }
    >
      <p className="hint">
        Each revision of a run is listed separately. Payment is not tracked on a run: it comes only from the outcomes recorded on its bank manifests. <Link to={PATHS.decisions}>Run decisions</Link>
      </p>
      {runs.isPending && <p className="hint">Loading payroll runs…</p>}
      {runs.error && <Problem error={runs.error} act="read" />}
      {runs.data && runs.data.items.length === 0 && <Empty>No payroll runs yet.</Empty>}
      {runs.data && runs.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Payroll runs">
            <thead>
              <tr>
                <th>Period</th>
                <th>Calendar</th>
                <th>Revision</th>
                <th>State</th>
                <th>Members</th>
                <th>Unresolved blocking exceptions</th>
                <th>Created</th>
                <th>Processed</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={PATHS.run(r.id)}>{`${r.periodCode} revision ${r.revision}`}</Link>
                  </td>
                  <td>{r.calendarCode}</td>
                  <td>{r.revision}</td>
                  <td>
                    <Status map={RUN_STATE} code={r.state} />
                  </td>
                  <td>{r.memberCount}</td>
                  <td>{r.unresolvedExceptions}</td>
                  <td>{formatDate(r.createdAt)}</td>
                  <td>{formatDate(r.processedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {runs.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={runs.data.total ?? runs.data.items.length} onPage={setPage} label="Payroll run pages" noun="run revision" />}
    </Section>
  );
}

function NewRun() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const calendars = useQuery({
    queryKey: keys.calendars,
    queryFn: () => api<{ items: Calendar[] }>('/v1/payroll/calendars'),
    enabled: can(CONFIG_READ),
    retry: retryTransient,
  });
  const [calendarId, setCalendarId] = useState('');
  const [periodId, setPeriodId] = useState('');
  const [preview, setPreview] = useState<ScopePreview | null>(null);
  const previewing = useMutation({
    mutationFn: (pid: string) => api<ScopePreview>('/v1/payroll/runs/preview', { body: { periodId: pid } }),
    onSuccess: (p) => setPreview(p),
  });
  const create = useMutation({
    mutationFn: (p: ScopePreview) => api<RunDetail>('/v1/payroll/runs', { body: { periodId: p.periodId, scopeToken: p.scopeToken } }),
    onSuccess: (run) => {
      void qc.invalidateQueries({ queryKey: keys.runsAll });
      navigate(PATHS.run(run.id));
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'SCOPE_CHANGED') setPreview(null);
    },
  });
  if (!can(CONFIG_READ)) {
    return (
      <Section title="Start a payroll run">
        <p className="hint">The selected role cannot list payroll calendars, so a run cannot be started here.</p>
      </Section>
    );
  }
  const active = (calendars.data?.items ?? []).filter((c) => c.state === 'ACTIVE');
  const calendar = active.find((c) => c.id === calendarId);
  const busy = previewing.isPending || create.isPending;
  return (
    <Section title="Start a payroll run">
      <p className="hint">Preview who the period’s run includes, then confirm exactly that scope. The run covers the whole company scope of the selected role.</p>
      {calendars.error && <Problem error={calendars.error} act="read" />}
      <form
        aria-label="Preview a payroll run"
        className="grid-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!periodId || busy) return;
          setPreview(null);
          create.reset();
          previewing.mutate(periodId);
        }}
      >
        <label>
          Payroll calendar
          <select
            value={calendarId}
            onChange={(e) => {
              setCalendarId(e.target.value);
              setPeriodId('');
              setPreview(null);
            }}
          >
            <option value="">Choose a calendar</option>
            {active.map((c) => (
              <option key={c.id} value={c.id}>
                {`${c.code} · ${c.name} (${c.currencyCode})`}
              </option>
            ))}
          </select>
        </label>
        <label>
          Period
          <select
            value={periodId}
            onChange={(e) => {
              setPeriodId(e.target.value);
              setPreview(null);
            }}
            disabled={!calendar}
          >
            <option value="">Choose a period</option>
            {(calendar?.periods ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {`${p.periodCode} (${formatDate(p.serviceStart)} to ${formatDate(p.serviceEnd)})`}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <button type="submit" className="secondary" disabled={!periodId || busy}>
            {previewing.isPending ? 'Previewing…' : 'Preview the members'}
          </button>
        </div>
      </form>
      {calendars.data && active.length === 0 && <p className="hint">No payroll calendar is active yet.</p>}
      <Problem error={previewing.error} act="run-start" />
      {preview && (
        <div aria-label="Run scope preview" role="region">
          <h3 style={H3}>{`Scope of ${preview.periodCode}`}</h3>
          <p style={FLUSH}>
            {preview.memberCount} {preview.memberCount === 1 ? 'member' : 'members'} included; {preview.notIncludedCount} not included.
          </p>
          {Object.keys(preview.notIncludedByReason).length > 0 && (
            <ul>
              {Object.entries(preview.notIncludedByReason).map(([reason, n]) => (
                <li key={reason}>{`${readable(reason)}: ${n}`}</li>
              ))}
            </ul>
          )}
          {preview.members.length > 0 && (
            <p className="hint">
              {preview.members.map((m) => `${m.employeeCode} ${m.displayName}`).join(', ')}
              {preview.membersTruncated ? ' and more' : ''}
            </p>
          )}
          <button type="button" disabled={busy || preview.memberCount === 0} onClick={() => create.mutate(preview)}>
            {create.isPending ? 'Creating…' : 'Create the run for this scope'}
          </button>
        </div>
      )}
      <Problem error={create.error} act="run-start" />
    </Section>
  );
}

// =========================================================================================================
// Payroll run detail
// =========================================================================================================

function involvement(run: RunDetail, userId: string | undefined): string[] {
  if (!userId) return [];
  const parts: string[] = [];
  if (run.createdBy === userId) parts.push('created');
  if (run.preparedBy === userId) parts.push('calculated');
  if (run.reviewedBy === userId) parts.push('reviewed');
  if (run.approvedBy === userId) parts.push('approved');
  return parts;
}

function RunScreen() {
  const { can } = useSession();
  const { id = '' } = useParams();
  if (!canReadRuns(can)) {
    return (
      <Section title="Payroll run">
        <Empty>The selected role cannot see payroll runs.</Empty>
      </Section>
    );
  }
  return <RunView key={id} id={id} />;
}

function RunView({ id }: { id: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const run = useQuery({ queryKey: keys.run(id), queryFn: () => api<RunDetail>(`/v1/payroll/runs/${encodeURIComponent(id)}`), retry: retryTransient });
  const r = run.data;
  if (run.isPending) return <p className="hint">Loading the payroll run…</p>;
  if (!r) {
    return (
      <Section title="Payroll run">
        <Problem error={run.error} act="read" />
        <Link to={PATHS.runs}>Back to payroll runs</Link>
      </Section>
    );
  }
  const mine = involvement(r, me?.userId);
  return (
    <div className="stack">
      <Section title={`Payroll run ${r.period.periodCode} · revision ${r.revision}`} actions={<Link to={PATHS.runs}>All runs</Link>}>
        <dl className="kv">
          <Fact term="State">
            <Status map={RUN_STATE} code={r.state} />
          </Fact>
          <Fact term="Calendar">{r.calendarCode}</Fact>
          <Fact term="Financial year">{r.period.financialYear}</Fact>
          <Fact term="Service period">{`${formatDate(r.period.serviceStart)} to ${formatDate(r.period.serviceEnd)}`}</Fact>
          <Fact term="Payment date">{formatDate(r.period.paymentDate)}</Fact>
          <Fact term="Members">{`${r.members.included} included, ${r.members.excluded} left out`}</Fact>
          <Fact term="Exceptions">{`${r.exceptions.unresolved} unresolved of ${r.exceptions.blocking} blocking; ${r.exceptions.warnings} warnings`}</Fact>
          <Fact term="Calculation">
            {r.progress.calculation.complete
              ? `Complete: ${r.progress.calculation.calculated} records`
              : r.progress.calculation.started
                ? `In progress: ${r.progress.calculation.calculated} of ${r.progress.calculation.members}`
                : 'Not started'}
          </Fact>
          <Fact term="Processing">
            {r.progress.processing.complete
              ? `Locked: ${r.progress.processing.frozen} records frozen`
              : r.progress.processing.started
                ? `In progress: ${r.progress.processing.frozen} of ${r.progress.processing.records} frozen`
                : 'Not started'}
          </Fact>
          {Object.keys(r.records).length > 0 && (
            <Fact term="Records">
              {Object.entries(r.records)
                .map(([k, n]) => `${readable(k)}: ${n}`)
                .join('; ')}
            </Fact>
          )}
          <Fact term="Submitted">{formatDate(r.submittedAt)}</Fact>
          <Fact term="Reviewed">{formatDate(r.reviewedAt)}</Fact>
          <Fact term="Approved">{formatDate(r.approvedAt)}</Fact>
          <Fact term="Processed">{formatDate(r.processedAt)}</Fact>
          {r.lockVersion !== null && <Fact term="Lock version">{r.lockVersion}</Fact>}
          {r.closeReason && <Fact term="Close reason">{r.closeReason}</Fact>}
        </dl>
        {r.paymentStatus === 'NOT_TRACKED_HERE' && <p className="hint">Payment is not tracked on the run: it comes only from the outcomes recorded on its bank manifests.</p>}
        {r.supersedesRunId && (
          <p style={FLUSH}>
            <Link to={PATHS.run(r.supersedesRunId)}>Previous revision</Link>
          </p>
        )}
        {r.successorRunId && (
          <p style={FLUSH}>
            <Link to={PATHS.run(r.successorRunId)}>Next revision</Link>
          </p>
        )}
        {can(REPORT_READ) && (
          <p style={FLUSH}>
            <Link to={PATHS.reports(r.id)}>Reports of this run</Link>
          </p>
        )}
        {mine.length > 0 && (
          <p role="note" className="hint">
            {`You ${mine.join(' and ')} this revision, so ${
              mine.includes('created') || mine.includes('calculated')
                ? 'you do not review, approve or process it'
                : mine.includes('reviewed')
                  ? 'you do not approve it or give its covering approvals'
                  : 'you do not give its covering approvals'
            }, and you never authorise its bank release or record its payment outcomes.`}
          </p>
        )}
        {r.decisions.length > 0 && (
          <>
            <h3 style={H3}>Decisions</h3>
            <ul>
              {r.decisions.map((d, i) => (
                <li key={i}>{`${readable(d.action)}: ${readable(d.decision)} on ${formatDate(d.decidedAt)}`}</li>
              ))}
            </ul>
          </>
        )}
        <RunActions run={r} />
      </Section>
      {r.totals && <RunTotalsSection run={r} totals={r.totals} />}
      {can(RUN_READ_AMOUNT) && <RunRecords run={r} />}
      {can(RUN_READ_AMOUNT) && <RunComponentsSection run={r} />}
      {r.state === 'PROCESSED_LOCKED' && (can(OUTPUT_READ) || can(OUTPUT_PUBLISH)) && <RunPayslips run={r} />}
      {r.state === 'PROCESSED_LOCKED' && can(BANK_READ) && <RunBank run={r} />}
      {r.state === 'PROCESSED_LOCKED' && can(LOAN_RECOVER) && <LoanRecoveries run={r} />}
      {can(RUN_READ_AMOUNT) && r.progress.calculation.complete && <RunVerify key={`${r.id}:${r.version}`} run={r} />}
    </div>
  );
}

type RunAction = 'calculate' | 'submit' | 'process' | 'revise' | 'return' | 'cancel';

function RunActions({ run }: { run: RunDetail }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [note, setNote] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: ({ action, body }: { action: RunAction; body: Record<string, unknown> }) =>
      api<RunDetail & { replayed?: boolean }>(`/v1/payroll/runs/${encodeURIComponent(run.id)}/${action}`, { body: { ...body, expectedVersion: run.version } }),
    onSuccess: (result, { action }) => {
      if (action === 'calculate') {
        const c = result.progress.calculation;
        setNote(c.complete ? `Calculated: ${c.calculated} records. Check the exceptions and totals, then submit it for review.` : `Calculation continues: ${c.calculated} of ${c.members} members calculated. Continue the calculation.`);
      } else if (action === 'process') {
        const p = result.progress.processing;
        setNote(
          result.state === 'PROCESSED_LOCKED'
            ? 'Processed and locked. Payslips and bank files can now be prepared; nothing has been paid.'
            : `Processing continues: ${p.frozen} of ${p.records} records frozen. Continue processing.`,
        );
      } else if (action === 'submit') setNote('Submitted for an independent review.');
      else if (action === 'cancel') setNote('This revision was cancelled.');
      else {
        setNote(null);
        navigate(PATHS.run(result.id));
      }
    },
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: keys.runAll }), qc.invalidateQueries({ queryKey: keys.runsAll })]),
  });
  const send = (action: RunAction, body: Record<string, unknown> = {}) => {
    if (act.isPending) return Promise.reject(new Error('busy'));
    setNote(null);
    return act.mutateAsync({ action, body });
  };
  const userId = me?.userId;
  const busy = act.isPending;
  const live = ['DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED'].includes(run.state) && !run.processingStartedAt;
  const calcStarted = run.progress.calculation.started;
  const notCalculator = run.preparedBy !== null && run.preparedBy !== userId;
  const runActor = run.createdBy === userId || run.preparedBy === userId;
  const controls: ReactNode[] = [];
  if (run.state === 'DRAFT' && can(RUN_PREPARE)) {
    controls.push(
      <div key="calculate">
        <button type="button" disabled={busy || (calcStarted && notCalculator)} onClick={() => void send('calculate').catch(() => undefined)}>
          {calcStarted ? 'Continue the calculation' : 'Calculate'}
        </button>
        {calcStarted && notCalculator && <p className="hint">The preparer who started this calculation continues it.</p>}
      </div>,
    );
    if (!calcStarted) controls.push(<MemberExclusion key="exclude" run={run} />);
  }
  if (run.state === 'CALCULATED' && can(RUN_PREPARE)) {
    controls.push(
      <div key="submit">
        <button type="button" disabled={busy || notCalculator} onClick={() => void send('submit').catch(() => undefined)}>
          Submit for review
        </button>
        {notCalculator && <p className="hint">Only the preparer who calculated this revision submits it.</p>}
      </div>,
      <ReasonForm
        key="revise"
        name="Return to a new draft revision"
        field="Why a new revision is needed"
        button="Return to a new draft revision"
        busy={busy}
        onSend={(reason) => send('revise', { reason })}
      />,
    );
  }
  if (run.state === 'IN_REVIEW') {
    controls.push(
      <p key="review" className="hint">
        Waiting for the independent review and approval: <Link to={PATHS.decisions}>Run decisions</Link>.
      </p>,
    );
  }
  if (run.state === 'APPROVED' && can(RUN_PROCESS)) {
    controls.push(
      <div key="process">
        <button type="button" disabled={busy || runActor} onClick={() => void send('process').catch(() => undefined)}>
          {run.processingStartedAt ? 'Continue processing' : 'Process and lock'}
        </button>
        {runActor && <p className="hint">You created or calculated this run, so someone else processes it.</p>}
      </div>,
    );
    if (!run.processingStartedAt) {
      controls.push(
        <ReasonForm
          key="return"
          name="Return before processing"
          field="Why the approved revision is returned"
          button="Return before processing"
          busy={busy}
          onSend={(reason) => send('return', { reason })}
        />,
      );
    }
  }
  if (live && can(RUN_CANCEL)) {
    controls.push(<ReasonForm key="cancel" name="Cancel this revision" field="Reason for cancelling" button="Cancel this revision" busy={busy} danger onSend={(reason) => send('cancel', { reason })} />);
  }
  return (
    <div style={{ marginTop: '0.75rem' }}>
      <h3 style={H3}>Actions</h3>
      {controls.length === 0 ? <p className="hint">No action on this revision is available to the selected role.</p> : <div className="stack">{controls}</div>}
      {note && (
        <p role="status" className="ok">
          {note}
        </p>
      )}
      <Problem error={act.error} act={act.variables?.action === 'process' ? 'process' : 'run'} />
    </div>
  );
}

function RunTotalsSection({ run, totals }: { run: RunDetail; totals: RunTotals[] }) {
  return (
    <Section title="Run totals">
      {run.scopeComplete === false && <p className="hint">Your scope covers part of this run: these totals are of the records in your scope only.</p>}
      {totals.length === 0 ? (
        <Empty>No records are calculated yet.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label="Run totals">
            <thead>
              <tr>
                <th>Currency</th>
                <th>Records</th>
                <th>Paid units</th>
                <th>Earnings</th>
                <th>Reimbursements</th>
                <th>Gross</th>
                <th>Deductions</th>
                <th>Net</th>
                <th>Employer contributions</th>
              </tr>
            </thead>
            <tbody>
              {totals.map((t) => (
                <tr key={t.currencyCode}>
                  <td>{t.currencyCode}</td>
                  <td>{t.records}</td>
                  <td>{t.paidUnits ?? '—'}</td>
                  <td>{money(t.earnings, t.currencyCode)}</td>
                  <td>{money(t.reimbursements, t.currencyCode)}</td>
                  <td>{money(t.gross, t.currencyCode)}</td>
                  <td>{money(t.deductions, t.currencyCode)}</td>
                  <td>{money(t.net, t.currencyCode)}</td>
                  <td>{money(t.employerContributions, t.currencyCode)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function exceptionDetail(detail: unknown): string {
  if (!detail || typeof detail !== 'object') return '';
  return Object.entries(detail as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(', ');
}

function RunRecords({ run }: { run: RunDetail }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [after, setAfter] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const [onlyExceptions, setOnlyExceptions] = useState(false);
  const [resolving, setResolving] = useState<{ exception: RunException; employee: string } | null>(null);
  const [holding, setHolding] = useState<RunRecord | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // A hold applies to a processed record: its balance (hold read) and a proposal (hold propose) start from the member list.
  const holdColumn = run.state === 'PROCESSED_LOCKED' && (can(HOLD_READ) || can(HOLD_PROPOSE));
  const records = useQuery({
    queryKey: keys.records(run.id, after, onlyExceptions),
    queryFn: () => {
      const q = new URLSearchParams();
      if (onlyExceptions) q.set('exceptions', 'true');
      if (after) q.set('after', after);
      const s = q.toString();
      return api<{ items: RunRecord[]; nextAfter: string | null }>(`/v1/payroll/runs/${encodeURIComponent(run.id)}/records${s ? `?${s}` : ''}`);
    },
    retry: retryTransient,
  });
  const resolve = useMutation({
    mutationFn: ({ exceptionId, resolution }: { exceptionId: string; resolution: string }) =>
      api<{ exceptionId: string; resolved: boolean }>(`/v1/payroll/runs/${encodeURIComponent(run.id)}/exceptions/${encodeURIComponent(exceptionId)}/resolve`, { body: { resolution } }),
    onSuccess: () => {
      setResolving(null);
      setNote('The exception was resolved.');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.run(run.id) }),
  });
  const canResolve = can(RUN_APPROVE) && (run.state === 'CALCULATED' || run.state === 'IN_REVIEW');
  const reset = (only: boolean) => {
    setOnlyExceptions(only);
    setAfter(null);
    setPrevious([]);
  };
  return (
    <Section title="Members and exceptions">
      <label className="check">
        <input type="checkbox" checked={onlyExceptions} onChange={(e) => reset(e.target.checked)} /> Only members with exceptions
      </label>
      {records.isPending && <p className="hint">Loading the members…</p>}
      {records.error && <Problem error={records.error} act="read" />}
      {records.data && records.data.items.length === 0 && <Empty>{run.progress.calculation.started ? 'No member records to show.' : 'Member records appear once the run is calculated.'}</Empty>}
      {records.data && records.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Run members">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Calculation</th>
                <th>Paid units</th>
                <th>Gross</th>
                <th>Deductions</th>
                <th>Net</th>
                <th>Prior net</th>
                <th>Salary stop</th>
                <th>Bank</th>
                <th>Exceptions</th>
                {holdColumn && <th>Salary hold</th>}
              </tr>
            </thead>
            <tbody>
              {records.data.items.map((rec) => (
                <tr key={rec.id}>
                  <td>{`${rec.employeeCode} ${rec.employeeName}`}</td>
                  <td>{readable(rec.calculationStatus)}</td>
                  <td>{rec.paidUnits ?? '—'}</td>
                  <td>{money(rec.gross, rec.currencyCode)}</td>
                  <td>{money(rec.deductions, rec.currencyCode)}</td>
                  <td>{money(rec.net, rec.currencyCode)}</td>
                  <td>{money(rec.priorNet, rec.currencyCode)}</td>
                  <td>{rec.salaryStopMode ? readable(rec.salaryStopMode) : '—'}</td>
                  <td>{rec.bankStatus ? readable(rec.bankStatus) : '—'}</td>
                  <td>
                    {rec.exceptions.length === 0 ? (
                      'None'
                    ) : (
                      <ul style={PLAIN_LIST}>
                        {rec.exceptions.map((x) => {
                          const open = x.severity === 'BLOCKING' && !x.resolvedAt;
                          const extra = exceptionDetail(x.detail);
                          return (
                            <li key={x.id}>
                              {`${readable(x.code)} (${x.severity === 'BLOCKING' ? 'blocking' : 'warning'}${x.resolvedAt ? `, resolved ${formatDate(x.resolvedAt)}` : open ? ', unresolved' : ''})`}
                              {extra && <span className="hint">{` ${extra}`}</span>}
                              {open && !x.resolvable && <span className="hint"> Needs corrected data and a new revision, or the employee left out.</span>}
                              {open && x.resolvable && canResolve && (
                                <>
                                  {' '}
                                  <button
                                    type="button"
                                    className="link"
                                    disabled={resolve.isPending}
                                    onClick={() => {
                                      resolve.reset();
                                      setNote(null);
                                      setResolving({ exception: x, employee: rec.employeeCode });
                                    }}
                                    aria-label={`Resolve ${readable(x.code)} of ${rec.employeeCode}`}
                                  >
                                    Resolve
                                  </button>
                                </>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </td>
                  {holdColumn && (
                    <td>
                      <button type="button" className="link" onClick={() => setHolding(holding?.id === rec.id ? null : rec)} aria-label={`Salary hold of ${rec.employeeCode}`}>
                        {holding?.id === rec.id ? 'Hide' : can(HOLD_PROPOSE) ? 'Balance and hold' : 'Balance'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {holding && <RecordHoldPanel key={holding.id} record={holding} />}
      <div className="row" style={{ marginTop: '0.5rem' }}>
        {previous.length > 0 && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setAfter(previous[previous.length - 1] ?? null);
              setPrevious(previous.slice(0, -1));
            }}
          >
            Previous page
          </button>
        )}
        {records.data?.nextAfter && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setPrevious([...previous, after]);
              setAfter(records.data?.nextAfter ?? null);
            }}
          >
            Next page
          </button>
        )}
      </div>
      {resolving && (
        <ReasonForm
          key={resolving.exception.id}
          name={`Resolve ${readable(resolving.exception.code)} of ${resolving.employee}`}
          field={`Resolution of ${readable(resolving.exception.code)} for ${resolving.employee}`}
          button={resolve.isPending ? 'Recording…' : 'Record the resolution'}
          busy={resolve.isPending}
          onSend={(resolution) => resolve.mutateAsync({ exceptionId: resolving.exception.id, resolution })}
        />
      )}
      <Problem error={resolve.error} act="resolve" />
      {note && (
        <p role="status" className="ok">
          {note}
        </p>
      )}
    </Section>
  );
}

function RunComponentsSection({ run }: { run: RunDetail }) {
  const keys = useKeys();
  const data = useQuery({
    queryKey: keys.components(run.id),
    queryFn: () => api<RunComponents>(`/v1/payroll/runs/${encodeURIComponent(run.id)}/components`),
    retry: retryTransient,
  });
  const c = data.data;
  return (
    <Section title="Component totals and prior period">
      {data.isPending && <p className="hint">Loading the component totals…</p>}
      {data.error && <Problem error={data.error} act="read" />}
      {c?.basis === 'SCOPE' && <p className="hint">Your scope covers part of this run: the records in your scope are compared with the same employees’ latest earlier processed records.</p>}
      {c?.basis === 'RUN' && !c.priorPeriodCode && <p className="hint">No earlier processed run of this calendar and scope to compare with.</p>}
      {c && <ComponentTable c={c} currency={run.currencyCode} name="Component totals" />}
    </Section>
  );
}

/** Component totals with the prior period and the difference, each exactly as returned. */
function ComponentTable({ c, currency, name }: { c: RunComponents; currency: string; name: string }) {
  return (
    <>
      {c.items.length === 0 && <Empty>No component totals yet.</Empty>}
      {c.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label={name}>
            <thead>
              <tr>
                <th>Component</th>
                <th>Type</th>
                <th>This run</th>
                <th>{c.priorPeriodCode ? `Prior period (${c.priorPeriodCode})` : 'Prior period'}</th>
                <th>Difference</th>
              </tr>
            </thead>
            <tbody>
              {c.items.map((i) => (
                <tr key={`${i.componentCode}:${i.headType}`}>
                  <td>{i.componentCode}</td>
                  <td>{label(HEAD_TYPE, i.headType)}</td>
                  <td>{money(i.current, currency)}</td>
                  <td>{money(i.prior, currency)}</td>
                  <td>{money(i.difference, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// =========================================================================================================
// Payslip publishing (processed runs)
// =========================================================================================================

function RunPayslips({ run }: { run: RunDetail }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [reissuing, setReissuing] = useState<IssuedOutput | null>(null);
  const reissue = useMutation({
    mutationFn: ({ o, reason }: { o: IssuedOutput; reason: string }) =>
      api<IssuedOutput>(`/v1/payroll-outputs/payslips/${encodeURIComponent(o.id)}/reissue`, { body: { reason, expectedVersion: o.rowVersion } }),
    onSuccess: (n, { o }) => {
      setReissuing(null);
      setNote(`A new version of the payslip of ${o.employeeCode} was issued${n.version ? ` (version ${n.version})` : ''}; the earlier one is marked superseded. Reissuing does not mean the salary has been paid.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.runPayslips(run.id) }),
  });
  const outputs = useQuery({
    queryKey: keys.runPayslips(run.id),
    queryFn: () => api<{ items: IssuedOutput[] }>(`/v1/payroll-outputs/runs/${encodeURIComponent(run.id)}/payslips`),
    enabled: can(OUTPUT_READ),
    retry: retryTransient,
  });
  const publish = useMutation({
    mutationFn: () => api<PublishResult>(`/v1/payroll-outputs/runs/${encodeURIComponent(run.id)}/payslips/publish`, { method: 'POST' }),
    onSuccess: (r) => {
      const parts = [`Published ${r.published} ${r.published === 1 ? 'payslip' : 'payslips'}.`];
      if (r.remaining > 0) parts.push(`${r.remaining} still to publish: publish again to continue.`);
      if (r.ownRecordLeftForAnotherPublisher > 0) parts.push('Your own payslip is left for another publisher.');
      parts.push('Publication does not mean the salary has been paid.');
      setNote(parts.join(' '));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.runPayslips(run.id) }),
  });
  const fetchFile = async (o: IssuedOutput) => {
    if (busyId) return;
    setBusyId(o.id);
    setFailure(null);
    try {
      await download(`/v1/payroll-outputs/payslips/${encodeURIComponent(o.id)}/file`);
    } catch (e) {
      setFailure(e);
    } finally {
      setBusyId(null);
    }
  };
  return (
    <Section title="Payslips">
      <p className="hint">Payslips are published from the frozen records of this processed run. Publishing a payslip does not mean the salary has been paid.</p>
      {can(OUTPUT_PUBLISH) && (
        <div className="row">
          <button
            type="button"
            disabled={publish.isPending}
            onClick={() => {
              setNote(null);
              publish.mutate();
            }}
          >
            {publish.isPending ? 'Publishing…' : 'Publish payslips'}
          </button>
        </div>
      )}
      {note && (
        <p role="status" className="ok">
          {note}
        </p>
      )}
      <Problem error={publish.error} act="publish" />
      {can(OUTPUT_READ) && (
        <>
          {outputs.isPending && <p className="hint">Loading issued payslips…</p>}
          {outputs.error && <Problem error={outputs.error} act="read" />}
          {outputs.data && outputs.data.items.length === 0 && <Empty>No payslip of this run has been issued yet.</Empty>}
          {outputs.data && outputs.data.items.length > 0 && (
            <div style={SCROLL}>
              <table aria-label="Issued payslips">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Period</th>
                    <th>Version</th>
                    <th>Status</th>
                    <th>Issued</th>
                    <th>File</th>
                    {can(OUTPUT_PUBLISH) && <th>Replace</th>}
                  </tr>
                </thead>
                <tbody>
                  {outputs.data.items.map((o) => (
                    <tr key={o.id}>
                      <td>{o.employeeCode}</td>
                      <td>{o.periodCode}</td>
                      <td>{o.version}</td>
                      <td>{o.publicationState === 'SUPERSEDED' ? <Badge tone="warn">Superseded by a later version</Badge> : <Badge>{readable(o.publicationState)}</Badge>}</td>
                      <td>{formatDate(o.issuedAt)}</td>
                      <td>
                        {o.publicationState === 'ISSUED' || o.publicationState === 'SUPERSEDED' ? (
                          <button type="button" className="secondary" disabled={busyId !== null} onClick={() => void fetchFile(o)} aria-label={`Download payslip of ${o.employeeCode} version ${o.version}`}>
                            {busyId === o.id ? 'Downloading…' : 'Download'}
                          </button>
                        ) : (
                          'Not issued'
                        )}
                      </td>
                      {can(OUTPUT_PUBLISH) && (
                        <td>
                          {o.publicationState === 'ISSUED' ? (
                            <button
                              type="button"
                              className="link"
                              disabled={reissue.isPending}
                              onClick={() => {
                                reissue.reset();
                                setNote(null);
                                setReissuing(o);
                              }}
                              aria-label={`Reissue the payslip of ${o.employeeCode} version ${o.version}`}
                            >
                              Reissue
                            </button>
                          ) : (
                            '—'
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {failure !== null && <Problem error={failure} act="download" />}
          {reissuing && (
            <ReasonForm
              key={reissuing.id}
              name={`Reissue the payslip of ${reissuing.employeeCode}`}
              field={`Why the payslip of ${reissuing.employeeCode} (version ${reissuing.version}) is replaced`}
              button={reissue.isPending ? 'Reissuing…' : 'Issue a new version'}
              busy={reissue.isPending}
              onSend={(reason) => reissue.mutateAsync({ o: reissuing, reason })}
            />
          )}
          <Problem error={reissue.error} act="reissue" />
        </>
      )}
    </Section>
  );
}

// =========================================================================================================
// Bank manifests of a processed run
// =========================================================================================================

function RunBank({ run }: { run: RunDetail }) {
  const { can } = useSession();
  const keys = useKeys();
  const manifests = useQuery({
    queryKey: keys.manifests(run.id),
    queryFn: () => api<{ items: ManifestRow[] }>(`/v1/payroll-outputs/runs/${encodeURIComponent(run.id)}/bank-manifests`),
    retry: retryTransient,
  });
  return (
    <Section title="Bank manifests">
      <p className="hint">A manifest or a bank file is not a payment: payment status comes only from outcomes recorded from bank evidence.</p>
      {manifests.isPending && <p className="hint">Loading manifests…</p>}
      {manifests.error && <Problem error={manifests.error} act="read" />}
      {manifests.data && manifests.data.items.length === 0 && <Empty>No manifest has been prepared for this run.</Empty>}
      {manifests.data && manifests.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Bank manifests">
            <thead>
              <tr>
                <th>Manifest</th>
                <th>Template</th>
                <th>State</th>
                <th>Lines</th>
                <th>Total</th>
                <th>Prepared</th>
                <th>Authorised</th>
                <th>File issued</th>
              </tr>
            </thead>
            <tbody>
              {manifests.data.items.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Link to={PATHS.manifest(m.id)}>{`Manifest ${m.batchRevision}`}</Link>
                  </td>
                  <td>{`${m.templateCode} v${m.templateVersion}`}</td>
                  <td>
                    <Status map={BATCH_STATE} code={m.state} />
                  </td>
                  <td>{m.lineCount}</td>
                  <td>{money(m.totalAmount, m.currencyCode)}</td>
                  <td>{formatDate(m.preparedAt)}</td>
                  <td>{formatDate(m.authorizedAt)}</td>
                  <td>{formatDate(m.issuedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can(BANK_PREPARE) && <PrepareManifest run={run} />}
    </Section>
  );
}

function PrepareManifest({ run }: { run: RunDetail }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [templateId, setTemplateId] = useState('');
  const [preview, setPreview] = useState<BankPreview | null>(null);
  const [prepared, setPrepared] = useState<Manifest | null>(null);
  const templates = useQuery({
    queryKey: keys.templates,
    queryFn: () => api<{ items: BankTemplate[] }>('/v1/payroll-outputs/bank-templates'),
    enabled: can(TEMPLATE_READ),
    retry: retryTransient,
  });
  const previewing = useMutation({
    mutationFn: (tid: string) => api<BankPreview>(`/v1/payroll-outputs/runs/${encodeURIComponent(run.id)}/bank-preview?templateId=${encodeURIComponent(tid)}`),
    onSuccess: (p) => setPreview(p),
  });
  const prepare = useMutation({
    mutationFn: (tid: string) => api<Manifest>(`/v1/payroll-outputs/runs/${encodeURIComponent(run.id)}/bank-manifests`, { body: { templateId: tid } }),
    onSuccess: (m) => {
      setPrepared(m);
      setPreview(null);
      setTemplateId('');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.manifests(run.id) }),
  });
  if (!can(TEMPLATE_READ)) return <p className="hint">The selected role cannot list bank file templates, so a manifest cannot be prepared here.</p>;
  const usable = (templates.data?.items ?? []).filter((t) => t.state === 'ACTIVE' && t.currencyCode === run.currencyCode);
  const busy = previewing.isPending || prepare.isPending;
  const mine = involvement(run, me?.userId);
  return (
    <div>
      <h3 style={H3}>Prepare a manifest</h3>
      <p className="hint">Only frozen records are used; held, reserved and confirmed amounts are left out. Someone independent of you and of the run’s preparer, reviewer and approver authorises it.</p>
      {mine.length > 0 && <p className="hint">{`You ${mine.join(' and ')} this run, so you cannot authorise this manifest’s release or record its outcomes.`}</p>}
      {templates.error && <Problem error={templates.error} act="read" />}
      {templates.data && usable.length === 0 && <p className="hint">{`No active bank file template pays in ${run.currencyCode}.`}</p>}
      {usable.length > 0 && (
        <form
          aria-label="Prepare a manifest"
          className="grid-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!templateId || busy) return;
            setPrepared(null);
            prepare.mutate(templateId);
          }}
        >
          <label>
            Bank file template
            <select
              value={templateId}
              onChange={(e) => {
                setTemplateId(e.target.value);
                setPreview(null);
              }}
            >
              <option value="">Choose a template</option>
              {usable.map((t) => (
                <option key={t.id} value={t.id}>
                  {`${t.templateCode} v${t.templateVersion} · ${t.name}${t.testOnly ? ' (test only)' : ''}`}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button
              type="button"
              className="secondary"
              disabled={!templateId || busy}
              onClick={() => {
                previewing.reset();
                previewing.mutate(templateId);
              }}
            >
              {previewing.isPending ? 'Previewing…' : 'Preview (not payable)'}
            </button>
            <button type="submit" disabled={!templateId || busy}>
              {prepare.isPending ? 'Preparing…' : 'Prepare the manifest'}
            </button>
          </div>
        </form>
      )}
      <Problem error={previewing.error} act="prepare" />
      {preview && (
        <div role="region" aria-label="Manifest preview">
          <p style={FLUSH}>
            <Badge tone="warn">Preview, not payable</Badge> {`${preview.lineCount} lines, total ${money(preview.totalAmount, preview.currencyCode)}.`}
          </p>
          <p className="hint">{`Left out: ${preview.excluded.held} held${preview.excluded.heldBySalaryStop ? ` (${preview.excluded.heldBySalaryStop} by a salary stop)` : ''}, ${preview.excluded.reservedOrPaid} already reserved or paid, ${preview.excluded.nothingPayable} with nothing payable.`}</p>
          {preview.errors.length > 0 && (
            <ul>
              {preview.errors.map((x, i) => (
                <li key={i}>{`${x.employeeCode ? `${x.employeeCode}: ` : ''}${readable(x.code)}${x.lineSequence ? ` (row ${x.lineSequence})` : ''}`}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Problem error={prepare.error} act="prepare" />
      {prepared && (
        <p role="status" className="ok">
          {`Manifest ${prepared.batchRevision} prepared: ${prepared.lineCount} lines, waiting for an independent authorisation. Nothing is reserved or paid yet. `}
          <Link to={PATHS.manifest(prepared.id)}>Open the manifest</Link>
        </p>
      )}
    </div>
  );
}

// =========================================================================================================
// Bank manifest detail: authorisation, file, outcomes and reversals
// =========================================================================================================

function ManifestScreen() {
  const { can } = useSession();
  const { id = '' } = useParams();
  if (!can(BANK_READ)) {
    return (
      <Section title="Bank manifest">
        <Empty>The selected role cannot see bank manifests.</Empty>
      </Section>
    );
  }
  return <ManifestView key={id} id={id} />;
}

type ManifestAction = 'authorize' | 'cancel' | 'issue';

function ManifestView({ id }: { id: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [fileFailure, setFileFailure] = useState<unknown>(null);
  const batch = useQuery({ queryKey: keys.manifest(id), queryFn: () => api<Manifest>(`/v1/payroll-outputs/bank-manifests/${encodeURIComponent(id)}`), retry: retryTransient });
  const b = batch.data;
  // The run's actors are known only to callers who may read the run; the server refuses them either way.
  const run = useQuery({
    queryKey: keys.run(b?.runId ?? '-'),
    queryFn: () => api<RunDetail>(`/v1/payroll/runs/${encodeURIComponent(b?.runId ?? '')}`),
    enabled: b !== undefined && canReadRuns(can),
    retry: retryTransient,
  });
  const act = useMutation({
    mutationFn: ({ action, reason }: { action: ManifestAction; reason?: string }) =>
      api<Manifest>(`/v1/payroll-outputs/bank-manifests/${encodeURIComponent(id)}/${action}`, action === 'issue' ? { method: 'POST' } : { body: { ...(reason ? { reason } : {}), expectedVersion: b?.version } }),
    onSuccess: (_r, { action }) => {
      setNote(
        action === 'authorize'
          ? 'Authorised: every line is reserved. Nothing is paid until a CONFIRMED outcome is recorded from bank evidence.'
          : action === 'issue'
            ? 'The bank file was issued. Issuing a file is not a payment.'
            : 'The manifest was cancelled; nothing was reserved.',
      );
    },
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: keys.manifestAll }), qc.invalidateQueries({ queryKey: keys.runAll })]),
  });
  if (batch.isPending) return <p className="hint">Loading the manifest…</p>;
  if (!b) {
    return (
      <Section title="Bank manifest">
        <Problem error={batch.error} act="read" />
      </Section>
    );
  }
  const preparer = b.preparedBy === me?.userId;
  const runRoles = run.data ? involvement(run.data, me?.userId) : [];
  // While the run's actors are still loading, nothing that needs independence is offered yet.
  const blocked = preparer || runRoles.length > 0 || run.isLoading;
  const busy = act.isPending;
  const fetchFile = async () => {
    if (downloading) return;
    setDownloading(true);
    setFileFailure(null);
    try {
      await download(`/v1/payroll-outputs/bank-manifests/${encodeURIComponent(id)}/file`);
    } catch (e) {
      setFileFailure(e);
    } finally {
      setDownloading(false);
    }
  };
  const ex = b.excluded ?? {};
  return (
    <div className="stack">
      <Section title={`Bank manifest ${b.batchRevision}`} actions={<Link to={PATHS.run(b.runId)}>Open the payroll run</Link>}>
        <dl className="kv">
          <Fact term="State">
            <Status map={BATCH_STATE} code={b.state} />
          </Fact>
          <Fact term="Template">{`${b.templateCode} v${b.templateVersion}${b.testOnly ? ' (test only)' : ''}`}</Fact>
          <Fact term="Payment date">{formatDate(b.paymentDate)}</Fact>
          <Fact term="Lines">{b.lineCount}</Fact>
          <Fact term="Total">{money(b.totalAmount, b.currencyCode)}</Fact>
          <Fact term="Prepared">{formatDate(b.preparedAt)}</Fact>
          <Fact term="Authorised">{formatDate(b.authorizedAt)}</Fact>
          <Fact term="File issued">{formatDate(b.issuedAt)}</Fact>
          {b.fileName && <Fact term="File">{b.fileName}</Fact>}
          {b.cancelledAt && <Fact term="Cancelled">{formatDate(b.cancelledAt)}</Fact>}
          <Fact term="Left out">
            {`${ex.held ?? 0} held${ex.heldBySalaryStop ? ` (${ex.heldBySalaryStop} by a salary stop)` : ''}, ${ex.reservedOrPaid ?? 0} reserved or paid, ${ex.nothingPayable ?? 0} nothing payable, ${ex.excludedByPreparer ?? 0} by the preparer`}
            {ex.excludedEmployeeCodes && ex.excludedEmployeeCodes.length > 0 ? ` (${ex.excludedEmployeeCodes.join(', ')})` : ''}
          </Fact>
        </dl>
        <p role="note" className="hint">
          A manifest or a bank file is not a payment. Payment status comes only from outcomes recorded from bank evidence; only a confirmed outcome is a payment.
        </p>
        {preparer && <p className="hint">You prepared this manifest, so someone else authorises it and records its outcomes.</p>}
        {runRoles.length > 0 && <p className="hint">{`You ${runRoles.join(' and ')} its payroll run, so you cannot authorise this manifest or record its outcomes.`}</p>}
        <div className="stack" style={{ marginTop: '0.5rem' }}>
          {b.state === 'VALIDATED' && can(BANK_AUTHORIZE) && (
            <div className="row">
              <button
                type="button"
                disabled={busy || blocked}
                onClick={() => {
                  setNote(null);
                  act.mutate({ action: 'authorize' });
                }}
              >
                {busy && act.variables?.action === 'authorize' ? 'Authorising…' : 'Authorise the payment'}
              </button>
            </div>
          )}
          {b.state === 'VALIDATED' && can(BANK_PREPARE) && (
            <ReasonForm
              name="Cancel the manifest"
              field="Reason for cancelling the manifest"
              button="Cancel the manifest"
              busy={busy}
              danger
              onSend={(reason) => {
                setNote(null);
                return act.mutateAsync({ action: 'cancel', reason });
              }}
            />
          )}
          {b.state === 'AUTHORIZED' && can(BANK_FILE) && (
            <div className="row">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setNote(null);
                  act.mutate({ action: 'issue' });
                }}
              >
                {busy ? 'Issuing…' : 'Issue the bank file'}
              </button>
            </div>
          )}
          {b.state === 'ISSUED' && can(BANK_FILE) && (
            <div className="row">
              <button type="button" className="secondary" disabled={downloading} onClick={() => void fetchFile()}>
                {downloading ? 'Downloading…' : 'Download the bank file'}
              </button>
            </div>
          )}
        </div>
        {note && (
          <p role="status" className="ok">
            {note}
          </p>
        )}
        <Problem error={act.error} act={act.variables?.action === 'authorize' ? 'authorize' : 'manifest'} />
        {fileFailure !== null && <Problem error={fileFailure} act="download" />}
      </Section>
      {b.ledger.length > 0 && (
        <Section title="Payment ledger">
          <div style={SCROLL}>
            <table aria-label="Payment ledger">
              <thead>
                <tr>
                  <th>Payment state</th>
                  <th>Lines</th>
                  <th>Amount</th>
                  <th>Net confirmed</th>
                </tr>
              </thead>
              <tbody>
                {b.ledger.map((l) => (
                  <tr key={l.paymentState}>
                    <td>
                      <Status map={PAYMENT_STATE} code={l.paymentState} />
                    </td>
                    <td>{l.lines}</td>
                    <td>{money(l.amount, b.currencyCode)}</td>
                    <td>{money(l.netConfirmed, b.currencyCode)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
      <ManifestLines batch={b} blocked={blocked} />
    </div>
  );
}

function ManifestLines({ batch, blocked }: { batch: Manifest; blocked: boolean }) {
  const { can } = useSession();
  const keys = useKeys();
  const [after, setAfter] = useState(0);
  const [previous, setPrevious] = useState<number[]>([]);
  const [selected, setSelected] = useState<{ line: BankLine; kind: 'outcome' | 'reversal' } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const lines = useQuery({
    queryKey: keys.lines(batch.id, after),
    queryFn: () => api<{ items: BankLine[]; next: number | null }>(`/v1/payroll-outputs/bank-manifests/${encodeURIComponent(batch.id)}/lines${after ? `?after=${after}` : ''}`),
    retry: retryTransient,
  });
  const recordable = can(BANK_OUTCOME) && (batch.state === 'AUTHORIZED' || batch.state === 'ISSUED');
  const outcomesFor = (line: BankLine) =>
    Object.keys(OUTCOME_FROM).filter((o) => OUTCOME_FROM[o]!.includes(line.paymentState) && (batch.state === 'ISSUED' || o === 'CANCELLED'));
  return (
    <Section title="Manifest lines">
      {recordable && <p className="hint">Outcomes are recorded only from bank evidence, each with its own evidence key. Before the file is issued, only a cancellation can be recorded.</p>}
      {lines.isPending && <p className="hint">Loading the lines…</p>}
      {lines.error && <Problem error={lines.error} act="read" />}
      {lines.data && lines.data.items.length === 0 && <Empty>This manifest has no lines.</Empty>}
      {lines.data && lines.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Manifest lines">
            <thead>
              <tr>
                <th>Row</th>
                <th>Allocation</th>
                <th>Employee</th>
                <th>Kind</th>
                <th>Amount</th>
                <th>Payment state</th>
                <th>Confirmed</th>
                <th>Reversed</th>
                {recordable && <th>Record</th>}
              </tr>
            </thead>
            <tbody>
              {lines.data.items.map((l) => (
                <tr key={l.id}>
                  <td>{l.lineSequence}</td>
                  <td>{l.allocationKey}</td>
                  <td>{l.employeeCode}</td>
                  <td>{l.holdId ? 'Released hold' : 'Payroll net'}</td>
                  <td>{money(l.amount, l.currencyCode)}</td>
                  <td>
                    <Status map={PAYMENT_STATE} code={l.paymentState} />
                  </td>
                  <td>{money(l.confirmedAmount, l.currencyCode)}</td>
                  <td>{money(l.reversedAmount, l.currencyCode)}</td>
                  {recordable && (
                    <td>
                      <div className="row">
                        {outcomesFor(l).length > 0 && (
                          <button
                            type="button"
                            className="link"
                            disabled={blocked}
                            onClick={() => {
                              setNote(null);
                              setSelected({ line: l, kind: 'outcome' });
                            }}
                            aria-label={`Record an outcome for row ${l.lineSequence}`}
                          >
                            Outcome
                          </button>
                        )}
                        {l.paymentState === 'CONFIRMED' && (
                          <button
                            type="button"
                            className="link"
                            disabled={blocked}
                            onClick={() => {
                              setNote(null);
                              setSelected({ line: l, kind: 'reversal' });
                            }}
                            aria-label={`Record a reversal for row ${l.lineSequence}`}
                          >
                            Reversal
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row" style={{ marginTop: '0.5rem' }}>
        {previous.length > 0 && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setAfter(previous[previous.length - 1] ?? 0);
              setPrevious(previous.slice(0, -1));
            }}
          >
            Previous lines
          </button>
        )}
        {lines.data?.next != null && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setPrevious([...previous, after]);
              setAfter(lines.data?.next ?? 0);
            }}
          >
            Next lines
          </button>
        )}
      </div>
      {note && (
        <p role="status" className="ok">
          {note}
        </p>
      )}
      {selected?.kind === 'outcome' && (
        <OutcomeForm
          key={`o:${selected.line.id}`}
          batch={batch}
          line={selected.line}
          options={outcomesFor(selected.line)}
          onDone={(text) => {
            setSelected(null);
            setNote(text);
          }}
        />
      )}
      {selected?.kind === 'reversal' && (
        <ReversalForm
          key={`r:${selected.line.id}`}
          batch={batch}
          line={selected.line}
          onDone={(text) => {
            setSelected(null);
            setNote(text);
          }}
        />
      )}
    </Section>
  );
}

/** Intent keys survive the form being closed and reopened, so a resend after a lost answer reuses its key. */
const outcomeIntents = new Map<string, { intent: string; key: string; lost: boolean }>();

function keyFor(scope: string, intent: string, prefix: string): string {
  const prior = outcomeIntents.get(scope);
  const key = prior && prior.lost && prior.intent === intent ? prior.key : idempotencyKey(prefix);
  outcomeIntents.set(scope, { intent, key, lost: false });
  return key;
}
function settleKey(scope: string, error: unknown) {
  const prior = outcomeIntents.get(scope);
  if (!prior) return;
  if (error !== null && error !== undefined && !(error instanceof ApiError)) prior.lost = true;
  else outcomeIntents.delete(scope);
}

function OutcomeForm({ batch, line, options, onDone }: { batch: Manifest; line: BankLine; options: string[]; onDone: (text: string) => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  // Never preselected: a payment outcome (above all CONFIRMED) is recorded only as an explicit choice from evidence.
  const [outcome, setOutcome] = useState('');
  const [evidence, setEvidence] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const scope = `outcome:${line.id}`;
  const record = useMutation({
    mutationFn: (body: { outcomes: { lineId: string; outcome: string; eventKey: string; evidenceReference: string }[] }) =>
      api<{ batchId: string; results: { lineId: string; outcome: string; replayed: boolean }[] }>(`/v1/payroll-outputs/bank-manifests/${encodeURIComponent(batch.id)}/outcomes`, { body }),
    onSettled: (_d, error) => {
      settleKey(scope, error);
      void qc.invalidateQueries({ queryKey: keys.manifest(batch.id) });
    },
    onSuccess: (r) => {
      const replayed = r.results[0]?.replayed === true;
      onDone(replayed ? 'This outcome had already been recorded with the same evidence key; nothing was recorded twice.' : `Recorded for row ${line.lineSequence}: ${label(OUTCOME_LABEL, outcome)}.`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (record.isPending) return;
    const ref = evidence.trim();
    if (!outcome) return setProblem('Choose the outcome.');
    if (!ref) return setProblem('Give the evidence reference (for example the bank statement or return file).');
    setProblem(null);
    record.reset();
    const eventKey = keyFor(scope, `${outcome}|${ref}`, 'pay-outcome');
    record.mutate({ outcomes: [{ lineId: line.id, outcome, eventKey, evidenceReference: ref }] });
  };
  return (
    <form onSubmit={submit} aria-label={`Outcome for row ${line.lineSequence}`} className="grid-form" style={{ marginTop: '0.5rem' }}>
      <p className="wide" style={FLUSH}>
        {`Row ${line.lineSequence} · ${line.employeeCode} · ${money(line.amount, line.currencyCode)} · ${label(PAYMENT_STATE, line.paymentState)}`}
      </p>
      <label>
        Outcome
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="">Choose the outcome</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {label(OUTCOME_LABEL, o)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Evidence reference
        <input value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={500} autoComplete="off" />
      </label>
      <div className="row">
        <button type="submit" disabled={record.isPending}>
          {record.isPending ? 'Recording…' : 'Record the outcome'}
        </button>
      </div>
      {problem && (
        <p role="alert" className="error wide">
          {problem}
        </p>
      )}
      <div className="wide">
        <Problem error={record.error} act="outcome" />
      </div>
    </form>
  );
}

function ReversalForm({ batch, line, onDone }: { batch: Manifest; line: BankLine; onDone: (text: string) => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [evidence, setEvidence] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const scope = `reversal:${line.id}`;
  const reverse = useMutation({
    mutationFn: (body: { amount: string; eventKey: string; evidenceReference: string; reason: string }) =>
      api<{ lineId: string; replayed: boolean; paymentState: string; confirmedAmount: string; reversedAmount: string }>(`/v1/payroll-outputs/bank-lines/${encodeURIComponent(line.id)}/reversal`, { body }),
    onSettled: (_d, error) => {
      settleKey(scope, error);
      void qc.invalidateQueries({ queryKey: keys.manifest(batch.id) });
    },
    onSuccess: (r) =>
      onDone(
        r.replayed
          ? 'This reversal had already been recorded with the same evidence key; nothing was recorded twice.'
          : `Reversal recorded for row ${line.lineSequence}: ${money(r.reversedAmount, line.currencyCode)} reversed of ${money(r.confirmedAmount, line.currencyCode)} confirmed.`,
      ),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reverse.isPending) return;
    const amt = amount.trim();
    const ref = evidence.trim();
    const why = reason.trim();
    if (!MONEY.test(amt) || /^0+(\.0+)?$/.test(amt)) return setProblem('Enter the reversed amount as a positive number, for example 1500.00.');
    if (!ref) return setProblem('Give the evidence reference of the return.');
    if (!why) return setProblem('Give the reason for the reversal.');
    setProblem(null);
    reverse.reset();
    const eventKey = keyFor(scope, `${amt}|${ref}|${why}`, 'pay-reversal');
    reverse.mutate({ amount: amt, eventKey, evidenceReference: ref, reason: why });
  };
  return (
    <form onSubmit={submit} aria-label={`Reversal for row ${line.lineSequence}`} className="grid-form" style={{ marginTop: '0.5rem' }}>
      <p className="wide" style={FLUSH}>
        {`Row ${line.lineSequence} · ${line.employeeCode} · confirmed ${money(line.confirmedAmount, line.currencyCode)}, reversed so far ${money(line.reversedAmount, line.currencyCode)}`}
      </p>
      <label>
        Reversed amount
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoComplete="off" />
      </label>
      <label>
        Evidence reference
        <input value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={500} autoComplete="off" />
      </label>
      <label className="wide">
        Reason
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
      </label>
      <div className="row">
        <button type="submit" disabled={reverse.isPending}>
          {reverse.isPending ? 'Recording…' : 'Record the reversal'}
        </button>
      </div>
      {problem && (
        <p role="alert" className="error wide">
          {problem}
        </p>
      )}
      <div className="wide">
        <Problem error={reverse.error} act="reverse" />
      </div>
    </form>
  );
}

// =========================================================================================================
// Run decision queues (review, approval and covering approval)
// =========================================================================================================

function RunTaskQueue({ steps, permission, title }: { steps: readonly string[]; permission: string; title: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const [notes, setNotes] = useState<{ id: string; text: string; nextRunId?: string }[]>([]);
  const tasks = useQuery({
    queryKey: keys.runTasks,
    queryFn: () => api<{ items: RunTask[] }>('/v1/payroll/runs/tasks/mine'),
    enabled: can(permission) && can(RUN_READ_AMOUNT),
    retry: retryTransient,
  });
  if (!can(permission)) return null;
  if (!can(RUN_READ_AMOUNT)) {
    return (
      <Section title={title}>
        <p className="hint">The selected role cannot list payroll run tasks: it needs the payroll run amounts.</p>
      </Section>
    );
  }
  const mine = (tasks.data?.items ?? []).filter((t) => steps.includes(t.step));
  return (
    <Section title={title}>
      {tasks.isPending && <p className="hint">Loading your tasks…</p>}
      {tasks.error && <Problem error={tasks.error} act="read" />}
      {notes.map((n) => (
        <p key={n.id} role="status" className="ok">
          {n.text} {n.nextRunId && <Link to={PATHS.run(n.nextRunId)}>Open the new revision</Link>}
        </p>
      ))}
      {tasks.data && mine.length === 0 && <Empty>Nothing is waiting for you.</Empty>}
      {mine.length > 0 && (
        <ul style={PLAIN_LIST} className="stack">
          {mine.map((t) => (
            <RunTaskItem key={t.taskId} task={t} onFinished={(text, nextRunId) => setNotes((prev) => [...prev, { id: t.taskId, text, ...(nextRunId ? { nextRunId } : {}) }])} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function decidedText(task: RunTask, decision: 'APPROVE' | 'RETURN', r: RunDecided): string {
  const name = task.run ? `${task.run.periodCode} revision ${task.run.revision}` : 'The run';
  if (r.replayed) return `${name}: this decision had already been recorded; nothing was applied twice.`;
  if (decision === 'RETURN') return `${name} was returned${task.run ? `: revision ${task.run.revision + 1} is open as a draft` : ''}.`;
  if (task.step === 'REVIEW') return `${name} was reviewed and goes to an independent approver.`;
  if (r.state === 'APPROVED') return `${name} was approved and can be processed by someone independent of its creator and preparer.`;
  if (r.step === 'COVER') {
    return `${name}: your approval was recorded; ${r.coversRequired ?? 'some'} covering ${r.coversRequired === 1 ? 'approval is' : 'approvals are'} needed for deciders’ own records.`;
  }
  return `${name}: your approval was recorded.`;
}

function RunTaskItem({ task, onFinished }: { task: RunTask; onFinished: (text: string, nextRunId?: string) => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const titleId = useId();
  const reasonId = useId();
  const intent = useIntentKey('payroll-run-decision');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const path = task.step === 'REVIEW' ? 'review' : task.step === 'APPROVAL' ? 'approve' : 'cover';
  const decide = useMutation({
    mutationFn: (body: { decision: 'APPROVE' | 'RETURN'; idempotencyKey: string; reason?: string }) =>
      api<RunDecided>(`/v1/payroll/run-tasks/${encodeURIComponent(task.taskId)}/${path}`, { body }),
    onSettled: (_d, error) => {
      intent.settle(error);
      if (!error || error instanceof ApiError) void Promise.all([qc.invalidateQueries({ queryKey: keys.runTasks }), qc.invalidateQueries({ queryKey: keys.runAll }), qc.invalidateQueries({ queryKey: keys.runsAll })]);
    },
    onSuccess: (r, body) => onFinished(decidedText(task, body.decision, r), body.decision === 'RETURN' ? r.nextRunId : undefined),
  });
  const send = (decision: 'APPROVE' | 'RETURN') => {
    if (decide.isPending) return;
    const text = reason.trim();
    if (decision === 'RETURN' && !text) {
      setProblem('Give the reason for returning the run.');
      return;
    }
    setProblem(null);
    decide.reset();
    const key = intent.key(`${decision}|${text}`);
    decide.mutate({ decision, idempotencyKey: key, ...(text ? { reason: text } : {}) });
  };
  const name = task.run ? `${task.run.periodCode} revision ${task.run.revision}` : 'Payroll run';
  return (
    <li aria-labelledby={titleId} className="card">
      <h3 id={titleId} style={H3}>
        {`${label(TASK_STEP, task.step)}: ${name}`}
      </h3>
      <DelegatedBadge taskId={task.taskId} />
      {task.run ? (
        <p style={FLUSH}>
          <Status map={RUN_STATE} code={task.run.state} /> <Link to={PATHS.run(task.run.id)}>Open the run (totals, members and exceptions)</Link>
        </p>
      ) : (
        <p className="hint">The run is not available in the selected role’s scope.</p>
      )}
      {task.step === 'COVER' && <p className="hint">Covering approval: a decider’s own record in this run needs a further, independent approver.</p>}
      <label htmlFor={reasonId}>
        Reason (needed to return)
        <textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
      </label>
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <button type="button" disabled={decide.isPending} onClick={() => send('APPROVE')}>
          Approve
        </button>
        <button type="button" className="secondary" disabled={decide.isPending} onClick={() => send('RETURN')}>
          Return to a new revision
        </button>
      </div>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <Problem error={decide.error} act="run-decision" />
    </li>
  );
}

function RunReviewQueue() {
  return <RunTaskQueue steps={['REVIEW']} permission={RUN_REVIEW} title="Payroll run reviews" />;
}
function RunApprovalQueue() {
  return <RunTaskQueue steps={['APPROVAL', 'COVER']} permission={RUN_APPROVE} title="Payroll run approvals" />;
}

function RunDecisionsScreen() {
  const { can } = useSession();
  if (!can(RUN_REVIEW) && !can(RUN_APPROVE)) {
    return (
      <Section title="Payroll run decisions">
        <Empty>The selected role does not review or approve payroll runs.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      <RunReviewQueue />
      <RunApprovalQueue />
    </div>
  );
}

// =========================================================================================================
// Loans and advances (HR)
// =========================================================================================================

const LOAN_FILTERS = ['REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLED', 'DISBURSED', 'CLOSED'];

function LoansScreen() {
  const { can } = useSession();
  if (!can(LOAN_READ)) {
    return (
      <Section title="Loans and advances">
        <Empty>The selected role cannot see loans and advances.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      {can(LOAN_DECIDE) && <LoanDecisionQueue />}
      {can(LOAN_REQUEST) && <LoanRequestFor />}
      <LoanList />
    </div>
  );
}

function LoanList() {
  const keys = useKeys();
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  // FR-056: one page at a time; `total` counts every loan in scope.
  const loans = useQuery({
    queryKey: [...keys.loans(state), page],
    queryFn: () => api<{ items: Loan[]; total?: number }>(`/v1/payroll-outputs/loans?${state ? `state=${encodeURIComponent(state)}&` : ''}${pageParams(page)}`),
    retry: retryTransient,
  });
  return (
    <Section
      title="Loans and advances"
      actions={
        <label className="inline">
          State
          <select
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {LOAN_FILTERS.map((s) => (
              <option key={s} value={s}>
                {label(LOAN_STATE, s)}
              </option>
            ))}
          </select>
        </label>
      }
    >
      {loans.isPending && <p className="hint">Loading loans…</p>}
      {loans.error && <Problem error={loans.error} act="read" />}
      {loans.data && loans.data.items.length === 0 && <Empty>No loans or advances in the selected role’s scope.</Empty>}
      {loans.data && loans.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Loans and advances">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Kind</th>
                <th>Principal</th>
                <th>State</th>
                <th>Requested</th>
                <th>Recovery head</th>
                <th>Recovered</th>
                <th>Outstanding</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {loans.data.items.map((l) => (
                <tr key={l.id}>
                  <td>{l.employeeCode}</td>
                  <td>{label(LOAN_KIND, l.loanKind)}</td>
                  <td>{money(l.principal, l.currencyCode)}</td>
                  <td>
                    <Status map={LOAN_STATE} code={l.state} />
                  </td>
                  <td>{formatDate(l.requestedAt)}</td>
                  <td>{l.recoveryHead ?? '—'}</td>
                  <td>{money(l.recovered, l.currencyCode)}</td>
                  <td>{money(l.outstanding, l.currencyCode)}</td>
                  <td>
                    <button type="button" className="link" onClick={() => setOpenId(openId === l.id ? null : l.id)} aria-label={`Details of the loan of ${l.employeeCode}`}>
                      {openId === l.id ? 'Hide' : 'Details'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {loans.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={loans.data.total ?? loans.data.items.length} onPage={setPage} label="Loan pages" noun="loan" />}
      {openId && <LoanDetail id={openId} />}
    </Section>
  );
}

function LoanDetail({ id }: { id: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const [note, setNote] = useState<string | null>(null);
  const loan = useQuery({ queryKey: keys.loan(id), queryFn: () => api<Loan>(`/v1/payroll-outputs/loans/${encodeURIComponent(id)}`), retry: retryTransient });
  const l = loan.data;
  if (loan.isPending) return <p className="hint">Loading the loan…</p>;
  if (!l) return <Problem error={loan.error} act="read" />;
  const name = `${label(LOAN_KIND, l.loanKind)} of ${l.employeeCode}`;
  return (
    <div role="region" aria-label={name}>
      <h3 style={H3}>{name}</h3>
      <dl className="kv">
        <Fact term="Purpose">{l.purpose}</Fact>
        {/[1-9]/.test(l.awaitingRecognition ?? '') && <Fact term="Deducted, not yet recognised">{money(l.awaitingRecognition!, l.currencyCode)}</Fact>}
        <Fact term="Requested by">{l.requestOrigin === 'EMPLOYEE' ? 'The employee' : 'HR, for the employee'}</Fact>
        {l.decidedAt && <Fact term="Decided">{formatDate(l.decidedAt)}</Fact>}
        {l.decisionReason && <Fact term="Decision reason">{l.decisionReason}</Fact>}
        {l.disbursementDate && <Fact term="Disbursed">{formatDate(l.disbursementDate)}</Fact>}
        {l.disbursementReference && <Fact term="Disbursement evidence">{l.disbursementReference}</Fact>}
        {l.closeReason && <Fact term="Close reason">{l.closeReason}</Fact>}
      </dl>
      <ScheduleTables loan={l} name={name} />
      {note && (
        <p role="status" className="ok">
          {note}
        </p>
      )}
      {l.state === 'APPROVED' && can(LOAN_DISBURSE) && <DisbursementForm loan={l} onDone={setNote} />}
      {l.state === 'APPROVED' && can(LOAN_DECIDE) && <LoanCancel loan={l} onDone={setNote} />}
    </div>
  );
}

function LoanDecisionQueue() {
  const { can } = useSession();
  const keys = useKeys();
  const [notes, setNotes] = useState<{ id: string; text: string }[]>([]);
  const [page, setPage] = useState(1);
  const pending = useQuery({
    queryKey: [...keys.loans('REQUESTED'), 'queue', page],
    queryFn: () => api<{ items: Loan[]; total?: number }>(`/v1/payroll-outputs/loans?state=REQUESTED&${pageParams(page)}`),
    enabled: can(LOAN_DECIDE) && can(LOAN_READ),
    retry: retryTransient,
  });
  if (!can(LOAN_DECIDE)) return null;
  if (!can(LOAN_READ)) {
    return (
      <Section title="Loan requests to decide">
        <p className="hint">The selected role cannot list loan requests.</p>
      </Section>
    );
  }
  return (
    <Section title="Loan requests to decide">
      <p className="hint">An approval fixes the recovery head and a schedule that recovers exactly the principal; neither changes afterwards. Loans carry no interest.</p>
      {pending.isPending && <p className="hint">Loading loan requests…</p>}
      {pending.error && <Problem error={pending.error} act="read" />}
      {notes.map((n) => (
        <p key={n.id} role="status" className="ok">
          {n.text}
        </p>
      ))}
      {pending.data && pending.data.items.length === 0 && <Empty>No loan request is waiting for a decision.</Empty>}
      {pending.data && pending.data.items.length > 0 && (
        <ul style={PLAIN_LIST} className="stack">
          {pending.data.items.map((l) => (
            <LoanDecisionItem key={l.id} loan={l} onFinished={(text) => setNotes((prev) => [...prev, { id: l.id, text }])} />
          ))}
        </ul>
      )}
      {pending.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={pending.data.total ?? pending.data.items.length} onPage={setPage} label="Loan request pages" noun="loan request" />}
    </Section>
  );
}

interface InstalmentDraft {
  id: number;
  dueMonth: string;
  amount: string;
}

function LoanDecisionItem({ loan, onFinished }: { loan: Loan; onFinished: (text: string) => void }) {
  const { me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const titleId = useId();
  const nextRow = useRef(1);
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [reason, setReason] = useState('');
  const [head, setHead] = useState('');
  const [rows, setRows] = useState<InstalmentDraft[]>([{ id: 0, dueMonth: '', amount: '' }]);
  const [problem, setProblem] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Loan>(`/v1/payroll-outputs/loans/${encodeURIComponent(loan.id)}/decision`, { body }),
    onSuccess: (r) => onFinished(`${loan.employeeCode}: ${r.state === 'APPROVED' ? 'approved with its recovery schedule; it is disbursed only from verified evidence by someone else' : 'rejected'}.`),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.loansAll }),
  });
  const own = loan.requestedBy === me?.userId;
  const beneficiary = !!me?.employeeId && me.employeeId === loan.employeeId;
  const blocked = own || beneficiary;
  const name = `${label(LOAN_KIND, loan.loanKind)} of ${loan.employeeCode}`;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (decide.isPending || blocked) return;
    const why = reason.trim();
    if (decision === 'REJECT') {
      if (!why) return setProblem('Give the reason for rejecting the request.');
      setProblem(null);
      decide.reset();
      return decide.mutate({ decision, reason: why, expectedVersion: loan.version });
    }
    const code = head.trim();
    if (!code) return setProblem('Name the recovery deduction head.');
    const list = rows.map((r) => ({ dueMonth: r.dueMonth.trim(), amount: r.amount.trim() }));
    if (list.length === 0) return setProblem('Add at least one instalment.');
    if (list.some((r) => !MONTH.test(r.dueMonth) || !MONEY.test(r.amount))) return setProblem('Give every instalment a due month and an amount such as 3000.00.');
    setProblem(null);
    decide.reset();
    decide.mutate({ decision, recoveryComponentCode: code, installments: list, expectedVersion: loan.version, ...(why ? { reason: why } : {}) });
  };
  return (
    <li aria-labelledby={titleId} className="card">
      <h3 id={titleId} style={H3}>
        {name}
      </h3>
      <dl className="kv">
        <Fact term="Principal">{money(loan.principal, loan.currencyCode)}</Fact>
        <Fact term="Purpose">{loan.purpose}</Fact>
        <Fact term="Requested">{`${formatDate(loan.requestedAt)} by ${loan.requestOrigin === 'EMPLOYEE' ? 'the employee' : 'HR'}`}</Fact>
      </dl>
      {own && <p className="hint">You entered this request, so someone else decides it.</p>}
      {beneficiary && <p className="hint">This is your own loan, so someone else decides it.</p>}
      <form onSubmit={submit} aria-label={`Decide ${name}`} className="stack" style={{ marginTop: '0.5rem' }}>
        <fieldset style={GROUP}>
          <legend>Decision</legend>
          <label className="check">
            <input type="radio" name={`${titleId}-decision`} checked={decision === 'APPROVE'} onChange={() => setDecision('APPROVE')} /> Approve
          </label>
          <label className="check">
            <input type="radio" name={`${titleId}-decision`} checked={decision === 'REJECT'} onChange={() => setDecision('REJECT')} /> Reject
          </label>
        </fieldset>
        {decision === 'APPROVE' && (
          <>
            <label>
              Recovery deduction head (code)
              <input value={head} onChange={(e) => setHead(e.target.value)} maxLength={40} autoComplete="off" />
            </label>
            <fieldset style={GROUP}>
              <legend>Instalments (they must recover exactly the principal)</legend>
              {rows.map((r, i) => (
                <div key={r.id} className="row" style={{ alignItems: 'flex-end' }}>
                  <label>
                    {`Instalment ${i + 1} due month`}
                    <input type="month" value={r.dueMonth} onChange={(e) => setRows(rows.map((x) => (x.id === r.id ? { ...x, dueMonth: e.target.value } : x)))} />
                  </label>
                  <label>
                    {`Instalment ${i + 1} amount`}
                    <input value={r.amount} onChange={(e) => setRows(rows.map((x) => (x.id === r.id ? { ...x, amount: e.target.value } : x)))} inputMode="decimal" autoComplete="off" />
                  </label>
                  {rows.length > 1 && (
                    <button type="button" className="secondary" onClick={() => setRows(rows.filter((x) => x.id !== r.id))} aria-label={`Remove instalment ${i + 1}`}>
                      Remove
                    </button>
                  )}
                </div>
              ))}
              <div className="row">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setRows([...rows, { id: nextRow.current, dueMonth: '', amount: '' }]);
                    nextRow.current += 1;
                  }}
                >
                  Add an instalment
                </button>
              </div>
            </fieldset>
          </>
        )}
        <label>
          {decision === 'REJECT' ? 'Reason' : 'Reason (optional)'}
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
        </label>
        <div className="row">
          <button type="submit" disabled={decide.isPending || blocked}>
            {decide.isPending ? 'Sending…' : 'Send the decision'}
          </button>
        </div>
      </form>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <Problem error={decide.error} act="loan-decide" />
    </li>
  );
}

// =========================================================================================================
// Salary holds and salary stops: decisions and release (proposals need verified evidence documents: not here)
// =========================================================================================================

const HOLD_READ = 'payroll_hold.read.hold';
const HOLD_DECIDE = 'payroll_hold.decide.hold';
const HOLD_RELEASE = 'payroll_hold.release.hold';
const STOP_READ = 'payroll_stop.read.hold';
const STOP_DECIDE = 'payroll_stop.decide.hold';
const STOP_PROPOSE = 'payroll_stop.propose.hold';
const HOLD_PROPOSE = 'payroll_hold.propose.hold';
const HOLD_DEFINE = 'payroll_hold.define_criterion.hold';
const HOLD_ACTIVATE = 'payroll_hold.activate_criterion.hold';

interface Hold {
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
interface HoldTotals {
  currencyCode: string;
  reserved: string;
  confirmed: string;
}
interface SalaryStop {
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

const HOLD_STATE: Record<string, string> = {
  PROPOSED: 'Proposed, waiting for a decision',
  APPROVED_ACTIVE: 'Active: payment withheld',
  EXPIRED_REVIEW: 'Review date passed: still withheld, needs review',
  RELEASED: 'Released',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};
const HOLD_KIND: Record<string, string> = { POLICY_HOLD: 'Salary hold', PAYMENT_SAFETY_BLOCK: 'Bank safety block' };
const STOP_MODE: Record<string, string> = { HOLD_DISBURSEMENT: 'Withhold payment (calculated, not paid)', EXCLUDE_CALCULATION: 'Leave out of the calculation' };
const STOP_STATE: Record<string, string> = { SUBMITTED: 'Waiting for a decision', APPROVED: 'Approved', APPLIED: 'Applied to the run', REJECTED: 'Rejected', WITHDRAWN: 'Withdrawn', REVOKED: 'Revoked' };

/** A task decision (approve or reject) with its idempotency key per intended decision; the reason is needed to reject. */
function TaskDecision({
  path,
  prefix,
  act,
  name,
  confirmMode,
  onDecided,
  onRefused,
}: {
  path: string;
  prefix: string;
  act: Act;
  name: string;
  confirmMode?: string;
  onDecided: (decision: 'APPROVE' | 'REJECT', result: { state: string; replayed: boolean }) => void;
  /** After a definite refusal (decided elsewhere, stale, out of scope) the queue is reloaded. */
  onRefused?: () => void;
}) {
  const reasonId = useId();
  const intent = useIntentKey(prefix);
  const [reason, setReason] = useState('');
  const [modeConfirmed, setModeConfirmed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ state: string; replayed: boolean }>(path, { body }),
    onSettled: (_d, error) => {
      intent.settle(error);
      if (error instanceof ApiError) onRefused?.();
    },
    onSuccess: (r, body) => onDecided(body.decision as 'APPROVE' | 'REJECT', r),
  });
  const send = (decision: 'APPROVE' | 'REJECT') => {
    if (decide.isPending) return;
    const text = reason.trim();
    if (decision === 'REJECT' && !text) return setProblem('Give the reason for rejecting.');
    if (decision === 'APPROVE' && confirmMode && !modeConfirmed) return setProblem('Confirm the stop mode you approve.');
    setProblem(null);
    decide.reset();
    const mode = decision === 'APPROVE' && confirmMode ? confirmMode : undefined;
    const key = intent.key(`${decision}|${text}|${mode ?? ''}`);
    decide.mutate({ decision, idempotencyKey: key, ...(text ? { reason: text } : {}), ...(mode ? { confirmMode: mode } : {}) });
  };
  return (
    <div className="stack" style={{ marginTop: '0.5rem' }}>
      {confirmMode && (
        <label className="check">
          <input type="checkbox" checked={modeConfirmed} onChange={(e) => setModeConfirmed(e.target.checked)} /> {`I approve the mode: ${label(STOP_MODE, confirmMode)}`}
        </label>
      )}
      <label htmlFor={reasonId}>
        Reason (needed to reject)
        <textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
      </label>
      <div className="row">
        <button type="button" disabled={decide.isPending} onClick={() => send('APPROVE')} aria-label={`Approve ${name}`}>
          Approve
        </button>
        <button type="button" className="secondary" disabled={decide.isPending} onClick={() => send('REJECT')} aria-label={`Reject ${name}`}>
          Reject
        </button>
      </div>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <Problem error={decide.error} act={act} />
    </div>
  );
}

function HoldDecisionQueue() {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [notes, setNotes] = useState<{ id: string; text: string }[]>([]);
  const tasks = useQuery({
    queryKey: keys.holdTasks,
    queryFn: () => api<{ items: { taskId: string; hold: Hold | null }[] }>('/v1/payroll/holds/tasks/mine'),
    enabled: can(HOLD_DECIDE) && can(HOLD_READ),
    retry: retryTransient,
  });
  if (!can(HOLD_DECIDE)) return null;
  if (!can(HOLD_READ)) {
    return (
      <Section title="Salary holds to decide">
        <p className="hint">The selected role cannot list salary holds.</p>
      </Section>
    );
  }
  const refresh = () => qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith('payroll-hold') });
  return (
    <Section title="Salary holds to decide">
      {tasks.isPending && <p className="hint">Loading your tasks…</p>}
      {tasks.error && <Problem error={tasks.error} act="read" />}
      {notes.map((n) => (
        <p key={n.id} role="status" className="ok">
          {n.text}
        </p>
      ))}
      {tasks.data && tasks.data.items.length === 0 && <Empty>No salary hold is waiting for you.</Empty>}
      {tasks.data && tasks.data.items.length > 0 && (
        <ul style={PLAIN_LIST} className="stack">
          {tasks.data.items.map(({ taskId, hold: h }) => {
            const name = h ? `${label(HOLD_KIND, h.holdKind)} of ${h.employeeCode} for ${h.periodCode}` : 'Salary hold';
            return (
              <li key={taskId} aria-label={name} className="card">
                <h3 style={H3}>{name}</h3>
                <DelegatedBadge taskId={taskId} />
                {h ? (
                  <dl className="kv">
                    <Fact term="Scope">{h.scope === 'PARTIAL' ? `Partial: ${money(h.holdAmount, h.currencyCode)}` : 'Full net pay'}</Fact>
                    {h.criterionCode && <Fact term="Criterion">{h.criterionCode}</Fact>}
                    {h.reason && <Fact term="Reason">{h.reason}</Fact>}
                    <Fact term="Review due">{formatDate(h.reviewDueOn)}</Fact>
                    {h.releaseCriterion && <Fact term="Release criterion">{h.releaseCriterion}</Fact>}
                  </dl>
                ) : (
                  <p className="hint">The hold is not available in the selected role’s scope.</p>
                )}
                {h !== null && h.proposedBy === me?.userId ? (
                  <p className="hint">You proposed this hold, so someone else decides it.</p>
                ) : (
                  <TaskDecision
                    path={`/v1/payroll/hold-tasks/${encodeURIComponent(taskId)}/decision`}
                    prefix="payroll-hold-decision"
                    act="hold-decide"
                    name={name}
                    onRefused={() => void refresh()}
                    onDecided={(decision, r) => {
                      setNotes((prev) => [
                        ...prev,
                        { id: taskId, text: r.replayed ? `${name}: this decision had already been recorded; nothing was applied twice.` : `${name}: ${decision === 'APPROVE' ? 'approved; the payment is withheld' : 'rejected; nothing is withheld'}.` },
                      ]);
                      void refresh();
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function StopDecisionQueue() {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [notes, setNotes] = useState<{ id: string; text: string }[]>([]);
  const tasks = useQuery({
    queryKey: keys.stopTasks,
    queryFn: () => api<{ items: { taskId: string; stop: SalaryStop | null }[] }>('/v1/payroll/salary-stops/tasks/mine'),
    enabled: can(STOP_DECIDE) && can(STOP_READ),
    retry: retryTransient,
  });
  if (!can(STOP_DECIDE)) return null;
  if (!can(STOP_READ)) {
    return (
      <Section title="Salary stops to decide">
        <p className="hint">The selected role cannot list salary stops.</p>
      </Section>
    );
  }
  const refresh = () => qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith('payroll-stop') });
  return (
    <Section title="Salary stops to decide">
      {tasks.isPending && <p className="hint">Loading your tasks…</p>}
      {tasks.error && <Problem error={tasks.error} act="read" />}
      {notes.map((n) => (
        <p key={n.id} role="status" className="ok">
          {n.text}
        </p>
      ))}
      {tasks.data && tasks.data.items.length === 0 && <Empty>No salary stop is waiting for you.</Empty>}
      {tasks.data && tasks.data.items.length > 0 && (
        <ul style={PLAIN_LIST} className="stack">
          {tasks.data.items.map(({ taskId, stop: s }) => {
            const name = s ? `Salary stop of ${s.employeeCode} for ${s.periodCode}` : 'Salary stop';
            return (
              <li key={taskId} aria-label={name} className="card">
                <h3 style={H3}>{name}</h3>
                <DelegatedBadge taskId={taskId} />
                {s ? (
                  <dl className="kv">
                    <Fact term="Mode">{label(STOP_MODE, s.mode)}</Fact>
                    {s.criterionCode && <Fact term="Criterion">{s.criterionCode}</Fact>}
                    <Fact term="Reason">{s.reason}</Fact>
                    {s.releaseCriterion && <Fact term="Release criterion">{s.releaseCriterion}</Fact>}
                    {s.evidenceReference && <Fact term="Evidence">{s.evidenceReference}</Fact>}
                  </dl>
                ) : (
                  <p className="hint">The salary stop is not available in the selected role’s scope.</p>
                )}
                {s && s.proposedBy === me?.userId ? (
                  <p className="hint">You proposed this salary stop, so someone else decides it.</p>
                ) : (
                  <TaskDecision
                    path={`/v1/payroll/stop-tasks/${encodeURIComponent(taskId)}/decision`}
                    prefix="payroll-stop-decision"
                    act="hold-decide"
                    name={name}
                    onRefused={() => void refresh()}
                    {...(s ? { confirmMode: s.mode } : {})}
                    onDecided={(decision, r) => {
                      setNotes((prev) => [
                        ...prev,
                        { id: taskId, text: r.replayed ? `${name}: this decision had already been recorded; nothing was applied twice.` : `${name}: ${decision === 'APPROVE' ? 'approved' : 'rejected'}.` },
                      ]);
                      void refresh();
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

const HOLD_FILTERS = ['PROPOSED', 'APPROVED_ACTIVE', 'EXPIRED_REVIEW', 'RELEASED', 'REJECTED', 'WITHDRAWN'];

function HoldList() {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [state, setState] = useState('');
  const [acting, setActing] = useState<{ hold: Hold; action: 'release' | 'withdraw' | 'renew' | 'details' } | null>(null);
  const releasing = acting?.action === 'release' ? acting.hold : null;
  const [note, setNote] = useState<string | null>(null);
  const open = (hold: Hold, action: 'release' | 'withdraw' | 'renew' | 'details') => {
    setNote(null);
    setActing(acting?.hold.id === hold.id && acting.action === action ? null : { hold, action });
  };
  const done = (text: string) => {
    setActing(null);
    setNote(text);
    void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith('payroll-hold') });
  };
  const [page, setPage] = useState(1);
  // FR-056: one page at a time; `total` counts every hold in scope. H7 totals (per currency, every matching hold, under
  // the hold amount grant) come with each page.
  const holds = useQuery({
    queryKey: [...keys.holds(state), page],
    queryFn: () => api<{ items: Hold[]; total?: number; totals?: HoldTotals[] }>(`/v1/payroll/holds?${state ? `state=${encodeURIComponent(state)}&` : ''}${pageParams(page)}`),
    retry: retryTransient,
  });
  return (
    <Section
      title="Salary holds"
      actions={
        <label className="inline">
          State
          <select
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {HOLD_FILTERS.map((s) => (
              <option key={s} value={s}>
                {label(HOLD_STATE, s)}
              </option>
            ))}
          </select>
        </label>
      }
    >
      <p className="hint">
        A hold withholds payment of earned salary; it never reduces what was earned. A released amount is paid only through a new manifest and a confirmed outcome. A hold is proposed from the member list of a processed payroll run.
      </p>
      {holds.isPending && <p className="hint">Loading holds…</p>}
      {holds.error && <Problem error={holds.error} act="read" />}
      {note && (
        <p role="status" className="ok">
          {note}
        </p>
      )}
      {holds.data && holds.data.items.length === 0 && <Empty>No salary holds in the selected role’s scope.</Empty>}
      {holds.data && holds.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Salary holds">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Period</th>
                <th>Kind</th>
                <th>Held</th>
                <th>State</th>
                <th>Review due</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {holds.data.items.map((h) => {
                const live = h.state === 'APPROVED_ACTIVE' || h.state === 'EXPIRED_REVIEW';
                const maker = h.proposedBy === me?.userId;
                const of = `${h.employeeCode} for ${h.periodCode}`;
                return (
                  <tr key={h.id}>
                    <td>{`${h.employeeCode} ${h.employeeName}`}</td>
                    <td>{`${h.periodCode} revision ${h.runRevision}`}</td>
                    <td>{label(HOLD_KIND, h.holdKind)}</td>
                    <td>{h.scope === 'PARTIAL' ? money(h.holdAmount, h.currencyCode) : 'Full net pay'}</td>
                    <td>
                      <Status map={HOLD_STATE} code={h.state} />
                    </td>
                    <td>{formatDate(h.reviewDueOn)}</td>
                    <td>
                      <div className="row">
                        <button type="button" className="link" onClick={() => open(h, 'details')} aria-label={`Details of the hold of ${of}`}>
                          Details
                        </button>
                        {live && can(HOLD_RELEASE) && (
                          <button type="button" className="link" onClick={() => open(h, 'release')} aria-label={`Release the hold of ${of}`}>
                            Release
                          </button>
                        )}
                        {h.state === 'PROPOSED' && maker && can(HOLD_PROPOSE) && (
                          <button type="button" className="link" onClick={() => open(h, 'withdraw')} aria-label={`Withdraw the hold proposal of ${of}`}>
                            Withdraw
                          </button>
                        )}
                        {h.state === 'EXPIRED_REVIEW' && h.holdKind === 'POLICY_HOLD' && can(HOLD_DECIDE) && (
                          <button type="button" className="link" onClick={() => open(h, 'renew')} aria-label={`Renew the review of the hold of ${of}`}>
                            Renew review
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {holds.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={holds.data.total ?? holds.data.items.length} onPage={setPage} label="Hold pages" noun="hold" />}
      {holds.data?.totals && holds.data.totals.length > 0 && (
        <>
          <p className="hint">
            Totals of every hold matching the filter, on all pages: what the payment allocations of released holds have reserved, and what the bank confirmed paid less reversals.
          </p>
          {holds.data.totals.map((t) => (
            <dl key={t.currencyCode} className="kv" aria-label={`Hold totals in ${t.currencyCode}`}>
              <Fact term="Reserved for payment, not paid">{money(t.reserved, t.currencyCode)}</Fact>
              <Fact term="Paid (confirmed from bank evidence)">{money(t.confirmed, t.currencyCode)}</Fact>
            </dl>
          ))}
        </>
      )}
      {releasing &&<ReleaseForm key={releasing.id} hold={releasing} maker={releasing.holdKind !== 'PAYMENT_SAFETY_BLOCK' && releasing.proposedBy === me?.userId} onDone={done} />}
      {acting?.action === 'details' && <HoldDetailView key={acting.hold.id} id={acting.hold.id} />}
      {acting?.action === 'withdraw' && <HoldWithdraw key={acting.hold.id} hold={acting.hold} onDone={done} />}
      {acting?.action === 'renew' && <HoldRenew key={acting.hold.id} hold={acting.hold} maker={acting.hold.proposedBy === me?.userId} onDone={done} />}
    </Section>
  );
}

function ReleaseForm({ hold, maker, onDone }: { hold: Hold; maker: boolean; onDone: (text: string) => void }) {
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const release = useMutation({
    mutationFn: (body: { reason: string; evidenceReference: string; expectedVersion: number }) => api<Hold>(`/v1/payroll/holds/${encodeURIComponent(hold.id)}/release`, { body }),
    onSuccess: () => onDone(`The hold of ${hold.employeeCode} was released. The amount becomes payable through a new manifest; it is not paid until a confirmed outcome.`),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (release.isPending || maker) return;
    const why = reason.trim();
    const ref = evidence.trim();
    if (!why) return setProblem('Give the reason for the release.');
    if (!ref) return setProblem('Give the evidence reference for the release.');
    setProblem(null);
    release.reset();
    release.mutate({ reason: why, evidenceReference: ref, expectedVersion: hold.version });
  };
  const name = `Release the hold of ${hold.employeeCode}`;
  return (
    <form onSubmit={submit} aria-label={name} className="grid-form" style={{ marginTop: '0.5rem' }}>
      {maker && <p className="hint wide">You proposed this hold, so someone else releases it.</p>}
      <label className="wide">
        Reason for the release
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
      </label>
      <label>
        Evidence reference
        <input value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={500} autoComplete="off" />
      </label>
      <div className="row">
        <button type="submit" disabled={release.isPending || maker}>
          {release.isPending ? 'Releasing…' : 'Release the hold'}
        </button>
      </div>
      {problem && (
        <p role="alert" className="error wide">
          {problem}
        </p>
      )}
      <div className="wide">
        <Problem error={release.error} act="hold-release" />
      </div>
    </form>
  );
}

function StopList() {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [acting, setActing] = useState<{ stop: SalaryStop; action: 'withdraw' | 'revoke' } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  // FR-056: one page at a time; `total` counts every salary stop in scope.
  const stops = useQuery({
    queryKey: [...keys.stops, page],
    queryFn: () => api<{ items: SalaryStop[]; total?: number }>(`/v1/payroll/salary-stops?${pageParams(page)}`),
    retry: retryTransient,
  });
  const change = useMutation({
    mutationFn: ({ stop: s, action, reason }: { stop: SalaryStop; action: 'withdraw' | 'revoke'; reason: string }) =>
      api<SalaryStop>(`/v1/payroll/salary-stops/${encodeURIComponent(s.id)}/${action}`, { body: action === 'withdraw' ? { reason } : { reason, expectedVersion: s.version } }),
    onSuccess: (s, { action }) => {
      setActing(null);
      setNote(action === 'withdraw' ? `The salary stop proposal of ${s.employeeCode} was withdrawn.` : `The salary stop of ${s.employeeCode} was revoked: the next calculation pays the employee as usual.`);
    },
    onSettled: () => qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith('payroll-stop') }),
  });
  /** What the selected role may do with a stop: withdraw its own proposal, or revoke an approved stop it did not make. */
  const actionOf = (s: SalaryStop): 'withdraw' | 'revoke' | null =>
    s.state === 'SUBMITTED' && s.proposedBy === me?.userId && can(STOP_PROPOSE) ? 'withdraw' : s.state === 'APPROVED' && s.proposedBy !== me?.userId && can(STOP_DECIDE) ? 'revoke' : null;
  const withActions = (stops.data?.items ?? []).some((s) => actionOf(s) !== null);
  return (
    <Section title="Salary stops">
      {stops.isPending && <p className="hint">Loading salary stops…</p>}
      {stops.error && <Problem error={stops.error} act="read" />}
      {note && (
        <p role="status" className="ok">
          {note}
        </p>
      )}
      {stops.data && stops.data.items.length === 0 && <Empty>No salary stops in the selected role’s scope.</Empty>}
      {stops.data && stops.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Salary stops">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Period</th>
                <th>Mode</th>
                <th>State</th>
                <th>Decided</th>
                {withActions && <th>Change</th>}
              </tr>
            </thead>
            <tbody>
              {stops.data.items.map((s) => {
                const action = actionOf(s);
                return (
                  <tr key={s.id}>
                    <td>{`${s.employeeCode} ${s.employeeName}`}</td>
                    <td>{s.periodCode}</td>
                    <td>{label(STOP_MODE, s.approvedMode ?? s.mode)}</td>
                    <td>
                      <Status map={STOP_STATE} code={s.state} />
                    </td>
                    <td>{formatDate(s.decidedAt)}</td>
                    {withActions && (
                      <td>
                        {action ? (
                          <button
                            type="button"
                            className="link"
                            disabled={change.isPending}
                            onClick={() => {
                              change.reset();
                              setNote(null);
                              setActing({ stop: s, action });
                            }}
                            aria-label={`${action === 'withdraw' ? 'Withdraw' : 'Revoke'} the salary stop of ${s.employeeCode} for ${s.periodCode}`}
                          >
                            {action === 'withdraw' ? 'Withdraw' : 'Revoke'}
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {stops.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={stops.data.total ?? stops.data.items.length} onPage={setPage} label="Salary stop pages" noun="salary stop" />}
      {acting && (
        <ReasonForm
          key={`${acting.stop.id}:${acting.action}`}
          name={`${acting.action === 'withdraw' ? 'Withdraw' : 'Revoke'} the salary stop of ${acting.stop.employeeCode}`}
          field={acting.action === 'withdraw' ? 'Why the proposal is withdrawn' : 'Why the approved stop is revoked'}
          button={acting.action === 'withdraw' ? 'Withdraw the proposal' : 'Revoke the salary stop'}
          busy={change.isPending}
          danger={acting.action === 'revoke'}
          onSend={(reason) => change.mutateAsync({ stop: acting.stop, action: acting.action, reason })}
        />
      )}
      <Problem error={change.error} act="stop-act" />
    </Section>
  );
}

function HoldsScreen() {
  const { can } = useSession();
  if (!can(HOLD_READ) && !can(STOP_READ) && !can(STOP_PROPOSE)) {
    return (
      <Section title="Salary holds and stops">
        <Empty>The selected role cannot see salary holds or salary stops.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      {can(HOLD_DECIDE) && <HoldDecisionQueue />}
      {can(HOLD_READ) && <HoldList />}
      {can(HOLD_READ) && <HoldCriteriaSection />}
      {can(STOP_DECIDE) && <StopDecisionQueue />}
      {can(STOP_PROPOSE) && <StopProposalForm />}
      {can(STOP_READ) && <StopList />}
    </div>
  );
}

// =========================================================================================================
// Shared choices: payroll period, employee, evidence documents
// =========================================================================================================

/** Query filter for every cached answer whose key starts with the prefix (any role context of this session). */
const byPrefix = (prefix: string) => ({ predicate: (q: { queryKey: readonly unknown[] }) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith(prefix) });

interface PeriodChoice {
  periodId: string;
  periodCode: string;
  currencyCode: string;
}

/** A period of an active payroll calendar (the calendars need the configuration read duty). */
function PeriodPicker({ value, onChange, purpose }: { value: PeriodChoice | null; onChange: (p: PeriodChoice | null) => void; purpose: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const [calendarId, setCalendarId] = useState('');
  const calendars = useQuery({ queryKey: keys.calendars, queryFn: () => api<{ items: Calendar[] }>('/v1/payroll/calendars'), enabled: can(CONFIG_READ), retry: retryTransient });
  if (!can(CONFIG_READ)) return <p className="hint wide">{`The selected role cannot list payroll calendars, so it cannot choose the period ${purpose}.`}</p>;
  const active = (calendars.data?.items ?? []).filter((c) => c.state === 'ACTIVE');
  const calendar = active.find((c) => c.id === calendarId);
  return (
    <>
      {calendars.error && (
        <div className="wide">
          <Problem error={calendars.error} act="read" />
        </div>
      )}
      <label>
        Payroll calendar
        <select
          value={calendarId}
          onChange={(e) => {
            setCalendarId(e.target.value);
            onChange(null);
          }}
        >
          <option value="">Choose a calendar</option>
          {active.map((c) => (
            <option key={c.id} value={c.id}>
              {`${c.code} · ${c.name} (${c.currencyCode})`}
            </option>
          ))}
        </select>
      </label>
      <label>
        Period
        <select
          value={value?.periodId ?? ''}
          disabled={!calendar}
          onChange={(e) => {
            const p = calendar?.periods.find((x) => x.id === e.target.value);
            onChange(p && calendar ? { periodId: p.id, periodCode: p.periodCode, currencyCode: calendar.currencyCode } : null);
          }}
        >
          <option value="">Choose a period</option>
          {(calendar?.periods ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {`${p.periodCode} (${formatDate(p.serviceStart)} to ${formatDate(p.serviceEnd)})`}
            </option>
          ))}
        </select>
      </label>
      {calendars.data && active.length === 0 && <p className="hint wide">No payroll calendar is active yet.</p>}
    </>
  );
}

interface EmployeeHit {
  id: string;
  employeeCode: string;
  displayName: string;
  status: string;
}
const person = (e: { employeeCode: string; displayName: string }) => `${e.employeeCode} ${e.displayName}`;

/** An employee found by the employee search (row scope, status and one's own record are checked by the server). */
function EmployeePicker({ title, value, onChange }: { title: string; value: EmployeeHit | null; onChange: (e: EmployeeHit | null) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const hits = useQuery({
    queryKey: keys.employeeSearch(term),
    queryFn: () => api<{ items: EmployeeHit[] }>(`/v1/employees?${new URLSearchParams({ search: term, page: '1', pageSize: '25' }).toString()}`),
    enabled: can(EMPLOYEE_LIST) && term !== '',
    retry: retryTransient,
  });
  if (!can(EMPLOYEE_LIST)) return <p className="hint wide">The selected role cannot search employees, so it cannot choose the employee here.</p>;
  return (
    <div className="wide">
      {value !== null && (
        <p style={FLUSH}>
          {`${title}: `}
          <strong>{person(value)}</strong>{' '}
          <button type="button" className="secondary" onClick={() => onChange(null)} aria-label={`Clear the ${title.toLowerCase()}`}>
            Clear
          </button>
        </p>
      )}
      <label>
        {`Find the ${title.toLowerCase()}`}
        <input type="search" value={search} maxLength={100} placeholder="Name, employee code or work email" onChange={(e) => setSearch(e.target.value)} />
      </label>
      {term !== '' && hits.isLoading && <p className="hint">Searching…</p>}
      {hits.error && <Problem error={hits.error} act="read" />}
      {term !== '' && hits.data && hits.data.items.length === 0 && <Empty>{`No employees match “${term}”.`}</Empty>}
      {term !== '' && hits.data && hits.data.items.length > 0 && (
        <ul className="choices" aria-label="Matching employees">
          {hits.data.items.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                aria-label={`Choose ${person(e)}`}
                onClick={() => {
                  onChange(e);
                  setSearch('');
                  setTerm('');
                }}
              >
                {`${person(e)} · ${readable(e.status).toLowerCase()}`}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface EvidenceDocument {
  id: string;
  documentType: string;
  fileName: string | null;
  uploadedAt: string;
  scanState: string | null;
  verificationState: string;
}
/** Evidence must be released by the malware scan and verified by an independent reviewer (the API refuses anything else). */
const usableEvidence = (d: EvidenceDocument) => d.scanState === 'CLEAN' && d.verificationState === 'VERIFIED';
function evidenceState(d: EvidenceDocument): string {
  if (d.scanState === 'QUARANTINED') return 'quarantined by the malware scan, not usable';
  if (d.scanState !== 'CLEAN') return 'waiting for the malware scan, not usable yet';
  if (d.verificationState === 'VERIFIED') return 'released and verified';
  if (d.verificationState === 'REJECTED') return 'rejected by the verifier, not usable';
  return 'released, not verified yet, not usable';
}

/** The employee's own documents as evidence: only released and verified ones can be chosen; the files are not opened here. */
function EvidencePicker({ employeeId, chosen, onChange, max }: { employeeId: string; chosen: string[]; onChange: (ids: string[]) => void; max: number }) {
  const { can } = useSession();
  const keys = useKeys();
  const name = useId();
  const docs = useQuery({
    queryKey: keys.documents(employeeId),
    queryFn: () => api<{ items: EvidenceDocument[] }>(`/v1/employees/${encodeURIComponent(employeeId)}/documents`),
    enabled: can(DOCUMENT_READ),
    retry: retryTransient,
  });
  if (!can(DOCUMENT_READ)) return <p className="hint wide">The selected role cannot list the employee’s documents, so it cannot choose the evidence here.</p>;
  return (
    <fieldset className="wide" style={GROUP}>
      <legend>{max === 1 ? 'Evidence document (released and verified)' : `Evidence documents (released and verified, at most ${max})`}</legend>
      {docs.isPending && <p className="hint">Loading the employee’s documents…</p>}
      {docs.error && <Problem error={docs.error} act="read" />}
      {docs.data && docs.data.items.length === 0 && <p className="hint">The employee has no documents yet: add the evidence to their record and have it verified first.</p>}
      {docs.data?.items.map((d) => {
        const picked = chosen.includes(d.id);
        return (
          <label key={d.id} className="check">
            <input
              type={max === 1 ? 'radio' : 'checkbox'}
              name={name}
              checked={picked}
              disabled={!usableEvidence(d) || (!picked && max > 1 && chosen.length >= max)}
              onChange={(e) => onChange(max === 1 ? [d.id] : e.target.checked ? [...chosen, d.id] : chosen.filter((x) => x !== d.id))}
            />{' '}
            {`${readable(d.documentType)}${d.fileName ? ` · ${d.fileName}` : ''} (${formatDate(d.uploadedAt)}): ${evidenceState(d)}`}
          </label>
        );
      })}
    </fieldset>
  );
}

function Note({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="status" className="ok">
      {text}
    </p>
  );
}

function Missing({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="error wide">
      {text}
    </p>
  );
}

// =========================================================================================================
// Payroll inputs (FR-031): entry, upload with dry run, submission, independent approval, cancellation and the
// controlled reversal of approved lines (DF03)
// =========================================================================================================

interface InputBatch {
  id: string;
  periodId: string;
  periodCode: string;
  source: string;
  fileHash: string | null;
  lineCount: number;
  reversedLines?: number;
  state: string;
  preparedBy: string;
  submittedAt: string | null;
  decidedAt: string | null;
  createdAt: string;
  version: number;
}
interface InputLineRow {
  id: string;
  employeeCode: string;
  componentCode: string;
  inputKind: string;
  amount: string;
  currencyCode: string;
  effectiveDate: string;
  reference: string;
  state: string;
  consumedRecordId?: string | null;
  reversalReason?: string | null;
}
interface InputBatchDetail extends InputBatch {
  lines: InputLineRow[];
  scopeComplete: boolean;
  replayed?: boolean;
}
interface UploadResult {
  template: string;
  dryRun: boolean;
  total: number;
  accepted: number;
  rejected: number;
  applied: boolean;
  replayed: boolean;
  batchId: string | null;
  errors: { row: number; code: string }[];
}

const INPUT_STATE: Record<string, string> = {
  DRAFT: 'Draft, not submitted',
  SUBMITTED: 'Submitted, waiting for approval',
  APPROVED: 'Approved: used by the next calculation',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  REVERSED: 'Reversed: used by no calculation',
};
const INPUT_SOURCE: Record<string, string> = { ENTRY: 'Entered', UPLOAD: 'Uploaded file' };
const INPUT_FILTERS = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'];
const UPLOAD_HEADER = 'employee_code,component_code,input_kind,amount,currency_code,effective_date,reference';

function InputsScreen() {
  const { can } = useSession();
  if (!can(INPUT_READ) && !can(INPUT_PREPARE) && !can(INPUT_APPROVE)) {
    return (
      <Section title="Payroll inputs">
        <Empty>The selected role cannot see payroll inputs.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      {can(INPUT_APPROVE) && <InputDecisionQueue />}
      {can(INPUT_PREPARE) && <NewInputBatch />}
      {can(INPUT_READ) && <InputBatchList />}
    </div>
  );
}

function NewInputBatch() {
  const [period, setPeriod] = useState<PeriodChoice | null>(null);
  return (
    <Section title="Enter payroll inputs">
      <p className="hint">Inputs are entered for one period and approved by someone independent before a calculation uses them. Nothing is saved unless every line is valid.</p>
      <div className="grid-form" role="group" aria-label="Input period">
        <PeriodPicker value={period} onChange={setPeriod} purpose="of the inputs" />
      </div>
      {period && <InputEntryForm key={`entry-${period.periodId}`} period={period} />}
      {period && <InputUploadForm key={`upload-${period.periodId}`} period={period} />}
    </Section>
  );
}

interface DraftInput {
  key: number;
  employee: EmployeeHit;
  componentCode: string;
  inputKind: string;
  amount: string;
  effectiveDate: string;
  reference: string;
}

function InputEntryForm({ period }: { period: PeriodChoice }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const intent = useIntentKey('payroll-input-batch');
  const seq = useRef(0);
  const [lines, setLines] = useState<DraftInput[]>([]);
  const [employee, setEmployee] = useState<EmployeeHit | null>(null);
  const [componentCode, setComponentCode] = useState('');
  const [inputKind, setInputKind] = useState('');
  const [amount, setAmount] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [reference, setReference] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: { lines: Record<string, string>[]; idempotencyKey: string }) =>
      api<InputBatchDetail>(`/v1/payroll/periods/${encodeURIComponent(period.periodId)}/input-batches`, { body }),
    onSettled: (_d, error) => {
      intent.settle(error);
      void qc.invalidateQueries({ queryKey: keys.inputBatchesAll });
    },
    onSuccess: (b) => {
      setLines([]);
      setNote(
        b.replayed
          ? 'This batch had already been saved; nothing was saved twice.'
          : `Saved as a draft batch of ${b.lineCount} ${b.lineCount === 1 ? 'line' : 'lines'} for ${b.periodCode}. Submit it for an independent approval from the list of batches.`,
      );
    },
  });
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!employee) return setProblem('Choose the employee.');
    if (!componentCode.trim() || !inputKind.trim()) return setProblem('Give the pay component and the input kind.');
    if (!MONEY.test(amount.trim())) return setProblem('Enter the amount as a number with at most four decimals, for example 1500.00.');
    if (!effectiveDate) return setProblem('Give the effective date.');
    if (!reference.trim()) return setProblem('Give the reference of the line.');
    setProblem(null);
    seq.current += 1;
    setLines([...lines, { key: seq.current, employee, componentCode: componentCode.trim(), inputKind: inputKind.trim(), amount: amount.trim(), effectiveDate, reference: reference.trim() }]);
    setEmployee(null);
    setAmount('');
    setReference('');
  };
  const send = () => {
    if (save.isPending || lines.length === 0) return;
    const body = lines.map((l) => ({
      employeeId: l.employee.id,
      componentCode: l.componentCode,
      inputKind: l.inputKind,
      amount: l.amount,
      currencyCode: period.currencyCode,
      effectiveDate: l.effectiveDate,
      reference: l.reference,
    }));
    setNote(null);
    save.reset();
    save.mutate({ lines: body, idempotencyKey: intent.key(JSON.stringify([period.periodId, body])) });
  };
  return (
    <div className="stack" style={{ marginTop: '0.75rem' }}>
      <h3 style={H3}>{`Enter lines for ${period.periodCode}`}</h3>
      <form onSubmit={add} aria-label="Add an input line" className="grid-form">
        <EmployeePicker title="Employee" value={employee} onChange={setEmployee} />
        <label>
          Pay component code
          <input value={componentCode} onChange={(e) => setComponentCode(e.target.value)} maxLength={40} autoComplete="off" />
        </label>
        <label>
          Input kind
          <input value={inputKind} onChange={(e) => setInputKind(e.target.value)} maxLength={60} autoComplete="off" />
        </label>
        <label>
          {`Amount (${period.currencyCode})`}
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" maxLength={20} autoComplete="off" />
        </label>
        <label>
          Effective date
          <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
        </label>
        <label>
          Reference
          <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} autoComplete="off" />
        </label>
        <div className="row">
          <button type="submit" className="secondary">
            Add the line
          </button>
        </div>
        <Missing text={problem} />
      </form>
      {lines.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Lines to save">
            <thead>
              <tr>
                <th>Row</th>
                <th>Employee</th>
                <th>Component</th>
                <th>Kind</th>
                <th>Amount</th>
                <th>Effective</th>
                <th>Reference</th>
                <th>Remove</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.key}>
                  <td>{i + 1}</td>
                  <td>{person(l.employee)}</td>
                  <td>{l.componentCode}</td>
                  <td>{l.inputKind}</td>
                  <td>{money(l.amount, period.currencyCode)}</td>
                  <td>{formatDate(l.effectiveDate)}</td>
                  <td>{l.reference}</td>
                  <td>
                    <button type="button" className="link" disabled={save.isPending} onClick={() => setLines(lines.filter((x) => x.key !== l.key))} aria-label={`Remove row ${i + 1}`}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row">
        <button type="button" disabled={save.isPending || lines.length === 0} onClick={send}>
          {save.isPending ? 'Saving…' : 'Save the lines as a draft batch'}
        </button>
      </div>
      <Note text={note} />
      <Problem error={save.error} act="input" />
    </div>
  );
}

function InputUploadForm({ period }: { period: PeriodChoice }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const intent = useIntentKey('payroll-input-upload');
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dryRun, setDryRun] = useState(true);
  const [result, setResult] = useState<UploadResult | null>(null);
  const upload = useMutation({
    mutationFn: async ({ f, dry }: { f: File; dry: boolean }) => {
      const contentBase64 = await fileToBase64(f);
      const key = dry ? null : intent.key(`${period.periodId}|${f.name}|${f.size}|${f.lastModified}`);
      return api<UploadResult>(`/v1/payroll/periods/${encodeURIComponent(period.periodId)}/input-batches/upload`, { body: { contentBase64, dryRun: dry, ...(key ? { idempotencyKey: key } : {}) } });
    },
    onSettled: (_d, error, v) => {
      if (!v.dry) intent.settle(error);
      void qc.invalidateQueries({ queryKey: keys.inputBatchesAll });
    },
    onSuccess: (r) => {
      setResult(r);
      if (r.applied || r.replayed) {
        setFile(null);
        if (fileRef.current) fileRef.current.value = '';
      }
    },
  });
  const r = result;
  const summary = !r
    ? null
    : r.replayed
      ? 'This file is already a live batch of this period; nothing was saved twice.'
      : r.dryRun
        ? `Checked only, nothing was saved: ${r.total} rows, ${r.accepted} valid, ${r.rejected} refused.`
        : r.applied
          ? `Saved as a draft batch of ${r.accepted} rows. Submit it for an independent approval from the list of batches.`
          : `Nothing was saved: every row must be valid (${r.rejected} of ${r.total} rows refused).`;
  return (
    <form
      aria-label="Upload input lines"
      className="grid-form"
      style={{ marginTop: '0.75rem' }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!file || upload.isPending) return;
        setResult(null);
        upload.reset();
        upload.mutate({ f: file, dry: dryRun });
      }}
    >
      <h3 style={H3} className="wide">{`Upload lines for ${period.periodCode}`}</h3>
      <p className="hint wide">{`A CSV file with the PAYROLL_INPUTS_V1 header: ${UPLOAD_HEADER}. The server scans it for malware before reading it: a flagged file is quarantined and nothing is saved.`}</p>
      <div className="wide">
        <TemplateDownload base="/v1/payroll/input-batches" code="PAYROLL_INPUTS_V1" />
      </div>
      <label>
        CSV file
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> Check only (dry run: nothing is saved)
      </label>
      <div className="row">
        <button type="submit" disabled={!file || upload.isPending}>
          {upload.isPending ? 'Scanning and checking…' : dryRun ? 'Check the file' : 'Upload the file'}
        </button>
      </div>
      {summary && (
        <p role="status" className={r && (r.applied || r.replayed || (r.dryRun && r.rejected === 0)) ? 'ok wide' : 'error wide'}>
          {summary}
        </p>
      )}
      {r && r.errors.length > 0 && (
        <div className="wide" style={SCROLL}>
          <table aria-label="Rows refused">
            <thead>
              <tr>
                <th>Row</th>
                <th>Problem</th>
              </tr>
            </thead>
            <tbody>
              {r.errors.map((x) => (
                <tr key={`${x.row}:${x.code}`}>
                  <td>{x.row}</td>
                  <td>{label(ROW_TEXT, x.code)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="wide">
        <Problem error={upload.error} act="upload" />
      </div>
    </form>
  );
}

function InputBatchList() {
  const { me } = useSession();
  const keys = useKeys();
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  // FR-056: one page at a time; `total` counts every input batch the selected role may see.
  const batches = useQuery({
    queryKey: [...keys.inputBatches(state), page],
    queryFn: () => api<{ items: InputBatch[]; total?: number }>(`/v1/payroll/input-batches?${state ? `state=${encodeURIComponent(state)}&` : ''}${pageParams(page)}`),
    retry: retryTransient,
  });
  return (
    <Section
      title="Input batches"
      actions={
        <label className="inline">
          State
          <select
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {INPUT_FILTERS.map((s) => (
              <option key={s} value={s}>
                {label(INPUT_STATE, s)}
              </option>
            ))}
          </select>
        </label>
      }
    >
      {batches.isPending && <p className="hint">Loading input batches…</p>}
      {batches.error && <Problem error={batches.error} act="read" />}
      {batches.data && batches.data.items.length === 0 && <Empty>No input batches.</Empty>}
      {batches.data && batches.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Input batches">
            <thead>
              <tr>
                <th>Period</th>
                <th>Source</th>
                <th>Lines</th>
                <th>State</th>
                <th>Prepared by</th>
                <th>Created</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {batches.data.items.map((b) => (
                <tr key={b.id}>
                  <td>{b.periodCode}</td>
                  <td>{label(INPUT_SOURCE, b.source)}</td>
                  <td>{b.lineCount}</td>
                  <td>
                    <Status map={INPUT_STATE} code={b.state} />
                  </td>
                  <td>{b.preparedBy === me?.userId ? 'You' : 'Someone else'}</td>
                  <td>{formatDate(b.createdAt)}</td>
                  <td>
                    <button type="button" className="link" onClick={() => setOpenId(openId === b.id ? null : b.id)} aria-label={`Details of the ${b.periodCode} batch created ${formatDate(b.createdAt)}`}>
                      {openId === b.id ? 'Hide' : 'Details'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {batches.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={batches.data.total ?? batches.data.items.length} onPage={setPage} label="Input batch pages" noun="input batch" plural="input batches" />}
      {openId && <InputBatchView key={openId} id={openId} withActions />}
    </Section>
  );
}

function InputBatchView({ id, withActions }: { id: string; withActions: boolean }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const batch = useQuery({ queryKey: keys.inputBatch(id), queryFn: () => api<InputBatchDetail>(`/v1/payroll/input-batches/${encodeURIComponent(id)}`), retry: retryTransient });
  const act = useMutation({
    mutationFn: ({ action, body }: { action: 'submit' | 'cancel'; body: Record<string, unknown> }) => api<InputBatchDetail>(`/v1/payroll/input-batches/${encodeURIComponent(id)}/${action}`, { body }),
    onSuccess: (_b, { action }) => setNote(action === 'submit' ? 'Submitted for an independent approval.' : 'The batch was cancelled; none of its inputs is used.'),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.inputBatchesAll }),
  });
  const reverse = useMutation({
    mutationFn: (body: { inputIds: string[]; reason: string; expectedVersion: number }) => api<InputBatchDetail>(`/v1/payroll/input-batches/${encodeURIComponent(id)}/reverse`, { body }),
    onSuccess: (_b, { inputIds }) => {
      setSelected([]);
      setNote(`${inputIds.length === 1 ? '1 line was reversed' : `${inputIds.length} lines were reversed`}: no calculation uses ${inputIds.length === 1 ? 'it' : 'them'}, and a corrected line can be entered under the same reference.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.inputBatchesAll }),
  });
  const b = batch.data;
  if (batch.isPending) return <p className="hint">Loading the batch…</p>;
  if (!b) return <Problem error={batch.error} act="read" />;
  const name = `Input batch of ${b.periodCode}`;
  const mine = b.preparedBy === me?.userId;
  const open = b.state === 'DRAFT' || b.state === 'SUBMITTED';
  // DF03: an approver independent of the preparer reverses approved lines no processed run has used.
  const reversible = withActions && can(INPUT_APPROVE) && b.state === 'APPROVED' && !mine;
  const canReverse = (l: InputLineRow) => reversible && l.state === 'APPROVED' && !l.consumedRecordId;
  return (
    <div role="region" aria-label={name} style={{ marginTop: '0.5rem' }}>
      <h3 style={H3}>{name}</h3>
      <dl className="kv">
        <Fact term="State">
          <Status map={INPUT_STATE} code={b.state} />
        </Fact>
        <Fact term="Source">{label(INPUT_SOURCE, b.source)}</Fact>
        <Fact term="Lines">{b.lineCount}</Fact>
        {!!b.reversedLines && <Fact term="Reversed lines">{b.reversedLines}</Fact>}
        <Fact term="Submitted">{formatDate(b.submittedAt)}</Fact>
        <Fact term="Decided">{formatDate(b.decidedAt)}</Fact>
      </dl>
      {!b.scopeComplete && <p className="hint">Some lines of this batch are outside your scope or are your own, so they are not shown.</p>}
      {b.lines.length > 0 && (
        <div style={SCROLL}>
          <table aria-label={`Lines of the ${b.periodCode} batch`}>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Component</th>
                <th>Kind</th>
                <th>Amount</th>
                <th>Effective</th>
                <th>Reference</th>
                <th>State</th>
                {reversible && <th>Reverse</th>}
              </tr>
            </thead>
            <tbody>
              {b.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.employeeCode}</td>
                  <td>{l.componentCode}</td>
                  <td>{l.inputKind}</td>
                  <td>{money(l.amount, l.currencyCode)}</td>
                  <td>{formatDate(l.effectiveDate)}</td>
                  <td>{l.reference}</td>
                  <td>
                    {l.consumedRecordId ? 'Used by a processed run' : <Status map={INPUT_STATE} code={l.state} />}
                    {l.reversalReason && <div className="hint">{l.reversalReason}</div>}
                  </td>
                  {reversible && (
                    <td>
                      {canReverse(l) && (
                        <input
                          type="checkbox"
                          aria-label={`Reverse the line ${l.reference}`}
                          checked={selected.includes(l.id)}
                          onChange={(e) => setSelected(e.target.checked ? [...selected, l.id] : selected.filter((x) => x !== l.id))}
                        />
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {withActions && can(INPUT_APPROVE) && b.state === 'APPROVED' && mine && <p className="hint">You prepared this batch, so someone independent reverses its approved lines.</p>}
      {reversible && b.lines.some(canReverse) && (
        <ReasonForm
          name="Reverse the selected lines"
          field="Reason for reversing the lines"
          button="Reverse the selected lines"
          busy={reverse.isPending}
          disabled={selected.length === 0}
          danger
          onSend={(reason) => {
            setNote(null);
            return reverse.mutateAsync({ inputIds: selected, reason, expectedVersion: b.version });
          }}
        />
      )}
      {withActions && can(INPUT_PREPARE) && open && !mine && <p className="hint">Only its preparer submits or cancels this batch.</p>}
      {withActions && can(INPUT_PREPARE) && open && mine && (
        <div className="stack">
          {b.state === 'DRAFT' && (
            <div className="row">
              <button
                type="button"
                disabled={act.isPending}
                onClick={() => {
                  setNote(null);
                  act.mutate({ action: 'submit', body: { expectedVersion: b.version } });
                }}
              >
                {act.isPending && act.variables?.action === 'submit' ? 'Submitting…' : 'Submit for approval'}
              </button>
            </div>
          )}
          <ReasonForm
            name="Cancel this batch"
            field="Reason for cancelling the batch"
            button="Cancel this batch"
            busy={act.isPending}
            danger
            onSend={(reason) => {
              setNote(null);
              return act.mutateAsync({ action: 'cancel', body: { reason, expectedVersion: b.version } });
            }}
          />
        </div>
      )}
      <Note text={note} />
      <Problem error={act.error} act="input" />
      <Problem error={reverse.error} act="input-reverse" />
    </div>
  );
}

function InputDecisionQueue() {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [notes, setNotes] = useState<{ id: string; text: string }[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  const tasks = useQuery({
    queryKey: keys.inputTasks,
    queryFn: () => api<{ items: { taskId: string; batch: InputBatch | null }[] }>('/v1/payroll/input-batches/tasks/mine'),
    enabled: can(INPUT_APPROVE) && can(INPUT_READ),
    retry: retryTransient,
  });
  if (!can(INPUT_APPROVE)) return null;
  if (!can(INPUT_READ)) {
    return (
      <Section title="Payroll inputs to approve">
        <p className="hint">The selected role cannot list payroll input batches.</p>
      </Section>
    );
  }
  const refresh = () => qc.invalidateQueries(byPrefix('payroll-input'));
  return (
    <Section title="Payroll inputs to approve">
      <p className="hint">An approved batch is used by the next calculation of its period; a rejected one is never used.</p>
      {tasks.isPending && <p className="hint">Loading your tasks…</p>}
      {tasks.error && <Problem error={tasks.error} act="read" />}
      {notes.map((n) => (
        <Note key={n.id} text={n.text} />
      ))}
      {tasks.data && tasks.data.items.length === 0 && <Empty>No input batch is waiting for you.</Empty>}
      {tasks.data && tasks.data.items.length > 0 && (
        <ul style={PLAIN_LIST} className="stack">
          {tasks.data.items.map(({ taskId, batch: b }) => {
            const name = b ? `Input batch of ${b.periodCode} with ${b.lineCount} ${b.lineCount === 1 ? 'line' : 'lines'}` : 'Input batch';
            return (
              <li key={taskId} aria-label={name} className="card">
                <h3 style={H3}>{name}</h3>
                <DelegatedBadge taskId={taskId} />
                {b ? (
                  <>
                    <dl className="kv">
                      <Fact term="Source">{label(INPUT_SOURCE, b.source)}</Fact>
                      <Fact term="Submitted">{formatDate(b.submittedAt)}</Fact>
                    </dl>
                    <button type="button" className="link" onClick={() => setShown(shown === b.id ? null : b.id)} aria-label={`${shown === b.id ? 'Hide' : 'Show'} the lines of ${name}`}>
                      {shown === b.id ? 'Hide the lines' : 'Show the lines'}
                    </button>
                    {shown === b.id && <InputBatchView id={b.id} withActions={false} />}
                  </>
                ) : (
                  <p className="hint">The batch is not available in the selected role’s scope.</p>
                )}
                {b !== null && b.preparedBy === me?.userId ? (
                  <p className="hint">You prepared this batch, so someone else decides it.</p>
                ) : (
                  <TaskDecision
                    path={`/v1/payroll/input-tasks/${encodeURIComponent(taskId)}/decision`}
                    prefix="payroll-input-decision"
                    act="input-decide"
                    name={name}
                    onRefused={() => void refresh()}
                    onDecided={(decision, r) => {
                      setNotes((prev) => [
                        ...prev,
                        {
                          id: taskId,
                          text: r.replayed
                            ? `${name}: this decision had already been recorded; nothing was applied twice.`
                            : `${name}: ${decision === 'APPROVE' ? 'approved; the next calculation of the period uses these inputs' : 'rejected; none of its inputs is used'}.`,
                        },
                      ]);
                      void refresh();
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

// =========================================================================================================
// Hold criteria, hold proposals from processed records, withdrawal, review renewal; salary stop proposals
// =========================================================================================================

interface HoldCriterion {
  id: string;
  code: string;
  revision: number;
  category: string;
  applicability: string;
  scopeMode: string;
  maxReviewDays: number;
  evidenceReference: string;
  validationReference: string;
  state: string;
  createdBy: string | null;
  activatedAt: string | null;
  retiredAt: string | null;
  version: number;
}
interface HoldBalance {
  payable: string | null;
  held: string;
  unreserved: string | null;
  currencyCode: string;
}
interface HoldDetail extends Hold {
  evidenceReference: string | null;
  approvedAt: string | null;
  releaseReason: string | null;
  releaseEvidenceReference: string | null;
  record: HoldBalance | null;
}

const CRITERION_STATE: Record<string, string> = { DRAFT: 'Draft, not active', ACTIVE: 'Active', RETIRED: 'Retired' };
const CRITERION_CATEGORY: Record<string, string> = { CONTRACTUAL: 'Contractual', LEGAL_DISCIPLINARY: 'Legal or disciplinary' };
const SCOPE_MODE: Record<string, string> = { FULL_ONLY: 'Full net pay only', FULL_OR_PARTIAL: 'Full or partial' };
/** A positive amount, decided on the string (never as a number): not only zeros. */
const ZERO = /^0+(\.0+)?$/;

function useCriteria() {
  const { can } = useSession();
  const keys = useKeys();
  return useQuery({ queryKey: keys.criteria, queryFn: () => api<{ items: HoldCriterion[] }>('/v1/payroll/hold-criteria'), enabled: can(HOLD_READ), retry: retryTransient });
}

function HoldCriteriaSection() {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const criteria = useCriteria();
  const [retiring, setRetiring] = useState<HoldCriterion | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: ({ c, action, body }: { c: HoldCriterion; action: 'activate' | 'retire'; body: Record<string, unknown> }) =>
      api<HoldCriterion>(`/v1/payroll/hold-criteria/${encodeURIComponent(c.id)}/${action}`, { body }),
    onSuccess: (r, { action }) => {
      setRetiring(null);
      setNote(action === 'activate' ? `Criterion ${r.code} revision ${r.revision} is active: holds may now cite it.` : `Criterion ${r.code} revision ${r.revision} was retired: no new hold cites it.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.criteria }),
  });
  const manage = can(HOLD_ACTIVATE);
  return (
    <Section title="Hold criteria">
      <p className="hint">
        {`Salary holds are disabled until the company activates a validated criterion; each is activated by someone other than its author.${manage || can(HOLD_DEFINE) ? '' : ' Read only for the selected role.'}`}
      </p>
      {criteria.isPending && <p className="hint">Loading hold criteria…</p>}
      {criteria.error && <Problem error={criteria.error} act="read" />}
      <Note text={note} />
      {criteria.data && criteria.data.items.length === 0 && <Empty>No hold criterion is defined, so no salary hold can be proposed.</Empty>}
      {criteria.data && criteria.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Hold criteria">
            <thead>
              <tr>
                <th>Code</th>
                <th>Revision</th>
                <th>Category</th>
                <th>Holds allowed</th>
                <th>Longest review</th>
                <th>Applies when</th>
                <th>State</th>
                {manage && <th>Change</th>}
              </tr>
            </thead>
            <tbody>
              {criteria.data.items.map((c) => (
                <tr key={c.id}>
                  <td>{c.code}</td>
                  <td>{c.revision}</td>
                  <td>{label(CRITERION_CATEGORY, c.category)}</td>
                  <td>{label(SCOPE_MODE, c.scopeMode)}</td>
                  <td>{`${c.maxReviewDays} days`}</td>
                  <td>{c.applicability}</td>
                  <td>
                    <Status map={CRITERION_STATE} code={c.state} />
                  </td>
                  {manage && (
                    <td>
                      {c.state === 'DRAFT' && c.createdBy === me?.userId && 'You wrote it: someone else activates it'}
                      {c.state === 'DRAFT' && c.createdBy !== me?.userId && (
                        <button
                          type="button"
                          className="link"
                          disabled={act.isPending}
                          onClick={() => {
                            setNote(null);
                            act.mutate({ c, action: 'activate', body: { expectedVersion: c.version } });
                          }}
                          aria-label={`Activate criterion ${c.code} revision ${c.revision}`}
                        >
                          Activate
                        </button>
                      )}
                      {c.state === 'ACTIVE' && (
                        <button
                          type="button"
                          className="link"
                          disabled={act.isPending}
                          onClick={() => {
                            act.reset();
                            setNote(null);
                            setRetiring(c);
                          }}
                          aria-label={`Retire criterion ${c.code} revision ${c.revision}`}
                        >
                          Retire
                        </button>
                      )}
                      {c.state === 'RETIRED' && '—'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {retiring && (
        <ReasonForm
          key={retiring.id}
          name={`Retire criterion ${retiring.code}`}
          field="Why the criterion is retired"
          button="Retire the criterion"
          busy={act.isPending}
          danger
          onSend={(reason) => act.mutateAsync({ c: retiring, action: 'retire', body: { reason, expectedVersion: retiring.version } })}
        />
      )}
      <Problem error={act.error} act="criterion" />
      {can(HOLD_DEFINE) && <CriterionForm />}
    </Section>
  );
}

function CriterionForm() {
  const keys = useKeys();
  const qc = useQueryClient();
  // Nothing prefilled: the category and whether partial holds are allowed are the definer's choice (I-28).
  const empty = { code: '', category: '', applicability: '', scopeMode: '', maxReviewDays: '', evidenceReference: '', validationReference: '' };
  const [f, setF] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<HoldCriterion>('/v1/payroll/hold-criteria', { body }),
    onSuccess: (c) => {
      setF(empty);
      setNote(`Criterion ${c.code} revision ${c.revision} saved as a draft: someone other than you activates it.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.criteria }),
  });
  const set = (patch: Partial<typeof empty>) => setF((prev) => ({ ...prev, ...patch }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    if (!f.code.trim() || !f.applicability.trim()) return setProblem('Give the code and when the criterion applies.');
    if (!f.category || !f.scopeMode) return setProblem('Choose the category and whether partial holds are allowed.');
    const days = f.maxReviewDays.trim();
    if (!/^\d{1,3}$/.test(days) || Number(days) < 1 || Number(days) > 366) return setProblem('The longest review interval is 1 to 366 days.');
    if (!f.evidenceReference.trim() || !f.validationReference.trim()) return setProblem('Give the evidence reference and the validation reference.');
    setProblem(null);
    setNote(null);
    create.reset();
    create.mutate({
      code: f.code.trim().toUpperCase(),
      category: f.category,
      applicability: f.applicability.trim(),
      scopeMode: f.scopeMode,
      maxReviewDays: Number(days),
      evidenceReference: f.evidenceReference.trim(),
      validationReference: f.validationReference.trim(),
    });
  };
  return (
    <form onSubmit={submit} aria-label="Define a hold criterion" className="grid-form" style={{ marginTop: '0.75rem' }}>
      <h3 style={H3} className="wide">
        Define a hold criterion
      </h3>
      <label>
        Criterion code
        <input value={f.code} onChange={(e) => set({ code: e.target.value })} maxLength={40} autoComplete="off" />
      </label>
      <label>
        Category
        <select value={f.category} onChange={(e) => set({ category: e.target.value })}>
          <option value="">Choose the category</option>
          {Object.entries(CRITERION_CATEGORY).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        Holds allowed
        <select value={f.scopeMode} onChange={(e) => set({ scopeMode: e.target.value })}>
          <option value="">Choose</option>
          {Object.entries(SCOPE_MODE).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        Longest review interval (days)
        <input value={f.maxReviewDays} onChange={(e) => set({ maxReviewDays: e.target.value })} inputMode="numeric" maxLength={3} />
      </label>
      <label className="wide">
        When the criterion applies
        <textarea value={f.applicability} onChange={(e) => set({ applicability: e.target.value })} maxLength={2000} rows={2} style={TEXTAREA} />
      </label>
      <label>
        Evidence reference
        <input value={f.evidenceReference} onChange={(e) => set({ evidenceReference: e.target.value })} maxLength={500} autoComplete="off" />
      </label>
      <label>
        Validation reference
        <input value={f.validationReference} onChange={(e) => set({ validationReference: e.target.value })} maxLength={500} autoComplete="off" />
      </label>
      <div className="row">
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Saving…' : 'Save the criterion as a draft'}
        </button>
      </div>
      <Missing text={problem} />
      <div className="wide">
        <Note text={note} />
        <Problem error={create.error} act="criterion" />
      </div>
    </form>
  );
}

/** The hold position of one processed record (hold read) and a hold proposal (hold propose). */
function RecordHoldPanel({ record }: { record: RunRecord }) {
  const { can } = useSession();
  const keys = useKeys();
  const balance = useQuery({
    queryKey: keys.holdBalance(record.id),
    queryFn: () => api<HoldBalance>(`/v1/payroll/records/${encodeURIComponent(record.id)}/hold-balance`),
    enabled: can(HOLD_READ),
    retry: retryTransient,
  });
  const b = balance.data;
  return (
    <div role="region" aria-label={`Salary hold position of ${record.employeeCode}`} style={{ marginTop: '0.5rem' }}>
      <h3 style={H3}>{`Salary hold: ${record.employeeCode} ${record.employeeName}`}</h3>
      {can(HOLD_READ) && (
        <>
          {balance.isPending && <p className="hint">Loading the hold position…</p>}
          {balance.error && <Problem error={balance.error} act="read" />}
          {b && (
            <dl className="kv" aria-label="Hold position">
              <Fact term="Payable net">{money(b.payable, b.currencyCode)}</Fact>
              <Fact term="Held by live holds">{money(b.held, b.currencyCode)}</Fact>
              <Fact term="Unpaid and unreserved">{money(b.unreserved, b.currencyCode)}</Fact>
            </dl>
          )}
        </>
      )}
      {can(HOLD_PROPOSE) && <HoldProposalForm record={record} />}
    </div>
  );
}

function HoldProposalForm({ record }: { record: RunRecord }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const criteria = useCriteria();
  const intent = useIntentKey('payroll-hold');
  const empty = { criterionId: '', scope: 'FULL', amount: '', effectiveDate: localDate(), reviewDueOn: '', reason: '', releaseCriterion: '', evidenceReference: '' };
  const [f, setF] = useState(empty);
  const [documents, setDocuments] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const set = (patch: Partial<typeof empty>) => setF((prev) => ({ ...prev, ...patch }));
  const propose = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Hold & { replayed: boolean }>(`/v1/payroll/records/${encodeURIComponent(record.id)}/holds`, { body }),
    onSettled: (_d, error) => {
      intent.settle(error);
      void qc.invalidateQueries(byPrefix('payroll-hold'));
    },
    onSuccess: (h) => {
      setF(empty);
      setDocuments([]);
      setNote(
        h.replayed
          ? 'This hold had already been proposed; nothing was proposed twice.'
          : `Hold proposed for ${h.employeeCode}: ${h.scope === 'PARTIAL' ? money(h.holdAmount, h.currencyCode) : 'the whole unpaid net'} is kept out of bank files while it waits for an independent decision.`,
      );
    },
  });
  if (!can(HOLD_READ)) return <p className="hint">The selected role cannot list the hold criteria, so it cannot propose a hold.</p>;
  const active = (criteria.data?.items ?? []).filter((c) => c.state === 'ACTIVE');
  const criterion = active.find((c) => c.id === f.criterionId);
  const partialAllowed = criterion?.scopeMode === 'FULL_OR_PARTIAL';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (propose.isPending) return;
    if (!criterion) return setProblem('Choose the active hold criterion.');
    const partial = f.scope === 'PARTIAL';
    if (partial && !partialAllowed) return setProblem('This criterion allows only a hold of the full unpaid net pay.');
    if (partial && (!MONEY.test(f.amount.trim()) || ZERO.test(f.amount.trim()))) return setProblem('Enter the amount to hold: above zero, with at most four decimals.');
    if (!f.effectiveDate || !f.reviewDueOn) return setProblem('Give the effective date and the review date.');
    if (!f.reason.trim() || !f.releaseCriterion.trim()) return setProblem('Give the reason and the release criterion.');
    if (!f.evidenceReference.trim() || documents.length === 0) return setProblem('Give the evidence reference and choose at least one released, verified document.');
    setProblem(null);
    setNote(null);
    propose.reset();
    const body = {
      criterionId: criterion.id,
      scope: f.scope,
      ...(partial ? { amount: f.amount.trim() } : {}),
      reason: f.reason.trim(),
      effectiveDate: f.effectiveDate,
      reviewDueOn: f.reviewDueOn,
      releaseCriterion: f.releaseCriterion.trim(),
      evidenceReference: f.evidenceReference.trim(),
      evidenceDocumentIds: documents,
    };
    propose.mutate({ ...body, idempotencyKey: intent.key(JSON.stringify([record.id, body])) });
  };
  return (
    <form onSubmit={submit} aria-label={`Propose a hold for ${record.employeeCode}`} className="grid-form" style={{ marginTop: '0.5rem' }}>
      {criteria.data && active.length === 0 && <p className="hint wide">No hold criterion is active, so no hold can be proposed (holds are disabled until a validated criterion is activated).</p>}
      <label>
        Hold criterion
        <select
          value={f.criterionId}
          onChange={(e) => {
            const c = active.find((x) => x.id === e.target.value);
            set({ criterionId: e.target.value, ...(c?.scopeMode === 'FULL_OR_PARTIAL' ? {} : { scope: 'FULL', amount: '' }) });
          }}
        >
          <option value="">Choose a criterion</option>
          {active.map((c) => (
            <option key={c.id} value={c.id}>
              {`${c.code} revision ${c.revision} (${label(CRITERION_CATEGORY, c.category)})`}
            </option>
          ))}
        </select>
      </label>
      <fieldset style={GROUP}>
        <legend>What is held</legend>
        <label className="check">
          <input type="radio" name={`scope-${record.id}`} checked={f.scope === 'FULL'} onChange={() => set({ scope: 'FULL', amount: '' })} /> The whole unpaid, unreserved net
        </label>
        <label className="check">
          <input type="radio" name={`scope-${record.id}`} checked={f.scope === 'PARTIAL'} disabled={!partialAllowed} onChange={() => set({ scope: 'PARTIAL' })} /> Part of it
        </label>
      </fieldset>
      {f.scope === 'PARTIAL' && (
        <label>
          {`Amount to hold (${record.currencyCode})`}
          <input value={f.amount} onChange={(e) => set({ amount: e.target.value })} inputMode="decimal" maxLength={20} autoComplete="off" />
        </label>
      )}
      {criterion && <p className="hint wide">{`The review date is at most ${criterion.maxReviewDays} days after the effective date. A partial hold is at most the unpaid, unreserved amount.`}</p>}
      <label>
        Effective date
        <input type="date" value={f.effectiveDate} onChange={(e) => set({ effectiveDate: e.target.value })} />
      </label>
      <label>
        Review date
        <input type="date" value={f.reviewDueOn} onChange={(e) => set({ reviewDueOn: e.target.value })} />
      </label>
      <label className="wide">
        Reason for the hold
        <textarea value={f.reason} onChange={(e) => set({ reason: e.target.value })} maxLength={1000} rows={2} style={TEXTAREA} />
      </label>
      <label className="wide">
        Release criterion
        <textarea value={f.releaseCriterion} onChange={(e) => set({ releaseCriterion: e.target.value })} maxLength={1000} rows={2} style={TEXTAREA} />
      </label>
      <label>
        Evidence reference
        <input value={f.evidenceReference} onChange={(e) => set({ evidenceReference: e.target.value })} maxLength={500} autoComplete="off" />
      </label>
      <EvidencePicker employeeId={record.employeeId} chosen={documents} onChange={setDocuments} max={10} />
      <div className="row">
        <button type="submit" disabled={propose.isPending}>
          {propose.isPending ? 'Proposing…' : 'Propose the hold'}
        </button>
      </div>
      <Missing text={problem} />
      <div className="wide">
        <Note text={note} />
        <Problem error={propose.error} act="hold-propose" />
      </div>
    </form>
  );
}

function HoldDetailView({ id }: { id: string }) {
  const keys = useKeys();
  const hold = useQuery({ queryKey: keys.hold(id), queryFn: () => api<HoldDetail>(`/v1/payroll/holds/${encodeURIComponent(id)}`), retry: retryTransient });
  const h = hold.data;
  if (hold.isPending) return <p className="hint">Loading the hold…</p>;
  if (!h) return <Problem error={hold.error} act="read" />;
  return (
    <div role="region" aria-label={`Hold of ${h.employeeCode} for ${h.periodCode}`} style={{ marginTop: '0.5rem' }}>
      <h3 style={H3}>{`${label(HOLD_KIND, h.holdKind)} of ${h.employeeCode} for ${h.periodCode}`}</h3>
      <dl className="kv">
        <Fact term="State">
          <Status map={HOLD_STATE} code={h.state} />
        </Fact>
        <Fact term="Held">{h.scope === 'PARTIAL' ? money(h.holdAmount, h.currencyCode) : 'Full net pay'}</Fact>
        {h.criterionCode && <Fact term="Criterion">{h.criterionCode}</Fact>}
        {h.reason && <Fact term="Reason">{h.reason}</Fact>}
        <Fact term="Effective">{formatDate(h.effectiveDate)}</Fact>
        <Fact term="Review due">{formatDate(h.reviewDueOn)}</Fact>
        {h.releaseCriterion && <Fact term="Release criterion">{h.releaseCriterion}</Fact>}
        {h.evidenceReference && <Fact term="Evidence">{h.evidenceReference}</Fact>}
        <Fact term="Proposed">{formatDate(h.proposedAt)}</Fact>
        <Fact term="Approved">{formatDate(h.approvedAt)}</Fact>
        <Fact term="Released">{formatDate(h.releasedAt)}</Fact>
        {h.releaseReason && <Fact term="Release reason">{h.releaseReason}</Fact>}
        {h.releaseEvidenceReference && <Fact term="Release evidence">{h.releaseEvidenceReference}</Fact>}
      </dl>
      {h.record && (
        <dl className="kv" aria-label="Hold position of the record">
          <Fact term="Payable net">{money(h.record.payable, h.record.currencyCode)}</Fact>
          <Fact term="Held by live holds">{money(h.record.held, h.record.currencyCode)}</Fact>
          <Fact term="Unpaid and unreserved">{money(h.record.unreserved, h.record.currencyCode)}</Fact>
        </dl>
      )}
    </div>
  );
}

function HoldWithdraw({ hold, onDone }: { hold: Hold; onDone: (text: string) => void }) {
  const withdraw = useMutation({
    mutationFn: (reason: string) => api<Hold>(`/v1/payroll/holds/${encodeURIComponent(hold.id)}/withdraw`, { body: { reason } }),
    onSuccess: () => onDone(`The hold proposal of ${hold.employeeCode} was withdrawn: nothing is withheld for it.`),
  });
  return (
    <>
      <ReasonForm name={`Withdraw the hold proposal of ${hold.employeeCode}`} field="Why the proposal is withdrawn" button="Withdraw the proposal" busy={withdraw.isPending} onSend={(r) => withdraw.mutateAsync(r)} />
      <Problem error={withdraw.error} act="hold-act" />
    </>
  );
}

function HoldRenew({ hold, maker, onDone }: { hold: Hold; maker: boolean; onDone: (text: string) => void }) {
  const [reviewDueOn, setReviewDueOn] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const renew = useMutation({
    mutationFn: (body: { reviewDueOn: string; reason: string; expectedVersion: number }) => api<Hold>(`/v1/payroll/holds/${encodeURIComponent(hold.id)}/renew-review`, { body }),
    onSuccess: (h) => onDone(`The review of the hold of ${hold.employeeCode} is renewed until ${formatDate(h.reviewDueOn)}; the payment stays withheld.`),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (renew.isPending || maker) return;
    if (!reviewDueOn || !reason.trim()) return setProblem('Give the new review date and the reason.');
    setProblem(null);
    renew.reset();
    renew.mutate({ reviewDueOn, reason: reason.trim(), expectedVersion: hold.version });
  };
  return (
    <form onSubmit={submit} aria-label={`Renew the review of the hold of ${hold.employeeCode}`} className="grid-form" style={{ marginTop: '0.5rem' }}>
      {maker && <p className="hint wide">You proposed this hold, so someone else renews its review.</p>}
      <label>
        New review date
        <input type="date" value={reviewDueOn} min={localDate()} onChange={(e) => setReviewDueOn(e.target.value)} />
      </label>
      <label className="wide">
        Why the hold continues
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
      </label>
      <div className="row">
        <button type="submit" disabled={renew.isPending || maker}>
          {renew.isPending ? 'Renewing…' : 'Renew the review'}
        </button>
      </div>
      <Missing text={problem} />
      <div className="wide">
        <Problem error={renew.error} act="hold-act" />
      </div>
    </form>
  );
}

type StopModeCode = 'HOLD_DISBURSEMENT' | 'EXCLUDE_CALCULATION';

function StopProposalForm() {
  const { can } = useSession();
  const qc = useQueryClient();
  const criteria = useCriteria();
  const intent = useIntentKey('payroll-stop');
  const [period, setPeriod] = useState<PeriodChoice | null>(null);
  const [employee, setEmployee] = useState<EmployeeHit | null>(null);
  const [mode, setMode] = useState<StopModeCode>('HOLD_DISBURSEMENT');
  const [criterionId, setCriterionId] = useState('');
  const [reason, setReason] = useState('');
  const [releaseCriterion, setReleaseCriterion] = useState('');
  const [evidenceReference, setEvidenceReference] = useState('');
  const [documents, setDocuments] = useState<string[]>([]);
  const [excludeConfirmed, setExcludeConfirmed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const propose = useMutation({
    mutationFn: ({ periodId, body }: { periodId: string; body: Record<string, unknown> }) =>
      api<SalaryStop & { replayed: boolean }>(`/v1/payroll/periods/${encodeURIComponent(periodId)}/salary-stops`, { body }),
    onSettled: (_d, error) => {
      intent.settle(error);
      void qc.invalidateQueries(byPrefix('payroll-stop'));
    },
    onSuccess: (s) => {
      setEmployee(null);
      setReason('');
      setReleaseCriterion('');
      setEvidenceReference('');
      setDocuments([]);
      setCriterionId('');
      setExcludeConfirmed(false);
      setMode('HOLD_DISBURSEMENT');
      setNote(
        s.replayed
          ? 'This salary stop had already been proposed; nothing was proposed twice.'
          : `Salary stop of ${s.employeeCode} for ${s.periodCode} proposed (${label(STOP_MODE, s.mode)}): it waits for an independent decision.`,
      );
    },
  });
  const active = (criteria.data?.items ?? []).filter((c) => c.state === 'ACTIVE');
  const withhold = mode === 'HOLD_DISBURSEMENT';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (propose.isPending) return;
    if (!period || !employee) return setProblem('Choose the period and the employee.');
    if (withhold && (!criterionId || !releaseCriterion.trim())) return setProblem('Withholding a payment needs an active hold criterion and the release criterion.');
    if (!withhold && !excludeConfirmed) return setProblem('Confirm that the employee is left out of the calculation.');
    if (!reason.trim()) return setProblem('Give the reason for the salary stop.');
    if (!evidenceReference.trim() || documents.length === 0) return setProblem('Give the evidence reference and choose at least one released, verified document.');
    setProblem(null);
    setNote(null);
    propose.reset();
    const body = {
      employeeId: employee.id,
      mode,
      ...(withhold ? { criterionId, releaseCriterion: releaseCriterion.trim() } : {}),
      reason: reason.trim(),
      evidenceReference: evidenceReference.trim(),
      evidenceDocumentIds: documents,
    };
    propose.mutate({ periodId: period.periodId, body: { ...body, idempotencyKey: intent.key(JSON.stringify([period.periodId, body])) } });
  };
  return (
    <Section title="Propose a salary stop">
      <p className="hint">A salary stop is decided by someone independent before the period’s calculation. Withholding the payment keeps the salary calculated but unpaid; leaving the employee out of the calculation is an exceptional mode that must be confirmed.</p>
      <form onSubmit={submit} aria-label="Propose a salary stop" className="grid-form">
        <PeriodPicker value={period} onChange={setPeriod} purpose="of the salary stop" />
        <EmployeePicker
          title="Employee"
          value={employee}
          onChange={(e) => {
            setEmployee(e);
            setDocuments([]);
          }}
        />
        <fieldset style={GROUP} className="wide">
          <legend>Mode</legend>
          <label className="check">
            <input
              type="radio"
              name="stop-mode"
              checked={withhold}
              onChange={() => {
                setMode('HOLD_DISBURSEMENT');
                setExcludeConfirmed(false);
              }}
            />{' '}
            {STOP_MODE.HOLD_DISBURSEMENT}
          </label>
          <label className="check">
            <input
              type="radio"
              name="stop-mode"
              checked={!withhold}
              onChange={() => {
                setMode('EXCLUDE_CALCULATION');
                setCriterionId('');
                setReleaseCriterion('');
              }}
            />{' '}
            {STOP_MODE.EXCLUDE_CALCULATION}
          </label>
        </fieldset>
        {withhold && !can(HOLD_READ) && <p className="hint wide">The selected role cannot list the hold criteria, so it cannot propose withholding a payment.</p>}
        {withhold && can(HOLD_READ) && criteria.data && active.length === 0 && <p className="hint wide">No hold criterion is active, so a payment cannot be withheld (disabled until a validated criterion is activated).</p>}
        {withhold && (
          <>
            <label>
              Hold criterion
              <select value={criterionId} onChange={(e) => setCriterionId(e.target.value)}>
                <option value="">Choose a criterion</option>
                {active.map((c) => (
                  <option key={c.id} value={c.id}>
                    {`${c.code} revision ${c.revision}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="wide">
              Release criterion
              <textarea value={releaseCriterion} onChange={(e) => setReleaseCriterion(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
            </label>
          </>
        )}
        {!withhold && (
          <label className="check wide">
            <input type="checkbox" checked={excludeConfirmed} onChange={(e) => setExcludeConfirmed(e.target.checked)} /> I confirm that the employee is left out of this period’s calculation entirely: nothing is calculated for them, which is not a payment hold.
          </label>
        )}
        <label className="wide">
          Reason for the salary stop
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
        </label>
        <label>
          Evidence reference
          <input value={evidenceReference} onChange={(e) => setEvidenceReference(e.target.value)} maxLength={500} autoComplete="off" />
        </label>
        {employee && <EvidencePicker employeeId={employee.id} chosen={documents} onChange={setDocuments} max={10} />}
        <div className="row">
          <button type="submit" disabled={propose.isPending}>
            {propose.isPending ? 'Proposing…' : 'Propose the salary stop'}
          </button>
        </div>
        <Missing text={problem} />
        <div className="wide">
          <Note text={note} />
          <Problem error={propose.error} act="stop-propose" />
        </div>
      </form>
    </Section>
  );
}

// =========================================================================================================
// Bank file templates (DB112; I-32): revisions, independent sample validation, activation, retirement
// =========================================================================================================

interface FieldSpecRow {
  source: string;
  value?: string;
  maxLength?: number;
}
interface FormatDefinition {
  layout: string;
  delimiter: string;
  lineEnding: string;
  amountDecimals: number;
  decimalSeparator: string;
  dateFormat: string;
  fileExtension: string;
  header?: FieldSpecRow[];
  detail: FieldSpecRow[];
  trailer?: FieldSpecRow[];
}
interface TemplateFull extends BankTemplate {
  formatDefinition: FormatDefinition;
  definitionHash: string;
  bankSpecificationReference: string;
  sampleHash: string | null;
  sampleValidationReference: string | null;
  sampleValidatedAt: string | null;
  activatedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  createdBy: string;
  createdAt: string;
  version: number;
}
interface TemplateSample {
  label: string;
  fileName: string;
  content: string;
  sampleHash: string;
  errors: BankRowError[];
}

const TEMPLATE_STATE: Record<string, string> = { DRAFT: 'Draft, not in use', ACTIVE: 'Active', RETIRED: 'Retired', CANCELLED: 'Cancelled' };
const DETAIL_SOURCES = ['LINE_SEQUENCE', 'ALLOCATION_KEY', 'EMPLOYEE_CODE', 'HOLDER_NAME', 'ACCOUNT_IDENTIFIER', 'ROUTING_REFERENCE', 'COUNTRY_CODE', 'AMOUNT', 'CURRENCY_CODE', 'PAYMENT_DATE', 'BATCH_REFERENCE', 'LITERAL'];
const CONTROL_SOURCES = ['BATCH_REFERENCE', 'RECORD_COUNT', 'TOTAL_AMOUNT', 'CURRENCY_CODE', 'PAYMENT_DATE', 'LITERAL'];
const SOURCE_LABEL: Record<string, string> = {
  LINE_SEQUENCE: 'Line number',
  ALLOCATION_KEY: 'Allocation key',
  EMPLOYEE_CODE: 'Employee code',
  HOLDER_NAME: 'Account holder name',
  ACCOUNT_IDENTIFIER: 'Account identifier',
  ROUTING_REFERENCE: 'Routing reference',
  COUNTRY_CODE: 'Country code',
  AMOUNT: 'Amount',
  CURRENCY_CODE: 'Currency code',
  PAYMENT_DATE: 'Payment date',
  BATCH_REFERENCE: 'Batch reference',
  RECORD_COUNT: 'Record count',
  TOTAL_AMOUNT: 'Total amount',
  LITERAL: 'Fixed text',
};
const DELIMITER_LABEL: Record<string, string> = { COMMA: 'Comma (,)', SEMICOLON: 'Semicolon (;)', PIPE: 'Pipe (|)', TAB: 'Tab' };
const DATE_FORMATS = ['YYYY-MM-DD', 'YYYYMMDD', 'DD-MM-YYYY', 'DDMMYYYY', 'DD/MM/YYYY'];

const fieldText = (f: FieldSpecRow) => `${label(SOURCE_LABEL, f.source)}${f.source === 'LITERAL' ? ` “${f.value ?? ''}”` : ''}${f.maxLength ? ` (at most ${f.maxLength} characters)` : ''}`;

function TemplatesScreen() {
  const { can } = useSession();
  const [openId, setOpenId] = useState<string | null>(null);
  const [basis, setBasis] = useState<TemplateFull | null>(null);
  if (!can(TEMPLATE_READ)) {
    return (
      <Section title="Bank file templates">
        <Empty>The selected role cannot see bank file templates.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      <TemplateList openId={openId} onOpen={setOpenId} />
      {openId && <TemplateView key={openId} id={openId} {...(can(TEMPLATE_MANAGE) ? { onRevise: setBasis } : {})} />}
      {can(TEMPLATE_MANAGE) && <TemplateForm key={basis?.id ?? 'new'} basis={basis} onClearBasis={() => setBasis(null)} />}
    </div>
  );
}

function TemplateList({ openId, onOpen }: { openId: string | null; onOpen: (id: string | null) => void }) {
  const keys = useKeys();
  const templates = useQuery({ queryKey: keys.templates, queryFn: () => api<{ items: TemplateFull[] }>('/v1/payroll-outputs/bank-templates'), retry: retryTransient });
  return (
    <Section title="Bank file templates">
      <p className="hint">
        A template is the company’s transcription of the bank’s accepted file specification as a delimited field mapping; no bank format is presumed. Its system-generated sample is validated, and the template activated, by people other than its author.
      </p>
      {templates.isPending && <p className="hint">Loading templates…</p>}
      {templates.error && <Problem error={templates.error} act="read" />}
      {templates.data && templates.data.items.length === 0 && <Empty>No bank file template yet.</Empty>}
      {templates.data && templates.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Bank file templates">
            <thead>
              <tr>
                <th>Template</th>
                <th>Name</th>
                <th>Currency</th>
                <th>Use</th>
                <th>State</th>
                <th>Sample validated</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {templates.data.items.map((t) => (
                <tr key={t.id}>
                  <td>{`${t.templateCode} version ${t.templateVersion}`}</td>
                  <td>{t.name}</td>
                  <td>{t.currencyCode}</td>
                  <td>{t.testOnly ? <Badge tone="warn">Test only: never for real payments</Badge> : 'Production'}</td>
                  <td>
                    <Status map={TEMPLATE_STATE} code={t.state} />
                  </td>
                  <td>{t.sampleHash ? formatDate(t.sampleValidatedAt) : 'Not yet'}</td>
                  <td>
                    <button type="button" className="link" onClick={() => onOpen(openId === t.id ? null : t.id)} aria-label={`Details of template ${t.templateCode} version ${t.templateVersion}`}>
                      {openId === t.id ? 'Hide' : 'Details'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function FieldList({ part, fields }: { part: string; fields: FieldSpecRow[] | undefined }) {
  if (!fields || fields.length === 0) return null;
  return (
    <>
      <h3 style={H3}>{`${part} record`}</h3>
      <ol aria-label={`${part} record fields`}>
        {fields.map((f, i) => (
          <li key={i}>{fieldText(f)}</li>
        ))}
      </ol>
    </>
  );
}

type TemplateAction = 'sample-validation' | 'activate' | 'retire';

function TemplateView({ id, onRevise }: { id: string; onRevise?: (t: TemplateFull) => void }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [showSample, setShowSample] = useState(false);
  const [validationReference, setValidationReference] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const template = useQuery({ queryKey: keys.template(id), queryFn: () => api<TemplateFull>(`/v1/payroll-outputs/bank-templates/${encodeURIComponent(id)}`), retry: retryTransient });
  const sample = useQuery({
    queryKey: keys.templateSample(id),
    queryFn: () => api<TemplateSample>(`/v1/payroll-outputs/bank-templates/${encodeURIComponent(id)}/sample`),
    enabled: showSample,
    retry: retryTransient,
  });
  const act = useMutation({
    mutationFn: ({ action, body }: { action: TemplateAction; body: Record<string, unknown> }) => api<TemplateFull>(`/v1/payroll-outputs/bank-templates/${encodeURIComponent(id)}/${action}`, { body }),
    onSuccess: (r, { action }) => {
      if (action === 'sample-validation') {
        setValidationReference('');
        setNote('The sample is recorded as validated against the bank’s specification. Someone other than the author can now activate the template.');
      } else if (action === 'activate') setNote(`Activated: ${r.templateCode} version ${r.templateVersion} is used for new manifests; an earlier active version of the same code is retired.`);
      else setNote(r.state === 'CANCELLED' ? 'The draft was cancelled.' : 'The template was retired: it is no longer used for new manifests.');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.templates }),
  });
  const t = template.data;
  if (template.isPending) return <p className="hint">Loading the template…</p>;
  if (!t) return <Problem error={template.error} act="read" />;
  const author = t.createdBy === me?.userId;
  const def = t.formatDefinition;
  const s = sample.data;
  const failedAct: Act = act.variables?.action === 'sample-validation' ? 'template-validate' : act.variables?.action === 'activate' ? 'template-activate' : 'template';
  const validate = (e: FormEvent) => {
    e.preventDefault();
    if (act.isPending || !s || author) return;
    if (!validationReference.trim()) return setProblem('Give the validation reference (where the sample was checked against the bank’s specification).');
    setProblem(null);
    setNote(null);
    act.reset();
    act.mutate({ action: 'sample-validation', body: { sampleHash: s.sampleHash, validationReference: validationReference.trim(), expectedVersion: t.version } });
  };
  return (
    <Section title={`Template ${t.templateCode} version ${t.templateVersion}`}>
      <dl className="kv">
        <Fact term="Name">{t.name}</Fact>
        <Fact term="State">
          <Status map={TEMPLATE_STATE} code={t.state} />
        </Fact>
        <Fact term="Currency">{t.currencyCode}</Fact>
        <Fact term="Bank specification">{t.bankSpecificationReference}</Fact>
        <Fact term="Definition fingerprint">{t.definitionHash}</Fact>
        <Fact term="Sample validated">{t.sampleHash ? `${formatDate(t.sampleValidatedAt)} (${t.sampleValidationReference ?? ''})` : 'Not yet'}</Fact>
        <Fact term="Activated">{formatDate(t.activatedAt)}</Fact>
        {t.closeReason && <Fact term="Closed">{`${formatDate(t.closedAt)}: ${t.closeReason}`}</Fact>}
      </dl>
      {t.testOnly && (
        <p role="note" className="hint">
          This is a test-only template: it is refused in production, so it is never used for real payments.
        </p>
      )}
      <dl className="kv" aria-label="Layout">
        <Fact term="Layout">Delimited</Fact>
        <Fact term="Delimiter">{label(DELIMITER_LABEL, def.delimiter)}</Fact>
        <Fact term="Line ending">{def.lineEnding}</Fact>
        <Fact term="Amount decimals">{def.amountDecimals}</Fact>
        <Fact term="Decimal separator">{def.decimalSeparator}</Fact>
        <Fact term="Date format">{def.dateFormat}</Fact>
        <Fact term="File extension">{def.fileExtension}</Fact>
      </dl>
      <FieldList part="Header" fields={def.header} />
      <FieldList part="Detail" fields={def.detail} />
      <FieldList part="Trailer" fields={def.trailer} />
      <div className="row">
        <button type="button" className="secondary" onClick={() => setShowSample(!showSample)}>
          {showSample ? 'Hide the sample file' : 'Show the sample file'}
        </button>
        {onRevise && (
          <button type="button" className="secondary" onClick={() => onRevise(t)}>
            Start a new version from this one
          </button>
        )}
      </div>
      {showSample && sample.isPending && <p className="hint">Generating the sample…</p>}
      {showSample && sample.error && <Problem error={sample.error} act="read" />}
      {showSample && s && (
        <div role="region" aria-label="Sample file">
          <p style={FLUSH}>
            <Badge tone="warn">{s.label === 'SAMPLE_NOT_PAYABLE' ? 'Sample: not payable' : readable(s.label)}</Badge> {s.fileName}
          </p>
          <pre style={SCROLL}>{s.content}</pre>
          <p className="hint">{`Sample fingerprint (SHA-256): ${s.sampleHash}`}</p>
          {s.errors.length > 0 && (
            <ul aria-label="Sample problems">
              {s.errors.map((x, i) => (
                <li key={i}>{`${label(ROW_TEXT, x.code)}${x.source ? ` (${label(SOURCE_LABEL, x.source)})` : ''}`}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {can(TEMPLATE_VALIDATE) && t.state === 'DRAFT' && !t.sampleHash && (
        <form onSubmit={validate} aria-label="Validate the sample" className="grid-form" style={{ marginTop: '0.5rem' }}>
          {author ? (
            <p className="hint wide">You wrote this template, so someone else validates its sample.</p>
          ) : !s ? (
            <p className="hint wide">Show the sample file first and compare it with the bank’s specification.</p>
          ) : null}
          <label>
            Validation reference
            <input value={validationReference} onChange={(e) => setValidationReference(e.target.value)} maxLength={500} autoComplete="off" />
          </label>
          <div className="row">
            <button type="submit" disabled={act.isPending || author || !s || s.errors.length > 0}>
              Record the sample as validated
            </button>
          </div>
          <Missing text={problem} />
        </form>
      )}
      {can(TEMPLATE_ACTIVATE) && t.state === 'DRAFT' && (
        <div style={{ marginTop: '0.5rem' }}>
          <button
            type="button"
            disabled={act.isPending || author || !t.sampleHash}
            onClick={() => {
              setNote(null);
              act.reset();
              act.mutate({ action: 'activate', body: { expectedVersion: t.version } });
            }}
          >
            Activate this template
          </button>
          {!t.sampleHash && <p className="hint">A template is activated only after an independent sample validation.</p>}
          {author && <p className="hint">You wrote this template, so someone else activates it.</p>}
        </div>
      )}
      {can(TEMPLATE_MANAGE) && (t.state === 'ACTIVE' || t.state === 'DRAFT') && (
        <ReasonForm
          name={t.state === 'ACTIVE' ? 'Retire this template' : 'Cancel this draft template'}
          field={t.state === 'ACTIVE' ? 'Why the template is retired' : 'Why the draft is cancelled'}
          button={t.state === 'ACTIVE' ? 'Retire this template' : 'Cancel this draft'}
          busy={act.isPending}
          danger
          onSend={(reason) => {
            setNote(null);
            return act.mutateAsync({ action: 'retire', body: { reason, expectedVersion: t.version } });
          }}
        />
      )}
      <Note text={note} />
      <Problem error={act.error} act={failedAct} />
    </Section>
  );
}

interface FieldDraft {
  key: number;
  source: string;
  value: string;
  maxLength: string;
}

function FieldListEditor({ part, sources, fields, onChange, newKey }: { part: string; sources: string[]; fields: FieldDraft[]; onChange: (f: FieldDraft[]) => void; newKey: () => number }) {
  const set = (i: number, patch: Partial<FieldDraft>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, by: number) => {
    const next = [...fields];
    const [f] = next.splice(i, 1);
    if (f) next.splice(i + by, 0, f);
    onChange(next);
  };
  return (
    <fieldset style={GROUP} className="wide">
      <legend>{`${part} record: fields in file order`}</legend>
      {fields.length === 0 && <p className="hint">No fields yet.</p>}
      {fields.map((f, i) => (
        <div key={f.key} className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label>
            {`${part} field ${i + 1}`}
            <select value={f.source} onChange={(e) => set(i, { source: e.target.value })}>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {label(SOURCE_LABEL, s)}
                </option>
              ))}
            </select>
          </label>
          {f.source === 'LITERAL' && (
            <label>
              {`${part} field ${i + 1} text`}
              <input value={f.value} onChange={(e) => set(i, { value: e.target.value })} maxLength={100} autoComplete="off" />
            </label>
          )}
          <label>
            {`${part} field ${i + 1} maximum length`}
            <input value={f.maxLength} onChange={(e) => set(i, { maxLength: e.target.value })} inputMode="numeric" maxLength={3} />
          </label>
          <button type="button" className="secondary" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${part.toLowerCase()} field ${i + 1} up`}>
            Up
          </button>
          <button type="button" className="secondary" disabled={i === fields.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${part.toLowerCase()} field ${i + 1} down`}>
            Down
          </button>
          <button type="button" className="secondary" onClick={() => onChange(fields.filter((_, j) => j !== i))} aria-label={`Remove ${part.toLowerCase()} field ${i + 1}`}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="secondary" onClick={() => onChange([...fields, { key: newKey(), source: sources[0] ?? 'LITERAL', value: '', maxLength: '' }])}>
        {`Add a ${part.toLowerCase()} field`}
      </button>
    </fieldset>
  );
}

function TemplateForm({ basis, onClearBasis }: { basis: TemplateFull | null; onClearBasis: () => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const seq = useRef(0);
  const newKey = () => ++seq.current;
  const drafts = (list: FieldSpecRow[] | undefined) => (list ?? []).map((f) => ({ key: newKey(), source: f.source, value: f.value ?? '', maxLength: f.maxLength ? String(f.maxLength) : '' }));
  const initial = () => {
    const d = basis?.formatDefinition;
    return {
      templateCode: basis?.templateCode ?? '',
      name: basis?.name ?? '',
      currencyCode: basis?.currencyCode ?? '',
      spec: basis?.bankSpecificationReference ?? '',
      testOnly: basis?.testOnly ?? false,
      delimiter: d?.delimiter ?? 'COMMA',
      lineEnding: d?.lineEnding ?? 'CRLF',
      decimals: String(d?.amountDecimals ?? 2),
      separator: d?.decimalSeparator ?? '.',
      dateFormat: d?.dateFormat ?? 'YYYY-MM-DD',
      extension: d?.fileExtension ?? 'csv',
      header: d?.header ? drafts(d.header) : null,
      detail: drafts(d?.detail),
      trailer: d?.trailer ? drafts(d.trailer) : null,
    };
  };
  const [f, setF] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const set = (patch: Partial<ReturnType<typeof initial>>) => setF((prev) => ({ ...prev, ...patch }));
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<TemplateFull>('/v1/payroll-outputs/bank-templates', { body }),
    onSuccess: (t) => {
      setF({ ...initial(), templateCode: '', name: '', currencyCode: '', spec: '', testOnly: false, header: null, detail: [], trailer: null });
      setNote(`Template ${t.templateCode} version ${t.templateVersion} saved as a draft. Someone other than you validates its sample against the bank’s specification; then someone other than you activates it.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.templates }),
  });
  const out = (list: FieldDraft[]) =>
    list.map((x) => ({ source: x.source, ...(x.source === 'LITERAL' ? { value: x.value } : {}), ...(x.maxLength.trim() ? { maxLength: Number(x.maxLength.trim()) } : {}) }));
  const lengthOk = (list: FieldDraft[]) => list.every((x) => !x.maxLength.trim() || (/^\d{1,3}$/.test(x.maxLength.trim()) && Number(x.maxLength) >= 1 && Number(x.maxLength) <= 500));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    const code = f.templateCode.trim().toUpperCase();
    const currency = f.currencyCode.trim().toUpperCase();
    if (!code || !f.name.trim() || !f.spec.trim()) return setProblem('Give the template code, the name and the bank specification reference.');
    if (!/^[A-Z]{3}$/.test(currency)) return setProblem('The currency is a three-letter ISO code.');
    const sources = f.detail.map((x) => x.source);
    if (!sources.includes('AMOUNT') || !sources.includes('ACCOUNT_IDENTIFIER')) return setProblem('The detail record must carry the amount and the account identifier.');
    const all = [...f.detail, ...(f.header ?? []), ...(f.trailer ?? [])];
    if (all.some((x) => x.source === 'LITERAL' && !x.value)) return setProblem('Every fixed-text field needs its text.');
    if (!lengthOk(all)) return setProblem('A maximum length is 1 to 500 characters.');
    if ((f.header && f.header.length === 0) || (f.trailer && f.trailer.length === 0)) return setProblem('A header or trailer record needs at least one field (or untick it).');
    setProblem(null);
    setNote(null);
    create.reset();
    create.mutate({
      templateCode: code,
      name: f.name.trim(),
      currencyCode: currency,
      bankSpecificationReference: f.spec.trim(),
      testOnly: f.testOnly,
      formatDefinition: {
        layout: 'DELIMITED',
        delimiter: f.delimiter,
        lineEnding: f.lineEnding,
        amountDecimals: Number(f.decimals),
        decimalSeparator: f.separator,
        dateFormat: f.dateFormat,
        fileExtension: f.extension,
        ...(f.header ? { header: out(f.header) } : {}),
        detail: out(f.detail),
        ...(f.trailer ? { trailer: out(f.trailer) } : {}),
      },
    });
  };
  return (
    <Section title={basis ? `New version of ${basis.templateCode}` : 'New bank file template'}>
      <p className="hint">Saving the same template code again creates its next version. Transcribe the bank’s accepted specification exactly: values are never shortened or changed to fit, and a row that does not fit stops the whole file.</p>
      {basis && (
        <button type="button" className="secondary" onClick={onClearBasis}>
          Start from an empty template instead
        </button>
      )}
      <form onSubmit={submit} aria-label="Bank file template" className="grid-form">
        <label>
          Template code
          <input value={f.templateCode} onChange={(e) => set({ templateCode: e.target.value })} maxLength={40} autoComplete="off" />
        </label>
        <label>
          Template name
          <input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} autoComplete="off" />
        </label>
        <label>
          Currency
          <input value={f.currencyCode} onChange={(e) => set({ currencyCode: e.target.value })} maxLength={3} autoComplete="off" />
        </label>
        <label>
          Bank specification reference
          <input value={f.spec} onChange={(e) => set({ spec: e.target.value })} maxLength={500} autoComplete="off" />
        </label>
        <label className="check wide">
          <input type="checkbox" checked={f.testOnly} onChange={(e) => set({ testOnly: e.target.checked })} /> Test only (synthetic; refused in production)
        </label>
        <label>
          Delimiter
          <select value={f.delimiter} onChange={(e) => set({ delimiter: e.target.value })}>
            {Object.entries(DELIMITER_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Line ending
          <select value={f.lineEnding} onChange={(e) => set({ lineEnding: e.target.value })}>
            <option value="CRLF">CRLF</option>
            <option value="LF">LF</option>
          </select>
        </label>
        <label>
          Amount decimals
          <select value={f.decimals} onChange={(e) => set({ decimals: e.target.value })}>
            {['0', '1', '2', '3', '4'].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          Decimal separator
          <select value={f.separator} onChange={(e) => set({ separator: e.target.value })}>
            <option value=".">Point (.)</option>
            <option value=",">Comma (,)</option>
          </select>
        </label>
        <label>
          Date format
          <select value={f.dateFormat} onChange={(e) => set({ dateFormat: e.target.value })}>
            {DATE_FORMATS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label>
          File extension
          <select value={f.extension} onChange={(e) => set({ extension: e.target.value })}>
            <option value="csv">csv</option>
            <option value="txt">txt</option>
          </select>
        </label>
        <label className="check wide">
          <input type="checkbox" checked={f.header !== null} onChange={(e) => set({ header: e.target.checked ? (f.header ?? []) : null })} /> Header record
        </label>
        {f.header !== null && <FieldListEditor part="Header" sources={CONTROL_SOURCES} fields={f.header} onChange={(header) => set({ header })} newKey={newKey} />}
        <FieldListEditor part="Detail" sources={DETAIL_SOURCES} fields={f.detail} onChange={(detail) => set({ detail })} newKey={newKey} />
        <label className="check wide">
          <input type="checkbox" checked={f.trailer !== null} onChange={(e) => set({ trailer: e.target.checked ? (f.trailer ?? []) : null })} /> Trailer record
        </label>
        {f.trailer !== null && <FieldListEditor part="Trailer" sources={CONTROL_SOURCES} fields={f.trailer} onChange={(trailer) => set({ trailer })} newKey={newKey} />}
        <div className="row">
          <button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Saving…' : 'Save as a draft version'}
          </button>
        </div>
        <Missing text={problem} />
        <div className="wide">
          <Note text={note} />
          <Problem error={create.error} act="template" />
        </div>
      </form>
    </Section>
  );
}

// =========================================================================================================
// Reports (FR-038) and statutory outputs (FR-039): exactly as returned, nothing computed here
// =========================================================================================================

interface ReportRun {
  id: string;
  periodCode: string;
  revision: number;
  state: string;
  currencyCode: string;
  lockVersion: number | null;
  processedAt: string | null;
}
interface RegisterRow {
  recordId: string;
  employeeCode: string;
  employeeName: string;
  calculationStatus: string;
  salaryStopMode?: string | null;
  paidUnits: string | null;
  earnings: string | null;
  reimbursements: string | null;
  deductions: string | null;
  net: string | null;
  employerContributions: string | null;
  bankStatus: string | null;
  held: string;
  reserved: string;
  paid: string;
}
interface Register {
  run: ReportRun;
  scope: string;
  totals: { records: number; earnings: string; reimbursements: string; deductions: string; net: string; employerContributions: string; held: string; reserved: string; paid: string };
  items: RegisterRow[];
  next: string | null;
}
interface Disbursement {
  run: ReportRun;
  totals: { payable: string; held: string; heldBySalaryStop?: string; salaryStopHolds?: number; excludedBySalaryStop?: number; reserved: string; paid: string; ready: string; reconciles: boolean };
  salaryStopExclusions?: { employeeCode: string; employeeName: string; mode: string }[];
  manifests: { id: string; templateCode: string; templateVersion: number; batchRevision: number; state: string; lineCount: number; totalAmount: string | null; ledger: { paymentState: string; lines: number; amount: string | null }[] }[];
  paymentStatusSource: string;
}
interface StatutoryRow {
  code: string;
  sourceLabel: string;
  status: string;
  needs: string[];
}

const registerPath = (runId: string, after: string) => `/v1/payroll-outputs/runs/${encodeURIComponent(runId)}/register${after ? `?after=${encodeURIComponent(after)}` : ''}`;

/** A report execution as GET /v1/reports/:id returns it. */
interface ReportExecution {
  id: string;
  reportCode: string;
  state: string;
  rowCount: number | null;
  failureCode: string | null;
  format?: string;
}
const EXPORT_FORMATS = ['CSV', 'XLSX'] as const;
const EXPORT_STATE: Record<string, string> = {
  QUEUED: 'Queued: it is generated in the background',
  RUNNING: 'Being generated',
  COMPLETED: 'Ready to download',
  FAILED: 'Failed: nothing was generated',
  EXPIRED: 'Expired: request it again',
};

/**
 * FR-038 export of one run report through the report catalogue (PAYROLL_REGISTER, PAYROLL_DISBURSEMENT,
 * PAYROLL_COMPARISON): the same rows as the report shown above, generated in the background as CSV or XLSX; the
 * download re-checks access. Offered only with the export key.
 */
function RunReportExport({ runId, reportCode, name }: { runId: string; reportCode: string; name: string }) {
  const { can } = useSession();
  const [format, setFormat] = useState<string>('CSV');
  const [requested, setRequested] = useState<string | null>(null);
  const request = useMutation({
    mutationFn: (chosen: string) => api<{ id: string }>('/v1/reports', { body: { reportCode, filters: { runId }, format: chosen } }),
    onSuccess: (r) => setRequested(r.id),
  });
  if (!can(REPORT_EXPORT)) return null;
  return (
    <div style={{ marginTop: '0.5rem' }}>
      <form
        className="row"
        aria-label={`Export the ${name}`}
        onSubmit={(e) => {
          e.preventDefault();
          request.mutate(format);
        }}
      >
        <label className="inline">
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            {EXPORT_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="secondary" disabled={request.isPending}>
          {`Export the ${name}`}
        </button>
      </form>
      <Problem error={request.error} act="export" />
      {requested && <RunReportExportStatus key={requested} id={requested} name={name} />}
    </div>
  );
}

function RunReportExportStatus({ id, name }: { id: string; name: string }) {
  const keys = useKeys();
  const [error, setError] = useState<unknown>(null);
  const status = useQuery({
    queryKey: keys.reportExport(id),
    queryFn: () => api<ReportExecution>(`/v1/reports/${encodeURIComponent(id)}`),
    refetchInterval: (q) => (!isReportRefusal(q.state.error) && (q.state.data?.state === 'QUEUED' || q.state.data?.state === 'RUNNING') ? 3000 : false),
    retry: retryTransient,
  });
  const s = status.data;
  const format = s?.format ?? 'CSV';
  return (
    <div role="status" aria-label={`Export of the ${name}`}>
      {s ? (
        <p style={FLUSH}>
          {label(EXPORT_STATE, s.state)}
          {s.rowCount !== null && ` · ${s.rowCount} ${s.rowCount === 1 ? 'row' : 'rows'}`}
          {s.state === 'FAILED' && s.failureCode && ` · ${label(ACT_REFUSALS.export ?? {}, s.failureCode)}`}{' '}
          {s.state === 'COMPLETED' && (
            <button type="button" className="link" onClick={() => download(`/v1/reports/${encodeURIComponent(id)}/download`).catch(setError)}>
              {`Download ${format}`}
            </button>
          )}
        </p>
      ) : (
        !status.error && <p className="hint">Checking the export…</p>
      )}
      <Problem error={status.error} act="read" />
      <Problem error={error} act="download" />
    </div>
  );
}

function RunReportsScreen() {
  const { can } = useSession();
  const { id = '' } = useParams();
  if (!can(REPORT_READ)) {
    return (
      <Section title="Payroll reports">
        <Empty>The selected role cannot see payroll reports.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack" key={id}>
      <p style={FLUSH}>
        <Link to={PATHS.run(id)}>Back to the payroll run</Link>
        {can(STATUTORY_READ) && (
          <>
            {' · '}
            <Link to={PATHS.statutory}>Statutory outputs</Link>
          </>
        )}
      </p>
      <RegisterReport runId={id} />
      <DisbursementReport runId={id} />
      <ComparisonReport runId={id} />
      <JournalReport runId={id} />
    </div>
  );
}

function RegisterReport({ runId }: { runId: string }) {
  const keys = useKeys();
  const [after, setAfter] = useState('');
  const [previous, setPrevious] = useState<string[]>([]);
  const register = useQuery({ queryKey: keys.register(runId, after), queryFn: () => api<Register>(registerPath(runId, after)), retry: retryTransient });
  const d = register.data;
  const cur = d?.run.currencyCode;
  return (
    <Section title="Payroll register">
      {register.isPending && <p className="hint">Loading the register…</p>}
      {register.error && <Problem error={register.error} act="read" />}
      {d && (
        <>
          <dl className="kv">
            <Fact term="Run">{`${d.run.periodCode} revision ${d.run.revision}`}</Fact>
            <Fact term="State">
              <Status map={RUN_STATE} code={d.run.state} />
            </Fact>
            <Fact term="Lock version">{d.run.lockVersion ?? '—'}</Fact>
            <Fact term="Processed">{formatDate(d.run.processedAt)}</Fact>
          </dl>
          {d.scope === 'ROW_SCOPE' && <p className="hint">Only the records within your scope are listed and totalled.</p>}
          <dl className="kv" aria-label="Register totals">
            <Fact term="Records">{d.totals.records}</Fact>
            <Fact term="Earnings">{money(d.totals.earnings, cur)}</Fact>
            <Fact term="Reimbursements">{money(d.totals.reimbursements, cur)}</Fact>
            <Fact term="Deductions">{money(d.totals.deductions, cur)}</Fact>
            <Fact term="Net">{money(d.totals.net, cur)}</Fact>
            <Fact term="Employer contributions">{money(d.totals.employerContributions, cur)}</Fact>
            <Fact term="Held">{money(d.totals.held, cur)}</Fact>
            <Fact term="Reserved, not paid">{money(d.totals.reserved, cur)}</Fact>
            <Fact term="Paid (confirmed from bank evidence)">{money(d.totals.paid, cur)}</Fact>
          </dl>
          {d.items.length === 0 && <Empty>No records in this register.</Empty>}
          {d.items.length > 0 && (
            <div style={SCROLL}>
              <table aria-label="Payroll register">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Calculation</th>
                    <th>Salary stop</th>
                    <th>Paid units</th>
                    <th>Earnings</th>
                    <th>Deductions</th>
                    <th>Net</th>
                    <th>Held</th>
                    <th>Reserved, not paid</th>
                    <th>Paid (confirmed)</th>
                    <th>Bank</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((r) => (
                    <tr key={r.recordId}>
                      <td>{`${r.employeeCode} ${r.employeeName}`}</td>
                      <td>{readable(r.calculationStatus)}</td>
                      <td>{r.salaryStopMode ? readable(r.salaryStopMode) : '—'}</td>
                      <td>{r.paidUnits ?? '—'}</td>
                      <td>{money(r.earnings, cur)}</td>
                      <td>{money(r.deductions, cur)}</td>
                      <td>{money(r.net, cur)}</td>
                      <td>{money(r.held, cur)}</td>
                      <td>{money(r.reserved, cur)}</td>
                      <td>{money(r.paid, cur)}</td>
                      <td>{r.bankStatus ? readable(r.bankStatus) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="row" style={{ marginTop: '0.5rem' }}>
            {previous.length > 0 && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setAfter(previous[previous.length - 1] ?? '');
                  setPrevious(previous.slice(0, -1));
                }}
              >
                Previous page
              </button>
            )}
            {d.next && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setPrevious([...previous, after]);
                  setAfter(d.next ?? '');
                }}
              >
                Next page
              </button>
            )}
          </div>
        </>
      )}
      <RunReportExport runId={runId} reportCode="PAYROLL_REGISTER" name="payroll register" />
    </Section>
  );
}

function DisbursementReport({ runId }: { runId: string }) {
  const keys = useKeys();
  const report = useQuery({ queryKey: keys.disbursement(runId), queryFn: () => api<Disbursement>(`/v1/payroll-outputs/runs/${encodeURIComponent(runId)}/disbursement`), retry: retryTransient });
  const d = report.data;
  const cur = d?.run.currencyCode;
  return (
    <Section title="Disbursement reconciliation">
      {report.isPending && <p className="hint">Loading the reconciliation…</p>}
      {report.error && <Problem error={report.error} act="read" />}
      {d && (
        <>
          <dl className="kv" aria-label="Reconciliation totals">
            <Fact term="Approved payable">{money(d.totals.payable, cur)}</Fact>
            <Fact term="Held">{money(d.totals.held, cur)}</Fact>
            {/* FR-031: what salary stops withhold, a part of Held, apart from policy holds and payment safety blocks. */}
            {(d.totals.salaryStopHolds ?? 0) > 0 && <Fact term="Of held, by salary stop">{`${money(d.totals.heldBySalaryStop ?? '0', cur)} for ${d.totals.salaryStopHolds} ${d.totals.salaryStopHolds === 1 ? 'employee' : 'employees'}`}</Fact>}
            <Fact term="Reserved, not paid">{money(d.totals.reserved, cur)}</Fact>
            <Fact term="Paid (confirmed from bank evidence)">{money(d.totals.paid, cur)}</Fact>
            <Fact term="Ready to pay">{money(d.totals.ready, cur)}</Fact>
            {/* FR-031: no net, so in none of the figures above. */}
            {(d.salaryStopExclusions?.length ?? 0) > 0 && (
              <Fact term="Excluded from calculation by a salary stop">{d.salaryStopExclusions!.map((x) => `${x.employeeCode} ${x.employeeName}`).join(', ')}</Fact>
            )}
            <Fact term="Reconciles">
              {d.totals.reconciles ? <Badge tone="good">Yes: payable equals held, reserved, paid and ready</Badge> : <Badge tone="bad">No: the figures do not reconcile; report this</Badge>}
            </Fact>
          </dl>
          {d.paymentStatusSource === 'RECORDED_OUTCOME_EVIDENCE_ONLY' && <p className="hint">Payment status comes only from the outcomes recorded from bank evidence.</p>}
          {d.manifests.length === 0 && <Empty>No bank manifest for this run yet.</Empty>}
          {d.manifests.length > 0 && (
            <div style={SCROLL}>
              <table aria-label="Manifests of the run">
                <thead>
                  <tr>
                    <th>Template</th>
                    <th>Manifest revision</th>
                    <th>State</th>
                    <th>Lines</th>
                    <th>Total</th>
                    <th>Payment states</th>
                  </tr>
                </thead>
                <tbody>
                  {d.manifests.map((m) => (
                    <tr key={m.id}>
                      <td>{`${m.templateCode} version ${m.templateVersion}`}</td>
                      <td>{m.batchRevision}</td>
                      <td>
                        <Status map={BATCH_STATE} code={m.state} />
                      </td>
                      <td>{m.lineCount}</td>
                      <td>{money(m.totalAmount, cur)}</td>
                      <td>{m.ledger.length === 0 ? '—' : m.ledger.map((l) => `${label(PAYMENT_STATE, l.paymentState)}: ${l.lines} ${l.lines === 1 ? 'line' : 'lines'}, ${money(l.amount, cur)}`).join('; ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <RunReportExport runId={runId} reportCode="PAYROLL_DISBURSEMENT" name="reconciliation totals" />
    </Section>
  );
}

function ComparisonReport({ runId }: { runId: string }) {
  const keys = useKeys();
  // The currency of the run comes with the register's first page (the same cached answer).
  const header = useQuery({ queryKey: keys.register(runId, ''), queryFn: () => api<Register>(registerPath(runId, '')), retry: retryTransient });
  const report = useQuery({ queryKey: keys.comparison(runId), queryFn: () => api<RunComponents>(`/v1/payroll-outputs/runs/${encodeURIComponent(runId)}/comparison`), retry: retryTransient });
  const c = report.data;
  return (
    <Section title="Prior-period comparison">
      {report.isPending && <p className="hint">Loading the comparison…</p>}
      {report.error && <Problem error={report.error} act="read" />}
      {c?.basis === 'SCOPE' && <p className="hint">Your scope covers part of this run: the records in your scope are compared with the same employees’ latest earlier processed records.</p>}
      {c?.basis === 'RUN' && !c.priorPeriodCode && <p className="hint">No earlier processed run of this calendar and scope to compare with.</p>}
      {c && <ComponentTable c={c} currency={header.data?.run.currencyCode ?? ''} name="Prior-period comparison" />}
      <RunReportExport runId={runId} reportCode="PAYROLL_COMPARISON" name="comparison" />
    </Section>
  );
}

function JournalReport({ runId }: { runId: string }) {
  const keys = useKeys();
  const jv = useQuery({ queryKey: keys.journal(runId), queryFn: () => api<unknown>(`/v1/payroll-outputs/runs/${encodeURIComponent(runId)}/journal`), retry: retryTransient });
  const notConfigured = jv.error instanceof ApiError && jv.error.code === 'NOT_CONFIGURED';
  return (
    <Section title="Journal voucher">
      {jv.isPending && <p className="hint">Checking the journal voucher…</p>}
      {notConfigured && (
        <p>
          <Badge tone="warn">Not configured</Badge> A journal voucher needs an approved chart-of-accounts mapping for the payroll heads. None is configured, so no voucher is produced.
        </p>
      )}
      {jv.error && !notConfigured && <Problem error={jv.error} act="read" />}
    </Section>
  );
}

const OUTPUT_STATUS: Record<string, string> = { NOT_CONFIGURED: 'Not configured' };

function StatutoryScreen() {
  const { can } = useSession();
  const keys = useKeys();
  const outputs = useQuery({ queryKey: keys.statutory, queryFn: () => api<{ items: StatutoryRow[] }>('/v1/payroll-outputs/statutory-outputs'), enabled: can(STATUTORY_READ), retry: retryTransient });
  if (!can(STATUTORY_READ)) {
    return (
      <Section title="Statutory outputs">
        <Empty>The selected role cannot see statutory outputs.</Empty>
      </Section>
    );
  }
  return (
    <Section title="Statutory outputs">
      <p className="hint">
        Each statutory register, certificate and return needs an activated rule pack and the payroll owner’s period template. Until they exist nothing is produced; the source labels are kept as written until the owner confirms them.
      </p>
      {outputs.isPending && <p className="hint">Loading statutory outputs…</p>}
      {outputs.error && <Problem error={outputs.error} act="read" />}
      {outputs.data && outputs.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Statutory outputs">
            <thead>
              <tr>
                <th>Output</th>
                <th>Code</th>
                <th>Status</th>
                <th>What it needs</th>
              </tr>
            </thead>
            <tbody>
              {outputs.data.items.map((o) => (
                <tr key={o.code}>
                  <td>{o.sourceLabel}</td>
                  <td>{o.code}</td>
                  <td>
                    <Badge tone="warn">{label(OUTPUT_STATUS, o.status)}</Badge>
                  </td>
                  <td>{o.needs.join('; ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// =========================================================================================================
// HR loans: request for an employee, disbursement from evidence, cancellation, recovery recognition
// =========================================================================================================

function LoanRequestFor() {
  const keys = useKeys();
  const qc = useQueryClient();
  const intent = useIntentKey('payroll-loan-for');
  const [employee, setEmployee] = useState<EmployeeHit | null>(null);
  const [loanKind, setLoanKind] = useState('LOAN');
  const [currencyCode, setCurrencyCode] = useState('');
  const [principal, setPrincipal] = useState('');
  const [purpose, setPurpose] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const request = useMutation({
    mutationFn: ({ employeeId, body }: { employeeId: string; body: Record<string, unknown> }) => api<Loan & { replayed: boolean }>(`/v1/payroll-outputs/employees/${encodeURIComponent(employeeId)}/loans`, { body }),
    onSettled: (_d, error) => {
      intent.settle(error);
      void qc.invalidateQueries({ queryKey: keys.loansAll });
    },
    onSuccess: (l) => {
      setEmployee(null);
      setPrincipal('');
      setPurpose('');
      setNote(
        l.replayed
          ? 'This request had already been recorded; nothing was requested twice.'
          : `${label(LOAN_KIND, l.loanKind)} of ${money(l.principal, l.currencyCode)} requested for ${l.employeeCode}: it waits for an independent decision. Loans carry no interest.`,
      );
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (request.isPending) return;
    const currency = currencyCode.trim().toUpperCase();
    if (!employee) return setProblem('Choose the employee.');
    if (!/^[A-Z]{3}$/.test(currency)) return setProblem('The currency is a three-letter ISO code.');
    if (!MONEY.test(principal.trim()) || ZERO.test(principal.trim())) return setProblem('Enter the amount: above zero, with at most four decimals.');
    if (!purpose.trim()) return setProblem('Give the purpose of the request.');
    setProblem(null);
    setNote(null);
    request.reset();
    const body = { loanKind, currencyCode: currency, principal: principal.trim(), purpose: purpose.trim() };
    request.mutate({ employeeId: employee.id, body: { ...body, idempotencyKey: intent.key(JSON.stringify([employee.id, body])) } });
  };
  return (
    <Section title="Request a loan or advance for an employee">
      <form onSubmit={submit} aria-label="Request a loan for an employee" className="grid-form">
        <EmployeePicker title="Employee" value={employee} onChange={setEmployee} />
        <label>
          Kind
          <select value={loanKind} onChange={(e) => setLoanKind(e.target.value)}>
            {Object.entries(LOAN_KIND).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Currency
          <input value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} maxLength={3} autoComplete="off" />
        </label>
        <label>
          Amount
          <input value={principal} onChange={(e) => setPrincipal(e.target.value)} inputMode="decimal" maxLength={20} autoComplete="off" />
        </label>
        <label className="wide">
          Purpose
          <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
        </label>
        <div className="row">
          <button type="submit" disabled={request.isPending}>
            {request.isPending ? 'Sending…' : 'Send the request'}
          </button>
        </div>
        <Missing text={problem} />
        <div className="wide">
          <Note text={note} />
          <Problem error={request.error} act="loan-request" />
        </div>
      </form>
      <p className="hint">
        Many requests at once: <Link to={PATHS.loanUpload}>upload a file of loan and advance requests</Link>.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// FR-034 "entry and upload": the LOAN_REQUESTS_V1 upload (payroll-outputs/loan-import.ts) through the shared batch
// screens (records.tsx): template download, row-by-row preview, an explicit all-or-nothing commit or cancel, the user's
// own batches and a batch held for the malware scan. Each row is checked exactly as a request entered above, under the
// same payroll_loan.request.loan grant; every entered request waits for its own independent decision.
// ---------------------------------------------------------------------------------------------------------

/** LOAN_REQUESTS_V1 row problems (loan-import.ts, imports/batch.ts and the request rules of loans.ts) in plain words. */
const LOAN_ROW_PROBLEMS: Record<string, string> = {
  UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code.',
  OUT_OF_SCOPE: 'The employee is outside the scope of the selected role.',
  SELF_ACTION_NOT_ALLOWED: 'This is your own record: a loan for you is requested by you in your Employee role, or entered by someone else.',
  INVALID_LOAN_KIND: 'The loan kind is LOAN or ADVANCE, in capital letters.',
  INVALID_CURRENCY: 'The currency is a three-letter ISO code in capital letters.',
  INVALID_AMOUNT: 'The principal is a positive amount: digits only, no commas, and no more decimals than the currency allows.',
  CURRENCY_NOT_CONFIGURED: 'No active payroll calendar pays in this currency.',
  PURPOSE_REQUIRED: 'Give the purpose of the request (at most 1,000 characters).',
  COLUMN_COUNT: 'The row does not have exactly one cell for each column of the header.',
};

const LOAN_IMPORT: ImportTemplate = {
  code: 'LOAN_REQUESTS_V1',
  label: 'Loan and advance requests',
  permissions: [LOAN_REQUEST],
  base: '/v1/payroll-outputs/loan-imports',
  columns: 'employeeCode,loanKind,currencyCode,principal,purpose',
  keyLabel: 'Employee code',
  noun: ['loan request', 'loan requests'],
  verb: 'Enter',
  note: 'Each row requests a loan or advance for one employee, checked exactly as a request entered on the loans screen: loanKind LOAN or ADVANCE, currencyCode a three-letter code an active payroll calendar pays in, principal as digits with no commas and no more decimals than that currency allows, and the purpose (put it in double quotes if it holds a comma). Loans carry no interest: no approved interest rate is configured. Every request entered waits for an independent decision, loan by loan; the upload approves nothing.',
  problems: LOAN_ROW_PROBLEMS,
};

function LoanUploadScreen() {
  const { can } = useSession();
  if (!can(LOAN_REQUEST)) {
    return (
      <Section title="Loan and advance upload">
        <Empty>The selected role cannot enter loan requests: that needs the loan request grant.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      <LoanUpload />
    </div>
  );
}

function LoanUpload() {
  const t = LOAN_IMPORT;
  const keys = useKeys();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  // Remounting the file input clears the chosen file once its preview is on screen.
  const [fileInput, setFileInput] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  // One idempotency key per chosen file: validating the same file again (after a lost answer) returns the same batch.
  const uploadKey = useRef<string | null>(null);
  const choose = (next: File | null) => {
    setFile(next);
    uploadKey.current = null;
  };
  const { resume, open, refresh, watch } = useBatchFollowUp(
    t.base,
    {
      show: setJob,
      closed: (id) => setJob((shown) => (shown?.id === id ? null : shown)),
      onStart: () => {
        upload.reset();
        act.reset();
      },
    },
    job,
  );
  const act = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'commit' | 'cancel' }) => {
      // The decision and any look at the batch after it go out under the role it was made in (BR-046).
      const send = pinSession();
      try {
        return await send<ImportJob>(`${t.base}/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      } catch (err) {
        // The batch may have moved on (this very decision went through but its answer was lost): its view says where it stands.
        const current = await send<ImportJob>(`${t.base}/${encodeURIComponent(id)}`).catch(() => null);
        if (current?.state === (action === 'commit' ? 'COMMITTED' : 'CANCELLED')) return current;
        if (current) setJob((shown) => (shown?.id === id ? current : shown));
        throw err;
      }
    },
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: (view) => {
      setJob(view);
      // A committed batch entered loan requests: the loan list and the decision queue show them.
      if (view.state === 'COMMITTED') void qc.invalidateQueries({ queryKey: keys.loansAll });
    },
    onSettled: refresh,
  });
  const upload = useMutation({
    mutationFn: async (f: File) => {
      const key = (uploadKey.current ??= idempotencyKey('payroll-loan-import'));
      return api<ImportJob>(t.base, { body: { fileName: f.name, contentBase64: await fileToBase64(f), idempotencyKey: key } });
    },
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: (view) => {
      setJob(view);
      act.reset();
      // The preview is on screen, so the form starts clean: the next file is a new upload with its own key.
      setFile(null);
      uploadKey.current = null;
      setFileInput((n) => n + 1);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'IDEMPOTENCY_KEY_IN_USE') uploadKey.current = null;
    },
    onSettled: refresh,
  });
  const busy = upload.isPending || act.isPending || resume.isPending || open.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (file && !busy) upload.mutate(file);
  };
  return (
    <>
      <Section title="Upload loan and advance requests">
        <form onSubmit={submit} aria-label="Upload loan requests" className="stack">
          <p className="hint">
            CSV with exactly the header <code>{t.columns}</code> (template {t.code}). {t.note} Nothing is requested until you commit a preview, and a batch is applied all or
            nothing: one row with a problem rejects the whole batch. <Link to={PATHS.loans}>Loans and advances</Link>
          </p>
          <TemplateDownload base={t.base} code={t.code} />
          <div className="inline">
            <label>
              Loan requests file
              <input key={fileInput} type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => choose(e.target.files?.[0] ?? null)} />
            </label>
            <button type="submit" disabled={!file || busy}>
              Validate
            </button>
          </div>
        </form>
        <Problem error={upload.error ?? resume.error} act="loan-upload" />
      </Section>
      {job && (
        <>
          <ImportJobView job={job} template={t} pending={act.isPending} onAction={(action) => act.mutate({ id: job.id, action })} error={act.error} />
          {job.state === 'COMMITTED' && (
            <p role="status" className="ok">
              Every request entered waits for an independent decision, loan by loan: someone other than you and the employee decides each one.
            </p>
          )}
          <HeldBatchCheck job={job} busy={busy} onCheck={() => resume.mutate(job.id)} checked={resume.isPending ? undefined : resume.data} watch={watch} />
        </>
      )}
      <ImportBatches base={t.base} title="Your loan request batches" openedId={job?.id ?? null} busy={busy} onOpen={(id) => open.mutate(id)} error={open.error} />
    </>
  );
}

function DisbursementForm({ loan, onDone }: { loan: Loan; onDone: (text: string) => void }) {
  const { me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const intent = useIntentKey('payroll-loan-disbursement');
  const [date, setDate] = useState('');
  const [reference, setReference] = useState('');
  const [documents, setDocuments] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const involved = loan.requestedBy === me?.userId || loan.decidedBy === me?.userId;
  const disburse = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Loan & { replayed: boolean }>(`/v1/payroll-outputs/loans/${encodeURIComponent(loan.id)}/disbursement`, { body }),
    onSettled: (_d, error) => {
      intent.settle(error);
      void qc.invalidateQueries({ queryKey: keys.loansAll });
    },
    onSuccess: (l) =>
      onDone(
        l.replayed
          ? 'This disbursement had already been recorded with this evidence key; nothing was recorded twice.'
          : `The disbursement of ${money(l.principal, l.currencyCode)} on ${formatDate(l.disbursementDate)} is recorded from its evidence; it is recovered through processed payroll.`,
      ),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (disburse.isPending || involved) return;
    if (!date) return setProblem('Give the date the amount was disbursed.');
    if (date > localDate()) return setProblem('A disbursement is recorded once it has happened: the date cannot be in the future.');
    if (!reference.trim() || documents.length !== 1) return setProblem('Give the evidence reference and choose the released, verified document of the disbursement.');
    setProblem(null);
    disburse.reset();
    const intended = [date, reference.trim(), documents];
    disburse.mutate({ disbursementDate: date, evidenceKey: intent.key(JSON.stringify(intended)), evidenceReference: reference.trim(), evidenceDocumentIds: documents, expectedVersion: loan.version });
  };
  return (
    <form onSubmit={submit} aria-label={`Record the disbursement of the loan of ${loan.employeeCode}`} className="grid-form" style={{ marginTop: '0.5rem' }}>
      <h3 style={H3} className="wide">
        Record the disbursement
      </h3>
      {involved && <p className="hint wide">You requested or decided this loan, so someone else records its disbursement.</p>}
      <label>
        Disbursement date
        <input type="date" value={date} max={localDate()} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label>
        Evidence reference
        <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={500} autoComplete="off" />
      </label>
      <EvidencePicker employeeId={loan.employeeId} chosen={documents} onChange={setDocuments} max={1} />
      <div className="row">
        <button type="submit" disabled={disburse.isPending || involved}>
          {disburse.isPending ? 'Recording…' : 'Record the disbursement'}
        </button>
      </div>
      <Missing text={problem} />
      <div className="wide">
        <Problem error={disburse.error} act="disburse" />
      </div>
    </form>
  );
}

function LoanCancel({ loan, onDone }: { loan: Loan; onDone: (text: string) => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: (reason: string) => api<Loan>(`/v1/payroll-outputs/loans/${encodeURIComponent(loan.id)}/cancel`, { body: { reason, expectedVersion: loan.version } }),
    onSuccess: () => onDone(`The approved ${label(LOAN_KIND, loan.loanKind).toLowerCase()} of ${loan.employeeCode} was cancelled; nothing was disbursed.`),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.loansAll }),
  });
  return (
    <>
      <ReasonForm
        name={`Cancel the approved loan of ${loan.employeeCode}`}
        field="Why the approved loan is cancelled"
        button="Cancel the approved loan"
        busy={cancel.isPending}
        danger
        onSend={(reason) => cancel.mutateAsync(reason)}
      />
      <Problem error={cancel.error} act="loan-cancel" />
    </>
  );
}

interface RecoveryResult {
  runId: string;
  recognised: number;
  closed: number;
  exceptions: { loanId: string; employeeCode: string; code: string }[];
  remaining: number;
  done: boolean;
}

function LoanRecoveries({ run }: { run: RunDetail }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const recognise = useMutation({
    mutationFn: () => api<RecoveryResult>(`/v1/payroll-outputs/runs/${encodeURIComponent(run.id)}/loan-recoveries`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.loansAll }),
  });
  const r = recognise.data;
  return (
    <Section title="Loan recoveries">
      <p className="hint">Recoveries are recognised only from this processed run’s frozen deduction lines, and never above a loan’s outstanding balance.</p>
      <div className="row">
        <button type="button" disabled={recognise.isPending} onClick={() => recognise.mutate()}>
          {recognise.isPending ? 'Recognising…' : r && !r.done ? 'Continue' : 'Recognise loan recoveries'}
        </button>
      </div>
      {r && (
        <p role="status" className="ok">
          {`${r.recognised} ${r.recognised === 1 ? 'recovery' : 'recoveries'} recognised in this pass; ${r.closed} ${r.closed === 1 ? 'loan' : 'loans'} fully recovered and closed. ${
            r.done ? 'Every recovery of this run is recognised.' : `${r.remaining} still to recognise: continue.`
          }`}
        </p>
      )}
      {r && r.exceptions.length > 0 && (
        <ul aria-label="Recoveries not recognised">
          {r.exceptions.map((x) => (
            <li key={x.loanId}>
              {`${x.employeeCode}: ${
                x.code === 'RECOVERY_EXCEEDS_OUTSTANDING' ? 'the deduction is above the outstanding balance (or in another currency), so it was not recognised; it needs a later-period correction' : readable(x.code)
              }.`}
            </li>
          ))}
        </ul>
      )}
      <Problem error={recognise.error} act="recover" />
    </Section>
  );
}

// =========================================================================================================
// Run extras: rerun check, members left out of a draft
// =========================================================================================================

interface VerifyResult {
  identical: boolean;
  records: number;
  lines: number;
  lineDifferences: number;
  totalDifferences: number;
  paidDayDifferences: number;
  complete: boolean;
  nextAfter: string | null;
}

function RunVerify({ run }: { run: RunDetail }) {
  const [differs, setDiffers] = useState(false);
  const verify = useMutation({
    mutationFn: (after: string | null) => api<VerifyResult>(`/v1/payroll/runs/${encodeURIComponent(run.id)}/verify${after ? `?after=${encodeURIComponent(after)}` : ''}`, { method: 'POST' }),
    onSuccess: (r, after) => setDiffers((prior) => (after ? prior : false) || !r.identical),
  });
  const r = verify.data;
  const nextAfter = r && !r.complete ? r.nextAfter : null;
  return (
    <Section title="Rerun check">
      <p className="hint">Recalculates every record of this revision from its stored snapshot and compares the results with what is stored. Nothing is changed.</p>
      <div className="row">
        <button type="button" className="secondary" disabled={verify.isPending} onClick={() => verify.mutate(nextAfter)}>
          {verify.isPending ? 'Checking…' : nextAfter ? 'Continue the check' : 'Check by recalculating'}
        </button>
      </div>
      {r && (
        <p role="status" className={r.identical ? 'ok' : 'error'}>
          {`This pass checked ${r.records} records and ${r.lines} lines: ${
            r.identical ? 'identical to the stored results' : `differences found (${r.lineDifferences} lines, ${r.totalDifferences} totals, ${r.paidDayDifferences} paid-day counts)`
          }.${r.complete ? (differs ? ' The rerun found differences: report this to the payroll administrator.' : ' The rerun gives identical results for the whole revision.') : ' The check stopped at its time limit: continue it.'}`}
        </p>
      )}
      <Problem error={verify.error} act="verify" />
    </Section>
  );
}

function MemberExclusion({ run }: { run: RunDetail }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<EmployeeHit[]>([]);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const exclude = useMutation({
    mutationFn: (body: { employeeIds: string[]; reason: string; expectedVersion: number }) => api<RunDetail>(`/v1/payroll/runs/${encodeURIComponent(run.id)}/exclusions`, { body }),
    onSuccess: (r) => {
      setChosen([]);
      setReason('');
      setOpen(false);
      setNote(`Left out of this revision: ${r.members.excluded} in all; ${r.members.included} members remain.`);
    },
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: keys.runAll }), qc.invalidateQueries({ queryKey: keys.runsAll })]),
  });
  if (!open) {
    return (
      <div>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setNote(null);
            setOpen(true);
          }}
        >
          Leave members out of this draft
        </button>
        <Note text={note} />
      </div>
    );
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (exclude.isPending) return;
    if (chosen.length === 0 || !reason.trim()) return setProblem('Choose who is left out and give the reason.');
    setProblem(null);
    exclude.reset();
    exclude.mutate({ employeeIds: chosen.map((x) => x.id), reason: reason.trim(), expectedVersion: run.version });
  };
  return (
    <form onSubmit={submit} aria-label="Leave members out of this draft" className="grid-form">
      <EmployeePicker title="Member to leave out" value={null} onChange={(e) => e && setChosen(chosen.some((x) => x.id === e.id) ? chosen : [...chosen, e])} />
      {chosen.length > 0 && (
        <ul className="wide" aria-label="Members to leave out">
          {chosen.map((x) => (
            <li key={x.id}>
              {person(x)}{' '}
              <button type="button" className="link" onClick={() => setChosen(chosen.filter((y) => y.id !== x.id))} aria-label={`Keep ${person(x)}`}>
                Keep
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="wide">
        Why they are left out
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
      </label>
      <div className="row">
        <button type="submit" disabled={exclude.isPending}>
          {exclude.isPending ? 'Saving…' : 'Leave them out'}
        </button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <Missing text={problem} />
      <div className="wide">
        <Problem error={exclude.error} act="exclude" />
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Exports for the navigation step (App.tsx wires these)
// ---------------------------------------------------------------------------------------------------------

/**
 * Screens of the payroll module; detail screens are reached through links (nav: false). The run list accepts either
 * run read group (operational status or amounts), so its menu entry is keyed to the operational one the payroll,
 * finance and treasury roles hold; amounts, records and outputs appear only for the confidential grants.
 */
// =========================================================================================================
// Payroll configuration (FR-028 to FR-030, FR-032; DF05; H2; I-28): calendars and their periods, the paid-day
// policy, pay components and their head revisions, and the salary components of an arrangement. No default exists
// on purpose, so nothing is prefilled: every business value is the company's own choice. Each draft is activated by
// someone other than its author; the server checks every rule and its refusals are explained in words.
// =========================================================================================================

const CONFIG_MANAGE = 'payroll_config.manage.operational';
const CONFIG_ACTIVATE = 'payroll_config.activate.operational';
const SALARY_READ = 'salary.read.salary';
const SALARY_MANAGE = 'salary.manage.salary';

interface CalendarPeriod {
  id: string;
  periodCode: string;
  financialYear: string;
  serviceStart: string;
  serviceEnd: string;
  inputCutoff: string;
  paymentDate: string;
  version: number;
}
interface CalendarDetail {
  id: string;
  code: string;
  name: string;
  currencyCode: string;
  currencyMinorUnit: number;
  state: string;
  createdBy: string | null;
  activatedAt: string | null;
  version: number;
  periods: CalendarPeriod[];
}
interface PayComponent {
  id: string;
  code: string;
  name: string;
  componentKind: string;
  active: boolean;
  headInEffect: { revisionId: string; revision: number; effectiveFrom: string; inUse: boolean; headType: string | null; calculationBasis: string | null } | null;
}
interface HeadRevision {
  id: string;
  componentCode: string;
  componentName: string;
  componentKind: string;
  revision: number;
  effectiveFrom: string;
  inUse: boolean;
  headType: string | null;
  calculationBasis: string | null;
  roundingRule: string | null;
  taxTreatment: string | null;
  rulePackCode: string | null;
  displaySequence: number | null;
  baseComponentCodes: string[];
  state: string;
  createdBy: string | null;
  version: number;
}
interface PaidDayPolicy {
  id: string;
  revision: number;
  effectiveFrom: string;
  attendanceBasis: string;
  absentUnpaidUnits: string | null;
  halfDayUnpaidUnits: string | null;
  state: string;
  createdBy: string | null;
  version: number;
}
interface SalaryArrangementRow {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  annualCtc?: string | null;
  monthlyGross?: string | null;
  currency: string;
}
interface ArrangementComponents {
  arrangementId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  annualCtc?: string | null;
  monthlyGross?: string | null;
  currencyCode: string;
  components: { componentCode: string; componentName: string; componentKind: string; amount: string; basis: string }[];
  totals: { basis: string; componentKind: string; total: string }[];
}

const CONFIG_STATE: Record<string, string> = { DRAFT: 'Draft, not active', ACTIVE: 'Active', SUPERSEDED: 'Superseded by a correction', CANCELLED: 'Cancelled', RETIRED: 'Retired' };
const COMPONENT_KIND: Record<string, string> = { EARNING: 'Earning', DEDUCTION: 'Deduction' };
const CALCULATION_BASIS: Record<string, string> = { FIXED: 'Fixed (from the salary components)', INPUT: 'From approved inputs', RULE_PACK: 'Rule pack' };
const ROUNDING: Record<string, string> = { HALF_UP_MINOR_UNIT: 'Half up to the currency minor unit (DF05)' };
const HEAD_USE: Record<string, string> = { IN_USE: 'In use from this date', DISCONTINUED: 'Discontinued from this date' };
const AMOUNT_BASIS: Record<string, string> = { MONTHLY: 'Monthly', ANNUAL: 'Annual' };
const ATTENDANCE_BASIS: Record<string, string> = { APPROVED_LEAVE_ONLY: 'Approved unpaid leave only', REVIEWED_ATTENDANCE: 'Approved unpaid leave and reviewed attendance' };
const MINOR_UNITS: Record<string, string> = { '0': '0 decimals', '1': '1 decimal', '2': '2 decimals', '3': '3 decimals', '4': '4 decimals' };
/** The PAYROLL_TAX_TREATMENT values the module registers; a company may add its own (no payroll route lists them). */
const TAX_TREATMENTS = ['TAXABLE', 'NON_TAXABLE', 'PER_TAX_RULE_PACK'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UNITS = /^\d(\.\d{1,2})?$/;
const RULE_PACK_BLOCKS = 'Blocks calculation until a rule pack exists: no rule pack is configured, so every employee this head applies to is blocked until the head is left out through a new revision.';
const NOT_CONFIG = 'The selected role cannot see the payroll configuration.';

/** A choice the user must make: it starts empty, because no default exists. */
function Choice({ label: text, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Record<string, string> }) {
  return (
    <label>
      {text}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {Object.entries(options).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Independent activation of a draft: never offered to its author (the server refuses that too). */
function ActivateControl({ state, createdBy, name, busy, onActivate }: { state: string; createdBy: string | null; name: string; busy: boolean; onActivate: () => void }) {
  const { me } = useSession();
  if (state !== 'DRAFT') return <>—</>;
  if (createdBy !== null && createdBy === me?.userId) return <>You wrote it: someone else activates it</>;
  return (
    <button type="button" className="link" disabled={busy} onClick={onActivate} aria-label={`Activate ${name}`}>
      Activate
    </button>
  );
}

function useCalendars() {
  const { can } = useSession();
  const keys = useKeys();
  return useQuery({ queryKey: keys.calendars, queryFn: () => api<{ items: CalendarDetail[] }>('/v1/payroll/calendars'), enabled: can(CONFIG_READ), retry: retryTransient });
}

function usePayComponents() {
  const { can } = useSession();
  const keys = useKeys();
  return useQuery({ queryKey: keys.payComponents, queryFn: () => api<{ items: PayComponent[] }>('/v1/payroll/components'), enabled: can(CONFIG_READ), retry: retryTransient });
}

function useCalendarActivation(onDone: (text: string) => void) {
  const keys = useKeys();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (k: { id: string; version: number }) => api<CalendarDetail>(`/v1/payroll/calendars/${encodeURIComponent(k.id)}/activate`, { body: { expectedVersion: k.version } }),
    onSuccess: (k) => onDone(`Calendar ${k.code} is active: payroll runs and inputs can now use its periods.`),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.calendars }),
  });
}

// ---- Calendars and periods (FR-030) ----

function CalendarsScreen() {
  const { can } = useSession();
  if (!can(CONFIG_READ)) {
    return (
      <Section title="Payroll calendars">
        <Empty>{NOT_CONFIG}</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      <CalendarList />
      {can(CONFIG_MANAGE) && <CalendarForm />}
      <PaidDayPolicySection />
    </div>
  );
}

function CalendarList() {
  const { can } = useSession();
  const calendars = useCalendars();
  const [note, setNote] = useState<string | null>(null);
  const activate = useCalendarActivation(setNote);
  const activator = can(CONFIG_ACTIVATE);
  return (
    <Section title="Payroll calendars">
      <p className="hint">
        No calendar exists by default. A calendar is saved as a draft with its currency, gets its monthly periods, and is activated by someone other than its author; runs and
        inputs use only the periods of an active calendar.
      </p>
      {calendars.isPending && <p className="hint">Loading payroll calendars…</p>}
      {calendars.error && <Problem error={calendars.error} act="read" />}
      <Note text={note} />
      {calendars.data && calendars.data.items.length === 0 && <Empty>No payroll calendar is defined, so no payroll can be run yet.</Empty>}
      {calendars.data && calendars.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Payroll calendars">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Currency</th>
                <th>Minor unit</th>
                <th>Periods</th>
                <th>State</th>
                {activator && <th>Activation</th>}
              </tr>
            </thead>
            <tbody>
              {calendars.data.items.map((k) => (
                <tr key={k.id}>
                  <td>
                    <Link to={PATHS.calendar(k.id)} aria-label={`Open calendar ${k.code}`}>
                      {k.code}
                    </Link>
                  </td>
                  <td>{k.name}</td>
                  <td>{k.currencyCode}</td>
                  <td>{label(MINOR_UNITS, String(k.currencyMinorUnit))}</td>
                  <td>{k.periods.length}</td>
                  <td>
                    <Status map={CONFIG_STATE} code={k.state} />
                  </td>
                  {activator && (
                    <td>
                      <ActivateControl
                        state={k.state}
                        createdBy={k.createdBy}
                        name={`calendar ${k.code}`}
                        busy={activate.isPending}
                        onActivate={() => {
                          setNote(null);
                          activate.mutate(k);
                        }}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Problem error={activate.error} act="calendar-activate" />
    </Section>
  );
}

function CalendarForm() {
  const keys = useKeys();
  const qc = useQueryClient();
  const empty = { code: '', name: '', currencyCode: '', currencyMinorUnit: '' };
  const [f, setF] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<CalendarDetail>('/v1/payroll/calendars', { body }),
    onSuccess: (k) => {
      setF(empty);
      setNote(`Calendar ${k.code} saved as a draft: add its periods; someone other than you activates it.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.calendars }),
  });
  const set = (patch: Partial<typeof empty>) => setF((prev) => ({ ...prev, ...patch }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    const currency = f.currencyCode.trim().toUpperCase();
    if (!f.code.trim() || !f.name.trim()) return setProblem('Give the calendar code and name.');
    if (!/^[A-Z]{3}$/.test(currency)) return setProblem('The currency is a three-letter ISO code.');
    if (!(f.currencyMinorUnit in MINOR_UNITS)) return setProblem('Choose the currency’s minor unit (its number of decimals).');
    setProblem(null);
    setNote(null);
    create.reset();
    create.mutate({ code: f.code.trim().toUpperCase(), name: f.name.trim(), currencyCode: currency, currencyMinorUnit: Number(f.currencyMinorUnit) });
  };
  return (
    <Section title="New payroll calendar">
      <form onSubmit={submit} aria-label="Create a payroll calendar" className="grid-form">
        <label>
          Calendar code
          <input value={f.code} onChange={(e) => set({ code: e.target.value })} maxLength={40} autoComplete="off" />
        </label>
        <label>
          Calendar name
          <input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} autoComplete="off" />
        </label>
        <label>
          Currency (ISO code)
          <input value={f.currencyCode} onChange={(e) => set({ currencyCode: e.target.value })} maxLength={3} autoComplete="off" />
        </label>
        <Choice label="Currency minor unit" value={f.currencyMinorUnit} onChange={(v) => set({ currencyMinorUnit: v })} options={MINOR_UNITS} />
        <div className="row">
          <button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Saving…' : 'Save the calendar as a draft'}
          </button>
        </div>
        <Missing text={problem} />
        <div className="wide">
          <Note text={note} />
          <Problem error={create.error} act="calendar" />
        </div>
      </form>
    </Section>
  );
}

function CalendarScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(CONFIG_READ)) {
    return (
      <Section title="Payroll calendar">
        <Empty>{NOT_CONFIG}</Empty>
      </Section>
    );
  }
  return <CalendarView key={id} id={id} />;
}

function CalendarView({ id }: { id: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const calendar = useQuery({ queryKey: keys.calendar(id), queryFn: () => api<CalendarDetail>(`/v1/payroll/calendars/${encodeURIComponent(id)}`), retry: retryTransient });
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const activate = useCalendarActivation(setNote);
  const k = calendar.data;
  const manage = can(CONFIG_MANAGE) && k !== undefined && k.state !== 'RETIRED';
  const edited = k?.periods.find((p) => p.id === editing) ?? null;
  return (
    <div className="stack">
      <Section title={k ? `Payroll calendar ${k.code}` : 'Payroll calendar'} actions={<Link to={PATHS.calendars}>All calendars</Link>}>
        {calendar.isPending && <p className="hint">Loading the calendar…</p>}
        {calendar.error && <Problem error={calendar.error} act="read" />}
        <Note text={note} />
        {k && (
          <dl className="kv">
            <Fact term="Name">{k.name}</Fact>
            <Fact term="Currency">{k.currencyCode}</Fact>
            <Fact term="Minor unit">{label(MINOR_UNITS, String(k.currencyMinorUnit))}</Fact>
            <Fact term="State">
              <Status map={CONFIG_STATE} code={k.state} />
            </Fact>
            {k.activatedAt && <Fact term="Activated">{formatDate(k.activatedAt)}</Fact>}
          </dl>
        )}
        {k && can(CONFIG_ACTIVATE) && k.state === 'DRAFT' && (
          <p style={FLUSH}>
            <ActivateControl
              state={k.state}
              createdBy={k.createdBy}
              name={`calendar ${k.code}`}
              busy={activate.isPending}
              onActivate={() => {
                setNote(null);
                activate.mutate(k);
              }}
            />
          </p>
        )}
        <Problem error={activate.error} act="calendar-activate" />
      </Section>
      {k && (
        <Section title="Periods">
          <p className="hint">
            Each period is one whole calendar month of service with its input cutoff and payment date. A period is fixed once payroll runs, inputs or salary stops use it.
          </p>
          {k.periods.length === 0 && <Empty>The calendar has no periods yet, so it cannot be activated.</Empty>}
          {k.periods.length > 0 && (
            <div style={SCROLL}>
              <table aria-label={`Periods of calendar ${k.code}`}>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Financial year</th>
                    <th>Service period</th>
                    <th>Input cutoff</th>
                    <th>Payment date</th>
                    {manage && <th>Change</th>}
                  </tr>
                </thead>
                <tbody>
                  {k.periods.map((p) => (
                    <tr key={p.id}>
                      <td>{p.periodCode}</td>
                      <td>{p.financialYear}</td>
                      <td>{`${formatDate(p.serviceStart)} to ${formatDate(p.serviceEnd)}`}</td>
                      <td>{formatDate(p.inputCutoff)}</td>
                      <td>{formatDate(p.paymentDate)}</td>
                      {manage && (
                        <td>
                          <button
                            type="button"
                            className="link"
                            onClick={() => {
                              setNote(null);
                              setEditing(p.id);
                            }}
                            aria-label={`Change the dates of period ${p.periodCode}`}
                          >
                            Change dates
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {manage && edited && (
            <PeriodForm
              key={edited.id}
              calendar={k}
              period={edited}
              onDone={(text) => {
                setEditing(null);
                setNote(text);
              }}
              onClose={() => setEditing(null)}
            />
          )}
          {manage && <PeriodForm calendar={k} period={null} onDone={setNote} />}
        </Section>
      )}
    </div>
  );
}

function PeriodForm({ calendar, period, onDone, onClose }: { calendar: CalendarDetail; period: CalendarPeriod | null; onDone: (text: string) => void; onClose?: () => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  // A change starts from the period as recorded; a new period starts empty (no default exists).
  const empty = {
    periodCode: period?.periodCode ?? '',
    financialYear: period?.financialYear ?? '',
    serviceStart: period?.serviceStart ?? '',
    serviceEnd: period?.serviceEnd ?? '',
    inputCutoff: period?.inputCutoff ?? '',
    paymentDate: period?.paymentDate ?? '',
  };
  const [f, setF] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      period
        ? api<CalendarPeriod>(`/v1/payroll/periods/${encodeURIComponent(period.id)}`, { method: 'PUT', body: { ...body, expectedVersion: period.version } })
        : api<CalendarPeriod>(`/v1/payroll/calendars/${encodeURIComponent(calendar.id)}/periods`, { body: { periodCode: f.periodCode.trim().toUpperCase(), ...body } }),
    onSuccess: (p) => {
      setF(empty);
      onDone(period ? `The dates of period ${p.periodCode} were changed.` : `Period ${p.periodCode} was added to calendar ${calendar.code}.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.calendars }),
  });
  const set = (patch: Partial<typeof empty>) => setF((prev) => ({ ...prev, ...patch }));
  const name = period ? `Change the dates of period ${period.periodCode}` : 'Add a period';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    if (!period && !f.periodCode.trim()) return setProblem('Give the period code.');
    if (!f.financialYear.trim()) return setProblem('Give the financial year label.');
    if (![f.serviceStart, f.serviceEnd, f.inputCutoff, f.paymentDate].every((d) => ISO_DAY.test(d))) return setProblem('Give the service start and end, the input cutoff and the payment date.');
    setProblem(null);
    save.reset();
    save.mutate({ financialYear: f.financialYear.trim().toUpperCase(), serviceStart: f.serviceStart, serviceEnd: f.serviceEnd, inputCutoff: f.inputCutoff, paymentDate: f.paymentDate });
  };
  return (
    <form onSubmit={submit} aria-label={name} className="grid-form" style={{ marginTop: '0.75rem' }}>
      <h3 style={H3} className="wide">
        {name}
      </h3>
      {!period && (
        <label>
          Period code
          <input value={f.periodCode} onChange={(e) => set({ periodCode: e.target.value })} maxLength={20} autoComplete="off" />
        </label>
      )}
      <label>
        Financial year
        <input value={f.financialYear} onChange={(e) => set({ financialYear: e.target.value })} maxLength={20} autoComplete="off" />
      </label>
      <label>
        Service start
        <input type="date" value={f.serviceStart} onChange={(e) => set({ serviceStart: e.target.value })} />
      </label>
      <label>
        Service end
        <input type="date" value={f.serviceEnd} onChange={(e) => set({ serviceEnd: e.target.value })} />
      </label>
      <label>
        Input cutoff
        <input type="date" value={f.inputCutoff} onChange={(e) => set({ inputCutoff: e.target.value })} />
      </label>
      <label>
        Payment date
        <input type="date" value={f.paymentDate} onChange={(e) => set({ paymentDate: e.target.value })} />
      </label>
      <div className="row">
        <button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : period ? 'Save the new dates' : 'Add the period'}
        </button>
        {onClose && (
          <button type="button" className="secondary" onClick={onClose} disabled={save.isPending}>
            Close
          </button>
        )}
      </div>
      <Missing text={problem} />
      <div className="wide">
        <Problem error={save.error} act="period" />
      </div>
    </form>
  );
}

// ---- Paid-day policy (FR-032; BR-049) ----

function PaidDayPolicySection() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const policies = useQuery({ queryKey: keys.paidDayPolicies, queryFn: () => api<{ items: PaidDayPolicy[] }>('/v1/payroll/paid-day-policies'), retry: retryTransient });
  const [note, setNote] = useState<string | null>(null);
  const activate = useMutation({
    mutationFn: (p: PaidDayPolicy) => api<PaidDayPolicy>(`/v1/payroll/paid-day-policies/${encodeURIComponent(p.id)}/activate`, { body: { expectedVersion: p.version } }),
    onSuccess: (p) => setNote(`Paid-day policy revision ${p.revision} is active from ${formatDate(p.effectiveFrom)}.`),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.paidDayPolicies }),
  });
  const activator = can(CONFIG_ACTIVATE);
  return (
    <Section title="Paid-day policy">
      <p className="hint">
        None exists by default. Until a policy is active, attendance never reduces paid days: absences are paid and reported for a documented resolution. Late flags and missing
        timesheets never reduce pay.
      </p>
      {policies.isPending && <p className="hint">Loading paid-day policies…</p>}
      {policies.error && <Problem error={policies.error} act="read" />}
      <Note text={note} />
      {policies.data && policies.data.items.length === 0 && <Empty>No paid-day policy is defined.</Empty>}
      {policies.data && policies.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Paid-day policies">
            <thead>
              <tr>
                <th>Revision</th>
                <th>Effective from</th>
                <th>Reduces paid days for</th>
                <th>Unpaid part of an absent day</th>
                <th>Unpaid part of a half day</th>
                <th>State</th>
                {activator && <th>Activation</th>}
              </tr>
            </thead>
            <tbody>
              {policies.data.items.map((p) => (
                <tr key={p.id}>
                  <td>{p.revision}</td>
                  <td>{formatDate(p.effectiveFrom)}</td>
                  <td>{label(ATTENDANCE_BASIS, p.attendanceBasis)}</td>
                  <td>{p.absentUnpaidUnits ?? '—'}</td>
                  <td>{p.halfDayUnpaidUnits ?? '—'}</td>
                  <td>
                    <Status map={CONFIG_STATE} code={p.state} />
                  </td>
                  {activator && (
                    <td>
                      <ActivateControl
                        state={p.state}
                        createdBy={p.createdBy}
                        name={`paid-day policy revision ${p.revision}`}
                        busy={activate.isPending}
                        onActivate={() => {
                          setNote(null);
                          activate.mutate(p);
                        }}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Problem error={activate.error} act="policy-activate" />
      {can(CONFIG_MANAGE) && <PolicyForm />}
    </Section>
  );
}

function PolicyForm() {
  const keys = useKeys();
  const qc = useQueryClient();
  const empty = { effectiveFrom: '', attendanceBasis: '', absentUnpaidUnits: '', halfDayUnpaidUnits: '' };
  const [f, setF] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<PaidDayPolicy>('/v1/payroll/paid-day-policies', { body }),
    onSuccess: (p) => {
      setF(empty);
      setNote(`Paid-day policy revision ${p.revision} saved as a draft: someone other than you activates it.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.paidDayPolicies }),
  });
  const set = (patch: Partial<typeof empty>) => setF((prev) => ({ ...prev, ...patch }));
  const reviewed = f.attendanceBasis === 'REVIEWED_ATTENDANCE';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    if (!ISO_DAY.test(f.effectiveFrom)) return setProblem('Give the date the policy takes effect.');
    if (!f.attendanceBasis) return setProblem('Choose what reduces paid days.');
    if (reviewed && !(UNITS.test(f.absentUnpaidUnits.trim()) && UNITS.test(f.halfDayUnpaidUnits.trim()))) {
      return setProblem('State the unpaid part of a reviewed absent day and of a half day, from 0 to 1 with at most two decimals.');
    }
    setProblem(null);
    setNote(null);
    create.reset();
    create.mutate({
      effectiveFrom: f.effectiveFrom,
      attendanceBasis: f.attendanceBasis,
      ...(reviewed ? { absentUnpaidUnits: f.absentUnpaidUnits.trim(), halfDayUnpaidUnits: f.halfDayUnpaidUnits.trim() } : {}),
    });
  };
  return (
    <form onSubmit={submit} aria-label="Define a paid-day policy" className="grid-form" style={{ marginTop: '0.75rem' }}>
      <h3 style={H3} className="wide">
        Define a paid-day policy
      </h3>
      <label>
        Effective from
        <input type="date" value={f.effectiveFrom} onChange={(e) => set({ effectiveFrom: e.target.value })} />
      </label>
      <Choice label="Reduces paid days for" value={f.attendanceBasis} onChange={(v) => set({ attendanceBasis: v })} options={ATTENDANCE_BASIS} />
      {reviewed && (
        <>
          <label>
            Unpaid part of a reviewed absent day (0 to 1)
            <input value={f.absentUnpaidUnits} onChange={(e) => set({ absentUnpaidUnits: e.target.value })} inputMode="decimal" maxLength={4} autoComplete="off" />
          </label>
          <label>
            Unpaid part of a reviewed half day (0 to 1)
            <input value={f.halfDayUnpaidUnits} onChange={(e) => set({ halfDayUnpaidUnits: e.target.value })} inputMode="decimal" maxLength={4} autoComplete="off" />
          </label>
        </>
      )}
      <div className="row">
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Saving…' : 'Save the policy as a draft'}
        </button>
      </div>
      <Missing text={problem} />
      <div className="wide">
        <Note text={note} />
        <Problem error={create.error} act="policy" />
      </div>
    </form>
  );
}

// ---- Pay components and head revisions (FR-028; DF05) ----

function HeadsScreen() {
  const { can } = useSession();
  if (!can(CONFIG_READ)) {
    return (
      <Section title="Pay heads">
        <Empty>{NOT_CONFIG}</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      <PayComponentsSection />
      <HeadRevisionsSection />
    </div>
  );
}

function headInEffectText(c: PayComponent): string {
  const h = c.headInEffect;
  if (!h) return 'No head in effect';
  const what = h.inUse ? `${label(HEAD_TYPE, h.headType)}, ${label(CALCULATION_BASIS, h.calculationBasis).toLowerCase()}` : 'discontinued';
  return `Revision ${h.revision} from ${formatDate(h.effectiveFrom)}: ${what}`;
}

function PayComponentsSection() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const components = usePayComponents();
  const empty = { code: '', name: '', componentKind: '' };
  const [f, setF] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<PayComponent>('/v1/payroll/components', { body }),
    onSuccess: (c) => {
      setF(empty);
      setNote(`Pay component ${c.code} created: classify it for payroll with a head revision.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.payComponents }),
  });
  const set = (patch: Partial<typeof empty>) => setF((prev) => ({ ...prev, ...patch }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    if (!f.code.trim() || !f.name.trim()) return setProblem('Give the component code and name.');
    if (!f.componentKind) return setProblem('Choose whether the component is an earning or a deduction.');
    setProblem(null);
    setNote(null);
    create.reset();
    create.mutate({ code: f.code.trim().toUpperCase(), name: f.name.trim(), componentKind: f.componentKind });
  };
  return (
    <Section title="Pay components">
      <p className="hint">A pay component is the identity of a head; head revisions classify it for payroll from a date.</p>
      {components.isPending && <p className="hint">Loading pay components…</p>}
      {components.error && <Problem error={components.error} act="read" />}
      {components.data && components.data.items.length === 0 && <Empty>No pay component is defined.</Empty>}
      {components.data && components.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Pay components">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Kind</th>
                <th>Head in effect today</th>
                <th>Active</th>
              </tr>
            </thead>
            <tbody>
              {components.data.items.map((c) => (
                <tr key={c.id}>
                  <td>{c.code}</td>
                  <td>{c.name}</td>
                  <td>{label(COMPONENT_KIND, c.componentKind)}</td>
                  <td>{headInEffectText(c)}</td>
                  <td>{c.active ? 'Active' : 'Not active'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can(CONFIG_MANAGE) && (
        <form onSubmit={submit} aria-label="Create a pay component" className="grid-form" style={{ marginTop: '0.75rem' }}>
          <h3 style={H3} className="wide">
            Create a pay component
          </h3>
          <label>
            Component code
            <input value={f.code} onChange={(e) => set({ code: e.target.value })} maxLength={40} autoComplete="off" />
          </label>
          <label>
            Component name
            <input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} autoComplete="off" />
          </label>
          <Choice label="Component kind" value={f.componentKind} onChange={(v) => set({ componentKind: v })} options={COMPONENT_KIND} />
          <div className="row">
            <button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Saving…' : 'Create the component'}
            </button>
          </div>
          <Missing text={problem} />
          <div className="wide">
            <Note text={note} />
            <Problem error={create.error} act="pay-component" />
          </div>
        </form>
      )}
    </Section>
  );
}

function HeadRevisionsSection() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const heads = useQuery({ queryKey: keys.heads, queryFn: () => api<{ items: HeadRevision[] }>('/v1/payroll/heads'), retry: retryTransient });
  const [note, setNote] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: ({ h, action }: { h: HeadRevision; action: 'activate' | 'cancel' }) =>
      api<HeadRevision>(`/v1/payroll/head-revisions/${encodeURIComponent(h.id)}/${action}`, { body: { expectedVersion: h.version } }),
    onSuccess: (h, { action }) =>
      setNote(
        action === 'activate'
          ? `Head ${h.componentCode} revision ${h.revision} is active from ${formatDate(h.effectiveFrom)}.`
          : `Draft revision ${h.revision} of head ${h.componentCode} was cancelled.`,
      ),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.heads });
      void qc.invalidateQueries({ queryKey: keys.payComponents });
    },
  });
  const activator = can(CONFIG_ACTIVATE);
  const manager = can(CONFIG_MANAGE);
  const lastAct = act.variables?.action;
  return (
    <Section title="Head revisions">
      <p className="hint">
        A head revision is created whole and never edited. It takes effect only once someone other than its author activates it, and activation refuses missing or cyclic
        definitions. The latest active revision on or before a date is the one in effect.
      </p>
      {heads.isPending && <p className="hint">Loading head revisions…</p>}
      {heads.error && <Problem error={heads.error} act="read" />}
      <Note text={note} />
      {heads.data && heads.data.items.length === 0 && <Empty>No head revision is defined, so no pay component is classified for payroll.</Empty>}
      {heads.data && heads.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Head revisions">
            <thead>
              <tr>
                <th>Component</th>
                <th>Revision</th>
                <th>Effective from</th>
                <th>Use</th>
                <th>Type</th>
                <th>Calculation</th>
                <th>Rounding</th>
                <th>Tax treatment</th>
                <th>Display order</th>
                <th>State</th>
                {(activator || manager) && <th>Change</th>}
              </tr>
            </thead>
            <tbody>
              {heads.data.items.map((h) => {
                const rulePack = h.inUse && h.calculationBasis === 'RULE_PACK';
                return (
                  <tr key={h.id}>
                    <td>{`${h.componentCode} · ${h.componentName}`}</td>
                    <td>{h.revision}</td>
                    <td>{formatDate(h.effectiveFrom)}</td>
                    <td>{h.inUse ? 'In use' : 'Discontinued'}</td>
                    <td>{label(HEAD_TYPE, h.headType)}</td>
                    <td>
                      {rulePack ? `Rule pack ${h.rulePackCode ?? ''}` : label(CALCULATION_BASIS, h.calculationBasis)}
                      {rulePack && h.baseComponentCodes.length > 0 && <div>{`Base heads: ${h.baseComponentCodes.join(', ')}`}</div>}
                      {rulePack && (
                        <div>
                          <strong>{RULE_PACK_BLOCKS}</strong>
                        </div>
                      )}
                    </td>
                    <td>{label(ROUNDING, h.roundingRule)}</td>
                    <td>{h.taxTreatment ?? '—'}</td>
                    <td>{h.displaySequence ?? '—'}</td>
                    <td>
                      <Status map={CONFIG_STATE} code={h.state} />
                    </td>
                    {(activator || manager) && (
                      <td>
                        {activator && (
                          <ActivateControl
                            state={h.state}
                            createdBy={h.createdBy}
                            name={`head ${h.componentCode} revision ${h.revision}`}
                            busy={act.isPending}
                            onActivate={() => {
                              setNote(null);
                              act.mutate({ h, action: 'activate' });
                            }}
                          />
                        )}
                        {manager && h.state === 'DRAFT' && (
                          <>
                            {' '}
                            <button
                              type="button"
                              className="link"
                              disabled={act.isPending}
                              onClick={() => {
                                setNote(null);
                                act.mutate({ h, action: 'cancel' });
                              }}
                              aria-label={`Cancel head ${h.componentCode} revision ${h.revision}`}
                            >
                              Cancel draft
                            </button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Problem error={act.error} act={lastAct === 'activate' ? 'head-activate' : 'head'} />
      {manager && <HeadForm />}
    </Section>
  );
}

function HeadForm() {
  const keys = useKeys();
  const qc = useQueryClient();
  const components = usePayComponents();
  const taxList = useId();
  const empty = { componentCode: '', effectiveFrom: '', use: '', headType: '', calculationBasis: '', roundingRule: '', taxTreatment: '', displaySequence: '', rulePackCode: '', bases: [] as string[] };
  const [f, setF] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<HeadRevision>('/v1/payroll/heads', { body }),
    onSuccess: (h) => {
      setF(empty);
      setNote(`Head ${h.componentCode} revision ${h.revision} saved as a draft: someone other than you activates it.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.heads }),
  });
  const set = (patch: Partial<typeof empty>) => setF((prev) => ({ ...prev, ...patch }));
  const inUse = f.use === 'IN_USE';
  const rulePack = inUse && f.calculationBasis === 'RULE_PACK';
  const others = (components.data?.items ?? []).filter((c) => c.code !== f.componentCode);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    if (!f.componentCode) return setProblem('Choose the pay component.');
    if (!ISO_DAY.test(f.effectiveFrom)) return setProblem('Give the date the revision takes effect.');
    if (!f.use) return setProblem('Choose whether the head is in use or discontinued from that date.');
    if (inUse) {
      if (!f.headType || !f.calculationBasis || !f.roundingRule || !f.taxTreatment.trim()) return setProblem('Choose the head type, calculation basis, rounding and tax treatment.');
      if (!/^\d{1,4}$/.test(f.displaySequence.trim()) || /^0+$/.test(f.displaySequence.trim())) return setProblem('The display sequence is a whole number from 1 to 9999.');
      if (rulePack && !f.rulePackCode.trim()) return setProblem('Name the rule pack that will calculate the head.');
    }
    setProblem(null);
    setNote(null);
    create.reset();
    create.mutate({
      componentCode: f.componentCode,
      effectiveFrom: f.effectiveFrom,
      inUse,
      ...(inUse
        ? {
            headType: f.headType,
            calculationBasis: f.calculationBasis,
            roundingRule: f.roundingRule,
            taxTreatment: f.taxTreatment.trim().toUpperCase(),
            displaySequence: Number(f.displaySequence.trim()),
            ...(rulePack ? { rulePackCode: f.rulePackCode.trim().toUpperCase(), baseComponentCodes: f.bases.filter((b) => b !== f.componentCode) } : {}),
          }
        : {}),
    });
  };
  return (
    <form onSubmit={submit} aria-label="Create a head revision" className="grid-form" style={{ marginTop: '0.75rem' }}>
      <h3 style={H3} className="wide">
        Create a head revision
      </h3>
      <label>
        Pay component
        <select value={f.componentCode} onChange={(e) => set({ componentCode: e.target.value })}>
          <option value="">Choose…</option>
          {(components.data?.items ?? []).map((c) => (
            <option key={c.id} value={c.code}>
              {`${c.code} · ${c.name} (${label(COMPONENT_KIND, c.componentKind).toLowerCase()})`}
            </option>
          ))}
        </select>
      </label>
      <label>
        Effective from
        <input type="date" value={f.effectiveFrom} onChange={(e) => set({ effectiveFrom: e.target.value })} />
      </label>
      <Choice label="Use" value={f.use} onChange={(v) => set({ use: v })} options={HEAD_USE} />
      {inUse && (
        <>
          <Choice label="Head type" value={f.headType} onChange={(v) => set({ headType: v })} options={HEAD_TYPE} />
          <Choice label="Calculation basis" value={f.calculationBasis} onChange={(v) => set({ calculationBasis: v })} options={CALCULATION_BASIS} />
          <Choice label="Rounding" value={f.roundingRule} onChange={(v) => set({ roundingRule: v })} options={ROUNDING} />
          <label>
            Tax treatment (from the company’s list)
            <input value={f.taxTreatment} onChange={(e) => set({ taxTreatment: e.target.value })} list={taxList} maxLength={60} autoComplete="off" />
            <datalist id={taxList}>
              {TAX_TREATMENTS.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label>
            Display sequence
            <input value={f.displaySequence} onChange={(e) => set({ displaySequence: e.target.value })} inputMode="numeric" maxLength={4} autoComplete="off" />
          </label>
        </>
      )}
      {rulePack && (
        <>
          <p className="hint wide" role="note">
            <strong>{RULE_PACK_BLOCKS}</strong>
          </p>
          <label>
            Rule pack code
            <input value={f.rulePackCode} onChange={(e) => set({ rulePackCode: e.target.value })} maxLength={40} autoComplete="off" />
          </label>
          <fieldset className="wide" style={GROUP}>
            <legend>Base heads</legend>
            {others.length === 0 && <p className="hint">No other pay component exists.</p>}
            {others.map((c) => (
              <label key={c.id} className="check">
                <input
                  type="checkbox"
                  checked={f.bases.includes(c.code)}
                  onChange={(e) => set({ bases: e.target.checked ? [...f.bases, c.code] : f.bases.filter((b) => b !== c.code) })}
                />{' '}
                {`${c.code} · ${c.name}`}
              </label>
            ))}
          </fieldset>
        </>
      )}
      <div className="row">
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Saving…' : 'Save the revision as a draft'}
        </button>
      </div>
      <Missing text={problem} />
      <div className="wide">
        <Note text={note} />
        <Problem error={create.error} act="head" />
      </div>
    </form>
  );
}

// ---- Salary components of an arrangement (FR-029; salary master grants) ----

function SalaryComponentsScreen() {
  const { can } = useSession();
  const [employee, setEmployee] = useState<EmployeeHit | null>(null);
  const [arrangementId, setArrangementId] = useState<string | null>(null);
  if (!can(SALARY_READ)) {
    return (
      <Section title="Salary components">
        <Empty>The selected role cannot see salary arrangements.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      <Section title="Salary components">
        <p className="hint">
          The pay components of an employee’s salary arrangement, exactly as recorded. They are set once, while the arrangement has none; a change is a new arrangement through
          the salary master. Nothing is added up or converted here.
        </p>
        <EmployeePicker
          title="Employee"
          value={employee}
          onChange={(e) => {
            setEmployee(e);
            setArrangementId(null);
          }}
        />
        {employee && <ArrangementList key={employee.id} employeeId={employee.id} chosen={arrangementId} onChoose={setArrangementId} />}
      </Section>
      {arrangementId && <ArrangementComponentsView key={arrangementId} arrangementId={arrangementId} />}
    </div>
  );
}

function ArrangementList({ employeeId, chosen, onChoose }: { employeeId: string; chosen: string | null; onChoose: (id: string) => void }) {
  const keys = useKeys();
  const history = useQuery({
    queryKey: keys.salaryHistory(employeeId),
    queryFn: () => api<{ items: SalaryArrangementRow[]; historyIncluded?: boolean }>(`/v1/employees/${encodeURIComponent(employeeId)}/salary`),
    retry: retryTransient,
  });
  // I-68: without the history grant the server sends only what is in force today and later, so an empty list does not mean none ever existed.
  const withheld = history.data?.historyIncluded === false;
  return (
    <>
      {history.isPending && <p className="hint">Loading the salary arrangements…</p>}
      {history.error && <Problem error={history.error} act="read" />}
      {history.data && history.data.items.length === 0 && <Empty>{withheld ? 'The employee has no salary arrangement in force today or later.' : 'The employee has no salary arrangement yet.'}</Empty>}
      {history.data && history.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Salary arrangements">
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>Annual CTC</th>
                <th>Monthly gross</th>
                <th>Components</th>
              </tr>
            </thead>
            <tbody>
              {history.data.items.map((a) => (
                <tr key={a.id}>
                  <td>{formatDate(a.effectiveFrom)}</td>
                  <td>{a.effectiveTo ? formatDate(a.effectiveTo) : 'Open'}</td>
                  <td>{a.annualCtc !== undefined ? money(a.annualCtc, a.currency) : '—'}</td>
                  <td>{a.monthlyGross !== undefined ? money(a.monthlyGross, a.currency) : '—'}</td>
                  <td>
                    {chosen === a.id ? (
                      'Shown below'
                    ) : (
                      <button type="button" className="link" onClick={() => onChoose(a.id)} aria-label={`Show the components of the arrangement from ${formatDate(a.effectiveFrom)}`}>
                        Show components
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {withheld && <p className="hint">Earlier arrangements are not shown: the selected role has no salary history grant.</p>}
    </>
  );
}

type ComponentLineInput = { componentCode: string; amount: string; basis: string };

function ArrangementComponentsView({ arrangementId }: { arrangementId: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const path = `/v1/payroll/salary-arrangements/${encodeURIComponent(arrangementId)}/components`;
  const view = useQuery({ queryKey: keys.salaryComponents(arrangementId), queryFn: () => api<ArrangementComponents>(path), retry: retryTransient });
  const [note, setNote] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (components: ComponentLineInput[]) => api<ArrangementComponents>(path, { body: { components } }),
    onSuccess: () => setNote('The salary components are set. They are fixed now: a change is a new salary arrangement.'),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.salaryComponents(arrangementId) }),
  });
  const a = view.data;
  return (
    <Section title="Components of the arrangement">
      {view.isPending && <p className="hint">Loading the components…</p>}
      {view.error && <Problem error={view.error} act="salary-components" />}
      <Note text={note} />
      {a && (
        <>
          <dl className="kv">
            <Fact term="From">{formatDate(a.effectiveFrom)}</Fact>
            <Fact term="To">{a.effectiveTo ? formatDate(a.effectiveTo) : 'Open'}</Fact>
            {a.annualCtc !== undefined && <Fact term="Annual CTC">{money(a.annualCtc, a.currencyCode)}</Fact>}
            {a.monthlyGross !== undefined && <Fact term="Monthly gross">{money(a.monthlyGross, a.currencyCode)}</Fact>}
          </dl>
          {a.components.length === 0 && <Empty>No salary components are set for this arrangement, so its payroll calculation is blocked until they are.</Empty>}
          {a.components.length > 0 && (
            <div style={SCROLL}>
              <table aria-label="Salary components">
                <thead>
                  <tr>
                    <th>Component</th>
                    <th>Kind</th>
                    <th>Basis</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {a.components.map((c) => (
                    <tr key={c.componentCode}>
                      <td>{`${c.componentCode} · ${c.componentName}`}</td>
                      <td>{label(COMPONENT_KIND, c.componentKind)}</td>
                      <td>{label(AMOUNT_BASIS, c.basis)}</td>
                      <td>{money(c.amount, a.currencyCode)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {a.totals.length > 0 && (
            <div style={SCROLL}>
              <table aria-label="Component totals as returned">
                <thead>
                  <tr>
                    <th>Basis</th>
                    <th>Kind</th>
                    <th>Total (as returned; no reconciliation rule is assumed)</th>
                  </tr>
                </thead>
                <tbody>
                  {a.totals.map((t) => (
                    <tr key={`${t.basis}-${t.componentKind}`}>
                      <td>{label(AMOUNT_BASIS, t.basis)}</td>
                      <td>{label(COMPONENT_KIND, t.componentKind)}</td>
                      <td>{money(t.total, a.currencyCode)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {a.components.length > 0 && <p className="hint">Set once: a change is a new salary arrangement through the salary master.</p>}
          {a.components.length === 0 && can(SALARY_MANAGE) && (
            <SalaryComponentsForm
              currency={a.currencyCode}
              busy={save.isPending}
              onSend={(lines) => {
                setNote(null);
                return save.mutateAsync(lines);
              }}
            />
          )}
        </>
      )}
      <Problem error={save.error} act="salary-components" />
    </Section>
  );
}

interface ComponentLineDraft extends ComponentLineInput {
  key: number;
}

function SalaryComponentsForm({ currency, busy, onSend }: { currency: string; busy: boolean; onSend: (lines: ComponentLineInput[]) => Promise<unknown> }) {
  const components = usePayComponents();
  const listId = useId();
  const next = useRef(1);
  const blank = (): ComponentLineDraft => ({ key: next.current++, componentCode: '', amount: '', basis: '' });
  const [lines, setLines] = useState<ComponentLineDraft[]>(() => [blank()]);
  const [problem, setProblem] = useState<string | null>(null);
  const byCode = new Map((components.data?.items ?? []).map((c) => [c.code, c]));
  const patch = (key: number, p: Partial<ComponentLineInput>) => setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    for (const [i, l] of lines.entries()) {
      if (!l.componentCode.trim()) return setProblem(`Give the pay component of line ${i + 1}.`);
      if (!MONEY.test(l.amount.trim())) return setProblem(`Give the amount of line ${i + 1} as a decimal number with at most four decimals.`);
      if (!l.basis) return setProblem(`Choose whether the amount of line ${i + 1} is monthly or annual.`);
    }
    setProblem(null);
    onSend(lines.map((l) => ({ componentCode: l.componentCode.trim().toUpperCase(), amount: l.amount.trim(), basis: l.basis }))).then(
      () => setLines([blank()]),
      () => undefined,
    );
  };
  return (
    <form onSubmit={submit} aria-label="Set the salary components" className="grid-form" style={{ marginTop: '0.75rem' }}>
      <h3 style={H3} className="wide">
        Set the salary components
      </h3>
      <p className="hint wide">{`Amounts in ${currency}, exactly as written. ${REFUSALS.COMPONENT_BASIS_NOT_MONTHLY}`}</p>
      <datalist id={listId}>
        {(components.data?.items ?? [])
          .filter((c) => c.active)
          .map((c) => (
            <option key={c.id} value={c.code}>
              {c.name}
            </option>
          ))}
      </datalist>
      {lines.map((l, i) => {
        const head = byCode.get(l.componentCode.trim().toUpperCase())?.headInEffect;
        const annualFixed = l.basis === 'ANNUAL' && head?.inUse === true && head.calculationBasis === 'FIXED';
        return (
          <fieldset key={l.key} className="wide grid-form" style={GROUP}>
            <legend>{`Line ${i + 1}`}</legend>
            <label>
              {`Pay component code (line ${i + 1})`}
              <input value={l.componentCode} onChange={(e) => patch(l.key, { componentCode: e.target.value })} list={listId} maxLength={40} autoComplete="off" />
            </label>
            <label>
              {`Amount (line ${i + 1})`}
              <input value={l.amount} onChange={(e) => patch(l.key, { amount: e.target.value })} inputMode="decimal" maxLength={20} autoComplete="off" />
            </label>
            <Choice label={`Amount basis (line ${i + 1})`} value={l.basis} onChange={(v) => patch(l.key, { basis: v })} options={AMOUNT_BASIS} />
            {lines.length > 1 && (
              <div className="row">
                <button type="button" className="secondary" onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))} aria-label={`Remove line ${i + 1}`}>
                  Remove
                </button>
              </div>
            )}
            {annualFixed && (
              <p className="error wide" role="note">
                {`Line ${i + 1}: the head in effect for ${l.componentCode.trim().toUpperCase()} is fixed. ${REFUSALS.COMPONENT_BASIS_NOT_MONTHLY}`}
              </p>
            )}
          </fieldset>
        );
      })}
      <div className="row">
        <button type="button" className="secondary" onClick={() => setLines((prev) => [...prev, blank()])} disabled={lines.length >= 100}>
          Add a line
        </button>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Set the components'}
        </button>
      </div>
      <Missing text={problem} />
    </form>
  );
}

export const PAYROLL_SCREENS: ScreenRoute[] = [
  { path: PATHS.runs, title: 'Payroll runs', permission: RUN_READ_STATUS, nav: true, component: RunsScreen },
  { path: '/payroll/runs/:id', title: 'Payroll run', permission: RUN_READ_STATUS, nav: false, component: RunScreen },
  { path: PATHS.decisions, title: 'Payroll run decisions', permission: RUN_READ_AMOUNT, nav: true, component: RunDecisionsScreen },
  { path: '/payroll/manifests/:id', title: 'Bank manifest', permission: BANK_READ, nav: false, component: ManifestScreen },
  { path: PATHS.loans, title: 'Loans and advances', permission: LOAN_READ, nav: true, component: LoansScreen },
  { path: PATHS.loanUpload, title: 'Loan and advance upload', permission: LOAN_REQUEST, nav: true, component: LoanUploadScreen },
  { path: '/payroll/holds', title: 'Salary holds and stops', permission: HOLD_READ, nav: true, component: HoldsScreen },
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
