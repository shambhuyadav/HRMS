// Outdoor duty and holiday work (jsdom): returned requests are corrected and resubmitted with their version, an
// overnight outdoor-duty window is accepted while holiday work stays within its day (web-4); own requests are
// asked for only where the role's scope can include the own record (web-9); submitting or withdrawing also
// refreshes "Requests in my scope" (web-10); supporting evidence (FR-027 with FR-106, I-22): own documents are offered
// except quarantined or rejected ones, a resubmission without a new choice keeps the earlier evidence, a released file
// opens through the request's evidence route, and the API's evidence refusals are said in plain words.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkRequestsPage } from './requests';

const session = vi.hoisted(() => ({ permissions: [] as string[], scopeKind: 'OWN', employeeId: 'emp-1' as string | null, assignmentId: 'a-emp-1' }));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: 'c-1', assignmentId: session.assignmentId },
    me: { accountKey: 'syn.user', companyName: 'Synthetic Co', roleCode: 'EMPLOYEE', roleName: 'Employee', scopeKind: session.scopeKind, employeeId: session.employeeId, displayName: 'Synthetic Person' },
    can: (p: string) => session.permissions.includes(p),
  }),
}));

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
type Route = unknown | ((call: Call) => [number, unknown]);
function mockApi(routes: Record<string, Route>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      const key = Object.keys(routes)
        .filter((k) => `${call.method} ${url}`.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const route = key === undefined ? undefined : routes[key];
      const [status, body] = key === undefined ? [404, { error: 'NOT_FOUND', message: 'Not found' }] : typeof route === 'function' ? (route as (c: Call) => [number, unknown])(call) : [200, route];
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}
const renderPage = (ui: JSX.Element) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
  session.scopeKind = 'OWN';
  session.employeeId = 'emp-1';
  session.assignmentId = 'a-emp-1';
});

const SELF =['work_request.submit.operational', 'work_request.read.operational', 'work_request.withdraw.operational'];
const request = (over: Record<string, unknown>) => ({
  kind: 'outdoor_duty',
  id: 'wr-1',
  employeeId: 'emp-1',
  employeeCode: 'SYN-1',
  employeeName: 'Synthetic Person',
  startDate: '2026-11-04',
  endDate: '2026-11-04',
  startTime: null,
  endTime: null,
  purpose: 'Synthetic site visit',
  state: 'SUBMITTED',
  version: 1,
  ...over,
});
const own = () => screen.getByRole('heading', { name: 'My work requests' }).closest('section')!;

describe('correcting a returned request (web-4)', () => {
  it('resubmits a returned overnight outdoor duty with its times, the new purpose and the expected version', async () => {
    session.permissions = SELF;
    const calls = mockApi({
      'GET /v1/employees/emp-1/work-requests': { items: [request({ startTime: '22:00', endTime: '06:00', purpose: 'Synthetic night audit', state: 'RETURNED', version: 2 })] },
      'GET /v1/work-requests/outdoor_duty?': { items: [] },
      'PUT /v1/work-requests/outdoor_duty/wr-1': { requestId: 'wr-1', revision: 2, state: 'SUBMITTED' },
    });
    renderPage(<WorkRequestsPage />);
    expect(await within(await screen.findByRole('table')).findByText('2026-11-04 22:00–06:00 (ends the next day)')).toBeTruthy();
    fireEvent.click(within(own()).getByText('Correct and resubmit'));
    const form = within(own()).getByText('Resubmit').closest('form')!;
    expect(within(form).getByText(/ends on the next day/)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Purpose'), { target: { value: 'Synthetic night audit, corrected' } });
    fireEvent.click(within(form).getByText('Resubmit'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('/v1/work-requests/outdoor_duty/wr-1');
    expect(put.body).toStrictEqual({ startDate: '2026-11-04', endDate: '2026-11-04', startTime: '22:00', endTime: '06:00', purpose: 'Synthetic night audit, corrected', expectedVersion: 2 });
  });

  it('a full-day correction sends the date range and no times', async () => {
    session.permissions = SELF;
    const calls = mockApi({
      'GET /v1/employees/emp-1/work-requests': { items: [request({ startDate: '2026-11-04', endDate: '2026-11-05', state: 'RETURNED', version: 4 })] },
      'GET /v1/work-requests/outdoor_duty?': { items: [] },
      'PUT /v1/work-requests/outdoor_duty/wr-1': { requestId: 'wr-1', revision: 2, state: 'SUBMITTED' },
    });
    renderPage(<WorkRequestsPage />);
    fireEvent.click(await within(await screen.findByRole('table')).findByText('Correct and resubmit'));
    const form = within(own()).getByText('Resubmit').closest('form')!;
    fireEvent.change(within(form).getByLabelText('To'), { target: { value: '2026-11-06' } });
    fireEvent.click(within(form).getByText('Resubmit'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toStrictEqual({ startDate: '2026-11-04', endDate: '2026-11-06', purpose: 'Synthetic site visit', expectedVersion: 4 });
  });

  it('holiday work must end after it starts on its day; nothing is sent until it does', async () => {
    session.permissions = SELF;
    const calls = mockApi({
      'GET /v1/employees/emp-1/work-requests': { items: [request({ kind: 'holiday_work', id: 'hw-1', startDate: '2026-11-08', endDate: '2026-11-08', startTime: '14:00', endTime: '10:00', state: 'RETURNED', version: 2 })] },
      'GET /v1/work-requests/outdoor_duty?': { items: [] },
      'PUT /v1/work-requests/holiday_work/hw-1': { requestId: 'hw-1', revision: 2, state: 'SUBMITTED' },
    });
    renderPage(<WorkRequestsPage />);
    fireEvent.click(await within(await screen.findByRole('table')).findByText('Correct and resubmit'));
    const form = within(own()).getByText('Resubmit').closest('form')!;
    expect(within(form).getByText(/Holiday work stays within its day/)).toBeTruthy();
    expect((within(form).getByText('Resubmit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('End'), { target: { value: '18:00' } });
    fireEvent.click(within(form).getByText('Resubmit'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toStrictEqual({ startDate: '2026-11-08', endDate: '2026-11-08', startTime: '14:00', endTime: '18:00', purpose: 'Synthetic site visit', expectedVersion: 2 });
  });

  it('offers no correction without the submit duty or for a request that was not returned', async () => {
    session.permissions = ['work_request.read.operational'];
    mockApi({
      'GET /v1/employees/emp-1/work-requests': { items: [request({ state: 'RETURNED' }), request({ id: 'wr-2', state: 'SUBMITTED' })] },
      'GET /v1/work-requests/outdoor_duty?': { items: [] },
    });
    renderPage(<WorkRequestsPage />);
    await within(await screen.findByRole('table')).findAllByText('Synthetic site visit');
    expect(screen.queryByText('Correct and resubmit')).toBeNull();
  });
});

describe('raising a rejected request again (DF03, I-66)', () => {
  it('fills the form from the rejected request and links the new one; a changed kind drops the link', async () => {
    session.permissions = SELF;
    const calls = mockApi({
      'GET /v1/employees/emp-1/work-requests': { items: [request({ id: 'wr-9', kind: 'holiday_work', state: 'REJECTED', startDate: '2026-11-08', endDate: '2026-11-08', startTime: '10:00', endTime: '14:00', purpose: 'Synthetic rejected purpose' })] },
      'GET /v1/employees/emp-1/documents': { items: [] },
      'POST /v1/work-requests/holiday_work': [201, { requestId: 'wr-10', state: 'SUBMITTED' }],
      'POST /v1/work-requests/outdoor_duty': [201, { requestId: 'wr-11', state: 'SUBMITTED' }],
    });
    renderPage(<WorkRequestsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Raise again the rejected Work on holiday request' }));
    const form = within(screen.getByRole('heading', { name: 'New outdoor duty or holiday work request' }).closest('section')!);
    expect((form.getByLabelText('Kind') as HTMLSelectElement).value).toBe('holiday_work');
    expect((form.getByLabelText('Purpose') as HTMLInputElement).value).toBe('Synthetic rejected purpose');
    fireEvent.click(form.getByText('Submit request'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/v1/work-requests/holiday_work')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ startDate: '2026-11-08', purpose: 'Synthetic rejected purpose', predecessorRequestId: 'wr-9' });

    await waitFor(() => expect((form.getByLabelText('Purpose') as HTMLInputElement).value).toBe(''));
    fireEvent.click(screen.getByRole('button', { name: 'Raise again the rejected Work on holiday request' }));
    expect(form.getByText('Make it an unlinked request')).toBeTruthy();
    fireEvent.change(form.getByLabelText('Kind'), { target: { value: 'outdoor_duty' } });
    expect(form.queryByText('Make it an unlinked request')).toBeNull();
  });

  it('is not offered for a request a live one follows, or without the submit duty; the follower says what it follows', async () => {
    session.permissions = SELF;
    const items = [request({ id: 'wr-9', state: 'REJECTED' }), request({ id: 'wr-10', state: 'SUBMITTED', predecessorRequestId: 'wr-9' })];
    mockApi({ 'GET /v1/employees/emp-1/work-requests': { items }, 'GET /v1/employees/emp-1/documents': { items: [] } });
    const first = renderPage(<WorkRequestsPage />);
    expect(await screen.findByText('Raised again after a rejected request')).toBeTruthy();
    expect(screen.queryByText('Raise again')).toBeNull();
    first.unmount();
    session.permissions = ['work_request.read.operational'];
    mockApi({ 'GET /v1/employees/emp-1/work-requests': { items: [request({ id: 'wr-9', state: 'REJECTED' })] } });
    renderPage(<WorkRequestsPage />);
    expect(await screen.findByText('Synthetic site visit')).toBeTruthy();
    expect(screen.queryByText('Raise again')).toBeNull();
  });
});

describe('new requests (web-4)', () => {
  it('an overnight outdoor-duty window is sent as given on its start date', async () => {
    session.permissions = SELF;
    const calls = mockApi({
      'GET /v1/employees/emp-1/work-requests': { items: [] },
      'GET /v1/work-requests/outdoor_duty?': { items: [] },
      'POST /v1/work-requests/outdoor_duty': () => [201, { requestId: 'wr-9', state: 'SUBMITTED' }],
    });
    renderPage(<WorkRequestsPage />);
    const form = (await screen.findByText('Submit request')).closest('form')!;
    fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-11-04' } });
    fireEvent.click(within(form).getByLabelText('Part of the day'));
    fireEvent.change(within(form).getByLabelText('Start'), { target: { value: '22:00' } });
    fireEvent.change(within(form).getByLabelText('End'), { target: { value: '06:00' } });
    expect(within(form).getByText(/ends on the next day/)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Purpose'), { target: { value: 'Synthetic night audit' } });
    fireEvent.click(within(form).getByText('Submit request'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toStrictEqual({ startDate: '2026-11-04', endDate: '2026-11-04', startTime: '22:00', endTime: '06:00', purpose: 'Synthetic night audit' });
  });

  it('the form starts clean after a successful submission and keeps what was typed after a refusal', async () => {
    session.permissions = SELF;
    let posts = 0;
    const calls = mockApi({
      'GET /v1/employees/emp-1/work-requests': { items: [] },
      'GET /v1/work-requests/outdoor_duty?': { items: [] },
      'POST /v1/work-requests/outdoor_duty': () =>
        ++posts === 1 ? [409, { error: 'OVERLAPS_LEAVE', message: 'The dates overlap a leave request' }] : [201, { requestId: 'wr-9', state: 'SUBMITTED' }],
    });
    renderPage(<WorkRequestsPage />);
    const form = (await screen.findByText('Submit request')).closest('form')!;
    fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-11-04' } });
    fireEvent.change(within(form).getByLabelText('To'), { target: { value: '2026-11-05' } });
    fireEvent.change(within(form).getByLabelText('Purpose'), { target: { value: 'Synthetic site visit' } });
    fireEvent.click(within(form).getByText('Submit request'));
    expect((await screen.findByRole('alert')).textContent).toContain('OVERLAPS_LEAVE');
    expect((within(form).getByLabelText('Purpose') as HTMLInputElement).value).toBe('Synthetic site visit');

    fireEvent.click(within(form).getByText('Submit request'));
    expect(await screen.findByText('Request submitted for review.')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toStrictEqual([
      { startDate: '2026-11-04', endDate: '2026-11-05', purpose: 'Synthetic site visit' },
      { startDate: '2026-11-04', endDate: '2026-11-05', purpose: 'Synthetic site visit' },
    ]);
    expect((within(form).getByLabelText('From') as HTMLInputElement).value).toBe('');
    expect((within(form).getByLabelText('To') as HTMLInputElement).value).toBe('');
    expect((within(form).getByLabelText('Purpose') as HTMLInputElement).value).toBe('');
  });
});

describe('"Requests in my scope" starts at the local month and day', () => {
  const tz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Asia/Kolkata'; // UTC+5:30
  });
  afterAll(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks for the local month to date, not the UTC one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T20:00:00Z')); // 01:30 on 1 November in India
    session.permissions = ['work_request.read.operational'];
    session.scopeKind = 'TEAM';
    const calls = mockApi({ 'GET /v1/work-requests/outdoor_duty?': { items: [] } });
    renderPage(<WorkRequestsPage />);
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/v1/work-requests/outdoor_duty?'))).toBe(true));
    expect(calls.find((c) => c.url.startsWith('/v1/work-requests/outdoor_duty?'))!.url).toBe('/v1/work-requests/outdoor_duty?from=2026-11-01&to=2026-11-01');
  });
});

describe('"Requests in my scope" stays current (web-10)', () => {
  it('is refreshed after submitting and after withdrawing', async () => {
    session.permissions = SELF;
    const calls = mockApi({
      'GET /v1/employees/emp-1/work-requests': { items: [request({ state: 'SUBMITTED' })] },
      'GET /v1/work-requests/outdoor_duty?': { items: [] },
      'POST /v1/work-requests/outdoor_duty/wr-1/withdraw': { requestId: 'wr-1', state: 'WITHDRAWN' },
      'POST /v1/work-requests/outdoor_duty': () => [201, { requestId: 'wr-9', state: 'SUBMITTED' }],
    });
    const registerCalls = () => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/v1/work-requests/outdoor_duty?')).length;
    renderPage(<WorkRequestsPage />);
    await waitFor(() => expect(registerCalls()).toBe(1));

    const form = (await screen.findByText('Submit request')).closest('form')!;
    fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-11-04' } });
    fireEvent.change(within(form).getByLabelText('To'), { target: { value: '2026-11-04' } });
    fireEvent.change(within(form).getByLabelText('Purpose'), { target: { value: 'Synthetic site visit' } });
    fireEvent.click(within(form).getByText('Submit request'));
    await waitFor(() => expect(registerCalls()).toBe(2));

    fireEvent.click(await within(own()).findByText('Withdraw'));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/work-requests/outdoor_duty/wr-1/withdraw')).toBe(true));
    await waitFor(() => expect(registerCalls()).toBe(3));
  });
});

describe('own requests and the role scope (web-9)', () => {
  it('a team-scope role makes no own-record call and shows no own-record error', async () => {
    session.permissions = ['work_request.read.operational', 'leave.approve.operational'];
    session.scopeKind = 'TEAM';
    const calls = mockApi({ 'GET /v1/work-requests/outdoor_duty?': { items: [request({ employeeCode: 'SYN-2', employeeName: 'Synthetic Report' })] } });
    renderPage(<WorkRequestsPage />);
    expect(await screen.findByText('Synthetic Report')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'My work requests' })).toBeNull();
    expect(calls.some((c) => c.url.startsWith('/v1/employees/'))).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a company-scope role whose filters leave out the own record hides the section instead of an error', async () => {
    session.permissions = ['work_request.read.operational'];
    session.scopeKind = 'COMPANY';
    const calls = mockApi({ 'GET /v1/work-requests/outdoor_duty?': { items: [] } });
    renderPage(<WorkRequestsPage />);
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/employees/emp-1/work-requests')).toBe(true));
    expect(await screen.findByText('No requests in this period.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'My work requests' })).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------
// FR-027 with FR-106 (I-22): supporting evidence
// ---------------------------------------------------------------------------------------------------------

const WITH_DOCUMENTS = [...SELF, 'document.read.document'];
/** One own document as GET /v1/employees/{id}/documents lists it in the employee's own view. */
const ownDocument = (over: Record<string, unknown>) => ({
  id: 'doc-1',
  documentType: 'GENERAL',
  fileName: 'travel-order.pdf',
  mediaType: 'application/pdf',
  byteSize: 2048,
  expiresOn: null,
  expired: false,
  uploadedAt: '2026-10-20T06:00:00Z',
  scanState: 'CLEAN',
  verificationState: 'UNVERIFIED',
  verifiedAt: null,
  ...over,
});
const DOCUMENTS = [
  ownDocument({}),
  ownDocument({ id: 'doc-2', fileName: 'visit-order.pdf', scanState: 'PENDING_SCAN' }),
  ownDocument({ id: 'doc-3', fileName: 'flagged.pdf', scanState: 'QUARANTINED' }),
  ownDocument({ id: 'doc-4', fileName: 'refused.pdf', verificationState: 'REJECTED', verifiedAt: '2026-10-21T06:00:00Z' }),
];
/** Evidence of a request revision as the request list returns it (metadata only). */
const EVIDENCE_RELEASED = { documentId: 'doc-1', documentType: 'GENERAL', scanState: 'CLEAN', verificationState: 'VERIFIED' };
const EVIDENCE_PENDING = { documentId: 'doc-2', documentType: 'TRAVEL_ORDER', scanState: 'PENDING_SCAN', verificationState: 'UNVERIFIED' };
const NEW_REQUEST_ROUTES = {
  'GET /v1/employees/emp-1/work-requests': { items: [] },
  'GET /v1/employees/emp-1/documents': { items: DOCUMENTS },
  'GET /v1/work-requests/outdoor_duty?': { items: [] },
};
const choiceGroup = { name: /Supporting documents/ };

async function fillNewRequest() {
  const form = (await screen.findByText('Submit request')).closest('form')!;
  fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-11-04' } });
  fireEvent.change(within(form).getByLabelText('To'), { target: { value: '2026-11-04' } });
  fireEvent.change(within(form).getByLabelText('Purpose'), { target: { value: 'Synthetic site visit' } });
  return form;
}

/** jsdom has no object URLs: a downloaded file is "saved" through a click on a link to one, counted here. */
function stubDownloads() {
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = vi.fn(() => 'blob:synthetic-evidence');
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

describe('supporting evidence on a new request (FR-027, FR-106)', () => {
  it('offers own documents except quarantined or rejected ones, says which wait for the scan, and sends the chosen ids', async () => {
    session.permissions = WITH_DOCUMENTS;
    const calls = mockApi({ ...NEW_REQUEST_ROUTES, 'POST /v1/work-requests/outdoor_duty': () => [201, { requestId: 'wr-9', state: 'SUBMITTED' }] });
    renderPage(<WorkRequestsPage />);
    const form = await fillNewRequest();
    const choice = await within(form).findByRole('group', choiceGroup);
    expect(within(choice).getAllByRole('checkbox')).toHaveLength(2);
    expect(choice.textContent).not.toContain('flagged.pdf');
    expect(choice.textContent).not.toContain('refused.pdf');
    expect(within(choice).getByLabelText(/visit-order\.pdf/).closest('label')!.textContent).toContain('waiting for the malware scan');
    expect(within(choice).getByLabelText(/travel-order\.pdf/).closest('label')!.textContent).not.toContain('waiting for the malware scan');
    fireEvent.click(within(choice).getByLabelText(/visit-order\.pdf/));
    fireEvent.click(within(choice).getByLabelText(/travel-order\.pdf/));
    fireEvent.click(within(form).getByText('Submit request'));
    expect(await screen.findByText('Request submitted for review.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')!.body).toStrictEqual({
      startDate: '2026-11-04',
      endDate: '2026-11-04',
      purpose: 'Synthetic site visit',
      evidenceDocumentIds: ['doc-2', 'doc-1'],
    });
    // The next request starts with nothing chosen.
    expect((within(choice).getByLabelText(/travel-order\.pdf/) as HTMLInputElement).checked).toBe(false);
    expect((within(choice).getByLabelText(/visit-order\.pdf/) as HTMLInputElement).checked).toBe(false);
  });

  it('lets at most 10 documents be chosen for one request', async () => {
    session.permissions = WITH_DOCUMENTS;
    mockApi({
      ...NEW_REQUEST_ROUTES,
      'GET /v1/employees/emp-1/documents': { items: Array.from({ length: 11 }, (_, i) => ownDocument({ id: `doc-${i + 1}`, fileName: `order-${i + 1}.pdf` })) },
    });
    renderPage(<WorkRequestsPage />);
    const choice = await screen.findByRole('group', choiceGroup);
    const boxes = within(choice).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(11);
    for (const box of boxes.slice(0, 10)) fireEvent.click(box);
    expect(boxes.slice(0, 10).every((b) => b.checked && !b.disabled)).toBe(true);
    expect(boxes[10]!.disabled).toBe(true);
    fireEvent.click(boxes[0]!);
    expect(boxes[10]!.disabled).toBe(false);
  });

  it('a chosen document that the scan quarantines meanwhile stays listed, saying so, until it is unticked', async () => {
    session.permissions = WITH_DOCUMENTS;
    let scanState = 'PENDING_SCAN';
    mockApi({
      ...NEW_REQUEST_ROUTES,
      'GET /v1/employees/emp-1/documents': () => [200, { items: [ownDocument({ id: 'doc-2', fileName: 'visit-order.pdf', scanState }), ownDocument({})] }],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <WorkRequestsPage />
      </QueryClientProvider>,
    );
    const choice = await screen.findByRole('group', choiceGroup);
    fireEvent.click(within(choice).getByLabelText(/visit-order\.pdf/));
    // The scan finishes while the form is open, and the list is read again.
    scanState = 'QUARANTINED';
    await act(() => client.invalidateQueries({ queryKey: ['documents'] }));
    await waitFor(() => expect(within(choice).getByLabelText(/visit-order\.pdf/).closest('label')!.textContent).toContain('quarantined by the malware scan: untick it'));
    const box = within(choice).getByLabelText(/visit-order\.pdf/) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(within(choice).queryByLabelText(/visit-order\.pdf/)).toBeNull();
    expect(within(choice).getAllByRole('checkbox')).toHaveLength(1);
  });

  it('after EVIDENCE_UNUSABLE reads the documents again, so the form says which chosen document to untick', async () => {
    session.permissions = WITH_DOCUMENTS;
    let reads = 0;
    const calls = mockApi({
      ...NEW_REQUEST_ROUTES,
      // The scan quarantines the chosen file after the form was opened; the server finds it on submission.
      'GET /v1/employees/emp-1/documents': () => [200, { items: [ownDocument({ id: 'doc-2', fileName: 'visit-order.pdf', scanState: ++reads === 1 ? 'PENDING_SCAN' : 'QUARANTINED' }), ownDocument({})] }],
      'POST /v1/work-requests/outdoor_duty': () => [422, { error: 'EVIDENCE_UNUSABLE', message: 'A supporting document failed the malware scan or was rejected; use another' }],
    });
    renderPage(<WorkRequestsPage />);
    const form = await fillNewRequest();
    fireEvent.click(await within(form).findByLabelText(/visit-order\.pdf/));
    fireEvent.click(within(form).getByText('Submit request'));
    expect((await screen.findByRole('alert')).textContent).toContain('A chosen document failed the malware scan or was rejected');
    await waitFor(() => expect(within(form).getByLabelText(/visit-order\.pdf/).closest('label')!.textContent).toContain('quarantined by the malware scan: untick it'));
    expect(calls.filter((c) => c.url === '/v1/employees/emp-1/documents')).toHaveLength(2);
    // Nothing typed or chosen is lost.
    expect((within(form).getByLabelText(/visit-order\.pdf/) as HTMLInputElement).checked).toBe(true);
    expect((within(form).getByLabelText('Purpose') as HTMLInputElement).value).toBe('Synthetic site visit');
  });

  for (const [code, words] of [
    ['EVIDENCE_UNUSABLE', 'A chosen document failed the malware scan or was rejected'],
    ['INVALID_EVIDENCE', 'Supporting documents must be your own uploaded documents'],
    ['TOO_MUCH_EVIDENCE', 'Attach at most 10 supporting documents'],
  ] as const) {
    it(`says ${code} in plain words and keeps what was typed and chosen`, async () => {
      session.permissions = WITH_DOCUMENTS;
      mockApi({ ...NEW_REQUEST_ROUTES, 'POST /v1/work-requests/outdoor_duty': () => [422, { error: code, message: 'Synthetic refusal' }] });
      renderPage(<WorkRequestsPage />);
      const form = await fillNewRequest();
      fireEvent.click(await within(form).findByLabelText(/travel-order\.pdf/));
      fireEvent.click(within(form).getByText('Submit request'));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(words);
      expect(alert.textContent).toContain(code);
      expect((within(form).getByLabelText(/travel-order\.pdf/) as HTMLInputElement).checked).toBe(true);
      expect((within(form).getByLabelText('Purpose') as HTMLInputElement).value).toBe('Synthetic site visit');
    });
  }

  it('offers no documents without the document read duty, makes no document call and sends no evidence', async () => {
    session.permissions = SELF;
    const calls = mockApi({ ...NEW_REQUEST_ROUTES, 'POST /v1/work-requests/outdoor_duty': () => [201, { requestId: 'wr-9', state: 'SUBMITTED' }] });
    renderPage(<WorkRequestsPage />);
    const form = await fillNewRequest();
    fireEvent.click(within(form).getByText('Submit request'));
    expect(await screen.findByText('Request submitted for review.')).toBeTruthy();
    expect(screen.queryByRole('group', choiceGroup)).toBeNull();
    expect(calls.some((c) => c.url.endsWith('/documents'))).toBe(false);
    expect(calls.find((c) => c.method === 'POST')!.body).toStrictEqual({ startDate: '2026-11-04', endDate: '2026-11-04', purpose: 'Synthetic site visit' });
  });

  it('a team-scope role, whose scope leaves out the own record, is offered no documents and makes no document call', async () => {
    session.permissions = WITH_DOCUMENTS;
    session.scopeKind = 'TEAM';
    const calls = mockApi({ 'GET /v1/work-requests/outdoor_duty?': { items: [] } });
    renderPage(<WorkRequestsPage />);
    await screen.findByText('Submit request');
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/v1/work-requests/outdoor_duty?'))).toBe(true));
    expect(screen.queryByRole('group', choiceGroup)).toBeNull();
    expect(calls.some((c) => c.url.startsWith('/v1/employees/'))).toBe(false);
  });

  it('a company-scope role whose filters leave out the own record is offered no documents and shows no error', async () => {
    session.permissions = WITH_DOCUMENTS;
    session.scopeKind = 'COMPANY';
    const calls = mockApi({ 'GET /v1/work-requests/outdoor_duty?': { items: [] } }); // own-record calls answer 404
    renderPage(<WorkRequestsPage />);
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/employees/emp-1/documents')).toBe(true));
    expect(await screen.findByText('No requests in this period.')).toBeTruthy();
    expect(screen.queryByRole('group', choiceGroup)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('evidence on own requests (FR-027, FR-106)', () => {
  let downloads: ReturnType<typeof stubDownloads>;
  beforeEach(() => {
    downloads = stubDownloads();
  });
  afterEach(() => downloads.restore());

  it('shows each document’s type, scan and verification state, and opens a released one through the request’s evidence route', async () => {
    session.permissions = SELF;
    const calls = mockApi({
      'GET /v1/employees/emp-1/work-requests': { items: [request({ state: 'APPROVED', evidence: [EVIDENCE_RELEASED, EVIDENCE_PENDING] })] },
      'GET /v1/work-requests/outdoor_duty?': { items: [] },
      'GET /v1/work-requests/outdoor_duty/wr-1/evidence/doc-1/content': { synthetic: 'pdf' },
    });
    renderPage(<WorkRequestsPage />);
    const list = await within(own()).findByRole('list', { name: 'Supporting documents' });
    const [released, pending] = within(list).getAllByRole('listitem');
    expect(within(released!).getByText('GENERAL')).toBeTruthy();
    expect(within(released!).getByText('released by the malware scan')).toBeTruthy();
    expect(within(released!).getByText('verified')).toBeTruthy();
    expect(within(pending!).getByText('TRAVEL_ORDER')).toBeTruthy();
    expect(within(pending!).getByText('waiting for the malware scan')).toBeTruthy();
    expect(within(pending!).getByText('not verified')).toBeTruthy();
    expect((within(pending!).getByRole('button', { name: 'Open' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(released!).getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(downloads.click).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.url.includes('/evidence/')).map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/work-requests/outdoor_duty/wr-1/evidence/doc-1/content']);
  });

  it('says in plain words when the malware scan has not released the file', async () => {
    session.permissions = SELF;
    mockApi({
      'GET /v1/employees/emp-1/work-requests': { items: [request({ evidence: [EVIDENCE_RELEASED] })] },
      'GET /v1/work-requests/outdoor_duty?': { items: [] },
      'GET /v1/work-requests/outdoor_duty/wr-1/evidence/doc-1/content': () => [
        409,
        { error: 'FILE_NOT_RELEASED', message: 'This file has not been released by the malware scan', details: { scanState: 'PENDING_SCAN' } },
      ],
    });
    renderPage(<WorkRequestsPage />);
    fireEvent.click(await within(own()).findByRole('button', { name: 'Open' }));
    const alert = await within(own()).findByRole('alert');
    expect(alert.textContent).toContain('This file cannot be opened until the malware scan releases it.');
    expect(alert.textContent).toContain('FILE_NOT_RELEASED');
    expect(downloads.click).not.toHaveBeenCalled();
  });

  it('offers nothing to open without the work-request read duty the evidence route checks, and says when there is no evidence', async () => {
    session.permissions = ['work_request.submit.operational'];
    mockApi({ 'GET /v1/employees/emp-1/work-requests': { items: [request({ evidence: [EVIDENCE_RELEASED] }), request({ id: 'wr-2', purpose: 'Synthetic stock count', evidence: [] })] } });
    renderPage(<WorkRequestsPage />);
    const list = await within(own()).findByRole('list', { name: 'Supporting documents' });
    expect(within(list).getByText('GENERAL')).toBeTruthy();
    expect(within(own()).queryByRole('button', { name: 'Open' })).toBeNull();
    expect(within(within(own()).getByText('Synthetic stock count').closest('tr')!).getByText('none')).toBeTruthy();
  });
});

describe('evidence on a resubmission (FR-027, I-22)', () => {
  const routes = (put: Route) => ({
    'GET /v1/employees/emp-1/work-requests': { items: [request({ state: 'RETURNED', version: 2, evidence: [EVIDENCE_RELEASED] })] },
    'GET /v1/employees/emp-1/documents': { items: DOCUMENTS },
    'GET /v1/work-requests/outdoor_duty?': { items: [] },
    'PUT /v1/work-requests/outdoor_duty/wr-1': put,
  });
  const openCorrection = async () => {
    fireEvent.click(await within(own()).findByText('Correct and resubmit'));
    return within(own()).getByText('Resubmit').closest('form')!;
  };

  it('without a new choice sends no evidence, so the earlier evidence is kept, and says so', async () => {
    session.permissions = WITH_DOCUMENTS;
    const calls = mockApi(routes({ requestId: 'wr-1', revision: 2, state: 'SUBMITTED' }));
    renderPage(<WorkRequestsPage />);
    const form = await openCorrection();
    expect(form.textContent).toContain('Without a new choice, the resubmission keeps the evidence attached before (1 document).');
    const choice = await within(form).findByRole('group', choiceGroup);
    expect(within(choice).getByLabelText(/travel-order\.pdf/).closest('label')!.textContent).toContain('attached before');
    expect(within(choice).getByLabelText(/visit-order\.pdf/).closest('label')!.textContent).not.toContain('attached before');
    fireEvent.click(within(form).getByText('Resubmit'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toStrictEqual({ startDate: '2026-11-04', endDate: '2026-11-04', purpose: 'Synthetic site visit', expectedVersion: 2 });
  });

  it('a new choice replaces the earlier evidence with exactly the documents ticked', async () => {
    session.permissions = WITH_DOCUMENTS;
    const calls = mockApi(routes({ requestId: 'wr-1', revision: 2, state: 'SUBMITTED' }));
    renderPage(<WorkRequestsPage />);
    const form = await openCorrection();
    fireEvent.click(await within(form).findByLabelText(/visit-order\.pdf/));
    fireEvent.click(within(form).getByText('Resubmit'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toStrictEqual({
      startDate: '2026-11-04',
      endDate: '2026-11-04',
      purpose: 'Synthetic site visit',
      evidenceDocumentIds: ['doc-2'],
      expectedVersion: 2,
    });
  });

  it('says in plain words when evidence kept from before can no longer be used, and keeps the correction', async () => {
    session.permissions = WITH_DOCUMENTS;
    mockApi(routes(() => [422, { error: 'EVIDENCE_UNUSABLE', message: 'A supporting document failed the malware scan or was rejected; use another' }]));
    renderPage(<WorkRequestsPage />);
    const form = await openCorrection();
    fireEvent.change(within(form).getByLabelText('Purpose'), { target: { value: 'Synthetic site visit, corrected' } });
    fireEvent.click(within(form).getByText('Resubmit'));
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toContain('A document attached before has since failed the malware scan or been rejected');
    expect(alert.textContent).toContain('EVIDENCE_UNUSABLE');
    expect((within(form).getByLabelText('Purpose') as HTMLInputElement).value).toBe('Synthetic site visit, corrected');
  });

  it('warns before resubmitting when evidence attached before was since rejected', async () => {
    session.permissions = WITH_DOCUMENTS;
    mockApi({
      ...routes({ requestId: 'wr-1', revision: 2, state: 'SUBMITTED' }),
      'GET /v1/employees/emp-1/work-requests': { items: [request({ state: 'RETURNED', version: 2, evidence: [{ ...EVIDENCE_RELEASED, verificationState: 'REJECTED' }] })] },
      'GET /v1/employees/emp-1/documents': { items: [ownDocument({ verificationState: 'REJECTED', verifiedAt: '2026-10-21T06:00:00Z' }), DOCUMENTS[1]] },
    });
    renderPage(<WorkRequestsPage />);
    const form = await openCorrection();
    expect(form.textContent).toContain('A document attached before failed the malware scan or was rejected, so choose the documents to attach.');
    // The rejected document is not offered again; the other one is.
    const choice = await within(form).findByRole('group', choiceGroup);
    expect(choice.textContent).not.toContain('travel-order.pdf');
    expect(within(choice).getAllByRole('checkbox')).toHaveLength(1);
  });

  it('after EVIDENCE_UNUSABLE reads the request and the documents again, so the form says the earlier evidence cannot be kept', async () => {
    session.permissions = WITH_DOCUMENTS;
    let requestReads = 0;
    let documentReads = 0;
    // A verifier rejects the document attached before while the correction is open.
    const verdict = (reads: number) => (reads === 1 ? 'UNVERIFIED' : 'REJECTED');
    mockApi({
      ...routes(() => [422, { error: 'EVIDENCE_UNUSABLE', message: 'A supporting document failed the malware scan or was rejected; use another' }]),
      'GET /v1/employees/emp-1/work-requests': () => [
        200,
        { items: [request({ state: 'RETURNED', version: 2, evidence: [{ ...EVIDENCE_RELEASED, verificationState: verdict(++requestReads) }] })] },
      ],
      'GET /v1/employees/emp-1/documents': () => [200, { items: [ownDocument({ verificationState: verdict(++documentReads) }), DOCUMENTS[1]] }],
    });
    renderPage(<WorkRequestsPage />);
    const form = await openCorrection();
    expect(await within(form).findByLabelText(/travel-order\.pdf/)).toBeTruthy();
    expect(form.textContent).not.toContain('A document attached before failed the malware scan or was rejected');
    fireEvent.change(within(form).getByLabelText('Purpose'), { target: { value: 'Synthetic site visit, corrected' } });
    fireEvent.click(within(form).getByText('Resubmit'));
    expect((await within(form).findByRole('alert')).textContent).toContain('A document attached before has since failed the malware scan or been rejected');
    await waitFor(() => expect(form.textContent).toContain('A document attached before failed the malware scan or was rejected, so choose the documents to attach.'));
    // The request's row says which document it is, and the rejected document is no longer offered.
    expect(within(own()).getByText('rejected by the verifier')).toBeTruthy();
    await waitFor(() => expect(within(form).queryByLabelText(/travel-order\.pdf/)).toBeNull());
    expect((within(form).getByLabelText('Purpose') as HTMLInputElement).value).toBe('Synthetic site visit, corrected');
  });
});

describe('role context (C1, DF02)', () => {
  it('never offers documents answered for another role assignment, even from the cache', async () => {
    // One query cache across role switches, fresh for 15 s (as in main.tsx).
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } });
    const inPage = () => (
      <QueryClientProvider client={client}>
        <WorkRequestsPage />
      </QueryClientProvider>
    );
    session.permissions = WITH_DOCUMENTS;
    const employeeCalls = mockApi(NEW_REQUEST_ROUTES);
    const employee = render(inPage());
    expect(await screen.findByLabelText(/travel-order\.pdf/)).toBeTruthy();
    employee.unmount();
    expect(employeeCalls.filter((c) => c.url === '/v1/employees/emp-1/documents')).toHaveLength(1);

    // Another assignment of the same user: a company scope whose filters leave out the own record (the server answers 404).
    session.assignmentId = 'a-hr-finance';
    session.scopeKind = 'COMPANY';
    const hrCalls = mockApi({ 'GET /v1/work-requests/outdoor_duty?': { items: [] } });
    render(inPage());
    expect(screen.queryByText(/travel-order\.pdf/)).toBeNull();
    await waitFor(() => expect(hrCalls.some((c) => c.url === '/v1/employees/emp-1/documents')).toBe(true));
    expect(await screen.findByText('No requests in this period.')).toBeTruthy();
    expect(screen.queryByText(/travel-order\.pdf/)).toBeNull();
    expect(screen.queryByRole('group', choiceGroup)).toBeNull();
  });
});
