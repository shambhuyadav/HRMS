// Refusals of the payroll routes in plain words: the actions, their refusal texts, the problem line and the one-reason form.

import { type FormEvent, useId, useState } from 'react';
import { ApiError, formatDate, readable } from '../../api';
import { FLUSH, label, TEXTAREA } from './shared';
import type { BankRowError } from './types';

// ---------------------------------------------------------------------------------------------------------
// Refusals in plain words
// ---------------------------------------------------------------------------------------------------------

export type Act =
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
  | 'stop-upload'
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
const KEYED: ReadonlySet<Act> = new Set<Act>(['loan-request', 'loan-upload', 'run-decision', 'outcome', 'reverse', 'input', 'upload', 'input-decide', 'stop-propose', 'stop-upload', 'hold-propose', 'disburse']);

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
export const ACT_REFUSALS: Partial<Record<Act, Record<string, string>>> = {
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
  // The shared batch import (imports/batch.ts, jobs.ts) answering the SALARY_STOPS_V1 upload.
  'stop-upload': {
    INVALID_HEADER: 'The file does not use the SALARY_STOPS_V1 header: download the template and keep exactly its header line.',
    INVALID_FILE: 'The file is not a valid UTF-8 CSV file.',
    EMPTY_FILE: 'The file has no rows below the header.',
    FILE_SIZE: 'An upload file is between 1 byte and 10 MB.',
    TOO_MANY_ROWS: 'At most 10,000 rows per upload: split the file.',
    FILE_QUARANTINED: 'The malware scan flagged the file as unsafe: nothing in it was read and no salary stop was proposed.',
    IDEMPOTENCY_KEY_IN_USE: 'That upload key is already in use. Choose the file again and validate it.',
  },
  'hold-propose': { EVIDENCE_REQUIRED: 'Give the evidence reference and choose at least one released, verified document of the employee.' },
  disburse: {
    EVIDENCE_REQUIRED: 'Give the evidence reference and choose the released, verified document of the disbursement.',
    EVIDENCE_KEY_REUSED: 'This evidence key already recorded another disbursement.',
  },
  criterion: {
    EVIDENCE_REQUIRED: 'Give the evidence reference of the criterion.',
    REMINDER_INTERVAL_NOT_NARROWER: 'A criterion may shorten the escalation intervals (at most 2, then every 5 business days), never lengthen them.',
  },
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
export const ROW_TEXT: Record<string, string> = {
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

export const REFUSALS: Record<string, string> = {
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
  MASTERS_CHANGED: 'A salary arrangement, unpaid leave, reviewed attendance or a leaving date was approved after the calculation: return the run to calculate a new revision.',
  STATUTORY_CHANGED: 'A statutory rule pack, PF option, work location state or accepted tax declaration changed after the calculation: return the run to calculate a new revision.',
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
  SERVICE_PERIOD_NOT_A_MONTH: 'A service period is one whole calendar month, from its first to its last day (proration uses the days of that month).',
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

export function Problem({ error, act }: { error: unknown; act: Act }) {
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
export function ReasonForm({
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
