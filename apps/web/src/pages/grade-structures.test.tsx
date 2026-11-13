// Grade salary structures and CTC categories (FR-028, FR-029; I-80), jsdom: rules are shown as the server returns them, typed lines are
// sent as structured lines, a draft is activated only by someone other than its author. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GRADE_STRUCTURE_SCREENS, parseLines } from './grade-structures';

const session = vi.hoisted(() => ({ permissions: [] as string[], userId: 'author-user' }));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: 'c1', assignmentId: 'a1' },
    me: { userId: session.userId, scopeKind: 'COMPANY', employeeId: null, roleCode: 'HR_ADMINISTRATOR' },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

type Reply = [number, unknown];
let calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
function serve(routes: Record<string, Reply>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      const reply = routes[`${method} ${url.pathname}`] ?? ([404, { error: 'NOT_FOUND', message: 'No mock' }] as Reply);
      return new Response(JSON.stringify(reply[1]), { status: reply[0], headers: { 'content-type': 'application/json' } });
    }),
  );
}
const show = (permissions: string[]) => {
  session.permissions = permissions;
  const Component = GRADE_STRUCTURE_SCREENS[0]!.component;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Component />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};
const LINES = [
  { sequence: 1, componentCode: 'BASIC', method: 'PERCENT_OF_CTC', percent: '40.0000', baseComponentCode: null, amount: null },
  { sequence: 2, componentCode: 'HRA', method: 'PERCENT_OF_COMPONENT', percent: '50.0000', baseComponentCode: 'BASIC', amount: null },
  { sequence: 3, componentCode: 'CONV', method: 'FIXED_MONTHLY', percent: null, baseComponentCode: null, amount: '1600.0000' },
  { sequence: 4, componentCode: 'SPECIAL', method: 'BALANCE', percent: null, baseComponentCode: null, amount: null },
];
const STRUCTURE = { id: 's1', revision: 1, gradeCode: 'G1', gradeName: 'Grade One', effectiveFrom: '2026-01-01', currencyCode: 'INR', state: 'DRAFT', createdBy: 'someone-else', version: 1, lines: LINES };
const READ = 'payroll_config.read.operational';
const MANAGE = 'payroll_config.manage.operational';
const ACTIVATE = 'payroll_config.activate.operational';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('grade salary structures (FR-028, I-80)', () => {
  it('shows each rule in words and activates a draft someone else wrote', async () => {
    serve({
      'GET /v1/payroll/grade-structures': [200, { items: [STRUCTURE, { ...STRUCTURE, id: 's2', revision: 2, createdBy: 'author-user' }] }],
      'GET /v1/payroll/ctc-categories': [200, { items: [{ id: 'c1', code: 'STAFF', name: 'Staff CTC', active: true }] }],
      'POST /v1/payroll/grade-structures/s1/activate': [200, { ...STRUCTURE, state: 'ACTIVE' }],
    });
    show([READ, ACTIVATE]);
    const card = await screen.findByLabelText('Structure G1 revision 1');
    expect(card.textContent).toContain('BASIC: 40% of monthly CTC');
    expect(card.textContent).toContain('HRA: 50% of BASIC');
    expect(card.textContent).toContain('CONV: fixed 1600.0000 a month');
    expect(card.textContent).toContain('SPECIAL: the balance of the monthly CTC');
    expect(within(screen.getByLabelText('Structure G1 revision 2')).queryByRole('button', { name: 'Activate' })).toBeNull();
    expect((await screen.findByRole('list', { name: 'CTC categories' })).textContent).toContain('STAFF: Staff CTC');
    expect(screen.queryByRole('form', { name: 'New grade salary structure' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/v1/payroll/grade-structures/s1/activate', body: { expectedVersion: 1 } });
  });

  it('sends typed lines as structured rules', async () => {
    expect(parseLines('BASIC PCT 40\nHRA PCT_OF BASIC 50\nCONV FIXED 1600\n\nSPECIAL BALANCE')).toEqual([
      { componentCode: 'BASIC', method: 'PERCENT_OF_CTC', percent: '40' },
      { componentCode: 'HRA', method: 'PERCENT_OF_COMPONENT', baseComponentCode: 'BASIC', percent: '50' },
      { componentCode: 'CONV', method: 'FIXED_MONTHLY', amount: '1600' },
      { componentCode: 'SPECIAL', method: 'BALANCE' },
    ]);
    serve({ 'GET /v1/payroll/grade-structures': [200, { items: [] }], 'GET /v1/payroll/ctc-categories': [200, { items: [] }], 'POST /v1/payroll/grade-structures': [201, STRUCTURE] });
    show([READ, MANAGE]);
    const form = await screen.findByRole('form', { name: 'New grade salary structure' });
    fireEvent.change(within(form).getByLabelText('Grade code'), { target: { value: 'G1' } });
    fireEvent.change(within(form).getByLabelText('Effective from'), { target: { value: '2026-01-01' } });
    fireEvent.change(within(form).getByLabelText('Lines'), { target: { value: 'BASIC PCT 40\nSPECIAL BALANCE' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save as draft' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      gradeCode: 'G1',
      effectiveFrom: '2026-01-01',
      currencyCode: 'INR',
      lines: [
        { componentCode: 'BASIC', method: 'PERCENT_OF_CTC', percent: '40' },
        { componentCode: 'SPECIAL', method: 'BALANCE' },
      ],
    });
  });
});

describe('external deduction codes (FR-028, I-91)', () => {
  it('lists mappings, drafts one, and activates or retires by decision', async () => {
    serve({
      'GET /v1/payroll/grade-structures': [200, { items: [] }],
      'GET /v1/payroll/ctc-categories': [200, { items: [] }],
      'GET /v1/payroll/external-deductions': [
        200,
        {
          items: [
            { id: 'x1', externalCode: 'CANTEEN', name: 'Canteen', componentCode: 'CANTEEN_DED', effectiveFrom: '2026-01-01', reason: 'Vendor', state: 'DRAFT', createdBy: 'someone', version: 1 },
            { id: 'x2', externalCode: 'SOCIETY', name: 'Society', componentCode: 'SOC_DED', effectiveFrom: '2026-01-01', reason: 'Society', state: 'ACTIVE', createdBy: 'someone', version: 2 },
          ],
        },
      ],
      'POST /v1/payroll/external-deductions/x1/decision': [200, {}],
      'POST /v1/payroll/external-deductions': [201, {}],
    });
    show([READ, MANAGE, ACTIVATE]);
    const list = await screen.findByRole('list', { name: 'External deduction codes' });
    expect(list.textContent).toContain('CANTEEN (Canteen) → CANTEEN_DED from 1 Jan 2026');
    expect(within(list).getAllByRole('button', { name: 'Activate' })).toHaveLength(1);
    expect(within(list).getAllByRole('button', { name: 'Retire' })).toHaveLength(1);
    fireEvent.click(within(list).getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/v1/payroll/external-deductions/x1/decision')?.body).toEqual({ action: 'ACTIVATE', expectedVersion: 1 }));
    const form = screen.getByRole('form', { name: 'Map an external deduction code' });
    const entries: [string, string][] = [
      ['External code', 'INSURANCE'],
      ['Name', 'Group insurance'],
      ['Deduction component code', 'INS_DED'],
      ['Effective from', '2026-12-01'],
      ['Reason', 'Insurer agreement'],
    ];
    for (const [label, value] of entries) {
      fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    }
    fireEvent.click(within(form).getByRole('button', { name: 'Save as draft' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path === '/v1/payroll/external-deductions')?.body).toEqual({
        externalCode: 'INSURANCE',
        name: 'Group insurance',
        componentCode: 'INS_DED',
        effectiveFrom: '2026-12-01',
        reason: 'Insurer agreement',
      }),
    );
  });
});
