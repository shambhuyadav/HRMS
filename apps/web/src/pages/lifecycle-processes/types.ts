// API shapes of the lifecycle routes (templates, processes, exit cases, notes), shared by the lifecycle process screens.

// ---------------------------------------------------------------------------------------------------------
// API shapes (modules/lifecycle/templates.ts, processes.ts, exit.ts, notes.ts)
// ---------------------------------------------------------------------------------------------------------
export interface TemplateSummary {
  id: string;
  code: string;
  name: string;
  processType: string;
  active: boolean;
  version: number;
  publishedRevision: number | null;
  draftRevision: number | null;
}
export interface TemplateTask {
  sequence: number;
  code: string;
  title: string;
  ownerRoleCode: string | null;
  ownerUserId: string | null;
  required: boolean;
  dueOffsetDays: number;
  evidenceRequired: boolean;
}
export interface TemplateRevision {
  revision: number;
  /** DRAFT, PUBLISHED or RETIRED. */
  state: string;
  publishedAt: string | null;
  version: number;
  tasks: TemplateTask[];
}
export interface TemplateDetail {
  id: string;
  code: string;
  name: string;
  processType: string;
  active: boolean;
  version: number;
  revisions: TemplateRevision[];
}
/** A task as POST /v1/lifecycle-processes and PUT .../draft take it: exactly one owner. */
export type TemplateTaskInput = { code: string; title: string; required: boolean; dueOffsetDays: number; evidenceRequired: boolean } & (
  | { ownerRoleCode: string }
  | { ownerUserId: string }
);

/** FR-106: an upload is served only once the malware scan has released it (CLEAN). */
export type ScanState = 'PENDING_SCAN' | 'CLEAN' | 'QUARANTINED' | null;
export interface ProcessTask {
  id: string;
  sequence: number;
  code: string;
  title: string;
  ownerRoleCode: string | null;
  ownerUserId: string | null;
  /** The named owner's employee name, when that user is linked to an employee. */
  ownerName: string | null;
  required: boolean;
  evidenceRequired: boolean;
  dueDate: string;
  /** OPEN, COMPLETED or SKIPPED. */
  state: string;
  /** Derived by the server: due before the company business date, still open in an open process. */
  overdue: boolean;
  doneAt: string | null;
  doneOn: string | null;
  doneBy: string | null;
  hasEvidence: boolean;
  evidenceScanState: ScanState;
  version: number;
}
export interface OwnerRef {
  roleCode: string | null;
  userId: string | null;
}
export interface ProcessEvent {
  action: string;
  taskCode: string | null;
  fromState: string | null;
  toState: string | null;
  priorOwner: OwnerRef | null;
  newOwner: OwnerRef | null;
  hasEvidence: boolean;
  /** Restricted (FR-018): present only for an authorised HR caller who is not the employee. */
  note?: string | null;
  /** Otherwise only whether a remark or reason was recorded. */
  noteRecorded?: boolean;
  actorUserId: string;
  businessDate: string;
  occurredAt: string;
}
export interface ProcessDetail {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  processId: string;
  processCode: string;
  processName: string;
  processType: string;
  revision: number;
  /** OPEN, CLOSED or CANCELLED. */
  state: string;
  effectiveDate: string;
  ownerUserId: string;
  exitCaseId: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  reopenCount: number;
  createdAt: string;
  version: number;
  counts: { total: number; open: number; requiredOpen: number; overdue: number };
  tasks: ProcessTask[];
  history: ProcessEvent[];
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
  version: number;
  taskCount: number;
  openTasks: number;
  requiredOpen: number;
  overdueTasks: number;
}
/** A task of GET /v1/employee-process-tasks/mine: open, in an open process, owned by the caller or the caller's role. */
export interface MyTask extends ProcessTask {
  processId: string;
  processCode: string;
  processName: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
}

/** F1: the recorded contractual value only; there is no default. */
export type NoticePeriod = { status: 'NOT_RECORDED' } | { status: 'RECORDED'; contractualNoticeDays: number };
export interface ExitCase {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  /** SUBMITTED, RECOMMENDED, APPROVED, SEPARATED, REJECTED or WITHDRAWN. */
  state: string;
  separationType: string;
  requestDate: string;
  proposedLastWorkingDate: string;
  recommendedLastWorkingDate: string | null;
  approvedLastWorkingDate: string | null;
  /** The inclusive last working date in force. */
  lastWorkingDate: string;
  noticePeriod: NoticePeriod;
  /** Confidential (exit reason group): present only for a granted caller, the employee's own under H1. */
  reasonCode?: string | null;
  reason?: string | null;
  employeeMessage: string | null;
  released: boolean;
  releasedAt: string | null;
  submittedAt: string;
  version: number;
  /** I-81 item 3: EMPLOYEE (self-service) or HR (entered from a resignation given outside the system). */
  origin?: string;
  enteredBy?: string | null;
}
/** I-81 item 3: records approved for days after the last working date, kept and listed (never cancelled by the exit). */
export interface AfterLastWorkingDate {
  treatment: string;
  items: { kind: string; id: string; startDate: string; endDate: string }[];
}
export interface ExitWithdrawal {
  id: string;
  /** SUBMITTED, APPROVED, REJECTED or WITHDRAWN. */
  state: string;
  /** Confidential: present only for a caller granted the exit reason group. */
  reason?: string;
  employeeMessage: string | null;
  requestedAt: string;
  decidedAt: string | null;
}
/** Decision history: step, decision and time only (reviewers' reasons never leave the server). */
export interface ExitDecision {
  transactionId: string;
  step: number;
  action: string;
  decision: string;
  decidedAt: string;
}
export interface ExitEvent {
  action: string;
  fromState: string;
  toState: string;
  lastWorkingDate: string | null;
  employeeStatusBefore: string | null;
  employeeStatusAfter: string | null;
  actorUserId: string;
  businessDate: string;
  occurredAt: string;
}
export interface ExitDetail extends ExitCase {
  afterLastWorkingDate?: AfterLastWorkingDate;
  clearance: { started: boolean; complete: boolean; processIds: string[]; incompleteRequired: string[] };
  withdrawals: ExitWithdrawal[];
  decisions: ExitDecision[];
  history: ExitEvent[];
}
/** GET /v1/exit-cases/tasks/mine: the manager's recommendations, HR decisions and withdrawal decisions. */
export interface ExitTask {
  taskId: string;
  /** exit_case or exit_withdrawal. */
  kind: string;
  /** The step's action: recommend or approve. */
  step: string;
  exitCase: ExitCase | null;
}
export interface RecommendResult {
  exitCaseId: string;
  state: string;
  recommendedLastWorkingDate?: string;
  replayed: boolean;
}
export interface ExitDecided {
  exitCaseId: string;
  state: string;
  approvedLastWorkingDate?: string;
  replayed: boolean;
}
export interface WithdrawalDecided {
  withdrawalId: string;
  state: string;
  exitState?: string;
  replayed: boolean;
}
export interface ResignationResult {
  exitCaseId: string;
  state: string;
  requestDate: string;
  proposedLastWorkingDate: string;
}
export type ExitDecisionBody =
  | { decision: 'APPROVE'; approvedLastWorkingDate?: string; reason?: string; idempotencyKey: string }
  | { decision: 'REJECT'; reason: string; employeeMessage: string; idempotencyKey: string };
export type WithdrawalDecisionBody = { decision: 'APPROVE' | 'REJECT'; reason: string; employeeMessage?: string; idempotencyKey: string };

export interface NoteItem {
  id: string;
  /** NOTE, REMARK or WARNING. */
  kind: string;
  /** CL-052 (0283): a warning's category; ABSCONDING is the only one. */
  warningCategory?: string | null;
  body: string;
  exitCaseId: string | null;
  processId: string | null;
  supersedesNoteId: string | null;
  supersededByNoteId: string | null;
  createdBy: string;
  createdAt: string;
}
/** NOTE, REMARK and WARNING (0038), and the register's types (CL-040, 0260). */
export type NoteKind = 'NOTE' | 'REMARK' | 'WARNING' | 'APPRECIATION' | 'EXIT_NOTE' | 'OFFER_REJECTION' | 'PIP';
export interface NoteBody {
  kind: NoteKind;
  /** CL-052 (0283): sent only for a warning marked as an absconding warning. */
  warningCategory?: 'ABSCONDING';
  body: string;
  exitCaseId?: string;
  employeeProcessId?: string;
  supersedesNoteId?: string;
}
