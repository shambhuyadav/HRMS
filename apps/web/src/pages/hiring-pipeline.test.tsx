// Hiring pipeline screens (FR-012 to FR-014; F1 hiring; DF02; FR-057; FR-106; C4; ZT07), jsdom: the exported screens
// and decision queue; the tracker as the API returns it; vendors; the candidate register and registration (exact
// bodies, form reset, refusals in words, in-flight disabling); one candidate's operational record without the
// confidential groups, the private contact read only when asked and recorded with new duplicate flags shown as flags
// (never merged), CVs with their scan state and released-only downloads; duplicate review; CV search; applications per
// requisition; stage moves as the API allows (a rejection ends that application only); offers with the compensation
// only when returned, submission, response and withdrawal; the offer approval queue and its idempotency keys; the
// handover to an employee DRAFT at most once and the employee's hiring origin; nothing cached for one role assignment
// shown under another. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatAmount, formatDate } from '../api';
import { HIRING_PIPELINE_ESS_PANELS, HIRING_PIPELINE_SCREENS, HIRING_PIPELINE_TASK_QUEUES } from './hiring-pipeline';

// The selected company and role assignment, as the session stores them; a test switches the assignment to model a role
// switch. `userId` is the signed-in user, as GET /v1/me/context returns it.
const session = vi.hoisted(() => ({
  permissions: [] as string[],
  companyId: 'c0000000-0000-4000-8000-000000000001',
  assignmentId: 'a0000000-0000-4000-8000-000000000001',
  userId: 'b0000000-0000-4000-8000-000000000001',
}));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: session.companyId, assignmentId: session.assignmentId },
    me: {
      userId: session.userId,
      accountKey: 'syn.recruiter',
      companyName: 'Synthetic Co',
      roleCode: 'RECRUITER',
      roleName: 'Recruiter',
      scopeKind: 'COMPANY',
      employeeId: null,
      displayName: 'Synthetic Recruiter',
    },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

const ASSIGNMENT = 'a0000000-0000-4000-8000-000000000001';
const OTHER_ASSIGNMENT = 'a0000000-0000-4000-8000-000000000002';
const ME = 'b0000000-0000-4000-8000-000000000001';
const OTHER_USER = 'b0000000-0000-4000-8000-000000000002';
const R1 = '10000000-0000-4000-8000-000000000001';
const R2 = '10000000-0000-4000-8000-000000000002';
const C1 = '20000000-0000-4000-8000-000000000001';
const C2 = '20000000-0000-4000-8000-000000000002';
const C3 = '20000000-0000-4000-8000-000000000003';
const V1 = '30000000-0000-4000-8000-000000000001';
const V2 = '30000000-0000-4000-8000-000000000002';
const A1 = '40000000-0000-4000-8000-000000000001';
const A2 = '40000000-0000-4000-8000-000000000002';
const A3 = '40000000-0000-4000-8000-000000000003';
const O1 = '50000000-0000-4000-8000-000000000001';
const T1 = '60000000-0000-4000-8000-000000000001';
const E1 = '70000000-0000-4000-8000-000000000001';
const D_CLEAN = '80000000-0000-4000-8000-000000000001';
const D_PENDING = '80000000-0000-4000-8000-000000000002';
const D_QUARANTINED = '80000000-0000-4000-8000-000000000003';
const F1 = '90000000-0000-4000-8000-000000000001';

// Duties as the hiring registration grants them (RECRUITER defaults) plus the confidential groups an eligible Admin
// assignment may hold (registration ceiling), and the extra duties of the handover.
const RECRUITER = [
  'requisition.read.operational',
  'candidate.read.operational',
  'candidate.manage.operational',
  'application.read.operational',
  'application.manage.operational',
  'offer.read.operational',
  'offer.manage.operational',
];
const CONTACT = ['candidate.read.contact', 'candidate.manage.contact'];
const DOCUMENTS = ['candidate.read.document', 'candidate.upload.document'];
const COMPENSATION = ['offer.read.compensation', 'offer.manage.compensation'];
const APPROVER = ['offer.read.operational', 'offer.read.compensation', 'offer.approve.compensation'];
const HANDOVER = [...RECRUITER, 'hiring.handover.operational', 'employee.create.operational'];

type Json = Record<string, unknown>;

const person = (userId: string, displayName: string | null, employeeCode: string | null) => ({ userId, displayName, employeeCode });
const ASHA = { id: C1, candidateCode: 'CAN-000001', fullName: 'Asha Synthetic', state: 'ACTIVE' };
const RAVI = { id: C2, candidateCode: 'CAN-000002', fullName: 'Ravi Synthetic', state: 'ACTIVE' };
const REQ1 = { id: R1, code: 'REQ-000001', title: 'Synthetic backend engineer', state: 'APPROVED' };
const REQ2 = { id: R2, code: 'REQ-000002', title: 'Synthetic data analyst', state: 'APPROVED' };
const VENDOR = { id: V1, code: 'SYN-AGENCY', name: 'Synthetic Staffing', active: true, version: 1 };

const candidate = (patch: Json = {}): Json => ({
  id: C1,
  candidateCode: 'CAN-000001',
  fullName: 'Asha Synthetic',
  source: { code: 'DIRECT', label: 'Direct application' },
  vendor: null,
  skills: ['Kotlin', 'SQL'],
  consentStatus: 'GIVEN',
  consentRecordedOn: '2026-10-01',
  retainUntil: null,
  state: 'ACTIVE',
  createdAt: '2026-10-01T05:00:00.000Z',
  version: 1,
  ...patch,
});
const candidateView = (patch: Json = {}): Json => ({ ...candidate(), contactRecorded: false, applications: [], duplicateFlags: [], ...patch });

const application = (patch: Json = {}): Json => ({
  id: A1,
  stage: 'APPLIED',
  stageEnteredAt: '2026-10-20T06:00:00.000Z',
  ageingDays: 3,
  pendingAction: 'START_SCREENING',
  owner: person(ME, 'Synthetic Recruiter', 'SYN-9'),
  candidate: ASHA,
  requisition: REQ1,
  latestOffer: null,
  createdAt: '2026-10-20T06:00:00.000Z',
  version: 1,
  ...patch,
});
const applicationView = (patch: Json = {}): Json => ({
  ...application(),
  history: [{ fromStage: null, toStage: 'APPLIED', note: null, actorUserId: ME, occurredAt: '2026-10-20T06:00:00.000Z' }],
  offers: [],
  ...patch,
});

const offer = (patch: Json = {}): Json => ({
  id: O1,
  state: 'DRAFT',
  proposedJoiningDate: '2026-12-01',
  currentRevision: 0,
  application: { id: A2, stage: 'OFFER' },
  requisition: REQ1,
  candidate: { id: C2, candidateCode: 'CAN-000002', fullName: 'Ravi Synthetic' },
  preparedBy: OTHER_USER,
  submittedBy: null,
  submittedAt: null,
  decidedBy: null,
  decidedAt: null,
  candidateResponseOn: null,
  withdrawnReason: null,
  withdrawnAt: null,
  handedOverEmployeeId: null,
  createdAt: '2026-10-22T06:00:00.000Z',
  version: 1,
  ...patch,
});
const offerView = (patch: Json = {}): Json => ({ ...offer(), decisions: [], pendingWith: null, ...patch });

const doc = (id: string, fileName: string, scanState: string, candidateId = C1): Json => ({
  id,
  candidateId,
  candidateCode: candidateId === C1 ? 'CAN-000001' : 'CAN-000002',
  documentType: 'CV',
  fileName,
  mediaType: 'application/pdf',
  byteSize: 18,
  scanState,
  uploadedAt: '2026-10-23T06:00:00.000Z',
});

const FLAG = {
  flagId: F1,
  basis: 'EMAIL',
  state: 'OPEN',
  flaggedAt: '2026-10-24T06:00:00.000Z',
  resolvedAt: null,
  resolutionNote: null,
  retiredCandidateId: null,
  candidate: RAVI,
  matchedCandidate: ASHA,
};

interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: unknown;
}
type Reply = [status: number, body: unknown];
/** A fixed reply, or a handler that sees the request; a handler may hold its reply back (a promise) or throw (a lost answer). */
type Route = Reply | ((call: Call) => Reply | Promise<Reply>);

let calls: Call[] = [];
const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const bodyOf = (method: string, path: string, index = 0) => callsTo(method, path)[index]?.body as Json | undefined;

/** A fetch stub answering "METHOD /path" (the query string is recorded apart); anything else is a 404. */
function serve(routes: Record<string, Route>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname, params: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}`];
      const [status, body]: Reply = route === undefined ? [404, { error: 'NOT_FOUND', message: `No mock for ${call.method} ${call.path}` }] : typeof route === 'function' ? await route(call) : route;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}

/** An answer that arrives only when the test lets it go. */
function held(reply: Reply) {
  let release: () => void = () => undefined;
  const promise = new Promise<Reply>((resolve) => {
    release = () => resolve(reply);
  });
  return { handler: () => promise, release: () => release() };
}

const testClient = (staleTime = 0) => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime }, mutations: { retry: false } } });

/** Every exported screen under its own path, as the navigation step will mount them. */
function renderAt(path: string, permissions: string[], client = testClient()) {
  session.permissions = permissions;
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {HIRING_PIPELINE_SCREENS.map((s) => (
            <Route key={s.path} path={s.path} element={<s.component />} />
          ))}
          <Route path="*" element={<p>Somewhere else</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderQueue(permissions: string[]) {
  session.permissions = permissions;
  const Queue = HIRING_PIPELINE_TASK_QUEUES[0]!.component;
  return render(
    <QueryClientProvider client={testClient()}>
      <MemoryRouter>
        <Queue />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((c) => c.textContent?.trim());
const rows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1);
const headers = (table: HTMLElement) => within(table).getAllByRole('columnheader').map((h) => h.textContent);
const rowWith = (table: HTMLElement, text: string) => within(table).getByText(text).closest('tr') as HTMLElement;
/** A card of the page by its title (the h2 of ui.tsx Section; page titles are h1, form titles h3). */
const sectionOf = async (heading: string) => (await screen.findByRole('heading', { level: 2, name: heading })).closest('section') as HTMLElement;
/** The value shown for a term of a description list. */
const valueOf = (scope: HTMLElement, term: string) => {
  const dt = within(scope)
    .getAllByText(term)
    .find((el) => el.tagName === 'DT');
  if (!dt) throw new Error(`No term "${term}"`);
  return dt.nextElementSibling?.textContent ?? null;
};
const type = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } });
const click = (button: HTMLElement) => fireEvent.click(button);
const disabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled;
const valueIn = (el: HTMLElement) => (el as HTMLInputElement).value;

/** Lets any request a click might have started reach the fetch stub before asserting that none was made. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

/** jsdom has no object URLs: a downloaded file is "saved" through a click on a link to one, counted here. */
function stubDownloads() {
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = vi.fn(() => 'blob:synthetic-cv');
  URL.revokeObjectURL = vi.fn();
  const saved = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  return {
    saved,
    restore: () => {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
      saved.mockRestore();
    },
  };
}

const pdf = (name: string) => new File(['%PDF-1.4 synthetic'], name, { type: 'application/pdf' });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  session.permissions = [];
  session.assignmentId = ASSIGNMENT;
});

// ---------------------------------------------------------------------------------------------------------

describe('exports for the navigation step', () => {
  it('lists each screen with its path, title, menu flag and the permission the API checks', () => {
    expect(HIRING_PIPELINE_SCREENS.map((s) => [s.path, s.title, s.permission, s.nav])).toEqual([
      ['/hiring/tracker', 'Hiring tracker', 'application.read.operational', true],
      ['/hiring/candidates', 'Candidates', 'candidate.read.operational', true],
      ['/hiring/candidates/:id', 'Candidate', 'candidate.read.operational', false],
      ['/hiring/duplicates', 'Duplicate review', 'candidate.read.operational', true],
      ['/hiring/cv-search', 'CV search', 'candidate.read.document', true],
      ['/hiring/vendors', 'Recruitment vendors', 'candidate.read.operational', true],
      ['/hiring/requisitions/:id/applications', 'Requisition applications', 'application.read.operational', false],
      ['/hiring/applications/:id', 'Application', 'application.read.operational', false],
      ['/hiring/offers', 'Offers', 'offer.read.operational', true],
      ['/hiring/offers/:id', 'Offer', 'offer.read.operational', false],
      ['/hiring/employees/:id/origin', 'Hiring origin', 'application.read.operational', false],
    ]);
    for (const s of HIRING_PIPELINE_SCREENS) expect(typeof s.component).toBe('function');
  });

  it('exports the offer approval queue (GET /v1/hiring/offer-tasks) for the Decision inbox, and no My ESS panel', () => {
    expect(HIRING_PIPELINE_TASK_QUEUES.map((q) => [q.permission, q.title])).toEqual([['offer.approve.compensation', 'Offer approvals']]);
    expect(typeof HIRING_PIPELINE_TASK_QUEUES[0]!.component).toBe('function');
    // H3 has no hiring tab (TN01 to TN18).
    expect(HIRING_PIPELINE_ESS_PANELS).toEqual([]);
  });

  it('a detail screen reached with an id that is not a record id asks for nothing', async () => {
    serve({});
    renderAt('/hiring/candidates/not-an-id', RECRUITER);
    expect((await screen.findByText('This candidate is not available in the selected role’s scope.')).textContent).toBeTruthy();
    await settle();
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('tracker (FR-014)', () => {
  const TRACKER = {
    vacancies: [{ ...REQ1, vacancies: 2, targetDate: '2026-12-31', filled: 1, openPlaces: 1, byStage: { SCREENING: 1, APPLIED: 2, HIRED: 1 } }],
    applications: [
      application({ stage: 'SCREENING', pendingAction: 'COMPLETE_SCREENING', ageingDays: 5, owner: person(OTHER_USER, 'Nila Synthetic', 'SYN-7') }),
      application({ id: A2, candidate: RAVI, stage: 'OFFER', pendingAction: 'OFFER_APPROVAL', ageingDays: 1, latestOffer: { id: O1, state: 'SUBMITTED' } }),
    ],
  };

  it('needs the application read duty: not permitted, and nothing is requested', async () => {
    serve({});
    renderAt('/hiring/tracker', ['candidate.read.operational']);
    expect((await screen.findByRole('note')).textContent).toContain('The selected role cannot view the hiring pipeline.');
    await settle();
    expect(calls).toEqual([]);
  });

  it('shows vacancies, candidates by stage, owner, pending action and ageing as returned; filters by owner and closed requisitions', async () => {
    serve({ 'GET /v1/hiring/tracker': [200, TRACKER] });
    renderAt('/hiring/tracker', RECRUITER);
    const vacancies = await screen.findByRole('table', { name: 'Vacancies' });
    expect(callsTo('GET', '/v1/hiring/tracker')[0]!.params.toString()).toBe('');
    const [vacancy] = rows(vacancies);
    expect(cells(vacancy!)).toEqual(['REQ-000001 Synthetic backend engineer', 'Approved', '2', '1', '1', '2026-12-31', 'Applied 2 · Screening 1 · Hired 1', 'Applications']);
    expect(within(vacancy!).getByRole('link', { name: 'Applications for REQ-000001' }).getAttribute('href')).toBe(`/hiring/requisitions/${R1}/applications`);

    const open = screen.getByRole('table', { name: 'Open applications' });
    expect(headers(open)).toEqual(['Candidate', 'Requisition', 'Stage', 'In stage since', 'Ageing', 'Owner', 'Pending action', 'Latest offer', 'Application']);
    expect(cells(rowWith(open, 'Asha Synthetic'))).toEqual([
      'Asha Synthetic CAN-000001',
      'REQ-000001 Synthetic backend engineer',
      'Screening',
      formatDate('2026-10-20T06:00:00.000Z'),
      '5 days',
      'Nila Synthetic, SYN-7',
      'Complete screening',
      '—',
      'Open',
    ]);
    const ravi = rowWith(open, 'Ravi Synthetic');
    expect(cells(ravi).slice(4, 8)).toEqual(['1 day', 'You (Synthetic Recruiter, SYN-9)', 'Offer approval by an independent Admin', 'Waiting for approval']);
    expect(within(ravi).getByRole('link', { name: 'Offer to Ravi Synthetic: Waiting for approval' }).getAttribute('href')).toBe(`/hiring/offers/${O1}`);
    expect(within(ravi).getByRole('link', { name: 'Open the application of Ravi Synthetic (CAN-000002)' }).getAttribute('href')).toBe(`/hiring/applications/${A2}`);

    click(screen.getByLabelText('Only applications I own'));
    await waitFor(() => expect(callsTo('GET', '/v1/hiring/tracker').at(-1)!.params.get('ownerUserId')).toBe(ME));
    click(screen.getByLabelText('Include closed requisitions'));
    await waitFor(() => expect(callsTo('GET', '/v1/hiring/tracker').at(-1)!.params.toString()).toBe(`includeClosed=true&ownerUserId=${ME}`));
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('recruitment vendors (Hiring / Masters / Vendor)', () => {
  it('adds a vendor with the exact body, keeps what was typed after a refusal, then starts the form clean', async () => {
    let attempts = 0;
    serve({
      'GET /v1/hiring/vendors': [200, { items: [VENDOR] }],
      'POST /v1/hiring/vendors': () =>
        attempts++ === 0
          ? [409, { error: 'DUPLICATE', message: 'A record with the same unique value already exists' }]
          : [201, { id: V2, code: 'SYN-TALENT', name: 'Synthetic Talent', active: true, version: 1 }],
    });
    renderAt('/hiring/vendors', RECRUITER);
    const table = await screen.findByRole('table', { name: 'Vendors' });
    expect(cells(rows(table)[0]!).slice(0, 3)).toEqual(['SYN-AGENCY', 'Synthetic Staffing', 'active']);
    const form = screen.getByRole('form', { name: 'Add a vendor' });
    type(within(form).getByLabelText('Code (required)'), ' syn-talent ');
    type(within(form).getByLabelText('Name (required)'), 'Synthetic Talent');
    click(within(form).getByRole('button', { name: 'Add vendor' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('A vendor with this code already exists. Choose another code.');
    expect(valueIn(within(form).getByLabelText('Code (required)'))).toBe(' syn-talent ');
    click(within(form).getByRole('button', { name: 'Add vendor' }));
    expect(await within(form).findByText('Added SYN-TALENT (Synthetic Talent).')).toBeTruthy();
    expect(bodyOf('POST', '/v1/hiring/vendors', 1)).toStrictEqual({ code: 'syn-talent', name: 'Synthetic Talent' });
    expect(valueIn(within(form).getByLabelText('Code (required)'))).toBe('');
    expect(valueIn(within(form).getByLabelText('Name (required)'))).toBe('');
  });

  it('renames and deactivates with the vendor version; inactive vendors only on request', async () => {
    let vendor = { ...VENDOR, version: 4 };
    serve({
      'GET /v1/hiring/vendors': (c) => [200, { items: c.params.get('includeInactive') === 'true' || vendor.active ? [vendor] : [] }],
      [`PATCH /v1/hiring/vendors/${V1}`]: (c) => {
        const body = c.body as { name?: string; active?: boolean };
        vendor = { ...vendor, ...body, version: vendor.version + 1 };
        return [200, vendor];
      },
    });
    renderAt('/hiring/vendors', RECRUITER);
    click(await screen.findByRole('button', { name: 'Rename SYN-AGENCY' }));
    type(screen.getByLabelText('New name for SYN-AGENCY'), ' Synthetic Staffing Partners ');
    click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Renamed SYN-AGENCY to Synthetic Staffing Partners.')).toBeTruthy();
    expect(bodyOf('PATCH', `/v1/hiring/vendors/${V1}`)).toStrictEqual({ name: 'Synthetic Staffing Partners', expectedVersion: 4 });
    await screen.findByText('Synthetic Staffing Partners');
    click(screen.getByRole('button', { name: 'Deactivate SYN-AGENCY' }));
    expect(await screen.findByText('SYN-AGENCY is now inactive.')).toBeTruthy();
    expect(bodyOf('PATCH', `/v1/hiring/vendors/${V1}`, 1)).toStrictEqual({ active: false, expectedVersion: 5 });
    expect(await screen.findByText('No active vendors.')).toBeTruthy();
    click(screen.getByLabelText('Show inactive vendors'));
    const table = await screen.findByRole('table', { name: 'Vendors' });
    expect(cells(rows(table)[0]!).slice(0, 3)).toEqual(['SYN-AGENCY', 'Synthetic Staffing Partners', 'inactive']);
    expect(within(table).getByRole('button', { name: 'Reactivate SYN-AGENCY' })).toBeTruthy();
  });

  it('a rename starts from the vendor’s current name, also after the list was read again', async () => {
    let agency = { ...VENDOR, version: 2 };
    const talent = { id: V2, code: 'SYN-TALENT', name: 'Synthetic Talent', active: true, version: 1 };
    serve({
      'GET /v1/hiring/vendors': () => [200, { items: [agency, talent] }],
      [`PATCH /v1/hiring/vendors/${V2}`]: () => {
        // Meanwhile someone else renamed the other vendor.
        agency = { ...agency, name: 'Synthetic Staffing Partners', version: 3 };
        return [200, { ...talent, active: false, version: 2 }];
      },
    });
    renderAt('/hiring/vendors', RECRUITER);
    click(await screen.findByRole('button', { name: 'Deactivate SYN-TALENT' }));
    expect(await screen.findByText('SYN-TALENT is now inactive.')).toBeTruthy();
    await screen.findByText('Synthetic Staffing Partners');
    click(screen.getByRole('button', { name: 'Rename SYN-AGENCY' }));
    expect(valueIn(screen.getByLabelText('New name for SYN-AGENCY'))).toBe('Synthetic Staffing Partners');
  });

  it('a filtered scope is refused in words; without the manage duty there is no way to change vendors', async () => {
    serve({
      'GET /v1/hiring/vendors': [200, { items: [VENDOR] }],
      [`PATCH /v1/hiring/vendors/${V1}`]: [403, { error: 'FORBIDDEN', message: 'Not permitted' }],
    });
    const view = renderAt('/hiring/vendors', RECRUITER);
    click(await screen.findByRole('button', { name: 'Deactivate SYN-AGENCY' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Vendors are company-wide masters: only a company-wide role without department, location or employee filters can add or change them.',
    );
    view.unmount();
    renderAt('/hiring/vendors', ['candidate.read.operational']);
    await screen.findByRole('table', { name: 'Vendors' });
    expect(screen.queryByRole('button', { name: /Deactivate|Rename/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Add a vendor' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('candidate register (FR-013)', () => {
  const PAGE = (items: Json[]) => [200, { items, total: items.length, page: 1, pageSize: 25 }] as Reply;

  it('searches by code, name or skill and filters by state; registering needs the manage duty', async () => {
    serve({
      'GET /v1/hiring/candidates': PAGE([candidate(), candidate({ id: C3, candidateCode: 'CAN-000003', fullName: 'Meera Synthetic', source: { code: 'VENDOR', label: 'Recruitment vendor' }, vendor: { id: V1, code: 'SYN-AGENCY', name: 'Synthetic Staffing' }, consentStatus: 'NOT_RECORDED', consentRecordedOn: null, retainUntil: '2027-10-24', state: 'DUPLICATE' })]),
    });
    renderAt('/hiring/candidates', ['candidate.read.operational']);
    const table = await screen.findByRole('table', { name: 'Candidate register' });
    expect(callsTo('GET', '/v1/hiring/candidates')[0]!.params.toString()).toBe('page=1&pageSize=25');
    expect(cells(rowWith(table, 'Asha Synthetic'))).toEqual(['CAN-000001', 'Asha Synthetic', 'Direct application', 'Kotlin, SQL', 'Given on 2026-10-01', '—', 'Active']);
    expect(cells(rowWith(table, 'Meera Synthetic'))).toEqual([
      'CAN-000003',
      'Meera Synthetic',
      'Recruitment vendor Synthetic Staffing (SYN-AGENCY)',
      'Kotlin, SQL',
      'Not recorded',
      '2027-10-24',
      'Retired duplicate',
    ]);
    expect(within(table).getByRole('link', { name: 'Asha Synthetic' }).getAttribute('href')).toBe(`/hiring/candidates/${C1}`);
    expect(screen.queryByRole('heading', { name: 'Register a candidate' })).toBeNull();

    type(screen.getByLabelText('Search code, name or skill'), ' kotlin ');
    click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(callsTo('GET', '/v1/hiring/candidates').at(-1)!.params.toString()).toBe('search=kotlin&page=1&pageSize=25'));
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'DUPLICATE' } });
    await waitFor(() => expect(callsTo('GET', '/v1/hiring/candidates').at(-1)!.params.toString()).toBe('search=kotlin&state=DUPLICATE&page=1&pageSize=25'));
  });

  it('registers a candidate who came through a vendor with the exact body, then starts the form clean', async () => {
    serve({
      'GET /v1/hiring/candidates': PAGE([]),
      'GET /v1/hiring/vendors': [200, { items: [VENDOR] }],
      'POST /v1/hiring/candidates': [
        201,
        candidateView({ id: C3, candidateCode: 'CAN-000003', fullName: 'Meera Synthetic', source: { code: 'VENDOR', label: 'Recruitment vendor' }, vendor: { id: V1, code: 'SYN-AGENCY', name: 'Synthetic Staffing' } }),
      ],
    });
    renderAt('/hiring/candidates', RECRUITER);
    const form = await screen.findByRole('form', { name: 'Register a candidate' });
    await settle();
    // The vendors are asked for only once the vendor source is chosen.
    expect(callsTo('GET', '/v1/hiring/vendors')).toHaveLength(0);
    type(within(form).getByLabelText('Full name (required)'), '  Meera Synthetic ');
    fireEvent.change(within(form).getByLabelText('Source'), { target: { value: 'VENDOR' } });
    const vendor = within(form).getByLabelText('Recruitment vendor (required)');
    await waitFor(() => expect(within(vendor).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a vendor…', 'Synthetic Staffing (SYN-AGENCY)']));
    fireEvent.change(vendor, { target: { value: V1 } });
    type(within(form).getByLabelText('Skills (separated by commas)'), 'Python, , SQL ');
    fireEvent.change(within(form).getByLabelText('Consent'), { target: { value: 'GIVEN' } });
    type(within(form).getByLabelText('Consent given on (required)'), '2026-10-24');
    type(within(form).getByLabelText('Retain until (optional)'), '2027-10-24');
    click(within(form).getByRole('button', { name: 'Register candidate' }));
    expect(await within(form).findByText(/Registered CAN-000003\./)).toBeTruthy();
    expect(bodyOf('POST', '/v1/hiring/candidates')).toStrictEqual({
      fullName: 'Meera Synthetic',
      sourceCode: 'VENDOR',
      vendorId: V1,
      skills: ['Python', 'SQL'],
      consentStatus: 'GIVEN',
      consentRecordedOn: '2026-10-24',
      retainUntil: '2027-10-24',
    });
    expect(within(form).getByRole('link', { name: 'Open Meera Synthetic' }).getAttribute('href')).toBe(`/hiring/candidates/${C3}`);
    expect(valueIn(within(form).getByLabelText('Full name (required)'))).toBe('');
    expect(valueIn(within(form).getByLabelText('Source'))).toBe('DIRECT');
    expect(valueIn(within(form).getByLabelText('Consent'))).toBe('NOT_RECORDED');
    expect(within(form).queryByLabelText('Recruitment vendor (required)')).toBeNull();
    expect(within(form).queryByLabelText('Consent given on (required)')).toBeNull();
    // The register is read again after the change.
    await waitFor(() => expect(callsTo('GET', '/v1/hiring/candidates')).toHaveLength(2));
  });

  it('checks required fields before sending, explains refusals in words, keeps what was typed and is disabled while in flight', async () => {
    const answer = held([422, { error: 'CONSENT_DATE_MISMATCH', message: 'Record the consent date exactly when consent is given or withdrawn', details: { field: 'consentRecordedOn' } }]);
    serve({ 'GET /v1/hiring/candidates': PAGE([]), 'POST /v1/hiring/candidates': answer.handler });
    renderAt('/hiring/candidates', RECRUITER);
    const form = await screen.findByRole('form', { name: 'Register a candidate' });
    const submit = within(form).getByRole('button', { name: 'Register candidate' });
    click(submit);
    expect(within(form).getByRole('alert').textContent).toBe('Enter the candidate’s full name.');
    type(within(form).getByLabelText('Full name (required)'), 'Kiran Synthetic');
    fireEvent.change(within(form).getByLabelText('Consent'), { target: { value: 'WITHDRAWN' } });
    click(submit);
    expect(within(form).getByRole('alert').textContent).toBe('Enter the date the consent was given or withdrawn.');
    await settle();
    expect(callsTo('POST', '/v1/hiring/candidates')).toHaveLength(0);
    type(within(form).getByLabelText('Consent withdrawn on (required)'), '2026-10-20');
    click(submit);
    await waitFor(() => expect(disabled(submit)).toBe(true));
    click(submit);
    expect(callsTo('POST', '/v1/hiring/candidates')).toHaveLength(1);
    act(() => answer.release());
    expect((await within(form).findByRole('alert')).textContent).toBe('Give the consent date when consent is given or withdrawn, and no date when consent is not recorded.');
    expect(disabled(submit)).toBe(false);
    expect(valueIn(within(form).getByLabelText('Full name (required)'))).toBe('Kiran Synthetic');
    expect(valueIn(within(form).getByLabelText('Consent withdrawn on (required)'))).toBe('2026-10-20');
  });

  it('the vendor mismatch refusal is shown in words', async () => {
    serve({ 'GET /v1/hiring/candidates': PAGE([]), 'POST /v1/hiring/candidates': [422, { error: 'VENDOR_MISMATCH', message: 'Name the recruitment vendor', details: { field: 'vendorId' } }] });
    renderAt('/hiring/candidates', RECRUITER);
    const form = await screen.findByRole('form', { name: 'Register a candidate' });
    type(within(form).getByLabelText('Full name (required)'), 'Dev Synthetic');
    click(within(form).getByRole('button', { name: 'Register candidate' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('Name the recruitment vendor when the candidate came through a vendor, and only then.');
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('one candidate (FR-013, F1, DF02)', () => {
  const path = `/hiring/candidates/${C1}`;
  const detail = `GET /v1/hiring/candidates/${C1}`;
  const contact = `/v1/hiring/candidates/${C1}/contact`;
  const documents = `/v1/hiring/candidates/${C1}/documents`;

  it('shows the operational record only: no private contact, documents or upload without the confidential grants', async () => {
    serve({
      [detail]: [
        200,
        candidateView({
          contactRecorded: true,
          applications: [{ applicationId: A1, requisitionId: R1, requisitionCode: 'REQ-000001', title: 'Synthetic backend engineer', stage: 'SCREENING', stageEnteredAt: '2026-10-21T06:00:00.000Z' }],
        }),
      ],
    });
    renderAt(path, RECRUITER);
    const summary = await sectionOf('Candidate');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Asha Synthetic (CAN-000001)');
    expect(valueOf(summary, 'Private contact')).toBe('Recorded');
    expect(valueOf(summary, 'Consent')).toBe('Given on 2026-10-01');
    expect(valueOf(summary, 'Retain until')).toBe('No date recorded');
    expect(screen.queryByRole('heading', { name: 'Private contact (confidential)' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'CV and documents (confidential)' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show private contact' })).toBeNull();
    const applications = screen.getByRole('table', { name: 'Applications of CAN-000001' });
    expect(cells(rows(applications)[0]!)).toEqual(['REQ-000001 Synthetic backend engineer', 'Screening', formatDate('2026-10-21T06:00:00.000Z'), 'Open']);
    expect(within(applications).getByRole('link', { name: 'Open the application for REQ-000001' }).getAttribute('href')).toBe(`/hiring/applications/${A1}`);
    await settle();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([detail]);
  });

  it('reads the private contact only when asked (each look is audited) and records a contact; new duplicate flags are flags, never merges', async () => {
    serve({
      [detail]: [200, candidateView({ contactRecorded: true })],
      [`GET ${contact}`]: [200, { candidateId: C1, email: 'asha@example.test', phone: '+91 98765 43210', updatedAt: '2026-10-22T06:00:00.000Z' }],
      [`PUT ${contact}`]: [200, { candidateId: C1, changedFields: ['email'], duplicateFlags: [{ ...FLAG, candidate: ASHA, matchedCandidate: RAVI }] }],
    });
    renderAt(path, [...RECRUITER, ...CONTACT]);
    const section = await sectionOf('Private contact (confidential)');
    await settle();
    expect(callsTo('GET', contact)).toHaveLength(0);
    expect(document.body.textContent).not.toContain('asha@example.test');
    expect(section.textContent).toContain('Each look at the private contact is recorded in the audit trail.');
    click(within(section).getByRole('button', { name: 'Show private contact' }));
    expect(await within(section).findByText('asha@example.test')).toBeTruthy();
    expect(within(section).getByText('+91 98765 43210')).toBeTruthy();
    expect(callsTo('GET', contact)).toHaveLength(1);
    click(within(section).getByRole('button', { name: 'Hide private contact' }));
    expect(within(section).queryByText('asha@example.test')).toBeNull();

    const form = within(section).getByRole('form', { name: 'Record the private contact' });
    type(within(form).getByLabelText('Email address'), ' asha.new@example.test ');
    click(within(form).getByRole('button', { name: 'Save private contact' }));
    expect(await within(form).findByText('Private contact saved: email address changed.')).toBeTruthy();
    expect(bodyOf('PUT', contact)).toStrictEqual({ email: 'asha.new@example.test' });
    expect(within(form).getByRole('list', { name: 'New duplicate flags' }).textContent).toBe('Same private email address as Ravi Synthetic (CAN-000002)');
    expect(within(form).getByText('Flagged for duplicate review (nothing was merged):')).toBeTruthy();
    expect(within(form).getByRole('link', { name: 'Ravi Synthetic' }).getAttribute('href')).toBe(`/hiring/candidates/${C2}`);
    expect(valueIn(within(form).getByLabelText('Email address'))).toBe('');
    // Saving never reads the contact again on its own: the next look is a new, recorded read.
    await settle();
    expect(callsTo('GET', contact)).toHaveLength(1);
  });

  it('removing a recorded value sends null; an invalid phone number is refused in words and kept', async () => {
    let attempt = 0;
    serve({
      [detail]: [200, candidateView({ contactRecorded: true })],
      [`PUT ${contact}`]: () =>
        attempt++ === 0
          ? [422, { error: 'INVALID_FIELD', message: 'The phone number is not valid', details: { field: 'phone' } }]
          : [200, { candidateId: C1, changedFields: ['email'], duplicateFlags: [] }],
    });
    renderAt(path, [...RECRUITER, 'candidate.manage.contact']);
    const form = await screen.findByRole('form', { name: 'Record the private contact' });
    // Recording without reading: no way to look at the contact.
    expect(screen.queryByRole('button', { name: 'Show private contact' })).toBeNull();
    type(within(form).getByLabelText('Phone number'), '1 2');
    click(within(form).getByRole('button', { name: 'Save private contact' }));
    expect((await within(form).findByRole('alert')).textContent).toBe(
      'The phone number is not valid: use 3 to 15 digits; spaces, dashes, dots, brackets and a leading + are allowed.',
    );
    expect(valueIn(within(form).getByLabelText('Phone number'))).toBe('1 2');
    type(within(form).getByLabelText('Phone number'), '');
    click(within(form).getByLabelText('Remove the recorded email address'));
    click(within(form).getByRole('button', { name: 'Save private contact' }));
    expect(await within(form).findByText('Private contact saved: email address changed.')).toBeTruthy();
    expect(bodyOf('PUT', contact, 1)).toStrictEqual({ email: null });
  });

  it('lists CVs with their scan state, offers downloads of released files only, and uploads with the exact body', async () => {
    const downloads = stubDownloads();
    try {
      serve({
        [detail]: [200, candidateView()],
        [`GET ${documents}`]: [200, { items: [doc(D_CLEAN, 'asha-cv.pdf', 'CLEAN'), doc(D_PENDING, 'asha-cv-new.pdf', 'PENDING_SCAN'), doc(D_QUARANTINED, 'asha-bad.pdf', 'QUARANTINED')] }],
        [`GET /v1/hiring/candidate-documents/${D_CLEAN}/content`]: [200, { synthetic: true }],
        [`POST ${documents}`]: [201, { id: '80000000-0000-4000-8000-000000000009', mediaType: 'application/pdf', byteSize: 18, scanState: 'PENDING_SCAN' }],
      });
      renderAt(path, [...RECRUITER, ...DOCUMENTS]);
      const table = await screen.findByRole('table', { name: 'Candidate documents' });
      expect(cells(rowWith(table, 'asha-cv.pdf'))).toEqual(['Curriculum vitae', 'asha-cv.pdf', formatDate('2026-10-23T06:00:00.000Z'), 'released', 'Download']);
      expect(cells(rowWith(table, 'asha-cv-new.pdf')).slice(3)).toEqual(['waiting for the malware scan', 'Available once released']);
      expect(cells(rowWith(table, 'asha-bad.pdf')).slice(3)).toEqual(['quarantined by the malware scan', 'Never available']);
      expect(within(table).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Download asha-cv.pdf']);
      click(within(table).getByRole('button', { name: 'Download asha-cv.pdf' }));
      await waitFor(() => expect(downloads.saved).toHaveBeenCalledOnce());
      expect(callsTo('GET', `/v1/hiring/candidate-documents/${D_CLEAN}/content`)).toHaveLength(1);

      const form = screen.getByRole('form', { name: 'Add a document' });
      fireEvent.change(within(form).getByLabelText('Document type'), { target: { value: 'OTHER' } });
      fireEvent.change(within(form).getByLabelText('File (PDF, JPEG or PNG, up to 10 MB)'), { target: { files: [pdf('asha-cover.pdf')] } });
      click(within(form).getByRole('button', { name: 'Upload' }));
      expect(await within(form).findByText('Uploaded. The file is waiting for the malware scan and can be opened once it is released.')).toBeTruthy();
      expect(bodyOf('POST', documents)).toStrictEqual({ documentType: 'OTHER', fileName: 'asha-cover.pdf', contentBase64: btoa('%PDF-1.4 synthetic') });
      expect(valueIn(within(form).getByLabelText('Document type'))).toBe('CV');
      expect((within(form).getByLabelText('File (PDF, JPEG or PNG, up to 10 MB)') as HTMLInputElement).files?.length ?? 0).toBe(0);
      await waitFor(() => expect(callsTo('GET', documents)).toHaveLength(2));
    } finally {
      downloads.restore();
    }
  });

  it('checks the file before sending and explains an unsupported file in words', async () => {
    serve({ [detail]: [200, candidateView()], [`POST ${documents}`]: [422, { error: 'UNSUPPORTED_FILE', message: 'Only PDF, JPEG and PNG files are accepted' }] });
    renderAt(path, [...RECRUITER, 'candidate.upload.document']);
    const form = await screen.findByRole('form', { name: 'Add a document' });
    // Uploading without the read grant: the list is never asked for.
    expect(screen.getByText('The selected role can add documents to this candidate but not read them.')).toBeTruthy();
    click(within(form).getByRole('button', { name: 'Upload' }));
    expect(within(form).getByRole('alert').textContent).toBe('Choose a file to upload.');
    const big = pdf('huge.pdf');
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    fireEvent.change(within(form).getByLabelText('File (PDF, JPEG or PNG, up to 10 MB)'), { target: { files: [big] } });
    click(within(form).getByRole('button', { name: 'Upload' }));
    expect(within(form).getByRole('alert').textContent).toBe('Files can be at most 10 MB.');
    await settle();
    expect(callsTo('POST', documents)).toHaveLength(0);
    fireEvent.change(within(form).getByLabelText('File (PDF, JPEG or PNG, up to 10 MB)'), { target: { files: [pdf('notes.pdf')] } });
    click(within(form).getByRole('button', { name: 'Upload' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('Only PDF, JPEG and PNG files are accepted.');
    expect(callsTo('GET', documents)).toHaveLength(0);
  });

  it('FR-013 approves typed searchable text only with the upload grant and says CONSENT_REQUIRED in plain words', async () => {
    const searchable = `/v1/hiring/candidate-documents/${D_CLEAN}/searchable-text`;
    const X1 = '92000000-0000-4000-8000-000000000001';
    const X2 = '92000000-0000-4000-8000-000000000002';
    const nila = person(OTHER_USER, 'Nila Synthetic', 'SYN-7');
    const approvedText = {
      candidateDocumentId: D_CLEAN,
      candidateId: C1,
      consentStatus: 'GIVEN',
      searchable: true,
      approved: { id: X1, source: 'TRANSCRIBED', content: 'Synthetic CV: Kotlin, SQL', approvedAt: '2026-11-02T06:00:00.000Z', approvedBy: OTHER_USER, approvedByPerson: nila },
      history: [{ id: X1, state: 'APPROVED', source: 'TRANSCRIBED', approvedAt: '2026-11-02T06:00:00.000Z', approvedBy: OTHER_USER, approvedByPerson: nila, revokedAt: null, revocationReason: null }],
    };
    let attempt = 0;
    serve({
      [detail]: [200, candidateView()],
      [`GET ${documents}`]: [200, { items: [doc(D_CLEAN, 'asha-cv.pdf', 'CLEAN'), { ...doc(D_PENDING, 'asha-cover.pdf', 'CLEAN'), documentType: 'OTHER' }] }],
      [`GET ${searchable}`]: [200, approvedText],
      [`POST ${searchable}`]: () => {
        attempt += 1;
        if (attempt === 1) return [422, { error: 'EXTRACTION_NOT_CONFIGURED', message: 'No text-extraction component is configured', details: { mediaType: 'application/pdf' } }];
        if (attempt === 2) return [409, { error: 'CONSENT_REQUIRED', message: 'Consent must be given', details: { consentStatus: 'WITHDRAWN' } }];
        return [201, { id: X2, candidateDocumentId: D_CLEAN, candidateId: C1, source: 'TRANSCRIBED', state: 'APPROVED', length: 34, replacedCvTextId: X1 }];
      },
    });

    // The read grant alone: the status and the text on request, and no way to approve or revoke.
    const view = renderAt(path, [...RECRUITER, 'candidate.read.document']);
    const region = await screen.findByRole('region', { name: 'Searchable text of asha-cv.pdf' });
    // Only a CV has searchable text.
    expect(screen.queryByRole('region', { name: 'Searchable text of asha-cover.pdf' })).toBeNull();
    expect(within(region).queryByRole('form', { name: 'Approve searchable text of asha-cv.pdf' })).toBeNull();
    expect(within(region).queryByRole('form', { name: 'Revoke searchable text of asha-cv.pdf' })).toBeNull();
    await settle();
    // Each read of an approved text is audited: nothing is read until asked.
    expect(callsTo('GET', searchable)).toHaveLength(0);
    click(within(region).getByRole('button', { name: 'Show searchable text' }));
    expect(await within(region).findByText('Synthetic CV: Kotlin, SQL')).toBeTruthy();
    const status = within(region).getByLabelText('Status of the searchable text of asha-cv.pdf');
    expect(valueOf(status, 'Searchable now')).toBe('Yes: the CV search matches this approved text');
    expect(valueOf(status, 'Candidate consent')).toBe('Given');
    expect(valueOf(status, 'Approved')).toBe(`${formatDate('2026-11-02T06:00:00.000Z')} by Nila Synthetic, SYN-7`);
    expect(valueOf(status, 'Source')).toBe('Typed or pasted by an Admin from the released CV');
    click(within(region).getByRole('button', { name: 'Hide searchable text' }));
    expect(within(region).queryByText('Synthetic CV: Kotlin, SQL')).toBeNull();
    expect(callsTo('GET', searchable)).toHaveLength(1);
    view.unmount();

    // With the upload grant: an empty submit asks the server to extract, which is not configured; then typed text.
    renderAt(path, [...RECRUITER, ...DOCUMENTS]);
    const form = await screen.findByRole('form', { name: 'Approve searchable text of asha-cv.pdf' });
    click(within(form).getByRole('button', { name: 'Approve as searchable text' }));
    expect((await within(form).findByRole('alert')).textContent).toBe(
      'No text extraction is configured for this kind of file, so nothing was approved. Type or paste the CV’s text and approve that.',
    );
    expect(bodyOf('POST', searchable, 0)).toStrictEqual({});
    const text = within(form).getByLabelText('Text of the CV, typed or pasted from the released file');
    type(text, 'Synthetic CV: Kotlin, SQL, Postgres');
    await waitFor(() => expect(disabled(within(form).getByRole('button', { name: 'Approve as searchable text' }))).toBe(false));
    click(within(form).getByRole('button', { name: 'Approve as searchable text' }));
    await waitFor(() =>
      expect(within(form).getByRole('alert').textContent).toBe(
        'The candidate’s consent is withdrawn. Nothing of a candidate becomes searchable until the candidate’s consent is recorded as given.',
      ),
    );
    expect(valueIn(text)).toBe('Synthetic CV: Kotlin, SQL, Postgres');
    await waitFor(() => expect(disabled(within(form).getByRole('button', { name: 'Approve as searchable text' }))).toBe(false));
    click(within(form).getByRole('button', { name: 'Approve as searchable text' }));
    const upload = await screen.findByRole('region', { name: 'Searchable text of asha-cv.pdf' });
    expect(
      (await within(upload).findByText('Approved as the searchable text of asha-cv.pdf (34 characters); the text approved before it is revoked. The CV search matches it and never shows it.'))
        .textContent,
    ).toBeTruthy();
    expect(callsTo('POST', searchable).map((c) => c.body)).toStrictEqual([{}, { content: 'Synthetic CV: Kotlin, SQL, Postgres' }, { content: 'Synthetic CV: Kotlin, SQL, Postgres' }]);
    expect(valueIn(text)).toBe('');
    // Approving reads nothing back: the next look is a new, recorded read.
    expect(callsTo('GET', searchable)).toHaveLength(1);
  });

  it('saves only the changed fields with the record version', async () => {
    let current = candidateView({ version: 3 });
    serve({
      [detail]: () => [200, current],
      [`PATCH /v1/hiring/candidates/${C1}`]: (c) => {
        const { expectedVersion: _v, ...patch } = c.body as Json;
        current = { ...current, ...patch, version: 4 };
        return [200, current];
      },
    });
    renderAt(path, RECRUITER);
    const form = await screen.findByRole('form', { name: 'Change the candidate' });
    expect(valueIn(within(form).getByLabelText('Full name (required)'))).toBe('Asha Synthetic');
    expect(valueIn(within(form).getByLabelText('Skills (separated by commas)'))).toBe('Kotlin, SQL');
    click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(within(form).getByRole('alert').textContent).toBe('Nothing has changed yet.');
    type(within(form).getByLabelText('Retain until (optional)'), '2027-12-31');
    fireEvent.change(within(form).getByLabelText('Record state'), { target: { value: 'INACTIVE' } });
    click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await within(form).findByText('Candidate saved.')).toBeTruthy();
    expect(bodyOf('PATCH', `/v1/hiring/candidates/${C1}`)).toStrictEqual({ retainUntil: '2027-12-31', state: 'INACTIVE', expectedVersion: 3 });
    const summary = await sectionOf('Candidate');
    await waitFor(() => expect(valueOf(summary, 'State')).toBe('Inactive'));
    expect(valueIn(within(form).getByLabelText('Record state'))).toBe('INACTIVE');
  });

  it('applies the candidate to another approved requisition; an existing application is marked, never repeated', async () => {
    serve({
      [detail]: [
        200,
        candidateView({ applications: [{ applicationId: A1, requisitionId: R1, requisitionCode: 'REQ-000001', title: 'Synthetic backend engineer', stage: 'REJECTED', stageEnteredAt: '2026-10-21T06:00:00.000Z' }] }),
      ],
      'GET /v1/hiring/requisitions': [200, { items: [{ ...REQ1, vacancies: 2, targetDate: '2026-12-31', filled: 0 }, { ...REQ2, vacancies: 1, targetDate: '2027-01-31', filled: 0 }], total: 2 }],
      [`POST /v1/hiring/requisitions/${R2}/applications`]: [201, applicationView({ id: A3, requisition: REQ2 })],
    });
    renderAt(path, RECRUITER);
    click(await screen.findByRole('button', { name: 'Search requisitions' }));
    const table = await screen.findByRole('table', { name: 'Approved requisitions' });
    expect(callsTo('GET', '/v1/hiring/requisitions')[0]!.params.toString()).toBe('state=APPROVED&page=1&pageSize=25');
    expect(cells(rowWith(table, 'REQ-000001'))[3]).toBe('Already applied');
    click(within(table).getByRole('button', { name: 'Apply to REQ-000002' }));
    expect(await screen.findByText(/Application created for REQ-000002 at the applied stage\./)).toBeTruthy();
    expect(bodyOf('POST', `/v1/hiring/requisitions/${R2}/applications`)).toStrictEqual({ candidateId: C1 });
    expect(screen.getByRole('link', { name: 'Open the application' }).getAttribute('href')).toBe(`/hiring/applications/${A3}`);
  });

  it('a requisition that stopped being approved is refused in words, and the candidate and the search are read again', async () => {
    let approved: Json[] = [{ ...REQ2, vacancies: 1, targetDate: '2027-01-31', filled: 0 }];
    serve({
      [detail]: [200, candidateView()],
      'GET /v1/hiring/requisitions': () => [200, { items: approved, total: approved.length }],
      [`POST /v1/hiring/requisitions/${R2}/applications`]: () => {
        // The requisition was closed a moment earlier.
        approved = [];
        return [409, { error: 'REQUISITION_NOT_APPROVED', message: 'Candidates apply only to an approved requisition' }];
      },
    });
    renderAt(path, RECRUITER);
    click(await screen.findByRole('button', { name: 'Search requisitions' }));
    const table = await screen.findByRole('table', { name: 'Approved requisitions' });
    click(within(table).getByRole('button', { name: 'Apply to REQ-000002' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Candidates apply only to an approved requisition.');
    expect(await screen.findByText('No approved requisitions match.')).toBeTruthy();
    expect(callsTo('GET', '/v1/hiring/requisitions')).toHaveLength(2);
    expect(callsTo('GET', `/v1/hiring/candidates/${C1}`)).toHaveLength(2);
    expect(callsTo('POST', `/v1/hiring/requisitions/${R2}/applications`)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('duplicate review (FR-013: flagged for review, never merged)', () => {
  it('records a confirmed duplicate with the record to retire and a note; nothing is merged', async () => {
    let flags: Json[] = [FLAG];
    serve({
      'GET /v1/hiring/duplicate-flags': (c) => [200, { items: c.params.get('state') === 'OPEN' ? flags.filter((f) => f.state === 'OPEN') : flags }],
      [`POST /v1/hiring/duplicate-flags/${F1}/resolve`]: () => {
        flags = [{ ...FLAG, state: 'CONFIRMED_DUPLICATE', retiredCandidateId: C2, resolutionNote: 'Synthetic: same person', resolvedAt: '2026-10-25T06:00:00.000Z' }];
        return [200, { flagId: F1, state: 'CONFIRMED_DUPLICATE', retiredCandidateId: C2 }];
      },
    });
    renderAt('/hiring/duplicates', RECRUITER);
    const item = await screen.findByRole('listitem', { name: 'CAN-000002 and CAN-000001: same private email address' });
    expect(callsTo('GET', '/v1/hiring/duplicate-flags')[0]!.params.toString()).toBe('state=OPEN');
    expect(valueOf(item, 'Record')).toBe('Ravi Synthetic CAN-000002 Active');
    expect(valueOf(item, 'Matching record')).toBe('Asha Synthetic CAN-000001 Active');
    expect(valueOf(item, 'Review')).toBe('Waiting for review');
    const form = within(item).getByRole('form', { name: 'Review CAN-000002 and CAN-000001' });
    const record = within(form).getByRole('button', { name: 'Record review' });
    click(record);
    expect(within(form).getByRole('alert').textContent).toBe('Choose whether the two records are the same person.');
    click(within(form).getByLabelText('Yes, the same person'));
    click(record);
    expect(within(form).getByRole('alert').textContent).toBe('Choose which of the two records is the duplicate to retire.');
    click(within(form).getByLabelText('Retire CAN-000002 (Ravi Synthetic)'));
    click(record);
    expect(within(form).getByRole('alert').textContent).toBe('Enter a note on the review.');
    await settle();
    expect(callsTo('POST', `/v1/hiring/duplicate-flags/${F1}/resolve`)).toHaveLength(0);
    type(within(form).getByLabelText('Review note (required)'), ' Synthetic: same person ');
    click(record);
    expect(await screen.findByText('Confirmed CAN-000002 and CAN-000001 as the same person: CAN-000002 is retired; nothing was merged.')).toBeTruthy();
    expect(bodyOf('POST', `/v1/hiring/duplicate-flags/${F1}/resolve`)).toStrictEqual({ resolution: 'CONFIRMED_DUPLICATE', retireCandidateId: C2, note: 'Synthetic: same person' });
    expect(await screen.findByText('No flags are waiting for review.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'CONFIRMED_DUPLICATE' } });
    const reviewed = await screen.findByRole('listitem', { name: 'CAN-000002 and CAN-000001: same private email address' });
    expect(valueOf(reviewed, 'Review')).toBe('Confirmed duplicate');
    expect(valueOf(reviewed, 'Retired record')).toBe('CAN-000002');
    expect(valueOf(reviewed, 'Review note')).toBe('Synthetic: same person');
    expect(within(reviewed).queryByRole('form')).toBeNull();
  });

  it('a flag reviewed meanwhile is refused in words; without the manage duty flags are shown without a review form', async () => {
    serve({
      'GET /v1/hiring/duplicate-flags': [200, { items: [FLAG] }],
      [`POST /v1/hiring/duplicate-flags/${F1}/resolve`]: [409, { error: 'INVALID_STATE', message: 'This flag has already been reviewed' }],
    });
    const view = renderAt('/hiring/duplicates', RECRUITER);
    const item = await screen.findByRole('listitem', { name: 'CAN-000002 and CAN-000001: same private email address' });
    click(within(item).getByLabelText('No, different people'));
    type(within(item).getByLabelText('Review note (required)'), 'Synthetic: shared family mailbox');
    click(within(item).getByRole('button', { name: 'Record review' }));
    expect((await within(item).findByRole('alert')).textContent).toBe('This flag has already been reviewed.');
    expect(bodyOf('POST', `/v1/hiring/duplicate-flags/${F1}/resolve`)).toStrictEqual({ resolution: 'NOT_DUPLICATE', note: 'Synthetic: shared family mailbox' });
    view.unmount();
    renderAt('/hiring/duplicates', ['candidate.read.operational']);
    const readOnly = await screen.findByRole('listitem', { name: 'CAN-000002 and CAN-000001: same private email address' });
    expect(within(readOnly).queryByRole('form')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('CV search (FR-013)', () => {
  it('needs the candidate document grant: not permitted, and nothing is requested', async () => {
    serve({});
    renderAt('/hiring/cv-search', RECRUITER);
    expect((await screen.findByRole('note')).textContent).toContain('CVs are confidential: the selected role holds no candidate document grant.');
    await settle();
    expect(calls).toEqual([]);
  });

  it('searches CV metadata and offers released files only; a refused download is explained in words', async () => {
    serve({
      'GET /v1/hiring/candidate-documents': [200, { items: [doc(D_CLEAN, 'asha-cv.pdf', 'CLEAN'), doc(D_PENDING, 'ravi-cv.pdf', 'PENDING_SCAN', C2)] }],
      [`GET /v1/hiring/candidate-documents/${D_CLEAN}/content`]: [409, { error: 'FILE_NOT_RELEASED', message: 'Not released', details: { scanState: 'QUARANTINED' } }],
    });
    renderAt('/hiring/cv-search', ['candidate.read.operational', 'candidate.read.document']);
    click(await screen.findByRole('button', { name: 'Search' }));
    expect(screen.getByRole('alert').textContent).toBe('Enter a file name, document type, candidate code or words from a CV.');
    type(screen.getByLabelText('File name, document type, candidate code or CV text'), ' cv ');
    click(screen.getByRole('button', { name: 'Search' }));
    const table = await screen.findByRole('table', { name: 'Matching documents' });
    expect(callsTo('GET', '/v1/hiring/candidate-documents')[0]!.params.get('search')).toBe('cv');
    expect(headers(table)).toEqual(['Candidate', 'Type', 'File', 'Uploaded', 'Malware scan', 'Approved CV text', 'Download']);
    expect(within(rowWith(table, 'ravi-cv.pdf')).queryByRole('button')).toBeNull();
    expect(within(table).getByRole('link', { name: 'CAN-000002' }).getAttribute('href')).toBe(`/hiring/candidates/${C2}`);
    click(within(table).getByRole('button', { name: 'Download asha-cv.pdf' }));
    expect((await screen.findByRole('alert')).textContent).toBe('This file was quarantined by the malware scan and can never be opened.');
  });

  it('FR-013 shows a content match without showing any text', async () => {
    serve({
      'GET /v1/hiring/candidate-documents': [
        200,
        {
          items: [
            // A field the API never sends, to show that nothing of a CV's text would be put on the page.
            { ...doc(D_CLEAN, 'asha-cv.pdf', 'CLEAN'), contentMatch: true, content: 'Synthetic CV text: Kotlin and SQL' },
            { ...doc(D_PENDING, 'kotlin-cv.pdf', 'PENDING_SCAN', C2), contentMatch: false },
          ],
        },
      ],
    });
    renderAt('/hiring/cv-search', ['candidate.read.operational', 'candidate.read.document']);
    const search = await sectionOf('Search CVs');
    expect(search.textContent).toContain('The search covers the file name, the document type, the candidate code and the approved searchable text of CVs.');
    expect(search.textContent).toContain('a match in it is marked, and the text itself is never shown here.');
    type(screen.getByLabelText('File name, document type, candidate code or CV text'), 'kotlin');
    click(screen.getByRole('button', { name: 'Search' }));
    const table = await screen.findByRole('table', { name: 'Matching documents' });
    expect(callsTo('GET', '/v1/hiring/candidate-documents')[0]!.params.get('search')).toBe('kotlin');
    expect(cells(rowWith(table, 'asha-cv.pdf'))[5]).toBe('matched in approved CV text');
    expect(cells(rowWith(table, 'kotlin-cv.pdf'))[5]).toBe('—');
    expect(document.body.textContent).not.toContain('Kotlin and SQL');
    // The search reads no approved text: that is read only on a candidate's record, when asked for.
    await settle();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/hiring/candidate-documents']);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('applications of a requisition (DB062: one per candidate and requisition)', () => {
  const path = `/hiring/requisitions/${R1}/applications`;
  const requisition = { ...REQ1, vacancies: 2, targetDate: '2026-12-31', filled: 0, department: { id: 'd1', name: 'Engineering' }, hiringManager: { id: 'e9', employeeCode: 'SYN-1', displayName: 'Manager Synthetic' } };

  it('lists the applications and adds an active candidate with the exact body; an existing applicant is marked', async () => {
    let attempt = 0;
    serve({
      [`GET /v1/hiring/requisitions/${R1}`]: [200, requisition],
      'GET /v1/hiring/applications': [200, { items: [application()] }],
      'GET /v1/hiring/candidates': [200, { items: [candidate(), candidate({ id: C2, candidateCode: 'CAN-000002', fullName: 'Ravi Synthetic', skills: [] })], total: 2, page: 1, pageSize: 25 }],
      [`POST /v1/hiring/requisitions/${R1}/applications`]: () =>
        attempt++ === 0
          ? [409, { error: 'ALREADY_APPLIED', message: 'This candidate already has an application for this requisition' }]
          : [201, applicationView({ id: A2, candidate: RAVI })],
    });
    renderAt(path, RECRUITER);
    expect((await screen.findByRole('heading', { level: 1, name: 'Applications for REQ-000001' })).textContent).toBeTruthy();
    expect(callsTo('GET', '/v1/hiring/applications')[0]!.params.get('requisitionId')).toBe(R1);
    const summary = await sectionOf('Requisition');
    expect(valueOf(summary, 'Hiring manager')).toBe('Manager Synthetic SYN-1');
    // The requisition itself is hiring part 1's screen.
    expect(within(summary).getByRole('link', { name: 'Open requisition REQ-000001' }).getAttribute('href')).toBe(`/hiring/requisitions/${R1}`);
    const table = await screen.findByRole('table', { name: 'Applications' });
    expect(cells(rows(table)[0]!)).toEqual(['Asha Synthetic CAN-000001', 'Applied', formatDate('2026-10-20T06:00:00.000Z'), '3 days', 'You (Synthetic Recruiter, SYN-9)', 'Start screening', '—', 'Open']);

    type(screen.getByLabelText('Find an active candidate'), 'synthetic');
    click(screen.getByRole('button', { name: 'Search candidates' }));
    const hits = await screen.findByRole('table', { name: 'Active candidates' });
    expect(callsTo('GET', '/v1/hiring/candidates')[0]!.params.toString()).toBe('search=synthetic&state=ACTIVE&page=1&pageSize=25');
    expect(cells(rowWith(hits, 'Asha Synthetic'))[2]).toBe('Already applied');
    click(within(hits).getByRole('button', { name: 'Add Ravi Synthetic (CAN-000002) to this requisition' }));
    expect((await screen.findByRole('alert')).textContent).toBe('This candidate already has an application for this requisition.');
    click(within(hits).getByRole('button', { name: 'Add Ravi Synthetic (CAN-000002) to this requisition' }));
    expect(await screen.findByText(/Ravi Synthetic \(CAN-000002\) now has an application at the applied stage\./)).toBeTruthy();
    expect(bodyOf('POST', `/v1/hiring/requisitions/${R1}/applications`, 1)).toStrictEqual({ candidateId: C2 });
    expect(screen.getByRole('link', { name: 'Open the application' }).getAttribute('href')).toBe(`/hiring/applications/${A2}`);
  });

  it('a candidate added meanwhile by someone else is refused in words, and the lists are read again to mark the applicant', async () => {
    let applied = [application()];
    serve({
      [`GET /v1/hiring/requisitions/${R1}`]: [200, requisition],
      'GET /v1/hiring/applications': () => [200, { items: applied }],
      'GET /v1/hiring/candidates': [200, { items: [candidate({ id: C2, candidateCode: 'CAN-000002', fullName: 'Ravi Synthetic', skills: [] })], total: 1, page: 1, pageSize: 25 }],
      [`POST /v1/hiring/requisitions/${R1}/applications`]: () => {
        // Another recruiter added the same candidate a moment earlier.
        applied = [application(), application({ id: A2, candidate: RAVI })];
        return [409, { error: 'ALREADY_APPLIED', message: 'This candidate already has an application for this requisition' }];
      },
    });
    renderAt(path, RECRUITER);
    await screen.findByRole('table', { name: 'Applications' });
    click(screen.getByRole('button', { name: 'Search candidates' }));
    const hits = await screen.findByRole('table', { name: 'Active candidates' });
    click(within(hits).getByRole('button', { name: 'Add Ravi Synthetic (CAN-000002) to this requisition' }));
    expect((await screen.findByRole('alert')).textContent).toBe('This candidate already has an application for this requisition.');
    await waitFor(() => expect(cells(rowWith(hits, 'Ravi Synthetic'))[2]).toBe('Already applied'));
    expect(within(hits).queryByRole('button')).toBeNull();
    expect(callsTo('GET', '/v1/hiring/applications')).toHaveLength(2);
    expect(callsTo('POST', `/v1/hiring/requisitions/${R1}/applications`)).toHaveLength(1);
  });

  it('a requisition that is not approved takes no new candidates', async () => {
    serve({
      [`GET /v1/hiring/requisitions/${R1}`]: [200, { ...requisition, state: 'CLOSED' }],
      'GET /v1/hiring/applications': [200, { items: [] }],
    });
    renderAt(path, RECRUITER);
    expect(await screen.findByText('Candidates apply only to an approved requisition; this one is closed.')).toBeTruthy();
    expect(screen.queryByLabelText('Find an active candidate')).toBeNull();
    expect(screen.getByText('No candidates have applied to this requisition yet.')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('one application (F1 stages)', () => {
  const path = `/hiring/applications/${A1}`;
  const stage = `/v1/hiring/applications/${A1}/stage`;

  it('moves one stage forward with the application version; the API refusal is shown in words', async () => {
    let current = applicationView({ version: 2 });
    let attempt = 0;
    serve({
      [`GET /v1/hiring/applications/${A1}`]: () => [200, current],
      [`POST ${stage}`]: () => {
        if (attempt++ === 0) return [409, { error: 'INVALID_TRANSITION', message: 'An application moves from APPLIED to SCREENING only' }];
        current = { ...current, stage: 'SCREENING', pendingAction: 'COMPLETE_SCREENING', version: 3 };
        return [200, { applicationId: A1, stage: 'SCREENING', version: 3 }];
      },
    });
    renderAt(path, RECRUITER);
    const section = await sectionOf('Stage');
    // HIRED is never a move: it comes only with the handover of an accepted offer.
    expect(within(section).queryByRole('button', { name: /hired/i })).toBeNull();
    const forward = within(section).getByRole('form', { name: 'Move forward' });
    type(within(forward).getByLabelText('Note on the move (optional)'), ' Synthetic: relevant CV ');
    click(within(forward).getByRole('button', { name: 'Move to screening' }));
    expect((await within(section).findByRole('alert')).textContent).toBe('An application moves one stage forward at a time.');
    expect(bodyOf('POST', stage)).toStrictEqual({ toStage: 'SCREENING', note: 'Synthetic: relevant CV', expectedVersion: 2 });
    // The conflict reloaded the application; the next attempt carries its current version.
    await waitFor(() => expect(callsTo('GET', `/v1/hiring/applications/${A1}`)).toHaveLength(2));
    await waitFor(() => expect(disabled(within(forward).getByRole('button', { name: 'Move to screening' }))).toBe(false));
    click(within(forward).getByRole('button', { name: 'Move to screening' }));
    expect(await within(section).findByText('The application is now at the screening stage.')).toBeTruthy();
    expect(bodyOf('POST', stage, 1)).toStrictEqual({ toStage: 'SCREENING', note: 'Synthetic: relevant CV', expectedVersion: 2 });
    expect(await within(section).findByRole('button', { name: 'Move to interview' })).toBeTruthy();
    expect(valueIn(within(section).getByLabelText('Note on the move (optional)'))).toBe('');
  });

  it('ends this application only, with a required note; an open offer is explained in words', async () => {
    let current = applicationView({ stage: 'INTERVIEW', version: 4 });
    let attempt = 0;
    serve({
      [`GET /v1/hiring/applications/${A1}`]: () => [200, current],
      [`POST ${stage}`]: () => {
        if (attempt++ === 0) return [409, { error: 'OFFER_OPEN', message: 'Withdraw the open offer before ending the application' }];
        current = { ...current, stage: 'REJECTED', pendingAction: null, version: 5 };
        return [200, { applicationId: A1, stage: 'REJECTED', version: 5 }];
      },
    });
    renderAt(path, RECRUITER);
    const end = await screen.findByRole('form', { name: 'End the application' });
    expect(end.textContent).toContain('This ends this application only: the candidate record and the candidate’s applications to other requisitions stay as they are.');
    click(within(end).getByRole('button', { name: 'End the application' }));
    expect(within(end).getByRole('alert').textContent).toBe('Choose how the application ends.');
    click(within(end).getByLabelText('Rejected'));
    click(within(end).getByRole('button', { name: 'End the application' }));
    expect(within(end).getByRole('alert').textContent).toBe('Record why the application ends.');
    await settle();
    expect(callsTo('POST', stage)).toHaveLength(0);
    type(within(end).getByLabelText('Why the application ends (required)'), 'Synthetic: interview outcome');
    click(within(end).getByRole('button', { name: 'End the application' }));
    const section = await sectionOf('Stage');
    expect((await within(section).findByRole('alert')).textContent).toBe('This application has an open offer. Withdraw the offer before ending the application.');
    expect(valueIn(within(end).getByLabelText('Why the application ends (required)'))).toBe('Synthetic: interview outcome');
    await waitFor(() => expect(disabled(within(end).getByRole('button', { name: 'End the application' }))).toBe(false));
    click(within(end).getByRole('button', { name: 'End the application' }));
    expect(await screen.findByText('The application was rejected. The candidate record and the candidate’s other applications are unchanged.')).toBeTruthy();
    expect(bodyOf('POST', stage, 1)).toStrictEqual({ toStage: 'REJECTED', note: 'Synthetic: interview outcome', expectedVersion: 4 });
    expect(await screen.findByText('This application has ended (rejected); its stage no longer changes.')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'End the application' })).toBeNull();
  });

  it('a requisition no longer approved stops forward moves and new offers, while the application can still be ended', async () => {
    const closed = { ...REQ1, state: 'CLOSED' };
    serve({
      [`GET /v1/hiring/applications/${A1}`]: [200, applicationView({ stage: 'INTERVIEW', requisition: closed })],
      [`GET /v1/hiring/applications/${A2}`]: [200, applicationView({ id: A2, candidate: RAVI, stage: 'OFFER', requisition: closed })],
    });
    const view = renderAt(path, RECRUITER);
    const section = await sectionOf('Stage');
    expect(section.textContent).toContain('The requisition is no longer approved, so the application cannot move forward. It can still be ended.');
    expect(within(section).queryByRole('form', { name: 'Move forward' })).toBeNull();
    expect(within(section).getByRole('form', { name: 'End the application' })).toBeTruthy();
    view.unmount();
    renderAt(`/hiring/applications/${A2}`, RECRUITER);
    const offers = await sectionOf('Offers (0)');
    expect(offers.textContent).toContain('An offer needs an approved requisition and an active candidate record.');
    expect(screen.queryByRole('form', { name: 'Prepare an offer' })).toBeNull();
  });

  it('without the manage duty: the record and its history, but no stage, owner or offer actions', async () => {
    serve({ [`GET /v1/hiring/applications/${A1}`]: [200, applicationView({ owner: person(OTHER_USER, null, null) })] });
    renderAt(path, ['application.read.operational', 'candidate.read.operational']);
    const summary = await sectionOf('Application');
    expect(valueOf(summary, 'Owner')).toBe('A user without an employee record');
    expect(screen.queryByRole('heading', { name: 'Stage' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Assign to me' })).toBeNull();
    const history = screen.getByRole('table', { name: 'Stage history' });
    expect(cells(rows(history)[0]!)).toEqual(['—', 'Applied', '—', 'You', formatDate('2026-10-20T06:00:00.000Z')]);
  });

  it('assigns the application to the signed-in user with its version', async () => {
    let current = applicationView({ owner: person(OTHER_USER, 'Nila Synthetic', 'SYN-7'), version: 6 });
    serve({
      [`GET /v1/hiring/applications/${A1}`]: () => [200, current],
      [`PUT /v1/hiring/applications/${A1}/owner`]: () => {
        current = { ...current, owner: person(ME, 'Synthetic Recruiter', 'SYN-9'), version: 7 };
        return [200, { applicationId: A1, ownerUserId: ME, version: 7 }];
      },
    });
    renderAt(path, RECRUITER);
    click(await screen.findByRole('button', { name: 'Assign to me' }));
    expect(await screen.findByText('You now own this application.')).toBeTruthy();
    expect(bodyOf('PUT', `/v1/hiring/applications/${A1}/owner`)).toStrictEqual({ ownerUserId: ME, expectedVersion: 6 });
    expect(valueOf(await sectionOf('Application'), 'Owner')).toBe('You (Synthetic Recruiter, SYN-9)');
    expect(screen.queryByRole('button', { name: 'Assign to me' })).toBeNull();
  });

  it('prepares a draft offer at the offer stage with the exact body and links to it', async () => {
    let current = applicationView({ id: A2, candidate: RAVI, stage: 'OFFER', pendingAction: 'PREPARE_OFFER', version: 4 });
    serve({
      [`GET /v1/hiring/applications/${A2}`]: () => [200, current],
      [`POST /v1/hiring/applications/${A2}/offers`]: (c) => {
        current = { ...current, pendingAction: 'COMPLETE_OFFER', offers: [{ id: O1, state: 'DRAFT', proposedJoiningDate: '2026-12-01', currentRevision: 0, createdAt: '2026-10-25T06:00:00.000Z' }] };
        return [201, offerView({ proposedJoiningDate: (c.body as Json).proposedJoiningDate })];
      },
    });
    renderAt(`/hiring/applications/${A2}`, RECRUITER);
    const stageSection = await sectionOf('Stage');
    expect(stageSection.textContent).toContain('At the offer stage the application becomes hired only through the handover of its accepted offer.');
    const form = screen.getByRole('form', { name: 'Prepare an offer' });
    click(within(form).getByRole('button', { name: 'Prepare draft offer' }));
    expect(within(form).getByRole('alert').textContent).toBe('Enter the proposed joining date.');
    type(within(form).getByLabelText('Proposed joining date (required)'), '2026-12-01');
    click(within(form).getByRole('button', { name: 'Prepare draft offer' }));
    expect(await screen.findByText(/Draft offer prepared\./)).toBeTruthy();
    expect(bodyOf('POST', `/v1/hiring/applications/${A2}/offers`)).toStrictEqual({ proposedJoiningDate: '2026-12-01' });
    expect(screen.getByRole('link', { name: 'Open the draft offer' }).getAttribute('href')).toBe(`/hiring/offers/${O1}`);
    // One open offer at a time: the form goes once the draft is listed.
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Prepare an offer' })).toBeNull());
    const offers = screen.getByRole('table', { name: 'Offers of the application' });
    expect(cells(rows(offers)[0]!).slice(0, 3)).toEqual(['Draft', '2026-12-01', 'Not submitted']);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('offers (F1: approved requisition, confidential compensation, independent approval)', () => {
  const path = `/hiring/offers/${O1}`;
  const detail = `GET /v1/hiring/offers/${O1}`;
  const COMPENSATION_VIEW = {
    current: { currencyCode: 'INR', annualCtc: '1234567.5000', monthlyGross: '98765.4321', setBy: ME, updatedAt: '2026-10-23T06:00:00.000Z' },
    revisions: [
      {
        revision: 1,
        proposedJoiningDate: '2026-12-01',
        currencyCode: 'INR',
        annualCtc: '1200000.0000',
        monthlyGross: null,
        compensationSetBy: ME,
        submittedBy: OTHER_USER,
        submittedAt: '2026-10-23T07:00:00.000Z',
      },
    ],
  };
  const decisions = (withReasons: boolean) => [
    { revision: 1, step: 1, action: 'approve', decision: 'RETURN', ...(withReasons ? { reason: 'Synthetic: check the band' } : {}), decidedAt: '2026-10-23T08:00:00.000Z', decidedBy: person(OTHER_USER, 'Nila Synthetic', 'SYN-7') },
    { revision: 2, step: 1, action: 'approve', decision: 'APPROVE', ...(withReasons ? { reason: null } : {}), decidedAt: '2026-10-24T08:00:00.000Z', decidedBy: person(OTHER_USER, 'Nila Synthetic', 'SYN-7') },
  ];

  it('lists offers with a state filter', async () => {
    serve({ 'GET /v1/hiring/offers': [200, { items: [offer({ state: 'SUBMITTED', currentRevision: 1 })] }] });
    renderAt('/hiring/offers', RECRUITER);
    const table = await screen.findByRole('table', { name: 'Offers' });
    expect(cells(rows(table)[0]!)).toEqual(['Ravi Synthetic CAN-000002', 'REQ-000001 Synthetic backend engineer', 'Waiting for approval', '2026-12-01', '1', formatDate('2026-10-22T06:00:00.000Z'), 'Open']);
    expect(within(table).getByRole('link', { name: 'Open the offer to Ravi Synthetic (CAN-000002)' }).getAttribute('href')).toBe(`/hiring/offers/${O1}`);
    // The approval queue belongs to the compensation approver only.
    expect(screen.queryByRole('region', { name: 'Offer approvals' })).toBeNull();
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'SUBMITTED' } });
    await waitFor(() => expect(callsTo('GET', '/v1/hiring/offers').at(-1)!.params.toString()).toBe('state=SUBMITTED'));
  });

  it('shows no compensation and no decision reasons when the API omits them', async () => {
    serve({ [detail]: [200, offerView({ state: 'APPROVED', currentRevision: 2, decisions: decisions(false) })] });
    renderAt(path, RECRUITER);
    expect(await screen.findByRole('heading', { level: 1, name: 'Offer to Ravi Synthetic (CAN-000002) for REQ-000001' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Compensation (confidential)' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/INR|CTC|gross|1234567|98765/);
    const history = screen.getByRole('table', { name: 'Approval history' });
    expect(headers(history)).toEqual(['Revision', 'Decision', 'Decided by', 'When']);
    expect(cells(rows(history)[0]!)).toEqual(['1', 'Returned for changes', 'Nila Synthetic, SYN-7', formatDate('2026-10-23T08:00:00.000Z')]);
    expect(document.body.textContent).not.toContain('check the band');
  });

  it('shows the compensation exactly as returned to a granted caller, with the decision reasons', async () => {
    serve({ [detail]: [200, offerView({ state: 'APPROVED', currentRevision: 2, compensation: COMPENSATION_VIEW, decisions: decisions(true) })] });
    renderAt(path, [...RECRUITER, 'offer.read.compensation']);
    const section = await sectionOf('Compensation (confidential)');
    expect(valueOf(section, 'Annual CTC')).toBe(formatAmount('1234567.5000', 'INR'));
    // Four decimals are shown exactly as sent, beside the two-decimal display.
    expect(valueOf(section, 'Monthly gross')).toBe(`${formatAmount('98765.4321', 'INR')} (exactly 98765.4321)`);
    expect(valueOf(section, 'Recorded')).toBe(`${formatDate('2026-10-23T06:00:00.000Z')} by you`);
    const revisions = within(section).getByRole('table', { name: 'Submitted revisions' });
    expect(cells(rows(revisions)[0]!)).toEqual(['1', '2026-12-01', formatAmount('1200000.0000', 'INR'), '—', formatDate('2026-10-23T07:00:00.000Z')]);
    const history = screen.getByRole('table', { name: 'Approval history' });
    expect(headers(history)).toEqual(['Revision', 'Decision', 'Decided by', 'When', 'Reason']);
    expect(rows(history).map((r) => cells(r)[4])).toEqual(['Synthetic: check the band', '—']);
  });

  it('a draft: records the compensation (format checked only) and submits with the version; refusals in words', async () => {
    let current = offerView({ version: 1, compensation: { current: null, revisions: [] } });
    let submits = 0;
    serve({
      [detail]: () => [200, current],
      [`PUT /v1/hiring/offers/${O1}/compensation`]: (c) => {
        const body = c.body as Json;
        current = { ...current, version: 2, compensation: { current: { currencyCode: body.currencyCode, annualCtc: `${body.annualCtc}00`, monthlyGross: null, setBy: ME, updatedAt: '2026-10-25T06:00:00.000Z' }, revisions: [] } };
        return [200, { offerId: O1, version: 2 }];
      },
      [`POST /v1/hiring/offers/${O1}/submit`]: () => {
        if (submits++ === 0) return [422, { error: 'NO_ELIGIBLE_REVIEWER', message: 'No eligible reviewer is configured for this request; contact HR to repair routing' }];
        current = {
          ...current,
          state: 'SUBMITTED',
          currentRevision: 1,
          version: 3,
          submittedBy: ME,
          submittedAt: '2026-10-25T07:00:00.000Z',
          pendingWith: { taskId: T1, step: 1, action: 'approve', assignee: person(OTHER_USER, 'Nila Synthetic', 'SYN-7'), assignedAt: '2026-10-25T07:00:00.000Z' },
        };
        return [200, { offerId: O1, state: 'SUBMITTED', revision: 1 }];
      },
    });
    renderAt(path, [...RECRUITER, ...COMPENSATION]);
    const form = await screen.findByRole('form', { name: 'Compensation (confidential)' });
    expect(valueIn(within(form).getByLabelText('Currency'))).toBe('INR');
    click(within(form).getByRole('button', { name: 'Record compensation' }));
    expect(within(form).getByRole('alert').textContent).toBe('Enter the annual CTC, the monthly gross or both.');
    type(within(form).getByLabelText('Annual CTC'), '12,00,000');
    click(within(form).getByRole('button', { name: 'Record compensation' }));
    expect(within(form).getByRole('alert').textContent).toBe('Enter amounts as digits with up to 4 decimal places and no separators, for example 1200000.00.');
    await settle();
    expect(callsTo('PUT', `/v1/hiring/offers/${O1}/compensation`)).toHaveLength(0);
    type(within(form).getByLabelText('Annual CTC'), '1200000.00');
    click(within(form).getByRole('button', { name: 'Record compensation' }));
    expect(await screen.findByText('Compensation recorded.')).toBeTruthy();
    expect(bodyOf('PUT', `/v1/hiring/offers/${O1}/compensation`)).toStrictEqual({ currencyCode: 'INR', annualCtc: '1200000.00', expectedVersion: 1 });
    const section = await sectionOf('Compensation (confidential)');
    await waitFor(() => expect(valueOf(section, 'Annual CTC')).toBe(formatAmount('1200000.0000', 'INR')));

    const submit = screen.getByRole('button', { name: 'Submit for approval' });
    await waitFor(() => expect(disabled(submit)).toBe(false));
    click(submit);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'No eligible approver is available: the approver must be an eligible Admin who neither prepared the offer, recorded its compensation nor submits it. Ask HR to update the offer approver list.',
    );
    expect(bodyOf('POST', `/v1/hiring/offers/${O1}/submit`)).toStrictEqual({ expectedVersion: 2 });
    click(screen.getByRole('button', { name: 'Submit for approval' }));
    expect(await screen.findByText('Offer submitted for independent approval (revision 1).')).toBeTruthy();
    const summary = await sectionOf('Offer');
    await waitFor(() => expect(valueOf(summary, 'State')).toBe('Waiting for approval'));
    expect(summary.textContent).toContain(`Waiting for approval by Nila Synthetic, SYN-7 since ${formatDate('2026-10-25T07:00:00.000Z')}.`);
    expect(screen.queryByRole('form', { name: 'Compensation (confidential)' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).toBeNull();
  });

  it('recording the compensation without the read grant sends the exact body, then starts the form clean; nothing is shown back', async () => {
    let current = offerView({ version: 1 });
    serve({
      [detail]: () => [200, current],
      [`PUT /v1/hiring/offers/${O1}/compensation`]: () => {
        current = { ...current, version: 2 };
        return [200, { offerId: O1, version: 2 }];
      },
    });
    renderAt(path, [...RECRUITER, 'offer.manage.compensation']);
    const form = await screen.findByRole('form', { name: 'Compensation (confidential)' });
    // The API returned no compensation to this caller: there is nothing to start from.
    expect(valueIn(within(form).getByLabelText('Annual CTC'))).toBe('');
    type(within(form).getByLabelText('Currency'), 'usd');
    type(within(form).getByLabelText('Annual CTC'), '90000');
    type(within(form).getByLabelText('Monthly gross'), '7500.5');
    click(within(form).getByRole('button', { name: 'Record compensation' }));
    expect(await screen.findByText('Compensation recorded.')).toBeTruthy();
    expect(bodyOf('PUT', `/v1/hiring/offers/${O1}/compensation`)).toStrictEqual({ currencyCode: 'USD', annualCtc: '90000', monthlyGross: '7500.5', expectedVersion: 1 });
    expect(valueIn(within(form).getByLabelText('Currency'))).toBe('INR');
    expect(valueIn(within(form).getByLabelText('Annual CTC'))).toBe('');
    expect(valueIn(within(form).getByLabelText('Monthly gross'))).toBe('');
    expect(screen.queryByRole('heading', { level: 2, name: 'Compensation (confidential)' })).toBeNull();
  });

  it('a draft: changes the proposed joining date with the offer version; a concurrent change is refused in words and the date typed is kept', async () => {
    let current = offerView({ version: 1 });
    let attempt = 0;
    serve({
      [detail]: () => [200, current],
      [`PUT /v1/hiring/offers/${O1}`]: (c) => {
        if (attempt++ === 0) {
          // Someone else changed the draft a moment earlier.
          current = { ...current, version: 2 };
          return [409, { error: 'STALE_VERSION', message: 'The record changed; reload and retry' }];
        }
        current = { ...current, proposedJoiningDate: (c.body as Json).proposedJoiningDate, version: 3 };
        return [200, { offerId: O1, version: 3 }];
      },
    });
    renderAt(path, RECRUITER);
    const form = await screen.findByRole('form', { name: 'Terms' });
    const joining = within(form).getByLabelText('Proposed joining date (required)');
    expect(valueIn(joining)).toBe('2026-12-01');
    type(joining, '2026-12-15');
    click(within(form).getByRole('button', { name: 'Save joining date' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('Someone changed this record meanwhile. It has been reloaded: check it and try again.');
    expect(valueIn(joining)).toBe('2026-12-15');
    await waitFor(() => expect(callsTo('GET', `/v1/hiring/offers/${O1}`)).toHaveLength(2));
    await waitFor(() => expect(disabled(within(form).getByRole('button', { name: 'Save joining date' }))).toBe(false));
    click(within(form).getByRole('button', { name: 'Save joining date' }));
    expect(await screen.findByText('Proposed joining date saved: 2026-12-15.')).toBeTruthy();
    expect(callsTo('PUT', `/v1/hiring/offers/${O1}`).map((x) => x.body)).toStrictEqual([
      { proposedJoiningDate: '2026-12-15', expectedVersion: 1 },
      { proposedJoiningDate: '2026-12-15', expectedVersion: 2 },
    ]);
    const summary = await sectionOf('Offer');
    await waitFor(() => expect(valueOf(summary, 'Proposed joining date')).toBe('2026-12-15'));
  });

  it('explains in words why a person cannot convert twice (FR-014, FR-013), naming no other record', async () => {
    const current = offerView({ state: 'APPROVED', currentRevision: 1, version: 4 });
    let attempt = 0;
    const refusals = [
      ['CANDIDATE_OFFER_ACCEPTED', 'This person already has another accepted offer, on this candidate record or one confirmed as its duplicate. Withdraw that offer first.'],
      ['CANDIDATE_ALREADY_EMPLOYED', 'This person is already an employee, through this candidate record or one confirmed as its duplicate. The offer can be declined or withdrawn.'],
      ['CANDIDATE_NOT_ACTIVE', 'The candidate record is not active, so this offer cannot be accepted.'],
    ] as const;
    serve({
      [detail]: () => [200, current],
      [`POST /v1/hiring/offers/${O1}/response`]: () => [409, { error: refusals[attempt++]![0], message: 'server words' }],
    });
    renderAt(path, RECRUITER);
    const form = await screen.findByRole('form', { name: 'The candidate’s response' });
    click(within(form).getByLabelText('Accepted'));
    type(within(form).getByLabelText('Responded on (required)'), '2026-10-24');
    for (const [, words] of refusals) {
      await waitFor(() => expect(disabled(within(form).getByRole('button', { name: 'Record response' }))).toBe(false));
      click(within(form).getByRole('button', { name: 'Record response' }));
      await waitFor(() => expect(within(form).getByRole('alert').textContent).toBe(words));
    }
  });

  it('records the candidate’s acceptance with its date and the offer version; no open vacancy is explained in words', async () => {
    let current = offerView({ state: 'APPROVED', currentRevision: 1, version: 4 });
    let attempt = 0;
    serve({
      [detail]: () => [200, current],
      [`POST /v1/hiring/offers/${O1}/response`]: () => {
        if (attempt++ === 0) return [409, { error: 'NO_OPEN_VACANCY', message: 'Every vacancy of this requisition already has an accepted offer', details: { vacancies: 1, accepted: 1 } }];
        current = { ...current, state: 'ACCEPTED', candidateResponseOn: '2026-10-24', version: 5 };
        return [200, { offerId: O1, state: 'ACCEPTED' }];
      },
    });
    renderAt(path, RECRUITER);
    const form = await screen.findByRole('form', { name: 'The candidate’s response' });
    click(within(form).getByRole('button', { name: 'Record response' }));
    expect(within(form).getByRole('alert').textContent).toBe('Choose whether the candidate accepted or declined.');
    click(within(form).getByLabelText('Accepted'));
    type(within(form).getByLabelText('Responded on (required)'), '2026-10-24');
    click(within(form).getByRole('button', { name: 'Record response' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('Every vacancy of this requisition already has an accepted offer.');
    await waitFor(() => expect(disabled(within(form).getByRole('button', { name: 'Record response' }))).toBe(false));
    click(within(form).getByRole('button', { name: 'Record response' }));
    expect(await screen.findByText('Recorded the candidate’s acceptance.')).toBeTruthy();
    expect(bodyOf('POST', `/v1/hiring/offers/${O1}/response`, 1)).toStrictEqual({ response: 'ACCEPTED', respondedOn: '2026-10-24', expectedVersion: 4 });
    expect(valueOf(await sectionOf('Offer'), 'Candidate responded on')).toBe('2026-10-24');
  });

  it('withdraws a submitted offer with a required reason', async () => {
    let current = offerView({ state: 'SUBMITTED', currentRevision: 1, version: 3 });
    serve({
      [detail]: () => [200, current],
      [`POST /v1/hiring/offers/${O1}/withdraw`]: (c) => {
        current = { ...current, state: 'WITHDRAWN', withdrawnReason: (c.body as Json).reason, withdrawnAt: '2026-10-25T06:00:00.000Z', version: 4 };
        return [200, { offerId: O1, state: 'WITHDRAWN' }];
      },
    });
    renderAt(path, RECRUITER);
    const form = await screen.findByRole('form', { name: 'Withdraw the offer' });
    expect(form.textContent).toContain('Withdrawing cancels the approval that is waiting.');
    expect(screen.queryByRole('form', { name: 'Terms' })).toBeNull();
    click(within(form).getByRole('button', { name: 'Withdraw offer' }));
    expect(within(form).getByRole('alert').textContent).toBe('Enter why the offer is withdrawn.');
    type(within(form).getByLabelText('Reason for withdrawing (required)'), 'Synthetic: position on hold');
    click(within(form).getByRole('button', { name: 'Withdraw offer' }));
    expect(await screen.findByText('Offer withdrawn.')).toBeTruthy();
    expect(bodyOf('POST', `/v1/hiring/offers/${O1}/withdraw`)).toStrictEqual({ reason: 'Synthetic: position on hold' });
    const summary = await sectionOf('Offer');
    await waitFor(() => expect(valueOf(summary, 'Withdrawal reason')).toBe('Synthetic: position on hold'));
    expect(screen.queryByRole('form', { name: 'Withdraw the offer' })).toBeNull();
  });

  it('never shows an offer answered under another role assignment, not even from the cache', async () => {
    const client = testClient(Infinity);
    let withCompensation = true;
    serve({ [detail]: () => [200, withCompensation ? offerView({ state: 'APPROVED', compensation: COMPENSATION_VIEW }) : offerView({ state: 'APPROVED' })] });
    const view = renderAt(path, [...RECRUITER, 'offer.read.compensation'], client);
    expect(await screen.findByRole('heading', { name: 'Compensation (confidential)' })).toBeTruthy();
    view.unmount();
    withCompensation = false;
    session.assignmentId = OTHER_ASSIGNMENT;
    renderAt(path, RECRUITER, client);
    expect(await screen.findByRole('heading', { level: 1, name: 'Offer to Ravi Synthetic (CAN-000002) for REQ-000001' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Compensation (confidential)' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/1234567|98765/);
    expect(callsTo('GET', `/v1/hiring/offers/${O1}`)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('offer letters (FR-014, FR-017, FR-018; DF09: never sent by the system; I-82 item 1)', () => {
  const path = `/hiring/offers/${O1}`;
  const detail = `GET /v1/hiring/offers/${O1}`;
  const letters = `/v1/hiring/offers/${O1}/letters`;
  const preview = `/v1/hiring/offers/${O1}/letter-preview`;
  const L1 = '93000000-0000-4000-8000-000000000001';
  const L2 = '93000000-0000-4000-8000-000000000002';
  /** Reads the offer compensation and so the stored letters, and may list letter templates; issues nothing. */
  const READ_LETTERS = [...RECRUITER, 'offer.read.compensation', 'letter_template.read.operational'];
  /** An eligible HR Administrator assignment holding the offer letter grant (registration ceiling). */
  const ISSUER = [...READ_LETTERS, 'offer.issue_letter.compensation'];
  const KEY = /^[A-Za-z0-9._:-]{8,100}$/;
  const TEMPLATE_LIST = {
    items: [
      { id: '94000000-0000-4000-8000-000000000001', code: 'OFFER_STD', name: 'Standard offer letter (synthetic)', letterType: 'OFFER', active: true, version: 2, publishedRevision: 3, draftRevision: null },
      { id: '94000000-0000-4000-8000-000000000002', code: 'OFFER_OLD', name: 'Old offer letter (synthetic)', letterType: 'OFFER', active: false, version: 3, publishedRevision: 1, draftRevision: null },
      { id: '94000000-0000-4000-8000-000000000003', code: 'OFFER_NEXT', name: 'Next offer letter (synthetic)', letterType: 'OFFER', active: true, version: 1, publishedRevision: null, draftRevision: 1 },
      { id: '94000000-0000-4000-8000-000000000004', code: 'RELIEVING', name: 'Relieving letter (synthetic)', letterType: 'RELIEVING', active: true, version: 4, publishedRevision: 2, draftRevision: null },
    ],
  };
  const OFFER_PLACEHOLDERS = {
    items: [
      { key: 'candidateName', source: 'OFFER', label: 'Candidate name' },
      { key: 'annualCtc', source: 'OFFER', label: 'Annual CTC (approved offer)' },
      { key: 'monthlyGross', source: 'OFFER', label: 'Monthly gross (approved offer)' },
    ],
  };
  const METHODS = {
    category: 'OFFER_LETTER_DELIVERY',
    items: [
      { code: 'IN_PERSON', label: 'Handed to the candidate in person' },
      { code: 'POST', label: 'Sent by post or courier' },
    ],
  };
  const LETTER_TEXT = 'Dear Ravi Synthetic,\nWe offer you the post of Synthetic backend engineer from 2026-12-01.';
  const ready = (patch: Json = {}): Json => ({ offerId: O1, offerRevision: 2, templateCode: 'OFFER_STD', templateRevision: 3, text: LETTER_TEXT, missing: [], ready: true, sent: false, ...patch });
  const stored = (patch: Json = {}): Json => ({
    id: L1,
    offerId: O1,
    offerRevision: 2,
    templateCode: 'OFFER_STD',
    templateRevision: 3,
    outputNumber: 1,
    checksum: 'synthetic-checksum',
    byteSize: 96,
    generatedAt: '2026-11-05T06:00:00.000Z',
    generatedBy: ME,
    deliveryState: 'NOT_DELIVERED',
    ...patch,
  });
  const listed = (patch: Json = {}): Json => ({ ...stored(), current: true, delivery: null, ...patch });
  const letterList = (items: Json[], offerState = 'APPROVED') => ({ offerId: O1, offerState, currentRevision: 2, items });
  const approved = offerView({ state: 'APPROVED', currentRevision: 2, version: 5 });

  it('FR-017 previews and generates an offer letter from an OFFER template only with the issue grant', async () => {
    let items: Json[] = [];
    serve({
      [detail]: [200, approved],
      [`GET ${letters}`]: () => [200, letterList(items)],
      'GET /v1/letter-templates': [200, TEMPLATE_LIST],
      'GET /v1/letter-placeholders': [200, OFFER_PLACEHOLDERS],
      'GET /v1/hiring/reference-values': [200, METHODS],
      [`POST ${preview}`]: [200, ready()],
      [`POST ${letters}`]: () => {
        const n = items.length + 1;
        const letter = stored({ id: n === 1 ? L1 : L2, outputNumber: n });
        items = [{ ...letter, current: true, delivery: null }, ...items];
        return [201, { ...letter, replayed: false }];
      },
    });

    // Reading the letters without the issue grant: the list, and no way to preview or generate one.
    const view = renderAt(path, READ_LETTERS);
    const readOnly = await sectionOf('Offer letters (confidential)');
    expect(await within(readOnly).findByText('No offer letter has been generated for this offer.')).toBeTruthy();
    expect(readOnly.textContent).toContain('The system never e-mails or sends an offer letter.');
    expect(within(readOnly).queryByRole('button', { name: 'Preview' })).toBeNull();
    expect(within(readOnly).queryByRole('button', { name: 'Generate final letter' })).toBeNull();
    await settle();
    expect(callsTo('GET', '/v1/letter-templates')).toHaveLength(0);
    expect(callsTo('POST', preview)).toHaveLength(0);
    view.unmount();

    renderAt(path, ISSUER);
    const section = await sectionOf('Offer letters (confidential)');
    const select = (await within(section).findByLabelText('Offer letter template')) as HTMLSelectElement;
    // Only an active OFFER template with a published revision is offered.
    await waitFor(() => expect([...select.options].map((o) => o.textContent)).toEqual(['Choose…', 'Standard offer letter (synthetic) (OFFER_STD, revision 3)']));
    const generateButton = () => within(section).getByRole('button', { name: 'Generate final letter' });
    expect(disabled(generateButton())).toBe(true);
    click(within(section).getByRole('button', { name: 'Preview' }));
    expect(within(section).getByRole('alert').textContent).toBe('Choose an offer letter template.');
    await settle();
    expect(callsTo('POST', preview)).toHaveLength(0);

    fireEvent.change(select, { target: { value: 'OFFER_STD' } });
    click(within(section).getByRole('button', { name: 'Preview' }));
    const shown = await within(section).findByRole('region', { name: 'Offer letter preview' });
    expect(bodyOf('POST', preview)).toStrictEqual({ templateCode: 'OFFER_STD' });
    expect(shown.textContent).toContain('Preview of OFFER_STD, revision 3, for offer revision 2');
    expect(shown.textContent).toContain('Nothing was stored or sent.');
    expect(shown.textContent).toContain('Every mandatory value is present.');
    expect(shown.querySelector('pre')?.textContent).toBe(LETTER_TEXT);
    // A preview stores nothing.
    expect(callsTo('POST', letters)).toHaveLength(0);
    expect(disabled(generateButton())).toBe(false);
    click(generateButton());
    expect((await within(section).findByRole('status')).textContent).toBe(
      'Final letter stored: letter number 1 (OFFER_STD, revision 3; offer revision 2). It was not sent: download it, hand it to the candidate and record the delivery.',
    );
    const first = bodyOf('POST', letters)!;
    expect(Object.keys(first).sort()).toEqual(['idempotencyKey', 'templateCode']);
    expect(first.templateCode).toBe('OFFER_STD');
    expect(String(first.idempotencyKey)).toMatch(KEY);
    // The stored letter is listed as the server returns it.
    const table = await within(section).findByRole('table', { name: 'Offer letters' });
    await waitFor(() => expect(cells(rows(table)[0]!)).toEqual(['1', 'OFFER_STD, revision 3', '2', formatDate('2026-11-05T06:00:00.000Z'), 'Not delivered yet', 'Download']));

    // Another letter is another action: a new preview first, then a new idempotency key.
    expect(disabled(generateButton())).toBe(true);
    fireEvent.change(select, { target: { value: 'OFFER_STD' } });
    click(within(section).getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(disabled(generateButton())).toBe(false));
    click(generateButton());
    await waitFor(() => expect(callsTo('POST', letters)).toHaveLength(2));
    const second = bodyOf('POST', letters, 1)!;
    expect(String(second.idempotencyKey)).toMatch(KEY);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    await waitFor(() => expect(rows(within(section).getByRole('table', { name: 'Offer letters' }))).toHaveLength(2));
  });

  it('FR-018 records a delivery with method, date and confirmed recipient; the page never offers to send', async () => {
    const downloads = stubDownloads();
    try {
      let items: Json[] = [listed({ id: L2, outputNumber: 2 }), listed({ id: L1, outputNumber: 1, offerRevision: 1, generatedAt: '2026-11-01T06:00:00.000Z', current: false })];
      let attempt = 0;
      serve({
        [detail]: [200, approved],
        [`GET ${letters}`]: () => [200, letterList(items)],
        'GET /v1/letter-templates': [200, TEMPLATE_LIST],
        'GET /v1/letter-placeholders': [200, OFFER_PLACEHOLDERS],
        'GET /v1/hiring/reference-values': [200, METHODS],
        [`GET /v1/hiring/offer-letters/${L2}/content`]: [200, { synthetic: true }],
        [`POST /v1/hiring/offer-letters/${L2}/delivery`]: (c) => {
          attempt += 1;
          if (attempt === 1) return [422, { error: 'INVALID_DATE', message: 'The delivery date cannot be before the letter was generated', details: { field: 'deliveredOn', generatedOn: '2026-11-05' } }];
          const b = c.body as Json;
          items = items.map((l) =>
            l.id === L2
              ? {
                  ...l,
                  deliveryState: 'DELIVERED',
                  delivery: { method: b.deliveryMethod, methodLabel: 'Handed to the candidate in person', deliveredOn: b.deliveredOn, recordedBy: ME, recordedByPerson: person(ME, 'Synthetic Recruiter', 'SYN-9'), recordedAt: '2026-11-06T06:00:00.000Z' },
                }
              : l,
          );
          return [200, { id: L2, offerId: O1, deliveryState: 'DELIVERED', deliveryMethod: b.deliveryMethod, deliveredOn: b.deliveredOn }];
        },
      });
      renderAt(path, ISSUER);
      const section = await sectionOf('Offer letters (confidential)');
      const table = await within(section).findByRole('table', { name: 'Offer letters' });
      expect(headers(table)).toEqual(['Letter number', 'Template', 'Offer revision', 'Generated', 'Delivery', 'Download']);
      expect(cells(rows(table)[0]!)).toEqual(['2', 'OFFER_STD, revision 3', '2', formatDate('2026-11-05T06:00:00.000Z'), 'Not delivered yet', 'Download']);
      expect(cells(rows(table)[1]!)[4]).toBe('Not delivered, and no longer deliverable: it carries an earlier revision of the offer, or the offer is no longer approved or accepted');
      // DF09: the letter is handed over outside the system; nothing on the page sends or e-mails it.
      expect(section.textContent).toContain(
        'The system never e-mails or sends an offer letter. Download the letter here and hand it to the candidate yourself, outside the system; then record how and when it was delivered.',
      );
      expect(screen.queryByRole('button', { name: /send|e-?mail/i })).toBeNull();
      click(within(table).getByRole('button', { name: 'Download offer letter 2' }));
      await waitFor(() => expect(downloads.saved).toHaveBeenCalledOnce());
      expect(callsTo('GET', `/v1/hiring/offer-letters/${L2}/content`)).toHaveLength(1);

      // Only the letter of the current approved revision can be recorded as delivered.
      const form = await within(section).findByRole('form', { name: 'Record the delivery of offer letter 2' });
      expect(within(section).queryByRole('form', { name: 'Record the delivery of offer letter 1' })).toBeNull();
      expect(callsTo('GET', '/v1/hiring/reference-values')[0]!.params.get('category')).toBe('OFFER_LETTER_DELIVERY');
      const method = within(form).getByLabelText('Delivery method (required)') as HTMLSelectElement;
      expect([...method.options].map((o) => o.textContent)).toEqual(['Choose…', 'Handed to the candidate in person', 'Sent by post or courier']);
      click(within(form).getByRole('button', { name: 'Record delivery' }));
      expect(within(form).getByRole('alert').textContent).toBe('Choose how the letter was delivered.');
      fireEvent.change(method, { target: { value: 'IN_PERSON' } });
      type(within(form).getByLabelText('Delivered on (required)'), '2026-11-04');
      click(within(form).getByRole('button', { name: 'Record delivery' }));
      expect(within(form).getByRole('alert').textContent).toBe('Confirm that the letter went to the offer’s candidate, Ravi Synthetic (CAN-000002).');
      await settle();
      expect(callsTo('POST', `/v1/hiring/offer-letters/${L2}/delivery`)).toHaveLength(0);

      click(within(form).getByLabelText('The letter went to the offer’s candidate, Ravi Synthetic (CAN-000002)'));
      click(within(form).getByRole('button', { name: 'Record delivery' }));
      expect((await within(form).findByRole('alert')).textContent).toBe('The delivery date cannot be before the letter was generated (2026-11-05).');
      type(within(form).getByLabelText('Delivered on (required)'), '2026-11-06');
      await waitFor(() => expect(disabled(within(form).getByRole('button', { name: 'Record delivery' }))).toBe(false));
      click(within(form).getByRole('button', { name: 'Record delivery' }));
      expect((await within(section).findByRole('status')).textContent).toBe(
        'Recorded the delivery of offer letter 2 to Ravi Synthetic (CAN-000002): Handed to the candidate in person on 2026-11-06.',
      );
      expect(callsTo('POST', `/v1/hiring/offer-letters/${L2}/delivery`).map((c) => c.body)).toStrictEqual([
        { deliveryMethod: 'IN_PERSON', deliveredOn: '2026-11-04', recipientConfirmed: true },
        { deliveryMethod: 'IN_PERSON', deliveredOn: '2026-11-06', recipientConfirmed: true },
      ]);
      await waitFor(() => expect(cells(rows(within(section).getByRole('table', { name: 'Offer letters' }))[0]!)[4]).toBe('Delivered: Handed to the candidate in person on 2026-11-06'));
      // A recorded delivery is final: nothing more to record for it.
      expect(within(section).queryByRole('form', { name: 'Record the delivery of offer letter 2' })).toBeNull();
    } finally {
      downloads.restore();
    }
  });

  it('FR-018 says a delivery recorded meanwhile in plain words and reads the letters again', async () => {
    let items: Json[] = [listed({ id: L2, outputNumber: 2 })];
    serve({
      [detail]: [200, approved],
      [`GET ${letters}`]: () => [200, letterList(items)],
      'GET /v1/letter-templates': [200, TEMPLATE_LIST],
      'GET /v1/letter-placeholders': [200, OFFER_PLACEHOLDERS],
      'GET /v1/hiring/reference-values': [200, METHODS],
      [`POST /v1/hiring/offer-letters/${L2}/delivery`]: () => {
        items = [listed({ id: L2, outputNumber: 2, deliveryState: 'DELIVERED', delivery: { method: 'POST', methodLabel: 'Sent by post or courier', deliveredOn: '2026-11-05', recordedBy: OTHER_USER, recordedByPerson: null, recordedAt: '2026-11-05T09:00:00.000Z' } })];
        return [409, { error: 'ALREADY_DELIVERED', message: 'This letter’s delivery is already recorded' }];
      },
    });
    renderAt(path, ISSUER);
    const section = await sectionOf('Offer letters (confidential)');
    const form = await within(section).findByRole('form', { name: 'Record the delivery of offer letter 2' });
    fireEvent.change(within(form).getByLabelText('Delivery method (required)'), { target: { value: 'IN_PERSON' } });
    type(within(form).getByLabelText('Delivered on (required)'), '2026-11-06');
    click(within(form).getByLabelText('The letter went to the offer’s candidate, Ravi Synthetic (CAN-000002)'));
    click(within(form).getByRole('button', { name: 'Record delivery' }));
    expect((await within(section).findByRole('alert')).textContent).toBe(
      'Offer letter 2: This letter’s delivery is already recorded, and a recorded delivery is final. The letters have been reloaded.',
    );
    await waitFor(() => expect(cells(rows(within(section).getByRole('table', { name: 'Offer letters' }))[0]!)[4]).toBe('Delivered: Sent by post or courier on 2026-11-05'));
    expect(within(section).queryByRole('form', { name: 'Record the delivery of offer letter 2' })).toBeNull();
  });

  it('FR-017 says a missing mandatory value in plain words', async () => {
    let previews = 0;
    serve({
      [detail]: [200, approved],
      [`GET ${letters}`]: [200, letterList([])],
      'GET /v1/letter-templates': [200, TEMPLATE_LIST],
      'GET /v1/letter-placeholders': [200, OFFER_PLACEHOLDERS],
      [`POST ${preview}`]: () => (previews++ === 0 ? [200, ready({ text: 'Monthly gross: ', missing: ['monthlyGross'], ready: false })] : [200, ready()]),
      [`POST ${letters}`]: [422, { error: 'MISSING_PLACEHOLDER', message: 'Mandatory letter values are missing', details: { missing: ['annualCtc'] } }],
    });
    renderAt(path, ISSUER);
    const section = await sectionOf('Offer letters (confidential)');
    const select = (await within(section).findByLabelText('Offer letter template')) as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(2));
    fireEvent.change(select, { target: { value: 'OFFER_STD' } });
    click(within(section).getByRole('button', { name: 'Preview' }));
    const shown = await within(section).findByRole('region', { name: 'Offer letter preview' });
    await waitFor(() =>
      expect(within(shown).getByRole('alert').textContent).toBe(
        'The final letter cannot be generated while the approved offer lacks these mandatory values: Monthly gross (approved offer) ({{monthlyGross}}).',
      ),
    );
    // The names come from the offer letter type's own placeholders.
    expect(callsTo('GET', '/v1/letter-placeholders')[0]!.params.get('letterType')).toBe('OFFER');
    expect(shown.textContent).toContain('Nothing was stored or sent.');
    expect(disabled(within(section).getByRole('button', { name: 'Generate final letter' }))).toBe(true);

    // The server checks again when the final letter is generated: a value gone meanwhile is named in words.
    click(within(section).getByRole('button', { name: 'Preview' }));
    expect(await within(section).findByText('Every mandatory value is present.')).toBeTruthy();
    await waitFor(() => expect(disabled(within(section).getByRole('button', { name: 'Generate final letter' }))).toBe(false));
    click(within(section).getByRole('button', { name: 'Generate final letter' }));
    expect((await within(section).findByRole('alert')).textContent).toBe(
      'The final letter was not generated: mandatory values are missing from the approved offer: Annual CTC (approved offer) ({{annualCtc}}).',
    );
    expect(within(section).queryByRole('status')).toBeNull();
  });

  it('FR-017 takes a template code where the role cannot list templates, says the refusals in plain words, and issues only from an approved or accepted offer', async () => {
    const refusals: Record<string, Reply> = {
      RELIEVING: [422, { error: 'NOT_AN_OFFER_TEMPLATE', message: 'An offer letter uses a template of the offer letter type' }],
      OFFER_OLD: [422, { error: 'TEMPLATE_INACTIVE', message: 'The letter template is inactive' }],
      OFFER_NEXT: [422, { error: 'TEMPLATE_NOT_PUBLISHED', message: 'The letter template has no published revision' }],
      OFFER_STD: [409, { error: 'OFFER_NOT_APPROVED', message: 'An offer letter is issued only for an approved or accepted offer', details: { state: 'WITHDRAWN' } }],
    };
    serve({
      [detail]: [200, approved],
      [`GET ${letters}`]: [200, letterList([])],
      [`POST ${preview}`]: (c) => refusals[String((c.body as Json).templateCode)]!,
    });
    const issuer = [...RECRUITER, 'offer.read.compensation', 'offer.issue_letter.compensation'];
    const view = renderAt(path, issuer);
    const section = await sectionOf('Offer letters (confidential)');
    const code = within(section).getByLabelText('Offer letter template code') as HTMLInputElement;
    for (const [typed, words] of [
      ['relieving', 'This template is not an offer letter template: an offer letter uses a template of the offer letter type.'],
      ['OFFER_OLD', 'This letter template is inactive, so it cannot be used. Choose another template, or ask HR to activate it.'],
      ['OFFER_NEXT', 'This letter template has no published revision yet, so it cannot be used.'],
      ['OFFER_STD', 'Only an approved or accepted offer issues an offer letter, and this offer is not approved or accepted (any more). It has been reloaded.'],
    ] as const) {
      type(code, typed);
      await waitFor(() => expect(disabled(within(section).getByRole('button', { name: 'Preview' }))).toBe(false));
      click(within(section).getByRole('button', { name: 'Preview' }));
      await waitFor(() => expect(within(section).getByRole('alert').textContent).toBe(words));
    }
    expect(callsTo('POST', preview).map((c) => (c.body as Json).templateCode)).toEqual(['RELIEVING', 'OFFER_OLD', 'OFFER_NEXT', 'OFFER_STD']);
    // The offer is read again after the conflict; the templates were never listed for this role.
    await waitFor(() => expect(callsTo('GET', `/v1/hiring/offers/${O1}`).length).toBeGreaterThan(1));
    expect(callsTo('GET', '/v1/letter-templates')).toEqual([]);
    view.unmount();

    serve({ [detail]: [200, offerView({ state: 'SUBMITTED', currentRevision: 1 })], [`GET ${letters}`]: [200, letterList([], 'SUBMITTED')] });
    renderAt(path, ISSUER);
    const pending = await sectionOf('Offer letters (confidential)');
    expect(await within(pending).findByText('Only an approved or accepted offer issues a letter. This offer’s state: Waiting for approval.')).toBeTruthy();
    expect(within(pending).queryByRole('button', { name: 'Preview' })).toBeNull();
    await settle();
    expect(callsTo('GET', '/v1/letter-templates')).toEqual([]);
    expect(callsTo('GET', '/v1/hiring/reference-values')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('handover to onboarding (FR-014: a reviewed employee DRAFT, at most once)', () => {
  const path = `/hiring/offers/${O1}`;
  const detail = `GET /v1/hiring/offers/${O1}`;
  const handover = `/v1/hiring/offers/${O1}/handover`;
  const accepted = offerView({ state: 'ACCEPTED', currentRevision: 1, candidateResponseOn: '2026-10-24', version: 5 });

  it('creates the employee draft from the accepted offer with released documents only, then links to the employee', async () => {
    let current = accepted;
    serve({
      [detail]: () => [200, current],
      [`GET /v1/hiring/candidates/${C2}/documents`]: [200, { items: [doc(D_CLEAN, 'ravi-cv.pdf', 'CLEAN', C2), doc(D_PENDING, 'ravi-id.pdf', 'PENDING_SCAN', C2)] }],
      [`POST ${handover}`]: () => {
        current = { ...current, handedOverEmployeeId: E1 };
        return [201, { handoverId: 'h-1', employeeId: E1, employeeStatus: 'DRAFT', offerId: O1, applicationId: A2, requisitionId: R1, documents: [{ candidateDocumentId: D_CLEAN, employeeDocumentId: 'ed-1' }] }];
      },
    });
    renderAt(path, [...HANDOVER, 'candidate.read.document', 'document.upload.document']);
    const form = await screen.findByRole('form', { name: 'Create the employee draft' });
    expect(form.textContent).toContain('Hiring never activates employment');
    const docs = await within(form).findByRole('list', { name: 'Candidate documents' });
    // A file still waiting for the malware scan cannot be chosen.
    expect(within(docs).getAllByRole('checkbox')).toHaveLength(1);
    expect(docs.textContent).toContain('ravi-id.pdf waiting for the malware scan only released files can be transferred');
    click(within(docs).getByLabelText('ravi-cv.pdf (Curriculum vitae)'));
    expect(valueIn(within(docs).getByLabelText('Employee document type for ravi-cv.pdf'))).toBe('GENERAL');
    click(within(form).getByRole('button', { name: 'Create employee draft' }));
    expect(within(form).getByRole('alert').textContent).toBe('Enter the new employee’s code.');
    type(within(form).getByLabelText('Employee code (required)'), ' HIRE-001 ');
    type(within(form).getByLabelText('Work email (optional)'), 'ravi.synthetic@example.test');
    click(within(form).getByRole('button', { name: 'Create employee draft' }));
    expect(await screen.findByText('Employee draft created (status: draft). It is not active.')).toBeTruthy();
    expect(bodyOf('POST', handover)).toStrictEqual({
      employeeCode: 'HIRE-001',
      workEmail: 'ravi.synthetic@example.test',
      documents: [{ candidateDocumentId: D_CLEAN, documentType: 'GENERAL' }],
    });
    // At most once: the form goes, and the employee's record is linked; nothing here activates it.
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Create the employee draft' })).toBeNull());
    expect(screen.getByRole('link', { name: 'Open the employee’s hiring record' }).getAttribute('href')).toBe(`/hiring/employees/${E1}/origin`);
    expect(screen.queryByRole('button', { name: /activate/i })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Withdraw the offer' })).toBeNull();
    expect(callsTo('POST', handover)).toHaveLength(1);
  });

  it('a second handover is refused in words with a link to the employee the offer already created; the button is disabled in flight', async () => {
    const answer = held([409, { error: 'ALREADY_HANDED_OVER', message: 'This accepted offer has already created an employee', details: { employeeId: E1 } }]);
    serve({ [detail]: [200, accepted], [`POST ${handover}`]: answer.handler });
    renderAt(path, HANDOVER);
    const form = await screen.findByRole('form', { name: 'Create the employee draft' });
    // Without the document grants nothing is offered for transfer and nothing is read.
    expect(form.textContent).toContain('Transferring candidate documents needs the candidate document read and employee document upload grants.');
    type(within(form).getByLabelText('Employee code (required)'), 'HIRE-002');
    const create = within(form).getByRole('button', { name: 'Create employee draft' });
    click(create);
    await waitFor(() => expect(disabled(create)).toBe(true));
    click(create);
    act(() => answer.release());
    expect((await within(form).findByRole('alert')).textContent).toBe('This accepted offer has already created an employee: an offer is handed over once only.');
    expect(within(form).getByRole('link', { name: 'Open the employee created from this offer' }).getAttribute('href')).toBe(`/hiring/employees/${E1}/origin`);
    expect(callsTo('POST', handover)).toHaveLength(1);
    expect(bodyOf('POST', handover)).toStrictEqual({ employeeCode: 'HIRE-002' });
    expect(callsTo('GET', `/v1/hiring/candidates/${C2}/documents`)).toHaveLength(0);
  });

  it('needs the handover duty and the employee creation duty', async () => {
    serve({ [detail]: [200, accepted] });
    const view = renderAt(path, RECRUITER);
    await screen.findByRole('heading', { level: 1, name: 'Offer to Ravi Synthetic (CAN-000002) for REQ-000001' });
    expect(screen.queryByRole('heading', { name: 'Hand over to onboarding' })).toBeNull();
    view.unmount();
    renderAt(path, [...RECRUITER, 'hiring.handover.operational']);
    const section = await sectionOf('Hand over to onboarding');
    expect(within(section).getByRole('note').textContent).toContain('it also needs the employee creation duty');
    expect(within(section).queryByRole('form')).toBeNull();
  });

  it('the employee’s hiring origin traces back to its requisition, application, offer and candidate', async () => {
    serve({
      [`GET /v1/hiring/employees/${E1}/origin`]: [
        200,
        {
          handoverId: 'h-1',
          employeeId: E1,
          handedOverAt: '2026-10-25T06:00:00.000Z',
          handedOverBy: ME,
          requisition: { id: R1, code: 'REQ-000001', title: 'Synthetic backend engineer' },
          application: { id: A2, stage: 'HIRED' },
          offer: { id: O1, state: 'ACCEPTED', proposedJoiningDate: '2026-12-01' },
          candidate: { id: C2, candidateCode: 'CAN-000002' },
          documents: [{ candidateDocumentId: D_CLEAN, employeeDocumentId: 'ed-1' }],
        },
      ],
      [`GET /v1/employees/${E1}`]: [
        200,
        { id: E1, employeeCode: 'HIRE-001', displayName: 'Ravi Synthetic', workEmail: 'ravi.synthetic@example.test', joiningDate: '2026-12-01', employmentType: 'PERMANENT', status: 'DRAFT', version: 1 },
      ],
    });
    renderAt(`/hiring/employees/${E1}/origin`, [...RECRUITER, 'employee.read.operational']);
    expect(await screen.findByRole('heading', { level: 1, name: 'Hiring origin of Ravi Synthetic (HIRE-001)' })).toBeTruthy();
    const record = await sectionOf('Employee record');
    expect(valueOf(record, 'Status')).toBe('Draft');
    expect(record.textContent).toContain('This employee is a draft. Hiring never activates employment');
    expect(within(record).queryByRole('link', { name: 'Employee documents' })).toBeNull();
    const history = await sectionOf('Recruitment history');
    await within(history).findByText('Documents transferred');
    expect(valueOf(history, 'Documents transferred')).toBe('1');
    expect(within(history).getByRole('link', { name: 'REQ-000001' }).getAttribute('href')).toBe(`/hiring/requisitions/${R1}/applications`);
    expect(within(history).getByRole('link', { name: 'Hired' }).getAttribute('href')).toBe(`/hiring/applications/${A2}`);
    expect(within(history).getByRole('link', { name: 'Accepted' }).getAttribute('href')).toBe(`/hiring/offers/${O1}`);
    expect(within(history).getByRole('link', { name: 'CAN-000002' }).getAttribute('href')).toBe(`/hiring/candidates/${C2}`);
  });

  it('an employee with no recorded hiring origin is said so in words; the employee documents are linked with a document grant', async () => {
    serve({
      [`GET /v1/hiring/employees/${E1}/origin`]: [404, { error: 'NOT_FOUND', message: 'Resource not found' }],
      [`GET /v1/employees/${E1}`]: [200, { id: E1, employeeCode: 'SYN-5', displayName: 'Om Synthetic', workEmail: null, joiningDate: '2025-04-01', employmentType: 'PERMANENT', status: 'ACTIVE_CONFIRMED', version: 3 }],
    });
    renderAt(`/hiring/employees/${E1}/origin`, [...RECRUITER, 'employee.read.operational', 'document.read.document']);
    expect(await screen.findByText('No hiring origin is recorded for this employee in the selected role’s scope.')).toBeTruthy();
    expect((await screen.findByRole('link', { name: 'Employee documents' })).getAttribute('href')).toBe(`/employees/${E1}/documents`);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('offer approvals (F1/C4: the independent eligible approver; ZT07 idempotency)', () => {
  const decision = `/v1/hiring/offer-tasks/${T1}/decision`;
  const task = (patch: Json = {}): Json => ({
    taskId: T1,
    transactionId: 'tx-1',
    assignedAt: '2026-10-24T06:00:00.000Z',
    offer: {
      ...offer({ state: 'SUBMITTED', currentRevision: 2, submittedAt: '2026-10-24T05:00:00.000Z' }),
      underReview: { revision: 2, proposedJoiningDate: '2026-12-15', currencyCode: 'INR', annualCtc: '1300000.2500', monthlyGross: null, submittedAt: '2026-10-24T05:00:00.000Z' },
      ...patch,
    },
  });
  const itemName = 'Offer to Ravi Synthetic (CAN-000002) for REQ-000001';

  it('is not permitted without the approval grant, and nothing is requested', async () => {
    serve({});
    renderQueue(['offer.read.operational']);
    expect((await screen.findByRole('note')).textContent).toContain('The selected role cannot approve offers.');
    await settle();
    expect(calls).toEqual([]);
  });

  it('shows the revision under review with the compensation as returned and approves with an idempotency key', async () => {
    let tasks = [task()];
    serve({
      'GET /v1/hiring/offer-tasks': () => [200, { items: tasks }],
      [`POST ${decision}`]: () => {
        tasks = [];
        return [200, { offerId: O1, state: 'APPROVED', replayed: false }];
      },
    });
    renderQueue(APPROVER);
    const item = await screen.findByRole('listitem', { name: itemName });
    expect(valueOf(item, 'Revision under review')).toBe('2');
    expect(valueOf(item, 'Proposed joining date')).toBe('2026-12-15');
    expect(valueOf(item, 'Annual CTC')).toBe(formatAmount('1300000.2500', 'INR'));
    expect(within(item).queryByText('Monthly gross')).toBeNull();
    expect(within(item).getByRole('link', { name: 'Open the offer to Ravi Synthetic (CAN-000002)' }).getAttribute('href')).toBe(`/hiring/offers/${O1}`);
    click(within(item).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved the offer to Ravi Synthetic (CAN-000002).')).toBeTruthy();
    const body = bodyOf('POST', decision)!;
    expect(Object.keys(body).sort()).toEqual(['decision', 'idempotencyKey']);
    expect(body.decision).toBe('APPROVE');
    expect(body.idempotencyKey).toMatch(/^offer-decision-[0-9a-f-]{36}$/);
    expect(await screen.findByText('No offers are waiting for your approval.')).toBeTruthy();
  });

  it('returning needs a reason; a retry after a lost answer reuses its key and is answered from what was recorded', async () => {
    const recorded = new Set<string>();
    let first = true;
    serve({
      'GET /v1/hiring/offer-tasks': () => [200, { items: recorded.size > 0 ? [] : [task()] }],
      [`POST ${decision}`]: (c) => {
        const key = (c.body as { idempotencyKey: string }).idempotencyKey;
        if (first) {
          // The server records the decision; the answer never arrives.
          first = false;
          recorded.add(key);
          throw new TypeError('Failed to fetch');
        }
        return recorded.has(key) ? [200, { offerId: O1, state: 'DRAFT', replayed: true }] : [409, { error: 'TASK_CLOSED', message: 'This task has already been decided' }];
      },
    });
    renderQueue(APPROVER);
    const item = await screen.findByRole('listitem', { name: itemName });
    click(within(item).getByRole('button', { name: 'Return for changes' }));
    expect(within(item).getByRole('alert').textContent).toBe('Enter a reason to return the offer for changes.');
    await settle();
    expect(callsTo('POST', decision)).toHaveLength(0);
    type(within(item).getByLabelText('Reason (required to return or reject)'), ' Synthetic: check the band ');
    click(within(item).getByRole('button', { name: 'Return for changes' }));
    expect((await within(item).findByRole('alert')).textContent).toContain('Something went wrong');
    click(within(item).getByRole('button', { name: 'Return for changes' }));
    expect(await screen.findByText('Returned the offer to Ravi Synthetic (CAN-000002) for changes: it is a draft again. Your earlier attempt had already been recorded, so nothing was applied twice.')).toBeTruthy();
    const [one, two] = callsTo('POST', decision).map((c) => c.body as Json);
    expect(one).toStrictEqual({ decision: 'RETURN', reason: 'Synthetic: check the band', idempotencyKey: two!.idempotencyKey });
    expect(two).toStrictEqual(one);
  });

  it('each new decision is a new key; a requisition no longer approved is explained in words and blocks approval', async () => {
    let requisitionState = 'APPROVED';
    serve({
      'GET /v1/hiring/offer-tasks': () => [200, { items: [task({ requisition: { ...REQ1, state: requisitionState } })] }],
      [`POST ${decision}`]: (c) => {
        const body = c.body as Json;
        if (body.decision === 'APPROVE') {
          requisitionState = 'CLOSED';
          return [409, { error: 'REQUISITION_NOT_APPROVED', message: 'The requisition is no longer approved; reject or return the offer' }];
        }
        return [200, { offerId: O1, state: 'REJECTED', replayed: false }];
      },
    });
    renderQueue(APPROVER);
    const item = await screen.findByRole('listitem', { name: itemName });
    click(within(item).getByRole('button', { name: 'Approve' }));
    expect((await within(item).findByRole('alert')).textContent).toBe('The requisition is no longer approved: return or reject the offer instead.');
    await waitFor(() => expect(disabled(within(item).getByRole('button', { name: 'Approve' }))).toBe(true));
    expect(item.textContent).toContain('The requisition is no longer approved: the offer can be returned or rejected, not approved.');
    click(within(item).getByRole('button', { name: 'Reject' }));
    expect(within(item).getByRole('alert').textContent).toBe('Enter a reason to reject the offer.');
    type(within(item).getByLabelText('Reason (required to return or reject)'), 'Synthetic: requisition closed');
    click(within(item).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Rejected the offer to Ravi Synthetic (CAN-000002).')).toBeTruthy();
    const [approve, reject] = callsTo('POST', decision).map((c) => c.body as Json);
    expect(reject).toMatchObject({ decision: 'REJECT', reason: 'Synthetic: requisition closed' });
    expect(reject!.idempotencyKey).not.toBe(approve!.idempotencyKey);
  });

  it('disables the decision buttons while a decision is in flight', async () => {
    const answer = held([200, { offerId: O1, state: 'APPROVED', replayed: false }]);
    serve({ 'GET /v1/hiring/offer-tasks': [200, { items: [task()] }], [`POST ${decision}`]: answer.handler });
    renderQueue(APPROVER);
    const item = await screen.findByRole('listitem', { name: itemName });
    const approve = within(item).getByRole('button', { name: 'Approve' });
    click(approve);
    await waitFor(() => expect(disabled(approve)).toBe(true));
    expect(disabled(within(item).getByRole('button', { name: 'Return for changes' }))).toBe(true);
    expect(disabled(within(item).getByRole('button', { name: 'Reject' }))).toBe(true);
    click(approve);
    expect(callsTo('POST', decision)).toHaveLength(1);
    act(() => answer.release());
    expect(await screen.findByText('Approved the offer to Ravi Synthetic (CAN-000002).')).toBeTruthy();
  });

  it('a task decided elsewhere leaves the queue with the reason in words; the offers screen shows the queue to the approver', async () => {
    let tasks = [task()];
    serve({
      'GET /v1/hiring/offer-tasks': () => [200, { items: tasks }],
      'GET /v1/hiring/offers': [200, { items: [] }],
      [`POST ${decision}`]: () => {
        tasks = [];
        return [409, { error: 'TASK_CLOSED', message: 'This task has already been decided' }];
      },
    });
    renderAt('/hiring/offers', APPROVER);
    const queue = await screen.findByRole('region', { name: 'Offer approvals' });
    const item = await within(queue).findByRole('listitem', { name: itemName });
    click(within(item).getByRole('button', { name: 'Approve' }));
    expect((await within(queue).findByRole('alert')).textContent).toBe('Offer to Ravi Synthetic (CAN-000002): This approval has already been decided.');
    expect(await within(queue).findByText('No offers are waiting for your approval.')).toBeTruthy();
  });
});
