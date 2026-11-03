// My background jobs (NFR-S09; ADR-15), jsdom: the requester's own jobs with kind and state in words, progress and the
// counts of each result, a job screen that asks again only while the job is queued or running, error classes in plain
// words, and refusals that read as such. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BULK_JOB_POLL_MS, BULK_JOBS_SCREENS, type BulkJob } from './bulk-jobs';

vi.mock('../session', () => ({
  useSession: () => ({ stored: { token: 'tkn', companies: [], companyId: 'company-1', assignmentId: 'assignment-1' }, me: null, can: () => false }),
}));

const J_REVIEW = '70000000-0000-4000-8000-000000000001';
const J_ATTENDANCE = '70000000-0000-4000-8000-000000000002';
const J_ACCRUAL = '70000000-0000-4000-8000-000000000003';
const CYCLE = '10000000-0000-4000-8000-000000000001';

function jobOf(over: Partial<BulkJob> & Pick<BulkJob, 'id' | 'kind' | 'state'>): BulkJob {
  return {
    parameters: {},
    processed: 0,
    result: {},
    errorCode: null,
    attempts: 0,
    nextAttemptAt: null,
    createdAt: '2026-10-29T09:00:00.000Z',
    startedAt: over.state === 'QUEUED' ? null : '2026-10-29T09:00:01.000Z',
    finishedAt: over.state === 'COMPLETED' || over.state === 'FAILED' ? '2026-10-29T09:00:09.000Z' : null,
    ...over,
  };
}

const REVIEW_RUNNING = jobOf({
  id: J_REVIEW,
  kind: 'INCREMENT_REVIEW_OPENING',
  state: 'RUNNING',
  parameters: { cycleId: CYCLE, year: 2027 },
  processed: 200,
  result: { cycleId: CYCLE, cycleCode: 'ANNUAL', period: '2027', asOf: '2026-10-29', rerun: false, run: null, created: 180, excluded: 20, excludedByReason: { NOT_CONFIRMED: 20 } },
});
const REVIEW_DONE = jobOf({
  ...REVIEW_RUNNING,
  state: 'COMPLETED',
  processed: 400,
  result: { ...REVIEW_RUNNING.result, run: 1, created: 350, excluded: 50, excludedByReason: { NOT_CONFIRMED: 30, NO_SALARY_BASELINE: 20 } },
});
const ATTENDANCE_FAILED = jobOf({
  id: J_ATTENDANCE,
  kind: 'ATTENDANCE_PROCESSING',
  state: 'FAILED',
  parameters: { workDate: '2026-10-28' },
  processed: 100,
  // A per-employee list is not a count and is not shown.
  result: { workDate: '2026-10-28', employees: 100, CREATED: 90, UPDATED: 5, UNCHANGED: 3, SKIPPED_AMENDED: 1, NO_POLICY: 1, noPolicyEmployeeIds: ['20000000-0000-4000-8000-000000000009'] },
  errorCode: 'ACCESS_REVOKED',
});
const ACCRUAL_DONE = jobOf({ id: J_ACCRUAL, kind: 'LEAVE_ACCRUAL', state: 'COMPLETED', parameters: { month: '2026-09' }, processed: 500, result: { month: '2026-09', credited: 1000 } });

type Reply = [status: number, body: unknown];
let calls: { method: string; path: string; params: URLSearchParams }[] = [];
const callsTo = (path: string) => calls.filter((c) => c.path === path);

function serve(routes: Record<string, Reply | (() => Reply)>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname, params: url.searchParams });
      const route = routes[`${method} ${url.pathname}`];
      const [status, body]: Reply = route === undefined ? [404, { error: 'NOT_FOUND', message: 'Resource not found' }] : typeof route === 'function' ? route() : route;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {BULK_JOBS_SCREENS.map((s) => (
            <Route key={s.path} path={s.path} element={<s.component />} />
          ))}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const valueOf = (scope: HTMLElement, term: string) => within(scope).getByText(term).nextSibling?.textContent;
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('my background jobs (NFR-S09)', () => {
  it('lists the requester’s jobs with the kind, what it was for and the state in words, and links each job', async () => {
    serve({ 'GET /v1/bulk-jobs': [200, { items: [REVIEW_DONE, ATTENDANCE_FAILED, ACCRUAL_DONE] }] });
    renderAt('/bulk-jobs');
    expect(screen.getByRole('heading', { level: 1, name: 'My background jobs' })).toBeTruthy();
    const table = await screen.findByRole('table');
    expect(callsTo('/v1/bulk-jobs')[0]!.params.get('limit')).toBe('50');
    const review = within(table).getByRole('link', { name: 'Increment review opening' }).closest('tr') as HTMLElement;
    expect(within(review).getByText('Review of cycle ANNUAL, period 2027')).toBeTruthy();
    expect(within(review).getByText('Completed')).toBeTruthy();
    expect(within(review).getByText('400')).toBeTruthy();
    expect(within(table).getByRole('link', { name: 'Increment review opening' }).getAttribute('href')).toBe(`/bulk-jobs/${J_REVIEW}`);
    const attendance = within(table).getByRole('link', { name: 'Attendance processing' }).closest('tr') as HTMLElement;
    expect(within(attendance).getByText('Work date 2026-10-28')).toBeTruthy();
    expect(within(attendance).getByText('Failed')).toBeTruthy();
    expect(within(attendance).getByText(/no longer holds the permission/)).toBeTruthy();
    const accrual = within(table).getByRole('link', { name: 'Monthly leave accrual' }).closest('tr') as HTMLElement;
    expect(within(accrual).getByText('Month 2026-09')).toBeTruthy();
    // Nothing is running, so the list is not asked for again.
    expect(callsTo('/v1/bulk-jobs')).toHaveLength(1);
  });

  it('says so when the selected role has started no job', async () => {
    serve({ 'GET /v1/bulk-jobs': [200, { items: [] }] });
    renderAt('/bulk-jobs');
    expect(await screen.findByText('You have started no background jobs under the selected role.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('asks again about a running job until it completes, then stops, and shows the result counts in words', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let polls = 0;
    const answers = [REVIEW_RUNNING, { ...REVIEW_RUNNING, processed: 300 }, REVIEW_DONE];
    serve({ [`GET /v1/bulk-jobs/${J_REVIEW}`]: () => [200, answers[Math.min(polls++, 2)]] });
    renderAt(`/bulk-jobs/${J_REVIEW}`);
    const status = await screen.findByRole('region', { name: 'Background job status' });
    expect(await within(status).findByText('Running')).toBeTruthy();
    expect(valueOf(status, 'Job')).toBe('Increment review opening');
    expect(valueOf(status, 'For')).toBe('Review of cycle ANNUAL, period 2027');
    expect(valueOf(status, 'Employees processed')).toBe('200');
    expect(valueOf(status, 'Draft cases created')).toBe('180');
    expect(valueOf(status, 'Employees excluded')).toBe('20');
    expect(within(status).getByText(/This status refreshes by itself/)).toBeTruthy();
    expect(callsTo(`/v1/bulk-jobs/${J_REVIEW}`)).toHaveLength(1);

    await advance(BULK_JOB_POLL_MS);
    await waitFor(() => expect(valueOf(status, 'Employees processed')).toBe('300'));
    expect(within(status).getByText('Running')).toBeTruthy();
    expect(callsTo(`/v1/bulk-jobs/${J_REVIEW}`)).toHaveLength(2);
    await advance(BULK_JOB_POLL_MS);
    expect(await within(status).findByText('Completed')).toBeTruthy();
    expect(valueOf(status, 'Employees processed')).toBe('400');
    expect(valueOf(status, 'Draft cases created')).toBe('350');
    expect(valueOf(status, 'Employees excluded')).toBe('50');
    expect(valueOf(status, 'Excluded: not confirmed')).toBe('30');
    expect(valueOf(status, 'Excluded: no salary in force before the effective date')).toBe('20');
    expect(within(status).queryByText(/refreshes by itself/)).toBeNull();
    // Fixed values that are not counts are not listed as counts.
    expect(within(status).queryByText('2026-10-29')).toBeNull();

    await advance(BULK_JOB_POLL_MS * 5);
    expect(callsTo(`/v1/bulk-jobs/${J_REVIEW}`)).toHaveLength(3);
  });

  it('says in plain words why a job stopped and keeps the error class, without asking again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve({ [`GET /v1/bulk-jobs/${J_ATTENDANCE}`]: [200, ATTENDANCE_FAILED] });
    renderAt(`/bulk-jobs/${J_ATTENDANCE}`);
    const status = await screen.findByRole('region', { name: 'Background job status' });
    const alert = await within(status).findByRole('alert');
    expect(alert.textContent).toBe(
      'Stopped: The role that started this job no longer holds the permission or the scope the job needs, so the job stopped. Work done before it stopped is kept. (Error class ACCESS_REVOKED)',
    );
    expect(valueOf(status, 'Attendance records created')).toBe('90');
    expect(valueOf(status, 'Employees without an attendance policy')).toBe('1');
    expect(within(status).queryByText(/20000000-0000-4000-8000-000000000009/)).toBeNull();
    await advance(BULK_JOB_POLL_MS * 3);
    expect(callsTo(`/v1/bulk-jobs/${J_ATTENDANCE}`)).toHaveLength(1);
  });

  it('an attendance job with a failure lists who was not processed and the employee it stopped on; a locked day is counted in words (FR-022)', async () => {
    const stopped = jobOf({
      id: J_ATTENDANCE,
      kind: 'ATTENDANCE_PROCESSING',
      state: 'FAILED',
      parameters: { workDate: '2026-10-28' },
      processed: 100,
      result: { workDate: '2026-10-28', employees: 100, CREATED: 90, UPDATED: 5, UNCHANGED: 3, SKIPPED_AMENDED: 0, SKIPPED_LOCKED: 2, NO_POLICY: 0 },
      errorCode: 'POLICY_AMBIGUOUS',
    });
    serve({
      [`GET /v1/bulk-jobs/${J_ATTENDANCE}`]: [200, stopped],
      [`GET /v1/attendance/processing/${J_ATTENDANCE}/unprocessed-employees`]: [
        200,
        {
          items: [
            { employeeId: 'e-1', employeeCode: 'SYN101', employeeName: 'Synthetic Stopped', errorCode: 'POLICY_AMBIGUOUS' },
            { employeeId: 'e-2', employeeCode: 'SYN102', employeeName: 'Synthetic Left', errorCode: null },
          ],
          nextAfter: null,
        },
      ],
    });
    renderAt(`/bulk-jobs/${J_ATTENDANCE}`);
    const status = await screen.findByRole('region', { name: 'Background job status' });
    expect(await within(status).findByText('Synthetic Stopped')).toBeTruthy();
    expect(within(status).getByText(/The job stopped on this employee: More than one attendance policy applies equally/)).toBeTruthy();
    expect(within(status).getByText('Not reached')).toBeTruthy();
    expect(valueOf(status, 'Days a processed payroll used, left as they are')).toBe('2');
  });

  it('asks for no employee list for a job that completed, or one that stopped for lost access', async () => {
    serve({ [`GET /v1/bulk-jobs/${J_ATTENDANCE}`]: [200, ATTENDANCE_FAILED] });
    renderAt(`/bulk-jobs/${J_ATTENDANCE}`);
    await screen.findByRole('region', { name: 'Background job status' });
    await screen.findByRole('alert');
    expect(callsTo(`/v1/attendance/processing/${J_ATTENDANCE}/unprocessed-employees`)).toHaveLength(0);
  });

  it('says that a failed part is retried automatically while the job keeps running', async () => {
    serve({
      [`GET /v1/bulk-jobs/${J_ACCRUAL}`]: [200, jobOf({ ...ACCRUAL_DONE, state: 'RUNNING', finishedAt: null, errorCode: 'PG_40P01', attempts: 1, nextAttemptAt: '2026-10-29T09:06:00.000Z' })],
    });
    renderAt(`/bulk-jobs/${J_ACCRUAL}`);
    const status = await screen.findByRole('region', { name: 'Background job status' });
    expect(await within(status).findByText(/A part of this job failed: A database error stopped a part of this job\. It is retried automatically at/)).toBeTruthy();
    expect(within(status).getByText(/Error class PG_40P01, attempt 1/)).toBeTruthy();
    expect(within(status).queryByRole('alert')).toBeNull();
    expect(valueOf(status, 'Leave accruals credited')).toBe('1000');
  });

  it('reads a job that is not the caller’s as not found, and a lost permission as not permitted, without asking again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve({ [`GET /v1/bulk-jobs/${J_ATTENDANCE}`]: [403, { error: 'FORBIDDEN', message: 'Not permitted' }] });
    renderAt(`/bulk-jobs/${J_REVIEW}`);
    expect(await screen.findByText('This job does not exist, or it was started by someone else or under another role.')).toBeTruthy();
    cleanup();

    renderAt(`/bulk-jobs/${J_ATTENDANCE}`);
    expect(await screen.findByText('The selected role no longer holds the permission this job was started under.', { exact: false })).toBeTruthy();
    expect(screen.getByText('not permitted')).toBeTruthy();
    await advance(BULK_JOB_POLL_MS * 3);
    expect(callsTo(`/v1/bulk-jobs/${J_ATTENDANCE}`)).toHaveLength(1);
  });

  it('offers the list in the menu and the job screen through links only, with no permission key (the server serves the requester only)', () => {
    expect(BULK_JOBS_SCREENS.map(({ path, title, nav, permission }) => ({ path, title, nav, permission }))).toEqual([
      { path: '/bulk-jobs', title: 'My background jobs', nav: true, permission: undefined },
      { path: '/bulk-jobs/:id', title: 'Background job', nav: false, permission: undefined },
    ]);
  });
});
