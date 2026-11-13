// Payroll pages (FR-028 to FR-034, FR-038, FR-102, FR-107; H2; H3 TN06 and TN15; DF02; DF07; I-28; I-32), jsdom:
// own issued payslips with earned, held, reserved and paid apart and superseded versions marked, own loans with the
// request and withdrawal bodies, runs with their per-state actions each gated by its key, confidential amounts only
// when returned, exception resolution, the review and approval queues with idempotency keys reused only after a lost
// answer, payslip publishing, bank manifests (independent authorisation, outcomes from evidence, reversals, nothing
// called paid unless CONFIRMED), the loan decision queue, refusals in plain words and the exported navigation.
// Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAYROLL_ESS_PANELS, PAYROLL_SCREENS, PAYROLL_TASK_QUEUES, statutoryNote } from './payroll';

const session = vi.hoisted(() => ({
  permissions: [] as string[],
  companyId: 'c0000000-0000-4000-8000-000000000001',
  assignmentId: 'a0000000-0000-4000-8000-000000000001',
  userId: 'b0000000-0000-4000-8000-000000000001',
  employeeId: null as string | null,
  roleCode: 'HR_ADMINISTRATOR',
  scopeKind: 'COMPANY',
}));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: session.companyId, assignmentId: session.assignmentId },
    me: {
      userId: session.userId,
      accountKey: 'syn.user',
      companyName: 'Synthetic Co',
      roleCode: session.roleCode,
      roleName: 'Synthetic role',
      scopeKind: session.scopeKind,
      employeeId: session.employeeId,
      displayName: 'Synthetic User',
    },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

const OWN_PAYSLIP = 'payslip.read.payslip';
const OWN_LOAN_READ = 'own_loan.read.loan';
const OWN_LOAN_REQUEST = 'own_loan.request.loan';
const CONFIG_READ = 'payroll_config.read.operational';
const RUN_STATUS = 'payroll_run.read.operational';
const RUN_AMOUNT = 'payroll_run.read.amount';
const RUN_PREPARE = 'payroll_run.prepare.amount';
const RUN_REVIEW = 'payroll_run.review.amount';
const RUN_APPROVE = 'payroll_run.approve.amount';
const RUN_PROCESS = 'payroll_run.process.amount';
const RUN_CANCEL = 'payroll_run.cancel.amount';
const OUTPUT_READ = 'payroll_output.read.amount';
const OUTPUT_PUBLISH = 'payroll_output.publish.amount';
const TEMPLATE_READ = 'payroll_bank_template.read.operational';
const BANK_READ = 'payroll_bank.read.amount';
const BANK_PREPARE = 'payroll_bank.prepare.amount';
const BANK_AUTHORIZE = 'payroll_bank.authorize.amount';
const BANK_FILE = 'payroll_bank.download.bank';
const BANK_OUTCOME = 'payroll_bank.record_outcome.amount';
const LOAN_READ = 'payroll_loan.read.loan';
const LOAN_DECIDE = 'payroll_loan.decide.loan';
const HOLD_READ = 'payroll_hold.read.hold';
const HOLD_DECIDE = 'payroll_hold.decide.hold';
const HOLD_RELEASE = 'payroll_hold.release.hold';
const STOP_READ = 'payroll_stop.read.hold';
const STOP_DECIDE = 'payroll_stop.decide.hold';
const STOP_PROPOSE = 'payroll_stop.propose.hold';
const HOLD_PROPOSE = 'payroll_hold.propose.hold';
const HOLD_DEFINE = 'payroll_hold.define_criterion.hold';
const HOLD_ACTIVATE = 'payroll_hold.activate_criterion.hold';
const INPUT_READ = 'payroll_input.read.amount';
const INPUT_PREPARE = 'payroll_input.prepare.amount';
const INPUT_APPROVE = 'payroll_input.approve.amount';
const TEMPLATE_MANAGE = 'payroll_bank_template.manage.operational';
const TEMPLATE_VALIDATE = 'payroll_bank_template.validate.operational';
const TEMPLATE_ACTIVATE = 'payroll_bank_template.activate.operational';
const REPORT_READ = 'payroll_report.read.amount';
const REPORT_EXPORT = 'payroll_report.export.amount';
const STATUTORY_READ = 'payroll_statutory.read.operational';
const LOAN_REQUEST = 'payroll_loan.request.loan';
const LOAN_DISBURSE = 'payroll_loan.disburse.loan';
const LOAN_RECOVER = 'payroll_loan.recover.loan';
const EMPLOYEE_LIST = 'employee.list.operational';
const DOCUMENT_READ = 'document.read.document';
const CONFIG_MANAGE = 'payroll_config.manage.operational';
const CONFIG_ACTIVATE = 'payroll_config.activate.operational';
const SALARY_READ = 'salary.read.salary';
const SALARY_MANAGE = 'salary.manage.salary';

const U_ME = session.userId;
const U_OTHER = 'b0000000-0000-4000-8000-000000000002';
const E_ME = 'e0000000-0000-4000-8000-000000000001';
const ASSIGNMENT_A = 'a0000000-0000-4000-8000-000000000001';
const ASSIGNMENT_B = 'a0000000-0000-4000-8000-000000000002';
const RUN = '10000000-0000-4000-8000-000000000001';
const NEXT_RUN = '10000000-0000-4000-8000-000000000002';
const PERIOD = '11000000-0000-4000-8000-000000000001';
const CALENDAR = '12000000-0000-4000-8000-000000000001';
const TASK = '30000000-0000-4000-8000-000000000001';
const TASK_2 = '30000000-0000-4000-8000-000000000002';
const BATCH = '40000000-0000-4000-8000-000000000001';
const TEMPLATE = '41000000-0000-4000-8000-000000000001';
const LINE_1 = '50000000-0000-4000-8000-000000000001';
const LINE_2 = '50000000-0000-4000-8000-000000000002';
const LOAN = '60000000-0000-4000-8000-000000000001';
const LOAN_2 = '60000000-0000-4000-8000-000000000002';
const P_CURRENT = '70000000-0000-4000-8000-000000000001';
const P_OLD = '70000000-0000-4000-8000-000000000002';
const X_ATTENDANCE = '80000000-0000-4000-8000-000000000001';

// ---------------------------------------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------------------------------------

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}
type Reply = [number, unknown] | Response;
type Handler = Reply | ((call: Call) => Reply | Promise<Reply>);

let calls: Call[] = [];
const lost = new Set<string>();
const holds = new Map<string, Promise<void>>();

function serve(routes: Record<string, Handler>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname, query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const key = `${call.method} ${call.path}`;
      const held = holds.get(key);
      if (held) await held;
      const route = routes[key];
      const reply: Reply = route === undefined ? [404, { error: 'NOT_FOUND', message: `No mock for ${key}` }] : typeof route === 'function' ? await route(call) : route;
      // The request was acted on; its answer is lost, as when the connection drops on the way back.
      if (lost.delete(key)) throw new TypeError('Failed to fetch');
      if (reply instanceof Response) return reply;
      return new Response(JSON.stringify(reply[1]), { status: reply[0], headers: { 'content-type': 'application/json' } });
    }),
  );
}

/** Holds the answer to a request until released (to see the screen while it is in flight). */
function hold(key: string): () => void {
  let release: () => void = () => undefined;
  holds.set(
    key,
    new Promise<void>((resolve) => {
      release = () => {
        holds.delete(key);
        resolve();
      };
    }),
  );
  return () => release();
}

const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const bodiesTo = (method: string, path: string) => callsTo(method, path).map((c) => c.body as Record<string, unknown>);
const refusal = (status: number, error: string, message = 'Refused', details?: unknown): Reply => [status, { error, message, ...(details ? { details } : {}) }];

/** jsdom has no object URLs: a downloaded file is "saved" through a click on a link to one, counted here. */
function stubDownloads() {
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = vi.fn(() => 'blob:synthetic-payslip');
  URL.revokeObjectURL = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  return {
    click,
    restore: () => {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
      click.mockRestore();
    },
  };
}
const fileReply = (name: string) => () => new Response('{"document":"SYNTHETIC"}', { status: 200, headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${name}"` } });

// ---------------------------------------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------------------------------------

const testClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

function asEmployee() {
  session.roleCode = 'EMPLOYEE';
  session.scopeKind = 'OWN';
  session.employeeId = E_ME;
}

function renderScreen(entry: string, permissions: string[], client = testClient()) {
  session.permissions = permissions;
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          {PAYROLL_SCREENS.map((s) => (
            <Route key={s.path} path={s.path} element={<s.component />} />
          ))}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function panelTree(tabId: string, client: QueryClient) {
  const Panel = PAYROLL_ESS_PANELS.find((p) => p.tabId === tabId)!.component;
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Panel />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
function renderPanel(tabId: string, permissions: string[], client = testClient()) {
  session.permissions = permissions;
  return render(panelTree(tabId, client));
}

function renderQueue(title: string, permissions: string[]) {
  session.permissions = permissions;
  const Queue = PAYROLL_TASK_QUEUES.find((q) => q.title === title)!.component;
  return render(
    <QueryClientProvider client={testClient()}>
      <MemoryRouter>
        <Queue />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((c) => c.textContent?.trim());
const rowWith = (scope: HTMLElement, text: string) => within(scope).getByText(text).closest('tr') as HTMLElement;
const button = (scope: HTMLElement, name: string | RegExp) => within(scope).getByRole('button', { name }) as HTMLButtonElement;
const section = async (heading: string) => (await screen.findByRole('heading', { name: heading })).closest('section') as HTMLElement;
/** Lets any request a click might have started reach the fetch stub before asserting that none was made. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
const SLOW = { timeout: 5000 };

beforeEach(() => {
  session.roleCode = 'HR_ADMINISTRATOR';
  session.scopeKind = 'COMPANY';
  session.employeeId = null;
  session.assignmentId = ASSIGNMENT_A;
  lost.clear();
  holds.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------------------

const OWN_PAYSLIPS = {
  items: [
    {
      id: P_CURRENT,
      periodCode: '2026-09',
      version: 2,
      publicationState: 'ISSUED',
      label: 'CURRENT',
      issuedAt: '2026-10-02T09:00:00.000Z',
      supersededAt: null,
      recordId: 'r1',
      payment: { earned: '48250.5000', held: '5000.0000', reserved: '43250.5000', paid: '0.0000' },
    },
    { id: P_OLD, periodCode: '2026-09', version: 1, publicationState: 'SUPERSEDED', label: 'REPLACED', issuedAt: '2026-10-01T09:00:00.000Z', supersededAt: '2026-10-02T09:00:00.000Z', payment: null },
  ],
  form16: { status: 'NOT_CONFIGURED', code: 'FORM16_TEMPLATE_NOT_CONFIGURED' },
};

const ownLoan = (patch: Record<string, unknown> = {}) => ({
  id: LOAN,
  loanKind: 'LOAN',
  requestOrigin: 'EMPLOYEE',
  currencyCode: 'INR',
  principal: '6000.0000',
  purpose: 'Synthetic household repair',
  state: 'DISBURSED',
  requestedAt: '2026-09-10T09:00:00.000Z',
  decidedAt: '2026-09-12T09:00:00.000Z',
  decisionReason: null,
  disbursementDate: '2026-09-15',
  recovered: '3000.0000',
  outstanding: '3000.0000',
  closedAt: null,
  version: 4,
  installments: [
    { sequence: 1, dueMonth: '2026-10', amount: '3000.0000' },
    { sequence: 2, dueMonth: '2026-11', amount: '3000.0000' },
  ],
  recoveries: [{ id: 'rc1', periodCode: '2026-10', runId: RUN, amount: '3000.0000', recognisedAt: '2026-10-28T09:00:00.000Z' }],
  ...patch,
});

const runDetail = (patch: Record<string, unknown> = {}) => ({
  id: RUN,
  lineageId: RUN,
  revision: 1,
  supersedesRunId: null,
  successorRunId: null,
  state: 'DRAFT',
  calendarCode: 'MONTHLY',
  period: { id: PERIOD, periodCode: '2026-10', financialYear: '2026-27', serviceStart: '2026-10-01', serviceEnd: '2026-10-31', inputCutoff: '2026-10-25', paymentDate: '2026-10-31', daysInMonth: 31 },
  currencyCode: 'INR',
  currencyMinorUnit: 2,
  members: { included: 2, excluded: 0 },
  progress: {
    calculation: { started: false, members: 2, calculated: 0, chunks: 0, complete: false },
    processing: { started: false, records: 0, frozen: 0, chunks: 0, complete: false },
  },
  records: {},
  exceptions: { blocking: 0, unresolved: 0, warnings: 0 },
  createdBy: U_OTHER,
  preparedBy: null,
  submittedAt: null,
  reviewedBy: null,
  reviewedAt: null,
  approvedBy: null,
  approvedAt: null,
  approvalStage: null,
  covers: [],
  processingStartedAt: null,
  processedAt: null,
  processedBy: null,
  lockVersion: null,
  closedAt: null,
  paymentStatus: 'NOT_TRACKED_HERE',
  decisions: [],
  createdAt: '2026-10-20T08:00:00.000Z',
  version: 3,
  ...patch,
});
const CALCULATED = { state: 'CALCULATED', preparedBy: U_OTHER, progress: { calculation: { started: true, members: 2, calculated: 2, chunks: 1, complete: true }, processing: { started: false, records: 2, frozen: 0, chunks: 0, complete: false } } };
const TOTALS = [
  { currencyCode: 'INR', records: 2, paidUnits: '62.0000', earnings: '95000.0000', reimbursements: '0', gross: '95000.0000', deductions: '7200.0000', net: '87800.0000', employerContributions: '3600.0000' },
];
const RUN_PATH = `/v1/payroll/runs/${RUN}`;

const BATCH_PATH = `/v1/payroll-outputs/bank-manifests/${BATCH}`;
const manifest = (patch: Record<string, unknown> = {}) => ({
  id: BATCH,
  runId: RUN,
  templateId: TEMPLATE,
  templateCode: 'SYN_BANK',
  templateVersion: 1,
  testOnly: true,
  batchRevision: 1,
  supersedesBatchId: null,
  currencyCode: 'INR',
  paymentDate: '2026-10-31',
  state: 'VALIDATED',
  lineCount: 2,
  totalAmount: '87800.0000',
  manifestHash: 'f'.repeat(64),
  excluded: { held: 0, reservedOrPaid: 0, nothingPayable: 0, excludedByPreparer: 0, excludedEmployeeIds: [], excludedEmployeeCodes: [] },
  preparedBy: U_OTHER,
  preparedAt: '2026-10-28T09:00:00.000Z',
  authorizedBy: null,
  authorizedAt: null,
  contentHash: null,
  fileName: null,
  issuedBy: null,
  issuedAt: null,
  cancelledAt: null,
  version: 2,
  ledger: [{ paymentState: 'RESERVED', lines: 2, amount: '87800.0000', netConfirmed: '0' }],
  paymentStatusSource: 'RECORDED_OUTCOME_EVIDENCE_ONLY',
  ...patch,
});
const bankLine = (id: string, seq: number, patch: Record<string, unknown> = {}) => ({
  id,
  lineSequence: seq,
  allocationKey: `PAY-r${seq}-1`,
  recordId: `r${seq}`,
  employeeId: `e${seq}`,
  employeeCode: `SYN-00${seq}`,
  holdId: null,
  bankRevisionId: `b${seq}`,
  amount: '43900.0000',
  currencyCode: 'INR',
  paymentState: 'RESERVED',
  confirmedAmount: '0.0000',
  reversedAmount: '0.0000',
  ...patch,
});

const hrLoan = (id: string, patch: Record<string, unknown> = {}) => ({
  ...ownLoan({ state: 'REQUESTED', decidedAt: null, disbursementDate: null, recovered: '0.0000', outstanding: '6000.0000', installments: undefined, recoveries: undefined, version: 1 }),
  id,
  employeeId: 'e2',
  employeeCode: 'SYN-002',
  recoveryHead: null,
  disbursementReference: null,
  closeReason: null,
  requestedBy: U_OTHER,
  decidedBy: null,
  disbursedBy: null,
  ...patch,
});

// =========================================================================================================
// My ESS TN06
// =========================================================================================================

describe('TN06 own issued payslips', () => {
  it('shows earned, held, reserved and paid apart as returned, marks a superseded version and says publication is not payment', async () => {
    asEmployee();
    serve({ 'GET /v1/me/payslips': [200, OWN_PAYSLIPS], 'GET /v1/me/payroll-holds': [200, { items: [], total: 0 }] });
    renderPanel('TN06', [OWN_PAYSLIP]);
    const table = await screen.findByRole('table', { name: 'My payslips' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(cells(rows[0]!)).toEqual(['2026-09', '2', 'Current version', '2 Oct 2026', '48,250.50', '5,000.00', '43,250.50', '0.00', 'View Download']);
    expect(cells(rows[1]!)).toEqual(['2026-09', '1', 'Replaced by a later version on 2 Oct 2026', '1 Oct 2026', 'See the current version', 'View Download']);
    expect(screen.getByRole('note').textContent).toContain('Publication of a payslip does not mean the salary has been paid.');
    expect(document.body.textContent).toContain('Form 16 is not available: no statutory Form 16 template is configured yet.');
    expect(table.textContent).not.toMatch(/\bpaid\b(?! \(confirmed\))/i);
  });

  it('downloads the chosen version through the own file route', async () => {
    asEmployee();
    serve({ 'GET /v1/me/payslips': [200, OWN_PAYSLIPS], [`GET /v1/me/payslips/${P_OLD}/file`]: fileReply('payslip-2026-09-SYN-001-v1.json') });
    const files = stubDownloads();
    try {
      renderPanel('TN06', [OWN_PAYSLIP]);
      fireEvent.click(await screen.findByRole('button', { name: 'Download payslip 2026-09 version 1' }));
      await waitFor(() => expect(files.click).toHaveBeenCalledTimes(1));
      expect(callsTo('GET', `/v1/me/payslips/${P_OLD}/file`)).toHaveLength(1);
    } finally {
      files.restore();
    }
  });

  it('views a payslip in place: lines by kind, totals, and how each statutory amount was worked out, from the issued file', async () => {
    asEmployee();
    const doc = {
      document: 'PAYSLIP',
      period: { code: '2026-09', serviceStart: '2026-09-01', serviceEnd: '2026-09-30', paymentDate: '2026-09-30' },
      version: 1,
      currencyCode: 'INR',
      paidDays: '30.0000',
      daysInMonth: 30,
      lines: [
        { componentCode: 'BASIC', componentName: 'Basic', headType: 'EARNING', amount: '200000.0000' },
        { componentCode: 'PF_EE', componentName: 'Provident fund', headType: 'DEDUCTION', amount: '1800.0000' },
        { componentCode: 'TDS', componentName: 'Income tax', headType: 'DEDUCTION', amount: '24375.0000' },
        { componentCode: 'PF_EPS', componentName: 'Pension (employer)', headType: 'EMPLOYER_CONTRIBUTION', amount: '1250.0000' },
      ],
      statutory: [
        { componentCode: 'ESI_EE', componentName: 'ESIC', status: 'NOT_APPLICABLE', amount: null, workings: { reason: 'NOT_COVERED', esicWages: '200000.0000' } },
        { componentCode: 'PF_EE', componentName: 'Provident fund', status: 'VALUED', amount: '1800.0000', workings: { output: 'EMPLOYEE', pfWages: '200000.0000', contributionWages: '15000.00', option: 'STATUTORY_CEILING', ratePercent: '12' } },
        {
          componentCode: 'TDS',
          componentName: 'Income tax',
          status: 'VALUED',
          amount: '24375.0000',
          workings: { output: 'TDS', regime: 'NEW', projectedAnnualSalary: '2400000.00', taxableIncome: '2325000.00', annualTax: '292500.00', tdsEarlier: '0.00', monthsLeft: 12 },
        },
      ],
      totals: { earnings: '200000.0000', reimbursements: '0.0000', gross: '200000.0000', deductions: '26175.0000', net: '173825.0000', employerContributions: '1250.0000' },
      paymentAtPublication: { earned: '173825.0000', held: '0.0000', reserved: '0.0000', paid: '0.0000' },
      notices: ['Publication of this payslip does not imply payment or statutory filing.'],
    };
    serve({ 'GET /v1/me/payslips': [200, OWN_PAYSLIPS], 'GET /v1/me/payroll-holds': [200, { items: [], total: 0 }], [`GET /v1/me/payslips/${P_OLD}/file`]: [200, doc] });
    renderPanel('TN06', [OWN_PAYSLIP]);
    fireEvent.click(await screen.findByRole('button', { name: 'View payslip 2026-09 version 1' }));
    const deductions = await screen.findByRole('table', { name: 'Deductions' });
    expect(deductions.textContent).toContain('Income tax');
    expect(screen.getByRole('table', { name: 'Paid by the employer (not part of your pay)' }).textContent).toContain('Pension (employer)');
    expect(screen.getByLabelText('Payslip totals').textContent).toContain('Net pay');
    const statutory = screen.getByRole('table', { name: 'How statutory amounts were worked out' });
    expect(cells(rowWith(statutory, 'ESIC'))[2]).toBe('Not covered: your wages are above the ESIC ceiling');
    expect(cells(rowWith(statutory, 'Provident fund'))[2]).toContain('12% of');
    expect(cells(rowWith(statutory, 'Income tax'))[2]).toContain('the rest spread over 12 month(s)');
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('table', { name: 'Deductions' })).toBeNull();
  });

  it('says how professional tax, the labour welfare fund and the pension share were worked out, from the recorded workings only', () => {
    const note = (status: string, workings: Record<string, unknown>) => statutoryNote({ componentCode: 'X', componentName: 'X', status, amount: status === 'VALUED' ? '1.0000' : null, workings }, 'INR');
    expect(note('VALUED', { gross: '14000.0000', stateCode: 'MH', slab: 3, month: 10 })).toBe('Professional tax, MH, slab 3 for a monthly gross of INR 14,000.00');
    expect(note('VALUED', { wages: '20000.0000', stateCode: 'MH', slab: 2, month: 6, contributionMonths: [6, 12] })).toBe('Labour welfare fund, MH, slab 2');
    expect(note('NOT_APPLICABLE', { reason: 'NOT_A_CONTRIBUTION_MONTH', contributionMonths: [6, 12] })).toBe('Not due this month');
    expect(note('VALUED', { output: 'EPS', pfWages: '25000.0000', pensionWages: '15000.00', ratePercent: '8.33' })).toBe('8.33% of INR 15,000.00 (pension)');
    expect(note('VALUED', { output: 'EMPLOYEE', pfWages: '25000.0000', contributionWages: '25000.0000', option: 'HIGHER_WAGES', ratePercent: '12' })).toBe(
      '12% of INR 25,000.00 (your option to contribute on higher wages)',
    );
    // The old regime's HRA exemption, when there is one, is named with the projection.
    expect(
      note('VALUED', { output: 'TDS', regime: 'OLD', projectedAnnualSalary: '1800000.00', hraExemption: '480000.00', taxableIncome: '1270000.00', annualTax: '201240.00', tdsEarlier: '0.00', monthsLeft: 12 }),
    ).toBe(
      'Old regime: projected salary for the year INR 18,00,000.00, less INR 4,80,000.00 of house rent allowance exempt, taxable income INR 12,70,000.00, tax for the year INR 2,01,240.00; INR 0.00 deducted earlier this year, the rest spread over 12 month(s)',
    );
  });

  it('shows the status of the employee’s own held salary: period, state and dates, never a reason or amount (H7)', async () => {
    asEmployee();
    const hold = (id: string, periodCode: string, state: string, heldFrom: string, releasedAt: string | null) => ({ id, periodCode, serviceStart: `${periodCode}-01`, serviceEnd: `${periodCode}-28`, state, heldFrom, releasedAt });
    serve({
      'GET /v1/me/payslips': [200, OWN_PAYSLIPS],
      'GET /v1/me/payroll-holds': [200, { items: [hold('h1', '2026-09', 'ON_HOLD', '2026-09-30', null), hold('h2', '2026-08', 'RELEASED', '2026-08-31', '2026-09-05T09:00:00.000Z')], total: 2, page: 1, pageSize: 25 }],
    });
    renderPanel('TN06', [OWN_PAYSLIP]);
    const table = await screen.findByRole('table', { name: 'My salary payment holds' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(cells(rows[0]!)).toEqual(['2026-09', 'On hold', '30 Sep 2026', '—']);
    expect(cells(rows[1]!)).toEqual(['2026-08', 'Released for payment', '31 Aug 2026', '5 Sep 2026']);
    expect(callsTo('GET', '/v1/me/payroll-holds')[0]?.query.toString()).toBe('page=1&pageSize=25');
    expect(table.textContent).not.toMatch(/reason|INR|bank/i);
    // Everything fits on one page: no pager.
    expect(screen.queryByRole('navigation', { name: 'Salary hold pages' })).toBeNull();
  });

  it('says when no payment of the employee’s salary is or was on hold', async () => {
    asEmployee();
    serve({ 'GET /v1/me/payslips': [200, OWN_PAYSLIPS], 'GET /v1/me/payroll-holds': [200, { items: [], total: 0, page: 1, pageSize: 25 }] });
    renderPanel('TN06', [OWN_PAYSLIP]);
    expect(await screen.findByText('No payment of your salary is or was on hold.')).toBeTruthy();
  });

  it('is shown only in the Employee OWN context with its key', async () => {
    serve({ 'GET /v1/me/payslips': [200, OWN_PAYSLIPS] });
    renderPanel('TN06', [OWN_PAYSLIP]);
    expect(screen.getByText('Your own payslips are shown in your Employee role. Switch to it to see them.')).toBeTruthy();
    cleanup();
    asEmployee();
    renderPanel('TN06', []);
    expect(screen.getByText('Your Employee role does not include payslips; contact HR.')).toBeTruthy();
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('never shows one role assignment’s payslips under another', async () => {
    asEmployee();
    let answer: Reply = [200, OWN_PAYSLIPS];
    serve({ 'GET /v1/me/payslips': () => answer });
    const client = testClient();
    const view = renderPanel('TN06', [OWN_PAYSLIP], client);
    await screen.findByText('48,250.50');
    answer = refusal(403, 'EMPLOYEE_CONTEXT_REQUIRED');
    session.assignmentId = ASSIGNMENT_B;
    view.rerender(panelTree('TN06', client));
    expect(screen.queryByText('48,250.50')).toBeNull();
    expect(await screen.findByText('Select your Employee role to see your own payroll documents.')).toBeTruthy();
  });
});

// =========================================================================================================
// My ESS TN15
// =========================================================================================================

describe('TN15 own loans and advances', () => {
  const LOANS = { items: [ownLoan()], interest: { status: 'NOT_CONFIGURED' }, earlySettlement: { status: 'NOT_CONFIGURED' } };

  it('shows what processed payroll deducted and is not yet recognised, as the balance already counts it (FR-034)', async () => {
    asEmployee();
    serve({ 'GET /v1/me/loans': [200, { ...LOANS, items: [ownLoan({ recovered: '0.0000', awaitingRecognition: '3000.0000', outstanding: '3000.0000' })] }] });
    renderPanel('TN15', [OWN_LOAN_READ]);
    const item = await screen.findByRole('listitem', { name: 'Loan requested 10 Sep 2026' });
    expect(item.textContent).toContain('Deducted, not yet recognisedINR 3,000.00');
    expect(item.textContent).toContain('Outstanding balanceINR 3,000.00');
  });

  it('lists own loans with the schedule, recoveries and balance as returned', async () => {
    asEmployee();
    serve({ 'GET /v1/me/loans': [200, LOANS] });
    renderPanel('TN15', [OWN_LOAN_READ]);
    const item = await screen.findByRole('listitem', { name: 'Loan requested 10 Sep 2026' });
    expect(item.textContent).toContain('Disbursed, being recovered');
    expect(item.textContent).toContain('RecoveredINR 3,000.00');
    expect(item.textContent).toContain('Outstanding balanceINR 3,000.00');
    // Nothing processed is waiting to be recognised, so that figure stays out of the way.
    expect(item.textContent).not.toContain('Deducted, not yet recognised');
    const schedule = within(item).getByRole('table', { name: 'Recovery schedule of Loan requested 10 Sep 2026' });
    expect(cells(within(schedule).getAllByRole('row')[2]!)).toEqual(['2', '2026-11', 'INR 3,000.00']);
    expect(cells(within(within(item).getByRole('table', { name: 'Recoveries of Loan requested 10 Sep 2026' })).getAllByRole('row')[1]!)).toEqual(['2026-10', 'INR 3,000.00', '28 Oct 2026']);
    expect(document.body.textContent).toContain('Loans carry no interest: no approved interest rate is configured.');
    // Without the request key there is neither a request form nor a withdrawal.
    expect(screen.queryByRole('form', { name: 'Request a loan or advance' })).toBeNull();
  });

  it('sends a request with an idempotency key that is reused only after a lost answer, and resets the form after success', async () => {
    asEmployee();
    serve({ 'GET /v1/me/loans': [200, { items: [] }], 'POST /v1/me/loans': [201, { ...ownLoan({ state: 'REQUESTED' }), replayed: false }] });
    renderPanel('TN15', [OWN_LOAN_READ, OWN_LOAN_REQUEST]);
    const form = await screen.findByRole('form', { name: 'Request a loan or advance' });
    const purpose = within(form).getByLabelText('Purpose');
    fireEvent.change(within(form).getByLabelText('Kind'), { target: { value: 'ADVANCE' } });
    fireEvent.change(within(form).getByLabelText('Currency (three-letter code)'), { target: { value: 'inr' } });
    fireEvent.change(within(form).getByLabelText('Amount'), { target: { value: '6000.00' } });
    fireEvent.change(purpose, { target: { value: 'Synthetic school fees' } });
    lost.add('POST /v1/me/loans');
    fireEvent.click(button(form, 'Send the request'));
    expect(await screen.findByText(/No answer came back, so it may or may not have been recorded/)).toBeTruthy();
    expect((within(form).getByLabelText('Amount') as HTMLInputElement).value).toBe('6000.00');
    const release = hold('POST /v1/me/loans');
    fireEvent.click(button(form, 'Send the request'));
    await waitFor(() => expect(button(form, 'Sending…').disabled).toBe(true));
    release();
    expect(await screen.findByText('Your request was sent for an independent decision.')).toBeTruthy();
    const [first, second] = bodiesTo('POST', '/v1/me/loans');
    expect(first).toEqual({ loanKind: 'ADVANCE', currencyCode: 'INR', principal: '6000.00', purpose: 'Synthetic school fees', idempotencyKey: expect.stringMatching(/^own-loan-[0-9a-f-]{36}$/) });
    expect(second).toEqual(first);
    expect((within(form).getByLabelText('Amount') as HTMLInputElement).value).toBe('');
    expect((within(form).getByLabelText('Kind') as HTMLSelectElement).value).toBe('LOAN');
    // A new request after a definite answer carries a new key.
    fireEvent.change(within(form).getByLabelText('Currency (three-letter code)'), { target: { value: 'INR' } });
    fireEvent.change(within(form).getByLabelText('Amount'), { target: { value: '6000.00' } });
    fireEvent.change(purpose, { target: { value: 'Synthetic school fees' } });
    fireEvent.change(within(form).getByLabelText('Kind'), { target: { value: 'ADVANCE' } });
    fireEvent.click(button(form, 'Send the request'));
    await waitFor(() => expect(bodiesTo('POST', '/v1/me/loans')).toHaveLength(3));
    expect(bodiesTo('POST', '/v1/me/loans')[2]!.idempotencyKey).not.toBe(first!.idempotencyKey);
  });

  it('explains a refusal in plain words and keeps what was typed', async () => {
    asEmployee();
    serve({ 'GET /v1/me/loans': [200, { items: [] }], 'POST /v1/me/loans': refusal(422, 'CURRENCY_NOT_CONFIGURED') });
    renderPanel('TN15', [OWN_LOAN_READ, OWN_LOAN_REQUEST]);
    const form = await screen.findByRole('form', { name: 'Request a loan or advance' });
    fireEvent.change(within(form).getByLabelText('Currency (three-letter code)'), { target: { value: 'USD' } });
    fireEvent.change(within(form).getByLabelText('Amount'), { target: { value: '500' } });
    fireEvent.change(within(form).getByLabelText('Purpose'), { target: { value: 'Synthetic travel' } });
    fireEvent.click(button(form, 'Send the request'));
    expect(await screen.findByText('No active payroll calendar pays in this currency.')).toBeTruthy();
    expect((within(form).getByLabelText('Currency (three-letter code)') as HTMLInputElement).value).toBe('USD');
    // Client-side checks stop an incomplete request before anything is sent.
    fireEvent.change(within(form).getByLabelText('Amount'), { target: { value: '12,000' } });
    fireEvent.click(button(form, 'Send the request'));
    expect(await screen.findByText('Enter the amount as a positive number, for example 25000.00.')).toBeTruthy();
    expect(callsTo('POST', '/v1/me/loans')).toHaveLength(1);
  });

  it('withdraws an undecided own request with its version, and offers no withdrawal for decided or HR-entered loans', async () => {
    asEmployee();
    const requested = ownLoan({ id: LOAN, state: 'REQUESTED', requestedAt: '2026-10-20T09:00:00.000Z', decidedAt: null, disbursementDate: null, installments: [], recoveries: [], version: 1 });
    const byHr = ownLoan({ id: LOAN_2, state: 'REQUESTED', requestOrigin: 'ADMIN', loanKind: 'ADVANCE', requestedAt: '2026-10-21T09:00:00.000Z', installments: [], recoveries: [], version: 1 });
    serve({
      'GET /v1/me/loans': [200, { items: [requested, byHr, ownLoan({ id: 'l3', requestedAt: '2026-08-01T09:00:00.000Z' })] }],
      [`POST /v1/me/loans/${LOAN}/withdraw`]: [200, { ...requested, state: 'WITHDRAWN' }],
    });
    renderPanel('TN15', [OWN_LOAN_READ, OWN_LOAN_REQUEST]);
    const mine = await screen.findByRole('listitem', { name: 'Loan requested 20 Oct 2026' });
    expect(within(screen.getByRole('listitem', { name: 'Salary advance requested 21 Oct 2026' })).queryByRole('button', { name: 'Withdraw the request' })).toBeNull();
    expect(within(screen.getByRole('listitem', { name: 'Loan requested 1 Aug 2026' })).queryByRole('button', { name: 'Withdraw the request' })).toBeNull();
    fireEvent.click(button(mine, 'Withdraw the request'));
    expect(await within(mine).findByText('Give a reason first.')).toBeTruthy();
    fireEvent.change(within(mine).getByLabelText('Reason for withdrawing'), { target: { value: 'No longer needed' } });
    fireEvent.click(button(mine, 'Withdraw the request'));
    expect(await screen.findByText('Your request was withdrawn.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/me/loans/${LOAN}/withdraw`)).toEqual([{ reason: 'No longer needed', expectedVersion: 1 }]);
  });
});

// =========================================================================================================
// Payroll runs
// =========================================================================================================

describe('payroll runs', () => {
  it('lists runs with their state, and hides them without a run read key', async () => {
    serve({
      'GET /v1/payroll/runs': [
        200,
        { items: [{ id: RUN, lineageId: RUN, revision: 2, state: 'IN_REVIEW', periodCode: '2026-10', financialYear: 'FY2026', periodId: PERIOD, calendarCode: 'MONTHLY', memberCount: 12, unresolvedExceptions: 1, createdAt: '2026-10-20T08:00:00.000Z', processedAt: null, version: 4 }] },
      ],
    });
    renderScreen('/payroll/runs', [RUN_STATUS]);
    const table = await screen.findByRole('table', { name: 'Payroll runs' });
    expect(cells(rowWith(table, '2026-10 revision 2'))).toEqual(['2026-10 revision 2', 'FY2026', 'MONTHLY', '2', 'In review', '12', '1', '20 Oct 2026', '—']);
    // Starting a run needs the prepare duty.
    expect(screen.queryByRole('heading', { name: 'Start a payroll run' })).toBeNull();
    cleanup();
    renderScreen('/payroll/runs', []);
    expect(screen.getByText('The selected role cannot see payroll runs.')).toBeTruthy();
  });

  it('pages the payroll runs with the total of every revision in scope, from the first page again on a new state filter (FR-056)', async () => {
    const runRow = (n: number) => ({
      id: `10000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}`,
      lineageId: RUN,
      revision: 1,
      state: 'DRAFT',
      periodCode: `2026-P${n}`,
      financialYear: 'FY2026',
      periodId: PERIOD,
      calendarCode: 'MONTHLY',
      memberCount: 1,
      unresolvedExceptions: 0,
      createdAt: '2026-10-20T08:00:00.000Z',
      processedAt: null,
      version: 1,
    });
    serve({
      'GET /v1/payroll/runs': (c) => [
        200,
        c.query.get('page') === '2' ? { items: [runRow(26)], total: 26, page: 2, pageSize: 25 } : { items: Array.from({ length: 25 }, (_, i) => runRow(i + 1)), total: 26, page: 1, pageSize: 25 },
      ],
    });
    renderScreen('/payroll/runs', [RUN_STATUS]);
    const table = await screen.findByRole('table', { name: 'Payroll runs' });
    expect(within(table).getAllByRole('row')).toHaveLength(26);
    expect(callsTo('GET', '/v1/payroll/runs')[0]?.query.toString()).toBe('page=1&pageSize=25');
    const pager = screen.getByRole('navigation', { name: 'Payroll run pages' });
    expect(pager.textContent).toContain('Page 1 of 2 · 26 run revisions');
    fireEvent.click(within(pager).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Payroll runs' })).getAllByRole('row')).toHaveLength(2));
    expect(callsTo('GET', '/v1/payroll/runs').at(-1)?.query.toString()).toBe('page=2&pageSize=25');
    expect(screen.getByRole('navigation', { name: 'Payroll run pages' }).textContent).toContain('Page 2 of 2 · 26 run revisions');
    // A state filter starts from the first page again and is kept while paging.
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'DRAFT' } });
    await waitFor(() => expect(callsTo('GET', '/v1/payroll/runs').at(-1)?.query.toString()).toBe('state=DRAFT&page=1&pageSize=25'));
    fireEvent.click(within(await screen.findByRole('navigation', { name: 'Payroll run pages' })).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(callsTo('GET', '/v1/payroll/runs').at(-1)?.query.toString()).toBe('state=DRAFT&page=2&pageSize=25'));
  });

  it('BR-012: filters the runs by the financial year their calendar gives the period, kept with the state filter and from the first page', async () => {
    serve({ 'GET /v1/payroll/runs': [200, { items: [], total: 0, page: 1, pageSize: 25 }] });
    renderScreen('/payroll/runs', [RUN_STATUS]);
    await waitFor(() => expect(callsTo('GET', '/v1/payroll/runs')).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'APPROVED' } });
    fireEvent.change(screen.getByLabelText('Financial year'), { target: { value: 'fy2026' } });
    await waitFor(() => expect(callsTo('GET', '/v1/payroll/runs').at(-1)?.query.toString()).toBe('state=APPROVED&financialYear=FY2026&page=1&pageSize=25'));
    expect(await screen.findByText('No payroll runs match these filters.')).toBeTruthy();
    // Something that cannot be a label is never sent; the screen says what a label looks like.
    fireEvent.change(screen.getByLabelText('Financial year'), { target: { value: 'FY 2026' } });
    expect(await screen.findByText(/A financial year is the label its calendar gives it/)).toBeTruthy();
    expect([...new Set(callsTo('GET', '/v1/payroll/runs').map((c) => c.query.get('financialYear')).filter(Boolean))]).toEqual(['FY2026']);
  });

  it('starts a run from a previewed scope and opens it', async () => {
    serve({
      'GET /v1/payroll/runs': [200, { items: [] }],
      'GET /v1/payroll/calendars': [
        200,
        {
          items: [
            { id: CALENDAR, code: 'MONTHLY', name: 'Monthly payroll', currencyCode: 'INR', state: 'ACTIVE', periods: [{ id: PERIOD, periodCode: '2026-10', serviceStart: '2026-10-01', serviceEnd: '2026-10-31', paymentDate: '2026-10-31' }] },
            { id: 'k2', code: 'DRAFTCAL', name: 'Draft calendar', currencyCode: 'INR', state: 'DRAFT', periods: [] },
          ],
        },
      ],
      'POST /v1/payroll/runs/preview': [
        200,
        {
          periodId: PERIOD,
          periodCode: '2026-10',
          memberCount: 2,
          members: [
            { employeeId: 'e1', employeeCode: 'SYN-001', displayName: 'Asha Synthetic' },
            { employeeId: 'e2', employeeCode: 'SYN-002', displayName: 'Ravi Synthetic' },
          ],
          membersTruncated: false,
          notIncludedCount: 1,
          notIncludedByReason: { ALREADY_IN_RUN: 1 },
          notIncluded: [],
          scopeToken: 'a'.repeat(64),
        },
      ],
      'POST /v1/payroll/runs': [201, runDetail()],
      [`GET ${RUN_PATH}`]: [200, runDetail()],
    });
    renderScreen('/payroll/runs', [RUN_STATUS, RUN_PREPARE, CONFIG_READ]);
    const form = await screen.findByRole('form', { name: 'Preview a payroll run' });
    const calendar = within(form).getByLabelText('Payroll calendar') as HTMLSelectElement;
    await waitFor(() => expect(calendar.options).toHaveLength(2));
    expect(calendar.textContent).not.toContain('DRAFTCAL');
    fireEvent.change(calendar, { target: { value: CALENDAR } });
    fireEvent.change(within(form).getByLabelText('Period'), { target: { value: PERIOD } });
    fireEvent.click(button(form, 'Preview the members'));
    const preview = await screen.findByRole('region', { name: 'Run scope preview' });
    expect(preview.textContent).toContain('2 members included; 1 not included.');
    expect(preview.textContent).toContain('Already in run: 1');
    fireEvent.click(button(preview, 'Create the run for this scope'));
    expect(await screen.findByRole('heading', { name: 'Payroll run 2026-10 · revision 1' })).toBeTruthy();
    expect(bodiesTo('POST', '/v1/payroll/runs/preview')).toEqual([{ periodId: PERIOD }]);
    expect(bodiesTo('POST', '/v1/payroll/runs')).toEqual([{ periodId: PERIOD, scopeToken: 'a'.repeat(64) }]);
  });

  it('shows totals, members, exceptions and the prior-period comparison only as returned to an amount reader', async () => {
    serve({
      [`GET ${RUN_PATH}`]: [200, runDetail({ ...CALCULATED, totals: TOTALS, scopeComplete: true, exceptions: { blocking: 1, unresolved: 1, warnings: 0 } })],
      [`GET ${RUN_PATH}/records`]: [
        200,
        {
          items: [
            {
              id: 'r1',
              employeeId: 'e1',
              employeeCode: 'SYN-001',
              employeeName: 'Asha Synthetic',
              calculationStatus: 'CALCULATED',
              paidUnits: '31.0000',
              currencyCode: 'INR',
              gross: '50000.0000',
              deductions: '4000.0000',
              net: '46000.0000',
              priorNet: '45000.0000',
              salaryStopMode: null,
              bankStatus: 'VERIFIED',
              exceptions: [{ id: X_ATTENDANCE, code: 'ATTENDANCE_NOT_VALUED', severity: 'BLOCKING', resolvable: true, detail: { absentDays: 1 }, resolvedAt: null, resolvedBy: null }],
            },
          ],
          nextAfter: null,
        },
      ],
      [`GET ${RUN_PATH}/components`]: [200, { runId: RUN, basis: 'RUN', priorPeriodCode: '2026-09', priorRunIds: ['p'], items: [{ componentCode: 'BASIC', headType: 'EARNING', current: '60000.0000', prior: '58000.0000', difference: '2000.0000' }] }],
    });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, RUN_AMOUNT]);
    const totals = await screen.findByRole('table', { name: 'Run totals' });
    expect(cells(within(totals).getAllByRole('row')[1]!)).toEqual(['INR', '2', '62.0000', 'INR 95,000.00', 'INR 0.00', 'INR 95,000.00', 'INR 7,200.00', 'INR 87,800.00', 'INR 3,600.00']);
    const members = await screen.findByRole('table', { name: 'Run members' });
    const row = cells(rowWith(members, 'SYN-001 Asha Synthetic'));
    expect(row.slice(0, 9)).toEqual(['SYN-001 Asha Synthetic', 'Calculated', '31.0000', 'INR 50,000.00', 'INR 4,000.00', 'INR 46,000.00', 'INR 45,000.00', '—', 'Verified']);
    expect(row[9]).toContain('Attendance not valued (blocking, unresolved)');
    // Resolving needs the approval duty.
    expect(within(members).queryByRole('button', { name: /Resolve/ })).toBeNull();
    const components = await screen.findByRole('table', { name: 'Component totals' });
    expect(within(components).getAllByRole('columnheader').map((h) => h.textContent)).toContain('Prior period (2026-09)');
    expect(cells(within(components).getAllByRole('row')[1]!)).toEqual(['BASIC', 'Earning', 'INR 60,000.00', 'INR 58,000.00', 'INR 2,000.00']);
  });

  it('opens a member’s record: paid days, lines by kind, inputs and how each statutory head was valued, as returned', async () => {
    const member = {
      id: 'r1',
      employeeId: 'e1',
      employeeCode: 'SYN-001',
      employeeName: 'Asha Synthetic',
      calculationStatus: 'CALCULATED',
      paidUnits: '31.0000',
      currencyCode: 'INR',
      gross: '200000.0000',
      deductions: '26175.0000',
      net: '173825.0000',
      priorNet: null,
      salaryStopMode: null,
      bankStatus: 'VERIFIED',
      exceptions: [],
    };
    serve({
      [`GET ${RUN_PATH}`]: [200, runDetail({ ...CALCULATED, totals: TOTALS, scopeComplete: true })],
      [`GET ${RUN_PATH}/records`]: [200, { items: [member], nextAfter: null }],
      [`GET ${RUN_PATH}/components`]: [200, { runId: RUN, basis: 'RUN', priorPeriodCode: null, priorRunIds: [], items: [] }],
      [`GET ${RUN_PATH}/records/e1`]: [
        200,
        {
          calculationStatus: 'CALCULATED',
          currencyCode: 'INR',
          segments: [{ segmentStart: '2026-10-01', segmentEnd: '2026-10-31', calendarDays: 31, leaveLopUnits: '0.0000', attendanceLopUnits: '0.0000', paidDays: '31.0000' }],
          inputs: [{ inputId: 'i1', componentCode: 'BONUS', amount: '5000.0000', reference: 'SYN-INPUT-1' }],
          lines: [
            { componentCode: 'BASIC', componentName: 'Basic', headType: 'EARNING', calculationBasis: 'FIXED', amount: '200000.0000' },
            { componentCode: 'TDS', componentName: 'Income tax', headType: 'DEDUCTION', calculationBasis: 'RULE_PACK', amount: '24375.0000' },
          ],
          statutory: [
            {
              componentCode: 'TDS',
              rulePackCode: 'TDS',
              headType: 'DEDUCTION',
              status: 'VALUED',
              amount: '24375.0000',
              workings: { packCode: 'INCOME_TAX', packRevision: 1, output: 'TDS', regime: 'NEW', projectedAnnualSalary: '2400000.00', taxableIncome: '2325000.00', annualTax: '292500.00', tdsEarlier: '0.00', monthsLeft: 12 },
            },
          ],
        },
      ],
    });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, RUN_AMOUNT]);
    const members = await screen.findByRole('table', { name: 'Run members' });
    // The employee cell reads as before; it opens the record.
    expect(cells(rowWith(members, 'SYN-001 Asha Synthetic'))[0]).toBe('SYN-001 Asha Synthetic');
    fireEvent.click(within(members).getByRole('button', { name: 'Details of SYN-001' }));
    const lines = await screen.findByRole('table', { name: 'Record lines' });
    expect(cells(rowWith(lines, 'Income tax'))).toEqual(['Income tax', 'Deduction', 'Rule pack', 'INR 24,375.00']);
    expect(cells(rowWith(screen.getByRole('table', { name: 'Paid days' }), '31.0000'))).toEqual(['1 Oct 2026', '31 Oct 2026', '31', '0.0000', '0.0000', '31.0000']);
    expect(cells(rowWith(screen.getByRole('table', { name: 'Approved inputs' }), 'SYN-INPUT-1'))).toEqual(['BONUS', 'SYN-INPUT-1', 'INR 5,000.00']);
    const statutory = cells(rowWith(screen.getByRole('table', { name: 'Statutory workings' }), 'Income tax'));
    expect(statutory.slice(0, 3)).toEqual(['Income tax', 'INCOME_TAX revision 1', 'INR 24,375.00']);
    expect(statutory[3]).toContain('tax for the year INR 2,92,500.00');
    expect(callsTo('GET', `${RUN_PATH}/records/e1`)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('table', { name: 'Record lines' })).toBeNull();
  });

  it('shows a status-only reader no amounts and asks for none', async () => {
    serve({ [`GET ${RUN_PATH}`]: [200, runDetail(CALCULATED)] });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS]);
    await screen.findByRole('heading', { name: 'Payroll run 2026-10 · revision 1' });
    await settle();
    expect(screen.queryByRole('table', { name: 'Run totals' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Members and exceptions' })).toBeNull();
    expect(calls.map((c) => c.path)).toEqual([RUN_PATH]);
    expect(screen.getByText('No action on this revision is available to the selected role.')).toBeTruthy();
  });

  it('calculates a draft with its version, disables the action while in flight and reports progress', async () => {
    let detail = runDetail();
    serve({
      [`GET ${RUN_PATH}`]: () => [200, detail],
      [`POST ${RUN_PATH}/calculate`]: () => {
        detail = runDetail({ version: 4, preparedBy: U_ME, progress: { ...runDetail().progress, calculation: { started: true, members: 2, calculated: 1, chunks: 1, complete: false } } });
        return [202, detail];
      },
    });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, RUN_PREPARE]);
    const calculate = (await screen.findByRole('button', { name: 'Calculate' })) as HTMLButtonElement;
    const release = hold(`POST ${RUN_PATH}/calculate`);
    fireEvent.click(calculate);
    await waitFor(() => expect(calculate.disabled).toBe(true));
    release();
    expect(await screen.findByText('Calculation continues: 1 of 2 members calculated. Continue the calculation.')).toBeTruthy();
    expect(bodiesTo('POST', `${RUN_PATH}/calculate`)).toEqual([{ expectedVersion: 3 }]);
    const again = (await screen.findByRole('button', { name: 'Continue the calculation' })) as HTMLButtonElement;
    await waitFor(() => expect(again.disabled).toBe(false));
    fireEvent.click(again);
    await waitFor(() => expect(bodiesTo('POST', `${RUN_PATH}/calculate`)).toEqual([{ expectedVersion: 3 }, { expectedVersion: 4 }]));
  });

  it('lets only the preparer submit, keeps run actors from processing, and explains an independence refusal', async () => {
    let detail = runDetail(CALCULATED);
    serve({ [`GET ${RUN_PATH}`]: () => [200, detail], [`POST ${RUN_PATH}/process`]: refusal(403, 'NOT_INDEPENDENT') });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, RUN_PREPARE, RUN_PROCESS]);
    const submit = (await screen.findByRole('button', { name: 'Submit for review' })) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByText('Only the preparer who calculated this revision submits it.')).toBeTruthy();
    cleanup();
    detail = runDetail({ ...CALCULATED, state: 'APPROVED', createdBy: U_ME });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, RUN_PROCESS]);
    expect(((await screen.findByRole('button', { name: 'Process and lock' })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('You created or calculated this run, so someone else processes it.')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain('You created this revision, so you do not review, approve or process it');
    cleanup();
    // A reviewer may still process the approved run (only its creator and preparer never do).
    detail = runDetail({ ...CALCULATED, state: 'APPROVED', reviewedBy: U_ME });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, RUN_PROCESS]);
    expect(((await screen.findByRole('button', { name: 'Process and lock' })) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('note').textContent).toContain('You reviewed this revision, so you do not approve it or give its covering approvals');
    expect(screen.getByRole('note').textContent).not.toContain('process');
    cleanup();
    detail = runDetail({ ...CALCULATED, state: 'APPROVED' });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, RUN_PROCESS]);
    fireEvent.click(await screen.findByRole('button', { name: 'Process and lock' }));
    expect(await screen.findByText('You cannot process this run: its creator and preparer never process it.')).toBeTruthy();
    expect(bodiesTo('POST', `${RUN_PATH}/process`)).toEqual([{ expectedVersion: 3 }]);
  });

  it('returns an approved revision before processing and cancels with a reason', async () => {
    serve({
      [`GET ${RUN_PATH}`]: [200, runDetail({ ...CALCULATED, state: 'APPROVED' })],
      [`POST ${RUN_PATH}/return`]: [201, runDetail({ id: NEXT_RUN, revision: 2, supersedesRunId: RUN })],
      [`GET /v1/payroll/runs/${NEXT_RUN}`]: [200, runDetail({ id: NEXT_RUN, revision: 2, supersedesRunId: RUN })],
      [`POST ${RUN_PATH}/cancel`]: [200, runDetail({ state: 'CANCELLED' })],
    });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, RUN_PROCESS, RUN_CANCEL]);
    const cancel = await screen.findByRole('form', { name: 'Cancel this revision' });
    fireEvent.click(button(cancel, 'Cancel this revision'));
    expect(await within(cancel).findByText('Give a reason first.')).toBeTruthy();
    expect(callsTo('POST', `${RUN_PATH}/cancel`)).toHaveLength(0);
    fireEvent.change(within(cancel).getByLabelText('Reason for cancelling'), { target: { value: 'Synthetic duplicate run' } });
    fireEvent.click(button(cancel, 'Cancel this revision'));
    expect(await screen.findByText('This revision was cancelled.')).toBeTruthy();
    expect(bodiesTo('POST', `${RUN_PATH}/cancel`)).toEqual([{ reason: 'Synthetic duplicate run', expectedVersion: 3 }]);
    const ret = screen.getByRole('form', { name: 'Return before processing' });
    fireEvent.change(within(ret).getByLabelText('Why the approved revision is returned'), { target: { value: 'Synthetic input correction' } });
    const send = button(ret, 'Return before processing');
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    expect(await screen.findByRole('heading', { name: 'Payroll run 2026-10 · revision 2' })).toBeTruthy();
    expect(bodiesTo('POST', `${RUN_PATH}/return`)).toEqual([{ reason: 'Synthetic input correction', expectedVersion: 3 }]);
  });

  it('resolves a resolvable blocking exception with a note when the approval duty is held', async () => {
    const records = {
      items: [
        {
          id: 'r1',
          employeeId: 'e1',
          employeeCode: 'SYN-001',
          employeeName: 'Asha Synthetic',
          calculationStatus: 'CALCULATED',
          paidUnits: '31.0000',
          currencyCode: 'INR',
          gross: '50000.0000',
          deductions: '4000.0000',
          net: '46000.0000',
          priorNet: null,
          salaryStopMode: null,
          bankStatus: null,
          exceptions: [
            { id: X_ATTENDANCE, code: 'ATTENDANCE_NOT_VALUED', severity: 'BLOCKING', resolvable: true, detail: null, resolvedAt: null, resolvedBy: null },
            { id: 'x2', code: 'RULE_PACK_NOT_CONFIGURED', severity: 'BLOCKING', resolvable: false, detail: { componentCode: 'PT' }, resolvedAt: null, resolvedBy: null },
          ],
        },
      ],
      nextAfter: 'SYN-001',
    };
    serve({
      [`GET ${RUN_PATH}`]: [200, runDetail({ ...CALCULATED, state: 'IN_REVIEW' })],
      [`GET ${RUN_PATH}/records`]: [200, records],
      [`GET ${RUN_PATH}/components`]: [200, { runId: RUN, basis: 'RUN', priorPeriodCode: null, priorRunIds: [], items: [] }],
      [`POST ${RUN_PATH}/exceptions/${X_ATTENDANCE}/resolve`]: [200, { exceptionId: X_ATTENDANCE, code: 'ATTENDANCE_NOT_VALUED', resolved: true }],
    });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, RUN_AMOUNT, RUN_APPROVE]);
    const members = await screen.findByRole('table', { name: 'Run members' });
    expect(members.textContent).toContain('componentCode: PT');
    expect(members.textContent).toContain('Needs corrected data and a new revision, or the employee left out.');
    expect(within(members).queryByRole('button', { name: 'Resolve Rule pack not configured of SYN-001' })).toBeNull();
    fireEvent.click(button(members, 'Resolve Attendance not valued of SYN-001'));
    const form = screen.getByRole('form', { name: 'Resolve Attendance not valued of SYN-001' });
    fireEvent.change(within(form).getByLabelText('Resolution of Attendance not valued for SYN-001'), { target: { value: 'Synthetic absence confirmed as paid' } });
    fireEvent.click(button(form, 'Record the resolution'));
    expect(await screen.findByText('The exception was resolved.')).toBeTruthy();
    expect(bodiesTo('POST', `${RUN_PATH}/exceptions/${X_ATTENDANCE}/resolve`)).toEqual([{ resolution: 'Synthetic absence confirmed as paid' }]);
    // The next page continues after the last employee code.
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(callsTo('GET', `${RUN_PATH}/records`).some((c) => c.query.get('after') === 'SYN-001')).toBe(true));
  });
});

// =========================================================================================================
// Run decision queues
// =========================================================================================================

describe('run review and approval queues', () => {
  const tasks = {
    items: [
      { taskId: TASK, step: 'REVIEW', run: { id: RUN, revision: 1, state: 'IN_REVIEW', periodCode: '2026-10', coveredEmployeeId: null } },
      { taskId: TASK_2, step: 'APPROVAL', run: { id: RUN, revision: 1, state: 'IN_REVIEW', periodCode: '2026-10', coveredEmployeeId: null } },
    ],
  };

  it('reviews with an idempotency key, needs a reason to return, and resends the same key after a lost answer', async () => {
    serve({ 'GET /v1/payroll/runs/tasks/mine': [200, tasks], [`POST /v1/payroll/run-tasks/${TASK}/review`]: [200, { runId: RUN, state: 'IN_REVIEW', step: 'APPROVAL', replayed: false }] });
    renderQueue('Payroll run reviews', [RUN_AMOUNT, RUN_REVIEW]);
    const item = await screen.findByRole('listitem', { name: 'Review: 2026-10 revision 1' });
    expect(screen.queryByRole('listitem', { name: 'Approval: 2026-10 revision 1' })).toBeNull();
    fireEvent.click(button(item, 'Return to a new revision'));
    expect(await within(item).findByText('Give the reason for returning the run.')).toBeTruthy();
    lost.add(`POST /v1/payroll/run-tasks/${TASK}/review`);
    fireEvent.click(button(item, 'Approve'));
    expect(await within(item).findByText(/No answer came back/)).toBeTruthy();
    const approve = button(item, 'Approve');
    await waitFor(() => expect(approve.disabled).toBe(false));
    fireEvent.click(approve);
    expect(await screen.findByText('2026-10 revision 1 was reviewed and goes to an independent approver.')).toBeTruthy();
    const [first, second] = bodiesTo('POST', `/v1/payroll/run-tasks/${TASK}/review`);
    expect(first).toEqual({ decision: 'APPROVE', idempotencyKey: expect.stringMatching(/^payroll-run-decision-[0-9a-f-]{36}$/) });
    expect(second).toEqual(first);
  });

  it('lists approvals and covering approvals and explains an independence refusal', async () => {
    serve({
      'GET /v1/payroll/runs/tasks/mine': [200, { items: [...tasks.items, { taskId: 't3', step: 'COVER', run: { id: RUN, revision: 1, state: 'IN_REVIEW', periodCode: '2026-10', coveredEmployeeId: 'e1' } }] }],
      [`POST /v1/payroll/run-tasks/${TASK_2}/approve`]: refusal(403, 'NOT_INDEPENDENT'),
    });
    renderQueue('Payroll run approvals', [RUN_AMOUNT, RUN_APPROVE]);
    const item = await screen.findByRole('listitem', { name: 'Approval: 2026-10 revision 1' });
    expect(screen.getByRole('listitem', { name: 'Covering approval: 2026-10 revision 1' }).textContent).toContain('a decider’s own record in this run needs a further, independent approver');
    fireEvent.change(within(item).getByLabelText('Reason (needed to return)'), { target: { value: 'Synthetic check' } });
    fireEvent.click(button(item, 'Approve'));
    expect(await within(item).findByText('You cannot take this step: the creator, preparer, reviewer and approver of a payroll run are different people.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/payroll/run-tasks/${TASK_2}/approve`)).toEqual([{ decision: 'APPROVE', reason: 'Synthetic check', idempotencyKey: expect.stringMatching(/^payroll-run-decision-/) }]);
  });

  it('says so when the role cannot list run tasks, and asks for nothing', async () => {
    serve({});
    renderQueue('Payroll run reviews', [RUN_REVIEW]);
    expect(screen.getByText('The selected role cannot list payroll run tasks: it needs the payroll run amounts.')).toBeTruthy();
    await settle();
    expect(calls).toHaveLength(0);
  });
});

// =========================================================================================================
// Payslip publishing
// =========================================================================================================

describe('payslip publishing', () => {
  const processed = runDetail({ ...CALCULATED, state: 'PROCESSED_LOCKED', processedAt: '2026-10-28T08:00:00.000Z', lockVersion: 1 });

  it('publishes a processed run in chunks and lists the issued payslips with superseded versions marked', async () => {
    serve({
      [`GET ${RUN_PATH}`]: [200, processed],
      [`POST /v1/payroll-outputs/runs/${RUN}/payslips/publish`]: [202, { runId: RUN, published: 2, remaining: 1, ownRecordLeftForAnotherPublisher: 1, done: false }],
      [`GET /v1/payroll-outputs/runs/${RUN}/payslips`]: [
        200,
        {
          items: [
            { id: 'o1', employeeCode: 'SYN-001', periodCode: '2026-10', version: 1, publicationState: 'SUPERSEDED', issuedAt: '2026-10-28T09:00:00.000Z', fileName: 'p1.json', supersededAt: '2026-10-28T10:00:00.000Z', rowVersion: 2 },
            { id: 'o2', employeeCode: 'SYN-001', periodCode: '2026-10', version: 2, publicationState: 'ISSUED', issuedAt: '2026-10-28T10:00:00.000Z', fileName: 'p2.json', supersededAt: null, rowVersion: 1 },
            { id: 'o3', employeeCode: 'SYN-002', periodCode: '2026-10', version: 1, publicationState: 'DRAFT', issuedAt: null, fileName: null, supersededAt: null, rowVersion: 1 },
          ],
        },
      ],
    });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, OUTPUT_READ, OUTPUT_PUBLISH]);
    const payslips = await section('Payslips');
    const issued = await within(payslips).findByRole('table', { name: 'Issued payslips' });
    expect(cells(within(issued).getAllByRole('row')[1]!).slice(0, 4)).toEqual(['SYN-001', '2026-10', '1', 'Superseded by a later version']);
    // Only an issued (or superseded) document is downloadable; a draft is not.
    expect(within(issued).getByRole('button', { name: 'Download payslip of SYN-001 version 2' })).toBeTruthy();
    expect(within(issued).queryByRole('button', { name: 'Download payslip of SYN-002 version 1' })).toBeNull();
    expect(cells(rowWith(issued, 'SYN-002'))[5]).toBe('Not issued');
    fireEvent.click(button(payslips, 'Publish payslips'));
    expect(
      await within(payslips).findByText(
        'Published 2 payslips. 1 still to publish: publish again to continue. Your own payslip is left for another publisher. Publication does not mean the salary has been paid.',
      ),
    ).toBeTruthy();
    expect(callsTo('POST', `/v1/payroll-outputs/runs/${RUN}/payslips/publish`)).toEqual([expect.objectContaining({ body: undefined })]);
  });

  it('offers no publishing without its key and no outputs before the run is processed', async () => {
    serve({ [`GET ${RUN_PATH}`]: [200, processed], [`GET /v1/payroll-outputs/runs/${RUN}/payslips`]: [200, { items: [] }] });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, OUTPUT_READ]);
    const payslips = await section('Payslips');
    expect(within(payslips).queryByRole('button', { name: 'Publish payslips' })).toBeNull();
    cleanup();
    serve({ [`GET ${RUN_PATH}`]: [200, runDetail({ ...CALCULATED, state: 'APPROVED' })] });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, OUTPUT_READ, OUTPUT_PUBLISH, BANK_READ]);
    await screen.findByRole('heading', { name: 'Payroll run 2026-10 · revision 1' });
    expect(screen.queryByRole('heading', { name: 'Payslips' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Bank manifests' })).toBeNull();
  });
});

// =========================================================================================================
// Bank manifests
// =========================================================================================================

describe('bank manifests', () => {
  const processed = runDetail({ ...CALCULATED, state: 'PROCESSED_LOCKED', processedAt: '2026-10-28T08:00:00.000Z', lockVersion: 1 });

  it('prepares a manifest from an active template of the run currency after a non-payable preview', async () => {
    serve({
      [`GET ${RUN_PATH}`]: [200, processed],
      [`GET /v1/payroll-outputs/runs/${RUN}/bank-manifests`]: [200, { items: [] }],
      'GET /v1/payroll-outputs/bank-templates': [
        200,
        {
          items: [
            { id: TEMPLATE, templateCode: 'SYN_BANK', templateVersion: 1, name: 'Synthetic bank', currencyCode: 'INR', testOnly: false, state: 'ACTIVE' },
            { id: 't2', templateCode: 'SYN_USD', templateVersion: 1, name: 'Synthetic dollars', currencyCode: 'USD', testOnly: false, state: 'ACTIVE' },
            { id: 't3', templateCode: 'SYN_DRAFT', templateVersion: 2, name: 'Synthetic draft', currencyCode: 'INR', testOnly: false, state: 'DRAFT' },
          ],
        },
      ],
      [`GET /v1/payroll-outputs/runs/${RUN}/bank-preview`]: [
        200,
        { label: 'NON_PAYABLE_PREVIEW', payable: false, runId: RUN, currencyCode: 'INR', lineCount: 2, totalAmount: '87800.0000', lines: [], excluded: { held: 1, reservedOrPaid: 0, nothingPayable: 0 }, errors: [] },
      ],
      [`POST /v1/payroll-outputs/runs/${RUN}/bank-manifests`]: [201, manifest()],
    });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, BANK_READ, BANK_PREPARE, TEMPLATE_READ]);
    const form = await screen.findByRole('form', { name: 'Prepare a manifest' });
    const select = within(form).getByLabelText('Bank file template') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', TEMPLATE]);
    fireEvent.change(select, { target: { value: TEMPLATE } });
    fireEvent.click(button(form, 'Preview (not payable)'));
    const preview = await screen.findByRole('region', { name: 'Manifest preview' });
    expect(preview.textContent).toContain('Preview, not payable 2 lines, total INR 87,800.00.');
    expect(preview.textContent).toContain('Left out: 1 held');
    expect(callsTo('GET', `/v1/payroll-outputs/runs/${RUN}/bank-preview`)[0]!.query.get('templateId')).toBe(TEMPLATE);
    fireEvent.click(button(form, 'Prepare the manifest'));
    expect(await screen.findByText(/Manifest 1 prepared: 2 lines, waiting for an independent authorisation\. Nothing is reserved or paid yet\./)).toBeTruthy();
    expect(bodiesTo('POST', `/v1/payroll-outputs/runs/${RUN}/bank-manifests`)).toEqual([{ templateId: TEMPLATE }]);
  });

  it('explains a refused preparation with the rows that failed', async () => {
    serve({
      [`GET ${RUN_PATH}`]: [200, processed],
      [`GET /v1/payroll-outputs/runs/${RUN}/bank-manifests`]: [200, { items: [] }],
      'GET /v1/payroll-outputs/bank-templates': [200, { items: [{ id: TEMPLATE, templateCode: 'SYN_BANK', templateVersion: 1, name: 'Synthetic bank', currencyCode: 'INR', testOnly: false, state: 'ACTIVE' }] }],
      [`POST /v1/payroll-outputs/runs/${RUN}/bank-manifests`]: refusal(422, 'BANK_FILE_VALIDATION_FAILED', 'Some rows are not valid', { errors: [{ lineSequence: 2, employeeCode: 'SYN-002', code: 'BANK_VALUES_UNAVAILABLE', source: 'BANK_REVISION' }] }),
    });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, BANK_READ, BANK_PREPARE, TEMPLATE_READ]);
    const form = await screen.findByRole('form', { name: 'Prepare a manifest' });
    await waitFor(() => expect((within(form).getByLabelText('Bank file template') as HTMLSelectElement).options).toHaveLength(2));
    fireEvent.change(within(form).getByLabelText('Bank file template'), { target: { value: TEMPLATE } });
    fireEvent.click(button(form, 'Prepare the manifest'));
    const alert = await screen.findByText(/Some rows are not valid, so nothing was prepared\./);
    expect(alert.closest('[role="alert"]')!.textContent).toContain('SYN-002: Bank values unavailable (row 2)');
  });

  it('shows the preparer and the run’s actors that they cannot authorise, and explains the refusal in words', async () => {
    serve({ [`GET ${BATCH_PATH}`]: [200, manifest({ preparedBy: U_ME })], [`GET ${BATCH_PATH}/lines`]: [200, { items: [], next: null }] });
    renderScreen(`/payroll/manifests/${BATCH}`, [BANK_READ, BANK_AUTHORIZE]);
    expect(((await screen.findByRole('button', { name: 'Authorise the payment' })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('You prepared this manifest, so someone else authorises it and records its outcomes.')).toBeTruthy();
    cleanup();
    serve({
      [`GET ${BATCH_PATH}`]: [200, manifest()],
      [`GET ${BATCH_PATH}/lines`]: [200, { items: [], next: null }],
      [`GET ${RUN_PATH}`]: [200, runDetail({ ...processed, approvedBy: U_ME })],
    });
    renderScreen(`/payroll/manifests/${BATCH}`, [BANK_READ, BANK_AUTHORIZE, RUN_STATUS]);
    expect(await screen.findByText('You approved its payroll run, so you cannot authorise this manifest or record its outcomes.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Authorise the payment' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    // While the run's actors are loading, the authorisation waits; an independent reader may then authorise.
    serve({ [`GET ${BATCH_PATH}`]: [200, manifest()], [`GET ${BATCH_PATH}/lines`]: [200, { items: [], next: null }], [`GET ${RUN_PATH}`]: [200, runDetail(processed)] });
    const releaseRun = hold(`GET ${RUN_PATH}`);
    renderScreen(`/payroll/manifests/${BATCH}`, [BANK_READ, BANK_AUTHORIZE, RUN_STATUS]);
    const authorise = (await screen.findByRole('button', { name: 'Authorise the payment' })) as HTMLButtonElement;
    expect(authorise.disabled).toBe(true);
    await act(async () => releaseRun());
    await waitFor(() => expect(authorise.disabled).toBe(false));
    cleanup();
    // Without the run read duty the screen cannot know; the server refuses and the refusal is said in words.
    serve({ [`GET ${BATCH_PATH}`]: [200, manifest()], [`GET ${BATCH_PATH}/lines`]: [200, { items: [], next: null }], [`POST ${BATCH_PATH}/authorize`]: refusal(403, 'NOT_INDEPENDENT') });
    renderScreen(`/payroll/manifests/${BATCH}`, [BANK_READ, BANK_AUTHORIZE]);
    fireEvent.click(await screen.findByRole('button', { name: 'Authorise the payment' }));
    expect(await screen.findByText(/You cannot authorise this payment: the preparer of a manifest, and whoever created, calculated, reviewed or approved its payroll run, never authorise its release\./)).toBeTruthy();
    expect(bodiesTo('POST', `${BATCH_PATH}/authorize`)).toEqual([{ expectedVersion: 2 }]);
  });

  it('authorises with the manifest version and says nothing is paid yet', async () => {
    let batch = manifest();
    serve({
      [`GET ${BATCH_PATH}`]: () => [200, batch],
      [`GET ${BATCH_PATH}/lines`]: [200, { items: [bankLine(LINE_1, 1), bankLine(LINE_2, 2)], next: null }],
      [`POST ${BATCH_PATH}/authorize`]: () => {
        batch = manifest({ state: 'AUTHORIZED', authorizedBy: U_ME, authorizedAt: '2026-10-28T10:00:00.000Z', version: 3 });
        return [200, batch];
      },
    });
    renderScreen(`/payroll/manifests/${BATCH}`, [BANK_READ, BANK_AUTHORIZE, BANK_FILE]);
    fireEvent.click(await screen.findByRole('button', { name: 'Authorise the payment' }));
    expect(await screen.findByText('Authorised: every line is reserved. Nothing is paid until a CONFIRMED outcome is recorded from bank evidence.')).toBeTruthy();
    expect(bodiesTo('POST', `${BATCH_PATH}/authorize`)).toEqual([{ expectedVersion: 2 }]);
    expect(await screen.findByRole('button', { name: 'Issue the bank file' })).toBeTruthy();
    const lines = screen.getByRole('table', { name: 'Manifest lines' });
    expect(cells(rowWith(lines, 'SYN-001'))[5]).toBe('Reserved, not paid');
  });

  it('labels only confirmed lines as paid, records outcomes with evidence keys and reverses a confirmed payment', async () => {
    serve({
      [`GET ${BATCH_PATH}`]: [200, manifest({ state: 'ISSUED', authorizedAt: '2026-10-28T10:00:00.000Z', issuedAt: '2026-10-28T11:00:00.000Z', fileName: 'bank.txt', version: 4 })],
      [`GET ${BATCH_PATH}/lines`]: [200, { items: [bankLine(LINE_1, 1, { paymentState: 'SUBMITTED' }), bankLine(LINE_2, 2, { paymentState: 'CONFIRMED', confirmedAmount: '43900.0000' })], next: null }],
      [`POST ${BATCH_PATH}/outcomes`]: [200, { batchId: BATCH, results: [{ lineId: LINE_1, outcome: 'CONFIRMED', replayed: false }] }],
      [`POST /v1/payroll-outputs/bank-lines/${LINE_2}/reversal`]: [200, { lineId: LINE_2, replayed: false, paymentState: 'CONFIRMED', confirmedAmount: '43900.0000', reversedAmount: '1500.0000' }],
    });
    renderScreen(`/payroll/manifests/${BATCH}`, [BANK_READ, BANK_OUTCOME, BANK_FILE]);
    const lines = await screen.findByRole('table', { name: 'Manifest lines' });
    expect(cells(rowWith(lines, 'SYN-001'))[5]).toBe('Submitted to the bank, not confirmed');
    expect(cells(rowWith(lines, 'SYN-002'))[5]).toBe('Paid: confirmed from bank evidence');
    expect(screen.getByRole('button', { name: 'Download the bank file' })).toBeTruthy();
    fireEvent.click(button(lines, 'Record an outcome for row 1'));
    const form = screen.getByRole('form', { name: 'Outcome for row 1' });
    const options = Array.from((within(form).getByLabelText('Outcome') as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual(['', 'UNKNOWN', 'CONFIRMED', 'FAILED', 'CANCELLED']);
    // No outcome is preselected: a payment confirmation is always an explicit choice.
    expect((within(form).getByLabelText('Outcome') as HTMLSelectElement).value).toBe('');
    fireEvent.change(within(form).getByLabelText('Evidence reference'), { target: { value: 'SYNTH-STATEMENT-0' } });
    fireEvent.click(button(form, 'Record the outcome'));
    expect(await within(form).findByText('Choose the outcome.')).toBeTruthy();
    expect(callsTo('POST', `${BATCH_PATH}/outcomes`)).toEqual([]);
    fireEvent.change(within(form).getByLabelText('Evidence reference'), { target: { value: '' } });
    fireEvent.change(within(form).getByLabelText('Outcome'), { target: { value: 'CONFIRMED' } });
    fireEvent.click(button(form, 'Record the outcome'));
    expect(await within(form).findByText('Give the evidence reference (for example the bank statement or return file).')).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Evidence reference'), { target: { value: 'SYNTH-STATEMENT-1' } });
    lost.add(`POST ${BATCH_PATH}/outcomes`);
    fireEvent.click(button(form, 'Record the outcome'));
    expect(await within(form).findByText(/No answer came back/)).toBeTruthy();
    const resend = button(form, 'Record the outcome');
    await waitFor(() => expect(resend.disabled).toBe(false));
    fireEvent.click(resend);
    expect(await screen.findByText('Recorded for row 1: Confirmed paid by the bank.')).toBeTruthy();
    const [first, second] = bodiesTo('POST', `${BATCH_PATH}/outcomes`);
    expect(first).toEqual({ outcomes: [{ lineId: LINE_1, outcome: 'CONFIRMED', eventKey: expect.stringMatching(/^pay-outcome-[0-9a-f-]{36}$/), evidenceReference: 'SYNTH-STATEMENT-1' }] });
    expect(second).toEqual(first);
    fireEvent.click(button(lines, 'Record a reversal for row 2'));
    const reversal = screen.getByRole('form', { name: 'Reversal for row 2' });
    fireEvent.change(within(reversal).getByLabelText('Reversed amount'), { target: { value: '1500.00' } });
    fireEvent.change(within(reversal).getByLabelText('Evidence reference'), { target: { value: 'SYNTH-RETURN-1' } });
    fireEvent.change(within(reversal).getByLabelText('Reason'), { target: { value: 'Synthetic return by the bank' } });
    fireEvent.click(button(reversal, 'Record the reversal'));
    expect(await screen.findByText('Reversal recorded for row 2: INR 1,500.00 reversed of INR 43,900.00 confirmed.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/payroll-outputs/bank-lines/${LINE_2}/reversal`)).toEqual([
      { amount: '1500.00', eventKey: expect.stringMatching(/^pay-reversal-[0-9a-f-]{36}$/), evidenceReference: 'SYNTH-RETURN-1', reason: 'Synthetic return by the bank' },
    ]);
  });

  it('offers only a cancellation before the file is issued, and no outcomes without the outcome key', async () => {
    serve({ [`GET ${BATCH_PATH}`]: [200, manifest({ state: 'AUTHORIZED', authorizedAt: '2026-10-28T10:00:00.000Z', version: 3 })], [`GET ${BATCH_PATH}/lines`]: [200, { items: [bankLine(LINE_1, 1)], next: null }] });
    renderScreen(`/payroll/manifests/${BATCH}`, [BANK_READ, BANK_OUTCOME]);
    const lines = await screen.findByRole('table', { name: 'Manifest lines' });
    fireEvent.click(button(lines, 'Record an outcome for row 1'));
    const form = screen.getByRole('form', { name: 'Outcome for row 1' });
    expect(Array.from((within(form).getByLabelText('Outcome') as HTMLSelectElement).options).map((o) => o.value)).toEqual(['', 'CANCELLED']);
    // The restricted file needs its own duty.
    expect(screen.queryByRole('button', { name: 'Issue the bank file' })).toBeNull();
    cleanup();
    serve({ [`GET ${BATCH_PATH}`]: [200, manifest({ state: 'AUTHORIZED', version: 3 })], [`GET ${BATCH_PATH}/lines`]: [200, { items: [bankLine(LINE_1, 1)], next: null }] });
    renderScreen(`/payroll/manifests/${BATCH}`, [BANK_READ]);
    const plain = await screen.findByRole('table', { name: 'Manifest lines' });
    expect(within(plain).queryByRole('button', { name: /Record an outcome/ })).toBeNull();
  });
});

// =========================================================================================================
// Loans (HR)
// =========================================================================================================

describe('loan decisions', () => {
  it('approves with the recovery head and schedule, and needs a reason to reject', async () => {
    serve({
      'GET /v1/payroll-outputs/loans': (c) => [200, { items: c.query.get('state') === 'REQUESTED' ? [hrLoan(LOAN), hrLoan(LOAN_2, { employeeCode: 'SYN-003', loanKind: 'ADVANCE' })] : [] }],
      [`POST /v1/payroll-outputs/loans/${LOAN}/decision`]: [200, { ...hrLoan(LOAN), state: 'APPROVED' }],
      [`POST /v1/payroll-outputs/loans/${LOAN_2}/decision`]: [200, { ...hrLoan(LOAN_2), state: 'REJECTED' }],
    });
    renderScreen('/payroll/loans', [LOAN_READ, LOAN_DECIDE]);
    const item = await screen.findByRole('listitem', { name: 'Loan of SYN-002' });
    const form = within(item).getByRole('form', { name: 'Decide Loan of SYN-002' });
    fireEvent.change(within(form).getByLabelText('Recovery deduction head (code)'), { target: { value: 'LN_RECOVERY' } });
    fireEvent.change(within(form).getByLabelText('Instalment 1 due month'), { target: { value: '2026-11' } });
    fireEvent.change(within(form).getByLabelText('Instalment 1 amount'), { target: { value: '3000.00' } });
    fireEvent.click(button(form, 'Add an instalment'));
    fireEvent.change(within(form).getByLabelText('Instalment 2 due month'), { target: { value: '2026-12' } });
    fireEvent.change(within(form).getByLabelText('Instalment 2 amount'), { target: { value: '3000.00' } });
    fireEvent.click(button(form, 'Send the decision'));
    expect(await screen.findByText('SYN-002: approved with its recovery schedule; it is disbursed only from verified evidence by someone else.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/payroll-outputs/loans/${LOAN}/decision`)).toEqual([
      {
        decision: 'APPROVE',
        recoveryComponentCode: 'LN_RECOVERY',
        installments: [
          { dueMonth: '2026-11', amount: '3000.00' },
          { dueMonth: '2026-12', amount: '3000.00' },
        ],
        expectedVersion: 1,
      },
    ]);
    const other = screen.getByRole('listitem', { name: 'Salary advance of SYN-003' });
    const otherForm = within(other).getByRole('form', { name: 'Decide Salary advance of SYN-003' });
    fireEvent.click(within(otherForm).getByLabelText('Reject'));
    fireEvent.click(button(otherForm, 'Send the decision'));
    expect(await within(other).findByText('Give the reason for rejecting the request.')).toBeTruthy();
    fireEvent.change(within(otherForm).getByLabelText('Reason'), { target: { value: 'Synthetic policy limit' } });
    fireEvent.click(button(otherForm, 'Send the decision'));
    await waitFor(() => expect(bodiesTo('POST', `/v1/payroll-outputs/loans/${LOAN_2}/decision`)).toEqual([{ decision: 'REJECT', reason: 'Synthetic policy limit', expectedVersion: 1 }]));
  });

  it('keeps a request the decider entered from being decided by them, and explains refusals', async () => {
    serve({
      'GET /v1/payroll-outputs/loans': (c) => [200, { items: c.query.get('state') === 'REQUESTED' ? [hrLoan(LOAN, { requestedBy: U_ME }), hrLoan(LOAN_2, { employeeCode: 'SYN-003' })] : [] }],
      [`POST /v1/payroll-outputs/loans/${LOAN_2}/decision`]: refusal(422, 'SCHEDULE_NOT_BALANCED'),
    });
    renderScreen('/payroll/loans', [LOAN_READ, LOAN_DECIDE]);
    const own = await screen.findByRole('listitem', { name: 'Loan of SYN-002' });
    expect(own.textContent).toContain('You entered this request, so someone else decides it.');
    expect(button(own, 'Send the decision').disabled).toBe(true);
    const other = screen.getByRole('listitem', { name: 'Loan of SYN-003' });
    fireEvent.change(within(other).getByLabelText('Recovery deduction head (code)'), { target: { value: 'LN_RECOVERY' } });
    fireEvent.change(within(other).getByLabelText('Instalment 1 due month'), { target: { value: '2026-11' } });
    fireEvent.change(within(other).getByLabelText('Instalment 1 amount'), { target: { value: '1000.00' } });
    fireEvent.click(button(other, 'Send the decision'));
    expect(await within(other).findByText('The instalments must recover exactly the principal.')).toBeTruthy();
    expect((within(other).getByLabelText('Instalment 1 amount') as HTMLInputElement).value).toBe('1000.00');
  });

  it('hides the loans without the read key and the queue without the decide key', async () => {
    serve({ 'GET /v1/payroll-outputs/loans': [200, { items: [hrLoan(LOAN)] }] });
    renderScreen('/payroll/loans', [LOAN_READ]);
    expect(await screen.findByRole('table', { name: 'Loans and advances' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Loan requests to decide' })).toBeNull();
    cleanup();
    renderScreen('/payroll/loans', [LOAN_DECIDE]);
    expect(screen.getByText('The selected role cannot see loans and advances.')).toBeTruthy();
  });
});

// =========================================================================================================
// Exports
// =========================================================================================================

describe('exports for the navigation step', () => {
  it('declares unique screens with their keys, the TN06 and TN15 panels and the decision queues', () => {
    expect(PAYROLL_SCREENS.map((s) => [s.path, s.permission, s.nav])).toEqual([
      ['/payroll/runs', RUN_STATUS, true],
      ['/payroll/runs/:id', RUN_STATUS, false],
      ['/payroll/run-decisions', RUN_AMOUNT, true],
      ['/payroll/manifests/:id', BANK_READ, false],
      ['/payroll/loans', LOAN_READ, true],
      ['/payroll/loans/upload', LOAN_REQUEST, true],
      ['/payroll/holds', HOLD_READ, true],
      ['/payroll/holds/stop-upload', STOP_PROPOSE, true],
      ['/payroll/inputs', INPUT_READ, true],
      ['/payroll/bank-templates', TEMPLATE_READ, true],
      ['/payroll/runs/:id/reports', REPORT_READ, false],
      ['/payroll/statutory-outputs', STATUTORY_READ, true],
      ['/payroll/calendars', CONFIG_READ, true],
      ['/payroll/calendars/:id', CONFIG_READ, false],
      ['/payroll/heads', CONFIG_READ, true],
      ['/payroll/salary-components', SALARY_READ, true],
    ]);
    expect(new Set(PAYROLL_SCREENS.map((s) => s.path)).size).toBe(PAYROLL_SCREENS.length);
    expect(PAYROLL_ESS_PANELS.map((p) => p.tabId)).toEqual(['TN06', 'TN15']);
    expect(PAYROLL_TASK_QUEUES.map((q) => [q.permission, q.title])).toEqual([
      [RUN_REVIEW, 'Payroll run reviews'],
      [RUN_APPROVE, 'Payroll run approvals'],
      [LOAN_DECIDE, 'Loan requests'],
      [HOLD_DECIDE, 'Salary holds'],
      [STOP_DECIDE, 'Salary stops'],
      [INPUT_APPROVE, 'Payroll input batches'],
    ]);
    expect(new Set(PAYROLL_TASK_QUEUES.map((q) => q.title)).size).toBe(PAYROLL_TASK_QUEUES.length);
  });
});

// =========================================================================================================
// Salary holds and salary stops
// =========================================================================================================

const holdRow = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  holdKind: 'POLICY_HOLD',
  state: 'PROPOSED',
  employeeId: 'e1',
  employeeCode: 'SYN-001',
  employeeName: 'Asha Synthetic',
  payrollRecordId: 'r1',
  runId: RUN,
  runRevision: 1,
  periodCode: '2026-10',
  criterionCode: 'SYN_CONTRACT',
  salaryStopId: null,
  reason: 'Synthetic unreturned company asset',
  scope: 'PARTIAL',
  holdAmount: '5000.0000',
  currencyCode: 'INR',
  effectiveDate: '2026-10-28',
  reviewDueOn: '2026-11-15',
  releaseCriterion: 'Asset returned',
  proposedAt: '2026-10-28T09:00:00.000Z',
  proposedBy: U_OTHER,
  approvedAt: null,
  releasedAt: null,
  version: 1,
  ...patch,
});
const stop = (patch: Record<string, unknown> = {}) => ({
  id: 'st1',
  periodId: PERIOD,
  periodCode: '2026-10',
  employeeId: 'e2',
  employeeCode: 'SYN-002',
  employeeName: 'Ravi Synthetic',
  mode: 'HOLD_DISBURSEMENT',
  approvedMode: null,
  criterionCode: 'SYN_CONTRACT',
  reason: 'Synthetic absconding case',
  releaseCriterion: 'Employee reports back',
  evidenceReference: 'SYNTH-NOTICE-1',
  state: 'SUBMITTED',
  proposedBy: U_OTHER,
  decidedAt: null,
  createdAt: '2026-10-27T09:00:00.000Z',
  version: 1,
  ...patch,
});

describe('salary holds and salary stops', () => {
  it('decides a hold with an idempotency key, needs a reason to reject, and never offers one’s own proposal', async () => {
    serve({
      'GET /v1/payroll/holds/tasks/mine': [200, { items: [{ taskId: TASK, hold: holdRow('h1') }, { taskId: TASK_2, hold: holdRow('h2', { employeeCode: 'SYN-003', proposedBy: U_ME }) }] }],
      'GET /v1/payroll/holds': [200, { items: [] }],
      [`POST /v1/payroll/hold-tasks/${TASK}/decision`]: [200, { holdId: 'h1', state: 'APPROVED_ACTIVE', replayed: false }],
    });
    renderScreen('/payroll/holds', [HOLD_READ, HOLD_DECIDE]);
    const item = await screen.findByRole('listitem', { name: 'Salary hold of SYN-001 for 2026-10' });
    expect(item.textContent).toContain('Partial: INR 5,000.00');
    const own = screen.getByRole('listitem', { name: 'Salary hold of SYN-003 for 2026-10' });
    expect(own.textContent).toContain('You proposed this hold, so someone else decides it.');
    expect(within(own).queryByRole('button', { name: /Approve/ })).toBeNull();
    fireEvent.click(button(item, 'Reject Salary hold of SYN-001 for 2026-10'));
    expect(await within(item).findByText('Give the reason for rejecting.')).toBeTruthy();
    fireEvent.click(button(item, 'Approve Salary hold of SYN-001 for 2026-10'));
    expect(await screen.findByText('Salary hold of SYN-001 for 2026-10: approved; the payment is withheld.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/payroll/hold-tasks/${TASK}/decision`)).toEqual([{ decision: 'APPROVE', idempotencyKey: expect.stringMatching(/^payroll-hold-decision-[0-9a-f-]{36}$/) }]);
  });

  it('pages the salary holds with the total of every hold in scope, keeping the state filter (FR-056)', async () => {
    serve({
      'GET /v1/payroll/holds': (c) => [
        200,
        c.query.get('page') === '2'
          ? { items: [holdRow('h26', { employeeCode: 'SYN-026' })], total: 26, page: 2, pageSize: 25 }
          : { items: Array.from({ length: 25 }, (_, i) => holdRow(`h${i}`, { employeeCode: `SYN-${100 + i}` })), total: 26, page: 1, pageSize: 25 },
      ],
    });
    renderScreen('/payroll/holds', [HOLD_READ]);
    await screen.findByRole('table', { name: 'Salary holds' });
    expect(callsTo('GET', '/v1/payroll/holds')[0]?.query.toString()).toBe('page=1&pageSize=25');
    const pager = screen.getByRole('navigation', { name: 'Hold pages' });
    expect(pager.textContent).toContain('Page 1 of 2 · 26 holds');
    fireEvent.click(within(pager).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Salary holds' })).getAllByRole('row')).toHaveLength(2));
    expect(callsTo('GET', '/v1/payroll/holds').at(-1)?.query.toString()).toBe('page=2&pageSize=25');
  });

  it('shows the H7 reserved and confirmed totals of every matching hold per currency, exactly as returned (H7)', async () => {
    serve({
      'GET /v1/payroll/holds': (c) => [
        200,
        c.query.get('state') === 'RELEASED'
          ? { items: [holdRow('h1', { state: 'RELEASED' })], total: 1, page: 1, pageSize: 25, totals: [{ currencyCode: 'INR', reserved: '0.0000', confirmed: '19900.0000' }] }
          : {
              items: [holdRow('h1', { state: 'RELEASED' }), holdRow('h2', { state: 'APPROVED_ACTIVE', employeeCode: 'SYN-003' })],
              total: 2,
              page: 1,
              pageSize: 25,
              totals: [{ currencyCode: 'INR', reserved: '20000.0000', confirmed: '19900.0000', outstanding: '50100.0000' }],
            },
      ],
    });
    renderScreen('/payroll/holds', [HOLD_READ]);
    const list = await section('Salary holds');
    const totals = await within(list).findByLabelText('Hold totals in INR');
    // I-80: the outstanding figure is the API's, shown as returned.
    expect(totals.textContent).toContain('Outstanding (held, not yet confirmed paid)INR 50,100.00');
    expect(totals.textContent).toContain('Reserved for payment, not paidINR 20,000.00');
    expect(totals.textContent).toContain('Paid (confirmed from bank evidence)INR 19,900.00');
    expect(list.textContent).toContain('Totals of every hold matching the filter, on all pages');
    // A filter asks the API again: the totals shown are the API's for that filter, never computed from the page.
    fireEvent.change(within(list).getByLabelText('State'), { target: { value: 'RELEASED' } });
    await waitFor(() => expect(within(list).getByLabelText('Hold totals in INR').textContent).toContain('Reserved for payment, not paidINR 0.00'));
    expect(callsTo('GET', '/v1/payroll/holds').at(-1)?.query.toString()).toBe('state=RELEASED&page=1&pageSize=25');
    cleanup();
    // Without the totals (no amount grant) nothing is shown in their place.
    serve({ 'GET /v1/payroll/holds': [200, { items: [holdRow('h1')], total: 1, page: 1, pageSize: 25 }] });
    renderScreen('/payroll/holds', [HOLD_READ]);
    await screen.findByRole('table', { name: 'Salary holds' });
    expect(screen.queryByLabelText(/Hold totals/)).toBeNull();
    expect(screen.queryByText(/Totals of every hold/)).toBeNull();
  });

  it('pages the salary stops with the total of every stop in scope (FR-056)', async () => {
    serve({
      'GET /v1/payroll/salary-stops': (c) => [
        200,
        c.query.get('page') === '2'
          ? { items: [stop({ id: 'st26', employeeCode: 'SYN-226' })], total: 26, page: 2, pageSize: 25 }
          : { items: Array.from({ length: 25 }, (_, i) => stop({ id: `st${i}`, employeeCode: `SYN-${200 + i}` })), total: 26, page: 1, pageSize: 25 },
      ],
    });
    renderScreen('/payroll/holds', [STOP_READ]);
    await screen.findByRole('table', { name: 'Salary stops' });
    expect(callsTo('GET', '/v1/payroll/salary-stops')[0]?.query.toString()).toBe('page=1&pageSize=25');
    const pager = screen.getByRole('navigation', { name: 'Salary stop pages' });
    expect(pager.textContent).toContain('Page 1 of 2 · 26 salary stops');
    fireEvent.click(within(pager).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Salary stops' })).getAllByRole('row')).toHaveLength(2));
    expect(callsTo('GET', '/v1/payroll/salary-stops').at(-1)?.query.toString()).toBe('page=2&pageSize=25');
  });

  it('approves a salary stop only with its mode confirmed', async () => {
    serve({
      'GET /v1/payroll/salary-stops/tasks/mine': [200, { items: [{ taskId: TASK, stop: stop() }] }],
      'GET /v1/payroll/salary-stops': [200, { items: [stop()] }],
      [`POST /v1/payroll/stop-tasks/${TASK}/decision`]: [200, { stopId: 'st1', state: 'APPROVED', replayed: false }],
    });
    renderScreen('/payroll/holds', [STOP_READ, STOP_DECIDE]);
    const item = await screen.findByRole('listitem', { name: 'Salary stop of SYN-002 for 2026-10' });
    fireEvent.click(button(item, 'Approve Salary stop of SYN-002 for 2026-10'));
    expect(await within(item).findByText('Confirm the stop mode you approve.')).toBeTruthy();
    expect(callsTo('POST', `/v1/payroll/stop-tasks/${TASK}/decision`)).toHaveLength(0);
    fireEvent.click(within(item).getByLabelText('I approve the mode: Withhold payment (calculated, not paid)'));
    fireEvent.click(button(item, 'Approve Salary stop of SYN-002 for 2026-10'));
    expect(await screen.findByText('Salary stop of SYN-002 for 2026-10: approved.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/payroll/stop-tasks/${TASK}/decision`)).toEqual([{ decision: 'APPROVE', idempotencyKey: expect.stringMatching(/^payroll-stop-decision-/), confirmMode: 'HOLD_DISBURSEMENT' }]);
    expect(cells(rowWith(screen.getByRole('table', { name: 'Salary stops' }), 'SYN-002 Ravi Synthetic'))).toEqual(['SYN-002 Ravi Synthetic', '2026-10', 'Withhold payment (calculated, not paid)', 'Waiting for a decision', '—']);
  });

  it('releases an active hold with a reason, evidence and its version, never by its maker, and explains refusals', async () => {
    serve({
      'GET /v1/payroll/holds': [200, { items: [holdRow('h1', { state: 'APPROVED_ACTIVE', version: 3 }), holdRow('h2', { state: 'APPROVED_ACTIVE', employeeCode: 'SYN-003', proposedBy: U_ME })] }],
      'POST /v1/payroll/holds/h1/release': refusal(409, 'BANK_NOT_VERIFIED'),
    });
    renderScreen('/payroll/holds', [HOLD_READ, HOLD_RELEASE]);
    const table = await screen.findByRole('table', { name: 'Salary holds' });
    expect(cells(rowWith(table, 'SYN-001 Asha Synthetic')).slice(0, 6)).toEqual(['SYN-001 Asha Synthetic', '2026-10 revision 1', 'Salary hold', 'INR 5,000.00', 'Active: payment withheld', '15 Nov 2026']);
    fireEvent.click(button(table, 'Release the hold of SYN-003 for 2026-10'));
    const mine = screen.getByRole('form', { name: 'Release the hold of SYN-003' });
    expect(mine.textContent).toContain('You proposed this hold, so someone else releases it.');
    expect(button(mine, 'Release the hold').disabled).toBe(true);
    fireEvent.click(button(table, 'Release the hold of SYN-001 for 2026-10'));
    const form = screen.getByRole('form', { name: 'Release the hold of SYN-001' });
    fireEvent.change(within(form).getByLabelText('Reason for the release'), { target: { value: 'Synthetic asset returned' } });
    fireEvent.change(within(form).getByLabelText('Evidence reference'), { target: { value: 'SYNTH-RECEIPT-1' } });
    fireEvent.click(button(form, 'Release the hold'));
    expect(await within(form).findByText('A bank safety block is released only once a valid approved bank instruction is on record.')).toBeTruthy();
    expect(bodiesTo('POST', '/v1/payroll/holds/h1/release')).toEqual([{ reason: 'Synthetic asset returned', evidenceReference: 'SYNTH-RECEIPT-1', expectedVersion: 3 }]);
    expect((within(form).getByLabelText('Evidence reference') as HTMLInputElement).value).toBe('SYNTH-RECEIPT-1');
  });

  it('is hidden without the hold and stop read keys', () => {
    serve({});
    renderScreen('/payroll/holds', [HOLD_DECIDE]);
    expect(screen.getByText('The selected role cannot see salary holds or salary stops.')).toBeTruthy();
  });
});

// =========================================================================================================
// Shared fixtures and steps of the added screens
// =========================================================================================================

const E_1 = 'e1000000-0000-4000-8000-000000000001';
const DOC_OK = 'd0000000-0000-4000-8000-000000000001';
const DOC_PENDING = 'd0000000-0000-4000-8000-000000000002';
const DOC_UNVERIFIED = 'd0000000-0000-4000-8000-000000000003';
const IB_MINE = '42000000-0000-4000-8000-000000000001';
const IB_OTHER = '42000000-0000-4000-8000-000000000002';
const CRIT_FULL = '43000000-0000-4000-8000-000000000001';
const CRIT_PARTIAL = '43000000-0000-4000-8000-000000000002';
const CRIT_DRAFT = '43000000-0000-4000-8000-000000000003';
const REC_1 = '44000000-0000-4000-8000-000000000001';

const CALENDARS = {
  items: [
    {
      id: CALENDAR,
      code: 'MONTHLY',
      name: 'Monthly',
      currencyCode: 'INR',
      state: 'ACTIVE',
      periods: [{ id: PERIOD, periodCode: '2026-10', serviceStart: '2026-10-01', serviceEnd: '2026-10-31', paymentDate: '2026-10-31' }],
    },
  ],
};
const EMPLOYEES = { items: [{ id: E_1, employeeCode: 'SYN-001', displayName: 'Asha Synthetic', status: 'ACTIVE' }], total: 1 };
const DOCUMENTS = {
  items: [
    { id: DOC_OK, documentType: 'BANK_LETTER', fileName: 'synthetic-letter.pdf', uploadedAt: '2026-10-20T09:00:00.000Z', scanState: 'CLEAN', verificationState: 'VERIFIED' },
    { id: DOC_PENDING, documentType: 'BANK_LETTER', fileName: 'pending.pdf', uploadedAt: '2026-10-21T09:00:00.000Z', scanState: 'PENDING_SCAN', verificationState: 'UNVERIFIED' },
    { id: DOC_UNVERIFIED, documentType: 'BANK_LETTER', fileName: 'unverified.pdf', uploadedAt: '2026-10-22T09:00:00.000Z', scanState: 'CLEAN', verificationState: 'UNVERIFIED' },
  ],
};
const criterion = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  code: 'SYN_CONTRACT',
  revision: 1,
  category: 'CONTRACTUAL',
  applicability: 'Synthetic unreturned company property',
  scopeMode: 'FULL_ONLY',
  maxReviewDays: 30,
  evidenceReference: 'SYN-POLICY-1',
  validationReference: 'SYN-LEGAL-1',
  state: 'ACTIVE',
  createdBy: U_OTHER,
  activatedAt: '2026-10-01T09:00:00.000Z',
  retiredAt: null,
  version: 2,
  ...patch,
});

async function choosePeriod(scope: HTMLElement) {
  await waitFor(() => expect((within(scope).getByLabelText('Payroll calendar') as HTMLSelectElement).options).toHaveLength(2));
  fireEvent.change(within(scope).getByLabelText('Payroll calendar'), { target: { value: CALENDAR } });
  fireEvent.change(within(scope).getByLabelText('Period'), { target: { value: PERIOD } });
}
async function chooseEmployee(scope: HTMLElement, field = 'Find the employee') {
  fireEvent.change(within(scope).getByLabelText(field), { target: { value: 'Asha' } });
  fireEvent.click(await within(scope).findByRole('button', { name: 'Choose SYN-001 Asha Synthetic' }));
}
const type = (scope: HTMLElement, field: string | RegExp, value: string) => fireEvent.change(within(scope).getByLabelText(field), { target: { value } });

// =========================================================================================================
// Payroll inputs
// =========================================================================================================

const inputBatch = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  periodId: PERIOD,
  periodCode: '2026-10',
  source: 'ENTRY',
  fileHash: null,
  lineCount: 1,
  state: 'DRAFT',
  preparedBy: U_ME,
  submittedAt: null,
  decidedAt: null,
  decidedBy: null,
  createdAt: '2026-10-20T09:00:00.000Z',
  version: 2,
  ...patch,
});
const INPUT_LINE = { id: 'il1', employeeId: E_1, employeeCode: 'SYN-001', componentCode: 'OVERTIME', inputKind: 'ONE_TIME', amount: '1500.0000', currencyCode: 'INR', effectiveDate: '2026-10-15', reference: 'SYN-OT-1', source: 'ENTRY', state: 'DRAFT', consumedRecordId: null };
const INPUTS_PATH = `/v1/payroll/periods/${PERIOD}/input-batches`;

describe('payroll inputs', () => {
  it('pages the input batches with the total of every batch in scope, keeping the state filter (FR-056)', async () => {
    serve({
      'GET /v1/payroll/input-batches': (c) => [
        200,
        c.query.get('page') === '2'
          ? { items: [inputBatch('ib26', { periodCode: '2026-26' })], total: 26, page: 2, pageSize: 25 }
          : { items: Array.from({ length: 25 }, (_, i) => inputBatch(`ib${i}`, { periodCode: `2026-${i}` })), total: 26, page: 1, pageSize: 25 },
      ],
    });
    renderScreen('/payroll/inputs', [INPUT_READ]);
    await screen.findByRole('table', { name: 'Input batches' });
    expect(callsTo('GET', '/v1/payroll/input-batches')[0]?.query.toString()).toBe('page=1&pageSize=25');
    const pager = screen.getByRole('navigation', { name: 'Input batch pages' });
    expect(pager.textContent).toContain('Page 1 of 2 · 26 input batches');
    fireEvent.click(within(pager).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Input batches' })).getAllByRole('row')).toHaveLength(2));
    expect(callsTo('GET', '/v1/payroll/input-batches').at(-1)?.query.toString()).toBe('page=2&pageSize=25');
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'SUBMITTED' } });
    await waitFor(() => expect(callsTo('GET', '/v1/payroll/input-batches').at(-1)?.query.toString()).toBe('state=SUBMITTED&page=1&pageSize=25'));
  });

  it('enters lines for a period and saves them as a draft batch, resending the same key only after a lost answer', async () => {
    serve({
      'GET /v1/payroll/calendars': [200, CALENDARS],
      'GET /v1/employees': [200, EMPLOYEES],
      'GET /v1/payroll/input-batches': [200, { items: [] }],
      [`POST ${INPUTS_PATH}`]: [201, { ...inputBatch(IB_MINE), lines: [INPUT_LINE], scopeComplete: true, replayed: false }],
    });
    renderScreen('/payroll/inputs', [INPUT_READ, INPUT_PREPARE, CONFIG_READ, EMPLOYEE_LIST]);
    await choosePeriod(await screen.findByRole('group', { name: 'Input period' }));
    const form = await screen.findByRole('form', { name: 'Add an input line' });
    fireEvent.click(button(form, 'Add the line'));
    expect(within(form).getByText('Choose the employee.')).toBeTruthy();
    await chooseEmployee(form);
    type(form, 'Pay component code', 'OVERTIME');
    type(form, 'Input kind', 'ONE_TIME');
    type(form, 'Amount (INR)', '15.00.0');
    type(form, 'Effective date', '2026-10-15');
    type(form, 'Reference', 'SYN-OT-1');
    fireEvent.click(button(form, 'Add the line'));
    expect(within(form).getByText('Enter the amount as a number with at most four decimals, for example 1500.00.')).toBeTruthy();
    type(form, 'Amount (INR)', '1500.00');
    fireEvent.click(button(form, 'Add the line'));
    const lines = screen.getByRole('table', { name: 'Lines to save' });
    expect(cells(within(lines).getAllByRole('row')[1]!).slice(0, 7)).toEqual(['1', 'SYN-001 Asha Synthetic', 'OVERTIME', 'ONE_TIME', 'INR 1,500.00', '15 Oct 2026', 'SYN-OT-1']);
    lost.add(`POST ${INPUTS_PATH}`);
    fireEvent.click(screen.getByRole('button', { name: 'Save the lines as a draft batch' }));
    expect(await screen.findByText(/No answer came back, so it may or may not have been recorded\. Send the same again/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save the lines as a draft batch' }));
    expect(await screen.findByText('Saved as a draft batch of 1 line for 2026-10. Submit it for an independent approval from the list of batches.')).toBeTruthy();
    const sent = bodiesTo('POST', INPUTS_PATH);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({
      lines: [{ employeeId: E_1, componentCode: 'OVERTIME', inputKind: 'ONE_TIME', amount: '1500.00', currencyCode: 'INR', effectiveDate: '2026-10-15', reference: 'SYN-OT-1' }],
      idempotencyKey: expect.stringMatching(/^payroll-input-batch-[0-9a-f-]{36}$/),
    });
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(screen.queryByRole('table', { name: 'Lines to save' })).toBeNull();
  });

  it('downloads the published PAYROLL_INPUTS_V1 template (DF09) beside the upload’s header', async () => {
    const files = stubDownloads();
    try {
      serve({
        'GET /v1/payroll/calendars': [200, CALENDARS],
        'GET /v1/payroll/input-batches': [200, { items: [] }],
        'GET /v1/payroll/input-batches/template': fileReply('PAYROLL_INPUTS_V1.csv'),
      });
      renderScreen('/payroll/inputs', [INPUT_PREPARE, CONFIG_READ]);
      await choosePeriod(await screen.findByRole('group', { name: 'Input period' }));
      const form = await screen.findByRole('form', { name: 'Upload input lines' });
      expect(form.textContent).toContain('employee_code,component_code,input_kind,amount,currency_code,effective_date,reference');
      expect(within(form).getByText('PAYROLL_INPUTS_V1.csv: the header line only, ready to fill in.')).toBeTruthy();
      fireEvent.click(button(form, 'Download the template'));
      await waitFor(() => expect(files.click).toHaveBeenCalledTimes(1));
      expect(callsTo('GET', '/v1/payroll/input-batches/template')).toHaveLength(1);
      expect(callsTo('POST', `${INPUTS_PATH}/upload`)).toHaveLength(0);
    } finally {
      files.restore();
    }
  });

  it('checks an upload as a dry run, saves it for real with a key, and explains a quarantined or unscannable file in words', async () => {
    const content = 'employee_code,component_code,input_kind,amount,currency_code,effective_date,reference\nSYN-001,OVERTIME,ONE_TIME,1500.00,INR,2026-10-15,SYN-OT-1\n';
    const replies: Reply[] = [
      [200, { template: 'PAYROLL_INPUTS_V1', dryRun: true, total: 2, accepted: 0, rejected: 2, applied: false, replayed: false, batchId: null, errors: [{ row: 2, code: 'BATCH_REJECTED' }, { row: 3, code: 'DUPLICATE_REFERENCE' }] }],
      refusal(422, 'UPLOAD_QUARANTINED'),
      refusal(503, 'SCAN_UNAVAILABLE'),
      [200, { template: 'PAYROLL_INPUTS_V1', dryRun: false, total: 2, accepted: 2, rejected: 0, applied: true, replayed: false, batchId: IB_MINE, errors: [] }],
    ];
    serve({
      'GET /v1/payroll/calendars': [200, CALENDARS],
      'GET /v1/payroll/input-batches': [200, { items: [] }],
      [`POST ${INPUTS_PATH}/upload`]: () => replies.shift()!,
    });
    renderScreen('/payroll/inputs', [INPUT_PREPARE, CONFIG_READ]);
    await choosePeriod(await screen.findByRole('group', { name: 'Input period' }));
    const form = await screen.findByRole('form', { name: 'Upload input lines' });
    expect(form.textContent).toContain('The server scans it for malware before reading it');
    fireEvent.change(within(form).getByLabelText('CSV file'), { target: { files: [new File([content], 'inputs.csv', { type: 'text/csv' })] } });
    fireEvent.click(button(form, 'Check the file'));
    expect(await within(form).findByText('Checked only, nothing was saved: 2 rows, 0 valid, 2 refused.')).toBeTruthy();
    expect(cells(rowWith(within(form).getByRole('table', { name: 'Rows refused' }), 'Reference already used in this period'))).toEqual(['3', 'Reference already used in this period']);
    expect(bodiesTo('POST', `${INPUTS_PATH}/upload`)[0]).toEqual({ contentBase64: btoa(content), dryRun: true });
    await waitFor(() => expect(button(form, 'Check the file').disabled).toBe(false));
    fireEvent.click(button(form, 'Check the file'));
    expect(await within(form).findByText('The malware scan flagged the file as unsafe: it was quarantined and not read. Nothing was saved.')).toBeTruthy();
    await waitFor(() => expect(button(form, 'Check the file').disabled).toBe(false));
    fireEvent.click(button(form, 'Check the file'));
    expect(await within(form).findByText('The file could not be scanned for malware just now, so it was not read and nothing was saved. Try again later.')).toBeTruthy();
    fireEvent.click(within(form).getByLabelText('Check only (dry run: nothing is saved)'));
    await waitFor(() => expect(button(form, 'Upload the file').disabled).toBe(false));
    fireEvent.click(button(form, 'Upload the file'));
    expect(await within(form).findByText('Saved as a draft batch of 2 rows. Submit it for an independent approval from the list of batches.')).toBeTruthy();
    expect(bodiesTo('POST', `${INPUTS_PATH}/upload`)[3]).toEqual({ contentBase64: btoa(content), dryRun: false, idempotencyKey: expect.stringMatching(/^payroll-input-upload-/) });
    // The saved file is cleared, so the same upload is not sent again by accident.
    await waitFor(() => expect(button(form, 'Upload the file').disabled).toBe(true));
    expect((within(form).getByLabelText('CSV file') as HTMLInputElement).value).toBe('');
  });

  it('submits and cancels its own draft batch with the version, and offers neither on another preparer’s batch', async () => {
    serve({
      'GET /v1/payroll/input-batches': [200, { items: [inputBatch(IB_MINE), inputBatch(IB_OTHER, { preparedBy: U_OTHER, state: 'SUBMITTED', createdAt: '2026-10-21T09:00:00.000Z' })] }],
      [`GET /v1/payroll/input-batches/${IB_MINE}`]: [200, { ...inputBatch(IB_MINE), lines: [INPUT_LINE], scopeComplete: false }],
      [`GET /v1/payroll/input-batches/${IB_OTHER}`]: [200, { ...inputBatch(IB_OTHER, { preparedBy: U_OTHER, state: 'SUBMITTED' }), lines: [], scopeComplete: true }],
      [`POST /v1/payroll/input-batches/${IB_MINE}/submit`]: [200, { ...inputBatch(IB_MINE, { state: 'SUBMITTED' }), lines: [], scopeComplete: true }],
      [`POST /v1/payroll/input-batches/${IB_MINE}/cancel`]: refusal(403, 'NOT_PREPARER'),
    });
    renderScreen('/payroll/inputs', [INPUT_READ, INPUT_PREPARE]);
    const table = await screen.findByRole('table', { name: 'Input batches' });
    expect(cells(within(table).getAllByRole('row')[1]!).slice(0, 5)).toEqual(['2026-10', 'Entered', '1', 'Draft, not submitted', 'You']);
    fireEvent.click(button(table, 'Details of the 2026-10 batch created 21 Oct 2026'));
    const other = await screen.findByRole('region', { name: 'Input batch of 2026-10' });
    expect(other.textContent).toContain('Only its preparer submits or cancels this batch.');
    expect(within(other).queryByRole('button', { name: 'Submit for approval' })).toBeNull();
    fireEvent.click(button(table, 'Details of the 2026-10 batch created 20 Oct 2026'));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Input batch of 2026-10' }).textContent).toContain('INR 1,500.00'));
    const mine = screen.getByRole('region', { name: 'Input batch of 2026-10' });
    expect(mine.textContent).toContain('Some lines of this batch are outside your scope or are your own, so they are not shown.');
    fireEvent.click(button(mine, 'Submit for approval'));
    expect(await within(mine).findByText('Submitted for an independent approval.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/payroll/input-batches/${IB_MINE}/submit`)).toEqual([{ expectedVersion: 2 }]);
    const cancel = within(mine).getByRole('form', { name: 'Cancel this batch' });
    type(cancel, 'Reason for cancelling the batch', 'Synthetic duplicate entry');
    await waitFor(() => expect(button(cancel, 'Cancel this batch').disabled).toBe(false));
    fireEvent.click(button(cancel, 'Cancel this batch'));
    expect(await within(mine).findByText('Only the preparer of this batch submits or cancels it.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/payroll/input-batches/${IB_MINE}/cancel`)).toEqual([{ reason: 'Synthetic duplicate entry', expectedVersion: 2 }]);
  });

  describe('reversal of approved lines (DF03)', () => {
    const LINE_2 = { ...INPUT_LINE, id: 'il2', reference: 'SYN-OT-2', state: 'APPROVED' };
    const APPROVED_LINES = [{ ...INPUT_LINE, state: 'APPROVED' }, LINE_2, { ...INPUT_LINE, id: 'il3', reference: 'SYN-OT-3', state: 'APPROVED', consumedRecordId: REC_1 }, { ...INPUT_LINE, id: 'il4', reference: 'SYN-OT-4', state: 'REVERSED', reversalReason: 'Entered twice (synthetic)' }];
    const open = async (preparedBy: string) => {
      const b = inputBatch(IB_OTHER, { preparedBy, state: 'APPROVED', lineCount: 4, reversedLines: 1, decidedAt: '2026-10-22T09:00:00.000Z', version: 7 });
      serve({
        'GET /v1/payroll/input-batches': [200, { items: [b] }],
        'GET /v1/payroll/input-batches/tasks/mine': [200, { items: [] }],
        [`GET /v1/payroll/input-batches/${IB_OTHER}`]: [200, { ...b, lines: APPROVED_LINES, scopeComplete: true }],
        [`POST /v1/payroll/input-batches/${IB_OTHER}/reverse`]: refusal(409, 'RUN_IN_PROGRESS'),
      });
      renderScreen('/payroll/inputs', [INPUT_READ, INPUT_APPROVE]);
      const table = await screen.findByRole('table', { name: 'Input batches' });
      fireEvent.click(button(table, 'Details of the 2026-10 batch created 20 Oct 2026'));
      const region = await screen.findByRole('region', { name: 'Input batch of 2026-10' });
      await within(region).findByRole('table', { name: 'Lines of the 2026-10 batch' });
      return region;
    };

    it('reverses the chosen lines with a reason and the batch version, shows why the run must be returned first, and offers only unused approved lines', async () => {
      const region = await open(U_OTHER);
      // A line a processed run used, and a line already reversed (with its reason), cannot be chosen.
      expect(within(region).queryByRole('checkbox', { name: 'Reverse the line SYN-OT-3' })).toBeNull();
      expect(within(region).queryByRole('checkbox', { name: 'Reverse the line SYN-OT-4' })).toBeNull();
      expect(region.textContent).toContain('Used by a processed run');
      expect(region.textContent).toContain('Entered twice (synthetic)');
      const form = within(region).getByRole('form', { name: 'Reverse the selected lines' });
      // Nothing chosen: nothing to send.
      expect(button(form, 'Reverse the selected lines').disabled).toBe(true);
      fireEvent.click(within(region).getByRole('checkbox', { name: 'Reverse the line SYN-OT-1' }));
      fireEvent.click(within(region).getByRole('checkbox', { name: 'Reverse the line SYN-OT-2' }));
      fireEvent.click(within(region).getByRole('checkbox', { name: 'Reverse the line SYN-OT-1' }));
      // A reason is required before anything is sent.
      fireEvent.click(button(form, 'Reverse the selected lines'));
      expect(await within(form).findByText('Give a reason first.')).toBeTruthy();
      expect(callsTo('POST', `/v1/payroll/input-batches/${IB_OTHER}/reverse`)).toHaveLength(0);
      type(form, 'Reason for reversing the lines', 'Synthetic wrong amount');
      fireEvent.click(button(form, 'Reverse the selected lines'));
      expect(await within(region).findByText('A payroll run including these employees has been calculated: return it to a new draft revision first, then reverse the lines.')).toBeTruthy();
      expect(bodiesTo('POST', `/v1/payroll/input-batches/${IB_OTHER}/reverse`)).toEqual([{ inputIds: ['il2'], reason: 'Synthetic wrong amount', expectedVersion: 7 }]);
    });

    it('confirms a reversal and clears the selection', async () => {
      const region = await open(U_OTHER);
      const after = { ...inputBatch(IB_OTHER, { preparedBy: U_OTHER, state: 'APPROVED', lineCount: 4, reversedLines: 2, version: 8 }), lines: APPROVED_LINES, scopeComplete: true };
      serve({
        'GET /v1/payroll/input-batches': [200, { items: [after] }],
        'GET /v1/payroll/input-batches/tasks/mine': [200, { items: [] }],
        [`GET /v1/payroll/input-batches/${IB_OTHER}`]: [200, after],
        [`POST /v1/payroll/input-batches/${IB_OTHER}/reverse`]: [200, after],
      });
      fireEvent.click(within(region).getByRole('checkbox', { name: 'Reverse the line SYN-OT-2' }));
      const form = within(region).getByRole('form', { name: 'Reverse the selected lines' });
      type(form, 'Reason for reversing the lines', 'Synthetic wrong amount');
      fireEvent.click(button(form, 'Reverse the selected lines'));
      expect(await within(region).findByText('1 line was reversed: no calculation uses it, and a corrected line can be entered under the same reference.')).toBeTruthy();
      await waitFor(() => expect((within(region).getByRole('checkbox', { name: 'Reverse the line SYN-OT-2' }) as HTMLInputElement).checked).toBe(false));
    });

    it('does not offer the control to the batch’s preparer', async () => {
      const region = await open(U_ME);
      expect(within(region).queryByRole('form', { name: 'Reverse the selected lines' })).toBeNull();
      expect(within(region).queryByRole('checkbox', { name: 'Reverse the line SYN-OT-2' })).toBeNull();
      expect(region.textContent).toContain('You prepared this batch, so someone independent reverses its approved lines.');
    });

    it('does not offer the control to a reader without the approval duty', async () => {
      const b = inputBatch(IB_OTHER, { preparedBy: U_OTHER, state: 'APPROVED', version: 7 });
      serve({
        'GET /v1/payroll/input-batches': [200, { items: [b] }],
        [`GET /v1/payroll/input-batches/${IB_OTHER}`]: [200, { ...b, lines: APPROVED_LINES, scopeComplete: true }],
      });
      renderScreen('/payroll/inputs', [INPUT_READ]);
      fireEvent.click(button(await screen.findByRole('table', { name: 'Input batches' }), 'Details of the 2026-10 batch created 20 Oct 2026'));
      const region = await screen.findByRole('region', { name: 'Input batch of 2026-10' });
      await within(region).findByRole('table', { name: 'Lines of the 2026-10 batch' });
      expect(within(region).queryByRole('form', { name: 'Reverse the selected lines' })).toBeNull();
      expect(within(region).queryByRole('checkbox')).toBeNull();
    });
  });

  it('decides input batches from the queue with an idempotency key and never offers the preparer’s own batch', async () => {
    serve({
      'GET /v1/payroll/input-batches/tasks/mine': [200, { items: [{ taskId: TASK, batch: inputBatch(IB_OTHER, { preparedBy: U_OTHER, state: 'SUBMITTED', lineCount: 3 }) }, { taskId: TASK_2, batch: inputBatch(IB_MINE, { periodCode: '2026-11', state: 'SUBMITTED' }) }] }],
      [`POST /v1/payroll/input-tasks/${TASK}/decision`]: [200, { batchId: IB_OTHER, state: 'REJECTED', replayed: false }],
    });
    renderQueue('Payroll input batches', [INPUT_READ, INPUT_APPROVE]);
    const item = await screen.findByRole('listitem', { name: 'Input batch of 2026-10 with 3 lines' });
    const own = screen.getByRole('listitem', { name: 'Input batch of 2026-11 with 1 line' });
    expect(own.textContent).toContain('You prepared this batch, so someone else decides it.');
    expect(within(own).queryByRole('button', { name: /Approve/ })).toBeNull();
    fireEvent.click(button(item, 'Reject Input batch of 2026-10 with 3 lines'));
    expect(within(item).getByText('Give the reason for rejecting.')).toBeTruthy();
    type(item, 'Reason (needed to reject)', 'Synthetic wrong period');
    fireEvent.click(button(item, 'Reject Input batch of 2026-10 with 3 lines'));
    expect(await screen.findByText('Input batch of 2026-10 with 3 lines: rejected; none of its inputs is used.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/payroll/input-tasks/${TASK}/decision`)).toEqual([{ decision: 'REJECT', reason: 'Synthetic wrong period', idempotencyKey: expect.stringMatching(/^payroll-input-decision-/) }]);
    cleanup();
    serve({});
    renderQueue('Payroll input batches', [INPUT_APPROVE]);
    expect(screen.getByText('The selected role cannot list payroll input batches.')).toBeTruthy();
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('is hidden without the input keys', () => {
    serve({});
    renderScreen('/payroll/inputs', [RUN_STATUS]);
    expect(screen.getByText('The selected role cannot see payroll inputs.')).toBeTruthy();
  });
});

// =========================================================================================================
// Salary stop proposals, withdrawal and revocation
// =========================================================================================================

describe('salary stop proposals', () => {
  const STOPS_PATH = `/v1/payroll/periods/${PERIOD}/salary-stops`;
  const base = {
    'GET /v1/payroll/calendars': [200, CALENDARS] as Reply,
    'GET /v1/employees': [200, EMPLOYEES] as Reply,
    [`GET /v1/employees/${E_1}/documents`]: [200, DOCUMENTS] as Reply,
    'GET /v1/payroll/hold-criteria': [200, { items: [criterion(CRIT_FULL), criterion(CRIT_DRAFT, { code: 'SYN_DRAFT', state: 'DRAFT' })] }] as Reply,
    'GET /v1/payroll/holds': [200, { items: [] }] as Reply,
  };

  it('proposes withholding the payment under an active criterion with released, verified evidence only', async () => {
    serve({ ...base, [`POST ${STOPS_PATH}`]: [201, { ...stop({ employeeCode: 'SYN-001' }), replayed: false }] });
    renderScreen('/payroll/holds', [STOP_PROPOSE, HOLD_READ, CONFIG_READ, EMPLOYEE_LIST, DOCUMENT_READ]);
    const form = await screen.findByRole('form', { name: 'Propose a salary stop' });
    await choosePeriod(form);
    await chooseEmployee(form);
    await waitFor(() => expect((within(form).getByLabelText('Hold criterion') as HTMLSelectElement).options).toHaveLength(2));
    expect(((await within(form).findByLabelText(/pending\.pdf/)) as HTMLInputElement).disabled).toBe(true);
    expect((within(form).getByLabelText(/unverified\.pdf/) as HTMLInputElement).disabled).toBe(true);
    expect(within(form).getByLabelText(/pending\.pdf/).closest('label')!.textContent).toContain('waiting for the malware scan, not usable yet');
    fireEvent.click(button(form, 'Propose the salary stop'));
    expect(within(form).getByText('Withholding a payment needs an active hold criterion and the release criterion.')).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Hold criterion'), { target: { value: CRIT_FULL } });
    type(form, 'Release criterion', 'Employee reports back');
    type(form, 'Reason for the salary stop', 'Synthetic absconding case');
    type(form, 'Evidence reference', 'SYNTH-NOTICE-1');
    fireEvent.click(within(form).getByLabelText(/synthetic-letter\.pdf/));
    fireEvent.click(button(form, 'Propose the salary stop'));
    expect(await within(form).findByText('Salary stop of SYN-001 for 2026-10 proposed (Withhold payment (calculated, not paid)): it waits for an independent decision.')).toBeTruthy();
    expect(bodiesTo('POST', STOPS_PATH)).toEqual([
      {
        employeeId: E_1,
        mode: 'HOLD_DISBURSEMENT',
        criterionId: CRIT_FULL,
        releaseCriterion: 'Employee reports back',
        reason: 'Synthetic absconding case',
        evidenceReference: 'SYNTH-NOTICE-1',
        evidenceDocumentIds: [DOC_OK],
        idempotencyKey: expect.stringMatching(/^payroll-stop-[0-9a-f-]{36}$/),
      },
    ]);
    expect((within(form).getByLabelText('Reason for the salary stop') as HTMLTextAreaElement).value).toBe('');
  });

  it('needs an explicit confirmation to leave the employee out of the calculation, and then sends no criterion', async () => {
    serve({ ...base, [`POST ${STOPS_PATH}`]: refusal(409, 'STOP_EXISTS') });
    renderScreen('/payroll/holds', [STOP_PROPOSE, HOLD_READ, CONFIG_READ, EMPLOYEE_LIST, DOCUMENT_READ]);
    const form = await screen.findByRole('form', { name: 'Propose a salary stop' });
    await choosePeriod(form);
    await chooseEmployee(form);
    fireEvent.click(within(form).getByLabelText('Leave out of the calculation'));
    expect(within(form).queryByLabelText('Hold criterion')).toBeNull();
    type(form, 'Reason for the salary stop', 'Synthetic long unpaid absence');
    type(form, 'Evidence reference', 'SYNTH-NOTICE-2');
    fireEvent.click(await within(form).findByLabelText(/synthetic-letter\.pdf/));
    fireEvent.click(button(form, 'Propose the salary stop'));
    expect(within(form).getByText('Confirm that the employee is left out of the calculation.')).toBeTruthy();
    await settle();
    expect(callsTo('POST', STOPS_PATH)).toHaveLength(0);
    fireEvent.click(within(form).getByLabelText(/I confirm that the employee is left out of this period’s calculation entirely/));
    fireEvent.click(button(form, 'Propose the salary stop'));
    expect(await within(form).findByText('The employee already has a salary stop for this period.')).toBeTruthy();
    expect(bodiesTo('POST', STOPS_PATH)).toEqual([
      { employeeId: E_1, mode: 'EXCLUDE_CALCULATION', reason: 'Synthetic long unpaid absence', evidenceReference: 'SYNTH-NOTICE-2', evidenceDocumentIds: [DOC_OK], idempotencyKey: expect.any(String) },
    ]);
    expect((within(form).getByLabelText('Reason for the salary stop') as HTMLTextAreaElement).value).toBe('Synthetic long unpaid absence');
  });

  it('withdraws its own proposal and revokes an approved stop made by someone else', async () => {
    serve({
      'GET /v1/payroll/salary-stops': [200, { items: [stop({ proposedBy: U_ME }), stop({ id: 'st2', employeeCode: 'SYN-003', employeeName: 'Mira Synthetic', state: 'APPROVED', version: 4 })] }],
      'GET /v1/payroll/salary-stops/tasks/mine': [200, { items: [] }],
      'POST /v1/payroll/salary-stops/st1/withdraw': [200, stop({ state: 'WITHDRAWN' })],
      'POST /v1/payroll/salary-stops/st2/revoke': [200, stop({ id: 'st2', employeeCode: 'SYN-003', state: 'REVOKED' })],
    });
    renderScreen('/payroll/holds', [STOP_READ, STOP_PROPOSE, STOP_DECIDE]);
    const table = await screen.findByRole('table', { name: 'Salary stops' });
    fireEvent.click(button(table, 'Withdraw the salary stop of SYN-002 for 2026-10'));
    const withdraw = screen.getByRole('form', { name: 'Withdraw the salary stop of SYN-002' });
    type(withdraw, 'Why the proposal is withdrawn', 'Synthetic: employee returned');
    fireEvent.click(button(withdraw, 'Withdraw the proposal'));
    expect(await screen.findByText('The salary stop proposal of SYN-002 was withdrawn.')).toBeTruthy();
    expect(bodiesTo('POST', '/v1/payroll/salary-stops/st1/withdraw')).toEqual([{ reason: 'Synthetic: employee returned' }]);
    await waitFor(() => expect(button(table, 'Revoke the salary stop of SYN-003 for 2026-10').disabled).toBe(false));
    fireEvent.click(button(table, 'Revoke the salary stop of SYN-003 for 2026-10'));
    const revoke = screen.getByRole('form', { name: 'Revoke the salary stop of SYN-003' });
    type(revoke, 'Why the approved stop is revoked', 'Synthetic: evidence withdrawn');
    fireEvent.click(button(revoke, 'Revoke the salary stop'));
    expect(await screen.findByText('The salary stop of SYN-003 was revoked: the next calculation pays the employee as usual.')).toBeTruthy();
    expect(bodiesTo('POST', '/v1/payroll/salary-stops/st2/revoke')).toEqual([{ reason: 'Synthetic: evidence withdrawn', expectedVersion: 4 }]);
  });
});

// =========================================================================================================
// Salary stop upload (FR-031 "Upload Stop Salary", SALARY_STOPS_V1)
// =========================================================================================================

describe('salary stop upload', () => {
  const STOP_IMPORTS = '/v1/payroll/salary-stop-imports';
  const NO_BATCHES: Reply = [200, { items: [], total: 0, page: 1, pageSize: 25 }];
  const STOP_HEADER = 'period_code,employee_code,mode,criterion_code,reason,release_criterion,evidence_reference,evidence_document_ids';
  const STOP_FILE = `${STOP_HEADER}\n2026-10,SYN-001,,SYN_CONTRACT,Synthetic stop,Synthetic clearance,SYNTH-1,${DOC_OK}\n2026-10,SYN-002,EXCLUDE_CALCULATION,,Synthetic exclusion,,SYNTH-2,${DOC_OK}`;
  const stopJob = (over: Record<string, unknown> = {}) => ({
    id: 'job-s',
    state: 'PREVIEWED',
    template: 'SALARY_STOPS_V1',
    fileName: 'stops.csv',
    rowCount: 2,
    acceptedCount: 0,
    rejectedCount: 0,
    scanState: 'CLEAN',
    createdAt: '2026-10-28T09:00:00.000Z',
    rows: [
      { rowNumber: 1, businessKey: '2026-10/SYN-001', state: 'VALID', errorCode: null, proposedChanges: null },
      { rowNumber: 2, businessKey: '2026-10/SYN-002', state: 'VALID', errorCode: null, proposedChanges: null },
    ],
    ...over,
  });
  const chooseStopFile = (text: string) => fireEvent.change(screen.getByLabelText('Salary stops file'), { target: { files: [new File([text], 'stops.csv', { type: 'text/csv' })] } });

  it('FR-031: is offered next to the single stop proposal, explains the template, and puts every row problem of a rejected batch in words', async () => {
    serve({ 'GET /v1/payroll/calendars': [200, CALENDARS], 'GET /v1/payroll/hold-criteria': [200, { items: [criterion(CRIT_FULL)] }], 'GET /v1/payroll/holds': [200, { items: [] }] });
    renderScreen('/payroll/holds', [STOP_PROPOSE, HOLD_READ]);
    await screen.findByRole('form', { name: 'Propose a salary stop' });
    expect(screen.getByRole('link', { name: 'upload a file of salary stops' }).getAttribute('href')).toBe('/payroll/holds/stop-upload');
    cleanup();

    const files = stubDownloads();
    try {
      serve({
        [`GET ${STOP_IMPORTS}`]: NO_BATCHES,
        [`GET ${STOP_IMPORTS}/template`]: fileReply('SALARY_STOPS_V1.csv'),
        [`POST ${STOP_IMPORTS}`]: [
          201,
          stopJob({
            state: 'REJECTED',
            rejectedCount: 2,
            rows: [
              { rowNumber: 1, businessKey: '2026-10/SYN-001', state: 'REJECTED', errorCode: 'HOLD_CRITERION_NOT_ACTIVE', proposedChanges: null },
              { rowNumber: 2, businessKey: '2026-10/SYN-002', state: 'REJECTED', errorCode: 'NOT_A_HOLD', proposedChanges: null },
            ],
          }),
        ],
      });
      renderScreen('/payroll/holds/stop-upload', [STOP_PROPOSE]);
      const form = await screen.findByRole('form', { name: 'Upload salary stops' });
      expect(form.textContent).toContain(STOP_HEADER);
      expect(form.textContent).toContain('Every stop proposed waits for an independent decision, stop by stop, which confirms its mode; the upload approves nothing.');
      expect(form.textContent).toContain('Nothing is proposed until you commit a preview');
      fireEvent.click(button(form, 'Download the template'));
      await waitFor(() => expect(files.click).toHaveBeenCalledTimes(1));
      expect(callsTo('GET', `${STOP_IMPORTS}/template`)).toHaveLength(1);

      chooseStopFile(STOP_FILE);
      fireEvent.click(button(form, 'Validate'));
      expect(await screen.findByText(/This batch was rejected, so nothing was applied/)).toBeTruthy();
      const sent = bodiesTo('POST', STOP_IMPORTS);
      expect(sent).toEqual([{ fileName: 'stops.csv', contentBase64: expect.any(String), idempotencyKey: expect.stringMatching(/^payroll-stop-import-/) }]);
      expect(atob(sent[0]!.contentBase64 as string)).toBe(STOP_FILE);
      expect(rowWith(document.body, '2026-10/SYN-001').textContent).toContain('Withholding a payment needs the code of an active hold criterion');
      expect(rowWith(document.body, '2026-10/SYN-002').textContent).toContain('Leaving the employee out of the calculation is not a payment hold');
      expect(screen.queryByRole('button', { name: /^Propose \d/ })).toBeNull();
      expect(callsTo('POST', `${STOP_IMPORTS}/job-s/commit`)).toHaveLength(0);
    } finally {
      files.restore();
    }
  });

  it('FR-031: commits a previewed batch only on request, and says every stop proposed waits for its own independent decision', async () => {
    serve({
      [`GET ${STOP_IMPORTS}`]: NO_BATCHES,
      [`POST ${STOP_IMPORTS}`]: [201, stopJob()],
      [`POST ${STOP_IMPORTS}/job-s/commit`]: [
        200,
        stopJob({
          state: 'COMMITTED',
          acceptedCount: 2,
          rows: [
            { rowNumber: 1, businessKey: '2026-10/SYN-001', state: 'ACCEPTED', errorCode: null, proposedChanges: null },
            { rowNumber: 2, businessKey: '2026-10/SYN-002', state: 'ACCEPTED', errorCode: null, proposedChanges: null },
          ],
        }),
      ],
    });
    renderScreen('/payroll/holds/stop-upload', [STOP_PROPOSE]);
    const form = await screen.findByRole('form', { name: 'Upload salary stops' });
    chooseStopFile(STOP_FILE);
    fireEvent.click(button(form, 'Validate'));
    expect(await screen.findByText(/All 2 rows are valid/)).toBeTruthy();
    await settle();
    expect(callsTo('POST', `${STOP_IMPORTS}/job-s/commit`)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Propose 2 salary stops' }));
    expect(await screen.findByText('All 2 rows were applied.')).toBeTruthy();
    expect(
      screen.getByText('Every salary stop proposed waits for an independent decision, stop by stop: someone other than you and the employee decides each one and confirms its mode.'),
    ).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([STOP_IMPORTS, `${STOP_IMPORTS}/job-s/commit`]);
    await waitFor(() => expect(callsTo('GET', STOP_IMPORTS).length).toBeGreaterThanOrEqual(3));
  });

  it('FR-031: looks up the ids of an employee’s documents, giving the id of released, verified ones only', async () => {
    serve({ [`GET ${STOP_IMPORTS}`]: NO_BATCHES, 'GET /v1/employees': [200, EMPLOYEES], [`GET /v1/employees/${E_1}/documents`]: [200, DOCUMENTS] });
    renderScreen('/payroll/holds/stop-upload', [STOP_PROPOSE, EMPLOYEE_LIST, DOCUMENT_READ]);
    const lookup = (await screen.findByRole('heading', { name: 'Evidence document ids' })).closest('section') as HTMLElement;
    await chooseEmployee(lookup);
    const table = await within(lookup).findByRole('table', { name: 'Evidence documents and their ids' });
    expect(rowWith(table, 'Bank letter · synthetic-letter.pdf').textContent).toContain(DOC_OK);
    expect(rowWith(table, 'Bank letter · pending.pdf').textContent).not.toContain(DOC_PENDING);
    expect(rowWith(table, 'Bank letter · unverified.pdf').textContent).toContain('released, not verified yet, not usable');
    expect(rowWith(table, 'Bank letter · unverified.pdf').textContent).not.toContain(DOC_UNVERIFIED);
  });

  it('FR-031: offers the upload only with the stop proposal grant, and asks the server nothing without it', async () => {
    serve({});
    renderScreen('/payroll/holds/stop-upload', [STOP_READ, STOP_DECIDE]);
    expect(screen.getByText('The selected role cannot propose salary stops: that needs the salary stop proposal grant.')).toBeTruthy();
    await settle();
    expect(calls).toHaveLength(0);
  });
});

// =========================================================================================================
// Hold proposals, criteria, withdrawal, renewal and the hold position
// =========================================================================================================

describe('hold proposals and criteria', () => {
  const processed = runDetail({ ...CALCULATED, state: 'PROCESSED_LOCKED', processedAt: '2026-10-28T08:00:00.000Z', lockVersion: 1 });
  const record = {
    id: REC_1,
    employeeId: E_1,
    employeeCode: 'SYN-001',
    employeeName: 'Asha Synthetic',
    calculationStatus: 'CALCULATED',
    paidUnits: '31.0000',
    currencyCode: 'INR',
    gross: '47000.0000',
    deductions: '3100.0000',
    net: '43900.0000',
    priorNet: null,
    salaryStopMode: null,
    bankStatus: 'VALID',
    exceptions: [],
  };

  it('proposes a partial hold from a processed record within the criterion’s rules, with the hold position as returned', async () => {
    const replies: Reply[] = [refusal(422, 'HOLD_EXCEEDS_UNRESERVED'), [201, { ...holdRow('h9', { employeeCode: 'SYN-001', holdAmount: '5000.0000' }), replayed: false }]];
    serve({
      [`GET ${RUN_PATH}`]: [200, processed],
      [`GET ${RUN_PATH}/records`]: [200, { items: [record], nextAfter: null }],
      [`GET ${RUN_PATH}/components`]: [200, { runId: RUN, basis: 'RUN', priorPeriodCode: null, items: [] }],
      'GET /v1/payroll/hold-criteria': [200, { items: [criterion(CRIT_FULL), criterion(CRIT_PARTIAL, { code: 'SYN_DISCIPLINE', category: 'LEGAL_DISCIPLINARY', scopeMode: 'FULL_OR_PARTIAL' })] }],
      [`GET /v1/payroll/records/${REC_1}/hold-balance`]: [200, { recordId: REC_1, payable: '43900.0000', held: '0.0000', unreserved: '43900.0000', currencyCode: 'INR' }],
      [`GET /v1/employees/${E_1}/documents`]: [200, DOCUMENTS],
      [`POST /v1/payroll/records/${REC_1}/holds`]: () => replies.shift()!,
    });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, RUN_AMOUNT, HOLD_READ, HOLD_PROPOSE, DOCUMENT_READ]);
    const members = await screen.findByRole('table', { name: 'Run members' });
    fireEvent.click(button(members, 'Salary hold of SYN-001'));
    const panel = screen.getByRole('region', { name: 'Salary hold position of SYN-001' });
    await waitFor(() => expect(within(panel).getByLabelText('Hold position').textContent).toContain('Unpaid and unreservedINR 43,900.00'));
    const form = within(panel).getByRole('form', { name: 'Propose a hold for SYN-001' });
    await waitFor(() => expect((within(form).getByLabelText('Hold criterion') as HTMLSelectElement).options).toHaveLength(3));
    fireEvent.change(within(form).getByLabelText('Hold criterion'), { target: { value: CRIT_FULL } });
    expect((within(form).getByLabelText('Part of it') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('Hold criterion'), { target: { value: CRIT_PARTIAL } });
    fireEvent.click(within(form).getByLabelText('Part of it'));
    type(form, 'Amount to hold (INR)', '0.00');
    type(form, 'Effective date', '2026-10-28');
    type(form, 'Review date', '2026-11-20');
    type(form, 'Reason for the hold', 'Synthetic disciplinary inquiry');
    type(form, 'Release criterion', 'Inquiry closed');
    type(form, 'Evidence reference', 'SYNTH-INQ-1');
    fireEvent.click(await within(form).findByLabelText(/synthetic-letter\.pdf/));
    fireEvent.click(button(form, 'Propose the hold'));
    expect(within(form).getByText('Enter the amount to hold: above zero, with at most four decimals.')).toBeTruthy();
    type(form, 'Amount to hold (INR)', '50000.00');
    fireEvent.click(button(form, 'Propose the hold'));
    expect(await within(form).findByText('A hold is at most the unpaid, unreserved amount of the record.')).toBeTruthy();
    expect((within(form).getByLabelText('Amount to hold (INR)') as HTMLInputElement).value).toBe('50000.00');
    type(form, 'Amount to hold (INR)', '5000.00');
    await waitFor(() => expect(button(form, 'Propose the hold').disabled).toBe(false));
    fireEvent.click(button(form, 'Propose the hold'));
    expect(await within(form).findByText('Hold proposed for SYN-001: INR 5,000.00 is kept out of bank files while it waits for an independent decision.')).toBeTruthy();
    const sent = bodiesTo('POST', `/v1/payroll/records/${REC_1}/holds`);
    expect(sent[1]).toEqual({
      criterionId: CRIT_PARTIAL,
      scope: 'PARTIAL',
      amount: '5000.00',
      reason: 'Synthetic disciplinary inquiry',
      effectiveDate: '2026-10-28',
      reviewDueOn: '2026-11-20',
      releaseCriterion: 'Inquiry closed',
      evidenceReference: 'SYNTH-INQ-1',
      evidenceDocumentIds: [DOC_OK],
      idempotencyKey: expect.stringMatching(/^payroll-hold-[0-9a-f-]{36}$/),
    });
    // A changed proposal after a definite refusal is a new intended action with a new key.
    expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
  });

  it('offers no hold column without the hold keys, and a full hold sends no amount', async () => {
    serve({
      [`GET ${RUN_PATH}`]: [200, processed],
      [`GET ${RUN_PATH}/records`]: [200, { items: [record], nextAfter: null }],
      [`GET ${RUN_PATH}/components`]: [200, { runId: RUN, basis: 'RUN', priorPeriodCode: null, items: [] }],
    });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, RUN_AMOUNT]);
    const members = await screen.findByRole('table', { name: 'Run members' });
    expect(within(members).queryByRole('button', { name: 'Salary hold of SYN-001' })).toBeNull();
    await settle();
    expect(calls.some((c) => c.path.includes('hold'))).toBe(false);
  });

  it('withdraws its own proposal, renews an expired review made by someone else, and shows a hold’s record position as returned', async () => {
    serve({
      'GET /v1/payroll/holds/tasks/mine': [200, { items: [] }],
      'GET /v1/payroll/hold-criteria': [200, { items: [] }],
      'GET /v1/payroll/holds': [200, { items: [holdRow('h1', { proposedBy: U_ME }), holdRow('h2', { employeeCode: 'SYN-003', state: 'EXPIRED_REVIEW', version: 5 })] }],
      'POST /v1/payroll/holds/h1/withdraw': [200, holdRow('h1', { state: 'WITHDRAWN' })],
      'POST /v1/payroll/holds/h2/renew-review': [200, holdRow('h2', { reviewDueOn: '2026-11-25' })],
      'GET /v1/payroll/holds/h2': [200, { ...holdRow('h2', { employeeCode: 'SYN-003', state: 'EXPIRED_REVIEW' }), record: { payable: '43900.0000', held: '5000.0000', unreserved: '38900.0000', currencyCode: 'INR' } }],
    });
    renderScreen('/payroll/holds', [HOLD_READ, HOLD_PROPOSE, HOLD_DECIDE]);
    const table = await screen.findByRole('table', { name: 'Salary holds' });
    expect(within(table).queryByRole('button', { name: 'Withdraw the hold proposal of SYN-003 for 2026-10' })).toBeNull();
    expect(within(table).queryByRole('button', { name: 'Renew the review of the hold of SYN-001 for 2026-10' })).toBeNull();
    fireEvent.click(button(table, 'Withdraw the hold proposal of SYN-001 for 2026-10'));
    const withdraw = screen.getByRole('form', { name: 'Withdraw the hold proposal of SYN-001' });
    type(withdraw, 'Why the proposal is withdrawn', 'Synthetic: asset returned');
    fireEvent.click(button(withdraw, 'Withdraw the proposal'));
    expect(await screen.findByText('The hold proposal of SYN-001 was withdrawn: nothing is withheld for it.')).toBeTruthy();
    expect(bodiesTo('POST', '/v1/payroll/holds/h1/withdraw')).toEqual([{ reason: 'Synthetic: asset returned' }]);
    fireEvent.click(button(table, 'Renew the review of the hold of SYN-003 for 2026-10'));
    const renew = screen.getByRole('form', { name: 'Renew the review of the hold of SYN-003' });
    fireEvent.click(button(renew, 'Renew the review'));
    expect(within(renew).getByText('Give the new review date and the reason.')).toBeTruthy();
    type(renew, 'New review date', '2026-11-25');
    type(renew, 'Why the hold continues', 'Synthetic: inquiry still open');
    fireEvent.click(button(renew, 'Renew the review'));
    expect(await screen.findByText('The review of the hold of SYN-003 is renewed until 25 Nov 2026; the payment stays withheld.')).toBeTruthy();
    expect(bodiesTo('POST', '/v1/payroll/holds/h2/renew-review')).toEqual([{ reviewDueOn: '2026-11-25', reason: 'Synthetic: inquiry still open', expectedVersion: 5 }]);
    fireEvent.click(button(table, 'Details of the hold of SYN-003 for 2026-10'));
    const detail = await screen.findByRole('region', { name: 'Hold of SYN-003 for 2026-10' });
    await waitFor(() => expect(within(detail).getByLabelText('Hold position of the record').textContent).toContain('Held by live holdsINR 5,000.00'));
    expect(within(detail).getByLabelText('Hold position of the record').textContent).toContain('Unpaid and unreservedINR 38,900.00');
  });

  it('lists hold criteria read only without the manage keys, and activates, retires and defines them with the keys', async () => {
    const items = [criterion(CRIT_FULL), criterion(CRIT_DRAFT, { code: 'SYN_NEW', state: 'DRAFT', version: 1 }), criterion(CRIT_PARTIAL, { code: 'SYN_MINE', state: 'DRAFT', createdBy: U_ME })];
    serve({ 'GET /v1/payroll/hold-criteria': [200, { items }], 'GET /v1/payroll/holds': [200, { items: [] }] });
    renderScreen('/payroll/holds', [HOLD_READ]);
    let list = await section('Hold criteria');
    await within(list).findByRole('table', { name: 'Hold criteria' });
    expect(list.textContent).toContain('Read only for the selected role.');
    expect(within(list).queryByRole('button', { name: /Activate/ })).toBeNull();
    expect(within(list).queryByRole('form', { name: 'Define a hold criterion' })).toBeNull();
    cleanup();
    serve({
      'GET /v1/payroll/hold-criteria': [200, { items }],
      'GET /v1/payroll/holds': [200, { items: [] }],
      [`POST /v1/payroll/hold-criteria/${CRIT_DRAFT}/activate`]: [200, criterion(CRIT_DRAFT, { code: 'SYN_NEW' })],
      [`POST /v1/payroll/hold-criteria/${CRIT_FULL}/retire`]: [200, criterion(CRIT_FULL, { state: 'RETIRED' })],
      'POST /v1/payroll/hold-criteria': refusal(422, 'NOT_A_HOLD_CRITERION'),
    });
    renderScreen('/payroll/holds', [HOLD_READ, HOLD_ACTIVATE, HOLD_DEFINE]);
    list = await section('Hold criteria');
    const table = await within(list).findByRole('table', { name: 'Hold criteria' });
    expect(rowWith(table, 'SYN_MINE').textContent).toContain('You wrote it: someone else activates it');
    fireEvent.click(button(table, 'Activate criterion SYN_NEW revision 1'));
    expect(await within(list).findByText('Criterion SYN_NEW revision 1 is active: holds may now cite it.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/payroll/hold-criteria/${CRIT_DRAFT}/activate`)).toEqual([{ expectedVersion: 1 }]);
    await waitFor(() => expect(button(table, 'Retire criterion SYN_CONTRACT revision 1').disabled).toBe(false));
    fireEvent.click(button(table, 'Retire criterion SYN_CONTRACT revision 1'));
    const retire = within(list).getByRole('form', { name: 'Retire criterion SYN_CONTRACT' });
    type(retire, 'Why the criterion is retired', 'Synthetic policy withdrawn');
    fireEvent.click(button(retire, 'Retire the criterion'));
    expect(await within(list).findByText('Criterion SYN_CONTRACT revision 1 was retired: no new hold cites it.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/payroll/hold-criteria/${CRIT_FULL}/retire`)).toEqual([{ reason: 'Synthetic policy withdrawn', expectedVersion: 2 }]);
    const define = within(list).getByRole('form', { name: 'Define a hold criterion' });
    type(define, 'Criterion code', 'missing_timesheet');
    type(define, 'When the criterion applies', 'Synthetic');
    // Nothing is prefilled: the category and the partial-hold choice must be made.
    expect((within(define).getByLabelText('Category') as HTMLSelectElement).value).toBe('');
    expect((within(define).getByLabelText('Holds allowed') as HTMLSelectElement).value).toBe('');
    fireEvent.click(button(define, 'Save the criterion as a draft'));
    expect(within(define).getByText('Choose the category and whether partial holds are allowed.')).toBeTruthy();
    type(define, 'Category', 'CONTRACTUAL');
    type(define, 'Holds allowed', 'FULL_ONLY');
    type(define, 'Longest review interval (days)', '400');
    type(define, 'Evidence reference', 'SYN-POLICY-2');
    type(define, 'Validation reference', 'SYN-LEGAL-2');
    fireEvent.click(button(define, 'Save the criterion as a draft'));
    expect(within(define).getByText('The longest review interval is 1 to 366 days.')).toBeTruthy();
    type(define, 'Longest review interval (days)', '30');
    fireEvent.click(button(define, 'Save the criterion as a draft'));
    expect(await within(define).findByText(/This situation is never a salary hold criterion/)).toBeTruthy();
    expect(bodiesTo('POST', '/v1/payroll/hold-criteria')).toEqual([
      { code: 'MISSING_TIMESHEET', category: 'CONTRACTUAL', applicability: 'Synthetic', scopeMode: 'FULL_ONLY', maxReviewDays: 30, evidenceReference: 'SYN-POLICY-2', validationReference: 'SYN-LEGAL-2' },
    ]);
  });

  it('FR-101: shows each criterion’s escalation cadence and lets the definer only shorten the H2 defaults of 2 and 5 business days', async () => {
    const items = [criterion(CRIT_FULL), criterion(CRIT_PARTIAL, { code: 'SYN_FAST', firstEscalationBusinessDays: 1, escalationIntervalBusinessDays: 2 })];
    serve({
      'GET /v1/payroll/hold-criteria': [200, { items }],
      'GET /v1/payroll/holds': [200, { items: [] }],
      'POST /v1/payroll/hold-criteria': [201, criterion(CRIT_DRAFT, { code: 'SYN_QUICK', state: 'DRAFT', firstEscalationBusinessDays: 1, escalationIntervalBusinessDays: 3 })],
    });
    renderScreen('/payroll/holds', [HOLD_READ, HOLD_DEFINE]);
    const list = await section('Hold criteria');
    const table = await within(list).findByRole('table', { name: 'Hold criteria' });
    expect(rowWith(table, 'SYN_CONTRACT').textContent).toContain('After 2, then every 5 business days (default)');
    expect(rowWith(table, 'SYN_FAST').textContent).toContain('After 1, then every 2 business days (narrowed)');
    const define = within(list).getByRole('form', { name: 'Define a hold criterion' });
    // Only shorter values than the defaults can be chosen.
    expect(Array.from((within(define).getByLabelText('First escalation after (business days)') as HTMLSelectElement).options).map((o) => o.value)).toEqual(['', '1']);
    expect(Array.from((within(define).getByLabelText('Then escalate every (business days)') as HTMLSelectElement).options).map((o) => o.value)).toEqual(['', '1', '2', '3', '4']);
    type(define, 'Criterion code', 'syn_quick');
    type(define, 'When the criterion applies', 'Synthetic');
    type(define, 'Category', 'CONTRACTUAL');
    type(define, 'Holds allowed', 'FULL_ONLY');
    type(define, 'Longest review interval (days)', '30');
    type(define, 'First escalation after (business days)', '1');
    type(define, 'Then escalate every (business days)', '3');
    type(define, 'Evidence reference', 'SYN-POLICY-3');
    type(define, 'Validation reference', 'SYN-LEGAL-3');
    fireEvent.click(button(define, 'Save the criterion as a draft'));
    expect(await within(define).findByText('Criterion SYN_QUICK revision 1 saved as a draft: someone other than you activates it.')).toBeTruthy();
    expect(bodiesTo('POST', '/v1/payroll/hold-criteria')).toEqual([
      {
        code: 'SYN_QUICK',
        category: 'CONTRACTUAL',
        applicability: 'Synthetic',
        scopeMode: 'FULL_ONLY',
        maxReviewDays: 30,
        firstEscalationBusinessDays: 1,
        escalationIntervalBusinessDays: 3,
        evidenceReference: 'SYN-POLICY-3',
        validationReference: 'SYN-LEGAL-3',
      },
    ]);
  });
});

// =========================================================================================================
// Bank file templates
// =========================================================================================================

const template = (patch: Record<string, unknown> = {}) => ({
  id: TEMPLATE,
  templateCode: 'SYN_BANK',
  templateVersion: 2,
  name: 'Synthetic bank',
  currencyCode: 'INR',
  formatDefinition: {
    layout: 'DELIMITED',
    delimiter: 'COMMA',
    lineEnding: 'CRLF',
    amountDecimals: 2,
    decimalSeparator: '.',
    dateFormat: 'YYYY-MM-DD',
    fileExtension: 'csv',
    detail: [{ source: 'ACCOUNT_IDENTIFIER', maxLength: 34 }, { source: 'AMOUNT' }, { source: 'LITERAL', value: 'SAL' }],
  },
  definitionHash: 'c'.repeat(64),
  bankSpecificationReference: 'SYN-BANK-SPEC-7',
  testOnly: true,
  state: 'DRAFT',
  sampleHash: null,
  sampleValidationReference: null,
  sampleValidatedBy: null,
  sampleValidatedAt: null,
  activatedBy: null,
  activatedAt: null,
  closedAt: null,
  closeReason: null,
  createdBy: U_OTHER,
  createdAt: '2026-10-25T09:00:00.000Z',
  version: 1,
  ...patch,
});
const TEMPLATE_PATH = `/v1/payroll-outputs/bank-templates/${TEMPLATE}`;

describe('bank file templates', () => {
  it('creates a version with an ordered delimited field mapping and the bank specification reference', async () => {
    serve({
      'GET /v1/payroll-outputs/bank-templates': [200, { items: [] }],
      'POST /v1/payroll-outputs/bank-templates': [201, template({ templateVersion: 3, createdBy: U_ME })],
    });
    renderScreen('/payroll/bank-templates', [TEMPLATE_READ, TEMPLATE_MANAGE]);
    const form = await screen.findByRole('form', { name: 'Bank file template' });
    type(form, 'Template code', 'syn_bank');
    type(form, 'Template name', 'Synthetic bank');
    type(form, 'Currency', 'inr');
    type(form, 'Bank specification reference', 'SYN-BANK-SPEC-7');
    fireEvent.click(within(form).getByLabelText('Test only (synthetic; refused in production)'));
    fireEvent.change(within(form).getByLabelText('Delimiter'), { target: { value: 'PIPE' } });
    const add = button(form, 'Add a detail field');
    fireEvent.click(add);
    fireEvent.click(add);
    fireEvent.click(add);
    fireEvent.change(within(form).getByLabelText('Detail field 1'), { target: { value: 'AMOUNT' } });
    fireEvent.change(within(form).getByLabelText('Detail field 2'), { target: { value: 'LITERAL' } });
    fireEvent.click(button(form, 'Save as a draft version'));
    expect(within(form).getByText('The detail record must carry the amount and the account identifier.')).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Detail field 3'), { target: { value: 'ACCOUNT_IDENTIFIER' } });
    fireEvent.click(button(form, 'Save as a draft version'));
    expect(within(form).getByText('Every fixed-text field needs its text.')).toBeTruthy();
    type(form, 'Detail field 2 text', 'SAL');
    type(form, 'Detail field 3 maximum length', '34');
    fireEvent.click(button(form, 'Move detail field 3 up'));
    fireEvent.click(within(form).getByLabelText('Trailer record'));
    fireEvent.click(button(form, 'Add a trailer field'));
    fireEvent.change(within(form).getByLabelText('Trailer field 1'), { target: { value: 'RECORD_COUNT' } });
    fireEvent.click(button(form, 'Save as a draft version'));
    expect(await within(form).findByText(/Template SYN_BANK version 3 saved as a draft\. Someone other than you validates its sample/)).toBeTruthy();
    expect(bodiesTo('POST', '/v1/payroll-outputs/bank-templates')).toEqual([
      {
        templateCode: 'SYN_BANK',
        name: 'Synthetic bank',
        currencyCode: 'INR',
        bankSpecificationReference: 'SYN-BANK-SPEC-7',
        testOnly: true,
        formatDefinition: {
          layout: 'DELIMITED',
          delimiter: 'PIPE',
          lineEnding: 'CRLF',
          amountDecimals: 2,
          decimalSeparator: '.',
          dateFormat: 'YYYY-MM-DD',
          fileExtension: 'csv',
          detail: [{ source: 'AMOUNT' }, { source: 'ACCOUNT_IDENTIFIER', maxLength: 34 }, { source: 'LITERAL', value: 'SAL' }],
          trailer: [{ source: 'RECORD_COUNT' }],
        },
      },
    ]);
    expect((within(form).getByLabelText('Template code') as HTMLInputElement).value).toBe('');
  });

  it('validates the system-generated sample independently, then activates; a test-only template is refused in production in words', async () => {
    let validated = false;
    serve({
      'GET /v1/payroll-outputs/bank-templates': [200, { items: [template()] }],
      [`GET ${TEMPLATE_PATH}`]: () => [200, template(validated ? { sampleHash: 'a'.repeat(64), sampleValidatedAt: '2026-10-28T09:00:00.000Z', sampleValidationReference: 'SYN-CHECK-1', version: 2 } : {})],
      [`GET ${TEMPLATE_PATH}/sample`]: [200, { label: 'SAMPLE_NOT_PAYABLE', templateCode: 'SYN_BANK', templateVersion: 2, fileName: 'sample-SYN_BANK-v2.csv', content: 'SYNACC0001,100.00,SAL', sampleHash: 'a'.repeat(64), errors: [] }],
      [`POST ${TEMPLATE_PATH}/sample-validation`]: () => {
        validated = true;
        return [200, template({ sampleHash: 'a'.repeat(64), version: 2 })];
      },
      [`POST ${TEMPLATE_PATH}/activate`]: refusal(409, 'TEST_TEMPLATE_NOT_ACTIVATABLE'),
    });
    renderScreen('/payroll/bank-templates', [TEMPLATE_READ, TEMPLATE_VALIDATE, TEMPLATE_ACTIVATE]);
    const table = await screen.findByRole('table', { name: 'Bank file templates' });
    expect(cells(within(table).getAllByRole('row')[1]!).slice(0, 6)).toEqual(['SYN_BANK version 2', 'Synthetic bank', 'INR', 'Test only: never for real payments', 'Draft, not in use', 'Not yet']);
    fireEvent.click(button(table, 'Details of template SYN_BANK version 2'));
    const view = await section('Template SYN_BANK version 2');
    expect(view.textContent).toContain('This is a test-only template: it is refused in production, so it is never used for real payments.');
    expect(within(view).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Account identifier (at most 34 characters)', 'Amount', 'Fixed text “SAL”']);
    const validate = within(view).getByRole('form', { name: 'Validate the sample' });
    expect(button(validate, 'Record the sample as validated').disabled).toBe(true);
    expect(button(view, 'Activate this template').disabled).toBe(true);
    fireEvent.click(button(view, 'Show the sample file'));
    const sample = await within(view).findByRole('region', { name: 'Sample file' });
    expect(sample.textContent).toContain('Sample: not payable');
    expect(sample.textContent).toContain('SYNACC0001,100.00,SAL');
    type(validate, 'Validation reference', 'SYN-CHECK-1');
    await waitFor(() => expect(button(validate, 'Record the sample as validated').disabled).toBe(false));
    fireEvent.click(button(validate, 'Record the sample as validated'));
    expect(await within(view).findByText(/The sample is recorded as validated against the bank’s specification/)).toBeTruthy();
    expect(bodiesTo('POST', `${TEMPLATE_PATH}/sample-validation`)).toEqual([{ sampleHash: 'a'.repeat(64), validationReference: 'SYN-CHECK-1', expectedVersion: 1 }]);
    await waitFor(() => expect(button(view, 'Activate this template').disabled).toBe(false));
    fireEvent.click(button(view, 'Activate this template'));
    expect(await within(view).findByText('A test-only template is never used in production.')).toBeTruthy();
    expect(bodiesTo('POST', `${TEMPLATE_PATH}/activate`)).toEqual([{ expectedVersion: 2 }]);
  });

  it('keeps the author from validating or activating, retires an active template with a reason, and is hidden without its key', async () => {
    serve({
      'GET /v1/payroll-outputs/bank-templates': [200, { items: [template({ createdBy: U_ME })] }],
      [`GET ${TEMPLATE_PATH}`]: [200, template({ createdBy: U_ME })],
    });
    renderScreen('/payroll/bank-templates', [TEMPLATE_READ, TEMPLATE_VALIDATE, TEMPLATE_ACTIVATE]);
    fireEvent.click(button(await screen.findByRole('table', { name: 'Bank file templates' }), 'Details of template SYN_BANK version 2'));
    let view = await section('Template SYN_BANK version 2');
    expect(view.textContent).toContain('You wrote this template, so someone else validates its sample.');
    expect(view.textContent).toContain('You wrote this template, so someone else activates it.');
    expect(button(view, 'Activate this template').disabled).toBe(true);
    cleanup();
    serve({
      'GET /v1/payroll-outputs/bank-templates': [200, { items: [template({ state: 'ACTIVE', testOnly: false, version: 3 })] }],
      [`GET ${TEMPLATE_PATH}`]: [200, template({ state: 'ACTIVE', testOnly: false, version: 3 })],
      [`POST ${TEMPLATE_PATH}/retire`]: [200, template({ state: 'RETIRED', testOnly: false })],
    });
    renderScreen('/payroll/bank-templates', [TEMPLATE_READ, TEMPLATE_MANAGE]);
    fireEvent.click(button(await screen.findByRole('table', { name: 'Bank file templates' }), 'Details of template SYN_BANK version 2'));
    view = await section('Template SYN_BANK version 2');
    expect(within(view).queryByRole('button', { name: 'Activate this template' })).toBeNull();
    const retire = within(view).getByRole('form', { name: 'Retire this template' });
    type(retire, 'Why the template is retired', 'Synthetic bank changed its format');
    fireEvent.click(button(retire, 'Retire this template'));
    expect(await within(view).findByText('The template was retired: it is no longer used for new manifests.')).toBeTruthy();
    expect(bodiesTo('POST', `${TEMPLATE_PATH}/retire`)).toEqual([{ reason: 'Synthetic bank changed its format', expectedVersion: 3 }]);
    cleanup();
    serve({});
    renderScreen('/payroll/bank-templates', [BANK_READ]);
    expect(screen.getByText('The selected role cannot see bank file templates.')).toBeTruthy();
  });
});

// =========================================================================================================
// Reports and statutory outputs
// =========================================================================================================

describe('payroll reports', () => {
  const header = { id: RUN, periodCode: '2026-10', revision: 1, state: 'PROCESSED_LOCKED', currencyCode: 'INR', lockVersion: 1, processedAt: '2026-10-28T08:00:00.000Z' };

  it('shows the register, the reconciliation and the comparison exactly as returned, and the JV as not configured', async () => {
    serve({
      [`GET /v1/payroll-outputs/runs/${RUN}/register`]: [
        200,
        {
          run: header,
          scope: 'ROW_SCOPE',
          totals: { records: 1, earnings: '47000.0000', reimbursements: '0.0000', deductions: '3100.0000', net: '43900.0000', employerContributions: '1800.0000', held: '5000.0000', reserved: '38900.0000', paid: '0.0000' },
          items: [
            { recordId: REC_1, employeeId: E_1, employeeCode: 'SYN-001', employeeName: 'Asha Synthetic', calculationStatus: 'CALCULATED', paidUnits: '31.0000', earnings: '47000.0000', reimbursements: '0.0000', deductions: '3100.0000', net: '43900.0000', employerContributions: '1800.0000', bankStatus: 'VALID', held: '5000.0000', reserved: '38900.0000', paid: '0.0000' },
          ],
          next: null,
        },
      ],
      [`GET /v1/payroll-outputs/runs/${RUN}/disbursement`]: [
        200,
        {
          run: header,
          totals: { payable: '43900.0000', held: '5000.0000', reserved: '38900.0000', paid: '0.0000', ready: '0.0000', reconciles: true },
          manifests: [{ id: BATCH, templateCode: 'SYN_BANK', templateVersion: 2, batchRevision: 1, state: 'AUTHORIZED', lineCount: 1, totalAmount: '38900.0000', contentHash: null, excluded: null, ledger: [{ paymentState: 'RESERVED', lines: 1, amount: '38900.0000' }] }],
          paymentStatusSource: 'RECORDED_OUTCOME_EVIDENCE_ONLY',
        },
      ],
      [`GET /v1/payroll-outputs/runs/${RUN}/comparison`]: [200, { runId: RUN, basis: 'RUN', priorPeriodCode: '2026-09', items: [{ componentCode: 'BASIC', headType: 'EARNING', current: '30000.0000', prior: '29000.0000', difference: '1000.0000' }] }],
      [`GET /v1/payroll-outputs/runs/${RUN}/journal`]: refusal(409, 'NOT_CONFIGURED', 'No chart mapping', { code: 'JV_CHART_MAPPING_NOT_CONFIGURED' }),
    });
    renderScreen(`/payroll/runs/${RUN}/reports`, [REPORT_READ]);
    const register = await section('Payroll register');
    await waitFor(() => expect(within(register).getByLabelText('Register totals').textContent).toContain('NetINR 43,900.00'));
    expect(register.textContent).toContain('Only the records within your scope are listed and totalled.');
    expect(within(register).getByLabelText('Register totals').textContent).toContain('Paid (confirmed from bank evidence)INR 0.00');
    expect(cells(rowWith(within(register).getByRole('table', { name: 'Payroll register' }), 'SYN-001 Asha Synthetic'))).toEqual([
      'SYN-001 Asha Synthetic',
      'Calculated',
      '—',
      '31.0000',
      'INR 47,000.00',
      'INR 3,100.00',
      'INR 43,900.00',
      'INR 5,000.00',
      'INR 38,900.00',
      'INR 0.00',
      'Valid',
    ]);
    const disbursement = await section('Disbursement reconciliation');
    await waitFor(() => expect(disbursement.textContent).toContain('Yes: payable equals held, reserved, paid and ready'));
    // No stop in this run: nothing is said about stops.
    expect(disbursement.textContent).not.toContain('salary stop');
    expect(cells(rowWith(within(disbursement).getByRole('table', { name: 'Manifests of the run' }), 'SYN_BANK version 2'))[5]).toBe('Reserved, not paid: 1 line, INR 38,900.00');
    expect(disbursement.textContent).not.toContain('Paid: confirmed');
    const comparison = await section('Prior-period comparison');
    await waitFor(() => expect(cells(rowWith(within(comparison).getByRole('table', { name: 'Prior-period comparison' }), 'BASIC'))).toEqual(['BASIC', 'Earning', 'INR 30,000.00', 'INR 29,000.00', 'INR 1,000.00']));
    const jv = await section('Journal voucher');
    await waitFor(() => expect(jv.textContent).toContain('Not configured'));
    expect(jv.textContent).toContain('A journal voucher needs an approved chart-of-accounts mapping for the payroll heads.');
    expect(callsTo('GET', `/v1/payroll-outputs/runs/${RUN}/register`)).toHaveLength(1);
    // Reading is not exporting: no export without the export key.
    expect(screen.queryByRole('form', { name: /^Export the / })).toBeNull();
  });

  it('shows how salary stops were read: withheld apart from other holds, excluded by name, the mode per record (FR-031)', async () => {
    serve({
      [`GET /v1/payroll-outputs/runs/${RUN}/register`]: [
        200,
        {
          run: header,
          scope: 'COMPANY',
          totals: { records: 2, earnings: '30000.0000', reimbursements: '0.0000', deductions: '0.0000', net: '30000.0000', employerContributions: '0.0000', held: '30000.0000', reserved: '0.0000', paid: '0.0000' },
          items: [
            { recordId: REC_1, employeeId: E_1, employeeCode: 'SYN-001', employeeName: 'Asha Synthetic', calculationStatus: 'CALCULATED', salaryStopMode: 'HOLD_DISBURSEMENT', paidUnits: '31.0000', earnings: '30000.0000', reimbursements: '0.0000', deductions: '0.0000', net: '30000.0000', employerContributions: '0.0000', bankStatus: 'VALID', held: '30000.0000', reserved: '0.0000', paid: '0.0000' },
          ],
          next: null,
        },
      ],
      [`GET /v1/payroll-outputs/runs/${RUN}/disbursement`]: [
        200,
        {
          run: header,
          totals: { payable: '30000.0000', held: '35000.0000', heldBySalaryStop: '30000.0000', salaryStopHolds: 1, excludedBySalaryStop: 1, reserved: '0.0000', paid: '0.0000', ready: '0.0000', reconciles: true },
          salaryStopExclusions: [{ employeeCode: 'SYN-002', employeeName: 'Ravi Synthetic', mode: 'EXCLUDE_CALCULATION' }],
          manifests: [],
          paymentStatusSource: 'RECORDED_OUTCOME_EVIDENCE_ONLY',
        },
      ],
      [`GET /v1/payroll-outputs/runs/${RUN}/comparison`]: [200, { runId: RUN, basis: 'RUN', priorPeriodCode: null, items: [] }],
      [`GET /v1/payroll-outputs/runs/${RUN}/journal`]: refusal(409, 'NOT_CONFIGURED', 'No chart mapping', { code: 'JV_CHART_MAPPING_NOT_CONFIGURED' }),
    });
    renderScreen(`/payroll/runs/${RUN}/reports`, [REPORT_READ]);
    const disbursement = await section('Disbursement reconciliation');
    await waitFor(() => expect(disbursement.textContent).toContain('Of held, by salary stopINR 30,000.00 for 1 employee'));
    expect(disbursement.textContent).toContain('Excluded from calculation by a salary stopSYN-002 Ravi Synthetic');
    const register = await section('Payroll register');
    await waitFor(() => expect(cells(rowWith(within(register).getByRole('table', { name: 'Payroll register' }), 'SYN-001 Asha Synthetic'))[2]).toBe('Hold disbursement'));
  });

  it('exports the register, the reconciliation and the comparison of the run through the report catalogue with the export key (FR-038)', async () => {
    const EXEC_1 = 'f0000000-0000-4000-8000-000000000001';
    const EXEC_2 = 'f0000000-0000-4000-8000-000000000002';
    const downloads = stubDownloads();
    try {
      serve({
        [`GET /v1/payroll-outputs/runs/${RUN}/register`]: [
          200,
          {
            run: header,
            scope: 'COMPANY',
            totals: { records: 0, earnings: '0', reimbursements: '0', deductions: '0', net: '0', employerContributions: '0', held: '0.0000', reserved: '0.0000', paid: '0.0000' },
            items: [],
            next: null,
          },
        ],
        [`GET /v1/payroll-outputs/runs/${RUN}/disbursement`]: [
          200,
          { run: header, totals: { payable: '0.0000', held: '0.0000', reserved: '0.0000', paid: '0.0000', ready: '0.0000', reconciles: true }, manifests: [], paymentStatusSource: 'RECORDED_OUTCOME_EVIDENCE_ONLY' },
        ],
        [`GET /v1/payroll-outputs/runs/${RUN}/comparison`]: [200, { runId: RUN, basis: 'RUN', priorPeriodCode: null, items: [] }],
        [`GET /v1/payroll-outputs/runs/${RUN}/journal`]: refusal(409, 'NOT_CONFIGURED'),
        'POST /v1/reports': (c) => {
          const code = (c.body as { reportCode: string }).reportCode;
          if (code === 'PAYROLL_REGISTER') return [202, { id: EXEC_1, state: 'QUEUED', format: 'XLSX' }];
          if (code === 'PAYROLL_DISBURSEMENT') return [202, { id: EXEC_2, state: 'QUEUED', format: 'CSV' }];
          return refusal(403, 'FORBIDDEN');
        },
        [`GET /v1/reports/${EXEC_1}`]: [200, { id: EXEC_1, reportCode: 'PAYROLL_REGISTER', state: 'COMPLETED', rowCount: 1, failureCode: null, format: 'XLSX' }],
        [`GET /v1/reports/${EXEC_1}/download`]: fileReply('payroll_register-f0000000.xlsx'),
        [`GET /v1/reports/${EXEC_2}`]: [200, { id: EXEC_2, reportCode: 'PAYROLL_DISBURSEMENT', state: 'FAILED', rowCount: null, failureCode: 'SCOPE_INCOMPLETE', format: 'CSV' }],
      });
      renderScreen(`/payroll/runs/${RUN}/reports`, [REPORT_READ, REPORT_EXPORT]);
      // The register as XLSX: requested for this run, generated in the background, then downloaded.
      const register = await section('Payroll register');
      const form = within(register).getByRole('form', { name: 'Export the payroll register' });
      fireEvent.change(within(form).getByLabelText('Format'), { target: { value: 'XLSX' } });
      fireEvent.click(button(form, 'Export the payroll register'));
      const ready = await within(register).findByRole('status', { name: 'Export of the payroll register' });
      await waitFor(() => expect(ready.textContent).toContain('Ready to download · 1 row'));
      fireEvent.click(button(ready, 'Download XLSX'));
      await waitFor(() => expect(downloads.click).toHaveBeenCalledTimes(1));
      expect(callsTo('GET', `/v1/reports/${EXEC_1}/download`)).toHaveLength(1);
      // The reconciliation as CSV: a generation failure is explained in plain words, with no download.
      const disbursement = await section('Disbursement reconciliation');
      fireEvent.click(button(within(disbursement).getByRole('form', { name: 'Export the reconciliation totals' }), 'Export the reconciliation totals'));
      const failed = await within(disbursement).findByRole('status', { name: 'Export of the reconciliation totals' });
      await waitFor(() => expect(failed.textContent).toContain('Failed: nothing was generated · The reconciliation is a company figure'));
      expect(within(failed).queryByRole('button', { name: /Download/ })).toBeNull();
      // A refused request is explained where it was made.
      const comparison = await section('Prior-period comparison');
      fireEvent.click(button(within(comparison).getByRole('form', { name: 'Export the comparison' }), 'Export the comparison'));
      expect(await within(comparison).findByText('The selected role is not permitted to do this.')).toBeTruthy();
      expect(bodiesTo('POST', '/v1/reports')).toEqual([
        { reportCode: 'PAYROLL_REGISTER', filters: { runId: RUN }, format: 'XLSX' },
        { reportCode: 'PAYROLL_DISBURSEMENT', filters: { runId: RUN }, format: 'CSV' },
        { reportCode: 'PAYROLL_COMPARISON', filters: { runId: RUN }, format: 'CSV' },
      ]);
    } finally {
      downloads.restore();
    }
  });

  it('exports the reimbursement register of the run with the export key only (FR-038, I-89 item 1)', async () => {
    const EXEC_3 = 'f0000000-0000-4000-8000-000000000003';
    const reports: Record<string, Handler> = {
      [`GET /v1/payroll-outputs/runs/${RUN}/register`]: [
        200,
        {
          run: header,
          scope: 'COMPANY',
          totals: { records: 0, earnings: '0', reimbursements: '0', deductions: '0', net: '0', employerContributions: '0', held: '0.0000', reserved: '0.0000', paid: '0.0000' },
          items: [],
          next: null,
        },
      ],
      [`GET /v1/payroll-outputs/runs/${RUN}/disbursement`]: [
        200,
        { run: header, totals: { payable: '0.0000', held: '0.0000', reserved: '0.0000', paid: '0.0000', ready: '0.0000', reconciles: true }, manifests: [], paymentStatusSource: 'RECORDED_OUTCOME_EVIDENCE_ONLY' },
      ],
      [`GET /v1/payroll-outputs/runs/${RUN}/comparison`]: [200, { runId: RUN, basis: 'RUN', priorPeriodCode: null, items: [] }],
      [`GET /v1/payroll-outputs/runs/${RUN}/journal`]: refusal(409, 'NOT_CONFIGURED'),
    };
    // Without the export key there is nothing to offer, so the section is not shown.
    serve({ ...reports });
    renderScreen(`/payroll/runs/${RUN}/reports`, [REPORT_READ]);
    await section('Payroll register');
    await settle();
    expect(screen.queryByRole('heading', { name: 'Reimbursement register' })).toBeNull();
    cleanup();

    serve({
      ...reports,
      'POST /v1/reports': [202, { id: EXEC_3, state: 'QUEUED', format: 'CSV' }],
      [`GET /v1/reports/${EXEC_3}`]: [200, { id: EXEC_3, reportCode: 'REIMBURSEMENT_REGISTER', state: 'COMPLETED', rowCount: 2, failureCode: null, format: 'CSV' }],
    });
    renderScreen(`/payroll/runs/${RUN}/reports`, [REPORT_READ, REPORT_EXPORT]);
    const reimbursement = await section('Reimbursement register');
    expect(within(reimbursement).getByText(/columns await the owner’s approval with samples/)).toBeTruthy();
    fireEvent.click(button(within(reimbursement).getByRole('form', { name: 'Export the reimbursement register' }), 'Export the reimbursement register'));
    const ready = await within(reimbursement).findByRole('status', { name: 'Export of the reimbursement register' });
    await waitFor(() => expect(ready.textContent).toContain('Ready to download · 2 rows'));
    expect(bodiesTo('POST', '/v1/reports')).toEqual([{ reportCode: 'REIMBURSEMENT_REGISTER', filters: { runId: RUN }, format: 'CSV' }]);
  });

  it('is hidden without the report key and links from the run only with it', async () => {
    serve({});
    renderScreen(`/payroll/runs/${RUN}/reports`, [RUN_STATUS]);
    expect(screen.getByText('The selected role cannot see payroll reports.')).toBeTruthy();
    await settle();
    expect(calls).toHaveLength(0);
    cleanup();
    serve({ [`GET ${RUN_PATH}`]: [200, runDetail()] });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS]);
    await screen.findByRole('heading', { name: 'Payroll run 2026-10 · revision 1' });
    expect(screen.queryByRole('link', { name: 'Reports of this run' })).toBeNull();
    cleanup();
    serve({ [`GET ${RUN_PATH}`]: [200, runDetail()] });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, REPORT_READ]);
    expect((await screen.findByRole('link', { name: 'Reports of this run' })).getAttribute('href')).toBe(`/payroll/runs/${RUN}/reports`);
  });

  it('lists the statutory outputs as not configured with their source labels', async () => {
    serve({
      'GET /v1/payroll-outputs/statutory-outputs': [
        200,
        { items: [{ code: 'FORM_16', sourceLabel: 'Form 16 / Form 130', status: 'NOT_CONFIGURED', reason: 'RULE_PACK_AND_TEMPLATE_NOT_CONFIGURED', needs: ['activated statutory rule pack (rates and applicability)', 'owner-supplied period template'] }] },
      ],
    });
    renderScreen('/payroll/statutory-outputs', [STATUTORY_READ]);
    const table = await screen.findByRole('table', { name: 'Statutory outputs' });
    expect(cells(rowWith(table, 'Form 16 / Form 130'))).toEqual(['Form 16 / Form 130', 'FORM_16', 'Not configured', 'activated statutory rule pack (rates and applicability); owner-supplied period template']);
  });

  it('shows a register whose pack is active as a working register, still needing the filing template', async () => {
    serve({
      'GET /v1/payroll-outputs/statutory-outputs': [
        200,
        { items: [{ code: 'PF_REGISTER', sourceLabel: 'PF register', status: 'AVAILABLE', format: 'WORKING_REGISTER', reason: 'WORKING_REGISTER', needs: ['owner-supplied period template and approved sample for the filing format'] }] },
      ],
    });
    renderScreen('/payroll/statutory-outputs', [STATUTORY_READ]);
    const table = await screen.findByRole('table', { name: 'Statutory outputs' });
    expect(cells(rowWith(table, 'PF register'))).toEqual(['PF register', 'PF_REGISTER', 'Working register', 'owner-supplied period template and approved sample for the filing format']);
  });

  it('FR-039: the quarter’s TDS register (Form 24Q working data) for a report reader, per employee and month with its source', async () => {
    serve({
      'GET /v1/payroll-outputs/statutory-outputs': [200, { items: [] }],
      'GET /v1/payroll-outputs/tds-register': [
        200,
        {
          from: '2026-04-01',
          to: '2026-06-30',
          notice: 'Working data for Form 24Q / Form 138. Not the return.',
          scope: 'COMPANY',
          totals: { employees: 1, tds: '292500.0000', months: [{ month: '2026-04', taxableSalary: '200000.0000', tds: '24375.0000' }, { month: '2026-05', taxableSalary: '2200000.0000', tds: '268125.0000' }] },
          items: [
            {
              employeeId: 'e1',
              employeeCode: 'SYN-001',
              employeeName: 'Asha Synthetic',
              tds: '292500.0000',
              months: [
                { month: '2026-04', source: 'PAYROLL', taxableSalary: '200000.0000', tds: '24375.0000' },
                { month: '2026-05', source: 'FINAL_SETTLEMENT', taxableSalary: '2200000.0000', tds: '268125.0000' },
              ],
            },
          ],
        },
      ],
    });
    renderScreen('/payroll/statutory-outputs', [STATUTORY_READ, REPORT_READ]);
    const form = await screen.findByRole('form', { name: 'TDS register' });
    fireEvent.change(within(form).getByLabelText('Quarter'), { target: { value: '1' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Show' }));
    const table = await screen.findByRole('table', { name: 'TDS by employee' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(cells(rows[0]!)).toEqual(['SYN-001 Asha Synthetic', 'Apr 2026', 'Payroll', 'INR 2,00,000.00', 'INR 24,375.00']);
    expect(cells(rows[1]!)).toEqual(['', 'May 2026', 'Final settlement', 'INR 22,00,000.00', 'INR 2,68,125.00']);
    expect(callsTo('GET', '/v1/payroll-outputs/tds-register')[0]?.query.toString()).toBe('fiscalYear=2026-27&quarter=1');
    expect(screen.getByLabelText('TDS register totals').textContent).toContain('INR 2,92,500.00');
  });

  it('offers the TDS register only with the report key', async () => {
    serve({ 'GET /v1/payroll-outputs/statutory-outputs': [200, { items: [] }] });
    renderScreen('/payroll/statutory-outputs', [STATUTORY_READ]);
    await screen.findByText(/Each statutory register/);
    expect(screen.queryByRole('form', { name: 'TDS register' })).toBeNull();
  });

  it('FR-039: a run’s working registers show the recorded valuations with totals, and a not-covered employee by reason', async () => {
    const register = (code: string, body: Record<string, unknown>): [string, [number, unknown]] => [`GET /v1/payroll-outputs/runs/${RUN}/statutory-registers/${code}`, [200, body]];
    const common = { notice: 'A working register of what the calculation recorded; not a statutory filing.', run: { currencyCode: 'INR' }, scope: 'COMPANY', next: null };
    serve(
      Object.fromEntries([
        register('PF_REGISTER', {
          ...common,
          sourceLabel: 'PF register',
          packs: [{ packCode: 'PF', packRevision: 1 }],
          totals: { records: 1, amounts: { employee: '1200.0000', pension: '833.0000', employerEpf: '367.0000', edli: '50.0000', adminCharges: '50.0000' } },
          items: [
            {
              recordId: 'r1',
              employeeCode: 'SYN-001',
              employeeName: 'Asha Synthetic',
              packCode: 'PF',
              facts: { pfWages: '10000.0000', contributionWages: '10000.0000', option: 'STATUTORY_CEILING' },
              amounts: { employee: '1200.0000', pension: '833.0000', employerEpf: '367.0000', edli: '50.0000', adminCharges: '50.0000' },
              notApplicable: {},
            },
          ],
        }),
        register('ESIC_REGISTER', {
          ...common,
          sourceLabel: 'ESIC register',
          packs: [{ packCode: 'ESIC', packRevision: 1 }],
          totals: { records: 1, amounts: { employee: '0.0000', employer: '0.0000' } },
          items: [
            {
              recordId: 'r2',
              employeeCode: 'SYN-002',
              employeeName: 'Bina Synthetic',
              packCode: 'ESIC',
              facts: { esicWages: '35000.0000' },
              amounts: { employee: null, employer: null },
              notApplicable: { employee: 'NOT_COVERED', employer: 'NOT_COVERED' },
            },
          ],
        }),
      ]),
    );
    renderScreen(`/payroll/runs/${RUN}/reports`, [REPORT_READ]);
    const s = await section('Statutory registers');
    const pf = await within(s).findByRole('table', { name: 'PF register' });
    expect(cells(rowWith(pf, 'SYN-001 Asha Synthetic'))).toEqual(['SYN-001 Asha Synthetic', 'INR 10,000.00', 'INR 10,000.00', 'Statutory ceiling', 'INR 1,200.00', 'INR 833.00', 'INR 367.00', 'INR 50.00', 'INR 50.00']);
    expect(within(s).getByLabelText('PF register totals').textContent).toContain('PF revision 1');
    expect(s.textContent).toContain('not a statutory filing');
    fireEvent.change(within(s).getByLabelText('Register'), { target: { value: 'ESIC_REGISTER' } });
    const esic = await within(s).findByRole('table', { name: 'ESIC register' });
    expect(cells(rowWith(esic, 'SYN-002 Bina Synthetic'))).toEqual(['SYN-002 Bina Synthetic', 'INR 35,000.00', '—', 'Not covered', 'Not covered']);
    expect(calls.filter((c) => c.path.includes('/statutory-registers/')).map((c) => c.path.split('/').pop())).toEqual(['PF_REGISTER', 'ESIC_REGISTER']);
  });
});

// =========================================================================================================
// HR loans: request, disbursement, cancellation, recoveries
// =========================================================================================================

describe('HR loans', () => {
  it('requests a loan for an employee with an idempotency key and resets after success', async () => {
    serve({
      'GET /v1/employees': [200, EMPLOYEES],
      'GET /v1/payroll-outputs/loans': [200, { items: [] }],
      [`POST /v1/payroll-outputs/employees/${E_1}/loans`]: [201, { ...hrLoan(LOAN, { employeeCode: 'SYN-001', principal: '6000.0000' }), replayed: false }],
    });
    renderScreen('/payroll/loans', [LOAN_READ, LOAN_REQUEST, EMPLOYEE_LIST]);
    const form = await screen.findByRole('form', { name: 'Request a loan for an employee' });
    await chooseEmployee(form);
    type(form, 'Currency', 'inr');
    type(form, 'Amount', '6000.00');
    type(form, 'Purpose', 'Synthetic household repair');
    fireEvent.click(button(form, 'Send the request'));
    expect(await within(form).findByText('Loan of INR 6,000.00 requested for SYN-001: it waits for an independent decision. Loans carry no interest.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/payroll-outputs/employees/${E_1}/loans`)).toEqual([
      { loanKind: 'LOAN', currencyCode: 'INR', principal: '6000.00', purpose: 'Synthetic household repair', idempotencyKey: expect.stringMatching(/^payroll-loan-for-/) },
    ]);
    expect((within(form).getByLabelText('Purpose') as HTMLTextAreaElement).value).toBe('');
    // Many requests at once go through the upload screen.
    expect(screen.getByRole('link', { name: 'upload a file of loan and advance requests' }).getAttribute('href')).toBe('/payroll/loans/upload');
  });

  const LOAN_IMPORTS = '/v1/payroll-outputs/loan-imports';
  const NO_BATCHES: Reply = [200, { items: [], total: 0, page: 1, pageSize: 25 }];
  const LOAN_FILE = 'employeeCode,loanKind,currencyCode,principal,purpose\nSYN-001,LOAN,INR,6000.00,Synthetic household repair\nSYN-002,ADVANCE,USD,100.00,Synthetic advance';
  const loanJob = (over: Record<string, unknown> = {}) => ({
    id: 'job-1',
    state: 'PREVIEWED',
    template: 'LOAN_REQUESTS_V1',
    fileName: 'loans.csv',
    rowCount: 2,
    acceptedCount: 0,
    rejectedCount: 0,
    scanState: 'CLEAN',
    createdAt: '2026-10-28T09:00:00.000Z',
    rows: [
      { rowNumber: 1, businessKey: 'SYN-001', state: 'VALID', errorCode: null, proposedChanges: null },
      { rowNumber: 2, businessKey: 'SYN-002', state: 'VALID', errorCode: null, proposedChanges: null },
    ],
    ...over,
  });
  const chooseLoanFile = (text: string) => fireEvent.change(screen.getByLabelText('Loan requests file'), { target: { files: [new File([text], 'loans.csv', { type: 'text/csv' })] } });

  it('uploads loan requests through the shared batch screens: the template and its rules, and every row problem of a rejected batch in words', async () => {
    const files = stubDownloads();
    try {
      serve({
        [`GET ${LOAN_IMPORTS}`]: NO_BATCHES,
        [`GET ${LOAN_IMPORTS}/template`]: fileReply('LOAN_REQUESTS_V1.csv'),
        [`POST ${LOAN_IMPORTS}`]: [
          201,
          loanJob({
            state: 'REJECTED',
            rejectedCount: 2,
            rows: [
              { rowNumber: 1, businessKey: 'SYN-001', state: 'REJECTED', errorCode: 'BATCH_REJECTED', proposedChanges: null },
              { rowNumber: 2, businessKey: 'SYN-002', state: 'REJECTED', errorCode: 'CURRENCY_NOT_CONFIGURED', proposedChanges: null },
            ],
          }),
        ],
      });
      renderScreen('/payroll/loans/upload', [LOAN_REQUEST]);
      const form = await screen.findByRole('form', { name: 'Upload loan requests' });
      expect(form.textContent).toContain('employeeCode,loanKind,currencyCode,principal,purpose');
      expect(form.textContent).toContain('Loans carry no interest');
      expect(form.textContent).toContain('Every request entered waits for an independent decision, loan by loan; the upload approves nothing.');
      expect(within(form).getByText('LOAN_REQUESTS_V1.csv: the header line only, ready to fill in.')).toBeTruthy();
      fireEvent.click(button(form, 'Download the template'));
      await waitFor(() => expect(files.click).toHaveBeenCalledTimes(1));
      expect(callsTo('GET', `${LOAN_IMPORTS}/template`)).toHaveLength(1);
      expect(await screen.findByText('You have not uploaded a file for this import yet.')).toBeTruthy();

      chooseLoanFile(LOAN_FILE);
      fireEvent.click(button(form, 'Validate'));
      expect(await screen.findByText(/This batch was rejected, so nothing was applied/)).toBeTruthy();
      const sent = bodiesTo('POST', LOAN_IMPORTS);
      expect(sent).toEqual([{ fileName: 'loans.csv', contentBase64: expect.any(String), idempotencyKey: expect.stringMatching(/^payroll-loan-import-/) }]);
      expect(atob(sent[0]!.contentBase64 as string)).toBe(LOAN_FILE);
      expect(rowWith(document.body, 'SYN-002').textContent).toContain('No active payroll calendar pays in this currency.');
      expect(rowWith(document.body, 'SYN-001').textContent).toContain('not applied (another row failed)');
      expect(screen.queryByRole('button', { name: /^Enter \d/ })).toBeNull();
      expect(callsTo('POST', `${LOAN_IMPORTS}/job-1/commit`)).toHaveLength(0);
    } finally {
      files.restore();
    }
  });

  it('commits a previewed batch only on request, and says every request entered waits for its own independent decision', async () => {
    serve({
      [`GET ${LOAN_IMPORTS}`]: NO_BATCHES,
      [`POST ${LOAN_IMPORTS}`]: [201, loanJob()],
      [`POST ${LOAN_IMPORTS}/job-1/commit`]: [
        200,
        loanJob({
          state: 'COMMITTED',
          acceptedCount: 2,
          rows: [
            { rowNumber: 1, businessKey: 'SYN-001', state: 'ACCEPTED', errorCode: null, proposedChanges: null },
            { rowNumber: 2, businessKey: 'SYN-002', state: 'ACCEPTED', errorCode: null, proposedChanges: null },
          ],
        }),
      ],
    });
    renderScreen('/payroll/loans/upload', [LOAN_REQUEST]);
    const form = await screen.findByRole('form', { name: 'Upload loan requests' });
    chooseLoanFile(LOAN_FILE);
    fireEvent.click(button(form, 'Validate'));
    expect(await screen.findByText(/All 2 rows are valid/)).toBeTruthy();
    await settle();
    expect(callsTo('POST', `${LOAN_IMPORTS}/job-1/commit`)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Enter 2 loan requests' }));
    expect(await screen.findByText('All 2 rows were applied.')).toBeTruthy();
    expect(screen.getByText('Every request entered waits for an independent decision, loan by loan: someone other than you and the employee decides each one.')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([LOAN_IMPORTS, `${LOAN_IMPORTS}/job-1/commit`]);
    // The user's own batches are read again after each change.
    await waitFor(() => expect(callsTo('GET', LOAN_IMPORTS).length).toBeGreaterThanOrEqual(3));
  });

  it('offers the upload only with the loan request grant, and asks the server nothing without it', async () => {
    serve({});
    renderScreen('/payroll/loans/upload', [LOAN_READ, LOAN_DECIDE]);
    expect(screen.getByText('The selected role cannot enter loan requests: that needs the loan request grant.')).toBeTruthy();
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('records a disbursement with one verified document and an evidence key resent after a lost answer, never by the decider, and cancels an approved loan', async () => {
    const approved = hrLoan(LOAN, { employeeId: E_1, employeeCode: 'SYN-001', state: 'APPROVED', decidedBy: U_OTHER, version: 3 });
    serve({
      'GET /v1/payroll-outputs/loans': (call) => [200, { items: call.query.get('state') === 'REQUESTED' ? [] : [approved, hrLoan(LOAN_2, { employeeCode: 'SYN-003', state: 'APPROVED', decidedBy: U_ME })] }],
      [`GET /v1/payroll-outputs/loans/${LOAN}`]: [200, approved],
      [`GET /v1/payroll-outputs/loans/${LOAN_2}`]: [200, hrLoan(LOAN_2, { employeeCode: 'SYN-003', state: 'APPROVED', decidedBy: U_ME })],
      [`GET /v1/employees/${E_1}/documents`]: [200, DOCUMENTS],
      'GET /v1/employees/e2/documents': [200, { items: [] }],
      [`POST /v1/payroll-outputs/loans/${LOAN}/disbursement`]: [200, { ...approved, state: 'DISBURSED', disbursementDate: '2026-10-27', replayed: false }],
      [`POST /v1/payroll-outputs/loans/${LOAN}/cancel`]: refusal(403, 'SELF_ACTION_NOT_ALLOWED'),
    });
    renderScreen('/payroll/loans', [LOAN_READ, LOAN_DECIDE, LOAN_DISBURSE, DOCUMENT_READ]);
    const table = await screen.findByRole('table', { name: 'Loans and advances' });
    fireEvent.click(button(table, 'Details of the loan of SYN-003'));
    const decided = await screen.findByRole('form', { name: 'Record the disbursement of the loan of SYN-003' });
    expect(decided.textContent).toContain('You requested or decided this loan, so someone else records its disbursement.');
    expect(button(decided, 'Record the disbursement').disabled).toBe(true);
    fireEvent.click(button(table, 'Details of the loan of SYN-001'));
    const form = await screen.findByRole('form', { name: 'Record the disbursement of the loan of SYN-001' });
    const cancel = screen.getByRole('form', { name: 'Cancel the approved loan of SYN-001' });
    type(cancel, 'Why the approved loan is cancelled', 'Synthetic: request made in error');
    fireEvent.click(button(cancel, 'Cancel the approved loan'));
    expect(await screen.findByText('You cannot act on your own payroll record in this role; another authorised person does that.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/payroll-outputs/loans/${LOAN}/cancel`)).toEqual([{ reason: 'Synthetic: request made in error', expectedVersion: 3 }]);
    type(form, 'Disbursement date', '2026-10-27');
    type(form, 'Evidence reference', 'SYN-BANK-STMT-9');
    expect((within(form).getByLabelText(/unverified\.pdf/) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(await within(form).findByLabelText(/synthetic-letter\.pdf/));
    lost.add(`POST /v1/payroll-outputs/loans/${LOAN}/disbursement`);
    fireEvent.click(button(form, 'Record the disbursement'));
    expect(await within(form).findByText(/No answer came back, so it may or may not have been recorded/)).toBeTruthy();
    await waitFor(() => expect(button(form, 'Record the disbursement').disabled).toBe(false));
    fireEvent.click(button(form, 'Record the disbursement'));
    expect(await screen.findByText('The disbursement of INR 6,000.00 on 27 Oct 2026 is recorded from its evidence; it is recovered through processed payroll.')).toBeTruthy();
    const sent = bodiesTo('POST', `/v1/payroll-outputs/loans/${LOAN}/disbursement`);
    expect(sent[0]).toEqual({ disbursementDate: '2026-10-27', evidenceKey: expect.stringMatching(/^payroll-loan-disbursement-/), evidenceReference: 'SYN-BANK-STMT-9', evidenceDocumentIds: [DOC_OK], expectedVersion: 3 });
    expect(sent[1]!.evidenceKey).toBe(sent[0]!.evidenceKey);
  });

  it('recognises the loan recoveries of a processed run and offers Continue while work remains', async () => {
    const replies: Reply[] = [
      [202, { runId: RUN, recognised: 2, closed: 1, exceptions: [{ loanId: LOAN, employeeCode: 'SYN-004', code: 'RECOVERY_EXCEEDS_OUTSTANDING' }], remaining: 3, done: false }],
      [200, { runId: RUN, recognised: 3, closed: 0, exceptions: [], remaining: 0, done: true }],
    ];
    serve({
      [`GET ${RUN_PATH}`]: [200, runDetail({ ...CALCULATED, state: 'PROCESSED_LOCKED', processedAt: '2026-10-28T08:00:00.000Z', lockVersion: 1 })],
      [`POST /v1/payroll-outputs/runs/${RUN}/loan-recoveries`]: () => replies.shift()!,
    });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, LOAN_RECOVER]);
    const recoveries = await section('Loan recoveries');
    fireEvent.click(button(recoveries, 'Recognise loan recoveries'));
    expect(await within(recoveries).findByText('2 recoveries recognised in this pass; 1 loan fully recovered and closed. 3 still to recognise: continue.')).toBeTruthy();
    expect(recoveries.textContent).toContain('SYN-004: the deduction is above the outstanding balance');
    await waitFor(() => expect(button(recoveries, 'Continue').disabled).toBe(false));
    fireEvent.click(button(recoveries, 'Continue'));
    expect(await within(recoveries).findByText('3 recoveries recognised in this pass; 0 loans fully recovered and closed. Every recovery of this run is recognised.')).toBeTruthy();
    expect(callsTo('POST', `/v1/payroll-outputs/runs/${RUN}/loan-recoveries`)).toHaveLength(2);
    cleanup();
    serve({ [`GET ${RUN_PATH}`]: [200, runDetail({ ...CALCULATED, state: 'PROCESSED_LOCKED' })] });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS]);
    await screen.findByRole('heading', { name: 'Payroll run 2026-10 · revision 1' });
    expect(screen.queryByRole('heading', { name: 'Loan recoveries' })).toBeNull();
  });
});

// =========================================================================================================
// Run extras: rerun check, payslip reissue, members left out of a draft
// =========================================================================================================

describe('run extras', () => {
  it('checks a calculated revision by recalculation, continuing from where it stopped', async () => {
    const replies: Reply[] = [
      [202, { runId: RUN, revision: 1, state: 'CALCULATED', identical: true, records: 1, lines: 6, lineDifferences: 0, totalDifferences: 0, paidDayDifferences: 0, complete: false, nextAfter: E_1 }],
      [200, { runId: RUN, revision: 1, state: 'CALCULATED', identical: true, records: 1, lines: 5, lineDifferences: 0, totalDifferences: 0, paidDayDifferences: 0, complete: true, nextAfter: null }],
    ];
    serve({
      [`GET ${RUN_PATH}`]: [200, runDetail(CALCULATED)],
      [`GET ${RUN_PATH}/records`]: [200, { items: [], nextAfter: null }],
      [`GET ${RUN_PATH}/components`]: [200, { runId: RUN, basis: 'RUN', priorPeriodCode: null, items: [] }],
      [`POST ${RUN_PATH}/verify`]: () => replies.shift()!,
    });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, RUN_AMOUNT]);
    const check = await section('Rerun check');
    fireEvent.click(button(check, 'Check by recalculating'));
    expect(await within(check).findByText('This pass checked 1 records and 6 lines: identical to the stored results. The check stopped at its time limit: continue it.')).toBeTruthy();
    await waitFor(() => expect(button(check, 'Continue the check').disabled).toBe(false));
    fireEvent.click(button(check, 'Continue the check'));
    expect(await within(check).findByText('This pass checked 1 records and 5 lines: identical to the stored results. The rerun gives identical results for the whole revision.')).toBeTruthy();
    const sent = callsTo('POST', `${RUN_PATH}/verify`);
    expect(sent.map((c) => c.query.get('after'))).toEqual([null, E_1]);
  });

  it('reissues an issued payslip with a reason and its row version, and says reissuing is not payment', async () => {
    serve({
      [`GET ${RUN_PATH}`]: [200, runDetail({ ...CALCULATED, state: 'PROCESSED_LOCKED', processedAt: '2026-10-28T08:00:00.000Z', lockVersion: 1 })],
      [`GET /v1/payroll-outputs/runs/${RUN}/payslips`]: [
        200,
        {
          items: [
            { id: 'o1', employeeCode: 'SYN-001', periodCode: '2026-10', version: 1, publicationState: 'SUPERSEDED', issuedAt: '2026-10-28T09:00:00.000Z', fileName: 'p1.json', supersededAt: '2026-10-28T10:00:00.000Z', rowVersion: 2 },
            { id: 'o2', employeeCode: 'SYN-001', periodCode: '2026-10', version: 2, publicationState: 'ISSUED', issuedAt: '2026-10-28T10:00:00.000Z', fileName: 'p2.json', supersededAt: null, rowVersion: 4 },
          ],
        },
      ],
      'POST /v1/payroll-outputs/payslips/o2/reissue': [201, { id: 'o3', employeeCode: 'SYN-001', periodCode: '2026-10', version: 3, publicationState: 'ISSUED', issuedAt: null, fileName: 'p3.json', supersededAt: null, rowVersion: 1 }],
    });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, OUTPUT_READ, OUTPUT_PUBLISH]);
    const payslips = await section('Payslips');
    const issued = await within(payslips).findByRole('table', { name: 'Issued payslips' });
    expect(within(issued).queryByRole('button', { name: 'Reissue the payslip of SYN-001 version 1' })).toBeNull();
    fireEvent.click(button(issued, 'Reissue the payslip of SYN-001 version 2'));
    const form = within(payslips).getByRole('form', { name: 'Reissue the payslip of SYN-001' });
    type(form, 'Why the payslip of SYN-001 (version 2) is replaced', 'Synthetic: bank name corrected');
    fireEvent.click(button(form, 'Issue a new version'));
    expect(await within(payslips).findByText('A new version of the payslip of SYN-001 was issued (version 3); the earlier one is marked superseded. Reissuing does not mean the salary has been paid.')).toBeTruthy();
    expect(bodiesTo('POST', '/v1/payroll-outputs/payslips/o2/reissue')).toEqual([{ reason: 'Synthetic: bank name corrected', expectedVersion: 4 }]);
  });

  it('leaves members out of a draft with a reason and its version', async () => {
    serve({
      [`GET ${RUN_PATH}`]: [200, runDetail()],
      'GET /v1/employees': [200, EMPLOYEES],
      [`POST ${RUN_PATH}/exclusions`]: [200, runDetail({ members: { included: 1, excluded: 1 }, version: 4 })],
    });
    renderScreen(`/payroll/runs/${RUN}`, [RUN_STATUS, RUN_PREPARE, EMPLOYEE_LIST]);
    fireEvent.click(await screen.findByRole('button', { name: 'Leave members out of this draft' }));
    const form = screen.getByRole('form', { name: 'Leave members out of this draft' });
    await chooseEmployee(form, 'Find the member to leave out');
    expect(within(form).getByRole('list', { name: 'Members to leave out' }).textContent).toContain('SYN-001 Asha Synthetic');
    fireEvent.click(button(form, 'Leave them out'));
    expect(within(form).getByText('Choose who is left out and give the reason.')).toBeTruthy();
    type(form, 'Why they are left out', 'Synthetic: joins next month');
    fireEvent.click(button(form, 'Leave them out'));
    expect(await screen.findByText('Left out of this revision: 1 in all; 1 members remain.')).toBeTruthy();
    expect(bodiesTo('POST', `${RUN_PATH}/exclusions`)).toEqual([{ employeeIds: [E_1], reason: 'Synthetic: joins next month', expectedVersion: 3 }]);
  });
});

// =========================================================================================================
// Payroll configuration: calendars and periods, paid-day policy, pay components and heads, salary components
// =========================================================================================================

const K_DRAFT = '12000000-0000-4000-8000-000000000002';
const K_MINE = '12000000-0000-4000-8000-000000000003';
const PERIOD_2 = '11000000-0000-4000-8000-000000000002';
const PD_1 = '14000000-0000-4000-8000-000000000001';
const PD_2 = '14000000-0000-4000-8000-000000000002';
const H_BASIC = '15000000-0000-4000-8000-000000000001';
const H_PF = '15000000-0000-4000-8000-000000000002';
const H_HRA = '15000000-0000-4000-8000-000000000003';
const ARR = '16000000-0000-4000-8000-000000000001';

const calPeriod = (patch: Record<string, unknown> = {}) => ({
  id: PERIOD,
  periodCode: '2026-10',
  financialYear: '2026-27',
  serviceStart: '2026-10-01',
  serviceEnd: '2026-10-31',
  inputCutoff: '2026-10-25',
  paymentDate: '2026-10-31',
  version: 1,
  ...patch,
});
const calendarRow = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  code: 'SYN_MONTHLY',
  name: 'Synthetic monthly',
  currencyCode: 'INR',
  currencyMinorUnit: 2,
  state: 'ACTIVE',
  createdBy: U_OTHER,
  activatedBy: U_ME,
  activatedAt: '2026-10-01T09:00:00.000Z',
  version: 2,
  periods: [calPeriod()],
  ...patch,
});
const policyRow = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  revision: 1,
  effectiveFrom: '2026-10-01',
  attendanceBasis: 'APPROVED_LEAVE_ONLY',
  absentUnpaidUnits: null,
  halfDayUnpaidUnits: null,
  state: 'DRAFT',
  createdBy: U_OTHER,
  activatedBy: null,
  activatedAt: null,
  version: 1,
  ...patch,
});
const headRev = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  componentCode: 'BASIC',
  componentName: 'Basic pay',
  componentKind: 'EARNING',
  revision: 1,
  effectiveFrom: '2026-04-01',
  inUse: true,
  headType: 'EARNING',
  calculationBasis: 'FIXED',
  roundingRule: 'HALF_UP_MINOR_UNIT',
  taxTreatment: 'TAXABLE',
  rulePackCode: null,
  displaySequence: 10,
  baseComponentCodes: [],
  state: 'ACTIVE',
  createdBy: U_OTHER,
  activatedBy: U_ME,
  activatedAt: '2026-04-01T09:00:00.000Z',
  version: 2,
  ...patch,
});
const PAY_COMPONENTS = {
  items: [
    { id: 'pc1', code: 'BASIC', name: 'Basic pay', componentKind: 'EARNING', active: true, headInEffect: { revisionId: H_BASIC, revision: 1, effectiveFrom: '2026-04-01', inUse: true, headType: 'EARNING', calculationBasis: 'FIXED' } },
    { id: 'pc2', code: 'PF_EMPLOYER', name: 'Synthetic employer PF', componentKind: 'EARNING', active: true, headInEffect: null },
  ],
};
const PF_DRAFT = {
  componentCode: 'PF_EMPLOYER',
  componentName: 'Synthetic employer PF',
  headType: 'EMPLOYER_CONTRIBUTION',
  calculationBasis: 'RULE_PACK',
  rulePackCode: 'SYN_PF',
  baseComponentCodes: ['BASIC'],
  taxTreatment: 'NON_TAXABLE',
  displaySequence: 20,
  state: 'DRAFT',
  createdBy: U_OTHER,
  version: 1,
  effectiveFrom: '2026-11-01',
};
const CONFIG_GETS: Record<string, Handler> = { 'GET /v1/payroll/calendars': [200, { items: [] }], 'GET /v1/payroll/paid-day-policies': [200, { items: [] }] };
/** Answers each call with the next reply of the list (the last one repeats). */
const inTurn = (...replies: Reply[]) => {
  let n = 0;
  return () => replies[Math.min(n++, replies.length - 1)]!;
};

describe('payroll calendars and periods', () => {
  it('is hidden without the configuration read key, and read only without the manage and activate keys', async () => {
    serve({});
    renderScreen('/payroll/calendars', [RUN_STATUS]);
    expect(await screen.findByText('The selected role cannot see the payroll configuration.')).toBeTruthy();
    await settle();
    expect(calls).toEqual([]);
    cleanup();
    serve({
      'GET /v1/payroll/calendars': [200, { items: [calendarRow(CALENDAR), calendarRow(K_DRAFT, { code: 'SYN_NEW', state: 'DRAFT', version: 1 })] }],
      'GET /v1/payroll/paid-day-policies': [200, { items: [policyRow(PD_1)] }],
    });
    renderScreen('/payroll/calendars', [CONFIG_READ]);
    const list = await section('Payroll calendars');
    const table = await within(list).findByRole('table', { name: 'Payroll calendars' });
    expect(cells(rowWith(table, 'SYN_NEW'))).toEqual(['SYN_NEW', 'Synthetic monthly', 'INR', '2 decimals', '1', 'Draft, not active']);
    expect(screen.queryByRole('button', { name: /Activate/ })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Create a payroll calendar' })).toBeNull();
    await screen.findByRole('table', { name: 'Paid-day policies' });
    expect(screen.queryByRole('form', { name: 'Define a paid-day policy' })).toBeNull();
  });

  it('creates a calendar with nothing prefilled, keeps the input after a refusal, disables saving in flight and resets after success', async () => {
    serve({ ...CONFIG_GETS, 'POST /v1/payroll/calendars': inTurn(refusal(409, 'CALENDAR_EXISTS'), [201, calendarRow(K_DRAFT, { state: 'DRAFT', periods: [] })]) });
    renderScreen('/payroll/calendars', [CONFIG_READ, CONFIG_MANAGE]);
    const form = await screen.findByRole('form', { name: 'Create a payroll calendar' });
    expect((within(form).getByLabelText('Currency minor unit') as HTMLSelectElement).value).toBe('');
    expect((within(form).getByLabelText('Currency (ISO code)') as HTMLInputElement).value).toBe('');
    type(form, 'Calendar code', 'syn_monthly');
    type(form, 'Calendar name', 'Synthetic monthly');
    type(form, 'Currency (ISO code)', 'inr');
    fireEvent.click(button(form, 'Save the calendar as a draft'));
    expect(within(form).getByText('Choose the currency’s minor unit (its number of decimals).')).toBeTruthy();
    await settle();
    expect(callsTo('POST', '/v1/payroll/calendars')).toHaveLength(0);
    type(form, 'Currency minor unit', '2');
    const release = hold('POST /v1/payroll/calendars');
    fireEvent.click(button(form, 'Save the calendar as a draft'));
    expect(((await within(form).findByRole('button', { name: 'Saving…' })) as HTMLButtonElement).disabled).toBe(true);
    release();
    expect(await within(form).findByText('A payroll calendar with this code already exists.')).toBeTruthy();
    expect((within(form).getByLabelText('Calendar code') as HTMLInputElement).value).toBe('syn_monthly');
    await waitFor(() => expect(button(form, 'Save the calendar as a draft').disabled).toBe(false));
    fireEvent.click(button(form, 'Save the calendar as a draft'));
    expect(await within(form).findByText('Calendar SYN_MONTHLY saved as a draft: add its periods; someone other than you activates it.')).toBeTruthy();
    expect((within(form).getByLabelText('Calendar code') as HTMLInputElement).value).toBe('');
    expect((within(form).getByLabelText('Currency minor unit') as HTMLSelectElement).value).toBe('');
    const sent = { code: 'SYN_MONTHLY', name: 'Synthetic monthly', currencyCode: 'INR', currencyMinorUnit: 2 };
    expect(bodiesTo('POST', '/v1/payroll/calendars')).toEqual([sent, sent]);
  });

  it('activates a draft calendar only by someone other than its author, and explains a refusal in words', async () => {
    serve({
      ...CONFIG_GETS,
      'GET /v1/payroll/calendars': [
        200,
        {
          items: [
            calendarRow(CALENDAR),
            calendarRow(K_DRAFT, { code: 'SYN_NEW', state: 'DRAFT', version: 1, periods: [] }),
            calendarRow(K_MINE, { code: 'SYN_MINE', state: 'DRAFT', createdBy: U_ME, version: 1 }),
          ],
        },
      ],
      [`POST /v1/payroll/calendars/${K_DRAFT}/activate`]: inTurn(refusal(422, 'NO_PERIODS'), [200, calendarRow(K_DRAFT, { code: 'SYN_NEW' })]),
    });
    renderScreen('/payroll/calendars', [CONFIG_READ, CONFIG_ACTIVATE]);
    const list = await section('Payroll calendars');
    const table = await within(list).findByRole('table', { name: 'Payroll calendars' });
    expect(rowWith(table, 'SYN_MINE').textContent).toContain('You wrote it: someone else activates it');
    expect(within(rowWith(table, 'SYN_MINE')).queryByRole('button')).toBeNull();
    expect(within(rowWith(table, 'SYN_MONTHLY')).queryByRole('button')).toBeNull();
    fireEvent.click(button(table, 'Activate calendar SYN_NEW'));
    expect(await within(list).findByText('Add the calendar’s periods before it is activated.')).toBeTruthy();
    await waitFor(() => expect(button(table, 'Activate calendar SYN_NEW').disabled).toBe(false));
    fireEvent.click(button(table, 'Activate calendar SYN_NEW'));
    expect(await within(list).findByText('Calendar SYN_NEW is active: payroll runs and inputs can now use its periods.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/payroll/calendars/${K_DRAFT}/activate`)).toEqual([{ expectedVersion: 1 }, { expectedVersion: 1 }]);
  });

  it('adds a monthly period, changes a period’s dates with its version, and says a used period is fixed', async () => {
    serve({
      [`GET /v1/payroll/calendars/${K_DRAFT}`]: [200, calendarRow(K_DRAFT, { code: 'SYN_NEW', state: 'DRAFT', version: 1 })],
      [`POST /v1/payroll/calendars/${K_DRAFT}/periods`]: inTurn(refusal(422, 'SERVICE_PERIOD_NOT_A_MONTH'), [201, { ...calPeriod({ id: PERIOD_2, periodCode: '2026-11' }), calendarId: K_DRAFT }]),
      [`PUT /v1/payroll/periods/${PERIOD}`]: refusal(409, 'PERIOD_IN_USE'),
    });
    renderScreen(`/payroll/calendars/${K_DRAFT}`, [CONFIG_READ, CONFIG_MANAGE]);
    const periods = await section('Periods');
    const table = within(periods).getByRole('table', { name: 'Periods of calendar SYN_NEW' });
    expect(cells(rowWith(table, '2026-10'))).toEqual(['2026-10', '2026-27', '1 Oct 2026 to 31 Oct 2026', '25 Oct 2026', '31 Oct 2026', 'Change dates']);
    expect(screen.queryByRole('button', { name: /Activate/ })).toBeNull();
    const add = within(periods).getByRole('form', { name: 'Add a period' });
    for (const field of ['Period code', 'Financial year', 'Service start', 'Service end', 'Input cutoff', 'Payment date']) expect((within(add).getByLabelText(field) as HTMLInputElement).value).toBe('');
    type(add, 'Period code', '2026-11');
    type(add, 'Financial year', '2026-27');
    type(add, 'Service start', '2026-11-01');
    type(add, 'Service end', '2026-11-29');
    type(add, 'Input cutoff', '2026-11-25');
    type(add, 'Payment date', '2026-11-30');
    fireEvent.click(button(add, 'Add the period'));
    expect(await within(add).findByText(/A service period is one whole calendar month/)).toBeTruthy();
    expect((within(add).getByLabelText('Service end') as HTMLInputElement).value).toBe('2026-11-29');
    type(add, 'Service end', '2026-11-30');
    await waitFor(() => expect(button(add, 'Add the period').disabled).toBe(false));
    fireEvent.click(button(add, 'Add the period'));
    expect(await screen.findByText('Period 2026-11 was added to calendar SYN_NEW.')).toBeTruthy();
    expect((within(add).getByLabelText('Period code') as HTMLInputElement).value).toBe('');
    expect(bodiesTo('POST', `/v1/payroll/calendars/${K_DRAFT}/periods`)[1]).toEqual({
      periodCode: '2026-11',
      financialYear: '2026-27',
      serviceStart: '2026-11-01',
      serviceEnd: '2026-11-30',
      inputCutoff: '2026-11-25',
      paymentDate: '2026-11-30',
    });
    fireEvent.click(button(table, 'Change the dates of period 2026-10'));
    const change = within(periods).getByRole('form', { name: 'Change the dates of period 2026-10' });
    expect(within(change).queryByLabelText('Period code')).toBeNull();
    type(change, 'Payment date', '2026-10-30');
    fireEvent.click(button(change, 'Save the new dates'));
    expect(await within(change).findByText('This period is fixed: payroll runs, inputs or salary stops already use it, so its dates can no longer change.')).toBeTruthy();
    expect((within(change).getByLabelText('Payment date') as HTMLInputElement).value).toBe('2026-10-30');
    expect(bodiesTo('PUT', `/v1/payroll/periods/${PERIOD}`)).toEqual([
      { financialYear: '2026-27', serviceStart: '2026-10-01', serviceEnd: '2026-10-31', inputCutoff: '2026-10-25', paymentDate: '2026-10-30', expectedVersion: 1 },
    ]);
  });

  it('defines a paid-day policy with nothing assumed and activates someone else’s draft', async () => {
    serve({
      ...CONFIG_GETS,
      'GET /v1/payroll/paid-day-policies': [200, { items: [policyRow(PD_1), policyRow(PD_2, { revision: 2, createdBy: U_ME })] }],
      'POST /v1/payroll/paid-day-policies': [201, policyRow('pd3', { revision: 3, attendanceBasis: 'REVIEWED_ATTENDANCE', absentUnpaidUnits: '1', halfDayUnpaidUnits: '0.5' })],
      [`POST /v1/payroll/paid-day-policies/${PD_1}/activate`]: [200, policyRow(PD_1, { state: 'ACTIVE' })],
    });
    renderScreen('/payroll/calendars', [CONFIG_READ, CONFIG_MANAGE, CONFIG_ACTIVATE]);
    const policies = await section('Paid-day policy');
    const table = await within(policies).findByRole('table', { name: 'Paid-day policies' });
    expect(rowWith(table, '2').textContent).toContain('You wrote it: someone else activates it');
    fireEvent.click(button(table, 'Activate paid-day policy revision 1'));
    expect(await within(policies).findByText('Paid-day policy revision 1 is active from 1 Oct 2026.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/payroll/paid-day-policies/${PD_1}/activate`)).toEqual([{ expectedVersion: 1 }]);
    const form = within(policies).getByRole('form', { name: 'Define a paid-day policy' });
    expect((within(form).getByLabelText('Reduces paid days for') as HTMLSelectElement).value).toBe('');
    expect(within(form).queryByLabelText(/Unpaid part of a reviewed absent day/)).toBeNull();
    type(form, 'Effective from', '2026-11-01');
    type(form, 'Reduces paid days for', 'REVIEWED_ATTENDANCE');
    expect((within(form).getByLabelText(/Unpaid part of a reviewed absent day/) as HTMLInputElement).value).toBe('');
    type(form, /Unpaid part of a reviewed absent day/, '1');
    fireEvent.click(button(form, 'Save the policy as a draft'));
    expect(within(form).getByText(/State the unpaid part of a reviewed absent day and of a half day/)).toBeTruthy();
    type(form, /Unpaid part of a reviewed half day/, '0.5');
    fireEvent.click(button(form, 'Save the policy as a draft'));
    expect(await within(form).findByText('Paid-day policy revision 3 saved as a draft: someone other than you activates it.')).toBeTruthy();
    expect(bodiesTo('POST', '/v1/payroll/paid-day-policies')).toEqual([{ effectiveFrom: '2026-11-01', attendanceBasis: 'REVIEWED_ATTENDANCE', absentUnpaidUnits: '1', halfDayUnpaidUnits: '0.5' }]);
    expect((within(form).getByLabelText('Reduces paid days for') as HTMLSelectElement).value).toBe('');
  });
});

describe('pay components and heads', () => {
  it('is hidden without the read key; lists components and heads read only; creates a component with its kind chosen', async () => {
    serve({});
    renderScreen('/payroll/heads', []);
    expect(await screen.findByText('The selected role cannot see the payroll configuration.')).toBeTruthy();
    await settle();
    expect(calls).toEqual([]);
    cleanup();
    const gets: Record<string, Handler> = { 'GET /v1/payroll/components': [200, PAY_COMPONENTS], 'GET /v1/payroll/heads': [200, { items: [headRev(H_BASIC)] }] };
    serve(gets);
    renderScreen('/payroll/heads', [CONFIG_READ]);
    const components = await screen.findByRole('table', { name: 'Pay components' });
    expect(cells(rowWith(components, 'BASIC'))).toEqual(['BASIC', 'Basic pay', 'Earning', 'Revision 1 from 1 Apr 2026: Earning, fixed (from the salary components)', 'Active']);
    expect(cells(rowWith(components, 'PF_EMPLOYER'))[3]).toBe('No head in effect');
    await screen.findByRole('table', { name: 'Head revisions' });
    expect(screen.queryByRole('form', { name: 'Create a pay component' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Create a head revision' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Change' })).toBeNull();
    cleanup();
    serve({ ...gets, 'POST /v1/payroll/components': inTurn(refusal(409, 'COMPONENT_EXISTS'), [201, { id: 'pc3', code: 'SYN_LOAN', name: 'Synthetic loan recovery', componentKind: 'DEDUCTION', active: true }]) });
    renderScreen('/payroll/heads', [CONFIG_READ, CONFIG_MANAGE]);
    const form = await screen.findByRole('form', { name: 'Create a pay component' });
    type(form, 'Component code', 'syn_loan');
    type(form, 'Component name', 'Synthetic loan recovery');
    expect((within(form).getByLabelText('Component kind') as HTMLSelectElement).value).toBe('');
    fireEvent.click(button(form, 'Create the component'));
    expect(within(form).getByText('Choose whether the component is an earning or a deduction.')).toBeTruthy();
    type(form, 'Component kind', 'DEDUCTION');
    fireEvent.click(button(form, 'Create the component'));
    expect(await within(form).findByText('A pay component with this code already exists.')).toBeTruthy();
    expect((within(form).getByLabelText('Component code') as HTMLInputElement).value).toBe('syn_loan');
    await waitFor(() => expect(button(form, 'Create the component').disabled).toBe(false));
    fireEvent.click(button(form, 'Create the component'));
    expect(await within(form).findByText('Pay component SYN_LOAN created: classify it for payroll with a head revision.')).toBeTruthy();
    expect((within(form).getByLabelText('Component code') as HTMLInputElement).value).toBe('');
    expect(bodiesTo('POST', '/v1/payroll/components')[1]).toEqual({ code: 'SYN_LOAN', name: 'Synthetic loan recovery', componentKind: 'DEDUCTION' });
  });

  it('labels rule-pack heads as blocking, activates only someone else’s draft and explains a missing definition in words', async () => {
    serve({
      'GET /v1/payroll/components': [200, PAY_COMPONENTS],
      'GET /v1/payroll/heads': [
        200,
        { items: [headRev(H_BASIC), headRev(H_PF, PF_DRAFT), headRev(H_HRA, { componentCode: 'HRA', componentName: 'Synthetic HRA', state: 'DRAFT', createdBy: U_ME, version: 1 })] },
      ],
      [`POST /v1/payroll/head-revisions/${H_PF}/activate`]: inTurn(refusal(422, 'MISSING_DEFINITION', 'Missing', { componentCode: 'PF_EMPLOYER', baseComponentCode: 'BASIC', date: '2026-11-01' }), [
        200,
        headRev(H_PF, { ...PF_DRAFT, state: 'ACTIVE', version: 2 }),
      ]),
      [`POST /v1/payroll/head-revisions/${H_HRA}/cancel`]: [200, headRev(H_HRA, { componentCode: 'HRA', state: 'CANCELLED', version: 2 })],
    });
    renderScreen('/payroll/heads', [CONFIG_READ, CONFIG_MANAGE, CONFIG_ACTIVATE]);
    const heads = await section('Head revisions');
    const table = await within(heads).findByRole('table', { name: 'Head revisions' });
    const pf = rowWith(table, 'PF_EMPLOYER · Synthetic employer PF');
    expect(pf.textContent).toContain('Rule pack SYN_PF');
    expect(pf.textContent).toContain('Base heads: BASIC');
    expect(pf.textContent).toContain('Blocks calculation until a rule pack exists');
    expect(cells(pf)[4]).toBe('Employer contribution');
    expect(cells(pf).slice(6, 9)).toEqual(['Half up to the nearest paisa', 'NON_TAXABLE', '20']);
    expect(rowWith(table, 'BASIC · Basic pay').textContent).not.toContain('Blocks calculation');
    const hra = rowWith(table, 'HRA · Synthetic HRA');
    expect(hra.textContent).toContain('You wrote it: someone else activates it');
    expect(within(hra).queryByRole('button', { name: /Activate/ })).toBeNull();
    fireEvent.click(button(table, 'Activate head PF_EMPLOYER revision 1'));
    expect(
      await within(heads).findByText(
        'A rule-pack head names a base head that is not defined and in use on that date (a missing definition), so it cannot be activated (pay component PF_EMPLOYER, base BASIC, on 1 Nov 2026).',
      ),
    ).toBeTruthy();
    await waitFor(() => expect(button(table, 'Cancel head HRA revision 1').disabled).toBe(false));
    fireEvent.click(button(table, 'Cancel head HRA revision 1'));
    expect(await within(heads).findByText('Draft revision 1 of head HRA was cancelled.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/payroll/head-revisions/${H_HRA}/cancel`)).toEqual([{ expectedVersion: 1 }]);
    await waitFor(() => expect(button(table, 'Activate head PF_EMPLOYER revision 1').disabled).toBe(false));
    fireEvent.click(button(table, 'Activate head PF_EMPLOYER revision 1'));
    expect(await within(heads).findByText('Head PF_EMPLOYER revision 1 is active from 1 Nov 2026.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/payroll/head-revisions/${H_PF}/activate`)).toEqual([{ expectedVersion: 1 }, { expectedVersion: 1 }]);
  });

  it('creates a head revision with nothing prefilled: a rule-pack head with its base heads, a refusal kept in words, and a discontinuation without a definition', async () => {
    serve({
      'GET /v1/payroll/components': [200, PAY_COMPONENTS],
      'GET /v1/payroll/heads': [200, { items: [] }],
      'POST /v1/payroll/heads': inTurn(refusal(422, 'UNKNOWN_TAX_TREATMENT'), [201, headRev(H_PF, PF_DRAFT)], [201, headRev('h4', { inUse: false, revision: 2, state: 'DRAFT' })]),
    });
    renderScreen('/payroll/heads', [CONFIG_READ, CONFIG_MANAGE]);
    const form = await screen.findByRole('form', { name: 'Create a head revision' });
    await waitFor(() => expect((within(form).getByLabelText('Pay component') as HTMLSelectElement).options).toHaveLength(3));
    expect((within(form).getByLabelText('Use') as HTMLSelectElement).value).toBe('');
    expect(within(form).queryByLabelText('Head type')).toBeNull();
    type(form, 'Pay component', 'PF_EMPLOYER');
    type(form, 'Effective from', '2026-11-01');
    type(form, 'Use', 'IN_USE');
    for (const field of ['Head type', 'Calculation basis', 'Rounding']) expect((within(form).getByLabelText(field) as HTMLSelectElement).value).toBe('');
    expect((within(form).getByLabelText('Tax treatment (from the company’s list)') as HTMLInputElement).value).toBe('');
    expect((within(form).getByLabelText('Display sequence') as HTMLInputElement).value).toBe('');
    fireEvent.click(button(form, 'Save the revision as a draft'));
    expect(within(form).getByText('Choose the head type, calculation basis, rounding and tax treatment.')).toBeTruthy();
    type(form, 'Head type', 'EMPLOYER_CONTRIBUTION');
    type(form, 'Calculation basis', 'RULE_PACK');
    expect(within(form).getByRole('note').textContent).toContain('Blocks calculation until a rule pack exists');
    type(form, 'Rounding', 'HALF_UP_MINOR_UNIT');
    type(form, 'Tax treatment (from the company’s list)', 'syn_exempt');
    type(form, 'Display sequence', '20');
    type(form, 'Rule pack code', 'syn_pf');
    expect(within(form).queryByLabelText('PF_EMPLOYER · Synthetic employer PF')).toBeNull();
    fireEvent.click(within(form).getByLabelText('BASIC · Basic pay'));
    const release = hold('POST /v1/payroll/heads');
    fireEvent.click(button(form, 'Save the revision as a draft'));
    expect(((await within(form).findByRole('button', { name: 'Saving…' })) as HTMLButtonElement).disabled).toBe(true);
    release();
    expect(await within(form).findByText('The tax treatment is not an active value of the company’s payroll tax treatment list.')).toBeTruthy();
    expect((within(form).getByLabelText('Tax treatment (from the company’s list)') as HTMLInputElement).value).toBe('syn_exempt');
    type(form, 'Tax treatment (from the company’s list)', 'NON_TAXABLE');
    await waitFor(() => expect(button(form, 'Save the revision as a draft').disabled).toBe(false));
    fireEvent.click(button(form, 'Save the revision as a draft'));
    expect(await within(form).findByText('Head PF_EMPLOYER revision 1 saved as a draft: someone other than you activates it.')).toBeTruthy();
    expect((within(form).getByLabelText('Use') as HTMLSelectElement).value).toBe('');
    const definition = {
      componentCode: 'PF_EMPLOYER',
      effectiveFrom: '2026-11-01',
      inUse: true,
      headType: 'EMPLOYER_CONTRIBUTION',
      calculationBasis: 'RULE_PACK',
      roundingRule: 'HALF_UP_MINOR_UNIT',
      displaySequence: 20,
      rulePackCode: 'SYN_PF',
      baseComponentCodes: ['BASIC'],
    };
    expect(bodiesTo('POST', '/v1/payroll/heads')).toEqual([
      { ...definition, taxTreatment: 'SYN_EXEMPT' },
      { ...definition, taxTreatment: 'NON_TAXABLE' },
    ]);
    type(form, 'Pay component', 'BASIC');
    type(form, 'Effective from', '2026-12-01');
    type(form, 'Use', 'DISCONTINUED');
    expect(within(form).queryByLabelText('Head type')).toBeNull();
    await waitFor(() => expect(button(form, 'Save the revision as a draft').disabled).toBe(false));
    fireEvent.click(button(form, 'Save the revision as a draft'));
    expect(await within(form).findByText('Head BASIC revision 2 saved as a draft: someone other than you activates it.')).toBeTruthy();
    expect(bodiesTo('POST', '/v1/payroll/heads')[2]).toEqual({ componentCode: 'BASIC', effectiveFrom: '2026-12-01', inUse: false });
  });
});

describe('salary components of an arrangement', () => {
  const ARRANGEMENTS = { employeeId: E_1, items: [{ id: ARR, effectiveFrom: '2026-04-01', effectiveTo: null, annualCtc: '1200000.0000', monthlyGross: '100000.0000', currency: 'INR' }] };
  const SET = {
    arrangementId: ARR,
    employeeId: E_1,
    effectiveFrom: '2026-04-01',
    effectiveTo: null,
    annualCtc: '1200000.0000',
    monthlyGross: '100000.0000',
    currencyCode: 'INR',
    components: [{ componentCode: 'BASIC', componentName: 'Basic pay', componentKind: 'EARNING', amount: '50000.0000', basis: 'MONTHLY' }],
    totals: [{ basis: 'MONTHLY', componentKind: 'EARNING', total: '50000.0000' }],
  };
  const NONE = { arrangementId: ARR, employeeId: E_1, effectiveFrom: '2026-04-01', effectiveTo: null, currencyCode: 'INR', components: [], totals: [] };
  const COMPONENTS_PATH = `/v1/payroll/salary-arrangements/${ARR}/components`;
  async function openArrangement() {
    const picker = await section('Salary components');
    await chooseEmployee(picker);
    fireEvent.click(await within(picker).findByRole('button', { name: 'Show the components of the arrangement from 1 Apr 2026' }));
    return section('Components of the arrangement');
  }

  it('is hidden without the salary read key, and shows set components exactly as returned with no way to set them again', async () => {
    serve({});
    renderScreen('/payroll/salary-components', [EMPLOYEE_LIST, CONFIG_READ]);
    expect(await screen.findByText('The selected role cannot see salary arrangements.')).toBeTruthy();
    await settle();
    expect(calls).toEqual([]);
    cleanup();
    serve({ 'GET /v1/employees': [200, EMPLOYEES], [`GET /v1/employees/${E_1}/salary`]: [200, ARRANGEMENTS], [`GET ${COMPONENTS_PATH}`]: [200, SET] });
    renderScreen('/payroll/salary-components', [SALARY_READ, SALARY_MANAGE, EMPLOYEE_LIST]);
    const view = await openArrangement();
    const table = await within(view).findByRole('table', { name: 'Salary components' });
    const basic = cells(rowWith(table, 'BASIC · Basic pay'));
    expect(basic.slice(0, 3)).toEqual(['BASIC · Basic pay', 'Earning', 'Monthly']);
    expect(basic[3]).toContain('50,000.00');
    expect(within(view).getByRole('table', { name: 'Component totals as returned' }).textContent).toContain('50,000.00');
    expect(view.textContent).toContain('Annual CTC');
    expect(view.textContent).toContain('Set once: a change is a new salary arrangement through the salary master.');
    expect(within(view).queryByRole('form', { name: 'Set the salary components' })).toBeNull();
    expect(callsTo('POST', COMPONENTS_PATH)).toHaveLength(0);
  });

  it('sets the components once with the amounts as typed and keeps the lines after a refusal', async () => {
    let isSet = false;
    const post = inTurn(refusal(422, 'UNKNOWN_COMPONENT', 'Unknown', { line: 2 }), [201, SET]);
    serve({
      'GET /v1/employees': [200, EMPLOYEES],
      [`GET /v1/employees/${E_1}/salary`]: [200, ARRANGEMENTS],
      'GET /v1/payroll/components': [200, PAY_COMPONENTS],
      [`GET ${COMPONENTS_PATH}`]: () => [200, isSet ? SET : NONE],
      [`POST ${COMPONENTS_PATH}`]: () => {
        const reply = post();
        if (!(reply instanceof Response) && reply[0] === 201) isSet = true;
        return reply;
      },
    });
    renderScreen('/payroll/salary-components', [SALARY_READ, SALARY_MANAGE, EMPLOYEE_LIST, CONFIG_READ]);
    const view = await openArrangement();
    const form = await within(view).findByRole('form', { name: 'Set the salary components' });
    expect(view.textContent).toContain('No salary components are set for this arrangement');
    expect(view.textContent).not.toContain('Annual CTC');
    expect(form.textContent).toContain('A fixed head needs a monthly salary component amount');
    expect((within(form).getByLabelText('Amount basis (line 1)') as HTMLSelectElement).value).toBe('');
    type(form, 'Pay component code (line 1)', 'basic');
    type(form, 'Amount (line 1)', '50000.00');
    type(form, 'Amount basis (line 1)', 'ANNUAL');
    await waitFor(() => expect(within(form).getByRole('note').textContent).toContain('Line 1: the head in effect for BASIC is fixed.'));
    type(form, 'Amount basis (line 1)', 'MONTHLY');
    expect(within(form).queryByRole('note')).toBeNull();
    fireEvent.click(button(form, 'Add a line'));
    type(form, 'Pay component code (line 2)', 'syn_bonus');
    type(form, 'Amount (line 2)', '1200');
    fireEvent.click(button(form, 'Set the components'));
    expect(within(form).getByText('Choose whether the amount of line 2 is monthly or annual.')).toBeTruthy();
    type(form, 'Amount basis (line 2)', 'ANNUAL');
    const release = hold(`POST ${COMPONENTS_PATH}`);
    fireEvent.click(button(form, 'Set the components'));
    expect(((await within(form).findByRole('button', { name: 'Saving…' })) as HTMLButtonElement).disabled).toBe(true);
    release();
    expect(await within(view).findByText('No active pay component has this code (line 2).')).toBeTruthy();
    expect((within(form).getByLabelText('Pay component code (line 2)') as HTMLInputElement).value).toBe('syn_bonus');
    await waitFor(() => expect(button(form, 'Set the components').disabled).toBe(false));
    fireEvent.click(button(form, 'Set the components'));
    expect(await within(view).findByText('The salary components are set. They are fixed now: a change is a new salary arrangement.')).toBeTruthy();
    await within(view).findByRole('table', { name: 'Salary components' });
    expect(within(view).queryByRole('form', { name: 'Set the salary components' })).toBeNull();
    const sent = { components: [{ componentCode: 'BASIC', amount: '50000.00', basis: 'MONTHLY' }, { componentCode: 'SYN_BONUS', amount: '1200', basis: 'ANNUAL' }] };
    expect(bodiesTo('POST', COMPONENTS_PATH)).toEqual([sent, sent]);
  });

  it('explains COMPONENTS_ALREADY_SET in words and then shows the components set meanwhile; offers no setting without the manage key', async () => {
    let isSet = false;
    serve({
      'GET /v1/employees': [200, EMPLOYEES],
      [`GET /v1/employees/${E_1}/salary`]: [200, ARRANGEMENTS],
      [`GET ${COMPONENTS_PATH}`]: () => [200, isSet ? SET : NONE],
      [`POST ${COMPONENTS_PATH}`]: () => {
        isSet = true;
        return refusal(409, 'COMPONENTS_ALREADY_SET');
      },
    });
    renderScreen('/payroll/salary-components', [SALARY_READ, SALARY_MANAGE, EMPLOYEE_LIST]);
    const view = await openArrangement();
    const form = await within(view).findByRole('form', { name: 'Set the salary components' });
    type(form, 'Pay component code (line 1)', 'BASIC');
    type(form, 'Amount (line 1)', '50000');
    type(form, 'Amount basis (line 1)', 'MONTHLY');
    fireEvent.click(button(form, 'Set the components'));
    expect(
      await within(view).findByText('The components of this arrangement are already set. They are set once: a change is a new salary arrangement through the salary master.'),
    ).toBeTruthy();
    await within(view).findByRole('table', { name: 'Salary components' });
    cleanup();
    serve({ 'GET /v1/employees': [200, EMPLOYEES], [`GET /v1/employees/${E_1}/salary`]: [200, ARRANGEMENTS], [`GET ${COMPONENTS_PATH}`]: [200, NONE] });
    renderScreen('/payroll/salary-components', [SALARY_READ, EMPLOYEE_LIST]);
    const readOnly = await openArrangement();
    await within(readOnly).findByText(/No salary components are set for this arrangement/);
    expect(within(readOnly).queryByRole('form', { name: 'Set the salary components' })).toBeNull();
  });

  describe('earlier arrangements the server withholds (I-68)', () => {
    const NOTE = 'Earlier arrangements are not shown: the selected role has no salary history grant.';
    async function listFor(answer: object) {
      serve({ 'GET /v1/employees': [200, EMPLOYEES], [`GET /v1/employees/${E_1}/salary`]: [200, answer] });
      renderScreen('/payroll/salary-components', [SALARY_READ, EMPLOYEE_LIST]);
      const picker = await section('Salary components');
      await chooseEmployee(picker);
      return picker;
    }

    it('says so under the arrangements still shown', async () => {
      const picker = await listFor({ ...ARRANGEMENTS, historyIncluded: false });
      await within(picker).findByRole('table', { name: 'Salary arrangements' });
      expect(within(picker).getByText(NOTE)).toBeTruthy();
    });

    it('does not say the employee never had one when every arrangement is withheld', async () => {
      const picker = await listFor({ ...ARRANGEMENTS, items: [], historyIncluded: false });
      await within(picker).findByText('The employee has no salary arrangement in force today or later.');
      expect(within(picker).getByText(NOTE)).toBeTruthy();
      expect(within(picker).queryByText('The employee has no salary arrangement yet.')).toBeNull();
    });

    it('claims nothing is withheld when the role holds the grant', async () => {
      const picker = await listFor({ ...ARRANGEMENTS, historyIncluded: true });
      await within(picker).findByRole('table', { name: 'Salary arrangements' });
      expect(within(picker).queryByText(NOTE)).toBeNull();
      cleanup();
      const none = await listFor({ ...ARRANGEMENTS, items: [], historyIncluded: true });
      await within(none).findByText('The employee has no salary arrangement yet.');
      expect(within(none).queryByText(NOTE)).toBeNull();
    });
  });
});
