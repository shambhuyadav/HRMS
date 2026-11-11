// Export employee documents to a ZIP (jsdom; BRD coverage CL-027 "Export Employee Documents to ZIP"; FR-010; FR-057; FR-106 released files
// only; BR-045 the export right and the read right; migration 0281). The screen asks what would be exported for exactly the filters
// chosen, offers the archive only when the server says it fits, and says every refusal in words. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOCUMENTS_SCREENS } from './documents';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../held-batch-timing', () => ({ HELD_BATCH_CHECK_INTERVAL_MS: 3_600_000, HELD_BATCH_MAX_CHECKS: 30 }));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: 'c0000000-0000-4000-8000-000000000001', assignmentId: 'a0000000-0000-4000-8000-000000000001' },
    me: { userId: 'b0000000-0000-4000-8000-000000000001', accountKey: 'syn.hr', companyName: 'Synthetic Co', roleCode: 'HR_ADMINISTRATOR', roleName: 'HR', scopeKind: 'COMPANY', employeeId: null, displayName: 'Synthetic HR' },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

const EXPORT = 'document.export.document';
const READ = 'document.read.document';
const DEPT = '91000000-0000-4000-8000-000000000001';

type Reply = [number, unknown];
interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
}
let calls: Call[] = [];
const OPTIONS = {
  departments: [{ id: DEPT, code: 'ENG', name: 'Engineering', active: true }],
  documentTypes: [{ code: 'GENERAL', label: 'General document', active: true }, { code: 'PASSPORT', label: 'Passport', active: true }],
  limits: { files: 200, bytes: 50 * 1024 * 1024 },
};
const LOG = {
  items: [
    {
      id: 'x-1',
      exportedAt: '2026-11-10T09:30:00.000Z',
      documentCount: 3,
      employeeCount: 2,
      byteSize: '4096',
      withheldCount: 1,
      exportedByName: 'Synthetic Hema HR',
      department: { code: 'ENG', name: 'Engineering' },
      documentType: null,
      employee: null,
    },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
};

function serve(routes: Record<string, Reply | ((c: Call) => Reply)>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname, params: url.searchParams };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}`];
      const [status, body] = route === undefined ? [404, { error: 'NOT_FOUND', message: 'Not found' }] : typeof route === 'function' ? route(call) : route;
      if (call.path === '/v1/documents/export' && status === 200) return new Response(new Blob(['PK synthetic']), { status, headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="employee-documents-2026-11-11.zip"' } });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}
const callsTo = (path: string) => calls.filter((c) => c.path === path);

function renderAt(permissions: string[]) {
  session.permissions = permissions;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <MemoryRouter initialEntries={['/documents/export']}>
        <Routes>
          {DOCUMENTS_SCREENS.map((s) => (
            <Route key={s.path} path={s.path} element={<s.component />} />
          ))}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:synthetic-archive');
  URL.revokeObjectURL = vi.fn();
  // jsdom does not navigate; the download's link click is only recorded.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  URL.createObjectURL = original.create;
  URL.revokeObjectURL = original.revoke;
});

describe('CL-027 export documents screen', () => {
  it('CL-027 BR-045: a menu screen under the export right; without both the export and the read right it says so and asks nothing', async () => {
    expect(DOCUMENTS_SCREENS.find((s) => s.path === '/documents/export')).toMatchObject({ permission: EXPORT, nav: true, title: 'Export documents' });
    serve({});
    renderAt([EXPORT]);
    expect(await screen.findByText(/cannot export employee documents/)).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('CL-027 FR-106: checks what exactly these filters would export, says how many files are left out, then downloads the archive and shows it in the log', async () => {
    serve({
      'GET /v1/documents/export/options': [200, OPTIONS],
      'GET /v1/documents/exports': [200, LOG],
      'GET /v1/documents/export/summary': [200, { documents: 3, employees: 2, bytes: 3 * 1024 * 1024, withheld: 1, withinLimits: true, limits: OPTIONS.limits }],
      'GET /v1/documents/export': [200, {}],
    });
    renderAt([EXPORT, READ]);
    const form = await screen.findByRole('form', { name: 'Export filters' });
    await within(form).findByRole('option', { name: 'Engineering' });
    expect(screen.getByText(/at most 200 files and 50\.0 MB/)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Department'), { target: { value: DEPT } });
    fireEvent.change(within(form).getByLabelText('Document type'), { target: { value: 'PASSPORT' } });
    fireEvent.change(within(form).getByLabelText('Employee code (blank: everyone)'), { target: { value: ' syn-001 ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Check what would be exported' }));
    expect((await screen.findByText(/^3 files of 2 employees, 3\.0 MB\./)).textContent).toContain('1 matching file is not released by the malware scan and will be left out.');
    expect(Object.fromEntries(callsTo('/v1/documents/export/summary')[0]!.params)).toEqual({ departmentId: DEPT, documentType: 'PASSPORT', employeeCode: 'syn-001' });
    fireEvent.click(screen.getByRole('button', { name: 'Download the ZIP' }));
    expect(await screen.findByText(/The archive was downloaded/)).toBeTruthy();
    expect(Object.fromEntries(callsTo('/v1/documents/export')[0]!.params)).toEqual({ departmentId: DEPT, documentType: 'PASSPORT', employeeCode: 'syn-001' });
    await waitFor(() => expect(callsTo('/v1/documents/exports').length).toBeGreaterThanOrEqual(2));
    const log = screen.getByRole('table', { name: 'Export log' });
    expect(log.textContent).toContain('Synthetic Hema HR');
    expect(log.textContent).toContain('Department Engineering');
    // A filter changed after the check asks again before anything can be downloaded.
    fireEvent.change(within(form).getByLabelText('Document type'), { target: { value: 'GENERAL' } });
    expect(screen.queryByRole('button', { name: 'Download the ZIP' })).toBeNull();
  });

  it('CL-027: a selection over one archive\'s bound is not offered for download, and refusals read in words', async () => {
    let answer: Reply = [200, { documents: 240, employees: 30, bytes: 1024, withheld: 0, withinLimits: false, limits: OPTIONS.limits }];
    serve({
      'GET /v1/documents/export/options': [200, OPTIONS],
      'GET /v1/documents/exports': [200, { items: [], total: 0, page: 1, pageSize: 25 }],
      'GET /v1/documents/export/summary': () => answer,
    });
    renderAt([EXPORT, READ]);
    const form = await screen.findByRole('form', { name: 'Export filters' });
    fireEvent.click(within(form).getByRole('button', { name: 'Check what would be exported' }));
    expect(await screen.findByText(/more than one archive holds/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download the ZIP' })).toBeNull();
    answer = [404, { error: 'NOT_FOUND', message: 'Not found' }];
    fireEvent.change(within(form).getByLabelText('Employee code (blank: everyone)'), { target: { value: 'NOBODY' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Check what would be exported' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No employee with this code is in the selected role’s scope.');
    expect(screen.getByText('No export yet.')).toBeTruthy();
  });
});
