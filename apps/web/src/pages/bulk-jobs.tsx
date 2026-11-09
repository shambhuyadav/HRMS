// My background jobs (NFR-S09; ADR-15). A company-wide task (attendance processing for a work date, monthly leave
// accrual, an increment review opening) never runs on the request that starts it: the request is checked and the work
// is queued as a background job that runs in bounded parts. These screens show the requester's own jobs (the server
// serves a job only to the person who started it, under the role it was started with, while that role still holds the
// job's permission): its kind and state in words, its progress, the counts in its result and, when it stopped or a
// part is being retried, the error class in plain words. A job still queued or running is asked about again every few
// seconds; once it is completed or failed, it is not asked about again. Nothing here changes a job.
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Section } from '../ui';

/** GET /v1/bulk-jobs/:id (modules/bulk/service.ts jobView). */
export interface BulkJob {
  id: string;
  kind: string;
  state: string;
  parameters: Record<string, unknown>;
  processed: number;
  /** Counts and fixed values only (the kind's running totals). */
  result: Record<string, unknown>;
  errorCode: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** How often a queued or running job is asked about again. */
export const BULK_JOB_POLL_MS = 3000;
/** GET /v1/bulk-jobs answers at most 100 jobs; the newest 50 are shown. */
const LIST_LIMIT = 50;

const PATHS = { list: '/bulk-jobs', job: (id: string) => `/bulk-jobs/${encodeURIComponent(id)}` } as const;

const KIND_LABEL: Record<string, string> = {
  ATTENDANCE_PROCESSING: 'Attendance processing',
  LEAVE_ACCRUAL: 'Monthly leave accrual',
  INCREMENT_REVIEW_OPENING: 'Increment review opening',
  LEAVE_YEAR_END: 'Leave year-end expiry',
};

const STATE_LABEL: Record<string, string> = { QUEUED: 'Queued', RUNNING: 'Running', COMPLETED: 'Completed', FAILED: 'Failed' };
const STATE_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = { QUEUED: 'neutral', RUNNING: 'warn', COMPLETED: 'good', FAILED: 'bad' };

/** The counts in each kind's result, in words, in the order shown. Other result fields are not counts. */
const COUNT_LABELS: Record<string, readonly [field: string, label: string][]> = {
  ATTENDANCE_PROCESSING: [
    ['employees', 'Employees evaluated'],
    ['CREATED', 'Attendance records created'],
    ['UPDATED', 'Attendance records updated'],
    ['UNCHANGED', 'Attendance records unchanged'],
    ['SKIPPED_AMENDED', 'Amended records left as they are'],
    ['SKIPPED_LOCKED', 'Days a processed payroll used, left as they are'],
    ['NO_POLICY', 'Employees without an attendance policy'],
  ],
  LEAVE_ACCRUAL: [['credited', 'Leave accruals credited']],
  LEAVE_YEAR_END: [
    ['employees', 'Employees looked at'],
    ['expired', 'Balances expired above the carry cap'],
    ['withinCap', 'Balances within the carry cap'],
    ['pendingRequests', 'Held back by a pending request'],
    ['notConfigured', 'Policies without a leave year'],
  ],
  INCREMENT_REVIEW_OPENING: [
    ['created', 'Draft cases created'],
    ['excluded', 'Employees excluded'],
  ],
};

/** Why an increment review opening excluded an employee (modules/increment/roster.ts EXCLUSION_REPAIR codes). */
const EXCLUSION_REASON_LABEL: Record<string, string> = {
  ALREADY_IN_REVIEW: 'Already in review',
  REVIEW_RESCHEDULED: 'Review moved by an approved override',
  ON_NOTICE: 'On notice',
  SEPARATION_BEFORE_EFFECTIVE_DATE: 'Leaves before the effective date',
  NOT_CONFIRMED: 'Not confirmed',
  JOINED_AFTER_CUTOFF: 'Joined after the cutoff',
  JOINED_AFTER_EFFECTIVE_DATE: 'Joins after the effective date',
  SERVICE_INTERVAL_NOT_COMPLETED: 'Service interval not completed',
  APPRAISAL_NOT_COMPLETED: 'Required appraisal not approved',
  NO_SALARY_BASELINE: 'No salary in force before the effective date',
  ROSTER_FROZEN: 'Roster frozen',
};

/** Error classes in plain words (a job never carries an error message, which could hold values). */
const ERROR_TEXT: Record<string, string> = {
  ACCESS_REVOKED: 'The role that started this job no longer holds the permission or the scope the job needs, so the job stopped.',
  FORBIDDEN: 'The role that started this job is not permitted to run it.',
  CYCLE_NOT_CONFIGURED: 'The increment cycle revision is no longer an activated revision of this company.',
  CYCLE_NOT_EFFECTIVE: 'The increment cycle revision no longer governs this review period.',
  POLICY_AMBIGUOUS: 'More than one attendance policy applies equally to an employee.',
};

function readable(code: string): string {
  const text = code.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const jobKindLabel = (kind: string) => KIND_LABEL[kind] ?? readable(kind);
export const exclusionReasonLabel = (code: string) => EXCLUSION_REASON_LABEL[code] ?? readable(code);

/** The error class of a job in plain words; the class itself is shown next to it for support. */
export function jobErrorText(code: string): string {
  const known = ERROR_TEXT[code];
  if (known) return known;
  if (/^PG_[A-Z0-9]{5}$/.test(code)) return 'A database error stopped a part of this job.';
  return `${readable(code)}.`;
}

/** Still to run or running: asked about again until it is completed or failed. */
export const jobActive = (job: BulkJob | undefined) => job?.state === 'QUEUED' || job?.state === 'RUNNING';

const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const formatInstant = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');

const isStatus = (error: unknown, status: number) => error instanceof ApiError && error.status === status;
/** A refusal or bad request will not change on retry; only transient failures are retried (once). */
const retryTransient = (failureCount: number, error: Error) => !(error instanceof ApiError && error.status < 500) && failureCount < 1;

/** Query keys carry the selected company and assignment: jobs belong to the role they were started with. */
function useJobKeys() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(() => ({ list: ['bulk-jobs', context, 'list'] as const, job: (id: string) => ['bulk-jobs', context, 'job', id] as const }), [context]);
}

/**
 * One job, asked about again every BULK_JOB_POLL_MS while it is queued or running, and never again once it is done or
 * refused. Only one reader of a job polls (BulkJobStatus); another reader on the same screen passes `poll: false` and
 * gets the same answers from the shared cache.
 */
export function useBulkJob(jobId: string, options: { poll?: boolean } = {}) {
  const keys = useJobKeys();
  const poll = options.poll ?? true;
  return useQuery({
    queryKey: keys.job(jobId),
    queryFn: () => api<BulkJob>(`/v1/bulk-jobs/${encodeURIComponent(jobId)}`),
    refetchInterval: (query) => (poll && query.state.status !== 'error' && jobActive(query.state.data) ? BULK_JOB_POLL_MS : false),
    retry: retryTransient,
  });
}

function StateBadge({ state }: { state: string }) {
  return <Badge tone={STATE_TONE[state] ?? 'neutral'}>{STATE_LABEL[state] ?? readable(state)}</Badge>;
}

function Item({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** What the job was started for, in words (from its parameters and the fixed values of its result). */
function subject(job: BulkJob): string | null {
  const p = job.parameters;
  const r = job.result;
  if (job.kind === 'ATTENDANCE_PROCESSING' && typeof p.workDate === 'string') return `Work date ${p.workDate}`;
  if (job.kind === 'LEAVE_ACCRUAL' && typeof p.month === 'string') return `Month ${p.month}`;
  if (job.kind === 'LEAVE_YEAR_END' && typeof p.yearEnd === 'string') return `Leave year ending ${p.yearEnd}`;
  if (job.kind === 'INCREMENT_REVIEW_OPENING') {
    const period = typeof r.period === 'string' ? r.period : typeof p.year === 'number' ? String(p.year) : null;
    const cycle = typeof r.cycleCode === 'string' ? `cycle ${r.cycleCode}, ` : '';
    return period ? `Review of ${cycle}period ${period}` : null;
  }
  return null;
}

/** The counts of the job's result in words; for a review opening, the excluded employees by reason as well. */
function ResultCounts({ job }: { job: BulkJob }) {
  const rows = (COUNT_LABELS[job.kind] ?? []).map(([field, label]) => [label, count(job.result[field])] as const).filter(([, n]) => n !== null);
  const byReason = job.kind === 'INCREMENT_REVIEW_OPENING' && job.result.excludedByReason && typeof job.result.excludedByReason === 'object' ? job.result.excludedByReason : null;
  const reasons = byReason ? Object.entries(byReason as Record<string, unknown>).filter(([, n]) => count(n) !== null) : [];
  if (rows.length === 0) return null;
  return (
    <>
      {rows.map(([label, n]) => (
        <Item key={label} term={label}>
          {n}
        </Item>
      ))}
      {reasons.map(([code, n]) => (
        <Item key={code} term={`Excluded: ${exclusionReasonLabel(code).toLowerCase()}`}>
          {String(n)}
        </Item>
      ))}
    </>
  );
}

/** Why the job stopped, or why a part of it waits for a retry, in plain words. */
function JobProblem({ job }: { job: BulkJob }) {
  if (!job.errorCode) return null;
  if (job.state === 'FAILED') {
    return (
      <p role="alert" className="error">
        Stopped: {jobErrorText(job.errorCode)} Work done before it stopped is kept. (Error class {job.errorCode})
      </p>
    );
  }
  return (
    <p className="hint">
      A part of this job failed: {jobErrorText(job.errorCode)} It is retried automatically
      {job.nextAttemptAt ? ` at ${formatInstant(job.nextAttemptAt)}` : ''}. (Error class {job.errorCode}, attempt {job.attempts})
    </p>
  );
}

interface UnprocessedPage {
  items: { employeeId: string; employeeCode: string; employeeName: string; errorCode: string | null }[];
  nextAfter: string | null;
}

/**
 * FR-022 "processing failures list affected employees": who an attendance job that stopped, or is waiting for a retry,
 * has not processed, the one it stopped on with the error class. Operational fields only; the server applies the
 * requester and row scope rules.
 */
function UnprocessedEmployees({ jobId }: { jobId: string }) {
  const keys = useJobKeys();
  const [after, setAfter] = useState<string | null>(null);
  const page = useQuery({
    queryKey: [...keys.job(jobId), 'unprocessed', after],
    queryFn: () => api<UnprocessedPage>(`/v1/attendance/processing/${encodeURIComponent(jobId)}/unprocessed-employees${after ? `?after=${encodeURIComponent(after)}` : ''}`),
    retry: retryTransient,
  });
  return (
    <div>
      <h3>Employees not processed</h3>
      <ErrorNote error={page.error} />
      {page.data?.items.length === 0 && <Empty>Every employee in your scope was processed.</Empty>}
      {!!page.data?.items.length && (
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Employee</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {page.data.items.map((e) => (
              <tr key={e.employeeId}>
                <td>{e.employeeCode}</td>
                <td>{e.employeeName}</td>
                <td>{e.errorCode ? `The job stopped on this employee: ${jobErrorText(e.errorCode)} (${e.errorCode})` : 'Not reached'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {page.data?.nextAfter && (
        <button type="button" className="secondary" onClick={() => setAfter(page.data!.nextAfter)}>
          Next employees
        </button>
      )}
    </div>
  );
}

/**
 * A job's live status: kind, state, progress, the counts of its result and its error class in plain words. Used by
 * the job screen and by the screen that started the job (e.g. the increment review opening).
 */
export function BulkJobStatus({ jobId }: { jobId: string }) {
  const job = useBulkJob(jobId);
  // Shown only from the latest successful answer: a job the server now refuses is not shown from the cache.
  const data = job.isSuccess ? job.data : undefined;
  return (
    <div role="region" aria-label="Background job status" aria-live="polite">
      {job.isPending && <p className="hint">Loading the job…</p>}
      {isStatus(job.error, 404) && (
        <p role="note" className="hint">
          This job does not exist, or it was started by someone else or under another role.
        </p>
      )}
      {isStatus(job.error, 403) && (
        <p role="note">
          <Badge tone="warn">not permitted</Badge> The selected role no longer holds the permission this job was started under.
        </p>
      )}
      {job.error && !isStatus(job.error, 404) && !isStatus(job.error, 403) && <ErrorNote error={job.error} />}
      {data && (
        <>
          <dl className="kv">
            <Item term="Job">{jobKindLabel(data.kind)}</Item>
            {subject(data) && <Item term="For">{subject(data)}</Item>}
            <Item term="State">
              <StateBadge state={data.state} />
            </Item>
            <Item term="Employees processed">{data.processed}</Item>
            <ResultCounts job={data} />
            <Item term="Started">{formatInstant(data.startedAt)}</Item>
            {data.finishedAt && <Item term="Finished">{formatInstant(data.finishedAt)}</Item>}
          </dl>
          {jobActive(data) && <p className="hint">{data.state === 'QUEUED' ? 'Waiting for a background worker.' : 'Running in the background.'} This status refreshes by itself.</p>}
          <JobProblem job={data} />
          {data.kind === 'ATTENDANCE_PROCESSING' && data.errorCode && data.errorCode !== 'ACCESS_REVOKED' && <UnprocessedEmployees jobId={data.id} />}
        </>
      )}
    </div>
  );
}

function BulkJobsScreen() {
  const keys = useJobKeys();
  const jobs = useQuery({
    queryKey: keys.list,
    queryFn: () => api<{ items: BulkJob[] }>(`/v1/bulk-jobs?${new URLSearchParams({ limit: String(LIST_LIMIT) })}`),
    refetchInterval: (query) => (query.state.status !== 'error' && query.state.data?.items.some(jobActive) ? BULK_JOB_POLL_MS : false),
    retry: retryTransient,
  });
  const items = jobs.isSuccess ? jobs.data.items : [];
  return (
    <>
      <h1>My background jobs</h1>
      <Section title="Jobs you started">
        <p className="hint">
          Company-wide tasks such as attendance processing, monthly leave accrual and increment review openings run in the background. Only the person who started
          a job sees it, under the role it was started with.
        </p>
        {jobs.isPending && <p className="hint">Loading jobs…</p>}
        <ErrorNote error={jobs.error} />
        {jobs.isSuccess && items.length === 0 && <Empty>You have started no background jobs under the selected role.</Empty>}
        {items.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">For</th>
                  <th scope="col">State</th>
                  <th scope="col">Employees processed</th>
                  <th scope="col">Started</th>
                  <th scope="col">Finished</th>
                </tr>
              </thead>
              <tbody>
                {items.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <Link to={PATHS.job(j.id)}>{jobKindLabel(j.kind)}</Link>
                    </td>
                    <td>{subject(j) ?? '—'}</td>
                    <td>
                      <StateBadge state={j.state} />
                      {j.errorCode && <span className="hint"> {jobErrorText(j.errorCode)}</span>}
                    </td>
                    <td>{j.processed}</td>
                    <td>{formatInstant(j.startedAt)}</td>
                    <td>{formatInstant(j.finishedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {items.length === LIST_LIMIT && <p className="hint">Showing your {LIST_LIMIT} newest jobs.</p>}
      </Section>
    </>
  );
}

function BulkJobScreen() {
  const { id = '' } = useParams();
  return (
    <>
      <h1>Background job</h1>
      <p>
        <Link to={PATHS.list}>My background jobs</Link>
      </p>
      <Section title="Status">
        <BulkJobStatus jobId={id} />
      </Section>
    </>
  );
}

/** Every user may have jobs of their own, so the screens need no permission key; the server serves only the requester. */
export const BULK_JOBS_SCREENS: ScreenRoute[] = [
  { path: PATHS.list, title: 'My background jobs', nav: true, component: BulkJobsScreen },
  { path: '/bulk-jobs/:id', title: 'Background job', nav: false, component: BulkJobScreen },
];
