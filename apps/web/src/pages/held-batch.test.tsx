// A batch waiting for the malware scan on every import screen (FR-106, NFR-S09). In a deployment every stored file waits for the scan
// worker, so a first upload answers 202 UPLOADED with no rows as a matter of course: the screen re-checks it by itself through POST
// <base>/:id/resume and a normal import reaches its preview without a click. The timing module is replaced only to keep the tests
// short; the screens, the shared hook and the mocked API answers are the real shapes. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentType } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HELD_BATCH_CHECK_INTERVAL_MS, HELD_BATCH_MAX_CHECKS } from '../held-batch-timing';
import { APPRAISAL_SCREENS } from './appraisal';
import { PunchImportsPage } from './attendance-admin';
import { DOCUMENTS_SCREENS } from './documents';
import { LIFECYCLE_DOCUMENTS_SCREENS } from './lifecycle-documents';
import { PAYROLL_SCREENS } from './payroll';
import { ImportsPage } from './records';
import { SALARY_SCREENS } from './salary';
import { TIMESHEET_SCREENS } from './timesheet';

vi.mock('../held-batch-timing', () => ({ HELD_BATCH_CHECK_INTERVAL_MS: 15, HELD_BATCH_MAX_CHECKS: 3 }));
vi.mock('../session', () => ({
  useSession: () => ({
    me: { userId: 'u-1', accountKey: 'syn.hr', companyName: 'Synthetic Co', roleCode: 'HR_ADMINISTRATOR', roleName: 'HR Administrator', scopeKind: 'COMPANY', employeeId: null, displayName: null, permissions: [] },
    stored: { token: 't', companies: [], companyId: 'co-1', assignmentId: 'as-1' },
    can: () => true,
  }),
}));

type Reply = [number, unknown];
const JOB = 'job-1';
const NO_BATCHES = { items: [], total: 0, page: 1, pageSize: 25 };
const job = (over: Record<string, unknown> = {}) => ({ id: JOB, state: 'UPLOADED', template: 'SYNTHETIC_V1', fileName: 'synthetic.csv', rowCount: null, acceptedCount: 0, rejectedCount: 0, scanState: 'PENDING_SCAN', rows: [], ...over });
const HELD: Reply = [202, job()];
const PREVIEW: Reply = [200, job({ state: 'PREVIEWED', scanState: 'CLEAN', rowCount: 1, rows: [{ rowNumber: 1, businessKey: 'SYN-001', state: 'VALID', errorCode: null, proposedChanges: null }] })];
const QUARANTINED: Reply = [422, { error: 'FILE_QUARANTINED', message: 'The malware scan flagged the file; nothing was read or imported' }];

/** A jsdom file read and a first render can take seconds when every page suite runs at once. */
const SLOW = { timeout: 10_000 };

/** A promise the test lets go of, so an answer lands exactly when the test wants it. */
function gate() {
  let open = () => {};
  const closed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { closed, open };
}

/**
 * Answers the upload as held and each check from `replies` in turn, the last one for good, each check once `held` lets go; any
 * other read finds an empty list. `extra` answers one more route.
 */
function mockApi(base: string, replies: Reply[], held: Promise<void> = Promise.resolve(), extra: Record<string, Reply> = {}) {
  const checks: string[] = [];
  const uploads: string[] = [];
  let next = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      let reply: Reply = extra[`${method} ${url}`] ?? [200, NO_BATCHES];
      if (method === 'POST' && url === base) {
        uploads.push(url);
        reply = HELD;
      } else if (method === 'POST' && url === `${base}/${JOB}/resume`) {
        checks.push(url);
        reply = replies[Math.min(next++, replies.length - 1)]!;
        await held;
      }
      return new Response(JSON.stringify(reply[1]), { status: reply[0], headers: { 'content-type': 'application/json' } });
    }),
  );
  return { checks, uploads };
}

const screenAt = (routes: readonly { path: string; component: ComponentType }[], path: string) => routes.find((s) => s.path === path)!.component;
const byTitle = (routes: readonly { title: string; component: ComponentType }[], title: string) => routes.find((s) => s.title === title)!.component;

const SCREENS: { name: string; base: string; file: string; submit: RegExp; Screen: () => ComponentType }[] = [
  { name: 'salary master', base: '/v1/salary-master/imports', file: 'Salary file', submit: /^Validate$/, Screen: () => screenAt(SALARY_SCREENS, '/salary-master/upload') },
  { name: 'loan requests', base: '/v1/payroll-outputs/loan-imports', file: 'Loan requests file', submit: /^Validate$/, Screen: () => screenAt(PAYROLL_SCREENS, '/payroll/loans/upload') },
  { name: 'employee imports', base: '/v1/employees/imports', file: 'Import file', submit: /^Validate$/, Screen: () => ImportsPage },
  { name: 'punch imports', base: '/v1/attendance/punch-imports', file: 'Import file', submit: /^Validate$/, Screen: () => PunchImportsPage },
  { name: 'settlement lines', base: '/v1/settlements/line-imports', file: 'Settlement lines file for several settlements (CSV)', submit: /^Validate$/, Screen: () => byTitle(LIFECYCLE_DOCUMENTS_SCREENS, 'Full and final settlements') },
  { name: 'allocation imports', base: '/v1/timesheet/allocation-imports', file: 'Import file', submit: /^Validate$/, Screen: () => screenAt(TIMESHEET_SCREENS, '/timesheet/allocation-imports') },
  { name: 'KRA upload', base: '/v1/appraisal-goal-imports', file: 'Goal file (CSV)', submit: /^Upload and preview$/, Screen: () => screenAt(APPRAISAL_SCREENS, '/appraisal/goal-upload') },
  { name: 'document mapping', base: '/v1/documents/mapping-imports', file: 'Mapping CSV file', submit: /^Validate$/, Screen: () => byTitle(DOCUMENTS_SCREENS, 'Bulk document mapping') },
];

function renderScreen(Screen: ComponentType) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Screen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const uploadFile = async (file: string, submit: RegExp) => {
  fireEvent.change(await screen.findByLabelText(file, {}, SLOW), { target: { files: [new File(['synthetic,header\n'], 'synthetic.csv', { type: 'text/csv' })] } });
  fireEvent.click(await screen.findByRole('button', { name: submit }, SLOW));
};
const pause = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const afterSeveralChecks = () => pause(HELD_BATCH_CHECK_INTERVAL_MS * 8);
const setTabHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};
const manualCheck = () => screen.findByRole('button', { name: 'Check the scan again' }, SLOW);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setTabHidden(false);
});

describe.each(SCREENS)('a batch waiting for the malware scan: $name', ({ base, file, submit, Screen }) => {
  it('held, then its preview, with no click, and the checks stop there', async () => {
    const answer = gate();
    const api = mockApi(base, [HELD, PREVIEW], answer.closed);
    renderScreen(Screen());
    await uploadFile(file, submit);
    // A normal short wait, in words: nothing here reads as a fault.
    expect(await screen.findByText(/This is usually a short wait/, {}, SLOW)).toBeTruthy();
    expect(screen.getByText('The preview appears here by itself once the scan is done.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Check the scan again' })).toBeTruthy();

    answer.open();
    expect(await screen.findByText('previewed', {}, SLOW)).toBeTruthy();
    expect(screen.queryByText(/This is usually a short wait/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check the scan again' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.uploads).toHaveLength(1); // from the stored file: no second upload
    expect(api.checks).toHaveLength(2);
    await afterSeveralChecks();
    expect(api.checks).toHaveLength(2);
  });

  it('held, then quarantined: refused in words, the batch gone from the screen, and the checks stop there', async () => {
    const answer = gate();
    const api = mockApi(base, [HELD, QUARANTINED], answer.closed);
    renderScreen(Screen());
    await uploadFile(file, submit);
    expect(await screen.findByText(/This is usually a short wait/, {}, SLOW)).toBeTruthy();
    answer.open();
    const alert = await screen.findByRole('alert', {}, SLOW);
    expect(alert.textContent).toMatch(/malware scan flagged/i);
    expect(screen.queryByText(/This is usually a short wait/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check the scan again' })).toBeNull();
    expect(api.checks).toHaveLength(2);
    await afterSeveralChecks();
    expect(api.checks).toHaveLength(2);
    expect(screen.getByRole('alert').textContent).toMatch(/malware scan flagged/i);
  });

  it('still held when the checks run out: it says so, stops asking, and the button still works and starts over', async () => {
    const api = mockApi(base, [HELD]);
    renderScreen(Screen());
    await uploadFile(file, submit);
    expect(await screen.findByText(/taking longer than usual/, {}, SLOW)).toBeTruthy();
    expect(api.checks).toHaveLength(HELD_BATCH_MAX_CHECKS);
    await afterSeveralChecks();
    expect(api.checks).toHaveLength(HELD_BATCH_MAX_CHECKS);
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(await manualCheck());
    expect(await screen.findByText('Still waiting for the malware scan.', {}, SLOW)).toBeTruthy();
    await waitFor(() => expect(api.checks.length).toBeGreaterThan(HELD_BATCH_MAX_CHECKS + 1), SLOW);
  });
});

describe('when the checks wait or end (salary master)', () => {
  const { base, file, submit, Screen } = SCREENS[0]!;

  it('asks nothing while the tab is hidden and goes on when it is shown', async () => {
    const api = mockApi(base, [HELD]);
    setTabHidden(true);
    renderScreen(Screen());
    await uploadFile(file, submit);
    await screen.findByText(/This is usually a short wait/, {}, SLOW);
    await afterSeveralChecks();
    expect(api.checks).toHaveLength(0);
    expect(screen.queryByText(/taking longer than usual/)).toBeNull();

    setTabHidden(false);
    await waitFor(() => expect(api.checks.length).toBeGreaterThan(0), SLOW);

    // Hidden again with checks under way: they wait where they are.
    setTabHidden(true);
    await pause(HELD_BATCH_CHECK_INTERVAL_MS * 2); // an answer already on its way may still land
    const whileHidden = api.checks.length;
    await afterSeveralChecks();
    expect(api.checks).toHaveLength(whileHidden);
  });

  it('asks nothing once the screen has gone, and an answer still on its way is dropped', async () => {
    const answer = gate();
    const inFlight = mockApi(base, [HELD], answer.closed);
    const first = renderScreen(Screen());
    await uploadFile(file, submit);
    await waitFor(() => expect(inFlight.checks).toHaveLength(1), SLOW);
    first.unmount();
    answer.open();
    await afterSeveralChecks();
    expect(inFlight.checks).toHaveLength(1);

    // Gone with the next check still to come: its timer goes too.
    const pending = mockApi(base, [HELD]);
    const second = renderScreen(Screen());
    await uploadFile(file, submit);
    await screen.findByText(/This is usually a short wait/, {}, SLOW);
    second.unmount();
    const atUnmount = pending.checks.length;
    await afterSeveralChecks();
    expect(pending.checks).toHaveLength(atUnmount);
  });

  it('a refusal other than a closed batch stops the checks and leaves the batch on screen with its button', async () => {
    const api = mockApi(base, [[403, { error: 'FORBIDDEN', message: 'Not permitted' }]]);
    renderScreen(Screen());
    await uploadFile(file, submit);
    expect((await screen.findByRole('alert', {}, SLOW)).textContent).toContain('FORBIDDEN');
    expect(screen.getByRole('button', { name: 'Check the scan again' })).toBeTruthy();
    expect(screen.queryByText(/taking longer than usual/)).toBeNull();
    expect(screen.queryByText('The preview appears here by itself once the scan is done.')).toBeNull();
    expect(api.checks).toHaveLength(1);
    await afterSeveralChecks();
    expect(api.checks).toHaveLength(1);
  });

  it('a check with no answer does not end the wait', async () => {
    const api = mockApi(base, [[503, { error: 'UNAVAILABLE', message: 'Try again' }], PREVIEW]);
    renderScreen(Screen());
    await uploadFile(file, submit);
    expect(await screen.findByText('previewed', {}, SLOW)).toBeTruthy();
    expect(api.checks).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a batch cancelled while a check is on its way stays cancelled when the answer lands', async () => {
    const answer = gate();
    const api = mockApi(base, [PREVIEW], answer.closed, { [`POST ${base}/${JOB}/cancel`]: [200, job({ state: 'CANCELLED' })] });
    renderScreen(Screen());
    await uploadFile(file, submit);
    await waitFor(() => expect(api.checks).toHaveLength(1), SLOW);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel import' }, SLOW));
    expect(await screen.findByText('cancelled', {}, SLOW)).toBeTruthy();
    answer.open();
    await afterSeveralChecks();
    expect(api.checks).toHaveLength(1);
    expect(screen.queryByText('previewed')).toBeNull();
    expect(screen.getByText('cancelled')).toBeTruthy();
  });

  it('a new upload while a check on the old batch is on its way shows the new batch, whatever the old answer says', async () => {
    const answer = gate();
    const second = job({ id: 'job-2', fileName: 'second.csv' });
    const api = mockApi(base, [PREVIEW], answer.closed, { [`POST ${base}/job-2/resume`]: [202, second] });
    const stubbed = vi.mocked(fetch).getMockImplementation()!;
    let uploads = 0;
    vi.mocked(fetch).mockImplementation(async (url, init) =>
      init?.method === 'POST' && String(url) === base && ++uploads === 2 ? new Response(JSON.stringify(second), { status: 202, headers: { 'content-type': 'application/json' } }) : stubbed(url as string, init),
    );
    renderScreen(Screen());
    await uploadFile(file, submit);
    await waitFor(() => expect(api.checks).toHaveLength(1), SLOW);
    await uploadFile(file, submit);
    expect(await screen.findByText(/second\.csv/, {}, SLOW)).toBeTruthy();
    answer.open();
    await pause(HELD_BATCH_CHECK_INTERVAL_MS * 2);
    expect(screen.queryByText('previewed')).toBeNull();
    expect(screen.getByText(/second\.csv/)).toBeTruthy();
  });
});

describe('the batch list in plain words', () => {
  it('names a waiting batch as waiting, not held, in the shared list', async () => {
    const facts = { id: JOB, state: 'UPLOADED', template: 'SALARY_MASTER_V1', fileName: 'waiting.csv', rowCount: null, acceptedCount: 0, rejectedCount: 0, scanState: 'PENDING_SCAN', createdAt: '2026-11-05T09:00:00.000Z', updatedAt: '2026-11-05T09:00:00.000Z' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [facts], total: 1, page: 1, pageSize: 25 }), { status: 200, headers: { 'content-type': 'application/json' } })));
    renderScreen(SCREENS[0]!.Screen());
    const row = (await screen.findByText('waiting.csv', {}, SLOW)).closest('tr')!;
    expect(row.textContent).toContain('waiting for the scan');
    expect(row.textContent).toContain('waiting for the malware scan');
    expect(row.textContent).not.toContain('held');
  });
});
