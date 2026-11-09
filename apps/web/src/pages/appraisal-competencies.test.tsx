// Appraisal competencies and sections (FR-041, FR-042; decided under owner delegation, 6 Nov 2026, I-86), jsdom: the result split,
// the competency master and the grade mapping on the Appraisal competencies screen; a cycle's split and sections; the employee's
// self-assessment of competencies and their part of the sections; the manager's rating of both with the results the server
// combined; and the training needs offered to training planning. Requests carry only what changed, refusals are said in words, and
// confidential texts are shown only when the API returned them. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APPRAISAL_ESS_PANELS, APPRAISAL_SCREENS, APPRAISAL_TASK_QUEUES } from './appraisal';

const session = vi.hoisted(() => ({
  permissions: [] as string[],
  companyId: 'c0000000-0000-4000-8000-000000000001',
  assignmentId: 'a0000000-0000-4000-8000-000000000001',
  userId: 'b0000000-0000-4000-8000-000000000001',
  employeeId: '20000000-0000-4000-8000-000000000001' as string | null,
  roleCode: 'HR_ADMINISTRATOR',
  scopeKind: 'COMPANY',
}));
vi.mock('../held-batch-timing', () => ({ HELD_BATCH_CHECK_INTERVAL_MS: 3_600_000, HELD_BATCH_MAX_CHECKS: 30 }));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: session.companyId, assignmentId: session.assignmentId },
    me: {
      userId: session.userId,
      accountKey: 'syn.asha',
      companyName: 'Synthetic Co',
      roleCode: session.roleCode,
      roleName: session.roleCode,
      scopeKind: session.scopeKind,
      employeeId: session.employeeId,
      displayName: 'Asha Synthetic',
    },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

const CYCLE_READ = 'appraisal_cycle.read.operational';
const CYCLE_MANAGE = 'appraisal_cycle.manage.operational';
const READ = 'appraisal.read.operational';
const READ_SELF = 'appraisal.read.self';
const READ_RATING = 'appraisal.read.rating';
const REPORT = 'appraisal.report.operational';
const REPORT_RATING = 'appraisal.report.rating';
const RATE = 'appraisal.rate.rating';
const SELF_ASSESS = 'appraisal.self_assess.self';
const ORG_READ = 'org_master.read.operational';

const C_OPEN = '10000000-0000-4000-8000-000000000001';
const A_OWN = '30000000-0000-4000-8000-000000000005';
const A_RATE = '30000000-0000-4000-8000-000000000002';
const T_RATE = '40000000-0000-4000-8000-000000000001';
const GRADE = '70000000-0000-4000-8000-000000000001';
const K = (n: number) => `80000000-0000-4000-8000-00000000000${n}`;
const AK = (n: number) => `81000000-0000-4000-8000-00000000000${n}`;
const G = (n: number) => `50000000-0000-4000-8000-00000000000${n}`;
const AT = '2026-10-20T09:00:00.000Z';
const ASHA = { id: session.employeeId!, employeeCode: 'SYN-001', displayName: 'Asha Synthetic', department: null };
const RAVI = { id: '20000000-0000-4000-8000-000000000002', employeeCode: 'SYN-002', displayName: 'Ravi Synthetic', department: null };

type Obj = Record<string, any>;
type Reply = [number, unknown];
interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: Obj | undefined;
}

const levels = (name: string) => [1, 2, 3, 4, 5].map((level) => ({ level, text: `Synthetic ${name} level ${level}` }));
const SECTIONS = [
  { code: 'IMPROVEMENT_AREAS', title: 'Areas for improvement', meaning: 'Where to improve.', filledBy: ['MANAGER'], prompts: { MANAGER: 'The areas to improve.' }, scored: false },
  { code: 'TRAINING_NEEDS', title: 'Training needs', meaning: 'Training needed.', filledBy: ['EMPLOYEE', 'MANAGER'], prompts: { EMPLOYEE: 'What you need.', MANAGER: 'What you recommend.' }, scored: false },
  { code: 'ACTIVITY_PERFORMANCE', title: 'Activity performance', meaning: 'Activities.', filledBy: ['EMPLOYEE', 'MANAGER'], prompts: {}, scored: false },
  { code: 'STRETCHED_KPIS', title: 'Stretched KPIs', meaning: 'Stretch targets.', filledBy: ['EMPLOYEE', 'MANAGER'], prompts: {}, scored: false },
];
const competencyItem = (n: number, code: string, name: string, weight: number, extra: Obj = {}) => ({
  id: AK(n),
  competencyId: K(n),
  sequence: n,
  code,
  name,
  description: null,
  indicators: levels(name),
  weight,
  selfEntryComplete: false,
  ...extra,
});
const goals = [
  { id: G(1), sequence: 1, description: 'Synthetic delivery goal', target: null, weight: 60, selfEntryComplete: true },
  { id: G(2), sequence: 2, description: 'Synthetic quality goal', target: null, weight: 40, selfEntryComplete: true },
];
const cycleRef = { id: C_OPEN, code: 'FY2026', name: 'Synthetic FY2026', startDate: '2026-04-01', endDate: '2027-03-31', approvalLevels: 1, ratingMode: 'FORMULA', scoring: { goalWeightPercent: 70, competencyWeightPercent: 30, competenciesAssessed: true }, state: 'OPEN' };
const windows = { goalSetting: { opensOn: '2026-04-01', closesOn: '2026-12-31', openToday: true, exceptionUntil: null, entryAllowed: true }, selfEntry: { opensOn: '2026-04-01', closesOn: '2026-12-31', openToday: true, exceptionUntil: null, entryAllowed: true }, managerRating: { opensOn: '2026-04-01', closesOn: '2026-12-31', openToday: true, exceptionUntil: null, entryAllowed: true } };

function ownView(): Obj {
  return {
    id: A_OWN,
    cycle: cycleRef,
    employee: ASHA,
    state: 'DRAFT',
    revision: 1,
    source: 'MANUAL',
    taskStatus: 'AWAITING_SELF_ENTRY',
    pending: null,
    goals,
    goalWeightTotal: 100,
    competencies: [competencyItem(1, 'CUST', 'Customer focus', 60), competencyItem(2, 'TEAM', 'Teamwork', 40)],
    competencyWeightTotal: 100,
    // The own view: no manager completion flag (rating progress is not shown on one's own appraisal).
    sections: [{ ...SECTIONS[0] }, { ...SECTIONS[1], selfEntryComplete: false }],
    windows,
    revisions: [
      {
        revision: 1,
        state: 'DRAFT',
        submittedAt: null,
        returnedAt: null,
        confirmedAt: null,
        employeeMessage: null,
        selfEntry: { comment: null, entries: [], competencies: [{ competencyId: AK(1), sequence: 1, score: 3, comment: null }], sections: [{ section: 'TRAINING_NEEDS', text: null }] },
      },
    ],
    decisions: [],
    exceptions: [],
    completedAt: null,
    cancelledAt: null,
    createdAt: AT,
    version: 4,
  };
}

function rateView(): Obj {
  return {
    ...ownView(),
    id: A_RATE,
    employee: RAVI,
    state: 'SUBMITTED',
    taskStatus: 'AWAITING_MANAGER_RATING',
    competencies: [competencyItem(1, 'CUST', 'Customer focus', 60, { selfEntryComplete: true, managerRatingComplete: false }), competencyItem(2, 'TEAM', 'Teamwork', 40, { selfEntryComplete: true, managerRatingComplete: false })],
    sections: [
      { ...SECTIONS[0], managerEntryComplete: false },
      { ...SECTIONS[1], selfEntryComplete: true, managerEntryComplete: false },
    ],
    revisions: [
      {
        revision: 1,
        state: 'SUBMITTED',
        submittedAt: AT,
        returnedAt: null,
        confirmedAt: null,
        ratedAt: null,
        approvalLevels: 1,
        employeeMessage: null,
        selfEntry: {
          comment: null,
          entries: [],
          competencies: [
            { competencyId: AK(1), sequence: 1, score: 4, comment: 'Synthetic own view of customers' },
            { competencyId: AK(2), sequence: 2, score: 3, comment: null },
          ],
          sections: [{ section: 'TRAINING_NEEDS', text: 'Synthetic: a negotiation course' }],
        },
        managerRating: { comment: null, entries: [], competencies: [], sections: [{ section: 'IMPROVEMENT_AREAS', text: null }, { section: 'TRAINING_NEEDS', text: null }], weightedResult: null, goalResult: null, competencyResult: null, split: null, overallRating: null },
        reviewerScores: [],
      },
    ],
    version: 7,
  };
}

let calls: Call[] = [];
let overrides: Record<string, Reply | ((c: Call) => Reply)> = {};
let own: Obj = ownView();
const competencies: Obj[] = [];
const sets: Obj[] = [];

function fakeApi(call: Call): Reply {
  const { method, path, body = {} } = call;
  if (path === '/v1/appraisal-sections') return [200, { items: SECTIONS }];
  if (path === '/v1/appraisal-scoring-settings') {
    if (method === 'GET')
      return [200, { businessDate: '2026-11-06', inForce: { goalWeightPercent: 70, competencyWeightPercent: 30 }, items: [{ id: 'x1', effectiveFrom: '2000-01-01', effectiveTo: null, goalWeightPercent: 70, competencyWeightPercent: 30, reason: 'Initial split', version: 1 }] }];
    return [201, { id: 'x2', ...body, effectiveTo: null, version: 1 }];
  }
  if (path === '/v1/appraisal-competencies') {
    if (method === 'GET') return [200, { items: competencies }];
    const k = { id: K(competencies.length + 1), code: String(body.code).toUpperCase(), name: body.name, description: body.description, indicators: (body.indicators as string[]).map((text, i) => ({ level: i + 1, text })), activeFrom: body.activeFrom, activeTo: null, activeToday: true, usedInSets: 0, version: 1 };
    competencies.push(k);
    return [201, k];
  }
  if (path === '/v1/appraisal-competency-sets') {
    if (method === 'GET') return [200, { items: sets }];
    const total = (body.items as { weight: number }[]).reduce((t, i) => t + i.weight, 0);
    if (total !== 100) return [422, { error: 'WEIGHT_TOTAL_NOT_100', message: 'x', details: { total } }];
    const s = { id: 'set-1', grade: { id: GRADE, code: 'G1', name: 'Synthetic Grade One' }, designation: null, effectiveFrom: body.effectiveFrom, effectiveTo: null, inForceToday: true, reason: body.reason, items: [], weightTotal: 100, version: 1 };
    sets.push(s);
    return [201, s];
  }
  if (path === '/v1/org/grades') return [200, { items: [{ id: GRADE, code: 'G1', name: 'Synthetic Grade One' }] }];
  if (path === '/v1/org/designations') return [200, { items: [] }];
  if (path === '/v1/me/appraisals') return [200, { items: [{ id: A_OWN, cycle: { id: C_OPEN, code: 'FY2026', name: 'Synthetic FY2026' }, employee: ASHA, state: 'DRAFT', revision: 1, source: 'MANUAL', taskStatus: 'AWAITING_SELF_ENTRY', goalCount: 2, goalWeightTotal: 100, completedAt: null, createdAt: AT }] }];
  if (path === `/v1/me/appraisals/${A_OWN}`) return [200, own];
  if (path === `/v1/me/appraisals/${A_OWN}/self-entry`) {
    // The saved self-entry, as the server would now return it.
    const rev = own.revisions[0];
    own = {
      ...own,
      version: own.version + 1,
      revisions: [
        {
          ...rev,
          selfEntry: {
            ...rev.selfEntry,
            competencies: [
              { competencyId: AK(1), sequence: 1, score: 3, comment: null },
              { competencyId: AK(2), sequence: 2, score: 4, comment: null },
            ],
            sections: [{ section: 'TRAINING_NEEDS', text: 'Synthetic: a negotiation course' }],
          },
        },
      ],
    };
    return [200, own];
  }
  if (path === `/v1/me/appraisals/${A_OWN}/submit`) return [422, { error: 'SELF_ENTRY_INCOMPLETE', message: 'x', details: { goals: [], competencies: [2], sections: ['TRAINING_NEEDS'] } }];
  if (path === '/v1/appraisal-tasks/mine') return [200, { items: [{ taskId: T_RATE, step: 1, stage: 'MANAGER_RATING', level: null, assignedAt: AT, dueOn: '2026-12-31', overdue: false, appraisal: rateView() }] }];
  if (path === `/v1/appraisal-tasks/${T_RATE}/rating`) return [200, { ...rateView(), version: 8 }];
  if (path === `/v1/appraisal-tasks/${T_RATE}/decision`) return [422, { error: 'RATING_INCOMPLETE', message: 'x', details: { goals: [], competencies: [], sections: ['IMPROVEMENT_AREAS'] } }];
  if (path === `/v1/appraisal-cycles/${C_OPEN}/training-needs`)
    return [200, { sectionIncluded: true, suggestionOnly: true, population: 1, items: [{ appraisalId: A_RATE, employee: RAVI, employeeStated: 'Synthetic: a negotiation course', managerRecommended: 'Synthetic: advanced negotiation' }] }];
  if (path === `/v1/appraisal-cycles/${C_OPEN}/report`) return [200, { cycle: cycleRef, filters: { departmentId: null }, scope: 'COMPANY', ownAppraisalExcluded: true, generatedAt: AT, population: 1, byState: { APPROVED: 1 } }];
  if (path === '/v1/appraisal-cycles') {
    const c = { ...cycleRef, version: 1, reviewDueOn: null, goalReviewRequired: true, windows: {}, sections: [] };
    return method === 'GET' ? [200, { items: [c] }] : [201, c];
  }
  return [404, { error: 'NOT_FOUND', message: 'Not found' }];
}

function serve(extra: Record<string, Reply | ((c: Call) => Reply)> = {}) {
  calls = [];
  overrides = extra;
  own = ownView();
  competencies.length = 0;
  sets.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname, params: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const route = overrides[`${call.method} ${call.path}`];
      const reply = (route === undefined ? undefined : typeof route === 'function' ? route(call) : route) ?? fakeApi(call);
      return new Response(JSON.stringify(reply[1]), { status: reply[0], headers: { 'content-type': 'application/json' } });
    }),
  );
}

const bodiesTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).map((c) => c.body);
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
function context(permissions: string[], own = false) {
  session.permissions = permissions;
  session.roleCode = own ? 'EMPLOYEE' : 'HR_ADMINISTRATOR';
  session.scopeKind = own ? 'OWN' : 'COMPANY';
}
function renderAt(entry: string, permissions: string[]) {
  context(permissions);
  return render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          {APPRAISAL_SCREENS.map((s) => (
            <Route key={s.path} path={s.path} element={<s.component />} />
          ))}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
function renderComponent(Component: () => JSX.Element | null, permissions: string[], own = false) {
  context(permissions, own);
  return render(
    <QueryClientProvider client={client()}>
      <MemoryRouter>
        <Component />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const form = (name: string) => screen.getByRole('form', { name });
const change = (scope: HTMLElement, label: string | RegExp, value: string) => fireEvent.change(within(scope).getByLabelText(label), { target: { value } });
const alertText = () =>
  screen
    .queryAllByRole('alert')
    .map((a) => a.textContent)
    .join(' | ');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Appraisal competencies screen (Appraisal Config, I-86)', () => {
  it('shows the dated result split and adds a competency with one behavioural indicator per level 1 to 5', async () => {
    serve();
    renderAt('/appraisal/competencies', [CYCLE_READ, CYCLE_MANAGE, ORG_READ]);
    expect(await screen.findByText('goals 70%, competencies 30%')).toBeTruthy();
    const f = form('New competency');
    change(f, 'Code', 'cust');
    change(f, 'Name', 'Customer focus');
    fireEvent.click(within(f).getByRole('button', { name: 'Add the competency' }));
    expect(alertText()).toContain('Describe each proficiency level 1 to 5.');
    for (const level of [1, 2, 3, 4, 5]) change(f, `Level ${level} behaviour`, `Synthetic customer level ${level}`);
    change(f, 'Active from', '2026-01-01');
    fireEvent.click(within(f).getByRole('button', { name: 'Add the competency' }));
    await screen.findByText('Added CUST.');
    expect(bodiesTo('POST', '/v1/appraisal-competencies')).toEqual([
      { name: 'Customer focus', description: null, indicators: [1, 2, 3, 4, 5].map((l) => `Synthetic customer level ${l}`), activeFrom: '2026-01-01', code: 'cust' },
    ]);
    // A new split starts today or later; the percentages add up to 100.
    const s = form('New result split');
    change(s, 'Starts on', '2027-04-01');
    change(s, 'Goals %', '60');
    change(s, 'Competencies %', '45');
    change(s, 'Reason', 'Synthetic policy change');
    fireEvent.click(within(s).getByRole('button', { name: 'Save the new split' }));
    expect(alertText()).toContain('add up to exactly 100');
    change(s, 'Competencies %', '40');
    fireEvent.click(within(s).getByRole('button', { name: 'Save the new split' }));
    await waitFor(() => expect(bodiesTo('POST', '/v1/appraisal-scoring-settings')).toEqual([{ effectiveFrom: '2027-04-01', goalWeightPercent: 60, competencyWeightPercent: 40, reason: 'Synthetic policy change' }]));
  });

  it('maps a dated competency set to a grade with weights totalling 100, and says a refused total in words', async () => {
    serve({ 'POST /v1/appraisal-competency-sets': [422, { error: 'WEIGHT_TOTAL_NOT_100', message: 'x', details: { total: 90 } }] });
    competencies.push({ id: K(1), code: 'CUST', name: 'Customer focus', description: null, indicators: levels('c'), activeFrom: '2026-01-01', activeTo: null, activeToday: true, usedInSets: 0, version: 1 });
    renderAt('/appraisal/competencies', [CYCLE_READ, CYCLE_MANAGE, ORG_READ]);
    const f = await waitFor(() => form('New competency set'));
    await within(f).findByRole('option', { name: 'Synthetic Grade One (G1)' });
    await within(f).findByRole('option', { name: 'Customer focus (CUST)' });
    change(f, 'Grade', GRADE);
    change(f, 'Starts on', '2026-11-06');
    change(f, 'Competency 1', K(1));
    change(f, 'Weight of competency 1', '90');
    change(f, 'Reason', 'Synthetic mapping');
    fireEvent.click(within(f).getByRole('button', { name: 'Save the set' }));
    expect(alertText()).toContain('The weights total 90; they must total exactly 100.');
    expect(bodiesTo('POST', '/v1/appraisal-competency-sets')).toEqual([]);
    change(f, 'Weight of competency 1', '100');
    overrides = { 'POST /v1/appraisal-competency-sets': [422, { error: 'COMPETENCY_NOT_ACTIVE', message: 'x' }] };
    fireEvent.click(within(f).getByRole('button', { name: 'Save the set' }));
    await waitFor(() => expect(alertText()).toContain('Each competency in a set is active from the set’s start date and has no end date.'));
    expect(bodiesTo('POST', '/v1/appraisal-competency-sets')).toEqual([{ gradeId: GRADE, effectiveFrom: '2026-11-06', items: [{ competencyId: K(1), weight: 100 }], reason: 'Synthetic mapping' }]);
  });

  it('is read-only without the manage duty', async () => {
    serve();
    renderAt('/appraisal/competencies', [CYCLE_READ]);
    await screen.findByText('goals 70%, competencies 30%');
    expect(screen.queryByRole('form', { name: 'New competency' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'New result split' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'New competency set' })).toBeNull();
  });
});

describe('a cycle’s split and sections (I-86)', () => {
  it('sends the split and the sections only when given; the percentages add up to 100', async () => {
    serve();
    renderAt('/appraisal/cycles', [CYCLE_READ, CYCLE_MANAGE]);
    const f = form('New cycle');
    await within(f).findByText(/Training needs: Training needed\./);
    change(f, 'Code', 'fy2027');
    change(f, 'Name', 'Synthetic FY2027');
    change(f, 'Start date', '2027-04-01');
    change(f, 'Review due date', '2028-02-28');
    change(f, 'Goals %', '80');
    fireEvent.click(within(f).getByRole('button', { name: 'Create the cycle' }));
    expect(alertText()).toContain('add up to exactly 100');
    change(f, 'Competencies %', '20');
    fireEvent.click(within(f).getByLabelText(/^Training needs:/));
    fireEvent.click(within(f).getByRole('button', { name: 'Create the cycle' }));
    await screen.findByText(/Created cycle/);
    expect(bodiesTo('POST', '/v1/appraisal-cycles')[0]).toMatchObject({ goalWeightPercent: 80, competencyWeightPercent: 20, sections: ['TRAINING_NEEDS'] });
  });
});

describe('competencies and sections in the self-entry (H1/BR-053 own record)', () => {
  it('shows the copied competencies with their levels, sends only changed competency scores and the employee’s sections, and says what is missing', async () => {
    serve();
    renderComponent(APPRAISAL_ESS_PANELS[0]!.component as () => JSX.Element, [READ, READ_SELF, SELF_ASSESS], true);
    await screen.findByRole('heading', { name: 'My competencies' });
    expect(screen.getAllByText('Synthetic Teamwork level 5').length).toBeGreaterThan(0);
    const f = form('My self-assessment');
    // The manager's section is not offered to the employee.
    expect(within(f).queryByText(/Areas for improvement/)).toBeNull();
    change(f, 'Score for Teamwork (1 to 5)', '4');
    change(f, /^Training needs/, 'Synthetic: a negotiation course');
    fireEvent.click(within(f).getByRole('button', { name: 'Save my self-assessment' }));
    await waitFor(() =>
      expect(bodiesTo('PUT', `/v1/me/appraisals/${A_OWN}/self-entry`)).toEqual([
        { entries: [], competencies: [{ competencyId: AK(2), score: 4, comment: null }], sections: [{ section: 'TRAINING_NEEDS', text: 'Synthetic: a negotiation course' }], expectedVersion: 4 },
      ]),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Submit my self-assessment' }));
    await waitFor(() => expect(alertText()).toContain('still missing competency 2, the training needs section'));
  });
});

describe('competencies and sections in the manager rating', () => {
  it('rates competencies, fills the manager’s sections and says a missing section in words', async () => {
    serve();
    renderComponent(APPRAISAL_TASK_QUEUES.find((q) => q.title === 'Appraisal ratings')!.component as () => JSX.Element, [READ, READ_RATING, RATE]);
    const f = await screen.findByRole('form', { name: 'Rating of Ravi Synthetic (SYN-002)' });
    // The employee's competency self-scores and section text, as the API returned them to this role.
    expect(screen.getByText('Synthetic own view of customers')).toBeTruthy();
    expect(screen.getByText('Synthetic: a negotiation course')).toBeTruthy();
    change(f, 'Score for Customer focus (1 to 5)', '3');
    change(f, 'Score for Teamwork (1 to 5)', '4');
    change(f, /^Training needs/, 'Synthetic: advanced negotiation');
    fireEvent.click(within(f).getByRole('button', { name: 'Save the scores' }));
    await waitFor(() =>
      expect(bodiesTo('PUT', `/v1/appraisal-tasks/${T_RATE}/rating`)).toEqual([
        {
          entries: [],
          competencies: [
            { competencyId: AK(1), score: 3, comment: null },
            { competencyId: AK(2), score: 4, comment: null },
          ],
          sections: [{ section: 'TRAINING_NEEDS', text: 'Synthetic: advanced negotiation' }],
          expectedVersion: 7,
        },
      ]),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Submit the rating' }));
    await waitFor(() => expect(alertText()).toContain('still missing the areas for improvement section'));
  });
});

describe('training needs for training planning', () => {
  it('are listed as a suggestion with the rating group’s report duty, and not offered without it', async () => {
    serve();
    renderAt('/appraisal/reports', [CYCLE_READ, REPORT, REPORT_RATING]);
    // The reports screen asks for a cycle first.
    await screen.findByRole('option', { name: /FY2026/ });
    fireEvent.change(screen.getByLabelText('Cycle'), { target: { value: C_OPEN } });
    const table = await screen.findByRole('table', { name: 'Training needs' });
    expect(within(table).getByText('Synthetic: advanced negotiation')).toBeTruthy();
    expect(within(table).getByText('Synthetic: a negotiation course')).toBeTruthy();
    expect(screen.getByText(/nobody is enrolled from here/)).toBeTruthy();
    cleanup();
    serve();
    renderAt('/appraisal/reports', [CYCLE_READ, REPORT]);
    await screen.findByRole('option', { name: /FY2026/ });
    fireEvent.change(screen.getByLabelText('Cycle'), { target: { value: C_OPEN } });
    await screen.findByRole('table', { name: 'Appraisals by state' });
    expect(screen.queryByRole('table', { name: 'Training needs' })).toBeNull();
    expect(calls.some((c) => c.path.endsWith('/training-needs'))).toBe(false);
  });
});
