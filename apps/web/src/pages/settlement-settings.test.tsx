// Settlement policy and statutory rule packs (FR-052; I-88), jsdom: the screen's export for the navigation step, the policy
// revisions with the server's defaults prefilled in a new revision, activation by someone other than the author, the rule pack
// revisions with their parameters in words, validation with its references and activation by a second person, refusals in plain
// words and gating by permission. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localDate } from '../api';
import { SETTLEMENT_SETTINGS_SCREENS } from './settlement-settings';

const session = vi.hoisted(() => ({
  permissions: [] as string[],
  userId: 'b0000000-0000-4000-8000-000000000001',
}));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: 'c0000000-0000-4000-8000-000000000001', assignmentId: 'a0000000-0000-4000-8000-000000000001' },
    me: {
      userId: session.userId,
      accountKey: 'syn.config',
      companyName: 'Synthetic Co',
      roleCode: 'HR_ADMINISTRATOR',
      roleName: 'HR Administrator',
      scopeKind: 'COMPANY',
      employeeId: null,
      displayName: 'Synthetic Config',
    },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

const POLICY_READ = 'payroll_config.read.operational';
const POLICY_MANAGE = 'payroll_config.manage.operational';
const POLICY_ACTIVATE = 'payroll_config.activate.operational';
const PACK_READ = 'statutory_pack.read.operational';
const PACK_VALIDATE = 'statutory_pack.validate.operational';
const PACK_ACTIVATE = 'statutory_pack.activate.operational';

const U_ME = session.userId;
const U_OTHER = 'b0000000-0000-4000-8000-000000000002';
const U_THIRD = 'b0000000-0000-4000-8000-000000000003';
const P_ACTIVE = 'e1000000-0000-4000-8000-000000000001';
const P_DRAFT = 'e1000000-0000-4000-8000-000000000002';
const P_MINE = 'e1000000-0000-4000-8000-000000000003';
const K_DRAFT = 'e2000000-0000-4000-8000-000000000001';
const K_VALIDATED = 'e2000000-0000-4000-8000-000000000002';
const K_PT = 'e2000000-0000-4000-8000-000000000003';

type Json = Record<string, unknown>;

const DEFAULTS = { encashmentRateBasis: 'BASIC_DA', encashmentDivisor: 30, noticeRateBasis: 'GROSS', noticeDivisor: 30, encashableMaxUnits: '30' };
const policy = (patch: Json): Json => ({
  id: P_DRAFT,
  revision: 2,
  effectiveFrom: '2026-12-01',
  basicComponentCode: 'BASIC',
  daComponentCode: null,
  encashmentComponentCode: null,
  encashmentRateBasis: 'BASIC_DA',
  encashmentDivisor: 30,
  noticeComponentCode: null,
  noticeRateBasis: 'GROSS',
  noticeDivisor: 26,
  gratuityComponentCode: null,
  encashable: [],
  state: 'DRAFT',
  createdBy: U_OTHER,
  activatedBy: null,
  activatedAt: null,
  version: 1,
  ...patch,
});
const POLICIES = {
  defaults: DEFAULTS,
  rateBases: ['BASIC', 'BASIC_DA', 'GROSS'],
  items: [
    policy({
      id: P_ACTIVE,
      revision: 1,
      effectiveFrom: '2026-04-01',
      daComponentCode: 'DA',
      encashmentComponentCode: 'LEAVE_ENC',
      noticeComponentCode: 'NOTICE_REC',
      noticeDivisor: 30,
      gratuityComponentCode: 'GRATUITY',
      encashable: [{ leaveType: 'EL', maxUnits: '30.0000' }],
      state: 'ACTIVE',
      activatedBy: U_ME,
      activatedAt: '2026-04-01T05:00:00.000Z',
      version: 2,
    }),
    policy({}),
    policy({ id: P_MINE, revision: 3, effectiveFrom: '2027-01-01', createdBy: U_ME }),
  ],
};

const GRATUITY_PARAMETERS = { wageDays: 15, wageDivisor: 26, minimumServiceYears: 5, partYearMonthsOver: 6, ceilingAmount: '2000000.00', exemptSeparationTypes: ['DEATH', 'DISABLEMENT'] };
const pack = (patch: Json): Json => ({
  id: K_DRAFT,
  code: 'GRATUITY',
  revision: 1,
  effectiveFrom: '2018-03-29',
  currencyCode: 'INR',
  parameters: GRATUITY_PARAMETERS,
  statuteReference: 'Synthetic statute reference, s.4',
  sourceReference: null,
  validationReference: null,
  state: 'DRAFT',
  createdBy: U_THIRD,
  validatedBy: null,
  validatedAt: null,
  activatedBy: null,
  activatedAt: null,
  version: 1,
  ...patch,
});
const PACKS = {
  definitions: [
    { code: 'GRATUITY', title: 'Gratuity (Payment of Gratuity Act, 1972)' },
    { code: 'PT', title: 'Professional tax (synthetic)' },
  ],
  items: [
    pack({}),
    pack({
      id: K_VALIDATED,
      revision: 2,
      effectiveFrom: '2026-04-01',
      sourceReference: 'Synthetic gazette notification',
      validationReference: 'Synthetic legal review',
      state: 'VALIDATED',
      validatedBy: U_OTHER,
      validatedAt: '2026-10-01T05:00:00.000Z',
      version: 3,
    }),
    pack({ id: K_PT, code: 'PT', parameters: { slabs: [] }, effectiveFrom: '2026-04-01' }),
  ],
};

// ---- The fetch stub ----
interface Call {
  method: string;
  path: string;
  body: unknown;
}
type Reply = [status: number, body: unknown];
type Route = Reply | ((call: Call) => Reply);

let calls: Call[] = [];
const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const bodyOf = (method: string, path: string, index = 0) => callsTo(method, path)[index]?.body;

function serve(routes: Record<string, Route>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}`];
      const [status, body] = route === undefined ? [404, { error: 'NOT_FOUND', message: `No mock for ${call.method} ${call.path}` }] : typeof route === 'function' ? route(call) : route;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}

function renderScreen(permissions: string[]) {
  session.permissions = permissions;
  const Screen = SETTLEMENT_SETTINGS_SCREENS[0]!.component;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <MemoryRouter initialEntries={['/lifecycle/settlement-settings']}>
        <Screen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((c) => c.textContent?.trim());
const rows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1);
const term = (scope: HTMLElement, name: string) => within(scope).getByText(name, { selector: 'dt' }).nextElementSibling?.textContent;
const findSection = async (title: string) => (await screen.findByRole('heading', { name: title })).closest('section') as HTMLElement;
const button = (scope: HTMLElement, name: string | RegExp) => within(scope).getByRole('button', { name }) as HTMLButtonElement;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function localTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('settlement settings: export for the navigation step', () => {
  it('exports one menu screen under the lifecycle paths', () => {
    expect(SETTLEMENT_SETTINGS_SCREENS.map((s) => [s.path, s.title, s.permission, s.nav])).toEqual([
      ['/lifecycle/settlement-settings', 'Settlement policy and statutory packs', POLICY_READ, true],
    ]);
    expect(typeof SETTLEMENT_SETTINGS_SCREENS[0]!.component).toBe('function');
  });

  it('asks for nothing without the read duties, and explains the two-person rule of statutory values', async () => {
    serve({});
    renderScreen([]);
    expect(
      screen.getByText(
        'A statutory value is used only once one authorised person has validated it and another has activated it; until then an employee it applies to is blocked with RULE_PACK_NOT_CONFIGURED.',
        { exact: false },
      ),
    ).toBeTruthy();
    const notes = screen.getAllByRole('note').map((n) => n.textContent);
    expect(notes).toContain('not permitted The selected role cannot view the settlement policy: that needs the payroll configuration read duty.');
    expect(notes).toContain('not permitted The selected role cannot view the statutory rule packs: that needs the statutory pack read duty.');
    await settle();
    expect(calls).toEqual([]);
  });
});

describe('settlement policy (FR-052; I-88)', () => {
  it('lists the revisions, and offers no new revision or activation without those duties', async () => {
    serve({ 'GET /v1/settlements/policies': [200, POLICIES] });
    renderScreen([POLICY_READ]);
    const table = await screen.findByRole('table', { name: 'Settlement policy revisions' });
    expect(rows(table).map(cells)).toEqual([
      [
        '1',
        '1 Apr 2026',
        'Active',
        'BASIC',
        'DA',
        'LEAVE_ENC: Basic + DA / 30',
        'EL up to 30',
        'NOTICE_REC: Monthly gross (every fixed earning) / 30',
        'GRATUITY',
        'another user',
        `${localTime('2026-04-01T05:00:00.000Z')} by you`,
      ],
      ['2', '1 Dec 2026', 'Draft: not in force until someone else activates it', 'BASIC', '—', 'No component: Basic + DA / 30', 'None', 'No component: Monthly gross (every fixed earning) / 26', '—', 'another user', '—'],
      ['3', '1 Jan 2027', 'Draft: not in force until someone else activates it', 'BASIC', '—', 'No component: Basic + DA / 30', 'None', 'No component: Monthly gross (every fixed earning) / 26', '—', 'you', '—'],
    ]);
    expect(
      screen.getByText(
        'Defaults for a field left out: encashment on Basic + DA / 30, notice recovery on Monthly gross (every fixed earning) / 30, an encashable leave type capped at 30 units. No leave type is encashable unless listed.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'New settlement policy revision' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Activate revision/ })).toBeNull();
  });

  it('writes a new revision prefilled with the defaults, sending what was given, and says a refusal in words', async () => {
    let attempt = 0;
    serve({
      'GET /v1/settlements/policies': [200, POLICIES],
      'POST /v1/settlements/policies': () => {
        attempt += 1;
        if (attempt === 1) return [422, { error: 'UNKNOWN_LEAVE_TYPE', message: 'An active leave type of that code is not defined', details: { field: 'encashable', index: 1, leaveType: 'CL' } }];
        return [201, policy({ id: 'e1000000-0000-4000-8000-000000000004', revision: 4, effectiveFrom: '2027-02-01', createdBy: U_ME })];
      },
    });
    renderScreen([POLICY_READ, POLICY_MANAGE]);
    const form = await screen.findByRole('form', { name: 'New settlement policy revision' });
    const field = (label: string) => within(form).getByLabelText(label) as HTMLInputElement;
    expect(field('Takes effect from').value).toBe(localDate());
    expect(field('Encashment rate basis').value).toBe('BASIC_DA');
    expect(field('Encashment divisor (days)').value).toBe('30');
    expect(field('Notice recovery rate basis').value).toBe('GROSS');
    expect(field('Notice recovery divisor (days)').value).toBe('30');
    expect([...(within(form).getByLabelText('Notice recovery rate basis') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      'Basic',
      'Basic + DA',
      'Monthly gross (every fixed earning)',
    ]);

    // Basic is required: nothing is sent without it.
    fireEvent.click(button(form, 'Write the draft revision'));
    expect((await within(form).findByRole('alert')).textContent).toBe('Name the pay component that stands for Basic.');
    await settle();
    expect(callsTo('POST', '/v1/settlements/policies')).toEqual([]);

    fireEvent.change(field('Takes effect from'), { target: { value: '2027-02-01' } });
    fireEvent.change(field('Basic component (required)'), { target: { value: 'basic' } });
    fireEvent.change(field('DA component (optional)'), { target: { value: 'da' } });
    fireEvent.change(field('Encashment component (an earning)'), { target: { value: 'leave_enc' } });
    fireEvent.click(button(form, 'Add an encashable leave type'));
    fireEvent.click(button(form, 'Add an encashable leave type'));
    fireEvent.change(field('Encashable leave type 1'), { target: { value: 'el' } });
    fireEvent.change(field('Encashable leave type 2'), { target: { value: 'cl' } });
    expect(field('Cap of leave type 2 (units)').placeholder).toBe('30');
    fireEvent.change(field('Cap of leave type 2 (units)'), { target: { value: '10' } });
    fireEvent.change(field('Notice recovery component (a deduction)'), { target: { value: 'notice_rec' } });
    fireEvent.change(field('Notice recovery divisor (days)'), { target: { value: '26' } });
    fireEvent.change(field('Gratuity component (an earning)'), { target: { value: 'gratuity' } });
    fireEvent.click(button(form, 'Write the draft revision'));
    await waitFor(() => expect(callsTo('POST', '/v1/settlements/policies')).toHaveLength(1));
    expect(bodyOf('POST', '/v1/settlements/policies')).toEqual({
      effectiveFrom: '2027-02-01',
      basicComponentCode: 'BASIC',
      daComponentCode: 'DA',
      encashmentComponentCode: 'LEAVE_ENC',
      encashmentRateBasis: 'BASIC_DA',
      encashmentDivisor: 30,
      encashable: [{ leaveType: 'EL' }, { leaveType: 'CL', maxUnits: '10' }],
      noticeComponentCode: 'NOTICE_REC',
      noticeRateBasis: 'GROSS',
      noticeDivisor: 26,
      gratuityComponentCode: 'GRATUITY',
    });
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toContain('Encashable leave type 2: no active leave type has the code CL.');
    expect(alert.textContent).toContain('UNKNOWN_LEAVE_TYPE');
    // Refused: what was typed stays.
    expect(field('Encashable leave type 2').value).toBe('CL');

    fireEvent.click(button(form, 'Write the draft revision'));
    expect((await screen.findByRole('status')).textContent).toBe('Revision 4 written as a draft from 1 Feb 2027. It is not in force until someone other than you activates it.');
    // The form starts again from the defaults.
    await waitFor(() => expect(field('Basic component (required)').value).toBe(''));
    expect(within(form).queryByLabelText('Encashable leave type 1')).toBeNull();
    await waitFor(() => expect(callsTo('GET', '/v1/settlements/policies').length).toBeGreaterThan(1));
  });

  it('says a divisor refused by the server for the field it names', async () => {
    serve({
      'GET /v1/settlements/policies': [200, POLICIES],
      'POST /v1/settlements/policies': [422, { error: 'INVALID_DIVISOR', message: 'A divisor is a whole number of days from 1 to 31', details: { field: 'noticeDivisor' } }],
    });
    renderScreen([POLICY_READ, POLICY_MANAGE]);
    const form = await screen.findByRole('form', { name: 'New settlement policy revision' });
    fireEvent.change(within(form).getByLabelText('Basic component (required)'), { target: { value: 'BASIC' } });
    fireEvent.click(button(form, 'Write the draft revision'));
    expect((await within(form).findByRole('alert')).textContent).toContain('The notice recovery divisor is a whole number of days from 1 to 31.');
  });

  it('activates a draft written by someone else against its version; one’s own draft is left to someone else', async () => {
    let attempt = 0;
    serve({
      'GET /v1/settlements/policies': [200, POLICIES],
      [`POST /v1/settlements/policies/${P_DRAFT}/activate`]: () => {
        attempt += 1;
        if (attempt === 1) return [403, { error: 'SELF_APPROVAL', message: 'A policy is activated by someone other than its author' }];
        return [200, policy({ state: 'ACTIVE', activatedBy: U_ME, activatedAt: '2026-11-06T05:00:00.000Z', version: 2 })];
      },
    });
    renderScreen([POLICY_READ, POLICY_ACTIVATE]);
    const table = await screen.findByRole('table', { name: 'Settlement policy revisions' });
    const mine = button(table, 'Activate revision 3');
    expect(mine.disabled).toBe(true);
    expect(document.getElementById(mine.getAttribute('aria-describedby') ?? '')?.textContent).toBe('You wrote this revision, so someone else activates it.');
    expect(within(table).queryByRole('button', { name: 'Activate revision 1' })).toBeNull();

    fireEvent.click(button(table, 'Activate revision 2'));
    const alert = await within(table).findByRole('alert');
    expect(alert.textContent).toContain('A policy is activated by someone other than its author.');
    expect(alert.textContent).toContain('SELF_APPROVAL');
    expect(bodyOf('POST', `/v1/settlements/policies/${P_DRAFT}/activate`)).toEqual({ expectedVersion: 1 });

    fireEvent.click(button(table, 'Activate revision 2'));
    expect((await screen.findByRole('status')).textContent).toBe('Revision 2 of the settlement policy is active from 1 Dec 2026.');
    expect(callsTo('POST', `/v1/settlements/policies/${P_MINE}/activate`)).toEqual([]);
  });
});

describe('statutory rule packs (I-88)', () => {
  it('lists each pack’s revisions with their state and parameters in words, and offers nothing to change without the duties', async () => {
    serve({ 'GET /v1/statutory-rule-packs': [200, PACKS] });
    renderScreen([PACK_READ]);
    const gratuity = await screen.findByRole('list', { name: 'Revisions of GRATUITY' });
    expect(screen.getByRole('heading', { name: 'Gratuity (Payment of Gratuity Act, 1972) GRATUITY' })).toBeTruthy();
    const draft = within(gratuity).getByRole('listitem', { name: 'GRATUITY revision 1, from 29 Mar 2018' });
    expect(term(draft, 'State')).toBe('Inactive draft');
    expect(term(draft, 'Currency')).toBe('INR');
    expect(term(draft, 'Parameters')).toBe(
      '15 days’ wages per counted year, a month’s wages / 26, 5 years’ continuous service (none on DEATH, DISABLEMENT), a final part-year of more than 6 months counts, ceiling 2000000.00 INR',
    );
    expect(term(draft, 'Statute reference')).toBe('Synthetic statute reference, s.4');
    expect(term(draft, 'Validated')).toBe('Not yet');
    const validated = within(gratuity).getByRole('listitem', { name: 'GRATUITY revision 2, from 1 Apr 2026' });
    expect(term(validated, 'State')).toBe('Validated, waiting for activation by another person');
    expect(term(validated, 'Source reference')).toBe('Synthetic gazette notification');
    expect(term(validated, 'Validation reference')).toBe('Synthetic legal review');
    // Another account is named in words; its identifier stays in the tooltip for the audit trail.
    expect(term(validated, 'Validated')).toBe(`${localTime('2026-10-01T05:00:00.000Z')} by another user`);
    expect(within(validated).getByTitle(`User ${U_OTHER}`)).toBeTruthy();
    // A pack without words of its own shows its parameters as the server holds them.
    const pt = screen.getByRole('list', { name: 'Revisions of PT' });
    expect(term(within(pt).getByRole('listitem'), 'Parameters')).toBe('{"slabs":[]}');
    expect(screen.queryByRole('form', { name: /^Validate/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Activate/ })).toBeNull();
  });

  it('validates a draft with its references against its version, sending nothing without them', async () => {
    serve({
      'GET /v1/statutory-rule-packs': [200, PACKS],
      [`POST /v1/statutory-rule-packs/${K_DRAFT}/validate`]: [
        200,
        pack({ state: 'VALIDATED', sourceReference: 'Synthetic source', validationReference: 'Synthetic check', validatedBy: U_ME, validatedAt: '2026-11-06T05:00:00.000Z', version: 2 }),
      ],
    });
    renderScreen([PACK_READ, PACK_VALIDATE]);
    const form = await screen.findByRole('form', { name: 'Validate GRATUITY revision 1' });
    // Only an inactive draft is validated.
    expect(screen.queryByRole('form', { name: 'Validate GRATUITY revision 2' })).toBeNull();
    fireEvent.click(button(form, 'Record the validation'));
    expect((await within(form).findByRole('alert')).textContent).toBe('Record where the values were obtained.');
    fireEvent.change(within(form).getByLabelText('Source reference: where the values were obtained (required)'), { target: { value: ' Synthetic source ' } });
    fireEvent.click(button(form, 'Record the validation'));
    expect(within(form).getByRole('alert').textContent).toBe('Record how the values were validated for the jurisdiction and period.');
    await settle();
    expect(callsTo('POST', `/v1/statutory-rule-packs/${K_DRAFT}/validate`)).toEqual([]);
    fireEvent.change(within(form).getByLabelText('Validation reference: how they were checked for the jurisdiction and period (required)'), { target: { value: 'Synthetic check' } });
    fireEvent.click(button(form, 'Record the validation'));
    await waitFor(() => expect(callsTo('POST', `/v1/statutory-rule-packs/${K_DRAFT}/validate`)).toHaveLength(1));
    expect(bodyOf('POST', `/v1/statutory-rule-packs/${K_DRAFT}/validate`)).toEqual({ sourceReference: 'Synthetic source', validationReference: 'Synthetic check', expectedVersion: 1 });
    expect((await screen.findByRole('status')).textContent).toBe(
      'GRATUITY revision 1 is validated. It is used once someone other than its author and its validator activates it.',
    );
  });

  it('says a stale validation in words and loads the packs again', async () => {
    serve({
      'GET /v1/statutory-rule-packs': [200, PACKS],
      [`POST /v1/statutory-rule-packs/${K_DRAFT}/validate`]: [409, { error: 'STALE_VERSION', message: 'The pack changed; reload and retry' }],
    });
    renderScreen([PACK_READ, PACK_VALIDATE]);
    const form = await screen.findByRole('form', { name: 'Validate GRATUITY revision 1' });
    fireEvent.change(within(form).getByLabelText('Source reference: where the values were obtained (required)'), { target: { value: 'Synthetic source' } });
    fireEvent.change(within(form).getByLabelText('Validation reference: how they were checked for the jurisdiction and period (required)'), { target: { value: 'Synthetic check' } });
    fireEvent.click(button(form, 'Record the validation'));
    expect((await within(form).findByRole('alert')).textContent).toContain('The revision changed after it was loaded. The rule packs have been reloaded: check it and try again.');
    await waitFor(() => expect(callsTo('GET', '/v1/statutory-rule-packs')).toHaveLength(2));
  });

  it('activates a validated revision against its version; someone who wrote or validated it is left out', async () => {
    let attempt = 0;
    serve({
      'GET /v1/statutory-rule-packs': [200, PACKS],
      [`POST /v1/statutory-rule-packs/${K_VALIDATED}/activate`]: () => {
        attempt += 1;
        if (attempt === 1) return [403, { error: 'SELF_APPROVAL', message: 'A statutory rule pack is activated by someone other than the person who wrote or validated it' }];
        return [200, pack({ id: K_VALIDATED, revision: 2, effectiveFrom: '2026-04-01', state: 'ACTIVE', activatedBy: U_ME, activatedAt: '2026-11-06T05:00:00.000Z', version: 4 })];
      },
    });
    const view = renderScreen([PACK_READ, PACK_ACTIVATE]);
    const item = await screen.findByRole('listitem', { name: 'GRATUITY revision 2, from 1 Apr 2026' });
    // Only a validated revision is activated.
    expect(screen.queryByRole('button', { name: 'Activate GRATUITY revision 1' })).toBeNull();
    fireEvent.click(button(item, 'Activate GRATUITY revision 2'));
    const alert = await within(item).findByRole('alert');
    expect(alert.textContent).toContain('Activated by someone other than the person who wrote or validated it.');
    expect(alert.textContent).toContain('SELF_APPROVAL');
    expect(bodyOf('POST', `/v1/statutory-rule-packs/${K_VALIDATED}/activate`)).toEqual({ expectedVersion: 3 });
    fireEvent.click(button(item, 'Activate GRATUITY revision 2'));
    expect((await screen.findByRole('status')).textContent).toBe('GRATUITY revision 2 is active from 1 Apr 2026. A settlement calculated from now on uses it.');
    view.unmount();

    // The validator (here the signed-in user) is told someone else activates it.
    serve({ 'GET /v1/statutory-rule-packs': [200, { ...PACKS, items: [pack({ id: K_VALIDATED, revision: 2, state: 'VALIDATED', validatedBy: U_ME, validatedAt: '2026-10-01T05:00:00.000Z' })] }] });
    renderScreen([PACK_READ, PACK_ACTIVATE]);
    const own = await screen.findByRole('listitem', { name: 'GRATUITY revision 2, from 29 Mar 2018' });
    expect(button(own, 'Activate GRATUITY revision 2').disabled).toBe(true);
    expect(within(own).getByText('You wrote or validated this revision, so someone else activates it.')).toBeTruthy();
  });
});
