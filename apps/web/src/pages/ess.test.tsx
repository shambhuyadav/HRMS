// My ESS and the sensitive-change review queue (FR-103 to FR-105, FR-109), jsdom with fetch mocks. Synthetic data.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MyEssPage, SensitiveChangeReviewPage } from './ess';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({
    me: { accountKey: 'syn.emp', companyName: 'Synthetic Co', roleCode: 'EMPLOYEE', roleName: 'Employee', scopeKind: 'OWN', employeeId: 'emp-1', displayName: 'Synthetic Person' },
    can: (p: string) => session.permissions.includes(p),
  }),
}));

type Call = { url: string; method: string; body: unknown };
function mockApi(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      const key = Object.keys(routes).find((k) => `${method} ${url}` === k) ?? Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
      return new Response(JSON.stringify(key ? routes[key] : { error: 'NOT_FOUND', message: 'Not found' }), { status: key ? 200 : 404, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}
const renderPage = (ui: JSX.Element) =>
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );

const tab = (id: string, name: string, section: string, status: 'AVAILABLE' | 'UNAVAILABLE' | 'NOT_PERMITTED' = 'AVAILABLE', message?: string) => ({
  id,
  name,
  section,
  status,
  links: [],
  ...(status === 'AVAILABLE' ? {} : { unavailable: { code: status === 'UNAVAILABLE' ? 'PAYROLL_NOT_ENABLED' : 'NOT_PERMITTED', message: message ?? 'Not available.' } }),
});
const INDEX = {
  context: { employeeId: 'emp-1', employeeCode: 'E-001', employeeName: 'Synthetic Person', roleCode: 'EMPLOYEE', scopeKind: 'OWN' },
  tabs: [
    tab('TN01', 'My Profile', 'Personal'),
    tab('TN02', 'Personal details change request', 'Personal'),
    tab('TN03', 'Bank change request', 'Personal'),
    tab('TN04', 'Address change', 'Personal'),
    tab('TN05', 'Document upload', 'Personal', 'NOT_PERMITTED', 'Your Employee role does not include this yet; contact HR.'),
    tab('TN06', 'Payslip', 'Financial', 'UNAVAILABLE', 'Available once payroll is enabled for your company.'),
    tab('TN07', 'Form 16', 'Financial', 'UNAVAILABLE'),
    tab('TN08', 'Tax declaration', 'Financial', 'UNAVAILABLE'),
    tab('TN09', 'Investment proof', 'Financial', 'UNAVAILABLE'),
    tab('TN10', 'Leave', 'Time and Requests'),
    tab('TN11', 'Attendance', 'Time and Requests'),
    tab('TN12', 'Regularization', 'Time and Requests'),
    tab('TN13', 'Timesheet', 'Time and Requests', 'UNAVAILABLE'),
    tab('TN14', 'Expense', 'Time and Requests'),
    tab('TN15', 'Loan/advance', 'Financial', 'UNAVAILABLE'),
    tab('TN16', 'Assets', 'Time and Requests', 'UNAVAILABLE'),
    tab('TN17', 'Training', 'Development', 'UNAVAILABLE'),
    tab('TN18', 'Appraisal', 'Development', 'UNAVAILABLE'),
  ],
};
const PROFILE = {
  personal: { revision: 0, effectiveFrom: null, values: { dateOfBirth: '1990-04-12' } },
  address: { revision: 1, effectiveFrom: '2026-10-25', values: { line1: '12 Synthetic Street', city: 'Testville', countryCode: 'IN' } },
  bank: { revision: 1, effectiveFrom: '2026-10-25', masked: true, values: { holderName: 'Synthetic Person', accountIdentifier: '••••6789', routingReference: 'SYNT0000001', countryCode: 'IN' } },
};

/** modules/payroll/cutoff.ts PayrollCutoffWarning: period and dates only, never a bank value. */
const CUTOFF = {
  code: 'AFTER_PAYROLL_CUTOFF',
  calendarCode: 'MONTHLY',
  periodCode: '2026-10',
  inputCutoff: '2026-10-25',
  paymentDate: '2026-10-31',
  effectiveDate: '2026-10-29',
  message: 'Synthetic server wording',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

describe('My ESS (FR-103)', () => {
  it('shows every tab with the own-record context, and a named state for an unavailable tab', async () => {
    mockApi({ 'GET /v1/me/ess': INDEX, 'GET /v1/me/private-profile': PROFILE });
    renderPage(<MyEssPage />);
    expect((await screen.findByLabelText('Own record')).textContent).toContain('Synthetic Person (E-001)');
    expect(screen.getAllByRole('tab')).toHaveLength(18);
    // TN01 opens first and shows the masked bank summary only.
    expect(await screen.findByText('••••6789')).toBeTruthy();
    expect(screen.getByText('12 Synthetic Street')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Payslip/ }));
    expect(screen.getByRole('tabpanel').textContent).toContain('Available once payroll is enabled for your company.');
    expect(within(screen.getByRole('tabpanel')).queryByRole('link')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Document upload/ }));
    expect(screen.getByRole('tabpanel').textContent).toContain('contact HR');
  });

  it('drafts an address change with only the typed fields, then submits it with its version (FR-104)', async () => {
    session.permissions = ['sensitive_change.submit.private'];
    const calls = mockApi({
      'GET /v1/me/ess': INDEX,
      'GET /v1/me/private-profile': PROFILE,
      'GET /v1/me/sensitive-changes': {
        items: [{ id: 'sc-1', category: 'ADDRESS', state: 'DRAFT', effectiveDate: '2026-10-25', changedFields: ['city'], proposed: { city: 'Newtown' }, before: { city: 'Testville' }, employeeMessage: null, pendingWith: null, decisions: [], version: 3 }],
      },
      'POST /v1/me/sensitive-changes/sc-1/submit': { requestId: 'sc-1', state: 'SUBMITTED' },
      'POST /v1/me/sensitive-changes': { requestId: 'sc-2', state: 'DRAFT' },
    });
    renderPage(<MyEssPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Address change' }));
    const form = await screen.findByRole('form', { name: 'New address request' });
    const save = within(form).getByRole('button', { name: 'Save draft' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('City'), { target: { value: ' Oldtown ' } });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Moved (synthetic)' } });
    fireEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/v1/me/sensitive-changes')).toBe(true));
    expect(calls.find((c) => c.method === 'POST' && c.url === '/v1/me/sensitive-changes')!.body).toEqual({ category: 'ADDRESS', values: { city: 'Oldtown' }, reason: 'Moved (synthetic)' });

    fireEvent.click(await screen.findByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/me/sensitive-changes/sc-1/submit')).toBe(true));
    expect(calls.find((c) => c.url === '/v1/me/sensitive-changes/sc-1/submit')!.body).toEqual({ expectedVersion: 3 });
  });

  it('offers no request form without the submit duty and shows the reviewer’s message, never a private note', async () => {
    mockApi({
      'GET /v1/me/ess': INDEX,
      'GET /v1/me/private-profile': PROFILE,
      'GET /v1/me/sensitive-changes': {
        items: [{ id: 'sc-3', category: 'BANK', state: 'RETURNED', effectiveDate: '2026-10-25', changedFields: ['accountIdentifier'], proposed: { accountIdentifier: '000987654321' }, before: { accountIdentifier: '••••6789' }, employeeMessage: 'Attach a bank letter', pendingWith: null, decisions: [{ decision: 'RETURN', decidedAt: '2026-10-25T06:00:00Z' }], version: 2 }],
      },
    });
    renderPage(<MyEssPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Bank change request' }));
    expect(await screen.findByText('Attach a bank letter')).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revise' })).toBeNull();
  });

  it('warns in plain words, without bank values, when a submitted bank change falls after the payroll cutoff (FR-105)', async () => {
    session.permissions = ['sensitive_change.submit.private'];
    const calls = mockApi({
      'GET /v1/me/ess': INDEX,
      'GET /v1/me/private-profile': PROFILE,
      'GET /v1/me/sensitive-changes': {
        items: [{ id: 'sc-5', category: 'BANK', state: 'DRAFT', effectiveDate: '2026-10-29', changedFields: ['accountIdentifier'], proposed: { accountIdentifier: '000987654321' }, before: { accountIdentifier: '••••6789' }, employeeMessage: null, pendingWith: null, decisions: [], version: 1 }],
      },
      'POST /v1/me/sensitive-changes/sc-5/submit': { requestId: 'sc-5', state: 'SUBMITTED', payrollCutoffWarning: CUTOFF },
    });
    renderPage(<MyEssPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Bank change request' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/me/sensitive-changes/sc-5/submit')).toBe(true));
    const warning = await screen.findByText(/after the input cutoff/);
    expect(warning.closest('p')!.textContent).toBe(
      'after payroll cutoff This bank change takes effect on 2026-10-29, after the input cutoff (2026-10-25) of payroll period 2026-10. The 2026-10 payment due on 2026-10-31 may still be made to the current bank account.',
    );
    expect(warning.closest('p')!.textContent).not.toContain('000987654321');
    expect(screen.getByText('Request submitted for review.')).toBeTruthy();
  });

  it('shows no cutoff warning when the submission carries none', async () => {
    session.permissions = ['sensitive_change.submit.private'];
    mockApi({
      'GET /v1/me/ess': INDEX,
      'GET /v1/me/private-profile': PROFILE,
      'GET /v1/me/sensitive-changes': {
        items: [{ id: 'sc-6', category: 'BANK', state: 'DRAFT', effectiveDate: '2026-10-29', changedFields: ['holderName'], proposed: { holderName: 'Synthetic Person' }, before: { holderName: 'S Person' }, employeeMessage: null, pendingWith: null, decisions: [], version: 1 }],
      },
      'POST /v1/me/sensitive-changes/sc-6/submit': { requestId: 'sc-6', state: 'SUBMITTED' },
    });
    renderPage(<MyEssPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Bank change request' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Request submitted for review.')).toBeTruthy();
    expect(screen.queryByText(/after the input cutoff/)).toBeNull();
  });

  it('shows the cutoff warning of a pending bank change from the list, when the page is opened later (FR-105)', async () => {
    mockApi({
      'GET /v1/me/ess': INDEX,
      'GET /v1/me/private-profile': PROFILE,
      'GET /v1/me/sensitive-changes': {
        items: [
          { id: 'sc-7', category: 'BANK', state: 'IN_REVIEW', effectiveDate: '2026-10-29', changedFields: ['accountIdentifier'], proposed: { accountIdentifier: '000987654321' }, before: { accountIdentifier: '••••6789' }, employeeMessage: null, pendingWith: 'Synthetic Reviewer', decisions: [], version: 2, payrollCutoffWarning: CUTOFF },
          { id: 'sc-8', category: 'BANK', state: 'APPLIED', effectiveDate: '2026-09-01', changedFields: ['holderName'], proposed: { holderName: 'Synthetic Person' }, before: { holderName: 'S Person' }, employeeMessage: null, pendingWith: null, decisions: [], version: 3 },
        ],
      },
    });
    renderPage(<MyEssPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Bank change request' }));
    const warnings = await screen.findAllByText(/after the input cutoff/);
    expect(warnings).toHaveLength(1);
    const row = warnings[0]!.closest('tr')!;
    expect(row.textContent).toContain('with Synthetic Reviewer');
    expect(warnings[0]!.closest('p')!.textContent).toBe(
      'after payroll cutoff This bank change takes effect on 2026-10-29, after the input cutoff (2026-10-25) of payroll period 2026-10. The 2026-10 payment due on 2026-10-31 may still be made to the current bank account.',
    );
    expect(warnings[0]!.closest('p')!.textContent).not.toContain('000987654321');
  });

  it('after a submission shows the warning once, in the request’s row, when the list carries it (FR-105)', async () => {
    session.permissions = ['sensitive_change.submit.private'];
    const draft = { id: 'sc-9', category: 'BANK', state: 'DRAFT', effectiveDate: '2026-10-29', changedFields: ['accountIdentifier'], proposed: { accountIdentifier: '000987654321' }, before: { accountIdentifier: '••••6789' }, employeeMessage: null, pendingWith: null, decisions: [], version: 1 };
    let submitted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const key = `${init?.method ?? 'GET'} ${url}`;
        let body: unknown = { error: 'NOT_FOUND', message: 'Not found' };
        if (key === 'GET /v1/me/ess') body = INDEX;
        if (key === 'GET /v1/me/private-profile') body = PROFILE;
        if (key === 'GET /v1/me/sensitive-changes') body = { items: [submitted ? { ...draft, state: 'SUBMITTED', payrollCutoffWarning: CUTOFF } : draft] };
        if (key === 'POST /v1/me/sensitive-changes/sc-9/submit') {
          submitted = true;
          body = { requestId: 'sc-9', state: 'SUBMITTED', payrollCutoffWarning: CUTOFF };
        }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    renderPage(<MyEssPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Bank change request' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Request submitted for review.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull());
    const warnings = screen.getAllByText(/after the input cutoff/);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.closest('tr')).not.toBeNull();
  });

  it('lists own requests with their decisions for a request tab (FR-109)', async () => {
    mockApi({
      'GET /v1/me/ess': INDEX,
      'GET /v1/me/private-profile': PROFILE,
      'GET /v1/me/requests?kind=leave_request': {
        items: [{ transactionId: 't-1', requestId: 'lr-1', kind: 'leave_request', state: 'APPROVED', pendingWith: null, createdAt: '2026-10-20', decisions: [{ step: 1, decision: 'APPROVE', decidedAt: '2026-10-21' }] }],
        total: 1,
        page: 1,
        pageSize: 25,
      },
    });
    renderPage(<MyEssPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Leave' }));
    expect(await screen.findByText('step 1: approve on 2026-10-21')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open leave' }).getAttribute('href')).toBe('/leave');
    // Everything fits on one page: no pager.
    expect(screen.queryByRole('navigation', { name: 'Request pages' })).toBeNull();
  });

  it('pages own requests with the total, asking for each page (FR-056)', async () => {
    const request = (n: number) => ({ transactionId: `t-${n}`, requestId: `lr-${n}`, kind: 'leave_request', state: 'REJECTED', pendingWith: null, createdAt: '2026-10-20', decisions: [] });
    const calls = mockApi({
      'GET /v1/me/ess': INDEX,
      'GET /v1/me/private-profile': PROFILE,
      'GET /v1/me/requests?kind=leave_request&page=2&pageSize=25': { items: [request(26), request(27)], total: 27, page: 2, pageSize: 25 },
      'GET /v1/me/requests?kind=leave_request&page=1&pageSize=25': { items: Array.from({ length: 25 }, (_, i) => request(i + 1)), total: 27, page: 1, pageSize: 25 },
    });
    renderPage(<MyEssPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Leave' }));
    const pager = await screen.findByRole('navigation', { name: 'Request pages' });
    expect(pager.textContent).toContain('Page 1 of 2 · 27 requests');
    expect(within(screen.getByRole('tabpanel')).getAllByRole('row')).toHaveLength(26); // header + 25
    fireEvent.click(within(pager).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Request pages' }).textContent).toContain('Page 2 of 2 · 27 requests'));
    expect(within(screen.getByRole('tabpanel')).getAllByRole('row')).toHaveLength(3);
    expect(calls.filter((c) => c.url.startsWith('/v1/me/requests')).map((c) => c.url)).toEqual([
      '/v1/me/requests?kind=leave_request&page=1&pageSize=25',
      '/v1/me/requests?kind=leave_request&page=2&pageSize=25',
    ]);
  });
});

describe('sensitive-change review (FR-104, FR-105)', () => {
  const task = (state: string, baseHolds = true) => ({
    taskId: 'task-1',
    transactionId: 't-1',
    request: {
      id: 'sc-1',
      category: 'BANK',
      state,
      effectiveDate: '2026-10-25',
      changedFields: ['accountIdentifier'],
      proposed: { accountIdentifier: '000123456789' },
      before: { accountIdentifier: '••••4321' },
      employeeMessage: null,
      pendingWith: 'HR Admin',
      decisions: [],
      version: 2,
      employeeName: 'Synthetic Person',
      employeeCode: 'E-001',
      current: { accountIdentifier: '••••4321' },
      baseHolds,
      evidenceRequired: true,
      reason: 'New synthetic account',
      evidence: [{ documentId: 'doc-1', documentType: 'GENERAL' }],
    },
  });

  it('starts the review before any decision', async () => {
    const calls = mockApi({ 'GET /v1/sensitive-changes/tasks/mine': { items: [task('SUBMITTED')] }, 'POST /v1/sensitive-changes/tasks/task-1/start-review': { state: 'IN_REVIEW' } });
    renderPage(<SensitiveChangeReviewPage />);
    expect(await screen.findByText('000123456789')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start review' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/sensitive-changes/tasks/task-1/start-review')).toBe(true));
  });

  it('needs a private note to approve and an employee message to return; warns when the base changed', async () => {
    const calls = mockApi({ 'GET /v1/sensitive-changes/tasks/mine': { items: [task('IN_REVIEW', false)] }, 'POST /v1/sensitive-changes/tasks/task-1/decision': { state: 'RETURNED' } });
    renderPage(<SensitiveChangeReviewPage />);
    expect((await screen.findByRole('alert')).textContent).toContain('end it in conflict');
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    const ret = screen.getByRole('button', { name: 'Return' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(ret.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Message to the employee/), { target: { value: 'Attach a bank letter' } });
    expect(ret.disabled).toBe(false);
    expect(approve.disabled).toBe(true);
    fireEvent.click(ret);
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/sensitive-changes/tasks/task-1/decision')).toBe(true));
    const body = calls.find((c) => c.url === '/v1/sensitive-changes/tasks/task-1/decision')!.body as Record<string, string>;
    expect(body).toMatchObject({ decision: 'RETURN', employeeMessage: 'Attach a bank letter' });
    expect(body.reason).toBeUndefined();
    expect(body.idempotencyKey).toMatch(/^sensitive-/);
  });

  it('shows the payroll cutoff warning before the decision, and again with the approval once the request leaves the queue (FR-105)', async () => {
    let decided = false;
    const queued = { ...task('IN_REVIEW'), request: { ...task('IN_REVIEW').request, payrollCutoffWarning: CUTOFF } };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        let body: unknown = { error: 'NOT_FOUND', message: 'Not found' };
        if (method === 'GET' && url === '/v1/sensitive-changes/tasks/mine') body = { items: decided ? [] : [queued] };
        if (method === 'POST' && url === '/v1/sensitive-changes/tasks/task-1/decision') {
          decided = true;
          body = { requestId: 'sc-1', state: 'SCHEDULED', replayed: false, payrollCutoffWarning: CUTOFF };
        }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    renderPage(<SensitiveChangeReviewPage />);
    const before = await screen.findByText(/after the input cutoff/);
    expect(before.closest('article')).toBeTruthy();
    expect(before.closest('p')!.textContent).toContain('payroll period 2026-10');
    fireEvent.change(screen.getByLabelText(/Private note/), { target: { value: 'Bank letter verified (synthetic)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Synthetic Person (E-001), bank details: approved; it applies on its effective date.')).toBeTruthy();
    expect(await screen.findByText('No changes are waiting for you.')).toBeTruthy();
    const after = screen.getByText(/after the input cutoff/).closest('p')!;
    expect(after.closest('article')).toBeNull();
    expect(after.textContent).toContain('The 2026-10 payment due on 2026-10-31 may still be made to the current bank account.');
    // The warning carries no bank value: neither the requested nor the masked current one.
    expect(after.textContent).not.toMatch(/000123456789|4321/);
  });
});
