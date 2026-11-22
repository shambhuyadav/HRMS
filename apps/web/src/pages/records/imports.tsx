// ---------------------------------------------------------------------------------------------------------
// Batch imports (FR-009, FR-023, DF09, I-13, I-20): upload, row-by-row preview, then an explicit commit or cancel.
// Every batch is all or nothing: any row problem rejects the whole batch, and a commit applies every row or none.
// Every stored file waits for the scan worker unread (FR-106, NFR-S09), so a first upload answers a held batch as a matter of
// course; the screen re-checks it by itself until the preview comes (useHeldBatchWatch). The user's own batches of the selected
// template are listed below the form, so a held batch can be opened again and checked again from its stored file.
// ---------------------------------------------------------------------------------------------------------
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { ButtonRow, FormField } from '@/components/form-field';
import { Hint, HintLine } from '@/components/hint';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, download, fileToBase64, formatDate, idempotencyKey, pinSession } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, Section, StateBadge } from '../../ui';
import { HELD_BATCH_NOTE, HeldBatchCheck, ImportBatches, useBatchFollowUp } from './batches';
import { FIELD_ROW, FIELD_WIDTH } from './layout';
import { type ImportJob, type ImportTemplate, type RowChanges, TEMPLATES } from './templates';

/** Rows shown in the table; a 10,000-row batch is summarised rather than drawn in full. */
const SHOWN_ROWS = 200;
const plural = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;
/** A row's proposed changes as a short list in its cell, indented less than a page's list. */
const CHANGE_LIST = 'm-0 pl-[1.1rem]';

export function ImportsPage() {
  const { can } = useSession();
  const available = TEMPLATES.filter((t) => t.permissions.every((p) => can(p)));
  const [templateCode, setTemplateCode] = useState(available[0]?.code ?? '');
  const template = available.find((t) => t.code === templateCode) ?? available[0];
  const [file, setFile] = useState<File | null>(null);
  // Remounting the file input clears the chosen file once its preview is on screen.
  const [fileInput, setFileInput] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  // One idempotency key per chosen file and template: validating the same file again (after a lost answer or a
  // double click) returns the same job instead of a second one. A new file or template gets a new key.
  const uploadKey = useRef<string | null>(null);
  const choose = (next: File | null) => {
    setFile(next);
    uploadKey.current = null;
  };

  // A held batch checked again, or one of the user's batches opened from the list (of the selected template).
  const { resume, open, refresh, watch } = useBatchFollowUp(
    template?.base ?? '',
    {
      show: setJob,
      closed: (id) => setJob((shown) => (shown?.id === id ? null : shown)),
      onStart: () => {
        upload.reset();
        act.reset();
      },
    },
    job,
  );
  const act = useMutation({
    mutationFn: async ({ t, id, action }: { t: ImportTemplate; id: string; action: 'commit' | 'cancel' }) => {
      // The decision and any look at the batch after it go out under the role it was made in (BR-046).
      const send = pinSession();
      try {
        // The routes take no body: committing a committed batch again returns it unchanged.
        return await send<ImportJob>(`${t.base}/${id}/${action}`, { method: 'POST' });
      } catch (err) {
        // The batch may have moved on: this very decision went through but its answer was lost, or the batch was
        // committed, rejected or cancelled since the preview. Its job view shows where it stands now.
        const current = await send<ImportJob>(`${t.base}/${id}`).catch(() => null);
        if (current?.state === (action === 'commit' ? 'COMMITTED' : 'CANCELLED')) return current;
        if (current) setJob((shown) => (shown?.id === id ? current : shown));
        throw err;
      }
    },
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: setJob,
    onSettled: refresh,
  });
  const upload = useMutation({
    mutationFn: async ({ t, f }: { t: ImportTemplate; f: File }) => {
      const key = (uploadKey.current ??= idempotencyKey('import'));
      return api<ImportJob>(t.base, { body: { fileName: f.name, contentBase64: await fileToBase64(f), idempotencyKey: key } });
    },
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSettled: refresh,
    onSuccess: (view) => {
      setJob(view);
      act.reset();
      // The preview is on screen, so the form starts clean: the next file, a corrected one included, is a new upload
      // with its own key (re-choosing a file of the same name must not return this job again).
      setFile(null);
      uploadKey.current = null;
      setFileInput((n) => n + 1);
    },
    onError: (err) => {
      // The key is someone else's: the next attempt must use a fresh one.
      if (err instanceof ApiError && err.code === 'IDEMPOTENCY_KEY_IN_USE') uploadKey.current = null;
    },
  });

  if (!template) return <Empty>You cannot import in this role.</Empty>;

  // While a file is checked or a decision on the batch shown is on its way, no other upload starts and the template
  // stays as it is: that answer would replace a newer preview, or bring back a batch the template switch cleared
  // (a switch resets every mutation, but their answers still arrive).
  const busy = upload.isPending || act.isPending || resume.isPending || open.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (file && !busy) upload.mutate({ t: template, f: file });
  };
  const jobTemplate = TEMPLATES.find((t) => t.code === job?.template) ?? template;

  return (
    <>
      <Section title="Import">
        <form onSubmit={submit} className="flex flex-col gap-3">
          <FormField className={FIELD_WIDTH}>
            Template
            <NativeSelect
              value={template.code}
              disabled={busy}
              onChange={(e) => {
                setTemplateCode(e.target.value);
                setJob(null);
                uploadKey.current = null;
                upload.reset();
                act.reset();
                resume.reset();
                open.reset();
              }}
            >
              {available.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label} ({t.code})
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <Hint>
            {/* The header is one long word of comma-joined column names: it may break anywhere, or it runs out of the card on a phone. */}
            CSV with exactly the header <code className="break-all">{template.columns}</code>. {template.note} Nothing is applied until you commit a preview, and a batch is
            applied all or nothing: one row with a problem rejects the whole batch.
          </Hint>
          <TemplateDownload key={template.code} base={template.base} code={template.code} />
          <div className={FIELD_ROW}>
            <FormField className="w-auto">
              Import file
              <Input key={fileInput} type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => choose(e.target.files?.[0] ?? null)} />
            </FormField>
            <Button type="submit" disabled={!file || busy}>
              Validate
            </Button>
          </div>
        </form>
        <ErrorNote error={upload.error ?? resume.error} />
      </Section>
      {job && (
        <>
          <ImportJobView
            job={job}
            template={jobTemplate}
            pending={act.isPending}
            onAction={(action) => act.mutate({ t: jobTemplate, id: job.id, action })}
            error={act.error}
          />
          <HeldBatchCheck job={job} busy={busy} onCheck={() => resume.mutate(job.id)} checked={resume.isPending ? undefined : resume.data} watch={watch} />
        </>
      )}
      <ImportBatches
        key={template.base}
        base={template.base}
        title={`Your ${template.label.toLowerCase()} batches`}
        openedId={job?.id ?? null}
        busy={busy}
        onOpen={(id) => open.mutate(id)}
        error={open.error}
      />
    </>
  );
}

/** A batch waiting for the malware scan: an informational status, nothing wrong. */
function HeldBatchStatus() {
  return (
    <StatusNote tone="info" role="status">
      {HELD_BATCH_NOTE}
    </StatusNote>
  );
}

/** A rejected batch: nothing was applied, and the rows to fix are listed below. */
function RejectedStatus({ problems }: { problems: number }) {
  return (
    <StatusNote tone="warning" role="status">
      This batch was rejected, so nothing was applied ({plural(problems, ['row has', 'rows have'])} a problem). Fix the rows listed below and upload the corrected file.
    </StatusNote>
  );
}

/** A batch's own decisions have a place in its card's header only while it waits for one (held for the scan, or previewed). */
const awaitsDecision = (job: ImportJob) => job.state === 'UPLOADED' || job.state === 'PREVIEWED';

/** The commit and cancel buttons of a batch waiting for a decision: commit only once it is previewed. */
function JobActions({ job, template, pending, onAction }: { job: ImportJob; template: ImportTemplate; pending: boolean; onAction: (a: 'commit' | 'cancel') => void }) {
  const rows = job.rowCount ?? job.rows.length;
  const cancel = (
    <Button type="button" variant="outline" disabled={pending} onClick={() => onAction('cancel')}>
      Cancel import
    </Button>
  );
  if (job.state === 'UPLOADED') return cancel;
  return (
    <ButtonRow>
      <Button type="button" disabled={pending} onClick={() => onAction('commit')}>
        {template.verb} {plural(rows, template.noun)}
      </Button>
      {cancel}
    </ButtonRow>
  );
}

export function ImportJobView({
  job,
  template,
  pending,
  onAction,
  error,
}: {
  job: ImportJob;
  template: ImportTemplate;
  pending: boolean;
  onAction: (a: 'commit' | 'cancel') => void;
  error: unknown;
}) {
  const rows = job.rowCount ?? job.rows.length;
  const problems = job.rows.filter((r) => r.errorCode && r.errorCode !== 'BATCH_REJECTED');
  // A rejected batch lists its problem rows first; the rest only explain that they were not applied.
  const ordered = job.state === 'REJECTED' ? [...problems, ...job.rows.filter((r) => !r.errorCode || r.errorCode === 'BATCH_REJECTED')] : job.rows;
  return (
    <Section
      title={`Preview: ${job.fileName ?? 'import'} (${job.template ?? template.code})`}
      actions={awaitsDecision(job) ? <JobActions job={job} template={template} pending={pending} onAction={onAction} /> : undefined}
    >
      <p>
        <StateBadge state={job.state} /> {job.state === 'UPLOADED' ? null : plural(rows, ['row', 'rows'])}
      </p>
      {job.state === 'UPLOADED' && <HeldBatchStatus />}
      {job.state === 'PREVIEWED' && <p>{rows === 1 ? 'The row is valid.' : `All ${rows} rows are valid.`} Committing applies every row in one go.</p>}
      {job.state === 'REJECTED' && <RejectedStatus problems={problems.length} />}
      {job.state === 'COMMITTED' && <p>{job.acceptedCount === 1 ? 'The row was applied.' : `All ${job.acceptedCount} rows were applied.`}</p>}
      {job.state === 'CANCELLED' && <p>Import cancelled; nothing was applied.</p>}
      {template.changeFields && <Hint>Each proposed change reads “field: old value -&gt; new value”; — means no value.</Hint>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Row</TableHead>
            <TableHead scope="col">{template.keyLabel}</TableHead>
            <TableHead scope="col">Result</TableHead>
            {template.changeFields && <TableHead scope="col">Proposed changes</TableHead>}
            <TableHead scope="col">Problem</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ordered.slice(0, SHOWN_ROWS).map((r) => (
            <TableRow key={r.rowNumber}>
              <TableCell>{r.rowNumber}</TableCell>
              <TableCell>{r.businessKey}</TableCell>
              <TableCell>
                <Badge tone={r.state === 'REJECTED' ? 'bad' : 'good'}>{r.state.toLowerCase()}</Badge>
              </TableCell>
              {template.changeFields && (
                <TableCell>
                  <ProposedChanges changes={r.proposedChanges} order={template.changeFields} />
                </TableCell>
              )}
              <TableCell>
                <RowProblem code={r.errorCode} words={template.problems} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {ordered.length > SHOWN_ROWS && (
        <Hint>
          Showing the first {SHOWN_ROWS} of {ordered.length} rows.
        </Hint>
      )}
      <ErrorNote error={error} />
    </Section>
  );
}

/** One proposed change as "field: from -> to": no value is an em dash, and the effective date is a calendar date. */
function changeText(field: string, change: { from: string | null; to: string | null } | null | undefined): string {
  const shown = (value: string | null | undefined) => {
    if (value === null || value === undefined) return '—';
    return field === 'effectiveFrom' ? formatDate(value) : value;
  };
  return `${field}: ${shown(change?.from)} -> ${shown(change?.to)}`;
}

/** A row's proposed changes exactly as the preview stored them, in the template's field order (any other field follows). */
function ProposedChanges({ changes, order }: { changes: RowChanges | null | undefined; order: string[] }) {
  const rank = (field: string) => (order.includes(field) ? order.indexOf(field) : order.length);
  const fields = Object.keys(changes ?? {}).sort((a, b) => rank(a) - rank(b));
  if (!changes || fields.length === 0) return <>—</>;
  return (
    <ul className={CHANGE_LIST}>
      {fields.map((field) => (
        <li key={field}>{changeText(field, changes[field])}</li>
      ))}
    </ul>
  );
}

/** A row's problem: in plain words where the template explains its code, which stays beneath for reference. */
function RowProblem({ code, words }: { code: string | null; words: Record<string, string> | undefined }) {
  if (!code) return <>—</>;
  if (code === 'BATCH_REJECTED') return <>not applied (another row failed)</>;
  const plain = words?.[code];
  if (!plain) return <>{code}</>;
  return (
    <>
      {plain}
      <HintLine>{code}</HintLine>
    </>
  );
}

/**
 * DF09 published versioned template: GET <base>/template downloads a CSV file holding exactly the header the upload
 * checks and no rows, named by the template code and version (imports/routes.ts), under the upload's own duties, which
 * the server checks again. The import screens here, in timesheet.tsx, appraisal.tsx, documents.tsx and payroll.tsx use it.
 */
export function TemplateDownload({ base, code }: { base: string; code: string }) {
  const get = useMutation({ mutationFn: () => download(`${base}/template`) });
  return (
    <div className="flex flex-col gap-3">
      <ButtonRow>
        <Button type="button" variant="outline" disabled={get.isPending} onClick={() => get.mutate()}>
          Download the template
        </Button>
        <Hint as="span">{`${code}.csv: the header line only, ready to fill in.`}</Hint>
      </ButtonRow>
      <ErrorNote error={get.error} />
    </div>
  );
}
