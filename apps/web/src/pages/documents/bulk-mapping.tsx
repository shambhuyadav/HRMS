// Bulk document mapping (FR-010, DF09, I-13): stage files, then map them with a DOCUMENT_MAPPING_V1 batch.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { PagerButton, PagerCount, PagerRow } from '@/components/pager';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { StatusNote } from '@/components/status-note';
import { SegmentedChoice, SegmentedOption } from '@/components/tab-list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, fileToBase64, formatDate, idempotencyKey, isForbidden, pinSession, plural, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, NotPermitted, Notice, Pager, Section } from '../../ui';
import { HeldBatchCheck, type ImportJob, ImportJobView, type ImportTemplate, TemplateDownload, useHeldBatchWatch } from '../records';
import { Refusal, UPLOAD_WORDS, type Words, wordsFor } from './refusals';
import {
  BATCHES_PAGE_SIZE,
  DOCUMENT_UPLOAD,
  EMPLOYEE_IMPORT,
  FIELD_ROW,
  FILE_ACCEPT,
  type MappingBatchPage,
  STAGED_PAGE_SIZE,
  type StagedFile,
  type StagedPage,
  type StagedState,
  useKeys,
} from './shared';
import { ScanBadge } from './shared-views';

// ---------------------------------------------------------------------------------------------------------
// Bulk document mapping (FR-010, DF09, I-13): stage files, then map them with a DOCUMENT_MAPPING_V1 batch
// ---------------------------------------------------------------------------------------------------------

/** DOCUMENT_MAPPING_V1 row problems: documents/mapping.ts applyRow and imports/batch.ts. Any other code is shown as sent. */
const MAPPING_PROBLEMS: Record<string, string> = {
  FILE_NAME_REQUIRED: 'The fileName cell is empty; name one of your staged files.',
  INVALID_EMPLOYEE_CODE: 'The employee code is not a valid code (letters, digits, - and _, starting with a letter or digit, at most 40 characters).',
  INVALID_EXPIRES_ON: 'expiresOn is not a valid date (YYYY-MM-DD); leave it blank for no expiry.',
  UNKNOWN_FILE: 'You have no staged file with this name waiting to be mapped. Stage it first or check the name; a file already mapped, or discarded, cannot be mapped.',
  FILE_QUARANTINED: 'This staged file failed the malware scan and is quarantined, so it can never be mapped.',
  FILE_NOT_RELEASED: 'This staged file is still waiting for the malware scan; it can be mapped once the scan releases it.',
  UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code. Nothing is assigned to a guessed employee; correct the code.',
  OUT_OF_SCOPE: 'This employee is outside the scope of your role.',
  UNKNOWN_DOCUMENT_TYPE: 'No active document type has this code.',
  FILE_ALREADY_MAPPED: 'This file was mapped to an employee meanwhile.',
  DUPLICATE_IN_BATCH: 'This file is already named on an earlier row; each staged file may appear on one row only.',
  COLUMN_COUNT: 'The row does not have exactly one cell for each column of the header.',
};

const MAPPING_TEMPLATE: ImportTemplate = {
  code: 'DOCUMENT_MAPPING_V1',
  label: 'Document mapping',
  permissions: [EMPLOYEE_IMPORT, DOCUMENT_UPLOAD],
  base: '/v1/documents/mapping-imports',
  columns: 'fileName,employeeCode,documentType,expiresOn',
  keyLabel: 'Employee code',
  noun: ['document', 'documents'],
  verb: 'Map',
  note:
    'Each row assigns one of your staged files, by its file name, to the employee with that code as a document of that type; expiresOn (YYYY-MM-DD) may be left blank. Only files the malware scan released can be mapped, and a mapping is final.',
  problems: MAPPING_PROBLEMS,
};

const MAPPING_UPLOAD_WORDS: Words = {
  FILE_QUARANTINED: 'The malware scan flagged this mapping file, so nothing in it was read and nothing was mapped. Upload a clean copy of the file.',
  INVALID_HEADER: `The first line of the file must be exactly the header ${MAPPING_TEMPLATE.columns}.`,
  INVALID_FILE: 'The file is not a valid UTF-8 CSV file.',
  EMPTY_FILE: 'The file has no rows to map below its header.',
  FILE_SIZE: 'A mapping file must be between 1 byte and 10 MB.',
  PAYLOAD_TOO_LARGE: 'The file is larger than 10 MB.',
  IDEMPOTENCY_KEY_IN_USE: 'This upload could not be matched to your earlier one. Validate the file again to send it as a new upload.',
  FORBIDDEN: 'The selected role cannot map documents: a mapping file needs the import duty and the document upload grant.',
};

const STAGE_WORDS: Words = {
  ...UPLOAD_WORDS,
  FILE_NAME_IN_USE: 'You already staged a file with this name that is waiting to be mapped. Map or discard that file first, or rename this one.',
  FORBIDDEN: 'The selected role cannot stage documents: that needs the document upload grant.',
  INVALID_REQUEST: 'The file name cannot contain / \\ < > : " | ? * or control characters.',
  SESSION_CHANGED: 'Not sent: the role or company changed before this file was staged.',
};

const DISCARD_WORDS: Words = {
  FILE_MAPPED: 'This file has been mapped to an employee meanwhile: it is an employee document now and cannot be discarded.',
  NOT_FOUND: 'This staged file is not available to the selected role.',
  FORBIDDEN: 'The selected role cannot discard staged documents: that needs the document upload grant.',
};

const STAGED_TABS: { state: StagedState; label: string; table: string; empty: string }[] = [
  { state: 'UNMAPPED', label: 'Waiting to be mapped', table: 'Files waiting to be mapped', empty: 'You have no staged files waiting to be mapped.' },
  { state: 'MAPPED', label: 'Mapped', table: 'Mapped files', empty: 'None of your staged files has been mapped yet.' },
  { state: 'DISCARDED', label: 'Discarded', table: 'Discarded files', empty: 'You have not discarded any staged file.' },
];

/** A batch's state in plain words (imports/jobs.ts). */
const BATCH_STATES: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  UPLOADED: { label: 'waiting for the scan', tone: 'neutral' },
  PREVIEWED: { label: 'previewed, not committed', tone: 'warn' },
  COMMITTED: { label: 'committed', tone: 'good' },
  REJECTED: { label: 'rejected, nothing mapped', tone: 'bad' },
  CANCELLED: { label: 'cancelled, nothing mapped', tone: 'neutral' },
};

type StageResult = { fileName: string; scanState: string | null } | { fileName: string; error: unknown };

function stageText(r: StageResult): string {
  if ('error' in r) {
    const e = r.error;
    return wordsFor(e, STAGE_WORDS) ?? (e instanceof ApiError ? `${e.message} (${e.code})` : 'Not staged: no answer came back.');
  }
  if (r.scanState === 'CLEAN') return 'Staged and checked; it can be mapped.';
  if (r.scanState === 'QUARANTINED') return 'Staged, but it failed the safety check, so it can never be mapped.';
  return 'Staged; being checked. It can be mapped once the check passes.';
}

export function BulkMappingScreen() {
  const { can } = useSession();
  const canStage = can(DOCUMENT_UPLOAD);
  const canMap = canStage && can(EMPLOYEE_IMPORT);
  if (!canStage) {
    return (
      <Section title="Bulk document mapping">
        <NotPermitted>Employee documents are confidential, and the selected role holds no document upload grant, so it cannot stage or map documents.</NotPermitted>
      </Section>
    );
  }
  return (
    <>
      <StageDocuments />
      <StagedFiles />
      {canMap ? (
        <MappingImport />
      ) : (
        <Section title="Mapping file">
          <NotPermitted>Uploading a mapping file also needs the import duty, which the selected role does not hold.</NotPermitted>
        </Section>
      )}
    </>
  );
}

function StageDocuments() {
  const keys = useKeys();
  const qc = useQueryClient();
  const [files, setFiles] = useState<File[]>([]);
  const [inputKey, setInputKey] = useState(0);
  const [results, setResults] = useState<StageResult[]>([]);
  const stage = useMutation({
    mutationFn: async (chosen: File[]) => {
      // One staging request per file, all under the role they were started in (BR-046).
      const send = pinSession();
      const out: StageResult[] = [];
      for (const f of chosen) {
        try {
          const r = await send<{ id: string; fileName: string; scanState: string | null }>('/v1/documents/bulk-uploads', {
            body: { fileName: f.name, contentBase64: await fileToBase64(f) },
          });
          out.push({ fileName: r.fileName, scanState: r.scanState });
        } catch (error) {
          out.push({ fileName: f.name, error });
        }
      }
      return out;
    },
    onMutate: () => setResults([]),
    onSuccess: (out) => {
      setResults(out);
      setFiles([]);
      setInputKey((k) => k + 1);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.staged }),
  });
  const staged = results.filter((r) => !('error' in r)).length;
  return (
    <Section title="Stage documents">
      <form
        className={FIELD_ROW}
        aria-label="Stage documents"
        onSubmit={(e) => {
          e.preventDefault();
          if (files.length > 0 && !stage.isPending) stage.mutate(files);
        }}
      >
        <FormField className="w-auto">
          Documents to stage
          <Input key={inputKey} type="file" multiple accept={FILE_ACCEPT} disabled={stage.isPending} onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        </FormField>
        <Button type="submit" disabled={files.length === 0 || stage.isPending}>
          {files.length > 1 ? `Stage ${files.length} files` : 'Stage file'}
        </Button>
      </form>
      <Hint>
        PDF, JPEG or PNG up to 10 MB each. A staged file waits, unassigned, under its file name until a mapping file assigns it to an employee. Every file goes through
        a safety check first.
      </Hint>
      {stage.isPending && <Hint>Staging…</Hint>}
      {results.length > 0 && (
        <>
          <StatusNote tone="info" role="status">
            {plural(staged, 'file', 'files')} staged{results.length > staged ? `, ${plural(results.length - staged, 'file', 'files')} not staged` : ''}.
          </StatusNote>
          <ul aria-label="Staging results">
            {results.map((r, i) => (
              <li key={`${r.fileName}-${i}`}>
                <strong>{r.fileName}</strong>: {stageText(r)}
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function StagedFiles() {
  const keys = useKeys();
  const qc = useQueryClient();
  const [state, setState] = useState<StagedState>('UNMAPPED');
  const [page, setPage] = useState(1);
  const tab = STAGED_TABS.find((t) => t.state === state)!;
  // The file whose discard waits for a second click, and the last one discarded.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [discarded, setDiscarded] = useState<string | null>(null);
  const list = useQuery({
    queryKey: keys.stagedIn(state, page),
    queryFn: () => api<StagedPage>(`/v1/documents/bulk-uploads?state=${state}&page=${page}&pageSize=${STAGED_PAGE_SIZE}`),
    retry: retryTransient,
  });
  const discard = useMutation({
    mutationFn: (f: StagedFile) => api<StagedFile>(`/v1/documents/bulk-uploads/${encodeURIComponent(f.id)}/discard`, { method: 'POST' }),
    onMutate: () => setDiscarded(null),
    onSuccess: (f) => setDiscarded(f.fileName),
    onSettled: () => {
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: keys.staged });
    },
  });
  const show = (next: StagedState) => {
    setState(next);
    setPage(1);
    setConfirming(null);
  };
  const turn = (next: number) => {
    setPage(next);
    setConfirming(null);
  };
  const items = list.data?.items ?? [];
  return (
    <Section
      title="Your staged files"
      actions={
        <SegmentedChoice>
          {STAGED_TABS.map((t) => (
            <SegmentedOption key={t.state} pressed={state === t.state} onClick={() => show(t.state)}>
              {t.label}
            </SegmentedOption>
          ))}
        </SegmentedChoice>
      }
    >
      <Hint>
        Only you see the files you staged. A mapped file is now an employee document and cannot be changed. You can discard a file still waiting to be mapped (for example
        one that failed the safety check or was staged by mistake); it stays on record, and you can stage a file with the same name again.
      </Hint>
      {discarded && <Notice notice={{ text: `${discarded} was discarded. It stays on record under Discarded and can never be mapped.`, ok: true }} />}
      <Refusal error={discard.error} words={DISCARD_WORDS} />
      {list.isPending && <LoadingLine>Loading staged files…</LoadingLine>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot list staged documents.</NotPermitted> : <ErrorNote error={list.error} />}
      {list.data && items.length === 0 && <Empty>{page === 1 ? tab.empty : 'No staged files on this page.'}</Empty>}
      {items.length > 0 && (
        <Table aria-label={tab.table}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">File</TableHead>
              <TableHead scope="col">Staged</TableHead>
              <TableHead scope="col">Safety check</TableHead>
              {state === 'MAPPED' && <TableHead scope="col">Mapped</TableHead>}
              {state === 'DISCARDED' && <TableHead scope="col">Discarded</TableHead>}
              {state === 'UNMAPPED' && (
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((f) => (
              <TableRow key={f.id}>
                <TableCell>{f.fileName}</TableCell>
                <TableCell>{formatDate(f.uploadedAt)}</TableCell>
                <TableCell>
                  <ScanBadge state={f.scanState} />
                </TableCell>
                {state === 'MAPPED' && <TableCell>{formatDate(f.mappedAt)}</TableCell>}
                {state === 'DISCARDED' && <TableCell>{formatDate(f.discardedAt)}</TableCell>}
                {state === 'UNMAPPED' && (
                  <RowActionsCell>
                    <DiscardActions
                      file={f}
                      confirming={confirming === f.id}
                      busy={discard.isPending}
                      onAsk={() => setConfirming(f.id)}
                      onConfirm={() => discard.mutate(f)}
                      onKeep={() => setConfirming(null)}
                    />
                  </RowActionsCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {list.data && <Pager page={page} pageSize={STAGED_PAGE_SIZE} total={list.data.total} onPage={turn} label="Staged file pages" noun="staged file" />}
    </Section>
  );
}

/** A staged file's discard: the first click only asks, the second (Yes, discard) sends; Keep backs out with nothing sent. */
function DiscardActions({
  file,
  confirming,
  busy,
  onAsk,
  onConfirm,
  onKeep,
}: {
  file: StagedFile;
  confirming: boolean;
  busy: boolean;
  onAsk: () => void;
  onConfirm: () => void;
  onKeep: () => void;
}) {
  if (!confirming) {
    return (
      <RowActions>
        <Button type="button" variant="danger" size="sm" disabled={busy} aria-label={`Discard ${file.fileName}`} onClick={onAsk}>
          Discard
        </Button>
      </RowActions>
    );
  }
  return (
    <RowActions>
      <Button type="button" size="sm" disabled={busy} aria-label={`Confirm discarding ${file.fileName}`} onClick={onConfirm}>
        Yes, discard
      </Button>
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onKeep}>
        Keep
      </Button>
    </RowActions>
  );
}

/**
 * The mapping batch, as the employee imports run it (records.tsx): one idempotency key per chosen file, a row-by-row
 * preview, then an explicit commit or cancel. A file waiting for the scan worker is held (UPLOADED) with nothing read, which
 * is the normal first answer; checking it again resumes that batch from its stored file (no second upload, no second batch),
 * by itself while the screen is open. The user's own batches are listed below, so a held batch can be opened again later.
 */
function MappingImport() {
  const keys = useKeys();
  const qc = useQueryClient();
  const t = MAPPING_TEMPLATE;
  const [file, setFile] = useState<File | null>(null);
  // Remounting the file input clears the chosen file once its preview is on screen.
  const [fileInput, setFileInput] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  const uploadKey = useRef<string | null>(null);
  const choose = (next: File | null) => {
    setFile(next);
    uploadKey.current = null;
  };
  // Every change to a batch changes the list of batches, and a commit maps staged files.
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.batches });
    void qc.invalidateQueries({ queryKey: keys.staged });
  };

  const act = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'commit' | 'cancel' }) => {
      // The decision and any look at the batch after it go out under the role it was made in (BR-046).
      const send = pinSession();
      try {
        return await send<ImportJob>(`${t.base}/${id}/${action}`, { method: 'POST' });
      } catch (err) {
        // The batch may have moved on (this very decision went through but its answer was lost, or the batch changed
        // since the preview): its job view shows where it stands now.
        const current = await send<ImportJob>(`${t.base}/${id}`).catch(() => null);
        if (current?.state === (action === 'commit' ? 'COMMITTED' : 'CANCELLED')) return current;
        if (current) setJob((shown) => (shown?.id === id ? current : shown));
        throw err;
      }
    },
    onSuccess: (view) => setJob(view),
    onSettled: refresh,
  });
  const upload = useMutation({
    mutationFn: async ({ f, key }: { f: File; key: string }) => api<ImportJob>(t.base, { body: { fileName: f.name, contentBase64: await fileToBase64(f), idempotencyKey: key } }),
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
      if (!(err instanceof ApiError)) return; // no answer: the same key may be sent again
      if (err.code === 'IDEMPOTENCY_KEY_IN_USE') uploadKey.current = null;
    },
    onSettled: refresh,
  });
  // A held batch, checked again from the file the server stored (POST /:id/resume): still held, or previewed.
  const resume = useMutation({
    mutationFn: (id: string) => api<ImportJob>(`${t.base}/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
    onMutate: () => {
      upload.reset();
      act.reset();
      open.reset();
    },
    onSuccess: (view) => setJob(view),
    onError: (err, id) => {
      // The server closed the held batch (its file was quarantined, or is not a valid batch): it is no longer held.
      if (err instanceof ApiError && err.status < 500) setJob((shown) => (shown?.id === id ? null : shown));
    },
    onSettled: refresh,
  });
  // One of the user's batches, opened from the list.
  const open = useMutation({
    mutationFn: (id: string) => api<ImportJob>(`${t.base}/${encodeURIComponent(id)}`),
    onMutate: () => {
      upload.reset();
      act.reset();
      resume.reset();
    },
    onSuccess: (view) => setJob(view),
  });
  // While a batch waits for the scan the screen re-checks it by itself; the button above stays for someone who comes back later.
  const watch = useHeldBatchWatch(t.base, job, { show: setJob, closed: (id) => setJob((shown) => (shown?.id === id ? null : shown)), refresh }, resume.isPending || open.isPending);

  const busy = upload.isPending || act.isPending || resume.isPending || open.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file || busy) return;
    watch.clearError();
    const key = (uploadKey.current ??= idempotencyKey('mapping'));
    upload.mutate({ f: file, key });
  };

  return (
    <>
      <Section title="Mapping file">
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Hint>
            CSV with exactly the header <code>{t.columns}</code> (template {t.code}). {t.note} Nothing is mapped until you commit a preview, and a batch is applied all or
            nothing: one row with a problem, such as an unknown employee code, rejects the whole batch and assigns nothing.
          </Hint>
          <TemplateDownload base={t.base} code={t.code} />
          <div className={FIELD_ROW}>
            <FormField className="w-auto">
              Mapping CSV file
              <Input key={fileInput} type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => choose(e.target.files?.[0] ?? null)} />
            </FormField>
            <Button type="submit" disabled={!file || busy}>
              Validate
            </Button>
          </div>
        </form>
        <Refusal error={upload.error ?? resume.error ?? watch.error} words={MAPPING_UPLOAD_WORDS} />
      </Section>
      {job && (
        <>
          <ImportJobView job={job} template={t} pending={act.isPending} onAction={(action) => act.mutate({ id: job.id, action })} error={act.error} />
          <HeldBatchCheck job={job} busy={busy} onCheck={() => resume.mutate(job.id)} checked={resume.isPending ? undefined : resume.data} watch={watch} />
        </>
      )}
      <MappingBatches openedId={job?.id ?? null} busy={busy} onOpen={(id) => open.mutate(id)} error={open.error} />
    </>
  );
}

/** A batch's rows in words: how many were mapped once committed, otherwise how many the file has (a dash before it is read). */
function batchRowsText(b: MappingBatchPage['items'][number]): string {
  if (b.state === 'COMMITTED') return `${b.acceptedCount} mapped`;
  return b.rowCount === null ? '—' : String(b.rowCount);
}

/** The user's own mapping batches, newest first, a page at a time (GET /v1/documents/mapping-imports). */
function MappingBatches({ openedId, busy, onOpen, error }: { openedId: string | null; busy: boolean; onOpen: (id: string) => void; error: unknown }) {
  const keys = useKeys();
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: keys.batchesPage(page),
    queryFn: () => api<MappingBatchPage>(`${MAPPING_TEMPLATE.base}?page=${page}&pageSize=${BATCHES_PAGE_SIZE}`),
    retry: retryTransient,
  });
  const items = list.data?.items ?? [];
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / BATCHES_PAGE_SIZE));
  return (
    <Section title="Your mapping batches">
      <Hint>
        Only you see the mapping files you uploaded. Open a batch to see its rows; one still waiting for its scan can be checked again and then committed or cancelled.
      </Hint>
      {list.isPending && <LoadingLine>Loading your mapping batches…</LoadingLine>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot list mapping batches.</NotPermitted> : <ErrorNote error={list.error} />}
      <Refusal error={error} words={{ NOT_FOUND: 'This batch is not available to the selected role.' }} />
      {list.data && items.length === 0 && <Empty>{page === 1 ? 'You have not uploaded a mapping file yet.' : 'No batches on this page.'}</Empty>}
      {items.length > 0 && (
        <Table aria-label="Your mapping batches">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Mapping file</TableHead>
              <TableHead scope="col">Uploaded</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Safety check</TableHead>
              <TableHead scope="col">Rows</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((b) => {
              const state = BATCH_STATES[b.state];
              const name = b.fileName ?? 'mapping file';
              return (
                <TableRow key={b.id}>
                  <TableCell>{name}</TableCell>
                  <TableCell>{formatDate(b.createdAt)}</TableCell>
                  <TableCell>
                    <Badge tone={state?.tone ?? 'neutral'}>{state?.label ?? b.state}</Badge>
                  </TableCell>
                  <TableCell>
                    <ScanBadge state={b.scanState} />
                  </TableCell>
                  <TableCell>{batchRowsText(b)}</TableCell>
                  <RowActionsCell>
                    {b.id === openedId ? (
                      <Hint as="span">open above</Hint>
                    ) : (
                      <RowActions>
                        <Button type="button" variant="outline" size="sm" disabled={busy} aria-label={`Open ${name} uploaded ${formatDate(b.createdAt)}`} onClick={() => onOpen(b.id)}>
                          Open
                        </Button>
                      </RowActions>
                    )}
                  </RowActionsCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {pages > 1 && (
        <PagerRow>
          <PagerButton disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Newer batches
          </PagerButton>
          <PagerCount>
            Page {page} of {pages}
          </PagerCount>
          <PagerButton disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Older batches
          </PagerButton>
        </PagerRow>
      )}
    </Section>
  );
}
