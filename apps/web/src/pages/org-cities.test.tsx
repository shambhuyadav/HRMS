// The city master screen (jsdom; BRD coverage CL-006 "City Master", CL-005 "State Master"; FR-004; BR-004; DF09; migration 0280): the
// states come from the state master, every change names the version on screen and only what changed, the server's refusals read in
// plain words, and the CSV upload goes through the shared import steps. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type City, ORG_SCREENS } from './org';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({ stored: { companyId: 'c-1', assignmentId: 'a-1' }, me: { employeeId: null, scopeKind: 'COMPANY' }, can: (p: string) => session.permissions.includes(p) }),
}));

const READ = 'org_master.read.operational';
const CREATE = 'org_master.create.operational';
const UPDATE = 'org_master.update.operational';

type Reply = [number, unknown];
type Call = { method: string; path: string; params: URLSearchParams; body: Record<string, unknown> | undefined };
let calls: Call[] = [];
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
const writes = () => calls.filter((c) => c.method !== 'GET');
const open = (permissions: string[]) => {
  session.permissions = permissions;
  const Page = ORG_SCREENS.find((s) => s.path === '/organisation/cities')!.component;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const PUNE: City = { id: 'city-1', country: 'IN', stateCode: 'MH', stateName: 'Maharashtra', stateActive: true, code: 'PUNE', name: 'Pune', active: true, validFrom: null, validTo: null, version: 3 };
const PANAJI: City = { id: 'city-2', country: 'IN', stateCode: 'GA', stateName: 'Goa', stateActive: false, code: 'PANAJI', name: 'Panaji', active: true, validFrom: null, validTo: null, version: 1 };
const STATES: Reply = [200, { category: 'STATE_IN', items: [{ code: 'GA', label: 'Goa' }, { code: 'MH', label: 'Maharashtra' }] }];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

describe('CL-006 the city master screen', () => {
  it('CL-005 CL-006: lists the cities with their state, filters by a state of the state master, and offers no change to a reader', async () => {
    serve({
      'GET /v1/reference-values': STATES,
      'GET /v1/org/cities': (c) => [200, { country: 'IN', items: c.params.get('state') === 'MH' ? [PUNE] : [PANAJI, PUNE] }],
    });
    open([READ]);
    const table = await screen.findByRole('table', { name: 'Cities' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(table.textContent).toContain('Goa (state inactive)');
    expect(calls.find((c) => c.path === '/v1/reference-values')!.params.get('category')).toBe('STATE_IN');
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'MH' } });
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Cities' })).getAllByRole('row')).toHaveLength(2));
    expect(calls.filter((c) => c.path === '/v1/org/cities').at(-1)!.params.get('state')).toBe('MH');
    // A reader is offered neither a form nor an upload, and is told where the state, bank and qualification lists are kept.
    expect(screen.queryByRole('form', { name: 'New city' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Upload cities' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit PUNE' })).toBeNull();
    expect(screen.getByText(/STATE_IN, BANK and QUALIFICATION/)).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it('CL-006: creates a city under a chosen state, and reads a refusal in plain words keeping what was typed', async () => {
    let first = true;
    serve({
      'GET /v1/reference-values': STATES,
      'GET /v1/org/cities': [200, { country: 'IN', items: [PUNE] }],
      'GET /v1/org/city-imports': [200, { items: [], total: 0, page: 1, pageSize: 25 }],
      'POST /v1/org/cities': (c) => {
        if (first) {
          first = false;
          return [422, { error: 'STATE_NOT_IN_FORCE', message: 'inactive state' }];
        }
        return [201, { ...PUNE, id: 'city-3', code: String(c.body!.code), name: String(c.body!.name), stateCode: 'GA', stateName: 'Goa' }];
      },
    });
    open([READ, CREATE]);
    const form = await screen.findByRole('form', { name: 'New city' });
    await waitFor(() => expect(within(form).getAllByRole('option')).toHaveLength(3));
    fireEvent.change(within(form).getByLabelText('State'), { target: { value: 'GA' } });
    fireEvent.change(within(form).getByLabelText('Code'), { target: { value: 'MARGAO' } });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: ' Margao ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create city' }));
    expect((await within(form).findByRole('alert')).textContent).toMatch(/inactive or outside its period/);
    expect((within(form).getByLabelText('Code') as HTMLInputElement).value).toBe('MARGAO');
    fireEvent.click(within(form).getByRole('button', { name: 'Create city' }));
    expect(await screen.findByText('Margao (Goa) created.')).toBeTruthy();
    expect(writes().map((c) => c.body)).toEqual([
      { stateCode: 'GA', code: 'MARGAO', name: 'Margao' },
      { stateCode: 'GA', code: 'MARGAO', name: 'Margao' },
    ]);
  });

  it('BR-004: a change names the version on screen and only what changed; a city is deactivated, never deleted', async () => {
    serve({
      'GET /v1/reference-values': STATES,
      'GET /v1/org/cities': [200, { country: 'IN', items: [PUNE] }],
      'PATCH /v1/org/cities/city-1': (c) => [200, { ...PUNE, ...c.body, version: 4 }],
    });
    open([READ, UPDATE]);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit PUNE' }));
    const edit = screen.getByRole('form', { name: 'Edit PUNE' });
    fireEvent.change(within(edit).getByLabelText('Name'), { target: { value: 'Pune (Poona)' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Save PUNE' }));
    await screen.findByText('PUNE saved.');
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate PUNE' }));
    await screen.findByText(/deactivated\./);
    expect(writes().map((c) => [c.method, c.path, c.body])).toEqual([
      ['PATCH', '/v1/org/cities/city-1', { expectedVersion: 3, name: 'Pune (Poona)' }],
      ['PATCH', '/v1/org/cities/city-1', { expectedVersion: 3, active: false }],
    ]);
    expect(writes().some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('CL-006 DF09: the CSV upload previews the rows, names each problem in words and adds the cities only on request', async () => {
    let committed = 0;
    serve({
      'GET /v1/reference-values': STATES,
      'GET /v1/org/cities': [200, { country: 'IN', items: [] }],
      'GET /v1/org/city-imports': [200, { items: [], total: 0, page: 1, pageSize: 25 }],
      'POST /v1/org/city-imports': [
        201,
        {
          id: 'job-1',
          state: 'PREVIEWED',
          template: 'CITY_MASTER_V1',
          fileName: 'cities.csv',
          rowCount: 2,
          acceptedCount: 0,
          rejectedCount: 0,
          rows: [
            { rowNumber: 1, businessKey: 'TN/CHENNAI', state: 'VALID', errorCode: null },
            { rowNumber: 2, businessKey: 'KL/KOCHI', state: 'VALID', errorCode: null },
          ],
        },
      ],
      'POST /v1/org/city-imports/job-1/commit': () => {
        committed += 1;
        return [200, { id: 'job-1', state: 'COMMITTED', template: 'CITY_MASTER_V1', fileName: 'cities.csv', rowCount: 2, acceptedCount: 2, rejectedCount: 0, rows: [] }];
      },
    });
    open([READ, CREATE]);
    const form = await screen.findByRole('form', { name: 'Upload cities' });
    expect(form.textContent).toContain('stateCode,cityCode,cityName');
    fireEvent.change(within(form).getByLabelText('Cities file (CSV)'), { target: { files: [new File(['stateCode,cityCode,cityName\nTN,CHENNAI,Chennai\n'], 'cities.csv', { type: 'text/csv' })] } });
    fireEvent.click(within(form).getByRole('button', { name: 'Upload and preview' }));
    const add = await screen.findByRole('button', { name: 'Add 2 cities' });
    expect(committed).toBe(0);
    const sent = calls.find((c) => c.method === 'POST' && c.path === '/v1/org/city-imports')!.body!;
    expect(sent).toMatchObject({ fileName: 'cities.csv' });
    expect(String(sent.idempotencyKey)).toMatch(/^cities-/);
    fireEvent.click(add);
    await waitFor(() => expect(committed).toBe(1));
    expect(await screen.findByText('All 2 rows were applied.')).toBeTruthy();
  });
});
