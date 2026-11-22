// ---------------------------------------------------------------------------------------------------------
// The user's own batches of one import and a batch held for the malware scan (imports/routes.ts; FR-106; NFR-S09): every
// import lists its submitter's batches (GET <base>, paged, job facts only) and resumes a held one from the file the server
// stored (POST <base>/:id/resume), so a held batch is found again after leaving the page and needs no second upload.
// Every stored file waits for the scan worker, so a held batch is the normal first answer: the screen re-checks it by itself.
// The import screens here and in salary, payroll, lifecycle-documents, attendance-admin, timesheet and appraisal use these;
// documents.tsx has its own follow-up calls for the mapping and shares the watch.
// ---------------------------------------------------------------------------------------------------------
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlertIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ButtonRow } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { PagerButton, PagerCount, PagerRow } from '@/components/pager';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, formatDate, pinSession, retryTransient } from '../../api';
import { HELD_BATCH_CHECK_INTERVAL_MS, HELD_BATCH_MAX_CHECKS } from '../../held-batch-timing';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, NotPermitted, Section } from '../../ui';
import { DATE_CELL } from './layout';
import type { ImportJob } from './templates';

/** What a batch waiting for the scan says: a normal short wait, nothing wrong. */
export const HELD_BATCH_NOTE = 'The file is waiting for the malware scan, so nothing in it has been read yet. This is usually a short wait. You can cancel the import meanwhile; the batch stays in your batches below.';

/** GET <base>: one of the caller's own batches, job facts only (GET <base>/:id has the rows). */
export interface ImportBatch {
  id: string;
  state: string;
  template: string | null;
  fileName: string | null;
  rowCount: number | null;
  acceptedCount: number;
  rejectedCount: number;
  scanState: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ImportBatchPage {
  items: ImportBatch[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET <base> pages: 25, 50 or 100 batches. */
const BATCHES_PAGE_SIZE = 25;

/** The query-key prefix of one import's list of batches: every change to one of its batches refreshes it. */
export const importBatchesKey = (base: string) => ['import-batches', base] as const;

/** A batch's state in plain words (imports/jobs.ts). */
const BATCH_STATES: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  UPLOADED: { label: 'waiting for the scan', tone: 'neutral' },
  PREVIEWED: { label: 'previewed, not committed', tone: 'warn' },
  COMMITTED: { label: 'committed', tone: 'good' },
  REJECTED: { label: 'rejected, nothing applied', tone: 'bad' },
  CANCELLED: { label: 'cancelled, nothing applied', tone: 'neutral' },
};

/** A batch's rows: how many were applied once it is committed, otherwise how many it holds (a dash before it is read). */
function rowsText(b: ImportBatch): string {
  if (b.state === 'COMMITTED') return `${b.acceptedCount} applied`;
  return b.rowCount === null ? '—' : String(b.rowCount);
}

function BatchScan({ state }: { state: string | null }) {
  if (state === 'CLEAN') return <Badge tone="good">released</Badge>;
  if (state === 'QUARANTINED') return <Badge tone="bad">quarantined by the malware scan</Badge>;
  if (state === 'PENDING_SCAN') return <Badge>waiting for the malware scan</Badge>;
  // A batch from before import files were scanned: never committed (imports/jobs.ts commitBatch).
  return <Badge>not scanned</Badge>;
}

/**
 * The follow-up calls of one import: resuming a batch held for the malware scan from its stored file (still held, or
 * previewed) and opening one of the user's batches from the list. `show` puts the answer on screen; `closed` hears of a
 * held batch the server closed instead (422: its file was quarantined, or is not a valid batch); `onStart` clears the
 * screen's other answers. `refresh` reads the list of batches again; every change to a batch calls it. `job` is the batch
 * on screen: while it is held, `watch` re-checks it by itself. A refusal from an automatic check reads as `resume.error`, as
 * one from the button does, and `resume.reset` clears it.
 */
export function useBatchFollowUp(base: string, on: { show: (job: ImportJob) => void; closed: (id: string) => void; onStart: () => void }, job: Pick<ImportJob, 'id' | 'state'> | null) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: importBatchesKey(base) });
  const resume = useMutation({
    mutationFn: (id: string) => api<ImportJob>(`${base}/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
    onMutate: () => {
      on.onStart();
      open.reset();
    },
    onSuccess: (view) => on.show(view),
    onError: (err, id) => {
      if (err instanceof ApiError && err.status === 422) on.closed(id);
    },
    onSettled: refresh,
  });
  const open = useMutation({
    mutationFn: (id: string) => api<ImportJob>(`${base}/${encodeURIComponent(id)}`),
    onMutate: () => {
      on.onStart();
      resume.reset();
    },
    onSuccess: (view) => on.show(view),
  });
  const watch = useHeldBatchWatch(base, job, { show: on.show, closed: on.closed, refresh }, resume.isPending || open.isPending);
  return {
    resume: {
      ...resume,
      error: resume.error ?? watch.error,
      reset: () => {
        resume.reset();
        watch.clearError();
      },
    },
    open,
    refresh,
    watch,
  };
}

export interface HeldBatchWatch {
  /** The screen no longer re-checks this held batch by itself: the manual check, or opening it again, starts over. */
  stopped: boolean;
  /** A refusal from an automatic check; it stays until the screen shows another batch or clears it. */
  error: Error | null;
  clearError: () => void;
}

/**
 * While `job` is a batch waiting for the malware scan and the screen is open, re-checks it through POST <base>/:id/resume every
 * HELD_BATCH_CHECK_INTERVAL_MS, so a normal import reaches its preview without a click. It stops at any other state, after
 * HELD_BATCH_MAX_CHECKS checks and at a refusal, waits while the tab is hidden or `paused` (another call on this batch is on its
 * way), and ends with the screen. Any new view of a held batch (the upload's answer, the manual check, opening it) starts
 * over. Separate from the manual check on purpose: a quiet check clears nobody's error and disables no button. Its answer
 * applies only while the same batch is still held on screen under the role that asked (BR-046), so it can never replace a
 * newer view. A still-held answer changes nothing on screen.
 */
export function useHeldBatchWatch(base: string, job: Pick<ImportJob, 'id' | 'state'> | null, on: { show: (job: ImportJob) => void; closed: (id: string) => void; refresh: () => void }, paused: boolean): HeldBatchWatch {
  const heldId = job?.state === 'UPLOADED' ? job.id : null;
  const [checks, setChecks] = useState(0);
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const send = useRef(pinSession());
  const latest = useRef({ heldId, on });
  latest.current = { heldId, on };

  // A new view on screen starts over. When the server closed the batch there is no view, and its refusal stays to be read.
  useEffect(() => {
    if (!job) return;
    send.current = pinSession();
    setChecks(0);
    setRefused(false);
    setError(null);
  }, [job]);

  useEffect(() => {
    const onChange = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  // An answer that arrives after the screen has gone is dropped.
  useEffect(
    () => () => {
      latest.current = { ...latest.current, heldId: null };
    },
    [],
  );

  const check = async (id: string) => {
    const pinned = send.current;
    const stale = () => latest.current.heldId !== id || !pinned.isCurrent();
    try {
      const view = await pinned<ImportJob>(`${base}/${encodeURIComponent(id)}/resume`, { method: 'POST' });
      if (stale()) return;
      if (view.state === 'UPLOADED') {
        setChecks((n) => n + 1);
        return;
      }
      latest.current.on.show(view);
      latest.current.on.refresh();
    } catch (err) {
      if (stale()) return;
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        setError(err);
        setRefused(true);
        // 422: the server closed the batch (its file was quarantined, or is not a valid batch). Any other refusal leaves it on screen.
        if (err.status === 422) latest.current.on.closed(id);
        latest.current.on.refresh();
      } else {
        // No answer, or a server that is struggling: the next check asks again, and the limit still ends it.
        setChecks((n) => n + 1);
      }
    }
  };

  const stopped = heldId !== null && (refused || checks >= HELD_BATCH_MAX_CHECKS);
  const waiting = heldId !== null && !stopped && !hidden && !paused;
  useEffect(() => {
    if (!waiting || heldId === null) return;
    const timer = setTimeout(() => void check(heldId), HELD_BATCH_CHECK_INTERVAL_MS);
    return () => clearTimeout(timer);
    // `checks` re-arms the timer after each answer; `check` reads what it needs through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, heldId, checks, base]);

  return { stopped, error, clearError: () => setError(null) };
}

/** Whether the preview will come by itself, or the screen has stopped checking and the wait is longer than usual. */
export function HeldBatchWatchNote({ watch }: { watch: HeldBatchWatch }) {
  if (watch.error) return null; // the refusal is on screen and says why
  return watch.stopped ? (
    <span role="status">This is taking longer than usual, so this page has stopped checking by itself. The batch is kept: check again here, or open it from your batches below later.</span>
  ) : (
    <Hint as="span">The preview appears here by itself once the scan is done.</Hint>
  );
}

/** Under a batch waiting for the malware scan: how the wait ends, and the manual check of its stored file (POST /:id/resume) for someone who comes back later. */
export function HeldBatchCheck({ job, busy, onCheck, checked, watch }: { job: ImportJob; busy: boolean; onCheck: () => void; checked: ImportJob | undefined; watch: HeldBatchWatch }) {
  if (job.state !== 'UPLOADED') return null;
  return (
    <ButtonRow>
      <HeldBatchWatchNote watch={watch} />
      <Button type="button" variant="outline" disabled={busy} onClick={onCheck}>
        Check the scan again
      </Button>
      <Hint as="span">Checks the file you uploaded for this batch, without uploading it again; the batch is previewed once the scan releases it.</Hint>
      {checked?.id === job.id && checked.state === 'UPLOADED' && <span role="status">Still waiting for the malware scan.</span>}
    </ButtonRow>
  );
}

/** Opening a batch the selected role may not see: said in plain words, the server's code beneath for reference. */
function BatchNotAvailable({ code }: { code: string }) {
  return (
    <Alert variant="destructive" className="error">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>This batch is not available to the selected role.</AlertTitle>
      <AlertDescription className="block">{code}</AlertDescription>
    </Alert>
  );
}

/** The user's own batches of one import, newest first, a page at a time; Open shows one with its rows. */
export function ImportBatches({ base, title, openedId, busy, onOpen, error }: { base: string; title: string; openedId: string | null; busy: boolean; onOpen: (id: string) => void; error: unknown }) {
  const { stored } = useSession();
  const [page, setPage] = useState(1);
  const list = useQuery({
    // The selected company and assignment are part of the key: a list answered to one role is never shown under another.
    queryKey: [...importBatchesKey(base), stored?.companyId ?? '-', stored?.assignmentId ?? '-', page],
    queryFn: () => api<ImportBatchPage>(`${base}?page=${page}&pageSize=${BATCHES_PAGE_SIZE}`),
    retry: retryTransient,
  });
  const items = list.data?.items ?? [];
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / BATCHES_PAGE_SIZE));
  return (
    <Section title={title}>
      <Hint>Only you see the files you uploaded here. Open a batch to see its rows; one still waiting for its scan can be checked again and then committed or cancelled.</Hint>
      {list.isPending && <LoadingLine>Loading your batches…</LoadingLine>}
      {list.error instanceof ApiError && list.error.status === 403 ? <NotPermitted>The selected role cannot list these batches.</NotPermitted> : <ErrorNote error={list.error} />}
      {error instanceof ApiError && error.status === 404 ? <BatchNotAvailable code={error.code} /> : <ErrorNote error={error} />}
      {list.data && items.length === 0 && <Empty>{page === 1 ? 'You have not uploaded a file for this import yet.' : 'No batches on this page.'}</Empty>}
      {items.length > 0 && (
        <Table aria-label={title}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">File</TableHead>
              <TableHead scope="col">Uploaded</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Malware scan</TableHead>
              <TableHead scope="col">Rows</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((b) => {
              const state = BATCH_STATES[b.state];
              const name = b.fileName ?? 'import file';
              return (
                <TableRow key={b.id}>
                  <TableCell>{name}</TableCell>
                  <TableCell className={DATE_CELL}>{formatDate(b.createdAt)}</TableCell>
                  <TableCell>
                    <Badge tone={state?.tone ?? 'neutral'}>{state?.label ?? b.state}</Badge>
                  </TableCell>
                  <TableCell>
                    <BatchScan state={b.scanState} />
                  </TableCell>
                  <TableCell>{rowsText(b)}</TableCell>
                  <RowActionsCell>
                    {b.id === openedId ? (
                      <Hint as="span" className="whitespace-nowrap">
                        open above
                      </Hint>
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
