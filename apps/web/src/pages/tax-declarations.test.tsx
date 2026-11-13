// Tax declarations and investment proofs (FR-036, FR-108; H3 TN08, TN09), jsdom: the NOT_CONFIGURED state in plain words, regimes
// and categories exactly as the active pack lists them, the submitted bodies, the employee-visible explanation apart from the
// private reason, and the review and rule pack screens. No tax figure is ever computed. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TAX_ESS_PANELS, TAX_SCREENS, TAX_TASK_QUEUES } from './tax-declarations';

const session = vi.hoisted(() => ({
  permissions: [] as string[],
  userId: 'b0000000-0000-4000-8000-000000000001',
  employeeId: 'e0000000-0000-4000-8000-000000000001' as string | null,
}));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: 'c1', assignmentId: 'a1' },
    me: { userId: session.userId, scopeKind: 'OWN', employeeId: session.employeeId, roleCode: 'EMPLOYEE' },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

type Reply = [number, unknown];
interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}
let calls: Call[] = [];

function serve(routes: Record<string, Reply | Reply[]>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      const route = routes[`${method} ${url.pathname}`];
      const reply: Reply = route === undefined ? [404, { error: 'NOT_FOUND', message: `No mock for ${method} ${url.pathname}` }] : Array.isArray(route[0]) ? (route as Reply[]).shift()! : (route as Reply);
      return new Response(JSON.stringify(reply[1]), { status: reply[0], headers: { 'content-type': 'application/json' } });
    }),
  );
}

const tree = (Component: React.ComponentType) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>
      <Component />
    </MemoryRouter>
  </QueryClientProvider>
);
const panel = (tabId: string, permissions: string[]) => {
  session.permissions = permissions;
  return render(tree(TAX_ESS_PANELS.find((p) => p.tabId === tabId)!.component));
};
const screenOf = (path: string, permissions: string[]) => {
  session.permissions = permissions;
  return render(tree(TAX_SCREENS.find((s) => s.path === path)!.component));
};

const OWN = ['own_tax.read.tax', 'own_tax.submit.tax'];
const CALCULATION = { status: 'NOT_CONFIGURED', message: 'No tax is calculated here.' };
const NOT_CONFIGURED = { status: 'NOT_CONFIGURED', code: 'TAX_RULE_PACK_NOT_CONFIGURED', message: 'Your company has not activated a tax rule pack yet.' };
const PERIOD = {
  rulePackId: 'p1',
  fiscalPeriodCode: 'FY-SYNTH',
  periodStart: '2026-01-01',
  periodEnd: '2026-12-31',
  cutoffDate: '2099-12-31',
  currencyCode: 'INR',
  cutoffPassed: false,
  regimes: [
    { code: 'SYNTH_A', name: 'Synthetic A', categories: [{ code: 'CAT_1', name: 'Category one' }, { code: 'CAT_2', name: 'Category two' }] },
    { code: 'SYNTH_B', name: 'Synthetic B', categories: [] },
  ],
};
const declaration = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  fiscalPeriodCode: 'FY-SYNTH',
  cutoffDate: '2099-12-31',
  currencyCode: 'INR',
  regimeCode: 'SYNTH_A',
  lines: [{ categoryCode: 'CAT_1', amount: '1000.00' }],
  state: 'DRAFT',
  employeeExplanation: null,
  employeeCode: 'SYN-001',
  employeeName: 'Asha Synthetic',
  version: 2,
  ...over,
});
const proof = (over: Record<string, unknown> = {}) => ({
  id: 'f1',
  declarationId: 'd1',
  fiscalPeriodCode: 'FY-SYNTH',
  categoryCode: 'CAT_1',
  categoryName: 'Category one',
  claimedAmount: '1000.00',
  acceptedAmount: null,
  rejectedAmount: null,
  currencyCode: 'INR',
  state: 'SUBMITTED',
  employeeExplanation: null,
  employeeCode: 'SYN-001',
  employeeName: 'Asha Synthetic',
  evidence: [{ documentId: 'doc1', documentType: 'GENERAL', scanState: 'CLEAN', verificationState: 'VERIFIED' }],
  ...over,
});

beforeEach(() => {
  session.permissions = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TN08 own tax declaration', () => {
  it('says so in plain words until a rule pack is activated, and offers no form', async () => {
    serve({ 'GET /v1/me/tax-declarations': [200, { items: [], total: 0, configuration: NOT_CONFIGURED, openPeriods: [], calculation: CALCULATION }] });
    panel('TN08', OWN);
    expect((await screen.findByRole('status')).textContent).toBe('Your company has not activated a tax rule pack yet.');
    expect(screen.queryByRole('form')).toBeNull();
    expect(document.body.textContent).toContain('No tax is calculated here.');
  });

  it('asks the Employee role without the read key and calls nothing', () => {
    serve({});
    panel('TN08', []);
    expect(document.body.textContent).toContain('Switch to it');
    expect(calls).toEqual([]);
  });

  it('offers exactly what the active pack lists and sends only the amounts entered', async () => {
    serve({
      'GET /v1/me/tax-declarations': [200, { items: [], total: 0, configuration: { status: 'ACTIVE' }, openPeriods: [PERIOD], calculation: CALCULATION }],
      'POST /v1/me/tax-declarations': [201, declaration()],
    });
    panel('TN08', OWN);
    const form = await screen.findByRole('form', { name: 'Declare for FY-SYNTH' });
    expect(within(form).getAllByRole('option').map((o) => o.textContent)).toEqual(['Synthetic A', 'Synthetic B']);
    fireEvent.change(within(form).getByLabelText('Category two'), { target: { value: '250.50' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ fiscalPeriodCode: 'FY-SYNTH', regimeCode: 'SYNTH_A', lines: [{ categoryCode: 'CAT_2', amount: '250.50' }] });
  });

  it('shows the refusal in plain words, and a regime with no categories takes no lines', async () => {
    serve({
      'GET /v1/me/tax-declarations': [200, { items: [], total: 0, configuration: { status: 'ACTIVE' }, openPeriods: [PERIOD], calculation: CALCULATION }],
      'POST /v1/me/tax-declarations': [409, { error: 'TAX_CUTOFF_PASSED', message: 'The cutoff for this fiscal period has passed' }],
    });
    panel('TN08', OWN);
    const form = await screen.findByRole('form', { name: 'Declare for FY-SYNTH' });
    fireEvent.change(within(form).getByRole('combobox'), { target: { value: 'SYNTH_B' } });
    expect(form.textContent).toContain('This regime lists no categories to declare.');
    fireEvent.click(within(form).getByRole('button', { name: 'Save draft' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The cutoff for this fiscal period has passed');
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ regimeCode: 'SYNTH_B', lines: [] });
  });

  it('submits a draft with its version, shows the employee explanation of a return, and hides the form while a declaration is live', async () => {
    serve({
      'GET /v1/me/tax-declarations': [
        200,
        { items: [declaration(), declaration({ id: 'd0', state: 'RETURNED', employeeExplanation: 'Split the amounts (synthetic)' })], total: 2, configuration: { status: 'ACTIVE' }, openPeriods: [PERIOD], calculation: CALCULATION },
      ],
      'POST /v1/me/tax-declarations/d1/submit': [200, declaration({ state: 'SUBMITTED' })],
    });
    panel('TN08', OWN);
    await screen.findAllByRole('listitem', { name: 'Declaration for FY-SYNTH' });
    expect(document.body.textContent).toContain('Split the amounts (synthetic)');
    expect(screen.queryByRole('form')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/submit'))).toBe(true));
    expect(calls.find((c) => c.path.endsWith('/submit'))!.body).toEqual({ expectedVersion: 2 });
  });

  it('shows a passed cutoff instead of the form', async () => {
    serve({ 'GET /v1/me/tax-declarations': [200, { items: [], total: 0, configuration: { status: 'ACTIVE' }, openPeriods: [{ ...PERIOD, cutoffPassed: true }], calculation: CALCULATION }] });
    panel('TN08', OWN);
    await waitFor(() => expect(document.body.textContent).toContain('The cutoff for FY-SYNTH passed on 31 Dec 2099.'));
    expect(screen.queryByRole('form')).toBeNull();
  });
});

describe('TN09 own investment proofs', () => {
  const lists = (items: unknown[], declarations: unknown[]) => ({
    'GET /v1/me/tax-proofs': [200, { items, total: items.length, configuration: { status: 'ACTIVE' } }] as Reply,
    'GET /v1/me/tax-declarations': [200, { items: declarations, total: declarations.length, configuration: { status: 'ACTIVE' }, openPeriods: [], calculation: CALCULATION }] as Reply,
    'GET /v1/employees/e0000000-0000-4000-8000-000000000001/documents': [200, { items: [{ id: 'doc1', fileName: 'proof.pdf', documentType: 'GENERAL' }] }] as Reply,
  });

  it('says NOT_CONFIGURED in plain words', async () => {
    serve({ 'GET /v1/me/tax-proofs': [200, { items: [], total: 0, configuration: NOT_CONFIGURED }], 'GET /v1/me/tax-declarations': [200, { items: [], total: 0, configuration: NOT_CONFIGURED, openPeriods: [], calculation: CALCULATION }] });
    panel('TN09', OWN);
    expect((await screen.findByRole('status')).textContent).toBe('Your company has not activated a tax rule pack yet.');
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('shows reviewer status with accepted and rejected amounts as returned, and says it gives no relief', async () => {
    serve(lists([proof({ state: 'ACCEPTED', acceptedAmount: '750.50', rejectedAmount: '249.50' })], []));
    panel('TN09', OWN);
    const table = await screen.findByRole('table', { name: 'My investment proofs' });
    expect(table.textContent).toContain('INR 750.50');
    expect(table.textContent).toContain('INR 249.50');
    expect(document.body.textContent).toContain('gives no tax relief by itself');
  });

  it('needs a category, an amount and evidence, and sends one idempotency key', async () => {
    serve({ ...lists([], [declaration({ state: 'SUBMITTED' })]), 'POST /v1/me/tax-proofs': [201, proof()] });
    panel('TN09', OWN);
    const form = await screen.findByRole('form', { name: 'Submit an investment proof' });
    const send = within(form).getByRole('button', { name: 'Submit proof' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('Category'), { target: { value: 'CAT_1' } });
    fireEvent.change(within(form).getByLabelText('Amount claimed'), { target: { value: '1000.00' } });
    expect(send.disabled).toBe(true);
    fireEvent.click(await within(form).findByRole('checkbox', { name: 'proof.pdf' }));
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ declarationId: 'd1', categoryCode: 'CAT_1', claimedAmount: '1000.00', evidenceDocumentIds: ['doc1'], idempotencyKey: expect.stringMatching(/^tax-proof-/) });
  });

  it('offers no form without a submitted declaration that has categories', async () => {
    serve(lists([], [declaration({ state: 'DRAFT' }), declaration({ id: 'd2', state: 'SUBMITTED', lines: [] })]));
    panel('TN09', OWN);
    await waitFor(() => expect(document.body.textContent).toContain('You have submitted no proofs.'));
    expect(screen.queryByRole('form')).toBeNull();
  });
});

describe('review', () => {
  const QUEUE = TAX_TASK_QUEUES[0]!;
  const tasks = {
    'GET /v1/tax-declarations/tasks/mine': [200, { items: [{ taskId: 't1', declaration: declaration({ state: 'SUBMITTED' }) }] }] as Reply,
    'GET /v1/tax-proofs/tasks/mine': [200, { items: [{ taskId: 't2', proof: proof() }] }] as Reply,
  };
  const queue = () => {
    session.permissions = ['tax_declaration.review.tax'];
    return render(tree(QUEUE.component));
  };

  it('is gated by the review key', () => {
    serve({});
    session.permissions = [];
    render(tree(QUEUE.component));
    expect(document.body.textContent).toContain('does not review');
    expect(calls).toEqual([]);
    expect(QUEUE.permission).toBe('tax_declaration.review.tax');
  });

  it('keeps the employee-visible explanation apart from the private reason', async () => {
    serve({ ...tasks, 'POST /v1/tax-declaration-tasks/t1/decision': [200, { state: 'RETURNED' }] });
    queue();
    const form = await screen.findByRole('form', { name: 'Review the declaration of SYN-001' });
    fireEvent.change(within(form).getByLabelText(/Explanation the employee sees/), { target: { value: 'Split the amounts' } });
    fireEvent.change(within(form).getByLabelText(/Private reason/), { target: { value: 'Private note' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Return' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ decision: 'RETURN', explanation: 'Split the amounts', reason: 'Private note', idempotencyKey: expect.any(String) });
  });

  it('accepts a proof with the amount the reviewer states, and shows the evidence state', async () => {
    serve({ ...tasks, 'POST /v1/tax-proof-tasks/t2/decision': [200, { state: 'ACCEPTED' }] });
    queue();
    const form = await screen.findByRole('form', { name: 'Review the proof of SYN-001' });
    expect(document.body.textContent).toContain('(released and verified)');
    fireEvent.change(within(form).getByLabelText('Accepted amount'), { target: { value: '750.50' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ decision: 'ACCEPT', acceptedAmount: '750.50' });
    expect(document.body.textContent).toContain('no tax is calculated');
  });

  it('shows the server refusal', async () => {
    serve({ ...tasks, 'POST /v1/tax-declaration-tasks/t1/decision': [409, { error: 'TAX_RULE_PACK_CHANGED', message: 'A new rule pack replaced the one this declaration was written under' }] });
    queue();
    const form = await screen.findByRole('form', { name: 'Review the declaration of SYN-001' });
    fireEvent.click(within(form).getByRole('button', { name: 'Accept' }));
    expect((await within(form).findByRole('alert')).textContent).toContain('A new rule pack replaced');
  });

  describe('evidence on a proof (FR-106)', () => {
    const EVIDENCE = '/v1/tax-proofs/p2/evidence/doc1';
    const withEvidence = (scanState: string | null, verificationState = 'UNVERIFIED') => ({
      'GET /v1/tax-declarations/tasks/mine': [200, { items: [] }] as Reply,
      'GET /v1/tax-proofs/tasks/mine': [200, { items: [{ taskId: 't2', proof: proof({ id: 'p2', evidence: [{ documentId: 'doc1', documentType: 'GENERAL', scanState, verificationState }] }) }] }] as Reply,
    });
    const open = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Open GENERAL' }));
      await waitFor(() => expect(calls.some((c) => c.path === EVIDENCE)).toBe(true));
    };

    it.each([
      ['PENDING_SCAN', 'UNVERIFIED', 'waiting for the malware scan'],
      [null, 'UNVERIFIED', 'waiting for the malware scan'],
      ['QUARANTINED', 'UNVERIFIED', 'quarantined by the malware scan'],
      ['CLEAN', 'UNVERIFIED', 'released, not verified yet'],
      ['CLEAN', 'VERIFIED', 'released and verified'],
      ['CLEAN', 'REJECTED', 'released, rejected by the verifier'],
    ])('scan %s and verification %s read as "%s", never as a code', async (scanState, verificationState, words) => {
      serve(withEvidence(scanState, verificationState));
      queue();
      await screen.findByRole('button', { name: 'Open GENERAL' });
      expect(document.body.textContent).toContain(`(${words})`);
      expect(document.body.textContent).not.toMatch(/PENDING_SCAN|QUARANTINED|UNVERIFIED|scan:|verification:/);
    });

    it('says why a file waiting for the scan will not open', async () => {
      serve({ ...withEvidence('PENDING_SCAN'), [`GET ${EVIDENCE}`]: [409, { error: 'FILE_NOT_RELEASED', message: 'This file has not been released by the malware scan', details: { scanState: 'PENDING_SCAN' } }] });
      queue();
      await open();
      expect((await screen.findByRole('alert')).textContent).toBe('This file is still waiting for the malware scan, so it cannot be opened yet. Try again shortly.');
    });

    it('says a quarantined file will never open', async () => {
      serve({ ...withEvidence('PENDING_SCAN'), [`GET ${EVIDENCE}`]: [409, { error: 'FILE_NOT_RELEASED', message: 'This file has not been released by the malware scan', details: { scanState: 'QUARANTINED' } }] });
      queue();
      await open();
      expect((await screen.findByRole('alert')).textContent).toBe('The malware scan flagged this file, so it can never be opened.');
    });

    it('shows any other refusal as the server sent it', async () => {
      serve({ ...withEvidence('CLEAN'), [`GET ${EVIDENCE}`]: [404, { error: 'NOT_FOUND', message: 'Not found' }] });
      queue();
      await open();
      expect((await screen.findByRole('alert')).textContent).toContain('Not found (NOT_FOUND)');
    });

    it('opens a released file and reports nothing', async () => {
      Object.assign(URL, { createObjectURL: () => 'blob:synthetic', revokeObjectURL: () => undefined });
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
      serve({ ...withEvidence('CLEAN', 'VERIFIED'), [`GET ${EVIDENCE}`]: [200, {}] });
      queue();
      await open();
      await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('alert')).toBeNull();
      click.mockRestore();
    });
  });
});

describe('Form 16 Part B working data (FR-107, I-90)', () => {
  const READ = ['tax_declaration.read.tax'];
  const lists = {
    'GET /v1/tax-declarations': [200, { items: [declaration({ state: 'ACCEPTED', employeeId: 'e0000000-0000-4000-8000-000000000009', fiscalPeriodCode: '2026-27' })], total: 1 }] as Reply,
    'GET /v1/tax-proofs': [200, { items: [], total: 0 }] as Reply,
  };
  const SALARY = { processedMonths: 2, grossSalary: '2000000.00', exemptAllowances: '40000.00', tdsDeducted: '48750.00' };
  const PART_A = { status: 'NOT_AVAILABLE', reason: 'Part A comes from TRACES, an outside input; no Form 16 is issued here.' };

  it('is not offered without the read key', () => {
    serve(lists);
    screenOf('/payroll/tax-review', []);
    expect(screen.queryByRole('form', { name: 'Form 16 Part B' })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('asks for the employee and year, and shows the figures exactly as the server returns them', async () => {
    serve({
      ...lists,
      'GET /v1/payroll/form16/part-b': [
        200,
        {
          status: 'CALCULATED',
          regime: 'OLD',
          regimeSource: 'DECLARATION',
          salary: { ...SALARY, finalSettlement: { taxableSalary: '2200000.00', exemptAllowances: '0.00', tdsDeducted: '268125.00' } },
          standardDeduction: '50000.00',
          hraExemption: { exemption: '50000.00', hraReceived: '50000.00', salaryForHra: '100000.00', rentPaid: '600000.00', metro: true },
          previousEmployment: { salary: '900000.00', tds: '50000.00' },
          deductions: [{ categoryCode: 'SEC_80C', amount: '200000.00', limit: '150000.00', allowed: '150000.00' }],
          taxableIncome: '1800000.00',
          tax: { slabTax: '352500.00', rebate: '0.00', surcharge: '0.00', cess: '14100.00', total: '366600.00' },
          balance: '317850.00',
          partA: PART_A,
        },
      ],
    });
    screenOf('/payroll/tax-review', READ);
    const form = await screen.findByRole('form', { name: 'Form 16 Part B' });
    fireEvent.change(within(form).getByLabelText('Employee ID'), { target: { value: 'e0000000-0000-4000-8000-000000000009' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Show Part B' }));
    const dl = await screen.findByLabelText('Part B figures');
    expect(dl.textContent).toContain('Calculated (OLD regime, as declared)');
    expect(dl.textContent).toContain('SEC_80C');
    expect(dl.textContent).toContain('Part A comes from TRACES');
    expect(dl.textContent).toContain('Final settlement (included)');
    expect(dl.textContent).toContain('House rent allowance exempt');
    expect(dl.textContent).toContain('Earlier employer this year (Form 12B)');
    expect(dl.textContent).toContain('metro city');
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes('/form16/'))).toEqual(['/v1/payroll/form16/part-b?employeeId=e0000000-0000-4000-8000-000000000009&fiscalYear=2026-27']);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('says plainly when no income tax pack is active, and opens a declaration’s year from the list', async () => {
    serve({
      ...lists,
      'GET /v1/payroll/form16/part-b': [
        200,
        { status: 'NOT_CONFIGURED', code: 'INCOME_TAX_PACK_NOT_ACTIVE', message: 'No INCOME_TAX rule pack for 2026-27 has been validated and activated; nothing is valued.', salary: SALARY, partA: PART_A },
      ],
    });
    screenOf('/payroll/tax-review', READ);
    fireEvent.click(await screen.findByRole('button', { name: 'Part B: SYN-001 2026-27' }));
    const dl = await screen.findByLabelText('Part B figures');
    expect(dl.textContent).toContain('nothing is valued');
    expect(dl.textContent).not.toContain('Calculated');
    // Without a final settlement paid this year, no settlement row.
    expect(dl.textContent).not.toContain('Final settlement');
  });

  it('shows the server refusal', async () => {
    serve({ ...lists, 'GET /v1/payroll/form16/part-b': [422, { error: 'INVALID_FISCAL_YEAR', message: 'A financial year looks like 2026-27' }] });
    screenOf('/payroll/tax-review', READ);
    const form = await screen.findByRole('form', { name: 'Form 16 Part B' });
    fireEvent.change(within(form).getByLabelText('Employee ID'), { target: { value: 'e1' } });
    fireEvent.change(within(form).getByLabelText('Financial year'), { target: { value: '2026-28' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Show Part B' }));
    expect((await screen.findByRole('alert')).textContent).toContain('A financial year looks like 2026-27');
  });
});

describe('rule packs', () => {
  const PACK = { id: 'p1', code: 'SYNTH_PACK', revision: 1, fiscalPeriodCode: 'FY-SYNTH', cutoffDate: '2099-12-31', state: 'DRAFT', version: 1, createdBy: 'someone-else', regimes: PERIOD.regimes };

  it('says plainly that none exists, and takes no rate anywhere', async () => {
    serve({ 'GET /v1/payroll/tax-rule-packs': [200, { items: [], calculation: CALCULATION }] });
    screenOf('/payroll/tax-rule-packs', ['payroll_config.read.operational', 'payroll_config.manage.operational']);
    await waitFor(() => expect(document.body.textContent).toContain('No rule pack has been recorded.'));
    const form = screen.getByRole('form', { name: 'Record a tax rule pack' });
    const fields = Array.from(form.querySelectorAll('label')).map((l) => l.textContent);
    expect(fields.length).toBeGreaterThan(5);
    for (const field of fields) expect(field).not.toMatch(/\brate\b|slab|percent|formula/i);
  });

  it('parses regimes and categories as typed and sends them with the pack', async () => {
    serve({ 'GET /v1/payroll/tax-rule-packs': [200, { items: [], calculation: CALCULATION }], 'POST /v1/payroll/tax-rule-packs': [201, PACK] });
    screenOf('/payroll/tax-rule-packs', ['payroll_config.read.operational', 'payroll_config.manage.operational']);
    const form = await screen.findByRole('form', { name: 'Record a tax rule pack' });
    fireEvent.change(within(form).getByLabelText('Pack code'), { target: { value: 'SYNTH_PACK' } });
    fireEvent.change(within(form).getByLabelText('Currency decimals'), { target: { value: '2' } });
    fireEvent.change(within(form).getByLabelText(/Regimes and categories/), { target: { value: 'SYNTH_A Synthetic A: CAT_1 Category one, CAT_2\nSYNTH_B Synthetic B:' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      code: 'SYNTH_PACK',
      currencyMinorUnit: 2,
      regimes: [
        { code: 'SYNTH_A', name: 'Synthetic A', categories: [{ code: 'CAT_1', name: 'Category one' }, { code: 'CAT_2', name: 'CAT_2' }] },
        { code: 'SYNTH_B', name: 'Synthetic B', categories: [] },
      ],
    });
  });

  it('offers activation only to someone other than the author, with the activate key', async () => {
    serve({ 'GET /v1/payroll/tax-rule-packs': [200, { items: [PACK, { ...PACK, id: 'p2', revision: 2, createdBy: session.userId }, { ...PACK, id: 'p3', revision: 3, state: 'ACTIVE' }], calculation: CALCULATION }], 'POST /v1/payroll/tax-rule-packs/p1/activate': [200, { ...PACK, state: 'ACTIVE' }] });
    screenOf('/payroll/tax-rule-packs', ['payroll_config.read.operational', 'payroll_config.activate.operational']);
    const buttons = await screen.findAllByRole('button', { name: 'Activate' });
    expect(buttons).toHaveLength(1);
    expect(within(screen.getByRole('listitem', { name: 'Pack SYNTH_PACK revision 2' })).queryByRole('button')).toBeNull();
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ expectedVersion: 1 });
  });

  it('declares its screens with their keys', () => {
    expect(TAX_SCREENS.map((s) => [s.path, s.permission])).toEqual([
      ['/payroll/tax-rule-packs', 'payroll_config.read.operational'],
      ['/payroll/tax-review', 'tax_declaration.read.tax'],
    ]);
  });
});
