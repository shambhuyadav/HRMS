// Expense policies (jsdom; FR-078; DF06): revisions with their values, rules, warnings and refusals in words, draft maintenance
// with no value proposed, independent activation, retirement and categories. Duties decide what is offered. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODULE_SCREENS } from '../screens-registry';
import { EXPENSE_ADMIN_SCREENS, type ExpensePolicy } from './expense-admin';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({ stored: { companyId: 'c-1', assignmentId: 'a-1' }, me: { employeeId: null, scopeKind: 'COMPANY' }, can: (p: string) => session.permissions.includes(p) }),
}));

const MANAGE = 'expense_policy.manage.operational';
const ACTIVATE = 'expense_policy.activate.operational';

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
const open = () => {
  const Page = EXPENSE_ADMIN_SCREENS.find((s) => s.path === '/expense/policies')!.component;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const RULE = { id: 'r-1', category: 'MEALS', limitBasis: 'PER_DAY', grade: null, location: null, limitAmount: '1000.0000', receiptRequired: true };
const ACTIVE: ExpensePolicy = {
  id: 'p-1',
  code: 'DEFAULT',
  revision: 1,
  currency: 'INR',
  effectiveFrom: '2000-01-01',
  effectiveTo: null,
  submissionWindowDays: 30,
  highValueThreshold: '50000.0000',
  state: 'ACTIVE',
  version: 2,
  lastUsedOn: '2026-10-20',
  rules: [RULE],
  warnings: [],
};
const DRAFT: ExpensePolicy = {
  ...ACTIVE,
  id: 'p-2',
  revision: 2,
  effectiveFrom: '2026-12-01',
  state: 'DRAFT',
  version: 3,
  lastUsedOn: null,
  rules: [{ ...RULE, id: 'r-2', category: 'ACCOMMODATION', limitBasis: 'PER_NIGHT', grade: 'G1', location: 'HQ', limitAmount: '6000.0000', receiptRequired: false }],
  warnings: [{ code: 'TIED_RULES', text: 'A grade rule and a location rule of one category tie for an employee with both.' }],
};
const OPTIONS = { categories: [{ id: 'c-1', code: 'MEALS', name: 'Meals', limitBasis: 'PER_DAY' }], grades: [{ id: 'g-1', code: 'G1', name: 'One' }], locations: [{ id: 'l-1', code: 'HQ', name: 'Head office' }] };
const CATEGORIES = { items: [{ id: 'c-1', code: 'MEALS', name: 'Meals', limitBasis: 'PER_DAY', active: true, version: 1 }] };
const BASE_ROUTES = { 'GET /v1/expense/policies': [200, { items: [ACTIVE, DRAFT] }] as Reply, 'GET /v1/expense/policy-options': [200, OPTIONS] as Reply, 'GET /v1/expense/category-maintenance': [200, CATEGORIES] as Reply };

describe('the screen', () => {
  it('is registered behind the management duty', () => {
    expect(MODULE_SCREENS.find((s) => s.path === '/expense/policies')).toMatchObject({ title: 'Expense policies', permission: MANAGE, nav: true });
  });

  it('shows each revision\'s period, values and rules, and a warning in words', async () => {
    session.permissions = [MANAGE, ACTIVATE];
    mockApi(BASE_ROUTES);
    open();
    const table = await screen.findByRole('table', { name: 'Expense policy revisions' });
    const [, first, second] = within(table).getAllByRole('row');
    expect(first!.textContent).toContain('DEFAULT revision 1');
    expect(first!.textContent).toContain('from 2000-01-01');
    expect(first!.textContent).toContain('Submission within 30 days; high-value approval above INR 50000.00');
    expect(first!.textContent).toContain('MEALS for the whole company: INR 1000.00 a day, receipt required');
    expect(first!.textContent).toContain('Used by submitted claims up to');
    expect(second!.textContent).toContain('ACCOMMODATION for grade G1, location HQ: INR 6000.00 a night, receipt not required');
    expect(within(second!).getByRole('note').textContent).toContain('tie for an employee with both');
  });

  it('offers duties by role: an activator cannot edit, a maintainer cannot activate or retire', async () => {
    session.permissions = [ACTIVATE];
    mockApi(BASE_ROUTES);
    const view = open();
    await screen.findByRole('table', { name: 'Expense policy revisions' });
    expect(screen.getByText('Activate DEFAULT revision 2')).toBeTruthy();
    expect(screen.getByText('Retire DEFAULT revision 1')).toBeTruthy();
    expect(screen.queryByText('Edit DEFAULT revision 2')).toBeNull();
    expect(screen.queryByRole('form', { name: 'New policy revision' })).toBeNull();
    view.unmount();

    session.permissions = [MANAGE];
    mockApi(BASE_ROUTES);
    open();
    await screen.findByRole('table', { name: 'Expense policy revisions' });
    expect(screen.getByText('Edit DEFAULT revision 2')).toBeTruthy();
    expect(screen.getByRole('form', { name: 'New policy revision' })).toBeTruthy();
    expect(screen.queryByText('Activate DEFAULT revision 2')).toBeNull();
    expect(screen.queryByText('Retire DEFAULT revision 1')).toBeNull();
    // A frozen revision offers no editing.
    expect(screen.queryByText('Edit DEFAULT revision 1')).toBeNull();
    expect(screen.queryByText('Add a rule to DEFAULT revision 1')).toBeNull();
  });
});

describe('maintaining a draft', () => {
  it('a new revision takes every value from the form: nothing is proposed', async () => {
    session.permissions = [MANAGE];
    const calls = mockApi({ ...BASE_ROUTES, 'POST /v1/expense/policies': [201, { id: 'p-9', revision: 1, state: 'DRAFT', version: 1 }] });
    open();
    const form = await screen.findByRole('form', { name: 'New policy revision' });
    for (const label of ['Effective from', 'Submission window (calendar days)', 'High-value approval above (INR)']) expect((within(form).getByLabelText(label) as HTMLInputElement).value).toBe('');
    type(within(form).getByLabelText('Policy code'), 'travel_2027');
    type(within(form).getByLabelText('Effective from'), '2027-04-01');
    type(within(form).getByLabelText('Submission window (calendar days)'), '45');
    type(within(form).getByLabelText('High-value approval above (INR)'), '75000');
    fireEvent.click(within(form).getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === '/v1/expense/policies')?.body).toEqual({ code: 'TRAVEL_2027', effectiveFrom: '2027-04-01', effectiveTo: null, submissionWindowDays: 45, highValueThreshold: '75000' }));
  });

  it('edits and adds a rule under the revision\'s version', async () => {
    session.permissions = [MANAGE];
    const calls = mockApi({ ...BASE_ROUTES, 'PATCH /v1/expense/policies/p-2': [200, { id: 'p-2', version: 4 }], 'POST /v1/expense/policies/p-2/rules': [201, { id: 'r-9', policyVersion: 4 }] });
    open();
    fireEvent.click(await screen.findByText('Edit DEFAULT revision 2'));
    const edit = screen.getByRole('form', { name: 'Edit DEFAULT revision 2' });
    type(within(edit).getByLabelText('Submission window (calendar days)'), '20');
    fireEvent.click(within(edit).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ expectedVersion: 3, effectiveFrom: '2026-12-01', effectiveTo: null, submissionWindowDays: 20, highValueThreshold: '50000.00' }));

    fireEvent.click(await screen.findByText('Add a rule to DEFAULT revision 2'));
    const rule = screen.getByRole('form', { name: 'Add a rule to DEFAULT revision 2' });
    await within(rule).findByRole('option', { name: 'MEALS' });
    type(within(rule).getByLabelText('Category'), 'c-1');
    type(within(rule).getByLabelText('Grade'), 'g-1');
    type(within(rule).getByLabelText('Limit (INR, a day)'), '750');
    fireEvent.click(within(rule).getByLabelText('Receipt required'));
    fireEvent.click(within(rule).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/v1/expense/policies/p-2/rules')?.body).toEqual({ expectedVersion: 3, categoryId: 'c-1', gradeId: 'g-1', limitAmount: '750', receiptRequired: false }));
  });

  it('removes a rule by what it says', async () => {
    session.permissions = [MANAGE];
    const calls = mockApi({ ...BASE_ROUTES, 'POST /v1/expense/policies/p-2/rules/r-2/remove': [200, { policyVersion: 4 }] });
    open();
    fireEvent.click(await screen.findByText('Remove ACCOMMODATION for grade G1, location HQ'));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/remove'))?.body).toEqual({ expectedVersion: 3 }));
  });
});

describe('activation and retirement', () => {
  const refusal = (error: string, details: unknown = undefined) => [409, { error, message: 'Refused', details }] as Reply;
  const activateWith = async (reply: Reply) => {
    session.permissions = [ACTIVATE];
    const calls = mockApi({ ...BASE_ROUTES, 'POST /v1/expense/policies/p-2/activate': reply });
    open();
    fireEvent.click(await screen.findByText('Activate DEFAULT revision 2'));
    return { calls, alert: await screen.findByRole('alert') };
  };

  it('activates under the version reviewed', async () => {
    session.permissions = [ACTIVATE];
    const calls = mockApi({ ...BASE_ROUTES, 'POST /v1/expense/policies/p-2/activate': [200, { id: 'p-2', state: 'ACTIVE', closed: ['p-1'] }] });
    open();
    fireEvent.click(await screen.findByText('Activate DEFAULT revision 2'));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/activate'))?.body).toEqual({ expectedVersion: 3 }));
  });

  it.each([
    ['POLICY_OVERLAP', { revisions: [{ code: 'TRAVEL', revision: 4 }] }, 'overlaps TRAVEL revision 4'],
    ['POLICY_IN_USE', { lastUsedOn: '2026-12-05' }, 'used the revision this would end for 2026-12-05'],
    ['POLICY_AMBIGUOUS', { ties: [{ category: 'MEALS', grade: 'G1', location: 'HQ' }] }, 'MEALS for grade G1 at location HQ'],
    ['POLICY_HAS_NO_RULES', undefined, 'at least one category rule'],
    ['SELF_APPROVAL', undefined, 'someone else must'],
    ['STALE_VERSION', undefined, 'reloaded'],
  ])('says %s in words', async (code, details, words) => {
    const { alert } = await activateWith(refusal(code, details));
    expect(alert.textContent).toContain(words);
  });

  it('a retirement takes its date and reason from the form', async () => {
    session.permissions = [ACTIVATE];
    const calls = mockApi({ ...BASE_ROUTES, 'POST /v1/expense/policies/p-1/retire': [200, { id: 'p-1', state: 'RETIRED', effectiveTo: '2027-01-01' }] });
    open();
    fireEvent.click(await screen.findByText('Retire DEFAULT revision 1'));
    const form = screen.getByRole('form', { name: 'Retire DEFAULT revision 1' });
    type(within(form).getByLabelText('No longer applies from'), '2027-01-01');
    type(within(form).getByLabelText('Reason for retiring'), ' Synthetic replacement ');
    fireEvent.click(within(form).getByRole('button', { name: 'Confirm retirement' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/retire'))?.body).toEqual({ expectedVersion: 2, effectiveTo: '2027-01-01', reason: 'Synthetic replacement' }));
  });
});

describe('categories', () => {
  it('adds a category with its limit basis, and deactivates under its version', async () => {
    session.permissions = [MANAGE];
    const calls = mockApi({ ...BASE_ROUTES, 'POST /v1/expense/categories': [201, { id: 'c-2', code: 'PARKING', version: 1 }], 'PATCH /v1/expense/categories/c-1': [200, { id: 'c-1', version: 2 }] });
    open();
    const form = await screen.findByRole('form', { name: 'New category' });
    type(within(form).getByLabelText('Category code'), 'parking');
    type(within(form).getByLabelText('Category name'), 'Synthetic parking');
    type(within(form).getByLabelText('Limit counts per'), 'PER_LINE');
    fireEvent.click(within(form).getByRole('button', { name: 'Add category' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/v1/expense/categories')?.body).toEqual({ code: 'PARKING', name: 'Synthetic parking', limitBasis: 'PER_LINE' }));
    fireEvent.click(await screen.findByText('Deactivate MEALS'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ expectedVersion: 1, active: false }));
  });
});

describe('claim currencies (OQ-17, I-80)', () => {
  it('lists enabled currencies, asks for one from the approved reference with a reason, and enables or retires by decision', async () => {
    session.permissions = [MANAGE, ACTIVATE];
    const calls = mockApi({
      'GET /v1/expense/policies': [200, { items: [] }],
      'GET /v1/expense/categories': [200, { items: [] }],
      'GET /v1/expense/currencies': [
        200,
        {
          companyCurrency: 'INR',
          reference: ['AED', 'INR', 'USD'].map((code) => ({ code, minorUnit: 2 })),
          items: [
            { id: 'cc-1', currencyCode: 'USD', state: 'DRAFT', reason: 'Conference travel', createdBy: 'someone', version: 1 },
            { id: 'cc-2', currencyCode: 'AED', state: 'ACTIVE', reason: 'Gulf office visits', createdBy: 'someone', version: 2 },
          ],
        },
      ],
      'POST /v1/expense/currencies/cc-1/decision': [200, {}],
      'POST /v1/expense/currencies': [201, {}],
    });
    open();
    const list = await screen.findByRole('list', { name: 'Claim currencies' });
    expect(list.textContent).toContain('USD: Conference travel');
    const form = screen.getByRole('form', { name: 'Ask for a claim currency' });
    const options = within(form).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Choose', 'AED', 'USD']);
    fireEvent.click(within(list).getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/v1/expense/currencies/cc-1/decision')?.body).toEqual({ action: 'ACTIVATE', expectedVersion: 1 }));
    expect(within(list).getByRole('button', { name: 'Retire' })).toBeTruthy();
    type(within(form).getByLabelText('Currency'), 'USD');
    type(within(form).getByLabelText('Reason'), 'Overseas training');
    fireEvent.click(within(form).getByRole('button', { name: 'Ask to enable' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === '/v1/expense/currencies')?.body).toEqual({ currencyCode: 'USD', reason: 'Overseas training' }));
  });
});

describe('exchange rates (I-87)', () => {
  it('lists rates, enters one with its source, and activates or cancels a draft', async () => {
    session.permissions = [MANAGE, ACTIVATE];
    const calls = mockApi({
      'GET /v1/expense/policies': [200, { items: [] }],
      'GET /v1/expense/categories': [200, { items: [] }],
      'GET /v1/expense/currencies': [200, { companyCurrency: 'INR', reference: [], items: [] }],
      'GET /v1/expense/exchange-rates': [
        200,
        { companyCurrency: 'INR', items: [{ id: 'xr-1', currencyCode: 'EUR', effectiveFrom: '2026-10-01', rate: '90.12345678', reason: 'Reference rate', state: 'DRAFT', createdBy: 'someone', version: 1 }] },
      ],
      'POST /v1/expense/exchange-rates/xr-1/decision': [200, {}],
      'POST /v1/expense/exchange-rates': [201, {}],
    });
    open();
    const list = await screen.findByRole('list', { name: 'Exchange rates' });
    expect(list.textContent).toContain('EUR from 2026-10-01: 90.12345678 (Reference rate)');
    fireEvent.click(within(list).getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/v1/expense/exchange-rates/xr-1/decision')?.body).toEqual({ action: 'ACTIVATE', expectedVersion: 1 }));
    const form = screen.getByRole('form', { name: 'Enter an exchange rate' });
    type(within(form).getByLabelText('Currency'), 'usd');
    type(within(form).getByLabelText('From'), '2026-11-01');
    type(within(form).getByLabelText('Rate'), '83.5');
    type(within(form).getByLabelText('Source'), 'Bank reference rate');
    fireEvent.click(within(form).getByRole('button', { name: 'Enter rate' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.url === '/v1/expense/exchange-rates')?.body).toEqual({ currencyCode: 'USD', effectiveFrom: '2026-11-01', rate: '83.5', reason: 'Bank reference rate' }),
    );
  });
});
