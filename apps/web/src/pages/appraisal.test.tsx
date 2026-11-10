// Appraisal screens (FR-040 to FR-044; F1 "Appraisal"; H3 TN18; I-23; I-24; DF02; DF03; C4; ZT07), jsdom: the cycle start
// month and cycles with their windows and reviewer levels; the register within row scope; enrolment with goals; one
// appraisal's goals (weights shown against 100), windows, revisions, decision history, exceptions and cancellation;
// the manager rating per goal (1 to 5) and the independent reviewer confirmation, each with one idempotency key per
// decision; the cycle report and export; the KRA upload (DRAFT only; a file held for the malware scan checked again
// through the resume route, the user's own uploads listed and opened again); and My ESS TN18 in the Employee OWN context.
// Controls are hidden without their permission keys, refusals are said in plain words, and confidential ratings,
// comments, results, remarks and reasons are shown only when the API returned them. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
// The automatic re-check of a waiting batch has its own tests (held-batch.test.tsx): here the manual check is on its own.
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
const MANAGE = 'appraisal.manage.operational';
const CANCEL = 'appraisal.cancel.operational';
const GRANT_EXCEPTION = 'appraisal.grant_exception.operational';
const IMPORT = 'appraisal.import.operational';
const REPORT = 'appraisal.report.operational';
const EXPORT = 'appraisal.export.operational';
const RATE = 'appraisal.rate.rating';
const CONFIRM = 'appraisal.confirm.rating';
const SELF_ASSESS = 'appraisal.self_assess.self';
const EMPLOYEE_LIST = 'employee.list.operational';
const HR = [CYCLE_READ, CYCLE_MANAGE, READ, MANAGE, CANCEL, GRANT_EXCEPTION, IMPORT, REPORT, EXPORT, EMPLOYEE_LIST];
const EMPLOYEE = [READ, READ_SELF, SELF_ASSESS];

const ASSIGNMENT_A = 'a0000000-0000-4000-8000-000000000001';
const ASSIGNMENT_B = 'a0000000-0000-4000-8000-000000000002';
const U_RAVI_MANAGER = 'b0000000-0000-4000-8000-000000000002';
const C_OPEN = '10000000-0000-4000-8000-000000000001';
const C_CLOSED = '10000000-0000-4000-8000-000000000002';
const C_NEW = '10000000-0000-4000-8000-000000000003';
const A_DRAFT = '30000000-0000-4000-8000-000000000001';
const A_RATE = '30000000-0000-4000-8000-000000000002';
const A_REVIEW = '30000000-0000-4000-8000-000000000003';
const A_NEW = '30000000-0000-4000-8000-000000000004';
const A_OWN = '30000000-0000-4000-8000-000000000005';
const T_RATE = '40000000-0000-4000-8000-000000000001';
const T_REVIEW = '40000000-0000-4000-8000-000000000002';
const G = (n: number) => `50000000-0000-4000-8000-00000000000${n}`;
const JOB = '60000000-0000-4000-8000-000000000001';

const ASHA = { id: session.employeeId!, employeeCode: 'SYN-001', displayName: 'Asha Synthetic', department: { id: 'd1', name: 'Engineering' } };
const RAVI = { id: '20000000-0000-4000-8000-000000000002', employeeCode: 'SYN-002', displayName: 'Ravi Synthetic', department: { id: 'd1', name: 'Engineering' } };
const MEERA = { id: '20000000-0000-4000-8000-000000000003', employeeCode: 'SYN-003', displayName: 'Meera Synthetic', department: null };
const AT = '2026-10-20T09:00:00.000Z';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

const cycleWindows = { goalSetting: { opensOn: '2026-04-01', closesOn: '2026-12-31', openToday: true }, selfEntry: { opensOn: '2026-05-01', closesOn: '2027-01-31', openToday: true }, managerRating: null };
const cycle = (id: string, code: string, state: string, patch: Obj = {}): Obj => ({
  id,
  code,
  name: `Synthetic ${code}`,
  startDate: '2026-04-01',
  endDate: '2027-03-31',
  approvalLevels: 1,
  goalReviewRequired: false,
  ratingMode: 'FORMULA',
  reviewDueOn: '2027-02-28',
  state,
  windows: cycleWindows,
  version: 3,
  ...patch,
});
const win = (allowed: boolean, patch: Obj = {}): Obj => ({ opensOn: '2026-04-01', closesOn: '2026-12-31', openToday: allowed, exceptionUntil: null, entryAllowed: allowed, ...patch });
const goal = (n: number, weight: number, patch: Obj = {}): Obj => ({
  id: G(n),
  sequence: n,
  description: `Synthetic goal ${n}`,
  target: null,
  weight,
  selfEntryComplete: false,
  managerRatingComplete: false,
  ...patch,
});
const entry = (n: number, score: number | null, comment: string | null = null) => ({ goalId: G(n), sequence: n, score, comment });
const appraisal = (id: string, employee: Obj, patch: Obj = {}): Obj => ({
  id,
  cycle: { id: C_OPEN, code: 'FY2026', name: 'Synthetic FY2026', startDate: '2026-04-01', endDate: '2027-03-31', approvalLevels: 1, state: 'OPEN' },
  employee,
  state: 'DRAFT',
  revision: 1,
  source: 'MANUAL',
  taskStatus: 'AWAITING_SELF_ENTRY',
  pending: null,
  goals: [goal(1, 60), goal(2, 30)],
  goalWeightTotal: 90,
  windows: { goalSetting: win(true), selfEntry: win(true), managerRating: win(false, { opensOn: null, closesOn: null }) },
  revisions: [{ revision: 1, state: 'DRAFT', submittedAt: null, returnedAt: null, confirmedAt: null, ratedAt: null, approvalLevels: null }],
  decisions: [],
  exceptions: [],
  completedAt: null,
  cancelledAt: null,
  createdAt: AT,
  version: 4,
  ...patch,
});

/** A completed appraisal as HR with the rating and reason groups sees it. */
const fullView = () =>
  appraisal(A_REVIEW, MEERA, {
    state: 'APPROVED',
    taskStatus: 'COMPLETED',
    goals: [goal(1, 30, { selfEntryComplete: true, managerRatingComplete: true }), goal(2, 70, { selfEntryComplete: true, managerRatingComplete: true })],
    goalWeightTotal: 100,
    revisions: [
      {
        revision: 1,
        state: 'CONFIRMED',
        submittedAt: AT,
        returnedAt: null,
        confirmedAt: AT,
        ratedAt: AT,
        approvalLevels: 1,
        employeeMessage: null,
        selfEntry: { comment: 'Synthetic self comment', entries: [entry(1, 4, 'Synthetic self note'), entry(2, 4)] },
        managerRating: { comment: 'Synthetic manager comment', entries: [entry(1, 3, 'Synthetic manager note'), entry(2, 5)], weightedResult: '4.40' },
      },
    ],
    decisions: [
      { revision: 1, step: 1, stage: 'MANAGER_RATING', level: null, decision: 'APPROVE', decidedAt: AT, decidedBy: { userId: U_RAVI_MANAGER, employeeCode: 'SYN-009', displayName: 'Mira Manager' }, remark: 'Synthetic private rater remark' },
      { revision: 1, step: 2, stage: 'REVIEW', level: 1, decision: 'APPROVE', decidedAt: AT, decidedBy: { userId: session.userId, employeeCode: null, displayName: null }, remark: null },
    ],
    finalRating: '4.40',
    exceptions: [{ stage: 'SELF_ENTRY', validUntil: '2026-11-15', recordedAt: AT, recordedBy: { userId: session.userId, employeeCode: null, displayName: null }, reason: 'Synthetic late joiner' }],
    completedAt: AT,
    cancelReason: null,
  });

/** The same appraisal for an assignment without the confidential groups: those keys are absent, not empty. */
function plainView(): Obj {
  const v = fullView();
  delete v.finalRating;
  delete v.cancelReason;
  v.revisions = v.revisions.map((r: Obj) => {
    const { selfEntry: _s, managerRating: _m, employeeMessage: _e, ...rest } = r;
    return rest;
  });
  v.decisions = v.decisions.map((d: Obj) => {
    const { remark: _r, ...rest } = d;
    return rest;
  });
  v.exceptions = v.exceptions.map((x: Obj) => {
    const { reason: _r, ...rest } = x;
    return rest;
  });
  return v;
}

const rateTaskView = () =>
  appraisal(A_RATE, RAVI, {
    state: 'SUBMITTED',
    taskStatus: 'AWAITING_MANAGER_RATING',
    goals: [goal(1, 60, { selfEntryComplete: true }), goal(2, 40, { selfEntryComplete: true })],
    goalWeightTotal: 100,
    pending: { taskId: T_RATE, step: 1, stage: 'MANAGER_RATING', level: null, assignedAt: AT, with: { userId: session.userId, employeeCode: 'SYN-001', displayName: 'Asha Synthetic' } },
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
        selfEntry: { comment: 'Synthetic self comment', entries: [entry(1, 4, 'Synthetic self note'), entry(2, 3)] },
        managerRating: { comment: null, entries: [entry(1, null), entry(2, null)], weightedResult: null },
      },
    ],
    version: 5,
  });

const reviewTaskView = () =>
  appraisal(A_REVIEW, MEERA, {
    state: 'IN_REVIEW',
    taskStatus: 'AWAITING_REVIEW',
    goals: [goal(1, 30, { selfEntryComplete: true, managerRatingComplete: true }), goal(2, 70, { selfEntryComplete: true, managerRatingComplete: true })],
    goalWeightTotal: 100,
    revisions: [{ ...fullView().revisions[0], state: 'RATED', confirmedAt: null }],
    version: 8,
  });

const ownView = (patch: Obj = {}) =>
  appraisal(A_OWN, ASHA, {
    goals: [goal(1, 60, { selfEntryComplete: true }), goal(2, 30)].map(({ managerRatingComplete: _m, ...g }) => g),
    revisions: [{ revision: 1, state: 'DRAFT', submittedAt: null, returnedAt: null, confirmedAt: null, employeeMessage: null, selfEntry: { comment: null, entries: [entry(1, 4, 'Synthetic own note')] } }],
    ...patch,
  });

interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: Obj | undefined;
}
type Reply = [status: number, body: unknown];
type RouteReply = Reply | ((call: Call) => Reply | undefined);

interface Db {
  setting: Obj;
  cycles: Obj[];
  appraisals: Map<string, Obj>;
  tasks: Obj[];
  own: Map<string, Obj>;
  keys: Map<string, { taskId: string; reply: Obj }>;
}
let db: Db;
let calls: Call[] = [];
let holds = new Map<string, Promise<void>>();
let lost = new Set<string>();
const NOT_FOUND = { error: 'NOT_FOUND', message: 'Not found' };

function listRow(a: Obj): Obj {
  return {
    id: a.id,
    cycle: { id: a.cycle.id, code: a.cycle.code, name: a.cycle.name },
    employee: a.employee,
    state: a.state,
    revision: a.revision,
    source: a.source,
    taskStatus: a.taskStatus,
    goalCount: a.goals.length,
    goalWeightTotal: a.goalWeightTotal,
    completedAt: a.completedAt,
    createdAt: a.createdAt,
    ...('finalRating' in a ? { finalRating: a.finalRating, weightedResult: a.finalRating } : {}),
  };
}

function fakeApi(call: Call): Reply {
  const { method, path, body = {} } = call;
  let m: RegExpExecArray | null;
  if (path === '/v1/appraisal-settings') {
    if (method === 'GET') return [200, db.setting];
    db.setting = { configured: true, cycleStartMonth: body.cycleStartMonth, version: (db.setting.version ?? 0) + 1 };
    return [200, db.setting];
  }
  if (path === '/v1/appraisal-cycles') {
    if (method === 'GET') return [200, { items: db.cycles.filter((c) => !call.params.get('state') || c.state === call.params.get('state')) }];
    if (!String(body.startDate).endsWith('-04-01')) return [422, { error: 'CYCLE_START_NOT_ALIGNED', message: 'x', details: { cycleStartMonth: 4 } }];
    const c = cycle(C_NEW, String(body.code).toUpperCase(), 'OPEN', {
      name: body.name,
      approvalLevels: body.approvalLevels,
      goalReviewRequired: body.goalReviewRequired,
      ratingMode: body.ratingMode,
      reviewDueOn: body.reviewDueOn,
      startDate: body.startDate,
      endDate: '2028-03-31',
      version: 1,
    });
    db.cycles.unshift(c);
    return [201, c];
  }
  if ((m = /^\/v1\/appraisal-cycles\/([0-9a-f-]{36})$/.exec(path))) {
    const c = db.cycles.find((x) => x.id === m![1]);
    if (!c) return [404, NOT_FOUND];
    if (method === 'GET') return [200, c];
    if (body.expectedVersion !== c.version) return [409, { error: 'STALE_VERSION', message: 'x' }];
    Object.assign(c, {
      name: body.name,
      approvalLevels: body.approvalLevels,
      goalReviewRequired: body.goalReviewRequired,
      ratingMode: body.ratingMode,
      reviewDueOn: body.reviewDueOn,
      version: c.version + 1,
    });
    return [200, c];
  }
  if ((m = /^\/v1\/appraisal-cycles\/([0-9a-f-]{36})\/close$/.exec(path))) return [409, { error: 'OPEN_APPRAISALS', message: 'x', details: { open: 2 } }];
  if (/\/report$/.test(path)) {
    return [
      200,
      {
        cycle: { id: C_OPEN, code: 'FY2026', name: 'Synthetic FY2026', startDate: '2026-04-01', endDate: '2027-03-31' },
        filters: { departmentId: null },
        scope: 'COMPANY',
        ownAppraisalExcluded: true,
        generatedAt: AT,
        population: 3,
        byState: { DRAFT: 1, SUBMITTED: 0, IN_REVIEW: 0, RETURNED: 0, APPROVED: 2, CANCELLED: 1 },
        ratings: { completed: 2, distribution: [{ finalRating: '3.00', count: 1 }, { finalRating: '4.10', count: 1 }] },
      },
    ];
  }
  if (/\/export$/.test(path)) return [422, { error: 'EXPORT_TOO_LARGE', message: 'x', details: { limit: 10000 } }];
  if (path === '/v1/appraisals') {
    if (method === 'GET') {
      const items = [...db.appraisals.values()].map(listRow);
      return [200, { items, total: items.length, page: Number(call.params.get('page') ?? 1), pageSize: Number(call.params.get('pageSize') ?? 25) }];
    }
    const a = appraisal(A_NEW, RAVI, {
      goals: (body.goals ?? []).map((g: Obj, i: number) => goal(i + 1, g.weight, { description: g.description, target: g.target })),
      goalWeightTotal: (body.goals ?? []).reduce((s: number, g: Obj) => s + g.weight, 0),
      version: 1,
    });
    db.appraisals.set(A_NEW, a);
    return [201, a];
  }
  if ((m = /^\/v1\/appraisals\/([0-9a-f-]{36})(\/[a-z-]+)?$/.exec(path))) {
    const a = db.appraisals.get(m[1]!);
    if (!a) return [404, NOT_FOUND];
    const sub = m[2];
    if (!sub) return [200, a];
    if (sub === '/goals') {
      const seqs = (body.goals as Obj[]).map((g) => g.sequence);
      if (new Set(seqs).size !== seqs.length) return [422, { error: 'DUPLICATE_SEQUENCE', message: 'x', details: { sequence: seqs[0] } }];
      a.goals = (body.goals as Obj[]).map((g, i) => goal(i + 1, g.weight, { sequence: g.sequence, description: g.description, target: g.target }));
      a.goalWeightTotal = (body.goals as Obj[]).reduce((s, g) => s + g.weight, 0);
      a.version += 1;
      return [200, a];
    }
    if (sub === '/window-exceptions') {
      if (body.validUntil < '2026-10-28') return [422, { error: 'INVALID_DATE', message: 'x', details: { field: 'validUntil' } }];
      a.exceptions = [...a.exceptions, { stage: body.stage, validUntil: body.validUntil, recordedAt: AT, recordedBy: { userId: session.userId, employeeCode: null, displayName: null }, reason: body.reason }];
      a.version += 1;
      return [201, a];
    }
    if (sub === '/cancel') {
      Object.assign(a, { state: 'CANCELLED', taskStatus: 'CANCELLED', cancelledAt: AT, version: a.version + 1 });
      return [200, a];
    }
  }
  if (method === 'GET' && path === '/v1/appraisal-tasks/mine') return [200, { items: db.tasks }];
  if ((m = /^\/v1\/appraisal-tasks\/([0-9a-f-]{36})\/rating$/.exec(path))) {
    const t = db.tasks.find((x) => x.taskId === m![1]);
    if (!t) return [404, NOT_FOUND];
    const a = t.appraisal as Obj;
    if (body.expectedVersion !== a.version) return [409, { error: 'STALE_VERSION', message: 'x' }];
    const rating = a.revisions[0].managerRating as Obj;
    for (const e of body.entries as Obj[]) {
      rating.entries = rating.entries.map((x: Obj) => (x.goalId === e.goalId ? { ...x, score: e.score, comment: e.comment } : x));
      a.goals = a.goals.map((g: Obj) => (g.id === e.goalId ? { ...g, managerRatingComplete: e.score !== null } : g));
    }
    if ('comment' in body) rating.comment = body.comment;
    t.appraisal = { ...a, version: a.version + 1 };
    return [200, t.appraisal];
  }
  if ((m = /^\/v1\/appraisal-tasks\/([0-9a-f-]{36})\/decision$/.exec(path))) {
    const taskId = m[1]!;
    const prior = db.keys.get(String(body.idempotencyKey));
    if (prior) return prior.taskId === taskId ? [200, { ...prior.reply, replayed: true }] : [409, { error: 'IDEMPOTENCY_KEY_REUSED', message: 'x' }];
    const t = db.tasks.find((x) => x.taskId === taskId);
    if (!t) return [404, NOT_FOUND];
    if (body.decision === 'RETURN' && !body.employeeMessage) return [422, { error: 'EMPLOYEE_MESSAGE_REQUIRED', message: 'x' }];
    const a = t.appraisal as Obj;
    let reply: Obj;
    if (body.decision === 'RETURN') reply = { appraisalId: a.id, state: 'RETURNED', revision: a.revision + 1, replayed: false };
    else if (t.stage === 'MANAGER_RATING') {
      const unrated = (a.revisions[0].managerRating.entries as Obj[]).filter((e) => e.score === null).map((e) => e.sequence);
      if (unrated.length) return [422, { error: 'RATING_INCOMPLETE', message: 'x', details: { goals: unrated } }];
      reply = { appraisalId: a.id, state: 'IN_REVIEW', revision: a.revision, pendingStep: 2, replayed: false };
    } else reply = { appraisalId: a.id, state: 'APPROVED', revision: a.revision, replayed: false };
    db.keys.set(String(body.idempotencyKey), { taskId, reply });
    db.tasks = db.tasks.filter((x) => x !== t);
    return [200, reply];
  }
  if (method === 'GET' && path === '/v1/me/appraisals') return [200, { items: [...db.own.values()].map(listRow) }];
  if ((m = /^\/v1\/me\/appraisals\/([0-9a-f-]{36})(\/[a-z-]+)?$/.exec(path))) {
    const a = db.own.get(m[1]!);
    if (!a) return [404, NOT_FOUND];
    if (!m[2]) return [200, a];
    if (body.expectedVersion !== a.version) return [409, { error: 'STALE_VERSION', message: 'x' }];
    if (m[2] === '/self-entry') {
      const self = a.revisions.at(-1).selfEntry as Obj;
      for (const e of body.entries as Obj[]) {
        const g = (a.goals as Obj[]).find((x) => x.id === e.goalId)!;
        self.entries = [...self.entries.filter((x: Obj) => x.goalId !== e.goalId), entry(g.sequence, e.score, e.comment)].sort((x: Obj, y: Obj) => x.sequence - y.sequence);
        g.selfEntryComplete = e.score !== null;
      }
      if ('comment' in body) self.comment = body.comment;
      a.version += 1;
      return [200, a];
    }
    if (a.goalWeightTotal !== 100) return [422, { error: 'WEIGHT_TOTAL_NOT_100', message: 'x', details: { total: a.goalWeightTotal } }];
    Object.assign(a, { state: 'SUBMITTED', taskStatus: 'AWAITING_MANAGER_RATING', version: a.version + 1, pending: { step: 1, stage: 'MANAGER_RATING', level: null, assignedAt: AT, with: { displayName: 'Mira Manager' } } });
    a.revisions[0].state = 'SUBMITTED';
    return [200, a];
  }
  if (method === 'GET' && path === '/v1/employees') return [200, { items: [{ ...RAVI, status: 'ACTIVE_CONFIRMED' }], total: 1 }];
  // The user's own uploads (imports/routes.ts): none unless a test says otherwise.
  if (method === 'GET' && path === '/v1/appraisal-goal-imports') return [200, { items: [], total: 0, page: 1, pageSize: 25 }];
  if (path === '/v1/appraisal-goal-imports') {
    const text = atob(String(body.contentBase64));
    const rejected = text.includes('BAD');
    return [
      201,
      {
        id: JOB,
        state: rejected ? 'REJECTED' : 'PREVIEWED',
        template: 'APPRAISAL_GOALS_V1',
        fileName: body.fileName,
        rowCount: 2,
        acceptedCount: 0,
        rejectedCount: rejected ? 2 : 0,
        rows: [
          { rowNumber: 1, businessKey: 'FY2026/SYN-002#1', state: rejected ? 'REJECTED' : 'VALID', errorCode: rejected ? 'WEIGHT_TOTAL_NOT_100' : null },
          { rowNumber: 2, businessKey: 'FY2026/SYN-002#2', state: rejected ? 'REJECTED' : 'VALID', errorCode: rejected ? 'BATCH_REJECTED' : null },
        ],
      },
    ];
  }
  if (path === `/v1/appraisal-goal-imports/${JOB}/commit`) return [200, { id: JOB, state: 'COMMITTED', fileName: 'goals.csv', rowCount: 2, acceptedCount: 2, rejectedCount: 0, rows: [] }];
  return [404, { error: 'NOT_FOUND', message: `No mock for ${method} ${path}` }];
}

function serve(overrides: Record<string, RouteReply> = {}) {
  db = {
    setting: { configured: true, cycleStartMonth: 4, version: 2 },
    cycles: [cycle(C_OPEN, 'FY2026', 'OPEN'), cycle(C_CLOSED, 'FY2025', 'CLOSED', { startDate: '2025-04-01', endDate: '2026-03-31' })],
    appraisals: new Map([
      [A_DRAFT, appraisal(A_DRAFT, RAVI)],
      [A_REVIEW, fullView()],
    ]),
    tasks: [
      { taskId: T_RATE, step: 1, stage: 'MANAGER_RATING', level: null, assignedAt: AT, appraisal: rateTaskView() },
      { taskId: T_REVIEW, step: 2, stage: 'REVIEW', level: 1, assignedAt: AT, appraisal: reviewTaskView() },
    ],
    own: new Map([[A_OWN, ownView()]]),
    keys: new Map(),
  };
  calls = [];
  holds = new Map();
  lost = new Set();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname, params: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const key = `${call.method} ${call.path}`;
      const held = holds.get(key);
      if (held) await held;
      const route = overrides[key];
      const reply = (route === undefined ? undefined : typeof route === 'function' ? route(call) : route) ?? fakeApi(call);
      if (lost.delete(key)) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(reply[1]), { status: reply[0], headers: { 'content-type': 'application/json' } });
    }),
  );
}

function hold(key: string): () => void {
  let release = () => {};
  holds.set(
    key,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  return () => {
    holds.delete(key);
    release();
  };
}

const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const bodiesTo = (method: string, path: string) => callsTo(method, path).map((c) => c.body);
const testClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

interface SessionOptions {
  assignmentId?: string;
  own?: boolean;
  client?: QueryClient;
}
function selectContext(permissions: string[], options: SessionOptions) {
  session.permissions = permissions;
  session.assignmentId = options.assignmentId ?? ASSIGNMENT_A;
  session.roleCode = options.own ? 'EMPLOYEE' : 'HR_ADMINISTRATOR';
  session.scopeKind = options.own ? 'OWN' : 'COMPANY';
}

function renderAt(entry: string, permissions: string[], options: SessionOptions = {}) {
  selectContext(permissions, options);
  return render(
    <QueryClientProvider client={options.client ?? testClient()}>
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

function renderQueue(title: string, permissions: string[], options: SessionOptions = {}) {
  selectContext(permissions, options);
  const Queue = APPRAISAL_TASK_QUEUES.find((q) => q.title === title)!.component;
  const client = options.client ?? testClient();
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Queue />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client, Queue };
}

function renderPanel(permissions: string[], options: SessionOptions = { own: true }) {
  selectContext(permissions, options);
  const Panel = APPRAISAL_ESS_PANELS[0]!.component;
  return render(
    <QueryClientProvider client={testClient()}>
      <MemoryRouter>
        <Panel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const findSection = async (heading: string) => (await screen.findByRole('heading', { name: heading })).closest('section') as HTMLElement;
const button = (scope: HTMLElement, name: string | RegExp) => within(scope).getByRole('button', { name }) as HTMLButtonElement;
const change = (scope: HTMLElement, label: string | RegExp, value: string) => fireEvent.change(within(scope).getByLabelText(label), { target: { value } });
const form = (name: string) => screen.getByRole('form', { name });
const KEY = expect.stringMatching(/^appraisal-decision-[0-9a-f-]{36}$/);
/** For waits behind a file read or the 300 ms search debounce, which take longer when the suite runs in parallel. */
// File reads and debounced searches are slow in jsdom when the whole suite runs in parallel.
const SLOW = { timeout: 10000 };
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
const alertText = (scope: HTMLElement = document.body) =>
  within(scope)
    .queryAllByRole('alert')
    .map((a) => a.textContent)
    .join(' | ');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('exports for the navigation step', () => {
  it('offers the screens, the TN18 My ESS panel and the rating and review queues', () => {
    expect(APPRAISAL_SCREENS.map((s) => [s.path, s.title, s.permission, s.nav])).toEqual([
      ['/appraisal/cycles', 'Appraisal cycles', CYCLE_READ, true],
      ['/appraisal/cycles/:id', 'Appraisal cycle', CYCLE_READ, false],
      ['/appraisal/appraisals', 'Appraisals', CYCLE_READ, true],
      ['/appraisal/appraisals/:id', 'Appraisal', READ, false],
      ['/appraisal/ratings', 'Appraisal ratings', RATE, true],
      ['/appraisal/reviews', 'Appraisal reviews', CONFIRM, true],
      ['/appraisal/reports', 'Appraisal reports', REPORT, true],
      // CL-132 (0262): the bell curve, under the confidential rating report right (appraisal-bell-curve.test.tsx).
      ['/appraisal/bell-curve', 'Bell curve', 'appraisal.report.rating', true],
      ['/appraisal/goal-upload', 'KRA upload', IMPORT, true],
      // I-86: the result split, competency master and grade mapping (Appraisal Config).
      ['/appraisal/competencies', 'Appraisal competencies', CYCLE_READ, true],
    ]);
    expect(APPRAISAL_ESS_PANELS.map((p) => p.tabId)).toEqual(['TN18']);
    expect(APPRAISAL_TASK_QUEUES.map((q) => [q.permission, q.title])).toEqual([
      [RATE, 'Appraisal ratings'],
      [CONFIRM, 'Appraisal reviews'],
    ]);
  });
});

describe('cycles (FR-040)', () => {
  it('needs appraisal_cycle.read; read-only roles see no setting or cycle forms', async () => {
    serve();
    renderAt('/appraisal/cycles', [READ]);
    expect(screen.getByRole('note').textContent).toContain('cannot view appraisal cycles');
    await settle();
    expect(calls).toHaveLength(0);
    cleanup();
    renderAt('/appraisal/cycles', [CYCLE_READ]);
    const table = await screen.findByRole('table', { name: 'Appraisal cycles' });
    expect(table.textContent).toContain('FY2026');
    expect(table.textContent).toContain('Not scheduled (entries are refused)');
    expect((await findSection('Cycle start month')).textContent).toContain('April');
    expect(screen.queryByRole('form', { name: 'Set the cycle start month' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'New cycle' })).toBeNull();
  });

  it('sets the start month with no default, then changes it against its version', async () => {
    serve();
    db.setting = { configured: false, cycleStartMonth: null, version: null, missing: ['cycleStartMonth'] };
    renderAt('/appraisal/cycles', [CYCLE_READ, CYCLE_MANAGE]);
    const section = await findSection('Cycle start month');
    await within(section).findByText(/cycles cannot be created yet/);
    const f = within(section).getByRole('form', { name: 'Set the cycle start month' });
    expect(button(f, 'Save the start month').disabled).toBe(true);
    change(f, 'Cycle start month', '4');
    fireEvent.click(button(f, 'Save the start month'));
    await within(section).findByText('Saved: cycles start on the 1st of April.');
    expect(bodiesTo('PUT', '/v1/appraisal-settings')).toEqual([{ cycleStartMonth: 4 }]);
    await within(section).findByText('April');
    change(f, 'Cycle start month', '7');
    fireEvent.click(button(f, 'Save the start month'));
    await waitFor(() => expect(bodiesTo('PUT', '/v1/appraisal-settings')[1]).toEqual({ cycleStartMonth: 7, expectedVersion: 1 }));
  });

  it('creates a cycle with its windows and levels; a misaligned start is refused in words and keeps what was typed', async () => {
    serve();
    renderAt('/appraisal/cycles', [CYCLE_READ, CYCLE_MANAGE]);
    await screen.findByRole('table', { name: 'Appraisal cycles' });
    const f = form('New cycle');
    change(f, 'Code', 'fy2027');
    change(f, 'Name', '  Synthetic FY2027 ');
    change(f, 'Start date', '2027-05-01');
    change(f, 'Reviewer levels', '2');
    change(f, 'Goal setting opens', '2027-04-01');
    // Half a window is not sent.
    fireEvent.click(button(f, 'Create the cycle'));
    expect(alertText(f)).toContain('Enter both dates of the goal setting window, or neither');
    expect(callsTo('POST', '/v1/appraisal-cycles')).toHaveLength(0);
    change(f, 'Goal setting closes', '2027-05-31');
    change(f, 'Manager rating opens', '2028-01-01');
    change(f, 'Manager rating closes', '2028-02-15');
    // With reviewer levels the review due date is required (I-77 item 5).
    fireEvent.click(button(f, 'Create the cycle'));
    expect(alertText(f)).toContain('Enter the review due date');
    expect(callsTo('POST', '/v1/appraisal-cycles')).toHaveLength(0);
    change(f, 'Review due date', '2028-02-28');
    fireEvent.click(button(f, 'Create the cycle'));
    await waitFor(() => expect(alertText(f)).toContain('A cycle starts on the 1st of April, the configured cycle start month.'));
    expect((within(f).getByLabelText('Code') as HTMLInputElement).value).toBe('fy2027');
    change(f, 'Start date', '2027-04-01');
    fireEvent.click(button(f, 'Create the cycle'));
    await screen.findByText(/Created cycle/);
    expect(bodiesTo('POST', '/v1/appraisal-cycles')[1]).toEqual({
      code: 'fy2027',
      startDate: '2027-04-01',
      name: 'Synthetic FY2027',
      approvalLevels: 2,
      windows: { goalSetting: { opensOn: '2027-04-01', closesOn: '2027-05-31' }, selfEntry: null, managerRating: { opensOn: '2028-01-01', closesOn: '2028-02-15' } },
      // I-77 defaults: goal review on, formula rating.
      goalReviewRequired: true,
      ratingMode: 'FORMULA',
      reviewDueOn: '2028-02-28',
    });
    expect(screen.getByRole('link', { name: 'FY2027' }).getAttribute('href')).toBe(`/appraisal/cycles/${C_NEW}`);
    // The form is reset after success.
    expect((within(form('New cycle')).getByLabelText('Code') as HTMLInputElement).value).toBe('');
  });

  it('a cycle changes against its version and closes only when every appraisal is finished', async () => {
    serve();
    renderAt(`/appraisal/cycles/${C_OPEN}`, [CYCLE_READ, CYCLE_MANAGE, READ, REPORT]);
    await screen.findByRole('heading', { name: 'Cycle FY2026' });
    expect(screen.getByRole('link', { name: 'Appraisals in this cycle' }).getAttribute('href')).toBe(`/appraisal/appraisals?cycleId=${C_OPEN}`);
    const f = form('Change the cycle');
    expect(within(f).queryByLabelText('Code')).toBeNull();
    change(f, 'Name', 'Synthetic renamed');
    fireEvent.click(button(f, 'Save the cycle'));
    await screen.findByText('Saved the cycle.');
    expect(bodiesTo('PUT', `/v1/appraisal-cycles/${C_OPEN}`)).toEqual([
      {
        name: 'Synthetic renamed',
        approvalLevels: 1,
        windows: { goalSetting: { opensOn: '2026-04-01', closesOn: '2026-12-31' }, selfEntry: { opensOn: '2026-05-01', closesOn: '2027-01-31' }, managerRating: null },
        goalReviewRequired: false,
        ratingMode: 'FORMULA',
        reviewDueOn: '2027-02-28',
        expectedVersion: 3,
      },
    ]);
    await screen.findByText('Synthetic renamed', { selector: 'dd' });
    fireEvent.click(button(document.body, 'Close the cycle'));
    await screen.findByText('Complete or cancel every appraisal of the cycle before closing it: 2 are still open.');
    expect(bodiesTo('POST', `/v1/appraisal-cycles/${C_OPEN}/close`)).toEqual([{ expectedVersion: 4 }]);
  });
});

describe('the register and enrolment (FR-041, FR-044)', () => {
  it('lists within scope with the filters the API offers; results appear only when the API returns them', async () => {
    serve();
    renderAt(`/appraisal/appraisals?cycleId=${C_OPEN}&state=DRAFT`, [CYCLE_READ, READ]);
    const table = await screen.findByRole('table', { name: 'Appraisal register' });
    const query = Object.fromEntries(callsTo('GET', '/v1/appraisals')[0]!.params);
    expect(query).toEqual({ cycleId: C_OPEN, state: 'DRAFT', page: '1', pageSize: '25' });
    expect(table.textContent).toContain('90 (must be 100)');
    expect(table.textContent).toContain('Final rating');
    expect(table.textContent).toContain('4.40');
    expect(screen.queryByRole('form', { name: 'Enrol an employee' })).toBeNull();
    cleanup();
    // An assignment without the rating group: the API leaves the results out, and so does the register.
    serve({ 'GET /v1/appraisals': () => [200, { items: [listRow(appraisal(A_DRAFT, RAVI)), listRow(plainView())], total: 2, page: 1, pageSize: 25 }] });
    renderAt('/appraisal/appraisals', [CYCLE_READ, READ]);
    const plain = await screen.findByRole('table', { name: 'Appraisal register' });
    expect(plain.textContent).not.toContain('Final rating');
    expect(plain.textContent).not.toContain('4.40');
  });

  it('enrols a chosen employee in an open cycle as a draft with goals, then opens it', async () => {
    serve();
    renderAt('/appraisal/appraisals', [CYCLE_READ, READ, MANAGE, EMPLOYEE_LIST]);
    const f = await screen.findByRole('form', { name: 'Enrol an employee' });
    await within(f).findByRole('option', { name: /FY2026/ });
    expect(within(f).queryByRole('option', { name: /FY2025/ })).toBeNull();
    change(f, 'Cycle', C_OPEN);
    change(f, 'Find the employee', 'Ravi');
    fireEvent.click(await within(f).findByRole('button', { name: 'Choose Ravi Synthetic (SYN-002)' }, SLOW));
    fireEvent.click(button(f, 'Add a goal'));
    fireEvent.click(button(f, 'Add a goal'));
    const g1 = within(f).getByRole('group', { name: 'Goal 1' });
    const g2 = within(f).getByRole('group', { name: 'Goal 2' });
    change(g1, 'Description', ' Synthetic delivery ');
    change(g1, 'Weight', '70');
    change(g2, 'Description', 'Synthetic learning');
    change(g2, 'Target (optional)', 'Two synthetic courses');
    change(g2, 'Weight', '20');
    expect(f.textContent).toContain('Weights entered: 90 of 100');
    fireEvent.click(button(f, 'Enrol as a draft'));
    await screen.findByRole('heading', { name: 'Appraisal of Ravi Synthetic (SYN-002)' });
    expect(bodiesTo('POST', '/v1/appraisals')).toEqual([
      {
        cycleId: C_OPEN,
        employeeId: RAVI.id,
        goals: [
          { sequence: 1, description: 'Synthetic delivery', target: null, weight: 70 },
          { sequence: 2, description: 'Synthetic learning', target: 'Two synthetic courses', weight: 20 },
        ],
      },
    ]);
    expect((await findSection('Goals')).textContent).toContain('Goal weights total 90; they must total exactly 100');
  });

  it('says enrolment refusals in words and keeps the form', async () => {
    serve({ 'POST /v1/appraisals': [409, { error: 'CYCLE_OVERLAP', message: 'x' }] });
    renderAt('/appraisal/appraisals', [CYCLE_READ, READ, MANAGE, EMPLOYEE_LIST]);
    const f = await screen.findByRole('form', { name: 'Enrol an employee' });
    await within(f).findByRole('option', { name: /FY2026/ });
    fireEvent.click(button(f, 'Enrol as a draft'));
    expect(alertText(f)).toContain('Choose an open cycle.');
    change(f, 'Cycle', C_OPEN);
    change(f, 'Find the employee', 'Ravi');
    fireEvent.click(await within(f).findByRole('button', { name: 'Choose Ravi Synthetic (SYN-002)' }, SLOW));
    fireEvent.click(button(f, 'Enrol as a draft'));
    await waitFor(() => expect(alertText(f)).toContain('The employee already has an appraisal in an overlapping cycle.'));
    expect(f.textContent).toContain('Ravi Synthetic (SYN-002)');
  });
});

describe('one appraisal (staff view)', () => {
  it('FR-043, FR-068: a decision a delegate took names the person it was taken for beside the delegate (I-57 item 7)', async () => {
    const view = fullView() as Obj & { decisions: Obj[] };
    const forRavi = { userId: U_RAVI_MANAGER, employeeCode: 'SYN-009', displayName: 'Mira Manager' };
    view.decisions = view.decisions.map((d, i) => (i === 1 ? { ...d, decidedBy: { userId: 'b9000000-0000-4000-8000-000000000009', employeeCode: 'SYN-010', displayName: 'Dev Delegate' }, onBehalfOf: forRavi } : { ...d, onBehalfOf: null }));
    serve({ [`GET /v1/appraisals/${A_REVIEW}`]: () => [200, view] });
    renderAt(`/appraisal/appraisals/${A_REVIEW}`, [CYCLE_READ, READ]);
    const history = await screen.findByRole('table', { name: 'Decision history' });
    const rows = within(history).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toContain('Mira Manager (SYN-009)');
    expect(rows[0]!.textContent).not.toContain('on behalf of');
    expect(rows[1]!.textContent).toContain('Dev Delegate (SYN-010) on behalf of Mira Manager (SYN-009)');
  });

  it('shows the confidential parts only when the API returned them', async () => {
    serve();
    renderAt(`/appraisal/appraisals/${A_REVIEW}`, [CYCLE_READ, READ]);
    await screen.findByRole('heading', { name: 'Appraisal of Meera Synthetic (SYN-003)' });
    const text = document.body.textContent!;
    expect(text).toContain('Final rating (confirmed weighted manager result)4.40');
    expect(within(screen.getByRole('group', { name: 'Revision 1' })).getByText(/Weighted manager result/).textContent).toBe('Weighted manager result: 4.40');
    expect(screen.getByRole('table', { name: 'Manager rating of revision 1' }).textContent).toContain('Synthetic manager note');
    expect(screen.getByRole('table', { name: 'Self-entry of revision 1' }).textContent).toContain('Synthetic self note');
    const history = screen.getByRole('table', { name: 'Decision history' });
    expect(history.textContent).toContain('Mira Manager (SYN-009)');
    expect(history.textContent).toContain('Synthetic private rater remark');
    expect(history.textContent).toContain('Reviewer confirmation (level 1)');
    expect(screen.getByRole('table', { name: 'Window exceptions' }).textContent).toContain('Synthetic late joiner');
    cleanup();
    serve({ [`GET /v1/appraisals/${A_REVIEW}`]: () => [200, plainView()] });
    renderAt(`/appraisal/appraisals/${A_REVIEW}`, [CYCLE_READ, READ]);
    await screen.findByRole('heading', { name: 'Appraisal of Meera Synthetic (SYN-003)' });
    const plain = document.body.textContent!;
    expect(plain).not.toMatch(/4\.40|Final rating|Weighted manager result|Private remark|Synthetic (self|manager|private|late)/);
    expect(screen.queryByRole('columnheader', { name: 'Reason' })).toBeNull();
    expect(screen.getByRole('table', { name: 'Decision history' }).textContent).toContain('Rating submitted');
  });

  it('replaces the goals of a draft against its version, with the weights shown against 100 and refusals in words', async () => {
    serve();
    renderAt(`/appraisal/appraisals/${A_DRAFT}`, [READ, MANAGE]);
    const f = await screen.findByRole('form', { name: 'Set the goals' });
    expect((await findSection('Goals')).textContent).toContain('Goal weights total 90; they must total exactly 100 before the appraisal can be submitted.');
    const g2 = within(f).getByRole('group', { name: 'Goal 2' });
    change(g2, 'Sequence', '1');
    fireEvent.click(button(f, 'Save the goals'));
    await waitFor(() => expect(alertText(f)).toContain('Each goal needs its own sequence number: 1 is used twice.'));
    change(g2, 'Sequence', '2');
    change(g2, 'Weight', '40');
    expect(f.textContent).toContain('Weights entered: 100 of 100');
    fireEvent.click(button(f, 'Save the goals'));
    await screen.findByText('Saved 2 goals; the weights total 100.');
    expect(bodiesTo('PUT', `/v1/appraisals/${A_DRAFT}/goals`)[1]).toEqual({
      goals: [
        { sequence: 1, description: 'Synthetic goal 1', target: null, weight: 60 },
        { sequence: 2, description: 'Synthetic goal 2', target: null, weight: 40 },
      ],
      expectedVersion: 4,
    });
    await waitFor(() => expect((screen.getByRole('heading', { name: 'Goals' }).closest('section') as HTMLElement).textContent).toContain('Goal weights total 100.'));
  });

  it('records a window exception and cancels with a reason; each form needs its own key', async () => {
    serve();
    renderAt(`/appraisal/appraisals/${A_DRAFT}`, [READ]);
    await screen.findByRole('heading', { name: 'Appraisal of Ravi Synthetic (SYN-002)' });
    expect(screen.queryByRole('form', { name: 'Set the goals' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Record a window exception' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Cancel the appraisal' })).toBeNull();
    cleanup();
    renderAt(`/appraisal/appraisals/${A_DRAFT}`, [READ, GRANT_EXCEPTION, CANCEL]);
    const x = await screen.findByRole('form', { name: 'Record a window exception' });
    change(x, 'Stage', 'SELF_ENTRY');
    change(x, 'Valid through', '2026-10-01');
    change(x, 'Reason (confidential)', 'Synthetic medical leave');
    fireEvent.click(button(x, 'Record the exception'));
    await waitFor(() => expect(alertText(x)).toContain('An exception is valid through today or a later date.'));
    change(x, 'Valid through', '2026-11-30');
    fireEvent.click(button(x, 'Record the exception'));
    await screen.findByText('Recorded an exception: self-entry entries are accepted through 2026-11-30.');
    expect(bodiesTo('POST', `/v1/appraisals/${A_DRAFT}/window-exceptions`)[1]).toEqual({ stage: 'SELF_ENTRY', validUntil: '2026-11-30', reason: 'Synthetic medical leave' });
    expect((within(x).getByLabelText('Reason (confidential)') as HTMLTextAreaElement).value).toBe('');
    await within(await screen.findByRole('table', { name: 'Window exceptions' })).findByText('Synthetic medical leave');
    const c = form('Cancel the appraisal');
    fireEvent.click(button(c, 'Cancel the appraisal'));
    expect(alertText(c)).toContain('Enter the reason for cancelling.');
    change(c, 'Reason for cancelling (confidential)', 'Synthetic leaver');
    fireEvent.click(button(c, 'Cancel the appraisal'));
    await screen.findByText('Cancelled the appraisal. It and its history are kept.');
    expect(bodiesTo('POST', `/v1/appraisals/${A_DRAFT}/cancel`)).toEqual([{ reason: 'Synthetic leaver', expectedVersion: 5 }]);
  });
});

describe('the rating queue (FR-043 step 1)', () => {
  it('saves only the changed scores against the version, then submits the saved rating with an idempotency key', async () => {
    serve();
    renderQueue('Appraisal ratings', [READ, RATE]);
    const item = await screen.findByRole('listitem', { name: 'Ravi Synthetic (SYN-002) · FY2026' });
    expect(screen.queryByRole('listitem', { name: /Meera/ })).toBeNull();
    expect(within(item).getByRole('table', { name: 'Self-entry of Ravi Synthetic (SYN-002)' }).textContent).toContain('Synthetic self note');
    const f = within(item).getByRole('form', { name: 'Rating of Ravi Synthetic (SYN-002)' });
    const g1 = within(f).getByRole('group', { name: 'Goal 1' });
    change(g1, 'Score (1 to 5)', '4');
    change(g1, 'Comment on goal 1 (optional)', ' Synthetic strong delivery ');
    // An unsaved rating is not submitted.
    fireEvent.click(button(item, 'Submit the rating'));
    expect(alertText(item)).toContain('Save the scores first');
    expect(callsTo('POST', `/v1/appraisal-tasks/${T_RATE}/decision`)).toHaveLength(0);
    fireEvent.click(button(f, 'Save the scores'));
    await within(item).findByText('Scores saved.');
    expect(bodiesTo('PUT', `/v1/appraisal-tasks/${T_RATE}/rating`)).toEqual([{ entries: [{ goalId: G(1), score: 4, comment: 'Synthetic strong delivery' }], expectedVersion: 5 }]);
    // Submitting with a goal unscored: the API's refusal in words.
    fireEvent.click(button(item, 'Submit the rating'));
    await waitFor(() => expect(alertText(item)).toContain('Score every goal and save before submitting the rating: goal 2 has no saved score.'));
    const g2 = within(within(item).getByRole('form', { name: /Rating of/ })).getByRole('group', { name: 'Goal 2' });
    change(g2, 'Score (1 to 5)', '5');
    fireEvent.click(button(within(item).getByRole('form', { name: /Rating of/ }), 'Save the scores'));
    await waitFor(() => expect(bodiesTo('PUT', `/v1/appraisal-tasks/${T_RATE}/rating`)[1]).toEqual({ entries: [{ goalId: G(2), score: 5, comment: null }], expectedVersion: 6 }));
    await within(item).findByText('Scores saved.');
    const release = hold(`POST /v1/appraisal-tasks/${T_RATE}/decision`);
    change(item, 'Private remark (optional; never shown to the employee)', 'Synthetic private rater remark');
    fireEvent.click(button(item, 'Submit the rating'));
    await waitFor(() => expect(button(item, 'Submit the rating').disabled).toBe(true));
    expect(button(item, 'Return to the employee').disabled).toBe(true);
    release();
    await screen.findByText('Submitted the rating of Ravi Synthetic (SYN-002). It now waits for the independent reviewer confirmation.');
    const decisions = bodiesTo('POST', `/v1/appraisal-tasks/${T_RATE}/decision`);
    expect(decisions.at(-1)).toEqual({ decision: 'APPROVE', idempotencyKey: KEY, reason: 'Synthetic private rater remark' });
    expect(decisions[0]!.idempotencyKey).not.toBe(decisions.at(-1)!.idempotencyKey);
    expect(screen.queryByRole('listitem', { name: /Ravi/ })).toBeNull();
  });

  it('returns with a message to the employee, resending the same key after a lost answer', async () => {
    serve();
    renderQueue('Appraisal ratings', [READ, RATE]);
    const item = await screen.findByRole('listitem', { name: 'Ravi Synthetic (SYN-002) · FY2026' });
    fireEvent.click(button(item, 'Return to the employee'));
    expect(alertText(item)).toContain('Tell the employee what to revise before returning the appraisal.');
    expect(callsTo('POST', `/v1/appraisal-tasks/${T_RATE}/decision`)).toHaveLength(0);
    change(item, 'Message to the employee (required to return)', 'Synthetic: add evidence');
    lost.add(`POST /v1/appraisal-tasks/${T_RATE}/decision`);
    fireEvent.click(button(item, 'Return to the employee'));
    await waitFor(() => expect(alertText(item)).toContain('No answer came back, so your decision may or may not have been recorded.'));
    fireEvent.click(button(item, 'Return to the employee'));
    await screen.findByText(/had already been recorded, so nothing was applied twice/);
    const sent = bodiesTo('POST', `/v1/appraisal-tasks/${T_RATE}/decision`);
    expect(sent).toEqual([
      { decision: 'RETURN', idempotencyKey: KEY, employeeMessage: 'Synthetic: add evidence' },
      { decision: 'RETURN', idempotencyKey: sent[0]!.idempotencyKey, employeeMessage: 'Synthetic: add evidence' },
    ]);
  });

  it('a role without the rating duty is told so; tasks of one assignment are not shown under another', async () => {
    serve();
    const client = testClient();
    const first = renderQueue('Appraisal ratings', [READ], { client });
    const item = await screen.findByRole('listitem', { name: 'Ravi Synthetic (SYN-002) · FY2026' });
    expect(item.textContent).toContain('The selected role cannot rate appraisals.');
    expect(within(item).queryByRole('button', { name: 'Submit the rating' })).toBeNull();
    first.unmount();
    serve({ 'GET /v1/appraisal-tasks/mine': [200, { items: [] }] });
    renderQueue('Appraisal ratings', [READ, RATE], { client, assignmentId: ASSIGNMENT_B });
    await screen.findByText('No appraisals are waiting for your rating.');
    expect(screen.queryByText(/Ravi/)).toBeNull();
  });

  it('the decision duty without a read key lists nothing and asks for nothing', async () => {
    serve();
    renderQueue('Appraisal ratings', [RATE]);
    expect(screen.getByRole('note').textContent).toContain('cannot read appraisals');
    cleanup();
    renderQueue('Appraisal reviews', [CONFIRM]);
    expect(screen.getByRole('note').textContent).toContain('cannot read appraisals');
    await settle();
    expect(calls).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/Ravi|Meera/);
  });
});

describe('the review queue (FR-043 step 2, C4)', () => {
  it('shows the weighted manager result exactly as returned and confirms the rating', async () => {
    serve();
    renderQueue('Appraisal reviews', [READ, CONFIRM]);
    const item = await screen.findByRole('listitem', { name: 'Meera Synthetic (SYN-003) · FY2026' });
    expect(item.textContent).toContain('Reviewer confirmation (level 1)');
    expect(within(item).getByText(/Weighted manager result/).textContent).toBe('Weighted manager result: 4.40');
    expect(within(item).queryByRole('form')).toBeNull();
    // FR-043 / DF04 (I-77 item 1): a confirmation carries the reviewer's overall score.
    fireEvent.click(button(item, 'Confirm the rating'));
    expect(alertText(item)).toContain('Choose your overall score (1 to 5) to confirm the rating.');
    expect(callsTo('POST', `/v1/appraisal-tasks/${T_REVIEW}/decision`)).toHaveLength(0);
    change(item, /Your overall score/, '4');
    fireEvent.click(button(item, 'Confirm the rating'));
    await screen.findByText('Confirmed the rating of Meera Synthetic (SYN-003): the appraisal is complete.');
    expect(bodiesTo('POST', `/v1/appraisal-tasks/${T_REVIEW}/decision`)).toEqual([{ decision: 'APPROVE', idempotencyKey: KEY, reviewerScore: 4 }]);
  });

  it('shows no rating content the API left out', async () => {
    const view = reviewTaskView();
    view.revisions = [{ revision: 1, state: 'RATED', submittedAt: AT, returnedAt: null, confirmedAt: null, ratedAt: AT, approvalLevels: 1 }];
    serve({ 'GET /v1/appraisal-tasks/mine': [200, { items: [{ taskId: T_REVIEW, step: 2, stage: 'REVIEW', level: 1, assignedAt: AT, appraisal: view }] }] });
    renderQueue('Appraisal reviews', [READ, CONFIRM]);
    const item = await screen.findByRole('listitem', { name: 'Meera Synthetic (SYN-003) · FY2026' });
    expect(item.textContent).toContain('The manager’s rating is confidential and not shown to the selected role.');
    expect(item.textContent).not.toMatch(/4\.40|Weighted manager result|Synthetic (self|manager)/);
  });
});

describe('reports and export (FR-044)', () => {
  it('reports counts by state and the exact rating distribution; the export refusal is said in words', async () => {
    serve();
    renderAt('/appraisal/reports', [CYCLE_READ, REPORT, EXPORT]);
    const s = await findSection('Appraisal reports');
    await within(s).findByRole('option', { name: /FY2026/ });
    change(s, 'Cycle', C_OPEN);
    const byState = await screen.findByRole('table', { name: 'Appraisals by state' });
    expect(byState.textContent).toContain('Approved2');
    expect(screen.getByText(/Your own appraisal is never included/)).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Final rating distribution' }).textContent).toBe('Final ratingAppraisals3.0014.101');
    fireEvent.click(screen.getByRole('button', { name: 'Export as CSV' }));
    await screen.findByText('An export holds at most 10,000 rows; narrow it with the department filter. Nothing was cut off.');
    expect(callsTo('GET', `/v1/appraisal-cycles/${C_OPEN}/export`)).toHaveLength(1);
  });

  it('shows no distribution the API left out and no export without its key', async () => {
    serve({
      [`GET /v1/appraisal-cycles/${C_OPEN}/report`]: () => {
        const r = fakeApi({ method: 'GET', path: `/v1/appraisal-cycles/${C_OPEN}/report`, params: new URLSearchParams(), body: undefined })[1] as Obj;
        delete r.ratings;
        return [200, r];
      },
    });
    renderAt(`/appraisal/cycles/${C_OPEN}`, [CYCLE_READ, REPORT]);
    await screen.findByRole('table', { name: 'Appraisals by state' });
    expect(screen.queryByRole('table', { name: 'Final rating distribution' })).toBeNull();
    expect(document.body.textContent).not.toContain('4.10');
    expect(screen.queryByRole('button', { name: 'Export as CSV' })).toBeNull();
  });
});

describe('the KRA upload (FR-041: DRAFT only)', () => {
  it('needs the import and goal-setting duties; a rejected file lists its row problems in words', async () => {
    serve();
    renderAt('/appraisal/goal-upload', [IMPORT]);
    expect(screen.getByRole('note').textContent).toContain('needs both the appraisal import duty and the goal-setting duty');
    cleanup();
    renderAt('/appraisal/goal-upload', [IMPORT, MANAGE]);
    const f = form('Upload goals');
    const file = new File(['cycleCode,employeeCode,sequence,description,target,weight\nFY2026,SYN-002,1,BAD,,50\n'], 'goals.csv', { type: 'text/csv' });
    fireEvent.change(within(f).getByLabelText('Goal file (CSV)'), { target: { files: [file] } });
    fireEvent.click(button(f, 'Upload and preview'));
    const rows = await screen.findByRole('table', { name: 'Upload rows' }, SLOW);
    expect(rows.textContent).toContain('This employee’s goal weights in the file do not total exactly 100.');
    expect(rows.textContent).toContain('Not applied, because another row of the file has a problem (all or nothing).');
    expect(screen.queryByRole('button', { name: /Commit/ })).toBeNull();
    const body = bodiesTo('POST', '/v1/appraisal-goal-imports')[0]!;
    expect(body).toEqual({ fileName: 'goals.csv', contentBase64: expect.any(String), idempotencyKey: expect.stringMatching(/^appraisal-goals-[0-9a-f-]{36}$/) });
    expect(atob(body.contentBase64)).toContain('FY2026,SYN-002,1,BAD');
  });

  it('downloads the published APPRAISAL_GOALS_V1 template (DF09) beside the column list', async () => {
    // jsdom has no object URLs: a downloaded file is "saved" through a click on a link to one, counted here.
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn(() => 'blob:synthetic-template');
    URL.revokeObjectURL = vi.fn();
    const saved = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      serve({ 'GET /v1/appraisal-goal-imports/template': [200, 'cycleCode,employeeCode,sequence,description,target,weight'] });
      renderAt('/appraisal/goal-upload', [IMPORT, MANAGE]);
      expect(screen.getByText('cycleCode,employeeCode,sequence,description,target,weight', { selector: 'code' })).toBeTruthy();
      expect(screen.getByText('APPRAISAL_GOALS_V1.csv: the header line only, ready to fill in.')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Download the template' }));
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(1), SLOW);
      expect(callsTo('GET', '/v1/appraisal-goal-imports/template')).toHaveLength(1);
      expect(callsTo('POST', '/v1/appraisal-goal-imports')).toHaveLength(0);
    } finally {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
      saved.mockRestore();
    }
  });

  it('commits a previewed file into draft appraisals', async () => {
    serve();
    renderAt('/appraisal/goal-upload', [IMPORT, MANAGE]);
    const f = form('Upload goals');
    const file = new File(['cycleCode,employeeCode,sequence,description,target,weight\nFY2026,SYN-002,1,Synthetic goal,,100\n'], 'goals.csv', { type: 'text/csv' });
    fireEvent.change(within(f).getByLabelText('Goal file (CSV)'), { target: { files: [file] } });
    fireEvent.click(button(f, 'Upload and preview'));
    // The button appears while the upload is still settling (disabled); a click then would be ignored.
    const commit = (await screen.findByRole('button', { name: 'Commit: create the draft appraisals' }, SLOW)) as HTMLButtonElement;
    await waitFor(() => expect(commit.disabled).toBe(false), SLOW);
    fireEvent.click(commit);
    await screen.findByText('Applied 2 rows: the draft appraisals were created with their goals. Nothing was submitted, rated or approved.', {}, SLOW);
    expect(callsTo('POST', `/v1/appraisal-goal-imports/${JOB}/commit`)).toHaveLength(1);
  });

  it('a commit answered with the rejected job reports that nothing was applied', async () => {
    serve({
      [`POST /v1/appraisal-goal-imports/${JOB}/commit`]: [
        200,
        {
          id: JOB,
          state: 'REJECTED',
          fileName: 'goals.csv',
          rowCount: 2,
          acceptedCount: 0,
          rejectedCount: 2,
          rows: [
            { rowNumber: 1, businessKey: 'FY2026/SYN-002#1', state: 'REJECTED', errorCode: 'APPRAISAL_EXISTS' },
            { rowNumber: 2, businessKey: 'FY2026/SYN-002#2', state: 'REJECTED', errorCode: 'BATCH_REJECTED' },
          ],
        },
      ],
    });
    renderAt('/appraisal/goal-upload', [IMPORT, MANAGE]);
    const f = form('Upload goals');
    const file = new File(['cycleCode,employeeCode,sequence,description,target,weight\nFY2026,SYN-002,1,Synthetic goal,,100\n'], 'goals.csv', { type: 'text/csv' });
    fireEvent.change(within(f).getByLabelText('Goal file (CSV)'), { target: { files: [file] } });
    fireEvent.click(button(f, 'Upload and preview'));
    const commit = (await screen.findByRole('button', { name: 'Commit: create the draft appraisals' }, SLOW)) as HTMLButtonElement;
    await waitFor(() => expect(commit.disabled).toBe(false), SLOW);
    fireEvent.click(commit);
    await screen.findByText(/Nothing was applied: a row failed when the upload was committed/, {}, SLOW);
    expect(document.body.textContent).not.toContain('the draft appraisals were created');
    expect(screen.getByRole('table', { name: 'Upload rows' }).textContent).toContain('The employee already has an appraisal in this cycle; an upload only creates new ones.');
  });

  /** A goal file the malware scan has not released yet: held, nothing read (FR-106). */
  const HELD_JOB = { id: JOB, state: 'UPLOADED', template: 'APPRAISAL_GOALS_V1', fileName: 'held-goals.csv', rowCount: null, acceptedCount: 0, rejectedCount: 0, scanState: 'PENDING_SCAN', rows: [] };
  const PREVIEWED_JOB = {
    ...HELD_JOB,
    state: 'PREVIEWED',
    rowCount: 1,
    scanState: 'CLEAN',
    rows: [{ rowNumber: 1, businessKey: 'FY2026/SYN-002#1', state: 'VALID', errorCode: null }],
  };
  const pressWhenReady = async (name: string) => {
    const b = (await screen.findByRole('button', { name }, SLOW)) as HTMLButtonElement;
    await waitFor(() => expect(b.disabled).toBe(false), SLOW);
    fireEvent.click(b);
  };

  it('a held goal file is checked again from its stored file, without a second upload, and previewed once released', async () => {
    let resumes = 0;
    serve({
      'POST /v1/appraisal-goal-imports': [202, HELD_JOB],
      [`POST /v1/appraisal-goal-imports/${JOB}/resume`]: () => {
        resumes += 1;
        return resumes === 1 ? [202, HELD_JOB] : [200, PREVIEWED_JOB];
      },
    });
    renderAt('/appraisal/goal-upload', [IMPORT, MANAGE]);
    const f = form('Upload goals');
    fireEvent.change(within(f).getByLabelText('Goal file (CSV)'), { target: { files: [new File(['cycleCode,employeeCode,sequence,description,target,weight\nFY2026,SYN-002,1,Synthetic goal,,100\n'], 'held-goals.csv', { type: 'text/csv' })] } });
    fireEvent.click(button(f, 'Upload and preview'));
    expect(await screen.findByText(/waiting for the malware scan, so nothing in it has been read yet/, {}, SLOW)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Commit/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Discard the upload' })).toBeTruthy();
    await pressWhenReady('Check the scan again');
    expect(await screen.findByText('Still waiting for the malware scan.', {}, SLOW)).toBeTruthy();
    await pressWhenReady('Check the scan again');
    expect(await screen.findByRole('button', { name: 'Commit: create the draft appraisals' }, SLOW)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check the scan again' })).toBeNull();
    expect(callsTo('POST', '/v1/appraisal-goal-imports')).toHaveLength(1);
    expect(bodiesTo('POST', `/v1/appraisal-goal-imports/${JOB}/resume`)).toEqual([undefined, undefined]);
  });

  it('lists the user’s own uploads; a held one is opened again, and one the scan quarantines is refused in words', async () => {
    // GET /v1/appraisal-goal-imports: job facts only.
    const heldFacts: Record<string, unknown> = { ...HELD_JOB, createdAt: AT, updatedAt: AT };
    delete heldFacts.rows;
    serve({
      'GET /v1/appraisal-goal-imports': [200, { items: [heldFacts], total: 1, page: 1, pageSize: 25 }],
      [`GET /v1/appraisal-goal-imports/${JOB}`]: [200, HELD_JOB],
      [`POST /v1/appraisal-goal-imports/${JOB}/resume`]: [422, { error: 'FILE_QUARANTINED', message: 'The malware scan flagged the file; nothing was read or imported' }],
    });
    renderAt('/appraisal/goal-upload', [IMPORT, MANAGE]);
    const list = await screen.findByRole('table', { name: 'Your KRA uploads' }, SLOW);
    const row = within(list).getByText('held-goals.csv').closest('tr')!;
    expect(row.textContent).toContain('waiting for the scan');
    expect(callsTo('GET', '/v1/appraisal-goal-imports')[0]!.params.toString()).toBe('page=1&pageSize=25');
    fireEvent.click(within(row).getByRole('button', { name: /^Open held-goals.csv/ }));
    expect(await screen.findByText(/waiting for the malware scan, so nothing in it has been read yet/, {}, SLOW)).toBeTruthy();
    await pressWhenReady('Check the scan again');
    expect((await screen.findByRole('alert', {}, SLOW)).textContent).toBe('The malware scan flagged this file, so nothing in it was read or applied. Upload a clean copy of the file.');
    expect(screen.queryByRole('button', { name: 'Check the scan again' })).toBeNull();
    expect(callsTo('POST', '/v1/appraisal-goal-imports')).toEqual([]);
  });
});

describe('My ESS TN18 (Employee OWN context)', () => {
  it('is offered only in the Employee OWN context', async () => {
    serve();
    renderPanel(EMPLOYEE, { own: false });
    expect(document.body.textContent).toContain('Your own appraisal is shown in your Employee role.');
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('shows own goals and status with no manager or reviewer content, saves the self-entry and submits it', async () => {
    serve();
    renderPanel(EMPLOYEE);
    const goals = await screen.findByRole('table', { name: 'My goals' });
    expect(goals.textContent).toContain('Synthetic goal 1');
    expect(goals.textContent).toContain('Entered');
    expect(goals.textContent).not.toContain('Manager rating');
    expect(document.body.textContent).not.toMatch(/Weighted manager result|Private remark|Final rating|Published result/);
    const f = screen.getByRole('form', { name: 'My self-assessment' });
    const g1 = within(f).getByRole('group', { name: 'Goal 1' });
    expect((within(g1).getByLabelText('Score (1 to 5)') as HTMLSelectElement).value).toBe('4');
    expect((within(g1).getByLabelText('Comment on goal 1 (optional)') as HTMLTextAreaElement).value).toBe('Synthetic own note');
    change(within(f).getByRole('group', { name: 'Goal 2' }), 'Score (1 to 5)', '3');
    change(f, 'Overall comment (optional)', 'Synthetic year summary');
    expect(button(document.body, 'Submit my self-assessment').disabled).toBe(true);
    fireEvent.click(button(f, 'Save my self-assessment'));
    await screen.findByText('Self-entry saved. Submit it when every goal has a score.');
    expect(bodiesTo('PUT', `/v1/me/appraisals/${A_OWN}/self-entry`)).toEqual([{ entries: [{ goalId: G(2), score: 3, comment: null }], comment: 'Synthetic year summary', expectedVersion: 4 }]);
    await waitFor(() => expect(button(document.body, 'Submit my self-assessment').disabled).toBe(false));
    fireEvent.click(button(document.body, 'Submit my self-assessment'));
    await screen.findByText(
      'The goal weights total 90; they must total exactly 100 before the appraisal can be submitted. Ask HR or your manager to correct the goals.',
    );
    expect(bodiesTo('POST', `/v1/me/appraisals/${A_OWN}/submit`)).toEqual([{ expectedVersion: 5 }]);
    // Once HR has corrected the goals the submission goes through.
    db.own.get(A_OWN)!.goalWeightTotal = 100;
    fireEvent.click(button(document.body, 'Submit my self-assessment'));
    await screen.findByText('Submitted. It now waits for the manager rating by Mira Manager.');
  });

  it('shows the return message, refuses entry outside the window and publishes no result', async () => {
    serve();
    db.own.set(
      A_OWN,
      ownView({
        state: 'RETURNED',
        revision: 2,
        windows: { goalSetting: win(false), selfEntry: win(false, { opensOn: '2026-05-01', closesOn: '2026-06-30' }), managerRating: win(false) },
        revisions: [
          { revision: 1, state: 'RETURNED', submittedAt: AT, returnedAt: AT, confirmedAt: null, employeeMessage: 'Synthetic: add evidence', selfEntry: { comment: null, entries: [entry(1, 2)] } },
          { revision: 2, state: 'DRAFT', submittedAt: null, returnedAt: null, confirmedAt: null, employeeMessage: null, selfEntry: { comment: null, entries: [entry(1, 2)] } },
        ],
      }),
    );
    renderPanel(EMPLOYEE);
    await screen.findByText(/Synthetic: add evidence/);
    expect(document.body.textContent).toContain('The self-entry window is not open today (2026-05-01 to 2026-06-30)');
    expect(screen.queryByRole('form', { name: 'My self-assessment' })).toBeNull();
    expect(screen.getByRole('table', { name: 'My self-entry of revision 1' })).toBeTruthy();
    cleanup();
    serve();
    db.own.set(A_OWN, ownView({ state: 'APPROVED', taskStatus: 'COMPLETED', revisions: [{ revision: 1, state: 'CONFIRMED', submittedAt: AT, returnedAt: null, confirmedAt: AT, employeeMessage: null }] }));
    renderPanel(EMPLOYEE);
    await screen.findByText('Your appraisal is complete. No result is published to employees.');
    expect(document.body.textContent).not.toContain('Published result');
  });

  it('without the self-assessment duty the entry form is not offered', async () => {
    serve();
    renderPanel([READ, READ_SELF]);
    await screen.findByRole('table', { name: 'My goals' });
    expect(screen.queryByRole('form', { name: 'My self-assessment' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit my self-assessment' })).toBeNull();
  });
});

// Process rules decided under owner delegation, 6 Nov 2026 (owner chose process rules only; I-77).
describe('process rules decided under owner delegation (I-77)', () => {
  const GOAL_REVIEW_LABEL = /Goals are reviewed before they take effect/;

  it('BR-013 / FR-042 / FR-041: a new cycle reviews goals by formula by default, and may instead have no reviewer level, manual rating and no goal review', async () => {
    serve();
    renderAt('/appraisal/cycles', [CYCLE_READ, CYCLE_MANAGE]);
    await screen.findByRole('table', { name: 'Appraisal cycles' });
    const f = form('New cycle');
    expect((within(f).getByLabelText(GOAL_REVIEW_LABEL) as HTMLInputElement).checked).toBe(true);
    expect((within(f).getByLabelText('Rating mode') as HTMLSelectElement).value).toBe('FORMULA');
    change(f, 'Code', 'fy2027');
    change(f, 'Name', 'Synthetic one level');
    change(f, 'Start date', '2027-04-01');
    // BR-013 one-level manager review: no reviewer, so no review due date is asked for or sent.
    change(f, 'Reviewer levels', '0');
    expect(within(f).queryByLabelText('Review due date')).toBeNull();
    change(f, 'Rating mode', 'MANUAL');
    fireEvent.click(within(f).getByLabelText(GOAL_REVIEW_LABEL));
    fireEvent.click(button(f, 'Create the cycle'));
    await screen.findByText(/Created cycle/);
    expect(bodiesTo('POST', '/v1/appraisal-cycles')).toEqual([
      {
        code: 'fy2027',
        startDate: '2027-04-01',
        name: 'Synthetic one level',
        approvalLevels: 0,
        windows: { goalSetting: null, selfEntry: null, managerRating: null },
        goalReviewRequired: false,
        ratingMode: 'MANUAL',
        reviewDueOn: null,
      },
    ]);
  });

  it('a cycle shows its review due date, goal review and rating mode; a refused rule change is said in words', async () => {
    serve({ [`PUT /v1/appraisal-cycles/${C_OPEN}`]: [409, { error: 'RULES_FIXED', message: 'x' }] });
    renderAt(`/appraisal/cycles/${C_OPEN}`, [CYCLE_READ, CYCLE_MANAGE]);
    await screen.findByRole('heading', { name: 'Cycle FY2026' });
    const text = document.body.textContent!;
    expect(text).toContain('Review due date2027-02-28');
    expect(text).toContain('Goal reviewNone: goals take effect when set');
    expect(text).toContain('Rating modeFormula (the weighted manager result is the final rating)');
    const f = form('Change the cycle');
    change(f, 'Rating mode', 'MANUAL');
    fireEvent.click(button(f, 'Save the cycle'));
    await waitFor(() => expect(alertText(f)).toContain('The goal review and the rating mode cannot change once an appraisal of this cycle has been submitted.'));
    expect(bodiesTo('PUT', `/v1/appraisal-cycles/${C_OPEN}`)[0]).toMatchObject({ ratingMode: 'MANUAL', goalReviewRequired: false, reviewDueOn: '2027-02-28' });
  });

  it('FR-041 KRA review: another user reviews the goals against the version; the setter is told someone else does; refusals in words', async () => {
    let reviewed = false;
    const view = (setBy: string) =>
      appraisal(A_DRAFT, RAVI, {
        cycle: { ...appraisal(A_DRAFT, RAVI).cycle, goalReviewRequired: true },
        goals: [goal(1, 60), goal(2, 40)],
        goalWeightTotal: 100,
        taskStatus: reviewed ? 'AWAITING_SELF_ENTRY' : 'AWAITING_GOAL_REVIEW',
        goalReview: {
          required: true,
          reviewed,
          reviewedAt: reviewed ? AT : null,
          setBy: { userId: setBy, employeeCode: 'SYN-009', displayName: 'Mira Manager' },
          setAt: AT,
          reviewedBy: reviewed ? { userId: session.userId, employeeCode: 'SYN-001', displayName: 'Asha Synthetic' } : null,
        },
      });
    let attempts = 0;
    serve({
      [`GET /v1/appraisals/${A_DRAFT}`]: () => [200, view(U_RAVI_MANAGER)],
      [`POST /v1/appraisals/${A_DRAFT}/goal-review`]: () => {
        attempts += 1;
        if (attempts === 1) return [409, { error: 'GOALS_ALREADY_REVIEWED', message: 'x' }];
        reviewed = true;
        return [200, view(U_RAVI_MANAGER)];
      },
    });
    renderAt(`/appraisal/appraisals/${A_DRAFT}`, [READ, MANAGE]);
    const block = await screen.findByRole('group', { name: 'Goal review' });
    expect(block.textContent).toContain('Waiting: the goals take effect once someone other than their setter reviews them');
    expect(block.textContent).toContain('Goals set byMira Manager (SYN-009)');
    expect(document.body.textContent).toContain('Waiting for the goal review');
    fireEvent.click(button(block, 'Review the goals'));
    await waitFor(() => expect(alertText(block)).toContain('These goals have already been reviewed.'));
    fireEvent.click(button(block, 'Review the goals'));
    await screen.findByText('Reviewed the goals: they have taken effect, and the employee can enter the self-entry.');
    expect(bodiesTo('POST', `/v1/appraisals/${A_DRAFT}/goal-review`)).toEqual([{ expectedVersion: 4 }, { expectedVersion: 4 }]);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Goal review' }).textContent).toContain('Goals reviewed byYou'));
    cleanup();
    // The setter is not offered the review.
    reviewed = false;
    serve({ [`GET /v1/appraisals/${A_DRAFT}`]: () => [200, view(session.userId)] });
    renderAt(`/appraisal/appraisals/${A_DRAFT}`, [READ, MANAGE]);
    const mine = await screen.findByRole('group', { name: 'Goal review' });
    expect(mine.textContent).toContain('You set these goals, so someone else reviews them.');
    expect(within(mine).queryByRole('button', { name: 'Review the goals' })).toBeNull();
  });

  it('FR-041: the register filters complete goal sets waiting for their review', async () => {
    serve();
    renderAt('/appraisal/appraisals', [CYCLE_READ, READ]);
    await screen.findByRole('table', { name: 'Appraisal register' });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'AWAITING_GOAL_REVIEW' } });
    await waitFor(() => expect(Object.fromEntries(callsTo('GET', '/v1/appraisals').at(-1)!.params)).toEqual({ stateGroup: 'AWAITING_GOAL_REVIEW', page: '1', pageSize: '25' }));
  });

  it('FR-042 manual mode and I-40 item 6: the rater saves an overall rating; each task shows its due date and whether it is overdue', async () => {
    serve();
    const manual = rateTaskView();
    manual.cycle = { ...manual.cycle, ratingMode: 'MANUAL' };
    manual.revisions[0].managerRating.overallRating = null;
    Object.assign(db.tasks[0]!, { appraisal: manual, dueOn: '2026-10-01', overdue: true });
    renderQueue('Appraisal ratings', [READ, RATE]);
    const item = await screen.findByRole('listitem', { name: 'Ravi Synthetic (SYN-002) · FY2026' });
    expect(item.textContent).toContain('due 2026-10-01');
    expect(within(item).getByText('overdue')).toBeTruthy();
    const f = within(item).getByRole('form', { name: 'Rating of Ravi Synthetic (SYN-002)' });
    change(f, 'Overall rating (1 to 5)', '5');
    fireEvent.click(button(f, 'Save the scores'));
    await within(item).findByText('Scores saved.');
    expect(bodiesTo('PUT', `/v1/appraisal-tasks/${T_RATE}/rating`)).toEqual([{ entries: [], overallRating: 5, expectedVersion: 5 }]);
    cleanup();
    // A formula cycle offers no overall rating; a task with no scheduled date says so and is not overdue.
    serve();
    renderQueue('Appraisal reviews', [READ, CONFIRM]);
    const review = await screen.findByRole('listitem', { name: 'Meera Synthetic (SYN-003) · FY2026' });
    expect(review.textContent).toContain('no due date');
    expect(within(review).queryByText('overdue')).toBeNull();
    expect(review.textContent).not.toContain('Overall rating of the manager');
  });

  it('BR-013: a rating in a cycle without reviewer levels completes the appraisal, and the rater is told so', async () => {
    serve({ [`POST /v1/appraisal-tasks/${T_RATE}/decision`]: [200, { appraisalId: A_RATE, state: 'APPROVED', revision: 1, replayed: false }] });
    renderQueue('Appraisal ratings', [READ, RATE]);
    const item = await screen.findByRole('listitem', { name: 'Ravi Synthetic (SYN-002) · FY2026' });
    fireEvent.click(button(item, 'Submit the rating'));
    await screen.findByText('Submitted the rating of Ravi Synthetic (SYN-002): this cycle has no reviewer level, so the appraisal is complete.');
  });

  it('FR-043 / FR-042: reviewer scores and the manual overall rating show only as the API returned them', async () => {
    const manual = fullView();
    manual.cycle = { ...manual.cycle, ratingMode: 'MANUAL' };
    manual.revisions[0].managerRating.overallRating = 5;
    manual.revisions[0].reviewerScores = [{ level: 1, score: 3, scoredAt: AT }];
    manual.finalRating = '5.00';
    serve({ [`GET /v1/appraisals/${A_REVIEW}`]: () => [200, manual] });
    renderAt(`/appraisal/appraisals/${A_REVIEW}`, [CYCLE_READ, READ]);
    await screen.findByRole('heading', { name: 'Appraisal of Meera Synthetic (SYN-003)' });
    expect(document.body.textContent).toContain('Final rating (confirmed overall rating of the manager)5.00');
    const revision = screen.getByRole('group', { name: 'Revision 1' });
    expect(revision.textContent).toContain('Overall rating of the manager (the final rating in this cycle): 5');
    expect(screen.getByRole('list', { name: 'Reviewer scores of revision 1' }).textContent).toContain('Level 1: 3');
    cleanup();
    serve({ [`GET /v1/appraisals/${A_REVIEW}`]: () => [200, plainView()] });
    renderAt(`/appraisal/appraisals/${A_REVIEW}`, [CYCLE_READ, READ]);
    await screen.findByRole('heading', { name: 'Appraisal of Meera Synthetic (SYN-003)' });
    expect(document.body.textContent).not.toMatch(/Reviewer scores|Overall rating of the manager/);
  });

  it('My ESS: goals waiting for their review take no self-entry yet', async () => {
    serve();
    db.own.set(A_OWN, ownView({ taskStatus: 'AWAITING_GOAL_REVIEW', goalReview: { required: true, reviewed: false, reviewedAt: null } }));
    renderPanel(EMPLOYEE);
    await screen.findByText(/Your goals are waiting for their review/);
    expect(screen.queryByRole('form', { name: 'My self-assessment' })).toBeNull();
    expect(document.body.textContent).toContain('Waiting for the goal review');
    expect(document.body.textContent).not.toContain('Goals set by');
  });
});
