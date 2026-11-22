// Bank manifest detail: authorisation, the file, outcomes and reversals.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ButtonRow, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { PagerButton, PagerRow } from '@/components/pager';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, download, formatDate, idempotencyKey, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Notice, Section } from '../../ui';
import { Missing } from './pickers';
import { Problem, ReasonForm } from './problems';
import { BANK_AUTHORIZE, BANK_FILE, BANK_OUTCOME, BANK_PREPARE, BANK_READ, BATCH_STATE, canReadRuns, Fact, involvement, label, MONEY, money, OUTCOME_FROM, OUTCOME_LABEL, PATHS, PAYMENT_STATE, Status, useKeys } from './shared';
import type { BankLine, Manifest, RunDetail } from './types';

// =========================================================================================================
// Bank manifest detail: authorisation, file, outcomes and reversals
// =========================================================================================================

export function ManifestScreen() {
  const { can } = useSession();
  const { id = '' } = useParams();
  if (!can(BANK_READ)) {
    return (
      <Section title="Bank manifest">
        <Empty refusal>The selected role cannot see bank manifests.</Empty>
      </Section>
    );
  }
  return <ManifestView key={id} id={id} />;
}

type ManifestAction = 'authorize' | 'cancel' | 'issue';

/** What a manifest action that worked did, in words; none of them is a payment. */
const ACTION_NOTE: Record<ManifestAction, string> = {
  authorize: 'Authorised: every line is reserved. Nothing is paid until a CONFIRMED outcome is recorded from bank evidence.',
  issue: 'The bank file was issued. Issuing a file is not a payment.',
  cancel: 'The manifest was cancelled; nothing was reserved.',
};

function ManifestView({ id }: { id: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [fileFailure, setFileFailure] = useState<unknown>(null);
  const batch = useQuery({ queryKey: keys.manifest(id), queryFn: () => api<Manifest>(`/v1/payroll-outputs/bank-manifests/${encodeURIComponent(id)}`), retry: retryTransient });
  const b = batch.data;
  // The run's actors are known only to callers who may read the run; the server refuses them either way.
  const run = useQuery({
    queryKey: keys.run(b?.runId ?? '-'),
    queryFn: () => api<RunDetail>(`/v1/payroll/runs/${encodeURIComponent(b?.runId ?? '')}`),
    enabled: b !== undefined && canReadRuns(can),
    retry: retryTransient,
  });
  const act = useMutation({
    mutationFn: ({ action, reason }: { action: ManifestAction; reason?: string }) =>
      api<Manifest>(`/v1/payroll-outputs/bank-manifests/${encodeURIComponent(id)}/${action}`, action === 'issue' ? { method: 'POST' } : { body: { ...(reason ? { reason } : {}), expectedVersion: b?.version } }),
    onSuccess: (_r, { action }) => setNote(ACTION_NOTE[action]),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: keys.manifestAll }), qc.invalidateQueries({ queryKey: keys.runAll })]),
  });
  if (batch.isPending) return <LoadingLine>Loading the manifest…</LoadingLine>;
  if (!b) {
    return (
      <Section title="Bank manifest">
        <Problem error={batch.error} act="read" />
      </Section>
    );
  }
  const preparer = b.preparedBy === me?.userId;
  const runRoles = run.data ? involvement(run.data, me?.userId) : [];
  // While the run's actors are still loading, nothing that needs independence is offered yet.
  const blocked = preparer || runRoles.length > 0 || run.isLoading;
  const busy = act.isPending;
  const fetchFile = async () => {
    if (downloading) return;
    setDownloading(true);
    setFileFailure(null);
    try {
      await download(`/v1/payroll-outputs/bank-manifests/${encodeURIComponent(id)}/file`);
    } catch (e) {
      setFileFailure(e);
    } finally {
      setDownloading(false);
    }
  };
  const ex = b.excluded ?? {};
  return (
    <div className="stack">
      <Section
        title={`Bank manifest ${b.batchRevision}`}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to={PATHS.run(b.runId)}>Open the payroll run</Link>
          </Button>
        }
      >
        <dl className="kv">
          <Fact term="State">
            <Status map={BATCH_STATE} code={b.state} />
          </Fact>
          <Fact term="Template">{`${b.templateCode} v${b.templateVersion}${b.testOnly ? ' (test only)' : ''}`}</Fact>
          <Fact term="Payment date">{formatDate(b.paymentDate)}</Fact>
          <Fact term="Lines">{b.lineCount}</Fact>
          <Fact term="Total">{money(b.totalAmount, b.currencyCode)}</Fact>
          <Fact term="Prepared">{formatDate(b.preparedAt)}</Fact>
          <Fact term="Authorised">{formatDate(b.authorizedAt)}</Fact>
          <Fact term="File issued">{formatDate(b.issuedAt)}</Fact>
          {b.fileName && <Fact term="File">{b.fileName}</Fact>}
          {b.cancelledAt && <Fact term="Cancelled">{formatDate(b.cancelledAt)}</Fact>}
          <Fact term="Left out">
            {`${ex.held ?? 0} held${ex.heldBySalaryStop ? ` (${ex.heldBySalaryStop} by a salary stop)` : ''}, ${ex.reservedOrPaid ?? 0} reserved or paid, ${ex.nothingPayable ?? 0} nothing payable, ${ex.excludedByPreparer ?? 0} by the preparer`}
            {ex.excludedEmployeeCodes && ex.excludedEmployeeCodes.length > 0 ? ` (${ex.excludedEmployeeCodes.join(', ')})` : ''}
          </Fact>
        </dl>
        <Hint role="note">A manifest or a bank file is not a payment. Payment status comes only from outcomes recorded from bank evidence; only a confirmed outcome is a payment.</Hint>
        {preparer && <Hint>You prepared this manifest, so someone else authorises it and records its outcomes.</Hint>}
        {runRoles.length > 0 && <Hint>{`You ${runRoles.join(' and ')} its payroll run, so you cannot authorise this manifest or record its outcomes.`}</Hint>}
        <div className="mt-2 flex flex-col gap-3">
          {b.state === 'VALIDATED' && can(BANK_AUTHORIZE) && (
            <ButtonRow>
              <Button
                type="button"
                disabled={busy || blocked}
                onClick={() => {
                  setNote(null);
                  act.mutate({ action: 'authorize' });
                }}
              >
                {busy && act.variables?.action === 'authorize' ? 'Authorising…' : 'Authorise the payment'}
              </Button>
            </ButtonRow>
          )}
          {b.state === 'VALIDATED' && can(BANK_PREPARE) && (
            <ReasonForm
              name="Cancel the manifest"
              field="Reason for cancelling the manifest"
              button="Cancel the manifest"
              busy={busy}
              danger
              onSend={(reason) => {
                setNote(null);
                return act.mutateAsync({ action: 'cancel', reason });
              }}
            />
          )}
          {b.state === 'AUTHORIZED' && can(BANK_FILE) && (
            <ButtonRow>
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  setNote(null);
                  act.mutate({ action: 'issue' });
                }}
              >
                {busy ? 'Issuing…' : 'Issue the bank file'}
              </Button>
            </ButtonRow>
          )}
          {b.state === 'ISSUED' && can(BANK_FILE) && (
            <ButtonRow>
              <Button type="button" variant="outline" disabled={downloading} onClick={() => void fetchFile()}>
                {downloading ? 'Downloading…' : 'Download the bank file'}
              </Button>
            </ButtonRow>
          )}
        </div>
        <Notice notice={note ? { text: note, ok: true } : null} />
        <Problem error={act.error} act={act.variables?.action === 'authorize' ? 'authorize' : 'manifest'} />
        {fileFailure !== null && <Problem error={fileFailure} act="download" />}
      </Section>
      {b.ledger.length > 0 && (
        <Section title="Payment ledger">
          <Table aria-label="Payment ledger">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Payment state</TableHead>
                <TableHead scope="col">Lines</TableHead>
                <TableHead scope="col">Amount</TableHead>
                <TableHead scope="col">Net confirmed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {b.ledger.map((l) => (
                <TableRow key={l.paymentState}>
                  <TableCell>
                    <Status map={PAYMENT_STATE} code={l.paymentState} />
                  </TableCell>
                  <TableCell>{l.lines}</TableCell>
                  <TableCell>{money(l.amount, b.currencyCode)}</TableCell>
                  <TableCell>{money(l.netConfirmed, b.currencyCode)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}
      <ManifestLines batch={b} blocked={blocked} />
    </div>
  );
}

function ManifestLines({ batch, blocked }: { batch: Manifest; blocked: boolean }) {
  const { can } = useSession();
  const keys = useKeys();
  const [after, setAfter] = useState(0);
  const [previous, setPrevious] = useState<number[]>([]);
  const [selected, setSelected] = useState<{ line: BankLine; kind: 'outcome' | 'reversal' } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const lines = useQuery({
    queryKey: keys.lines(batch.id, after),
    queryFn: () => api<{ items: BankLine[]; next: number | null }>(`/v1/payroll-outputs/bank-manifests/${encodeURIComponent(batch.id)}/lines${after ? `?after=${after}` : ''}`),
    retry: retryTransient,
  });
  const recordable = can(BANK_OUTCOME) && (batch.state === 'AUTHORIZED' || batch.state === 'ISSUED');
  const outcomesFor = (line: BankLine) =>
    Object.keys(OUTCOME_FROM).filter((o) => OUTCOME_FROM[o]!.includes(line.paymentState) && (batch.state === 'ISSUED' || o === 'CANCELLED'));
  const done = (text: string) => {
    setSelected(null);
    setNote(text);
  };
  return (
    <Section title="Manifest lines">
      {recordable && <Hint>Outcomes are recorded only from bank evidence, each with its own evidence key. Before the file is issued, only a cancellation can be recorded.</Hint>}
      {lines.isPending && <LoadingLine>Loading the lines…</LoadingLine>}
      {lines.error && <Problem error={lines.error} act="read" />}
      {lines.data && lines.data.items.length === 0 && <Empty>This manifest has no lines.</Empty>}
      {lines.data && lines.data.items.length > 0 && (
        <Table aria-label="Manifest lines">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Row</TableHead>
              <TableHead scope="col">Allocation</TableHead>
              <TableHead scope="col">Employee</TableHead>
              <TableHead scope="col">Kind</TableHead>
              <TableHead scope="col">Amount</TableHead>
              <TableHead scope="col">Payment state</TableHead>
              <TableHead scope="col">Confirmed</TableHead>
              <TableHead scope="col">Reversed</TableHead>
              {recordable && <TableHead scope="col">Record</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.data.items.map((l) => (
              <TableRow key={l.id}>
                <TableCell>{l.lineSequence}</TableCell>
                <TableCell>{l.allocationKey}</TableCell>
                <TableCell>{l.employeeCode}</TableCell>
                <TableCell>{l.holdId ? 'Released hold' : 'Payroll net'}</TableCell>
                <TableCell>{money(l.amount, l.currencyCode)}</TableCell>
                <TableCell>
                  <Status map={PAYMENT_STATE} code={l.paymentState} />
                </TableCell>
                <TableCell>{money(l.confirmedAmount, l.currencyCode)}</TableCell>
                <TableCell>{money(l.reversedAmount, l.currencyCode)}</TableCell>
                {recordable && (
                  <RowActionsCell>
                    <RowActions>
                      {outcomesFor(l).length > 0 && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={blocked}
                          onClick={() => {
                            setNote(null);
                            setSelected({ line: l, kind: 'outcome' });
                          }}
                          aria-label={`Record an outcome for row ${l.lineSequence}`}
                        >
                          Outcome
                        </Button>
                      )}
                      {l.paymentState === 'CONFIRMED' && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={blocked}
                          onClick={() => {
                            setNote(null);
                            setSelected({ line: l, kind: 'reversal' });
                          }}
                          aria-label={`Record a reversal for row ${l.lineSequence}`}
                        >
                          Reversal
                        </Button>
                      )}
                    </RowActions>
                  </RowActionsCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <PagerRow>
        {previous.length > 0 && (
          <PagerButton
            onClick={() => {
              setAfter(previous[previous.length - 1] ?? 0);
              setPrevious(previous.slice(0, -1));
            }}
          >
            Previous lines
          </PagerButton>
        )}
        {lines.data?.next != null && (
          <PagerButton
            onClick={() => {
              setPrevious([...previous, after]);
              setAfter(lines.data?.next ?? 0);
            }}
          >
            Next lines
          </PagerButton>
        )}
      </PagerRow>
      <Notice notice={note ? { text: note, ok: true } : null} />
      {selected?.kind === 'outcome' && <OutcomeForm key={`o:${selected.line.id}`} batch={batch} line={selected.line} options={outcomesFor(selected.line)} onDone={done} />}
      {selected?.kind === 'reversal' && <ReversalForm key={`r:${selected.line.id}`} batch={batch} line={selected.line} onDone={done} />}
    </Section>
  );
}

/** Intent keys survive the form being closed and reopened, so a resend after a lost answer reuses its key. */
const outcomeIntents = new Map<string, { intent: string; key: string; lost: boolean }>();

function keyFor(scope: string, intent: string, prefix: string): string {
  const prior = outcomeIntents.get(scope);
  const key = prior && prior.lost && prior.intent === intent ? prior.key : idempotencyKey(prefix);
  outcomeIntents.set(scope, { intent, key, lost: false });
  return key;
}
function settleKey(scope: string, error: unknown) {
  const prior = outcomeIntents.get(scope);
  if (!prior) return;
  if (error !== null && error !== undefined && !(error instanceof ApiError)) prior.lost = true;
  else outcomeIntents.delete(scope);
}

function OutcomeForm({ batch, line, options, onDone }: { batch: Manifest; line: BankLine; options: string[]; onDone: (text: string) => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  // Never preselected: a payment outcome (above all CONFIRMED) is recorded only as an explicit choice from evidence.
  const [outcome, setOutcome] = useState('');
  const [evidence, setEvidence] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const scope = `outcome:${line.id}`;
  const record = useMutation({
    mutationFn: (body: { outcomes: { lineId: string; outcome: string; eventKey: string; evidenceReference: string }[] }) =>
      api<{ batchId: string; results: { lineId: string; outcome: string; replayed: boolean }[] }>(`/v1/payroll-outputs/bank-manifests/${encodeURIComponent(batch.id)}/outcomes`, { body }),
    onSettled: (_d, error) => {
      settleKey(scope, error);
      void qc.invalidateQueries({ queryKey: keys.manifest(batch.id) });
    },
    onSuccess: (r) => {
      const replayed = r.results[0]?.replayed === true;
      onDone(replayed ? 'This outcome had already been recorded with the same evidence key; nothing was recorded twice.' : `Recorded for row ${line.lineSequence}: ${label(OUTCOME_LABEL, outcome)}.`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (record.isPending) return;
    const ref = evidence.trim();
    if (!outcome) return setProblem('Choose the outcome.');
    if (!ref) return setProblem('Give the evidence reference (for example the bank statement or return file).');
    setProblem(null);
    record.reset();
    const eventKey = keyFor(scope, `${outcome}|${ref}`, 'pay-outcome');
    record.mutate({ outcomes: [{ lineId: line.id, outcome, eventKey, evidenceReference: ref }] });
  };
  return (
    <FormGrid onSubmit={submit} aria-label={`Outcome for row ${line.lineSequence}`}>
      <p className="my-1">{`Row ${line.lineSequence} · ${line.employeeCode} · ${money(line.amount, line.currencyCode)} · ${label(PAYMENT_STATE, line.paymentState)}`}</p>
      <FormField>
        Outcome
        <NativeSelect value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="">Choose the outcome</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {label(OUTCOME_LABEL, o)}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      <FormField>
        Evidence reference
        <Input value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={500} autoComplete="off" />
      </FormField>
      <ButtonRow>
        <Button type="submit" disabled={record.isPending}>
          {record.isPending ? 'Recording…' : 'Record the outcome'}
        </Button>
      </ButtonRow>
      <Missing text={problem} />
      <div className="col-span-full">
        <Problem error={record.error} act="outcome" />
      </div>
    </FormGrid>
  );
}

function ReversalForm({ batch, line, onDone }: { batch: Manifest; line: BankLine; onDone: (text: string) => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [evidence, setEvidence] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const scope = `reversal:${line.id}`;
  const reverse = useMutation({
    mutationFn: (body: { amount: string; eventKey: string; evidenceReference: string; reason: string }) =>
      api<{ lineId: string; replayed: boolean; paymentState: string; confirmedAmount: string; reversedAmount: string }>(`/v1/payroll-outputs/bank-lines/${encodeURIComponent(line.id)}/reversal`, { body }),
    onSettled: (_d, error) => {
      settleKey(scope, error);
      void qc.invalidateQueries({ queryKey: keys.manifest(batch.id) });
    },
    onSuccess: (r) =>
      onDone(
        r.replayed
          ? 'This reversal had already been recorded with the same evidence key; nothing was recorded twice.'
          : `Reversal recorded for row ${line.lineSequence}: ${money(r.reversedAmount, line.currencyCode)} reversed of ${money(r.confirmedAmount, line.currencyCode)} confirmed.`,
      ),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reverse.isPending) return;
    const amt = amount.trim();
    const ref = evidence.trim();
    const why = reason.trim();
    if (!MONEY.test(amt) || /^0+(\.0+)?$/.test(amt)) return setProblem('Enter the reversed amount as a positive number, for example 1500.00.');
    if (!ref) return setProblem('Give the evidence reference of the return.');
    if (!why) return setProblem('Give the reason for the reversal.');
    setProblem(null);
    reverse.reset();
    const eventKey = keyFor(scope, `${amt}|${ref}|${why}`, 'pay-reversal');
    reverse.mutate({ amount: amt, eventKey, evidenceReference: ref, reason: why });
  };
  return (
    <FormGrid onSubmit={submit} aria-label={`Reversal for row ${line.lineSequence}`}>
      <p className="my-1">{`Row ${line.lineSequence} · ${line.employeeCode} · confirmed ${money(line.confirmedAmount, line.currencyCode)}, reversed so far ${money(line.reversedAmount, line.currencyCode)}`}</p>
      <FormField>
        Reversed amount
        <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoComplete="off" />
      </FormField>
      <FormField>
        Evidence reference
        <Input value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={500} autoComplete="off" />
      </FormField>
      <FormField className="col-span-full">
        Reason
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} />
      </FormField>
      <ButtonRow>
        <Button type="submit" disabled={reverse.isPending}>
          {reverse.isPending ? 'Recording…' : 'Record the reversal'}
        </Button>
      </ButtonRow>
      <Missing text={problem} />
      <div className="col-span-full">
        <Problem error={reverse.error} act="reverse" />
      </div>
    </FormGrid>
  );
}
