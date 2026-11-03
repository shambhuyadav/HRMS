// Employee documents and batch imports (jsdom): the upload form starts clean after each upload (web-8); an
// upload-only grant reaches the upload form while the list needs the read grant (web-11); upload times are shown
// as the local calendar day (web-12); imports follow the all-or-nothing batch semantics for every published
// template (FR-009, FR-023, DF09, I-13), and the employee update import previews each row's proposed changes (I-20). A
// file held for the malware scan is checked again through the resume route, and the user's own batches of the selected
// template are listed and opened again (FR-106).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EmployeesPage } from './home';
import { EmployeeDocumentsPage, ImportsPage } from './records';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({
    me: { accountKey: 'syn.hr', companyName: 'Synthetic Co', roleCode: 'HR_ADMINISTRATOR', roleName: 'HR Administrator', scopeKind: 'COMPANY', employeeId: null, displayName: null },
    can: (p: string) => session.permissions.includes(p),
  }),
}));

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
type Reply = [number, unknown];
type Route = unknown | ((call: Call) => Reply | Promise<Reply>);
/** GET <base>?page=…: the user's own batches of each import (imports/routes.ts); none unless a test says otherwise. */
const NO_BATCHES = { items: [], total: 0, page: 1, pageSize: 25 };
const BATCH_LISTS: Record<string, Route> = { 'GET /v1/employees/imports?': NO_BATCHES, 'GET /v1/employees/update-imports?': NO_BATCHES, 'GET /v1/shifts/plan-imports?': NO_BATCHES };
/** Routes are "METHOD /path" (the longest matching prefix wins); a function answers [status, body], or a promise of it (an answer still on its way). */
function mockApi(given: Record<string, Route>) {
  const calls: Call[] = [];
  const routes = { ...BATCH_LISTS, ...given };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      const key = Object.keys(routes)
        .filter((k) => `${call.method} ${url}`.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const route = key === undefined ? undefined : routes[key];
      const [status, body] = key === undefined ? [404, { error: 'NOT_FOUND', message: 'Not found' }] : typeof route === 'function' ? await (route as (c: Call) => Reply | Promise<Reply>)(call) : [200, route];
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}
/** An answer that arrives only when the test lets it go. */
function deferred(reply: Reply) {
  let release: () => void = () => undefined;
  const promise = new Promise<Reply>((resolve) => (release = () => resolve(reply)));
  return { promise, release: () => release() };
}
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderPage = (ui: JSX.Element) => render(<QueryClientProvider client={client()}>{ui}</QueryClientProvider>);
const renderDocuments = () =>
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={['/employees/emp-9/documents']}>
        <Routes>
          <Route path="/employees/:id/documents" element={<EmployeeDocumentsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

const DOC = { id: 'd-1', documentType: 'CONTRACT', fileName: 'synthetic-contract.pdf', mediaType: 'application/pdf', byteSize: 10, expiresOn: '2027-01-31', expired: false, uploadedAt: '2026-10-24T20:00:00Z' };
const pdf = (name = 'offer.pdf') => new File(['%PDF-1.4 synthetic'], name, { type: 'application/pdf' });

describe('employee documents', () => {
  it('starts the upload form clean after a successful upload (web-8)', async () => {
    session.permissions = ['document.read.document', 'document.upload.document'];
    const calls = mockApi({ 'GET /v1/employees/emp-9/documents': { items: [] }, 'POST /v1/employees/emp-9/documents': () => [201, { documentId: 'd-2' }] });
    renderDocuments();
    await screen.findByText('No documents on record.');
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'contract' } });
    fireEvent.change(screen.getByLabelText('Expires'), { target: { value: '2027-01-31' } });
    fireEvent.change(screen.getByLabelText('Document file'), { target: { files: [pdf()] } });
    fireEvent.click(screen.getByText('Upload'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ documentType: 'CONTRACT', fileName: 'offer.pdf', expiresOn: '2027-01-31' });
    await waitFor(() => expect((screen.getByLabelText('Type') as HTMLInputElement).value).toBe('GENERAL'));
    expect((screen.getByLabelText('Expires') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Document file') as HTMLInputElement).files?.length ?? 0).toBe(0);
    expect((screen.getByText('Upload') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Document uploaded.')).toBeTruthy();
  });

  it('an upload-only grant reaches the upload form; the list is asked for only with the read grant (web-11)', async () => {
    session.permissions = ['document.upload.document'];
    const calls = mockApi({ 'POST /v1/employees/emp-9/documents': () => [201, { documentId: 'd-2' }] });
    renderDocuments();
    expect(await screen.findByText('Add a document')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Document file'), { target: { files: [pdf()] } });
    fireEvent.click(screen.getByText('Upload'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.some((c) => c.method === 'GET')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the employee list links to documents with either document grant (web-11)', async () => {
    const employees = { items: [{ id: 'emp-9', employeeCode: 'SYN-9', displayName: 'Synthetic Nine', status: 'ACTIVE_CONFIRMED', assignment: null, joiningDate: '2026-01-05' }], total: 1 };
    for (const grant of ['document.upload.document', 'document.read.document']) {
      session.permissions = ['employee.list.operational', grant];
      mockApi({ 'GET /v1/employees?': employees });
      render(
        <QueryClientProvider client={client()}>
          <MemoryRouter>
            <EmployeesPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      expect(await screen.findByText('Synthetic Nine')).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Documents' }).getAttribute('href')).toBe('/employees/emp-9/documents');
      cleanup();
    }
    session.permissions = ['employee.list.operational'];
    mockApi({ 'GET /v1/employees?': employees });
    render(
      <QueryClientProvider client={client()}>
        <MemoryRouter>
          <EmployeesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Synthetic Nine')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Documents' })).toBeNull();
  });

  describe('dates (web-12)', () => {
    const tz = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = 'Asia/Tokyo'; // UTC+9
    });
    afterAll(() => {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    });

    it('shows the upload time as the local calendar day and the expiry date as given', async () => {
      session.permissions = ['document.read.document'];
      mockApi({ 'GET /v1/employees/emp-9/documents': { items: [DOC] } });
      renderDocuments();
      const row = (await screen.findByText('synthetic-contract.pdf')).closest('tr')!;
      const cells = within(row).getAllByRole('cell').map((c) => c.textContent?.trim());
      expect(cells[2]).toBe('2027-01-31');
      expect(cells[3]).toBe('2026-10-25');
    });
  });
});

// ---------------------------------------------------------------------------------------------------------
// Batch imports (DF09, I-13): all-or-nothing, both templates.
// ---------------------------------------------------------------------------------------------------------

const job = (over: Record<string, unknown>) => ({
  id: 'job-1',
  state: 'PREVIEWED',
  template: 'EMPLOYEE_ONBOARDING_V1',
  fileName: 'joiners.csv',
  rowCount: 2,
  acceptedCount: 0,
  rejectedCount: 0,
  createdAt: '2026-10-24T05:00:00Z',
  rows: [
    { rowNumber: 1, businessKey: 'SYN-1', state: 'VALID', errorCode: null },
    { rowNumber: 2, businessKey: 'SYN-2', state: 'VALID', errorCode: null },
  ],
  ...over,
});
const csv = (text: string, name = 'joiners.csv') => new File([text], name, { type: 'text/csv' });

async function upload(file: File) {
  fireEvent.change(await screen.findByLabelText('Import file'), { target: { files: [file] } });
  fireEvent.click(screen.getByText('Validate'));
}

/** The duties each template's routes require together (employee/imports.ts importGrants, shift/plan-import.ts grants). */
const EMPLOYEE_IMPORT = ['employee.import.operational', 'employee.create.operational'];
const SHIFT_IMPORT = ['shift.import.operational', 'shift.assign.operational'];

describe('batch imports', () => {
  it('offers a template only with every duty its upload and commit require', async () => {
    for (const [permissions, offered] of [
      [['employee.import.operational'], []],
      [['employee.create.operational'], []],
      [['shift.import.operational'], []],
      [['shift.import.operational', 'employee.import.operational', 'shift.assign.operational'], ['SHIFT_PLAN_V1']],
      [EMPLOYEE_IMPORT, ['EMPLOYEE_ONBOARDING_V1']],
      // FR-025: the opening-balance upload needs the import duty and the adjustment duty its rows are applied under.
      [['leave.import.operational'], []],
      [['leave.adjust.operational'], []],
      [['leave.import.operational', 'leave.adjust.operational'], ['LEAVE_OPENING_V1']],
    ] as const) {
      session.permissions = [...permissions];
      mockApi({});
      renderPage(<ImportsPage />);
      if (offered.length === 0) {
        expect(screen.queryByLabelText('Import file')).toBeNull();
        expect(screen.getByText(/cannot import/)).toBeTruthy();
      } else {
        expect([...(screen.getByLabelText('Template') as HTMLSelectElement).options].map((o) => o.value)).toEqual(offered);
      }
      cleanup();
    }
  });

  it('offers only the templates this role may import and posts to the chosen template’s endpoint', async () => {
    session.permissions = [...EMPLOYEE_IMPORT, ...SHIFT_IMPORT];
    const calls = mockApi({ 'POST /v1/shifts/plan-imports': () => [201, job({ template: 'SHIFT_PLAN_V1', fileName: 'plan.csv', rows: [{ rowNumber: 1, businessKey: 'SYN-1@2026-11-01', state: 'VALID', errorCode: null }], rowCount: 1 })] });
    renderPage(<ImportsPage />);
    const select = screen.getByLabelText('Template') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['EMPLOYEE_ONBOARDING_V1', 'SHIFT_PLAN_V1']);
    fireEvent.change(select, { target: { value: 'SHIFT_PLAN_V1' } });
    expect(screen.getByText('employeeCode,shiftCode,effectiveFrom')).toBeTruthy();
    await upload(csv('employeeCode,shiftCode,effectiveFrom\nSYN-1,DAY,2026-11-01', 'plan.csv'));
    expect(await screen.findByText('Apply 1 shift assignment')).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/v1/shifts/plan-imports');
    expect(atob(post.body!.contentBase64 as string)).toBe('employeeCode,shiftCode,effectiveFrom\nSYN-1,DAY,2026-11-01');
    expect(post.body).toMatchObject({ fileName: 'plan.csv' });
    expect(screen.getByText(/SHIFT_PLAN_V1/, { selector: 'h2' })).toBeTruthy();

    cleanup();
    session.permissions = SHIFT_IMPORT;
    renderPage(<ImportsPage />);
    expect([...(screen.getByLabelText('Template') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['SHIFT_PLAN_V1']);
    cleanup();
    session.permissions = [];
    renderPage(<ImportsPage />);
    expect(screen.queryByLabelText('Import file')).toBeNull();
    expect(screen.getByText(/cannot import/)).toBeTruthy();
  });

  it('downloads the selected template’s published file next to its column list, and says why when the server refuses (DF09)', async () => {
    session.permissions = [...EMPLOYEE_IMPORT, ...SHIFT_IMPORT];
    const calls = mockApi({
      'GET /v1/employees/imports/template': 'employeeCode,displayName',
      'GET /v1/shifts/plan-imports/template': () => [403, { error: 'FORBIDDEN', message: 'Not permitted' }],
    });
    // jsdom has no object URLs: a downloaded file is "saved" through a click on a link to one, counted here.
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn(() => 'blob:synthetic-template');
    URL.revokeObjectURL = vi.fn();
    const saved = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      renderPage(<ImportsPage />);
      // The column explanation stays; the template is offered beside it.
      expect(screen.getByText(/^employeeCode,displayName,workEmail,joiningDate/)).toBeTruthy();
      expect(screen.getByText('EMPLOYEE_ONBOARDING_V1.csv: the header line only, ready to fill in.')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Download the template' }));
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
      expect(calls.filter((c) => c.url.endsWith('/template')).map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/employees/imports/template']);
      expect(calls.some((c) => c.method === 'POST')).toBe(false);

      fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'SHIFT_PLAN_V1' } });
      expect(screen.getByText('SHIFT_PLAN_V1.csv: the header line only, ready to fill in.')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Download the template' }));
      expect(await screen.findByText(/Not permitted/)).toBeTruthy();
      expect(calls.filter((c) => c.url.endsWith('/template')).map((c) => c.url)).toEqual(['/v1/employees/imports/template', '/v1/shifts/plan-imports/template']);
      expect(saved).toHaveBeenCalledTimes(1);
    } finally {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
      saved.mockRestore();
    }
  });

  it('a rejected batch says nothing was applied, lists the row problems and offers no commit', async () => {
    session.permissions = EMPLOYEE_IMPORT;
    mockApi({
      'POST /v1/employees/imports': () => [
        201,
        job({
          state: 'REJECTED',
          rejectedCount: 2,
          rows: [
            { rowNumber: 1, businessKey: 'SYN-1', state: 'REJECTED', errorCode: 'BATCH_REJECTED' },
            { rowNumber: 2, businessKey: 'SYN-2', state: 'REJECTED', errorCode: 'UNKNOWN_DEPARTMENT' },
          ],
        }),
      ],
    });
    renderPage(<ImportsPage />);
    await upload(csv('employeeCode\nSYN-1'));
    expect(await screen.findByText(/nothing was applied/)).toBeTruthy();
    expect(screen.getByText(/all or nothing/)).toBeTruthy();
    const problem = screen.getByText('UNKNOWN_DEPARTMENT').closest('tr')!;
    expect(within(problem).getByText('SYN-2')).toBeTruthy();
    const other = screen.getByText('SYN-1').closest('tr')!;
    expect(within(other).getByText('not applied (another row failed)')).toBeTruthy();
    expect(screen.queryByText(/^Create/)).toBeNull();
    expect(screen.queryByText('Cancel import')).toBeNull();
  });

  it('a previewed batch is committed only on request; a row that became invalid rejects the whole batch', async () => {
    session.permissions = EMPLOYEE_IMPORT;
    const calls = mockApi({
      'POST /v1/employees/imports': () => [201, job({})],
      'POST /v1/employees/imports/job-1/commit': job({
        state: 'REJECTED',
        rejectedCount: 2,
        rows: [
          { rowNumber: 1, businessKey: 'SYN-1', state: 'REJECTED', errorCode: 'DUPLICATE' },
          { rowNumber: 2, businessKey: 'SYN-2', state: 'REJECTED', errorCode: 'BATCH_REJECTED' },
        ],
      }),
    });
    renderPage(<ImportsPage />);
    await upload(csv('employeeCode\nSYN-1'));
    expect(await screen.findByText(/All 2 rows are valid/)).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith('/commit'))).toHaveLength(0);
    fireEvent.click(screen.getByText('Create 2 employees'));
    expect(await screen.findByText('DUPLICATE')).toBeTruthy();
    expect(screen.getByText(/nothing was applied/)).toBeTruthy();
    expect(screen.queryByText('Create 2 employees')).toBeNull();
  });

  it('a committed batch reports every row applied', async () => {
    session.permissions = EMPLOYEE_IMPORT;
    mockApi({
      'POST /v1/employees/imports': () => [201, job({})],
      'POST /v1/employees/imports/job-1/commit': job({ state: 'COMMITTED', acceptedCount: 2, rows: [{ rowNumber: 1, businessKey: 'SYN-1', state: 'ACCEPTED', errorCode: null }, { rowNumber: 2, businessKey: 'SYN-2', state: 'ACCEPTED', errorCode: null }] }),
    });
    renderPage(<ImportsPage />);
    await upload(csv('employeeCode\nSYN-1'));
    fireEvent.click(await screen.findByText('Create 2 employees'));
    expect(await screen.findByText(/All 2 rows were applied/)).toBeTruthy();
    expect(screen.queryByText('Cancel import')).toBeNull();
  });

  it('validating the same file again reuses its key (same job); a key in use by someone else asks for a new upload', async () => {
    session.permissions = EMPLOYEE_IMPORT;
    let posts = 0;
    const calls = mockApi({
      'POST /v1/employees/imports': () => {
        posts += 1;
        if (posts === 1) return [500, { error: 'INTERNAL', message: 'Synthetic transient failure' }];
        if (posts === 2) return [200, job({})];
        return [409, { error: 'IDEMPOTENCY_KEY_IN_USE', message: 'Use a new idempotency key for this upload' }];
      },
    });
    renderPage(<ImportsPage />);
    const file = csv('employeeCode\nSYN-1');
    await upload(file);
    expect((await screen.findByRole('alert')).textContent).toContain('INTERNAL');
    fireEvent.click(screen.getByText('Validate'));
    expect(await screen.findByText('Create 2 employees')).toBeTruthy();
    const keys = calls.filter((c) => c.method === 'POST').map((c) => c.body!.idempotencyKey);
    expect(keys[0]).toMatch(/^import-/);
    expect(keys[1]).toBe(keys[0]);

    // A new file gets a new key; a refused key is replaced so the next attempt can go through.
    await upload(csv('employeeCode\nSYN-3', 'more.csv'));
    expect((await screen.findByRole('alert')).textContent).toContain('IDEMPOTENCY_KEY_IN_USE');
    fireEvent.click(screen.getByText('Validate'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(4));
    const later = calls.filter((c) => c.method === 'POST').map((c) => c.body!.idempotencyKey);
    expect(later[2]).not.toBe(keys[0]);
    expect(later[3]).not.toBe(later[2]);
  });

  it('cancelling a previewed batch shows it cancelled', async () => {
    session.permissions = EMPLOYEE_IMPORT;
    const calls = mockApi({ 'POST /v1/employees/imports': () => [201, job({})], 'POST /v1/employees/imports/job-1/cancel': job({ state: 'CANCELLED' }) });
    renderPage(<ImportsPage />);
    await upload(csv('employeeCode\nSYN-1'));
    fireEvent.click(await screen.findByText('Cancel import'));
    expect(await screen.findByText(/cancelled; nothing was applied/)).toBeTruthy();
    expect(calls.some((c) => c.url === '/v1/employees/imports/job-1/cancel')).toBe(true);
  });

  it('a file still waiting for the malware scan is held: nothing read, no commit, and it can be cancelled (FR-106)', async () => {
    session.permissions = EMPLOYEE_IMPORT;
    const calls = mockApi({
      'POST /v1/employees/imports': () => [202, job({ state: 'UPLOADED', rowCount: null, rows: [], scanState: 'PENDING_SCAN' })],
      'POST /v1/employees/imports/job-1/cancel': job({ state: 'CANCELLED', rowCount: null, rows: [] }),
    });
    renderPage(<ImportsPage />);
    await upload(csv('employeeCode\nSYN-1'));
    expect(await screen.findByText(/waiting for the malware scan, so nothing in it has been read yet/)).toBeTruthy();
    expect(screen.queryByText(/^Create /)).toBeNull();
    fireEvent.click(screen.getByText('Cancel import'));
    expect(await screen.findByText(/cancelled; nothing was applied/)).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith('/commit'))).toEqual([]);
  });

  it('a held batch is checked again from its stored file, without a second upload, and previewed once the scan releases it', async () => {
    session.permissions = EMPLOYEE_IMPORT;
    const held = job({ state: 'UPLOADED', rowCount: null, rows: [], scanState: 'PENDING_SCAN' });
    let resumes = 0;
    const calls = mockApi({
      'POST /v1/employees/imports': () => [202, held],
      'POST /v1/employees/imports/job-1/resume': () => {
        resumes += 1;
        return resumes === 1 ? [202, held] : [200, job({ scanState: 'CLEAN' })];
      },
      'POST /v1/employees/imports/job-1/commit': job({ state: 'COMMITTED', acceptedCount: 2 }),
    });
    renderPage(<ImportsPage />);
    await upload(csv('employeeCode\nSYN-1'));
    expect(await screen.findByText(/Check the scan again later to see the preview/)).toBeTruthy();
    await checkAgain();
    expect(await screen.findByText('Still waiting for the malware scan.')).toBeTruthy();
    await checkAgain();
    fireEvent.click(await screen.findByText('Create 2 employees'));
    expect(await screen.findByText(/All 2 rows were applied/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check the scan again' })).toBeNull();
    // One upload; each check went to the resume route with no body.
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/v1/employees/imports')).toHaveLength(1);
    expect(calls.filter((c) => c.url === '/v1/employees/imports/job-1/resume').map((c) => [c.method, c.body])).toEqual([
      ['POST', undefined],
      ['POST', undefined],
    ]);
  });

  it('lists the user’s own batches of the selected template; a held one is opened again, and one the scan quarantines is closed', async () => {
    session.permissions = [...EMPLOYEE_IMPORT, ...SHIFT_IMPORT];
    /** GET /v1/employees/imports: job facts only. */
    const facts = (over: Record<string, unknown>) => {
      const batch: Record<string, unknown> = { ...job({ scanState: 'CLEAN', ...over }), updatedAt: '2026-10-24T05:00:00Z' };
      delete batch.rows;
      return batch;
    };
    const calls = mockApi({
      'GET /v1/employees/imports?page=1&pageSize=25': {
        items: [facts({ id: 'job-1', state: 'UPLOADED', rowCount: null, scanState: 'PENDING_SCAN', fileName: 'held.csv' }), facts({ id: 'job-2', state: 'COMMITTED', acceptedCount: 2, fileName: 'done.csv' })],
        total: 30,
        page: 1,
        pageSize: 25,
      },
      'GET /v1/employees/imports?page=2&pageSize=25': { items: [facts({ id: 'job-0', state: 'CANCELLED', fileName: 'oldest.csv' })], total: 30, page: 2, pageSize: 25 },
      'GET /v1/employees/imports/job-1': job({ state: 'UPLOADED', rowCount: null, rows: [], scanState: 'PENDING_SCAN', fileName: 'held.csv' }),
      'POST /v1/employees/imports/job-1/resume': () => [422, { error: 'FILE_QUARANTINED', message: 'The malware scan flagged the file; nothing was read or imported' }],
    });
    renderPage(<ImportsPage />);
    const list = await screen.findByRole('table', { name: 'Your employee onboarding batches' });
    expect(calls.find((c) => c.method === 'GET')!.url).toBe('/v1/employees/imports?page=1&pageSize=25');
    const rowOf = (name: string) => within(screen.getByRole('table', { name: 'Your employee onboarding batches' })).getByText(name).closest('tr')!;
    expect(rowOf('held.csv').textContent).toContain('held for the malware scan');
    expect(rowOf('held.csv').textContent).toContain('waiting for the malware scan');
    expect(rowOf('done.csv').textContent).toContain('committed');
    expect(rowOf('done.csv').textContent).toContain('2 applied');
    expect(within(list).queryByText('SYN-1')).toBeNull(); // job facts only, never rows

    fireEvent.click(within(rowOf('held.csv')).getByRole('button', { name: /^Open held.csv/ }));
    expect(await screen.findByText(/Check the scan again later to see the preview/)).toBeTruthy();
    expect(within(rowOf('held.csv')).getByText('open above')).toBeTruthy();
    await checkAgain();
    expect((await screen.findByRole('alert')).textContent).toContain('FILE_QUARANTINED');
    expect(screen.queryByRole('heading', { name: /^Preview:/ })).toBeNull();
    await waitFor(() => expect(calls.filter((c) => c.url === '/v1/employees/imports?page=1&pageSize=25').length).toBeGreaterThanOrEqual(2));

    // Paged, newest first; another template lists its own batches.
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Older batches' }));
    expect(await screen.findByText('oldest.csv')).toBeTruthy();
    expect(rowOf('oldest.csv').textContent).toContain('cancelled, nothing applied');
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'SHIFT_PLAN_V1' } });
    expect(await screen.findByText('You have not uploaded a file for this import yet.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Your shift plan batches' })).toBeTruthy();
    expect(calls.some((c) => c.url === '/v1/shifts/plan-imports?page=1&pageSize=25')).toBe(true);
  });
});

/** The button waits for the request that showed the held batch to settle. */
async function checkAgain() {
  const button = (await screen.findByRole('button', { name: 'Check the scan again' })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

// ---------------------------------------------------------------------------------------------------------
// Employee update import (FR-009, I-20): template EMPLOYEE_UPDATE_V1, each row's proposed changes in the preview,
// row problems in plain words, and the same all-or-nothing batch (I-13).
// ---------------------------------------------------------------------------------------------------------

/** employee/update-import.ts importGrants: the import duty, and the update duty every row is applied under. */
const UPDATE_IMPORT = ['employee.import.operational', 'employee.update.operational'];
/** EMPLOYEE_UPDATE_COLUMNS (employee/update-import.ts), in order. */
const UPDATE_HEADER = 'employeeCode,displayName,workEmail,effectiveFrom,departmentCode,locationCode,designationCode,gradeCode,managerEmployeeCode';
// Proposed changes are stored as jsonb, which hands keys back shortest first; the page puts them in template order.
const UPDATE_ROWS = [
  {
    rowNumber: 1,
    businessKey: 'SYN-1',
    state: 'VALID',
    errorCode: null,
    proposedChanges: { workEmail: { from: null, to: 'renamed@synthetic.example' }, displayName: { from: 'Synthetic One', to: 'Synthetic Renamed' } },
  },
  {
    rowNumber: 2,
    businessKey: 'SYN-2',
    state: 'VALID',
    errorCode: null,
    proposedChanges: { manager: { from: null, to: 'SYN-9' }, department: { from: 'ENG', to: 'FIN' }, effectiveFrom: { from: null, to: '2026-11-01' } },
  },
];
const ACCEPTED_ROWS = UPDATE_ROWS.map((r) => ({ ...r, state: 'ACCEPTED' }));
const updateJob = (over: Record<string, unknown>) => job({ template: 'EMPLOYEE_UPDATE_V1', fileName: 'updates.csv', rows: UPDATE_ROWS, ...over });
const updateCsv = (...rows: string[]) => csv([UPDATE_HEADER, ...rows].join('\n'), 'updates.csv');
/** A preview row's cells: row, employee code, result, proposed changes, problem. */
const cellsOf = (key: string) => within(screen.getByText(key, { selector: 'td' }).closest('tr')!).getAllByRole('cell');
const changesOf = (key: string) => within(cellsOf(key)[3]!).queryAllByRole('listitem').map((li) => li.textContent);

describe('employee update import (FR-009, I-20)', () => {
  it('is offered only with both the import and the update duty, next to the onboarding and shift-plan templates', () => {
    for (const [permissions, offered] of [
      [['employee.import.operational'], []],
      [['employee.update.operational'], []],
      [['employee.update.operational', 'employee.create.operational', 'shift.import.operational'], []],
      [UPDATE_IMPORT, ['EMPLOYEE_UPDATE_V1']],
      [[...EMPLOYEE_IMPORT, 'employee.update.operational'], ['EMPLOYEE_ONBOARDING_V1', 'EMPLOYEE_UPDATE_V1']],
      [[...SHIFT_IMPORT, ...UPDATE_IMPORT, 'employee.create.operational'], ['EMPLOYEE_ONBOARDING_V1', 'EMPLOYEE_UPDATE_V1', 'SHIFT_PLAN_V1']],
    ] as const) {
      session.permissions = [...permissions];
      mockApi({});
      renderPage(<ImportsPage />);
      if (offered.length === 0) {
        expect(screen.queryByLabelText('Import file')).toBeNull();
        expect(screen.getByText(/cannot import/)).toBeTruthy();
      } else {
        expect([...(screen.getByLabelText('Template') as HTMLSelectElement).options].map((o) => o.value)).toEqual(offered);
      }
      cleanup();
    }
  });

  it('shows the exact template header and its rules: a blank cell changes nothing; organisation and manager changes need effectiveFrom', () => {
    session.permissions = [...EMPLOYEE_IMPORT, 'employee.update.operational'];
    mockApi({});
    renderPage(<ImportsPage />);
    const select = screen.getByLabelText('Template') as HTMLSelectElement;
    expect(select.options[1]!.textContent).toBe('Employee update (EMPLOYEE_UPDATE_V1)');
    fireEvent.change(select, { target: { value: 'EMPLOYEE_UPDATE_V1' } });
    const hint = screen.getByText(UPDATE_HEADER, { selector: 'code' }).closest('p')!;
    expect(hint.textContent).toContain('A blank cell means no change.');
    expect(hint.textContent).toContain('Organisation changes (department, location, designation, grade) and manager changes need effectiveFrom');
    // A filled-in organisation or manager cell asks for the date even when it repeats the current value.
    expect(hint.textContent).toContain('leave it and the organisation and manager cells blank on a row that changes only the display name or work email');
    expect(hint.textContent).toContain('a manager cannot be removed by import');
    expect(hint.textContent).toContain('a batch is applied all or nothing: one row with a problem rejects the whole batch');
    // Every input has a visible label.
    expect(screen.getByLabelText('Import file').closest('label')?.textContent?.trim()).toBe('Import file');
  });

  it('uploads to the update-import route and previews each row’s proposed changes as "field: from -> to"', async () => {
    session.permissions = UPDATE_IMPORT;
    const calls = mockApi({ 'POST /v1/employees/update-imports': () => [201, updateJob({})] });
    renderPage(<ImportsPage />);
    const text = [UPDATE_HEADER, 'SYN-1,Synthetic Renamed,renamed@synthetic.example,,,,,,', 'SYN-2,,,2026-11-01,FIN,,,,SYN-9'].join('\n');
    await upload(csv(text, 'updates.csv'));
    expect(await screen.findByText('Update 2 employees')).toBeTruthy();
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('/v1/employees/update-imports');
    expect(Object.keys(posts[0]!.body!).sort()).toEqual(['contentBase64', 'fileName', 'idempotencyKey']);
    expect(posts[0]!.body).toMatchObject({ fileName: 'updates.csv' });
    expect(posts[0]!.body!.idempotencyKey).toMatch(/^import-/);
    expect(atob(posts[0]!.body!.contentBase64 as string)).toBe(text);
    expect(screen.getByText(/EMPLOYEE_UPDATE_V1/, { selector: 'h2' })).toBeTruthy();
    expect(screen.getByText(/All 2 rows are valid/)).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Proposed changes' })).toBeTruthy();
    // In template order whatever order the server used; a value that was empty before shows as an em dash.
    expect(changesOf('SYN-1')).toEqual(['displayName: Synthetic One -> Synthetic Renamed', 'workEmail: — -> renamed@synthetic.example']);
    expect(changesOf('SYN-2')).toEqual(['department: ENG -> FIN', 'manager: — -> SYN-9', 'effectiveFrom: — -> 2026-11-01']);
    expect(cellsOf('SYN-1')[4]!.textContent).toBe('—');
    expect(screen.getByText('Cancel import')).toBeTruthy();
  });

  it('a rejected batch says in plain words what is wrong with each row, applies nothing and offers no commit', async () => {
    session.permissions = UPDATE_IMPORT;
    const PLAIN: Record<string, string> = {
      UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code.',
      DUPLICATE_IN_BATCH: 'This employee is already on an earlier row',
      NO_CHANGE: 'so there is nothing to change',
      // The server asks for the date whenever an organisation or manager cell is filled in, changed or not.
      EFFECTIVE_DATE_REQUIRED: 'needs effectiveFrom as a valid date (YYYY-MM-DD), even when the code matches the current value',
      NOTHING_TO_DATE: 'leave effectiveFrom blank',
      UNKNOWN_MANAGER: 'No employee in this company has the manager employee code given.',
      SELF_MANAGER: 'An employee cannot be their own manager.',
      OUT_OF_SCOPE: 'outside the scope of your role',
      UNKNOWN_DEPARTMENT: 'No active department has this code.',
      UNKNOWN_LOCATION: 'No active location has this code.',
      UNKNOWN_DESIGNATION: 'No active designation has this code.',
      UNKNOWN_GRADE: 'No active grade has this code.',
      // Codes a row can get from the shared batch rules and the ordinary update and change paths.
      COLUMN_COUNT: 'exactly one cell for each column of the header',
      INVALID_DISPLAY_NAME: 'longer than 200 characters',
      INVALID_WORK_EMAIL: 'The work email is not a valid address.',
      DUPLICATE: 'such as the work email',
      NO_CURRENT_ASSIGNMENT: 'The employee has no current assignment to change.',
      // No history-correction screen exists, so the words must not send anyone to one.
      CHANGE_NOT_LATEST: 'an import can only add a change after the latest one, so use a later effectiveFrom',
      RULE_VIOLATION: 'before the joining date',
      INVALID_REFERENCE: 'the manager is outside the scope of your role',
    };
    const codes = Object.keys(PLAIN);
    const other = `SYN-${codes.length + 2}`;
    mockApi({
      'POST /v1/employees/update-imports': () => [
        201,
        updateJob({
          state: 'REJECTED',
          rowCount: codes.length + 2,
          rejectedCount: codes.length + 2,
          rows: [
            { ...UPDATE_ROWS[0]!, state: 'REJECTED', errorCode: 'BATCH_REJECTED' },
            ...codes.map((code, i) => ({ rowNumber: i + 2, businessKey: `SYN-${i + 2}`, state: 'REJECTED', errorCode: code, proposedChanges: null })),
            { rowNumber: codes.length + 2, businessKey: other, state: 'REJECTED', errorCode: 'SYNTHETIC_NEW_CODE', proposedChanges: null },
          ],
        }),
      ],
    });
    renderPage(<ImportsPage />);
    await upload(updateCsv('SYN-1,Synthetic Renamed,,,,,,,'));
    expect(await screen.findByText(/nothing was applied/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`${codes.length + 1} rows have a problem`))).toBeTruthy();
    codes.forEach((code, i) => {
      const cells = cellsOf(`SYN-${i + 2}`);
      expect(cells[4]!.textContent).toContain(PLAIN[code]);
      expect(within(cells[4]!).getByText(code)).toBeTruthy(); // the code stays readable for reference
      expect(cells[3]!.textContent).toBe('—');
    });
    // A code the page has no words for is shown as the server sent it.
    expect(cellsOf(other)[4]!.textContent).toBe('SYNTHETIC_NEW_CODE');
    // A row without a problem is not applied either, and still shows what it would change.
    expect(cellsOf('SYN-1')[4]!.textContent).toBe('not applied (another row failed)');
    expect(changesOf('SYN-1')).toEqual(['displayName: Synthetic One -> Synthetic Renamed', 'workEmail: — -> renamed@synthetic.example']);
    // The problem rows come first.
    expect(within(screen.getAllByRole('row')[1]!).getAllByRole('cell')[1]!.textContent).toBe('SYN-2');
    expect(screen.queryByText(/^Update \d/)).toBeNull();
    expect(screen.queryByText('Cancel import')).toBeNull();
  });

  it('commits only on request; the decision buttons and the upload wait for the answer, and a committed batch reports every row applied', async () => {
    session.permissions = UPDATE_IMPORT;
    const answer = deferred([200, updateJob({ state: 'COMMITTED', acceptedCount: 2, rows: ACCEPTED_ROWS })]);
    const calls = mockApi({ 'POST /v1/employees/update-imports': () => [201, updateJob({})], 'POST /v1/employees/update-imports/job-1/commit': () => answer.promise });
    renderPage(<ImportsPage />);
    await upload(updateCsv('SYN-1,Synthetic Renamed,,,,,,,'));
    const commit = (await screen.findByText('Update 2 employees')) as HTMLButtonElement;
    const cancel = screen.getByText('Cancel import') as HTMLButtonElement;
    expect([commit.getAttribute('type'), cancel.getAttribute('type')]).toEqual(['button', 'button']);
    expect(calls.filter((c) => c.url.endsWith('/commit'))).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Import file'), { target: { files: [updateCsv('SYN-3,Synthetic Three,,,,,,,')] } });
    fireEvent.click(commit);
    await waitFor(() => expect(commit.disabled).toBe(true));
    expect(cancel.disabled).toBe(true);
    fireEvent.click(commit); // no second commit while the first is on its way
    // Nor another upload, whose preview the commit's answer would replace.
    expect((screen.getByText('Validate') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Import file') as HTMLInputElement).disabled).toBe(true);
    answer.release();
    expect(await screen.findByText('All 2 rows were applied.')).toBeTruthy();
    const commits = calls.filter((c) => c.method === 'POST' && c.url === '/v1/employees/update-imports/job-1/commit');
    expect(commits).toHaveLength(1);
    expect(commits[0]!.body).toBeUndefined(); // the route takes no body: a repeated commit returns the committed job
    expect(calls.some((c) => c.url.endsWith('/cancel'))).toBe(false);
    expect(screen.queryByText('Update 2 employees')).toBeNull();
    expect(screen.queryByText('Cancel import')).toBeNull();
    expect(changesOf('SYN-2')).toEqual(['department: ENG -> FIN', 'manager: — -> SYN-9', 'effectiveFrom: — -> 2026-11-01']);
  });

  it('a row that became invalid since the preview rejects the whole batch at commit, explained in plain words', async () => {
    session.permissions = UPDATE_IMPORT;
    mockApi({
      'POST /v1/employees/update-imports': () => [201, updateJob({})],
      'POST /v1/employees/update-imports/job-1/commit': updateJob({
        state: 'REJECTED',
        rejectedCount: 2,
        rows: [
          { ...UPDATE_ROWS[0]!, state: 'REJECTED', errorCode: 'BATCH_REJECTED' },
          { ...UPDATE_ROWS[1]!, state: 'REJECTED', errorCode: 'NO_CHANGE' },
        ],
      }),
    });
    renderPage(<ImportsPage />);
    await upload(updateCsv('SYN-1,Synthetic Renamed,,,,,,,'));
    fireEvent.click(await screen.findByText('Update 2 employees'));
    expect(await screen.findByText(/nothing was applied/)).toBeTruthy();
    expect(cellsOf('SYN-2')[4]!.textContent).toContain('so there is nothing to change');
    expect(cellsOf('SYN-1')[4]!.textContent).toBe('not applied (another row failed)');
    expect(screen.queryByText('Update 2 employees')).toBeNull();
    expect(screen.queryByText('Cancel import')).toBeNull();
  });

  it('cancelling goes to the update-import route and applies nothing', async () => {
    session.permissions = UPDATE_IMPORT;
    const calls = mockApi({ 'POST /v1/employees/update-imports': () => [201, updateJob({})], 'POST /v1/employees/update-imports/job-1/cancel': updateJob({ state: 'CANCELLED' }) });
    renderPage(<ImportsPage />);
    await upload(updateCsv('SYN-1,Synthetic Renamed,,,,,,,'));
    fireEvent.click(await screen.findByText('Cancel import'));
    expect(await screen.findByText('Import cancelled; nothing was applied.')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/v1/employees/update-imports', '/v1/employees/update-imports/job-1/cancel']);
  });

  it('after a refused commit the page shows where the batch stands now, read from the job view', async () => {
    session.permissions = UPDATE_IMPORT;
    const calls = mockApi({
      'POST /v1/employees/update-imports': () => [201, updateJob({})],
      'POST /v1/employees/update-imports/job-1/commit': () => [409, { error: 'INVALID_STATE', message: 'Only a previewed batch without errors can be committed' }],
      'GET /v1/employees/update-imports/job-1': updateJob({ state: 'CANCELLED' }),
    });
    renderPage(<ImportsPage />);
    await upload(updateCsv('SYN-1,Synthetic Renamed,,,,,,,'));
    fireEvent.click(await screen.findByText('Update 2 employees'));
    expect((await screen.findByRole('alert')).textContent).toContain('INVALID_STATE');
    expect(screen.getByText('Import cancelled; nothing was applied.')).toBeTruthy();
    expect(screen.queryByText('Update 2 employees')).toBeNull();
    // The job view only (the list of batches is read again too, from its own route).
    expect(calls.filter((c) => c.method === 'GET' && !c.url.includes('?')).map((c) => c.url)).toEqual(['/v1/employees/update-imports/job-1']);
  });

  it('a commit whose answer was lost but which went through shows the committed batch, not an error', async () => {
    session.permissions = UPDATE_IMPORT;
    mockApi({
      'POST /v1/employees/update-imports': () => [201, updateJob({})],
      'POST /v1/employees/update-imports/job-1/commit': () => {
        throw new TypeError('Failed to fetch');
      },
      'GET /v1/employees/update-imports/job-1': updateJob({ state: 'COMMITTED', acceptedCount: 2, rows: ACCEPTED_ROWS }),
    });
    renderPage(<ImportsPage />);
    await upload(updateCsv('SYN-1,Synthetic Renamed,,,,,,,'));
    fireEvent.click(await screen.findByText('Update 2 employees'));
    expect(await screen.findByText('All 2 rows were applied.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Update 2 employees')).toBeNull();
  });

  it('after a preview the form starts clean, so a corrected file is a new upload with its own key', async () => {
    session.permissions = UPDATE_IMPORT;
    let posts = 0;
    const calls = mockApi({
      'POST /v1/employees/update-imports': () => {
        posts += 1;
        if (posts > 1) return [201, updateJob({ id: 'job-2' })];
        return [
          201,
          updateJob({
            state: 'REJECTED',
            rejectedCount: 2,
            rows: [
              { ...UPDATE_ROWS[0]!, state: 'REJECTED', errorCode: 'BATCH_REJECTED' },
              { ...UPDATE_ROWS[1]!, state: 'REJECTED', errorCode: 'UNKNOWN_MANAGER', proposedChanges: null },
            ],
          }),
        ];
      },
    });
    renderPage(<ImportsPage />);
    await upload(updateCsv('SYN-1,Synthetic Renamed,,,,,,,', 'SYN-2,,,2026-11-01,,,,,SYN-NONE'));
    expect(await screen.findByText(/nothing was applied/)).toBeTruthy();
    // The preview is drawn while the upload is still settling (Validate is then disabled as busy), so wait until the
    // form unlocks: only then does a disabled Validate show that no file is chosen.
    await waitFor(() => expect((screen.getByLabelText('Import file') as HTMLInputElement).disabled).toBe(false));
    expect((screen.getByLabelText('Import file') as HTMLInputElement).files?.length ?? 0).toBe(0);
    expect((screen.getByText('Validate') as HTMLButtonElement).disabled).toBe(true);
    // The corrected file, under the same name.
    await upload(updateCsv('SYN-1,Synthetic Renamed,,,,,,,', 'SYN-2,,,2026-11-01,,,,,SYN-9'));
    expect(await screen.findByText('Update 2 employees')).toBeTruthy();
    const keys = calls.filter((c) => c.method === 'POST').map((c) => c.body!.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('a refused commit leaves a still-previewed batch committable, and its error does not carry over to the next preview', async () => {
    session.permissions = UPDATE_IMPORT;
    let posts = 0;
    mockApi({
      'POST /v1/employees/update-imports': () => {
        posts += 1;
        return [201, updateJob(posts === 1 ? {} : { id: 'job-2', fileName: 'corrected.csv' })];
      },
      'POST /v1/employees/update-imports/job-1/commit': () => [409, { error: 'FILE_INTEGRITY', message: 'The stored import file does not match its checksum' }],
      'GET /v1/employees/update-imports/job-1': updateJob({}),
    });
    renderPage(<ImportsPage />);
    await upload(updateCsv('SYN-1,Synthetic Renamed,,,,,,,'));
    fireEvent.click(await screen.findByText('Update 2 employees'));
    expect((await screen.findByRole('alert')).textContent).toContain('FILE_INTEGRITY');
    // The job view says the batch is still previewed, so it can be committed again.
    expect((screen.getByText('Update 2 employees') as HTMLButtonElement).disabled).toBe(false);
    await upload(updateCsv('SYN-1,Synthetic Renamed Again,,,,,,,'));
    expect(await screen.findByText(/corrected\.csv/, { selector: 'h2' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the template while an upload or a decision is on its way, so a late answer cannot bring back a batch a switch cleared', async () => {
    session.permissions = [...EMPLOYEE_IMPORT, 'employee.update.operational'];
    const preview = deferred([201, updateJob({})]);
    const answer = deferred([200, updateJob({ state: 'COMMITTED', acceptedCount: 2, rows: ACCEPTED_ROWS })]);
    mockApi({ 'POST /v1/employees/update-imports': () => preview.promise, 'POST /v1/employees/update-imports/job-1/commit': () => answer.promise });
    renderPage(<ImportsPage />);
    const select = screen.getByLabelText('Template') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'EMPLOYEE_UPDATE_V1' } });
    expect(select.disabled).toBe(false);
    await upload(updateCsv('SYN-1,Synthetic Renamed,,,,,,,'));
    await waitFor(() => expect(select.disabled).toBe(true));
    preview.release();
    const commit = await screen.findByText('Update 2 employees');
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.click(commit);
    await waitFor(() => expect(select.disabled).toBe(true));
    answer.release();
    expect(await screen.findByText('All 2 rows were applied.')).toBeTruthy();
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe('EMPLOYEE_UPDATE_V1');
  });
});

describe('document scan and verification states (FR-106)', () => {
  it('cannot open a file the scan has not released, and says why', async () => {
    session.permissions = ['document.read.document'];
    mockApi({
      'GET /v1/employees/emp-9/documents': {
        items: [
          { ...DOC, id: 'd-q', fileName: 'flagged.pdf', scanState: 'QUARANTINED', verificationState: 'UNVERIFIED' },
          { ...DOC, id: 'd-p', fileName: 'waiting.pdf', scanState: 'PENDING_SCAN', verificationState: 'UNVERIFIED' },
          { ...DOC, id: 'd-c', fileName: 'released.pdf', scanState: 'CLEAN', verificationState: 'VERIFIED' },
        ],
      },
    });
    renderDocuments();
    const row = async (name: string) => (await screen.findByText(name)).closest('tr')!;
    expect(within(await row('flagged.pdf')).getByText('quarantined by the malware scan')).toBeTruthy();
    expect((within(await row('flagged.pdf')).getByRole('button', { name: 'Download' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(await row('waiting.pdf')).getByRole('button', { name: 'Download' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(await row('released.pdf')).getByRole('button', { name: 'Download' }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(await row('released.pdf')).getByText('verified')).toBeTruthy();
  });

  it('lets a verifier verify a released file, and reject it only with a reason', async () => {
    session.permissions = ['document.read.document', 'document.verify.document'];
    const calls = mockApi({
      'GET /v1/employees/emp-9/documents': { items: [{ ...DOC, scanState: 'CLEAN', verificationState: 'UNVERIFIED' }] },
      'POST /v1/documents/d-1/verification': { id: 'd-1', verificationState: 'VERIFIED' },
    });
    renderDocuments();
    const reject = await screen.findByRole('button', { name: 'Reject' });
    expect((reject as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Rejection reason'), { target: { value: 'Unreadable (synthetic)' } });
    expect((reject as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/v1/documents/d-1/verification')).toBe(true));
    expect(calls.find((c) => c.url === '/v1/documents/d-1/verification')!.body).toEqual({ decision: 'VERIFIED' });
  });
});
