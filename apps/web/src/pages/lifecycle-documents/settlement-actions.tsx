// Settlement steps besides preparation: the notice waiver, release eligibility, export, the payment record, voiding and the statement.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useRef, useState } from 'react';
import { api, ApiError, download, idempotencyKey, isConflict, localDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Section } from '../../ui';
import { VerifiedEvidencePicker } from '../exit-finance';
import { plural, unitText } from './calculation-basis';
import { EXPORT_WORDS, PAYMENT_WORDS, Refusal, RELEASE_WORDS, SEND_WORDS, VOID_WORDS, WAIVER_WORDS } from './refusals';
import { DELIVERY_STATUS_LABEL, enc, EXPORT_FORMATS, type ExportFormat, formatLabel, labelOf, MAX_REASON, TEXTAREA, useSettlementRefresh, when } from './shared';
import type { Delivery, SettlementDetail } from './types';

/**
 * F1 notice (I-88): the exit's notice recovery waived, with a reason, by someone holding the waiver right who is neither the employee
 * nor the preparer (the server refuses both). It applies when the preparer calculates the draft again; once per exit.
 */
export function WaiveNotice({ s, onNotice }: { s: SettlementDetail; onNotice: (text: string) => void }) {
  const { me } = useSession();
  const refresh = useSettlementRefresh();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const preparer = me?.userId === s.preparedBy;
  const blockedId = `${useId()}-preparer`;
  const waive = useMutation({
    mutationFn: (text: string) => api<{ id: string; exitCaseId: string; waivedBy: string }>(`/v1/exit-cases/${enc(s.exitCaseId)}/notice-waiver`, { body: { reason: text } }),
    onSuccess: () => {
      setReason('');
      onNotice('Notice recovery waived. The preparer calculates the draft again to apply it.');
      refresh(s);
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) refresh(s);
    },
  });
  const item = s.calculation?.items.find((i) => i.kind === 'NOTICE_RECOVERY' && i.status === 'CALCULATED');
  const short = unitText(item?.basis?.shortfallDays);
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (waive.isPending || preparer) return;
    const text = reason.trim();
    setProblem(text ? null : 'Enter why the notice recovery is waived.');
    if (!text) {
      waive.reset();
      return;
    }
    waive.mutate(text);
  };
  return (
    <Section title="Waive the notice recovery">
      <p className="hint">
        The calculation recovers {short ? plural(short, 'day', 'days') : 'the days'} of notice not served. Waiving it is recorded with its reason, once for this exit, by someone other
        than the employee and the preparer; it applies when the preparer calculates the draft again.
      </p>
      {preparer && (
        <p className="hint" id={blockedId}>
          You prepared this settlement, so someone else waives its notice recovery.
        </p>
      )}
      <form className="stack" aria-label="Waive the notice recovery" onSubmit={send}>
        <label>
          Reason for waiving (required)
          <textarea rows={2} maxLength={MAX_REASON} value={reason} disabled={waive.isPending || preparer} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
        </label>
        {problem && (
          <p role="alert" className="error">
            {problem}
          </p>
        )}
        <div className="row">
          <button type="submit" disabled={waive.isPending || preparer} aria-describedby={preparer ? blockedId : undefined}>
            Waive the notice recovery
          </button>
        </div>
        <Refusal
          error={waive.error}
          words={WAIVER_WORDS}
          noAnswer="No answer came back, so the waiver may or may not have been recorded. The settlement has been reloaded: check it before trying again."
        />
      </form>
    </Section>
  );
}


/** FR-053/BR-016: eligibility for release only; it never makes, schedules or records a payment. */
export function ReleaseEligibility({ s, onNotice }: { s: SettlementDetail; onNotice: (text: string) => void }) {
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
export function SettlementExport({ s }: { s: SettlementDetail }) {
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
 * FR-053, DF07 (I-81 item 2): the settlement is paid outside this system; its payment is recorded here from evidence (date, reference,
 * one released and verified document) by someone independent of the preparer, reviewer, approver and release marker.
 */
export function RecordPayment({ s, onNotice }: { s: SettlementDetail; onNotice: (text: string) => void }) {
  const { me } = useSession();
  const refresh = useSettlementRefresh();
  const [date, setDate] = useState('');
  const [reference, setReference] = useState('');
  const [doc, setDoc] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const involved = me?.userId === s.preparedBy || s.decisions.some((d) => d.actorUserId === me?.userId);
  const pay = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<SettlementDetail & { replayed: boolean }>(`/v1/settlements/${enc(s.id)}/payment`, { body }),
    onSuccess: (saved) => {
      key.current = null;
      onNotice(saved.replayed ? 'This payment had already been recorded with this evidence; nothing was recorded twice.' : `The payment of revision ${saved.revision} is recorded from its evidence.`);
      refresh(saved);
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) refresh(s);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pay.isPending || involved) return;
    if (!date || !reference.trim() || !doc) return setProblem('Give the payment date, its bank reference and its verified evidence document.');
    setProblem(null);
    key.current ??= idempotencyKey('ff-pay');
    pay.mutate({ paymentDate: date, evidenceKey: key.current, evidenceReference: reference.trim(), evidenceDocumentIds: [doc], expectedVersion: s.version });
  };
  return (
    <Section title="Record the payment">
      <p>The settlement is paid outside this system. Record the payment once it has happened, from its evidence; the full net amount is the amount paid.</p>
      {involved && <p className="hint">You prepared, decided or marked this settlement, so someone else records its payment.</p>}
      <form onSubmit={submit} className="grid-form" aria-label="Record the settlement payment">
        <label>
          Payment date
          <input type="date" value={date} max={localDate()} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          Bank or receipt reference
          <input value={reference} maxLength={500} onChange={(e) => setReference(e.target.value)} />
        </label>
        <VerifiedEvidencePicker employeeId={s.employeeId} chosen={doc} onChange={setDoc} legend="Evidence of the payment (released and verified)" />
        <div className="row">
          <button type="submit" disabled={pay.isPending || involved}>
            Record the payment
          </button>
        </div>
      </form>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <Refusal error={pay.error} words={PAYMENT_WORDS} noAnswer="No answer came back, so the payment may or may not have been recorded. The settlement has been reloaded: check its state before trying again." />
    </Section>
  );
}

/** I-81 items 5, 6: a live revision that must not be paid is voided by an independent approver, with the reason; everything is kept. */
export function VoidSettlement({ s, onNotice }: { s: SettlementDetail; onNotice: (text: string) => void }) {
  const refresh = useSettlementRefresh();
  const [reason, setReason] = useState('');
  const voiding = useMutation({
    mutationFn: () => api<SettlementDetail>(`/v1/settlements/${enc(s.id)}/void`, { body: { reason: reason.trim(), expectedVersion: s.version } }),
    onSuccess: (saved) => {
      onNotice(`Revision ${saved.revision} is cancelled; its lines and decisions are kept. A corrected revision can be prepared.`);
      refresh(saved);
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) refresh(s);
    },
  });
  return (
    <Section title="Void this revision">
      <p className="hint">For a revision that must not be paid: the final period’s payroll already paid one of its components, or it is wrong. A paid revision cannot be voided.</p>
      <label>
        Reason
        <input value={reason} maxLength={MAX_REASON} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="row">
        <button type="button" disabled={voiding.isPending || !reason.trim()} onClick={() => voiding.mutate()}>
          Void the revision
        </button>
      </div>
      <Refusal error={voiding.error} words={VOID_WORDS} />
    </Section>
  );
}

/**
 * FR-054 "Send PDF" / "Send Excel", FR-018, DF09 (I-81 item 9): the statement is delivered to the employee's own self-service, never
 * e-mailed. The sender confirms the recipient (recipient review); the delivery's status shows whether the employee has opened it.
 */
export function SendStatement({ s }: { s: SettlementDetail }) {
  const qc = useQueryClient();
  const [format, setFormat] = useState<'PDF' | 'XLSX'>('PDF');
  const [confirmed, setConfirmed] = useState(false);
  const key = useRef<string | null>(null);
  const deliveries = useQuery({
    queryKey: ['settlement-deliveries', s.id],
    queryFn: () => api<{ items: Delivery[] }>(`/v1/settlements/${enc(s.id)}/deliveries`),
    retry: retryTransient,
  });
  const send = useMutation({
    mutationFn: () => {
      key.current ??= idempotencyKey('ff-send');
      return api<Delivery>(`/v1/settlements/${enc(s.id)}/send`, { body: { format, recipientEmployeeId: s.employeeId, idempotencyKey: key.current } });
    },
    onSuccess: () => {
      key.current = null;
      setConfirmed(false);
      void qc.invalidateQueries({ queryKey: ['settlement-deliveries', s.id] });
    },
  });
  return (
    <Section title="Send to the employee’s self-service">
      <p className="hint">The statement is delivered in the employee’s own self-service with an in-app notice; nothing is attached to an e-mail.</p>
      <div className="row">
        <label>
          Format
          <select value={format} disabled={send.isPending} onChange={(e) => setFormat(e.target.value as 'PDF' | 'XLSX')}>
            <option value="PDF">PDF</option>
            <option value="XLSX">Excel (XLSX)</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          {` The recipient is ${s.employeeName} (${s.employeeCode}), the employee this settlement is about`}
        </label>
        <button type="button" disabled={send.isPending || !confirmed} onClick={() => send.mutate()}>
          {`Send the ${format === 'PDF' ? 'PDF' : 'Excel'} statement`}
        </button>
      </div>
      <Refusal error={send.error} words={SEND_WORDS} />
      {deliveries.data && deliveries.data.items.length > 0 && (
        <ul>
          {deliveries.data.items.map((d) => (
            <li key={d.id}>{`${d.format} of revision ${d.sourceRevision}, sent ${when(d.sentAt)}: ${labelOf(DELIVERY_STATUS_LABEL, d.status)}`}</li>
          ))}
        </ul>
      )}
    </Section>
  );
}

