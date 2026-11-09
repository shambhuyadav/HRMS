// HR entry of a non-resignation separation (jsdom; FR-051, FR-052, FR-055; I-89 item 7, I-92): each type's date rule in words, the
// reference and one verified document, the exit reason code a termination requires, and the server's refusals in plain words.
// Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnterSeparationForm, SEPARATION_TYPE_RULES } from './separation-entry';

const session = vi.hoisted(() => ({ permissions: ['document.read.document'] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({ stored: { companyId: 'c-1', assignmentId: 'a-1' }, me: { employeeId: null, userId: 'u-hr', scopeKind: 'COMPANY' }, can: (p: string) => session.permissions.includes(p) }),
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

const EMPLOYEE = 'e0000000-0000-4000-8000-000000000001';
const DOC = { id: 'd0000000-0000-4000-8000-000000000001', documentType: 'GENERAL', fileName: 'order.pdf', uploadedAt: '2026-11-02T05:00:00.000Z', scanState: 'CLEAN', verificationState: 'VERIFIED' };
const UNVERIFIED = { ...DOC, id: 'd0000000-0000-4000-8000-000000000002', fileName: 'draft.pdf', verificationState: 'UNVERIFIED' };
const REASONS = { category: 'EXIT_REASON', items: [{ code: 'MISCONDUCT', label: 'Misconduct (synthetic)' }] };

const renderForm = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <EnterSeparationForm employeeId={EMPLOYEE} exitsKey={['lifecycle-processes', 'c-1:a-1', 'exits']} />
    </QueryClientProvider>,
  );
const choose = (form: HTMLElement, label: string, value: string) => fireEvent.change(within(form).getByLabelText(label), { target: { value } });
const submit = (form: HTMLElement) => fireEvent.click(within(form).getByRole('button', { name: 'Enter the separation' }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HR separation entry (I-89 item 7; I-92)', () => {
  it('a termination needs its date, reference, one verified document and an exit reason code, and is sent as entered', async () => {
    const calls = mockApi({
      [`GET /v1/employees/${EMPLOYEE}/documents`]: [200, { items: [DOC, UNVERIFIED] }],
      'GET /v1/exit-reasons': [200, REASONS],
      [`POST /v1/employees/${EMPLOYEE}/separations`]: [201, { exitCaseId: 'x-1', state: 'SUBMITTED' }],
    });
    renderForm();
    const form = screen.getByRole('form', { name: 'Enter a separation' });
    // Nothing is read until a type is chosen.
    expect(calls).toEqual([]);
    submit(form);
    expect(await screen.findByText('Choose the type of separation.')).toBeTruthy();
    choose(form, 'Type of separation', 'TERMINATION');
    expect(within(form).getByText(/Notice is the employer’s to give under the contract/)).toBeTruthy();
    choose(form, 'Proposed last working date', '2026-12-31');
    choose(form, 'Reference of the document received', 'Order HR/T/7 (synthetic)');
    // Only the released, verified document can be chosen.
    const radios = await within(form).findAllByRole('radio');
    expect(radios.map((r) => (r as HTMLInputElement).disabled)).toEqual([false, true]);
    fireEvent.click(radios[0]!);
    submit(form);
    expect(await screen.findByText('Choose the ground of the termination from the company’s exit reasons.')).toBeTruthy();
    await within(form).findByRole('option', { name: 'Misconduct (synthetic) (MISCONDUCT)' });
    choose(form, 'Ground of the termination (exit reason, required)', 'MISCONDUCT');
    choose(form, 'Reason (optional; seen by authorised reviewers only)', 'Synthetic ground');
    submit(form);
    expect(await screen.findByText('The termination is entered and waits for the manager’s recommendation.')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body])).toEqual([
      [
        `/v1/employees/${EMPLOYEE}/separations`,
        { separationType: 'TERMINATION', proposedLastWorkingDate: '2026-12-31', evidenceReference: 'Order HR/T/7 (synthetic)', evidenceDocumentIds: [DOC.id], reasonCode: 'MISCONDUCT', reason: 'Synthetic ground' },
      ],
    ]);
  });

  it('each type says its own date rule; a death is dated on or before today, with no exit reason required', async () => {
    const calls = mockApi({
      [`GET /v1/employees/${EMPLOYEE}/documents`]: [200, { items: [DOC] }],
      'GET /v1/exit-reasons': [200, { category: 'EXIT_REASON', items: [] }],
      [`POST /v1/employees/${EMPLOYEE}/separations`]: [201, { exitCaseId: 'x-2', state: 'SUBMITTED' }],
    });
    renderForm();
    const form = screen.getByRole('form', { name: 'Enter a separation' });
    for (const [type, rule] of Object.entries(SEPARATION_TYPE_RULES)) {
      choose(form, 'Type of separation', type);
      expect(within(form).getByLabelText(rule.dateLabel), type).toBeTruthy();
      expect(within(form).getByText(new RegExp(rule.dateRule.replace(/[.()]/g, '\\$&'))), type).toBeTruthy();
    }
    choose(form, 'Type of separation', 'DEATH');
    expect(await within(form).findByText(/No exit reason codes are configured yet/)).toBeTruthy();
    choose(form, 'Date of death', '2026-11-01');
    choose(form, 'Reference of the document received', 'Certificate 0001 (synthetic)');
    fireEvent.click(await within(form).findByRole('radio'));
    submit(form);
    expect(await screen.findByText('The death is entered and waits for the manager’s recommendation.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ separationType: 'DEATH', proposedLastWorkingDate: '2026-11-01', evidenceReference: 'Certificate 0001 (synthetic)', evidenceDocumentIds: [DOC.id] });
  });

  it('says the server’s refusals in words, keeping the date rule the server names', async () => {
    let reply: Reply = [422, { error: 'INVALID_LAST_WORKING_DATE', message: 'The date of death cannot be in the future' }];
    mockApi({
      [`GET /v1/employees/${EMPLOYEE}/documents`]: [200, { items: [DOC] }],
      'GET /v1/exit-reasons': [200, REASONS],
      [`POST /v1/employees/${EMPLOYEE}/separations`]: () => reply,
    });
    renderForm();
    const form = screen.getByRole('form', { name: 'Enter a separation' });
    choose(form, 'Type of separation', 'DEATH');
    choose(form, 'Date of death', '2027-01-05');
    choose(form, 'Reference of the document received', 'Certificate 0002 (synthetic)');
    fireEvent.click(await within(form).findByRole('radio'));
    submit(form);
    expect(await screen.findByText('The date was not accepted: The date of death cannot be in the future.')).toBeTruthy();
    for (const [error, words] of [
      ['OPEN_EXIT_EXISTS', 'The employee already has an open exit. It must be decided or rejected before another separation is entered.'],
      ['EVIDENCE_NOT_VERIFIED', 'The document must be released by the malware scan and verified by someone independent first.'],
      ['SELF_ACTION_NOT_ALLOWED', 'You cannot enter a separation on your own record.'],
      ['EMPLOYEE_NOT_ACTIVE', 'Only an active employee can be separated.'],
    ] as const) {
      reply = [error === 'SELF_ACTION_NOT_ALLOWED' ? 403 : error === 'OPEN_EXIT_EXISTS' || error === 'EMPLOYEE_NOT_ACTIVE' ? 409 : 422, { error, message: 'Synthetic refusal' }];
      submit(form);
      expect(await screen.findByText(words), error).toBeTruthy();
    }
  });

  it('without the document read grant it says the evidence cannot be chosen here', async () => {
    session.permissions = [];
    mockApi({ 'GET /v1/exit-reasons': [200, REASONS] });
    renderForm();
    const form = screen.getByRole('form', { name: 'Enter a separation' });
    choose(form, 'Type of separation', 'RETIREMENT');
    expect(within(form).getByText('The selected role cannot list the employee’s documents, so it cannot choose the evidence here.')).toBeTruthy();
    session.permissions = ['document.read.document'];
  });
});
