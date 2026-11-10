// The employee notes register screens (BRD coverage CL-040 "Exit Notes/Remarks/Warnings"; FR-018 restricted to authorised HR;
// BR-044; FR-056 filters, paging and totals; DF08 a void with a reason, never a deletion; DF09 bulk upload; FR-106 scanned files),
// jsdom. Requests carry exactly the filters and fields chosen, controls are hidden without their permission keys, and refusals are
// said in words. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIFECYCLE_PROCESSES_SCREENS } from './lifecycle-processes';

const session = vi.hoisted(() => ({
  permissions: [] as string[],
  companyId: 'c0000000-0000-4000-8000-000000000001',
  assignmentId: 'a0000000-0000-4000-8000-000000000001',
  userId: 'b0000000-0000-4000-8000-000000000001',
}));
vi.mock('../held-batch-timing', () => ({ HELD_BATCH_CHECK_INTERVAL_MS: 3_600_000, HELD_BATCH_MAX_CHECKS: 30 }));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: session.companyId, assignmentId: session.assignmentId },
    me: { userId: session.userId, accountKey: 'syn.hr', companyName: 'Synthetic Co', roleCode: 'HR_ADMINISTRATOR', roleName: 'HR', scopeKind: 'COMPANY', employeeId: null, displayName: 'Synthetic HR' },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

const NOTE_READ = 'employee_note.read.restricted';
const NOTE_WRITE = 'employee_note.write.restricted';
const NOTE_VOID = 'employee_note.void.restricted';
const NOTE_IMPORT = 'employee_note.import.restricted';
const EMPLOYEE_LIST = 'employee.list.operational';
const E1 = '20000000-0000-4000-8000-000000000001';
const N1 = '60000000-0000-4000-8000-000000000001';
const N2 = '60000000-0000-4000-8000-000000000002';

type Reply = [number, unknown];
interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: Record<string, unknown> | undefined;
}
let calls: Call[] = [];

const note = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'WARNING',
  noteDate: '2026-11-02',
  body: 'Synthetic warning: late twice',
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
  ...extra,
});

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

describe('notes register screen (CL-040; FR-018)', () => {
  it('FR-018 BR-044: the menu entries need the restricted notes grants, and the screen says so without them and asks nothing', async () => {
    const screens = LIFECYCLE_PROCESSES_SCREENS.filter((s) => s.path.startsWith('/lifecycle/notes'));
    expect(screens.map((s) => [s.path, s.permission, s.nav])).toEqual([
      ['/lifecycle/notes', NOTE_READ, true],
      ['/lifecycle/notes/upload', NOTE_IMPORT, true],
    ]);
    serve({});
    renderAt('/lifecycle/notes', [EMPLOYEE_LIST]);
    expect(await screen.findByText('The selected role cannot read restricted notes.')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'New note' })).toBeNull();
    expect(callsTo('GET', '/v1/employee-notes')).toHaveLength(0);
  });

  it('FR-056: lists the notes with type, date, submitter and status, sends exactly the chosen filters and pages with the total', async () => {
    serve({
      'GET /v1/employee-notes': (c) =>
        c.params.get('page') === '2'
          ? [200, { items: [note(N2, { kind: 'APPRECIATION', body: 'Synthetic praise' })], total: 26, page: 2, pageSize: 25 }]
          : [200, { items: [note(N1, { attachment: { id: 'a1', fileName: 'warning.pdf', scanState: 'CLEAN' } })], total: 26, page: 1, pageSize: 25 }],
    });
    renderAt('/lifecycle/notes', [NOTE_READ]);
    const table = await screen.findByRole('table', { name: 'Notes' });
    const row = within(table).getAllByRole('row')[1]!;
    expect(row.textContent).toContain('2026-11-02');
    expect(row.textContent).toContain('Synthetic Noor');
    expect(row.textContent).toContain('warning');
    expect(row.textContent).toContain('Synthetic Hema HR');
    expect(row.textContent).toContain('active');
    expect(within(row).getByRole('button', { name: 'warning.pdf' })).toBeTruthy();
    // Without the void right there is no Void button; without the write right no form.
    expect(within(table).queryByRole('button', { name: /Void/ })).toBeNull();
    expect(screen.queryByRole('form', { name: 'New note' })).toBeNull();
    expect(screen.getByText('26 notes match.')).toBeTruthy();
    const filters = screen.getByRole('search', { name: 'Filter notes' });
    change(filters, 'From', '2026-11-05');
    change(filters, 'To', '2026-11-01');
    fireEvent.click(within(filters).getByRole('button', { name: 'Show notes' }));
    expect(screen.getByText('The period ends before it starts.')).toBeTruthy();
    change(filters, 'From', '2026-10-01');
    change(filters, 'Type', 'EXIT_NOTE');
    change(filters, 'Status', 'VOIDED');
    change(filters, 'Employee, code or submitted by', ' noor ');
    fireEvent.click(within(filters).getByRole('button', { name: 'Show notes' }));
    await waitFor(() => expect(callsTo('GET', '/v1/employee-notes').length).toBeGreaterThanOrEqual(2));
    const asked = callsTo('GET', '/v1/employee-notes').at(-1)!.params;
    expect(Object.fromEntries(asked)).toEqual({ from: '2026-10-01', to: '2026-11-01', kind: 'EXIT_NOTE', status: 'VOIDED', search: 'noor', page: '1', pageSize: '25' });
    fireEvent.click(await screen.findByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Synthetic praise')).toBeTruthy();
  });

  it('DF08: voids an active note with a reason, never a corrected one, and says the note stays on record', async () => {
    serve({
      'GET /v1/employee-notes': [200, { items: [note(N1), note(N2, { status: 'SUPERSEDED', supersededByNoteId: N1 })], total: 2 }],
      [`POST /v1/employee-notes/${N1}/void`]: [200, { ...note(N1), status: 'VOIDED' }],
    });
    renderAt('/lifecycle/notes', [NOTE_READ, NOTE_VOID]);
    const table = await screen.findByRole('table', { name: 'Notes' });
    const voidButtons = within(table).getAllByRole('button', { name: /^Void the warning/ });
    expect(voidButtons).toHaveLength(1);
    fireEvent.click(voidButtons[0]!);
    const form = screen.getByRole('form', { name: 'Void a note' });
    fireEvent.click(within(form).getByRole('button', { name: 'Void the note' }));
    expect(within(form).getByText('Say why the note is voided.')).toBeTruthy();
    expect(callsTo('POST', `/v1/employee-notes/${N1}/void`)).toHaveLength(0);
    change(form, 'Why it is voided', ' Synthetic: recorded on the wrong employee ');
    fireEvent.click(within(form).getByRole('button', { name: 'Void the note' }));
    expect(await screen.findByText(/it stays on record, marked voided/)).toBeTruthy();
    expect(callsTo('POST', `/v1/employee-notes/${N1}/void`).map((c) => c.body)).toEqual([{ reason: 'Synthetic: recorded on the wrong employee' }]);
  });

  it('CL-040: a new note is about an employee found in scope, with its type, date and an optional file; a date after today is refused before sending', async () => {
    serve({
      'GET /v1/employee-notes': [200, { items: [], total: 0 }],
      'GET /v1/employees': [200, { items: [{ id: E1, employeeCode: 'SYN-001', displayName: 'Synthetic Noor', status: 'ACTIVE_CONFIRMED' }], total: 1 }],
      [`POST /v1/employees/${E1}/notes`]: [201, { id: N1, employeeId: E1, kind: 'PIP', noteDate: '2026-11-01', attachment: { id: 'a1', scanState: 'PENDING_SCAN' } }],
    });
    renderAt('/lifecycle/notes', [NOTE_READ, NOTE_WRITE, EMPLOYEE_LIST]);
    expect(await screen.findByText('No notes match.')).toBeTruthy();
    const find = screen.getByRole('search', { name: 'Find the employee' });
    change(find, 'Employee name or code', 'noor');
    fireEvent.click(within(find).getByRole('button', { name: 'Find' }));
    const form = screen.getByRole('form', { name: 'New note' });
    await waitFor(() => expect(within(form).getByRole('option', { name: 'Synthetic Noor (SYN-001)' })).toBeTruthy());
    fireEvent.click(within(form).getByRole('button', { name: 'Add the note' }));
    expect(within(form).getByText('Find and choose the employee the note is about.')).toBeTruthy();
    change(form, 'Employee', E1);
    change(form, 'Type', 'PIP');
    change(form, 'Note (restricted to authorised HR)', '  Synthetic PIP: weekly check-ins ');
    change(form, 'Date it is about (blank: today)', '2999-01-01');
    fireEvent.click(within(form).getByRole('button', { name: 'Add the note about Synthetic Noor' }));
    expect(within(form).getByText('A note cannot be dated after today.')).toBeTruthy();
    expect(callsTo('POST', `/v1/employees/${E1}/notes`)).toHaveLength(0);
    change(form, 'Date it is about (blank: today)', '2026-11-01');
    const file = new File(['%PDF-1.4 synthetic plan'], 'plan.pdf', { type: 'application/pdf' });
    fireEvent.change(within(form).getByLabelText('Supporting file (optional)'), { target: { files: [file] } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add the note about Synthetic Noor' }));
    expect(await screen.findByText('Saved the performance improvement plan (pip). The file opens once the malware scan releases it.')).toBeTruthy();
    const sent = callsTo('POST', `/v1/employees/${E1}/notes`)[0]!.body!;
    expect(sent).toMatchObject({ kind: 'PIP', body: 'Synthetic PIP: weekly check-ins', noteDate: '2026-11-01', attachment: { fileName: 'plan.pdf' } });
    expect(typeof (sent.attachment as { contentBase64: string }).contentBase64).toBe('string');
  });

  it('DF09: the bulk upload previews the rows, names each problem in words and commits only on request', async () => {
    let committed = 0;
    serve({
      'GET /v1/employee-note-imports': [200, { items: [], total: 0, page: 1, pageSize: 25 }],
      'POST /v1/employee-note-imports': [
        201,
        {
          id: 'job-1',
          state: 'REJECTED',
          template: 'EMPLOYEE_NOTES_V1',
          fileName: 'notes.csv',
          rowCount: 2,
          acceptedCount: 0,
          rejectedCount: 2,
          rows: [
            { rowNumber: 1, businessKey: 'SYN-001/WARNING/2026-11-01', state: 'REJECTED', errorCode: 'BATCH_REJECTED' },
            { rowNumber: 2, businessKey: 'SYN-002/WARNING/2026-11-01', state: 'REJECTED', errorCode: 'DUPLICATE_NOTE' },
          ],
        },
      ],
      'POST /v1/employee-note-imports/job-1/commit': () => {
        committed += 1;
        return [200, {}];
      },
    });
    renderAt('/lifecycle/notes/upload', [NOTE_IMPORT, NOTE_WRITE]);
    const form = await screen.findByRole('form', { name: 'Upload notes' });
    expect(form.textContent).toContain('employeeCode,noteType,noteDate,text');
    fireEvent.change(within(form).getByLabelText('Notes file (CSV)'), { target: { files: [new File(['employeeCode,noteType,noteDate,text\n'], 'notes.csv', { type: 'text/csv' })] } });
    fireEvent.click(within(form).getByRole('button', { name: 'Upload and preview' }));
    expect(await screen.findByText('This note is already on record (same employee, type, date and text).')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Add \d/ })).toBeNull();
    expect(committed).toBe(0);
    const sent = callsTo('POST', '/v1/employee-note-imports')[0]!.body!;
    expect(sent).toMatchObject({ fileName: 'notes.csv' });
    expect(String(sent.idempotencyKey)).toMatch(/^employee-notes-/);
  });

  it('FR-018: without both upload rights the upload screen says so and asks nothing', async () => {
    serve({});
    renderAt('/lifecycle/notes/upload', [NOTE_IMPORT]);
    expect(await screen.findByText(/cannot upload notes/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});
