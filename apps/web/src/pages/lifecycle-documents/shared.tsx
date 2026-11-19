// Shared by the letter and settlement screens: permission keys, paths and limits, labels, query keys, styles and small pieces.
import { useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, type ReactNode, useMemo } from 'react';
import { ApiError, formatAmount, formatDate, isForbidden, isNotFound, readable } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, NotPermitted, pageParams } from '../../ui';
import type { Calculation } from './types';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (modules/lifecycle/registration.ts; migrations 0038_lifecycle.sql and 0039_settlement.sql; the
// requireAccess calls of letter-routes.ts, settlement-routes.ts, process-routes.ts and exit-routes.ts) and paths
// ---------------------------------------------------------------------------------------------------------
export const TEMPLATE_READ = 'letter_template.read.operational';
export const TEMPLATE_MANAGE = 'letter_template.manage.operational';
/** Previews and final letters (confidential letter group, approved per assignment). */
export const LETTER_GENERATE = 'letter.generate.letter';
/** Stored letters and their content. */
export const LETTER_READ = 'letter.read.letter';
export const NOTE_READ = 'employee_note.read.restricted';
/** GET /v1/employee-processes/:id and GET /v1/employees/:id/processes. */
export const PROCESS_READ = 'employee_process.read.operational';
/** GET /v1/employees: the employee search. */
export const EMPLOYEE_LIST = 'employee.list.operational';
/** GET /v1/employees/:id: the employee's name above their letters. */
export const EMPLOYEE_READ = 'employee.read.operational';
/** GET /v1/exit-cases and GET /v1/exit-cases/:id: the exit a settlement belongs to. */
export const EXIT_READ = 'exit.read.operational';
export const SETTLEMENT_READ = 'settlement.read.operational';
/** FR-002 / migration 0119: exporting is its own right; reading a settlement's amounts does not allow it. */
export const SETTLEMENT_EXPORT = 'settlement.export.amount';
export const SETTLEMENT_PREPARE = 'settlement.prepare.amount';
export const SETTLEMENT_REVIEW = 'settlement.review.amount';
export const SETTLEMENT_APPROVE = 'settlement.approve.amount';
export const SETTLEMENT_RELEASE = 'settlement.release.amount';
// I-81 (0185): recording a payment from evidence, and sending in-app, are rights of their own; letters are sent in-app too.
export const SETTLEMENT_RECORD_PAYMENT = 'settlement.record_payment.amount';
export const SETTLEMENT_SEND = 'settlement.send.amount';
export const LETTER_SEND = 'letter.send.letter';
// I-88 (0235): waiving an exit's notice recovery is its own confidential right; the settlement policy and the statutory rule packs
// are read on the settlement settings screen (settlement-settings.tsx), linked from the calculation.
export const SETTLEMENT_WAIVE_NOTICE = 'settlement.waive_notice.amount';
export const POLICY_READ = 'payroll_config.read.operational';
export const STATUTORY_READ = 'statutory_pack.read.operational';

export const PATHS = {
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
  // The settlement policy and statutory rule packs (settlement-settings.tsx).
  settlementSettings: '/lifecycle/settlement-settings',
} as const;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Template codes (letter-routes.ts and process-routes.ts `code`). */
export const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;
/** Letter type codes (POST /v1/letter-templates `letterType`). */
export const LETTER_TYPE_CODE = /^[A-Z][A-Z0-9_]{0,59}$/;
/** The letter type of offer letters (lifecycle/letters.ts OFFER_LETTER_TYPE): issued from the approved offer in Hiring. */
export const OFFER_LETTER_TYPE = 'OFFER';
/** A placeholder as letters.ts reads it. */
const TOKEN = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;
/** The amount format settlement.ts accepts; only the format is checked here, never the value. */
export const AMOUNT = /^-?\d{1,15}(\.\d{1,4})?$/;
export const CURRENCY = /^[A-Z]{3}$/;
export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const MAX_BODY = 20000;
export const MAX_NAME = 200;
export const MAX_REASON = 1000;
/** An entered line's reason (settlement.ts replaceLines). */
export const MAX_LINE_REASON = 500;
export const MAX_OPTIONAL = 50;
export const MAX_LINES = 500;
export const MAX_COMPONENT_CODE = 40;
export const MAX_AMOUNT_TEXT = 24;
export const MAX_EMPLOYEE_CODE = 60;
/** The upload route takes at most 1,000,000 base64 characters, which is 750,000 bytes of file. */
export const MAX_UPLOAD_BYTES = 750_000;
export const EMPLOYEE_PAGE_SIZE = 25;
/**
 * FR-056: the letter, process, note, settlement and exit lists are read a page at a time (page/pageSize); every
 * answer carries the total of every match in scope, so nothing beyond a fixed limit is silently left out.
 */
export interface Paged<T> {
  items: T[];
  total?: number;
}
/** The total of a paged answer (an older answer without one counts its items). */
export const totalOf = (p: Paged<unknown>) => p.total ?? p.items.length;
export const pagedUrl = (path: string, page: number, query?: string) => `${path}?${query ? `${query}&` : ''}${pageParams(page)}`;
/** Upload rows shown in the problem table; a 10,000-row file is summarised. */
export const SHOWN_ROWS = 200;
export const UPLOAD_TEMPLATE = 'SETTLEMENT_LINES_V1';
export const UPLOAD_HEADER = 'employee_code,last_working_date,component_code,amount,line_kind';
/** The settlement lines template is served at `${SETTLEMENT_LINES}/template` (records.tsx TemplateDownload). */
export const SETTLEMENT_LINES = '/v1/settlements/lines';
/** FR-054 bulk upload: the same template for many drafts, through the shared import lifecycle (settlement-import.ts). */
export const SETTLEMENT_IMPORTS = '/v1/settlements/line-imports';
/** FR-054 outputs (settlement-routes.ts): one revision's file, or a ZIP of the files of the settlements selected. */
export type ExportFormat = 'CSV' | 'XLSX' | 'PDF';
export const EXPORT_FORMATS: readonly (readonly [format: ExportFormat, label: string])[] = [
  ['CSV', 'CSV'],
  ['XLSX', 'Excel (XLSX)'],
  ['PDF', 'PDF'],
];
export const formatLabel = (format: ExportFormat) => EXPORT_FORMATS.find(([f]) => f === format)?.[1] ?? format;
/** The states an output is built for (settlement.ts exportable). */
export const EXPORTABLE_STATES: ReadonlySet<string> = new Set(['APPROVED', 'RELEASE_ELIGIBLE', 'PAID']);
/** The most settlements one ZIP holds (settlement.ts MAX_ARCHIVE_SETTLEMENTS, a technical bound). */
export const MAX_ARCHIVE = 100;

/** The LETTER_TYPE values the module seeds (FR-017 target examples); a company may add others. */
export const LETTER_TYPES: readonly (readonly [code: string, label: string])[] = [
  ['OFFER', 'Offer letter'],
  ['APPOINTMENT', 'Appointment letter'],
  ['CONFIRMATION', 'Confirmation letter'],
  ['TRANSFER', 'Transfer letter'],
  ['WARNING', 'Warning letter'],
  ['RELIEVING', 'Relieving letter'],
  ['EXPERIENCE', 'Experience letter'],
];


// ---------------------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------------------
export const REVISION_STATE_LABEL: Record<string, string> = { DRAFT: 'Draft', PUBLISHED: 'Published', RETIRED: 'Retired' };
export const SOURCE_LABEL: Record<string, string> = { EMPLOYEE: 'Employee record', COMPANY: 'Company', EXIT: 'Approved exit', LETTER: 'The letter', OFFER: 'Approved offer (Hiring)' };
export const NOTE_KIND_LABEL: Record<string, string> = {
  NOTE: 'Note',
  REMARK: 'Remark',
  WARNING: 'Warning',
  // The register's types (CL-040, 0260).
  APPRECIATION: 'Appreciation',
  EXIT_NOTE: 'Exit note',
  OFFER_REJECTION: 'Offer rejection',
  PIP: 'Performance improvement plan (PIP)',
};
export const DELIVERY_LABEL: Record<string, string> = { NOT_SENT: 'Not sent', DELIVERED_IN_APP: 'Delivered to the employee’s self-service' };
export const DELIVERY_STATUS_LABEL: Record<string, string> = { DELIVERED: 'Delivered, not yet opened', READ: 'Opened by the employee' };

export const SETTLEMENT_STATES = ['DRAFT', 'SUBMITTED', 'REVIEWED', 'APPROVED', 'RELEASE_ELIGIBLE', 'PAID', 'RETURNED', 'REJECTED', 'CANCELLED'] as const;
/** BR-016: states as the server records them; release eligibility is worded so it never reads as a payment. */
const SETTLEMENT_STATE_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Waiting for review',
  REVIEWED: 'Reviewed, waiting for approval',
  APPROVED: 'Approved, not yet eligible for release',
  RELEASE_ELIGIBLE: 'Eligible for release (not a payment)',
  PAID: 'Paid (recorded from evidence)',
  RETURNED: 'Returned for correction',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};
const SETTLEMENT_TONE: Record<string, 'good' | 'warn' | 'bad'> = {
  SUBMITTED: 'warn',
  REVIEWED: 'warn',
  APPROVED: 'good',
  RELEASE_ELIGIBLE: 'good',
  PAID: 'good',
  RETURNED: 'warn',
  REJECTED: 'bad',
};
/** A live revision blocks a new one (settlement.ts createSettlement). */
export const LIVE_STATES: ReadonlySet<string> = new Set(['DRAFT', 'SUBMITTED', 'REVIEWED', 'APPROVED', 'RELEASE_ELIGIBLE']);
/** I-81 items 5, 6: a live revision past its draft that is not paid can be voided by an independent approver. */
export const VOIDABLE_STATES: ReadonlySet<string> = new Set(['SUBMITTED', 'REVIEWED', 'APPROVED', 'RELEASE_ELIGIBLE']);
/** Revisions an export or an in-app statement may carry (settlement.ts EXPORTABLE_STATES). */
export const OUTPUT_STATES: ReadonlySet<string> = EXPORTABLE_STATES;
export const STATE_EXPLANATION: Record<string, string> = {
  DRAFT: 'Being prepared: the preparer calculates it, or enters or uploads the lines, then submits the revision for an independent review.',
  SUBMITTED: 'Submitted and frozen: its lines can no longer change. It waits for an independent review.',
  REVIEWED: 'Reviewed: it waits for an independent approval by someone who neither prepared nor reviewed it.',
  APPROVED:
    'Approved. It is not yet eligible for release: that is a separate step, recorded by someone independent once the exit clearance is complete. No payment is made here.',
  RELEASE_ELIGIBLE:
    'Eligible for release. This is not a payment. The payment is made outside this system and then recorded here from its evidence by someone independent.',
  PAID: 'Paid: the payment made outside this system was recorded from its evidence. It is final; nothing more is prepared for this exit.',
  RETURNED: 'Returned for correction. A corrected revision is prepared from the exit’s settlements and starts from this revision’s lines.',
  REJECTED: 'Rejected. A new revision can be prepared from the exit’s settlements.',
  CANCELLED: 'Cancelled (its lines and decisions are kept). A new revision can be prepared from the exit’s settlements while the exit stands.',
};
export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  NOT_PAID: 'Not paid: no payment has been recorded (release eligibility is not a payment)',
  PAID: 'Paid: recorded from evidence',
  NOT_TRACKED: 'Not tracked here: release eligibility is not a payment',
};
/** One revision's calculation status (settlement.calculation_status). */
export const CALCULATION_LABEL: Record<string, string> = { NOT_CONFIGURED: 'Not calculated (lines entered or uploaded)', CALCULATED: 'Calculated from a snapshot' };
/** What GET /v1/settlements/calculation reports for every draft (not one revision's status). */
const CALCULATION_AVAILABILITY_LABEL: Record<string, string> = { NOT_CONFIGURED: 'Not configured', AVAILABLE: 'Available' };
export const COMPONENT_KIND_LABEL: Record<string, string> = { EARNING: 'Earning', DEDUCTION: 'Deduction' };
export const LINE_KIND_LABEL: Record<string, string> = { STANDARD: 'Standard', NOTICE_ADJUSTMENT: 'Notice adjustment' };
export const LINE_SOURCE_LABEL: Record<string, string> = { ENTERED: 'Entered', UPLOADED: 'Uploaded', COPIED: 'Copied from the previous revision', CALCULATED: 'Calculated' };
/** I-88 calculation items (settlement-calculation.ts), in plain words. */
export const ITEM_KIND_LABEL: Record<string, string> = {
  EARNINGS_DUE: 'Earnings due',
  LEAVE_ENCASHMENT: 'Leave encashment',
  NOTICE_RECOVERY: 'Notice recovery',
  LOAN_RECOVERY: 'Loan or advance recovery',
  ARREARS: 'Arrears',
  ADJUSTMENT: 'Timesheet adjustment',
  GRATUITY: 'Gratuity',
  STATUTORY_DEDUCTION: 'Tax and statutory deductions',
};
/** Item statuses: the first six never block; every other one blocks the final approval until it is put right. */
export const ITEM_STATUS_LABEL: Record<string, string> = {
  CALCULATED: 'Calculated',
  ALREADY_PAID: 'Already paid by monthly payroll',
  NOT_APPLICABLE: 'Not applicable',
  NOT_ELIGIBLE: 'Not eligible',
  WAIVED: 'Waived',
  NOT_INCLUDED: 'Not included (enter it if due)',
  RULE_PACK_NOT_CONFIGURED: 'Rule pack not configured',
  POLICY_NOT_CONFIGURED: 'Settlement policy not configured',
  VALUATION_POLICY_NOT_CONFIGURED: 'Arrears valuation policy not configured',
  RECOVERY_POLICY_NOT_CONFIGURED: 'The valuation policy names no component to pay or recover it on',
  NOTICE_PERIOD_NOT_RECORDED: 'Notice period not recorded',
  NO_SALARY_ARRANGEMENT: 'No salary arrangement in force',
  ARRANGEMENT_GAP: 'The salary arrangements leave days of the period uncovered',
  CURRENCY_MISMATCH: 'In another currency than the settlement',
  HEAD_NOT_CONFIGURED: 'Pay head not configured',
  COMPONENT_BASIS_NOT_MONTHLY: 'The salary component is not a monthly amount',
  COMPONENT_HEAD_NOT_FIXED: 'The pay head is not a fixed amount',
  RATE_BASIS_MISSING: 'The salary lacks the components of the rate basis',
  LEAVE_DECISIONS_PENDING: 'Leave requests wait for a decision',
  LOAN_SETTLEMENT_PENDING: 'An early settlement of the loan waits for a decision',
};
/** The daily-rate bases of the settlement policy (settlement-policy.ts RATE_BASES); shared with the settings screen. */
export const RATE_BASIS_LABEL: Record<string, string> = { BASIC: 'Basic', BASIC_DA: 'Basic + DA', GROSS: 'Monthly gross (every fixed earning)' };
/** Statutory rule pack revision states (statutory/rule-packs.ts); shared with the settings screen. */
export const PACK_STATE_LABEL: Record<string, string> = {
  DRAFT: 'Inactive draft',
  VALIDATED: 'Validated, waiting for activation by another person',
  ACTIVE: 'Active',
  RETIRED: 'Retired',
};
export const LOAN_KIND_LABEL: Record<string, string> = { LOAN: 'Loan', ADVANCE: 'Salary advance' };
export const DECISION_LABEL: Record<string, string> = { APPROVE: 'Approved', RETURN: 'Returned for correction', REJECT: 'Rejected' };
export const STEP_LABEL: Record<string, string> = { review: 'Review', approve: 'Approval' };
export const EXIT_STATE_LABEL: Record<string, string> = { APPROVED: 'Approved', SEPARATED: 'Separated' };

/** Upload row problems (settlement.ts uploadLines), in plain words. */
export const UPLOAD_ROW_WORDS: Record<string, string> = {
  WRONG_CELL_COUNT: 'The row does not have exactly one cell for each of the five columns.',
  EMPLOYEE_MISMATCH: 'The employee code is not this settlement’s employee.',
  DATE_MISMATCH: 'The last working date is not the approved last working date of this exit.',
  UNKNOWN_COMPONENT: 'No active pay component has this code.',
  INVALID_AMOUNT: 'The amount is not a decimal number with up to 15 digits and 4 decimal places.',
  SIGN_MISMATCH: 'The sign does not match the pay component: an earning is zero or positive, a deduction zero or negative.',
  INVALID_LINE_KIND: 'The line kind must be STANDARD, NOTICE_ADJUSTMENT or blank.',
  NOTICE_PERIOD_NOT_RECORDED: 'A notice adjustment needs the contractual notice period recorded on the exit first.',
  DUPLICATE_COMPONENT: 'This pay component is already on an earlier row; each component appears once.',
  ALREADY_PAID_IN_PAYROLL: 'The final period’s approved or processed monthly payroll already pays this component; it is not paid again in the settlement.',
  BATCH_REJECTED: 'Valid, but not applied: a file is applied all or nothing.',
};

export const labelOf = (map: Record<string, string>, code: string) => map[code] ?? readable(code);
export const letterTypeLabel = (code: string) => LETTER_TYPES.find(([c]) => c === code)?.[1] ?? readable(code);
export const settlementLabel = (state: string) => labelOf(SETTLEMENT_STATE_LABEL, state);
export const enc = encodeURIComponent;
const pad = (n: number) => String(n).padStart(2, '0');

/** An instant shown as the viewer's local day (formatDate) and local time; anything else exactly as formatDate shows it. */
export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) || Number.isNaN(d.getTime())) return formatDate(iso);
  return `${formatDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The approved placeholders a letter text uses, sorted (the server reads the text the same way and checks it). */
export function usedPlaceholders(body: string): string[] {
  return [...new Set([...body.matchAll(TOKEN)].map((m) => m[1]!))].sort();
}

export const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

export const isSelf = (error: unknown) => error instanceof ApiError && error.code === 'SELF_ACTION_NOT_ALLOWED';


// ---------------------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------------------
export const SCROLL: CSSProperties = { overflowX: 'auto' };
export const H3: CSSProperties = { fontSize: '1rem', margin: '0.5rem 0 0' };
export const TEXTAREA: CSSProperties = { font: 'inherit', padding: '0.4rem 0.5rem', border: '1px solid var(--line)', borderRadius: 6, color: 'var(--text)', resize: 'vertical' };
export const LETTER: CSSProperties = { whiteSpace: 'pre-wrap', fontFamily: 'inherit', border: '1px solid var(--line)', borderRadius: 6, padding: '0.75rem', margin: '0.5rem 0', background: 'var(--surface)' };
export const GROUP: CSSProperties = { border: '1px solid var(--line)', borderRadius: 6, padding: '0.5rem 0.75rem', margin: 0, minWidth: 0 };
export const SR_ONLY: CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 };

/**
 * Query keys carry the selected company and assignment: the app keeps one query cache across role switches, and an
 * answer given to one assignment (a scoped list, a letter, settlement amounts) must never be shown under another, not
 * even from the cache while the new answer loads.
 */
export function useKeys() {
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
      calculations: (id: string) => k('settlement-calculations', id),
    };
  }, [context]);
}

/** After a settlement changes: every list, queue and revision table that shows it loads again (never patched here). */
export function useSettlementRefresh() {
  const qc = useQueryClient();
  const keys = useKeys();
  return (s?: { id: string } | null) => {
    void qc.invalidateQueries({ queryKey: keys.settlementLists });
    void qc.invalidateQueries({ queryKey: keys.tasks });
    void qc.invalidateQueries({ queryKey: keys.allExitSettlements });
    if (s) {
      void qc.invalidateQueries({ queryKey: keys.settlement(s.id) });
      void qc.invalidateQueries({ queryKey: keys.calculations(s.id) });
    }
  };
}

/** One term of a details list; a wide one (a paragraph of text) takes the whole row instead of a narrow column. */
export function Item({ term, children, wide = false }: { term: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'kv-wide' : undefined}>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A list or record that did not load: a refusal of the role, one's own record, a record outside the scope, or the API's error. */
export function LoadProblem({ error, forbidden, missing }: { error: unknown; forbidden: string; missing?: string }) {
  if (!error) return null;
  if (isSelf(error)) return <Empty>This concerns your own record, which is not available to you in this role.</Empty>;
  if (isForbidden(error)) return <NotPermitted>{forbidden}</NotPermitted>;
  if (missing !== undefined && isNotFound(error)) return <Empty>{missing}</Empty>;
  return <ErrorNote error={error} />;
}

/** A user the API named: the signed-in user as "you", anyone else by the id the API returned. */
export function UserRef({ userId }: { userId: string }) {
  const { me } = useSession();
  // No name is served for another account here, and a raw identifier means nothing on screen: the words say who, the tooltip
  // keeps the identifier for matching against the audit trail.
  return me?.userId === userId ? <>you</> : <span title={`User ${userId}`}>another user</span>;
}

/**
 * A decimal string the server returned, in its currency. Shown, never computed: where the 2-decimal display would hide
 * digits of the recorded value (amounts carry up to 4 decimals), the exact value follows.
 */
export function Money({ value, currency }: { value: string | null | undefined; currency: string }) {
  if (value === null || value === undefined) return <>—</>;
  const finer = /\.\d{2}\d*[1-9]/.test(value);
  return (
    <>
      {formatAmount(value, currency)}
      {finer && <span className="hint"> (exactly {value})</span>}
    </>
  );
}

export function SettlementState({ state }: { state: string }) {
  return <Badge tone={SETTLEMENT_TONE[state] ?? 'neutral'}>{settlementLabel(state)}</Badge>;
}

/**
 * FR-052: how drafts are calculated, as the server reports it, and its reason; nothing is ever calculated here. Since I-88 a draft
 * is calculated on the server (AVAILABLE: the reason is a hint); a server that answers otherwise is flagged in words and colour.
 */
export function CalculationNote({ calculation }: { calculation: Calculation | undefined }) {
  if (!calculation) return null;
  if (calculation.status === 'AVAILABLE') return <p className="hint">{calculation.reason}</p>;
  return (
    <p role="note">
      <Badge tone="warn">calculation {labelOf(CALCULATION_AVAILABILITY_LABEL, calculation.status).toLowerCase()}</Badge> {calculation.reason}
    </p>
  );
}

