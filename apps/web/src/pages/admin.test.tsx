// Administration screens (FR-058; DF03; DF08; FR-023; FR-085/FR-061), jsdom: audit export only with its own duty,
// routing lists saved in tick order, link decisions carrying the row version, retention actions only for their duties,
// and notification rule revisions (I-35) scheduled from a future instant with exactly the changed fields, the latest
// revision number and a reason, mandatory rules offered no off switch and refusals shown in plain words.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_SCREENS, AuditTrailPage, MobileLinkReviewPage, NotificationRuleApprovalsPage, NotificationRulesPage, RetentionPage, RoutingPage } from './admin';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({
    me: { accountKey: 'syn.admin', companyName: 'Synthetic Co', roleCode: 'SYSTEM_ADMINISTRATOR', roleName: 'System Administrator', scopeKind: 'COMPANY', employeeId: null, displayName: null },
    can: (p: string) => session.permissions.includes(p),
  }),
}));

type Call = { url: string; method: string; body: unknown };
/** A route answers its body with 200, or a `Reply` function answers [status, body] for the request it sees. */
class Reply {
  constructor(readonly answer: (call: Call) => [number, unknown]) {}
}
function mockApi(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const call = { url, method, body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
      const route = key ? routes[key] : undefined;
      const [status, body] = route instanceof Reply ? route.answer(call) : key ? [200, route] : [404, { error: 'NOT_FOUND', message: 'Not found' }];
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
});

const EVENT = {
  id: 'ev-1',
  occurredAt: '2026-10-24T05:00:00Z',
  resource: 'employee',
  recordKey: '0f0f0f0f-0000-4000-8000-000000000001',
  action: 'CREATE',
  actorAccountKey: 'syn.hr',
  actingRoleCode: 'HR_ADMINISTRATOR',
  valueGroups: ['operational', 'personal'],
  changedFields: ['displayName', 'workEmail'],
  reasonRecorded: false,
};

describe('audit trail (FR-058)', () => {
  it('shows field names and recorded groups; export needs its own duty and a period', async () => {
    session.permissions = ['audit.read.operational', 'audit.export.operational'];
    const calls = mockApi({ 'GET /v1/audit/events': { items: [EVENT], total: 1 }, 'POST /v1/reports': { id: 'r-1', state: 'QUEUED' } });
    renderPage(<AuditTrailPage />);
    expect(await screen.findByText('displayName, workEmail')).toBeTruthy();
    expect(screen.getByText('personal')).toBeTruthy();
    const exportButton = screen.getByText('Export these events') as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-24' } });
    fireEvent.click(screen.getByText('Show'));
    await waitFor(() => expect((screen.getByText('Export these events') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText('Export these events'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/v1/reports')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ reportCode: 'AUDIT_TRAIL', filters: { from: '2026-10-01', to: '2026-10-24' } });
    expect(calls.some((c) => c.url.includes('from=2026-10-01') && c.url.includes('to=2026-10-24'))).toBe(true);
  });

  it('exports the events shown: the record filters applied with the period, not what is typed and not yet shown (BR-026)', async () => {
    session.permissions = ['audit.read.operational', 'audit.export.operational'];
    const calls = mockApi({ 'GET /v1/audit/events': { items: [EVENT], total: 1 }, 'POST /v1/reports': { id: 'r-1', state: 'QUEUED' } });
    renderPage(<AuditTrailPage />);
    await screen.findByText('displayName, workEmail');
    fireEvent.change(screen.getByLabelText('Record kind'), { target: { value: 'employee' } });
    fireEvent.change(screen.getByLabelText('Record id'), { target: { value: EVENT.recordKey } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-24' } });
    fireEvent.click(screen.getByText('Show'));
    await waitFor(() => expect((screen.getByText('Export these events') as HTMLButtonElement).disabled).toBe(false));
    // Typed after Show: neither the list nor the export has it yet.
    fireEvent.change(screen.getByLabelText('Record kind'), { target: { value: 'leave_request' } });
    fireEvent.click(screen.getByText('Export these events'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ reportCode: 'AUDIT_TRAIL', filters: { resource: 'employee', recordKey: EVENT.recordKey, from: '2026-10-01', to: '2026-10-24' } });
  });

  it('sorts on the server by a column heading: newest first until one is chosen, the next click reverses it, a new sort starts at page 1 (FR-056)', async () => {
    session.permissions = ['audit.read.operational'];
    const calls = mockApi({ 'GET /v1/audit/events': { items: [EVENT], total: 120 } });
    renderPage(<AuditTrailPage />);
    await screen.findByText('displayName, workEmail');
    const last = () => new URLSearchParams(calls.filter((c) => c.url.startsWith('/v1/audit/events')).at(-1)!.url.split('?')[1]);
    expect(last().has('sort')).toBe(false);
    expect(screen.getByRole('columnheader', { name: 'When' }).getAttribute('aria-sort')).toBe('none');
    // Go to page 2, then sort: back to page 1.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(last().get('page')).toBe('2'));
    fireEvent.click(await screen.findByRole('button', { name: 'Actor' }));
    await waitFor(() => expect(last().get('sort')).toBe('actor'));
    expect(last().get('direction')).toBe('ASC');
    expect(last().get('page')).toBe('1');
    expect((await screen.findByRole('columnheader', { name: /Actor/ })).getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(await screen.findByRole('button', { name: /Actor/ }));
    await waitFor(() => expect(last().get('direction')).toBe('DESC'));
    expect((await screen.findByRole('columnheader', { name: /Actor/ })).getAttribute('aria-sort')).toBe('descending');
    // The filters and the order travel together; the fields column is not sortable.
    expect(screen.queryByRole('button', { name: 'Fields' })).toBeNull();
  });

  describe('grade and payroll trace (FR-057)', () => {
    const EMPLOYEE = '0f0f0f0f-0000-4000-8000-0000000000e1';
    const TRACE = {
      employee: { id: EMPLOYEE, code: 'SYN-7', name: 'Tess Traced (synthetic)' },
      assignments: [
        { id: 'aaaaaaaa-0000-4000-8000-000000000002', gradeId: 'g2', gradeCode: 'G-TWO', effectiveFrom: '2026-10-01', effectiveTo: null, recordedAt: '2026-09-20T05:00:00Z', recordedBy: 'syn.hr', changedFields: ['assignment.gradeId'] },
        { id: 'aaaaaaaa-0000-4000-8000-000000000001', gradeId: 'g1', gradeCode: 'G-ONE', effectiveFrom: '2026-01-05', effectiveTo: '2026-10-01', recordedAt: '2026-01-02T05:00:00Z', recordedBy: 'syn.hr2', changedFields: [] },
      ],
      runs: [
        {
          runId: 'bbbbbbbb-0000-4000-8000-000000000002',
          revision: 2,
          state: 'CALCULATED',
          periodCode: '2026-10',
          selectedAssignmentId: 'aaaaaaaa-0000-4000-8000-000000000002',
          calculatedAssignmentId: 'aaaaaaaa-0000-4000-8000-000000000002',
          salaryArrangementIds: ['cccccccc-0000-4000-8000-000000000001'],
        },
        { runId: 'bbbbbbbb-0000-4000-8000-000000000001', revision: 1, state: 'PROCESSED_LOCKED', periodCode: '2026-09', selectedAssignmentId: null, calculatedAssignmentId: null, salaryArrangementIds: [] },
      ],
      total: 2,
      page: 1,
      pageSize: 25,
    };

    const rowsOf = (name: string) => within(screen.getByRole('table', { name })).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));

    it('asks for the employee, then shows who recorded each grade and which runs used it, with no amount', async () => {
      session.permissions = ['audit.read.operational'];
      const calls = mockApi({ 'GET /v1/audit/events': { items: [], total: 0 }, [`GET /v1/audit/employees/${EMPLOYEE}/payroll-trace`]: TRACE });
      renderPage(<AuditTrailPage />);
      const section = await screen.findByRole('region', { name: 'Grade and payroll trace' });
      const trace = within(section).getByRole('button', { name: 'Trace' }) as HTMLButtonElement;
      expect(trace.disabled).toBe(true);
      expect(calls.some((c) => c.url.includes('payroll-trace'))).toBe(false);
      fireEvent.change(within(section).getByLabelText('Employee id'), { target: { value: 'not-an-id' } });
      expect(trace.disabled).toBe(true);
      fireEvent.change(within(section).getByLabelText('Employee id'), { target: { value: EMPLOYEE } });
      fireEvent.click(trace);
      await within(section).findByText('Tess Traced (synthetic) (SYN-7)');
      expect(calls.find((c) => c.url.includes('payroll-trace'))!.url).toBe(`/v1/audit/employees/${EMPLOYEE}/payroll-trace?page=1&pageSize=25`);
      const assignments = rowsOf('Assignment revisions');
      expect(assignments[0]!.slice(0, 2)).toEqual(['aaaaaaaa', 'G-TWO']);
      expect(assignments[0]![4]).toBe('assignment.gradeId');
      expect(assignments[0]![5]).toBe('syn.hr');
      expect(assignments[1]![4]).toBe('—');
      const runs = rowsOf('Payroll runs that used an assignment');
      expect(runs[0]!.slice(0, 3)).toEqual(['2026-10', 'bbbbbbbb', '2']);
      expect(runs[0]!.slice(4)).toEqual(['aaaaaaaa', 'aaaaaaaa', 'cccccccc']);
      // A run older than the record says so, instead of guessing.
      expect(runs[1]!.slice(4)).toEqual(['not recorded', 'not recorded', '—']);
      expect(section.textContent).toContain('amounts are never shown here');
    });

    it('says a refusal in the section and shows nothing else', async () => {
      session.permissions = ['audit.read.operational'];
      mockApi({ 'GET /v1/audit/events': { items: [], total: 0 }, [`GET /v1/audit/employees/${EMPLOYEE}/payroll-trace`]: new Reply(() => [404, { error: 'NOT_FOUND', message: 'Not found' }]) });
      renderPage(<AuditTrailPage />);
      const section = await screen.findByRole('region', { name: 'Grade and payroll trace' });
      fireEvent.change(within(section).getByLabelText('Employee id'), { target: { value: EMPLOYEE } });
      fireEvent.click(within(section).getByRole('button', { name: 'Trace' }));
      expect(await within(section).findByRole('alert')).toBeTruthy();
      expect(within(section).queryByRole('table')).toBeNull();
    });
  });

  it('offers no export without the export duty', async () => {
    session.permissions = ['audit.read.operational'];
    mockApi({ 'GET /v1/audit/events': { items: [EVENT], total: 1 } });
    renderPage(<AuditTrailPage />);
    expect(await screen.findByText('displayName, workEmail')).toBeTruthy();
    expect(screen.queryByText('Export these events')).toBeNull();
  });
});

describe('reviewer routing (DF03)', () => {
  it('saves the ticked reviewers with priorities in tick order; shared kinds are not editable', async () => {
    const calls = mockApi({
      'GET /v1/workflows/profile_change/candidates': {
        kind: 'profile_change',
        items: [
          { userId: 'u-a', accountKey: 'syn.a', employeeCode: null, displayName: 'Reviewer A' },
          { userId: 'u-b', accountKey: 'syn.b', employeeCode: null, displayName: 'Reviewer B' },
        ],
      },
      'GET /v1/workflows': {
        items: [
          { kind: 'leave_cancellation', routingKind: 'leave_request', steps: [{ sequence: 1, permission: 'leave.approve.operational', selectionRule: 'DIRECT_MANAGER', conditionCode: null }], fallbackReviewers: [] },
          { kind: 'profile_change', routingKind: null, steps: [{ sequence: 1, permission: 'employee.update.operational', selectionRule: 'HR_FALLBACK_LIST', conditionCode: null }], fallbackReviewers: [] },
        ],
      },
      'PUT /v1/workflows/profile_change/fallback-reviewers': { kind: 'profile_change', reviewers: [] },
    });
    renderPage(<RoutingPage />);
    expect(await screen.findByText('Uses the leave request fallback list.')).toBeTruthy();
    expect(screen.getAllByText('Edit list')).toHaveLength(1);
    fireEvent.click(screen.getByText('Edit list'));
    fireEvent.click(await screen.findByLabelText(/Reviewer B/));
    fireEvent.click(screen.getByLabelText(/Reviewer A/));
    fireEvent.click(screen.getByText('Save list'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      reviewers: [
        { userId: 'u-b', priority: 1 },
        { userId: 'u-a', priority: 2 },
      ],
    });
  });
});

describe('stranded tasks (C4, DF03, I-84 item 1)', () => {
  const STRANDED = {
    items: [
      {
        taskId: 't-1',
        kind: 'leave_request',
        transactionId: 'bt-1',
        ownerEmployeeId: 'e-1',
        ownerEmployeeCode: 'SYN-001',
        ownerName: 'Asha Synthetic',
        assignedAt: '2026-11-02T05:00:00Z',
        assigneeUserId: 'u-old',
        assigneeAccountKey: 'syn.former.manager',
        step: 1,
        delegationId: null,
      },
      {
        taskId: 't-2',
        kind: 'payroll_run',
        transactionId: 'bt-2',
        ownerEmployeeId: null,
        ownerEmployeeCode: null,
        ownerName: null,
        assignedAt: '2026-11-03T05:00:00Z',
        assigneeUserId: 'u-del',
        assigneeAccountKey: 'syn.delegate',
        step: 1,
        delegationId: 'd-1',
      },
    ],
  };
  const ROUTING = { items: [] };

  it('FR-003, FR-068: lists the tasks nobody can decide and reroutes one with a reason; the rule picks the reviewer, never the caller', async () => {
    session.permissions = ['workflow.manage.operational', 'workflow.reroute_task.operational'];
    let listed = 0;
    const calls = mockApi({
      'GET /v1/workflows/stranded-tasks': new Reply(() => [200, listed++ === 0 ? STRANDED : { items: [STRANDED.items[1]] }]),
      'POST /v1/workflows/tasks/t-1/reroute': { taskId: 't-9', supersededTaskId: 't-1', assigneeUserId: 'u-new' },
      'GET /v1/workflows': ROUTING,
    });
    renderPage(<RoutingPage />);
    const table = await screen.findByRole('table', { name: 'Stranded tasks' });
    const first = within(table).getByText('SYN-001 Asha Synthetic').closest('tr') as HTMLElement;
    expect(first.textContent).toContain('leave request, step 1');
    expect(first.textContent).toContain('syn.former.manager');
    const second = within(table).getByText('No employee (company-wide)').closest('tr') as HTMLElement;
    expect(within(second).getByText('delegated')).toBeTruthy();
    const reroute = within(first).getByRole('button', { name: 'Reroute the task of SYN-001 Asha Synthetic' }) as HTMLButtonElement;
    // A reason is required; no reviewer is offered to choose.
    expect(reroute.disabled).toBe(true);
    expect(within(first).queryByRole('combobox')).toBeNull();
    fireEvent.change(within(first).getByLabelText('Reason to reroute the task of SYN-001 Asha Synthetic'), { target: { value: 'Former manager left (synthetic)' } });
    fireEvent.click(reroute);
    expect(await screen.findByText(/The leave request task of SYN-001 was rerouted: a new task went to the reviewer its step now selects/)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([{ url: '/v1/workflows/tasks/t-1/reroute', method: 'POST', body: { reason: 'Former manager left (synthetic)' } }]);
    // The list is read again: the rerouted task is no longer stranded.
    await waitFor(() => expect(screen.queryByText('SYN-001 Asha Synthetic')).toBeNull());
  });

  it('FR-003: explains a refusal, offers no reroute without the duty, and reads nothing without routing administration', async () => {
    session.permissions = ['workflow.manage.operational', 'workflow.reroute_task.operational'];
    mockApi({
      'GET /v1/workflows/stranded-tasks': STRANDED,
      'POST /v1/workflows/tasks/t-1/reroute': new Reply(() => [409, { error: 'TASK_NOT_STRANDED', message: 'The current assignee can still decide this task' }]),
      'GET /v1/workflows': ROUTING,
    });
    renderPage(<RoutingPage />);
    const table = await screen.findByRole('table', { name: 'Stranded tasks' });
    fireEvent.change(within(table).getByLabelText('Reason to reroute the task of SYN-001 Asha Synthetic'), { target: { value: 'Synthetic' } });
    fireEvent.click(within(table).getByRole('button', { name: 'Reroute the task of SYN-001 Asha Synthetic' }));
    expect(await screen.findByText('The current assignee can still decide this task (TASK_NOT_STRANDED)')).toBeTruthy();
    cleanup();

    session.permissions = ['workflow.manage.operational'];
    mockApi({ 'GET /v1/workflows/stranded-tasks': STRANDED, 'GET /v1/workflows': ROUTING });
    renderPage(<RoutingPage />);
    const readOnly = await screen.findByRole('table', { name: 'Stranded tasks' });
    expect(within(readOnly).queryByRole('button', { name: /Reroute/ })).toBeNull();
    expect(screen.getByText(/The selected role cannot reroute tasks\./)).toBeTruthy();
    cleanup();

    session.permissions = [];
    const calls = mockApi({ 'GET /v1/workflows/stranded-tasks': STRANDED, 'GET /v1/workflows': ROUTING });
    renderPage(<RoutingPage />);
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/workflows')).toBe(true));
    expect(calls.some((c) => c.url === '/v1/workflows/stranded-tasks')).toBe(false);
    expect(screen.queryByRole('heading', { name: 'Stranded tasks' })).toBeNull();
  });
});

describe('mobile-app link review (FR-023)', () => {
  it('approves with the row version and needs a reason to revoke', async () => {
    const pending = { id: 'l-1', employeeCode: 'SYN-1', employeeName: 'Synthetic Person', appAccountRef: 'app-1', state: 'PENDING', replacesLinkId: 'l-0', version: 3, requestedAt: '2026-10-24T05:00:00Z' };
    const active = { ...pending, id: 'l-0', state: 'ACTIVE', replacesLinkId: null, version: 2 };
    const calls = mockApi({
      'GET /v1/mobile-links?state=PENDING': { items: [pending] },
      'GET /v1/mobile-links?state=ACTIVE': { items: [active] },
      'POST /v1/mobile-links/l-1/decision': { id: 'l-1', state: 'ACTIVE' },
      'POST /v1/mobile-links/l-0/revoke': { id: 'l-0', state: 'REVOKED' },
    });
    renderPage(<MobileLinkReviewPage />);
    expect(await screen.findByText('replaces the current link')).toBeTruthy();
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/mobile-links/l-1/decision')).toBe(true));
    expect(calls.find((c) => c.url === '/v1/mobile-links/l-1/decision')!.body).toEqual({ expectedVersion: 3, decision: 'APPROVE' });

    fireEvent.click(screen.getByText('Active'));
    const revoke = (await screen.findByText('Revoke')) as HTMLButtonElement;
    expect(revoke.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Revocation reason'), { target: { value: 'Phone lost' } });
    fireEvent.click(screen.getByText('Revoke'));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/mobile-links/l-0/revoke')).toBe(true));
    expect(calls.find((c) => c.url === '/v1/mobile-links/l-0/revoke')!.body).toEqual({ expectedVersion: 2, reason: 'Phone lost' });
  });
});

describe('retention (FR-058, DF08)', () => {
  const routes = {
    'GET /v1/retention/rules': { items: [{ id: 'rule-1', resource: 'audit_event', revision: 1, retainDays: 400, basisNote: 'Synthetic schedule', state: 'DRAFT', version: 1 }] },
    'GET /v1/retention/holds': { items: [{ id: 'hold-1', resource: 'employee', recordKey: null, reason: 'Synthetic dispute', state: 'PENDING', version: 1, requestedAt: '2026-10-24T05:00:00Z' }] },
    'GET /v1/retention/eligibility': { rule: null, cutoffDate: null, eligibleCount: 0, heldCount: 0, purgeEnabled: false, note: 'Purge is disabled (DF08).' },
    'POST /v1/retention/rules/rule-1/activate': { id: 'rule-1', state: 'ACTIVE' },
  };

  it('a manager proposes and requests but cannot activate or decide', async () => {
    session.permissions = ['retention.manage.operational'];
    mockApi(routes);
    renderPage(<RetentionPage />);
    expect(await screen.findByText('No approved retention schedule: nothing is eligible.')).toBeTruthy();
    expect(await screen.findByText('Synthetic schedule')).toBeTruthy();
    expect(screen.queryByText('Activate')).toBeNull();
    expect(screen.queryByText('Approve')).toBeNull();
    expect(screen.getByText('Propose rule')).toBeTruthy();
  });

  it('an approver activates with the row version', async () => {
    session.permissions = ['retention.manage.operational', 'retention.approve.operational'];
    const calls = mockApi(routes);
    renderPage(<RetentionPage />);
    fireEvent.click(await screen.findByText('Activate'));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/retention/rules/rule-1/activate')).toBe(true));
    expect(calls.find((c) => c.url === '/v1/retention/rules/rule-1/activate')!.body).toEqual({ expectedVersion: 1 });
  });
});

describe('notification rules (FR-085, FR-061, I-35)', () => {
  const MANAGE_RULES = 'notification.manage_rules.operational';
  const rule = (code: string, revision: number, patch: Record<string, unknown> = {}) => ({
    id: `r-${code}-${revision}`,
    code,
    revision,
    eventType: code,
    channel: 'IN_APP',
    recipientSelector: 'BENEFICIARY_USER',
    optionalEvent: false,
    active: true,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    retryCeiling: 3,
    templateCode: code,
    templateRevision: 1,
    subjectTemplate: null,
    bodyTemplate: 'A {{roleCode}} role assignment was approved for you.',
    approvedPlaceholders: ['roleCode'],
    status: 'IN_FORCE',
    ...patch,
  });
  const RULES = [
    rule('ACCESS_GRANT_APPROVED', 1, { effectiveTo: '2026-11-05T04:00:00.000Z' }),
    rule('ACCESS_GRANT_APPROVED', 2, {
      effectiveFrom: '2026-11-05T04:00:00.000Z',
      status: 'SCHEDULED',
      templateRevision: 2,
      subjectTemplate: 'Access approved',
      bodyTemplate: 'Your {{roleCode}} access is now approved.',
    }),
    rule('BIRTHDAY', 1, { optionalEvent: true, recipientSelector: 'COMPANY_ALL', bodyTemplate: 'Happy birthday, {{firstName}}!', approvedPlaceholders: ['firstName'] }),
  ];
  const AT = '2026-12-01T09:30';
  const reads = (calls: Call[]) => calls.filter((c) => c.method === 'GET' && c.url === '/v1/notifications/rules');
  const revisionsOf = (calls: Call[], code: string) => calls.filter((c) => c.method === 'POST' && c.url === `/v1/notifications/rules/${code}/revisions`);
  const scheduled = (call: Call): [number, unknown] => {
    const body = call.body as { effectiveFrom: string; expectedRevision: number };
    return [201, { id: 'r-new', code: 'X', revision: body.expectedRevision + 1, templateRevision: 3, active: true, effectiveFrom: body.effectiveFrom, status: 'PROPOSED' }];
  };
  const APPROVE_RULES = 'notification.approve_rules.operational';

  it('C6: a change waiting for approval blocks another; a rejected one is shown with its reason and the next change builds on what came before it', async () => {
    session.permissions = [MANAGE_RULES];
    const calls = mockApi({
      'GET /v1/notifications/rules': {
        items: [
          rule('WAITING', 1),
          rule('WAITING', 2, { status: 'PROPOSED', effectiveFrom: '2026-12-01T00:00:00.000Z' }),
          rule('REFUSED', 1),
          rule('REFUSED', 2, { status: 'REJECTED', decisionReason: 'Synthetic: wrong tone', effectiveFrom: '2026-12-01T00:00:00.000Z' }),
        ],
      },
      'POST /v1/notifications/rules/REFUSED/revisions': new Reply(scheduled),
    });
    renderPage(<NotificationRulesPage />);
    const waiting = await screen.findByRole('listitem', { name: 'Rule WAITING' });
    expect(within(waiting).getByText('waiting for approval')).toBeTruthy();
    expect(within(waiting).queryByRole('button', { name: 'Change WAITING' })).toBeNull();
    const refused = screen.getByRole('listitem', { name: 'Rule REFUSED' });
    expect(within(refused).getByText('rejected')).toBeTruthy();
    expect(within(refused).getByText('Synthetic: wrong tone')).toBeTruthy();
    fireEvent.click(within(refused).getByRole('button', { name: 'Change REFUSED' }));
    const form = screen.getByRole('form', { name: 'Change REFUSED' });
    fireEvent.change(within(form).getByLabelText('Takes effect from'), { target: { value: AT } });
    fireEvent.change(within(form).getByLabelText('Message'), { target: { value: 'Reworded {{roleCode}}.' } });
    fireEvent.change(within(form).getByLabelText('Reason for the change'), { target: { value: 'Synthetic review' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Propose change' }));
    await waitFor(() => expect(revisionsOf(calls, 'REFUSED')).toHaveLength(1));
    expect(revisionsOf(calls, 'REFUSED')[0]!.body).toMatchObject({ expectedRevision: 1 });
  });

  describe('approvals (C6 "publication ... require business owner approval")', () => {
    const PROPOSAL = {
      id: 'r-9',
      code: 'BIRTHDAY',
      revision: 2,
      version: 4,
      effectiveFrom: '2026-12-01T04:00:00.000Z',
      active: false,
      optionalEvent: true,
      proposalReason: 'Synthetic: pause celebrations',
      proposedByAccountKey: 'syn.author',
      subjectTemplate: null,
      bodyTemplate: 'Proposed wording',
      currentActive: true,
      currentSubjectTemplate: null,
      currentBodyTemplate: 'Wording now',
    };

    it('needs the approval grant, and asks the server nothing without it', async () => {
      const calls = mockApi({});
      renderPage(<NotificationRuleApprovalsPage />);
      expect(screen.getByText(/cannot approve notification rules/)).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toHaveLength(0);
    });

    it('shows what is proposed beside what is in force; approval carries the row version; a rejection needs its reason', async () => {
      session.permissions = [APPROVE_RULES];
      const calls = mockApi({
        'GET /v1/notifications/rules/proposals': { items: [PROPOSAL] },
        'POST /v1/notifications/rules/proposals/r-9/publish': { id: 'r-9', status: 'SCHEDULED' },
        'POST /v1/notifications/rules/proposals/r-9/reject': { id: 'r-9', status: 'REJECTED' },
      });
      renderPage(<NotificationRuleApprovalsPage />);
      const item = await screen.findByRole('listitem', { name: 'Proposed change to BIRTHDAY' });
      expect(within(item).getByText('Wording now')).toBeTruthy();
      expect(within(item).getByText('Proposed wording')).toBeTruthy();
      expect(within(item).getByText('Synthetic: pause celebrations')).toBeTruthy();
      expect(within(item).getByText('switched off')).toBeTruthy();
      const reject = within(item).getByRole('button', { name: 'Reject BIRTHDAY' }) as HTMLButtonElement;
      expect(reject.disabled).toBe(true);
      fireEvent.change(within(item).getByLabelText('Reason for rejecting BIRTHDAY'), { target: { value: 'Synthetic: not now' } });
      fireEvent.click(reject);
      await waitFor(() => expect(calls.find((c) => c.url.endsWith('/reject'))?.body).toEqual({ expectedVersion: 4, reason: 'Synthetic: not now' }));
      fireEvent.click(within(item).getByRole('button', { name: 'Approve BIRTHDAY' }));
      await waitFor(() => expect(calls.find((c) => c.url.endsWith('/publish'))?.body).toEqual({ expectedVersion: 4 }));
    });

    it('shows the server’s refusal of the author', async () => {
      session.permissions = [APPROVE_RULES];
      mockApi({
        'GET /v1/notifications/rules/proposals': { items: [PROPOSAL] },
        'POST /v1/notifications/rules/proposals/r-9/publish': new Reply(() => [403, { error: 'SELF_APPROVAL', message: 'A rule change cannot be decided by its author' }]),
      });
      renderPage(<NotificationRuleApprovalsPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Approve BIRTHDAY' }));
      expect((await screen.findByRole('alert')).textContent).toContain('SELF_APPROVAL');
    });
  });

  it('needs the rule-management grant', async () => {
    const calls = mockApi({ 'GET /v1/notifications/rules': { items: RULES } });
    renderPage(<NotificationRulesPage />);
    expect(screen.getByText(/cannot change notification rules/)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(0);
    expect(ADMIN_SCREENS.map((s) => [s.path, s.permission, s.nav])).toEqual([
      ['/admin/notification-rules', MANAGE_RULES, true],
      ['/admin/notification-rule-approvals', APPROVE_RULES, true],
    ]);
  });

  it('lists every revision of each rule with its status, dates and wording', async () => {
    session.permissions = [MANAGE_RULES];
    mockApi({ 'GET /v1/notifications/rules': { items: RULES } });
    renderPage(<NotificationRulesPage />);
    const access = await screen.findByRole('listitem', { name: 'Rule ACCESS_GRANT_APPROVED' });
    expect(within(access).getByText('mandatory')).toBeTruthy();
    expect(within(access).getByText('sending now')).toBeTruthy();
    const rows = within(within(access).getByRole('table', { name: 'Revisions of ACCESS_GRANT_APPROVED' })).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText('in force')).toBeTruthy();
    expect(within(rows[2]!).getByText('scheduled')).toBeTruthy();
    expect(within(rows[2]!).getByText('Your {{roleCode}} access is now approved.')).toBeTruthy();
    // The superseded revision ends exactly when the next one starts.
    expect(within(rows[1]!).getAllByRole('cell')[3]!.textContent).toBe(within(rows[2]!).getAllByRole('cell')[2]!.textContent);
    const birthday = screen.getByRole('listitem', { name: 'Rule BIRTHDAY' });
    expect(within(birthday).getByText('optional')).toBeTruthy();
    expect(within(birthday).getByText('company all')).toBeTruthy();
  });

  it('schedules a wording change from a future instant with exactly the changed field, the latest revision and a reason', async () => {
    session.permissions = [MANAGE_RULES];
    const calls = mockApi({ 'POST /v1/notifications/rules/ACCESS_GRANT_APPROVED/revisions': new Reply(scheduled), 'GET /v1/notifications/rules': { items: RULES } });
    renderPage(<NotificationRulesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change ACCESS_GRANT_APPROVED' }));
    const form = screen.getByRole('form', { name: 'Change ACCESS_GRANT_APPROVED' });
    // The form starts from the latest revision's wording; a mandatory rule has no off switch.
    expect((within(form).getByLabelText('Subject (optional)') as HTMLInputElement).value).toBe('Access approved');
    expect((within(form).getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Your {{roleCode}} access is now approved.');
    expect(within(form).queryByLabelText('Send this notification')).toBeNull();
    expect(within(form).getByText('Mandatory: this notification cannot be switched off.')).toBeTruthy();
    expect(within(form).getByText('Approved placeholders: {{roleCode}}.')).toBeTruthy();
    const submit = within(form).getByRole('button', { name: 'Propose change'}) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('Takes effect from'), { target: { value: AT } });
    fireEvent.change(within(form).getByLabelText('Message'), { target: { value: 'Your {{roleCode}} access is approved.' } });
    expect(submit.disabled).toBe(true); // a reason is required
    fireEvent.change(within(form).getByLabelText('Reason for the change'), { target: { value: 'Wording review (synthetic)' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(revisionsOf(calls, 'ACCESS_GRANT_APPROVED')).toHaveLength(1));
    expect(revisionsOf(calls, 'ACCESS_GRANT_APPROVED')[0]!.body).toEqual({
      expectedRevision: 2,
      effectiveFrom: new Date(AT).toISOString(),
      reason: 'Wording review (synthetic)',
      bodyTemplate: 'Your {{roleCode}} access is approved.',
    });
    expect(await screen.findByText('Revision 3 of ACCESS_GRANT_APPROVED is waiting for approval. Once approved it takes effect from 2026-12-01 09:30.')).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
    await waitFor(() => expect(reads(calls)).toHaveLength(2));
  });

  it('switches an optional rule off with only the on/off setting', async () => {
    session.permissions = [MANAGE_RULES];
    const calls = mockApi({ 'POST /v1/notifications/rules/BIRTHDAY/revisions': new Reply(scheduled), 'GET /v1/notifications/rules': { items: RULES } });
    renderPage(<NotificationRulesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change BIRTHDAY' }));
    const form = screen.getByRole('form', { name: 'Change BIRTHDAY' });
    const send = within(form).getByLabelText('Send this notification') as HTMLInputElement;
    expect(send.checked).toBe(true);
    fireEvent.click(send);
    fireEvent.change(within(form).getByLabelText('Takes effect from'), { target: { value: AT } });
    fireEvent.change(within(form).getByLabelText('Reason for the change'), { target: { value: 'Celebrations paused (synthetic)' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Propose change'}));
    await waitFor(() => expect(revisionsOf(calls, 'BIRTHDAY')).toHaveLength(1));
    expect(revisionsOf(calls, 'BIRTHDAY')[0]!.body).toEqual({ expectedRevision: 1, effectiveFrom: new Date(AT).toISOString(), reason: 'Celebrations paused (synthetic)', active: false });
  });

  it('shows the API’s refusals in plain words, keeps what was typed and reloads a stale rule', async () => {
    session.permissions = [MANAGE_RULES];
    const refusals: [number, unknown][] = [
      [422, { error: 'PLACEHOLDER_NOT_APPROVED', message: 'The wording uses a placeholder that is not approved', details: { placeholder: 'reason' } }],
      [422, { error: 'EFFECTIVE_DATE_BEFORE_LATEST', message: 'A rule change must take effect after the latest revision' }],
      [422, { error: 'EFFECTIVE_DATE_NOT_FUTURE', message: 'A rule change takes effect from a future date only' }],
      [409, { error: 'STALE_VERSION', message: 'The rule changed; reload and retry' }],
    ];
    const calls = mockApi({ 'POST /v1/notifications/rules/ACCESS_GRANT_APPROVED/revisions': new Reply(() => refusals.shift()!), 'GET /v1/notifications/rules': { items: RULES } });
    renderPage(<NotificationRulesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change ACCESS_GRANT_APPROVED' }));
    const form = screen.getByRole('form', { name: 'Change ACCESS_GRANT_APPROVED' });
    fireEvent.change(within(form).getByLabelText('Takes effect from'), { target: { value: AT } });
    fireEvent.change(within(form).getByLabelText('Message'), { target: { value: 'Access for {{reason}} approved.' } });
    fireEvent.change(within(form).getByLabelText('Reason for the change'), { target: { value: 'Wording review (synthetic)' } });
    for (const words of [
      'The wording uses {{reason}}, which is not approved for this message.',
      'A change must take effect after the latest revision of this rule starts.',
      'A change takes effect from a future date and time only.',
      'This rule changed since the page loaded it, so nothing was saved.',
    ]) {
      fireEvent.click(within(form).getByRole('button', { name: 'Propose change'}));
      await waitFor(() => expect(within(form).getByRole('alert').textContent).toContain(words));
    }
    expect((within(form).getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Access for {{reason}} approved.');
    await waitFor(() => expect(reads(calls)).toHaveLength(2));
  });
});
