// Attendance administration (jsdom; FR-019, FR-020; DF09): the punch import's partial acceptance in plain words, its
// commit, error report and held batches; the policy screen's thresholds, warnings, draft maintenance, independent
// activation and retirement. Duties decide what is offered. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATTENDANCE_ADMIN_SCREENS, type AttendancePolicy } from './attendance-admin';

// The automatic re-check of a waiting batch has its own tests (held-batch.test.tsx): here the manual check is on its own.
vi.mock('../held-batch-timing', () => ({ HELD_BATCH_CHECK_INTERVAL_MS: 3_600_000, HELD_BATCH_MAX_CHECKS: 30 }));
const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({ stored: { companyId: 'c-1', assignmentId: 'a-1' }, me: { employeeId: null, scopeKind: 'COMPANY' }, can: (p: string) => session.permissions.includes(p) }),
}));

type Reply = [number, unknown];
type Call = { method: string; url: string; body: Record<string, unknown> | undefined };
function mockApi(routes: Record<string, Reply | ((c: Call) => Reply)>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      const key = Object.keys(routes)
        .filter((k) => `${call.method} ${url}`.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const route = key === undefined ? undefined : routes[key];
      const [status, body]: Reply = route === undefined ? [404, { error: 'NOT_FOUND', message: 'Not found' }] : typeof route === 'function' ? route(call) : route;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}
const open = (path: string) => {
  const Page = ATTENDANCE_ADMIN_SCREENS.find((s) => s.path === path)!.component;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};
const click = (el: HTMLElement) => fireEvent.click(el);
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NO_BATCHES = { items: [], total: 0, page: 1, pageSize: 25 };
const BASE = '/v1/attendance/punch-imports';
const JOB = {
  id: 'job-1',
  state: 'PREVIEWED',
  template: 'ATTENDANCE_PUNCH_V1',
  fileName: 'march.csv',
  rowCount: 4,
  acceptedCount: 0,
  rejectedCount: 0,
  rows: [
    { rowNumber: 1, businessKey: 'E1 IN @ 2026-03-02T09:00:00+05:30', state: 'VALID', errorCode: null, proposedChanges: null },
    { rowNumber: 2, businessKey: 'NOPE IN @ 2026-03-02T09:00:00+05:30', state: 'QUARANTINED', errorCode: 'UNKNOWN_EMPLOYEE', proposedChanges: null },
    { rowNumber: 3, businessKey: 'E1 IN @ 2026-03-02T09:00:00+05:30', state: 'REJECTED', errorCode: 'REPEATED_PUNCH', proposedChanges: null },
    { rowNumber: 4, businessKey: 'E2 IN @ 2026-03-02T09:00:00+05:30', state: 'VALID', errorCode: null, proposedChanges: { repeatOfSource: { from: null, to: 'biometric:GATE' } } },
  ],
};
const COMMITTED = {
  ...JOB,
  state: 'COMMITTED',
  acceptedCount: 2,
  rejectedCount: 2,
  rows: JOB.rows.map((r) => (r.state === 'VALID' ? { ...r, state: 'ACCEPTED' } : r)),
};
const chooseFile = async () => {
  const input = screen.getByLabelText('Import file');
  fireEvent.change(input, { target: { files: [new File(['employeeCode\r\nE1'], 'march.csv', { type: 'text/csv' })] } });
  click(screen.getByRole('button', { name: 'Validate' }));
};

describe('punch imports (FR-019, DF09)', () => {
  it('is a menu screen under the import duty, as is the policy screen under its own', () => {
    expect(ATTENDANCE_ADMIN_SCREENS.map((s) => [s.path, s.permission, s.nav])).toEqual([
      ['/attendance/punch-imports', 'attendance.import.operational', true],
      ['/attendance/policies', 'attendance_policy.manage.operational', true],
    ]);
  });

  it('previews what will be applied, quarantined and left out, and applies only on request', async () => {
    let committed = false;
    const calls = mockApi({
      [`GET ${BASE}?`]: [200, NO_BATCHES],
      [`POST ${BASE}/job-1/commit`]: () => {
        committed = true;
        return [200, COMMITTED];
      },
      [`POST ${BASE}`]: [201, JOB],
    });
    open('/attendance/punch-imports');
    await chooseFile();

    expect((await screen.findByText(/2 rows will be applied/)).textContent).toContain('1 row is quarantined for review and 1 repeat adds nothing. Nothing is stored until you apply.');
    const table = screen.getByRole('table', { name: 'Rows of this batch' });
    // Rows left out come first.
    expect(within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual(['2', '3', '1', '4']);
    expect(within(table).getByText('No employee with this code is in the scope of your role.')).toBeTruthy();
    expect(within(table).getByText(/under another key of this source/)).toBeTruthy();
    // A repeat from another source is stored and flagged, in words.
    expect(within(table).getByText(/biometric:GATE already delivered this punch/)).toBeTruthy();
    expect(committed).toBe(false);
    const posted = calls.find((c) => c.method === 'POST' && c.url === BASE)!;
    expect(posted.body).toMatchObject({ fileName: 'march.csv', idempotencyKey: expect.any(String) });

    click(screen.getByRole('button', { name: 'Apply 2 rows' }));
    expect((await screen.findByText(/2 rows were applied/)).textContent).toContain('1 row stays quarantined and 1 repeat added nothing');
    expect(committed).toBe(true);
    expect(screen.queryByRole('button', { name: 'Apply 2 rows' })).toBeNull();
  });

  it('offers the stored error report when rows were left out, and says when nothing can be applied', async () => {
    Object.assign(URL, { createObjectURL: () => 'blob:synthetic', revokeObjectURL: () => undefined });
    const saved = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const none = { ...JOB, rowCount: 1, rows: [JOB.rows[1]!] };
    mockApi({ [`GET ${BASE}?`]: [200, NO_BATCHES], [`GET ${BASE}/job-1/error-report`]: [200, { ok: true }], [`POST ${BASE}`]: [201, none] });
    open('/attendance/punch-imports');
    await chooseFile();
    expect(await screen.findByRole('button', { name: 'Close the batch, nothing to apply' })).toBeTruthy();
    click(screen.getByRole('button', { name: 'Download the error report' }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u) === `${BASE}/job-1/error-report`)).toBe(true);
    saved.mockRestore();
  });

  it('switches template, shows a held file as held, and offers no report for it', async () => {
    const held = { ...JOB, id: 'job-2', state: 'UPLOADED', rowCount: null, rows: [], template: 'ATTENDANCE_IN_OUT_V1' };
    const calls = mockApi({ 'GET /v1/attendance/in-out-imports?': [200, NO_BATCHES], [`GET ${BASE}?`]: [200, NO_BATCHES], 'POST /v1/attendance/in-out-imports': [202, held] });
    open('/attendance/punch-imports');
    type(screen.getByLabelText('Template'), 'ATTENDANCE_IN_OUT_V1');
    expect(screen.getByText('employeeCode,workDate,inTime,outTime')).toBeTruthy();
    await chooseFile();
    expect(await screen.findByText(/waiting for the malware scan/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download the error report' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check the scan again' })).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url === '/v1/attendance/in-out-imports')).toBe(true);
  });

  it('shows a refused file with the server’s reason', async () => {
    mockApi({ [`GET ${BASE}?`]: [200, NO_BATCHES], [`POST ${BASE}`]: [422, { error: 'INVALID_HEADER', message: 'Template ATTENDANCE_PUNCH_V1: the header must be exactly the template' }] });
    open('/attendance/punch-imports');
    await chooseFile();
    expect((await screen.findByRole('alert')).textContent).toContain('INVALID_HEADER');
  });
});

const MANAGE = 'attendance_policy.manage.operational';
const ACTIVATE = 'attendance_policy.activate.operational';
const revision = (over: Partial<AttendancePolicy>): AttendancePolicy => ({
  id: 'p-1',
  code: 'DEFAULT',
  revision: 1,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  graceMinutes: 10,
  presentPercent: '75.00',
  halfDayPercent: '50.00',
  overtimeEnabled: false,
  state: 'ACTIVE',
  version: 2,
  mappings: [{ id: 'm-1', grade: null, location: null, priority: 0 }],
  warnings: [],
  ...over,
});
const POLICIES = '/v1/attendance/policies';

describe('attendance policies (FR-020, BR-009)', () => {
  it('shows thresholds, mappings, period and warnings in words', async () => {
    session.permissions = [MANAGE];
    mockApi({
      [`GET ${POLICIES}`]: [
        200,
        {
          items: [
            revision({ effectiveTo: '2026-06-01' }),
            revision({ id: 'p-2', code: 'NIGHT', state: 'DRAFT', mappings: [], warnings: [{ code: 'UNMAPPED', text: 'No grade, location or company-wide mapping is set, so this policy applies to nobody.' }] }),
            revision({ id: 'p-3', code: 'SITE', revision: 2, state: 'RETIRED', mappings: [{ id: 'm-3', grade: 'G1', location: 'HQ', priority: 2 }], overtimeEnabled: true }),
          ],
        },
      ],
    });
    open('/attendance/policies');
    const table = await screen.findByRole('table', { name: 'Attendance policy revisions' });
    const row = (name: string) => within(table).getByText(name).closest('tr')!;
    expect(row('DEFAULT revision 1').textContent).toContain('from 2026-01-01, until before 2026-06-01');
    expect(row('DEFAULT revision 1').textContent).toContain('Grace 10 minutes; present from 75%; half day from 50%; overtime setting off');
    expect(row('DEFAULT revision 1').textContent).toContain('the whole company');
    expect(row('NIGHT revision 1').textContent).toContain('unmapped');
    expect(row('NIGHT revision 1').textContent).toContain('applies to nobody');
    expect(row('SITE revision 2').textContent).toContain('grade G1, location HQ');
    expect(row('SITE revision 2').textContent).toContain('overtime setting on');
    expect(screen.getByText(/The overtime setting is recorded only/)).toBeTruthy();
  });

  it('creates a draft with exactly the values entered and proposes none', async () => {
    session.permissions = [MANAGE];
    const calls = mockApi({ [`GET ${POLICIES}`]: [200, { items: [] }], [`POST ${POLICIES}`]: [201, { id: 'p-9', revision: 1, state: 'DRAFT', version: 1 }] });
    open('/attendance/policies');
    const form = await screen.findByRole('form', { name: 'New policy revision' });
    expect((within(form).getByLabelText('Grace (minutes)') as HTMLInputElement).value).toBe('');
    expect((within(form).getByLabelText(/Present from/) as HTMLInputElement).value).toBe('');
    type(within(form).getByLabelText('Policy code'), 'night_shift');
    type(within(form).getByLabelText('Effective from'), '2026-12-01');
    type(within(form).getByLabelText('Grace (minutes)'), '5');
    type(within(form).getByLabelText(/Present from/), '70');
    type(within(form).getByLabelText(/Half day from/), '45.5');
    click(within(form).getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toStrictEqual({
      code: 'NIGHT_SHIFT',
      effectiveFrom: '2026-12-01',
      effectiveTo: null,
      graceMinutes: 5,
      presentPercent: '70',
      halfDayPercent: '45.5',
      overtimeEnabled: false,
    });
  });

  it('explains refused thresholds and a stale edit in words', async () => {
    session.permissions = [MANAGE];
    const draft = revision({ id: 'p-2', code: 'NIGHT', state: 'DRAFT', version: 3 });
    const calls = mockApi({
      [`GET ${POLICIES}`]: [200, { items: [draft] }],
      [`PATCH ${POLICIES}/p-2`]: [422, { error: 'INVALID_THRESHOLDS', message: 'x' }],
    });
    open('/attendance/policies');
    click(await screen.findByRole('button', { name: 'Edit NIGHT revision 1' }));
    const form = screen.getByRole('form', { name: 'Edit NIGHT revision 1' });
    type(within(form).getByLabelText(/Half day from/), '90');
    click(within(form).getByRole('button', { name: 'Save draft' }));
    expect((await within(form).findByRole('alert')).textContent).toContain('half-day percentage is above 0 and below the present percentage');
    expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({ expectedVersion: 3, halfDayPercent: '90', presentPercent: '75.00', graceMinutes: 10 });
  });

  it('maps a draft through the form’s own choices, and removes a mapping under its version', async () => {
    session.permissions = [MANAGE];
    const draft = revision({ id: 'p-2', code: 'NIGHT', state: 'DRAFT', version: 3 });
    const calls = mockApi({
      [`GET ${POLICIES}`]: [200, { items: [draft] }],
      'GET /v1/attendance/policy-options': [200, { grades: [{ id: 'g-1', code: 'G1', name: 'Grade one' }], locations: [{ id: 'l-1', code: 'HQ', name: 'Head office' }] }],
      [`POST ${POLICIES}/p-2/mappings/m-1/remove`]: [200, { policyVersion: 4 }],
      [`POST ${POLICIES}/p-2/mappings`]: [201, { id: 'm-2', policyVersion: 4 }],
    });
    open('/attendance/policies');
    click(await screen.findByRole('button', { name: 'Map NIGHT revision 1' }));
    const form = screen.getByRole('form', { name: 'Map NIGHT revision 1' });
    await within(form).findByRole('option', { name: 'G1' });
    type(within(form).getByLabelText('Grade'), 'g-1');
    click(within(form).getByRole('button', { name: 'Add mapping' }));
    await waitFor(() => expect(calls.some((c) => c.url === `${POLICIES}/p-2/mappings`)).toBe(true));
    expect(calls.find((c) => c.url === `${POLICIES}/p-2/mappings`)!.body).toStrictEqual({ expectedVersion: 3, gradeId: 'g-1' });
    click(await screen.findByRole('button', { name: 'Remove the whole company' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/remove'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/remove'))!.body).toStrictEqual({ expectedVersion: 3 });
  });

  it('offers activation and retirement only to whoever holds the duty', async () => {
    session.permissions = [MANAGE];
    const items = [revision({ id: 'p-1' }), revision({ id: 'p-2', code: 'NIGHT', state: 'DRAFT', version: 3 })];
    mockApi({ [`GET ${POLICIES}`]: [200, { items }] });
    const view = open('/attendance/policies');
    await screen.findByRole('button', { name: 'Edit NIGHT revision 1' });
    expect(screen.queryByRole('button', { name: 'Activate NIGHT revision 1' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retire DEFAULT revision 1' })).toBeNull();
    view.unmount();
    session.permissions = [ACTIVATE];
    mockApi({ [`GET ${POLICIES}`]: [200, { items }] });
    open('/attendance/policies');
    expect(await screen.findByRole('button', { name: 'Activate NIGHT revision 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retire DEFAULT revision 1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit NIGHT revision 1' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'New policy revision' })).toBeNull();
  });

  it('explains a refused activation in words, and retires with a date and a reason', async () => {
    session.permissions = [MANAGE, ACTIVATE];
    const draft = revision({ id: 'p-2', code: 'NIGHT', state: 'DRAFT', version: 3 });
    let attempt = 0;
    const calls = mockApi({
      [`GET ${POLICIES}`]: [200, { items: [draft, revision({ id: 'p-1' })] }],
      [`POST ${POLICIES}/p-2/activate`]: () =>
        attempt++ === 0
          ? [403, { error: 'SELF_APPROVAL', message: 'x' }]
          : [409, { error: 'POLICY_OVERLAP', message: 'x', details: { revisions: [{ policyId: 'p-1', code: 'DEFAULT', revision: 1, effectiveFrom: '2026-01-01', effectiveTo: null }] } }],
      [`POST ${POLICIES}/p-1/retire`]: [200, { id: 'p-1', state: 'RETIRED', effectiveTo: '2026-12-01' }],
    });
    open('/attendance/policies');
    click(await screen.findByRole('button', { name: 'Activate NIGHT revision 1' }));
    expect((await screen.findByRole('alert')).textContent).toContain('someone else must');
    click(screen.getByRole('button', { name: 'Activate NIGHT revision 1' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('ties with DEFAULT revision 1'));

    click(screen.getByRole('button', { name: 'Retire DEFAULT revision 1' }));
    const form = screen.getByRole('form', { name: 'Retire DEFAULT revision 1' });
    type(within(form).getByLabelText('No longer applies from'), '2026-12-01');
    type(within(form).getByLabelText('Reason for retiring'), ' Synthetic: replaced ');
    click(within(form).getByRole('button', { name: 'Confirm retirement' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/retire'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/retire'))!.body).toStrictEqual({ expectedVersion: 2, effectiveTo: '2026-12-01', reason: 'Synthetic: replaced' });
  });

  it('shows a refusal of the list as such', async () => {
    session.permissions = [MANAGE];
    mockApi({ [`GET ${POLICIES}`]: [403, { error: 'FORBIDDEN', message: 'Not permitted' }] });
    open('/attendance/policies');
    expect((await screen.findByRole('alert')).textContent).toContain('FORBIDDEN');
  });
});
