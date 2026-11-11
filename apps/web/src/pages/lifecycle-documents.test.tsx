// Letters and full-and-final settlements (FR-017, FR-018, FR-052 to FR-055; BR-016; DF02; C4; ZT07), jsdom: letter
// templates with approved placeholders (create, draft against its version, publish, rename and activation), a preview
// that is labelled as such and never stored or sent, the final letter blocked while a mandatory value is missing (named),
// stored letters with their template revision and generator downloaded through their content route, restricted notes
// only when returned; settlements with the calculation reported as not configured, amounts only when the server returned
// them and the server's net amount (never a sum worked out in the browser), the preparer's lines and upload, submission,
// release eligibility worded as no payment, the review and approval queues with idempotency keys and reasons, refusal
// codes in plain words, in-flight disabling, form resets, gating by permission, the role context in the query keys and
// the exports for the navigation step. I-88: the server's calculation of a draft (its items, what blocks approval and the
// basis of each), calculated and entered lines apart, entered lines with their reason, the notice recovery waiver and the
// approver's refusal naming every blocker. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIFECYCLE_DOCUMENTS_ESS_PANELS, LIFECYCLE_DOCUMENTS_SCREENS, LIFECYCLE_DOCUMENTS_TASK_QUEUES } from './lifecycle-documents';

// The selected company and role assignment as the session stores them, and the signed-in user and their linked
// employee as GET /v1/me/context returns them; tests change the assignment to model a role switch.
const session = vi.hoisted(() => ({
  permissions: [] as string[],
  companyId: 'c0000000-0000-4000-8000-000000000001',
  assignmentId: 'a0000000-0000-4000-8000-000000000001',
  userId: 'b0000000-0000-4000-8000-000000000001',
  employeeId: null as string | null,
}));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: session.companyId, assignmentId: session.assignmentId },
    me: {
      userId: session.userId,
      accountKey: 'syn.hr',
      companyName: 'Synthetic Co',
      roleCode: 'HR_ADMINISTRATOR',
      roleName: 'HR Administrator',
      scopeKind: 'COMPANY',
      employeeId: session.employeeId,
      displayName: 'Synthetic HR',
    },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

const TEMPLATE_READ = 'letter_template.read.operational';
const TEMPLATE_MANAGE = 'letter_template.manage.operational';
const LETTER_GENERATE = 'letter.generate.letter';
const LETTER_READ = 'letter.read.letter';
const NOTE_READ = 'employee_note.read.restricted';
const PROCESS_READ = 'employee_process.read.operational';
const EMPLOYEE_LIST = 'employee.list.operational';
const EMPLOYEE_READ = 'employee.read.operational';
const EXIT_READ = 'exit.read.operational';
const SETTLEMENT_READ = 'settlement.read.operational';
const SETTLEMENT_AMOUNT = 'settlement.read.amount';
const SETTLEMENT_EXPORT = 'settlement.export.amount';
const SETTLEMENT_PREPARE = 'settlement.prepare.amount';
const SETTLEMENT_REVIEW = 'settlement.review.amount';
const SETTLEMENT_APPROVE = 'settlement.approve.amount';
const SETTLEMENT_RELEASE = 'settlement.release.amount';

/** An HR Administrator assignment with the letter grants (approved per assignment). */
const HR_LETTERS = [TEMPLATE_READ, TEMPLATE_MANAGE, LETTER_GENERATE, LETTER_READ, PROCESS_READ, EMPLOYEE_LIST, EMPLOYEE_READ];
const PREPARER = [SETTLEMENT_READ, SETTLEMENT_AMOUNT, SETTLEMENT_PREPARE, EXIT_READ];
const REVIEWER = [SETTLEMENT_READ, SETTLEMENT_AMOUNT, SETTLEMENT_REVIEW];

const ASSIGNMENT_HR = session.assignmentId;
const ASSIGNMENT_OTHER = 'a0000000-0000-4000-8000-000000000002';
const U_ME = session.userId;
const U_OTHER = 'b0000000-0000-4000-8000-000000000002';
const E_ASHA = '20000000-0000-4000-8000-000000000001';
const E_RAVI = '20000000-0000-4000-8000-000000000002';
const P_EXIT = '30000000-0000-4000-8000-000000000001';
const P_TRANSFER = '30000000-0000-4000-8000-000000000002';
const T_RELIEVING = '40000000-0000-4000-8000-000000000001';
const T_EXPERIENCE = '40000000-0000-4000-8000-000000000002';
const T_OFFER = '40000000-0000-4000-8000-000000000003';
const T_NEW = '40000000-0000-4000-8000-000000000004';
const O_FIRST = '50000000-0000-4000-8000-000000000001';
const O_SECOND = '50000000-0000-4000-8000-000000000002';
const S_DRAFT = '60000000-0000-4000-8000-000000000001';
const S_APPROVED = '60000000-0000-4000-8000-000000000002';
const S_ELIGIBLE = '60000000-0000-4000-8000-000000000003';
const S_SUBMITTED = '60000000-0000-4000-8000-000000000004';
const S_REVIEWED = '60000000-0000-4000-8000-000000000005';
const X_ASHA = '70000000-0000-4000-8000-000000000001';
const K_REVIEW = '80000000-0000-4000-8000-000000000001';
const K_APPROVAL = '80000000-0000-4000-8000-000000000002';
const N_WARNING = '90000000-0000-4000-8000-000000000001';
const N_NOTE = '90000000-0000-4000-8000-000000000002';

type Json = Record<string, unknown>;

// ---- Letters ----
const PLACEHOLDERS = [
  { key: 'employeeCode', source: 'EMPLOYEE', label: 'Employee code' },
  { key: 'employeeName', source: 'EMPLOYEE', label: 'Employee name' },
  { key: 'designation', source: 'EMPLOYEE', label: 'Designation' },
  { key: 'companyName', source: 'COMPANY', label: 'Company name' },
  { key: 'lastWorkingDate', source: 'EXIT', label: 'Approved last working date (inclusive)' },
  { key: 'letterDate', source: 'LETTER', label: 'Letter date' },
];

const TEMPLATES = [
  { id: T_RELIEVING, code: 'RELIEVING', name: 'Relieving letter (synthetic)', letterType: 'RELIEVING', active: true, version: 3, publishedRevision: 2, draftRevision: null },
  { id: T_EXPERIENCE, code: 'EXPERIENCE', name: 'Experience letter (synthetic)', letterType: 'EXPERIENCE', active: false, version: 2, publishedRevision: 1, draftRevision: null },
  { id: T_OFFER, code: 'OFFER_STD', name: 'Offer letter (synthetic)', letterType: 'OFFER', active: true, version: 1, publishedRevision: null, draftRevision: 1 },
];

const OFFER_BODY = 'Dear {{employeeName}},\nWe offer you the role of {{designation}} at {{companyName}}.';
const offerRevision = (patch: Json = {}): Json => ({
  revision: 1,
  state: 'DRAFT',
  body: OFFER_BODY,
  placeholders: ['companyName', 'designation', 'employeeName'],
  optionalPlaceholders: ['designation'],
  publishedAt: null,
  version: 2,
  ...patch,
});
const offerDetail = (revisions: Json[] = [offerRevision()], patch: Json = {}): Json => ({
  id: T_OFFER,
  code: 'OFFER_STD',
  name: 'Offer letter (synthetic)',
  letterType: 'OFFER',
  active: true,
  version: 1,
  revisions,
  ...patch,
});
const RELIEVING_BODY = 'Dear {{employeeName}}, you served {{companyName}} until {{lastWorkingDate}}.';
const relievingDetail = (patch: Json = {}): Json => ({
  id: T_RELIEVING,
  code: 'RELIEVING',
  name: 'Relieving letter (synthetic)',
  letterType: 'RELIEVING',
  active: true,
  version: 4,
  revisions: [
    { revision: 1, state: 'RETIRED', body: 'Dear {{employeeName}}.', placeholders: ['employeeName'], optionalPlaceholders: [], publishedAt: '2026-09-01T06:00:00.000Z', version: 3 },
    {
      revision: 2,
      state: 'PUBLISHED',
      body: RELIEVING_BODY,
      placeholders: ['companyName', 'employeeName', 'lastWorkingDate'],
      optionalPlaceholders: [],
      publishedAt: '2026-10-01T06:00:00.000Z',
      version: 2,
    },
  ],
  ...patch,
});

const PROCESS = {
  id: P_EXIT,
  employeeId: E_ASHA,
  employeeCode: 'SYN-301',
  employeeName: 'Asha Synthetic',
  processId: '31000000-0000-4000-8000-000000000001',
  processCode: 'EXIT_CLEAR',
  processName: 'Exit clearance (synthetic)',
  processType: 'EXIT',
  revision: 1,
  state: 'OPEN',
  effectiveDate: '2026-10-20',
  ownerUserId: U_ME,
  exitCaseId: X_ASHA,
  closedAt: null,
  cancelledAt: null,
  reopenCount: 0,
  createdAt: '2026-10-20T05:00:00.000Z',
  version: 1,
  counts: { total: 1, open: 1, requiredOpen: 1, overdue: 0 },
  tasks: [],
  history: [],
};
const PROCESSES = [
  { id: P_EXIT, processCode: 'EXIT_CLEAR', processName: 'Exit clearance (synthetic)', processType: 'EXIT', revision: 1, state: 'OPEN', effectiveDate: '2026-10-20', exitCaseId: X_ASHA, version: 1 },
  { id: P_TRANSFER, processCode: 'TRANSFER_STD', processName: 'Transfer (synthetic)', processType: 'TRANSFER', revision: 1, state: 'CANCELLED', effectiveDate: '2026-09-01', exitCaseId: null, version: 3 },
];

const PREVIEW_TEXT = 'Dear Asha Synthetic, you served Synthetic Co until 2026-10-31.';
const PREVIEW_MISSING = { templateCode: 'RELIEVING', templateRevision: 2, text: 'Dear Asha Synthetic, you served Synthetic Co until .', missing: ['lastWorkingDate'], ready: false, sent: false };
const PREVIEW_READY = { templateCode: 'RELIEVING', templateRevision: 2, text: PREVIEW_TEXT, missing: [], ready: true, sent: false };
const GENERATED = {
  id: O_FIRST,
  templateCode: 'RELIEVING',
  templateRevision: 2,
  outputNumber: 1,
  generatedAt: '2026-10-26T06:30:00.000Z',
  generatedBy: U_ME,
  checksum: 'a'.repeat(64),
  byteSize: 64,
  deliveryState: 'NOT_SENT',
};
const OUTPUTS = [
  {
    id: O_SECOND,
    processId: P_EXIT,
    templateCode: 'RELIEVING',
    templateRevision: 2,
    outputNumber: 2,
    generatedAt: '2026-10-25T09:00:00.000Z',
    generatedBy: U_OTHER,
    checksum: 'b'.repeat(64),
    byteSize: 120,
    deliveryState: 'NOT_SENT',
  },
  {
    id: O_FIRST,
    processId: P_EXIT,
    templateCode: 'RELIEVING',
    templateRevision: 1,
    outputNumber: 1,
    generatedAt: '2026-10-24T09:00:00.000Z',
    generatedBy: U_ME,
    checksum: 'c'.repeat(64),
    byteSize: 118,
    deliveryState: 'NOT_SENT',
  },
];
const ASHA = { id: E_ASHA, employeeCode: 'SYN-301', displayName: 'Asha Synthetic', status: 'NOTICE' };
const NOTES = [
  {
    id: N_WARNING,
    kind: 'WARNING',
    body: 'Synthetic warning about late asset returns',
    exitCaseId: X_ASHA,
    processId: null,
    supersedesNoteId: null,
    supersededByNoteId: null,
    createdBy: U_OTHER,
    createdAt: '2026-10-22T08:00:00.000Z',
  },
  // A note whose text did not come back: nothing is shown for it beyond what was returned.
  { id: N_NOTE, kind: 'NOTE', exitCaseId: null, processId: P_EXIT, supersedesNoteId: null, supersededByNoteId: null, createdBy: U_OTHER, createdAt: '2026-10-21T08:00:00.000Z' },
];

// ---- Settlements ----
const CALCULATION = {
  status: 'NOT_CONFIGURED',
  reason:
    'Full-and-final calculation needs actual approved policy and rate packs (F1, DF05: no gratuity, encashment, notice or tax rule is assumed). None is configured, so settlement lines are entered or uploaded and independently reviewed.',
};
const LINES = [
  { componentCode: 'BASIC', componentName: 'Basic pay (synthetic)', componentKind: 'EARNING', amount: '50000.0000', lineKind: 'STANDARD', source: 'ENTERED' },
  { componentCode: 'LEAVE_ENC', componentName: 'Leave encashment (synthetic)', componentKind: 'EARNING', amount: '12345.6789', lineKind: 'STANDARD', source: 'UPLOADED' },
  { componentCode: 'LOAN', componentName: 'Loan recovery (synthetic)', componentKind: 'DEDUCTION', amount: '-10000.5000', lineKind: 'STANDARD', source: 'COPIED' },
];
const AMOUNTS = { netAmount: '52345.1789', lines: LINES };

/** A settlement as GET /v1/settlements/:id answers; `amounts` null models a caller without the amount group. */
function settlement(id: string, patch: Json = {}, amounts: { netAmount: string; lines: Json[] } | null = AMOUNTS): Json {
  return {
    id,
    exitCaseId: X_ASHA,
    employeeId: E_ASHA,
    employeeCode: 'SYN-301',
    employeeName: 'Asha Synthetic',
    revision: 1,
    state: 'DRAFT',
    currencyCode: 'INR',
    calculationStatus: 'NOT_CONFIGURED',
    supersedesSettlementId: null,
    preparedBy: U_ME,
    paymentStatus: 'NOT_TRACKED',
    ...(amounts ?? {}),
    submittedAt: null,
    reviewedAt: null,
    approvedAt: null,
    releaseEligibleAt: null,
    createdAt: '2026-10-25T05:00:00.000Z',
    decisions: [],
    version: 5,
    ...patch,
  };
}
/** A settlement as the list answers it (no lines; the net amount only with the amount group). */
function summary(id: string, patch: Json = {}, withAmount = false): Json {
  return {
    id,
    exitCaseId: X_ASHA,
    employeeId: E_ASHA,
    employeeCode: 'SYN-301',
    employeeName: 'Asha Synthetic',
    revision: 1,
    state: 'DRAFT',
    currencyCode: 'INR',
    calculationStatus: 'NOT_CONFIGURED',
    ...(withAmount ? { netAmount: '52345.1789' } : {}),
    version: 5,
    ...patch,
  };
}
const APPROVED = settlement(S_APPROVED, {
  revision: 2,
  state: 'APPROVED',
  preparedBy: U_OTHER,
  supersedesSettlementId: S_SUBMITTED,
  submittedAt: '2026-10-24T10:00:00.000Z',
  reviewedAt: '2026-10-25T10:00:00.000Z',
  approvedAt: '2026-10-26T04:00:00.000Z',
  decisions: [
    // access-4 follow-up: the review was decided by a delegate for the reviewer; the approver has no employee record.
    {
      transactionId: 'd1000000-0000-4000-8000-000000000001',
      step: 1,
      action: 'review',
      decision: 'APPROVE',
      decidedAt: '2026-10-25T10:00:00.000Z',
      decidedBy: { userId: 'b0000000-0000-4000-8000-000000000010', employeeCode: 'SYN-010', displayName: 'Dev Delegate' },
      onBehalfOf: { userId: 'b0000000-0000-4000-8000-000000000009', employeeCode: 'SYN-009', displayName: 'Mira Manager' },
    },
    {
      transactionId: 'd1000000-0000-4000-8000-000000000002',
      step: 1,
      action: 'approve',
      decision: 'APPROVE',
      decidedAt: '2026-10-26T04:00:00.000Z',
      decidedBy: { userId: 'b0000000-0000-4000-8000-000000000011', employeeCode: null, displayName: null },
      onBehalfOf: null,
    },
  ],
  version: 7,
});
const REVIEW_TASK = {
  taskId: K_REVIEW,
  kind: 'settlement',
  step: 'review',
  settlement: settlement(S_SUBMITTED, {
    employeeId: E_RAVI,
    employeeCode: 'SYN-302',
    employeeName: 'Ravi Synthetic',
    state: 'SUBMITTED',
    preparedBy: U_OTHER,
    submittedAt: '2026-10-25T10:00:00.000Z',
    version: 6,
  }),
};
const APPROVAL_TASK = {
  taskId: K_APPROVAL,
  kind: 'settlement_approval',
  step: 'approve',
  settlement: settlement(S_REVIEWED, { revision: 2, state: 'REVIEWED', preparedBy: U_OTHER, submittedAt: '2026-10-24T10:00:00.000Z', reviewedAt: '2026-10-25T10:00:00.000Z' }),
};
const EXIT = {
  id: X_ASHA,
  employeeId: E_ASHA,
  employeeCode: 'SYN-301',
  employeeName: 'Asha Synthetic',
  state: 'APPROVED',
  separationType: 'RESIGNATION',
  requestDate: '2026-10-01',
  proposedLastWorkingDate: '2026-10-31',
  recommendedLastWorkingDate: '2026-10-31',
  approvedLastWorkingDate: '2026-10-31',
  lastWorkingDate: '2026-10-31',
  noticePeriod: { status: 'RECORDED', contractualNoticeDays: 30 },
  employeeMessage: null,
  released: false,
  releasedAt: null,
  submittedAt: '2026-10-01T05:00:00.000Z',
  version: 4,
};
const STALE = { error: 'STALE_VERSION', message: 'The record changed; reload and retry' };

// ---- The fetch stub ----
interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: unknown;
}
/** A JSON reply, or a Response (a downloaded file). */
type Reply = [status: number, body: unknown] | Response;
/** A fixed reply, or a handler that sees the request; a handler may hold its reply back (a promise) or throw (a lost answer). */
type Route = Reply | ((call: Call) => Reply | Promise<Reply>);

let calls: Call[] = [];
const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const bodyOf = (method: string, path: string, index = 0) => callsTo(method, path)[index]?.body;

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
      const reply: Reply = route === undefined ? [404, { error: 'NOT_FOUND', message: `No mock for ${call.method} ${call.path}` }] : typeof route === 'function' ? await route(call) : route;
      if (reply instanceof Response) return reply;
      const [status, body] = reply;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}

/** A promise the test opens when it wants a held answer to arrive. */
function gate() {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

const textFile = (text: string, type = 'text/plain', name = 'letter.txt') => () =>
  new Response(text, { status: 200, headers: { 'content-type': type, 'content-disposition': `attachment; filename="${name}"` } });

/** jsdom has no object URLs: a downloaded file is "saved" through a click on a link to one, counted here. */
function stubDownloads() {
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = vi.fn(() => 'blob:synthetic-letter');
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

const testClient = (staleTime = 0) => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime }, mutations: { retry: false } } });

/** Every exported screen under its own path, as the navigation step will mount them. */
function renderAt(path: string, permissions: string[], options: { client?: QueryClient; employeeId?: string | null; assignmentId?: string } = {}) {
  session.permissions = permissions;
  session.employeeId = options.employeeId ?? null;
  session.assignmentId = options.assignmentId ?? ASSIGNMENT_HR;
  return render(
    <QueryClientProvider client={options.client ?? testClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {LIFECYCLE_DOCUMENTS_SCREENS.map((s) => (
            <Route key={s.path} path={s.path} element={<s.component />} />
          ))}
          <Route path="*" element={<p>Somewhere else</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** One of the exported decision queues, as the Decision inbox will mount it. */
function renderQueue(index: number, permissions: string[], employeeId: string | null = null) {
  session.permissions = permissions;
  session.employeeId = employeeId;
  session.assignmentId = ASSIGNMENT_HR;
  const Queue = LIFECYCLE_DOCUMENTS_TASK_QUEUES[index]!.component;
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
/** The value next to a term of a definition list. */
const term = (scope: HTMLElement, name: string) => within(scope).getByText(name, { selector: 'dt' }).nextElementSibling?.textContent;
const findSection = async (title: string | RegExp) => (await screen.findByRole('heading', { name: title })).closest('section') as HTMLElement;
const button = (scope: HTMLElement, name: string | RegExp) => within(scope).getByRole('button', { name }) as HTMLButtonElement;
/** An instant as the page shows it: the viewer's local date and time. */
function localTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Lets any request a click might have started reach the fetch stub before asserting that none was made. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('exports for the navigation step', () => {
  it('exports the screens with their paths, titles, permissions and menu entries, no ESS panel, and the two decision queues', () => {
    expect(LIFECYCLE_DOCUMENTS_SCREENS.map((s) => [s.path, s.title, s.permission, s.nav])).toEqual([
      ['/lifecycle/letter-templates', 'Letter templates', TEMPLATE_READ, true],
      ['/lifecycle/letter-templates/:id', 'Letter template', TEMPLATE_READ, false],
      ['/lifecycle/letters', 'Letters', LETTER_READ, true],
      ['/lifecycle/employees/:id/letters', 'Employee letters', LETTER_READ, false],
      ['/lifecycle/processes/:id/letters', 'Process letters', LETTER_GENERATE, false],
      ['/lifecycle/settlements', 'Full and final settlements', SETTLEMENT_READ, true],
      ['/lifecycle/exits/:id/settlements', 'Exit settlements', SETTLEMENT_READ, false],
      ['/lifecycle/settlements/:id', 'Settlement', SETTLEMENT_READ, false],
    ]);
    expect(LIFECYCLE_DOCUMENTS_SCREENS.every((s) => typeof s.component === 'function')).toBe(true);
    // H3 has no letter or settlement tab (TN01 to TN18), and one's own letters and settlement are refused anyway.
    expect(LIFECYCLE_DOCUMENTS_ESS_PANELS).toEqual([]);
    expect(LIFECYCLE_DOCUMENTS_TASK_QUEUES.map((q) => [q.permission, q.title])).toEqual([
      [SETTLEMENT_REVIEW, 'Settlement reviews'],
      [SETTLEMENT_APPROVE, 'Settlement approvals'],
    ]);
    expect(LIFECYCLE_DOCUMENTS_TASK_QUEUES.every((q) => typeof q.component === 'function')).toBe(true);
  });

  it('a detail screen reached with an address that is not a record id asks for nothing', async () => {
    serve({});
    renderAt('/lifecycle/settlements/not-an-id', [SETTLEMENT_READ]);
    expect(await screen.findByText('This address does not name a settlement.')).toBeTruthy();
    await settle();
    expect(calls).toEqual([]);
  });
});

describe('letter templates (FR-017)', () => {
  const listRoutes = (overrides: Record<string, Route> = {}): Record<string, Route> => ({
    'GET /v1/letter-templates': [200, { items: TEMPLATES }],
    'GET /v1/letter-placeholders': [200, { items: PLACEHOLDERS }],
    ...overrides,
  });

  it('shows nothing of the templates without the read duty, and no new-template form without the manage duty', async () => {
    serve(listRoutes());
    const view = renderAt('/lifecycle/letter-templates', []);
    expect((await screen.findByRole('note')).textContent).toContain('The selected role cannot view letter templates.');
    expect(screen.queryByRole('form', { name: 'New letter template' })).toBeNull();
    await settle();
    expect(calls).toEqual([]);
    view.unmount();

    renderAt('/lifecycle/letter-templates', [TEMPLATE_READ]);
    const table = await screen.findByRole('table', { name: 'Letter templates' });
    expect(rows(table).map(cells)).toEqual([
      ['RELIEVING', 'Relieving letter (synthetic)', 'Relieving letter', 'Active', '2', 'None', 'Yes, revision 2', 'Open'],
      ['EXPERIENCE', 'Experience letter (synthetic)', 'Experience letter', 'Inactive', '1', 'None', 'No: inactive', 'Open'],
      ['OFFER_STD', 'Offer letter (synthetic)', 'Offer letter', 'Active', 'None', '1', 'No: nothing published yet', 'Open'],
    ]);
    expect(within(table).getByRole('link', { name: 'Open template OFFER_STD' }).getAttribute('href')).toBe(`/lifecycle/letter-templates/${T_OFFER}`);
    expect(screen.queryByRole('form', { name: 'New letter template' })).toBeNull();
    const reference = await screen.findByRole('table', { name: 'Approved placeholders' });
    expect(cells(rows(reference)[4]!)).toEqual(['{{lastWorkingDate}}', 'Approved last working date (inclusive)', 'Approved exit']);
  });

  it('creates a template with the placeholders its text uses, the optional ones marked, and starts the form clean', async () => {
    const answer = gate();
    const body = 'Dear {{employeeName}},\nyour last working day is {{ lastWorkingDate }} as {{designation}}.';
    serve(
      listRoutes({
        'POST /v1/letter-templates': async () => {
          await answer.promise;
          return [201, { id: T_NEW, code: 'RELIEVING_STD', name: 'Standard relieving letter (synthetic)', letterType: 'RELIEVING', active: true, version: 1, revisions: [] }];
        },
      }),
    );
    renderAt('/lifecycle/letter-templates', [TEMPLATE_READ, TEMPLATE_MANAGE]);
    const form = await screen.findByRole('form', { name: 'New letter template' });
    const code = within(form).getByLabelText('Template code (required)') as HTMLInputElement;
    fireEvent.change(code, { target: { value: 'relieving_std' } });
    fireEvent.change(within(form).getByLabelText('Name (required)'), { target: { value: 'Standard relieving letter (synthetic)' } });
    fireEvent.change(within(form).getByLabelText('Letter type (required)'), { target: { value: 'relieving' } });
    fireEvent.change(within(form).getByLabelText('Letter text (required)'), { target: { value: body } });
    expect(code.value).toBe('RELIEVING_STD');
    // Every placeholder the text uses is mandatory unless marked optional.
    fireEvent.click(await within(form).findByLabelText('Designation ({{designation}}) optional'));
    expect((within(form).getByLabelText('Approved last working date (inclusive) ({{lastWorkingDate}}) optional') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(button(form, 'Create template'));
    await waitFor(() => expect(callsTo('POST', '/v1/letter-templates')).toHaveLength(1));
    expect(bodyOf('POST', '/v1/letter-templates')).toEqual({
      code: 'RELIEVING_STD',
      name: 'Standard relieving letter (synthetic)',
      letterType: 'RELIEVING',
      body,
      optionalPlaceholders: ['designation'],
    });
    // While it is on its way, nothing more can be sent.
    expect(button(form, 'Create template').disabled).toBe(true);
    fireEvent.click(button(form, 'Create template'));
    answer.open();
    const status = await within(form).findByRole('status');
    expect(status.textContent).toBe('Template RELIEVING_STD created as draft revision 1. Open template RELIEVING_STD to publish it.');
    expect(within(status).getByRole('link', { name: 'Open template RELIEVING_STD' }).getAttribute('href')).toBe(`/lifecycle/letter-templates/${T_NEW}`);
    expect(callsTo('POST', '/v1/letter-templates')).toHaveLength(1);
    // The form starts clean, and the list is loaded again.
    expect(code.value).toBe('');
    expect((within(form).getByLabelText('Name (required)') as HTMLInputElement).value).toBe('');
    expect((within(form).getByLabelText('Letter type (required)') as HTMLInputElement).value).toBe('');
    expect((within(form).getByLabelText('Letter text (required)') as HTMLTextAreaElement).value).toBe('');
    await waitFor(() => expect(callsTo('GET', '/v1/letter-templates').length).toBeGreaterThan(1));
  });

  it('says a refused template in plain words and keeps what was typed', async () => {
    serve(
      listRoutes({
        'POST /v1/letter-templates': [422, { error: 'UNKNOWN_PLACEHOLDER', message: 'Only approved placeholders may be used', details: { placeholders: ['salary'] } }],
      }),
    );
    renderAt('/lifecycle/letter-templates', [TEMPLATE_READ, TEMPLATE_MANAGE]);
    const form = await screen.findByRole('form', { name: 'New letter template' });
    fireEvent.change(within(form).getByLabelText('Template code (required)'), { target: { value: 'PAY_NOTE' } });
    fireEvent.change(within(form).getByLabelText('Name (required)'), { target: { value: 'Pay note (synthetic)' } });
    fireEvent.change(within(form).getByLabelText('Letter type (required)'), { target: { value: 'OFFER' } });
    fireEvent.change(within(form).getByLabelText('Letter text (required)'), { target: { value: 'Pay: {{salary}} for {{employeeName}}' } });
    // The text is checked against the approved list as it is typed; the server decides.
    expect(await within(form).findByText('{{salary}} is not an approved placeholder')).toBeTruthy();
    fireEvent.click(button(form, 'Create template'));
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toContain('Only approved placeholders may be used. Not approved: {{salary}}.');
    expect(alert.textContent).toContain('UNKNOWN_PLACEHOLDER');
    expect((within(form).getByLabelText('Template code (required)') as HTMLInputElement).value).toBe('PAY_NOTE');
    expect((within(form).getByLabelText('Letter text (required)') as HTMLTextAreaElement).value).toBe('Pay: {{salary}} for {{employeeName}}');
  });

  it('inserts an approved placeholder into the letter text', async () => {
    serve(listRoutes());
    renderAt('/lifecycle/letter-templates', [TEMPLATE_READ, TEMPLATE_MANAGE]);
    const form = await screen.findByRole('form', { name: 'New letter template' });
    const text = within(form).getByLabelText('Letter text (required)') as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: 'Dear ' } });
    fireEvent.change(await within(form).findByLabelText('Placeholder to insert'), { target: { value: 'employeeName' } });
    fireEvent.click(button(form, 'Insert placeholder'));
    expect(text.value).toBe('Dear {{employeeName}}');
    expect(within(form).getByLabelText('Employee name ({{employeeName}}) optional')).toBeTruthy();
  });

  it('FR-017 lists the placeholders of the chosen letter type (OFFER has the offer placeholders)', async () => {
    const OFFER_PLACEHOLDERS = [
      { key: 'candidateName', source: 'OFFER', label: 'Candidate name' },
      { key: 'annualCtc', source: 'OFFER', label: 'Annual CTC (approved offer)' },
      { key: 'companyName', source: 'COMPANY', label: 'Company name' },
    ];
    const OFFER_NOTE = 'An offer letter is issued from the approved offer in Hiring, not from an employee process.';
    const byType = (c: Call): Reply => [200, { items: c.params.get('letterType') === 'OFFER' ? OFFER_PLACEHOLDERS : PLACEHOLDERS }];
    serve(listRoutes({ 'GET /v1/letter-placeholders': byType, [`GET /v1/letter-templates/${T_OFFER}`]: [200, offerDetail()] }));
    const view = renderAt('/lifecycle/letter-templates', [TEMPLATE_READ, TEMPLATE_MANAGE]);
    const form = await screen.findByRole('form', { name: 'New letter template' });
    fireEvent.change(within(form).getByLabelText('Letter text (required)'), { target: { value: 'Dear {{candidateName}}, {{employeeName}}' } });
    // No letter type chosen yet: the employee letters' placeholders.
    expect(await within(form).findByText('{{candidateName}} is not an approved placeholder')).toBeTruthy();
    expect(form.textContent).not.toContain(OFFER_NOTE);

    fireEvent.change(within(form).getByLabelText('Letter type (required)'), { target: { value: 'offer' } });
    expect(await within(form).findByText('{{employeeName}} is not an approved placeholder')).toBeTruthy();
    expect(within(form).getByLabelText('Candidate name ({{candidateName}}) optional')).toBeTruthy();
    const insert = within(form).getByLabelText('Placeholder to insert') as HTMLSelectElement;
    expect([...insert.options].map((o) => o.value)).toEqual(['', 'candidateName', 'annualCtc', 'companyName']);
    expect(form.textContent).toContain(OFFER_NOTE);
    expect(callsTo('GET', '/v1/letter-placeholders').map((c) => c.params.get('letterType'))).toContain('OFFER');
    // The reference list stays the employee letters' one.
    expect(cells(rows(await screen.findByRole('table', { name: 'Approved placeholders' }))[0]!)[0]).toBe('{{employeeCode}}');

    // Another type: the employee letters' placeholders again, and no offer note.
    fireEvent.change(within(form).getByLabelText('Letter type (required)'), { target: { value: 'RELIEVING' } });
    expect(await within(form).findByText('{{candidateName}} is not an approved placeholder')).toBeTruthy();
    expect(form.textContent).not.toContain(OFFER_NOTE);
    view.unmount();

    // An opened OFFER template: its editor asks for the offer placeholders, and says where an offer letter is issued.
    renderAt(`/lifecycle/letter-templates/${T_OFFER}`, [TEMPLATE_READ, TEMPLATE_MANAGE]);
    const draft = await screen.findByRole('form', { name: 'Draft revision 1' });
    expect(await within(draft).findByText('{{designation}} is not an approved placeholder')).toBeTruthy();
    expect((await findSection('Template')).textContent).toContain(OFFER_NOTE);
    expect(callsTo('GET', '/v1/letter-placeholders').at(-1)!.params.get('letterType')).toBe('OFFER');
  });
});

describe('one letter template (FR-017)', () => {
  it('saves the draft against its version and publishes the saved draft, never unsaved changes; then opens the next revision', async () => {
    let detail = offerDetail();
    serve({
      [`GET /v1/letter-templates/${T_OFFER}`]: () => [200, detail],
      'GET /v1/letter-templates': [200, { items: TEMPLATES }],
      'GET /v1/letter-placeholders': [200, { items: PLACEHOLDERS }],
      [`PUT /v1/letter-templates/${T_OFFER}/draft`]: (c) => {
        const b = c.body as { body: string; optionalPlaceholders: string[] };
        const revisions = detail.revisions as Json[];
        const draft = revisions.find((r) => r.state === 'DRAFT');
        detail = offerDetail(
          draft
            ? revisions.map((r) => (r === draft ? { ...r, body: b.body, optionalPlaceholders: b.optionalPlaceholders, version: (r.version as number) + 1 } : r))
            : [...revisions, offerRevision({ revision: 2, body: b.body, optionalPlaceholders: b.optionalPlaceholders, version: 1 })],
        );
        return [200, detail];
      },
      [`POST /v1/letter-templates/${T_OFFER}/publish`]: () => {
        detail = offerDetail((detail.revisions as Json[]).map((r) => ({ ...r, state: 'PUBLISHED', publishedAt: '2026-10-26T07:00:00.000Z', version: 4 })));
        return [200, detail];
      },
    });
    renderAt(`/lifecycle/letter-templates/${T_OFFER}`, [TEMPLATE_READ, TEMPLATE_MANAGE]);
    expect(await screen.findByRole('heading', { name: 'Letter template OFFER_STD' })).toBeTruthy();
    const revisions = await screen.findByRole('table', { name: 'Revisions' });
    expect(rows(revisions).map((r) => cells(r).slice(0, 5))).toEqual([['1', 'Draft', '{{companyName}}, {{employeeName}}', '{{designation}}', '—']]);
    const form = screen.getByRole('form', { name: 'Draft revision 1' });
    const text = within(form).getByLabelText('Letter text (required)') as HTMLTextAreaElement;
    expect(text.value).toBe(OFFER_BODY);
    expect((within(form).getByLabelText('Designation ({{designation}}) optional') as HTMLInputElement).checked).toBe(true);
    const publish = () => screen.getByRole('button', { name: 'Publish revision 1' }) as HTMLButtonElement;
    expect(publish().disabled).toBe(false);

    const edited = `${OFFER_BODY}\nIssued on {{letterDate}}.`;
    fireEvent.change(text, { target: { value: edited } });
    // Unsaved changes would not be in what is published.
    expect(publish().disabled).toBe(true);
    expect(screen.getByText('Save the draft first: publishing publishes the saved text, not unsaved changes.')).toBeTruthy();
    fireEvent.click(button(form, 'Save draft'));
    await waitFor(() => expect(callsTo('PUT', `/v1/letter-templates/${T_OFFER}/draft`)).toHaveLength(1));
    expect(bodyOf('PUT', `/v1/letter-templates/${T_OFFER}/draft`)).toEqual({ body: edited, optionalPlaceholders: ['designation'], expectedVersion: 2 });
    expect(await screen.findByText('Draft revision 1 is saved. Publish it for new letters to use it.')).toBeTruthy();
    await waitFor(() => expect(publish().disabled).toBe(false));

    fireEvent.click(publish());
    await waitFor(() => expect(callsTo('POST', `/v1/letter-templates/${T_OFFER}/publish`)).toHaveLength(1));
    expect(bodyOf('POST', `/v1/letter-templates/${T_OFFER}/publish`)).toEqual({ revision: 1, expectedVersion: 3 });
    expect(await screen.findByText('Revision 1 is published: new letters use it, and letters already generated keep the revision they were made from.')).toBeTruthy();

    // With no draft, saving opens the next revision from the published text; there is no draft version to send.
    const next = await screen.findByRole('form', { name: 'Next revision' });
    expect((within(next).getByLabelText('Letter text (required)') as HTMLTextAreaElement).value).toBe(edited);
    fireEvent.click(button(next, 'Save as a new draft'));
    await waitFor(() => expect(callsTo('PUT', `/v1/letter-templates/${T_OFFER}/draft`)).toHaveLength(2));
    expect(bodyOf('PUT', `/v1/letter-templates/${T_OFFER}/draft`, 1)).toEqual({ body: edited, optionalPlaceholders: ['designation'] });
    expect(await screen.findByRole('form', { name: 'Draft revision 2' })).toBeTruthy();
  });

  it('says in words why a relieving or experience template cannot be published without the employment period (FR-055)', async () => {
    serve({
      [`GET /v1/letter-templates/${T_OFFER}`]: () => [200, offerDetail()],
      'GET /v1/letter-templates': [200, { items: TEMPLATES }],
      'GET /v1/letter-placeholders': [200, { items: PLACEHOLDERS }],
      [`POST /v1/letter-templates/${T_OFFER}/publish`]: [422, { error: 'EMPLOYMENT_PERIOD_REQUIRED', message: 'A relieving or experience letter must show the employment period', details: { placeholders: ['joiningDate', 'lastWorkingDate'] } }],
    });
    renderAt(`/lifecycle/letter-templates/${T_OFFER}`, [TEMPLATE_READ, TEMPLATE_MANAGE]);
    fireEvent.click(await screen.findByRole('button', { name: 'Publish revision 1' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('must show the employment period, so these placeholders must be in the text and not optional: {{joiningDate}}, {{lastWorkingDate}}.');
    // Refused, so nothing says it was published.
    expect(screen.queryByText(/is published: new letters use it/)).toBeNull();
  });

  it('deactivates and renames the template against its version; a stale version is said in words, reloaded, and what was typed kept', async () => {
    let version = 4;
    let active = true;
    serve({
      [`GET /v1/letter-templates/${T_RELIEVING}`]: () => [200, relievingDetail({ version, active })],
      'GET /v1/letter-placeholders': [200, { items: PLACEHOLDERS }],
      [`PATCH /v1/letter-templates/${T_RELIEVING}`]: (c) => {
        const b = c.body as { name?: string; active?: boolean };
        if (b.name !== undefined) return [409, STALE];
        version += 1;
        active = b.active ?? active;
        return [200, relievingDetail({ version, active })];
      },
    });
    renderAt(`/lifecycle/letter-templates/${T_RELIEVING}`, [TEMPLATE_READ, TEMPLATE_MANAGE]);
    const settings = await findSection('Name and status');
    fireEvent.click(button(settings, 'Deactivate template'));
    await waitFor(() => expect(callsTo('PATCH', `/v1/letter-templates/${T_RELIEVING}`)).toHaveLength(1));
    expect(bodyOf('PATCH', `/v1/letter-templates/${T_RELIEVING}`)).toEqual({ active: false, expectedVersion: 4 });
    expect((await within(settings).findByRole('status')).textContent).toBe(
      'The template is inactive: no letter can be previewed or generated from it until it is activated again.',
    );
    // Reloaded: the status is the server's, and the next change carries the new version.
    expect(await within(settings).findByRole('button', { name: 'Activate template' })).toBeTruthy();
    expect(term(await findSection('Template'), 'Usable for letters')).toBe('No: inactive');

    const name = within(settings).getByLabelText('Template name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Relieving letter, revised (synthetic)' } });
    const reads = callsTo('GET', `/v1/letter-templates/${T_RELIEVING}`).length;
    fireEvent.click(button(settings, 'Save name'));
    const alert = await within(settings).findByRole('alert');
    expect(alert.textContent).toContain('The template changed after it was loaded. It has been reloaded: check it and try again.');
    expect(alert.textContent).toContain('STALE_VERSION');
    expect(bodyOf('PATCH', `/v1/letter-templates/${T_RELIEVING}`, 1)).toEqual({ name: 'Relieving letter, revised (synthetic)', expectedVersion: 5 });
    await waitFor(() => expect(callsTo('GET', `/v1/letter-templates/${T_RELIEVING}`).length).toBeGreaterThan(reads));
    expect(name.value).toBe('Relieving letter, revised (synthetic)');
  });

  it('offers no change to the template without the manage duty', async () => {
    serve({ [`GET /v1/letter-templates/${T_RELIEVING}`]: [200, relievingDetail()], 'GET /v1/letter-placeholders': [200, { items: PLACEHOLDERS }] });
    renderAt(`/lifecycle/letter-templates/${T_RELIEVING}`, [TEMPLATE_READ]);
    const revisions = await screen.findByRole('table', { name: 'Revisions' });
    expect(rows(revisions).map((r) => cells(r).slice(0, 2))).toEqual([
      ['1', 'Retired'],
      ['2', 'Published'],
    ]);
    expect(screen.queryByRole('button', { name: /Deactivate template|Save draft|Save as a new draft|Publish/ })).toBeNull();
    expect(screen.queryByLabelText('Letter text (required)')).toBeNull();
  });
});

describe('letters for a process (FR-017, FR-018, FR-055)', () => {
  const PREVIEW = `POST /v1/employee-processes/${P_EXIT}/letters/preview`;
  const GENERATE = `POST /v1/employee-processes/${P_EXIT}/letters`;
  const letterRoutes = (overrides: Record<string, Route> = {}): Record<string, Route> => ({
    [`GET /v1/employee-processes/${P_EXIT}`]: [200, PROCESS],
    'GET /v1/letter-templates': [200, { items: TEMPLATES }],
    'GET /v1/letter-placeholders': [200, { items: PLACEHOLDERS }],
    [`GET /v1/employees/${E_ASHA}/letter-outputs`]: [200, { items: [] }],
    ...overrides,
  });
  async function previewRelieving() {
    const select = (await screen.findByLabelText('Letter template')) as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(2));
    fireEvent.change(select, { target: { value: 'RELIEVING' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview letter' }));
    return screen.findByRole('region', { name: 'Letter preview' });
  }

  it('previews without storing or sending, names the missing mandatory values and blocks the final letter', async () => {
    serve(letterRoutes({ [PREVIEW]: [200, PREVIEW_MISSING] }));
    renderAt(`/lifecycle/processes/${P_EXIT}/letters`, HR_LETTERS);
    expect(await screen.findByRole('heading', { name: 'Letters for Asha Synthetic (SYN-301)' })).toBeTruthy();
    const select = (await screen.findByLabelText('Letter template')) as HTMLSelectElement;
    // Only active templates with a published revision are offered.
    await waitFor(() => expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Choose…', 'Relieving letter (synthetic) (RELIEVING, revision 2)']));
    const generate = screen.getByRole('button', { name: 'Generate the final letter' }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    expect(screen.getByText('Preview the letter first: the final letter is offered once a preview has every mandatory value.')).toBeTruthy();

    const region = await previewRelieving();
    expect(callsTo('POST', `/v1/employee-processes/${P_EXIT}/letters/preview`).map((c) => c.body)).toEqual([{ templateCode: 'RELIEVING' }]);
    expect(within(region).getByRole('heading').textContent).toBe('Preview of RELIEVING, revision 2');
    expect(region.textContent).toContain('preview only');
    expect(region.textContent).toContain('This preview is not stored and nothing is sent to anyone.');
    expect(within(region).getByRole('alert').textContent).toBe(
      'The final letter cannot be generated until these mandatory values are recorded: Approved last working date (inclusive) ({{lastWorkingDate}}).',
    );
    expect(region.querySelector('pre')?.textContent).toBe(PREVIEW_MISSING.text);
    expect(generate.disabled).toBe(true);
    fireEvent.click(generate);
    await settle();
    expect(callsTo('POST', `/v1/employee-processes/${P_EXIT}/letters`)).toEqual([]);
  });

  it('generates the final letter from a ready preview, shows its template revision and generator, and downloads the stored letter', async () => {
    const downloads = stubDownloads();
    const answer = gate();
    serve(
      letterRoutes({
        [PREVIEW]: [200, PREVIEW_READY],
        [GENERATE]: async () => {
          await answer.promise;
          return [201, GENERATED];
        },
        [`GET /v1/letter-outputs/${O_FIRST}/content`]: textFile(PREVIEW_TEXT, 'text/plain', 'RELIEVING-SYN-301-1.txt'),
      }),
    );
    renderAt(`/lifecycle/processes/${P_EXIT}/letters`, HR_LETTERS);
    const region = await previewRelieving();
    expect(within(region).getByText('Every mandatory value is present.')).toBeTruthy();
    const generate = screen.getByRole('button', { name: 'Generate the final letter' }) as HTMLButtonElement;
    expect(generate.disabled).toBe(false);
    fireEvent.click(generate);
    await waitFor(() => expect(callsTo('POST', `/v1/employee-processes/${P_EXIT}/letters`)).toHaveLength(1));
    expect(bodyOf('POST', `/v1/employee-processes/${P_EXIT}/letters`)).toEqual({ templateCode: 'RELIEVING' });
    // In flight: neither another final letter nor another preview can be sent.
    expect(generate.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Preview letter' }) as HTMLButtonElement).disabled).toBe(true);
    answer.open();

    const status = await screen.findByRole('status');
    expect(status.textContent).toBe('Final letter stored: RELIEVING, revision 2, letter number 1.');
    const facts = status.parentElement as HTMLElement;
    expect(term(facts, 'Template revision')).toBe('2');
    expect(term(facts, 'Generated by')).toBe('you');
    expect(term(facts, 'Generated')).toBe(localTime(GENERATED.generatedAt));
    expect(term(facts, 'Delivery')).toBe('Not sent: sending letters is not available');
    // The preview is used up and the choice starts clean: another letter needs a new preview first.
    expect(screen.queryByRole('region', { name: 'Letter preview' })).toBeNull();
    expect((screen.getByLabelText('Letter template') as HTMLSelectElement).value).toBe('');
    expect(generate.disabled).toBe(true);
    expect(callsTo('POST', `/v1/employee-processes/${P_EXIT}/letters`)).toHaveLength(1);

    fireEvent.click(within(facts).getByRole('button', { name: 'Download RELIEVING letter 1' }));
    await waitFor(() => expect(downloads.click).toHaveBeenCalledTimes(1));
    expect(callsTo('GET', `/v1/letter-outputs/${O_FIRST}/content`)).toHaveLength(1);
    downloads.restore();
  });

  it('says a refused final letter in plain words, naming the missing values', async () => {
    serve(
      letterRoutes({
        [PREVIEW]: [200, PREVIEW_READY],
        [GENERATE]: [422, { error: 'MISSING_PLACEHOLDER', message: 'Mandatory letter values are missing', details: { missing: ['lastWorkingDate'] } }],
      }),
    );
    renderAt(`/lifecycle/processes/${P_EXIT}/letters`, HR_LETTERS);
    await previewRelieving();
    fireEvent.click(screen.getByRole('button', { name: 'Generate the final letter' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'The final letter was not generated: mandatory values are missing: Approved last working date (inclusive) ({{lastWorkingDate}}). Once they are recorded, preview the letter again.',
    );
    expect(alert.textContent).toContain('MISSING_PLACEHOLDER');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says in words why a relieving or experience letter cannot be previewed (FR-055)', async () => {
    for (const [reply, words] of [
      [{ error: 'EXIT_NOT_APPROVED', message: 'This letter needs an approved exit of the employee' }, 'A relieving or experience letter is issued from an approved exit, and this employee has none for this process.'],
      [{ error: 'EMPLOYMENT_PERIOD_REQUIRED', message: 'A relieving or experience letter must show the employment period', details: { placeholders: ['lastWorkingDate'] } }, 'This relieving or experience template does not show the employment period.'],
    ] as const) {
      serve(letterRoutes({ [PREVIEW]: [reply.error === 'EXIT_NOT_APPROVED' ? 409 : 422, reply] }));
      const view = renderAt(`/lifecycle/processes/${P_EXIT}/letters`, [PROCESS_READ, LETTER_GENERATE]);
      fireEvent.change(await screen.findByLabelText('Letter template code'), { target: { value: 'RELIEVING_STD' } });
      fireEvent.click(screen.getByRole('button', { name: 'Preview letter' }));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(words));
      // No preview, so nothing can be generated from it.
      expect((screen.getByRole('button', { name: /final letter/i }) as HTMLButtonElement).disabled).toBe(true);
      view.unmount();
    }
  });

  it('takes a template code where the role cannot list templates, and says an unpublished template in plain words', async () => {
    serve(
      letterRoutes({
        [PREVIEW]: [422, { error: 'TEMPLATE_NOT_PUBLISHED', message: 'The letter template has no published revision' }],
      }),
    );
    renderAt(`/lifecycle/processes/${P_EXIT}/letters`, [PROCESS_READ, LETTER_GENERATE]);
    const code = (await screen.findByLabelText('Letter template code')) as HTMLInputElement;
    fireEvent.click(screen.getByRole('button', { name: 'Preview letter' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Enter the template code: a capital letter followed by capital letters, digits or _ (up to 40 characters).');
    await settle();
    expect(callsTo('POST', `/v1/employee-processes/${P_EXIT}/letters/preview`)).toEqual([]);
    fireEvent.change(code, { target: { value: 'offer_std' } });
    expect(code.value).toBe('OFFER_STD');
    fireEvent.click(screen.getByRole('button', { name: 'Preview letter' }));
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(alert.textContent).toContain('This letter template has no published revision yet, so it cannot be used for letters.'));
    expect(bodyOf('POST', `/v1/employee-processes/${P_EXIT}/letters/preview`)).toEqual({ templateCode: 'OFFER_STD' });
    expect(callsTo('GET', '/v1/letter-templates')).toEqual([]);
    expect(callsTo('GET', '/v1/letter-placeholders')).toEqual([]);
  });

  it('offers no preview or final letter without the letter grant, and no download without the letter read grant', async () => {
    serve(letterRoutes({ [PREVIEW]: [200, PREVIEW_READY], [GENERATE]: [201, GENERATED] }));
    const view = renderAt(`/lifecycle/processes/${P_EXIT}/letters`, [PROCESS_READ, TEMPLATE_READ]);
    expect((await screen.findByRole('note')).textContent).toContain('The selected role cannot prepare letters: previews and final letters need the confidential letter grant.');
    expect(screen.queryByRole('button', { name: 'Preview letter' })).toBeNull();
    view.unmount();

    renderAt(`/lifecycle/processes/${P_EXIT}/letters`, [PROCESS_READ, TEMPLATE_READ, LETTER_GENERATE]);
    await previewRelieving();
    fireEvent.click(screen.getByRole('button', { name: 'Generate the final letter' }));
    expect(await screen.findByText('Downloading the stored letter needs the letter read grant.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Download/ })).toBeNull();
  });

  it('offers no letter about one’s own record', async () => {
    serve(letterRoutes());
    renderAt(`/lifecycle/processes/${P_EXIT}/letters`, HR_LETTERS, { employeeId: E_ASHA });
    expect(await screen.findByText('This process is about your own record, so you cannot prepare letters for it in this role.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Preview letter' })).toBeNull();
    await settle();
    expect(callsTo('POST', `/v1/employee-processes/${P_EXIT}/letters/preview`)).toEqual([]);
  });
});

describe('an employee’s letters and restricted notes (FR-017, FR-018)', () => {
  const employeeRoutes = (overrides: Record<string, Route> = {}): Record<string, Route> => ({
    [`GET /v1/employees/${E_ASHA}`]: [200, ASHA],
    [`GET /v1/employees/${E_ASHA}/letter-outputs`]: [200, { items: OUTPUTS }],
    [`GET /v1/employees/${E_ASHA}/processes`]: [200, { items: PROCESSES }],
    [`GET /v1/employees/${E_ASHA}/notes`]: [200, { items: NOTES }],
    ...overrides,
  });

  it('finds an employee and links to their letters', async () => {
    serve({ 'GET /v1/employees': [200, { items: [ASHA], total: 1, page: 1, pageSize: 25 }] });
    renderAt('/lifecycle/letters', [LETTER_READ, EMPLOYEE_LIST]);
    fireEvent.change(await screen.findByLabelText('Employee name, code or work email'), { target: { value: 'asha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const table = await screen.findByRole('table', { name: 'Employees found' });
    expect(callsTo('GET', '/v1/employees')[0]?.params.toString()).toBe('search=asha&page=1&pageSize=25');
    expect(within(table).getByRole('link', { name: 'Letters of Asha Synthetic (SYN-301)' }).getAttribute('href')).toBe(`/lifecycle/employees/${E_ASHA}/letters`);
  });

  it('lists the stored letters with their template revision and generator, downloads one, and offers the processes to prepare a letter for', async () => {
    const downloads = stubDownloads();
    serve(employeeRoutes({ [`GET /v1/letter-outputs/${O_SECOND}/content`]: textFile('Synthetic relieving letter', 'text/plain', 'RELIEVING-SYN-301-2.txt') }));
    renderAt(`/lifecycle/employees/${E_ASHA}/letters`, HR_LETTERS);
    expect(await screen.findByRole('heading', { name: 'Letters of Asha Synthetic (SYN-301)' })).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Stored letters' });
    expect(headers(table)).toEqual(['Template', 'Template revision', 'Output number', 'Generated', 'Generated by', 'Size', 'Delivery', 'Download']);
    expect(rows(table).map(cells)).toEqual([
      ['RELIEVING', '2', '2', localTime('2026-10-25T09:00:00.000Z'), U_OTHER, '120 bytes', 'Not sent', 'Download'],
      ['RELIEVING', '1', '1', localTime('2026-10-24T09:00:00.000Z'), 'you', '118 bytes', 'Not sent', 'Download'],
    ]);
    fireEvent.click(within(table).getByRole('button', { name: 'Download RELIEVING letter 2' }));
    await waitFor(() => expect(downloads.click).toHaveBeenCalledTimes(1));
    expect(callsTo('GET', `/v1/letter-outputs/${O_SECOND}/content`)).toHaveLength(1);
    downloads.restore();

    const processes = await screen.findByRole('table', { name: 'Processes' });
    expect(rows(processes).map(cells)).toEqual([
      ['Exit clearance (synthetic) EXIT_CLEAR', 'open', '2026-10-20', 'Prepare a letter'],
      ['Transfer (synthetic) TRANSFER_STD', 'cancelled', '2026-09-01', 'Cancelled: no letters'],
    ]);
    expect(within(processes).getByRole('link', { name: 'Prepare a letter for Exit clearance (synthetic)' }).getAttribute('href')).toBe(`/lifecycle/processes/${P_EXIT}/letters`);
  });

  it('says a refused download in plain words', async () => {
    serve(employeeRoutes({ [`GET /v1/letter-outputs/${O_SECOND}/content`]: [404, { error: 'NOT_FOUND', message: 'Resource not found' }] }));
    renderAt(`/lifecycle/employees/${E_ASHA}/letters`, HR_LETTERS);
    const table = await screen.findByRole('table', { name: 'Stored letters' });
    fireEvent.click(within(table).getByRole('button', { name: 'Download RELIEVING letter 2' }));
    const alert = await within(table).findByRole('alert');
    expect(alert.textContent).toContain('This letter is not available in the selected role’s scope.');
  });

  it('shows restricted notes only with the note grant, each text only when it was returned', async () => {
    serve(employeeRoutes());
    const view = renderAt(`/lifecycle/employees/${E_ASHA}/letters`, HR_LETTERS);
    await screen.findByRole('table', { name: 'Stored letters' });
    await settle();
    expect(callsTo('GET', `/v1/employees/${E_ASHA}/notes`)).toEqual([]);
    expect(screen.queryByRole('heading', { name: 'Restricted HR notes and warnings' })).toBeNull();
    view.unmount();

    renderAt(`/lifecycle/employees/${E_ASHA}/letters`, [...HR_LETTERS, NOTE_READ]);
    const list = await screen.findByRole('list', { name: 'Restricted notes' });
    const [warning, note] = within(list).getAllByRole('listitem');
    expect(warning?.textContent).toContain('Warning');
    expect(warning?.textContent).toContain('Synthetic warning about late asset returns');
    expect(warning?.textContent).toContain('linked to an exit');
    expect(note?.textContent).toContain('Note');
    expect(note?.textContent).toContain('linked to a process');
    expect(note?.querySelector('p')).toBeNull();
  });

  it('asks for no stored letters without the letter read grant, and for nothing about one’s own record', async () => {
    serve(employeeRoutes());
    const view = renderAt(`/lifecycle/employees/${E_ASHA}/letters`, [EMPLOYEE_READ, PROCESS_READ, LETTER_GENERATE]);
    expect((await screen.findByRole('note')).textContent).toContain('The selected role cannot read stored letters: they need the confidential letter grant.');
    await screen.findByRole('table', { name: 'Processes' });
    expect(callsTo('GET', `/v1/employees/${E_ASHA}/letter-outputs`)).toEqual([]);
    view.unmount();

    serve(employeeRoutes());
    renderAt(`/lifecycle/employees/${E_ASHA}/letters`, [...HR_LETTERS, NOTE_READ], { employeeId: E_ASHA });
    expect(await screen.findByText('This is your own record. Letters and restricted notes about your own record are not available in this role.')).toBeTruthy();
    await settle();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /v1/employees/${E_ASHA}`]);
  });
});

describe('settlements (FR-052 to FR-054, BR-016)', () => {
  it('lists settlements with the calculation reported as not configured, and no amount when the API omits it', async () => {
    serve({
      'GET /v1/settlements': [200, { calculation: CALCULATION, items: [summary(S_DRAFT), summary(S_ELIGIBLE, { revision: 2, state: 'RELEASE_ELIGIBLE' })] }],
    });
    renderAt('/lifecycle/settlements', [SETTLEMENT_READ]);
    const table = await screen.findByRole('table', { name: 'Settlements' });
    expect(headers(table)).toEqual(['Employee', 'Revision', 'State', 'Currency', 'Settlement']);
    expect(rows(table).map(cells)).toEqual([
      ['Asha Synthetic SYN-301', '1', 'Draft', 'INR', 'Open'],
      ['Asha Synthetic SYN-301', '2', 'Eligible for release (not a payment)', 'INR', 'Open'],
    ]);
    expect(within(table).getByRole('link', { name: 'Open revision 2 of Asha Synthetic (SYN-301)' }).getAttribute('href')).toBe(`/lifecycle/settlements/${S_ELIGIBLE}`);
    const note = screen.getByText(CALCULATION.reason, { exact: false }).closest('p') as HTMLElement;
    expect(note.textContent).toContain('calculation not configured');
    expect(document.body.textContent).not.toMatch(/INR [-\d]/);
    // BR-016: no listed revision reads as paid; only a payment recorded from evidence is (the PAID state, I-81 item 2).
    expect(table.textContent).not.toMatch(/\bpaid\b/i);
    // The outputs carry amounts: without the amount grant nothing is selectable and there is no ZIP download.
    expect(within(table).queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('group', { name: 'ZIP download of the selected settlements' })).toBeNull();
  });

  it('selects approved settlements across pages and downloads them as one ZIP in the chosen format (FR-054)', async () => {
    const downloads = stubDownloads();
    try {
      const S_LATER = '60000000-0000-4000-8000-000000000099';
      serve({
        'GET /v1/settlements': (c) => [
          200,
          {
            calculation: CALCULATION,
            items:
              c.params.get('page') === '2'
                ? [summary(S_LATER, { employeeId: E_RAVI, employeeCode: 'SYN-302', employeeName: 'Ravi Synthetic', state: 'RELEASE_ELIGIBLE' }, true)]
                : [summary(S_DRAFT, {}, true), summary(S_APPROVED, { revision: 2, state: 'APPROVED' }, true), summary(S_SUBMITTED, { revision: 3, state: 'SUBMITTED' }, true)],
            total: 26,
            page: Number(c.params.get('page')),
            pageSize: 25,
          },
        ],
        'GET /v1/settlements/export-archive': textFile('PK synthetic', 'application/zip', 'settlements-2026-10-29.zip'),
      });
      renderAt('/lifecycle/settlements', [SETTLEMENT_READ, SETTLEMENT_AMOUNT, SETTLEMENT_EXPORT]);
      const table = await screen.findByRole('table', { name: 'Settlements' });
      const zip = screen.getByRole('group', { name: 'ZIP download of the selected settlements' });
      const download = () => button(zip, 'Download the ZIP of the selected settlements');
      expect(within(zip).getByRole('status').textContent).toBe('No settlement selected.');
      expect(download().disabled).toBe(true);
      // Only an approved or release-eligible settlement can be chosen.
      expect(within(table).getAllByRole('checkbox')).toHaveLength(1);
      fireEvent.click(within(table).getByRole('checkbox', { name: 'Select revision 2 of Asha Synthetic (SYN-301) for the ZIP download' }));
      expect(within(zip).getByRole('status').textContent).toBe('1 of at most 100 selected.');
      // The selection is kept while paging.
      fireEvent.click(within(screen.getByRole('navigation', { name: 'Settlement pages' })).getByRole('button', { name: 'Next page' }));
      await screen.findByText('Ravi Synthetic');
      fireEvent.click(button(zip, 'Select the exportable settlements on this page'));
      expect(within(zip).getByRole('status').textContent).toBe('2 of at most 100 selected.');
      expect((screen.getByRole('checkbox', { name: 'Select revision 1 of Ravi Synthetic (SYN-302) for the ZIP download' }) as HTMLInputElement).checked).toBe(true);
      expect(button(zip, 'Select the exportable settlements on this page').disabled).toBe(true);
      fireEvent.change(within(zip).getByLabelText('File format in the ZIP'), { target: { value: 'XLSX' } });
      fireEvent.click(download());
      await waitFor(() => expect(downloads.click).toHaveBeenCalledTimes(1));
      const calls = callsTo('GET', '/v1/settlements/export-archive');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.params.get('ids')).toBe(`${S_APPROVED},${S_LATER}`);
      expect(calls[0]!.params.get('format')).toBe('XLSX');
      // Nothing is sent: the archive is only downloaded.
      expect(calls.every((c) => c.method === 'GET')).toBe(true);
      // Clearing, or new filters, start a new selection.
      fireEvent.click(button(zip, 'Clear the selection'));
      expect(within(zip).getByRole('status').textContent).toBe('No settlement selected.');
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select revision 1 of Ravi Synthetic (SYN-302) for the ZIP download' }));
      fireEvent.click(button(screen.getByRole('form', { name: 'Filter settlements' }), 'Show settlements'));
      await waitFor(() => expect(within(screen.getByRole('group', { name: 'ZIP download of the selected settlements' })).getByRole('status').textContent).toBe('No settlement selected.'));
    } finally {
      downloads.restore();
    }
  });

  it('says a refused ZIP download in words, naming the settlement that is no longer approved', async () => {
    serve({
      'GET /v1/settlements': [200, { calculation: CALCULATION, items: [summary(S_APPROVED, { revision: 2, state: 'APPROVED' }, true)], total: 1, page: 1, pageSize: 25 }],
      'GET /v1/settlements/export-archive': [409, { error: 'NOT_APPROVED', message: 'Only an approved settlement is exported', details: { settlementId: S_APPROVED } }],
    });
    renderAt('/lifecycle/settlements', [SETTLEMENT_READ, SETTLEMENT_AMOUNT, SETTLEMENT_EXPORT]);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select revision 2 of Asha Synthetic (SYN-301) for the ZIP download' }));
    const zip = screen.getByRole('group', { name: 'ZIP download of the selected settlements' });
    fireEvent.click(button(zip, 'Download the ZIP of the selected settlements'));
    const alert = await within(zip).findByRole('alert');
    expect(alert.textContent).toContain('The settlement of Asha Synthetic (SYN-301), revision 2 is no longer approved or eligible for release, so nothing was downloaded.');
    expect(alert.textContent).toContain('NOT_APPROVED');
    expect(callsTo('GET', '/v1/settlements/export-archive')[0]!.params.get('format')).toBe('CSV');
  });

  it('selects at most 100 settlements for one ZIP', async () => {
    const id = (page: number, i: number) => `61000000-0000-4000-8000-${String(page * 100 + i).padStart(12, '0')}`;
    serve({
      'GET /v1/settlements': (c) => {
        const page = Number(c.params.get('page'));
        return [200, { calculation: CALCULATION, items: Array.from({ length: 25 }, (_, i) => summary(id(page, i), { revision: page * 100 + i, state: 'APPROVED' }, true)), total: 125, page, pageSize: 25 }];
      },
    });
    renderAt('/lifecycle/settlements', [SETTLEMENT_READ, SETTLEMENT_AMOUNT, SETTLEMENT_EXPORT]);
    await screen.findByRole('table', { name: 'Settlements' });
    const zip = screen.getByRole('group', { name: 'ZIP download of the selected settlements' });
    for (let page = 1; page <= 4; page++) {
      await waitFor(() => expect(within(screen.getByRole('table', { name: 'Settlements' })).getAllByRole('checkbox')[0]!.getAttribute('aria-label')).toContain(`revision ${page * 100} `));
      fireEvent.click(button(zip, 'Select the exportable settlements on this page'));
      fireEvent.click(within(screen.getByRole('navigation', { name: 'Settlement pages' })).getByRole('button', { name: 'Next page' }));
    }
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Settlements' })).getAllByRole('checkbox')[0]!.getAttribute('aria-label')).toContain('revision 500 '));
    expect(within(zip).getByRole('status').textContent).toBe('100 of at most 100 selected.');
    const boxes = within(screen.getByRole('table', { name: 'Settlements' })).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.every((b) => b.disabled && !b.checked)).toBe(true);
    expect(button(zip, 'Select the exportable settlements on this page').disabled).toBe(true);
  });

  it('validates and applies a bulk lines file for several drafts through the import lifecycle (FR-054)', async () => {
    const content = 'employee_code,last_working_date,component_code,amount,line_kind\r\nSYN-301,2026-10-31,BASIC,40000.25,\r\nSYN-302,2026-10-30,LOAN,-250.25,STANDARD\r\n';
    const JOB = '80000000-0000-4000-8000-000000000001';
    const job = (state: string, patch: Json = {}): Json => ({
      id: JOB,
      state,
      template: 'SETTLEMENT_LINES_V1',
      fileName: 'lines.csv',
      rowCount: 2,
      acceptedCount: state === 'COMMITTED' ? 2 : 0,
      rejectedCount: 0,
      scanState: 'CLEAN',
      createdAt: '2026-10-29T08:00:00.000Z',
      rows: [
        { rowNumber: 1, businessKey: 'SYN-301/BASIC', state: state === 'COMMITTED' ? 'ACCEPTED' : 'VALID', errorCode: null },
        { rowNumber: 2, businessKey: 'SYN-302/LOAN', state: state === 'COMMITTED' ? 'ACCEPTED' : 'VALID', errorCode: null },
      ],
      ...patch,
    });
    serve({
      'GET /v1/settlements': [200, { calculation: CALCULATION, items: [], total: 0, page: 1, pageSize: 25 }],
      'GET /v1/exit-cases': [200, { items: [], total: 0, page: 1, pageSize: 25 }],
      'GET /v1/settlements/line-imports': [200, { items: [], total: 0, page: 1, pageSize: 25 }],
      'POST /v1/settlements/line-imports': [201, job('PREVIEWED')],
      [`POST /v1/settlements/line-imports/${JOB}/commit`]: [200, job('COMMITTED')],
    });
    renderAt('/lifecycle/settlements', PREPARER);
    const section = await findSection('Bulk upload of settlement lines');
    expect(section.textContent).toContain('employee_code,last_working_date,component_code,amount,line_kind');
    expect(section.textContent).toContain('one row with a problem rejects every settlement in it');
    expect(within(section).getByText('SETTLEMENT_LINES_V1.csv: the header line only, ready to fill in.')).toBeTruthy();
    expect(button(section, 'Validate').disabled).toBe(true);
    fireEvent.change(within(section).getByLabelText('Settlement lines file for several settlements (CSV)'), { target: { files: [new File([content], 'lines.csv', { type: 'text/csv' })] } });
    fireEvent.click(button(section, 'Validate'));
    await waitFor(() => expect(callsTo('POST', '/v1/settlements/line-imports')).toHaveLength(1));
    const sent = bodyOf('POST', '/v1/settlements/line-imports') as { fileName: string; contentBase64: string; idempotencyKey: string };
    expect(sent).toMatchObject({ fileName: 'lines.csv', contentBase64: Buffer.from(content, 'utf8').toString('base64') });
    expect(sent.idempotencyKey).toMatch(/^settlement-lines-/);
    const preview = await findSection('Preview: lines.csv (SETTLEMENT_LINES_V1)');
    expect(preview.textContent).toContain('All 2 rows are valid.');
    expect(rows(within(preview).getByRole('table')).map((r) => cells(r).slice(0, 2))).toEqual([
      ['1', 'SYN-301/BASIC'],
      ['2', 'SYN-302/LOAN'],
    ]);
    const listed = callsTo('GET', '/v1/settlements').length;
    fireEvent.click(button(preview, 'Apply 2 lines'));
    await waitFor(() => expect(callsTo('POST', `/v1/settlements/line-imports/${JOB}/commit`)).toHaveLength(1));
    expect(await within(await findSection('Preview: lines.csv (SETTLEMENT_LINES_V1)')).findByText('All 2 rows were applied.')).toBeTruthy();
    // The drafts changed: the settlement list loads again.
    await waitFor(() => expect(callsTo('GET', '/v1/settlements').length).toBeGreaterThan(listed));
    expect(await findSection('Your settlement lines batches')).toBeTruthy();
  });

  it('says a rejected bulk lines file’s row problems in plain words, and offers no bulk upload without the preparation grant', async () => {
    const JOB = '80000000-0000-4000-8000-000000000002';
    serve({
      'GET /v1/settlements': [200, { calculation: CALCULATION, items: [], total: 0, page: 1, pageSize: 25 }],
      'GET /v1/exit-cases': [200, { items: [], total: 0, page: 1, pageSize: 25 }],
      'GET /v1/settlements/line-imports': [200, { items: [], total: 0, page: 1, pageSize: 25 }],
      'POST /v1/settlements/line-imports': [
        201,
        {
          id: JOB,
          state: 'REJECTED',
          template: 'SETTLEMENT_LINES_V1',
          fileName: 'bad.csv',
          rowCount: 2,
          acceptedCount: 0,
          rejectedCount: 2,
          scanState: 'CLEAN',
          createdAt: '2026-10-29T08:00:00.000Z',
          rows: [
            { rowNumber: 1, businessKey: 'SYN-301/BASIC', state: 'REJECTED', errorCode: 'BATCH_REJECTED' },
            { rowNumber: 2, businessKey: 'SYN-309/BASIC', state: 'REJECTED', errorCode: 'NO_DRAFT_SETTLEMENT' },
          ],
        },
      ],
    });
    const view = renderAt('/lifecycle/settlements', PREPARER);
    const section = await findSection('Bulk upload of settlement lines');
    fireEvent.change(within(section).getByLabelText('Settlement lines file for several settlements (CSV)'), { target: { files: [new File(['x'], 'bad.csv', { type: 'text/csv' })] } });
    fireEvent.click(button(section, 'Validate'));
    const preview = await findSection('Preview: bad.csv (SETTLEMENT_LINES_V1)');
    expect(preview.textContent).toContain('This batch was rejected, so nothing was applied');
    expect(rows(within(preview).getByRole('table')).map((r) => cells(r)[3])).toEqual([
      'This employee has no settlement revision in draft. Prepare one from the approved exit first; a submitted revision is frozen.NO_DRAFT_SETTLEMENT',
      'not applied (another row failed)',
    ]);
    expect(within(preview).queryByRole('button', { name: /^Apply/ })).toBeNull();
    view.unmount();
    serve({ 'GET /v1/settlements': [200, { calculation: CALCULATION, items: [], total: 0, page: 1, pageSize: 25 }] });
    renderAt('/lifecycle/settlements', [SETTLEMENT_READ, SETTLEMENT_AMOUNT]);
    await screen.findByRole('heading', { name: 'Settlements' });
    expect(screen.queryByRole('heading', { name: 'Bulk upload of settlement lines' })).toBeNull();
    await settle();
    expect(callsTo('GET', '/v1/settlements/line-imports')).toHaveLength(0);
  });

  it('sorts on the server by a column heading, keeps the filters and starts again at page 1; the net amount is not offered (FR-056, DF02)', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => summary(`a0000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`, { revision: i + 1 }, true));
    serve({ 'GET /v1/settlements': (c) => [200, { calculation: CALCULATION, items: page(c.params.get('page') === '2' ? 2 : 25), total: 27, page: Number(c.params.get('page')), pageSize: 25 }] });
    renderAt('/lifecycle/settlements', [SETTLEMENT_READ, SETTLEMENT_AMOUNT]);
    const table = await screen.findByRole('table', { name: 'Settlements' });
    const last = () => callsTo('GET', '/v1/settlements').at(-1)!.params.toString();
    expect(last()).toBe('page=1&pageSize=25');
    expect(within(table).getByRole('columnheader', { name: 'Employee' }).getAttribute('aria-sort')).toBe('none');
    const form = screen.getByRole('form', { name: 'Filter settlements' });
    fireEvent.change(within(form).getByLabelText('State'), { target: { value: 'APPROVED' } });
    fireEvent.click(button(form, 'Show settlements'));
    await waitFor(() => expect(last()).toBe('state=APPROVED&page=1&pageSize=25'));
    fireEvent.click(within(await screen.findByRole('navigation', { name: 'Settlement pages' })).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(last()).toBe('state=APPROVED&page=2&pageSize=25'));
    fireEvent.click(within(await screen.findByRole('table', { name: 'Settlements' })).getByRole('button', { name: 'Employee' }));
    await waitFor(() => expect(last()).toBe('state=APPROVED&sort=employeeName&direction=ASC&page=1&pageSize=25'));
    const sorted = await screen.findByRole('table', { name: 'Settlements' });
    expect(within(sorted).getByRole('columnheader', { name: /Employee/ }).getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(within(sorted).getByRole('button', { name: /Employee/ }));
    await waitFor(() => expect(last()).toBe('state=APPROVED&sort=employeeName&direction=DESC&page=1&pageSize=25'));
    expect(within(await screen.findByRole('table', { name: 'Settlements' })).queryByRole('button', { name: 'Net amount' })).toBeNull();
  });

  it('FR-002: the amount grant shows the amounts; only the separate export grant selects for the ZIP download', async () => {
    serve({ 'GET /v1/settlements': [200, { calculation: CALCULATION, items: [summary(S_ELIGIBLE, { revision: 2, state: 'RELEASE_ELIGIBLE' }, true)] }] });
    renderAt('/lifecycle/settlements', [SETTLEMENT_READ, SETTLEMENT_AMOUNT]);
    const table = await screen.findByRole('table', { name: 'Settlements' });
    expect(headers(table)).toEqual(['Employee', 'Revision', 'State', 'Currency', 'Net amount', 'Settlement']);
    expect(within(table).queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('group', { name: 'ZIP download of the selected settlements' })).toBeNull();
  });

  it('shows the net amounts the server returned and filters by state, employee code and month as the API takes them', async () => {
    serve({
      'GET /v1/settlements': (c) => [
        200,
        {
          calculation: CALCULATION,
          items:
            c.params.get('state') === 'RELEASE_ELIGIBLE'
              ? [summary(S_ELIGIBLE, { revision: 2, state: 'RELEASE_ELIGIBLE' }, true)]
              : [summary(S_DRAFT, {}, true), summary(S_ELIGIBLE, { revision: 2, state: 'RELEASE_ELIGIBLE' }, true)],
        },
      ],
    });
    renderAt('/lifecycle/settlements', [SETTLEMENT_READ, SETTLEMENT_AMOUNT, SETTLEMENT_EXPORT]);
    const table = await screen.findByRole('table', { name: 'Settlements' });
    // With the export grant, approved and release-eligible settlements can be selected for the ZIP download (FR-054).
    expect(headers(table)).toEqual(['Select', 'Employee', 'Revision', 'State', 'Currency', 'Net amount', 'Settlement']);
    expect(cells(rows(table)[0]!)[5]).toBe('INR 52,345.18 (exactly 52345.1789)');
    expect(cells(rows(table)[0]!)[0]).toBe('—');
    expect(within(rows(table)[1]!).getByRole('checkbox', { name: 'Select revision 2 of Asha Synthetic (SYN-301) for the ZIP download' })).toBeTruthy();
    const form = screen.getByRole('form', { name: 'Filter settlements' });
    fireEvent.change(within(form).getByLabelText('State'), { target: { value: 'RELEASE_ELIGIBLE' } });
    fireEvent.change(within(form).getByLabelText('Employee code contains'), { target: { value: 'syn-30' } });
    fireEvent.change(within(form).getByLabelText('Month of the approved last working date'), { target: { value: '2026-10' } });
    fireEvent.click(button(form, 'Show settlements'));
    await waitFor(() => expect(callsTo('GET', '/v1/settlements')).toHaveLength(2));
    expect(callsTo('GET', '/v1/settlements')[1]?.params.toString()).toBe('state=RELEASE_ELIGIBLE&employeeCode=syn-30&lastWorkingMonth=2026-10&page=1&pageSize=25');
    await waitFor(() => expect(rows(screen.getByRole('table', { name: 'Settlements' }))).toHaveLength(1));
  });

  it('pages the settlements with the total of every match, keeping the filters (FR-056)', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => summary(`a0000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`, { revision: i + 1 }, false));
    serve({
      'GET /v1/settlements': (c) => [200, { calculation: CALCULATION, items: c.params.get('page') === '2' ? page(2) : page(25), total: 27, page: Number(c.params.get('page')), pageSize: 25 }],
    });
    renderAt('/lifecycle/settlements', [SETTLEMENT_READ]);
    const table = await screen.findByRole('table', { name: 'Settlements' });
    expect(rows(table)).toHaveLength(25);
    expect(callsTo('GET', '/v1/settlements')[0]?.params.toString()).toBe('page=1&pageSize=25');
    const pager = screen.getByRole('navigation', { name: 'Settlement pages' });
    expect(pager.textContent).toContain('Page 1 of 2 · 27 settlements');
    fireEvent.change(within(screen.getByRole('form', { name: 'Filter settlements' })).getByLabelText('State'), { target: { value: 'DRAFT' } });
    fireEvent.click(button(screen.getByRole('form', { name: 'Filter settlements' }), 'Show settlements'));
    await waitFor(() => expect(callsTo('GET', '/v1/settlements')).toHaveLength(2));
    expect(callsTo('GET', '/v1/settlements')[1]?.params.toString()).toBe('state=DRAFT&page=1&pageSize=25');
    fireEvent.click(within(await screen.findByRole('navigation', { name: 'Settlement pages' })).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(rows(screen.getByRole('table', { name: 'Settlements' }))).toHaveLength(2));
    expect(callsTo('GET', '/v1/settlements').at(-1)?.params.toString()).toBe('state=DRAFT&page=2&pageSize=25');
    expect(screen.getByRole('navigation', { name: 'Settlement pages' }).textContent).toContain('Page 2 of 2');
  });

  it('lists nothing without the settlement read duty', async () => {
    serve({});
    renderAt('/lifecycle/settlements', []);
    expect((await screen.findByRole('note')).textContent).toContain('The selected role cannot view settlements.');
    await settle();
    expect(calls).toEqual([]);
  });

  it('lists the approved exits a settlement is prepared for, with the recorded notice period', async () => {
    serve({
      'GET /v1/settlements': [200, { calculation: CALCULATION, items: [] }],
      'GET /v1/exit-cases': (c) => [200, { items: c.params.get('state') === 'APPROVED' ? [EXIT] : [] }],
    });
    renderAt('/lifecycle/settlements', PREPARER);
    const table = await screen.findByRole('table', { name: 'Exits' });
    expect(callsTo('GET', '/v1/exit-cases')[0]?.params.toString()).toBe('state=APPROVED&page=1&pageSize=25');
    expect(rows(table).map(cells)).toEqual([['Asha Synthetic SYN-301', 'Approved', '2026-10-31', '30 days (recorded)', 'Settlements']]);
    expect(within(table).getByRole('link', { name: 'Settlements of Asha Synthetic (SYN-301)' }).getAttribute('href')).toBe(`/lifecycle/exits/${X_ASHA}/settlements`);
    fireEvent.change(screen.getByLabelText('Exit state'), { target: { value: 'SEPARATED' } });
    expect(await screen.findByText('No separated exits in the selected role’s scope.')).toBeTruthy();
    expect(callsTo('GET', '/v1/exit-cases')[1]?.params.toString()).toBe('state=SEPARATED&page=1&pageSize=25');
  });

  it('never shows a list loaded for one role assignment under another, not even from the cache', async () => {
    serve({
      'GET /v1/settlements': () => [
        200,
        {
          calculation: CALCULATION,
          items: [session.assignmentId === ASSIGNMENT_HR ? summary(S_DRAFT) : summary(S_SUBMITTED, { employeeId: E_RAVI, employeeCode: 'SYN-302', employeeName: 'Ravi Synthetic' })],
        },
      ],
    });
    const client = testClient(Infinity);
    const view = renderAt('/lifecycle/settlements', [SETTLEMENT_READ], { client });
    expect(await screen.findByText('Asha Synthetic')).toBeTruthy();
    view.unmount();
    renderAt('/lifecycle/settlements', [SETTLEMENT_READ], { client, assignmentId: ASSIGNMENT_OTHER });
    expect(await screen.findByText('Ravi Synthetic')).toBeTruthy();
    expect(screen.queryByText('Asha Synthetic')).toBeNull();
    expect(callsTo('GET', '/v1/settlements')).toHaveLength(2);
  });
});

describe('one settlement revision (FR-052 to FR-054, BR-016)', () => {
  const detailPath = (id: string) => `/v1/settlements/${id}`;
  const base = (overrides: Record<string, Route> = {}): Record<string, Route> => ({
    'GET /v1/settlements/calculation': [200, CALCULATION],
    [`GET /v1/exit-cases/${X_ASHA}`]: [200, EXIT],
    ...overrides,
  });

  it('shows the lines and the server’s net amount exactly as returned, never a sum worked out here', async () => {
    // The net amount differs from the lines on purpose: the page must show the server's figure, not its own sum.
    serve(base({ [`GET ${detailPath(S_APPROVED)}`]: [200, { ...APPROVED, netAmount: '52345.1700' }] }));
    renderAt(`/lifecycle/settlements/${S_APPROVED}`, [SETTLEMENT_READ, SETTLEMENT_AMOUNT]);
    // I-88: a revision that is not calculated has only entered lines (entered, uploaded or copied), each with its reason if any.
    const lines = await screen.findByRole('table', { name: 'Entered lines' });
    expect(headers(lines)).toEqual(['Pay component', 'Kind', 'Line kind', 'Source', 'Amount', 'Reason']);
    expect(rows(lines).map(cells)).toEqual([
      ['Basic pay (synthetic) BASIC', 'Earning', 'Standard', 'Entered', 'INR 50,000.00', '—'],
      ['Leave encashment (synthetic) LEAVE_ENC', 'Earning', 'Standard', 'Uploaded', 'INR 12,345.68 (exactly 12345.6789)', '—'],
      ['Loan recovery (synthetic) LOAN', 'Deduction', 'Standard', 'Copied from the previous revision', 'INR -10,000.50', '—'],
    ]);
    expect(screen.queryByRole('table', { name: 'Calculated lines' })).toBeNull();
    expect(screen.getByText('None: this revision is not calculated.')).toBeTruthy();
    const net = screen.getByText('Net amount:').closest('p') as HTMLElement;
    expect(net.textContent).toContain('INR 52,345.17');
    expect(net.textContent).not.toContain('52,345.18');
    const facts = await findSection('Settlement');
    expect(term(facts, 'State')).toBe('Approved, not yet eligible for release');
    expect(term(facts, 'Payment')).toBe('Not tracked here: release eligibility is not a payment');
    expect(term(facts, 'Calculation')).toBe('Not calculated (lines entered or uploaded)');
    expect(term(facts, 'Prepared by')).toBe(U_OTHER);
    expect(facts.textContent).toContain('It is not yet eligible for release');
    expect(await within(facts).findByText(CALCULATION.reason, { exact: false })).toBeTruthy();
    // access-4 follow-up: the decider, and the person a delegated decision was taken for, as the other decision histories show them.
    const decisions = screen.getByRole('table', { name: 'Decisions' });
    expect(headers(decisions)).toEqual(['Step', 'Decision', 'Decided by', 'Decided']);
    expect(rows(decisions).map(cells)).toEqual([
      ['Review', 'Approved', 'Dev Delegate (SYN-010) on behalf of Mira Manager (SYN-009)', localTime('2026-10-25T10:00:00.000Z')],
      ['Approval', 'Approved', 'A user without an employee record', localTime('2026-10-26T04:00:00.000Z')],
    ]);
  });

  it('shows the remaining loan and leave balances read-only, exactly as returned (FR-034)', async () => {
    const balances = {
      asOf: '2026-10-31',
      leave: [
        { leaveType: 'ANNUAL', available: '10.0000', pending: '1.0000', taken: '3.5000' },
        { leaveType: 'CASUAL', available: '1.2903', pending: '0.0000', taken: '0.0000' },
      ],
      loans: [
        { id: 'f1000000-0000-4000-8000-000000000001', loanKind: 'LOAN', currencyCode: 'INR', principal: '6000.0000', recovered: '1500.0000', outstanding: '4500.0000', disbursementDate: '2026-06-15' },
        { id: 'f1000000-0000-4000-8000-000000000002', loanKind: 'ADVANCE', currencyCode: 'INR', principal: '500.0000', recovered: '0.0000', outstanding: '500.0000', disbursementDate: '2026-09-01' },
      ],
    };
    serve(base({ [`GET ${detailPath(S_APPROVED)}`]: [200, { ...APPROVED, balances }] }));
    renderAt(`/lifecycle/settlements/${S_APPROVED}`, [SETTLEMENT_READ, SETTLEMENT_AMOUNT]);
    const leave = await screen.findByRole('table', { name: 'Leave balances at the last working date' });
    const section = leave.closest('section') as HTMLElement;
    expect(within(section).getByRole('heading', { name: 'Paid leave as at the last working date (2026-10-31)' })).toBeTruthy();
    expect(rows(leave).map(cells)).toEqual([
      ['ANNUAL', '10.00', '1.00', '3.50'],
      ['CASUAL', '1.29 (exactly 1.2903)', '0.00', '0.00'],
    ]);
    const loans = within(section).getByRole('table', { name: 'Outstanding loans and advances' });
    expect(rows(loans).map(cells)).toEqual([
      ['Loan', '2026-06-15', 'INR 6,000.00', 'INR 1,500.00', 'INR 4,500.00'],
      ['Salary advance', '2026-09-01', 'INR 500.00', 'INR 0.00', 'INR 500.00'],
    ]);
    expect(section.textContent).toContain('no encashment or recovery is worked out from them');
    // Read-only: nothing to change in this section.
    expect(within(section).queryByRole('button')).toBeNull();
    expect(within(section).queryByRole('textbox')).toBeNull();
  });

  it('says when the loan module is not in use, or when there is no outstanding loan', async () => {
    const leave = [{ leaveType: 'ANNUAL', available: '2.0000', pending: '0.0000', taken: '0.0000' }];
    serve(base({ [`GET ${detailPath(S_APPROVED)}`]: [200, { ...APPROVED, balances: { asOf: '2026-10-31', leave } }] }));
    const view = renderAt(`/lifecycle/settlements/${S_APPROVED}`, [SETTLEMENT_READ, SETTLEMENT_AMOUNT]);
    const section = (await screen.findByRole('table', { name: 'Leave balances at the last working date' })).closest('section') as HTMLElement;
    expect(within(section).getByText('Loans and advances are not in use, so no loan balance is shown.')).toBeTruthy();
    expect(within(section).queryByRole('table', { name: 'Outstanding loans and advances' })).toBeNull();
    view.unmount();

    serve(base({ [`GET ${detailPath(S_APPROVED)}`]: [200, { ...APPROVED, balances: { asOf: '2026-10-31', leave, loans: [] } }] }));
    renderAt(`/lifecycle/settlements/${S_APPROVED}`, [SETTLEMENT_READ, SETTLEMENT_AMOUNT]);
    expect(await screen.findByText('No outstanding loan or advance.')).toBeTruthy();
  });

  it('shows no amount when the API omits them, and no line editor even for the preparer', async () => {
    serve(base({ [`GET ${detailPath(S_DRAFT)}`]: [200, settlement(S_DRAFT, {}, null)] }));
    renderAt(`/lifecycle/settlements/${S_DRAFT}`, [SETTLEMENT_READ, SETTLEMENT_PREPARE]);
    expect(await screen.findByText('Settlement amounts are confidential, and the selected role does not receive them.')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Entered lines' })).toBeNull();
    expect(screen.queryByRole('table', { name: 'Calculated lines' })).toBeNull();
    // The calculation comes with the amounts only (I-88).
    expect(screen.getByText('The calculation is confidential like the settlement amounts, and the selected role does not receive it.')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Calculation items' })).toBeNull();
    expect(screen.queryByText('Net amount:')).toBeNull();
    // The remaining balances come with the amounts only.
    expect(screen.getByText('Remaining loan and leave balances are shown with the settlement amounts, and the selected role does not receive them.')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Leave balances at the last working date' })).toBeNull();
    expect(screen.queryByRole('table', { name: 'Outstanding loans and advances' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/INR [-\d]/);
    expect(screen.getByText('The selected role does not receive settlement amounts, so the lines cannot be edited here.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save lines' })).toBeNull();
  });

  it('lets the preparer save the lines against the version, says a refused line with its number and keeps what was typed', async () => {
    let current = settlement(S_DRAFT, { lines: [LINES[0]], netAmount: '50000.0000' });
    let attempt = 0;
    serve(
      base({
        [`GET ${detailPath(S_DRAFT)}`]: () => [200, current],
        [`PUT ${detailPath(S_DRAFT)}/lines`]: () => {
          attempt += 1;
          if (attempt === 1) return [422, { error: 'SIGN_MISMATCH', message: 'A settlement line is not valid', details: { line: 2 } }];
          current = settlement(S_DRAFT, {
            lines: [LINES[0], { componentCode: 'LOAN', componentName: 'Loan recovery (synthetic)', componentKind: 'DEDUCTION', amount: '-250.2500', lineKind: 'STANDARD', source: 'ENTERED' }],
            netAmount: '49749.7500',
            version: 6,
          });
          return [200, current];
        },
      }),
    );
    renderAt(`/lifecycle/settlements/${S_DRAFT}`, PREPARER);
    const form = await screen.findByRole('form', { name: 'Settlement lines' });
    expect((within(form).getAllByLabelText('Pay component code')[0] as HTMLInputElement).value).toBe('BASIC');
    fireEvent.click(button(form, 'Add a line'));
    const codes = within(form).getAllByLabelText('Pay component code') as HTMLInputElement[];
    const amounts = within(form).getAllByLabelText('Amount') as HTMLInputElement[];
    fireEvent.change(codes[1]!, { target: { value: 'loan' } });
    expect(codes[1]!.value).toBe('LOAN');
    // Only the format is checked here; signs, components and duplicates are the server's.
    fireEvent.change(amounts[1]!, { target: { value: '12,50' } });
    fireEvent.click(button(form, 'Save lines'));
    expect((await within(form).findByRole('alert')).textContent).toBe(
      'Line 2: enter the amount as a decimal number with up to 15 digits and 4 decimal places (a minus sign for a deduction).',
    );
    await settle();
    expect(callsTo('PUT', `${detailPath(S_DRAFT)}/lines`)).toEqual([]);

    fireEvent.change(amounts[1]!, { target: { value: '250.25' } });
    fireEvent.click(button(form, 'Save lines'));
    await waitFor(() => expect(callsTo('PUT', `${detailPath(S_DRAFT)}/lines`)).toHaveLength(1));
    expect(bodyOf('PUT', `${detailPath(S_DRAFT)}/lines`)).toEqual({
      lines: [
        { componentCode: 'BASIC', amount: '50000.0000', lineKind: 'STANDARD' },
        { componentCode: 'LOAN', amount: '250.25', lineKind: 'STANDARD' },
      ],
      expectedVersion: 5,
    });
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toContain('Line 2: the sign does not match the pay component: an earning is zero or positive, a deduction zero or negative.');
    expect(alert.textContent).toContain('SIGN_MISMATCH');
    expect(amounts[1]!.value).toBe('250.25');

    fireEvent.change(amounts[1]!, { target: { value: '-250.25' } });
    fireEvent.click(button(form, 'Save lines'));
    expect((await within(form).findByRole('status')).textContent).toBe('Saved 2 lines.');
    expect((bodyOf('PUT', `${detailPath(S_DRAFT)}/lines`, 1) as { lines: Json[] }).lines[1]).toEqual({ componentCode: 'LOAN', amount: '-250.25', lineKind: 'STANDARD' });
    // Loaded again: the editor shows the lines as the server holds them, and the net amount is the server's.
    await waitFor(() => expect(callsTo('GET', detailPath(S_DRAFT)).length).toBeGreaterThan(1));
    expect((within(form).getAllByLabelText('Amount')[1] as HTMLInputElement).value).toBe('-250.2500');
    await waitFor(() => expect((screen.getByText('Net amount:').closest('p') as HTMLElement).textContent).toContain('INR 49,749.75'));
  });

  it('checks and then uploads a lines file as the upload route takes it, with row problems in plain words', async () => {
    const content = 'employee_code,last_working_date,component_code,amount,line_kind\r\nSYN-301,2026-10-31,BASIC,40000.25,\r\nSYN-301,2026-10-30,LOAN,-250.25,STANDARD\r\n';
    serve(
      base({
        [`GET ${detailPath(S_DRAFT)}`]: [200, settlement(S_DRAFT)],
        [`POST ${detailPath(S_DRAFT)}/upload`]: (c) =>
          (c.body as { dryRun: boolean }).dryRun
            ? [
                200,
                {
                  template: 'SETTLEMENT_LINES_V1',
                  dryRun: true,
                  total: 2,
                  accepted: 0,
                  rejected: 2,
                  applied: false,
                  errors: [
                    { row: 2, code: 'BATCH_REJECTED' },
                    { row: 3, code: 'DATE_MISMATCH' },
                  ],
                },
              ]
            : [200, { template: 'SETTLEMENT_LINES_V1', dryRun: false, total: 2, accepted: 2, rejected: 0, applied: true, errors: [] }],
      }),
    );
    renderAt(`/lifecycle/settlements/${S_DRAFT}`, PREPARER);
    const section = await findSection('Upload the lines');
    expect(section.textContent).toContain('employee_code,last_working_date,component_code,amount,line_kind');
    expect(section.textContent).toContain('(SYN-301)');
    await waitFor(() => expect(section.textContent).toContain('(2026-10-31)'));
    fireEvent.click(button(section, 'Check the file'));
    expect((await within(section).findByRole('alert')).textContent).toBe('Choose the CSV file to upload.');
    fireEvent.change(within(section).getByLabelText('Settlement lines file (CSV)'), { target: { files: [new File([content], 'lines.csv', { type: 'text/csv' })] } });
    fireEvent.click(button(section, 'Check the file'));
    await waitFor(() => expect(callsTo('POST', `${detailPath(S_DRAFT)}/upload`)).toHaveLength(1));
    expect(bodyOf('POST', `${detailPath(S_DRAFT)}/upload`)).toEqual({ contentBase64: Buffer.from(content, 'utf8').toString('base64'), dryRun: true, expectedVersion: 5 });
    const problems = await within(section).findByRole('table', { name: 'Upload problems' });
    expect(rows(problems).map(cells)).toEqual([
      ['3', 'The last working date is not the approved last working date of this exit. DATE_MISMATCH'],
      ['2', 'Valid, but not applied: a file is applied all or nothing. BATCH_REJECTED'],
    ]);
    expect(section.textContent).toContain('The file was rejected, so nothing was changed: 1 of 2 rows have a problem.');

    fireEvent.click(button(section, 'Upload and replace the lines'));
    await waitFor(() => expect(callsTo('POST', `${detailPath(S_DRAFT)}/upload`)).toHaveLength(2));
    expect(bodyOf('POST', `${detailPath(S_DRAFT)}/upload`, 1)).toMatchObject({ dryRun: false, expectedVersion: 5 });
    expect(await within(section).findByText('Uploaded: 2 of 2 rows replaced the lines of this draft.')).toBeTruthy();
    // The form starts clean, and the settlement is loaded again.
    expect((within(section).getByLabelText('Settlement lines file (CSV)') as HTMLInputElement).files?.length ?? 0).toBe(0);
    await waitFor(() => expect(callsTo('GET', detailPath(S_DRAFT)).length).toBeGreaterThan(1));
  });

  it('downloads the published SETTLEMENT_LINES_V1 template (DF09) beside the upload’s header, without uploading anything', async () => {
    const downloads = stubDownloads();
    try {
      serve(
        base({
          [`GET ${detailPath(S_DRAFT)}`]: [200, settlement(S_DRAFT)],
          'GET /v1/settlements/lines/template': textFile('employee_code,last_working_date,component_code,amount,line_kind\r\n', 'text/csv; charset=utf-8', 'SETTLEMENT_LINES_V1.csv'),
        }),
      );
      renderAt(`/lifecycle/settlements/${S_DRAFT}`, PREPARER);
      const section = await findSection('Upload the lines');
      expect(section.textContent).toContain('employee_code,last_working_date,component_code,amount,line_kind');
      expect(within(section).getByText('SETTLEMENT_LINES_V1.csv: the header line only, ready to fill in.')).toBeTruthy();
      fireEvent.click(button(section, 'Download the template'));
      await waitFor(() => expect(downloads.click).toHaveBeenCalledTimes(1));
      expect(callsTo('GET', '/v1/settlements/lines/template')).toHaveLength(1);
      expect(callsTo('POST', `${detailPath(S_DRAFT)}/upload`)).toHaveLength(0);
    } finally {
      downloads.restore();
    }
  });

  it('says in words when the selected role cannot download the settlement lines template', async () => {
    serve(
      base({
        [`GET ${detailPath(S_DRAFT)}`]: [200, settlement(S_DRAFT)],
        'GET /v1/settlements/lines/template': [403, { error: 'FORBIDDEN', message: 'Not permitted' }],
      }),
    );
    renderAt(`/lifecycle/settlements/${S_DRAFT}`, PREPARER);
    const section = await findSection('Upload the lines');
    fireEvent.click(button(section, 'Download the template'));
    expect((await within(section).findByRole('alert')).textContent).toContain('FORBIDDEN');
  });

  it('starts the line editor again from the uploaded lines, so saving it never puts the replaced lines back', async () => {
    const content = 'employee_code,last_working_date,component_code,amount,line_kind\r\nSYN-301,2026-10-31,BASIC,40000.25,\r\nSYN-301,2026-10-31,LOAN,-250.25,STANDARD\r\n';
    const uploaded = [
      { componentCode: 'BASIC', componentName: 'Basic pay (synthetic)', componentKind: 'EARNING', amount: '40000.2500', lineKind: 'STANDARD', source: 'UPLOADED' },
      { componentCode: 'LOAN', componentName: 'Loan recovery (synthetic)', componentKind: 'DEDUCTION', amount: '-250.2500', lineKind: 'STANDARD', source: 'UPLOADED' },
    ];
    let current = settlement(S_DRAFT, { lines: [LINES[0]], netAmount: '50000.0000' });
    serve(
      base({
        [`GET ${detailPath(S_DRAFT)}`]: () => [200, current],
        [`POST ${detailPath(S_DRAFT)}/upload`]: () => {
          current = settlement(S_DRAFT, { lines: uploaded, netAmount: '39750.0000', version: 6 });
          return [200, { template: 'SETTLEMENT_LINES_V1', dryRun: false, total: 2, accepted: 2, rejected: 0, applied: true, errors: [] }];
        },
        [`PUT ${detailPath(S_DRAFT)}/lines`]: () => [200, current],
      }),
    );
    renderAt(`/lifecycle/settlements/${S_DRAFT}`, PREPARER);
    const editor = () => screen.getByRole('form', { name: 'Settlement lines' });
    const amounts = () => (within(editor()).getAllByLabelText('Amount') as HTMLInputElement[]).map((i) => i.value);
    await screen.findByRole('form', { name: 'Settlement lines' });
    expect(amounts()).toEqual(['50000.0000']);
    const section = await findSection('Upload the lines');
    fireEvent.change(within(section).getByLabelText('Settlement lines file (CSV)'), { target: { files: [new File([content], 'lines.csv', { type: 'text/csv' })] } });
    fireEvent.click(button(section, 'Upload and replace the lines'));
    expect(await within(section).findByText('Uploaded: 2 of 2 rows replaced the lines of this draft.')).toBeTruthy();
    // Loaded again: the editor holds the lines the upload left, not the ones it replaced.
    await waitFor(() => expect(amounts()).toEqual(['40000.2500', '-250.2500']));
    fireEvent.click(button(editor(), 'Save lines'));
    await waitFor(() => expect(callsTo('PUT', `${detailPath(S_DRAFT)}/lines`)).toHaveLength(1));
    expect(bodyOf('PUT', `${detailPath(S_DRAFT)}/lines`)).toEqual({
      lines: [
        { componentCode: 'BASIC', amount: '40000.2500', lineKind: 'STANDARD' },
        { componentCode: 'LOAN', amount: '-250.2500', lineKind: 'STANDARD' },
      ],
      expectedVersion: 6,
    });
  });

  it('submits the draft against its version, says in words when no reviewer is eligible, and sends nothing more while in flight', async () => {
    let current = settlement(S_DRAFT);
    let attempt = 0;
    const answer = gate();
    serve(
      base({
        [`GET ${detailPath(S_DRAFT)}`]: () => [200, current],
        [`POST ${detailPath(S_DRAFT)}/submit`]: async () => {
          attempt += 1;
          if (attempt === 1) return [422, { error: 'NO_ELIGIBLE_REVIEWER', message: 'No eligible reviewer is configured for this request; contact HR to repair routing' }];
          await answer.promise;
          current = settlement(S_DRAFT, { state: 'SUBMITTED', submittedAt: '2026-10-26T08:00:00.000Z', version: 6 });
          return [200, current];
        },
      }),
    );
    renderAt(`/lifecycle/settlements/${S_DRAFT}`, PREPARER);
    const section = await findSection('Submit for review');
    fireEvent.click(button(section, 'Submit revision 1 for review'));
    const alert = await within(section).findByRole('alert');
    expect(alert.textContent).toContain('No eligible reviewer is available');
    expect(alert.textContent).toContain('ask HR to update the settlement reviewer list.');
    expect(bodyOf('POST', `${detailPath(S_DRAFT)}/submit`)).toEqual({ expectedVersion: 5 });

    fireEvent.click(button(section, 'Submit revision 1 for review'));
    await waitFor(() => expect(callsTo('POST', `${detailPath(S_DRAFT)}/submit`)).toHaveLength(2));
    expect(button(section, 'Submit revision 1 for review').disabled).toBe(true);
    fireEvent.click(button(section, 'Submit revision 1 for review'));
    answer.open();
    expect(await screen.findByText('Revision 1 submitted: it is frozen and waits for an independent review.')).toBeTruthy();
    expect(callsTo('POST', `${detailPath(S_DRAFT)}/submit`)).toHaveLength(2);
    // Loaded again: a submitted revision is frozen, so no preparation action is left.
    await waitFor(() => expect(term(screen.getByRole('heading', { name: 'Settlement' }).closest('section') as HTMLElement, 'State')).toBe('Waiting for review'));
    expect(screen.queryByRole('heading', { name: 'Submit for review' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Settlement lines' })).toBeNull();
  });

  it('submits only the saved lines: changes still in the line editor block the submission until they are saved', async () => {
    let current = settlement(S_DRAFT, { lines: [LINES[0]], netAmount: '50000.0000' });
    serve(
      base({
        [`GET ${detailPath(S_DRAFT)}`]: () => [200, current],
        [`PUT ${detailPath(S_DRAFT)}/lines`]: () => {
          current = settlement(S_DRAFT, { lines: [{ ...LINES[0], amount: '45000.0000' }], netAmount: '45000.0000', version: 6 });
          return [200, current];
        },
        [`POST ${detailPath(S_DRAFT)}/submit`]: () => {
          current = settlement(S_DRAFT, { lines: [{ ...LINES[0], amount: '45000.0000' }], netAmount: '45000.0000', state: 'SUBMITTED', version: 7 });
          return [200, current];
        },
      }),
    );
    renderAt(`/lifecycle/settlements/${S_DRAFT}`, PREPARER);
    const form = await screen.findByRole('form', { name: 'Settlement lines' });
    const section = await findSection('Submit for review');
    const submit = () => button(section, 'Submit revision 1 for review');
    expect(submit().disabled).toBe(false);
    fireEvent.change(within(form).getByLabelText('Amount'), { target: { value: '45000' } });
    expect(submit().disabled).toBe(true);
    expect(document.getElementById(submit().getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Save the lines first: submitting freezes the saved lines, not changes still in the line editor.',
    );
    fireEvent.click(submit());
    await settle();
    expect(callsTo('POST', `${detailPath(S_DRAFT)}/submit`)).toEqual([]);
    // Typing the saved value back leaves nothing unsaved.
    fireEvent.change(within(form).getByLabelText('Amount'), { target: { value: '50000.0000' } });
    expect(submit().disabled).toBe(false);
    fireEvent.change(within(form).getByLabelText('Amount'), { target: { value: '45000' } });
    fireEvent.click(button(form, 'Save lines'));
    expect((await within(form).findByRole('status')).textContent).toBe('Saved 1 line.');
    // Once the saved lines are loaded again, the revision is submitted against their version.
    await waitFor(() => expect(submit().disabled).toBe(false));
    fireEvent.click(submit());
    await waitFor(() => expect(callsTo('POST', `${detailPath(S_DRAFT)}/submit`)).toHaveLength(1));
    expect(bodyOf('POST', `${detailPath(S_DRAFT)}/submit`)).toEqual({ expectedVersion: 6 });
  });

  it('cancels the draft with a reason, sending nothing without one', async () => {
    let current = settlement(S_DRAFT);
    serve(
      base({
        [`GET ${detailPath(S_DRAFT)}`]: () => [200, current],
        [`POST ${detailPath(S_DRAFT)}/cancel`]: () => {
          current = settlement(S_DRAFT, { state: 'CANCELLED', version: 6 });
          return [200, current];
        },
      }),
    );
    renderAt(`/lifecycle/settlements/${S_DRAFT}`, PREPARER);
    const form = await screen.findByRole('form', { name: 'Cancel this draft' });
    fireEvent.click(button(form, 'Cancel the draft'));
    expect((await within(form).findByRole('alert')).textContent).toBe('Enter why the draft is cancelled.');
    await settle();
    expect(callsTo('POST', `${detailPath(S_DRAFT)}/cancel`)).toEqual([]);
    fireEvent.change(within(form).getByLabelText('Reason for cancelling (required)'), { target: { value: 'Synthetic: prepared against the wrong exit' } });
    fireEvent.click(button(form, 'Cancel the draft'));
    await waitFor(() => expect(callsTo('POST', `${detailPath(S_DRAFT)}/cancel`)).toHaveLength(1));
    expect(bodyOf('POST', `${detailPath(S_DRAFT)}/cancel`)).toEqual({ expectedVersion: 5, reason: 'Synthetic: prepared against the wrong exit' });
    expect(await screen.findByText('Revision 1 cancelled. A new revision can be prepared from the exit’s settlements.')).toBeTruthy();
  });

  it('offers the preparation actions only to the preparer of the revision', async () => {
    serve(base({ [`GET ${detailPath(S_DRAFT)}`]: [200, settlement(S_DRAFT, { preparedBy: U_OTHER })] }));
    renderAt(`/lifecycle/settlements/${S_DRAFT}`, PREPARER);
    expect(await screen.findByText('Only the HR Administrator who prepared this revision can change, submit or cancel it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save lines' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Submit revision/ })).toBeNull();
    expect(screen.queryByLabelText('Settlement lines file (CSV)')).toBeNull();
  });

  it('records release eligibility worded as no payment, and says an incomplete clearance in plain words', async () => {
    let current = APPROVED;
    let attempt = 0;
    serve(
      base({
        [`GET ${detailPath(S_APPROVED)}`]: () => [200, current],
        [`POST ${detailPath(S_APPROVED)}/release-eligibility`]: () => {
          attempt += 1;
          if (attempt === 1) return [409, { error: 'CLEARANCE_INCOMPLETE', message: 'Every required clearance task must be completed first', details: { tasks: ['ASSETS', 'LAPTOP'] } }];
          current = { ...APPROVED, state: 'RELEASE_ELIGIBLE', releaseEligibleAt: '2026-10-26T09:00:00.000Z', version: 8 };
          return [200, current];
        },
      }),
    );
    renderAt(`/lifecycle/settlements/${S_APPROVED}`, [SETTLEMENT_READ, SETTLEMENT_AMOUNT, SETTLEMENT_RELEASE]);
    const section = await findSection('Release eligibility');
    expect(section.textContent).toContain('It is not a payment: nothing is paid, scheduled or recorded as paid here.');
    fireEvent.click(button(section, 'Record release eligibility'));
    const alert = await within(section).findByRole('alert');
    expect(alert.textContent).toContain('Every required exit clearance task must be completed first. Still open: ASSETS, LAPTOP.');
    expect(alert.textContent).toContain('CLEARANCE_INCOMPLETE');
    expect(bodyOf('POST', `${detailPath(S_APPROVED)}/release-eligibility`)).toEqual({ expectedVersion: 7 });
    // Reloaded after the refusal.
    await waitFor(() => expect(callsTo('GET', detailPath(S_APPROVED))).toHaveLength(2));

    fireEvent.click(button(section, 'Record release eligibility'));
    expect(await screen.findByText('Revision 2 is now eligible for release. No payment has been made, scheduled or recorded.')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Eligible for release (not a payment)')).toBeTruthy());
    expect(screen.getByText('Eligible for release. This is not a payment. The payment is made outside this system and then recorded here from its evidence by someone independent.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Release eligibility' })).toBeNull();
  });

  it('starts a revision reached through its link afresh: nothing said about one revision is shown on another', async () => {
    let current = APPROVED;
    serve(
      base({
        [`GET ${detailPath(S_APPROVED)}`]: () => [200, current],
        [`GET ${detailPath(S_SUBMITTED)}`]: [200, settlement(S_SUBMITTED, { state: 'RETURNED', preparedBy: U_OTHER })],
        [`POST ${detailPath(S_APPROVED)}/release-eligibility`]: () => {
          current = { ...APPROVED, state: 'RELEASE_ELIGIBLE', releaseEligibleAt: '2026-10-26T09:00:00.000Z', version: 8 };
          return [200, current];
        },
      }),
    );
    renderAt(`/lifecycle/settlements/${S_APPROVED}`, [SETTLEMENT_READ, SETTLEMENT_RELEASE]);
    fireEvent.click(button(await findSection('Release eligibility'), 'Record release eligibility'));
    const notice = 'Revision 2 is now eligible for release. No payment has been made, scheduled or recorded.';
    expect(await screen.findByText(notice)).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'The previous revision' }));
    expect(await screen.findByRole('heading', { name: 'Settlement of Asha Synthetic (SYN-301), revision 1' })).toBeTruthy();
    expect(screen.queryByText(notice)).toBeNull();
    expect(await screen.findByText('Returned for correction')).toBeTruthy();
  });

  it('does not let the preparer record release eligibility, and says a dependent marker in plain words', async () => {
    serve(
      base({
        [`GET ${detailPath(S_APPROVED)}`]: [200, { ...APPROVED, preparedBy: U_ME }],
      }),
    );
    const view = renderAt(`/lifecycle/settlements/${S_APPROVED}`, [SETTLEMENT_READ, SETTLEMENT_RELEASE]);
    const section = await findSection('Release eligibility');
    expect(within(section).getByText('You prepared this settlement, so someone else records its release eligibility.')).toBeTruthy();
    expect(button(section, 'Record release eligibility').disabled).toBe(true);
    view.unmount();

    serve(
      base({
        [`GET ${detailPath(S_APPROVED)}`]: [200, APPROVED],
        [`POST ${detailPath(S_APPROVED)}/release-eligibility`]: [409, { error: 'NOT_INDEPENDENT', message: 'Release eligibility is decided by someone other than the preparer, reviewer and approver' }],
      }),
    );
    renderAt(`/lifecycle/settlements/${S_APPROVED}`, [SETTLEMENT_READ, SETTLEMENT_RELEASE]);
    const again = await findSection('Release eligibility');
    fireEvent.click(button(again, 'Record release eligibility'));
    expect((await within(again).findByRole('alert')).textContent).toContain(
      'Release eligibility is recorded by someone other than the preparer, the reviewer and the approver of this settlement.',
    );
  });

  it('exports an approved settlement only with the export grant, as CSV, Excel (XLSX) or PDF (FR-054, FR-002)', async () => {
    const downloads = stubDownloads();
    serve(
      base({
        [`GET ${detailPath(S_APPROVED)}`]: [200, APPROVED],
        [`GET ${detailPath(S_APPROVED)}/export`]: (c) =>
          textFile('synthetic', c.params.get('format') === 'PDF' ? 'application/pdf' : 'text/csv; charset=utf-8', `settlement-SYN-301-r2.${(c.params.get('format') ?? 'csv').toLowerCase()}`)(),
      }),
    );
    const view = renderAt(`/lifecycle/settlements/${S_APPROVED}`, [SETTLEMENT_READ]);
    expect(await screen.findByRole('heading', { name: 'Settlement of Asha Synthetic (SYN-301), revision 2' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download the CSV export' })).toBeNull();
    expect(screen.queryByLabelText('Format')).toBeNull();
    view.unmount();

    // FR-002: reading the amounts does not offer the export either; it is its own grant.
    const amounts = renderAt(`/lifecycle/settlements/${S_APPROVED}`, [SETTLEMENT_READ, SETTLEMENT_AMOUNT]);
    expect(await screen.findByRole('heading', { name: 'Settlement of Asha Synthetic (SYN-301), revision 2' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download the CSV export' })).toBeNull();
    amounts.unmount();

    renderAt(`/lifecycle/settlements/${S_APPROVED}`, [SETTLEMENT_READ, SETTLEMENT_EXPORT]);
    const section = await findSection('Export');
    expect(section.textContent).toContain('as CSV, Excel (XLSX) or PDF');
    expect(section.textContent).toContain('nothing is sent');
    expect([...(within(section).getByLabelText('Format') as HTMLSelectElement).options].map((o) => [o.value, o.textContent])).toEqual([
      ['CSV', 'CSV'],
      ['XLSX', 'Excel (XLSX)'],
      ['PDF', 'PDF'],
    ]);
    fireEvent.click(button(section, 'Download the CSV export'));
    await waitFor(() => expect(downloads.click).toHaveBeenCalledTimes(1));
    for (const [i, [format, label]] of (
      [
        ['XLSX', 'Excel (XLSX)'],
        ['PDF', 'PDF'],
      ] as const
    ).entries()) {
      await waitFor(() => expect((within(section).getByLabelText('Format') as HTMLSelectElement).disabled).toBe(false));
      fireEvent.change(within(section).getByLabelText('Format'), { target: { value: format } });
      fireEvent.click(button(section, `Download the ${label} export`));
      await waitFor(() => expect(downloads.click).toHaveBeenCalledTimes(i + 2));
    }
    expect(callsTo('GET', `${detailPath(S_APPROVED)}/export`).map((c) => c.params.get('format'))).toEqual(['CSV', 'XLSX', 'PDF']);
    downloads.restore();
  });
});

describe('the settlements of one exit (FR-052, FR-054)', () => {
  const listPath = `/v1/exit-cases/${X_ASHA}/settlements`;

  it('lists the revisions with the calculation reported, and prepares the first revision with its currency', async () => {
    let revisions: Json[] = [];
    serve({
      [`GET /v1/exit-cases/${X_ASHA}`]: [200, EXIT],
      [`GET ${listPath}`]: () => [200, { calculation: CALCULATION, items: revisions }],
      [`POST ${listPath}`]: () => {
        const s = settlement(S_DRAFT, {}, { netAmount: '0.0000', lines: [] });
        revisions = [s];
        return [201, s];
      },
    });
    renderAt(`/lifecycle/exits/${X_ASHA}/settlements`, [SETTLEMENT_READ, SETTLEMENT_AMOUNT, SETTLEMENT_PREPARE, EXIT_READ]);
    expect(await screen.findByRole('heading', { name: 'Settlements for Asha Synthetic (SYN-301)' })).toBeTruthy();
    expect(await screen.findByText('No settlement has been prepared for this exit yet.')).toBeTruthy();
    expect(screen.getByText(CALCULATION.reason, { exact: false })).toBeTruthy();
    const form = screen.getByRole('form', { name: 'Prepare a revision' });
    const currency = within(form).getByLabelText('Currency (ISO 4217 code, required)') as HTMLInputElement;
    fireEvent.click(button(form, 'Prepare a new revision'));
    expect((await within(form).findByRole('alert')).textContent).toBe('Enter the settlement currency, for example INR.');
    await settle();
    expect(callsTo('POST', listPath)).toEqual([]);
    fireEvent.change(currency, { target: { value: 'inr' } });
    expect(currency.value).toBe('INR');
    fireEvent.click(button(form, 'Prepare a new revision'));
    await waitFor(() => expect(callsTo('POST', listPath)).toHaveLength(1));
    expect(bodyOf('POST', listPath)).toEqual({ currencyCode: 'INR' });
    const status = await screen.findByRole('status');
    expect(status.textContent).toBe('Revision 1 created as a draft. Open revision 1 to enter or upload its lines.');
    expect(within(status).getByRole('link', { name: 'Open revision 1' }).getAttribute('href')).toBe(`/lifecycle/settlements/${S_DRAFT}`);
    // Loaded again: the live draft blocks another revision.
    const table = await screen.findByRole('table', { name: 'Settlement revisions' });
    expect(rows(table).map(cells)).toEqual([['1', 'Draft', 'INR', 'INR 0.00', 'you', localTime('2026-10-25T05:00:00.000Z'), 'Open']]);
    expect(screen.getByText('Revision 1 is live (draft): a new revision can be prepared only once it is returned, rejected or cancelled.')).toBeTruthy();
  });

  it('a correction keeps the earlier currency when left blank, and a refused revision is said in plain words', async () => {
    const returned = settlement(S_SUBMITTED, { state: 'RETURNED' });
    let revisions: Json[] = [returned];
    serve({
      [`GET ${listPath}`]: () => [200, { calculation: CALCULATION, items: revisions }],
      [`POST ${listPath}`]: () => {
        revisions = [returned, settlement(S_DRAFT, { revision: 2, supersedesSettlementId: S_SUBMITTED, preparedBy: U_OTHER })];
        return [409, { error: 'SETTLEMENT_EXISTS', message: 'This exit already has a live settlement revision' }];
      },
    });
    renderAt(`/lifecycle/exits/${X_ASHA}/settlements`, [SETTLEMENT_READ, SETTLEMENT_PREPARE]);
    expect(await screen.findByRole('heading', { name: 'Settlements for Asha Synthetic (SYN-301)' })).toBeTruthy();
    const form = await screen.findByRole('form', { name: 'Prepare a revision' });
    expect(within(form).getByLabelText('Currency (leave blank to keep INR)')).toBeTruthy();
    expect(form.textContent).toContain('With the same currency as revision 1, its lines (active pay components only) are copied into the new draft as a starting point.');
    fireEvent.click(button(form, 'Prepare a new revision'));
    await waitFor(() => expect(callsTo('POST', listPath)).toHaveLength(1));
    expect(bodyOf('POST', listPath)).toEqual({});
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This exit already has a live settlement revision (a draft, or one under review, approved or eligible for release).');
    expect(alert.textContent).toContain('SETTLEMENT_EXISTS');
    // Loaded again: the live revision now blocks another one.
    expect(await screen.findByText('Revision 2 is live (draft): a new revision can be prepared only once it is returned, rejected or cancelled.')).toBeTruthy();
  });
});

describe('settlement decision queues (FR-053; C4; ZT07)', () => {
  const REVIEW = `/v1/settlements/tasks/${K_REVIEW}/review`;
  const APPROVE = `/v1/settlements/tasks/${K_APPROVAL}/approve`;
  const reviewItem = async () => {
    const list = await screen.findByRole('list', { name: 'Settlements waiting for your review' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    return items[0]!;
  };

  it('lists the review tasks only, with the amounts returned, and approves a review with a fresh idempotency key', async () => {
    let tasks: Json[] = [REVIEW_TASK, APPROVAL_TASK];
    serve({
      'GET /v1/settlements/tasks/mine': () => [200, { items: tasks }],
      [`POST ${REVIEW}`]: () => {
        tasks = [APPROVAL_TASK];
        return [200, { settlementId: S_SUBMITTED, state: 'REVIEWED', replayed: false }];
      },
    });
    renderQueue(0, REVIEWER);
    const item = await reviewItem();
    expect(within(item).getByRole('heading').textContent).toBe('Review: settlement of Ravi Synthetic (SYN-302), revision 1');
    expect(term(item, 'Net amount')).toBe('INR 52,345.18 (exactly 52345.1789)');
    expect(rows(within(item).getByRole('table', { name: 'Settlement lines' }))).toHaveLength(3);
    expect(within(item).getByRole('link', { name: 'Open the settlement of Ravi Synthetic (SYN-302)' }).getAttribute('href')).toBe(`/lifecycle/settlements/${S_SUBMITTED}`);
    fireEvent.click(button(item, 'Approve the review'));
    await waitFor(() => expect(callsTo('POST', REVIEW)).toHaveLength(1));
    expect(bodyOf('POST', REVIEW)).toEqual({ decision: 'APPROVE', idempotencyKey: expect.stringMatching(/^settlement-review-[0-9a-f-]{36}$/) });
    expect((await screen.findByRole('status')).textContent).toBe('Reviewed revision 1 of the settlement of Ravi Synthetic (SYN-302): it now waits for an independent approval.');
    expect(screen.queryByRole('list', { name: 'Settlements waiting for your review' })).toBeNull();
    expect(await screen.findByText('No settlements are waiting for your review.')).toBeTruthy();
  });

  it('needs a reason to return or reject, sending nothing without one', async () => {
    serve({
      'GET /v1/settlements/tasks/mine': [200, { items: [REVIEW_TASK] }],
      [`POST ${REVIEW}`]: [200, { settlementId: S_SUBMITTED, state: 'RETURNED', replayed: false }],
    });
    renderQueue(0, REVIEWER);
    const item = await reviewItem();
    fireEvent.click(button(item, 'Return for correction'));
    expect((await within(item).findByRole('alert')).textContent).toBe('Enter a reason to return the settlement for correction.');
    fireEvent.click(button(item, 'Reject'));
    expect(within(item).getByRole('alert').textContent).toBe('Enter a reason to reject the settlement.');
    await settle();
    expect(callsTo('POST', REVIEW)).toEqual([]);
    fireEvent.change(within(item).getByLabelText('Reason (required to return or reject)'), { target: { value: 'Synthetic: loan figure to confirm' } });
    fireEvent.click(button(item, 'Return for correction'));
    await waitFor(() => expect(callsTo('POST', REVIEW)).toHaveLength(1));
    expect(bodyOf('POST', REVIEW)).toEqual({ decision: 'RETURN', reason: 'Synthetic: loan figure to confirm', idempotencyKey: expect.stringMatching(/^settlement-review-/) });
    expect((await screen.findByRole('status')).textContent).toBe(
      'Returned revision 1 of the settlement of Ravi Synthetic (SYN-302) for correction: the preparer prepares a corrected revision.',
    );
  });

  it('sends a decision whose answer was lost again under the same key, and disables the decision while one is in flight', async () => {
    const answer = gate();
    let attempt = 0;
    serve({
      'GET /v1/settlements/tasks/mine': [200, { items: [REVIEW_TASK] }],
      [`POST ${REVIEW}`]: async () => {
        attempt += 1;
        if (attempt === 1) {
          await answer.promise;
          throw new TypeError('Failed to fetch');
        }
        return [200, { settlementId: S_SUBMITTED, state: 'REVIEWED', replayed: true }];
      },
    });
    renderQueue(0, REVIEWER);
    const item = await reviewItem();
    fireEvent.click(button(item, 'Approve the review'));
    await waitFor(() => expect(callsTo('POST', REVIEW)).toHaveLength(1));
    for (const name of ['Approve the review', 'Return for correction', 'Reject']) expect(button(item, name).disabled).toBe(true);
    answer.open();
    expect((await within(item).findByRole('alert')).textContent).toBe(
      'No answer came back, so your decision may or may not have been recorded. Send the same decision again: it is never applied twice.',
    );
    expect(button(item, 'Approve the review').disabled).toBe(false);
    fireEvent.click(button(item, 'Approve the review'));
    await waitFor(() => expect(callsTo('POST', REVIEW)).toHaveLength(2));
    const [first, second] = callsTo('POST', REVIEW).map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(second).toBe(first);
    expect((await screen.findByRole('status')).textContent).toBe(
      'Reviewed revision 1 of the settlement of Ravi Synthetic (SYN-302): it now waits for an independent approval. Your earlier attempt had already been recorded, so nothing was applied twice.',
    );
  });

  it('says refused decisions in plain words: a task decided meanwhile leaves the queue, a missing approver stays explained', async () => {
    serve({
      'GET /v1/settlements/tasks/mine': [200, { items: [REVIEW_TASK] }],
      [`POST ${REVIEW}`]: (c) =>
        (c.body as { decision: string }).decision === 'APPROVE'
          ? [422, { error: 'NO_ELIGIBLE_REVIEWER', message: 'No eligible reviewer is configured for this request; contact HR to repair routing' }]
          : [409, { error: 'TASK_CLOSED', message: 'This task has already been decided' }],
    });
    renderQueue(0, REVIEWER);
    const item = await reviewItem();
    fireEvent.click(button(item, 'Approve the review'));
    const alert = await within(item).findByRole('alert');
    expect(alert.textContent).toContain('No eligible approver is available for the next step');
    expect(alert.textContent).toContain('NO_ELIGIBLE_REVIEWER');
    fireEvent.change(within(item).getByLabelText('Reason (required to return or reject)'), { target: { value: 'Synthetic: duplicate submission' } });
    fireEvent.click(button(item, 'Reject'));
    expect((await screen.findByText('Settlement of Ravi Synthetic (SYN-302): This task has already been decided.')).getAttribute('role')).toBe('alert');
    expect(screen.queryByRole('list', { name: 'Settlements waiting for your review' })).toBeNull();
  });

  it('the approval queue lists the approval tasks and decides them on the approval route; approval is not release and no payment', async () => {
    serve({
      'GET /v1/settlements/tasks/mine': [200, { items: [REVIEW_TASK, APPROVAL_TASK] }],
      [`POST ${APPROVE}`]: [200, { settlementId: S_REVIEWED, state: 'APPROVED', replayed: false }],
    });
    renderQueue(1, [SETTLEMENT_READ, SETTLEMENT_AMOUNT, SETTLEMENT_APPROVE]);
    const list = await screen.findByRole('list', { name: 'Settlements waiting for your approval' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(within(items[0]!).getByRole('heading').textContent).toBe('Approval: settlement of Asha Synthetic (SYN-301), revision 2');
    fireEvent.click(button(items[0]!, 'Approve'));
    await waitFor(() => expect(callsTo('POST', APPROVE)).toHaveLength(1));
    expect(bodyOf('POST', APPROVE)).toEqual({ decision: 'APPROVE', idempotencyKey: expect.stringMatching(/^settlement-approval-[0-9a-f-]{36}$/) });
    expect((await screen.findByRole('status')).textContent).toBe(
      'Approved revision 2 of the settlement of Asha Synthetic (SYN-301). It is not yet eligible for release, and no payment is made here.',
    );
    expect(callsTo('POST', REVIEW)).toEqual([]);
  });

  it('shows no amount in a task when the API omits them, and blocks a decision about one’s own record', async () => {
    const own = { ...REVIEW_TASK, settlement: settlement(S_SUBMITTED, { employeeId: E_RAVI, employeeCode: 'SYN-302', employeeName: 'Ravi Synthetic', state: 'SUBMITTED', preparedBy: U_OTHER }, null) };
    serve({ 'GET /v1/settlements/tasks/mine': [200, { items: [own] }] });
    renderQueue(0, [SETTLEMENT_READ, SETTLEMENT_REVIEW], E_RAVI);
    const item = await reviewItem();
    expect(within(item).queryByText('Net amount')).toBeNull();
    expect(within(item).queryByRole('table', { name: 'Settlement lines' })).toBeNull();
    expect(item.textContent).not.toMatch(/INR [-\d]/);
    expect(within(item).getByText('This settlement is about your own record, so someone else decides it.')).toBeTruthy();
    expect(button(item, 'Approve the review').disabled).toBe(true);
    expect(within(item).queryByLabelText('Reason (required to return or reject)')).toBeNull();
  });

  it('lists nothing without the settlement read duty, and says when the role cannot decide', async () => {
    serve({ 'GET /v1/settlements/tasks/mine': [200, { items: [REVIEW_TASK] }] });
    const view = renderQueue(0, [SETTLEMENT_REVIEW]);
    expect((await screen.findByRole('note')).textContent).toContain('The selected role cannot list settlement tasks: that needs the settlement read duty as well.');
    await settle();
    expect(calls).toEqual([]);
    view.unmount();

    renderQueue(1, [SETTLEMENT_READ, SETTLEMENT_REVIEW]);
    expect((await screen.findByRole('note')).textContent).toContain('The selected role cannot make this decision: it needs the confidential settlement approval grant.');
    await settle();
    expect(calls).toEqual([]);
  });

  it('shows both queues on the settlements screen for a role holding both decision grants, from one task list', async () => {
    serve({
      'GET /v1/settlements': [200, { calculation: CALCULATION, items: [] }],
      'GET /v1/settlements/tasks/mine': [200, { items: [REVIEW_TASK, APPROVAL_TASK] }],
    });
    renderAt('/lifecycle/settlements', [SETTLEMENT_READ, SETTLEMENT_AMOUNT, SETTLEMENT_REVIEW, SETTLEMENT_APPROVE]);
    expect(await screen.findByRole('list', { name: 'Settlements waiting for your review' })).toBeTruthy();
    expect(await screen.findByRole('list', { name: 'Settlements waiting for your approval' })).toBeTruthy();
    expect(callsTo('GET', '/v1/settlements/tasks/mine')).toHaveLength(1);
  });
});

describe('settlement payment, void, in-app sending and list selection (I-81)', () => {
  const RECORD_PAYMENT = 'settlement.record_payment.amount';
  const SEND = 'settlement.send.amount';
  const DOCUMENT_READ = 'document.read.document';
  const ELIGIBLE = { ...APPROVED, id: S_ELIGIBLE, state: 'RELEASE_ELIGIBLE', paymentStatus: 'NOT_PAID', releaseEligibleAt: '2026-10-26T09:00:00.000Z', version: 8 };
  const DOC = { id: 'd0000000-0000-4000-8000-000000000001', documentType: 'GENERAL', fileName: 'neft.pdf', uploadedAt: '2026-10-27T05:00:00.000Z', scanState: 'CLEAN', verificationState: 'VERIFIED' };
  const base = (overrides: Record<string, Route> = {}): Record<string, Route> => ({
    'GET /v1/settlements/calculation': [200, CALCULATION],
    [`GET /v1/exit-cases/${X_ASHA}`]: [200, EXIT],
    [`GET /v1/employees/${E_ASHA}/documents`]: [200, { items: [DOC] }],
    [`GET /v1/settlements/${S_ELIGIBLE}/deliveries`]: [200, { items: [] }],
    ...overrides,
  });

  it('FR-053 records the payment made outside the system from its evidence, by someone independent; the date is the disbursement month', async () => {
    let current: Json = ELIGIBLE;
    serve(
      base({
        [`GET /v1/settlements/${S_ELIGIBLE}`]: () => [200, current],
        [`POST /v1/settlements/${S_ELIGIBLE}/payment`]: () => {
          current = { ...ELIGIBLE, state: 'PAID', paymentStatus: 'PAID', paymentDate: '2026-10-28', payment: { paidAt: '2026-10-28T09:00:00.000Z', paidBy: U_ME, reference: 'NEFT-1' }, version: 9 };
          return [200, { ...current, replayed: false }];
        },
      }),
    );
    renderAt(`/lifecycle/settlements/${S_ELIGIBLE}`, [SETTLEMENT_READ, SETTLEMENT_AMOUNT, RECORD_PAYMENT, DOCUMENT_READ]);
    const section = await findSection('Record the payment');
    fireEvent.change(within(section).getByLabelText('Payment date'), { target: { value: '2026-10-28' } });
    fireEvent.change(within(section).getByLabelText('Bank or receipt reference'), { target: { value: 'NEFT-1' } });
    fireEvent.click(await within(section).findByRole('radio'));
    fireEvent.click(button(section, 'Record the payment'));
    expect(await screen.findByText('The payment of revision 2 is recorded from its evidence.')).toBeTruthy();
    const body = bodyOf('POST', `/v1/settlements/${S_ELIGIBLE}/payment`) as Record<string, unknown>;
    expect(body).toMatchObject({ paymentDate: '2026-10-28', evidenceReference: 'NEFT-1', evidenceDocumentIds: [DOC.id], expectedVersion: 8 });
    expect(typeof body.evidenceKey).toBe('string');
    await waitFor(() => expect(screen.getByText('Paid: recorded from evidence')).toBeTruthy());
    expect(screen.queryByRole('heading', { name: 'Record the payment' })).toBeNull();
  });

  it('FR-052 FR-053 voids a live revision with the reason, and says a refusal in words', async () => {
    serve(
      base({
        [`GET /v1/settlements/${S_ELIGIBLE}`]: [200, ELIGIBLE],
        [`POST /v1/settlements/${S_ELIGIBLE}/void`]: [409, { error: 'NOT_INDEPENDENT', message: 'x' }],
      }),
    );
    renderAt(`/lifecycle/settlements/${S_ELIGIBLE}`, [SETTLEMENT_READ, SETTLEMENT_AMOUNT, SETTLEMENT_APPROVE]);
    const section = await findSection('Void this revision');
    expect(button(section, 'Void the revision').disabled).toBe(true);
    fireEvent.change(within(section).getByLabelText('Reason'), { target: { value: 'Final-period payroll paid BASIC' } });
    fireEvent.click(button(section, 'Void the revision'));
    expect((await within(section).findByRole('alert')).textContent).toContain('A revision is voided by someone other than its preparer and its employee.');
    expect(bodyOf('POST', `/v1/settlements/${S_ELIGIBLE}/void`)).toEqual({ reason: 'Final-period payroll paid BASIC', expectedVersion: 8 });
  });

  it('FR-054 FR-018 sends the statement to the employee’s own self-service only after the recipient is confirmed', async () => {
    serve(
      base({
        [`GET /v1/settlements/${S_ELIGIBLE}`]: [200, ELIGIBLE],
        [`POST /v1/settlements/${S_ELIGIBLE}/send`]: [201, { id: 'dl-1', kind: 'SETTLEMENT_STATEMENT', format: 'XLSX', sourceRevision: 2, status: 'DELIVERED', sentBy: U_ME, sentAt: '2026-10-28T09:00:00.000Z', firstReadAt: null }],
      }),
    );
    renderAt(`/lifecycle/settlements/${S_ELIGIBLE}`, [SETTLEMENT_READ, SETTLEMENT_AMOUNT, SEND]);
    const section = await findSection('Send to the employee’s self-service');
    expect(section.textContent).toContain('nothing is attached to an e-mail');
    expect(button(section, /Send the PDF statement/).disabled).toBe(true);
    fireEvent.change(within(section).getByLabelText('Format'), { target: { value: 'XLSX' } });
    fireEvent.click(within(section).getByRole('checkbox'));
    fireEvent.click(button(section, /Send the Excel statement/));
    await waitFor(() => expect(callsTo('POST', `/v1/settlements/${S_ELIGIBLE}/send`)).toHaveLength(1));
    expect(bodyOf('POST', `/v1/settlements/${S_ELIGIBLE}/send`)).toMatchObject({ format: 'XLSX', recipientEmployeeId: E_ASHA });
  });

  it('FR-054 filters by disbursement month and selects from an uploaded list of employee codes', async () => {
    serve({
      'GET /v1/settlements': [200, { calculation: CALCULATION, total: 0, items: [] }],
      'POST /v1/settlements/selection': [
        200,
        {
          template: 'SETTLEMENT_SELECTION_V1',
          total: 2,
          matched: 1,
          rows: [
            { row: 2, employeeCode: 'SYN-301', outcome: 'MATCHED', settlements: 1 },
            { row: 3, employeeCode: 'NOPE', outcome: 'NOT_FOUND', settlements: 0 },
          ],
          items: [summary(S_ELIGIBLE, { revision: 2, state: 'PAID' }, true)],
        },
      ],
    });
    renderAt('/lifecycle/settlements', [SETTLEMENT_READ, SETTLEMENT_AMOUNT, SETTLEMENT_EXPORT]);
    fireEvent.change(await screen.findByLabelText('Disbursement month (recorded payment date)'), { target: { value: '2026-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show settlements' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/v1/settlements' && c.params.get('disbursementMonth') === '2026-10')).toBe(true));
    const file = new File(['employee_code\r\nSYN-301\r\nNOPE\r\n'], 'list.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('Employee list file'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Select from the list' }));
    const outcomes = await screen.findByRole('table', { name: 'Uploaded list rows' });
    expect(rows(outcomes).map(cells)).toEqual([
      ['2', 'SYN-301', 'Matched (1)'],
      ['3', 'NOPE', 'No employee with this code in the selected role’s scope'],
    ]);
    expect(await screen.findByText('1 of at most 100 selected.')).toBeTruthy();
    expect(calls.find((c) => c.path === '/v1/settlements/selection')!.body).toMatchObject({ disbursementMonth: '2026-10' });
  });
});

describe('the settlement calculation (FR-052; I-88)', () => {
  const WAIVE = 'settlement.waive_notice.amount';
  const C_FIRST = 'c1000000-0000-4000-8000-000000000001';
  const C_EARLIER = 'c1000000-0000-4000-8000-000000000002';
  const AVAILABLE = { status: 'AVAILABLE', reason: 'A draft is calculated from a versioned snapshot (synthetic reason).' };
  const detailPath = `/v1/settlements/${S_DRAFT}`;
  const ITEMS = [
    {
      position: 1,
      kind: 'EARNINGS_DUE',
      status: 'CALCULATED',
      blocking: false,
      componentCode: 'BASIC',
      componentKind: 'EARNING',
      amount: '9032.2600',
      basis: { daysInMonth: 31, segments: [{ arrangementId: 'f2000000-0000-4000-8000-000000000001', start: '2026-10-01', end: '2026-10-31', monthlyAmount: '20000.0000', paidDays: '14.0000' }] },
      leaveTypeCode: null,
    },
    {
      position: 2,
      kind: 'LEAVE_ENCASHMENT',
      status: 'CALCULATED',
      blocking: false,
      componentCode: 'LEAVE_ENC',
      componentKind: 'EARNING',
      amount: '13500.0000',
      basis: { leaveType: 'EL', asOf: '2026-10-31', available: '18.5000', pending: '0.0000', cap: '15', units: '15', rateBasis: 'BASIC_DA', monthlyRate: '27000.0000', divisor: 30 },
      leaveTypeCode: 'EL',
    },
    {
      position: 3,
      kind: 'NOTICE_RECOVERY',
      status: 'CALCULATED',
      blocking: false,
      componentCode: 'NOTICE_REC',
      componentKind: 'DEDUCTION',
      amount: '-5833.3300',
      basis: { requestDate: '2026-10-01', lastWorkingDate: '2026-10-25', requiredDays: 30, servedDays: 25, shortfallDays: 5, rateBasis: 'GROSS', monthlyRate: '35000.0000', divisor: 30 },
      leaveTypeCode: null,
    },
    {
      position: 4,
      kind: 'GRATUITY',
      status: 'RULE_PACK_NOT_CONFIGURED',
      blocking: true,
      componentCode: null,
      componentKind: null,
      amount: null,
      basis: { rulePackCode: 'GRATUITY', packRevision: 1, packState: 'DRAFT', completedYears: 7, partYearCounts: false, countedYears: 7, minimumServiceYears: 5, exemptSeparation: false },
      leaveTypeCode: null,
    },
    {
      position: 5,
      kind: 'STATUTORY_DEDUCTION',
      status: 'NOT_APPLICABLE',
      blocking: false,
      componentCode: null,
      componentKind: null,
      amount: null,
      basis: { tax: 'NOT_CONFIGURED', reason: 'No statutory head applies (synthetic).' },
      leaveTypeCode: null,
    },
  ];
  const SNAPSHOT = {
    id: C_FIRST,
    sequence: 2,
    calculatedAt: '2026-11-05T06:00:00.000Z',
    calculatedBy: U_ME,
    lastWorkingDate: '2026-10-31',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    currencyCode: 'INR',
    policyId: 'f3000000-0000-4000-8000-000000000001',
    policyRevision: 2,
    gratuityPackId: 'f4000000-0000-4000-8000-000000000001',
    valuationPolicyId: null,
    paidDayPolicyId: null,
    itemCount: 5,
    blockingCount: 1,
    inputs: {},
    items: ITEMS,
  };
  const calculatedLine = (componentCode: string, componentName: string, componentKind: string, amount: string, lineKind = 'STANDARD') => ({
    componentCode,
    componentName,
    componentKind,
    amount,
    lineKind,
    source: 'CALCULATED',
    calculationId: C_FIRST,
    reason: null,
  });
  const BONUS = {
    componentCode: 'BONUS',
    componentName: 'Bonus (synthetic)',
    componentKind: 'EARNING',
    amount: '1000.0000',
    lineKind: 'STANDARD',
    source: 'ENTERED',
    calculationId: null,
    reason: 'Synthetic: festival bonus agreed in writing',
  };
  const CALCULATED_LINES = [
    calculatedLine('BASIC', 'Basic pay (synthetic)', 'EARNING', '9032.2600'),
    calculatedLine('LEAVE_ENC', 'Leave encashment (synthetic)', 'EARNING', '13500.0000'),
    calculatedLine('NOTICE_REC', 'Notice recovery (synthetic)', 'DEDUCTION', '-5833.3300', 'NOTICE_ADJUSTMENT'),
  ];
  const notCalculated = (patch: Json = {}) => settlement(S_DRAFT, { calculation: null, noticeWaiver: null, ...patch }, { netAmount: '1000.0000', lines: [BONUS] });
  const calculated = (patch: Json = {}) =>
    settlement(S_DRAFT, { calculationStatus: 'CALCULATED', calculation: SNAPSHOT, noticeWaiver: null, version: 6, ...patch }, { netAmount: '17698.9300', lines: [...CALCULATED_LINES, BONUS] });
  const base = (overrides: Record<string, Route> = {}): Record<string, Route> => ({
    'GET /v1/settlements/calculation': [200, AVAILABLE],
    [`GET /v1/exit-cases/${X_ASHA}`]: [200, EXIT],
    ...overrides,
  });

  it('calculates the draft against its version and shows each item with its basis, a blocking item marked "Blocks approval"', async () => {
    let current = notCalculated();
    let attempt = 0;
    serve(
      base({
        [`GET ${detailPath}`]: () => [200, current],
        [`POST ${detailPath}/calculate`]: () => {
          attempt += 1;
          if (attempt === 1) return [409, { error: 'MANUAL_LINE_CONFLICT', message: 'An entered line uses a component the calculation produces', details: { components: ['BASIC'] } }];
          current = calculated();
          return [200, current];
        },
      }),
    );
    renderAt(`/lifecycle/settlements/${S_DRAFT}`, PREPARER);
    const calculation = await findSection('Calculation');
    expect(await within(calculation).findByText('Not calculated yet.')).toBeTruthy();
    expect(within(calculation).queryByRole('table', { name: 'Calculation items' })).toBeNull();
    // How a draft is calculated is the server's to say: a hint for a draft that is not calculated.
    const facts = await findSection('Settlement');
    expect(await within(facts).findByText(AVAILABLE.reason)).toBeTruthy();
    expect(term(facts, 'Calculation')).toBe('Not calculated (lines entered or uploaded)');

    const section = await findSection('Calculate');
    fireEvent.click(button(section, 'Calculate'));
    const alert = await within(section).findByRole('alert');
    expect(alert.textContent).toContain('An entered line uses a component the calculation produces: BASIC. Remove it and calculate again.');
    expect(alert.textContent).toContain('MANUAL_LINE_CONFLICT');
    expect(bodyOf('POST', `${detailPath}/calculate`)).toEqual({ expectedVersion: 5 });

    fireEvent.click(button(section, 'Calculate'));
    await waitFor(() => expect(callsTo('POST', `${detailPath}/calculate`)).toHaveLength(2));
    expect(bodyOf('POST', `${detailPath}/calculate`, 1)).toEqual({ expectedVersion: 5 });
    expect((await within(section).findByRole('status')).textContent).toBe('Calculated: snapshot 2, 5 items, 1 blocking approval.');
    expect(button(section, 'Calculate again')).toBeTruthy();

    const items = await screen.findByRole('table', { name: 'Calculation items' });
    expect(headers(items)).toEqual(['Item', 'Status', 'Pay component', 'Leave type', 'Amount', 'How']);
    expect(rows(items).map(cells)).toEqual([
      ['Earnings due', 'Calculated', 'BASIC', '', 'INR 9,032.26', '20,000.00 x 14 paid days / 31'],
      ['Leave encashment', 'Calculated', 'LEAVE_ENC', 'EL', 'INR 13,500.00', '15 of 18.5 units (cap 15) x 27,000.00 / 30; rate on Basic + DA'],
      ['Notice recovery', 'Calculated', 'NOTICE_REC', '', 'INR -5,833.33', '30 required, 25 served: 5 days x 35,000.00 / 30; rate on Monthly gross (every fixed earning)'],
      ['Gratuity', 'Rule pack not configured Blocks approval', '', '', '', '7 counted years; pack revision 1 (inactive draft)'],
      ['Tax and statutory deductions', 'Not applicable', '', '', '', 'No statutory head applies (synthetic).'],
    ]);
    // "Blocks approval" is words, not colour alone, and only on the blocking item.
    expect(within(items).getAllByText('Blocks approval')).toHaveLength(1);
    const view = items.closest('section') as HTMLElement;
    expect(term(view, 'Snapshot')).toBe('2');
    expect(term(view, 'Calculated')).toBe(`${localTime('2026-11-05T06:00:00.000Z')} by you`);
    expect(term(view, 'Last working date')).toBe('2026-10-31');
    expect(term(view, 'Period')).toBe('2026-10-01 to 2026-10-31');
    expect(term(view, 'Blocking items')).toBe('1 blocks approval');
    await waitFor(() => expect(term(screen.getByRole('heading', { name: 'Settlement' }).closest('section') as HTMLElement, 'Calculation')).toBe('Calculated from a snapshot'));
    // Calculated: the hint about how drafts are calculated goes, and the upload is not offered.
    expect(screen.queryByText(AVAILABLE.reason)).toBeNull();
    expect(screen.queryByLabelText('Settlement lines file (CSV)')).toBeNull();
  });

  it('lists earlier snapshots only when asked, newest first, without the one the revision carries', async () => {
    serve(
      base({
        [`GET ${detailPath}`]: [200, calculated()],
        [`GET ${detailPath}/calculations`]: [
          200,
          { items: [SNAPSHOT, { ...SNAPSHOT, id: C_EARLIER, sequence: 1, calculatedAt: '2026-11-04T06:00:00.000Z', itemCount: 4, blockingCount: 2 }] },
        ],
      }),
    );
    renderAt(`/lifecycle/settlements/${S_DRAFT}`, [SETTLEMENT_READ, SETTLEMENT_AMOUNT]);
    await screen.findByRole('table', { name: 'Calculation items' });
    await settle();
    expect(callsTo('GET', `${detailPath}/calculations`)).toEqual([]);
    const details = screen.getByText('Earlier snapshots', { selector: 'summary' }).closest('details') as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    const list = await screen.findByRole('list', { name: 'Earlier snapshots' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([`Snapshot 1, calculated ${localTime('2026-11-04T06:00:00.000Z')}: 4 items, 2 blocking approval`]);
  });

  it('shows calculated and entered lines apart, the entered ones with their reason; the editor changes the entered lines only, each with a reason', async () => {
    let current = calculated();
    let attempt = 0;
    serve(
      base({
        [`GET ${detailPath}`]: () => [200, current],
        [`PUT ${detailPath}/lines`]: () => {
          attempt += 1;
          if (attempt === 1) return [422, { error: 'COMPONENT_CALCULATED', message: 'The calculation already produces this component', details: { line: 2 } }];
          current = calculated({
            lines: [...CALCULATED_LINES, BONUS, { ...BONUS, componentCode: 'ADV_REC', componentName: 'Advance recovery (synthetic)', componentKind: 'DEDUCTION', amount: '-500.0000', reason: 'Synthetic: advance agreed' }],
            version: 7,
          });
          return [200, current];
        },
      }),
    );
    renderAt(`/lifecycle/settlements/${S_DRAFT}`, PREPARER);
    const calculatedTable = await screen.findByRole('table', { name: 'Calculated lines' });
    expect(headers(calculatedTable)).toEqual(['Pay component', 'Kind', 'Line kind', 'Amount']);
    expect(rows(calculatedTable).map(cells)).toEqual([
      ['Basic pay (synthetic) BASIC', 'Earning', 'Standard', 'INR 9,032.26'],
      ['Leave encashment (synthetic) LEAVE_ENC', 'Earning', 'Standard', 'INR 13,500.00'],
      ['Notice recovery (synthetic) NOTICE_REC', 'Deduction', 'Notice adjustment', 'INR -5,833.33'],
    ]);
    const entered = screen.getByRole('table', { name: 'Entered lines' });
    expect(rows(entered).map(cells)).toEqual([['Bonus (synthetic) BONUS', 'Earning', 'Standard', 'Entered', 'INR 1,000.00', 'Synthetic: festival bonus agreed in writing']]);
    expect((screen.getByText('Net amount:').closest('p') as HTMLElement).textContent).toContain('INR 17,698.93');

    // The upload would replace the calculated lines: it is not offered, and the screen says why.
    const upload = await findSection('Upload the lines');
    expect(upload.textContent).toContain('This draft is calculated, so its lines are not uploaded');
    expect(within(upload).queryByLabelText('Settlement lines file (CSV)')).toBeNull();

    const form = await screen.findByRole('form', { name: 'Settlement lines' });
    const editor = form.closest('section') as HTMLElement;
    expect(editor.textContent).toContain('Entered lines are for components the calculation does not produce');
    expect((within(form).getAllByLabelText('Pay component code') as HTMLInputElement[]).map((i) => i.value)).toEqual(['BONUS']);
    expect((within(form).getByLabelText('Reason (required)') as HTMLInputElement).value).toBe('Synthetic: festival bonus agreed in writing');
    fireEvent.click(button(form, 'Add a line'));
    const codes = within(form).getAllByLabelText('Pay component code') as HTMLInputElement[];
    const amounts = within(form).getAllByLabelText('Amount') as HTMLInputElement[];
    const reasons = within(form).getAllByLabelText('Reason (required)') as HTMLInputElement[];
    fireEvent.change(codes[1]!, { target: { value: 'adv_rec' } });
    fireEvent.change(amounts[1]!, { target: { value: '-500' } });
    fireEvent.click(button(form, 'Save lines'));
    expect((await within(form).findByRole('alert')).textContent).toBe('Line 2: enter why this line is entered: this draft is calculated, so each entered line states its reason.');
    await settle();
    expect(callsTo('PUT', `${detailPath}/lines`)).toEqual([]);

    fireEvent.change(reasons[1]!, { target: { value: 'Synthetic: advance agreed' } });
    fireEvent.click(button(form, 'Save lines'));
    await waitFor(() => expect(callsTo('PUT', `${detailPath}/lines`)).toHaveLength(1));
    // Only the entered lines are sent: the server keeps the calculated ones.
    expect(bodyOf('PUT', `${detailPath}/lines`)).toEqual({
      lines: [
        { componentCode: 'BONUS', amount: '1000.0000', lineKind: 'STANDARD', reason: 'Synthetic: festival bonus agreed in writing' },
        { componentCode: 'ADV_REC', amount: '-500', lineKind: 'STANDARD', reason: 'Synthetic: advance agreed' },
      ],
      expectedVersion: 6,
    });
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toContain('Line 2: the calculation already produces this pay component, so it is not entered as well.');
    expect(alert.textContent).toContain('COMPONENT_CALCULATED');

    fireEvent.click(button(form, 'Save lines'));
    expect((await within(form).findByRole('status')).textContent).toBe('Saved 2 lines.');
    await waitFor(() => expect(rows(screen.getByRole('table', { name: 'Entered lines' }))).toHaveLength(2));
    expect((within(form).getAllByLabelText('Pay component code') as HTMLInputElement[]).map((i) => i.value)).toEqual(['BONUS', 'ADV_REC']);
  });

  it('sends an optional reason with an entered line of a draft that is not calculated', async () => {
    serve(
      base({
        [`GET ${detailPath}`]: [200, notCalculated()],
        [`PUT ${detailPath}/lines`]: [200, notCalculated({ version: 6 })],
      }),
    );
    renderAt(`/lifecycle/settlements/${S_DRAFT}`, PREPARER);
    const form = await screen.findByRole('form', { name: 'Settlement lines' });
    fireEvent.change(within(form).getByLabelText('Reason (optional)'), { target: { value: 'Synthetic: confirmed by the manager' } });
    fireEvent.click(button(form, 'Save lines'));
    await waitFor(() => expect(callsTo('PUT', `${detailPath}/lines`)).toHaveLength(1));
    expect(bodyOf('PUT', `${detailPath}/lines`)).toEqual({
      lines: [{ componentCode: 'BONUS', amount: '1000.0000', lineKind: 'STANDARD', reason: 'Synthetic: confirmed by the manager' }],
      expectedVersion: 5,
    });
    // Not calculated: the upload is offered as before.
    expect(within(await findSection('Upload the lines')).getByLabelText('Settlement lines file (CSV)')).toBeTruthy();
  });

  it('offers the notice recovery waiver only with its own right, to someone other than the preparer, and posts the reason', async () => {
    let current = calculated({ preparedBy: U_OTHER });
    serve(
      base({
        [`GET ${detailPath}`]: () => [200, current],
        [`POST /v1/exit-cases/${X_ASHA}/notice-waiver`]: () => {
          current = calculated({
            preparedBy: U_OTHER,
            noticeWaiver: { id: 'f5000000-0000-4000-8000-000000000001', reason: 'Synthetic: relieved early at our request', waivedBy: U_ME, waivedAt: '2026-11-05T07:00:00.000Z' },
          });
          return [201, { id: 'f5000000-0000-4000-8000-000000000001', exitCaseId: X_ASHA, waivedBy: U_ME }];
        },
      }),
    );
    const without = renderAt(`/lifecycle/settlements/${S_DRAFT}`, [SETTLEMENT_READ, SETTLEMENT_AMOUNT]);
    await screen.findByRole('table', { name: 'Calculation items' });
    expect(screen.queryByRole('heading', { name: 'Waive the notice recovery' })).toBeNull();
    without.unmount();

    // The preparer holding the right is told someone else waives it.
    current = calculated();
    const preparer = renderAt(`/lifecycle/settlements/${S_DRAFT}`, [...PREPARER, WAIVE]);
    const own = await findSection('Waive the notice recovery');
    expect(within(own).getByText('You prepared this settlement, so someone else waives its notice recovery.')).toBeTruthy();
    expect(button(own, 'Waive the notice recovery').disabled).toBe(true);
    preparer.unmount();

    current = calculated({ preparedBy: U_OTHER });
    renderAt(`/lifecycle/settlements/${S_DRAFT}`, [SETTLEMENT_READ, SETTLEMENT_AMOUNT, WAIVE]);
    const section = await findSection('Waive the notice recovery');
    expect(section.textContent).toContain('The calculation recovers 5 days of notice not served.');
    const form = within(section).getByRole('form', { name: 'Waive the notice recovery' });
    fireEvent.click(button(form, 'Waive the notice recovery'));
    expect((await within(form).findByRole('alert')).textContent).toBe('Enter why the notice recovery is waived.');
    await settle();
    expect(callsTo('POST', `/v1/exit-cases/${X_ASHA}/notice-waiver`)).toEqual([]);
    fireEvent.change(within(form).getByLabelText('Reason for waiving (required)'), { target: { value: '  Synthetic: relieved early at our request ' } });
    fireEvent.click(button(form, 'Waive the notice recovery'));
    await waitFor(() => expect(callsTo('POST', `/v1/exit-cases/${X_ASHA}/notice-waiver`)).toHaveLength(1));
    expect(bodyOf('POST', `/v1/exit-cases/${X_ASHA}/notice-waiver`)).toEqual({ reason: 'Synthetic: relieved early at our request' });
    expect(await screen.findByText('Notice recovery waived. The preparer calculates the draft again to apply it.')).toBeTruthy();
    // Loaded again: the waiver is shown with its reason, and nothing more is offered to waive.
    const note = await screen.findByText(/Notice recovery waived: Synthetic: relieved early at our request/);
    expect(note.closest('p')?.textContent).toContain('waived');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Waive the notice recovery' })).toBeNull());
  });

  it('says a refused waiver in plain words', async () => {
    serve(
      base({
        [`GET ${detailPath}`]: [200, calculated({ preparedBy: U_OTHER })],
        [`POST /v1/exit-cases/${X_ASHA}/notice-waiver`]: [409, { error: 'NOT_INDEPENDENT', message: 'The notice recovery is waived by someone other than the settlement’s preparer' }],
      }),
    );
    renderAt(`/lifecycle/settlements/${S_DRAFT}`, [SETTLEMENT_READ, SETTLEMENT_AMOUNT, WAIVE]);
    const section = await findSection('Waive the notice recovery');
    fireEvent.change(within(section).getByLabelText('Reason for waiving (required)'), { target: { value: 'Synthetic: early release' } });
    fireEvent.click(button(section, 'Waive the notice recovery'));
    const alert = await within(section).findByRole('alert');
    expect(alert.textContent).toContain('The preparer of this settlement cannot waive its notice recovery: someone else waives it.');
    expect(alert.textContent).toContain('NOT_INDEPENDENT');
  });

  it('says a submission refused because payroll took an arrear the calculation includes', async () => {
    serve(
      base({
        [`GET ${detailPath}`]: [200, calculated()],
        [`POST ${detailPath}/submit`]: [409, { error: 'ARREARS_TAKEN_BY_PAYROLL', message: 'Payroll has paid or holds an arrear', details: { cases: ['f6000000-0000-4000-8000-000000000001'] } }],
      }),
    );
    renderAt(`/lifecycle/settlements/${S_DRAFT}`, PREPARER);
    const section = await findSection('Submit for review');
    fireEvent.click(button(section, 'Submit revision 1 for review'));
    const alert = await within(section).findByRole('alert');
    expect(alert.textContent).toContain('Monthly payroll has meanwhile paid or taken an arrear or timesheet adjustment this calculation includes');
    expect(alert.textContent).toContain('Prepare a corrected revision');
  });

  it('the approval refused with CALCULATION_BLOCKED names every blocker in plain words, and the task stays', async () => {
    const APPROVE = `/v1/settlements/tasks/${K_APPROVAL}/approve`;
    const blockers = [
      { source: 'CALCULATION', kind: 'GRATUITY', code: 'RULE_PACK_NOT_CONFIGURED', componentCode: null },
      { source: 'CALCULATION', kind: 'NOTICE_RECOVERY', code: 'POLICY_NOT_CONFIGURED', componentCode: null },
      { source: 'STATUTORY', kind: 'STATUTORY_DEDUCTION', code: 'RULE_PACK_NOT_CONFIGURED', componentCode: 'TX_TDS', rulePackCode: 'TDS' },
      { source: 'GRATUITY', kind: 'GRATUITY', code: 'CALCULATION_REQUIRED', rulePackCode: 'GRATUITY' },
    ];
    const task = { ...APPROVAL_TASK, settlement: { ...APPROVAL_TASK.settlement, calculationStatus: 'CALCULATED', calculation: { ...SNAPSHOT, blockingCount: 2 } } };
    serve({
      'GET /v1/settlements/tasks/mine': [200, { items: [task] }],
      [`POST ${APPROVE}`]: [409, { error: 'CALCULATION_BLOCKED', message: 'This settlement cannot be approved', details: { blockers } }],
    });
    renderQueue(1, [SETTLEMENT_READ, SETTLEMENT_AMOUNT, SETTLEMENT_APPROVE]);
    const list = await screen.findByRole('list', { name: 'Settlements waiting for your approval' });
    const item = within(list).getAllByRole('listitem')[0]!;
    expect(term(item, 'Calculation')).toBe('Calculated from a snapshot');
    expect(term(item, 'Blocking items')).toBe('2 block approval');
    fireEvent.click(button(item, 'Approve'));
    const alert = await within(item).findByRole('alert');
    expect(alert.textContent).toContain(
      'This settlement cannot be approved while something it needs is missing: Gratuity: the gratuity rule pack is not active (RULE_PACK_NOT_CONFIGURED); Notice recovery: settlement policy not configured (POLICY_NOT_CONFIGURED); Statutory deduction TX_TDS: rule pack TDS is not configured; Gratuity: the employee is eligible, so the settlement must be calculated (CALCULATION_REQUIRED). Return the settlement for a corrected revision once that is in place.',
    );
    expect(alert.textContent).toContain('CALCULATION_BLOCKED');
    // Nothing was decided: the task stays, so the approver can return it instead.
    await settle();
    expect(within(screen.getByRole('list', { name: 'Settlements waiting for your approval' })).getAllByRole('listitem')).toHaveLength(1);
    expect(button(item, 'Return for correction').disabled).toBe(false);
  });

  it('links the calculation to the settlement policy and statutory packs for a role that reads them', async () => {
    serve(base({ [`GET ${detailPath}`]: [200, calculated()] }));
    renderAt(`/lifecycle/settlements/${S_DRAFT}`, [SETTLEMENT_READ, SETTLEMENT_AMOUNT, 'statutory_pack.read.operational']);
    const link = await screen.findByRole('link', { name: 'Settlement policy and statutory packs' });
    expect(link.getAttribute('href')).toBe('/lifecycle/settlement-settings');
  });
});
