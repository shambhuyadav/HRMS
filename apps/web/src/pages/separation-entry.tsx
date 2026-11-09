// HR entry of a separation other than a resignation (FR-051, FR-052, FR-055; decided under owner delegation, 6 Nov 2026, docs/03 I-89
// item 7 and I-92): retirement, termination, death, disablement or end of contract, entered by HR only, with the reference of the
// document received and that one released, verified document of the employee (POST /v1/employees/:id/separations). Each type's date
// rule is explained beside the date; a termination records its ground as one of the company's exit reason codes (GET
// /v1/exit-reasons). Whoever enters it never recommends or approves it. The server decides every rule; refusals are said in words.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, ApiError } from '../api';
import { ErrorNote, Section } from '../ui';
import { VerifiedEvidencePicker } from './exit-finance';

type SeparationType = 'RETIREMENT' | 'TERMINATION' | 'DEATH' | 'DISABLEMENT' | 'END_OF_CONTRACT';

interface TypeRule {
  label: string;
  /** What the date field holds for this type. */
  dateLabel: string;
  /** The date rule, as the server applies it against the company's business date (lifecycle/separation-types.ts). */
  dateRule: string;
  /** What happens to the date and the notice afterwards. */
  route: string;
  evidence: string;
  reasonCodeRequired: boolean;
}

/** lifecycle/separation-types.ts SEPARATION_RULES, in words. */
export const SEPARATION_TYPE_RULES: Readonly<Record<SeparationType, TypeRule>> = {
  RETIREMENT: {
    label: 'Retirement',
    dateLabel: 'Retirement date (the last working date)',
    dateRule: 'From today, and not before the joining date.',
    route: 'The date is fixed: the manager’s recommendation and the approval confirm it. No notice applies.',
    evidence: 'the retirement order or superannuation note',
    reasonCodeRequired: false,
  },
  TERMINATION: {
    label: 'Termination',
    dateLabel: 'Proposed last working date',
    dateRule: 'From today, and not before the joining date.',
    route:
      'The manager recommends the last working date and an independent HR approver decides it. Notice is the employer’s to give under the contract: a shortfall is shown and nothing is recovered from the employee; any pay in lieu is a settlement line entered with its reason.',
    evidence: 'the termination order',
    reasonCodeRequired: true,
  },
  DEATH: {
    label: 'Death',
    dateLabel: 'Date of death',
    dateRule: 'Today or earlier (it may be in the past), and not before the joining date.',
    route: 'The date is fixed. No notice applies, and nothing about it is sent to the employee’s own self-service.',
    evidence: 'the death certificate',
    reasonCodeRequired: false,
  },
  DISABLEMENT: {
    label: 'Disablement',
    dateLabel: 'Date employment ends on the medical evidence',
    dateRule: 'Any date on or after the joining date.',
    route: 'The date is fixed: the recommendation and the approval confirm it. No notice applies.',
    evidence: 'the medical certificate or board finding',
    reasonCodeRequired: false,
  },
  END_OF_CONTRACT: {
    label: 'End of contract',
    dateLabel: 'Contract end date (the last working date)',
    dateRule: 'From today, and not before the joining date.',
    route: 'The date is fixed: the recommendation and the approval confirm it. No notice applies.',
    evidence: 'the fixed-term contract or its non-renewal letter',
    reasonCodeRequired: false,
  },
};

const TYPES = Object.keys(SEPARATION_TYPE_RULES) as SeparationType[];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REFERENCE = 500;
const MAX_REASON = 1000;

/** Refusals of POST /v1/employees/:id/separations (lifecycle/exit.ts enterSeparation and createResignation), in plain words. */
const SEPARATION_WORDS: Record<string, string> = {
  INVALID_SEPARATION_TYPE: 'Choose retirement, termination, death, disablement or end of contract; a resignation has its own form.',
  REASON_CODE_REQUIRED: 'A termination needs its ground recorded as one of the company’s exit reason codes.',
  INVALID_REFERENCE: 'The exit reason code is not one of the company’s active exit reasons.',
  EVIDENCE_REQUIRED: 'Give the reference of the document received (at most 500 characters) and choose its verified document.',
  ONE_EVIDENCE_DOCUMENT: 'Choose exactly one released, verified document of the employee as the evidence.',
  TOO_MUCH_EVIDENCE: 'Choose exactly one released, verified document of the employee as the evidence.',
  EVIDENCE_NOT_VERIFIED: 'The document must be released by the malware scan and verified by someone independent first.',
  INVALID_EVIDENCE: 'The evidence must be a document of this employee.',
  OPEN_EXIT_EXISTS: 'The employee already has an open exit. It must be decided or rejected before another separation is entered.',
  EMPLOYEE_NOT_ACTIVE: 'Only an active employee can be separated.',
  SELF_ACTION_NOT_ALLOWED: 'You cannot enter a separation on your own record.',
  FORBIDDEN: 'The selected role cannot enter separations.',
  NOT_FOUND: 'This employee is not in the selected role’s scope.',
};

/** The server's refusal in words; a date refusal keeps the server's own sentence, which names the rule that failed. */
function refusalOf(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'INVALID_LAST_WORKING_DATE') return `The date was not accepted: ${error.message.replace(/\.?$/, '.')}`;
  return SEPARATION_WORDS[error.code] ?? null;
}

interface ReasonCodes {
  items: { code: string; label: string }[];
}

export function EnterSeparationForm({ employeeId, exitsKey }: { employeeId: string; exitsKey: readonly unknown[] }) {
  const qc = useQueryClient();
  const [type, setType] = useState<SeparationType | ''>('');
  const [date, setDate] = useState('');
  const [reference, setReference] = useState('');
  const [doc, setDoc] = useState<string | null>(null);
  const [reasonCode, setReasonCode] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [entered, setEntered] = useState<string | null>(null);
  // Read once a type is chosen: the list is the company's, under the same duty as the entry.
  const reasons = useQuery({ queryKey: ['exit-reasons'], queryFn: () => api<ReasonCodes>('/v1/exit-reasons'), enabled: type !== '', retry: false });
  const rule = type ? SEPARATION_TYPE_RULES[type] : null;
  const codes = reasons.data?.items ?? [];

  const enter = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ exitCaseId: string }>(`/v1/employees/${encodeURIComponent(employeeId)}/separations`, { body }),
    onSuccess: () => {
      setEntered(rule?.label ?? 'separation');
      setType('');
      setDate('');
      setReference('');
      setDoc(null);
      setReasonCode('');
      setReason('');
      void qc.invalidateQueries({ queryKey: exitsKey });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (enter.isPending) return;
    setEntered(null);
    let issue: string | null = null;
    if (!type || !rule) issue = 'Choose the type of separation.';
    else if (!ISO_DATE.test(date)) issue = `Give the ${rule.dateLabel.toLowerCase()}.`;
    else if (!reference.trim()) issue = 'Give the reference of the document received.';
    else if (!doc) issue = `Choose the verified document: ${rule.evidence}.`;
    else if (rule.reasonCodeRequired && !reasonCode) issue = 'Choose the ground of the termination from the company’s exit reasons.';
    setProblem(issue);
    if (issue) {
      enter.reset();
      return;
    }
    enter.mutate({
      separationType: type,
      proposedLastWorkingDate: date,
      evidenceReference: reference.trim(),
      evidenceDocumentIds: [doc],
      ...(reasonCode ? { reasonCode } : {}),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
  };
  const refusal = refusalOf(enter.error);

  return (
    <Section title="Enter a separation other than a resignation">
      <p className="hint">
        For a retirement, termination, death, disablement or end of contract. HR enters it with the document received; it follows the exit route, and you will not recommend or approve
        it.
      </p>
      <form onSubmit={submit} className="grid-form" aria-label="Enter a separation">
        <label>
          Type of separation
          <select value={type} onChange={(e) => setType(e.target.value as SeparationType | '')}>
            <option value="">Choose…</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {SEPARATION_TYPE_RULES[t].label}
              </option>
            ))}
          </select>
        </label>
        {rule && (
          <>
            <p className="hint">
              {rule.dateRule} {rule.route}
            </p>
            <label>
              {rule.dateLabel}
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label>
              Reference of the document received
              <input value={reference} maxLength={MAX_REFERENCE} onChange={(e) => setReference(e.target.value)} />
            </label>
            <VerifiedEvidencePicker employeeId={employeeId} chosen={doc} onChange={setDoc} legend={`The document: ${rule.evidence} (released and verified)`} />
            <label>
              {rule.reasonCodeRequired ? 'Ground of the termination (exit reason, required)' : 'Exit reason (optional)'}
              <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} disabled={codes.length === 0}>
                <option value="">{rule.reasonCodeRequired ? 'Choose…' : 'None'}</option>
                {codes.map((c) => (
                  <option key={c.code} value={c.code}>
                    {`${c.label} (${c.code})`}
                  </option>
                ))}
              </select>
            </label>
            {reasons.isSuccess && codes.length === 0 && (
              <p className="hint">
                No exit reason codes are configured yet. {rule.reasonCodeRequired ? 'A termination cannot be entered until an administrator adds them to the EXIT_REASON reference list.' : ''}
              </p>
            )}
            <ErrorNote error={reasons.error} />
            <label>
              Reason (optional; seen by authorised reviewers only)
              <textarea value={reason} maxLength={MAX_REASON} onChange={(e) => setReason(e.target.value)} />
            </label>
          </>
        )}
        <div className="row">
          <button type="submit" disabled={enter.isPending}>
            Enter the separation
          </button>
        </div>
      </form>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      {refusal ? (
        <p role="alert" className="error">
          {refusal}
        </p>
      ) : (
        <ErrorNote error={enter.error} />
      )}
      {entered && (
        <p role="status" className="ok">
          {`The ${entered.toLowerCase()} is entered and waits for the manager’s recommendation.`}
        </p>
      )}
    </Section>
  );
}
