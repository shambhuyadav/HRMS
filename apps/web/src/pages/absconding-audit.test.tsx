// Absconding warnings and the absconding audit report (jsdom; BRD coverage CL-052 "Absconding Audit Report"; FR-018 restricted notes
// and warnings; FR-056 reports with filters; BR-045 the report's own confidential export right; migration 0283). A warning is marked as
// an absconding warning when it is written; the report is requested with exactly the dates chosen. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIFECYCLE_PROCESSES_SCREENS } from './lifecycle-processes';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../held-batch-timing', () => ({ HELD_BATCH_CHECK_INTERVAL_MS: 3_600_000, HELD_BATCH_MAX_CHECKS: 30 }));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: 'c0000000-0000-4000-8000-000000000001', assignmentId: 'a0000000-0000-4000-8000-000000000001' },
    me: { userId: 'b0000000-0000-4000-8000-000000000001', accountKey: 'syn.hr', companyName: 'Synthetic Co', roleCode: 'HR_ADMINISTRATOR', roleName: 'HR', scopeKind: 'COMPANY', employeeId: null, displayName: 'Synthetic HR' },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

const NOTE_READ = 'employee_note.read.restricted';
const NOTE_WRITE = 'employee_note.write.restricted';
const NOTE_EXPORT = 'employee_note.export.restricted';
const EMPLOYEE_LIST = 'employee.list.operational';
const E1 = '20000000-0000-4000-8000-000000000001';
const N1 = '60000000-0000-4000-8000-000000000001';

type Reply = [number, unknown];
interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: Record<string, unknown> | undefined;
}
let calls: Call[] = [];
function serve(routes: Record<string, Reply | ((c: Call) => Reply)>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname, params: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}`];
      const [status, body] = route === undefined ? [404, { error: 'NOT_FOUND', message: 'Not found' }] : typeof route === 'function' ? route(call) : route;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}
const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

function renderAt(entry: string, permissions: string[]) {
  session.permissions = permissions;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          {LIFECYCLE_PROCESSES_SCREENS.map((s) => (
            <Route key={s.path} path={s.path} element={<s.component />} />
          ))}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const change = (scope: HTMLElement, label: string | RegExp, value: string) => fireEvent.change(within(scope).getByLabelText(label), { target: { value } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CL-052 absconding audit report screen', () => {
  it('CL-052 BR-045: a menu screen under the report\'s own export right; without it the screen says so and asks nothing', async () => {
    expect(LIFECYCLE_PROCESSES_SCREENS.find((s) => s.path === '/lifecycle/absconding-audit')).toMatchObject({ title: 'Absconding audit', permission: NOTE_EXPORT, nav: true });
    serve({});
    renderAt('/lifecycle/absconding-audit', [NOTE_READ]);
    expect(await screen.findByText(/cannot export the absconding audit/)).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('CL-052 FR-056: asks for the "warning issued from" date first, then requests the report with exactly the dates chosen', async () => {
    serve({
      'POST /v1/reports': [202, { id: 'r-1', state: 'QUEUED', format: 'CSV' }],
      'GET /v1/reports/r-1': [200, { state: 'QUEUED', rowCount: null, failureCode: null }],
    });
    renderAt('/lifecycle/absconding-audit', [NOTE_EXPORT]);
    expect(await screen.findByText('Choose the date the warnings were issued from.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate the absconding audit' })).toBeNull();
    expect(screen.getByText(/at Synthetic Co/)).toBeTruthy();
    const form = screen.getByRole('form', { name: 'Absconding audit filters' });
    change(form, 'Warning issued from', '2026-10-01');
    change(form, 'Up to (blank: today)', '2026-09-01');
    expect(screen.getByText('The end is before the start.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate the absconding audit' })).toBeNull();
    change(form, 'Up to (blank: today)', '');
    fireEvent.click(screen.getByRole('button', { name: 'Generate the absconding audit' }));
    await waitFor(() => expect(callsTo('POST', '/v1/reports')).toHaveLength(1));
    expect(callsTo('POST', '/v1/reports')[0]!.body).toEqual({ reportCode: 'ABSCONDING_AUDIT', filters: { from: '2026-10-01' } });
    change(form, 'Up to (blank: today)', '2026-10-31');
    fireEvent.click(screen.getByRole('button', { name: 'Generate the absconding audit' }));
    await waitFor(() => expect(callsTo('POST', '/v1/reports')).toHaveLength(2));
    expect(callsTo('POST', '/v1/reports')[1]!.body).toEqual({ reportCode: 'ABSCONDING_AUDIT', filters: { from: '2026-10-01', to: '2026-10-31' } });
  });
});

describe('CL-052 absconding warnings in the notes register', () => {
  it('CL-052 FR-018: a warning can be marked as an absconding warning when written; no other type offers the mark; the register says which warnings are', async () => {
    serve({
      'GET /v1/employee-notes': [
        200,
        {
          items: [
            {
              id: N1,
              kind: 'WARNING',
              warningCategory: 'ABSCONDING',
              noteDate: '2026-11-02',
              body: 'Synthetic: absent without word since Monday',
              source: 'ENTRY',
              status: 'ACTIVE',
              supersedesNoteId: null,
              supersededByNoteId: null,
              void: null,
              attachment: null,
              createdBy: 'b0000000-0000-4000-8000-000000000009',
              submittedByName: 'Synthetic Hema HR',
              createdAt: '2026-11-02T09:00:00.000Z',
              employee: { id: E1, employeeCode: 'SYN-001', displayName: 'Synthetic Noor' },
            },
          ],
          total: 1,
        },
      ],
      'GET /v1/employees': [200, { items: [{ id: E1, employeeCode: 'SYN-001', displayName: 'Synthetic Noor', status: 'ACTIVE_CONFIRMED' }], total: 1 }],
      [`POST /v1/employees/${E1}/notes`]: [201, { id: N1, employeeId: E1, kind: 'WARNING', warningCategory: 'ABSCONDING', noteDate: '2026-11-01', attachment: null }],
    });
    renderAt('/lifecycle/notes', [NOTE_READ, NOTE_WRITE, EMPLOYEE_LIST]);
    const table = await screen.findByRole('table', { name: 'Notes' });
    expect(within(table).getAllByRole('row')[1]!.textContent).toContain('absconding warning');

    const find = screen.getByRole('search', { name: 'Find the employee' });
    change(find, 'Employee name or code', 'noor');
    fireEvent.click(within(find).getByRole('button', { name: 'Find' }));
    const form = screen.getByRole('form', { name: 'New note' });
    await waitFor(() => expect(within(form).getByRole('option', { name: 'Synthetic Noor (SYN-001)' })).toBeTruthy());
    change(form, 'Employee', E1);
    expect(within(form).queryByLabelText(/Absconding warning/)).toBeNull();
    change(form, 'Type', 'WARNING');
    fireEvent.click(within(form).getByLabelText(/Absconding warning/));
    change(form, 'Note (restricted to authorised HR)', 'Synthetic: absent without word since Monday');
    fireEvent.click(within(form).getByRole('button', { name: 'Add the note about Synthetic Noor' }));
    expect(await screen.findByText('Saved the absconding warning.')).toBeTruthy();
    expect(callsTo('POST', `/v1/employees/${E1}/notes`)[0]!.body).toEqual({ kind: 'WARNING', warningCategory: 'ABSCONDING', body: 'Synthetic: absent without word since Monday' });

    // A plain warning sends no category; changing the type away from a warning drops the mark.
    change(form, 'Type', 'REMARK');
    expect(within(form).queryByLabelText(/Absconding warning/)).toBeNull();
  });
});
