// Letters and full-and-final settlements (FR-017, FR-018 and FR-055 letters; FR-052 to FR-054 settlements, as built;
// F1 "Exit and employee processes"; BR-016; DF02; DF03; DF09; DF12; C4; ZT07).
//
// Letters: HR keeps versioned letter templates that may use only the approved placeholders. A template is edited as its
// DRAFT revision; publishing freezes the draft and retires the revision published before; a template is renamed,
// deactivated or activated again against its version. Every placeholder a template uses is mandatory unless the template
// marks it optional. For an employee process, an HR Administrator holding the confidential letter grant previews a
// letter (rendered for review only: nothing is stored and nothing is sent) and then generates the final letter, which
// the server refuses while a mandatory value is missing. The final letter is stored as a confidential file with its
// template code and revision, its generator and time, and is downloaded for manual delivery: sending is not available
// (FR-018; DF09/DF12). Restricted HR notes and warnings appear only when the server returned them.
// Settlements: no calculation is configured (F1 needs actual approved policy and rate packs), so an authorised HR
// Administrator enters or uploads the lines on pay components for a revision of an approved exit. Amounts are
// confidential: they appear only when the server returned them, exactly as returned, and the net amount is the
// server's (never summed or worked out here). With them come the remaining balances, read-only (FR-034): outstanding
// loans and advances (while the loans module is active) and paid leave as at the last working date; nothing here
// changes the lines or works out an encashment or a recovery. Submission freezes the revision; an independent reviewer and then an
// independent approver decide it in the settlement decision queues; a returned or rejected revision is corrected through
// a new revision. Release eligibility is a further explicit step by someone independent of all of them once the exit
// clearance is complete. It is not a payment: nothing on these screens makes, schedules or records a payment (BR-016).
// FR-054 outputs: an approved revision downloads as CSV, Excel (XLSX) or PDF, and settlements selected from the list
// download as one ZIP of their files; the bulk upload takes the lines of several drafts in one file (shared import
// lifecycle). Outputs are downloaded only: nothing is stored or sent (sending awaits an owner decision).
// The server authorises every call and decides every rule; these screens hide what the selected assignment cannot use,
// show only what the server returned and say its refusals in plain words.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentType, type CSSProperties, type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, download, fileToBase64, formatAmount, formatDate, idempotencyKey, pinSession } from '../api';
import type { EssPanel, ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, LIST_PAGE_SIZE, nextSort, Pager, pageParams, Section, SortHeader, type SortState, sortParams, StateBadge } from '../ui';
import { DelegatedBadge } from './delegations';
import { HeldBatchCheck, ImportBatches, type ImportJob, ImportJobView, type ImportTemplate, TemplateDownload, useBatchFollowUp } from './records';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (modules/lifecycle/registration.ts; migrations 0038_lifecycle.sql and 0039_settlement.sql; the
// requireAccess calls of letter-routes.ts, settlement-routes.ts, process-routes.ts and exit-routes.ts) and paths
// ---------------------------------------------------------------------------------------------------------
const TEMPLATE_READ = 'letter_template.read.operational';
const TEMPLATE_MANAGE = 'letter_template.manage.operational';
/** Previews and final letters (confidential letter group, approved per assignment). */
const LETTER_GENERATE = 'letter.generate.letter';
/** Stored letters and their content. */
const LETTER_READ = 'letter.read.letter';
const NOTE_READ = 'employee_note.read.restricted';
/** GET /v1/employee-processes/:id and GET /v1/employees/:id/processes. */
const PROCESS_READ = 'employee_process.read.operational';
/** GET /v1/employees: the employee search. */
const EMPLOYEE_LIST = 'employee.list.operational';
/** GET /v1/employees/:id: the employee's name above their letters. */
const EMPLOYEE_READ = 'employee.read.operational';
/** GET /v1/exit-cases and GET /v1/exit-cases/:id: the exit a settlement belongs to. */
const EXIT_READ = 'exit.read.operational';
const SETTLEMENT_READ = 'settlement.read.operational';
/** FR-002 / migration 0119: exporting is its own right; reading a settlement's amounts does not allow it. */
const SETTLEMENT_EXPORT = 'settlement.export.amount';
const SETTLEMENT_PREPARE = 'settlement.prepare.amount';
const SETTLEMENT_REVIEW = 'settlement.review.amount';
const SETTLEMENT_APPROVE = 'settlement.approve.amount';
const SETTLEMENT_RELEASE = 'settlement.release.amount';

const PATHS = {
  templates: '/lifecycle/letter-templates',
  template: (id: string) => `/lifecycle/letter-templates/${id}`,
  letters: '/lifecycle/letters',
  employeeLetters: (id: string) => `/lifecycle/employees/${id}/letters`,
  processLetters: (id: string) => `/lifecycle/processes/${id}/letters`,
  settlements: '/lifecycle/settlements',
  settlement: (id: string) => `/lifecycle/settlements/${id}`,
  exitSettlements: (id: string) => `/lifecycle/exits/${id}/settlements`,
  // Screens of the employee processes and exit page (lifecycle-processes.tsx), linked for context.
  process: (id: string) => `/lifecycle/processes/${id}`,
  exit: (id: string) => `/lifecycle/exits/${id}`,
  employeeLifecycle: (id: string) => `/lifecycle/employees/${id}`,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Template codes (letter-routes.ts and process-routes.ts `code`). */
const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;
/** Letter type codes (POST /v1/letter-templates `letterType`). */
const LETTER_TYPE_CODE = /^[A-Z][A-Z0-9_]{0,59}$/;
/** A placeholder as letters.ts reads it. */
const TOKEN = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;
/** The amount format settlement.ts accepts; only the format is checked here, never the value. */
const AMOUNT = /^-?\d{1,15}(\.\d{1,4})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_BODY = 20000;
const MAX_NAME = 200;
const MAX_REASON = 1000;
const MAX_OPTIONAL = 50;
const MAX_LINES = 500;
const MAX_COMPONENT_CODE = 40;
const MAX_AMOUNT_TEXT = 24;
const MAX_EMPLOYEE_CODE = 60;
/** The upload route takes at most 1,000,000 base64 characters, which is 750,000 bytes of file. */
const MAX_UPLOAD_BYTES = 750_000;
const EMPLOYEE_PAGE_SIZE = 25;
/**
 * FR-056: the letter, process, note, settlement and exit lists are read a page at a time (page/pageSize); every
 * answer carries the total of every match in scope, so nothing beyond a fixed limit is silently left out.
 */
interface Paged<T> {
  items: T[];
  total?: number;
}
/** The total of a paged answer (an older answer without one counts its items). */
const totalOf = (p: Paged<unknown>) => p.total ?? p.items.length;
const pagedUrl = (path: string, page: number, query?: string) => `${path}?${query ? `${query}&` : ''}${pageParams(page)}`;
/** Upload rows shown in the problem table; a 10,000-row file is summarised. */
const SHOWN_ROWS = 200;
const UPLOAD_TEMPLATE = 'SETTLEMENT_LINES_V1';
const UPLOAD_HEADER = 'employee_code,last_working_date,component_code,amount,line_kind';
/** The settlement lines template is served at `${SETTLEMENT_LINES}/template` (records.tsx TemplateDownload). */
const SETTLEMENT_LINES = '/v1/settlements/lines';
/** FR-054 bulk upload: the same template for many drafts, through the shared import lifecycle (settlement-import.ts). */
const SETTLEMENT_IMPORTS = '/v1/settlements/line-imports';
/** FR-054 outputs (settlement-routes.ts): one revision's file, or a ZIP of the files of the settlements selected. */
type ExportFormat = 'CSV' | 'XLSX' | 'PDF';
const EXPORT_FORMATS: readonly (readonly [format: ExportFormat, label: string])[] = [
  ['CSV', 'CSV'],
  ['XLSX', 'Excel (XLSX)'],
  ['PDF', 'PDF'],
];
const formatLabel = (format: ExportFormat) => EXPORT_FORMATS.find(([f]) => f === format)?.[1] ?? format;
/** The states an output is built for (settlement.ts exportable). */
const EXPORTABLE_STATES: ReadonlySet<string> = new Set(['APPROVED', 'RELEASE_ELIGIBLE']);
/** The most settlements one ZIP holds (settlement.ts MAX_ARCHIVE_SETTLEMENTS, a technical bound). */
const MAX_ARCHIVE = 100;

/** The LETTER_TYPE values the module seeds (FR-017 target examples); a company may add others. */
const LETTER_TYPES: readonly (readonly [code: string, label: string])[] = [
  ['OFFER', 'Offer letter'],
  ['APPOINTMENT', 'Appointment letter'],
  ['CONFIRMATION', 'Confirmation letter'],
  ['TRANSFER', 'Transfer letter'],
  ['WARNING', 'Warning letter'],
  ['RELIEVING', 'Relieving letter'],
  ['EXPERIENCE', 'Experience letter'],
];

// ---------------------------------------------------------------------------------------------------------
// API shapes (modules/lifecycle/letters.ts, settlement.ts, notes.ts, processes.ts, exit.ts)
// ---------------------------------------------------------------------------------------------------------
interface Placeholder {
  key: string;
  /** EMPLOYEE, COMPANY, EXIT or LETTER. */
  source: string;
  label: string;
}

interface TemplateSummary {
  id: string;
  code: string;
  name: string;
  letterType: string;
  active: boolean;
  version: number;
  publishedRevision: number | null;
  draftRevision: number | null;
}

interface TemplateRevision {
  revision: number;
  /** DRAFT, PUBLISHED or RETIRED. */
  state: string;
  body: string;
  placeholders: string[];
  optionalPlaceholders: string[];
  publishedAt: string | null;
  version: number;
}

interface TemplateDetail {
  id: string;
  code: string;
  name: string;
  letterType: string;
  active: boolean;
  version: number;
  revisions: TemplateRevision[];
}

/** POST /v1/employee-processes/:id/letters/preview: rendered for review, never stored or sent. */
interface LetterPreview {
  templateCode: string;
  templateRevision: number;
  text: string;
  missing: string[];
  ready: boolean;
  sent: boolean;
}

/** A stored final letter: POST /v1/employee-processes/:id/letters and GET /v1/employees/:id/letter-outputs. */
interface LetterOutput {
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

interface EmployeeHit {
  id: string;
  employeeCode: string;
  displayName: string;
  status: string;
}

interface ProcessSummary {
  id: string;
  processCode: string;
  processName: string;
  processType: string;
  revision: number;
  state: string;
  effectiveDate: string;
  exitCaseId: string | null;
}

interface ProcessDetail {
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
interface NoteItem {
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

/** FR-052: reported by the server, never guessed. */
interface Calculation {
  status: string;
  reason: string;
}

interface SettlementLine {
  componentCode: string;
  componentName: string;
  /** EARNING or DEDUCTION. */
  componentKind: string;
  /** A signed decimal string exactly as the server holds it. */
  amount: string;
  /** STANDARD or NOTICE_ADJUSTMENT. */
  lineKind: string;
  /** ENTERED, UPLOADED or COPIED. */
  source: string;
}

/** Decision history: step, decision and time only. */
interface SettlementDecision {
  transactionId: string;
  step: number;
  /** The step's duty: review or approve. */
  action: string;
  decision: string;
  decidedAt: string;
}

interface SettlementSummary {
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

/** FR-034 "settlement shows remaining balance": read-only, with the settlement amount group only. */
interface SettlementBalances {
  /** The approved last working date the leave balances are taken at. */
  asOf: string | null;
  leave: LeaveBalanceAsOf[];
  /** Absent while the loans module is not active. */
  loans?: OutstandingLoan[];
}

interface SettlementDetail extends SettlementSummary {
  supersedesSettlementId: string | null;
  preparedBy: string;
  /** NOT_TRACKED: release eligibility is not a payment (BR-016). */
  paymentStatus: string;
  /** Confidential, like the net amount. */
  lines?: SettlementLine[];
  /** Confidential, like the net amount; only on GET /v1/settlements/:id and the answers of its actions. */
  balances?: SettlementBalances;
  submittedAt: string | null;
  reviewedAt: string | null;
  approvedAt: string | null;
  releaseEligibleAt: string | null;
  createdAt: string;
  decisions: SettlementDecision[];
}

type QueueKind = 'settlement' | 'settlement_approval';

/** GET /v1/settlements/tasks/mine: the caller's review and approval tasks; `settlement` is null outside the role's scope. */
interface SettlementTask {
  taskId: string;
  kind: string;
  step: string;
  settlement: SettlementDetail | null;
}

type Decision = 'APPROVE' | 'RETURN' | 'REJECT';
type DecisionBody = { decision: Decision; reason?: string; idempotencyKey: string };

interface SettlementDecided {
  settlementId: string;
  state: string;
  /** True when the key was already used for this decision: the earlier attempt's result, nothing applied twice. */
  replayed: boolean;
}

interface UploadResult {
  template: string;
  dryRun: boolean;
  total: number;
  accepted: number;
  rejected: number;
  applied: boolean;
  errors: { row: number; code: string }[];
}

interface ExitCase {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  state: string;
  approvedLastWorkingDate: string | null;
  noticePeriod: { status: string; contractualNoticeDays?: number };
}

type LineKind = 'STANDARD' | 'NOTICE_ADJUSTMENT';
interface LineInput {
  componentCode: string;
  amount: string;
  lineKind: LineKind;
}

// ---------------------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------------------
const REVISION_STATE_LABEL: Record<string, string> = { DRAFT: 'Draft', PUBLISHED: 'Published', RETIRED: 'Retired' };
const SOURCE_LABEL: Record<string, string> = { EMPLOYEE: 'Employee record', COMPANY: 'Company', EXIT: 'Approved exit', LETTER: 'The letter' };
const NOTE_KIND_LABEL: Record<string, string> = { NOTE: 'Note', REMARK: 'Remark', WARNING: 'Warning' };
const DELIVERY_LABEL: Record<string, string> = { NOT_SENT: 'Not sent' };

const SETTLEMENT_STATES = ['DRAFT', 'SUBMITTED', 'REVIEWED', 'APPROVED', 'RELEASE_ELIGIBLE', 'RETURNED', 'REJECTED', 'CANCELLED'] as const;
/** BR-016: states as the server records them; release eligibility is worded so it never reads as a payment. */
const SETTLEMENT_STATE_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Waiting for review',
  REVIEWED: 'Reviewed, waiting for approval',
  APPROVED: 'Approved, not yet eligible for release',
  RELEASE_ELIGIBLE: 'Eligible for release (not a payment)',
  RETURNED: 'Returned for correction',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};
const SETTLEMENT_TONE: Record<string, 'good' | 'warn' | 'bad'> = {
  SUBMITTED: 'warn',
  REVIEWED: 'warn',
  APPROVED: 'good',
  RELEASE_ELIGIBLE: 'good',
  RETURNED: 'warn',
  REJECTED: 'bad',
};
/** A live revision blocks a new one (settlement.ts createSettlement). */
const LIVE_STATES: ReadonlySet<string> = new Set(['DRAFT', 'SUBMITTED', 'REVIEWED', 'APPROVED', 'RELEASE_ELIGIBLE']);
const STATE_EXPLANATION: Record<string, string> = {
  DRAFT: 'Being prepared: the preparer enters or uploads the lines, then submits the revision for an independent review.',
  SUBMITTED: 'Submitted and frozen: its lines can no longer change. It waits for an independent review.',
  REVIEWED: 'Reviewed: it waits for an independent approval by someone who neither prepared nor reviewed it.',
  APPROVED:
    'Approved. It is not yet eligible for release: that is a separate step, recorded by someone independent once the exit clearance is complete. No payment is made here.',
  RELEASE_ELIGIBLE: 'Eligible for release. This is not a payment: no payment has been made, scheduled or recorded here.',
  RETURNED: 'Returned for correction. A corrected revision is prepared from the exit’s settlements and starts from this revision’s lines.',
  REJECTED: 'Rejected. A new revision can be prepared from the exit’s settlements.',
  CANCELLED: 'Cancelled. A new revision can be prepared from the exit’s settlements.',
};
const PAYMENT_STATUS_LABEL: Record<string, string> = { NOT_TRACKED: 'Not tracked here: release eligibility is not a payment' };
const CALCULATION_LABEL: Record<string, string> = { NOT_CONFIGURED: 'Not configured' };
const COMPONENT_KIND_LABEL: Record<string, string> = { EARNING: 'Earning', DEDUCTION: 'Deduction' };
const LINE_KIND_LABEL: Record<string, string> = { STANDARD: 'Standard', NOTICE_ADJUSTMENT: 'Notice adjustment' };
const LINE_SOURCE_LABEL: Record<string, string> = { ENTERED: 'Entered', UPLOADED: 'Uploaded', COPIED: 'Copied from the previous revision' };
const LOAN_KIND_LABEL: Record<string, string> = { LOAN: 'Loan', ADVANCE: 'Salary advance' };
const DECISION_LABEL: Record<string, string> = { APPROVE: 'Approved', RETURN: 'Returned for correction', REJECT: 'Rejected' };
const STEP_LABEL: Record<string, string> = { review: 'Review', approve: 'Approval' };
const EXIT_STATE_LABEL: Record<string, string> = { APPROVED: 'Approved', SEPARATED: 'Separated' };

/** Upload row problems (settlement.ts uploadLines), in plain words. */
const UPLOAD_ROW_WORDS: Record<string, string> = {
  WRONG_CELL_COUNT: 'The row does not have exactly one cell for each of the five columns.',
  EMPLOYEE_MISMATCH: 'The employee code is not this settlement’s employee.',
  DATE_MISMATCH: 'The last working date is not the approved last working date of this exit.',
  UNKNOWN_COMPONENT: 'No active pay component has this code.',
  INVALID_AMOUNT: 'The amount is not a decimal number with up to 15 digits and 4 decimal places.',
  SIGN_MISMATCH: 'The sign does not match the pay component: an earning is zero or positive, a deduction zero or negative.',
  INVALID_LINE_KIND: 'The line kind must be STANDARD, NOTICE_ADJUSTMENT or blank.',
  NOTICE_PERIOD_NOT_RECORDED: 'A notice adjustment needs the contractual notice period recorded on the exit first.',
  DUPLICATE_COMPONENT: 'This pay component is already on an earlier row; each component appears once.',
  BATCH_REJECTED: 'Valid, but not applied: a file is applied all or nothing.',
};

function readable(code: string): string {
  const text = code.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
const labelOf = (map: Record<string, string>, code: string) => map[code] ?? readable(code);
const letterTypeLabel = (code: string) => LETTER_TYPES.find(([c]) => c === code)?.[1] ?? readable(code);
const settlementLabel = (state: string) => labelOf(SETTLEMENT_STATE_LABEL, state);
const enc = encodeURIComponent;
const pad = (n: number) => String(n).padStart(2, '0');

/** An instant shown as the viewer's local day (formatDate) and local time; anything else exactly as formatDate shows it. */
function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) || Number.isNaN(d.getTime())) return formatDate(iso);
  return `${formatDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The approved placeholders a letter text uses, sorted (the server reads the text the same way and checks it). */
function usedPlaceholders(body: string): string[] {
  return [...new Set([...body.matchAll(TOKEN)].map((m) => m[1]!))].sort();
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

const isForbidden = (error: unknown) => error instanceof ApiError && error.status === 403;
const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;
const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409;
const isSelf = (error: unknown) => error instanceof ApiError && error.code === 'SELF_ACTION_NOT_ALLOWED';
/** A refusal or bad request will not change on retry; only transient failures are retried (once). */
const retryTransient = (failureCount: number, error: Error) => !(error instanceof ApiError && error.status < 500) && failureCount < 1;

// ---------------------------------------------------------------------------------------------------------
// The API's refusals in plain words
// ---------------------------------------------------------------------------------------------------------
type Words = Record<string, string | ((error: ApiError) => string)>;

/** A list in an error's details (placeholders, missing values, open clearance tasks). */
function listOf(error: ApiError, key: string): string[] {
  const value = (error.details as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
const braces = (keys: readonly string[]) => keys.map((k) => `{{${k}}}`).join(', ');
/** The line a refused line set names (settlement.ts replaceLines). */
function atLine(error: ApiError, text: string): string {
  const line = (error.details as { line?: unknown } | undefined)?.line;
  return typeof line === 'number' ? `Line ${line}: ${text}` : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

const COMMON_WORDS: Words = {
  FORBIDDEN: 'The selected role is not permitted to do this.',
  NOT_FOUND: 'This record is not available in the selected role’s scope.',
  SELF_ACTION_NOT_ALLOWED: 'This concerns your own record, which you cannot handle in this role.',
  STALE_VERSION: 'The record changed after it was loaded. It has been reloaded: check it and try again.',
  RETRY: 'This conflicted with another change made at the same moment. Try again.',
  UNAVAILABLE: 'The service is busy. Try again in a few seconds.',
  RULE_VIOLATION: 'This breaks a business rule, so nothing was recorded.',
};

const TEMPLATE_WORDS: Words = {
  TEMPLATE_CODE_EXISTS: 'A letter template with this code already exists. Choose another code.',
  UNKNOWN_PLACEHOLDER: (e) => `Only approved placeholders may be used. Not approved: ${braces(listOf(e, 'placeholders'))}.`,
  MALFORMED_PLACEHOLDER: (e) => `A placeholder is not written correctly: ${listOf(e, 'placeholders').join(', ')}. Write each placeholder as {{name}}, with letters and digits only.`,
  INVALID_OPTIONAL_PLACEHOLDER: (e) => `Only placeholders the text uses can be optional. Not in the text: ${braces(listOf(e, 'placeholders'))}.`,
  EMPLOYMENT_PERIOD_REQUIRED: (e) => `A relieving or experience letter must show the employment period, so these placeholders must be in the text and not optional: ${braces(listOf(e, 'placeholders'))}.`,
  INVALID_REFERENCE: 'This letter type is not an active letter type of this company.',
  STALE_VERSION: 'The template changed after it was loaded. It has been reloaded: check it and try again.',
  INVALID_STATE: 'Only a draft revision can be published, and this one is no longer a draft. The template has been reloaded.',
  NOT_FOUND: 'This letter template or revision is not available.',
  FORBIDDEN: 'The selected role cannot manage letter templates.',
  INVALID_REQUEST:
    'Check the entries: the code is a capital letter followed by capital letters, digits or _ (up to 40 characters), the name has at most 200 characters, the text at most 20,000, and at most 50 placeholders are optional.',
};

const DOWNLOAD_WORDS: Words = {
  NOT_FOUND: 'This letter is not available in the selected role’s scope.',
  FORBIDDEN: 'The selected role cannot open stored letters: that needs the confidential letter grant.',
  SELF_ACTION_NOT_ALLOWED: 'This letter concerns your own record, which you cannot open in this role.',
};

const CREATE_WORDS: Words = {
  EXIT_NOT_APPROVED: 'A settlement is prepared only for an approved exit, and this exit is not approved.',
  SETTLEMENT_EXISTS: 'This exit already has a live settlement revision (a draft, or one under review, approved or eligible for release). Work on that revision instead.',
  CURRENCY_REQUIRED: 'Enter the settlement currency as a three-letter ISO 4217 code, for example INR.',
  INVALID_REQUEST: 'Enter the currency as three capital letters, for example INR.',
  FORBIDDEN: 'The selected role cannot prepare settlements: that needs the confidential settlement preparation grant.',
  NOT_FOUND: 'This exit is not available in the selected role’s scope.',
  SELF_ACTION_NOT_ALLOWED: 'This is your own exit: you cannot prepare your own settlement.',
};

const PREPARE_WORDS: Words = {
  UNKNOWN_COMPONENT: (e) => atLine(e, 'no active pay component has this code.'),
  INVALID_AMOUNT: (e) => atLine(e, 'the amount must be a decimal number with up to 15 digits and 4 decimal places, with a minus sign for a deduction.'),
  SIGN_MISMATCH: (e) => atLine(e, 'the sign does not match the pay component: an earning is zero or positive, a deduction zero or negative.'),
  DUPLICATE_COMPONENT: (e) => atLine(e, 'this pay component is already on an earlier line; each component appears once.'),
  NOTICE_PERIOD_NOT_RECORDED: (e) => atLine(e, 'a notice adjustment needs the contractual notice period recorded on the exit first.'),
  INVALID_LINE_KIND: (e) => atLine(e, 'the line kind must be Standard or Notice adjustment.'),
  NOT_PREPARER: 'Only the HR Administrator who prepared this revision can change, submit or cancel it.',
  INVALID_STATE: 'Only a draft revision can change, and this revision has been submitted or closed meanwhile. It has been reloaded.',
  STALE_VERSION: 'The settlement changed after it was loaded. It has been reloaded: check it and try again.',
  INVALID_REQUEST: 'Check the lines: at most 500 lines, component codes of up to 40 characters and amounts of up to 24 characters.',
  FORBIDDEN: 'The selected role cannot prepare settlements: that needs the confidential settlement preparation grant.',
};

const UPLOAD_WORDS: Words = {
  ...PREPARE_WORDS,
  INVALID_FILE: 'The file is not valid CSV.',
  INVALID_TEMPLATE: `The file must start with exactly the header ${UPLOAD_HEADER} (template ${UPLOAD_TEMPLATE}).`,
  EMPTY_FILE: 'The file has a header but no lines.',
  TOO_MANY_ROWS: 'A file has at most 10,000 rows.',
  INVALID_REQUEST: 'The file is empty or too large for one upload.',
  PAYLOAD_TOO_LARGE: 'The file is too large for one upload.',
};

const SUBMIT_WORDS: Words = {
  ...PREPARE_WORDS,
  NO_LINES: 'Enter or upload the settlement lines before submitting.',
  EXIT_NOT_APPROVED: 'The exit is no longer approved, so the settlement cannot be submitted.',
  NO_ELIGIBLE_REVIEWER:
    'No eligible reviewer is available: the reviewer is an HR Administrator on the settlement reviewer list, holding the review grant with this employee in scope, who did not prepare it. Nothing was submitted; ask HR to update the settlement reviewer list.',
  WORKFLOW_NOT_CONFIGURED: 'No review route is configured for settlements. Nothing was submitted; ask HR to set one up.',
};

const DECISION_WORDS: Words = {
  REASON_REQUIRED: 'Record why the settlement is returned or rejected.',
  TASK_CLOSED: 'This task has already been decided.',
  INVALID_STATE: 'This settlement is no longer waiting for this decision.',
  IDEMPOTENCY_KEY_REUSED: 'Nothing was recorded: this attempt was matched to a different decision. Send your decision again.',
  NOT_FOUND: 'This task is not yours, or it is no longer in the selected role’s scope.',
  NO_ELIGIBLE_REVIEWER:
    'No eligible approver is available for the next step: the approver is another HR Administrator on the settlement reviewer list, holding the approval grant with this employee in scope, who neither prepared nor reviewed it. Nothing was recorded; ask HR to update the list.',
  WORKFLOW_NOT_CONFIGURED: 'No approval route is configured for settlements. Nothing was recorded; ask HR to set one up.',
  FORBIDDEN: 'The selected role cannot make this decision.',
  RULE_VIOLATION: 'This decision breaks a rule (for example, a decision about your own record), so nothing was recorded.',
};

const RELEASE_WORDS: Words = {
  NOT_INDEPENDENT: 'Release eligibility is recorded by someone other than the preparer, the reviewer and the approver of this settlement.',
  CLEARANCE_NOT_STARTED: 'The exit clearance checklist has not been started. It has to be started, and its required tasks completed, first.',
  CLEARANCE_INCOMPLETE: (e) => {
    const open = listOf(e, 'tasks');
    return `Every required exit clearance task must be completed first.${open.length > 0 ? ` Still open: ${open.join(', ')}.` : ''}`;
  },
  EXIT_NOT_APPROVED: 'The exit is no longer approved.',
  INVALID_STATE: 'Only an approved settlement can become eligible for release, and this one has moved on. It has been reloaded.',
  STALE_VERSION: 'The settlement changed after it was loaded. It has been reloaded: check it and try again.',
  FORBIDDEN: 'The selected role cannot record release eligibility: that needs the confidential release grant.',
};

const EXPORT_WORDS: Words = {
  NOT_APPROVED: 'Only an approved settlement, or one eligible for release, is exported.',
  FORBIDDEN: 'The selected role cannot export settlements: exporting needs its own settlement export grant, separate from reading a settlement.',
};

/** The ZIP download's refusals: one unavailable settlement refuses the whole archive, named where the screen knows it. */
function archiveWords(names: ReadonlyMap<string, string>): Words {
  return {
    NOT_APPROVED: (e) => {
      const id = (e.details as { settlementId?: unknown } | undefined)?.settlementId;
      const name = typeof id === 'string' ? names.get(id) : undefined;
      return `${name ? `The settlement of ${name}` : 'One of the selected settlements'} is no longer approved or eligible for release, so nothing was downloaded. Take it off the selection and download again.`;
    },
    NOT_FOUND: 'One of the selected settlements is no longer available in the selected role’s scope, so nothing was downloaded.',
    SELF_ACTION_NOT_ALLOWED: 'Your own settlement is among the selected ones, and you cannot export it in this role, so nothing was downloaded.',
    TOO_MANY_SETTLEMENTS: `One ZIP download holds at most ${MAX_ARCHIVE} settlements.`,
    NO_SELECTION: 'Select at least one settlement.',
    FORBIDDEN: EXPORT_WORDS.FORBIDDEN!,
  };
}

/**
 * Bulk upload row problems (settlement-import.ts and the shared import framework): the one-settlement upload's checks,
 * and the settlement a row names by its employee code and approved last working date.
 */
const BULK_UPLOAD_PROBLEMS: Record<string, string> = {
  ...UPLOAD_ROW_WORDS,
  UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code.',
  OUT_OF_SCOPE: 'This employee is outside the scope of the selected role.',
  SELF_ACTION_NOT_ALLOWED: 'This is your own settlement, which you cannot prepare.',
  NO_DRAFT_SETTLEMENT: 'This employee has no settlement revision in draft. Prepare one from the approved exit first; a submitted revision is frozen.',
  DATE_MISMATCH: 'The last working date is not the approved last working date of the exit whose settlement is in draft.',
  NOT_PREPARER: 'Only the HR Administrator who prepared the draft can upload its lines.',
  INVALID_STATE: 'The settlement is no longer a draft.',
  COLUMN_COUNT: 'The row does not have exactly one cell for each of the five columns.',
  FORBIDDEN: 'The selected role can no longer prepare settlements, so nothing was applied.',
};

const BULK_UPLOAD: ImportTemplate = {
  code: UPLOAD_TEMPLATE,
  label: 'Settlement lines',
  permissions: [SETTLEMENT_PREPARE],
  base: SETTLEMENT_IMPORTS,
  columns: UPLOAD_HEADER,
  keyLabel: 'Employee / component',
  noun: ['line', 'lines'],
  verb: 'Apply',
  note: 'Each row names a settlement by the employee code and the approved last working date: the revision in draft that you prepared. Its rows replace every line of that draft, exactly as uploading them on the settlement does; one row per pay component, the line kind STANDARD, NOTICE_ADJUSTMENT or blank. Nothing is submitted: each draft is submitted for review as before.',
  problems: BULK_UPLOAD_PROBLEMS,
};

function refusalText(error: unknown, words: Words = {}): string | null {
  if (!(error instanceof ApiError)) return null;
  const entry = words[error.code] ?? COMMON_WORDS[error.code];
  if (entry === undefined) return null;
  return typeof entry === 'function' ? entry(error) : entry;
}

/**
 * A failed action: the API's refusal in plain words (its code beneath for reference), anything else as the API sent
 * it. `noAnswer` explains a request whose answer never came back (the connection dropped): it may have been recorded.
 */
function Refusal({ error, words, noAnswer }: { error: unknown; words?: Words; noAnswer?: string }) {
  if (!error) return null;
  // fetch rejects with a TypeError when the connection drops: the request may have reached the server.
  if (error instanceof TypeError) {
    return (
      <p role="alert" className="error">
        {noAnswer ?? 'No answer came back from the server. Check your connection and try again.'}
      </p>
    );
  }
  if (!(error instanceof ApiError)) return <ErrorNote error={error} />;
  const text = refusalText(error, words);
  if (text === null) return <ErrorNote error={error} />;
  return (
    <div role="alert" className="error">
      <strong>{text}</strong>
      <div className="hint">{error.code}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------------------
const SCROLL: CSSProperties = { overflowX: 'auto' };
const H3: CSSProperties = { fontSize: '1rem', margin: '0.5rem 0 0' };
const TEXTAREA: CSSProperties = { font: 'inherit', padding: '0.4rem 0.5rem', border: '1px solid var(--line)', borderRadius: 6, color: 'var(--text)', resize: 'vertical' };
const LETTER: CSSProperties = { whiteSpace: 'pre-wrap', fontFamily: 'inherit', border: '1px solid var(--line)', borderRadius: 6, padding: '0.75rem', margin: '0.5rem 0', background: 'var(--surface)' };
const GROUP: CSSProperties = { border: '1px solid var(--line)', borderRadius: 6, padding: '0.5rem 0.75rem', margin: 0, minWidth: 0 };
const SR_ONLY: CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 };

/**
 * Query keys carry the selected company and assignment: the app keeps one query cache across role switches, and an
 * answer given to one assignment (a scoped list, a letter, settlement amounts) must never be shown under another, not
 * even from the cache while the new answer loads.
 */
function useKeys() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(() => {
    const k = (...parts: string[]) => ['lifecycle-documents', context, ...parts] as const;
    return {
      placeholders: k('letter-placeholders'),
      templates: k('letter-templates'),
      template: (id: string) => k('letter-template', id),
      employeeSearch: (term: string) => k('employee-search', term),
      employee: (id: string) => k('employee', id),
      processes: (employeeId: string) => k('employee-processes', employeeId),
      process: (id: string) => k('employee-process', id),
      allOutputs: k('letter-outputs'),
      outputs: (employeeId: string) => k('letter-outputs', employeeId),
      notes: (employeeId: string) => k('employee-notes', employeeId),
      settlementLists: k('settlement-list'),
      settlementList: (query: string) => k('settlement-list', query),
      settlement: (id: string) => k('settlement', id),
      allExitSettlements: k('exit-settlements'),
      exitSettlements: (exitId: string) => k('exit-settlements', exitId),
      exit: (id: string) => k('exit', id),
      exits: (state: string) => k('exits', state),
      tasks: k('settlement-tasks'),
      calculation: k('settlement-calculation'),
    };
  }, [context]);
}

/** After a settlement changes: every list, queue and revision table that shows it loads again (never patched here). */
function useSettlementRefresh() {
  const qc = useQueryClient();
  const keys = useKeys();
  return (s?: { id: string } | null) => {
    void qc.invalidateQueries({ queryKey: keys.settlementLists });
    void qc.invalidateQueries({ queryKey: keys.tasks });
    void qc.invalidateQueries({ queryKey: keys.allExitSettlements });
    if (s) void qc.invalidateQueries({ queryKey: keys.settlement(s.id) });
  };
}

function NotPermitted({ children }: { children: ReactNode }) {
  return (
    <p role="note">
      <Badge tone="warn">not permitted</Badge> {children}
    </p>
  );
}

function Item({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A list or record that did not load: a refusal of the role, one's own record, a record outside the scope, or the API's error. */
function LoadProblem({ error, forbidden, missing }: { error: unknown; forbidden: string; missing?: string }) {
  if (!error) return null;
  if (isSelf(error)) return <Empty>This concerns your own record, which is not available to you in this role.</Empty>;
  if (isForbidden(error)) return <NotPermitted>{forbidden}</NotPermitted>;
  if (missing !== undefined && isNotFound(error)) return <Empty>{missing}</Empty>;
  return <ErrorNote error={error} />;
}

/** A user the API named: the signed-in user as "you", anyone else by the id the API returned. */
function UserRef({ userId }: { userId: string }) {
  const { me } = useSession();
  return me?.userId === userId ? <>you</> : <code>{userId}</code>;
}

/**
 * A decimal string the server returned, in its currency. Shown, never computed: where the 2-decimal display would hide
 * digits of the recorded value (amounts carry up to 4 decimals), the exact value follows.
 */
function Money({ value, currency }: { value: string | null | undefined; currency: string }) {
  if (value === null || value === undefined) return <>—</>;
  const finer = /\.\d{2}\d*[1-9]/.test(value);
  return (
    <>
      {formatAmount(value, currency)}
      {finer && <span className="hint"> (exactly {value})</span>}
    </>
  );
}

function SettlementState({ state }: { state: string }) {
  return <Badge tone={SETTLEMENT_TONE[state] ?? 'neutral'}>{settlementLabel(state)}</Badge>;
}

/** FR-052: the server's calculation status and its reason; nothing is ever calculated here. */
function CalculationNote({ calculation }: { calculation: Calculation | undefined }) {
  if (!calculation) return null;
  return (
    <p role="note">
      <Badge tone="warn">calculation {labelOf(CALCULATION_LABEL, calculation.status).toLowerCase()}</Badge> {calculation.reason}
    </p>
  );
}

const placeholderLabelMap = (items: readonly Placeholder[] | undefined) => new Map((items ?? []).map((p) => [p.key, p.label]));

/** A placeholder by its approved label when the list is at hand, always with its key. */
function placeholderName(labels: ReadonlyMap<string, string>, key: string): string {
  const label = labels.get(key);
  return label ? `${label} ({{${key}}})` : `{{${key}}}`;
}

function usePlaceholders(enabled: boolean) {
  const keys = useKeys();
  return useQuery({
    enabled,
    queryKey: keys.placeholders,
    queryFn: () => api<{ items: Placeholder[] }>('/v1/letter-placeholders'),
    retry: retryTransient,
    staleTime: 5 * 60_000,
  });
}

// =========================================================================================================
// Letter templates (FR-017): list, approved placeholders, a new template
// =========================================================================================================
function LetterTemplatesScreen() {
  const { can } = useSession();
  const canRead = can(TEMPLATE_READ);
  return (
    <>
      <h1>Letter templates</h1>
      <p className="hint">
        Versioned templates that may use only the approved placeholders. A template is used for letters while it is active and has a published revision; letters
        already generated keep the revision they were made from.
        {(can(LETTER_READ) || can(LETTER_GENERATE)) && (
          <>
            {' '}
            Letters for employees are prepared under <Link to={PATHS.letters}>Letters</Link>.
          </>
        )}
      </p>
      {canRead ? (
        <TemplateList />
      ) : (
        <Section title="Letter templates">
          <NotPermitted>The selected role cannot view letter templates.</NotPermitted>
        </Section>
      )}
      {can(TEMPLATE_MANAGE) && <CreateTemplate />}
      {canRead && <PlaceholderReference />}
    </>
  );
}

const usableText = (t: { active: boolean; publishedRevision: number | null }) =>
  !t.active ? 'No: inactive' : t.publishedRevision === null ? 'No: nothing published yet' : `Yes, revision ${t.publishedRevision}`;

function TemplateList() {
  const keys = useKeys();
  const list = useQuery({ queryKey: keys.templates, queryFn: () => api<{ items: TemplateSummary[] }>('/v1/letter-templates'), retry: retryTransient });
  const items = list.data?.items ?? [];
  return (
    <Section title="Letter templates">
      {list.isPending && <p className="hint">Loading the letter templates…</p>}
      <LoadProblem error={list.error} forbidden="The selected role cannot view letter templates." />
      {list.data && items.length === 0 && <Empty>No letter templates yet.</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Letter templates">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">Letter type</th>
                <th scope="col">Status</th>
                <th scope="col">Published revision</th>
                <th scope="col">Draft revision</th>
                <th scope="col">Usable for letters</th>
                <th scope="col">
                  <span style={SR_ONLY}>Template</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td>{t.code}</td>
                  <td>{t.name}</td>
                  <td>{letterTypeLabel(t.letterType)}</td>
                  <td>{t.active ? 'Active' : 'Inactive'}</td>
                  <td>{t.publishedRevision ?? 'None'}</td>
                  <td>{t.draftRevision ?? 'None'}</td>
                  <td>{usableText(t)}</td>
                  <td>
                    <Link to={PATHS.template(t.id)} aria-label={`Open template ${t.code}`}>
                      Open
                    </Link>
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

function PlaceholderReference() {
  const placeholders = usePlaceholders(true);
  const items = placeholders.data?.items ?? [];
  return (
    <Section title="Approved placeholders">
      <p className="hint">
        Write a placeholder as {'{{name}}'}. Every placeholder a template uses is mandatory unless the template marks it optional, and a missing mandatory value blocks
        the final letter. Only these placeholders are accepted.
      </p>
      {placeholders.isPending && <p className="hint">Loading the approved placeholders…</p>}
      <LoadProblem error={placeholders.error} forbidden="The selected role cannot view the approved placeholders." />
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Approved placeholders">
            <thead>
              <tr>
                <th scope="col">Placeholder</th>
                <th scope="col">Meaning</th>
                <th scope="col">Taken from</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.key}>
                  <td>
                    <code>{`{{${p.key}}}`}</code>
                  </td>
                  <td>{p.label}</td>
                  <td>{labelOf(SOURCE_LABEL, p.source)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/**
 * The letter text with placeholder insertion, the placeholders it uses and which of them are optional. `approved` is
 * the approved placeholder list when the role may read it (the server checks the text either way).
 */
function TemplateTextFields({
  body,
  onBody,
  optional,
  onOptional,
  approved,
  disabled,
}: {
  body: string;
  onBody: (next: string) => void;
  optional: readonly string[];
  onOptional: (next: string[]) => void;
  approved: readonly Placeholder[] | undefined;
  disabled: boolean;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [toInsert, setToInsert] = useState('');
  const used = usedPlaceholders(body);
  const approvedKeys = approved ? new Set(approved.map((p) => p.key)) : null;
  const labels = placeholderLabelMap(approved);
  const insert = () => {
    if (!toInsert) return;
    const token = `{{${toInsert}}}`;
    const el = area.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const next = `${body.slice(0, start)}${token}${body.slice(end)}`;
    if (next.length > MAX_BODY) return;
    onBody(next);
  };
  const toggle = (key: string, on: boolean) => onOptional(on ? [...optional.filter((k) => k !== key), key] : optional.filter((k) => k !== key));
  return (
    <>
      <label className="wide">
        Letter text (required)
        <textarea ref={area} required rows={10} maxLength={MAX_BODY} value={body} disabled={disabled} onChange={(e) => onBody(e.target.value)} style={TEXTAREA} />
      </label>
      {approved && approved.length > 0 && (
        <div className="wide row">
          <label className="inline">
            Placeholder to insert{' '}
            <select value={toInsert} disabled={disabled} onChange={(e) => setToInsert(e.target.value)}>
              <option value="">Choose…</option>
              {approved.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label} ({`{{${p.key}}}`})
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="secondary" disabled={disabled || !toInsert} onClick={insert}>
            Insert placeholder
          </button>
        </div>
      )}
      <div className="wide">
        {used.length === 0 ? (
          <p className="hint">The text uses no placeholders.</p>
        ) : (
          <fieldset style={GROUP}>
            <legend>Placeholders the text uses: mandatory unless marked optional</legend>
            <div className="row">
              {used.map((key) =>
                approvedKeys && !approvedKeys.has(key) ? (
                  <span key={key} className="error">
                    {`{{${key}}}`} is not an approved placeholder
                  </span>
                ) : (
                  <label key={key} className="check">
                    <input type="checkbox" disabled={disabled} checked={optional.includes(key)} onChange={(e) => toggle(key, e.target.checked)} /> {placeholderName(labels, key)}{' '}
                    optional
                  </label>
                ),
              )}
            </div>
          </fieldset>
        )}
      </div>
    </>
  );
}

/** The optional placeholders to send: those the text still uses, sorted. */
const optionalToSend = (body: string, optional: readonly string[]) => {
  const used = usedPlaceholders(body);
  return optional.filter((k) => used.includes(k)).sort();
};

function CreateTemplate() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const id = useId();
  const approved = usePlaceholders(can(TEMPLATE_READ));
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [letterType, setLetterType] = useState('');
  const [body, setBody] = useState('');
  const [optional, setOptional] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<TemplateDetail | null>(null);
  const create = useMutation({
    mutationFn: (input: { code: string; name: string; letterType: string; body: string; optionalPlaceholders: string[] }) =>
      api<TemplateDetail>('/v1/letter-templates', { body: input }),
    onMutate: () => setCreated(null),
    // A template created starts the form clean; a refused one keeps what was typed.
    onSuccess: (t) => {
      setCreated(t);
      setCode('');
      setName('');
      setLetterType('');
      setBody('');
      setOptional([]);
      void qc.invalidateQueries({ queryKey: keys.templates });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    const c = code.trim();
    const n = name.trim();
    const type = letterType.trim();
    const sendOptional = optionalToSend(body, optional);
    const missing = !CODE.test(c)
      ? 'Enter a template code: a capital letter followed by capital letters, digits or _ (up to 40 characters).'
      : !n
        ? 'Enter the template name.'
        : !LETTER_TYPE_CODE.test(type)
          ? 'Enter the letter type code, for example RELIEVING.'
          : !body.trim()
            ? 'Enter the letter text.'
            : sendOptional.length > MAX_OPTIONAL
              ? `At most ${MAX_OPTIONAL} placeholders can be optional.`
              : null;
    setProblem(missing);
    if (missing !== null) {
      create.reset();
      return;
    }
    create.mutate({ code: c, name: n, letterType: type, body, optionalPlaceholders: sendOptional });
  };

  const typeList = `${id}-types`;
  return (
    <Section title="New letter template">
      <form className="grid-form" aria-label="New letter template" onSubmit={submit}>
        <label>
          Template code (required)
          <input value={code} maxLength={40} required placeholder="RELIEVING_STANDARD" onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </label>
        <label>
          Name (required)
          <input value={name} maxLength={MAX_NAME} required onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Letter type (required)
          <input value={letterType} maxLength={60} required list={typeList} onChange={(e) => setLetterType(e.target.value.toUpperCase())} />
        </label>
        {/* Suggestions only (the seeded letter types); a company may have added others, and the server checks the code. */}
        <datalist id={typeList}>
          {LETTER_TYPES.map(([c, label]) => (
            <option key={c} value={c}>
              {label}
            </option>
          ))}
        </datalist>
        <TemplateTextFields body={body} onBody={setBody} optional={optional} onOptional={setOptional} approved={approved.data?.items} disabled={create.isPending} />
        <p className="hint wide">The template starts as draft revision 1. Publish it on the template’s page before letters can use it.</p>
        {problem && (
          <p role="alert" className="error wide">
            {problem}
          </p>
        )}
        {create.error && (
          <div className="wide">
            <Refusal error={create.error} words={TEMPLATE_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={create.isPending}>
            Create template
          </button>
        </div>
        {created && (
          <p className="ok wide" role="status">
            Template {created.code} created as draft revision 1. <Link to={PATHS.template(created.id)}>Open template {created.code}</Link> to publish it.
          </p>
        )}
      </form>
    </Section>
  );
}

// =========================================================================================================
// One letter template: revisions, the draft, publishing, renaming and activation
// =========================================================================================================
function LetterTemplateScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!UUID.test(id)) {
    return (
      <>
        <h1>Letter template</h1>
        <Empty>This address does not name a letter template.</Empty>
      </>
    );
  }
  if (!can(TEMPLATE_READ)) {
    return (
      <>
        <h1>Letter template</h1>
        <Section title="Letter template">
          <NotPermitted>The selected role cannot view letter templates.</NotPermitted>
        </Section>
      </>
    );
  }
  // Keyed by the record: following a link to another one never carries typed text or notices over.
  return <TemplateView key={id} id={id} />;
}

function TemplateView({ id }: { id: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const detail = useQuery({ queryKey: keys.template(id), queryFn: () => api<TemplateDetail>(`/v1/letter-templates/${enc(id)}`), retry: retryTransient });
  const t = detail.data;
  const published = t?.revisions.find((r) => r.state === 'PUBLISHED') ?? null;
  const draft = t?.revisions.find((r) => r.state === 'DRAFT') ?? null;
  return (
    <>
      <h1>{t ? `Letter template ${t.code}` : 'Letter template'}</h1>
      <p>
        <Link to={PATHS.templates}>All letter templates</Link>
      </p>
      <Section title="Template">
        {detail.isPending && <p className="hint">Loading the template…</p>}
        <LoadProblem error={detail.error} forbidden="The selected role cannot view letter templates." missing="This letter template is not available." />
        {t && (
          <dl className="kv">
            <Item term="Code">{t.code}</Item>
            <Item term="Name">{t.name}</Item>
            <Item term="Letter type">{letterTypeLabel(t.letterType)}</Item>
            <Item term="Status">{t.active ? 'Active' : 'Inactive'}</Item>
            <Item term="Published revision">{published ? published.revision : 'None'}</Item>
            <Item term="Draft revision">{draft ? draft.revision : 'None'}</Item>
            <Item term="Usable for letters">{usableText({ active: t.active, publishedRevision: published?.revision ?? null })}</Item>
          </dl>
        )}
      </Section>
      {t && <RevisionTable template={t} />}
      {t && can(TEMPLATE_MANAGE) && <TemplateSettings template={t} />}
      {t && can(TEMPLATE_MANAGE) && <DraftEditor template={t} />}
    </>
  );
}

function RevisionTable({ template: t }: { template: TemplateDetail }) {
  return (
    <Section title="Revisions">
      {t.revisions.length === 0 ? (
        <Empty>No revisions.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label="Revisions">
            <thead>
              <tr>
                <th scope="col">Revision</th>
                <th scope="col">State</th>
                <th scope="col">Mandatory placeholders</th>
                <th scope="col">Optional placeholders</th>
                <th scope="col">Published</th>
                <th scope="col">Text</th>
              </tr>
            </thead>
            <tbody>
              {t.revisions.map((r) => {
                const mandatory = r.placeholders.filter((p) => !r.optionalPlaceholders.includes(p));
                return (
                  <tr key={r.revision}>
                    <td>{r.revision}</td>
                    <td>{labelOf(REVISION_STATE_LABEL, r.state)}</td>
                    <td>{mandatory.length > 0 ? braces(mandatory) : 'None'}</td>
                    <td>{r.optionalPlaceholders.length > 0 ? braces(r.optionalPlaceholders) : 'None'}</td>
                    <td>{when(r.publishedAt)}</td>
                    <td>
                      <details>
                        <summary>Text of revision {r.revision}</summary>
                        <pre style={LETTER}>{r.body}</pre>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function useTemplateRefresh(id: string) {
  const qc = useQueryClient();
  const keys = useKeys();
  return () => {
    void qc.invalidateQueries({ queryKey: keys.template(id) });
    void qc.invalidateQueries({ queryKey: keys.templates });
  };
}

/** Renaming and activation, against the template's version (PATCH /v1/letter-templates/:id). */
function TemplateSettings({ template: t }: { template: TemplateDetail }) {
  const refresh = useTemplateRefresh(t.id);
  const [name, setName] = useState(t.name);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (body: { name?: string; active?: boolean; expectedVersion: number }) => api<TemplateDetail>(`/v1/letter-templates/${enc(t.id)}`, { method: 'PATCH', body }),
    onMutate: () => setNotice(null),
    onSuccess: (saved, body) => {
      if (body.name !== undefined) setName(saved.name);
      setNotice(
        body.active === undefined
          ? `The template is now named “${saved.name}”.`
          : saved.active
            ? 'The template is active again: letters can use its published revision.'
            : 'The template is inactive: no letter can be previewed or generated from it until it is activated again.',
      );
      refresh();
    },
    // A stale version: reload, so the next attempt uses the current one (what was typed is kept).
    onError: (error) => {
      if (isConflict(error)) refresh();
    },
  });
  const rename = (event: FormEvent) => {
    event.preventDefault();
    if (update.isPending) return;
    const n = name.trim();
    setProblem(n ? null : 'Enter the template name.');
    if (!n) {
      update.reset();
      return;
    }
    update.mutate({ name: n, expectedVersion: t.version });
  };
  return (
    <Section title="Name and status">
      <form className="row" aria-label="Rename the template" onSubmit={rename}>
        <label className="inline">
          Template name{' '}
          <input value={name} maxLength={MAX_NAME} required disabled={update.isPending} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" disabled={update.isPending}>
          Save name
        </button>
      </form>
      <p>
        This template is {t.active ? 'active' : 'inactive'}.{' '}
        {t.active ? 'Deactivating it stops new previews and letters from it; letters already generated stay as they are.' : 'Activating it lets letters use its published revision again.'}
      </p>
      <div className="row">
        <button type="button" className={t.active ? 'danger' : undefined} disabled={update.isPending} onClick={() => update.mutate({ active: !t.active, expectedVersion: t.version })}>
          {t.active ? 'Deactivate template' : 'Activate template'}
        </button>
      </div>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <Refusal error={update.error} words={TEMPLATE_WORDS} />
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
    </Section>
  );
}

/**
 * The draft revision: saved as a whole against its version (PUT .../draft); without a draft, saving opens the next
 * revision. Publishing freezes the saved draft and retires the revision published before (POST .../publish).
 */
function DraftEditor({ template: t }: { template: TemplateDetail }) {
  const { can } = useSession();
  const refresh = useTemplateRefresh(t.id);
  const approved = usePlaceholders(can(TEMPLATE_READ));
  const draft = t.revisions.find((r) => r.state === 'DRAFT') ?? null;
  const published = t.revisions.find((r) => r.state === 'PUBLISHED') ?? null;
  const start = draft ?? published;
  const [body, setBody] = useState(start?.body ?? '');
  const [optional, setOptional] = useState<string[]>(start?.optionalPlaceholders ?? []);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (input: { body: string; optionalPlaceholders: string[]; expectedVersion?: number }) =>
      api<TemplateDetail>(`/v1/letter-templates/${enc(t.id)}/draft`, { method: 'PUT', body: input }),
    onMutate: () => setNotice(null),
    onSuccess: (saved) => {
      const d = saved.revisions.find((r) => r.state === 'DRAFT');
      if (d) {
        setBody(d.body);
        setOptional(d.optionalPlaceholders);
      }
      setNotice(`${d ? `Draft revision ${d.revision}` : 'The draft'} is saved. Publish it for new letters to use it.`);
      refresh();
    },
    onError: (error) => {
      if (isConflict(error)) refresh();
    },
  });
  const publish = useMutation({
    mutationFn: (d: TemplateRevision) => api<TemplateDetail>(`/v1/letter-templates/${enc(t.id)}/publish`, { body: { revision: d.revision, expectedVersion: d.version } }),
    onMutate: () => setNotice(null),
    onSuccess: (saved, d) => {
      const p = saved.revisions.find((r) => r.state === 'PUBLISHED');
      if (p) {
        setBody(p.body);
        setOptional(p.optionalPlaceholders);
      }
      setNotice(`Revision ${d.revision} is published: new letters use it, and letters already generated keep the revision they were made from.`);
      refresh();
    },
    onError: (error) => {
      if (isConflict(error) || isNotFound(error)) refresh();
    },
  });
  const busy = save.isPending || publish.isPending;
  // The saved text this editor started from (the draft, else the published revision), as the server holds it now.
  const base = draft ?? published;
  const changed = base !== null && (body !== base.body || !sameSet(optionalToSend(body, optional), base.optionalPlaceholders));
  // Publishing publishes the saved draft: changes not saved yet would not be in it.
  const unsaved = draft !== null && changed;
  const discard = () => {
    if (!base) return;
    setBody(base.body);
    setOptional(base.optionalPlaceholders);
    setProblem(null);
    save.reset();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const sendOptional = optionalToSend(body, optional);
    const missing = !body.trim() ? 'Enter the letter text.' : sendOptional.length > MAX_OPTIONAL ? `At most ${MAX_OPTIONAL} placeholders can be optional.` : null;
    setProblem(missing);
    if (missing !== null) {
      save.reset();
      return;
    }
    save.mutate({ body, optionalPlaceholders: sendOptional, ...(draft ? { expectedVersion: draft.version } : {}) });
  };

  return (
    <Section title={draft ? `Draft revision ${draft.revision}` : 'Next revision'}>
      <p className="hint">
        {draft
          ? 'Edit the draft and save it, then publish it. A published revision is frozen.'
          : published
            ? `Start the next revision from the published text (revision ${published.revision}). Saving opens a new draft; revision ${published.revision} stays in use until the draft is published.`
            : 'Write the text and save it as a draft.'}
      </p>
      <form className="grid-form" aria-label={draft ? `Draft revision ${draft.revision}` : 'Next revision'} onSubmit={submit}>
        <TemplateTextFields body={body} onBody={setBody} optional={optional} onOptional={setOptional} approved={approved.data?.items} disabled={busy} />
        {problem && (
          <p role="alert" className="error wide">
            {problem}
          </p>
        )}
        {save.error && (
          <div className="wide">
            <Refusal error={save.error} words={TEMPLATE_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={busy}>
            {draft ? 'Save draft' : 'Save as a new draft'}
          </button>
          {changed && base && (
            <button type="button" className="secondary" disabled={busy} onClick={discard}>
              Discard changes (back to the saved text of revision {base.revision})
            </button>
          )}
        </div>
      </form>
      {draft && (
        <div className="stack">
          <p>
            Publishing revision {draft.revision} freezes it{published ? ` and retires revision ${published.revision}` : ''}. New letters then use revision {draft.revision}.
          </p>
          {unsaved && <p className="hint">Save the draft first: publishing publishes the saved text, not unsaved changes.</p>}
          <div className="row">
            <button type="button" disabled={busy || unsaved} onClick={() => publish.mutate(draft)}>
              Publish revision {draft.revision}
            </button>
          </div>
          <Refusal error={publish.error} words={TEMPLATE_WORDS} />
        </div>
      )}
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
    </Section>
  );
}

// =========================================================================================================
// Letters (FR-017, FR-018, FR-055): find an employee, their stored letters, processes and restricted notes
// =========================================================================================================
function LettersScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Letters</h1>
      <p className="hint">
        A letter is prepared for one of an employee’s processes: preview it (nothing is stored or sent), then generate the final letter. The final letter is stored as
        a confidential file and downloaded for manual delivery; sending letters is not available.
        {can(TEMPLATE_READ) && (
          <>
            {' '}
            Templates are kept under <Link to={PATHS.templates}>Letter templates</Link>.
          </>
        )}
      </p>
      <EmployeeFinder />
    </>
  );
}

function EmployeeFinder() {
  const { can } = useSession();
  const keys = useKeys();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const hits = useQuery({
    enabled: can(EMPLOYEE_LIST) && term !== '',
    queryKey: keys.employeeSearch(term),
    queryFn: () => api<{ items: EmployeeHit[]; total: number }>(`/v1/employees?${new URLSearchParams({ search: term, page: '1', pageSize: String(EMPLOYEE_PAGE_SIZE) }).toString()}`),
    retry: retryTransient,
  });
  if (!can(EMPLOYEE_LIST)) {
    return (
      <Section title="Find an employee">
        <NotPermitted>The selected role cannot search employees. Open an employee’s letters from their process instead.</NotPermitted>
      </Section>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTerm(search.trim());
  };
  return (
    <Section title="Find an employee">
      <form className="row" aria-label="Find an employee" onSubmit={submit}>
        <label className="inline">
          Employee name, code or work email{' '}
          <input type="search" value={search} maxLength={100} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button type="submit">Search</button>
      </form>
      {term !== '' && hits.isPending && <p className="hint">Searching…</p>}
      <LoadProblem error={hits.error} forbidden="The selected role cannot search employees." />
      {hits.data && hits.data.items.length === 0 && <Empty>No employees match “{term}”.</Empty>}
      {hits.data && hits.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Employees found">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span style={SR_ONLY}>Letters</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {hits.data.items.map((e) => (
                <tr key={e.id}>
                  <td>{e.employeeCode}</td>
                  <td>{e.displayName}</td>
                  <td>
                    <StateBadge state={e.status} />
                  </td>
                  <td>
                    <Link to={PATHS.employeeLetters(e.id)} aria-label={`Letters of ${e.displayName} (${e.employeeCode})`}>
                      Letters
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hits.data.total > hits.data.items.length && (
            <p className="hint">
              Showing the first {hits.data.items.length} of {hits.data.total}; refine the search to narrow it down.
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

function EmployeeLettersScreen() {
  const { id = '' } = useParams();
  if (!UUID.test(id)) {
    return (
      <>
        <h1>Employee letters</h1>
        <Empty>This address does not name an employee.</Empty>
      </>
    );
  }
  return <EmployeeLetters key={id} employeeId={id} />;
}

function EmployeeLetters({ employeeId }: { employeeId: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const own = !!me?.employeeId && me.employeeId === employeeId;
  const employee = useQuery({
    enabled: can(EMPLOYEE_READ),
    queryKey: keys.employee(employeeId),
    queryFn: () => api<EmployeeHit>(`/v1/employees/${enc(employeeId)}`),
    retry: retryTransient,
  });
  const who = employee.data ? `${employee.data.displayName} (${employee.data.employeeCode})` : null;
  return (
    <>
      <h1>{who ? `Letters of ${who}` : 'Employee letters'}</h1>
      <p className="row">
        <Link to={PATHS.letters}>Find another employee</Link>
        {can(PROCESS_READ) && <Link to={PATHS.employeeLifecycle(employeeId)}>Processes and exit of this employee</Link>}
      </p>
      {own ? (
        <Section title="Letters">
          <Empty>This is your own record. Letters and restricted notes about your own record are not available in this role.</Empty>
        </Section>
      ) : (
        <>
          <StoredLetters employeeId={employeeId} />
          {can(LETTER_GENERATE) && <ProcessesForLetters employeeId={employeeId} />}
          {can(NOTE_READ) && <RestrictedNotes employeeId={employeeId} />}
        </>
      )}
    </>
  );
}

function StoredLetters({ employeeId }: { employeeId: string }) {
  const { can } = useSession();
  if (!can(LETTER_READ)) {
    return (
      <Section title="Stored letters">
        <NotPermitted>The selected role cannot read stored letters: they need the confidential letter grant.</NotPermitted>
      </Section>
    );
  }
  return <StoredLetterList employeeId={employeeId} />;
}

function StoredLetterList({ employeeId }: { employeeId: string }) {
  const keys = useKeys();
  const [page, setPage] = useState(1);
  const outputs = useQuery({
    queryKey: [...keys.outputs(employeeId), page],
    queryFn: () => api<Paged<LetterOutput>>(pagedUrl(`/v1/employees/${enc(employeeId)}/letter-outputs`, page)),
    retry: retryTransient,
  });
  const items = outputs.data?.items ?? [];
  return (
    <Section title="Stored letters">
      <p className="hint">
        Final letters exactly as generated, newest first, each with the template revision it was made from and who generated it. Each is a confidential file; it is not
        sent to anyone, so download it for manual delivery.
      </p>
      {outputs.isPending && <p className="hint">Loading the stored letters…</p>}
      <LoadProblem error={outputs.error} forbidden="The selected role cannot read stored letters." missing="This employee is not in the selected role’s scope." />
      {outputs.data && items.length === 0 && <Empty>No letters have been generated for this employee.</Empty>}
      {items.length > 0 && <OutputTable items={items} />}
      {outputs.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={totalOf(outputs.data)} onPage={setPage} label="Stored letter pages" noun="letter" />}
    </Section>
  );
}

function OutputTable({ items }: { items: readonly LetterOutput[] }) {
  return (
    <div style={SCROLL}>
      <table aria-label="Stored letters">
        <thead>
          <tr>
            <th scope="col">Template</th>
            <th scope="col">Template revision</th>
            <th scope="col">Output number</th>
            <th scope="col">Generated</th>
            <th scope="col">Generated by</th>
            <th scope="col">Size</th>
            <th scope="col">Delivery</th>
            <th scope="col">
              <span style={SR_ONLY}>Download</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((o) => (
            <tr key={o.id}>
              <td>{o.templateCode}</td>
              <td>{o.templateRevision}</td>
              <td>{o.outputNumber}</td>
              <td>
                <time dateTime={o.generatedAt}>{when(o.generatedAt)}</time>
              </td>
              <td>
                <UserRef userId={o.generatedBy} />
              </td>
              <td>{o.byteSize} bytes</td>
              <td>{labelOf(DELIVERY_LABEL, o.deliveryState)}</td>
              <td>
                <OutputDownload output={o} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The stored letter's exact content; the server re-checks the grant and scope and records the read. */
function OutputDownload({ output: o }: { output: LetterOutput }) {
  const open = useMutation({ mutationFn: () => download(`/v1/letter-outputs/${enc(o.id)}/content`) });
  return (
    <>
      <button type="button" className="link" disabled={open.isPending} aria-label={`Download ${o.templateCode} letter ${o.outputNumber}`} onClick={() => open.mutate()}>
        Download
      </button>
      <Refusal error={open.error} words={DOWNLOAD_WORDS} />
    </>
  );
}

function ProcessesForLetters({ employeeId }: { employeeId: string }) {
  const { can } = useSession();
  if (!can(PROCESS_READ)) {
    return (
      <Section title="Prepare a letter">
        <NotPermitted>The selected role cannot list this employee’s processes, and a letter is prepared for one of them.</NotPermitted>
      </Section>
    );
  }
  return <ProcessList employeeId={employeeId} />;
}

function ProcessList({ employeeId }: { employeeId: string }) {
  const keys = useKeys();
  const [page, setPage] = useState(1);
  const processes = useQuery({
    queryKey: [...keys.processes(employeeId), page],
    queryFn: () => api<Paged<ProcessSummary>>(pagedUrl(`/v1/employees/${enc(employeeId)}/processes`, page)),
    retry: retryTransient,
  });
  const items = processes.data?.items ?? [];
  return (
    <Section title="Prepare a letter">
      <p className="hint">
        Choose the process the letter belongs to. Exit placeholders (resignation date, approved last working date) come from an approved exit only, never from a
        proposal.
      </p>
      {processes.isPending && <p className="hint">Loading the employee’s processes…</p>}
      <LoadProblem error={processes.error} forbidden="The selected role cannot list this employee’s processes." missing="This employee is not in the selected role’s scope." />
      {processes.data && items.length === 0 && <Empty>This employee has no processes yet, so no letter can be prepared.</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Processes">
            <thead>
              <tr>
                <th scope="col">Process</th>
                <th scope="col">State</th>
                <th scope="col">Effective date</th>
                <th scope="col">
                  <span style={SR_ONLY}>Letter</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.processName} <span className="hint">{p.processCode}</span>
                  </td>
                  <td>
                    <StateBadge state={p.state} />
                  </td>
                  <td>{formatDate(p.effectiveDate)}</td>
                  <td>
                    {p.state === 'CANCELLED' ? (
                      <span className="hint">Cancelled: no letters</span>
                    ) : (
                      <Link to={PATHS.processLetters(p.id)} aria-label={`Prepare a letter for ${p.processName}`}>
                        Prepare a letter
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {processes.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={totalOf(processes.data)} onPage={setPage} label="Process pages" noun="process" plural="processes" />}
    </Section>
  );
}

/** FR-018 restricted notes, read only: each shown exactly as the server returned it, its text only when returned. */
function RestrictedNotes({ employeeId }: { employeeId: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const [page, setPage] = useState(1);
  const notes = useQuery({
    queryKey: [...keys.notes(employeeId), page],
    queryFn: () => api<Paged<NoteItem>>(pagedUrl(`/v1/employees/${enc(employeeId)}/notes`, page)),
    retry: retryTransient,
  });
  const items = notes.data?.items ?? [];
  return (
    <Section title="Restricted HR notes and warnings">
      <p className="hint">
        Visible only to authorised HR. Notes are never changed: a correction is a new note that supersedes the earlier one.
        {can(PROCESS_READ) && (
          <>
            {' '}
            Notes are added on the employee’s <Link to={PATHS.employeeLifecycle(employeeId)}>processes and exit</Link> screen.
          </>
        )}
      </p>
      {notes.isPending && <p className="hint">Loading the restricted notes…</p>}
      <LoadProblem error={notes.error} forbidden="The selected role cannot read restricted HR notes." missing="This employee is not in the selected role’s scope." />
      {notes.data && items.length === 0 && <Empty>No restricted notes or warnings are recorded for this employee.</Empty>}
      {items.length > 0 && (
        <ul className="tasks" aria-label="Restricted notes">
          {items.map((n) => (
            <li key={n.id}>
              <div>
                <strong>{labelOf(NOTE_KIND_LABEL, n.kind)}</strong> <span className="hint">recorded {when(n.createdAt)}</span>
                {n.supersededByNoteId && <span className="hint"> · superseded by a later note</span>}
                {n.supersedesNoteId && <span className="hint"> · corrects an earlier note</span>}
                {n.processId && <span className="hint"> · linked to a process</span>}
                {n.exitCaseId && <span className="hint"> · linked to an exit</span>}
              </div>
              {typeof n.body === 'string' && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{n.body}</p>}
            </li>
          ))}
        </ul>
      )}
      {notes.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={totalOf(notes.data)} onPage={setPage} label="Note pages" noun="note" />}
    </Section>
  );
}

// =========================================================================================================
// Letters for one process: preview (never stored or sent), then the final letter
// =========================================================================================================
function ProcessLettersScreen() {
  const { id = '' } = useParams();
  if (!UUID.test(id)) {
    return (
      <>
        <h1>Process letters</h1>
        <Empty>This address does not name an employee process.</Empty>
      </>
    );
  }
  return <ProcessLetters key={id} processId={id} />;
}

function ProcessLetters({ processId }: { processId: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const canRead = can(PROCESS_READ);
  const process = useQuery({
    enabled: canRead,
    queryKey: keys.process(processId),
    queryFn: () => api<ProcessDetail>(`/v1/employee-processes/${enc(processId)}`),
    retry: retryTransient,
  });
  const p = process.data;
  const own = p !== undefined && !!me?.employeeId && me.employeeId === p.employeeId;
  return (
    <>
      <h1>{p ? `Letters for ${p.employeeName} (${p.employeeCode})` : 'Process letters'}</h1>
      <Section title="Process">
        {!canRead && <p className="hint">The selected role cannot open this process, so its details are not shown here; the server checks every letter request.</p>}
        {canRead && process.isPending && <p className="hint">Loading the process…</p>}
        <LoadProblem error={process.error} forbidden="The selected role cannot open this process." missing="This process is not available in the selected role’s scope." />
        {p && (
          <>
            <dl className="kv">
              <Item term="Employee">
                {p.employeeName} <span className="hint">{p.employeeCode}</span>
              </Item>
              <Item term="Process">
                {p.processName} <span className="hint">{p.processCode}</span>
              </Item>
              <Item term="State">
                <StateBadge state={p.state} />
              </Item>
              <Item term="Effective date">{formatDate(p.effectiveDate)}</Item>
              <Item term="Linked exit">
                {p.exitCaseId ? 'Yes: exit placeholders use this exit once it is approved' : 'None: exit placeholders use the employee’s approved exit, if there is one'}
              </Item>
            </dl>
            <p className="row">
              <Link to={PATHS.process(p.id)}>Open the process</Link>
              {can(LETTER_READ) && <Link to={PATHS.employeeLetters(p.employeeId)}>Stored letters of {p.employeeName}</Link>}
            </p>
          </>
        )}
      </Section>
      {!can(LETTER_GENERATE) ? (
        <Section title="Prepare a letter">
          <NotPermitted>The selected role cannot prepare letters: previews and final letters need the confidential letter grant.</NotPermitted>
        </Section>
      ) : canRead && !p ? null /* the process is loading, or did not load (said above): nothing to prepare yet */ : own ? (
        <Section title="Prepare a letter">
          <Empty>This process is about your own record, so you cannot prepare letters for it in this role.</Empty>
        </Section>
      ) : p?.state === 'CANCELLED' ? (
        <Section title="Prepare a letter">
          <Empty>This process was cancelled, so no letter can be generated for it.</Empty>
        </Section>
      ) : (
        <LetterComposer processId={processId} employeeId={p?.employeeId ?? null} />
      )}
    </>
  );
}

/**
 * Choose a template, preview the letter, then generate the final letter. The final letter is offered only for a
 * preview of the chosen template that has every mandatory value; the server checks again and refuses a letter with a
 * missing mandatory value. Each generation stores a new letter (the route takes no idempotency key), so after one the
 * letter is previewed again before another is generated.
 */
function LetterComposer({ processId, employeeId }: { processId: string; employeeId: string | null }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const id = useId();
  const canTemplates = can(TEMPLATE_READ);
  const templates = useQuery({ enabled: canTemplates, queryKey: keys.templates, queryFn: () => api<{ items: TemplateSummary[] }>('/v1/letter-templates'), retry: retryTransient });
  const approved = usePlaceholders(canTemplates);
  const labels = useMemo(() => placeholderLabelMap(approved.data?.items), [approved.data]);
  const name = (key: string) => placeholderName(labels, key);
  const words = useMemo<Words>(
    () => ({
      INVALID_REFERENCE: 'No letter template has this code.',
      TEMPLATE_INACTIVE: 'This letter template is inactive, so it cannot be used for letters. Choose another template, or ask HR to activate it.',
      TEMPLATE_NOT_PUBLISHED: 'This letter template has no published revision yet, so it cannot be used for letters.',
      MISSING_PLACEHOLDER: (e) =>
        `The final letter was not generated: mandatory values are missing: ${listOf(e, 'missing')
          .map((k) => placeholderName(labels, k))
          .join(', ')}. Once they are recorded, preview the letter again.`,
      PROCESS_CANCELLED: 'This process was cancelled, so no letter can be generated for it.',
      EXIT_NOT_APPROVED: 'A relieving or experience letter is issued from an approved exit, and this employee has none for this process.',
      EMPLOYMENT_PERIOD_REQUIRED: 'This relieving or experience template does not show the employment period. Ask HR to publish a revision with the joining date and the last working date as mandatory placeholders.',
      NOT_FOUND: 'This process is not available in the selected role’s scope.',
      FORBIDDEN: 'The selected role cannot prepare letters: that needs the confidential letter grant.',
      SELF_ACTION_NOT_ALLOWED: 'This process is about your own record, so you cannot prepare letters for it in this role.',
      INVALID_REQUEST: 'Enter a template code: a capital letter followed by capital letters, digits or _ (up to 40 characters).',
    }),
    [labels],
  );
  const usable = (templates.data?.items ?? []).filter((t) => t.active && t.publishedRevision !== null);
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<LetterPreview | null>(null);
  const [generated, setGenerated] = useState<LetterOutput | null>(null);
  const generate = useMutation({
    mutationFn: (templateCode: string) => api<LetterOutput>(`/v1/employee-processes/${enc(processId)}/letters`, { body: { templateCode } }),
    // Stored: the choice starts clean, and another letter needs a new preview first.
    onSuccess: (letter) => {
      setGenerated(letter);
      setShown(null);
      setCode('');
      void qc.invalidateQueries({ queryKey: employeeId ? keys.outputs(employeeId) : keys.allOutputs });
    },
    // The answer was lost: the letter may have been stored; the stored letters show whether it was.
    onError: (error) => {
      if (!(error instanceof ApiError)) void qc.invalidateQueries({ queryKey: keys.allOutputs });
    },
  });
  const preview = useMutation({
    mutationFn: (templateCode: string) => api<LetterPreview>(`/v1/employee-processes/${enc(processId)}/letters/preview`, { body: { templateCode } }),
    onMutate: () => {
      setShown(null);
      setGenerated(null);
      generate.reset();
    },
    onSuccess: setShown,
  });
  const busy = preview.isPending || generate.isPending;
  const chosen = code.trim().toUpperCase();
  const current = shown !== null && shown.templateCode === chosen ? shown : null;
  const canGenerate = current !== null && current.ready && current.missing.length === 0;

  const choose = (next: string) => {
    setCode(next);
    setShown(null);
    setProblem(null);
    preview.reset();
    generate.reset();
  };
  const runPreview = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!CODE.test(chosen)) {
      setProblem(canTemplates ? 'Choose a letter template.' : 'Enter the template code: a capital letter followed by capital letters, digits or _ (up to 40 characters).');
      preview.reset();
      return;
    }
    setProblem(null);
    preview.mutate(chosen);
  };
  const generateFinal = () => {
    if (busy || !canGenerate || current === null) return;
    generate.mutate(current.templateCode);
  };

  const blockedId = `${id}-blocked`;
  return (
    <Section title="Prepare a letter">
      <form className="row" aria-label="Choose a letter template" onSubmit={runPreview}>
        {canTemplates ? (
          <label className="inline">
            Letter template{' '}
            <select value={code} disabled={busy} onChange={(e) => choose(e.target.value)}>
              <option value="">Choose…</option>
              {usable.map((t) => (
                <option key={t.id} value={t.code}>
                  {t.name} ({t.code}, revision {t.publishedRevision})
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="inline">
            Letter template code{' '}
            <input value={code} maxLength={40} disabled={busy} onChange={(e) => choose(e.target.value.toUpperCase())} />
          </label>
        )}
        <button type="submit" disabled={busy}>
          Preview letter
        </button>
      </form>
      {canTemplates && templates.data && usable.length === 0 && <p className="hint">No letter template is active with a published revision yet.</p>}
      <LoadProblem error={templates.error} forbidden="The selected role cannot list letter templates." />
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <Refusal error={preview.error} words={words} />
      {preview.isPending && <p className="hint">Preparing the preview…</p>}

      {current && (
        <div role="region" aria-label="Letter preview">
          <h3 style={H3}>
            Preview of {current.templateCode}, revision {current.templateRevision}
          </h3>
          <p>
            <Badge tone="warn">preview only</Badge> This preview is not stored and nothing is sent to anyone.
          </p>
          {current.missing.length > 0 ? (
            <p id={blockedId} role="alert" className="error">
              The final letter cannot be generated until these mandatory values are recorded: {current.missing.map(name).join(', ')}.
            </p>
          ) : (
            <p className="ok">Every mandatory value is present.</p>
          )}
          <pre style={LETTER}>{current.text}</pre>
        </div>
      )}

      <div className="stack">
        <p className="hint">
          Generating stores the final letter as a confidential file with its template revision and your name as generator. It is not sent; download it for manual
          delivery. Each generation stores a new letter.
        </p>
        {current === null && !generated && <p className="hint">Preview the letter first: the final letter is offered once a preview has every mandatory value.</p>}
        <div className="row">
          <button type="button" disabled={busy || !canGenerate} aria-describedby={current && !canGenerate ? blockedId : undefined} onClick={generateFinal}>
            Generate the final letter
          </button>
        </div>
        <Refusal
          error={generate.error}
          words={words}
          noAnswer="No answer came back, so the letter may or may not have been stored. Check the employee’s stored letters before generating it again: each generation stores a new letter."
        />
      </div>

      {generated && (
        <div className="stack">
          <p className="ok" role="status">
            Final letter stored: {generated.templateCode}, revision {generated.templateRevision}, letter number {generated.outputNumber}.
          </p>
          <dl className="kv">
            <Item term="Template">{generated.templateCode}</Item>
            <Item term="Template revision">{generated.templateRevision}</Item>
            <Item term="Letter number">{generated.outputNumber}</Item>
            <Item term="Generated">
              <time dateTime={generated.generatedAt}>{when(generated.generatedAt)}</time>
            </Item>
            <Item term="Generated by">
              <UserRef userId={generated.generatedBy} />
            </Item>
            <Item term="Size">{generated.byteSize} bytes</Item>
            <Item term="Delivery">{labelOf(DELIVERY_LABEL, generated.deliveryState)}: sending letters is not available</Item>
          </dl>
          {can(LETTER_READ) ? (
            <div className="row">
              <OutputDownload output={generated} />
            </div>
          ) : (
            <p className="hint">Downloading the stored letter needs the letter read grant.</p>
          )}
        </div>
      )}
    </Section>
  );
}

// =========================================================================================================
// Settlements (FR-052 to FR-054, BR-016): the register, the decision queues and preparation from an approved exit
// =========================================================================================================
function SettlementsScreen() {
  const { can, stored } = useSession();
  // A selection made under one role assignment is never carried to another.
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return (
    <>
      <h1>Full and final settlements</h1>
      {can(SETTLEMENT_READ) ? (
        <SettlementRegister key={`register:${context}`} />
      ) : (
        <Section title="Settlements">
          <NotPermitted>The selected role cannot view settlements.</NotPermitted>
        </Section>
      )}
      {can(SETTLEMENT_REVIEW) && <SettlementReviewQueue />}
      {can(SETTLEMENT_APPROVE) && <SettlementApprovalQueue />}
      {can(SETTLEMENT_PREPARE) && <PrepareFromExit />}
      {can(SETTLEMENT_PREPARE) && <SettlementBulkUpload key={`upload:${context}`} />}
    </>
  );
}

interface SettlementList extends Paged<SettlementSummary> {
  calculation: Calculation;
}

/** The columns GET /v1/settlements sorts by that the list shows (settlement.ts); never the net amount (DF02). */
type SettlementSort = 'employeeName' | 'revision' | 'state';

/** A settlement chosen for the ZIP download, with the words that name it if the server refuses it. */
interface Selected {
  id: string;
  name: string;
}

function SettlementRegister() {
  const keys = useKeys();
  const { can } = useSession();
  // FR-054 "uploaded-list selection": the outputs carry amounts, so only a role holding the export grant selects.
  const selectable = can(SETTLEMENT_EXPORT);
  const [state, setState] = useState('');
  const [employeeCode, setEmployeeCode] = useState('');
  const [month, setMonth] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [problem, setProblem] = useState<string | null>(null);
  // Kept while paging (in the order chosen); new filters start a new selection.
  const [selected, setSelected] = useState<Selected[]>([]);
  const [sort, setSort] = useState<SortState<SettlementSort>>(null);
  const onSort = (column: SettlementSort) => {
    setSort((current) => nextSort(current, column));
    setPage(1);
  };
  const ordered = [query, new URLSearchParams(sortParams(sort)).toString()].filter(Boolean).join('&');
  const list = useQuery({
    queryKey: keys.settlementList(`${ordered}#${page}`),
    queryFn: () => api<SettlementList>(pagedUrl('/v1/settlements', page, ordered)),
    retry: retryTransient,
  });
  const apply = (event: FormEvent) => {
    event.preventDefault();
    const codeText = employeeCode.trim();
    const missing = month !== '' && !MONTH.test(month) ? 'Enter the month as YYYY-MM.' : null;
    setProblem(missing);
    if (missing !== null) return;
    const params = new URLSearchParams();
    if (state) params.set('state', state);
    if (codeText) params.set('employeeCode', codeText);
    if (month) params.set('lastWorkingMonth', month);
    setQuery(params.toString());
    setPage(1);
    setSelected([]);
  };
  const clear = () => {
    setState('');
    setEmployeeCode('');
    setMonth('');
    setProblem(null);
    setQuery('');
    setPage(1);
    setSelected([]);
  };
  const items = list.data?.items ?? [];
  const withAmounts = items.some((s) => typeof s.netAmount === 'string');
  const nameOf = (s: SettlementSummary) => `${s.employeeName} (${s.employeeCode}), revision ${s.revision}`;
  const isSelected = (id: string) => selected.some((x) => x.id === id);
  const toggle = (s: SettlementSummary, on: boolean) =>
    setSelected((now) => (on ? (now.some((x) => x.id === s.id) || now.length >= MAX_ARCHIVE ? now : [...now, { id: s.id, name: nameOf(s) }]) : now.filter((x) => x.id !== s.id)));
  const exportable = selectable ? items.filter((s) => EXPORTABLE_STATES.has(s.state)) : [];
  const selectPage = () =>
    setSelected((now) => {
      const next = [...now];
      for (const s of exportable) if (next.length < MAX_ARCHIVE && !next.some((x) => x.id === s.id)) next.push({ id: s.id, name: nameOf(s) });
      return next;
    });
  return (
    <Section title="Settlements">
      <CalculationNote calculation={list.data?.calculation} />
      <form className="grid-form" aria-label="Filter settlements" onSubmit={apply}>
        <label>
          State
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All states</option>
            {SETTLEMENT_STATES.map((s) => (
              <option key={s} value={s}>
                {settlementLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Employee code contains
          <input value={employeeCode} maxLength={MAX_EMPLOYEE_CODE} onChange={(e) => setEmployeeCode(e.target.value)} />
        </label>
        <label>
          Month of the approved last working date
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </label>
        <div className="row">
          <button type="submit">Show settlements</button>
          <button type="button" className="secondary" onClick={clear}>
            Clear filters
          </button>
        </div>
        {problem && (
          <p role="alert" className="error wide">
            {problem}
          </p>
        )}
      </form>
      {list.isPending && <p className="hint">Loading the settlements…</p>}
      <LoadProblem error={list.error} forbidden="The selected role cannot view settlements." />
      {list.data && items.length === 0 && <Empty>{query ? 'No settlements match these filters.' : 'No settlements in the selected role’s scope yet.'}</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Settlements">
            <thead>
              <tr>
                {selectable && <th scope="col">Select</th>}
                <SortHeader column="employeeName" label="Employee" sort={sort} onSort={onSort} />
                <SortHeader column="revision" label="Revision" sort={sort} onSort={onSort} />
                <SortHeader column="state" label="State" sort={sort} onSort={onSort} />
                <th scope="col">Currency</th>
                {withAmounts && <th scope="col">Net amount</th>}
                <th scope="col">
                  <span style={SR_ONLY}>Settlement</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  {selectable && (
                    <td>
                      {EXPORTABLE_STATES.has(s.state) ? (
                        <input
                          type="checkbox"
                          aria-label={`Select revision ${s.revision} of ${s.employeeName} (${s.employeeCode}) for the ZIP download`}
                          checked={isSelected(s.id)}
                          disabled={!isSelected(s.id) && selected.length >= MAX_ARCHIVE}
                          onChange={(e) => toggle(s, e.target.checked)}
                        />
                      ) : (
                        <span className="hint" title="Only an approved settlement, or one eligible for release, is exported">
                          —
                        </span>
                      )}
                    </td>
                  )}
                  <td>
                    {s.employeeName} <span className="hint">{s.employeeCode}</span>
                  </td>
                  <td>{s.revision}</td>
                  <td>
                    <SettlementState state={s.state} />
                  </td>
                  <td>{s.currencyCode}</td>
                  {withAmounts && (
                    <td>
                      <Money value={s.netAmount} currency={s.currencyCode} />
                    </td>
                  )}
                  <td>
                    <Link to={PATHS.settlement(s.id)} aria-label={`Open revision ${s.revision} of ${s.employeeName} (${s.employeeCode})`}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={totalOf(list.data)} onPage={setPage} label="Settlement pages" noun="settlement" />}
      {selectable && <ArchiveDownload selected={selected} canSelectPage={exportable.some((s) => !isSelected(s.id))} onSelectPage={selectPage} onClear={() => setSelected([])} />}
    </Section>
  );
}

/**
 * FR-054 ZIP output (CL-247): one archive holding each selected settlement's file in the chosen format, built when it
 * is downloaded (the server checks every one again and refuses the whole archive if one is not available); nothing is
 * stored or sent.
 */
function ArchiveDownload({ selected, canSelectPage, onSelectPage, onClear }: { selected: Selected[]; canSelectPage: boolean; onSelectPage: () => void; onClear: () => void }) {
  const [format, setFormat] = useState<ExportFormat>('CSV');
  const zip = useMutation({
    mutationFn: (input: { ids: string[]; format: ExportFormat }) => download(`/v1/settlements/export-archive?${new URLSearchParams({ ids: input.ids.join(','), format: input.format })}`),
  });
  const names = new Map(selected.map((s) => [s.id, s.name]));
  return (
    <div className="stack" role="group" aria-label="ZIP download of the selected settlements">
      <p className="hint">
        Select approved settlements, or ones eligible for release, on any page of the list (at most {MAX_ARCHIVE}) and download one ZIP holding each one’s export in
        the chosen format. It is built when you download it; it is not stored and nothing is sent.
      </p>
      <div className="row">
        <span role="status">{selected.length === 0 ? 'No settlement selected.' : `${selected.length} of at most ${MAX_ARCHIVE} selected.`}</span>
        <button type="button" className="secondary" disabled={!canSelectPage || selected.length >= MAX_ARCHIVE} onClick={onSelectPage}>
          Select the exportable settlements on this page
        </button>
        <button type="button" className="secondary" disabled={selected.length === 0} onClick={onClear}>
          Clear the selection
        </button>
      </div>
      <div className="row">
        <label>
          File format in the ZIP
          <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
            {EXPORT_FORMATS.map(([f, label]) => (
              <option key={f} value={f}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={selected.length === 0 || zip.isPending} onClick={() => zip.mutate({ ids: selected.map((s) => s.id), format })}>
          Download the ZIP of the selected settlements
        </button>
      </div>
      <Refusal error={zip.error} words={archiveWords(names)} />
    </div>
  );
}

/** A settlement is prepared for an approved (or separated) exit: pick it here, or open its settlements from the exit. */
function PrepareFromExit() {
  const { can } = useSession();
  if (!can(EXIT_READ)) {
    return (
      <Section title="Prepare a settlement">
        <p className="hint">A settlement is prepared for an approved exit. The selected role cannot list exits; open the exit’s settlements from the exit case.</p>
      </Section>
    );
  }
  return <ApprovedExits />;
}

function ApprovedExits() {
  const keys = useKeys();
  const [state, setState] = useState<'APPROVED' | 'SEPARATED'>('APPROVED');
  const [page, setPage] = useState(1);
  const exits = useQuery({
    queryKey: keys.exits(`${state}#${page}`),
    queryFn: () => api<Paged<ExitCase>>(pagedUrl('/v1/exit-cases', page, new URLSearchParams({ state }).toString())),
    retry: retryTransient,
  });
  const items = exits.data?.items ?? [];
  return (
    <Section title="Prepare a settlement">
      <p className="hint">A settlement is prepared for an approved exit. Open the exit’s settlements to prepare a revision or to see the revisions so far.</p>
      <label className="inline">
        Exit state{' '}
        <select
          value={state}
          onChange={(e) => {
            setState(e.target.value === 'SEPARATED' ? 'SEPARATED' : 'APPROVED');
            setPage(1);
          }}
        >
          <option value="APPROVED">Approved</option>
          <option value="SEPARATED">Separated</option>
        </select>
      </label>
      {exits.isPending && <p className="hint">Loading the exits…</p>}
      <LoadProblem error={exits.error} forbidden="The selected role cannot list exits." />
      {exits.data && items.length === 0 && <Empty>{state === 'APPROVED' ? 'No approved exits in the selected role’s scope.' : 'No separated exits in the selected role’s scope.'}</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Exits">
            <thead>
              <tr>
                <th scope="col">Employee</th>
                <th scope="col">Exit</th>
                <th scope="col">Approved last working date</th>
                <th scope="col">Notice period</th>
                <th scope="col">
                  <span style={SR_ONLY}>Settlements</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((x) => (
                <tr key={x.id}>
                  <td>
                    {x.employeeName} <span className="hint">{x.employeeCode}</span>
                  </td>
                  <td>{labelOf(EXIT_STATE_LABEL, x.state)}</td>
                  <td>{formatDate(x.approvedLastWorkingDate)}</td>
                  <td>
                    <NoticePeriod notice={x.noticePeriod} />
                  </td>
                  <td>
                    <Link to={PATHS.exitSettlements(x.id)} aria-label={`Settlements of ${x.employeeName} (${x.employeeCode})`}>
                      Settlements
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {exits.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={totalOf(exits.data)} onPage={setPage} label="Exit pages" noun="exit" />}
    </Section>
  );
}

/** F1: the recorded contractual notice period; a notice adjustment line needs it. */
function NoticePeriod({ notice }: { notice: ExitCase['noticePeriod'] | undefined }) {
  if (!notice) return <>—</>;
  if (notice.status === 'RECORDED' && typeof notice.contractualNoticeDays === 'number') return <>{notice.contractualNoticeDays} days (recorded)</>;
  return <>Not recorded: no notice adjustment line until it is</>;
}

// =========================================================================================================
// The settlements of one exit: revisions, and a new revision
// =========================================================================================================
function ExitSettlementsScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!UUID.test(id)) {
    return (
      <>
        <h1>Exit settlements</h1>
        <Empty>This address does not name an exit.</Empty>
      </>
    );
  }
  if (!can(SETTLEMENT_READ)) {
    return (
      <>
        <h1>Exit settlements</h1>
        <Section title="Settlement revisions">
          <NotPermitted>The selected role cannot view settlements.</NotPermitted>
        </Section>
      </>
    );
  }
  return <ExitSettlements key={id} exitId={id} />;
}

function ExitSettlements({ exitId }: { exitId: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const exit = useQuery({ enabled: can(EXIT_READ), queryKey: keys.exit(exitId), queryFn: () => api<ExitCase>(`/v1/exit-cases/${enc(exitId)}`), retry: retryTransient });
  const list = useQuery({
    queryKey: keys.exitSettlements(exitId),
    queryFn: () => api<{ calculation: Calculation; items: SettlementDetail[] }>(`/v1/exit-cases/${enc(exitId)}/settlements`),
    retry: retryTransient,
  });
  const x = exit.data;
  const first = list.data?.items[0];
  const who = x ? `${x.employeeName} (${x.employeeCode})` : first ? `${first.employeeName} (${first.employeeCode})` : null;
  const own = (!!me?.employeeId && (x?.employeeId === me.employeeId || first?.employeeId === me.employeeId)) || isSelf(list.error);
  const items = list.data?.items ?? [];
  const withAmounts = items.some((s) => typeof s.netAmount === 'string');
  return (
    <>
      <h1>{who ? `Settlements for ${who}` : 'Exit settlements'}</h1>
      <p className="row">
        <Link to={PATHS.settlements}>All settlements</Link>
        {can(EXIT_READ) && <Link to={PATHS.exit(exitId)}>Open the exit case</Link>}
      </p>
      {x && (
        <Section title="Exit">
          <dl className="kv">
            <Item term="Employee">
              {x.employeeName} <span className="hint">{x.employeeCode}</span>
            </Item>
            <Item term="Exit state">
              <StateBadge state={x.state} />
            </Item>
            <Item term="Approved last working date">{formatDate(x.approvedLastWorkingDate)}</Item>
            <Item term="Notice period">
              <NoticePeriod notice={x.noticePeriod} />
            </Item>
          </dl>
        </Section>
      )}
      <Section title="Settlement revisions">
        <CalculationNote calculation={list.data?.calculation} />
        {list.isPending && <p className="hint">Loading the settlement revisions…</p>}
        <LoadProblem error={list.error} forbidden="The selected role cannot view settlements." missing="This exit is not available in the selected role’s scope." />
        {list.data && items.length === 0 && <Empty>No settlement has been prepared for this exit yet.</Empty>}
        {items.length > 0 && (
          <div style={SCROLL}>
            <table aria-label="Settlement revisions">
              <thead>
                <tr>
                  <th scope="col">Revision</th>
                  <th scope="col">State</th>
                  <th scope="col">Currency</th>
                  {withAmounts && <th scope="col">Net amount</th>}
                  <th scope="col">Prepared by</th>
                  <th scope="col">Created</th>
                  <th scope="col">
                    <span style={SR_ONLY}>Revision</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id}>
                    <td>{s.revision}</td>
                    <td>
                      <SettlementState state={s.state} />
                    </td>
                    <td>{s.currencyCode}</td>
                    {withAmounts && (
                      <td>
                        <Money value={s.netAmount} currency={s.currencyCode} />
                      </td>
                    )}
                    <td>
                      <UserRef userId={s.preparedBy} />
                    </td>
                    <td>{when(s.createdAt)}</td>
                    <td>
                      <Link to={PATHS.settlement(s.id)} aria-label={`Open revision ${s.revision}`}>
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {can(SETTLEMENT_PREPARE) && list.data && !own && <PrepareRevision exitId={exitId} revisions={items} />}
    </>
  );
}

function PrepareRevision({ exitId, revisions }: { exitId: string; revisions: readonly SettlementDetail[] }) {
  const refresh = useSettlementRefresh();
  const [currency, setCurrency] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<SettlementDetail | null>(null);
  const live = revisions.find((r) => LIVE_STATES.has(r.state));
  const latest = revisions.length > 0 ? revisions[revisions.length - 1]! : null;
  const create = useMutation({
    mutationFn: (body: { currencyCode?: string }) => api<SettlementDetail>(`/v1/exit-cases/${enc(exitId)}/settlements`, { body }),
    onMutate: () => setCreated(null),
    onSuccess: (s) => {
      setCreated(s);
      setCurrency('');
      refresh(s);
    },
    // A live revision appeared meanwhile, or the answer was lost: the revisions load again to show where things stand.
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) refresh();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    const c = currency.trim().toUpperCase();
    const missing =
      c === '' && latest === null ? 'Enter the settlement currency, for example INR.' : c !== '' && !CURRENCY.test(c) ? 'Enter the currency as three capital letters, for example INR.' : null;
    setProblem(missing);
    if (missing !== null) {
      create.reset();
      return;
    }
    create.mutate(c ? { currencyCode: c } : {});
  };
  return (
    <Section title="Prepare a revision">
      {created && (
        <p className="ok" role="status">
          Revision {created.revision} created as a draft. <Link to={PATHS.settlement(created.id)}>Open revision {created.revision}</Link> to enter or upload its lines.
        </p>
      )}
      {live ? (
        <p className="hint">
          Revision {live.revision} is live ({settlementLabel(live.state).toLowerCase()}): a new revision can be prepared only once it is returned, rejected or cancelled.
        </p>
      ) : (
        <form className="grid-form" aria-label="Prepare a revision" onSubmit={submit}>
          <p className="hint wide">
            No calculation is configured, so you enter or upload the lines of the new draft yourself; an independent reviewer and approver then decide it.
            {latest &&
              ` With the same currency as revision ${latest.revision}, its lines (active pay components only) are copied into the new draft as a starting point.`}
          </p>
          <label>
            {latest ? `Currency (leave blank to keep ${latest.currencyCode})` : 'Currency (ISO 4217 code, required)'}
            <input value={currency} maxLength={3} placeholder={latest ? latest.currencyCode : 'INR'} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </label>
          {problem && (
            <p role="alert" className="error wide">
              {problem}
            </p>
          )}
          <div className="wide row">
            <button type="submit" disabled={create.isPending}>
              Prepare a new revision
            </button>
          </div>
        </form>
      )}
      {/* Outside the form: a refusal stays readable when the reloaded revisions replace the form (a live revision). */}
      <Refusal
        error={create.error}
        words={CREATE_WORDS}
        noAnswer="No answer came back, so the revision may or may not have been created. The revisions have been reloaded: check them before trying again."
      />
    </Section>
  );
}

// =========================================================================================================
// One settlement revision: lines, decisions, preparation, release eligibility and export
// =========================================================================================================
function SettlementScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!UUID.test(id)) {
    return (
      <>
        <h1>Settlement</h1>
        <Empty>This address does not name a settlement.</Empty>
      </>
    );
  }
  if (!can(SETTLEMENT_READ)) {
    return (
      <>
        <h1>Settlement</h1>
        <Section title="Settlement">
          <NotPermitted>The selected role cannot view settlements.</NotPermitted>
        </Section>
      </>
    );
  }
  return <SettlementView key={id} id={id} />;
}

function SettlementView({ id }: { id: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const detail = useQuery({ queryKey: keys.settlement(id), queryFn: () => api<SettlementDetail>(`/v1/settlements/${enc(id)}`), retry: retryTransient });
  const calculation = useQuery({ queryKey: keys.calculation, queryFn: () => api<Calculation>('/v1/settlements/calculation'), retry: retryTransient, staleTime: 5 * 60_000 });
  const s = detail.data;
  const exit = useQuery({
    enabled: s !== undefined && can(EXIT_READ),
    queryKey: keys.exit(s?.exitCaseId ?? '-'),
    queryFn: () => api<ExitCase>(`/v1/exit-cases/${enc(s!.exitCaseId)}`),
    retry: retryTransient,
  });
  /** What the last action did; it outlives the action's own panel, which goes away when the state moves on. */
  const [notice, setNotice] = useState<string | null>(null);
  const own = s !== undefined && !!me?.employeeId && me.employeeId === s.employeeId;
  return (
    <>
      <h1>{s ? `Settlement of ${s.employeeName} (${s.employeeCode}), revision ${s.revision}` : 'Settlement'}</h1>
      <p className="row">
        <Link to={PATHS.settlements}>All settlements</Link>
        {s && <Link to={PATHS.exitSettlements(s.exitCaseId)}>All revisions for this exit</Link>}
      </p>
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
      <Section title="Settlement">
        {detail.isPending && <p className="hint">Loading the settlement…</p>}
        <LoadProblem error={detail.error} forbidden="The selected role cannot view settlements." missing="This settlement is not available in the selected role’s scope." />
        {s && (
          <>
            <dl className="kv">
              <Item term="Employee">
                {s.employeeName} <span className="hint">{s.employeeCode}</span>
              </Item>
              <Item term="Revision">{s.revision}</Item>
              <Item term="State">
                <SettlementState state={s.state} />
              </Item>
              <Item term="Currency">{s.currencyCode}</Item>
              <Item term="Calculation">{labelOf(CALCULATION_LABEL, s.calculationStatus)}</Item>
              <Item term="Payment">{labelOf(PAYMENT_STATUS_LABEL, s.paymentStatus)}</Item>
              <Item term="Prepared by">
                <UserRef userId={s.preparedBy} />
              </Item>
              <Item term="Corrects">{s.supersedesSettlementId ? <Link to={PATHS.settlement(s.supersedesSettlementId)}>The previous revision</Link> : 'Nothing: first revision'}</Item>
              <Item term="Created">{when(s.createdAt)}</Item>
              <Item term="Submitted">{when(s.submittedAt)}</Item>
              <Item term="Reviewed">{when(s.reviewedAt)}</Item>
              <Item term="Approved">{when(s.approvedAt)}</Item>
              <Item term="Eligible for release">{when(s.releaseEligibleAt)}</Item>
              {exit.data && <Item term="Approved last working date">{formatDate(exit.data.approvedLastWorkingDate)}</Item>}
              {exit.data && (
                <Item term="Notice period">
                  <NoticePeriod notice={exit.data.noticePeriod} />
                </Item>
              )}
            </dl>
            <p>{STATE_EXPLANATION[s.state] ?? settlementLabel(s.state)}</p>
            {s.calculationStatus === 'NOT_CONFIGURED' && calculation.data?.status === 'NOT_CONFIGURED' && <CalculationNote calculation={calculation.data} />}
          </>
        )}
      </Section>
      {s && <SettlementLines s={s} />}
      {s && <RemainingBalances s={s} />}
      {s && <DecisionTrail s={s} />}
      {s && !own && s.state === 'DRAFT' && can(SETTLEMENT_PREPARE) && <PreparerActions s={s} exit={exit.data} onNotice={setNotice} />}
      {s && !own && s.state === 'APPROVED' && can(SETTLEMENT_RELEASE) && <ReleaseEligibility s={s} onNotice={setNotice} />}
      {s && (s.state === 'APPROVED' || s.state === 'RELEASE_ELIGIBLE') && can(SETTLEMENT_EXPORT) && <SettlementExport s={s} />}
    </>
  );
}

/** Confidential lines and net amount, exactly as returned; the net is the server's, never a sum worked out here. */
function SettlementLines({ s }: { s: SettlementDetail }) {
  if (s.lines === undefined && s.netAmount === undefined) {
    return (
      <Section title="Lines and net amount">
        <p className="hint">Settlement amounts are confidential, and the selected role does not receive them.</p>
      </Section>
    );
  }
  return (
    <Section title="Lines and net amount">
      {s.lines && s.lines.length === 0 && <Empty>No lines yet.</Empty>}
      {s.lines && s.lines.length > 0 && <LineTable lines={s.lines} currency={s.currencyCode} />}
      {s.netAmount !== undefined && (
        <p>
          <strong>Net amount:</strong> <Money value={s.netAmount} currency={s.currencyCode} /> <span className="hint">(as recorded by the server for these lines)</span>
        </p>
      )}
    </Section>
  );
}

function LineTable({ lines, currency }: { lines: readonly SettlementLine[]; currency: string }) {
  return (
    <div style={SCROLL}>
      <table aria-label="Settlement lines">
        <thead>
          <tr>
            <th scope="col">Pay component</th>
            <th scope="col">Kind</th>
            <th scope="col">Line kind</th>
            <th scope="col">Source</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.componentCode}>
              <td>
                {l.componentName} <span className="hint">{l.componentCode}</span>
              </td>
              <td>{labelOf(COMPONENT_KIND_LABEL, l.componentKind)}</td>
              <td>{labelOf(LINE_KIND_LABEL, l.lineKind)}</td>
              <td>{labelOf(LINE_SOURCE_LABEL, l.source)}</td>
              <td>
                <Money value={l.amount} currency={currency} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Leave days with 2 decimals (DF05 display), and the exact value too when the server holds a finer one. */
function Days({ value }: { value: string }) {
  const finer = /\.\d{2}\d*[1-9]/.test(value);
  return (
    <>
      {Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      {finer && <span className="hint"> (exactly {value})</span>}
    </>
  );
}

/**
 * FR-034 "settlement shows remaining balance": the outstanding loans and the paid leave balances as at the last working
 * date, exactly as the server returned them and read-only. They are information for the preparer and the deciders:
 * nothing here changes the lines or works out an encashment or a recovery.
 */
function RemainingBalances({ s }: { s: SettlementDetail }) {
  const b = s.balances;
  if (!b) {
    return (
      <Section title="Remaining balances">
        <p className="hint">Remaining loan and leave balances are shown with the settlement amounts, and the selected role does not receive them.</p>
      </Section>
    );
  }
  return (
    <Section title="Remaining balances">
      <p className="hint">Read-only. These balances do not change the settlement lines; no encashment or recovery is worked out from them.</p>
      <h3 style={H3}>Paid leave as at the last working date ({formatDate(b.asOf)})</h3>
      {b.leave.length === 0 ? (
        <Empty>No paid leave type is active.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label="Leave balances at the last working date">
            <thead>
              <tr>
                <th scope="col">Leave type</th>
                <th scope="col">Available (days)</th>
                <th scope="col">Pending (days)</th>
                <th scope="col">Taken (days)</th>
              </tr>
            </thead>
            <tbody>
              {b.leave.map((l) => (
                <tr key={l.leaveType}>
                  <td>{l.leaveType}</td>
                  <td>
                    <Days value={l.available} />
                  </td>
                  <td>
                    <Days value={l.pending} />
                  </td>
                  <td>
                    <Days value={l.taken} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3 style={H3}>Outstanding loans and advances</h3>
      {b.loans === undefined ? (
        <p className="hint">Loans and advances are not in use, so no loan balance is shown.</p>
      ) : b.loans.length === 0 ? (
        <Empty>No outstanding loan or advance.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label="Outstanding loans and advances">
            <thead>
              <tr>
                <th scope="col">Kind</th>
                <th scope="col">Disbursed</th>
                <th scope="col">Principal</th>
                <th scope="col">Recovered</th>
                <th scope="col">Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {b.loans.map((l) => (
                <tr key={l.id}>
                  <td>{labelOf(LOAN_KIND_LABEL, l.loanKind)}</td>
                  <td>{formatDate(l.disbursementDate)}</td>
                  <td>
                    <Money value={l.principal} currency={l.currencyCode} />
                  </td>
                  <td>
                    <Money value={l.recovered} currency={l.currencyCode} />
                  </td>
                  <td>
                    <Money value={l.outstanding} currency={l.currencyCode} />
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

function DecisionTrail({ s }: { s: SettlementDetail }) {
  return (
    <Section title="Decisions">
      {s.decisions.length === 0 ? (
        <Empty>No review or approval decision yet.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label="Decisions">
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col">Decision</th>
                <th scope="col">Decided</th>
              </tr>
            </thead>
            <tbody>
              {s.decisions.map((d, i) => (
                <tr key={`${d.transactionId}-${d.step}-${i}`}>
                  <td>{labelOf(STEP_LABEL, d.action)}</td>
                  <td>{labelOf(DECISION_LABEL, d.decision)}</td>
                  <td>
                    <time dateTime={d.decidedAt}>{when(d.decidedAt)}</time>
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

function PreparerActions({ s, exit, onNotice }: { s: SettlementDetail; exit: ExitCase | undefined; onNotice: (text: string) => void }) {
  const { me } = useSession();
  // An applied upload replaced every line on the server. Once the settlement has loaded again (a later version), the line
  // editor starts afresh from the lines the server now holds, so saving it never puts the replaced lines back.
  const [replacedAt, setReplacedAt] = useState<number | null>(null);
  const [editorKey, setEditorKey] = useState('lines');
  if (replacedAt !== null && s.version !== replacedAt) {
    setReplacedAt(null);
    setEditorKey(`lines-after-upload-${s.version}`);
  }
  // Submitting freezes the saved lines: while the line editor holds changes not saved yet, the revision is not submitted.
  const [unsavedLines, setUnsavedLines] = useState(false);
  if (me?.userId !== s.preparedBy) {
    return (
      <Section title="Prepare this revision">
        <p className="hint">Only the HR Administrator who prepared this revision can change, submit or cancel it.</p>
      </Section>
    );
  }
  return (
    <>
      {s.lines !== undefined ? (
        <LinesEditor key={editorKey} s={s} onUnsaved={setUnsavedLines} />
      ) : (
        <Section title="Enter the lines">
          <p className="hint">The selected role does not receive settlement amounts, so the lines cannot be edited here.</p>
        </Section>
      )}
      <LinesUpload s={s} exit={exit} onReplaced={setReplacedAt} />
      <SubmitDraft s={s} onNotice={onNotice} unsavedLines={s.lines !== undefined && unsavedLines} />
      <CancelDraft s={s} onNotice={onNotice} />
    </>
  );
}

interface LineRow extends LineInput {
  key: number;
}

/** Whether the editor's rows are exactly the lines the server returned (compared as text, never as numbers). */
const sameLines = (rows: readonly LineInput[], lines: readonly SettlementLine[]) =>
  rows.length === lines.length &&
  rows.every((r, i) => {
    const l = lines[i]!;
    return r.componentCode.trim() === l.componentCode && r.amount.trim() === l.amount && r.lineKind === (l.lineKind === 'NOTICE_ADJUSTMENT' ? 'NOTICE_ADJUSTMENT' : 'STANDARD');
  });

/** The draft's lines, replaced as a whole against the settlement's version (PUT /v1/settlements/:id/lines). */
function LinesEditor({ s, onUnsaved }: { s: SettlementDetail; onUnsaved: (unsaved: boolean) => void }) {
  const refresh = useSettlementRefresh();
  const next = useRef(0);
  const toRows = (lines: readonly SettlementLine[]): LineRow[] =>
    lines.map((l) => ({ key: next.current++, componentCode: l.componentCode, amount: l.amount, lineKind: l.lineKind === 'NOTICE_ADJUSTMENT' ? 'NOTICE_ADJUSTMENT' : 'STANDARD' }));
  const [rows, setRows] = useState<LineRow[]>(() => toRows(s.lines ?? []));
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: { lines: LineInput[]; expectedVersion: number }) => api<SettlementDetail>(`/v1/settlements/${enc(s.id)}/lines`, { method: 'PUT', body }),
    onMutate: () => setNotice(null),
    // Saved: the editor shows the lines as the server holds them now. Refused: what was typed stays.
    onSuccess: (saved, body) => {
      setRows(toRows(saved.lines ?? []));
      setNotice(body.lines.length === 1 ? 'Saved 1 line.' : `Saved ${body.lines.length} lines.`);
      refresh(saved);
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) refresh(s);
    },
  });
  // Rows that differ from the server's lines are not saved yet (submitting would freeze the saved ones instead).
  const unsaved = !sameLines(rows, s.lines ?? []);
  useEffect(() => onUnsaved(unsaved), [unsaved, onUnsaved]);
  useEffect(() => () => onUnsaved(false), [onUnsaved]);
  const change = (key: number, patch: Partial<LineInput>) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const add = () => setRows((prev) => (prev.length >= MAX_LINES ? prev : [...prev, { key: next.current++, componentCode: '', amount: '', lineKind: 'STANDARD' }]));
  const remove = (key: number) => setRows((prev) => prev.filter((r) => r.key !== key));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending) return;
    // Format checks only: components, signs, duplicates and the notice period are the server's to check.
    let missing: string | null = null;
    rows.forEach((r, i) => {
      if (missing !== null) return;
      if (!r.componentCode.trim()) missing = `Line ${i + 1}: enter the pay component code.`;
      else if (!AMOUNT.test(r.amount.trim())) missing = `Line ${i + 1}: enter the amount as a decimal number with up to 15 digits and 4 decimal places (a minus sign for a deduction).`;
    });
    setProblem(missing);
    if (missing !== null) {
      save.reset();
      return;
    }
    save.mutate({ lines: rows.map((r) => ({ componentCode: r.componentCode.trim(), amount: r.amount.trim(), lineKind: r.lineKind })), expectedVersion: s.version });
  };
  return (
    <Section title="Enter the lines">
      <p className="hint">
        One line per pay component. Earnings are zero or positive and deductions zero or negative; a notice adjustment needs the exit’s contractual notice period.
        Saving replaces every line of this draft, and the server records the net amount.
      </p>
      <form className="stack" aria-label="Settlement lines" onSubmit={submit}>
        {rows.length === 0 && <Empty>No lines. Add one to start.</Empty>}
        {rows.map((r, i) => (
          <fieldset key={r.key} style={GROUP}>
            <legend>Line {i + 1}</legend>
            <div className="row">
              <label>
                Pay component code
                <input value={r.componentCode} maxLength={MAX_COMPONENT_CODE} disabled={save.isPending} onChange={(e) => change(r.key, { componentCode: e.target.value.toUpperCase() })} />
              </label>
              <label>
                Amount
                <input value={r.amount} maxLength={MAX_AMOUNT_TEXT} inputMode="decimal" disabled={save.isPending} onChange={(e) => change(r.key, { amount: e.target.value })} />
              </label>
              <label>
                Line kind
                <select value={r.lineKind} disabled={save.isPending} onChange={(e) => change(r.key, { lineKind: e.target.value === 'NOTICE_ADJUSTMENT' ? 'NOTICE_ADJUSTMENT' : 'STANDARD' })}>
                  <option value="STANDARD">Standard</option>
                  <option value="NOTICE_ADJUSTMENT">Notice adjustment</option>
                </select>
              </label>
              <button type="button" className="secondary" disabled={save.isPending} aria-label={`Remove line ${i + 1}`} onClick={() => remove(r.key)}>
                Remove
              </button>
            </div>
          </fieldset>
        ))}
        <div className="row">
          <button type="button" className="secondary" disabled={save.isPending || rows.length >= MAX_LINES} onClick={add}>
            Add a line
          </button>
          <button type="submit" disabled={save.isPending}>
            Save lines
          </button>
        </div>
        {problem && (
          <p role="alert" className="error">
            {problem}
          </p>
        )}
        <Refusal
          error={save.error}
          words={PREPARE_WORDS}
          noAnswer="No answer came back, so the lines may or may not have been saved. The settlement has been reloaded: check it before saving again."
        />
        {notice && (
          <p className="ok" role="status">
            {notice}
          </p>
        )}
      </form>
    </Section>
  );
}

/**
 * FR-054 upload (template SETTLEMENT_LINES_V1): checked as a whole, all or nothing; a check changes nothing. The file is
 * read at once and not stored, so it is not held for a malware scan.
 */
function LinesUpload({ s, exit, onReplaced }: { s: SettlementDetail; exit: ExitCase | undefined; onReplaced: (version: number) => void }) {
  const refresh = useSettlementRefresh();
  const [file, setFile] = useState<File | null>(null);
  // Remounting the file input clears the chosen file once its lines are applied.
  const [inputKey, setInputKey] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const upload = useMutation({
    mutationFn: async (input: { file: File; dryRun: boolean; version: number }) =>
      api<UploadResult>(`/v1/settlements/${enc(s.id)}/upload`, { body: { contentBase64: await fileToBase64(input.file), dryRun: input.dryRun, expectedVersion: input.version } }),
    onMutate: () => setResult(null),
    onSuccess: (r, input) => {
      setResult(r);
      if (r.applied) {
        setFile(null);
        setInputKey((n) => n + 1);
        // The lines were replaced at this version; the editor starts again from the server's lines once they load.
        onReplaced(input.version);
        refresh(s);
      }
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) refresh(s);
    },
  });
  const send = (dryRun: boolean) => {
    if (upload.isPending) return;
    const missing = !file
      ? 'Choose the CSV file to upload.'
      : file.size === 0
        ? 'The chosen file is empty.'
        : file.size > MAX_UPLOAD_BYTES
          ? `The file is larger than one upload takes (${MAX_UPLOAD_BYTES.toLocaleString('en-IN')} bytes).`
          : null;
    setProblem(missing);
    if (missing !== null || !file) {
      upload.reset();
      return;
    }
    upload.mutate({ file, dryRun, version: s.version });
  };
  const problems = result ? result.errors.filter((e) => e.code !== 'BATCH_REJECTED') : [];
  const ordered = result ? [...problems, ...result.errors.filter((e) => e.code === 'BATCH_REJECTED')] : [];
  return (
    <Section title="Upload the lines">
      <p className="hint">
        CSV with exactly the header <code>{UPLOAD_HEADER}</code> (template {UPLOAD_TEMPLATE}). Every row names this employee’s code ({s.employeeCode}) and the
        approved last working date{exit?.approvedLastWorkingDate ? ` (${formatDate(exit.approvedLastWorkingDate)})` : ' of the exit'}; one row per pay component; the
        line kind is STANDARD, NOTICE_ADJUSTMENT or blank. The file replaces every line of this draft, all or nothing. It is read at once and not kept.
      </p>
      {/* DF09 published template: GET /v1/settlements/lines/template, under the preparation grant the upload needs. */}
      <TemplateDownload base={SETTLEMENT_LINES} code={UPLOAD_TEMPLATE} />
      <div className="row">
        <label>
          Settlement lines file (CSV)
          <input
            key={inputKey}
            type="file"
            accept=".csv,text/csv"
            disabled={upload.isPending}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setResult(null);
            }}
          />
        </label>
      </div>
      <div className="row">
        <button type="button" className="secondary" disabled={upload.isPending} onClick={() => send(true)}>
          Check the file
        </button>
        <button type="button" disabled={upload.isPending} onClick={() => send(false)}>
          Upload and replace the lines
        </button>
      </div>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <Refusal
        error={upload.error}
        words={UPLOAD_WORDS}
        noAnswer="No answer came back, so the lines may or may not have been replaced. The settlement has been reloaded: check it before uploading again."
      />
      {result && (
        <div className="stack" role="status">
          {result.applied ? (
            <p className="ok">
              Uploaded: {result.accepted} of {result.total} rows replaced the lines of this draft.
            </p>
          ) : result.dryRun && result.rejected === 0 ? (
            <p className="ok">
              The file is valid: its {result.total} rows would replace the lines of this draft. Nothing was changed (check only).
            </p>
          ) : (
            <p className="error">
              The file was rejected, so nothing was changed: {problems.length} of {result.total} rows have a problem.
            </p>
          )}
          {ordered.length > 0 && (
            <div style={SCROLL}>
              <table aria-label="Upload problems">
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    <th scope="col">Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {ordered.slice(0, SHOWN_ROWS).map((e) => (
                    <tr key={e.row}>
                      <td>{e.row}</td>
                      <td>
                        {UPLOAD_ROW_WORDS[e.code] ?? readable(e.code)} <span className="hint">{e.code}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {ordered.length > SHOWN_ROWS && <p className="hint">Showing the first {SHOWN_ROWS} of {ordered.length} rows.</p>}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function SubmitDraft({ s, onNotice, unsavedLines }: { s: SettlementDetail; onNotice: (text: string) => void; unsavedLines: boolean }) {
  const refresh = useSettlementRefresh();
  const blockedId = `${useId()}-unsaved`;
  const submit = useMutation({
    mutationFn: (version: number) => api<SettlementDetail>(`/v1/settlements/${enc(s.id)}/submit`, { body: { expectedVersion: version } }),
    onSuccess: (saved) => {
      onNotice(`Revision ${saved.revision} submitted: it is frozen and waits for an independent review.`);
      refresh(saved);
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) refresh(s);
    },
  });
  return (
    <Section title="Submit for review">
      <p className="hint">
        Submitting freezes revision {s.revision}: its lines can no longer change. An independent reviewer and then an independent approver decide it; neither can be you.
      </p>
      {unsavedLines && (
        <p className="hint" id={blockedId}>
          Save the lines first: submitting freezes the saved lines, not changes still in the line editor.
        </p>
      )}
      <div className="row">
        <button type="button" disabled={submit.isPending || unsavedLines} aria-describedby={unsavedLines ? blockedId : undefined} onClick={() => submit.mutate(s.version)}>
          Submit revision {s.revision} for review
        </button>
      </div>
      <Refusal
        error={submit.error}
        words={SUBMIT_WORDS}
        noAnswer="No answer came back, so the revision may or may not have been submitted. It has been reloaded: check its state before trying again."
      />
    </Section>
  );
}

function CancelDraft({ s, onNotice }: { s: SettlementDetail; onNotice: (text: string) => void }) {
  const refresh = useSettlementRefresh();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: (body: { expectedVersion: number; reason: string }) => api<SettlementDetail>(`/v1/settlements/${enc(s.id)}/cancel`, { body }),
    onSuccess: (saved) => {
      setReason('');
      onNotice(`Revision ${saved.revision} cancelled. A new revision can be prepared from the exit’s settlements.`);
      refresh(saved);
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) refresh(s);
    },
  });
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (cancel.isPending) return;
    const text = reason.trim();
    setProblem(text ? null : 'Enter why the draft is cancelled.');
    if (!text) {
      cancel.reset();
      return;
    }
    cancel.mutate({ expectedVersion: s.version, reason: text });
  };
  return (
    <Section title="Cancel this draft">
      <form className="stack" aria-label="Cancel this draft" onSubmit={send}>
        <label>
          Reason for cancelling (required)
          <textarea rows={2} maxLength={MAX_REASON} value={reason} disabled={cancel.isPending} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
        </label>
        {problem && (
          <p role="alert" className="error">
            {problem}
          </p>
        )}
        <div className="row">
          <button type="submit" className="danger" disabled={cancel.isPending}>
            Cancel the draft
          </button>
        </div>
        <Refusal error={cancel.error} words={PREPARE_WORDS} />
      </form>
    </Section>
  );
}

/** FR-053/BR-016: eligibility for release only; it never makes, schedules or records a payment. */
function ReleaseEligibility({ s, onNotice }: { s: SettlementDetail; onNotice: (text: string) => void }) {
  const { me } = useSession();
  const refresh = useSettlementRefresh();
  const preparer = me?.userId === s.preparedBy;
  const release = useMutation({
    mutationFn: (version: number) => api<SettlementDetail>(`/v1/settlements/${enc(s.id)}/release-eligibility`, { body: { expectedVersion: version } }),
    onSuccess: (saved) => {
      onNotice(`Revision ${saved.revision} is now eligible for release. No payment has been made, scheduled or recorded.`);
      refresh(saved);
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) refresh(s);
    },
  });
  return (
    <Section title="Release eligibility">
      <p>
        Recording release eligibility states that this approved settlement may be released. It is not a payment: nothing is paid, scheduled or recorded as paid here.
      </p>
      <p className="hint">
        It is recorded by someone other than the preparer, the reviewer and the approver, once every required task of the exit clearance checklist is complete.
      </p>
      {preparer && <p className="hint">You prepared this settlement, so someone else records its release eligibility.</p>}
      <div className="row">
        <button type="button" disabled={release.isPending || preparer} onClick={() => release.mutate(s.version)}>
          Record release eligibility
        </button>
      </div>
      <Refusal
        error={release.error}
        words={RELEASE_WORDS}
        noAnswer="No answer came back, so release eligibility may or may not have been recorded. The settlement has been reloaded: check its state before trying again."
      />
    </Section>
  );
}

/** FR-054 outputs (CL-245, CL-246): this revision as CSV, Excel (XLSX) or PDF, with the same rows in each. */
function SettlementExport({ s }: { s: SettlementDetail }) {
  const [format, setFormat] = useState<ExportFormat>('CSV');
  const exp = useMutation({ mutationFn: (f: ExportFormat) => download(`/v1/settlements/${enc(s.id)}/export?format=${f}`) });
  return (
    <Section title="Export">
      <p className="hint">
        This approved revision’s lines and net amount with its context, as CSV, Excel (XLSX) or PDF, built when you download it. It is not stored and nothing is sent.
      </p>
      <div className="row">
        <label>
          Format
          <select value={format} disabled={exp.isPending} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
            {EXPORT_FORMATS.map(([f, label]) => (
              <option key={f} value={f}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={exp.isPending} onClick={() => exp.mutate(format)}>
          {`Download the ${formatLabel(format)} export`}
        </button>
      </div>
      <Refusal error={exp.error} words={EXPORT_WORDS} />
    </Section>
  );
}

/**
 * FR-054 bulk upload (CL-244): the lines of several drafts in one SETTLEMENT_LINES_V1 file, through the shared import
 * lifecycle: validate (a preview changes nothing), then apply or cancel; all or nothing; the file is scanned for
 * malware before any row is read; the user's own batches are listed below.
 */
function SettlementBulkUpload() {
  const t = BULK_UPLOAD;
  const refreshSettlements = useSettlementRefresh();
  const [file, setFile] = useState<File | null>(null);
  // Remounting the file input clears the chosen file once its preview is on screen.
  const [fileInput, setFileInput] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  // One idempotency key per chosen file: validating the same file again returns the same batch.
  const uploadKey = useRef<string | null>(null);
  const choose = (next: File | null) => {
    setFile(next);
    uploadKey.current = null;
  };
  const { resume, open, refresh } = useBatchFollowUp(t.base, {
    show: setJob,
    closed: (id) => setJob((shown) => (shown?.id === id ? null : shown)),
    onStart: () => {
      upload.reset();
      act.reset();
    },
  });
  const act = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'commit' | 'cancel' }) => {
      // The decision and any look at the batch after it go out under the role it was made in (BR-046).
      const send = pinSession();
      try {
        return await send<ImportJob>(`${t.base}/${enc(id)}/${action}`, { method: 'POST' });
      } catch (err) {
        // The batch may have moved on (this very decision went through but its answer was lost): its view says where it stands.
        const current = await send<ImportJob>(`${t.base}/${enc(id)}`).catch(() => null);
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
      // Applied lines change the drafts: every settlement list, queue and revision table loads again.
      if (view.state === 'COMMITTED') refreshSettlements();
    },
    onSettled: refresh,
  });
  const upload = useMutation({
    mutationFn: async (f: File) => {
      const key = (uploadKey.current ??= idempotencyKey('settlement-lines'));
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
      <Section title="Bulk upload of settlement lines">
        <form onSubmit={submit} className="stack" aria-label="Bulk upload of settlement lines">
          <p className="hint">
            CSV with exactly the header <code>{t.columns}</code> (template {t.code}), for as many draft settlements as you prepared. {t.note} Nothing changes until you
            apply a preview, and a file is applied all or nothing: one row with a problem rejects every settlement in it.
          </p>
          <TemplateDownload base={t.base} code={t.code} />
          <div className="inline">
            <label>
              Settlement lines file for several settlements (CSV)
              <input key={fileInput} type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => choose(e.target.files?.[0] ?? null)} />
            </label>
            <button type="submit" disabled={!file || busy}>
              Validate
            </button>
          </div>
        </form>
        {isForbidden(upload.error) ? <NotPermitted>The selected role cannot upload settlement lines.</NotPermitted> : <ErrorNote error={upload.error ?? resume.error} />}
      </Section>
      {job && (
        <>
          <ImportJobView job={job} template={t} pending={act.isPending} onAction={(action) => act.mutate({ id: job.id, action })} error={act.error} />
          <HeldBatchCheck job={job} busy={busy} onCheck={() => resume.mutate(job.id)} checked={resume.isPending ? undefined : resume.data} />
        </>
      )}
      <ImportBatches base={t.base} title="Your settlement lines batches" openedId={job?.id ?? null} busy={busy} onOpen={(id) => open.mutate(id)} error={open.error} />
    </>
  );
}

// =========================================================================================================
// Decision queues (FR-053; DF03; C4; ZT07): independent review, then independent approval
// =========================================================================================================
const QUEUES: Record<
  QueueKind,
  { title: string; decide: string; route: 'review' | 'approve'; keyPrefix: string; step: string; intro: string; empty: string; listLabel: string }
> = {
  settlement: {
    title: 'Settlement reviews',
    decide: SETTLEMENT_REVIEW,
    route: 'review',
    keyPrefix: 'settlement-review',
    step: 'Review',
    intro:
      'Submitted settlement revisions waiting for your independent review; a revision never reaches the person who prepared it. Returning or rejecting needs a reason; an approved review goes to an independent approver.',
    empty: 'No settlements are waiting for your review.',
    listLabel: 'Settlements waiting for your review',
  },
  settlement_approval: {
    title: 'Settlement approvals',
    decide: SETTLEMENT_APPROVE,
    route: 'approve',
    keyPrefix: 'settlement-approval',
    step: 'Approval',
    intro:
      'Reviewed settlement revisions waiting for your independent approval; an approver is never the preparer or the reviewer. Approval does not make the settlement eligible for release and makes no payment.',
    empty: 'No settlements are waiting for your approval.',
    listLabel: 'Settlements waiting for your approval',
  },
};

function SettlementReviewQueue() {
  return <SettlementQueue kind="settlement" />;
}

function SettlementApprovalQueue() {
  return <SettlementQueue kind="settlement_approval" />;
}

function SettlementQueue({ kind }: { kind: QueueKind }) {
  const { can } = useSession();
  const q = QUEUES[kind];
  if (!can(q.decide)) {
    return (
      <Section title={q.title}>
        <NotPermitted>The selected role cannot make this decision: it needs the confidential settlement {q.route === 'review' ? 'review' : 'approval'} grant.</NotPermitted>
      </Section>
    );
  }
  if (!can(SETTLEMENT_READ)) {
    return (
      <Section title={q.title}>
        <NotPermitted>The selected role cannot list settlement tasks: that needs the settlement read duty as well.</NotPermitted>
      </Section>
    );
  }
  return <SettlementQueueList kind={kind} />;
}

function SettlementQueueList({ kind }: { kind: QueueKind }) {
  const keys = useKeys();
  const q = QUEUES[kind];
  const region = useRef<HTMLDivElement>(null);
  // Both queues read the same list (one request): reviews are `settlement` tasks, approvals `settlement_approval` tasks.
  const tasks = useQuery({ queryKey: keys.tasks, queryFn: () => api<{ items: SettlementTask[] }>('/v1/settlements/tasks/mine'), retry: retryTransient });
  /** Tasks seen decided here leave the queue at once, before it has reloaded. */
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const items = (tasks.data?.items ?? []).filter((t) => t.kind === kind && !gone.has(t.taskId));
  const finished = (taskId: string, text: string, ok: boolean) => {
    setGone((prev) => new Set(prev).add(taskId));
    setNotice({ text, ok });
    // The item and its focused button go away; keep a keyboard user in the queue, unless they moved on.
    const active = document.activeElement;
    if (!active || active === document.body || region.current?.contains(active)) region.current?.focus();
  };
  return (
    <div ref={region} role="region" aria-label={q.title} tabIndex={-1}>
      <Section title={`${q.title}${tasks.data ? ` (${items.length})` : ''}`}>
        <p className="hint">{q.intro}</p>
        {tasks.isPending && <p className="hint">Loading the settlements waiting for you…</p>}
        <LoadProblem error={tasks.error} forbidden="The selected role cannot list settlement tasks." />
        {notice && (
          <p className={notice.ok ? 'ok' : 'error'} role={notice.ok ? 'status' : 'alert'}>
            {notice.text}
          </p>
        )}
        {tasks.data && items.length === 0 && <Empty>{q.empty}</Empty>}
        {items.length > 0 && (
          <ul className="tasks" aria-label={q.listLabel}>
            {items.map((t) => (
              <SettlementTaskItem key={t.taskId} task={t} kind={kind} onFinished={finished} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function decidedText(kind: QueueKind, result: SettlementDecided, s: SettlementDetail, who: string): string {
  const subject = `revision ${s.revision} of the settlement of ${who}`;
  const replay = result.replayed ? ' Your earlier attempt had already been recorded, so nothing was applied twice.' : '';
  if (result.state === 'REVIEWED') return `Reviewed ${subject}: it now waits for an independent approval.${replay}`;
  if (result.state === 'APPROVED') return `Approved ${subject}. It is not yet eligible for release, and no payment is made here.${replay}`;
  if (result.state === 'RETURNED') return `Returned ${subject} for correction: the preparer prepares a corrected revision.${replay}`;
  if (result.state === 'REJECTED') return `Rejected ${subject}.${replay}`;
  return `${kind === 'settlement' ? 'Review' : 'Approval'} recorded: ${subject} is now ${settlementLabel(result.state).toLowerCase()}.${replay}`;
}

function SettlementTaskItem({ task: t, kind, onFinished }: { task: SettlementTask; kind: QueueKind; onFinished: (taskId: string, text: string, ok: boolean) => void }) {
  const { can, me } = useSession();
  const refresh = useSettlementRefresh();
  const id = useId();
  const q = QUEUES[kind];
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const s = t.settlement;
  const who = s ? `${s.employeeName} (${s.employeeCode})` : 'an employee';
  /**
   * The decision last sent and its idempotency key (ZT07). Sending that same decision again (same choice, same reason)
   * after a failure, whose answer may have been lost on the way back, carries the same key: the server then answers from
   * what it recorded and never applies it twice. Any other decision is a new user action with a new key.
   */
  const attempt = useRef<{ decision: Decision; reason: string; key: string } | null>(null);
  const decide = useMutation({
    mutationFn: (body: DecisionBody) => api<SettlementDecided>(`/v1/settlements/tasks/${enc(t.taskId)}/${q.route}`, { body }),
    onSuccess: (result) => {
      attempt.current = null;
      if (s) onFinished(t.taskId, decidedText(kind, result, s, who), true);
      refresh(s);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      // The server took the key for another task's decision and recorded nothing: the next attempt gets a new key.
      if (error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.current = null;
      // Decided meanwhile, or no longer this user's or in scope: nothing is left to decide here.
      if (error.status === 404 || error.code === 'TASK_CLOSED' || error.code === 'INVALID_STATE') {
        onFinished(t.taskId, `Settlement of ${who}: ${refusalText(error, DECISION_WORDS) ?? error.message}`, false);
        refresh(s);
      } else if (isConflict(error)) refresh(s);
    },
  });
  const titleId = `${id}-title`;
  const blockedId = `${id}-blocked`;
  if (!s) {
    return (
      <li aria-labelledby={titleId}>
        <h3 id={titleId} style={H3}>
          A settlement outside the selected role’s scope
        </h3>
        <p className="hint">This task’s settlement is not in the selected role’s scope, so it cannot be decided here.</p>
      </li>
    );
  }
  // C4: never about one's own record, never by the preparer (the server refuses both as well).
  const blocked =
    !!me?.employeeId && me.employeeId === s.employeeId
      ? 'This settlement is about your own record, so someone else decides it.'
      : me?.userId === s.preparedBy
        ? 'You prepared this settlement, so someone else decides it.'
        : null;
  const send = (decision: Decision) => {
    if (blocked !== null || decide.isPending) return;
    const text = reason.trim();
    if (decision !== 'APPROVE' && !text) {
      setProblem(decision === 'RETURN' ? 'Enter a reason to return the settlement for correction.' : 'Enter a reason to reject the settlement.');
      decide.reset();
      return;
    }
    setProblem(null);
    const last = attempt.current;
    const key = last !== null && last.decision === decision && last.reason === text ? last.key : idempotencyKey(q.keyPrefix);
    attempt.current = { decision, reason: text, key };
    decide.mutate({ decision, ...(text ? { reason: text } : {}), idempotencyKey: key });
  };
  const describedBy = blocked === null ? titleId : `${titleId} ${blockedId}`;
  return (
    <li aria-labelledby={titleId}>
      <h3 id={titleId} style={H3}>
        {q.step}: settlement of {who}, revision {s.revision}
      </h3>
      <DelegatedBadge taskId={t.taskId} />
      <dl className="kv">
        <Item term="State">
          <SettlementState state={s.state} />
        </Item>
        <Item term="Currency">{s.currencyCode}</Item>
        {s.netAmount !== undefined && (
          <Item term="Net amount">
            <Money value={s.netAmount} currency={s.currencyCode} />
          </Item>
        )}
        <Item term="Calculation">{labelOf(CALCULATION_LABEL, s.calculationStatus)}</Item>
        <Item term="Prepared by">
          <UserRef userId={s.preparedBy} />
        </Item>
        <Item term="Submitted">{when(s.submittedAt)}</Item>
        {kind === 'settlement_approval' && <Item term="Reviewed">{when(s.reviewedAt)}</Item>}
      </dl>
      {s.lines && s.lines.length > 0 && <LineTable lines={s.lines} currency={s.currencyCode} />}
      {can(SETTLEMENT_READ) && (
        <div>
          <Link to={PATHS.settlement(s.id)}>Open the settlement of {who}</Link>
        </div>
      )}
      {blocked === null ? (
        <label>
          Reason (required to return or reject)
          <textarea maxLength={MAX_REASON} rows={2} value={reason} disabled={decide.isPending} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
        </label>
      ) : (
        <p className="hint" id={blockedId}>
          {blocked}
        </p>
      )}
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <div className="row">
        <button type="button" disabled={blocked !== null || decide.isPending} aria-describedby={describedBy} onClick={() => send('APPROVE')}>
          {kind === 'settlement' ? 'Approve the review' : 'Approve'}
        </button>
        <button type="button" className="secondary" disabled={blocked !== null || decide.isPending} aria-describedby={describedBy} onClick={() => send('RETURN')}>
          Return for correction
        </button>
        <button type="button" className="danger" disabled={blocked !== null || decide.isPending} aria-describedby={describedBy} onClick={() => send('REJECT')}>
          Reject
        </button>
      </div>
      <Refusal
        error={decide.error}
        words={DECISION_WORDS}
        noAnswer="No answer came back, so your decision may or may not have been recorded. Send the same decision again: it is never applied twice."
      />
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Exports for the navigation step (App.tsx wires them): screens, decision queues. No H3 My ESS tab is served.
// ---------------------------------------------------------------------------------------------------------

/** The module's letter and settlement screens; detail screens are reached through links (`nav: false`). */
export const LIFECYCLE_DOCUMENTS_SCREENS: ScreenRoute[] = [
  { path: PATHS.templates, title: 'Letter templates', permission: TEMPLATE_READ, nav: true, component: LetterTemplatesScreen },
  { path: '/lifecycle/letter-templates/:id', title: 'Letter template', permission: TEMPLATE_READ, nav: false, component: LetterTemplateScreen },
  { path: PATHS.letters, title: 'Letters', permission: LETTER_READ, nav: true, component: LettersScreen },
  { path: '/lifecycle/employees/:id/letters', title: 'Employee letters', permission: LETTER_READ, nav: false, component: EmployeeLettersScreen },
  { path: '/lifecycle/processes/:id/letters', title: 'Process letters', permission: LETTER_GENERATE, nav: false, component: ProcessLettersScreen },
  { path: PATHS.settlements, title: 'Full and final settlements', permission: SETTLEMENT_READ, nav: true, component: SettlementsScreen },
  { path: '/lifecycle/exits/:id/settlements', title: 'Exit settlements', permission: SETTLEMENT_READ, nav: false, component: ExitSettlementsScreen },
  { path: '/lifecycle/settlements/:id', title: 'Settlement', permission: SETTLEMENT_READ, nav: false, component: SettlementScreen },
];

/**
 * No H3 My ESS tab (TN01 to TN18) covers letters or settlements, and the lifecycle registration declares no ESS tabs:
 * the API refuses one's own letters, notes and settlement (SELF_ACTION_NOT_ALLOWED), so nothing is offered in the hub.
 */
export const LIFECYCLE_DOCUMENTS_ESS_PANELS: EssPanel[] = [];

/** The settlement decision queues (FR-053), also shown on the settlements screen. */
export const LIFECYCLE_DOCUMENTS_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [
  { permission: SETTLEMENT_REVIEW, title: 'Settlement reviews', component: SettlementReviewQueue },
  { permission: SETTLEMENT_APPROVE, title: 'Settlement approvals', component: SettlementApprovalQueue },
];
