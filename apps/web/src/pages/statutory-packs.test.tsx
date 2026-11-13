// Statutory packs screen (I-85), jsdom: the export for the navigation step, the pack revisions with their values in words (PF, ESIC,
// professional tax slabs), validation with its references, activation by a person who neither wrote nor validated the revision,
// retirement with a reason, refusals in plain words and gating by permission. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STATUTORY_PACK_SCREENS } from './statutory-packs';

const session = vi.hoisted(() => ({ permissions: [] as string[], userId: 'b0000000-0000-4000-8000-000000000001' }));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: 'c0000000-0000-4000-8000-000000000001', assignmentId: 'a0000000-0000-4000-8000-000000000001' },
    me: { userId: session.userId, accountKey: 'syn.packs', companyName: 'Synthetic Co', roleCode: 'HR_ADMINISTRATOR', roleName: 'HR Administrator', scopeKind: 'COMPANY', employeeId: null, displayName: 'Synthetic Packs' },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

const READ = 'statutory_pack.read.operational';
const VALIDATE = 'statutory_pack.validate.operational';
const ACTIVATE = 'statutory_pack.activate.operational';
const U_ME = session.userId;
const U_OTHER = 'b0000000-0000-4000-8000-000000000002';
const U_SYSTEM = '00000000-0000-4000-8000-000000000001';
const K_PF = 'e3000000-0000-4000-8000-000000000001';
const K_ESIC = 'e3000000-0000-4000-8000-000000000002';
const K_MH = 'e3000000-0000-4000-8000-000000000003';
const K_KA = 'e3000000-0000-4000-8000-000000000004';

type Json = Record<string, unknown>;
const pack = (patch: Json): Json => ({
  id: K_PF,
  code: 'PF',
  revision: 1,
  effectiveFrom: '2018-06-01',
  currencyCode: 'INR',
  parameters: {
    wageCeiling: '15000.00',
    employeeRatePercent: '12',
    employerRatePercent: '12',
    pensionRatePercent: '8.33',
    pensionWageCeiling: '15000.00',
    edliRatePercent: '0.5',
    edliWageCeiling: '15000.00',
    adminChargesRatePercent: '0.5',
    rounding: 'HALF_UP_WHOLE',
  },
  statuteReference: 'Synthetic statute reference. Validate against the law in force, including the Code on Social Security, 2020, before activation.',
  sourceReference: null,
  validationReference: null,
  state: 'DRAFT',
  createdBy: U_SYSTEM,
  validatedBy: null,
  validatedAt: null,
  activatedBy: null,
  activatedAt: null,
  version: 1,
  ...patch,
});
const PACKS = {
  definitions: [
    { code: 'PF', title: 'Provident fund (synthetic title)' },
    { code: 'ESIC', title: 'Employees’ state insurance (synthetic title)' },
    { code: 'PT_MH', title: 'Professional tax, Maharashtra' },
    { code: 'PT_KA', title: 'Professional tax, Karnataka' },
  ],
  items: [
    pack({}),
    pack({
      id: K_ESIC,
      code: 'ESIC',
      effectiveFrom: '2019-07-01',
      parameters: { wageCeiling: '21000.00', employeeRatePercent: '0.75', employerRatePercent: '3.25', contributionPeriodStartMonths: [4, 10], rounding: 'UP_WHOLE' },
      state: 'VALIDATED',
      sourceReference: 'Synthetic source',
      validationReference: 'Synthetic check',
      validatedBy: U_ME,
      validatedAt: '2026-11-01T05:00:00.000Z',
      version: 2,
    }),
    pack({
      id: K_MH,
      code: 'PT_MH',
      effectiveFrom: '2023-04-01',
      parameters: { stateCode: 'MH', slabs: [{ upTo: '7500.00', amount: '0.00' }, { upTo: '10000.00', amount: '175.00' }, { upTo: null, amount: '200.00', monthAmounts: { '2': '300.00' } }] },
      state: 'ACTIVE',
      sourceReference: 'Synthetic source',
      validationReference: 'Synthetic check',
      validatedBy: U_OTHER,
      validatedAt: '2026-11-01T05:00:00.000Z',
      activatedBy: U_ME,
      activatedAt: '2026-11-02T05:00:00.000Z',
      version: 3,
    }),
    pack({ id: K_KA, code: 'PT_KA', effectiveFrom: '2023-04-01', parameters: { stateCode: 'KA', slabs: [{ upTo: '24999.99', amount: '0.00' }, { upTo: null, amount: '200.00' }] }, state: 'VALIDATED', validatedBy: U_OTHER, version: 2 }),
  ],
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}
type Reply = [status: number, body: unknown];
let calls: Call[] = [];
function serve(routes: Record<string, Reply | ((c: Call) => Reply)>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}`];
      const [status, body] = route === undefined ? [404, { error: 'NOT_FOUND', message: 'No mock' }] : typeof route === 'function' ? route(call) : route;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}
function renderScreen(permissions: string[]) {
  session.permissions = permissions;
  const Screen = STATUTORY_PACK_SCREENS[0]!.component;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <MemoryRouter initialEntries={['/payroll/statutory-packs']}>
        <Screen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const revision = async (name: string) => (await screen.findByRole('heading', { name })).closest('li') as HTMLElement;
const term = (scope: HTMLElement, name: string) => within(scope).getByText(name, { selector: 'dt' }).nextElementSibling?.textContent;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('statutory packs: export for the navigation step', () => {
  it('exports one menu screen for whoever reads the packs', () => {
    expect(STATUTORY_PACK_SCREENS.map((s) => [s.path, s.title, s.permission, s.nav])).toEqual([['/payroll/statutory-packs', 'Statutory packs', READ, true]]);
  });
});

describe('statutory packs: reading', () => {
  it('shows each revision with its state, statute and values in words, and no action without the duties', async () => {
    serve({ 'GET /v1/statutory-rule-packs': [200, PACKS] });
    renderScreen([READ]);
    const pf = await revision('PF revision 1, from 1 Jun 2018');
    expect(term(pf, 'State')).toBe('Inactive draft');
    expect(term(pf, 'Values')).toContain('Employee 12% and employer 12% of PF wages up to INR 15,000.00');
    expect(term(pf, 'Values')).toContain('pension 8.33% of wages up to INR 15,000.00');
    expect(term(pf, 'Values')).toContain('rounded to the nearest whole unit, half up');
    expect(term(pf, 'Statute reference')).toContain('Code on Social Security, 2020');
    const esic = await revision('ESIC revision 1, from 1 Jul 2019');
    expect(term(esic, 'Values')).toContain('for monthly wages up to INR 21,000.00; contribution periods start in April and October');
    const mh = await revision('PT_MH revision 1, from 1 Apr 2023');
    const slabs = within(mh).getByRole('table', { name: 'Monthly slabs' });
    expect(within(slabs).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))).toEqual([
      ['INR 7,500.00', 'INR 0.00', '—'],
      ['INR 10,000.00', 'INR 175.00', '—'],
      ['No upper limit', 'INR 200.00', 'February: INR 300.00'],
    ]);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('reads a labour welfare fund revision and an income tax revision in words and tables, for their validators (FR-039, I-90)', async () => {
    const regime = (patch: Json) => ({
      standardDeduction: '75000.00',
      slabs: [
        { upTo: '400000.00', ratePercent: '0' },
        { upTo: null, ratePercent: '30' },
      ],
      rebate: { incomeUpTo: '1200000.00', maxAmount: '60000.00', marginalRelief: true },
      surcharge: [{ incomeAbove: '5000000.00', ratePercent: '10' }],
      cessPercent: '4',
      rounding: 'NEAREST_TEN',
      ...patch,
    });
    serve({
      'GET /v1/statutory-rule-packs': [
        200,
        {
          definitions: [...PACKS.definitions, { code: 'LWF_MH', title: 'Labour welfare fund, Maharashtra' }, { code: 'INCOME_TAX', title: 'Income tax on salary (synthetic title)' }],
          items: [
            pack({
              id: 'e3000000-0000-4000-8000-000000000005',
              code: 'LWF_MH',
              effectiveFrom: '2023-04-01',
              parameters: { stateCode: 'MH', contributionMonths: [6, 12], slabs: [{ upTo: '3000.00', employee: '6.00', employer: '18.00' }, { upTo: null, employee: '12.00', employer: '36.00' }] },
            }),
            pack({
              id: 'e3000000-0000-4000-8000-000000000006',
              code: 'INCOME_TAX',
              effectiveFrom: '2026-04-01',
              parameters: {
                fiscalYear: '2026-27',
                defaultRegime: 'NEW',
                regimes: {
                  NEW: regime({ employerNpsLimitPercent: '14' }),
                  OLD: regime({ standardDeduction: '50000.00', marginalRelief: false, hraExemption: { metroPercent: '50', otherPercent: '40', rentAboveSalaryPercent: '10' }, employerNpsLimitPercent: '10' }),
                },
              },
            }),
          ],
        },
      ],
    });
    renderScreen([READ]);
    const lwf = await revision('LWF_MH revision 1, from 1 Apr 2023');
    expect(term(lwf, 'Values')).toContain('State MH; contributions with the wages of June and December');
    expect(within(lwf).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))).toEqual([
      ['INR 3,000.00', 'INR 6.00', 'INR 18.00'],
      ['No upper limit', 'INR 12.00', 'INR 36.00'],
    ]);
    const tax = await revision('INCOME_TAX revision 1, from 1 Apr 2026');
    const values = term(tax, 'Values')!;
    expect(values).toContain('Financial year 2026-27; an employee who chooses no regime is taxed under the new regime.');
    expect(values).toContain('New regime: standard deduction INR 75,000.00; rebate of up to INR 60,000.00 on taxable income up to INR 12,00,000.00, with marginal relief just above it');
    expect(values).toContain("surcharge 10% above INR 50,00,000.00 (with marginal relief); cess 4%; the year's tax rounded to the nearest ten.");
    expect(values).toContain('Employer NPS contribution deductible up to 14% of salary.');
    expect(values).toContain('House rent allowance exempt: the least of the allowance, rent less 10% of salary, and 50% of salary (four metro cities) or 40% elsewhere.');
    expect(within(tax).getByRole('table', { name: 'Old regime slabs' }).textContent).toContain('No upper limit30%');
    expect(screen.queryByText(/"fiscalYear"/)).toBeNull();
  });

  it('says plainly when the role cannot read the packs', async () => {
    serve({ 'GET /v1/statutory-rule-packs': [403, { error: 'FORBIDDEN', message: 'no' }] });
    renderScreen([READ]);
    expect(await screen.findByText(/cannot view the statutory packs/)).toBeTruthy();
  });
});

describe('statutory packs: two people, and retirement', () => {
  it('a draft is validated with both references; a missing one is named before any call', async () => {
    serve({
      'GET /v1/statutory-rule-packs': [200, PACKS],
      [`POST /v1/statutory-rule-packs/${K_PF}/validate`]: [200, pack({ state: 'VALIDATED', version: 2 })],
    });
    renderScreen([READ, VALIDATE]);
    const form = await screen.findByRole('form', { name: 'Validate PF revision 1' });
    fireEvent.change(within(form).getByLabelText(/Source reference/), { target: { value: 'Synthetic gazette' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record the validation' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('Record how the values were validated against the law in force for the period.');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    fireEvent.change(within(form).getByLabelText(/Validation reference/), { target: { value: 'Synthetic legal check' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record the validation' }));
    expect((await screen.findByRole('status')).textContent).toContain('PF revision 1 is validated');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ sourceReference: 'Synthetic gazette', validationReference: 'Synthetic legal check', expectedVersion: 1 });
  });

  it('the validator cannot activate what they validated; another activator can, and a refusal is said in words', async () => {
    serve({
      'GET /v1/statutory-rule-packs': [200, PACKS],
      [`POST /v1/statutory-rule-packs/${K_KA}/activate`]: [403, { error: 'SELF_APPROVAL', message: 'no' }],
    });
    renderScreen([READ, ACTIVATE]);
    const esic = await revision('ESIC revision 1, from 1 Jul 2019');
    expect((within(esic).getByRole('button', { name: 'Activate ESIC revision 1' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(esic).getByText('You wrote or validated this revision, so someone else activates it.')).toBeTruthy();
    const ka = await revision('PT_KA revision 1, from 1 Apr 2023');
    fireEvent.click(within(ka).getByRole('button', { name: 'Activate PT_KA revision 1' }));
    expect(await within(ka).findByText('Activated by someone other than the person who wrote or validated it.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ expectedVersion: 2 });
  });

  it('an active revision is retired with a reason against its version', async () => {
    serve({
      'GET /v1/statutory-rule-packs': [200, PACKS],
      [`POST /v1/statutory-rule-packs/${K_MH}/retire`]: [200, { ...PACKS.items[2], state: 'RETIRED', version: 4 }],
    });
    renderScreen([READ, ACTIVATE]);
    const form = await screen.findByRole('form', { name: 'Retire PT_MH revision 1' });
    fireEvent.click(within(form).getByRole('button', { name: 'Retire PT_MH revision 1' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('Record why the revision is retired.');
    fireEvent.change(within(form).getByLabelText(/Reason for retiring/), { target: { value: 'Synthetic: new slabs from April' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Retire PT_MH revision 1' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ reason: 'Synthetic: new slabs from April', expectedVersion: 3 }));
    expect((await screen.findByRole('status')).textContent).toContain('PT_MH revision 1 is retired');
  });
});
