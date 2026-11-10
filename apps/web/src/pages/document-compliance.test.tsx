// Mandatory documents screen (BRD coverage CL-150 "Employee Document Compliance"; FR-010 dated configuration; FR-056 report with
// filters; BR-045 the report needs its own confidential grant), jsdom. Requests carry exactly what was chosen; controls are hidden
// without their permission keys; refusals are said in words. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const READ = 'document_requirement.read.operational';
const MANAGE = 'document_requirement.manage.operational';
const EXPORT = 'document_compliance.export.document';
const ORG_READ = 'org_master.read.operational';
const R1 = '90000000-0000-4000-8000-000000000001';
const DEPT = '91000000-0000-4000-8000-000000000001';
const LOC = '92000000-0000-4000-8000-000000000001';

type Reply = [number, unknown];
interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}
let calls: Call[] = [];
const LIST = {
  businessDate: '2026-11-10',
  items: [
    { id: R1, documentType: { code: 'PAN', label: 'PAN card' }, employmentType: null, effectiveFrom: '2026-11-10', effectiveTo: null, inForceToday: true, reason: 'Synthetic: tax identity', endReason: null, version: 1 },
    {
      id: '90000000-0000-4000-8000-000000000002',
      documentType: { code: 'VISA', label: 'Visa' },
      employmentType: { code: 'INTERN', label: 'Intern' },
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-11-01',
      inForceToday: false,
      reason: 'Synthetic: travel',
      endReason: 'Synthetic: no longer needed',
      version: 2,
    },
  ],
  options: { documentTypes: [{ code: 'AADHAAR', label: 'Aadhaar card' }, { code: 'PAN', label: 'PAN card' }], employmentTypes: [{ code: 'INTERN', label: 'Intern' }, { code: 'PERMANENT', label: 'Permanent' }] },
};

function serve(routes: Record<string, Reply | ((c: Call) => Reply)>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}`];
      const [status, body] = route === undefined ? [404, { error: 'NOT_FOUND', message: 'Not found' }] : typeof route === 'function' ? route(call) : route;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}
const bodiesTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).map((c) => c.body);

function renderAt(entry: string, permissions: string[]) {
  session.permissions = permissions;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          {DOCUMENTS_SCREENS.map((s) => (
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

describe('mandatory documents screen (CL-150)', () => {
  it('FR-056 BR-045: the menu entry needs the read duty; without the confidential export grant the report says so and nothing is requested', async () => {
    expect(DOCUMENTS_SCREENS.find((s) => s.path === '/documents/mandatory-types')).toMatchObject({ permission: READ, nav: true, title: 'Mandatory documents' });
    serve({ 'GET /v1/document-requirements': [200, LIST] });
    renderAt('/documents/mandatory-types', [READ]);
    const table = await screen.findByRole('table', { name: 'Mandatory document types' });
    const rows = within(table).getAllByRole('row');
    expect(rows[1]!.textContent).toContain('PAN card');
    expect(rows[1]!.textContent).toContain('All employment types');
    expect(rows[1]!.textContent).toContain('in force');
    expect(rows[2]!.textContent).toContain('Intern only');
    expect(rows[2]!.textContent).toContain('ended on 2026-11-01');
    expect(rows[2]!.textContent).toContain('Ended: Synthetic: no longer needed');
    // Read only: no forms, no End buttons; the report needs its own grant.
    expect(screen.queryByRole('form', { name: 'New mandatory document type' })).toBeNull();
    expect(within(table).queryByRole('button', { name: /End the requirement/ })).toBeNull();
    expect(screen.getByText(/The compliance report needs its own confidential grant/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate the compliance report' })).toBeNull();
  });

  it('FR-010: HR makes a type mandatory from today on, per employment type, and ends one with a reason against its version', async () => {
    serve({
      'GET /v1/document-requirements': [200, LIST],
      'POST /v1/document-requirements': (c) => [201, { ...LIST.items[0], id: 'new', documentType: { code: c.body!.documentType, label: 'Aadhaar card' }, employmentType: { code: 'PERMANENT', label: 'Permanent' }, effectiveFrom: c.body!.effectiveFrom }],
      [`POST /v1/document-requirements/${R1}/end`]: [409, { error: 'VERSION_CONFLICT', message: 'x' }],
    });
    renderAt('/documents/mandatory-types', [READ, MANAGE]);
    const add = await screen.findByRole('form', { name: 'New mandatory document type' });
    fireEvent.click(within(add).getByRole('button', { name: 'Make it mandatory' }));
    expect(within(add).getByText('Choose the document type.')).toBeTruthy();
    change(add, 'Document type', 'AADHAAR');
    change(add, 'For', 'PERMANENT');
    change(add, 'Starts on', '2026-11-09');
    change(add, 'Reason', 'Synthetic: identity proof');
    fireEvent.click(within(add).getByRole('button', { name: 'Make it mandatory' }));
    expect(within(add).getByText('Choose today or a later start date.')).toBeTruthy();
    change(add, 'Starts on', '2026-12-01');
    fireEvent.click(within(add).getByRole('button', { name: 'Make it mandatory' }));
    expect(await screen.findByText('Aadhaar card is mandatory for Permanent employees from 2026-12-01.')).toBeTruthy();
    expect(bodiesTo('POST', '/v1/document-requirements')).toEqual([{ documentType: 'AADHAAR', employmentType: 'PERMANENT', effectiveFrom: '2026-12-01', reason: 'Synthetic: identity proof' }]);
    fireEvent.click(screen.getByRole('button', { name: 'End the requirement for PAN card' }));
    const end = screen.getByRole('form', { name: 'End a mandatory document type' });
    change(end, 'Reason', 'Synthetic: replaced');
    fireEvent.click(within(end).getByRole('button', { name: 'End the requirement' }));
    expect(await within(end).findByText(/changed since the page loaded it/)).toBeTruthy();
    expect(bodiesTo('POST', `/v1/document-requirements/${R1}/end`)).toEqual([{ effectiveTo: '2026-11-10', reason: 'Synthetic: replaced', expectedVersion: 1 }]);
  });

  it('FR-056: the compliance report is requested with exactly the chosen department, location, status and as-on date', async () => {
    serve({
      'GET /v1/document-requirements': [200, LIST],
      'GET /v1/org/departments': [200, { items: [{ id: DEPT, code: 'FIN', name: 'Finance' }] }],
      'GET /v1/org/locations': [200, { items: [{ id: LOC, code: 'BR', name: 'Branch' }] }],
      'POST /v1/reports': [202, { id: 'rep-1', state: 'QUEUED' }],
      'GET /v1/reports/rep-1': [200, { state: 'COMPLETED', rowCount: 3, failureCode: null }],
    });
    renderAt('/documents/mandatory-types', [READ, EXPORT, ORG_READ]);
    const form = await screen.findByRole('form', { name: 'Compliance report filters' });
    await waitFor(() => expect(within(form).getByRole('option', { name: 'Finance' })).toBeTruthy());
    await waitFor(() => expect(within(form).getByRole('option', { name: 'Branch' })).toBeTruthy());
    change(form, 'Department', DEPT);
    change(form, 'Location', LOC);
    change(form, 'Employees', 'LEFT');
    change(form, 'As on (blank: today)', '2026-10-31');
    fireEvent.click(screen.getByRole('button', { name: 'Generate the compliance report' }));
    expect(await screen.findByRole('button', { name: 'Download (3 rows)' })).toBeTruthy();
    expect(bodiesTo('POST', '/v1/reports')).toEqual([{ reportCode: 'EMPLOYEE_DOCUMENT_COMPLIANCE', filters: { departmentId: DEPT, locationId: LOC, statusGroup: 'LEFT', to: '2026-10-31' } }]);
  });

  it('FR-056: by default the report covers active employees as on today, with no filter sent', async () => {
    serve({ 'GET /v1/document-requirements': [200, LIST], 'POST /v1/reports': [202, { id: 'rep-2', state: 'QUEUED' }], 'GET /v1/reports/rep-2': [200, { state: 'QUEUED', rowCount: null, failureCode: null }] });
    renderAt('/documents/mandatory-types', [READ, EXPORT]);
    fireEvent.click(await screen.findByRole('button', { name: 'Generate the compliance report' }));
    await waitFor(() => expect(bodiesTo('POST', '/v1/reports')).toEqual([{ reportCode: 'EMPLOYEE_DOCUMENT_COMPLIANCE', filters: {} }]));
    // Without the organisation read duty no department or location list is offered or asked for.
    expect(calls.some((c) => c.path.startsWith('/v1/org/'))).toBe(false);
  });
});
