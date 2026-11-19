// API shapes of the payroll routes (as the routes return them), shared by the payroll screens.

// ---------------------------------------------------------------------------------------------------------
// API shapes (as the routes return them)
// ---------------------------------------------------------------------------------------------------------

export interface OwnPayslip {
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
export interface OwnPayslips {
  items: OwnPayslip[];
  form16?: { status: string; code?: string };
}

export interface Installment {
  sequence: number;
  dueMonth: string;
  amount: string;
}
export interface LoanRecovery {
  id: string;
  periodCode: string;
  runId: string;
  amount: string;
  recognisedAt: string;
}
export interface OwnLoan {
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
export interface OwnLoans {
  items: OwnLoan[];
  interest?: { status: string };
  earlySettlement?: { status: string };
}
export interface Loan extends Omit<OwnLoan, 'installments' | 'recoveries'> {
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

export interface RunRow {
  id: string;
  lineageId: string;
  revision: number;
  state: string;
  periodCode: string;
  financialYear: string;
  periodId: string;
  calendarCode: string;
  memberCount: number;
  unresolvedExceptions: number;
  createdAt: string;
  processedAt: string | null;
  version: number;
}
export interface RunTotals {
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
export interface RunDetail {
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
export interface RunException {
  id: string;
  code: string;
  severity: string;
  resolvable: boolean;
  detail: unknown;
  resolvedAt: string | null;
  resolvedBy: string | null;
}
export interface RunRecord {
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
export interface RunComponents {
  runId: string;
  basis: string;
  priorPeriodCode: string | null;
  items: { componentCode: string; headType: string; current: string; prior: string; difference: string }[];
}
export interface RunTask {
  taskId: string;
  step: string;
  run: { id: string; revision: number; state: string; periodCode: string; coveredEmployeeId: string | null } | null;
}
export interface RunDecided {
  runId: string;
  state: string;
  step?: string;
  nextRunId?: string;
  coversRequired?: number;
  replayed: boolean;
}
export interface Calendar {
  id: string;
  code: string;
  name: string;
  currencyCode: string;
  state: string;
  periods: { id: string; periodCode: string; serviceStart: string; serviceEnd: string; paymentDate: string | null }[];
}
export interface ScopePreview {
  periodId: string;
  periodCode: string;
  memberCount: number;
  members: { employeeId: string; employeeCode: string; displayName: string }[];
  membersTruncated: boolean;
  notIncludedCount: number;
  notIncludedByReason: Record<string, number>;
  scopeToken: string;
}
export interface IssuedOutput {
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
export interface PublishResult {
  runId: string;
  published: number;
  remaining: number;
  ownRecordLeftForAnotherPublisher: number;
  done: boolean;
}
export interface BankTemplate {
  id: string;
  templateCode: string;
  templateVersion: number;
  name: string;
  currencyCode: string;
  testOnly: boolean;
  state: string;
}
export interface BankPreview {
  label: string;
  payable: boolean;
  currencyCode: string;
  lineCount: number;
  totalAmount: string | null;
  excluded: { held: number; heldBySalaryStop?: number; reservedOrPaid: number; nothingPayable: number };
  errors: BankRowError[];
}
export interface BankRowError {
  lineSequence: number | null;
  employeeCode?: string;
  code: string;
  source?: string;
}
export interface ManifestRow {
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
export interface Manifest extends ManifestRow {
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
export interface BankLine {
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
