// Leave, expenses and the decision inbox (jsdom): a claim retried after a submit-step error revises its own draft
// (web-2); resubmitting returned leave keeps the private reason unless a new one is typed (web-3); every queue
// item says what is being decided, and profile changes and attendance corrections have their own queues (web-5);
// own-record calls are made only where the role's scope can include the own record (web-9); instants are shown
// as the local calendar day (web-12); a work-request task lists its supporting documents and the assigned reviewer
// opens released ones through the request's evidence route (FR-027 with FR-106, I-22).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSession } from '../api';
import { ExpensesPage, LeavePage, PaymentsPage, ReportsPage, TasksPage } from './work';

const session = vi.hoisted(() => ({ permissions: [] as string[], scopeKind: 'OWN', employeeId: 'emp-1' as string | null }));
vi.mock('../session', () => ({
  useSession: () => ({
    me: { accountKey: 'syn.user', companyName: 'Synthetic Co', roleCode: 'EMPLOYEE', roleName: 'Employee', scopeKind: session.scopeKind, employeeId: session.employeeId, displayName: 'Synthetic Person' },
    can: (p: string) => session.permissions.includes(p),
  }),
}));

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
type Reply = [number, unknown];
type Route = unknown | ((call: Call) => Reply | Promise<Reply>);
/** Routes are "METHOD /path" (the longest matching prefix wins); a function answers [status, body], or a promise of it (an answer still on its way). */
function mockApi(routes: Record<string, Route>) {
  const calls: Call[] = [];
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
const renderPage = (ui: JSX.Element) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null);
  session.permissions = [];
  session.scopeKind = 'OWN';
  session.employeeId = 'emp-1';
});

// ---------------------------------------------------------------------------------------------------------
// web-2: expense claim retry
// ---------------------------------------------------------------------------------------------------------

async function fillClaim() {
  fireEvent.change(await screen.findByLabelText('Business purpose'), { target: { value: 'Synthetic client visit' } });
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-01' } });
  fireEvent.change(screen.getByLabelText('Merchant'), { target: { value: 'Synthetic Cabs' } });
  fireEvent.change(screen.getByLabelText('Amount (INR)'), { target: { value: '450' } });
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Airport transfer' } });
  fireEvent.change(screen.getByLabelText('Receipt (PDF, JPEG or PNG)'), { target: { files: [new File(['%PDF-1.4 synthetic'], 'cab.pdf', { type: 'application/pdf' })] } });
}

const LINE = { category: 'OTHER', expenseDate: '2026-08-01', merchant: 'Synthetic Cabs', grossAmount: '450', claimedAmount: '450', description: 'Airport transfer' };

describe('expense claim submission (web-2)', () => {
  it('a retry after a submit-step error revises the same draft, reuses the uploaded receipt and submits it', async () => {
    session.permissions = ['expense.draft.operational', 'expense.submit.operational', 'expense.read.operational'];
    let version = 1;
    let submits = 0;
    const calls = mockApi({
      'GET /v1/employees/emp-1/expense-claims': { items: [] },
      'POST /v1/expense/receipts': () => [201, { receiptId: 'rc-1', mediaType: 'application/pdf', byteSize: 18 }],
      'POST /v1/expense/claims': () => [201, { claimId: 'cl-1', revision: 1, state: 'DRAFT' }],
      'GET /v1/expense/claims/cl-1': () => [200, { id: 'cl-1', state: 'DRAFT', version, purpose: 'Synthetic client visit', currency: 'INR', lines: [] }],
      'PUT /v1/expense/claims/cl-1': () => {
        version += 1;
        return [200, { claimId: 'cl-1', revision: 1, state: 'DRAFT' }];
      },
      'POST /v1/expense/claims/cl-1/submit': () =>
        ++submits === 1
          ? [422, { error: 'EXCEPTION_REASON_REQUIRED', message: 'Flagged lines need an exception reason', details: { lines: [{ line: 1, flags: ['LATE_SUBMISSION'] }] } }]
          : [200, { claimId: 'cl-1', state: 'MANAGER_PENDING' }],
    });
    renderPage(<ExpensesPage />);
    await fillClaim();
    fireEvent.click(screen.getByText('Submit claim'));
    expect((await screen.findByRole('alert')).textContent).toContain('line 1 needs a reason (LATE_SUBMISSION)');
    // Nothing typed is lost after the error.
    expect((screen.getByLabelText('Business purpose') as HTMLInputElement).value).toBe('Synthetic client visit');

    fireEvent.change(screen.getByLabelText('Exception reason (if over limit, late or without receipt)'), { target: { value: 'Synthetic late filing' } });
    fireEvent.click(screen.getByText('Submit claim'));
    expect(await screen.findByText('Claim submitted for review.')).toBeTruthy();

    expect(calls.filter((c) => c.method === 'POST' && c.url === '/v1/expense/claims')).toHaveLength(1);
    expect(calls.filter((c) => c.url === '/v1/expense/receipts')).toHaveLength(1);
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe('/v1/expense/claims/cl-1');
    expect(puts[0]!.body).toEqual({
      expectedVersion: 1,
      purpose: 'Synthetic client visit',
      currency: 'INR',
      lines: [{ ...LINE, exceptionReason: 'Synthetic late filing', receipt: { receiptId: 'rc-1' } }],
    });
    expect(calls.filter((c) => c.url === '/v1/expense/claims/cl-1/submit').map((c) => c.body)).toEqual([{ expectedVersion: 1 }, { expectedVersion: 2 }]);
    // Reset only after success.
    expect((screen.getByLabelText('Business purpose') as HTMLInputElement).value).toBe('');
  });

  it('I-87: a line paid in another currency is sent with its code and its own amount, in an INR claim; the server converts it', async () => {
    session.permissions = ['expense.draft.operational', 'expense.submit.operational', 'expense.read.operational'];
    const calls = mockApi({
      'GET /v1/employees/emp-1/expense-claims': { items: [] },
      'POST /v1/expense/receipts': () => [201, { receiptId: 'rc-1', mediaType: 'application/pdf', byteSize: 18 }],
      'POST /v1/expense/claims': () => [201, { claimId: 'cl-20', revision: 1, state: 'DRAFT' }],
      'GET /v1/expense/claims/cl-20': () => [200, { id: 'cl-20', state: 'DRAFT', version: 1, purpose: 'Synthetic client visit', currency: 'INR', lines: [] }],
      'POST /v1/expense/claims/cl-20/submit': () => [200, { claimId: 'cl-20', state: 'MANAGER_PENDING' }],
    });
    renderPage(<ExpensesPage />);
    await fillClaim();
    fireEvent.change(screen.getByLabelText('Paid in another currency (code, if not INR)'), { target: { value: 'eur' } });
    expect(screen.getByLabelText('Amount (EUR)')).toBeTruthy();
    fireEvent.click(screen.getByText('Submit claim'));
    expect(await screen.findByText('Claim submitted for review.')).toBeTruthy();
    const created = calls.find((c) => c.method === 'POST' && c.url === '/v1/expense/claims')!.body as { currency: string; lines: unknown[] };
    expect(created.currency).toBe('INR');
    expect(created.lines).toEqual([{ ...LINE, currency: 'EUR', receipt: { receiptId: 'rc-1' } }]);
  });

  it('a retry after a submission whose answer was lost does not file the claim a second time', async () => {
    session.permissions = ['expense.draft.operational', 'expense.submit.operational'];
    let state = 'DRAFT';
    const calls = mockApi({
      'GET /v1/employees/emp-1/expense-claims': { items: [] },
      'POST /v1/expense/receipts': () => [201, { receiptId: 'rc-3', mediaType: 'application/pdf', byteSize: 18 }],
      'POST /v1/expense/claims': () => [201, { claimId: 'cl-3', revision: 1, state: 'DRAFT' }],
      'GET /v1/expense/claims/cl-3': () => [200, { id: 'cl-3', state, version: state === 'DRAFT' ? 1 : 2, lines: [] }],
      // The server submits the claim, but the answer never reaches the browser.
      'POST /v1/expense/claims/cl-3/submit': () => {
        state = 'MANAGER_PENDING';
        return [503, { error: 'UNAVAILABLE', message: 'Synthetic gateway timeout' }];
      },
    });
    renderPage(<ExpensesPage />);
    await fillClaim();
    fireEvent.click(screen.getByText('Submit claim'));
    expect((await screen.findByRole('alert')).textContent).toContain('UNAVAILABLE');
    fireEvent.click(screen.getByText('Submit claim'));
    expect(await screen.findByText('Claim submitted for review.')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/v1/expense/claims')).toHaveLength(1);
    expect(calls.filter((c) => c.url === '/v1/expense/claims/cl-3/submit')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('a submission still under way when the role or company changes sends nothing more under the new one', async () => {
    session.permissions = ['expense.draft.operational', 'expense.submit.operational'];
    setSession({ token: 'tok-emp', companyId: 'c-1', assignmentId: 'a-emp-1' });
    let uploadAnswer: (r: [number, unknown]) => void = () => undefined;
    const calls = mockApi({
      'GET /v1/employees/emp-1/expense-claims': { items: [] },
      'POST /v1/expense/receipts': () => new Promise<[number, unknown]>((resolve) => (uploadAnswer = resolve)),
      'POST /v1/expense/claims': () => [201, { claimId: 'cl-8', revision: 1, state: 'DRAFT' }],
    });
    renderPage(<ExpensesPage />);
    await fillClaim();
    fireEvent.click(screen.getByText('Submit claim'));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/expense/receipts')).toBe(true));
    // While the receipt is uploading, the user switches to a role in another company.
    setSession({ token: 'tok-emp', companyId: 'c-2', assignmentId: 'a-emp-2' });
    uploadAnswer([201, { receiptId: 'rc-8', mediaType: 'application/pdf', byteSize: 18 }]);
    expect((await screen.findByRole('alert')).textContent).toContain('SESSION_CHANGED');
    expect(calls.some((c) => c.url.startsWith('/v1/expense/claims'))).toBe(false);
  });

  it('a retry after the draft itself was refused creates the draft then, still without uploading the receipt again', async () => {
    session.permissions = ['expense.draft.operational', 'expense.submit.operational'];
    let creates = 0;
    const calls = mockApi({
      'GET /v1/employees/emp-1/expense-claims': { items: [] },
      'POST /v1/expense/receipts': () => [201, { receiptId: 'rc-7', mediaType: 'application/pdf', byteSize: 18 }],
      'POST /v1/expense/claims': () =>
        ++creates === 1 ? [422, { error: 'INVALID_REFERENCE', message: 'Unknown expense category OTHER' }] : [201, { claimId: 'cl-2', revision: 1, state: 'DRAFT' }],
      'GET /v1/expense/claims/cl-2': { id: 'cl-2', state: 'DRAFT', version: 1, lines: [] },
      'POST /v1/expense/claims/cl-2/submit': { claimId: 'cl-2', state: 'MANAGER_PENDING' },
    });
    renderPage(<ExpensesPage />);
    await fillClaim();
    fireEvent.click(screen.getByText('Submit claim'));
    expect((await screen.findByRole('alert')).textContent).toContain('INVALID_REFERENCE');
    fireEvent.click(screen.getByText('Submit claim'));
    expect(await screen.findByText('Claim submitted for review.')).toBeTruthy();
    expect(calls.filter((c) => c.url === '/v1/expense/receipts')).toHaveLength(1);
    const creations = calls.filter((c) => c.method === 'POST' && c.url === '/v1/expense/claims');
    expect(creations).toHaveLength(2);
    expect(creations[1]!.body).toEqual({ purpose: 'Synthetic client visit', currency: 'INR', lines: [{ ...LINE, receipt: { receiptId: 'rc-7' } }] });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------
// web-3: leave resubmission and the private reason
// ---------------------------------------------------------------------------------------------------------

const LEAVE_ROUTES = {
  'GET /v1/employees/emp-1/leave-balances': { items: [{ leaveType: 'ANNUAL', paid: true, available: '10.0000', pending: '0.0000', taken: '0.0000' }] },
  'GET /v1/employees/emp-1/leave-requests': {
    items: [{ id: 'lr-1', leaveType: 'ANNUAL', startDate: '2026-11-02', endDate: '2026-11-03', halfDay: false, units: '2.0000', state: 'RETURNED', version: 3, cancellationState: null }],
  },
  'PUT /v1/leave/requests/lr-1': { requestId: 'lr-1', units: '1.0000', revision: 2, state: 'SUBMITTED' },
};

describe('raising rejected leave and claims again (DF03, I-66)', () => {
  it('leave: fills the form from the rejected request, never its private reason, and links the new one; followed or undutied ones are not offered', async () => {
    session.permissions = ['leave.submit.operational', 'leave.read.operational'];
    const row = { id: 'lr-9', leaveType: 'ANNUAL', startDate: '2026-11-02', endDate: '2026-11-03', halfDay: false, units: '2.0000', state: 'REJECTED', version: 1, cancellationState: null };
    const calls = mockApi({
      'GET /v1/employees/emp-1/leave-balances': LEAVE_ROUTES['GET /v1/employees/emp-1/leave-balances'],
      'GET /v1/employees/emp-1/leave-requests': { items: [row, { ...row, id: 'lr-8' }, { ...row, id: 'lr-10', state: 'SUBMITTED', predecessorRequestId: 'lr-8' }] },
      'GET /v1/employees/emp-1/documents': { items: [] },
      'POST /v1/leave/requests': [201, { requestId: 'lr-11', state: 'SUBMITTED' }],
    });
    renderPage(<LeavePage />);
    const offers = await screen.findAllByText('Raise again');
    expect(offers).toHaveLength(1);
    expect(screen.getAllByText('Raised again after a rejected request')).toHaveLength(1);
    fireEvent.click(offers[0]!);
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-11-02');
    expect((screen.getByLabelText('Reason (private, optional)') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByText('Submit request'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/v1/leave/requests')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ leaveType: 'ANNUAL', startDate: '2026-11-02', endDate: '2026-11-03', halfDay: false, predecessorRequestId: 'lr-9' });
  });

  it('a claim: the form takes the rejected text with no receipt, and only the new claim names what it follows, also on a retry', async () => {
    session.permissions = ['expense.draft.operational', 'expense.submit.operational', 'expense.read.operational'];
    let submits = 0;
    const calls = mockApi({
      'GET /v1/employees/emp-1/expense-claims': { items: [{ id: 'cl-9', purpose: 'Synthetic rejected visit', state: 'REJECTED', paymentState: 'NOT_APPLICABLE', claimedTotal: '450.00', currency: 'INR', version: 2 }] },
      'GET /v1/expense/claims/cl-9': { id: 'cl-9', state: 'REJECTED', version: 2, purpose: 'Synthetic rejected visit', currency: 'INR', lines: [{ ...LINE, nights: null, invoiceReference: null, receiptId: 'rc-old', receiptScanState: 'CLEAN' }] },
      'POST /v1/expense/receipts': () => [201, { receiptId: 'rc-new', mediaType: 'application/pdf', byteSize: 18 }],
      'POST /v1/expense/claims': () => [201, { claimId: 'cl-10', revision: 1, state: 'DRAFT' }],
      'GET /v1/expense/claims/cl-10': { id: 'cl-10', state: 'DRAFT', version: 1, purpose: 'Synthetic rejected visit', currency: 'INR', lines: [] },
      'PUT /v1/expense/claims/cl-10': { claimId: 'cl-10', revision: 1, state: 'DRAFT' },
      'POST /v1/expense/claims/cl-10/submit': () => (++submits === 1 ? [409, { error: 'BUSY', message: 'Synthetic refusal' }] : [200, { claimId: 'cl-10', state: 'MANAGER_PENDING' }]),
    });
    renderPage(<ExpensesPage />);
    fireEvent.click(await screen.findByText('Raise again'));
    await waitFor(() => expect((screen.getByLabelText('Business purpose') as HTMLInputElement).value).toBe('Synthetic rejected visit'));
    expect(await screen.findByText('Attach the receipts again: they stay with the rejected claim.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Receipt (PDF, JPEG or PNG)'), { target: { files: [new File(['%PDF-1.4 synthetic'], 'cab.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(screen.getByText('Submit claim'));
    await waitFor(() => expect(submits).toBe(1));
    const created = calls.filter((c) => c.method === 'POST' && c.url === '/v1/expense/claims');
    expect(created).toHaveLength(1);
    expect(created[0]!.body).toMatchObject({ purpose: 'Synthetic rejected visit', predecessorRequestId: 'cl-9', lines: [{ receipt: { receiptId: 'rc-new' } }] });
    // A retry revises that draft; the link was named once.
    fireEvent.click(await screen.findByText('Submit claim'));
    await waitFor(() => expect(submits).toBe(2));
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/v1/expense/claims')).toHaveLength(1);
    expect(calls.find((c) => c.method === 'PUT')!.body).not.toHaveProperty('predecessorRequestId');
  });
});

describe('resubmitting returned leave (web-3)', () => {
  it('offers an optional new private reason and sends no reason when none is typed', async () => {
    session.permissions = ['leave.read.operational', 'leave.submit.operational'];
    const calls = mockApi(LEAVE_ROUTES);
    renderPage(<LeavePage />);
    fireEvent.click(await screen.findByText('Correct and resubmit'));
    const form = screen.getByText('Resubmit').closest('form')!;
    expect(within(form).getByLabelText('New reason (private)')).toBeTruthy();
    expect(within(form).getByText(/earlier reason is kept/)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('To'), { target: { value: '2026-11-02' } });
    fireEvent.click(within(form).getByText('Resubmit'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toStrictEqual({ startDate: '2026-11-02', endDate: '2026-11-02', halfDay: false, expectedVersion: 3 });
  });

  it('sends a typed new reason, trimmed', async () => {
    session.permissions = ['leave.read.operational', 'leave.submit.operational'];
    const calls = mockApi(LEAVE_ROUTES);
    renderPage(<LeavePage />);
    fireEvent.click(await screen.findByText('Correct and resubmit'));
    const form = screen.getByText('Resubmit').closest('form')!;
    fireEvent.change(within(form).getByLabelText('New reason (private)'), { target: { value: '  Synthetic family event  ' } });
    fireEvent.click(within(form).getByText('Resubmit'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toStrictEqual({
      startDate: '2026-11-02',
      endDate: '2026-11-03',
      halfDay: false,
      reason: 'Synthetic family event',
      expectedVersion: 3,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------
// web-9: own-record sections only where the scope can include the own record
// ---------------------------------------------------------------------------------------------------------

describe('supporting documents on leave (FR-026, FR-106)', () => {
  const DOC = { id: 'doc-1', documentType: 'GENERAL', fileName: 'medical-note.pdf', uploadedAt: '2026-10-01T00:00:00Z', scanState: 'CLEAN', verificationState: 'UNVERIFIED' };
  const OWN = ['leave.read.operational', 'leave.submit.operational', 'document.read.document'];

  it('balances and days read without padding zeros, and nothing is rounded', async () => {
    session.permissions = OWN;
    mockApi({
      'GET /v1/employees/emp-1/leave-balances': { items: [{ leaveType: 'SICK', paid: true, available: '5.0000', pending: '1.5000', taken: '1.6667' }] },
      'GET /v1/employees/emp-1/leave-requests': { items: [{ id: 'lr-1', leaveType: 'SICK', startDate: '2026-11-02', endDate: '2026-11-03', halfDay: false, units: '2.0000', state: 'SUBMITTED' }] },
      'GET /v1/employees/emp-1/documents': { items: [] },
    });
    renderPage(<LeavePage />);
    for (const text of ['5', '1.5', '1.6667', '2']) expect(await screen.findByRole('cell', { name: text })).toBeTruthy();
    expect(screen.queryByText(/\.0000/)).toBeNull();
  });

  it('attaches chosen documents to a new request and sends none when none is chosen', async () => {
    session.permissions = OWN;
    const calls = mockApi({
      'GET /v1/employees/emp-1/leave-balances': { items: [{ leaveType: 'SICK', paid: true, available: '5.0000', pending: '0.0000', taken: '0.0000' }] },
      'GET /v1/employees/emp-1/leave-requests': { items: [] },
      'GET /v1/employees/emp-1/documents': { items: [DOC] },
      'POST /v1/leave/requests': () => [201, { requestId: 'lr-1', units: '1', state: 'SUBMITTED' }] as Reply,
    });
    renderPage(<LeavePage />);
    const box = await screen.findByLabelText(/medical-note\.pdf/);
    fireEvent.click(box);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-09' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-09' } });
    fireEvent.click(screen.getByText('Submit request'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ evidenceDocumentIds: ['doc-1'] });
  });

  it('a refused document is explained in words, and an unticked resubmission keeps the earlier documents', async () => {
    session.permissions = OWN;
    const calls = mockApi({
      'GET /v1/employees/emp-1/leave-balances': { items: [] },
      'GET /v1/employees/emp-1/leave-requests': {
        items: [
          {
            id: 'lr-1',
            leaveType: 'SICK',
            startDate: '2026-11-02',
            endDate: '2026-11-02',
            halfDay: false,
            units: '1.0000',
            state: 'RETURNED',
            version: 3,
            cancellationState: null,
            evidence: [{ documentId: 'doc-1', documentType: 'GENERAL', scanState: 'CLEAN', verificationState: 'UNVERIFIED' }],
          },
        ],
      },
      'GET /v1/employees/emp-1/documents': { items: [DOC] },
      'PUT /v1/leave/requests/lr-1': () => [422, { error: 'EVIDENCE_UNUSABLE', message: 'unusable' }] as Reply,
    });
    renderPage(<LeavePage />);
    fireEvent.click(await screen.findByText('Correct and resubmit'));
    const form = screen.getByText('Resubmit').closest('form')!;
    expect(within(form).getByText(/documents attached before are kept/)).toBeTruthy();
    fireEvent.click(within(form).getByText('Resubmit'));
    expect((await screen.findByRole('alert')).textContent).toContain('A document attached before has since failed the malware scan');
    expect(calls.find((c) => c.method === 'PUT')!.body).not.toHaveProperty('evidenceDocumentIds');
  });

  it('FR-096: the inbox says which tasks the user decides as a delegate and in which role, and marks only those rows', async () => {
    session.permissions = ['leave.approve.operational'];
    const row = (taskId: string, ownerName: string) => ({ taskId, kind: 'leave_request', transactionId: `tx-${taskId}`, ownerName, ownerEmployeeCode: `C-${taskId}`, assignedAt: '2026-10-24T06:00:00Z', stepSequence: 1 });
    mockApi({
      'GET /v1/leave/tasks': { items: [row('t-own', 'Own Synthetic'), row('t-del', 'Delegated Synthetic')] },
      'GET /v1/me/delegated-tasks': {
        items: [
          {
            taskId: 't-del',
            kind: 'leave_request',
            ownerName: 'Delegated Synthetic',
            ownerEmployeeCode: 'C-t-del',
            delegationId: 'd-1',
            delegatedUntil: '2026-11-20T04:30:00.000Z',
            delegator: { userId: 'u-1', accountKey: 'syn.mira', employeeCode: 'SYN-1', displayName: 'Mira Synthetic' },
          },
        ],
      },
    });
    renderPage(<TasksPage />);
    expect(await screen.findByRole('heading', { name: 'Delegated to you (1)' })).toBeTruthy();
    expect(screen.getByText(/acting as Employee/)).toBeTruthy();
    const queue = screen.getByRole('heading', { name: 'Leave requests (2)' }).closest('section')!;
    const items = within(queue).getAllByRole('listitem');
    expect(within(items[0]!).queryByText('delegated')).toBeNull();
    expect(within(items[1]!).getByText('delegated')).toBeTruthy();
    expect(items[1]!.textContent).toContain('from Mira Synthetic');
    expect(items[1]!.textContent).toContain('you decide as Employee');
  });

  it('a leave task lists its documents for the reviewer and opens a released one through the request’s route', async () => {
    session.permissions = ['leave.approve.operational'];
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn(() => 'blob:synthetic');
    URL.revokeObjectURL = vi.fn();
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      const calls = mockApi({
        'GET /v1/leave/tasks': {
          items: [
            {
              taskId: 't-1',
              kind: 'leave_request',
              transactionId: 'tx-1',
              assignedAt: '2026-10-24T06:00:00Z',
              stepSequence: 1,
              summary: { requestId: 'lr-9', leaveType: 'SICK', startDate: '2026-11-02', endDate: '2026-11-02', halfDay: false, units: '1.0000', isCancellation: false, evidence: [{ documentId: 'doc-1', documentType: 'GENERAL', scanState: 'CLEAN', verificationState: 'VERIFIED' }] },
            },
          ],
        },
        'GET /v1/leave/requests/lr-9/evidence/doc-1/content': 'file',
      });
      renderPage(<TasksPage />);
      fireEvent.click(await screen.findByRole('button', { name: /Open/ }));
      await waitFor(() => expect(calls.some((c) => c.url === '/v1/leave/requests/lr-9/evidence/doc-1/content')).toBe(true));
    } finally {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
      spy.mockRestore();
    }
  });
});

describe('own leave records and the role scope (web-9)', () => {
  it('a team-scope role makes no own-record calls and says where own leave is', async () => {
    session.permissions = ['leave.read.operational', 'leave.approve.operational'];
    session.scopeKind = 'TEAM';
    const calls = mockApi(LEAVE_ROUTES);
    renderPage(<LeavePage />);
    expect(await screen.findByText(/not in this role’s scope/)).toBeTruthy();
    expect(calls.some((c) => c.url.startsWith('/v1/employees/emp-1/'))).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a company-scope role whose filters leave out the own record says so instead of showing errors', async () => {
    session.permissions = ['leave.read.operational', 'leave.submit.operational'];
    session.scopeKind = 'COMPANY';
    const calls = mockApi({}); // every own-record call answers 404 NOT_FOUND
    renderPage(<LeavePage />);
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/employees/emp-1/leave-balances')).toBe(true));
    expect(await screen.findByText(/not in this role’s scope/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------
// web-5 and web-12: decision queues
// ---------------------------------------------------------------------------------------------------------

const base = { ownerEmployeeCode: 'SYN-1', ownerName: 'Synthetic Person', stepAction: 'approve', step: 1, ownerEmployeeId: 'emp-1' };
const LEAVE_TASKS = {
  items: [
    { ...base, taskId: 't-l1', kind: 'leave_request', transactionId: 'tx-l1', assignedAt: '2026-10-24T20:00:00Z', summary: { leaveType: 'ANNUAL', startDate: '2026-11-02', endDate: '2026-11-03', halfDay: false, units: '2.0000', isCancellation: false } },
    { ...base, taskId: 't-l2', kind: 'leave_cancellation', transactionId: 'tx-l2', assignedAt: '2026-10-24T06:00:00Z', summary: { leaveType: 'SICK', startDate: '2026-10-10', endDate: '2026-10-10', halfDay: true, units: '0.5000', isCancellation: true } },
  ],
};
const WORK_TASKS = {
  items: [
    {
      ...base,
      taskId: 't-w1',
      kind: 'outdoor_duty',
      transactionId: 'tx-w1',
      assignedAt: '2026-10-24T06:00:00Z',
      summary: { kind: 'outdoor_duty', startDate: '2026-11-04', endDate: '2026-11-04', startTime: '22:00', endTime: '06:00', purpose: 'Synthetic night audit' },
    },
    {
      ...base,
      taskId: 't-w2',
      kind: 'holiday_work',
      transactionId: 'tx-w2',
      assignedAt: '2026-10-24T06:00:00Z',
      summary: { kind: 'holiday_work', startDate: '2026-11-08', endDate: '2026-11-08', startTime: null, endTime: null, purpose: 'Synthetic stock count' },
    },
  ],
};
const PROFILE_TASKS = {
  items: [
    {
      ...base,
      taskId: 't-p1',
      kind: 'profile_change',
      transactionId: 'tx-p1',
      assignedAt: '2026-10-24T06:00:00Z',
      request: {
        id: 'pc-1',
        employeeId: 'emp-1',
        employeeCode: 'SYN-1',
        employeeName: 'Synthetic Person',
        requested: { displayName: 'Synthetic Person-Renamed' },
        currentValues: { displayName: 'Synthetic Person', workEmail: 'syn.person@example.test' },
        recordNow: { displayName: 'Synthetic Person', workEmail: 'syn.person@example.test' },
        state: 'SUBMITTED',
      },
    },
  ],
};
const correction = (reason?: string) => ({
  items: [
    {
      ...base,
      taskId: 't-c1',
      kind: 'attendance_correction',
      transactionId: 'tx-c1',
      assignedAt: '2026-10-24T06:00:00Z',
      request: { id: 'ac-1', employeeCode: 'SYN-1', employeeName: 'Synthetic Person', workDate: '2026-10-20', currentStatus: 'ABSENT', requestedStatus: 'PRESENT', state: 'SUBMITTED', ...(reason ? { reason } : {}) },
    },
  ],
});

const queue = (title: RegExp) => screen.getByRole('heading', { name: title }).closest('section')!;

describe('decision queues say what is decided (web-5)', () => {
  it('leave and work-request items show their type, dates, units, times and purpose', async () => {
    session.permissions = ['leave.approve.operational'];
    mockApi({ 'GET /v1/leave/tasks': LEAVE_TASKS, 'GET /v1/work-requests/tasks/mine': WORK_TASKS });
    renderPage(<TasksPage />);
    await screen.findByRole('heading', { name: /Leave requests \(2\)/ });
    const leave = queue(/Leave requests/);
    expect(within(leave).getByText('ANNUAL · 2026-11-02 – 2026-11-03 · 2.00 days')).toBeTruthy();
    expect(within(leave).getByText('SICK · 2026-10-10 (half day) · 0.50 days')).toBeTruthy();
    expect(within(leave).getByText('cancel approved leave')).toBeTruthy();
    await screen.findByRole('heading', { name: /Outdoor duty and holiday work \(2\)/ });
    const work = queue(/Outdoor duty and holiday work/);
    expect(within(work).getByText('Outdoor duty · 2026-11-04 22:00–06:00 (ends the next day)')).toBeTruthy();
    expect(within(work).getByText('Synthetic night audit')).toBeTruthy();
    expect(within(work).getByText('Work on holiday · 2026-11-08')).toBeTruthy();
    expect(within(work).getByText('Synthetic stock count')).toBeTruthy();
  });

  it('profile changes compare requested with current values and are approved or rejected, never returned', async () => {
    session.permissions = ['employee.update.operational'];
    const calls = mockApi({ 'GET /v1/profile-changes/tasks/mine': PROFILE_TASKS, 'POST /v1/profile-changes/tasks/t-p1/decision': { requestId: 'pc-1', state: 'APPROVED', replayed: false } });
    renderPage(<TasksPage />);
    await screen.findByRole('heading', { name: /Profile changes \(1\)/ });
    const section = queue(/Profile changes/);
    const row = within(section).getByText('Display name').closest('tr')!;
    expect(within(row).getByText('Synthetic Person')).toBeTruthy();
    expect(within(row).getByText('Synthetic Person-Renamed')).toBeTruthy();
    // Only the requested field is compared.
    expect(within(section).queryByText('Work email')).toBeNull();
    expect(within(section).queryByText('Return')).toBeNull();
    expect((within(section).getByText('Reject') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(section).getByText('Approve'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/v1/profile-changes/tasks/t-p1/decision');
    expect(post.body).toMatchObject({ decision: 'APPROVE' });
    expect(Object.keys(post.body!).sort()).toEqual(['decision', 'idempotencyKey']);
  });

  it('a profile change flags a record that changed after the request was made', async () => {
    session.permissions = ['employee.update.operational'];
    const changed = structuredClone(PROFILE_TASKS);
    changed.items[0]!.request.recordNow.displayName = 'Synthetic Person-HR-Edit';
    mockApi({ 'GET /v1/profile-changes/tasks/mine': changed });
    renderPage(<TasksPage />);
    await screen.findByRole('heading', { name: /Profile changes \(1\)/ });
    const row = within(queue(/Profile changes/)).getByText('Display name').closest('tr')!;
    expect(within(row).getByText('Synthetic Person-HR-Edit')).toBeTruthy();
    expect(within(row).getByText('was Synthetic Person when requested')).toBeTruthy();
  });

  it('attendance corrections show the day and statuses, the private reason only when returned, and need a reason to reject', async () => {
    session.permissions = ['attendance.approve_correction.operational'];
    const calls = mockApi({
      'GET /v1/attendance-corrections/tasks/mine': correction('Badge reader fault'),
      'POST /v1/attendance-corrections/tasks/t-c1/decision': { requestId: 'ac-1', state: 'REJECTED', replayed: false },
    });
    renderPage(<TasksPage />);
    await screen.findByRole('heading', { name: /Attendance corrections \(1\)/ });
    const section = queue(/Attendance corrections/);
    expect(within(section).getByText('2026-10-20: absent → present')).toBeTruthy();
    expect(within(section).getByText('Badge reader fault')).toBeTruthy();
    expect(within(section).queryByText('Return')).toBeNull();
    fireEvent.change(within(section).getByLabelText('Decision reason'), { target: { value: 'Synthetic badge log shows no entry' } });
    fireEvent.click(within(section).getByText('Reject'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/v1/attendance-corrections/tasks/t-c1/decision');
    expect(post.body).toMatchObject({ decision: 'REJECT', reason: 'Synthetic badge log shows no entry' });
  });

  it('shows no reason line when the reviewer has no reason grant', async () => {
    session.permissions = ['attendance.approve_correction.operational'];
    mockApi({ 'GET /v1/attendance-corrections/tasks/mine': correction() });
    renderPage(<TasksPage />);
    await screen.findByRole('heading', { name: /Attendance corrections \(1\)/ });
    expect(within(queue(/Attendance corrections/)).queryByText(/Reason \(private\)/)).toBeNull();
  });

  it('each queue appears only with its own duty', async () => {
    session.permissions = ['leave.approve.operational'];
    const calls = mockApi({ 'GET /v1/leave/tasks': { items: [] }, 'GET /v1/work-requests/tasks/mine': { items: [] } });
    renderPage(<TasksPage />);
    await screen.findByRole('heading', { name: /Leave requests \(0\)/ });
    expect(screen.queryByRole('heading', { name: /Profile changes/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Attendance corrections/ })).toBeNull();
    expect(calls.some((c) => c.url.includes('profile-changes') || c.url.includes('attendance-corrections'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------
// FR-027 with FR-106 (I-22): supporting documents of a work-request task, for the reviewer it is assigned to
// ---------------------------------------------------------------------------------------------------------

describe('work-request evidence for the assigned reviewer (FR-027, FR-106)', () => {
  const EVIDENCE = [
    { documentId: 'doc-1', documentType: 'GENERAL', scanState: 'CLEAN', verificationState: 'VERIFIED' },
    { documentId: 'doc-2', documentType: 'TRAVEL_ORDER', scanState: 'PENDING_SCAN', verificationState: 'UNVERIFIED' },
  ];
  const WINDOW = { startDate: '2026-11-04', endDate: '2026-11-04', startTime: null, endTime: null, purpose: 'Synthetic site visit' };
  const TASK = {
    ...base,
    taskId: 't-w3',
    kind: 'outdoor_duty',
    transactionId: 'tx-w3',
    assignedAt: '2026-10-24T06:00:00Z',
    summary: { requestId: 'wr-7', kind: 'outdoor_duty', ...WINDOW, evidence: EVIDENCE },
  };
  const REVIEWER = ['leave.approve.operational', 'work_request.read.operational'];
  const work = () => queue(/Outdoor duty and holiday work/);
  let downloads: { click: ReturnType<typeof vi.fn>; restore: () => void };
  beforeEach(() => {
    // jsdom has no object URLs: a downloaded file is "saved" through a click on a link to one, counted here.
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn(() => 'blob:synthetic-evidence');
    URL.revokeObjectURL = vi.fn();
    const click = vi.fn();
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => click());
    downloads = {
      click,
      restore: () => {
        URL.createObjectURL = original.create;
        URL.revokeObjectURL = original.revoke;
        spy.mockRestore();
      },
    };
  });
  afterEach(() => downloads.restore());

  it('lists each document’s type, scan and verification state, and opens a released one through the request’s evidence route', async () => {
    session.permissions = REVIEWER;
    const calls = mockApi({
      'GET /v1/leave/tasks': { items: [] },
      'GET /v1/work-requests/tasks/mine': { items: [TASK] },
      'GET /v1/work-requests/outdoor_duty/wr-7/evidence/doc-1/content': { synthetic: 'pdf' },
    });
    renderPage(<TasksPage />);
    await screen.findByRole('heading', { name: /Outdoor duty and holiday work \(1\)/ });
    const list = within(work()).getByRole('list', { name: 'Supporting documents' });
    const [released, pending] = within(list).getAllByRole('listitem');
    expect(within(released!).getByText('GENERAL')).toBeTruthy();
    expect(within(released!).getByText('released by the malware scan')).toBeTruthy();
    expect(within(released!).getByText('verified')).toBeTruthy();
    expect(within(pending!).getByText('TRAVEL_ORDER')).toBeTruthy();
    expect(within(pending!).getByText('waiting for the malware scan')).toBeTruthy();
    expect(within(pending!).getByText('not verified')).toBeTruthy();
    const open = within(released!).getByRole('button', { name: 'Open' }) as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(false));
    expect((within(pending!).getByRole('button', { name: 'Open' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(open);
    await waitFor(() => expect(downloads.click).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.url.includes('/evidence/')).map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/work-requests/outdoor_duty/wr-7/evidence/doc-1/content']);
    // The task names its request: nothing else about the requester is read.
    expect(calls.some((c) => c.url.startsWith('/v1/employees/'))).toBe(false);
  });

  it('says in plain words when the malware scan quarantined the file', async () => {
    session.permissions = REVIEWER;
    mockApi({
      'GET /v1/leave/tasks': { items: [] },
      'GET /v1/work-requests/tasks/mine': { items: [TASK] },
      'GET /v1/work-requests/outdoor_duty/wr-7/evidence/doc-1/content': () => [
        409,
        { error: 'FILE_NOT_RELEASED', message: 'This file has not been released by the malware scan', details: { scanState: 'QUARANTINED' } },
      ],
    });
    renderPage(<TasksPage />);
    await screen.findByRole('heading', { name: /Outdoor duty and holiday work \(1\)/ });
    const open = within(work()).getAllByRole('button', { name: 'Open' })[0] as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);
    const alert = await within(work()).findByRole('alert');
    expect(alert.textContent).toContain('This file failed the malware scan, so it cannot be opened.');
    expect(alert.textContent).toContain('FILE_NOT_RELEASED');
    expect(downloads.click).not.toHaveBeenCalled();
  });

  it('without the work-request read duty lists the documents but offers nothing to open and reads no requests', async () => {
    session.permissions = ['leave.approve.operational'];
    const calls = mockApi({
      'GET /v1/leave/tasks': { items: [] },
      'GET /v1/work-requests/tasks/mine': { items: [TASK, { ...TASK, taskId: 't-w4', transactionId: 'tx-w4', summary: { ...TASK.summary, purpose: 'Synthetic stock count', evidence: [] } }] },
    });
    renderPage(<TasksPage />);
    await screen.findByRole('heading', { name: /Outdoor duty and holiday work \(2\)/ });
    expect(within(work()).getByText('TRAVEL_ORDER')).toBeTruthy();
    expect(within(work()).queryByRole('button', { name: 'Open' })).toBeNull();
    // A task without documents says so.
    expect(within(within(work()).getByText('Synthetic stock count').closest('li')!).getByText('none')).toBeTruthy();
    expect(calls.some((c) => c.url.startsWith('/v1/employees/'))).toBe(false);
  });

  it('offers nothing to open when the task does not name its request', async () => {
    session.permissions = REVIEWER;
    const { requestId: _omitted, ...unnamed } = TASK.summary;
    const calls = mockApi({
      'GET /v1/leave/tasks': { items: [] },
      'GET /v1/work-requests/tasks/mine': { items: [{ ...TASK, summary: unnamed }] },
    });
    renderPage(<TasksPage />);
    await screen.findByRole('heading', { name: /Outdoor duty and holiday work \(1\)/ });
    expect(await within(work()).findByText(/could not be identified/)).toBeTruthy();
    expect(within(work()).getAllByRole('button', { name: 'Open' }).every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(calls.some((c) => c.url.includes('/evidence/'))).toBe(false);
  });

  it('reads no requests when no document has been released yet', async () => {
    session.permissions = REVIEWER;
    const calls = mockApi({
      'GET /v1/leave/tasks': { items: [] },
      'GET /v1/work-requests/tasks/mine': { items: [{ ...TASK, summary: { ...TASK.summary, evidence: [EVIDENCE[1]] } }] },
    });
    renderPage(<TasksPage />);
    await screen.findByRole('heading', { name: /Outdoor duty and holiday work \(1\)/ });
    expect(within(work()).getByText('waiting for the malware scan')).toBeTruthy();
    expect((within(work()).getByRole('button', { name: 'Open' }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some((c) => c.url.startsWith('/v1/employees/'))).toBe(false);
  });
});

describe('instants are shown as the local calendar day (web-12)', () => {
  const tz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Asia/Tokyo'; // UTC+9: 20:00Z on the 24th is already the 25th locally
  });
  afterAll(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it('task assignment times use the local day, while leave dates stay as given', async () => {
    session.permissions = ['leave.approve.operational'];
    mockApi({ 'GET /v1/leave/tasks': LEAVE_TASKS, 'GET /v1/work-requests/tasks/mine': { items: [] } });
    renderPage(<TasksPage />);
    await screen.findByRole('heading', { name: /Leave requests \(2\)/ });
    const leave = queue(/Leave requests/);
    expect(within(leave).getByText('SYN-1 · assigned 2026-10-25')).toBeTruthy();
    expect(within(leave).getByText('ANNUAL · 2026-11-02 – 2026-11-03 · 2.00 days')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------------
// Review follow-ups: decision reasons, payment actions, clean forms after success, local "today".
// ---------------------------------------------------------------------------------------------------------

/** An answer that arrives only when the test lets it go. */
function deferred(reply: Reply) {
  let release: () => void = () => undefined;
  const promise = new Promise<Reply>((resolve) => (release = () => resolve(reply)));
  return { promise, release: () => release() };
}

describe('decisions that always need a reason (confirmation, increment)', () => {
  // The confirmation and increment decision routes require a reason for every decision, approval included.
  for (const q of [
    { permission: 'confirmation.decide.operational', path: '/v1/confirmations/tasks', kind: 'employee_confirmation', title: /Confirmation reviews \(1\)/ },
    { permission: 'increment.approve.salary', path: '/v1/increment-cases/tasks', kind: 'increment_case', title: /Increment cases \(1\)/ },
  ]) {
    it(`${q.kind}: Approve stays disabled until a reason is typed, and the reason is sent trimmed`, async () => {
      session.permissions = [q.permission];
      const calls = mockApi({
        [`GET ${q.path}/mine`]: { items: [{ ...base, taskId: 't-q1', kind: q.kind, transactionId: 'tx-q1', assignedAt: '2026-10-24T06:00:00Z' }] },
        [`POST ${q.path}/t-q1/decision`]: { state: 'APPROVED', replayed: false },
      });
      renderPage(<TasksPage />);
      await screen.findByRole('heading', { name: q.title });
      const section = queue(q.title);
      const approve = within(section).getByText('Approve') as HTMLButtonElement;
      expect(approve.disabled).toBe(true);
      fireEvent.change(within(section).getByLabelText('Decision reason'), { target: { value: '   ' } });
      expect(approve.disabled).toBe(true);
      fireEvent.change(within(section).getByLabelText('Decision reason'), { target: { value: '  Synthetic review complete  ' } });
      expect(approve.disabled).toBe(false);
      fireEvent.click(approve);
      await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
      expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ decision: 'APPROVE', reason: 'Synthetic review complete' });
    });
  }
});

describe('own claims: correcting and withdrawing (FR-074, BR-017, DF03)', () => {
  const OWN = { id: 'cl-5', purpose: 'Synthetic visit', state: 'RETURNED', paymentState: 'NOT_APPLICABLE', claimedTotal: '300.00', currency: 'INR', version: 4 };
  const OWN_LINE = {
    category: 'ACCOMMODATION',
    expenseDate: '2026-10-01',
    nights: 2,
    merchant: 'Synthetic Inn',
    invoiceReference: 'INN-1',
    claimedAmount: '300.0000',
    grossAmount: '350.0000',
    description: 'Two nights',
    receiptId: 'rc-kept',
    receiptScanState: 'CLEAN',
  };
  const DUTIES = ['expense.draft.operational', 'expense.submit.operational', 'expense.withdraw.operational', 'expense.read.operational'];
  const row = (purpose: string) => screen.getByText(purpose).closest('tr')!;

  it('offers withdrawal at every state before the final decision, and correction only of the claimant\'s own open work', async () => {
    session.permissions = DUTIES;
    const states = ['DRAFT', 'RETURNED', 'MANAGER_PENDING', 'FINANCE_PENDING', 'HIGH_VALUE_PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'];
    mockApi({ 'GET /v1/employees/emp-1/expense-claims': { items: states.map((state) => ({ ...OWN, id: `cl-${state}`, state, purpose: `Claim ${state}` })) } });
    renderPage(<ExpensesPage />);
    await screen.findByText('Claim DRAFT');
    for (const state of ['DRAFT', 'RETURNED', 'MANAGER_PENDING', 'FINANCE_PENDING', 'HIGH_VALUE_PENDING']) expect(within(row(`Claim ${state}`)).queryByText('Withdraw'), state).toBeTruthy();
    for (const state of ['APPROVED', 'REJECTED', 'WITHDRAWN']) expect(within(row(`Claim ${state}`)).queryByText('Withdraw'), state).toBeNull();
    expect(within(row('Claim RETURNED')).getByText('Correct')).toBeTruthy();
    expect(within(row('Claim DRAFT')).getByText('Edit')).toBeTruthy();
    for (const state of ['MANAGER_PENDING', 'APPROVED']) {
      expect(within(row(`Claim ${state}`)).queryByText('Correct'), state).toBeNull();
      expect(within(row(`Claim ${state}`)).queryByText('Edit'), state).toBeNull();
    }
  });

  it('without the duty there is no withdrawal to offer', async () => {
    session.permissions = ['expense.draft.operational', 'expense.read.operational'];
    mockApi({ 'GET /v1/employees/emp-1/expense-claims': { items: [{ ...OWN, state: 'MANAGER_PENDING' }] } });
    renderPage(<ExpensesPage />);
    await screen.findByText('Synthetic visit');
    expect(screen.queryByText('Withdraw')).toBeNull();
  });

  it('a withdrawal is sent, the list reloads, and a refusal is said', async () => {
    session.permissions = DUTIES;
    let state = 'FINANCE_PENDING';
    const calls = mockApi({
      'GET /v1/employees/emp-1/expense-claims': () => [200, { items: [{ ...OWN, state }] }],
      'POST /v1/expense/claims/cl-5/withdraw': () => {
        if (state === 'APPROVED') return [409, { error: 'INVALID_STATE', message: 'A decided claim can no longer be withdrawn' }];
        state = 'WITHDRAWN';
        return [200, { claimId: 'cl-5', state }];
      },
    });
    renderPage(<ExpensesPage />);
    fireEvent.click(await screen.findByText('Withdraw'));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/expense-claims')).length).toBeGreaterThan(1));
    expect(calls.find((c) => c.url.endsWith('/withdraw'))!.method).toBe('POST');
    await waitFor(() => expect(screen.queryByText('Withdraw')).toBeNull());
    cleanup();

    state = 'FINANCE_PENDING';
    mockApi({
      'GET /v1/employees/emp-1/expense-claims': () => [200, { items: [{ ...OWN, state }] }],
      'POST /v1/expense/claims/cl-5/withdraw': () => {
        state = 'APPROVED';
        return [409, { error: 'INVALID_STATE', message: 'A decided claim can no longer be withdrawn' }];
      },
    });
    renderPage(<ExpensesPage />);
    fireEvent.click(await screen.findByText('Withdraw'));
    expect((await screen.findByRole('alert')).textContent).toContain('A decided claim can no longer be withdrawn');
    await waitFor(() => expect(screen.queryByText('Withdraw')).toBeNull());
  });

  it('correcting a returned claim fills the form, keeps its receipt and gross, and sends a new revision before submitting', async () => {
    session.permissions = DUTIES;
    let version = 4;
    const calls = mockApi({
      'GET /v1/employees/emp-1/expense-claims': { items: [OWN] },
      'GET /v1/expense/categories': { items: [{ code: 'ACCOMMODATION', name: 'Accommodation', limitBasis: 'PER_NIGHT' }, { code: 'OTHER', name: 'Other', limitBasis: 'PER_LINE' }] },
      'GET /v1/expense/claims/cl-5': () => [200, { id: 'cl-5', state: 'RETURNED', version, purpose: 'Synthetic visit', currency: 'INR', lines: [OWN_LINE] }],
      'PUT /v1/expense/claims/cl-5': () => {
        version += 1;
        return [200, { claimId: 'cl-5', revision: 2, state: 'RETURNED' }];
      },
      'POST /v1/expense/claims/cl-5/submit': [200, { claimId: 'cl-5', state: 'MANAGER_PENDING' }],
    });
    renderPage(<ExpensesPage />);
    fireEvent.click(await screen.findByText('Correct'));
    await screen.findByText('Correct returned claim');
    expect((screen.getByLabelText('Business purpose') as HTMLInputElement).value).toBe('Synthetic visit');
    expect((screen.getByLabelText('Merchant') as HTMLInputElement).value).toBe('Synthetic Inn');
    expect((screen.getByLabelText('Nights') as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText('Invoice reference (if the bill has one)') as HTMLInputElement).value).toBe('INN-1');
    expect((screen.getByLabelText('Amount (INR)') as HTMLInputElement).value).toBe('300.00');
    fireEvent.change(screen.getByLabelText('Business purpose'), { target: { value: 'Synthetic visit, corrected' } });
    fireEvent.click(screen.getByText('Submit claim'));
    expect(await screen.findByText('Claim submitted for review.')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/v1/expense/claims')).toHaveLength(0);
    expect(calls.filter((c) => c.url === '/v1/expense/receipts')).toHaveLength(0);
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      expectedVersion: 4,
      purpose: 'Synthetic visit, corrected',
      currency: 'INR',
      lines: [{ category: 'ACCOMMODATION', expenseDate: '2026-10-01', nights: 2, merchant: 'Synthetic Inn', invoiceReference: 'INN-1', grossAmount: '350.00', claimedAmount: '300.00', description: 'Two nights', receipt: { receiptId: 'rc-kept' } }],
    });
    expect(calls.find((c) => c.url.endsWith('/submit'))!.body).toEqual({ expectedVersion: 5 });
    // The form is new again.
    expect(screen.getByText('New expense claim')).toBeTruthy();
  });

  it('a receipt that failed the scan is not kept, and the form says so', async () => {
    session.permissions = DUTIES;
    const calls = mockApi({
      'GET /v1/employees/emp-1/expense-claims': { items: [OWN] },
      'GET /v1/expense/claims/cl-5': () => [200, { id: 'cl-5', state: 'RETURNED', version: 4, purpose: 'Synthetic visit', currency: 'INR', lines: [{ ...OWN_LINE, receiptScanState: 'QUARANTINED' }] }],
      'PUT /v1/expense/claims/cl-5': [200, { claimId: 'cl-5', revision: 2, state: 'RETURNED' }],
      'POST /v1/expense/claims/cl-5/submit': [422, { error: 'EXCEPTION_REASON_REQUIRED', message: 'Flagged lines need an exception reason', details: { lines: [{ line: 1, flags: ['RECEIPT_MISSING'] }] } }],
    });
    renderPage(<ExpensesPage />);
    fireEvent.click(await screen.findByText('Correct'));
    expect(await screen.findByText('A receipt on this claim failed the malware scan and was removed; attach another.')).toBeTruthy();
    fireEvent.click(screen.getByText('Submit claim'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect((calls.find((c) => c.method === 'PUT')!.body!.lines as Record<string, unknown>[])[0]).not.toHaveProperty('receipt');
  });

  it('leaving a correction goes back to a new claim and changes nothing', async () => {
    session.permissions = DUTIES;
    const calls = mockApi({
      'GET /v1/employees/emp-1/expense-claims': { items: [OWN] },
      'GET /v1/expense/claims/cl-5': () => [200, { id: 'cl-5', state: 'RETURNED', version: 4, purpose: 'Synthetic visit', currency: 'INR', lines: [OWN_LINE] }],
    });
    renderPage(<ExpensesPage />);
    fireEvent.click(await screen.findByText('Correct'));
    fireEvent.click(await screen.findByText('Leave this claim as it is'));
    expect(screen.getByText('New expense claim')).toBeTruthy();
    expect((screen.getByLabelText('Business purpose') as HTMLInputElement).value).toBe('');
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('a new claim sends its invoice reference and offers the company\'s categories, with nights for a per-night one', async () => {
    session.permissions = DUTIES;
    const calls = mockApi({
      'GET /v1/employees/emp-1/expense-claims': { items: [] },
      'GET /v1/expense/categories': { items: [{ code: 'CAMP', name: 'Camp', limitBasis: 'PER_NIGHT' }, { code: 'OTHER', name: 'Other', limitBasis: 'PER_LINE' }] },
      'POST /v1/expense/receipts': () => [201, { receiptId: 'rc-1', mediaType: 'application/pdf', byteSize: 18 }],
      'POST /v1/expense/claims': () => [201, { claimId: 'cl-1', revision: 1, state: 'DRAFT' }],
      'GET /v1/expense/claims/cl-1': () => [200, { id: 'cl-1', state: 'DRAFT', version: 1, lines: [] }],
      'POST /v1/expense/claims/cl-1/submit': [200, { claimId: 'cl-1', state: 'MANAGER_PENDING' }],
    });
    renderPage(<ExpensesPage />);
    // Each category reads as the company named it; its code is what is sent.
    expect(((await screen.findByRole('option', { name: 'Camp' })) as HTMLOptionElement).value).toBe('CAMP');
    expect(screen.queryByRole('option', { name: 'CAMP' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Meals' })).toBeNull();
    expect(screen.queryByLabelText('Nights')).toBeNull();
    await fillClaim();
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'CAMP' } });
    fireEvent.change(screen.getByLabelText('Nights'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Invoice reference (if the bill has one)'), { target: { value: ' SYN-77 ' } });
    fireEvent.click(screen.getByText('Submit claim'));
    expect(await screen.findByText('Claim submitted for review.')).toBeTruthy();
    expect((calls.find((c) => c.method === 'POST' && c.url === '/v1/expense/claims')!.body!.lines as Record<string, unknown>[])[0]).toMatchObject({ category: 'CAMP', nights: 3, invoiceReference: 'SYN-77' });
  });
});

describe('expense decisions', () => {
  const EXPENSE_TASK = { ...base, taskId: 't-e1', kind: 'expense_claim', transactionId: 'tx-e1', assignedAt: '2026-10-24T06:00:00Z', stepAction: 'manager_decide', claimId: 'cl-9' };
  const CLAIM = {
    id: 'cl-9',
    purpose: 'Synthetic client visit',
    currency: 'INR',
    lines: [{ id: 'ln-1', sequence: 1, category: 'OTHER', expenseDate: '2026-10-01', merchant: 'Synthetic Cabs', claimedAmount: '450.0000', description: 'Airport transfer', exceptionFlags: [], receiptPresent: true }],
  };

  it('a receipt the scan has not released says so, opens nothing, and needs a reason at the financial step like a flagged line', async () => {
    session.permissions = ['expense.read.operational', 'expense.view_receipt.receipt'];
    const lines = [
      { ...CLAIM.lines[0]!, receiptScanState: 'CLEAN' },
      { ...CLAIM.lines[0]!, id: 'ln-2', sequence: 2, receiptScanState: 'QUARANTINED' },
      { ...CLAIM.lines[0]!, id: 'ln-3', sequence: 3, receiptScanState: 'PENDING_SCAN' },
    ];
    const calls = mockApi({
      'GET /v1/expense/tasks': { items: [{ ...EXPENSE_TASK, stepAction: 'finance_decide' }] },
      'GET /v1/expense/claims/cl-9': { ...CLAIM, lines },
      'POST /v1/expense/tasks/t-e1/decision': () => [200, { claimId: 'cl-9', state: 'APPROVED' }],
    });
    renderPage(<TasksPage />);
    await screen.findByText('Synthetic client visit');
    const section = queue(/Expense claims/);
    const cells = within(section).getAllByRole('row').slice(1);
    expect(within(cells[0]!).getByText('View')).toBeTruthy();
    expect(cells[1]!.textContent).toContain('quarantined by the malware scan');
    expect(within(cells[1]!).queryByText('View')).toBeNull();
    expect(cells[2]!.textContent).toContain('waiting for the malware scan');
    expect(within(cells[2]!).queryByText('View')).toBeNull();
    const approve = within(section).getByText('Approve amounts') as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(section.textContent).toContain('A receipt the malware scan has not released counts as none.');
    fireEvent.change(within(section).getByLabelText('Reason for line 2'), { target: { value: 'Synthetic: copy seen' } });
    expect(approve.disabled).toBe(true);
    fireEvent.change(within(section).getByLabelText('Reason for line 3'), { target: { value: 'Synthetic: copy seen too' } });
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  });

  it('shows the reviewer the invoice reference, the limit applied and what earlier revisions said', async () => {
    session.permissions = ['expense.read.operational'];
    mockApi({
      'GET /v1/expense/tasks': { items: [EXPENSE_TASK] },
      'GET /v1/expense/claims/cl-9': {
        ...CLAIM,
        purpose: 'Synthetic visit, corrected',
        lines: [{ ...CLAIM.lines[0]!, invoiceReference: 'SYN-77', appliedLimit: '1000.0000', receiptScanState: 'CLEAN' }],
        revisions: [
          { revision: 1, purpose: 'Synthetic visit, as first reviewed', claimedTotal: '500.00' },
          { revision: 2, purpose: 'Synthetic visit, corrected', claimedTotal: '450.00' },
        ],
      },
    });
    renderPage(<TasksPage />);
    await screen.findByText('Synthetic visit, corrected');
    const section = queue(/Expense claims/);
    expect(within(section).getByText('Invoice SYN-77')).toBeTruthy();
    expect(section.textContent).toContain('Limit');
    const earlier = within(section).getByRole('list', { name: 'Earlier revisions' });
    expect(earlier.textContent).toContain('Revision 1');
    expect(earlier.textContent).toContain('Synthetic visit, as first reviewed');
    expect(earlier.textContent).not.toContain('Revision 2');
  });

  it('Return and Reject need a non-blank reason, which is sent trimmed; the buttons wait for the answer', async () => {
    session.permissions = ['expense.read.operational'];
    const answer = deferred([200, { claimId: 'cl-9', state: 'RETURNED' }]);
    const calls = mockApi({
      'GET /v1/expense/tasks': { items: [EXPENSE_TASK] },
      'GET /v1/expense/claims/cl-9': CLAIM,
      'POST /v1/expense/tasks/t-e1/decision': () => answer.promise,
    });
    renderPage(<TasksPage />);
    await screen.findByText('Synthetic client visit');
    const section = queue(/Expense claims/);
    const ret = within(section).getByText('Return') as HTMLButtonElement;
    const reject = within(section).getByText('Reject') as HTMLButtonElement;
    expect(ret.disabled).toBe(true);
    expect(reject.disabled).toBe(true);
    fireEvent.change(within(section).getByLabelText('Decision reason'), { target: { value: '   ' } });
    expect(ret.disabled).toBe(true);
    fireEvent.change(within(section).getByLabelText('Decision reason'), { target: { value: '  Synthetic receipt unreadable  ' } });
    expect(ret.disabled).toBe(false);
    fireEvent.click(ret);
    // While the decision is on its way, no second decision can be sent.
    await waitFor(() => expect((within(section).getByText('Approve') as HTMLButtonElement).disabled).toBe(true));
    expect(ret.disabled).toBe(true);
    answer.release();
    await waitFor(() => expect(calls.filter((c) => c.url === '/v1/expense/tasks' && c.method === 'GET').length).toBeGreaterThan(1));
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ decision: 'RETURN', reason: 'Synthetic receipt unreadable' });
  });

  it('a flagged line shows the claimant reason and needs a clearance reason before the financial approval is sent, at full amount too', async () => {
    session.permissions = ['expense.read.operational'];
    const flaggedLine = { ...CLAIM.lines[0]!, id: 'ln-2', sequence: 2, exceptionFlags: ['DUPLICATE_SUSPECTED'], exceptionReason: 'Synthetic: two purchases on one bill' };
    const calls = mockApi({
      'GET /v1/expense/tasks': { items: [{ ...EXPENSE_TASK, stepAction: 'finance_decide' }] },
      'GET /v1/expense/claims/cl-9': { ...CLAIM, lines: [CLAIM.lines[0], flaggedLine] },
      'POST /v1/expense/tasks/t-e1/decision': () => [200, { claimId: 'cl-9', state: 'APPROVED' }],
    });
    renderPage(<TasksPage />);
    await screen.findByText('Synthetic client visit');
    const section = queue(/Expense claims/);
    expect(within(section).getByText('Claimant: Synthetic: two purchases on one bill')).toBeTruthy();
    const approve = within(section).getByText('Approve amounts') as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(within(section).getByLabelText('Reason for line 2'), { target: { value: '   ' } });
    expect(approve.disabled).toBe(true);
    // The unflagged line needs no reason; the flagged one is cleared by its own.
    fireEvent.change(within(section).getByLabelText('Reason for line 2'), { target: { value: ' Synthetic: bill checked ' } });
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      decision: 'APPROVE',
      lines: [
        { lineId: 'ln-1', allowedAmount: '450.00' },
        { lineId: 'ln-2', allowedAmount: '450.00', reason: 'Synthetic: bill checked' },
      ],
    });
  });

  it('the manager step approves a flagged claim without a line reason: clearing it is the financial reviewer’s', async () => {
    session.permissions = ['expense.read.operational'];
    const flaggedLine = { ...CLAIM.lines[0]!, exceptionFlags: ['LATE_SUBMISSION'] };
    mockApi({ 'GET /v1/expense/tasks': { items: [EXPENSE_TASK] }, 'GET /v1/expense/claims/cl-9': { ...CLAIM, lines: [flaggedLine] } });
    renderPage(<TasksPage />);
    await screen.findByText('Synthetic client visit');
    expect((within(queue(/Expense claims/)).getByText('Approve') as HTMLButtonElement).disabled).toBe(false);
  });
});

const PAYABLE = {
  claimId: 'cl-5',
  employeeCode: 'SYN-5',
  employeeName: 'Synthetic Five',
  purpose: 'Synthetic travel',
  paymentState: 'UNPAID',
  approvedAmount: '900.00',
  netPaid: '0.00',
  pending: '0.00',
  allocatable: '900.00',
  currency: 'INR',
};

describe('payments (DF07)', () => {
  it('preparing a payment: one request at a time, the same key when retried, then a clean form and a new key', async () => {
    session.permissions = ['payment.read.operational', 'payment.prepare.operational'];
    let posts = 0;
    const second = deferred([201, { instructionId: 'pi-1', state: 'PREPARED', replayed: true }]);
    const calls = mockApi({
      'GET /v1/expense/payables': { items: [PAYABLE] },
      'GET /v1/expense/claims/cl-5/payments': { items: [] },
      'POST /v1/expense/payments': () => {
        posts += 1;
        // The first answer is lost on the way (the server may or may not have prepared it).
        if (posts === 1) return [503, { error: 'UNAVAILABLE', message: 'Synthetic gateway timeout' }];
        if (posts === 2) return second.promise;
        return [201, { instructionId: 'pi-2', state: 'PREPARED', replayed: false }];
      },
    });
    renderPage(<PaymentsPage />);
    fireEvent.click(await screen.findByText('Manage'));
    fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '300' } });
    fireEvent.click(screen.getByText('Prepare payment'));
    expect((await screen.findByRole('alert')).textContent).toContain('UNAVAILABLE');
    fireEvent.click(screen.getByText('Prepare payment'));
    await waitFor(() => expect((screen.getByText('Prepare payment') as HTMLButtonElement).disabled).toBe(true));
    second.release();
    await waitFor(() => expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe(''));
    const keys = calls.filter((c) => c.method === 'POST').map((c) => c.body!.idempotencyKey);
    expect(keys).toHaveLength(2);
    // The retry is the same payment: the server answers it from the first attempt instead of preparing another.
    expect(keys[1]).toBe(keys[0]);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body!.amount)).toEqual(['300', '300']);

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '200' } });
    fireEvent.click(screen.getByText('Prepare payment'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(3));
    expect(calls.filter((c) => c.method === 'POST')[2]!.body).toMatchObject({ amount: '200' });
    expect(calls.filter((c) => c.method === 'POST')[2]!.body!.idempotencyKey).not.toBe(keys[0]);
  });

  it('BR-024 lists the payroll reimbursements to review and sends the preparer’s recorded review with the same payment', async () => {
    session.permissions = ['payment.read.operational', 'payment.prepare.operational'];
    let posts = 0;
    const calls = mockApi({
      'GET /v1/expense/payables': { items: [PAYABLE] },
      'GET /v1/expense/claims/cl-5/payments': { items: [] },
      'POST /v1/expense/payments': () => {
        posts += 1;
        if (posts === 1) {
          return [
            409,
            {
              error: 'PAYROLL_REIMBURSEMENT_REVIEW_REQUIRED',
              message: 'Review',
              details: { payrollInputs: [{ inputId: 'pi-x', periodCode: '2026-11', reference: 'REIMB-1', state: 'APPROVED', effectiveDate: '2026-11-05', matchesAmount: true }] },
            },
          ];
        }
        return [201, { instructionId: 'pi-1', state: 'PREPARED', replayed: false }];
      },
    });
    renderPage(<PaymentsPage />);
    fireEvent.click(await screen.findByText('Manage'));
    fireEvent.click(await screen.findByText('Prepare payment'));
    expect(await screen.findByText(/Period 2026-11, reference REIMB-1, approved, dated .*for the same amount as this payment/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Why these do not pay this claim'), { target: { value: 'Fuel allowance, not this claim (synthetic)' } });
    fireEvent.click(screen.getByText('Prepare payment'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
    const [first, second] = calls.filter((c) => c.method === 'POST');
    expect(first!.body).not.toHaveProperty('payrollReimbursementReview');
    expect(second!.body).toMatchObject({ payrollReimbursementReview: 'Fuel allowance, not this claim (synthetic)', idempotencyKey: first!.body!.idempotencyKey });
  });

  it('another claim gets its own payment form: nothing typed or keyed for one claim carries over', async () => {
    session.permissions = ['payment.read.operational', 'payment.prepare.operational'];
    const other = { ...PAYABLE, claimId: 'cl-6', employeeCode: 'SYN-6', employeeName: 'Synthetic Six', allocatable: '120.00' };
    const calls = mockApi({
      'GET /v1/expense/payables': { items: [PAYABLE, other] },
      'GET /v1/expense/claims/cl-5/payments': { items: [] },
      'GET /v1/expense/claims/cl-6/payments': { items: [] },
      'POST /v1/expense/payments': () => [503, { error: 'UNAVAILABLE', message: 'Synthetic gateway timeout' }],
    });
    renderPage(<PaymentsPage />);
    const [manageFive, manageSix] = await screen.findAllByText('Manage');
    fireEvent.click(manageFive!);
    fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '300' } });
    fireEvent.click(screen.getByText('Prepare payment'));
    expect((await screen.findByRole('alert')).textContent).toContain('UNAVAILABLE');

    fireEvent.click(manageSix!);
    expect(await screen.findByRole('heading', { name: 'Payments for Synthetic Six' })).toBeTruthy();
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByText('Prepare payment'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
    const [forFive, forSix] = calls.filter((c) => c.method === 'POST');
    expect(forSix!.body).toMatchObject({ claimId: 'cl-6', amount: '120.00' });
    expect(forSix!.body!.idempotencyKey).not.toBe(forFive!.body!.idempotencyKey);
  });

  it('a changed amount is a new payment with a new key', async () => {
    session.permissions = ['payment.read.operational', 'payment.prepare.operational'];
    const calls = mockApi({
      'GET /v1/expense/payables': { items: [PAYABLE] },
      'GET /v1/expense/claims/cl-5/payments': { items: [] },
      'POST /v1/expense/payments': () => [422, { error: 'EXCEEDS_OUTSTANDING', message: 'The amount exceeds the unreserved outstanding entitlement' }],
    });
    renderPage(<PaymentsPage />);
    fireEvent.click(await screen.findByText('Manage'));
    fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '950' } });
    fireEvent.click(screen.getByText('Prepare payment'));
    expect((await screen.findByRole('alert')).textContent).toContain('EXCEEDS_OUTSTANDING');
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '900' } });
    fireEvent.click(screen.getByText('Prepare payment'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
    const [first, retry] = calls.filter((c) => c.method === 'POST');
    expect(retry!.body!.idempotencyKey).not.toBe(first!.body!.idempotencyKey);
  });

  describe('C5 DRAFT then READY, C3 explicitly assigned outcome actor', () => {
    const row = (over: Record<string, unknown>) => ({ id: 'pi-1', amount: '900.00', currency: 'INR', state: 'PREPARED', batchState: 'DRAFT', outcomeAssignedToMe: false, outcomeActorAccountKey: null, paymentDate: '2026-10-20', reversed: '0.00', ...over });
    const ACTORS = { items: [{ userId: 'u-9', accountKey: 'syn.confirmer', employeeCode: 'SYN-9', employeeName: 'Synthetic Confirmer' }] };

    it('a draft is marked ready by the preparer and offers no release', async () => {
      session.permissions = ['payment.read.operational', 'payment.prepare.operational', 'payment.release.operational'];
      let batchState = 'DRAFT';
      const calls = mockApi({
        'GET /v1/expense/payables': { items: [PAYABLE] },
        'GET /v1/expense/claims/cl-5/payments': () => [200, { items: [row({ batchState })] }],
        'GET /v1/expense/payments/pi-1/outcome-actors': ACTORS,
        'POST /v1/expense/payments/pi-1/ready': () => {
          batchState = 'READY';
          return [200, { instructionId: 'pi-1', state: 'PREPARED', batchState: 'READY' }];
        },
      });
      renderPage(<PaymentsPage />);
      fireEvent.click(await screen.findByText('Manage'));
      fireEvent.click(await screen.findByText('Mark ready'));
      await waitFor(() => expect(calls.some((c) => c.url.endsWith('/ready') && c.method === 'POST')).toBe(true));
      expect(await screen.findByText('Release')).toBeTruthy();
      expect(screen.queryByText('Mark ready')).toBeNull();
    });

    it('someone without the prepare duty sees the draft without the step; nobody is offered release before READY', async () => {
      session.permissions = ['payment.read.operational', 'payment.release.operational'];
      mockApi({ 'GET /v1/expense/payables': { items: [PAYABLE] }, 'GET /v1/expense/claims/cl-5/payments': { items: [row({})] } });
      renderPage(<PaymentsPage />);
      fireEvent.click(await screen.findByText('Manage'));
      expect(await screen.findByText('Draft')).toBeTruthy();
      expect(screen.queryByText('Mark ready')).toBeNull();
      expect(screen.queryByText('Release')).toBeNull();
    });

    it('the release names the outcome actor and cannot be sent without one', async () => {
      session.permissions = ['payment.read.operational', 'payment.release.operational'];
      const calls = mockApi({
        'GET /v1/expense/payables': { items: [PAYABLE] },
        'GET /v1/expense/claims/cl-5/payments': { items: [row({ batchState: 'READY' })] },
        'GET /v1/expense/payments/pi-1/outcome-actors': ACTORS,
        'POST /v1/expense/payments/pi-1/release': { instructionId: 'pi-1', state: 'RELEASED', outcomeActorUserId: 'u-9' },
      });
      renderPage(<PaymentsPage />);
      fireEvent.click(await screen.findByText('Manage'));
      const release = (await screen.findByText('Release')) as HTMLButtonElement;
      expect(release.disabled).toBe(true);
      await screen.findByText('Synthetic Confirmer (SYN-9)');
      fireEvent.change(screen.getByLabelText('Outcome recorded by'), { target: { value: 'u-9' } });
      expect(release.disabled).toBe(false);
      fireEvent.click(release);
      await waitFor(() => expect(calls.find((c) => c.url.endsWith('/release'))?.body).toEqual({ outcomeActorUserId: 'u-9' }));
    });

    it('only the assigned person is offered the outcome; a release holder can reassign with a reason', async () => {
      session.permissions = ['payment.read.operational', 'payment.release.operational', 'payment.confirm_outcome.operational'];
      const calls = mockApi({
        'GET /v1/expense/payables': { items: [PAYABLE] },
        'GET /v1/expense/claims/cl-5/payments': { items: [row({ state: 'RELEASED', batchState: 'RELEASED', outcomeActorAccountKey: 'syn.other' })] },
        'GET /v1/expense/payments/pi-1/outcome-actors': ACTORS,
        'POST /v1/expense/payments/pi-1/outcome-actor': { instructionId: 'pi-1', state: 'RELEASED', outcomeActorUserId: 'u-9' },
      });
      renderPage(<PaymentsPage />);
      fireEvent.click(await screen.findByText('Manage'));
      expect(await screen.findByText('Outcome assigned to syn.other')).toBeTruthy();
      expect(screen.queryByText('Confirm paid')).toBeNull();
      expect(screen.queryByLabelText('Evidence reference')).toBeNull();
      const reassign = screen.getByText('Reassign outcome') as HTMLButtonElement;
      await screen.findByText('Synthetic Confirmer (SYN-9)');
      fireEvent.change(screen.getByLabelText('Outcome recorded by'), { target: { value: 'u-9' } });
      expect(reassign.disabled).toBe(true);
      fireEvent.change(screen.getByLabelText('Reason for reassigning'), { target: { value: 'Synthetic: first actor left' } });
      fireEvent.click(reassign);
      await waitFor(() => expect(calls.find((c) => c.url.endsWith('/outcome-actor'))?.body).toEqual({ outcomeActorUserId: 'u-9', reason: 'Synthetic: first actor left' }));
    });

    it('holding the duty without the assignment, or the assignment without the duty, offers no outcome', async () => {
      session.permissions = ['payment.read.operational'];
      mockApi({
        'GET /v1/expense/payables': { items: [PAYABLE] },
        'GET /v1/expense/claims/cl-5/payments': { items: [row({ state: 'RELEASED', batchState: 'RELEASED', outcomeAssignedToMe: true, outcomeActorAccountKey: 'syn.user' })] },
      });
      renderPage(<PaymentsPage />);
      fireEvent.click(await screen.findByText('Manage'));
      expect(await screen.findByText('Outcome assigned to syn.user')).toBeTruthy();
      expect(screen.queryByText('Confirm paid')).toBeNull();
    });
  });

  it('the bank reference of a recorded outcome is not reused for a reversal', async () => {
    session.permissions = ['payment.read.operational', 'payment.confirm_outcome.operational', 'payment.reverse.operational'];
    let state = 'RELEASED';
    const calls = mockApi({
      'GET /v1/expense/payables': { items: [PAYABLE] },
      'GET /v1/expense/claims/cl-5/payments': () => [200, { items: [{ id: 'pi-1', amount: '900.00', currency: 'INR', state, batchState: 'RELEASED', outcomeAssignedToMe: true, outcomeActorAccountKey: 'syn.user', paymentDate: '2026-10-20', reversed: '0.00' }] }],
      'POST /v1/expense/payments/pi-1/outcome': () => {
        state = 'CONFIRMED';
        return [200, { instructionId: 'pi-1', state: 'CONFIRMED', replayed: false }];
      },
      'POST /v1/expense/payments/pi-1/reversal': { instructionId: 'pi-1', replayed: false },
    });
    renderPage(<PaymentsPage />);
    fireEvent.click(await screen.findByText('Manage'));
    fireEvent.change(await screen.findByLabelText('Evidence reference'), { target: { value: 'SYN-BANK-CONF-001' } });
    fireEvent.click(screen.getByText('Confirm paid'));
    await screen.findByText('Record reversal');
    // The confirmation's reference was used up: a reversal needs its own bank reference.
    expect((screen.getByLabelText('Evidence reference') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Amount to reverse'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Reason for the reversal'), { target: { value: 'Synthetic bank return' } });
    expect((screen.getByText('Record reversal') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Evidence reference'), { target: { value: 'SYN-BANK-REV-001' } });
    fireEvent.click(screen.getByText('Record reversal'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/reversal'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/reversal'))!.body).toEqual({ amount: '100', evidenceKey: 'SYN-BANK-REV-001', reason: 'Synthetic bank return' });
    await waitFor(() => expect((screen.getByLabelText('Amount to reverse') as HTMLInputElement).value).toBe(''));
  });

  it('says so when a reversal reference was already recorded and nothing new was recorded', async () => {
    session.permissions = ['payment.read.operational', 'payment.reverse.operational'];
    mockApi({
      'GET /v1/expense/payables': { items: [PAYABLE] },
      'GET /v1/expense/claims/cl-5/payments': { items: [{ id: 'pi-1', amount: '900.00', currency: 'INR', state: 'CONFIRMED', paymentDate: '2026-10-20', reversed: '0.00' }] },
      'POST /v1/expense/payments/pi-1/reversal': { instructionId: 'pi-1', replayed: true },
    });
    renderPage(<PaymentsPage />);
    fireEvent.click(await screen.findByText('Manage'));
    fireEvent.change(await screen.findByLabelText('Evidence reference'), { target: { value: 'SYN-BANK-CONF-001' } });
    fireEvent.change(screen.getByLabelText('Amount to reverse'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Reason for the reversal'), { target: { value: 'Synthetic bank return' } });
    fireEvent.click(screen.getByText('Record reversal'));
    expect((await screen.findByRole('status')).textContent).toMatch(/already recorded.*nothing new was recorded/);
  });

  it('a reference already used for something else is refused: the error shows and what was typed stays to be corrected', async () => {
    session.permissions = ['payment.read.operational', 'payment.reverse.operational'];
    mockApi({
      'GET /v1/expense/payables': { items: [PAYABLE] },
      'GET /v1/expense/claims/cl-5/payments': { items: [{ id: 'pi-1', amount: '900.00', currency: 'INR', state: 'CONFIRMED', paymentDate: '2026-10-20', reversed: '0.00' }] },
      'POST /v1/expense/payments/pi-1/reversal': () => [409, { error: 'EVIDENCE_KEY_REUSED', message: 'This evidence key was already used for a different payment event' }],
    });
    renderPage(<PaymentsPage />);
    fireEvent.click(await screen.findByText('Manage'));
    fireEvent.change(await screen.findByLabelText('Evidence reference'), { target: { value: 'SYN-BANK-CONF-001' } });
    fireEvent.change(screen.getByLabelText('Amount to reverse'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Reason for the reversal'), { target: { value: 'Synthetic bank return' } });
    fireEvent.click(screen.getByText('Record reversal'));
    expect((await screen.findByRole('alert')).textContent).toContain('EVIDENCE_KEY_REUSED');
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByLabelText('Evidence reference') as HTMLInputElement).value).toBe('SYN-BANK-CONF-001');
    expect((screen.getByLabelText('Amount to reverse') as HTMLInputElement).value).toBe('100');
  });
});

describe('new requests start clean after a successful submission', () => {
  it('the leave form forgets the dates and the private reason once submitted', async () => {
    session.permissions = ['leave.read.operational', 'leave.submit.operational'];
    const calls = mockApi({ ...LEAVE_ROUTES, 'POST /v1/leave/requests': () => [201, { requestId: 'lr-2', units: '1.0000', state: 'SUBMITTED' }] });
    renderPage(<LeavePage />);
    const form = (await screen.findByText('Submit request')).closest('form')!;
    await within(form).findByRole('option', { name: 'ANNUAL' });
    fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-11-10' } });
    fireEvent.change(within(form).getByLabelText('To'), { target: { value: '2026-11-10' } });
    fireEvent.change(within(form).getByLabelText('Reason (private, optional)'), { target: { value: 'Synthetic appointment' } });
    fireEvent.click(within(form).getByText('Submit request'));
    expect(await screen.findByText('Request submitted for review.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')!.body).toStrictEqual({ leaveType: 'ANNUAL', startDate: '2026-11-10', endDate: '2026-11-10', halfDay: false, reason: 'Synthetic appointment' });
    expect((within(form).getByLabelText('From') as HTMLInputElement).value).toBe('');
    expect((within(form).getByLabelText('To') as HTMLInputElement).value).toBe('');
    expect((within(form).getByLabelText('Reason (private, optional)') as HTMLInputElement).value).toBe('');
  });

  it('the cancellation form starts empty when it is opened again', async () => {
    session.permissions = ['leave.read.operational', 'leave.cancel.operational'];
    let cancellationState: string | null = null;
    const calls = mockApi({
      'GET /v1/employees/emp-1/leave-balances': LEAVE_ROUTES['GET /v1/employees/emp-1/leave-balances'],
      'GET /v1/employees/emp-1/leave-requests': () => [
        200,
        { items: [{ id: 'lr-5', leaveType: 'ANNUAL', startDate: '2026-12-01', endDate: '2026-12-02', halfDay: false, units: '2.0000', state: 'APPROVED', version: 4, cancellationState }] },
      ],
      'POST /v1/leave/requests/lr-5/cancellation': () => {
        cancellationState = 'REJECTED'; // refused meanwhile, so the leave can be asked about again
        return [201, { cancellationId: 'lc-1', state: 'SUBMITTED' }];
      },
    });
    renderPage(<LeavePage />);
    fireEvent.click(await screen.findByText('Cancel leave'));
    fireEvent.change(screen.getByLabelText('Cancellation reason'), { target: { value: 'Synthetic plans changed' } });
    fireEvent.click(screen.getByText('Ask to cancel'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toStrictEqual({ reason: 'Synthetic plans changed' });
    fireEvent.click(await screen.findByText('Cancel leave'));
    expect((screen.getByLabelText('Cancellation reason') as HTMLInputElement).value).toBe('');
  });

  it('a refused leave request keeps what was typed', async () => {
    session.permissions = ['leave.read.operational', 'leave.submit.operational'];
    mockApi({ ...LEAVE_ROUTES, 'POST /v1/leave/requests': () => [422, { error: 'INSUFFICIENT_BALANCE', message: 'Not enough leave balance; request unpaid leave or ask HR' }] });
    renderPage(<LeavePage />);
    const form = (await screen.findByText('Submit request')).closest('form')!;
    fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-11-10' } });
    fireEvent.change(within(form).getByLabelText('To'), { target: { value: '2026-11-12' } });
    fireEvent.click(within(form).getByText('Submit request'));
    expect((await screen.findByRole('alert')).textContent).toContain('INSUFFICIENT_BALANCE');
    expect((within(form).getByLabelText('From') as HTMLInputElement).value).toBe('2026-11-10');
    expect((within(form).getByLabelText('To') as HTMLInputElement).value).toBe('2026-11-12');
  });
});

describe('report requests (FR-046 Export XLSX)', () => {
  const CATALOGUE = {
    items: [
      { code: 'EMPLOYEE_REGISTER', title: 'Employee register', requiresPeriod: false, columns: ['Employee code'] },
      { code: 'TMS_HOURS', title: 'TMS hours by employee, project, job, activity and period', requiresPeriod: true, columns: ['Employee code'], formats: ['CSV', 'XLSX'] },
    ],
  };

  const own = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    reportCode: 'EMPLOYEE_REGISTER',
    title: 'Employee register',
    state: 'COMPLETED',
    rowCount: 3,
    failureCode: null,
    requestedAt: '2026-10-24T05:00:00Z',
    expiresAt: '2026-10-25T05:00:00Z',
    filters: {},
    format: 'CSV',
    ...overrides,
  });

  it('lists the reports already requested, with their downloads, without requesting anything: a reload loses nothing (FR-056)', async () => {
    const calls = mockApi({
      'GET /v1/reports/catalogue': CATALOGUE,
      'GET /v1/reports?': { items: [own('r-9'), own('r-8', { title: 'TMS hours', format: 'XLSX' })], total: 2, page: 1, pageSize: 25 },
    });
    renderPage(<ReportsPage />);
    expect(await screen.findByRole('button', { name: 'Download CSV' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download XLSX' })).toBeTruthy();
    expect(screen.getAllByRole('listitem').map((r) => r.querySelector('strong')?.textContent)).toEqual(['Employee register', 'TMS hours']);
    expect(screen.getByRole('heading', { name: 'My reports (2)' })).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(calls.find((c) => c.url.startsWith('/v1/reports?'))!.url).toBe('/v1/reports?page=1&pageSize=25');
  });

  it('asks for the report shown, never one this role was not offered; with none offered, says so and offers no request', async () => {
    const offered = { items: [{ code: 'LEAVE_REGISTER', title: 'Leave register', requiresPeriod: false }, { code: 'MY_TEAM', title: 'My team', requiresPeriod: false }] };
    const calls = mockApi({
      'GET /v1/reports/catalogue': offered,
      'GET /v1/reports?': { items: [], total: 0, page: 1, pageSize: 25 },
      'POST /v1/reports': () => [202, { id: 'r-1', state: 'QUEUED', format: 'CSV' }] as Reply,
    });
    const view = renderPage(<ReportsPage />);
    const choice = (await screen.findByLabelText('Report')) as HTMLSelectElement;
    expect(choice.value).toBe('LEAVE_REGISTER');
    fireEvent.click(screen.getByRole('button', { name: 'Request' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ reportCode: 'LEAVE_REGISTER' });
    view.unmount();
    mockApi({ 'GET /v1/reports/catalogue': { items: [] }, 'GET /v1/reports?': { items: [], total: 0, page: 1, pageSize: 25 } });
    renderPage(<ReportsPage />);
    expect(await screen.findByText('No report can be requested in this role.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request' })).toBeNull();
  });

  it('says plainly that nothing was requested, as distinct from a failed answer', async () => {
    mockApi({ 'GET /v1/reports/catalogue': CATALOGUE, 'GET /v1/reports?': { items: [], total: 0, page: 1, pageSize: 25 } });
    const view = renderPage(<ReportsPage />);
    expect(await screen.findByText('You have not requested any reports under this role.')).toBeTruthy();
    view.unmount();
    mockApi({ 'GET /v1/reports/catalogue': CATALOGUE, 'GET /v1/reports?': () => [500, { error: 'INTERNAL', message: 'The list could not be read' }] });
    renderPage(<ReportsPage />);
    expect(await screen.findByText('The list could not be read', { exact: false })).toBeTruthy();
    expect(screen.queryByText('You have not requested any reports under this role.')).toBeNull();
  });

  it('shows the progress, says failures in words instead of codes, and offers no download unless the report is ready', async () => {
    mockApi({
      'GET /v1/reports/catalogue': CATALOGUE,
      'GET /v1/reports?': {
        items: [
          own('r-1', { state: 'RUNNING', rowCount: null, expiresAt: null }),
          own('r-2', { state: 'QUEUED', rowCount: null, expiresAt: null, failureCode: 'PG_57014' }),
          own('r-3', { state: 'FAILED', rowCount: null, expiresAt: null, failureCode: 'ACCESS_REVOKED' }),
          own('r-4', { state: 'FAILED', rowCount: null, expiresAt: null, failureCode: 'PG_57014' }),
          own('r-5', { state: 'EXPIRED' }),
          own('r-6', { state: 'COMPLETED', rowCount: 0 }),
        ],
        total: 6,
        page: 1,
        pageSize: 25,
      },
    });
    renderPage(<ReportsPage />);
    const rows = await screen.findAllByRole('listitem');
    const text = rows.map((r) => r.textContent ?? '');
    expect(text[0]).toContain('running');
    expect(text[1]).toContain('The last attempt failed; it is being tried again.');
    expect(text[2]).toContain('Your access changed after the request, so nothing was generated.');
    expect(text[2]).not.toContain('ACCESS_REVOKED');
    expect(text[3]).toContain('The report could not be generated. Request it again; if it keeps failing, quote PG_57014 to support.');
    expect(text[4]).toContain('the download has expired, so request the report again');
    // No rows is a finished report of no rows, with a download; only that one is offered.
    expect(text[5]).toContain('0 rows');
    expect(screen.getAllByRole('button', { name: /^Download/ })).toHaveLength(1);
    expect(within(rows[5]!).getByRole('button', { name: 'Download CSV' })).toBeTruthy();
  });

  it('pages the list with the total of every report', async () => {
    const asked: string[] = [];
    mockApi({
      'GET /v1/reports/catalogue': CATALOGUE,
      'GET /v1/reports?': (c: Call): Reply => {
        asked.push(c.url);
        return [200, { items: [own(c.url.includes('page=2') ? 'r-26' : 'r-1')], total: 26, page: c.url.includes('page=2') ? 2 : 1, pageSize: 25 }];
      },
    });
    renderPage(<ReportsPage />);
    await screen.findByRole('button', { name: 'Download CSV' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Report pages' })).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(asked.at(-1)).toBe('/v1/reports?page=2&pageSize=25'));
    expect(await screen.findByText('Page 2 of 2 · 26 reports')).toBeTruthy();
  });

  it('keeps asking while a report is being generated, and offers its download when it is ready', async () => {
    let answers = 0;
    mockApi({
      'GET /v1/reports/catalogue': CATALOGUE,
      'GET /v1/reports?': () => [200, { items: [++answers === 1 ? own('r-1', { state: 'RUNNING', rowCount: null, expiresAt: null }) : own('r-1')], total: 1, page: 1, pageSize: 25 }],
    });
    renderPage(<ReportsPage />);
    await screen.findByText('RUNNING', { exact: false });
    expect(screen.queryByRole('button', { name: 'Download CSV' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Download CSV' }, { timeout: 6000 })).toBeTruthy();
    expect(answers).toBe(2);
  }, 10_000);

  it('offers the format choice only for a report that declares it and sends the chosen format', async () => {
    let next = 0;
    const requested: Record<string, unknown>[] = [];
    const calls = mockApi({
      'GET /v1/reports/catalogue': CATALOGUE,
      'GET /v1/reports?': () => [200, { items: requested, total: requested.length, page: 1, pageSize: 25 }],
      'POST /v1/reports': (c: Call): Reply => {
        const body = c.body as unknown as { reportCode: string; format?: string };
        const id = `r-${++next}`;
        requested.unshift(own(id, { reportCode: body.reportCode, title: body.reportCode, format: body.format ?? 'CSV' }));
        return [202, { id, state: 'QUEUED' }];
      },
    });
    renderPage(<ReportsPage />);
    await screen.findByRole('option', { name: 'TMS hours by employee, project, job, activity and period' });
    // A CSV-only report: no format choice, and no format is sent.
    expect(screen.queryByLabelText('Format')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Request' }));
    expect(await screen.findByRole('button', { name: 'Download CSV' })).toBeTruthy();
    const posts = () => calls.filter((c) => c.method === 'POST' && c.url === '/v1/reports').map((c) => c.body);
    expect(posts()).toEqual([{ reportCode: 'EMPLOYEE_REGISTER', filters: {} }]);

    // The timesheet export offers CSV (the default) and XLSX.
    fireEvent.change(screen.getByLabelText('Report'), { target: { value: 'TMS_HOURS' } });
    const format = screen.getByLabelText('Format') as HTMLSelectElement;
    expect([...format.options].map((o) => o.value)).toEqual(['CSV', 'XLSX']);
    expect(format.value).toBe('CSV');
    fireEvent.change(format, { target: { value: 'XLSX' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-03-02' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-22' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request' }));
    expect(await screen.findByRole('button', { name: 'Download XLSX' })).toBeTruthy();
    expect(posts()[1]).toEqual({ reportCode: 'TMS_HOURS', filters: { from: '2026-03-02', to: '2026-03-22' }, format: 'XLSX' });

    // Back to a CSV-only report: the choice goes away and is not sent.
    fireEvent.change(screen.getByLabelText('Report'), { target: { value: 'EMPLOYEE_REGISTER' } });
    expect(screen.queryByLabelText('Format')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Request' }));
    await waitFor(() => expect(posts()).toHaveLength(3));
    expect(posts()[2]).toMatchObject({ reportCode: 'EMPLOYEE_REGISTER' });
    expect(posts()[2]).not.toHaveProperty('format');
    // The dates chosen for the earlier report are not sent to one without a period, which would refuse them (hidden from view).
    expect(posts()[2]).toEqual({ reportCode: 'EMPLOYEE_REGISTER', filters: {} });
  });
});

describe('"today" is the local calendar day', () => {
  const tz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Asia/Kolkata'; // UTC+5:30
  });
  afterAll(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the payment date starts at the local day, not the UTC one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-25T20:00:00Z')); // 01:30 on 26 October in India
    session.permissions = ['payment.read.operational', 'payment.prepare.operational'];
    mockApi({ 'GET /v1/expense/payables': { items: [PAYABLE] }, 'GET /v1/expense/claims/cl-5/payments': { items: [] } });
    renderPage(<PaymentsPage />);
    fireEvent.click(await screen.findByText('Manage'));
    expect(((await screen.findByLabelText('Payment date')) as HTMLInputElement).value).toBe('2026-10-26');
  });
});
