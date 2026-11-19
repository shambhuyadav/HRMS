// The API's shapes the letter and settlement screens read: templates, letters, notes, processes, exits and settlements.

// ---------------------------------------------------------------------------------------------------------
// API shapes (modules/lifecycle/letters.ts, settlement.ts, notes.ts, processes.ts, exit.ts)
// ---------------------------------------------------------------------------------------------------------
export interface Placeholder {
  key: string;
  /** EMPLOYEE, COMPANY, EXIT, LETTER or (an OFFER template's) OFFER. */
  source: string;
  label: string;
}

export interface TemplateSummary {
  id: string;
  code: string;
  name: string;
  letterType: string;
  active: boolean;
  version: number;
  publishedRevision: number | null;
  draftRevision: number | null;
}

export interface TemplateRevision {
  revision: number;
  /** DRAFT, PUBLISHED or RETIRED. */
  state: string;
  body: string;
  placeholders: string[];
  optionalPlaceholders: string[];
  publishedAt: string | null;
  version: number;
}

export interface TemplateDetail {
  id: string;
  code: string;
  name: string;
  letterType: string;
  active: boolean;
  version: number;
  revisions: TemplateRevision[];
}

/** POST /v1/employee-processes/:id/letters/preview: rendered for review, never stored or sent. */
export interface LetterPreview {
  templateCode: string;
  templateRevision: number;
  text: string;
  missing: string[];
  ready: boolean;
  sent: boolean;
}

/** A stored final letter: POST /v1/employee-processes/:id/letters and GET /v1/employees/:id/letter-outputs. */
export interface LetterOutput {
  id: string;
  /** The listing names the process; the generation answer does not. */
  processId?: string;
  templateCode: string;
  templateRevision: number;
  outputNumber: number;
  generatedAt: string;
  generatedBy: string;
  checksum: string;
  byteSize: number;
  /** NOT_SENT: sending is not built (FR-018). */
  deliveryState: string;
}

export interface ProcessSummary {
  id: string;
  processCode: string;
  processName: string;
  processType: string;
  revision: number;
  state: string;
  effectiveDate: string;
  exitCaseId: string | null;
}

export interface ProcessDetail {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  processCode: string;
  processName: string;
  processType: string;
  state: string;
  effectiveDate: string;
  exitCaseId: string | null;
}

/** A restricted HR note (FR-018); the text arrives only for a caller holding the restricted note grant. */
export interface NoteItem {
  id: string;
  kind: string;
  body?: string;
  exitCaseId: string | null;
  processId: string | null;
  supersedesNoteId: string | null;
  supersededByNoteId: string | null;
  createdBy: string;
  createdAt: string;
}

/**
 * FR-052: how a draft is calculated, reported by the server (GET /v1/settlements/calculation and the lists' `calculation`), never
 * guessed. AVAILABLE since I-88 (a draft is calculated from a snapshot); a server before it answered NOT_CONFIGURED.
 */
export interface Calculation {
  status: string;
  reason: string;
}

export interface SettlementLine {
  componentCode: string;
  componentName: string;
  /** EARNING or DEDUCTION. */
  componentKind: string;
  /** A signed decimal string exactly as the server holds it. */
  amount: string;
  /** STANDARD or NOTICE_ADJUSTMENT. */
  lineKind: string;
  /** ENTERED, UPLOADED, COPIED or (I-88) CALCULATED. */
  source: string;
  /** The calculation snapshot a CALCULATED line came from (absent from answers of servers before I-88). */
  calculationId?: string | null;
  /** Why an entered line is entered (required on a calculated draft). */
  reason?: string | null;
}

/** One item of a calculation snapshot (settlement-calculation.ts): what was worked out, or why it could not be. */
export interface CalculationItem {
  position: number;
  /** EARNINGS_DUE, LEAVE_ENCASHMENT, NOTICE_RECOVERY, LOAN_RECOVERY, ARREARS, ADJUSTMENT, GRATUITY or STATUTORY_DEDUCTION. */
  kind: string;
  status: string;
  /** A blocking item refuses the final approval. */
  blocking: boolean;
  componentCode: string | null;
  componentKind: string | null;
  /** A signed decimal string exactly as the server holds it, or null when nothing was worked out. */
  amount: string | null;
  /** The facts and rates the server used, by kind (see howText). */
  basis: Record<string, unknown> | null;
  leaveTypeCode: string | null;
  loanId?: string | null;
  arrearsCaseId?: string | null;
  adjustmentId?: string | null;
  headRevisionId?: string | null;
}

/** A versioned calculation snapshot (confidential with the amounts): the one a revision carries, or an earlier one. */
export interface SettlementCalculation {
  id: string;
  sequence: number;
  calculatedAt: string;
  calculatedBy: string;
  lastWorkingDate: string;
  periodStart: string;
  periodEnd: string;
  currencyCode: string;
  policyId: string | null;
  policyRevision: number | null;
  gratuityPackId: string | null;
  valuationPolicyId: string | null;
  paidDayPolicyId: string | null;
  itemCount: number;
  blockingCount: number;
  inputs?: Record<string, unknown>;
  items: CalculationItem[];
}

/** F1 notice (I-88): an exit's notice recovery waived, with its reason (confidential with the amounts). */
interface NoticeWaiver {
  id: string;
  reason: string;
  waivedBy: string;
  waivedAt: string;
}

/** One thing that refuses the final approval (settlement-gates.ts approvalBlockers; 409 CALCULATION_BLOCKED). */
export interface Blocker {
  source: string;
  kind: string;
  code: string;
  componentCode?: string | null;
  rulePackCode?: string | null;
}

/** Decision history: step, decision and time only. */
interface SettlementDecision {
  transactionId: string;
  step: number;
  /** The step's duty: review or approve. */
  action: string;
  decision: string;
  decidedAt: string;
  /** The deciding user (settlement trails name them so independence can be checked). */
  actorUserId?: string;
  /** The decider by operational identity, and the delegator a delegated decision was taken for (null otherwise; I-57 item 7). */
  decidedBy?: DeciderRef;
  onBehalfOf?: DeciderRef | null;
}

/** A decider as the trail names them (the hiring history's shape); the names are null for a user without an employee record. */
interface DeciderRef {
  userId: string;
  employeeCode: string | null;
  displayName: string | null;
}

/** A decider in words, as the appraisal and requisition histories show them: "You" for the signed-in user. */
export function deciderLabel(u: DeciderRef, myUserId: string | null): string {
  if (myUserId !== null && u.userId === myUserId) return 'You';
  if (u.displayName) return u.employeeCode ? `${u.displayName} (${u.employeeCode})` : u.displayName;
  return 'A user without an employee record';
}

export interface SettlementSummary {
  id: string;
  exitCaseId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  revision: number;
  state: string;
  currencyCode: string;
  calculationStatus: string;
  /** Confidential (settlement amount group): present only when the selected assignment holds it. */
  netAmount?: string;
  version: number;
}

/** A paid leave type's balance as at the last working date, in days as decimal strings exactly as the server holds them. */
interface LeaveBalanceAsOf {
  leaveType: string;
  available: string;
  pending: string;
  taken: string;
}

/** A disbursed loan or advance not yet fully recovered (net of recoveries recognised or already deducted by processed payroll, as the loan module shows it). */
interface OutstandingLoan {
  id: string;
  /** LOAN or ADVANCE. */
  loanKind: string;
  currencyCode: string;
  principal: string;
  recovered: string;
  outstanding: string;
  disbursementDate: string;
}

/** FR-052 (I-81 item 5): a payroll run covering the last working date, with the components it pays and which count as paid. */
export interface FinalPeriodRun {
  runId: string;
  periodCode: string;
  runState: string;
  revision: number;
  components: { componentCode: string; headType: string; alreadyPaid: boolean }[];
}

/** FR-034 "settlement shows remaining balance": read-only, with the settlement amount group only. */
interface SettlementBalances {
  /** The approved last working date the leave balances are taken at. */
  asOf: string | null;
  leave: LeaveBalanceAsOf[];
  /** Absent while the loans module is not active. */
  loans?: OutstandingLoan[];
  /** Absent from answers of servers before I-81. */
  finalPeriodPayroll?: FinalPeriodRun[];
}

/** I-81 item 9: one in-app delivery of a letter or statement to the employee's own self-service. */
export interface Delivery {
  id: string;
  kind: string;
  format: string;
  sourceRevision: number;
  status: string;
  sentBy: string;
  sentAt: string;
  firstReadAt: string | null;
  title?: string;
}

export interface SettlementDetail extends SettlementSummary {
  supersedesSettlementId: string | null;
  preparedBy: string;
  /** NOT_PAID or PAID: only a payment recorded from evidence is a payment (BR-016; I-81 item 2). */
  paymentStatus: string;
  /** The recorded payment date: the disbursement month (FR-054). */
  paymentDate?: string | null;
  /** Confidential, like the net amount. */
  payment?: { paidAt: string; paidBy: string; reference: string };
  cancelReason?: string | null;
  /** Confidential, like the net amount. */
  lines?: SettlementLine[];
  /** Confidential, like the net amount; only on GET /v1/settlements/:id and the answers of its actions. */
  balances?: SettlementBalances;
  /** I-88, confidential like the lines: the snapshot the revision carries (null while it is not calculated). */
  calculation?: SettlementCalculation | null;
  /** I-88, confidential like the lines: the exit's notice recovery waiver, if any. */
  noticeWaiver?: NoticeWaiver | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  approvedAt: string | null;
  releaseEligibleAt: string | null;
  createdAt: string;
  decisions: SettlementDecision[];
}

export type QueueKind = 'settlement' | 'settlement_approval';

/** GET /v1/settlements/tasks/mine: the caller's review and approval tasks; `settlement` is null outside the role's scope. */
export interface SettlementTask {
  taskId: string;
  kind: string;
  step: string;
  settlement: SettlementDetail | null;
}

export type Decision = 'APPROVE' | 'RETURN' | 'REJECT';
export type DecisionBody = { decision: Decision; reason?: string; idempotencyKey: string };

export interface SettlementDecided {
  settlementId: string;
  state: string;
  /** True when the key was already used for this decision: the earlier attempt's result, nothing applied twice. */
  replayed: boolean;
}

export interface UploadResult {
  template: string;
  dryRun: boolean;
  total: number;
  accepted: number;
  rejected: number;
  applied: boolean;
  errors: { row: number; code: string }[];
}

export interface ExitCase {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  state: string;
  approvedLastWorkingDate: string | null;
  noticePeriod: { status: string; contractualNoticeDays?: number };
}

export type LineKind = 'STANDARD' | 'NOTICE_ADJUSTMENT';
/** A line as the editor holds it; the reason is sent only when one is given. */
export interface LineInput {
  componentCode: string;
  amount: string;
  lineKind: LineKind;
  reason: string;
}
/** A line as PUT /v1/settlements/:id/lines takes it. */
export interface LineBody {
  componentCode: string;
  amount: string;
  lineKind: LineKind;
  reason?: string;
}

