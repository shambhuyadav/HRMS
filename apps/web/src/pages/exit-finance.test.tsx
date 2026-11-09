// Exit finance screens (jsdom; I-81): FR-034 loan early settlement recorded from evidence and decided by someone else, and the
// employee's documents received in-app (FR-018, FR-054, DF09). Duties decide what is offered; synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODULE_SCREENS, MODULE_TASK_QUEUES } from '../screens-registry';
import { EXIT_FINANCE_SCREENS, EXIT_FINANCE_TASK_QUEUES } from './exit-finance';

const session = vi.hoisted(() => ({ permissions: [] as string[], userId: 'u-me' }));
vi.mock('../session', () => ({
  useSession: () => ({ stored: { companyId: 'c-1', assignmentId: 'a-1' }, me: { employeeId: null, userId: session.userId, scopeKind: 'COMPANY' }, can: (p: string) => session.permissions.includes(p) }),
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
const renderAt = (path: string, url: string) => {
  const screenDef = EXIT_FINANCE_SCREENS.find((s) => s.path === path)!;
  const Page = screenDef.component;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path={path} element={<Page />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

const LOAN = {
  id: 'l-1',
  employeeId: 'e-1',
  employeeCode: 'E001',
  loanKind: 'LOAN',
  currencyCode: 'INR',
  principal: '3000.0000',
  state: 'DISBURSED',
  recovered: '1000.0000',
  awaitingRecognition: '0.0000',
  outstanding: '2000.0000',
  disbursementDate: '2026-10-01',
  version: 3,
  earlySettlements: [],
};
const DOC = { id: 'd-1', documentType: 'GENERAL', fileName: 'receipt.pdf', uploadedAt: '2026-11-01T10:00:00Z', scanState: 'CLEAN', verificationState: 'VERIFIED' };

describe('exit finance screens (I-81)', () => {
  it('registers its screens and the decision queue through the module registry', () => {
    for (const s of EXIT_FINANCE_SCREENS) expect(MODULE_SCREENS).toContain(s);
    for (const q of EXIT_FINANCE_TASK_QUEUES) expect(MODULE_TASK_QUEUES).toContain(q);
  });

  it('FR-034 records an early settlement with the amounts entered and its verified evidence, for someone else to decide', async () => {
    session.permissions = ['payroll_loan.read.loan', 'payroll_loan.disburse.loan', 'document.read.document'];
    const calls = mockApi({
      'GET /v1/payroll-outputs/loans/l-1': [200, LOAN],
      'GET /v1/employees/e-1/documents': [200, { items: [DOC] }],
      'POST /v1/payroll-outputs/loans/l-1/early-settlement': [201, { ...LOAN, earlySettlements: [{ id: 's-1', state: 'PROPOSED' }] }],
    });
    renderAt('/payroll/loans/:id/early-settlement', '/payroll/loans/l-1/early-settlement');
    await screen.findByText(/Loan of E001/);
    type(screen.getByLabelText('Repaid by the employee'), '1500');
    type(screen.getByLabelText('Repayment date'), '2026-11-02');
    type(screen.getByLabelText('Receipt or bank reference'), 'SYNTH-RCPT');
    fireEvent.click(await screen.findByRole('radio'));
    type(screen.getByLabelText('Waived or written off'), '500');
    type(screen.getByLabelText('Kind'), 'WAIVER');
    type(screen.getByLabelText('Reason'), 'Hardship (synthetic)');
    fireEvent.click(screen.getByRole('button', { name: 'Record for an independent decision' }));
    await screen.findByText(/Someone other than you decides it/);
    const sent = calls.find((c) => c.method === 'POST')!;
    expect(sent.body).toMatchObject({
      repaidAmount: '1500',
      repaymentRoute: 'DIRECT_REPAYMENT',
      repaymentDate: '2026-11-02',
      evidenceReference: 'SYNTH-RCPT',
      evidenceDocumentIds: ['d-1'],
      waivedAmount: '500',
      waiverKind: 'WAIVER',
      expectedVersion: 3,
    });
    expect(typeof sent.body!.evidenceKey).toBe('string');
  });

  it('FR-034 says the server’s refusal in words, and offers nothing without the disbursement duty', async () => {
    session.permissions = ['payroll_loan.read.loan', 'payroll_loan.disburse.loan', 'document.read.document'];
    mockApi({
      'GET /v1/payroll-outputs/loans/l-1': [200, LOAN],
      'GET /v1/employees/e-1/documents': [200, { items: [DOC] }],
      'POST /v1/payroll-outputs/loans/l-1/early-settlement': [422, { error: 'SETTLEMENT_NOT_BALANCED', message: 'x', details: { balance: '2000.0000' } }],
    });
    renderAt('/payroll/loans/:id/early-settlement', '/payroll/loans/l-1/early-settlement');
    await screen.findByText(/Loan of E001/);
    type(screen.getByLabelText('Repaid by the employee'), '100');
    type(screen.getByLabelText('Repayment date'), '2026-11-02');
    type(screen.getByLabelText('Receipt or bank reference'), 'SYNTH-RCPT');
    fireEvent.click(await screen.findByRole('radio'));
    type(screen.getByLabelText('Reason'), 'Synthetic');
    fireEvent.click(screen.getByRole('button', { name: 'Record for an independent decision' }));
    await screen.findByText('The repaid and waived amounts must add up to the balance left on the loan.');
    cleanup();
    session.permissions = ['payroll_loan.read.loan'];
    renderAt('/payroll/loans/:id/early-settlement', '/payroll/loans/l-1/early-settlement');
    expect(screen.getByText('The selected role cannot record early settlements of loans.')).toBeTruthy();
  });

  it('FR-034 the decider approves or rejects; whoever recorded it is not offered the decision', async () => {
    session.permissions = ['payroll_loan.read.loan', 'payroll_loan.decide.loan'];
    const item = { id: 's-1', loanId: 'l-1', employeeCode: 'E001', currencyCode: 'INR', balance: '2000.0000', repaidAmount: '2000.0000', repaymentRoute: 'DIRECT_REPAYMENT', waivedAmount: '0.0000', waiverKind: null, recordedBy: 'u-other', recordedAt: '2026-11-02T10:00:00Z', version: 1 };
    const calls = mockApi({
      'GET /v1/payroll-outputs/loan-settlements': [200, { items: [item, { ...item, id: 's-2', recordedBy: 'u-me' }] }],
      'POST /v1/payroll-outputs/loan-settlements/s-1/decision': [200, { id: 'l-1', state: 'CLOSED' }],
    });
    const Queue = EXIT_FINANCE_TASK_QUEUES[0]!.component;
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <Queue />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const approve = await screen.findAllByRole('button', { name: 'Approve and close the loan' });
    expect(approve[1]!.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('You recorded this settlement, so someone else decides it.')).toBeTruthy();
    fireEvent.click(approve[0]!);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/s-1/decision'))).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ decision: 'APPROVE', expectedVersion: 1 });
  });

  it('FR-018 FR-054 lists the employee’s own documents received in-app and opens them there (no e-mail)', async () => {
    session.permissions = ['own_delivery.read.delivery'];
    mockApi({
      'GET /v1/me/deliveries': [200, { items: [{ id: 'dl-1', kind: 'SETTLEMENT_STATEMENT', title: 'Full and final settlement statement', format: 'PDF', status: 'DELIVERED', sentAt: '2026-11-03T10:00:00Z', firstReadAt: null }] }],
    });
    renderAt('/me/documents-received', '/me/documents-received');
    expect(await screen.findByText('Full and final settlement statement')).toBeTruthy();
    expect(screen.getByText(/never as e-mail attachments/)).toBeTruthy();
    expect(screen.getByText('Not yet')).toBeTruthy();
  });
});
