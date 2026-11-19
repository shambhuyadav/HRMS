// The lifecycle API's refusals in plain words.
import { ApiError } from '../../api';
import { ErrorNote } from '../../ui';
import type { ImportTemplate } from '../records';
import { ITEM_KIND_LABEL, ITEM_STATUS_LABEL, labelOf, MAX_ARCHIVE, MAX_LINE_REASON, MAX_REASON, SETTLEMENT_IMPORTS, SETTLEMENT_PREPARE, UPLOAD_HEADER, UPLOAD_ROW_WORDS, UPLOAD_TEMPLATE } from './shared';
import type { Blocker } from './types';

// ---------------------------------------------------------------------------------------------------------
// The API's refusals in plain words
// ---------------------------------------------------------------------------------------------------------
export type Words = Record<string, string | ((error: ApiError) => string)>;

/** A list in an error's details (placeholders, missing values, open clearance tasks). */
export function listOf(error: ApiError, key: string): string[] {
  const value = (error.details as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
export const braces = (keys: readonly string[]) => keys.map((k) => `{{${k}}}`).join(', ');
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

export const TEMPLATE_WORDS: Words = {
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

export const DOWNLOAD_WORDS: Words = {
  NOT_FOUND: 'This letter is not available in the selected role’s scope.',
  FORBIDDEN: 'The selected role cannot open stored letters: that needs the confidential letter grant.',
  SELF_ACTION_NOT_ALLOWED: 'This letter concerns your own record, which you cannot open in this role.',
};

export const CREATE_WORDS: Words = {
  EXIT_NOT_APPROVED: 'A settlement is prepared only for an approved exit, and this exit is not approved.',
  SETTLEMENT_EXISTS: 'This exit already has a live settlement revision (a draft, or one under review, approved or eligible for release). Work on that revision instead.',
  CURRENCY_REQUIRED: 'Enter the settlement currency as a three-letter ISO 4217 code, for example INR.',
  INVALID_REQUEST: 'Enter the currency as three capital letters, for example INR.',
  FORBIDDEN: 'The selected role cannot prepare settlements: that needs the confidential settlement preparation grant.',
  NOT_FOUND: 'This exit is not available in the selected role’s scope.',
  SELF_ACTION_NOT_ALLOWED: 'This is your own exit: you cannot prepare your own settlement.',
};

export const PREPARE_WORDS: Words = {
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

/** The line editor's refusals: the preparation ones, and (I-88) the rules of entered lines on a calculated draft. */
export const LINES_WORDS: Words = {
  ...PREPARE_WORDS,
  COMPONENT_CALCULATED: (e) => atLine(e, 'the calculation already produces this pay component, so it is not entered as well.'),
  REASON_REQUIRED: (e) => atLine(e, 'this draft is calculated, so each entered line states why it is entered.'),
  REASON_TOO_LONG: (e) => atLine(e, `a line’s reason has at most ${MAX_LINE_REASON} characters.`),
};

/** FR-052 (I-88): calculating a draft. */
export const CALCULATE_WORDS: Words = {
  ...PREPARE_WORDS,
  NOT_PREPARER: 'Only the HR Administrator who prepared this revision can calculate it.',
  INVALID_STATE: 'Only a draft is calculated, and this revision has been submitted or closed meanwhile. It has been reloaded.',
  EXIT_NOT_APPROVED: 'The exit is no longer approved, so the settlement is not calculated.',
  CURRENCY_UNKNOWN: 'The settlement currency is not an approved currency code, so its rounding is unknown and nothing was calculated. Prepare a revision in an approved currency.',
  MANUAL_LINE_CONFLICT: (e) => `An entered line uses a component the calculation produces: ${listOf(e, 'components').join(', ')}. Remove it and calculate again.`,
  FORBIDDEN: 'The selected role cannot calculate settlements: that needs the confidential settlement preparation grant.',
};

/** F1 notice (I-88): waiving an exit's notice recovery. */
export const WAIVER_WORDS: Words = {
  NOT_INDEPENDENT: 'The preparer of this settlement cannot waive its notice recovery: someone else waives it.',
  ALREADY_WAIVED: 'The notice recovery of this exit is already waived. The settlement has been reloaded.',
  SETTLEMENT_PAID: 'This exit’s settlement has been paid, so nothing more is waived for it.',
  EXIT_NOT_APPROVED: 'A notice recovery is waived only for an approved exit, and this exit is no longer approved.',
  REASON_REQUIRED: `Record why the notice recovery is waived (at most ${MAX_REASON.toLocaleString('en-IN')} characters).`,
  FORBIDDEN: 'The selected role cannot waive a notice recovery: that needs its own confidential grant.',
  NOT_FOUND: 'This exit is not available in the selected role’s scope.',
};

/**
 * I-88: what a calculation took must still stand at submission, release eligibility and payment (settlement-gates.ts
 * assertCalculationStillHolds); otherwise a corrected revision is calculated again.
 */
const CALCULATION_HOLDS_WORDS: Words = {
  ARREARS_TAKEN_BY_PAYROLL: (e) => {
    const n = listOf(e, 'cases').length;
    return `Monthly payroll has meanwhile paid or taken ${n === 1 ? 'an arrear or timesheet adjustment' : n > 1 ? `${n} arrears or timesheet adjustments` : 'arrears or timesheet adjustments'} this calculation includes, so it would be paid twice. Prepare a corrected revision: calculating it again leaves them out.`;
  },
  LOAN_BALANCE_CHANGED: (e) => {
    const n = listOf(e, 'loans').length;
    return `${n > 1 ? `${n} loans or advances` : 'A loan or advance'} this calculation recovers now ${n > 1 ? 'owe' : 'owes'} less than it recovers. Prepare a corrected revision: calculating it again takes the current balance.`;
  },
};

export const UPLOAD_WORDS: Words = {
  ...PREPARE_WORDS,
  CALCULATED_REVISION: 'This draft is calculated, so its lines are not uploaded: enter the lines for components the calculation does not produce one by one, each with its reason.',
  INVALID_FILE: 'The file is not valid CSV.',
  INVALID_TEMPLATE: `The file must start with exactly the header ${UPLOAD_HEADER} (template ${UPLOAD_TEMPLATE}).`,
  EMPTY_FILE: 'The file has a header but no lines.',
  TOO_MANY_ROWS: 'A file has at most 10,000 rows.',
  INVALID_REQUEST: 'The file is empty or too large for one upload.',
  PAYLOAD_TOO_LARGE: 'The file is too large for one upload.',
};

export const SUBMIT_WORDS: Words = {
  ...PREPARE_WORDS,
  ...CALCULATION_HOLDS_WORDS,
  NO_LINES: 'Calculate the draft, or enter or upload its lines, before submitting.',
  EXIT_NOT_APPROVED: 'The exit is no longer approved, so the settlement cannot be submitted.',
  NO_ELIGIBLE_REVIEWER:
    'No eligible reviewer is available: the reviewer is an HR Administrator on the settlement reviewer list, holding the review grant with this employee in scope, who did not prepare it. Nothing was submitted; ask HR to update the settlement reviewer list.',
  WORKFLOW_NOT_CONFIGURED: 'No review route is configured for settlements. Nothing was submitted; ask HR to set one up.',
};

const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/** One blocker of a refused approval (settlement-gates.ts), in plain words with its code. */
function blockerText(b: Blocker): string {
  if (b.source === 'GRATUITY') {
    return b.code === 'CALCULATION_REQUIRED'
      ? 'Gratuity: the employee is eligible, so the settlement must be calculated (CALCULATION_REQUIRED)'
      : `Gratuity: the gratuity rule pack is not active (${b.code})`;
  }
  if (b.source === 'STATUTORY') {
    return `Statutory deduction${b.componentCode ? ` ${b.componentCode}` : ''}: ${b.rulePackCode ? `rule pack ${b.rulePackCode}` : 'its rule pack'} is not configured`;
  }
  const what = `${labelOf(ITEM_KIND_LABEL, b.kind)}${b.componentCode ? ` ${b.componentCode}` : ''}`;
  if (b.kind === 'GRATUITY' && b.code === 'RULE_PACK_NOT_CONFIGURED') return `${what}: the gratuity rule pack is not active (${b.code})`;
  return `${what}: ${lowerFirst(labelOf(ITEM_STATUS_LABEL, b.code))} (${b.code})`;
}

function blockersOf(error: ApiError): Blocker[] {
  const value = (error.details as { blockers?: unknown } | undefined)?.blockers;
  return Array.isArray(value) ? value.filter((b): b is Blocker => typeof b === 'object' && b !== null && typeof (b as Blocker).code === 'string') : [];
}

export const DECISION_WORDS: Words = {
  // I-88: the final approval is refused while a rule pack, policy or record the settlement needs is missing.
  CALCULATION_BLOCKED: (e) => {
    const blockers = blockersOf(e).map(blockerText);
    return `This settlement cannot be approved while something it needs is missing${blockers.length > 0 ? `: ${blockers.join('; ')}` : ''}. Return the settlement for a corrected revision once that is in place.`;
  },
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

export const RELEASE_WORDS: Words = {
  ...CALCULATION_HOLDS_WORDS,
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

export const EXPORT_WORDS: Words = {
  NOT_APPROVED: 'Only an approved settlement, one eligible for release or a paid one is exported.',
  FORBIDDEN: 'The selected role cannot export settlements: exporting needs its own settlement export grant, separate from reading a settlement.',
};

/** I-81 item 2: the payment recorded from evidence. */
export const PAYMENT_WORDS: Words = {
  ...CALCULATION_HOLDS_WORDS,
  NOT_INDEPENDENT: 'The payment is recorded by someone other than the preparer, the reviewer, the approver and whoever marked it eligible for release.',
  WITHDRAWAL_PENDING: 'The employee’s request to withdraw the resignation is waiting for its decision; the payment waits for it.',
  ALREADY_PAID_IN_PAYROLL: (e) => `Monthly payroll for the final period already pays ${listOf(e, 'components').join(', ')}; this revision has to be voided and corrected.`,
  PAYMENT_IN_FUTURE: 'A payment is recorded once it has happened: the date cannot be in the future.',
  PAYMENT_BEFORE_RELEASE: 'The payment date cannot be before the settlement became eligible for release.',
  EVIDENCE_NOT_VERIFIED: 'The evidence must be released by the malware scan and verified by someone independent.',
  EVIDENCE_KEY_REUSED: 'This payment evidence was already used for another payment.',
  FORBIDDEN: 'The selected role cannot record settlement payments: it needs its own grant.',
};

/** I-81 items 5, 6: voiding a live revision. */
export const VOID_WORDS: Words = {
  NOT_INDEPENDENT: 'A revision is voided by someone other than its preparer and its employee.',
  USE_DRAFT_CANCEL: 'A draft is cancelled by its preparer.',
};

/** I-81 item 9: in-app sending. */
export const SEND_WORDS: Words = {
  RECIPIENT_MISMATCH: 'A document is delivered only to the employee it is about.',
  NO_SELF_SERVICE_ACCESS: 'The employee has no active self-service account to deliver to; hand the document over another way.',
  NOT_APPROVED: 'Only an approved, release-eligible or paid settlement is sent.',
  FORBIDDEN: 'The selected role cannot send: sending needs its own grant.',
};

/** The ZIP download's refusals: one unavailable settlement refuses the whole archive, named where the screen knows it. */
export function archiveWords(names: ReadonlyMap<string, string>): Words {
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
  // I-88: an upload replaces every line, so a calculated draft takes its other lines one by one, each with its reason.
  CALCULATED_REVISION: 'This draft is calculated, so its lines are not uploaded: enter the lines for other components on the settlement, each with its reason.',
  INVALID_STATE: 'The settlement is no longer a draft.',
  COLUMN_COUNT: 'The row does not have exactly one cell for each of the five columns.',
  FORBIDDEN: 'The selected role can no longer prepare settlements, so nothing was applied.',
};

export const BULK_UPLOAD: ImportTemplate = {
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

export function refusalText(error: unknown, words: Words = {}): string | null {
  if (!(error instanceof ApiError)) return null;
  const entry = words[error.code] ?? COMMON_WORDS[error.code];
  if (entry === undefined) return null;
  return typeof entry === 'function' ? entry(error) : entry;
}

/**
 * A failed action: the API's refusal in plain words (its code beneath for reference), anything else as the API sent
 * it. `noAnswer` explains a request whose answer never came back (the connection dropped): it may have been recorded.
 */
export function Refusal({ error, words, noAnswer }: { error: unknown; words?: Words; noAnswer?: string }) {
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

