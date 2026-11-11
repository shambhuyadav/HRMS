// Statutory files screen (jsdom; batch R4: CL-093, CL-105 to CL-107): it lists the outputs with the server's NOT_CONFIGURED reasons, asks
// the right status and file routes for a run or a period, shows row errors and offers the download only when the file is ready and the
// keys allow it, and runs the format flow (set up, sample, accept with a reference) under the maker and checker keys. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fiscalYearOf, MISSING_TEXT, periodQuery, STATUTORY_FILE_SCREENS, type StatutoryOutput, StatutoryFilesPage } from './statutory-files';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({ stored: { companyId: 'c-1', assignmentId: 'a-1' }, me: { employeeId: null, scopeKind: 'COMPANY' }, can: (p: string) => session.permissions.includes(p) }),
}));

type Call = { method: string; url: string; body: Record<string, unknown> | undefined };
type Reply = [number, unknown];
/** Answers by "METHOD path-prefix" (the longest matching prefix wins). */
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
      const [status, body] = found ? (typeof found === 'function' ? found() : found) : [404, { error: 'NOT_FOUND', message: 'Not found' }];
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' } });
    }),
  );
  return calls;
}
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <StatutoryFilesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

const output = (code: string, over: Partial<StatutoryOutput> = {}): StatutoryOutput => ({
  code,
  title: code === 'PF_ECR' ? 'EPFO ECR (electronic challan cum return)' : 'TDS quarterly summary (Form 27A control totals)',
  clause: code === 'PF_ECR' ? 'CL-106' : 'CL-093',
  period: code === 'PF_ECR' ? 'RUN' : 'QUARTER',
  packFamily: code === 'PF_ECR' ? 'PF' : 'INCOME_TAX',
  formats: code === 'PF_ECR' ? ['txt'] : ['csv', 'xlsx'],
  identifiers: code === 'PF_ECR',
  upload: code === 'PF_ECR',
  notice: `${code} notice`,
  status: 'NOT_CONFIGURED',
  missing: [
    { code: 'RULE_PACK_NOT_ACTIVE', pack: 'PF', message: 'PF has no ACTIVE revision in effect today' },
    { code: 'FORMAT_NOT_ACCEPTED', message: 'No accepted PF_ECR format is in force' },
  ],
  format: null,
  ...over,
});
const OUTPUTS = { items: [output('PF_ECR'), output('TDS_QUARTERLY')] };
const NO_FORMATS = { inForce: [{ outputCode: 'PF_ECR', format: null, sampleCurrent: null }], items: [] };
const RUNS = { items: [{ id: 'run-oct', revision: 1, periodCode: '2026-10' }] };
const ready = {
  status: 'AVAILABLE',
  ready: true,
  missing: [],
  selfIncluded: false,
  rowCount: 4,
  rowErrors: [],
  warnings: [{ code: 'REFUND_OF_ADVANCES_NOT_RECORDED', detail: 'Refund of advances is written 0: this payroll records no refund of PF advances.' }],
  totals: { members: 4, epfContribution: '5574' },
  packs: [{ packCode: 'PF', packRevision: 1 }],
  files: [{ format: 'txt', fileName: 'PF_ECR_2026-10_run-aaaaaaaa-rev1_pack-PF-rev1.txt' }],
  format: { revision: 1, formatReference: 'ECR 2.0', effectiveFrom: '2026-04-01' },
  period: { label: '2026-10', from: '2026-10-01', to: '2026-10-31' },
};

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:statutory-file');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

describe('statutory files screen (CL-093, CL-105 to CL-107)', () => {
  it('is one payroll menu screen under the statutory output read key; the period queries', () => {
    expect(STATUTORY_FILE_SCREENS.map((s) => [s.path, s.title, s.permission, s.nav])).toEqual([['/payroll/statutory/files', 'Statutory files', 'payroll_statutory.read.operational', true]]);
    expect(fiscalYearOf('2027-03-31')).toBe('2026-27');
    expect(periodQuery('RUN', { runId: ' r-1 ', fiscalYear: '2026-27', quarter: '3', half: '2' })).toBe('runId=r-1');
    expect(periodQuery('QUARTER', { runId: '', fiscalYear: '2026-27', quarter: '3', half: '2' })).toBe('fiscalYear=2026-27&quarter=3');
    expect(periodQuery('HALF_YEAR', { runId: '', fiscalYear: '2026-27', quarter: '3', half: '2' })).toBe('fiscalYear=2026-27&half=2');
  });

  it('without the read key it says why; with it, each output shows what is missing in plain words', async () => {
    show();
    expect(screen.getByText(/need the statutory output read duty/)).toBeTruthy();
    cleanup();
    session.permissions = ['payroll_statutory.read.operational'];
    serve({ 'GET /v1/statutory-files/outputs': [200, OUTPUTS], 'GET /v1/statutory-files/formats': [200, NO_FORMATS] });
    show();
    expect(await screen.findByText(MISSING_TEXT.RULE_PACK_NOT_ACTIVE!, { exact: false })).toBeTruthy();
    expect(screen.getByText(MISSING_TEXT.FORMAT_NOT_ACCEPTED!, { exact: false })).toBeTruthy();
    expect(within(screen.getByRole('form', { name: 'Output' })).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'EPFO ECR (electronic challan cum return) (CL-106)',
      'TDS quarterly summary (Form 27A control totals) (CL-093)',
    ]);
    expect(await screen.findByText('No accepted format is in force for this output.')).toBeTruthy();
    // Neither the maker's form nor any acceptance without their keys.
    expect(screen.queryByRole('form', { name: 'Set up a format' })).toBeNull();
  });

  it('a run’s status: row errors and no download; when ready, the download asks the file route of that run', async () => {
    session.permissions = ['payroll_statutory.read.operational', 'payroll_report.read.amount', 'payroll_report.export.amount', 'employee.read.payroll_id', 'payroll_run.read.amount'];
    let answer: unknown = { ...ready, ready: false, rowErrors: [{ employeeCode: 'SYN004', code: 'MISSING_UAN', field: 'uan' }] };
    const calls = serve({
      'GET /v1/statutory-files/outputs/PF_ECR/status': () => [200, answer],
      'GET /v1/statutory-files/outputs/PF_ECR/file': [200, '100000000001#~#Synthetic Asha'],
      'GET /v1/statutory-files/outputs': [200, { items: [output('PF_ECR', { status: 'AVAILABLE', missing: [] })] }],
      'GET /v1/statutory-files/formats': [200, NO_FORMATS],
      'GET /v1/payroll/runs': [200, RUNS],
    });
    show();
    const period = await screen.findByRole('form', { name: 'Period' });
    await within(period).findByRole('option', { name: '2026-10 · revision 1' });
    fireEvent.change(within(period).getByLabelText('Payroll run'), { target: { value: 'run-oct' } });
    fireEvent.click(within(period).getByRole('button', { name: 'Show status' }));
    const errors = await screen.findByRole('table', { name: 'Row errors' });
    expect(within(errors).getByText('SYN004')).toBeTruthy();
    expect(within(errors).getByText('No UAN is recorded')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download TXT' })).toBeNull();
    expect(calls.find((c) => c.url.startsWith('/v1/statutory-files/outputs/PF_ECR/status'))!.url).toBe('/v1/statutory-files/outputs/PF_ECR/status?runId=run-oct');
    cleanup();
    answer = ready;
    show();
    const again = await screen.findByRole('form', { name: 'Period' });
    await within(again).findByRole('option', { name: '2026-10 · revision 1' });
    fireEvent.change(within(again).getByLabelText('Payroll run'), { target: { value: 'run-oct' } });
    fireEvent.click(within(again).getByRole('button', { name: 'Show status' }));
    const totals = await screen.findByRole('table', { name: 'Totals' });
    expect(within(totals).getByText('5574')).toBeTruthy();
    expect(screen.getByText(/Refund of advances is written 0/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download TXT' }));
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/v1/statutory-files/outputs/PF_ECR/file'))).toBe(true));
    expect(calls.find((c) => c.url.startsWith('/v1/statutory-files/outputs/PF_ECR/file'))!.url).toBe('/v1/statutory-files/outputs/PF_ECR/file?runId=run-oct&format=txt');
  });

  it('a file that carries UAN numbers is not offered without the payroll identifier key; a NOT_CONFIGURED period shows what is missing', async () => {
    session.permissions = ['payroll_statutory.read.operational', 'payroll_report.read.amount', 'payroll_report.export.amount'];
    let answer: unknown = ready;
    serve({
      'GET /v1/statutory-files/outputs/PF_ECR/status': () => [200, answer],
      'GET /v1/statutory-files/outputs': [200, { items: [output('PF_ECR', { status: 'AVAILABLE', missing: [] })] }],
      'GET /v1/statutory-files/formats': [200, NO_FORMATS],
    });
    show();
    const period = await screen.findByRole('form', { name: 'Period' });
    fireEvent.change(within(period).getByLabelText('Payroll run id'), { target: { value: 'run-oct' } });
    fireEvent.click(within(period).getByRole('button', { name: 'Show status' }));
    expect(await screen.findByText(/payroll identifier read duty/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download TXT' })).toBeNull();
    cleanup();
    answer = { status: 'NOT_CONFIGURED', ready: false, missing: [{ code: 'RULE_PACK_NOT_ACTIVE', pack: 'PF', message: 'PF has no ACTIVE revision in effect on 2026-10-31' }], warnings: [], packs: [], format: null, period: ready.period };
    show();
    const again = await screen.findByRole('form', { name: 'Period' });
    fireEvent.change(within(again).getByLabelText('Payroll run id'), { target: { value: 'run-oct' } });
    fireEvent.click(within(again).getByRole('button', { name: 'Show status' }));
    expect(await screen.findByText(/in effect on 2026-10-31/)).toBeTruthy();
  });

  it('row errors about UAN or IP numbers withheld from a reader without the identifier key are counted, never listed', async () => {
    session.permissions = ['payroll_statutory.read.operational', 'payroll_report.read.amount'];
    serve({
      'GET /v1/statutory-files/outputs/PF_ECR/status': [200, { ...ready, ready: false, rowErrors: [], identifierErrorsWithheld: 2 }],
      'GET /v1/statutory-files/outputs': [200, { items: [output('PF_ECR', { status: 'AVAILABLE', missing: [] })] }],
      'GET /v1/statutory-files/formats': [200, NO_FORMATS],
    });
    show();
    const period = await screen.findByRole('form', { name: 'Period' });
    fireEvent.change(within(period).getByLabelText('Payroll run id'), { target: { value: 'run-oct' } });
    fireEvent.click(within(period).getByRole('button', { name: 'Show status' }));
    expect(await screen.findByText(/2 rows have a missing, invalid or unreadable UAN or IP number/)).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Row errors' })).toBeNull();
  });

  it('a quarter’s status asks the financial year and quarter', async () => {
    session.permissions = ['payroll_statutory.read.operational', 'payroll_report.read.amount'];
    const calls = serve({
      'GET /v1/statutory-files/outputs/TDS_QUARTERLY/status': [200, { ...ready, packs: [{ packCode: 'INCOME_TAX', packRevision: 1 }], files: [{ format: 'csv', fileName: 'x.csv' }] }],
      'GET /v1/statutory-files/outputs': [200, { items: [output('TDS_QUARTERLY', { status: 'AVAILABLE', missing: [] })] }],
      'GET /v1/statutory-files/formats': [200, NO_FORMATS],
    });
    show();
    const period = await screen.findByRole('form', { name: 'Period' });
    fireEvent.change(within(period).getByLabelText('Financial year'), { target: { value: '2026-27' } });
    fireEvent.change(within(period).getByLabelText('Quarter'), { target: { value: '3' } });
    fireEvent.click(within(period).getByRole('button', { name: 'Show status' }));
    await screen.findByRole('table', { name: 'Totals' });
    expect(calls.find((c) => c.url.includes('/status'))!.url).toBe('/v1/statutory-files/outputs/TDS_QUARTERLY/status?fiscalYear=2026-27&quarter=3');
    // The export key is missing: no download button.
    expect(screen.queryByRole('button', { name: 'Download CSV' })).toBeNull();
  });

  it('the maker sets a format up; the checker reads its sample and accepts it with the sample hash and a reference', async () => {
    session.permissions = ['payroll_statutory.read.operational', 'payroll_statutory_format.define.operational'];
    const draft = { id: 'f-1', outputCode: 'PF_ECR', revision: 1, formatReference: 'ECR 2.0', effectiveFrom: '2026-04-01', state: 'AWAITING_VALIDATION', sampleHash: 'a'.repeat(64), validationReference: null, acceptedAt: null, withdrawalReason: null, note: null };
    const calls = serve({
      'GET /v1/statutory-files/outputs': [200, { items: [output('PF_ECR')] }],
      'GET /v1/statutory-files/formats/f-1/sample': [200, { sampleHash: 'a'.repeat(64), matchesRecorded: true, files: [{ format: 'txt', fileName: 'SAMPLE_PF_ECR_layout-1.txt', content: '999999999901#~#SAMPLE MEMBER ONE' }] }],
      'GET /v1/statutory-files/formats': [200, { inForce: [{ outputCode: 'PF_ECR', format: null, sampleCurrent: null }], items: [draft] }],
      'POST /v1/statutory-files/formats': [201, draft],
      'POST /v1/statutory-files/formats/f-1/acceptance': [200, { ...draft, state: 'ACCEPTED' }],
    });
    show();
    const form = await screen.findByRole('form', { name: 'Set up a format' });
    fireEvent.change(within(form).getByLabelText('Format reference'), { target: { value: 'ECR 2.0' } });
    fireEvent.change(within(form).getByLabelText('Effective from'), { target: { value: '2026-04-01' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Set up format' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ outputCode: 'PF_ECR', formatReference: 'ECR 2.0', effectiveFrom: '2026-04-01', note: null });
    // The maker sees the sample but cannot accept it.
    expect(await screen.findByLabelText('Sample txt')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Accept revision 1' })).toBeNull();
    cleanup();
    session.permissions = ['payroll_statutory.read.operational', 'payroll_statutory_format.accept.operational'];
    show();
    const revisions = await screen.findByRole('table', { name: 'Format revisions' });
    expect(within(revisions).getByText('awaiting validation')).toBeTruthy();
    fireEvent.click(within(revisions).getByRole('button', { name: 'Sample' }));
    expect((await screen.findByLabelText('Sample txt')).textContent).toBe('999999999901#~#SAMPLE MEMBER ONE');
    const acceptance = screen.getByRole('form', { name: 'Accept revision 1' });
    fireEvent.change(within(acceptance).getByLabelText('Validation reference'), { target: { value: 'EPFO validator run 0001' } });
    fireEvent.click(within(acceptance).getByRole('button', { name: 'Accept this format' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/statutory-files/formats/f-1/acceptance')).toBe(true));
    expect(calls.find((c) => c.url === '/v1/statutory-files/formats/f-1/acceptance')!.body).toEqual({ sampleHash: 'a'.repeat(64), validationReference: 'EPFO validator run 0001' });
    expect(screen.queryByRole('form', { name: 'Set up a format' })).toBeNull();
  });
});
