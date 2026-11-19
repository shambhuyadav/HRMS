// Payroll inputs (FR-031): entry, upload with dry run, the batch list and a batch with its actions.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { api, type EmployeeHit, fileToBase64, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, LIST_PAGE_SIZE, Pager, pageParams, Section } from '../../ui';
import { TemplateDownload } from '../records';
import { EmployeePicker, Missing, Note, type PeriodChoice, PeriodPicker, person } from './pickers';
import { Problem, ReasonForm, ROW_TEXT } from './problems';
import { Fact, H3, INPUT_APPROVE, INPUT_PREPARE, label, MONEY, money, SCROLL, Status, useIntentKey, useKeys } from './shared';

// =========================================================================================================
// Payroll inputs (FR-031): entry, upload with dry run, submission, independent approval, cancellation and the
// controlled reversal of approved lines (DF03)
// =========================================================================================================

export interface InputBatch {
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
export const INPUT_SOURCE: Record<string, string> = { ENTRY: 'Entered', UPLOAD: 'Uploaded file' };
const INPUT_FILTERS = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'];
const UPLOAD_HEADER = 'employee_code,component_code,input_kind,amount,currency_code,effective_date,reference';

export function NewInputBatch() {
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

export function InputBatchList() {
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
      {batches.isPending && <p className="hint loading">Loading input batches…</p>}
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

export function InputBatchView({ id, withActions }: { id: string; withActions: boolean }) {
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
  if (batch.isPending) return <p className="hint loading">Loading the batch…</p>;
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
