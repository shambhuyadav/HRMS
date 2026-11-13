// Bell curve screen (BRD coverage CL-132 "Bell Curve"; FR-044 "proposed distribution charts must report selected population and
// period"; BR-044 / DF02 confidential ratings; F1 "no forced distribution": targets are a reference only), jsdom. The chart is plain
// SVG with a table of the same numbers; filters are sent exactly; bands and targets are checked before sending. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APPRAISAL_SCREENS } from './appraisal';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../held-batch-timing', () => ({ HELD_BATCH_CHECK_INTERVAL_MS: 3_600_000, HELD_BATCH_MAX_CHECKS: 30 }));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: 'c0000000-0000-4000-8000-000000000001', assignmentId: 'a0000000-0000-4000-8000-000000000001' },
    me: { userId: 'b0000000-0000-4000-8000-000000000001', accountKey: 'syn.hr', companyName: 'Synthetic Co', roleCode: 'HR_ADMINISTRATOR', roleName: 'HR', scopeKind: 'COMPANY', employeeId: null, displayName: 'Synthetic HR' },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

const CYCLE_READ = 'appraisal_cycle.read.operational';
const REPORT_RATING = 'appraisal.report.rating';
const ORG_READ = 'org_master.read.operational';
const MANAGE = 'appraisal_distribution.manage.operational';
const C1 = '10000000-0000-4000-8000-000000000001';
const DEPT = '91000000-0000-4000-8000-000000000001';
const GRADE = '70000000-0000-4000-8000-000000000001';

type Reply = [number, unknown];
interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: Record<string, unknown> | undefined;
}
let calls: Call[] = [];

const band = (sequence: number, code: string, label: string, min: string, max: string, target: string, actual: number, actualPercent: string, targetCount: string, diff: string) => ({
  sequence,
  code,
  label,
  minRating: min,
  maxRating: max,
  targetPercent: target,
  targetCount,
  actualCount: actual,
  actualPercent,
  differencePercent: diff,
});
const BASE = {
  cycle: { id: C1, code: 'FY2026', name: 'Synthetic FY2026', startDate: '2026-04-01', endDate: '2027-03-31', state: 'OPEN' },
  period: { from: '2026-04-01', to: '2027-03-31' },
  filters: { departmentId: null, gradeId: null },
  scope: 'COMPANY',
  ownAppraisalExcluded: true,
  generatedAt: '2026-11-10T09:00:00.000Z',
  population: 10,
  distribution: [
    { rating: '1.00', count: 1, percent: '10.00' },
    { rating: '3.40', count: 4, percent: '40.00' },
    { rating: '4.00', count: 5, percent: '50.00' },
  ],
  targetEnforced: false,
};
const WITH_BANDS = {
  ...BASE,
  target: { source: 'COMPANY', settingId: 's1', revision: 1, reason: 'Synthetic company reference curve', setAt: '2026-11-01T00:00:00.000Z' },
  bands: [
    band(1, 'LOW', 'Needs improvement', '1.00', '2.99', '20.00', 1, '10.00', '2.0', '-10.00'),
    band(2, 'MEETS', 'Meets expectations', '3.00', '3.99', '50.00', 4, '40.00', '5.0', '-10.00'),
    band(3, 'HIGH', 'Exceeds expectations', '4.00', '5.00', '30.00', 5, '50.00', '3.0', '20.00'),
  ],
};

function serve(routes: Record<string, Reply | ((c: Call) => Reply)>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname, params: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}`];
      const [status, body] = route === undefined ? [404, { error: 'NOT_FOUND', message: 'Not found' }] : typeof route === 'function' ? route(call) : route;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}
const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const CYCLES: Record<string, Reply> = {
  'GET /v1/appraisal-cycles': [200, { items: [{ id: C1, code: 'FY2026', name: 'Synthetic FY2026', startDate: '2026-04-01', endDate: '2027-03-31', state: 'OPEN' }] }],
  'GET /v1/org/departments': [200, { items: [{ id: DEPT, code: 'FIN', name: 'Finance' }] }],
  'GET /v1/org/grades': [200, { items: [{ id: GRADE, code: 'G1', name: 'Grade One' }] }],
};

function renderAt(permissions: string[]) {
  session.permissions = permissions;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <MemoryRouter initialEntries={['/appraisal/bell-curve']}>
        <Routes>
          {APPRAISAL_SCREENS.map((s) => (
            <Route key={s.path} path={s.path} element={<s.component />} />
          ))}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
async function chooseCycle() {
  const cycle = await screen.findByLabelText('Cycle');
  await waitFor(() => expect(within(cycle).getByRole('option', { name: /FY2026/ })).toBeTruthy());
  fireEvent.change(cycle, { target: { value: C1 } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bell curve screen (CL-132; FR-044)', () => {
  it('BR-044 DF02: the menu entry and the screen need the confidential rating report right; without it nothing is asked', async () => {
    expect(APPRAISAL_SCREENS.find((s) => s.path === '/appraisal/bell-curve')).toMatchObject({ permission: REPORT_RATING, nav: true, title: 'Bell curve' });
    serve(CYCLES);
    renderAt([CYCLE_READ]);
    expect(await screen.findByText(/needs the appraisal rating report right/)).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith('/bell-curve'))).toBe(false);
  });

  it('FR-044: draws each band\'s actual share against its target as SVG bars and dashed ticks, states population and period, and tabulates the same numbers', async () => {
    serve({ ...CYCLES, [`GET /v1/appraisal-cycles/${C1}/bell-curve`]: [200, WITH_BANDS] });
    const { container } = renderAt([CYCLE_READ, REPORT_RATING, ORG_READ]);
    await chooseCycle();
    expect(await screen.findByText(/Population:/)).toBeTruthy();
    const statement = screen.getByText(/Population:/).closest('p')!;
    expect(statement.textContent).toContain('1 Apr 2026 to 31 Mar 2027');
    expect(statement.textContent).toContain('10 completed appraisals');
    expect(screen.getByText(/the company default, revision 1 \(Synthetic company reference curve\)/)).toBeTruthy();
    expect(screen.getByText(/no rating is changed or limited by it/)).toBeTruthy();
    expect(screen.getByText('Your own appraisal is never included.')).toBeTruthy();
    // The chart: one bar per band (a path), one dashed target tick per band, its numbers in the hover titles and the summary.
    const svg = container.querySelector('svg[role="img"]')!;
    expect(svg.querySelectorAll('path')).toHaveLength(3);
    expect(svg.querySelectorAll('line[stroke-dasharray]')).toHaveLength(3);
    const titles = [...svg.querySelectorAll('g > title')].map((t) => t.textContent);
    expect(titles).toEqual([
      'Needs improvement (1.00 to 2.99): 1 of 10 (10.00%); target 20.00% (2.0)',
      'Meets expectations (3.00 to 3.99): 4 of 10 (40.00%); target 50.00% (5.0)',
      'Exceeds expectations (4.00 to 5.00): 5 of 10 (50.00%); target 30.00% (3.0)',
    ]);
    // Taller bar for the larger share (heights proportional to the share).
    // "M x,baseline V y+r Q x,top ...": the bar's height is the baseline less its top.
    const heights = [...svg.querySelectorAll('path')].map((p) => {
      const nums = p.getAttribute('d')!.match(/-?\d+(\.\d+)?/g)!.map(Number);
      return nums[1]! - nums[4]!;
    });
    expect(heights[2]!).toBeGreaterThan(heights[1]!);
    expect(heights[1]!).toBeGreaterThan(heights[0]!);
    expect(Math.round((heights[2]! / heights[0]!) * 10) / 10).toBe(5);
    const table = screen.getByRole('table', { name: 'Rating bands against targets' });
    const rows = within(table).getAllByRole('row').map((r) => [...r.querySelectorAll('td,th')].map((c) => c.textContent));
    expect(rows[1]).toEqual(['Needs improvement', '1.00 to 2.99', '1', '10.00%', '20.00%', '2.0', '-10.00 points']);
    expect(rows[3]).toEqual(['Exceeds expectations', '4.00 to 5.00', '5', '50.00%', '30.00%', '3.0', '+20.00 points']);
    expect(rows[4]).toEqual(['Total', '10', '100%', '100%', '10', '']);
  });

  it('FR-044 BR-026: sends exactly the chosen department and grade; without bands it shows the exact ratings, without targets', async () => {
    serve({ ...CYCLES, [`GET /v1/appraisal-cycles/${C1}/bell-curve`]: [200, { ...BASE, target: null, bands: null }] });
    const { container } = renderAt([CYCLE_READ, REPORT_RATING, ORG_READ]);
    await chooseCycle();
    expect(await screen.findByText(/No rating bands or target shares are set/)).toBeTruthy();
    const svg = container.querySelector('svg[role="img"]')!;
    expect(svg.querySelectorAll('path')).toHaveLength(3);
    expect(svg.querySelectorAll('line[stroke-dasharray]')).toHaveLength(0);
    expect(within(screen.getByRole('table', { name: 'Final rating distribution' })).getAllByRole('row')).toHaveLength(5);
    await waitFor(() => expect(within(screen.getByLabelText('Department')).getByRole('option', { name: 'Finance (FIN)' })).toBeTruthy());
    await waitFor(() => expect(within(screen.getByLabelText('Grade')).getByRole('option', { name: 'Grade One (G1)' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: DEPT } });
    fireEvent.change(screen.getByLabelText('Grade'), { target: { value: GRADE } });
    await waitFor(() => expect(callsTo('GET', `/v1/appraisal-cycles/${C1}/bell-curve`).some((c) => c.params.get('gradeId') === GRADE && c.params.get('departmentId') === DEPT)).toBe(true));
    // Read-only: no write is ever sent from the bell curve.
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('FR-044: HR records bands and targets only when they cover 1.00 to 5.00 in order and add up to 100; the save changes no rating', async () => {
    serve({
      ...CYCLES,
      [`GET /v1/appraisal-cycles/${C1}/bell-curve`]: [200, WITH_BANDS],
      'POST /v1/appraisal-rating-distributions': [201, { id: 's2', cycleId: C1, revision: 1 }],
    });
    renderAt([CYCLE_READ, REPORT_RATING, MANAGE]);
    await chooseCycle();
    const form = await screen.findByRole('form', { name: 'Rating bands and targets' });
    expect((within(form).getByLabelText('Band 2 target share') as HTMLInputElement).value).toBe('50.00');
    fireEvent.change(within(form).getByLabelText('Band 2 target share'), { target: { value: '45' } });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Synthetic cycle view' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save the bands and targets' }));
    expect(within(form).getByText('The target shares add up to 95.00; they must add up to exactly 100.')).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Band 2 target share'), { target: { value: '50' } });
    fireEvent.change(within(form).getByLabelText('Band 3 from rating'), { target: { value: '4.10' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save the bands and targets' }));
    expect(within(form).getByText('Band 3 starts 0.01 above where band 2 ends.')).toBeTruthy();
    expect(callsTo('POST', '/v1/appraisal-rating-distributions')).toHaveLength(0);
    fireEvent.change(within(form).getByLabelText('Band 3 from rating'), { target: { value: '4.00' } });
    fireEvent.change(within(form).getByLabelText('Applies to'), { target: { value: 'CYCLE' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save the bands and targets' }));
    expect(await within(form).findByText(/Saved revision 1 of the cycle’s bands and targets. No rating was changed./)).toBeTruthy();
    expect(callsTo('POST', '/v1/appraisal-rating-distributions').map((c) => c.body)).toEqual([
      {
        cycleId: C1,
        reason: 'Synthetic cycle view',
        bands: [
          { code: 'LOW', label: 'Needs improvement', minRating: '1.00', maxRating: '2.99', targetPercent: '20.00' },
          { code: 'MEETS', label: 'Meets expectations', minRating: '3.00', maxRating: '3.99', targetPercent: '50' },
          { code: 'HIGH', label: 'Exceeds expectations', minRating: '4.00', maxRating: '5.00', targetPercent: '30.00' },
        ],
      },
    ]);
  });
});
