// Payroll inputs (FR-031): entry, upload with dry run, the batch list and a batch with its actions.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, CheckField, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, type EmployeeHit, fileToBase64, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, LIST_PAGE_SIZE, Pager, pageParams, Section } from '../../ui';
import { TemplateDownload } from '../records';
import { EmployeePicker, Missing, Note, type PeriodChoice, PeriodPicker, person } from './pickers';
import { Problem, ReasonForm, ROW_TEXT } from './problems';
import { Fact, INPUT_APPROVE, INPUT_PREPARE, label, MONEY, money, Status, useIntentKey, useKeys } from './shared';

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
/** A part of a card below what comes before it, its pieces one under another. */
const CARD_PART = 'mt-3 flex flex-col gap-3';

export function NewInputBatch() {
  const [period, setPeriod] = useState<PeriodChoice | null>(null);
  return (
    <Section title="Enter payroll inputs">
      <Hint>Inputs are entered for one period and approved by someone independent before a calculation uses them. Nothing is saved unless every line is valid.</Hint>
      <FormGrid asChild>
        <div role="group" aria-label="Input period">
          <PeriodPicker value={period} onChange={setPeriod} purpose="of the inputs" />
        </div>
      </FormGrid>
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
    <div className={CARD_PART}>
      <CardSubheading>{`Enter lines for ${period.periodCode}`}</CardSubheading>
      <FormGrid onSubmit={add} aria-label="Add an input line">
        <EmployeePicker title="Employee" value={employee} onChange={setEmployee} />
        <FormField>
          Pay component code
          <Input value={componentCode} onChange={(e) => setComponentCode(e.target.value)} maxLength={40} autoComplete="off" />
        </FormField>
        <FormField>
          Input kind
          <Input value={inputKind} onChange={(e) => setInputKind(e.target.value)} maxLength={60} autoComplete="off" />
        </FormField>
        <FormField>
          {`Amount (${period.currencyCode})`}
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" maxLength={20} autoComplete="off" />
        </FormField>
        <FormField>
          Effective date
          <Input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
        </FormField>
        <FormField>
          Reference
          <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} autoComplete="off" />
        </FormField>
        <ButtonRow>
          <Button type="submit" variant="outline">
            Add the line
          </Button>
        </ButtonRow>
        <Missing text={problem} />
      </FormGrid>
      {lines.length > 0 && (
        <Table aria-label="Lines to save">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Row</TableHead>
              <TableHead scope="col">Employee</TableHead>
              <TableHead scope="col">Component</TableHead>
              <TableHead scope="col">Kind</TableHead>
              <TableHead scope="col">Amount</TableHead>
              <TableHead scope="col">Effective</TableHead>
              <TableHead scope="col">Reference</TableHead>
              <TableHead scope="col">Remove</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l, i) => (
              <TableRow key={l.key}>
                <TableCell>{i + 1}</TableCell>
                <TableCell>{person(l.employee)}</TableCell>
                <TableCell>{l.componentCode}</TableCell>
                <TableCell>{l.inputKind}</TableCell>
                <TableCell>{money(l.amount, period.currencyCode)}</TableCell>
                <TableCell>{formatDate(l.effectiveDate)}</TableCell>
                <TableCell>{l.reference}</TableCell>
                <RowActionsCell>
                  <RowActions>
                    <Button type="button" variant="danger" size="sm" disabled={save.isPending} onClick={() => setLines(lines.filter((x) => x.key !== l.key))} aria-label={`Remove row ${i + 1}`}>
                      Remove
                    </Button>
                  </RowActions>
                </RowActionsCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <ButtonRow>
        <Button type="button" disabled={save.isPending || lines.length === 0} onClick={send}>
          {save.isPending ? 'Saving…' : 'Save the lines as a draft batch'}
        </Button>
      </ButtonRow>
      <Note text={note} />
      <Problem error={save.error} act="input" />
    </div>
  );
}

/** What an upload did, in words: a file already live, a dry run, a saved batch, or a file refused as a whole. */
function uploadSummary(r: UploadResult): string {
  if (r.replayed) return 'This file is already a live batch of this period; nothing was saved twice.';
  if (r.dryRun) return `Checked only, nothing was saved: ${r.total} rows, ${r.accepted} valid, ${r.rejected} refused.`;
  if (r.applied) return `Saved as a draft batch of ${r.accepted} rows. Submit it for an independent approval from the list of batches.`;
  return `Nothing was saved: every row must be valid (${r.rejected} of ${r.total} rows refused).`;
}

/** The upload button: busy while the server scans and checks the file, else a check (dry run) or the upload itself. */
function uploadButtonText(pending: boolean, dryRun: boolean): string {
  if (pending) return 'Scanning and checking…';
  return dryRun ? 'Check the file' : 'Upload the file';
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
  return (
    <FormGrid
      aria-label="Upload input lines"
      onSubmit={(e) => {
        e.preventDefault();
        if (!file || upload.isPending) return;
        setResult(null);
        upload.reset();
        upload.mutate({ f: file, dry: dryRun });
      }}
    >
      <CardSubheading>{`Upload lines for ${period.periodCode}`}</CardSubheading>
      <Hint>{`A CSV file with the PAYROLL_INPUTS_V1 header: ${UPLOAD_HEADER}. The server scans it for malware before reading it: a flagged file is quarantined and nothing is saved.`}</Hint>
      <div className="col-span-full">
        <TemplateDownload base="/v1/payroll/input-batches" code="PAYROLL_INPUTS_V1" />
      </div>
      <FormField>
        CSV file
        <Input ref={fileRef} type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </FormField>
      <CheckField>
        <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> Check only (dry run: nothing is saved)
      </CheckField>
      <ButtonRow>
        <Button type="submit" disabled={!file || upload.isPending}>
          {uploadButtonText(upload.isPending, dryRun)}
        </Button>
      </ButtonRow>
      {/* What the upload did is a status whatever it says: a success when the file was saved or checked clean, an error when rows were refused. */}
      {r && (
        <StatusNote tone={r.applied || r.replayed || (r.dryRun && r.rejected === 0) ? 'success' : 'error'} role="status">
          {uploadSummary(r)}
        </StatusNote>
      )}
      {r && r.errors.length > 0 && (
        <div className="col-span-full">
          <Table aria-label="Rows refused">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Row</TableHead>
                <TableHead scope="col">Problem</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.errors.map((x) => (
                <TableRow key={`${x.row}:${x.code}`}>
                  <TableCell>{x.row}</TableCell>
                  <TableCell>{label(ROW_TEXT, x.code)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <div className="col-span-full">
        <Problem error={upload.error} act="upload" />
      </div>
    </FormGrid>
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
        <FormField className="w-auto">
          State
          <NativeSelect
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
          </NativeSelect>
        </FormField>
      }
    >
      {batches.isPending && <LoadingLine>Loading input batches…</LoadingLine>}
      {batches.error && <Problem error={batches.error} act="read" />}
      {batches.data && batches.data.items.length === 0 && <Empty>No input batches.</Empty>}
      {batches.data && batches.data.items.length > 0 && (
        <Table aria-label="Input batches">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Period</TableHead>
              <TableHead scope="col">Source</TableHead>
              <TableHead scope="col">Lines</TableHead>
              <TableHead scope="col">State</TableHead>
              <TableHead scope="col">Prepared by</TableHead>
              <TableHead scope="col">Created</TableHead>
              <TableHead scope="col">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {batches.data.items.map((b) => (
              <TableRow key={b.id}>
                <TableCell>{b.periodCode}</TableCell>
                <TableCell>{label(INPUT_SOURCE, b.source)}</TableCell>
                <TableCell>{b.lineCount}</TableCell>
                <TableCell>
                  <Status map={INPUT_STATE} code={b.state} />
                </TableCell>
                <TableCell>{b.preparedBy === me?.userId ? 'You' : 'Someone else'}</TableCell>
                <TableCell>{formatDate(b.createdAt)}</TableCell>
                <RowActionsCell>
                  <RowActions>
                    <Button type="button" variant="outline" size="sm" onClick={() => setOpenId(openId === b.id ? null : b.id)} aria-label={`Details of the ${b.periodCode} batch created ${formatDate(b.createdAt)}`}>
                      {openId === b.id ? 'Hide' : 'Details'}
                    </Button>
                  </RowActions>
                </RowActionsCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
  if (batch.isPending) return <LoadingLine>Loading the batch…</LoadingLine>;
  if (!b) return <Problem error={batch.error} act="read" />;
  const name = `Input batch of ${b.periodCode}`;
  const mine = b.preparedBy === me?.userId;
  const open = b.state === 'DRAFT' || b.state === 'SUBMITTED';
  // DF03: an approver independent of the preparer reverses approved lines no processed run has used.
  const reversible = withActions && can(INPUT_APPROVE) && b.state === 'APPROVED' && !mine;
  const canReverse = (l: InputLineRow) => reversible && l.state === 'APPROVED' && !l.consumedRecordId;
  return (
    <div role="region" aria-label={name} className="mt-2">
      <CardSubheading>{name}</CardSubheading>
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
      {!b.scopeComplete && <Hint>Some lines of this batch are outside your scope or are your own, so they are not shown.</Hint>}
      {b.lines.length > 0 && (
        <Table aria-label={`Lines of the ${b.periodCode} batch`}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Employee</TableHead>
              <TableHead scope="col">Component</TableHead>
              <TableHead scope="col">Kind</TableHead>
              <TableHead scope="col">Amount</TableHead>
              <TableHead scope="col">Effective</TableHead>
              <TableHead scope="col">Reference</TableHead>
              <TableHead scope="col">State</TableHead>
              {reversible && <TableHead scope="col">Reverse</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {b.lines.map((l) => (
              <TableRow key={l.id}>
                <TableCell>{l.employeeCode}</TableCell>
                <TableCell>{l.componentCode}</TableCell>
                <TableCell>{l.inputKind}</TableCell>
                <TableCell>{money(l.amount, l.currencyCode)}</TableCell>
                <TableCell>{formatDate(l.effectiveDate)}</TableCell>
                <TableCell>{l.reference}</TableCell>
                <TableCell>
                  {l.consumedRecordId ? 'Used by a processed run' : <Status map={INPUT_STATE} code={l.state} />}
                  {l.reversalReason && <Hint className="m-0">{l.reversalReason}</Hint>}
                </TableCell>
                {reversible && (
                  <TableCell>
                    {canReverse(l) && (
                      <input
                        type="checkbox"
                        aria-label={`Reverse the line ${l.reference}`}
                        checked={selected.includes(l.id)}
                        onChange={(e) => setSelected(e.target.checked ? [...selected, l.id] : selected.filter((x) => x !== l.id))}
                      />
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {withActions && can(INPUT_APPROVE) && b.state === 'APPROVED' && mine && <Hint>You prepared this batch, so someone independent reverses its approved lines.</Hint>}
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
      {withActions && can(INPUT_PREPARE) && open && !mine && <Hint>Only its preparer submits or cancels this batch.</Hint>}
      {withActions && can(INPUT_PREPARE) && open && mine && (
        <div className="flex flex-col gap-3">
          {b.state === 'DRAFT' && (
            <ButtonRow>
              <Button
                type="button"
                disabled={act.isPending}
                onClick={() => {
                  setNote(null);
                  act.mutate({ action: 'submit', body: { expectedVersion: b.version } });
                }}
              >
                {act.isPending && act.variables?.action === 'submit' ? 'Submitting…' : 'Submit for approval'}
              </Button>
            </ButtonRow>
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
