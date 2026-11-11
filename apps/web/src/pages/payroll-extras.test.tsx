// Payroll inputs and reports screens (jsdom; BRD coverage CL-074, CL-081, CL-084, CL-085, CL-097, CL-098, CL-100, CL-113, CL-119): each
// screen asks the right route, sends what the form says, shows the server's NOT_CONFIGURED reasons instead of numbers, and offers
// actions only to the keys that allow them. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentType } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChallanMasterPage,
  EdocExportPage,
  fiscalYearOf,
  LiabilityProvisionsPage,
  MedicalClaimsPage,
  parseMappingLines,
  PAYROLL_EXTRAS_SCREENS,
  SalaryJvPage,
  TaxInputsPage,
  TdsChallansPage,
} from './payroll-extras';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({ stored: { companyId: 'c-1', assignmentId: 'a-1' }, me: { employeeId: null, scopeKind: 'COMPANY' }, can: (p: string) => session.permissions.includes(p) }),
}));

type Call = { method: string; url: string; body: Record<string, unknown> | undefined };
type Reply = [number, unknown];
/** Answers by "METHOD path-prefix"; an import's own batch list answers an empty page. */
function serve(routes: Record<string, Reply | (() => Reply)>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      const key = Object.keys(routes)
        .filter((k) => `${method} ${url}`.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const found = key ? routes[key] : undefined;
      const [status, body] = found ? (typeof found === 'function' ? found() : found) : /-imports\?page=/.test(url) ? [200, { items: [], total: 0, page: 1, pageSize: 10 }] : [404, { error: 'NOT_FOUND', message: 'Not found' }];
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}
const show = (Page: ComponentType) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

describe('payroll inputs and reports screens (CL-074 to CL-119)', () => {
  it('lists seven payroll menu screens, each under its own read key', () => {
    expect(PAYROLL_EXTRAS_SCREENS.map((s) => [s.path, s.permission, s.nav])).toEqual([
      ['/payroll/challan-master', 'payroll_challan.read.operational', true],
      ['/payroll/tds-challans', 'payroll_challan.read.operational', true],
      ['/payroll/tax-inputs', 'payroll_tax_input.read.amount', true],
      ['/payroll/medical-claims', 'expense.read.operational', true],
      ['/payroll/liability-provisions', 'payroll_report.read.amount', true],
      ['/payroll/salary-jv', 'payroll_gl_mapping.read.operational', true],
      ['/payroll/edoc-export', 'payroll_output.export.amount', true],
    ]);
    expect(fiscalYearOf('2026-03-31')).toBe('2025-26');
    expect(fiscalYearOf('2026-04-01')).toBe('2026-27');
    expect(parseMappingLines('JV_BASIC = 5100\n\nJV_ER=5200/2200\n')).toEqual([
      { componentCode: 'JV_BASIC', accountCode: '5100' },
      { componentCode: 'JV_ER', accountCode: '5200', payableAccountCode: '2200' },
    ]);
  });

  it('CL-074: shows the revision in force per statute and records a new TDS revision with its TAN and reason', async () => {
    session.permissions = ['payroll_challan.read.operational', 'payroll_challan.manage.operational'];
    const calls = serve({
      'GET /v1/payroll-extras/challan-settings': [
        200,
        {
          asOf: '2026-11-11',
          inForce: { TDS: { id: 's1', statute: 'TDS', revision: 2, effectiveFrom: '2026-04-01', tan: 'ABCD12345E', establishmentCode: null, bankName: 'Synthetic Bank', bankBranch: null, bsrCode: '0510001', reason: 'x' }, PF: null, ESIC: null },
          items: [],
        },
      ],
      'POST /v1/payroll-extras/challan-settings': [201, { id: 's2' }],
    });
    show(ChallanMasterPage);
    const table = await screen.findByRole('table', { name: 'In force' });
    expect(within(table).getByText('ABCD12345E')).toBeTruthy();
    expect(within(table).getAllByText('Not recorded')).toHaveLength(2);
    const form = screen.getByRole('form', { name: 'New revision' });
    fireEvent.change(within(form).getByLabelText('TAN'), { target: { value: 'WXYZ54321A' } });
    fireEvent.change(within(form).getByLabelText('Bank'), { target: { value: 'Other Bank' } });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Bank change' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record revision' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ statute: 'TDS', tan: 'WXYZ54321A', bankName: 'Other Bank', reason: 'Bank change', bsrCode: null });
  });

  it('CL-074: a reader sees no form, and a role without the read key sees why', async () => {
    session.permissions = ['payroll_challan.read.operational'];
    serve({ 'GET /v1/payroll-extras/challan-settings': [200, { asOf: '2026-11-11', inForce: { TDS: null, PF: null, ESIC: null }, items: [] }] });
    show(ChallanMasterPage);
    await screen.findByRole('table', { name: 'In force' });
    expect(screen.queryByRole('form', { name: 'New revision' })).toBeNull();
    cleanup();
    session.permissions = [];
    show(ChallanMasterPage);
    expect(screen.getByText(/needs the challan read duty/)).toBeTruthy();
  });

  it('CL-081: lists the year’s challans, reconciles with the TDS deducted only with the report key, and records one', async () => {
    session.permissions = ['payroll_challan.read.operational', 'payroll_challan.manage.operational', 'payroll_report.read.amount'];
    const challan = { id: 'c1', month: '2026-04', section: '192', bsrCode: '0510001', challanSerial: '00012', depositDate: '2026-05-07', amount: '15000.50', source: 'SCREEN', state: 'RECORDED', cancelReason: null, version: 1 };
    const calls = serve({
      'GET /v1/payroll-extras/tds-challans': [200, { items: [challan], months: [{ month: '2026-04', deposited: '15000.5000' }] }],
      'GET /v1/payroll-extras/tds-reconciliation': [
        200,
        { form24Q: { status: 'NOT_CONFIGURED', reason: 'The return needs the owner’s template.' }, months: [{ month: '2026-04', deducted: '15000.5000', deposited: '15000.5000', difference: '0.0000', status: 'MATCHED' }] },
      ],
      'POST /v1/payroll-extras/tds-challans': [201, challan],
    });
    show(TdsChallansPage);
    expect(within(await screen.findByRole('table', { name: 'Challans' })).getByText('00012')).toBeTruthy();
    expect(within(await screen.findByRole('table', { name: 'Reconciliation' })).getByText('matched')).toBeTruthy();
    expect(screen.getByText(/Form 24Q: not configured/)).toBeTruthy();
    // The upload uses the shared batch screens with its published template.
    expect(screen.getByText('month,section,bsrCode,challanSerial,depositDate,amount')).toBeTruthy();
    const form = screen.getByRole('form', { name: 'Enter a challan' });
    fireEvent.change(within(form).getByLabelText('Month'), { target: { value: '2026-05' } });
    expect((within(form).getByLabelText('Section') as HTMLInputElement).value).toBe('');
    fireEvent.change(within(form).getByLabelText('Section'), { target: { value: '192' } });
    fireEvent.change(within(form).getByLabelText('BSR code'), { target: { value: '0510001' } });
    fireEvent.change(within(form).getByLabelText('Challan serial'), { target: { value: '13' } });
    fireEvent.change(within(form).getByLabelText('Deposit date'), { target: { value: '2026-06-07' } });
    fireEvent.change(within(form).getByLabelText('Amount'), { target: { value: '900' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record challan' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/v1/payroll-extras/tds-challans')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ month: '2026-05', section: '192', bsrCode: '0510001', challanSerial: '13', depositDate: '2026-06-07', amount: '900' });
    expect(calls.some((c) => c.url.startsWith('/v1/payroll-extras/tds-challans?fiscalYear='))).toBe(true);
  });

  it('CL-081: amounts the server hides (no payroll report read duty) read Hidden, never a dash or zero', async () => {
    session.permissions = ['payroll_challan.read.operational'];
    const challan = { id: 'c1', month: '2026-04', section: '192', bsrCode: '0510001', challanSerial: '00012', depositDate: '2026-05-07', amount: null, source: 'SCREEN', state: 'RECORDED', cancelReason: null, version: 1 };
    serve({ 'GET /v1/payroll-extras/tds-challans': [200, { amountsHidden: true, items: [challan], months: [{ month: '2026-04', deposited: null }], deposited: null }] });
    show(TdsChallansPage);
    const table = await screen.findByRole('table', { name: 'Challans' });
    const row = within(table).getByText('00012').closest('tr')!;
    expect(within(row).getByText('Hidden')).toBeTruthy();
    expect(row.textContent).not.toContain('—');
    expect(screen.getByText(/seeing them needs the payroll report read duty/)).toBeTruthy();
  });

  it('CL-081: shown amounts are formatted when the server sends them', async () => {
    session.permissions = ['payroll_challan.read.operational'];
    const challan = { id: 'c1', month: '2026-04', section: '192', bsrCode: '0510001', challanSerial: '00012', depositDate: '2026-05-07', amount: '15000.50', source: 'SCREEN', state: 'RECORDED', cancelReason: null, version: 1 };
    serve({ 'GET /v1/payroll-extras/tds-challans': [200, { amountsHidden: false, items: [challan], months: [{ month: '2026-04', deposited: '15000.5000' }], deposited: '15000.5000' }] });
    show(TdsChallansPage);
    const row = within(await screen.findByRole('table', { name: 'Challans' })).getByText('00012').closest('tr')!;
    expect(row.textContent).toContain('15,000.50');
    expect(row.textContent).not.toContain('Hidden');
    expect(screen.queryByText(/seeing them needs the payroll report read duty/)).toBeNull();
  });

  it('CL-081: without the report key there is no reconciliation request, and without manage no entry or upload', async () => {
    session.permissions = ['payroll_challan.read.operational'];
    const calls = serve({ 'GET /v1/payroll-extras/tds-challans': [200, { items: [], months: [] }] });
    show(TdsChallansPage);
    expect(await screen.findByText(/No challan is recorded/)).toBeTruthy();
    expect(calls.some((c) => c.url.includes('tds-reconciliation'))).toBe(false);
    expect(screen.queryByRole('form', { name: 'Enter a challan' })).toBeNull();
    expect(screen.queryByText('Upload TDS challans')).toBeNull();
  });

  it('CL-084 CL-085: shows that the tax projection does not read the recorded inputs, and offers the uploads to the import key only', async () => {
    session.permissions = ['payroll_tax_input.read.amount'];
    serve({
      'GET /v1/payroll-extras/tax-inputs': [
        200,
        {
          tdsProjection: { status: 'NOT_FED', reason: 'These values change no tax until it does.' },
          items: [{ employeeId: 'e1', employeeCode: 'E1', employeeName: 'Asha Rao', perquisites: [{ month: '2026-05', perquisiteType: 'MOTOR_CAR', value: '2400.50', revision: 1 }], pastSalary: [] }],
        },
      ],
    });
    show(TaxInputsPage);
    expect((await screen.findByRole('note')).textContent).toContain('Tax projection: not fed. These values change no tax until it does.');
    expect(within(screen.getByRole('table', { name: 'Recorded inputs' })).getByText(/2026-05 motor car 2,400.50/)).toBeTruthy();
    expect(screen.queryByText('Upload perquisites')).toBeNull();
    cleanup();
    session.permissions = ['payroll_tax_input.read.amount', 'payroll_tax_input.import.amount'];
    show(TaxInputsPage);
    expect(await screen.findByText('Upload perquisites')).toBeTruthy();
    expect(screen.getByText('Upload past salary')).toBeTruthy();
    expect(screen.getByText('employeeCode,financialYear,source,fromMonth,toMonth,taxableSalary,tdsDeducted')).toBeTruthy();
  });

  it('CL-113: asks for the period and search given and lists the medical lines', async () => {
    session.permissions = ['expense.read.operational'];
    const calls = serve({
      'GET /v1/payroll-extras/medical-claims': [
        200,
        {
          items: [
            { employee_code: 'E1', employee_name: 'Asha Rao', department: 'ENG', claim_id: 'k1', claim_state: 'MANAGER_PENDING', payment_state: 'NOT_APPLICABLE', expense_date: '2026-11-08', category: 'MEDICAL', merchant: 'Synthetic Clinic', claimed_amount: '1500.00', approved_amount: '', currency: 'INR', line: 1 },
          ],
        },
      ],
    });
    show(MedicalClaimsPage);
    expect(within(await screen.findByRole('table', { name: 'Medical claims' })).getByText('Synthetic Clinic')).toBeTruthy();
    const form = screen.getByRole('form', { name: 'Medical claim filters' });
    fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(within(form).getByLabelText('To'), { target: { value: '2026-10-31' } });
    fireEvent.change(within(form).getByLabelText('Search'), { target: { value: 'clinic' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/payroll-extras/medical-claims?from=2026-10-01&to=2026-10-31&search=clinic')).toBe(true));
  });

  it('CL-098: worked from salaries, the screen needs the salary read duty as well, and asks nothing without it', async () => {
    session.permissions = ['payroll_report.read.amount'];
    const calls = serve({});
    show(LiabilityProvisionsPage);
    expect(screen.getByText(/need the salary read duty as well/)).toBeTruthy();
    expect(calls.some((c) => c.url.includes('liability-provisions'))).toBe(false);
  });

  it('CL-098: an item without its rule reads not configured with the reason and no number; department totals per item', async () => {
    session.permissions = ['payroll_report.read.amount', 'salary.read.salary'];
    serve({
      'GET /v1/payroll-extras/liability-provisions': [
        200,
        {
          asOf: '2026-10-31',
          employees: 2,
          items: [
            { item: 'GRATUITY', status: 'NOT_CONFIGURED', reason: 'RULE_PACK_NOT_ACTIVE', totals: [], rows: 0, unresolved: 0 },
            { item: 'STATUTORY_BONUS', status: 'NOT_CONFIGURED', reason: 'RULE_PACK_NOT_DEFINED', totals: [], rows: 0, unresolved: 0 },
            { item: 'LEAVE_ENCASHMENT', status: 'CALCULATED', reason: null, totals: [{ currencyCode: 'INR', amount: '10400.0000' }], rows: 1, unresolved: 0 },
            { item: 'NOTICE_PAY', status: 'CALCULATED', reason: null, totals: [], rows: 0, unresolved: 0 },
          ],
          departments: [{ departmentCode: 'ENG', department: 'Engineering', currencyCode: 'INR', amounts: { LEAVE_ENCASHMENT: '10400.0000' }, total: '10400.0000' }],
          rows: [{ item: 'LEAVE_ENCASHMENT', status: 'CALCULATED', employeeCode: 'E1', employeeName: 'Asha Rao', department: 'Engineering', amount: '10400.0000', vested: '', basis: 'ANNUAL balance at the day rate of Basic + DA' }],
        },
      ],
    });
    show(LiabilityProvisionsPage);
    const items = await screen.findByRole('table', { name: 'Provision items' });
    const gratuity = within(items).getByText('Gratuity').closest('tr')!;
    expect(gratuity.textContent).toContain('not configured: rule pack not active');
    expect(gratuity.textContent).toContain('—');
    expect(within(items).getByText('Leave encashment').closest('tr')!.textContent).toContain('INR 10,400.00');
    expect(within(screen.getByRole('table', { name: 'By department' })).getByText('Engineering')).toBeTruthy();
  });

  it('CL-097: names the heads still to map, then shows a balanced voucher and requests its export', async () => {
    session.permissions = ['payroll_gl_mapping.read.operational', 'payroll_report.read.amount', 'payroll_report.export.amount'];
    let ready = false;
    const calls = serve({
      'GET /v1/payroll-extras/gl-mappings': [200, { inForce: null, items: [] }],
      'GET /v1/payroll-extras/runs/r1/salary-jv': () =>
        ready
          ? [
              200,
              {
                status: 'READY',
                reason: null,
                periodCode: '2026-01',
                voucherDate: '2026-01-31',
                missing: [],
                mappingRevision: 3,
                lines: [
                  { side: 'DEBIT', accountCode: '5100', accountName: 'Salaries', costCentre: 'ENG', componentCode: 'JV_BASIC', narration: 'Basic, 2026-01', amount: '100.0000' },
                  { side: 'CREDIT', accountCode: '2000', accountName: '', costCentre: '', componentCode: '', narration: 'Net salary payable, 2026-01', amount: '100.0000' },
                ],
                totals: { debit: '100.0000', credit: '100.0000', balanced: true },
              },
            ]
          : [200, { status: 'NOT_CONFIGURED', reason: 'HEADS_NOT_MAPPED', periodCode: '2026-01', voucherDate: '2026-01-31', missing: [{ componentCode: 'JV_ER', problem: 'NO_PAYABLE_ACCOUNT' }], mappingRevision: 2, lines: [], totals: null }],
      'POST /v1/reports': [202, { id: 'x1', state: 'QUEUED' }],
    });
    show(SalaryJvPage);
    expect(await screen.findByText(/No GL mapping is in force/)).toBeTruthy();
    const form = screen.getByRole('form', { name: 'Payroll run' });
    fireEvent.change(within(form).getByLabelText('Payroll run id'), { target: { value: 'r1' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Show voucher' }));
    expect((await screen.findByText(/Not configured/)).textContent).toContain('map JV_ER (no payable account).');
    ready = true;
    cleanup();
    show(SalaryJvPage);
    const again = screen.getByRole('form', { name: 'Payroll run' });
    fireEvent.change(within(again).getByLabelText('Payroll run id'), { target: { value: 'r1' } });
    fireEvent.click(within(again).getByRole('button', { name: 'Show voucher' }));
    expect(within(await screen.findByRole('table', { name: 'Voucher' })).getByText('ENG')).toBeTruthy();
    expect(screen.getByText(/debits 100.00, credits 100.00, balanced/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Request CSV / XLSX export' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === '/v1/reports')?.body).toEqual({ reportCode: 'SALARY_JV', filters: { runId: 'r1' } }));
    expect(screen.queryByRole('form', { name: 'New mapping revision' })).toBeNull();
  });

  it('CL-097: a role that may list runs picks an approved or processed run instead of typing its id', async () => {
    session.permissions = ['payroll_gl_mapping.read.operational', 'payroll_report.read.amount', 'payroll_run.read.amount'];
    const calls = serve({
      'GET /v1/payroll-extras/gl-mappings': [200, { inForce: null, items: [] }],
      'GET /v1/payroll/runs': [200, { items: [{ id: 'r2', revision: 1, state: 'PROCESSED_LOCKED', periodCode: '2026-02' }, { id: 'r1', revision: 2, state: 'APPROVED', periodCode: '2026-01' }], total: 2 }],
      'GET /v1/payroll-extras/runs/r2/salary-jv': [200, { status: 'NOT_CONFIGURED', reason: 'NO_MAPPING', periodCode: '2026-02', voucherDate: '2026-02-28', missing: [], mappingRevision: null, lines: [], totals: null }],
    });
    show(SalaryJvPage);
    const form = await screen.findByRole('form', { name: 'Payroll run' });
    const select = await within(form).findByLabelText('Payroll run');
    expect(within(form).queryByLabelText('Payroll run id')).toBeNull();
    expect(within(select).getByRole('option', { name: '2026-02 · revision 1 · processed' })).toBeTruthy();
    expect(calls.find((c) => c.url.startsWith('/v1/payroll/runs'))!.url).toBe('/v1/payroll/runs?states=APPROVED,PROCESSED_LOCKED&page=1&pageSize=50');
    fireEvent.change(select, { target: { value: 'r2' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Show voucher' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/payroll-extras/runs/r2/salary-jv')).toBe(true));
  });

  it('CL-100: starts the background export for the month, follows the job and offers the ZIP once completed', async () => {
    session.permissions = ['payroll_output.export.amount'];
    const calls = serve({
      'POST /v1/payroll-extras/edoc-exports': [202, { jobId: 'j1', state: 'QUEUED' }],
      'GET /v1/bulk-jobs/j1': () => [
        200,
        { id: 'j1', kind: 'PAYSLIP_EDOC_EXPORT', state: 'COMPLETED', parameters: { month: '2026-01' }, processed: 3, result: { month: '2026-01', files: 3 }, errorCode: null, attempts: 0, nextAttemptAt: null, createdAt: '', startedAt: '', finishedAt: '' },
      ],
    });
    show(EdocExportPage);
    const form = screen.getByRole('form', { name: 'EDOC export' });
    fireEvent.change(within(form).getByLabelText('Month'), { target: { value: '2026-01' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Prepare export' }));
    expect((await screen.findByText(/Ready: 3 payslip PDFs for 2026-01/)).textContent).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download ZIP' })).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ month: '2026-01' });
    expect(String(post.body!.idempotencyKey)).toMatch(/^edoc-/);
  });
});
