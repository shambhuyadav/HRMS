// Hiring part 1 screens (FR-011, FR-012 approval; F1 "Hiring"; DF02; DF03; DF08; C4; ZT07), jsdom: the requisition
// register with the filters the API offers; a new draft with the exact FR-011 body and the masters a role may choose
// from; the requester's draft changed against its version, submitted, withdrawn, discarded with a reason, copied to a
// new reference and closed by HR; the budget exception shown where the API reports it; the F1 decision queue
// (validation, then HR budget and headcount approval with an explicit exception approval) with one idempotency key per
// decision; manpower budget lines, their revisions as the preparer drafts, submits and withdraws them, and the
// independent budget queue. Controls are hidden without their permission keys, the API's refusals are said in plain
// words, nothing the server did not return is shown, and nothing cached for one role assignment is shown under another.
// Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HIRING_REQUISITIONS_ESS_PANELS, HIRING_REQUISITIONS_SCREENS, HIRING_REQUISITIONS_TASK_QUEUES } from './hiring-requisitions';

// The selected company and role assignment and the signed-in user, as the session holds them; tests change the
// assignment to model a role switch and the employee link to model an account without an employee record.
const session = vi.hoisted(() => ({
  permissions: [] as string[],
  companyId: 'c0000000-0000-4000-8000-000000000001',
  assignmentId: 'a0000000-0000-4000-8000-000000000001',
  userId: 'b0000000-0000-4000-8000-000000000001',
  employeeId: '20000000-0000-4000-8000-000000000001' as string | null,
}));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: session.companyId, assignmentId: session.assignmentId },
    me: {
      userId: session.userId,
      accountKey: 'syn.asha',
      companyName: 'Synthetic Co',
      roleCode: 'REPORTING_MANAGER',
      roleName: 'Reporting Manager',
      scopeKind: 'TEAM',
      employeeId: session.employeeId,
      displayName: 'Asha Synthetic',
    },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

const READ = 'requisition.read.operational';
const CREATE = 'requisition.create.operational';
const VALIDATE = 'requisition.validate.operational';
const APPROVE = 'requisition.approve.operational';
const CLOSE = 'requisition.close.operational';
const BUDGET_READ = 'manpower_budget.read.operational';
const BUDGET_MANAGE = 'manpower_budget.manage.operational';
const BUDGET_APPROVE = 'manpower_budget.approve.operational';
const ORG_READ = 'org_master.read.operational';
const EMPLOYEE_LIST = 'employee.list.operational';

const ASSIGNMENT_A = 'a0000000-0000-4000-8000-000000000001';
const ASSIGNMENT_B = 'a0000000-0000-4000-8000-000000000002';
const U_ME = session.userId;
const U_RAVI = 'b0000000-0000-4000-8000-000000000002';
const U_MEERA = 'b0000000-0000-4000-8000-000000000003';
/** An HR Administrator account with no employee record. */
const U_HR = 'b0000000-0000-4000-8000-000000000004';

const ENG = { id: 'd0000000-0000-4000-8000-000000000001', code: 'ENG', name: 'Engineering' };
const FIN = { id: 'd0000000-0000-4000-8000-000000000002', code: 'FIN', name: 'Finance' };
const HQ = { id: 'e0000000-0000-4000-8000-000000000001', code: 'HQ', name: 'Head office' };
const PUNE = { id: 'e0000000-0000-4000-8000-000000000002', code: 'PUN', name: 'Pune office' };
const DEV = { id: 'f0000000-0000-4000-8000-000000000001', code: 'DEV', name: 'Developer' };
const QA = { id: 'f0000000-0000-4000-8000-000000000002', code: 'QA', name: 'Tester' };
/** Not in the masters the HR role lists here; only a team member's assignment carries it. */
const ANALYST = { id: 'f0000000-0000-4000-8000-000000000003', code: 'AN', name: 'Analyst' };
type Master = typeof ENG;
const ORG: Record<string, Master[]> = { departments: [ENG, FIN], locations: [HQ, PUNE], designations: [DEV, QA] };
const named = (m: Master) => ({ id: m.id, name: m.name });

interface Person {
  id: string;
  employeeCode: string;
  displayName: string;
}
const ASHA: Person = { id: session.employeeId!, employeeCode: 'SYN-001', displayName: 'Asha Synthetic' };
const RAVI: Person = { id: '20000000-0000-4000-8000-000000000002', employeeCode: 'SYN-002', displayName: 'Ravi Synthetic' };
const MEERA: Person = { id: '20000000-0000-4000-8000-000000000003', employeeCode: 'SYN-003', displayName: 'Meera Synthetic' };
const PEOPLE = [ASHA, RAVI, MEERA];
/** GET /v1/employees rows: a search finds anyone; the unfiltered list is the manager's direct report. */
const hit = (p: Person, status: string, assignment: { d: Master; l: Master; g: Master } | null) => ({
  ...p,
  status,
  assignment: assignment
    ? { departmentId: assignment.d.id, departmentName: assignment.d.name, locationId: assignment.l.id, locationName: assignment.l.name, designationId: assignment.g.id, designationName: assignment.g.name }
    : null,
});
const EMPLOYEES = [hit(ASHA, 'ACTIVE_CONFIRMED', null), hit(RAVI, 'ACTIVE_CONFIRMED', null), hit(MEERA, 'ACTIVE_PROBATION', { d: FIN, l: PUNE, g: ANALYST })];
const TEAM = [EMPLOYEES[2]!];

const R_DRAFT = '30000000-0000-4000-8000-000000000001';
const R_SUBMITTED = '30000000-0000-4000-8000-000000000002';
const R_APPROVED = '30000000-0000-4000-8000-000000000003';
const R_NEW = '30000000-0000-4000-8000-000000000004';
const R_COPY = '30000000-0000-4000-8000-000000000005';
const R_TEAM = '30000000-0000-4000-8000-000000000006';
const R_HR = '30000000-0000-4000-8000-000000000007';
const T_VALIDATE = '40000000-0000-4000-8000-000000000001';
const T_APPROVE = '40000000-0000-4000-8000-000000000002';
const T_PENDING = '40000000-0000-4000-8000-000000000003';

const B_DEV = '50000000-0000-4000-8000-000000000001';
const B_QA = '50000000-0000-4000-8000-000000000002';
const B_NEW = '50000000-0000-4000-8000-000000000003';
const B_FIN = '50000000-0000-4000-8000-000000000004';
const B_OPS = '50000000-0000-4000-8000-000000000005';
const V_DEV_1 = '60000000-0000-4000-8000-000000000001';
const V_DEV_2 = '60000000-0000-4000-8000-000000000002';
const V_QA_1 = '60000000-0000-4000-8000-000000000003';
const V_NEW = '60000000-0000-4000-8000-000000000004';
const V_LINE = '60000000-0000-4000-8000-000000000005';
const V_FIN_2 = '60000000-0000-4000-8000-000000000006';
const V_OPS_1 = '60000000-0000-4000-8000-000000000007';
const BT_FIN = '70000000-0000-4000-8000-000000000001';
const BT_OPS = '70000000-0000-4000-8000-000000000002';

const CREATED_AT = '2026-10-20T09:00:00.000Z';
const SUBMITTED_AT = '2026-10-21T09:30:00.000Z';
const VALIDATED_AT = '2026-10-22T10:00:00.000Z';
const DECIDED_AT = '2026-10-23T11:45:00.000Z';
const ASSIGNED_AT = '2026-10-24T08:15:00.000Z';
const CLOSED_AT = '2026-10-25T16:20:00.000Z';

interface BudgetCheck {
  budgetStatus: string;
  approvedHeadcount: number | null;
  committed: number;
  requested: number;
}
/** A requisition as GET /v1/hiring/requisitions/:id returns it. */
interface Detail {
  id: string;
  code: string;
  title: string;
  state: string;
  vacancies: number;
  reasonType: string;
  reason: string;
  skills: string[];
  targetDate: string;
  department: { id: string; name: string };
  location: { id: string; name: string };
  designation: { id: string; name: string };
  employmentType: string;
  requester: Person;
  hiringManager: Person;
  budgetId: string | null;
  budgetExceptionReason: string | null;
  currentRevision: number;
  copiedFromRequisitionId: string | null;
  budgetExceptionApprovedBy: string | null;
  budgetExceptionApprovedAt: string | null;
  submittedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  closedAt: string | null;
  closureReason: string | null;
  filled: number;
  createdAt: string;
  version: number;
  budgetCheck: BudgetCheck | null;
  revisions: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
  pendingWith: Record<string, unknown> | null;
}

const requisition = (id: string, code: string, patch: Partial<Detail> = {}): Detail => ({
  id,
  code,
  title: 'Synthetic platform engineer',
  state: 'DRAFT',
  vacancies: 2,
  reasonType: 'NEW',
  reason: 'Synthetic team growth',
  skills: ['TypeScript', 'PostgreSQL'],
  targetDate: '2026-12-01',
  department: named(ENG),
  location: named(HQ),
  designation: named(DEV),
  employmentType: 'PERMANENT',
  requester: ASHA,
  hiringManager: ASHA,
  budgetId: null,
  budgetExceptionReason: null,
  currentRevision: 0,
  copiedFromRequisitionId: null,
  budgetExceptionApprovedBy: null,
  budgetExceptionApprovedAt: null,
  submittedAt: null,
  decidedBy: null,
  decidedAt: null,
  closedAt: null,
  closureReason: null,
  filled: 0,
  createdAt: CREATED_AT,
  version: 1,
  budgetCheck: { budgetStatus: 'WITHIN_BUDGET', approvedHeadcount: 5, committed: 1, requested: 2 },
  revisions: [],
  decisions: [],
  pendingWith: null,
  ...patch,
});

const RAVI_USER = { userId: U_RAVI, employeeCode: 'SYN-002', displayName: 'Ravi Synthetic' };
const EXCEPTION_REASON = 'Synthetic: urgent client project';

function seedRequisitions(): Map<string, Detail> {
  const list = [
    // Asha's own draft, beyond its budget and without an exception reason yet.
    requisition(R_DRAFT, 'REQ-000101', { version: 3, budgetCheck: { budgetStatus: 'EXCEEDS_BUDGET', approvedHeadcount: 3, committed: 2, requested: 2 } }),
    // Asha's own requisition, waiting for her manager's validation.
    requisition(R_SUBMITTED, 'REQ-000102', {
      title: 'Synthetic data engineer',
      state: 'SUBMITTED',
      currentRevision: 1,
      version: 2,
      submittedAt: SUBMITTED_AT,
      revisions: [
        { revision: 1, vacancies: 2, targetDate: '2026-12-01', budgetStatus: 'WITHIN_BUDGET', approvedHeadcount: 5, committed: 1, budgetExceptionReason: null, submittedBy: U_ME, submittedAt: SUBMITTED_AT },
      ],
      pendingWith: { taskId: T_PENDING, step: 1, action: 'validate', assignee: RAVI_USER, assignedAt: SUBMITTED_AT },
    }),
    // Meera's requisition, validated by Asha and approved, with its exception, by an HR user without an employee record.
    requisition(R_APPROVED, 'REQ-000103', {
      title: 'Synthetic data analyst',
      state: 'APPROVED',
      vacancies: 1,
      filled: 1,
      targetDate: '2026-11-15',
      skills: [],
      requester: MEERA,
      hiringManager: ASHA,
      // The budget reference recorded at its submission and HR approval.
      budgetId: B_DEV,
      budgetExceptionReason: EXCEPTION_REASON,
      budgetExceptionApprovedBy: U_HR,
      budgetExceptionApprovedAt: DECIDED_AT,
      currentRevision: 1,
      version: 4,
      submittedAt: SUBMITTED_AT,
      decidedBy: U_HR,
      decidedAt: DECIDED_AT,
      budgetCheck: null,
      revisions: [
        {
          revision: 1,
          vacancies: 1,
          targetDate: '2026-11-15',
          budgetStatus: 'EXCEEDS_BUDGET',
          approvedHeadcount: 3,
          committed: 3,
          budgetExceptionReason: EXCEPTION_REASON,
          submittedBy: U_MEERA,
          submittedAt: SUBMITTED_AT,
        },
      ],
      decisions: [
        { revision: 1, step: 1, action: 'validate', decision: 'APPROVE', reason: null, decidedAt: VALIDATED_AT, decidedBy: { userId: U_ME, employeeCode: 'SYN-001', displayName: 'Asha Synthetic' } },
        {
          revision: 1,
          step: 2,
          action: 'approve',
          decision: 'APPROVE',
          reason: 'Synthetic: covered by the client budget',
          decidedAt: DECIDED_AT,
          decidedBy: { userId: U_HR, employeeCode: null, displayName: null },
        },
      ],
    }),
    // Meera (Asha's direct report) waits for Asha's validation.
    requisition(R_TEAM, 'REQ-000106', {
      title: 'Synthetic QA analyst',
      state: 'SUBMITTED',
      vacancies: 1,
      requester: MEERA,
      hiringManager: MEERA,
      department: named(FIN),
      location: named(PUNE),
      designation: named(QA),
      currentRevision: 1,
      version: 2,
      submittedAt: SUBMITTED_AT,
      budgetCheck: { budgetStatus: 'WITHIN_BUDGET', approvedHeadcount: 2, committed: 0, requested: 1 },
    }),
    // Ravi's validated requisition, beyond its budget with a recorded exception, waits for HR approval.
    requisition(R_HR, 'REQ-000107', {
      title: 'Synthetic support engineer',
      state: 'SUBMITTED',
      vacancies: 1,
      requester: RAVI,
      hiringManager: RAVI,
      employmentType: 'FIXED_TERM',
      reasonType: 'REPLACEMENT',
      budgetExceptionReason: 'Synthetic: replaces a leaver before the budget review',
      currentRevision: 1,
      version: 2,
      submittedAt: SUBMITTED_AT,
      budgetCheck: { budgetStatus: 'EXCEEDS_BUDGET', approvedHeadcount: 4, committed: 4, requested: 1 },
    }),
  ];
  return new Map(list.map((r) => [r.id, r]));
}

/** A list row: the detail without what only the detail carries. */
const listed = ({ budgetCheck: _b, revisions: _r, decisions: _d, pendingWith: _p, ...row }: Detail) => row;

interface Revision {
  revisionId: string;
  revision: number;
  headcount: number;
  reason: string;
  state: string;
  preparedBy: string;
  submittedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  version: number;
  createdAt: string;
}
interface Line {
  id: string;
  departmentId: string;
  departmentName: string;
  locationId: string;
  locationName: string;
  designationId: string;
  designationName: string;
  periodStart: string;
  periodEnd: string;
  approvedHeadcount: number | null;
  committed: number;
  revisions: Revision[];
}

const budgetLine = (id: string, d: Master, l: Master, g: Master, patch: Partial<Line> = {}): Line => ({
  id,
  departmentId: d.id,
  departmentName: d.name,
  locationId: l.id,
  locationName: l.name,
  designationId: g.id,
  designationName: g.name,
  periodStart: '2026-04-01',
  periodEnd: '2027-03-31',
  approvedHeadcount: null,
  committed: 0,
  revisions: [],
  ...patch,
});
const revision = (revisionId: string, n: number, headcount: number, reason: string, state: string, preparedBy: string, patch: Partial<Revision> = {}): Revision => ({
  revisionId,
  revision: n,
  headcount,
  reason,
  state,
  preparedBy,
  submittedAt: null,
  decidedBy: null,
  decidedAt: null,
  version: 1,
  createdAt: CREATED_AT,
  ...patch,
});
const openOf = (revisions: Revision[]) => {
  const o = revisions.find((v) => v.state === 'DRAFT' || v.state === 'SUBMITTED');
  return o ? { revisionId: o.revisionId, revision: o.revision, state: o.state, headcount: o.headcount } : null;
};
const lineView = ({ revisions, ...line }: Line) => ({ ...line, openRevision: openOf(revisions) });
const budgetDetail = (b: Line) => ({ ...lineView(b), revisions: [...b.revisions].sort((x, y) => y.revision - x.revision) });

function seedBudgets(): Map<string, Line> {
  const list = [
    budgetLine(B_DEV, ENG, HQ, DEV, {
      approvedHeadcount: 3,
      committed: 2,
      revisions: [
        revision(V_DEV_1, 1, 3, 'Synthetic plan', 'APPROVED', U_HR, { submittedAt: SUBMITTED_AT, decidedBy: U_ME, decidedAt: VALIDATED_AT, version: 2 }),
        revision(V_DEV_2, 2, 4, 'Synthetic increase', 'REJECTED', U_ME, { submittedAt: SUBMITTED_AT, decidedBy: U_HR, decidedAt: DECIDED_AT, version: 2 }),
      ],
    }),
    // A draft first revision prepared by another HR user.
    budgetLine(B_QA, ENG, HQ, QA, { revisions: [revision(V_QA_1, 1, 2, 'Synthetic first testers', 'DRAFT', U_HR)] }),
  ];
  return new Map(list.map((b) => [b.id, b]));
}

/** GET /v1/hiring/budget-tasks rows: each revision with its budget line, the headcount in force and the commitments. */
const budgetTask = (taskId: string, revisionId: string, n: number, headcount: number, reason: string, line: Line) => ({
  taskId,
  transactionId: `8${taskId.slice(1)}`,
  assignedAt: ASSIGNED_AT,
  revision: { revisionId, revision: n, headcount, reason, state: 'SUBMITTED', preparedBy: U_HR, submittedAt: SUBMITTED_AT, ...lineView(line) },
});

interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: unknown;
}
type Reply = [status: number, body: unknown];
/** A fixed reply, or a handler that answers (or returns undefined to let the fake API answer as usual). */
type Route = Reply | ((call: Call) => Reply | undefined | Promise<Reply | undefined>);

interface Db {
  requisitions: Map<string, Detail>;
  requisitionTasks: { taskId: string; transactionId: string; step: number; stepAction: string; assignedAt: string; requisition: Detail | null }[];
  budgets: Map<string, Line>;
  budgetTasks: ReturnType<typeof budgetTask>[];
  /** Idempotency keys of recorded decisions (ZT07) and what each recorded. */
  keys: Map<string, { taskId: string; reply: Record<string, unknown> }>;
}

let db: Db;
let calls: Call[] = [];
let holds = new Map<string, Promise<void>>();
let lost = new Set<string>();

const NOT_FOUND = { error: 'NOT_FOUND', message: 'Resource not found' };
const INVALID_STATE = { error: 'INVALID_STATE', message: 'Not in a state that allows this' };
const STALE = { error: 'STALE_VERSION', message: 'The record changed; reload and retry' };
const findMaster = (kind: string, id: unknown) => ORG[kind]!.find((m) => m.id === id) ?? ANALYST;

/** The request body of a requisition write, as the detail it becomes. */
function fromInput(b: Record<string, unknown>): Partial<Detail> {
  return {
    title: String(b.title),
    department: named(findMaster('departments', b.departmentId)),
    location: named(findMaster('locations', b.locationId)),
    designation: named(findMaster('designations', b.designationId)),
    employmentType: String(b.employmentType),
    vacancies: Number(b.vacancies),
    reasonType: String(b.reasonType),
    reason: String(b.reason),
    skills: (b.skills as string[] | undefined) ?? [],
    targetDate: String(b.targetDate),
    hiringManager: PEOPLE.find((p) => p.id === b.hiringManagerId) ?? ASHA,
    budgetExceptionReason: (b.budgetExceptionReason as string | null | undefined) ?? null,
  };
}

/** The hiring API's behaviour the screens rely on (modules/hiring/requisition.ts and budget.ts), over the fixtures. */
function fakeApi(call: Call): Reply {
  const { method, path, params } = call;
  const body = (call.body ?? {}) as Record<string, unknown>;
  if (method === 'GET' && path.startsWith('/v1/org/')) {
    return [200, { items: (ORG[path.slice('/v1/org/'.length)] ?? []).map((m) => ({ ...m, active: true, version: 1 })) }];
  }
  if (method === 'GET' && path === '/v1/employees') {
    const term = (params.get('search') ?? '').toLowerCase();
    const items = term ? EMPLOYEES.filter((e) => e.displayName.toLowerCase().includes(term) || e.employeeCode.toLowerCase().includes(term)) : TEAM;
    return [200, { items, total: items.length, page: 1, pageSize: Number(params.get('pageSize') ?? '25') }];
  }

  // Requisitions
  if (method === 'GET' && path === '/v1/hiring/requisitions') {
    const state = params.get('state');
    const department = params.get('departmentId');
    const search = (params.get('search') ?? '').toLowerCase();
    const page = Number(params.get('page') ?? '1');
    const size = Number(params.get('pageSize') ?? '25');
    const all = [...db.requisitions.values()].filter(
      (r) => (!state || r.state === state) && (!department || r.department.id === department) && (!search || r.code.toLowerCase().includes(search) || r.title.toLowerCase().includes(search)),
    );
    return [200, { items: all.slice((page - 1) * size, page * size).map(listed), total: all.length, page, pageSize: size }];
  }
  if (method === 'POST' && path === '/v1/hiring/requisitions') {
    const created = requisition(R_NEW, 'REQ-000104', { ...fromInput(body), requester: ASHA });
    db.requisitions.set(R_NEW, created);
    return [201, created];
  }
  let m = /^\/v1\/hiring\/requisitions\/([0-9a-f-]{36})(?:\/(submit|withdraw|discard|copy|close))?$/.exec(path);
  if (m) {
    const r = db.requisitions.get(m[1]!);
    if (!r) return [404, NOT_FOUND];
    const action = m[2];
    if (!action && method === 'GET') return [200, r];
    if (!action && method === 'PUT') {
      if (r.state !== 'DRAFT') return [409, INVALID_STATE];
      if (body.expectedVersion !== r.version) return [409, STALE];
      Object.assign(r, fromInput(body), { version: r.version + 1 });
      return [200, r];
    }
    if (action === 'submit') {
      if (r.state !== 'DRAFT') return [409, INVALID_STATE];
      if (body.expectedVersion !== r.version) return [409, STALE];
      const check = r.budgetCheck!;
      if (check.budgetStatus !== 'WITHIN_BUDGET' && !r.budgetExceptionReason) {
        return [422, { error: 'BUDGET_EXCEPTION_REASON_REQUIRED', message: 'The requisition exceeds its approved budget; record why an exception is needed', details: check }];
      }
      const n = r.currentRevision + 1;
      Object.assign(r, {
        state: 'SUBMITTED',
        currentRevision: n,
        version: r.version + 1,
        submittedAt: SUBMITTED_AT,
        revisions: [...r.revisions, { revision: n, vacancies: r.vacancies, targetDate: r.targetDate, budgetStatus: check.budgetStatus, approvedHeadcount: check.approvedHeadcount, committed: check.committed, budgetExceptionReason: r.budgetExceptionReason, submittedBy: U_ME, submittedAt: SUBMITTED_AT }],
        pendingWith: { taskId: T_PENDING, step: 1, action: 'validate', assignee: RAVI_USER, assignedAt: SUBMITTED_AT },
      });
      return [200, { requisitionId: r.id, state: 'SUBMITTED', revision: n, ...check }];
    }
    if (action === 'withdraw') {
      if (r.state !== 'SUBMITTED') return [409, INVALID_STATE];
      Object.assign(r, { state: 'DRAFT', pendingWith: null, version: r.version + 1 });
      return [200, { requisitionId: r.id, state: 'DRAFT' }];
    }
    if (action === 'discard') {
      if (r.state !== 'DRAFT') return [409, INVALID_STATE];
      Object.assign(r, { state: 'CLOSED', closureReason: body.reason, closedAt: CLOSED_AT, budgetCheck: null, version: r.version + 1 });
      return [200, { requisitionId: r.id, state: 'CLOSED' }];
    }
    if (action === 'copy') {
      const { title, department, location, designation, employmentType, vacancies, reasonType, reason, skills, targetDate, hiringManager } = r;
      const copy = requisition(R_COPY, 'REQ-000105', { title, department, location, designation, employmentType, vacancies, reasonType, reason, skills, targetDate, hiringManager, copiedFromRequisitionId: r.id });
      db.requisitions.set(R_COPY, copy);
      return [201, copy];
    }
    if (action === 'close') {
      if (r.state !== 'APPROVED') return [409, INVALID_STATE];
      Object.assign(r, { state: 'CLOSED', closureReason: body.reason, closedAt: CLOSED_AT, version: r.version + 1 });
      return [200, { requisitionId: r.id, state: 'CLOSED' }];
    }
  }
  if (method === 'GET' && path === '/v1/hiring/requisition-tasks') return [200, { items: db.requisitionTasks }];
  m = /^\/v1\/hiring\/requisition-tasks\/([0-9a-f-]{36})\/decision$/.exec(path);
  if (m && method === 'POST') {
    const taskId = m[1]!;
    const prior = db.keys.get(String(body.idempotencyKey));
    if (prior) return prior.taskId === taskId ? [200, { ...prior.reply, replayed: true }] : [409, { error: 'IDEMPOTENCY_KEY_REUSED', message: 'Idempotency key was used for another task' }];
    const t = db.requisitionTasks.find((x) => x.taskId === taskId);
    if (!t?.requisition) return [404, NOT_FOUND];
    if (body.decision !== 'APPROVE' && !body.reason) return [422, { error: 'REASON_REQUIRED', message: 'Record why the requisition is rejected or returned' }];
    const check = t.requisition.budgetCheck!;
    if (t.stepAction === 'approve' && body.decision === 'APPROVE' && check.budgetStatus !== 'WITHIN_BUDGET' && body.approveBudgetException !== true) {
      return [422, { error: 'BUDGET_EXCEPTION_DECISION_REQUIRED', message: 'Approve the budget exception explicitly', details: check }];
    }
    const state = body.decision === 'APPROVE' ? (t.step === 1 ? 'SUBMITTED' : 'APPROVED') : body.decision === 'RETURN' ? 'DRAFT' : 'REJECTED';
    db.keys.set(String(body.idempotencyKey), { taskId, reply: { requisitionId: t.requisition.id, state } });
    db.requisitionTasks = db.requisitionTasks.filter((x) => x !== t);
    return [200, { requisitionId: t.requisition.id, state, ...(body.decision === 'APPROVE' && t.step === 1 ? { pendingStep: 2 } : {}), replayed: false }];
  }

  // Manpower budgets
  if (method === 'GET' && path === '/v1/hiring/budgets') {
    const get = (k: string) => params.get(k);
    const on = get('on');
    const items = [...db.budgets.values()].filter(
      (b) =>
        (!get('departmentId') || b.departmentId === get('departmentId')) &&
        (!get('locationId') || b.locationId === get('locationId')) &&
        (!get('designationId') || b.designationId === get('designationId')) &&
        (!on || (b.periodStart <= on && b.periodEnd >= on)),
    );
    return [200, { items: items.map(lineView) }];
  }
  if (method === 'POST' && path === '/v1/hiring/budgets') {
    const line = budgetLine(B_NEW, findMaster('departments', body.departmentId), findMaster('locations', body.locationId), findMaster('designations', body.designationId), {
      periodStart: String(body.periodStart),
      periodEnd: String(body.periodEnd),
      revisions: [revision(V_LINE, 1, Number(body.headcount), String(body.reason), 'DRAFT', U_ME)],
    });
    db.budgets.set(B_NEW, line);
    return [201, { revisionId: V_LINE, budgetId: B_NEW, revision: 1, headcount: Number(body.headcount), state: 'DRAFT', version: 1 }];
  }
  m = /^\/v1\/hiring\/budgets\/([0-9a-f-]{36})(\/revisions)?$/.exec(path);
  if (m) {
    const b = db.budgets.get(m[1]!);
    if (!b) return [404, NOT_FOUND];
    if (!m[2] && method === 'GET') return [200, budgetDetail(b)];
    if (m[2] && method === 'POST') {
      if (openOf(b.revisions)) return [409, { error: 'OPEN_REVISION_EXISTS', message: 'This budget already has a revision in progress' }];
      const n = Math.max(0, ...b.revisions.map((v) => v.revision)) + 1;
      b.revisions.push(revision(V_NEW, n, Number(body.headcount), String(body.reason), 'DRAFT', U_ME));
      return [201, { revisionId: V_NEW, budgetId: b.id, revision: n, headcount: Number(body.headcount), state: 'DRAFT', version: 1 }];
    }
  }
  m = /^\/v1\/hiring\/budget-revisions\/([0-9a-f-]{36})(?:\/(submit|withdraw))?$/.exec(path);
  if (m) {
    const id = m[1]!;
    const v = [...db.budgets.values()].flatMap((b) => b.revisions).find((x) => x.revisionId === id);
    if (!v) return [404, NOT_FOUND];
    if (v.preparedBy !== U_ME) return [403, { error: 'NOT_PREPARER', message: 'Only the preparer can change, submit or withdraw this revision' }];
    if (!m[2] && method === 'PUT') {
      if (v.state !== 'DRAFT') return [409, INVALID_STATE];
      if (body.expectedVersion !== v.version) return [409, STALE];
      Object.assign(v, { headcount: body.headcount, reason: body.reason, version: v.version + 1 });
      return [200, { revisionId: id, state: 'DRAFT', headcount: v.headcount, version: v.version }];
    }
    if (m[2] === 'submit') {
      if (v.state !== 'DRAFT') return [409, INVALID_STATE];
      if (body.expectedVersion !== v.version) return [409, STALE];
      Object.assign(v, { state: 'SUBMITTED', submittedAt: SUBMITTED_AT, version: v.version + 1 });
      return [200, { revisionId: id, state: 'SUBMITTED' }];
    }
    if (m[2] === 'withdraw') {
      if (v.state !== 'DRAFT' && v.state !== 'SUBMITTED') return [409, INVALID_STATE];
      Object.assign(v, { state: 'WITHDRAWN', version: v.version + 1 });
      return [200, { revisionId: id, state: 'WITHDRAWN' }];
    }
  }
  if (method === 'GET' && path === '/v1/hiring/budget-tasks') return [200, { items: db.budgetTasks }];
  m = /^\/v1\/hiring\/budget-tasks\/([0-9a-f-]{36})\/decision$/.exec(path);
  if (m && method === 'POST') {
    const taskId = m[1]!;
    const prior = db.keys.get(String(body.idempotencyKey));
    if (prior) return prior.taskId === taskId ? [200, { ...prior.reply, replayed: true }] : [409, { error: 'IDEMPOTENCY_KEY_REUSED', message: 'Idempotency key was used for another task' }];
    const t = db.budgetTasks.find((x) => x.taskId === taskId);
    if (!t) return [404, NOT_FOUND];
    if (body.decision === 'REJECT' && !body.reason) return [422, { error: 'REASON_REQUIRED', message: 'Record why the revision is rejected' }];
    const state = body.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    db.keys.set(String(body.idempotencyKey), { taskId, reply: { revisionId: t.revision.revisionId, state } });
    db.budgetTasks = db.budgetTasks.filter((x) => x !== t);
    return [200, { revisionId: t.revision.revisionId, state, replayed: false }];
  }
  return [404, { error: 'NOT_FOUND', message: `No mock for ${method} ${path}` }];
}

/** Starts the fake API afresh; "METHOD /path" overrides answer first. Every request is recorded in `calls`. */
function serve(overrides: Record<string, Route> = {}) {
  const requisitions = seedRequisitions();
  db = {
    requisitions,
    requisitionTasks: [
      { taskId: T_VALIDATE, transactionId: '90000000-0000-4000-8000-000000000001', step: 1, stepAction: 'validate', assignedAt: ASSIGNED_AT, requisition: requisitions.get(R_TEAM)! },
      { taskId: T_APPROVE, transactionId: '90000000-0000-4000-8000-000000000002', step: 2, stepAction: 'approve', assignedAt: ASSIGNED_AT, requisition: requisitions.get(R_HR)! },
    ],
    budgets: seedBudgets(),
    budgetTasks: [
      budgetTask(BT_FIN, V_FIN_2, 2, 4, 'Synthetic: new client team', budgetLine(B_FIN, FIN, PUNE, DEV, { approvedHeadcount: 1 })),
      budgetTask(BT_OPS, V_OPS_1, 1, 2, 'Synthetic: support desk', budgetLine(B_OPS, ENG, PUNE, QA)),
    ],
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
      const reply = (route === undefined ? undefined : typeof route === 'function' ? await route(call) : route) ?? fakeApi(call);
      // The request was acted on; its answer is lost on the way back.
      if (lost.delete(key)) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(reply[1]), { status: reply[0], headers: { 'content-type': 'application/json' } });
    }),
  );
}

/** Holds every answer to "METHOD /path" until the returned function is called. */
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
const loseAnswer = (key: string) => lost.add(key);

const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const bodiesTo = (method: string, path: string) => callsTo(method, path).map((c) => c.body);
const lastParams = (path: string) => Object.fromEntries(callsTo('GET', path).at(-1)?.params ?? []);

interface SessionOptions {
  employeeId?: string | null;
  assignmentId?: string;
  client?: QueryClient;
}
const testClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

function selectContext(permissions: string[], options: SessionOptions) {
  session.permissions = permissions;
  session.employeeId = options.employeeId === undefined ? ASHA.id : options.employeeId;
  session.assignmentId = options.assignmentId ?? ASSIGNMENT_A;
}

/** Renders the hiring screens at a path, routed as the app routes them (so links and redirects work). */
function renderAt(entry: string, permissions: string[], options: SessionOptions = {}) {
  selectContext(permissions, options);
  return render(
    <QueryClientProvider client={options.client ?? testClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          {HIRING_REQUISITIONS_SCREENS.map((s) => (
            <Route key={s.path} path={s.path} element={<s.component />} />
          ))}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Renders one exported decision queue on its own, as the Decision inbox would. */
function renderQueue(title: string, permissions: string[], options: SessionOptions = {}) {
  selectContext(permissions, options);
  const Queue = HIRING_REQUISITIONS_TASK_QUEUES.find((q) => q.title === title)!.component;
  return render(
    <QueryClientProvider client={testClient()}>
      <MemoryRouter>
        <Queue />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((c) => c.textContent?.trim());
const rowWith = (table: HTMLElement, text: string) => within(table).getByText(text).closest('tr') as HTMLElement;
const headers = (table: HTMLElement) => within(table).getAllByRole('columnheader').map((h) => h.textContent);
const bodyRows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1);
const findSection = async (heading: string) => (await screen.findByRole('heading', { name: heading })).closest('section') as HTMLElement;
const valueIn = (scope: HTMLElement, term: string) => within(scope).getByText(term, { selector: 'dt' }).nextElementSibling!.textContent;
const optionsOf = (select: HTMLElement) => Array.from((select as HTMLSelectElement).options).map((o) => o.textContent);
const button = (scope: HTMLElement, name: string) => within(scope).getByRole('button', { name }) as HTMLButtonElement;
const field = (scope: HTMLElement, label: string | RegExp) => within(scope).getByLabelText(label) as HTMLInputElement;
const change = (scope: HTMLElement, label: string | RegExp, value: string) => fireEvent.change(within(scope).getByLabelText(label), { target: { value } });
const queueItem = async (name: string) => screen.findByRole('listitem', { name });
const KEY = (prefix: string) => expect.stringMatching(new RegExp(`^${prefix}-[0-9a-f-]{36}$`));

/** Lets any request a click might have started reach the fetch stub before asserting that none was made. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

/** An instant as the screens show it: the viewer's local date and time. */
function localTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Fills the requisition form; every field the API requires. */
async function fillRequisition(form: HTMLElement, values: { title?: string; vacancies?: string; hiringManager?: string } = {}) {
  await within(form).findByRole('option', { name: 'Engineering (ENG)' });
  change(form, 'Position title', values.title ?? '  Synthetic platform engineer ');
  change(form, 'Department', ENG.id);
  change(form, 'Location', PUNE.id);
  change(form, 'Designation', QA.id);
  change(form, 'Employment type', 'fixed_term');
  change(form, 'Vacancies', values.vacancies ?? '3');
  change(form, 'Target date', '2027-01-15');
  fireEvent.click(within(form).getByLabelText('Replacement'));
  change(form, 'Reason for the requisition', 'Synthetic: replaces a leaver');
  change(form, /^Skills/, 'Selenium, API testing\n\nSQL ');
  change(form, 'Hiring manager', values.hiringManager ?? ASHA.id);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('exports for the navigation step', () => {
  it('offers the screens, the two decision queues and no My ESS panel', () => {
    expect(HIRING_REQUISITIONS_SCREENS.map((s) => [s.path, s.title, s.permission, s.nav])).toEqual([
      ['/hiring/requisitions', 'Requisitions', READ, true],
      ['/hiring/requisitions/new', 'New requisition', CREATE, false],
      ['/hiring/requisitions/:id', 'Requisition', READ, false],
      ['/hiring/budgets', 'Manpower budgets', BUDGET_READ, true],
      ['/hiring/budgets/:id', 'Manpower budget', BUDGET_READ, false],
    ]);
    expect(HIRING_REQUISITIONS_SCREENS.every((s) => typeof s.component === 'function')).toBe(true);
    // Hiring serves no H3 My ESS tab.
    expect(HIRING_REQUISITIONS_ESS_PANELS).toEqual([]);
    // One queue per decision duty: each F1 requisition step is decided with its own permission.
    expect(HIRING_REQUISITIONS_TASK_QUEUES.map((q) => [q.permission, q.title])).toEqual([
      [BUDGET_APPROVE, 'Manpower budget approvals'],
      [VALIDATE, 'Requisition validations'],
      [APPROVE, 'Requisition budget and headcount approvals'],
    ]);
    expect(HIRING_REQUISITIONS_TASK_QUEUES.every((q) => typeof q.component === 'function')).toBe(true);
  });

  it('renders each exported queue under its own title for a role holding its permission', async () => {
    for (const q of HIRING_REQUISITIONS_TASK_QUEUES) {
      serve();
      // The requisition queues list their tasks with the read permission every deciding role holds.
      renderQueue(q.title, [q.permission, READ]);
      expect(await screen.findByRole('region', { name: q.title })).toBeTruthy();
      expect(screen.getAllByRole('region')).toHaveLength(1);
      cleanup();
    }
  });
});

describe('requisition register (FR-012 HR view within scope)', () => {
  it('lists the requisitions in scope and sends the filters the API offers', async () => {
    serve();
    renderAt('/hiring/requisitions', [READ, ORG_READ]);
    const table = await screen.findByRole('table', { name: 'Requisitions' });
    expect(headers(table)).toEqual(['Reference', 'Position', 'Department', 'Location', 'Designation', 'Vacancies', 'Filled', 'Target date', 'Requester', 'Hiring manager', 'State']);
    expect(bodyRows(table)).toHaveLength(5);
    expect(cells(rowWith(table, 'REQ-000103'))).toEqual([
      'REQ-000103',
      'Synthetic data analyst',
      'Engineering',
      'Head office',
      'Developer',
      '1',
      '1',
      '2026-11-15',
      'Meera Synthetic (SYN-003)',
      'Asha Synthetic (SYN-001)',
      'approved',
    ]);
    expect(within(table).getByRole('link', { name: 'REQ-000103' }).getAttribute('href')).toBe(`/hiring/requisitions/${R_APPROVED}`);
    expect(lastParams('/v1/hiring/requisitions')).toEqual({ page: '1', pageSize: '25' });

    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'SUBMITTED' } });
    await waitFor(() => expect(lastParams('/v1/hiring/requisitions')).toEqual({ page: '1', pageSize: '25', state: 'SUBMITTED' }));
    await waitFor(() => expect(bodyRows(screen.getByRole('table', { name: 'Requisitions' }))).toHaveLength(3));

    await screen.findByRole('option', { name: 'Engineering (ENG)' });
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: ENG.id } });
    await waitFor(() => expect(lastParams('/v1/hiring/requisitions')).toEqual({ page: '1', pageSize: '25', state: 'SUBMITTED', departmentId: ENG.id }));

    // The search is sent trimmed once typing pauses.
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: '  support ' } });
    await waitFor(() => expect(lastParams('/v1/hiring/requisitions')).toEqual({ page: '1', pageSize: '25', state: 'SUBMITTED', departmentId: ENG.id, search: 'support' }));
    await waitFor(() => expect(bodyRows(screen.getByRole('table', { name: 'Requisitions' })).map((r) => cells(r)[0])).toEqual(['REQ-000107']));

    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '50' } });
    await waitFor(() => expect(lastParams('/v1/hiring/requisitions')).toMatchObject({ pageSize: '50', page: '1' }));

    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'CLOSED' } });
    expect(await screen.findByText('No requisitions match these filters.')).toBeTruthy();
  });

  it('pages through the register', async () => {
    serve({ 'GET /v1/hiring/requisitions': (c) => [200, { items: [listed(db.requisitions.get(R_DRAFT)!)], total: 60, page: Number(c.params.get('page')), pageSize: 25 }] });
    renderAt('/hiring/requisitions', [READ]);
    expect(await screen.findByText('Page 1 of 3 · 60 requisitions')).toBeTruthy();
    expect(button(document.body, 'Previous').disabled).toBe(true);
    fireEvent.click(button(document.body, 'Next'));
    await waitFor(() => expect(lastParams('/v1/hiring/requisitions').page).toBe('2'));
    expect(await screen.findByText('Page 2 of 3 · 60 requisitions')).toBeTruthy();
    fireEvent.click(button(document.body, 'Next'));
    expect(await screen.findByText('Page 3 of 3 · 60 requisitions')).toBeTruthy();
    expect(button(document.body, 'Next').disabled).toBe(true);
    fireEvent.click(button(document.body, 'Previous'));
    await waitFor(() => expect(lastParams('/v1/hiring/requisitions').page).toBe('2'));
  });

  it('offers the first page when the address asks for a page past the end', async () => {
    serve({
      'GET /v1/hiring/requisitions': (c) => [
        200,
        c.params.get('page') === '5' ? { items: [], total: 30, page: 5, pageSize: 25 } : { items: [listed(db.requisitions.get(R_DRAFT)!)], total: 30, page: 1, pageSize: 25 },
      ],
    });
    renderAt('/hiring/requisitions?page=5', [READ]);
    expect(await screen.findByText('This page is past the end of the list.')).toBeTruthy();
    expect(screen.queryByText(/^No requisitions/)).toBeNull();
    fireEvent.click(button(document.body, 'Go to the first page'));
    await waitFor(() => expect(lastParams('/v1/hiring/requisitions').page).toBe('1'));
    expect(await screen.findByRole('link', { name: 'REQ-000101' })).toBeTruthy();
  });

  it('shows the register only with the read permission, and New requisition only to a linked employee who may raise one', async () => {
    serve();
    renderAt('/hiring/requisitions', []);
    expect(screen.getByText('The selected role cannot view requisitions.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    await settle();
    expect(calls).toHaveLength(0);
    cleanup();

    serve();
    renderAt(`/hiring/requisitions?department=${ENG.id}`, [READ]);
    await screen.findByRole('table', { name: 'Requisitions' });
    expect(screen.queryByRole('link', { name: 'New requisition' })).toBeNull();
    // Without the masters there is no department filter, nothing asks for them, and none from the address applies unseen.
    expect(screen.queryByLabelText('Department')).toBeNull();
    expect(calls.some((c) => c.path.startsWith('/v1/org/'))).toBe(false);
    expect(lastParams('/v1/hiring/requisitions')).toEqual({ page: '1', pageSize: '25' });
    // No decision duty: no queue, and the tasks are never asked for.
    expect(screen.queryByRole('region')).toBeNull();
    expect(callsTo('GET', '/v1/hiring/requisition-tasks')).toHaveLength(0);
    cleanup();

    serve();
    renderAt('/hiring/requisitions', [READ, CREATE]);
    expect((await screen.findByRole('link', { name: 'New requisition' })).getAttribute('href')).toBe('/hiring/requisitions/new');
    cleanup();

    serve();
    renderAt('/hiring/requisitions', [READ, CREATE], { employeeId: null });
    expect(await screen.findByText(/this account is not linked to an employee record, so it cannot raise one/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'New requisition' })).toBeNull();
  });

  it('never shows one role assignment’s answers under another', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    serve();
    renderAt('/hiring/requisitions', [READ], { client });
    await screen.findByRole('link', { name: 'REQ-000101' });
    cleanup();

    serve({ 'GET /v1/hiring/requisitions': [200, { items: [], total: 0, page: 1, pageSize: 25 }] });
    renderAt('/hiring/requisitions', [READ], { client, assignmentId: ASSIGNMENT_B });
    expect(await screen.findByText('No requisitions in the selected role’s scope yet.')).toBeTruthy();
    expect(screen.queryByText('REQ-000101')).toBeNull();
    expect(callsTo('GET', '/v1/hiring/requisitions')).toHaveLength(1);
  });
});

describe('a new requisition (FR-011 fields)', () => {
  it('saves the draft with the exact body, is not sent twice while in flight, and opens it', async () => {
    serve();
    renderAt('/hiring/requisitions/new', [READ, CREATE, ORG_READ, EMPLOYEE_LIST]);
    const form = await screen.findByRole('form', { name: 'New requisition' });
    await fillRequisition(form);
    expect(optionsOf(field(form, 'Hiring manager'))).toEqual(['Choose…', 'You (Asha Synthetic)']);
    const release = hold('POST /v1/hiring/requisitions');
    fireEvent.click(button(form, 'Save draft'));
    await waitFor(() => expect(callsTo('POST', '/v1/hiring/requisitions')).toHaveLength(1));
    await waitFor(() => expect(button(form, 'Save draft').disabled).toBe(true));
    fireEvent.click(button(form, 'Save draft'));
    await settle();
    expect(bodiesTo('POST', '/v1/hiring/requisitions')).toEqual([
      {
        title: 'Synthetic platform engineer',
        departmentId: ENG.id,
        locationId: PUNE.id,
        designationId: QA.id,
        employmentType: 'FIXED_TERM',
        vacancies: 3,
        reasonType: 'REPLACEMENT',
        reason: 'Synthetic: replaces a leaver',
        skills: ['Selenium', 'API testing', 'SQL'],
        targetDate: '2027-01-15',
        hiringManagerId: ASHA.id,
        budgetExceptionReason: null,
      },
    ]);
    await act(async () => release());
    expect(await screen.findByRole('heading', { level: 1, name: 'Requisition REQ-000104' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Draft REQ-000104 saved. Check its budget, then submit it for approval.');
    expect(callsTo('GET', `/v1/hiring/requisitions/${R_NEW}`)).toHaveLength(1);
  });

  it('says which field is missing, and keeps what was typed when the API refuses', async () => {
    serve({
      'POST /v1/hiring/requisitions': [422, { error: 'INVALID_HIRING_MANAGER', message: 'The hiring manager must be an active employee of this company', details: { field: 'hiringManagerId' } }],
    });
    renderAt('/hiring/requisitions/new', [READ, CREATE, ORG_READ]);
    const form = await screen.findByRole('form', { name: 'New requisition' });
    fireEvent.click(button(form, 'Save draft'));
    expect((await within(form).findByRole('alert')).textContent).toBe('Enter the position title.');
    await fillRequisition(form, { vacancies: '0' });
    fireEvent.click(button(form, 'Save draft'));
    await waitFor(() => expect(within(form).getByRole('alert').textContent).toBe('Enter the number of vacancies as a whole number of at least 1.'));
    change(form, 'Employment type', 'not a code');
    change(form, 'Vacancies', '1');
    fireEvent.click(button(form, 'Save draft'));
    await waitFor(() => expect(within(form).getByRole('alert').textContent).toBe('Enter the employment type code, for example PERMANENT.'));
    await settle();
    expect(callsTo('POST', '/v1/hiring/requisitions')).toHaveLength(0);

    change(form, 'Employment type', 'PERMANENT');
    fireEvent.click(button(form, 'Save draft'));
    expect((await screen.findByText(/^The hiring manager must be an active employee/)).textContent).toBe(
      'The hiring manager must be an active employee of this company. Choose another hiring manager.',
    );
    expect(callsTo('POST', '/v1/hiring/requisitions')).toHaveLength(1);
    expect(field(form, 'Position title').value).toBe('  Synthetic platform engineer ');
    expect(field(form, 'Reason for the requisition').value).toBe('Synthetic: replaces a leaver');
    expect(within(form).queryByRole('alert')).toBeNull();
  });

  it('finds another hiring manager by an employee search, offered only with the employee list permission', async () => {
    serve();
    renderAt('/hiring/requisitions/new', [READ, CREATE, ORG_READ, EMPLOYEE_LIST]);
    const form = await screen.findByRole('form', { name: 'New requisition' });
    change(form, 'Find another hiring manager', 'Meera');
    const choose = await within(form).findByRole('button', { name: 'Choose Meera Synthetic (SYN-003) as the hiring manager' });
    expect(choose.textContent).toBe('Meera Synthetic (SYN-003) · active probation');
    expect(lastParams('/v1/employees')).toEqual({ search: 'Meera', page: '1', pageSize: '25' });
    fireEvent.click(choose);
    expect(field(form, 'Hiring manager').value).toBe(MEERA.id);
    expect(within(form).queryByRole('button', { name: /^Choose / })).toBeNull();
    await fillRequisition(form, { hiringManager: MEERA.id });
    fireEvent.click(button(form, 'Save draft'));
    await waitFor(() => expect(callsTo('POST', '/v1/hiring/requisitions')).toHaveLength(1));
    expect((callsTo('POST', '/v1/hiring/requisitions')[0]!.body as { hiringManagerId: string }).hiringManagerId).toBe(MEERA.id);
    cleanup();

    serve();
    renderAt('/hiring/requisitions/new', [READ, CREATE, ORG_READ]);
    const plain = await screen.findByRole('form', { name: 'New requisition' });
    expect(within(plain).queryByLabelText('Find another hiring manager')).toBeNull();
  });

  it('offers a manager the masters the server returned to it when the role cannot list them', async () => {
    serve();
    renderAt('/hiring/requisitions/new', [READ, CREATE, EMPLOYEE_LIST]);
    const form = await screen.findByRole('form', { name: 'New requisition' });
    expect(
      within(form).getByText('The selected role cannot list the company’s departments, locations and designations, so the choices come from your team and the requisitions you can see.'),
    ).toBeTruthy();
    // From the direct report's assignment (Finance, Pune office, Analyst) and the requisitions in scope.
    await waitFor(() => expect(optionsOf(field(form, 'Designation'))).toEqual(['Choose…', 'Analyst', 'Developer', 'Tester']));
    expect(optionsOf(field(form, 'Department'))).toEqual(['Choose…', 'Engineering', 'Finance']);
    expect(optionsOf(field(form, 'Location'))).toEqual(['Choose…', 'Head office', 'Pune office']);
    expect(calls.some((c) => c.path.startsWith('/v1/org/'))).toBe(false);
    expect(lastParams('/v1/employees')).toEqual({ page: '1', pageSize: '100' });
    expect(lastParams('/v1/hiring/requisitions')).toEqual({ page: '1', pageSize: '100' });
  });

  it('is not offered without the create permission or to an account without an employee record', async () => {
    serve();
    renderAt('/hiring/requisitions/new', [READ]);
    expect(screen.getByText('The selected role cannot raise requisitions.')).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
    cleanup();

    serve();
    renderAt('/hiring/requisitions/new', [READ, CREATE, ORG_READ], { employeeId: null });
    expect(screen.getByText(/this account is not linked to an employee record, so it cannot raise one/)).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
    await settle();
    expect(calls).toHaveLength(0);
  });
});

describe('one requisition', () => {
  it('FR-003, FR-068: a decision a delegate took names the person it was taken for beside the delegate (I-57 item 7)', async () => {
    serve({
      [`GET /v1/hiring/requisitions/${R_APPROVED}`]: () => {
        const r = db.requisitions.get(R_APPROVED)!;
        const meera = { userId: U_MEERA, employeeCode: 'SYN-003', displayName: 'Meera Synthetic' };
        return [200, { ...r, decisions: r.decisions.map((d, i) => ({ ...d, onBehalfOf: i === 1 ? meera : null })) }];
      },
    });
    renderAt(`/hiring/requisitions/${R_APPROVED}`, [READ]);
    const history = await screen.findByRole('table', { name: 'Approval history' });
    expect(bodyRows(history).map(cells).map((row) => row[3])).toEqual(['You', 'A user without an employee record on behalf of Meera Synthetic (SYN-003)']);
  });

  it('shows a decided requisition with its approval history and revisions, and only what the server returned', async () => {
    serve();
    renderAt(`/hiring/requisitions/${R_APPROVED}`, [READ]);
    await screen.findByRole('heading', { level: 1, name: 'Requisition REQ-000103' });
    const facts = await findSection('Synthetic data analyst');
    expect(valueIn(facts, 'State')).toBe('approved');
    expect(valueIn(facts, 'Requester')).toBe('Meera Synthetic (SYN-003)');
    expect(valueIn(facts, 'Hiring manager')).toBe('Asha Synthetic (SYN-001)');
    expect(valueIn(facts, 'Employment type')).toBe('Permanent');
    expect(valueIn(facts, 'New or replacement')).toBe('New position');
    expect(valueIn(facts, 'Skills')).toBe('None listed');
    expect(valueIn(facts, 'Filled (accepted offers)')).toBe('1');
    expect(valueIn(facts, 'Decided')).toBe(localTime(DECIDED_AT));
    expect(within(facts).queryByText('Closed', { selector: 'dt' })).toBeNull();

    const history = screen.getByRole('table', { name: 'Approval history' });
    expect(headers(history)).toEqual(['Revision', 'Step', 'Decision', 'Decided by', 'Decided at', 'Reason']);
    expect(bodyRows(history).map(cells)).toEqual([
      ['1', 'Step 1: Validation', 'Approved', 'You', localTime(VALIDATED_AT), '—'],
      ['1', 'Step 2: Budget and headcount approval', 'Approved', 'A user without an employee record', localTime(DECIDED_AT), 'Synthetic: covered by the client budget'],
    ]);
    const revisions = screen.getByRole('table', { name: 'Submitted revisions' });
    expect(bodyRows(revisions).map(cells)).toEqual([['1', '1', '2026-11-15', 'Exceeds budget', '3', '3', EXCEPTION_REASON, localTime(SUBMITTED_AT)]]);

    // A decided requisition has no budget check now: its exception and approval are shown, no check is invented.
    const budget = await findSection('Budget');
    expect(budget.textContent).toContain(`Budget exception reason: ${EXCEPTION_REASON}`);
    expect(budget.textContent).toContain(`exception approved The HR approver approved the budget exception on ${localTime(DECIDED_AT)}.`);
    expect(budget.textContent).not.toMatch(/Within the approved budget|Approved headcount/);
    // The budget reference is a link to a budget line, which this role cannot view.
    expect(budget.textContent).not.toContain('Budget reference');
    expect(within(budget).queryByRole('link')).toBeNull();
    // Reading only: no actions.
    expect(screen.queryByRole('heading', { name: 'Actions' })).toBeNull();
  });

  it('links the budget reference to its budget line for a role that can view manpower budgets', async () => {
    serve();
    renderAt(`/hiring/requisitions/${R_APPROVED}`, [READ, BUDGET_READ]);
    const budget = await findSection('Budget');
    expect(within(budget).getByText(/^Budget reference:/).textContent).toBe('Budget reference: open the manpower budget line it was checked against');
    expect(within(budget).getByRole('link', { name: 'open the manpower budget line it was checked against' }).getAttribute('href')).toBe(`/hiring/budgets/${B_DEV}`);
    cleanup();

    // A draft's check is the live one; a reference left from an earlier submission is not offered as its budget line.
    serve({ [`GET /v1/hiring/requisitions/${R_DRAFT}`]: () => [200, { ...db.requisitions.get(R_DRAFT)!, budgetId: B_QA, currentRevision: 1 }] });
    renderAt(`/hiring/requisitions/${R_DRAFT}`, [READ, BUDGET_READ]);
    expect((await findSection('Budget')).textContent).not.toContain('Budget reference');
  });

  it('shows the budget exception a draft needs, and says why it cannot be submitted without one', async () => {
    serve();
    renderAt(`/hiring/requisitions/${R_DRAFT}`, [READ, CREATE]);
    const budget = await findSection('Budget');
    expect(budget.textContent).toBe(
      'BudgetExceeds budget Exceeds the approved budget: an exception reason is needed to submit it, and the HR approver approves the exception explicitly. Approved headcount 3, already committed 2, this requisition 2.',
    );
    const actions = await findSection('Actions');
    expect(within(actions).getByText('Record a budget exception reason (Edit draft) before submitting: this requisition exceeds its approved budget or has none.')).toBeTruthy();
    fireEvent.click(button(actions, 'Submit for approval'));
    await waitFor(() => expect(bodiesTo('POST', `/v1/hiring/requisitions/${R_DRAFT}/submit`)).toEqual([{ expectedVersion: 3 }]));
    expect((await within(actions).findByRole('alert')).textContent).toBe(
      'The requisition exceeds its approved budget (approved headcount 3, already committed 2, requested 2). Edit the draft to record why an exception is needed, then submit it again.',
    );
  });

  it('changes the draft against its version, then submits it', async () => {
    serve();
    renderAt(`/hiring/requisitions/${R_DRAFT}`, [READ, CREATE, ORG_READ]);
    const actions = await findSection('Actions');
    fireEvent.click(button(actions, 'Edit draft'));
    const form = within(actions).getByRole('form', { name: 'Edit draft REQ-000101' });
    expect(field(form, 'Position title').value).toBe('Synthetic platform engineer');
    expect(field(form, /^Skills/).value).toBe('TypeScript\nPostgreSQL');
    expect(field(form, 'Employment type').value).toBe('PERMANENT');
    expect((within(form).getByLabelText('New position') as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(field(form, 'Department').value).toBe(ENG.id));
    expect(field(form, 'Hiring manager').value).toBe(ASHA.id);
    expect(within(form).getByText(/^Required to submit: this requisition exceeds its approved budget or has none/)).toBeTruthy();
    change(form, 'Budget exception reason', `  ${EXCEPTION_REASON} `);
    fireEvent.click(button(form, 'Save draft'));
    await waitFor(() => expect(callsTo('PUT', `/v1/hiring/requisitions/${R_DRAFT}`)).toHaveLength(1));
    expect(bodiesTo('PUT', `/v1/hiring/requisitions/${R_DRAFT}`)).toEqual([
      {
        title: 'Synthetic platform engineer',
        departmentId: ENG.id,
        locationId: HQ.id,
        designationId: DEV.id,
        employmentType: 'PERMANENT',
        vacancies: 2,
        reasonType: 'NEW',
        reason: 'Synthetic team growth',
        skills: ['TypeScript', 'PostgreSQL'],
        targetDate: '2026-12-01',
        hiringManagerId: ASHA.id,
        budgetExceptionReason: EXCEPTION_REASON,
        expectedVersion: 3,
      },
    ]);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Draft saved.'));
    // The form closes after the save; the reloaded draft shows the recorded exception.
    expect(within(actions).queryByRole('form')).toBeNull();
    await waitFor(async () => expect((await findSection('Budget')).textContent).toContain(`Budget exception reason: ${EXCEPTION_REASON}`));

    const submit = button(actions, 'Submit for approval');
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(bodiesTo('POST', `/v1/hiring/requisitions/${R_DRAFT}/submit`)).toEqual([{ expectedVersion: 4 }]));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Submitted for approval as revision 1, with its budget exception. It now waits for validation.'));
    const facts = await findSection('Synthetic platform engineer');
    await waitFor(() => expect(facts.textContent).toContain(`Waiting for Ravi Synthetic (SYN-002): Step 1: Validation, since ${localTime(SUBMITTED_AT)}.`));
    expect(await within(await findSection('Actions')).findByRole('button', { name: 'Withdraw' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit draft' })).toBeNull();
    expect(bodyRows(screen.getByRole('table', { name: 'Submitted revisions' })).map(cells)).toEqual([
      ['1', '2', '2026-12-01', 'Exceeds budget', '3', '2', EXCEPTION_REASON, localTime(SUBMITTED_AT)],
    ]);
  });

  it('withdraws a requisition waiting for a decision, then discards the draft with a reason', async () => {
    serve();
    renderAt(`/hiring/requisitions/${R_SUBMITTED}`, [READ, CREATE]);
    const actions = await findSection('Actions');
    fireEvent.click(button(actions, 'Withdraw'));
    await waitFor(() => expect(callsTo('POST', `/v1/hiring/requisitions/${R_SUBMITTED}/withdraw`)).toHaveLength(1));
    expect(bodiesTo('POST', `/v1/hiring/requisitions/${R_SUBMITTED}/withdraw`)).toEqual([undefined]);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Withdrawn. The requisition is a draft again, and its reviewer no longer needs to decide it.'));

    const discard = await within(actions).findByRole('button', { name: 'Discard draft' });
    await waitFor(() => expect((discard as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(discard);
    const form = within(actions).getByRole('form', { name: 'Discard this draft' });
    fireEvent.click(button(form, 'Discard this draft'));
    expect((await within(form).findByRole('alert')).textContent).toBe('Enter a reason.');
    await settle();
    expect(callsTo('POST', `/v1/hiring/requisitions/${R_SUBMITTED}/discard`)).toHaveLength(0);
    change(form, 'Reason for discarding (required)', '  Synthetic: no longer needed ');
    fireEvent.click(button(form, 'Discard this draft'));
    await waitFor(() => expect(bodiesTo('POST', `/v1/hiring/requisitions/${R_SUBMITTED}/discard`)).toEqual([{ reason: 'Synthetic: no longer needed' }]));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Draft discarded. It is kept as a closed requisition with your reason.'));
    const facts = await findSection('Synthetic data engineer');
    await waitFor(() => expect(valueIn(facts, 'Closure reason')).toBe('Synthetic: no longer needed'));
    expect(valueIn(facts, 'State')).toBe('closed');
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).toBeNull();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('copies a requisition to a new reference and opens the copy, with no approval history', async () => {
    serve();
    renderAt(`/hiring/requisitions/${R_APPROVED}`, [READ, CREATE]);
    const actions = await findSection('Actions');
    expect(within(actions).getByText('A copy gets a new reference and keeps the job details only: no approvals, decisions, budget exception or candidates.')).toBeTruthy();
    fireEvent.click(button(actions, 'Copy to a new requisition'));
    await waitFor(() => expect(bodiesTo('POST', `/v1/hiring/requisitions/${R_APPROVED}/copy`)).toEqual([undefined]));
    expect(await screen.findByRole('heading', { level: 1, name: 'Requisition REQ-000105' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Copied to REQ-000105, a new draft with no approvals or decisions. Review it, then submit it for approval.');
    expect(within(await findSection('Approval history')).getByText('No decisions recorded yet.')).toBeTruthy();
    expect(within(await findSection('Submitted revisions')).getByText('Not submitted yet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'The requisition it was copied from' }).getAttribute('href')).toBe(`/hiring/requisitions/${R_APPROVED}`);
    // The copy is the caller's own draft.
    expect(await within(await findSection('Actions')).findByRole('button', { name: 'Edit draft' })).toBeTruthy();
  });

  it('DF03: the requester raises a rejected requisition again as a linked draft; nobody else is offered it, nor on another state', async () => {
    const raisedBody = { state: 'DRAFT', id: R_COPY, code: 'REQ-000105', predecessorRequestId: R_DRAFT };
    serve({ [`POST /v1/hiring/requisitions/${R_DRAFT}/raise-again`]: () => [201, { ...db.requisitions.get(R_DRAFT), ...raisedBody }] });
    db.requisitions.set(R_DRAFT, { ...db.requisitions.get(R_DRAFT)!, state: 'REJECTED' });
    db.requisitions.set(R_COPY, { ...db.requisitions.get(R_DRAFT)!, ...raisedBody });
    renderAt(`/hiring/requisitions/${R_DRAFT}`, [READ, CREATE]);
    const actions = await findSection('Actions');
    fireEvent.click(button(actions, 'Raise again'));
    await waitFor(() => expect(bodiesTo('POST', `/v1/hiring/requisitions/${R_DRAFT}/raise-again`)).toEqual([undefined]));
    expect((await screen.findByRole('status')).textContent).toBe('Raised again as REQ-000105, a new draft linked to the rejected requisition. Review it, then submit it for approval.');
    expect((await screen.findByRole('link', { name: 'The rejected requisition' })).getAttribute('href')).toBe(`/hiring/requisitions/${R_DRAFT}`);
    cleanup();

    serve();
    renderAt(`/hiring/requisitions/${R_APPROVED}`, [READ, CREATE]);
    expect(within(await findSection('Actions')).queryByRole('button', { name: 'Raise again' })).toBeNull();
    cleanup();

    serve();
    db.requisitions.set(R_TEAM, { ...db.requisitions.get(R_TEAM)!, state: 'REJECTED' });
    renderAt(`/hiring/requisitions/${R_TEAM}`, [READ, CREATE]);
    expect(within(await findSection('Actions')).queryByRole('button', { name: 'Raise again' })).toBeNull(); // another requester's
  });

  it('says why a requisition cannot be copied in words that fit a copy', async () => {
    let refusal: Reply = [422, { error: 'INVALID_HIRING_MANAGER', message: 'The hiring manager must be an active employee of this company', details: { field: 'hiringManagerId' } }];
    serve({ [`POST /v1/hiring/requisitions/${R_APPROVED}/copy`]: () => refusal });
    renderAt(`/hiring/requisitions/${R_APPROVED}`, [READ, CREATE]);
    const actions = await findSection('Actions');
    fireEvent.click(button(actions, 'Copy to a new requisition'));
    expect((await within(actions).findByRole('alert')).textContent).toBe('This requisition cannot be copied: its hiring manager is no longer an active employee of this company.');
    refusal = [422, { error: 'INVALID_REFERENCE', message: 'The designation is not an active master in this company', details: { field: 'designationId' } }];
    await waitFor(() => expect(button(actions, 'Copy to a new requisition').disabled).toBe(false));
    fireEvent.click(button(actions, 'Copy to a new requisition'));
    await waitFor(() => expect(within(actions).getByRole('alert').textContent).toBe('This requisition cannot be copied: its designation is no longer active in this company.'));
    // Nothing was copied: the source stays open.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Requisition REQ-000103');
  });

  it('lets HR close an approved requisition, keeping the reason when a close is refused', async () => {
    let refusal: Reply | undefined = [409, { error: 'OPEN_OFFERS', message: 'Finish, withdraw or hand over the open offers before closing the requisition' }];
    serve({ [`POST /v1/hiring/requisitions/${R_APPROVED}/close`]: () => refusal });
    renderAt(`/hiring/requisitions/${R_APPROVED}`, [READ, CLOSE], { employeeId: null });
    const actions = await findSection('Actions');
    // Not linked to an employee: no copy.
    expect(within(actions).queryByRole('button', { name: 'Copy to a new requisition' })).toBeNull();
    fireEvent.click(button(actions, 'Close requisition'));
    const form = within(actions).getByRole('form', { name: 'Close this requisition' });
    change(form, 'Reason for closing (required)', 'Synthetic: positions filled');
    fireEvent.click(button(form, 'Close this requisition'));
    expect((await within(actions).findByRole('alert')).textContent).toBe('Finish, withdraw or hand over the open offers before closing the requisition.');
    expect(field(form, 'Reason for closing (required)').value).toBe('Synthetic: positions filled');

    refusal = undefined;
    await waitFor(() => expect(button(form, 'Close this requisition').disabled).toBe(false));
    fireEvent.click(button(form, 'Close this requisition'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Requisition closed.'));
    expect(bodiesTo('POST', `/v1/hiring/requisitions/${R_APPROVED}/close`)).toEqual([{ reason: 'Synthetic: positions filled' }, { reason: 'Synthetic: positions filled' }]);
    await waitFor(() => expect(valueIn(screen.getByRole('heading', { name: 'Synthetic data analyst' }).closest('section')!, 'State')).toBe('closed'));
    expect(screen.queryByRole('heading', { name: 'Actions' })).toBeNull();
  });

  it('says in plain sentences why a draft came back and whom a requisition waits for', async () => {
    const overrides: Record<string, Route> = {
      [`GET /v1/hiring/requisitions/${R_DRAFT}`]: () => [
        200,
        {
          ...db.requisitions.get(R_DRAFT)!,
          currentRevision: 1,
          decisions: [{ revision: 1, step: 1, action: 'validate', decision: 'RETURN', reason: 'Synthetic: add the skills needed', decidedAt: VALIDATED_AT, decidedBy: RAVI_USER }],
        },
      ],
      [`GET /v1/hiring/requisitions/${R_TEAM}`]: () => [
        200,
        {
          ...db.requisitions.get(R_TEAM)!,
          pendingWith: { taskId: T_VALIDATE, step: 1, action: 'validate', assignee: { userId: U_ME, employeeCode: 'SYN-001', displayName: 'Asha Synthetic' }, assignedAt: ASSIGNED_AT },
        },
      ],
    };
    serve(overrides);
    renderAt(`/hiring/requisitions/${R_DRAFT}`, [READ]);
    const facts = await findSection('Synthetic platform engineer');
    expect(within(facts).getByRole('note').textContent).toBe(`Returned for changes by Ravi Synthetic (SYN-002) on ${localTime(VALIDATED_AT)}: Synthetic: add the skills needed`);
    expect(bodyRows(screen.getByRole('table', { name: 'Approval history' })).map(cells)).toEqual([
      ['1', 'Step 1: Validation', 'Returned for changes', 'Ravi Synthetic (SYN-002)', localTime(VALIDATED_AT), 'Synthetic: add the skills needed'],
    ]);
    cleanup();

    serve(overrides);
    renderAt(`/hiring/requisitions/${R_TEAM}`, [READ]);
    expect((await findSection('Synthetic QA analyst')).textContent).toContain(`Waiting for you: Step 1: Validation, since ${localTime(ASSIGNED_AT)}.`);
  });

  it('keeps a refusal in view when the reloaded requisition leaves nothing to do', async () => {
    serve({
      [`POST /v1/hiring/requisitions/${R_APPROVED}/close`]: () => {
        // Closed by another HR user a moment earlier.
        db.requisitions.get(R_APPROVED)!.state = 'CLOSED';
        return [409, INVALID_STATE];
      },
    });
    renderAt(`/hiring/requisitions/${R_APPROVED}`, [READ, CLOSE], { employeeId: null });
    const actions = await findSection('Actions');
    fireEvent.click(button(actions, 'Close requisition'));
    const form = within(actions).getByRole('form', { name: 'Close this requisition' });
    change(form, 'Reason for closing (required)', 'Synthetic: positions filled');
    fireEvent.click(button(form, 'Close this requisition'));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Actions' })).toBeNull());
    expect(screen.getByRole('alert').textContent).toBe('Only an approved requisition can be closed. It has been reloaded.');
    expect(valueIn(await findSection('Synthetic data analyst'), 'State')).toBe('closed');
  });

  it('offers changes only to the requester, and only what the state and the permissions allow', async () => {
    serve();
    renderAt(`/hiring/requisitions/${R_TEAM}`, [READ, CREATE]);
    const actions = await findSection('Actions');
    expect(within(actions).getByText('Only the requester, Meera Synthetic (SYN-003), can withdraw this requisition.')).toBeTruthy();
    expect(within(actions).queryByRole('button', { name: 'Withdraw' })).toBeNull();
    expect(within(actions).getByRole('button', { name: 'Copy to a new requisition' })).toBeTruthy();
    cleanup();

    serve();
    renderAt(`/hiring/requisitions/${R_DRAFT}`, [READ]);
    await screen.findByRole('heading', { level: 1, name: 'Requisition REQ-000101' });
    expect(screen.queryByRole('heading', { name: 'Actions' })).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();

    serve();
    renderAt(`/hiring/requisitions/${R_APPROVED}`, [READ, CREATE]);
    const approved = await findSection('Actions');
    expect(within(approved).queryByRole('button', { name: 'Close requisition' })).toBeNull();
    expect(within(approved).queryByRole('button', { name: 'Edit draft' })).toBeNull();
  });

  it('reloads the requisition after a stale version and says so', async () => {
    serve({ [`POST /v1/hiring/requisitions/${R_DRAFT}/submit`]: [409, STALE] });
    renderAt(`/hiring/requisitions/${R_DRAFT}`, [READ, CREATE]);
    const actions = await findSection('Actions');
    fireEvent.click(button(actions, 'Submit for approval'));
    expect((await within(actions).findByRole('alert')).textContent).toBe('The requisition changed since it was loaded. It has been reloaded: check it and try again.');
    await waitFor(() => expect(callsTo('GET', `/v1/hiring/requisitions/${R_DRAFT}`)).toHaveLength(2));
  });

  it('says when a requisition is not available, without asking for a malformed one', async () => {
    serve();
    renderAt('/hiring/requisitions/not-a-requisition', [READ]);
    expect(screen.getByText('This requisition is not available in the selected role’s scope.')).toBeTruthy();
    await settle();
    expect(calls).toHaveLength(0);
    cleanup();

    serve();
    renderAt('/hiring/requisitions/30000000-0000-4000-8000-000000000999', [READ]);
    expect(await screen.findByText('This requisition is not available in the selected role’s scope.')).toBeTruthy();
    cleanup();

    serve();
    renderAt(`/hiring/requisitions/${R_DRAFT}`, []);
    expect(screen.getByText('The selected role cannot view requisitions.')).toBeTruthy();
    await settle();
    expect(calls).toHaveLength(0);
  });
});

describe('requisition decision queue (F1: validation, then HR budget and headcount approval)', () => {
  it('validates as the direct manager with an idempotency key, sending nothing twice while in flight', async () => {
    serve();
    renderQueue('Requisition validations', [READ, VALIDATE]);
    const item = await queueItem('REQ-000106: Synthetic QA analyst');
    const queue = screen.getByRole('region', { name: 'Requisition validations' });
    // Validations only: the HR step of another requisition (in the same task list) is not this queue's.
    expect(within(queue).getByRole('heading', { level: 2 }).textContent).toBe('Requisition validations (1)');
    expect(within(queue).queryByRole('listitem', { name: 'REQ-000107: Synthetic support engineer' })).toBeNull();
    expect(within(item).getByText(/^Step 1: Validation · assigned/).textContent).toBe(`Step 1: Validation · assigned ${localTime(ASSIGNED_AT)}`);
    expect(valueIn(item, 'Requester')).toBe('Meera Synthetic (SYN-003)');
    expect(valueIn(item, 'Department')).toBe('Finance');
    expect(item.textContent).toContain('Within budget Within the approved budget. Approved headcount 2, already committed 0, this requisition 1.');
    expect(within(item).getByRole('link', { name: 'Open REQ-000106' }).getAttribute('href')).toBe(`/hiring/requisitions/${R_TEAM}`);
    expect(within(item).queryByLabelText('Approve the budget exception')).toBeNull();

    const release = hold(`POST /v1/hiring/requisition-tasks/${T_VALIDATE}/decision`);
    fireEvent.click(button(item, 'Validate'));
    await waitFor(() => expect(callsTo('POST', `/v1/hiring/requisition-tasks/${T_VALIDATE}/decision`)).toHaveLength(1));
    await waitFor(() => expect(button(item, 'Validate').disabled).toBe(true));
    expect(button(item, 'Return for changes').disabled).toBe(true);
    expect(button(item, 'Reject').disabled).toBe(true);
    fireEvent.click(button(item, 'Validate'));
    await settle();
    expect(bodiesTo('POST', `/v1/hiring/requisition-tasks/${T_VALIDATE}/decision`)).toEqual([{ decision: 'APPROVE', idempotencyKey: KEY('hiring-requisition') }]);

    await act(async () => release());
    expect((await within(queue).findByRole('status')).textContent).toBe('Validated REQ-000106. It now waits for HR budget and headcount approval.');
    expect(within(queue).queryByRole('listitem', { name: 'REQ-000106: Synthetic QA analyst' })).toBeNull();
    // The decided item went away; focus stays in the queue.
    expect(document.activeElement).toBe(queue);
    await waitFor(() => expect(callsTo('GET', '/v1/hiring/requisition-tasks')).toHaveLength(2));
    // What is left in the task list is another step's: nothing waits for this role's validation.
    expect(await within(queue).findByText('No requisitions are waiting for your validation.')).toBeTruthy();
    expect(screen.queryByRole('listitem', { name: 'REQ-000107: Synthetic support engineer' })).toBeNull();
  });

  it('returns or rejects only with a reason, and sends it', async () => {
    serve();
    renderQueue('Requisition validations', [READ, VALIDATE]);
    const item = await queueItem('REQ-000106: Synthetic QA analyst');
    fireEvent.click(button(item, 'Return for changes'));
    expect((await within(item).findByRole('alert')).textContent).toBe('Enter a reason to return the requisition for changes.');
    fireEvent.click(button(item, 'Reject'));
    await waitFor(() => expect(within(item).getByRole('alert').textContent).toBe('Enter a reason to reject the requisition.'));
    await settle();
    expect(callsTo('POST', `/v1/hiring/requisition-tasks/${T_VALIDATE}/decision`)).toHaveLength(0);
    change(item, 'Decision reason (required to return or reject)', '  Synthetic: add the skills needed ');
    fireEvent.click(button(item, 'Return for changes'));
    await waitFor(() =>
      expect(bodiesTo('POST', `/v1/hiring/requisition-tasks/${T_VALIDATE}/decision`)).toEqual([
        { decision: 'RETURN', reason: 'Synthetic: add the skills needed', idempotencyKey: KEY('hiring-requisition') },
      ]),
    );
    expect((await within(screen.getByRole('region', { name: 'Requisition validations' })).findByRole('status')).textContent).toBe('Returned REQ-000106 to the requester for changes.');
  });

  it('approves the budget and headcount only with an explicit approval of the budget exception', async () => {
    serve();
    renderQueue('Requisition budget and headcount approvals', [READ, APPROVE]);
    const item = await queueItem('REQ-000107: Synthetic support engineer');
    expect(within(item).getByText(/^Step 2: Budget and headcount approval · assigned/)).toBeTruthy();
    // Submitted with its exception reason: what is left is the HR approver's explicit approval.
    expect(item.textContent).toContain('Exceeds budget Exceeds the approved budget: the HR approver approves its budget exception explicitly.');
    expect(item.textContent).toContain('Approved headcount 4, already committed 4, this requisition 1.');
    expect(item.textContent).toContain('Budget exception reason: Synthetic: replaces a leaver before the budget review');
    expect(valueIn(item, 'Employment type')).toBe('Fixed term');
    expect(valueIn(item, 'New or replacement')).toBe('Replacement');
    const tick = within(item).getByLabelText('Approve the budget exception') as HTMLInputElement;
    expect(tick.checked).toBe(false);
    // The validation step of another requisition (in the same task list) is not this queue's.
    expect(screen.queryByRole('listitem', { name: 'REQ-000106: Synthetic QA analyst' })).toBeNull();

    fireEvent.click(button(item, 'Approve'));
    expect((await within(item).findByRole('alert')).textContent).toBe(
      'The requisition exceeds its approved budget (approved headcount 4, already committed 4, requested 1). Tick “Approve the budget exception” to approve it, or return or reject it.',
    );
    // The budget moved since the queue was loaded: it reloads to show the check as it is now.
    await waitFor(() => expect(callsTo('GET', '/v1/hiring/requisition-tasks')).toHaveLength(2));
    fireEvent.click(tick);
    await waitFor(() => expect(button(item, 'Approve').disabled).toBe(false));
    fireEvent.click(button(item, 'Approve'));
    await waitFor(() => expect(callsTo('POST', `/v1/hiring/requisition-tasks/${T_APPROVE}/decision`)).toHaveLength(2));
    const sent = bodiesTo('POST', `/v1/hiring/requisition-tasks/${T_APPROVE}/decision`) as { idempotencyKey: string }[];
    expect(sent).toEqual([
      { decision: 'APPROVE', idempotencyKey: KEY('hiring-requisition') },
      { decision: 'APPROVE', approveBudgetException: true, idempotencyKey: KEY('hiring-requisition') },
    ]);
    // Approving the exception is another decision: another key.
    expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
    expect((await within(screen.getByRole('region', { name: 'Requisition budget and headcount approvals' })).findByRole('status')).textContent).toBe(
      'Approved REQ-000107 and its budget exception.',
    );
  });

  it('says a requisition that now exceeds its budget without a recorded exception cannot be approved, and reloads it', async () => {
    serve({
      [`POST /v1/hiring/requisition-tasks/${T_APPROVE}/decision`]: [
        409,
        {
          error: 'BUDGET_EXCEPTION_REQUIRED',
          message: 'The requisition now exceeds its budget and records no exception; return it to the requester',
          details: { budgetStatus: 'EXCEEDS_BUDGET', approvedHeadcount: 4, committed: 4, requested: 1 },
        },
      ],
    });
    // Within budget when it was submitted (no exception reason); approvals since then used up the line.
    db.requisitionTasks[1]!.requisition = { ...db.requisitions.get(R_HR)!, budgetExceptionReason: null };
    renderQueue('Requisition budget and headcount approvals', [READ, APPROVE]);
    const item = await queueItem('REQ-000107: Synthetic support engineer');
    expect(item.textContent).toContain(
      'Exceeds budget Exceeds the approved budget: it records no budget exception reason, so it cannot be approved as it stands: it can be returned to the requester or rejected.',
    );
    // No exception was recorded, so there is none to approve.
    expect(within(item).queryByLabelText('Approve the budget exception')).toBeNull();
    fireEvent.click(button(item, 'Approve'));
    expect((await within(item).findByRole('alert')).textContent).toBe(
      'The requisition exceeds its approved budget (approved headcount 4, already committed 4, requested 1). It records no exception reason, so it cannot be approved: return it to the requester or reject it.',
    );
    await waitFor(() => expect(callsTo('GET', '/v1/hiring/requisition-tasks')).toHaveLength(2));
    // Nothing was recorded: the task stays to be returned or rejected.
    expect(button(item, 'Return for changes')).toBeTruthy();
  });

  it('says the API’s refusals in plain words, keeps the reason, and drops a task decided elsewhere', async () => {
    let refusal: Reply = [422, { error: 'NO_ELIGIBLE_REVIEWER', message: 'No eligible reviewer is configured for this request; contact HR to repair routing' }];
    serve({ [`POST /v1/hiring/requisition-tasks/${T_VALIDATE}/decision`]: () => refusal });
    renderQueue('Requisition validations', [READ, VALIDATE]);
    const item = await queueItem('REQ-000106: Synthetic QA analyst');
    change(item, 'Decision reason (required to return or reject)', 'Synthetic note');
    fireEvent.click(button(item, 'Validate'));
    expect((await within(item).findByRole('alert')).textContent).toBe(
      'No eligible HR Administrator is left for the budget and headcount approval: neither the requester nor you may take that step. Ask HR to add a reviewer to the requisition reviewer list; your decision was not recorded.',
    );
    expect(field(item, 'Decision reason (required to return or reject)').value).toBe('Synthetic note');

    refusal = [409, { error: 'TASK_CLOSED', message: 'This task has already been decided' }];
    await waitFor(() => expect(button(item, 'Validate').disabled).toBe(false));
    fireEvent.click(button(item, 'Validate'));
    const queue = screen.getByRole('region', { name: 'Requisition validations' });
    expect((await within(queue).findByRole('alert')).textContent).toBe('This task has already been decided or withdrawn.');
    expect(within(queue).queryByRole('listitem', { name: 'REQ-000106: Synthetic QA analyst' })).toBeNull();
  });

  it('reloads the queue when the requisition changed while the decision was recorded, as the refusal says', async () => {
    serve({ [`POST /v1/hiring/requisition-tasks/${T_VALIDATE}/decision`]: [409, STALE] });
    renderQueue('Requisition validations', [READ, VALIDATE]);
    const item = await queueItem('REQ-000106: Synthetic QA analyst');
    fireEvent.click(button(item, 'Validate'));
    expect((await within(item).findByRole('alert')).textContent).toBe('The requisition changed since it was loaded. It has been reloaded: check it and try again.');
    await waitFor(() => expect(callsTo('GET', '/v1/hiring/requisition-tasks')).toHaveLength(2));
  });

  it('sends the same key again after a lost answer, so the decision is answered and never applied twice', async () => {
    serve();
    renderQueue('Requisition validations', [READ, VALIDATE]);
    const item = await queueItem('REQ-000106: Synthetic QA analyst');
    loseAnswer(`POST /v1/hiring/requisition-tasks/${T_VALIDATE}/decision`);
    fireEvent.click(button(item, 'Validate'));
    expect((await within(item).findByRole('alert')).textContent).toBe(
      'No answer came back, so your decision may or may not have been recorded. Send the same decision again: it is never applied twice.',
    );
    fireEvent.click(button(item, 'Validate'));
    expect((await within(screen.getByRole('region', { name: 'Requisition validations' })).findByRole('status')).textContent).toBe(
      'Your earlier decision on REQ-000106 had already been recorded, so nothing was applied twice. Its state is now: submitted.',
    );
    const keys = (bodiesTo('POST', `/v1/hiring/requisition-tasks/${T_VALIDATE}/decision`) as { idempotencyKey: string }[]).map((b) => b.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it('offers each step’s queue only with that step’s duty and the read permission, also on the requisitions screen', async () => {
    serve();
    // A reader without a decision duty (a Recruiter) is offered no queue; a duty without the read cannot list tasks.
    for (const [title, permissions] of [
      ['Requisition validations', [READ]],
      ['Requisition budget and headcount approvals', [READ]],
      ['Requisition validations', [VALIDATE, APPROVE]],
      ['Requisition budget and headcount approvals', [VALIDATE, APPROVE]],
      ['Requisition validations', [READ, APPROVE]],
      ['Requisition budget and headcount approvals', [READ, VALIDATE]],
    ] as const) {
      const rendered = renderQueue(title, [...permissions]);
      expect(rendered.container.innerHTML).toBe('');
      cleanup();
    }
    await settle();
    expect(calls).toHaveLength(0);

    // A manager validates: the validation queue only.
    serve();
    renderAt('/hiring/requisitions', [READ, VALIDATE]);
    const validations = await screen.findByRole('region', { name: 'Requisition validations' });
    expect(await within(validations).findByRole('listitem', { name: 'REQ-000106: Synthetic QA analyst' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Requisition budget and headcount approvals' })).toBeNull();
    expect(await screen.findByRole('table', { name: 'Requisitions' })).toBeTruthy();
    cleanup();

    // An HR Administrator holds both duties: two queues from one request, each with its own step's task.
    serve();
    renderAt('/hiring/requisitions', [READ, VALIDATE, APPROVE]);
    const first = await screen.findByRole('region', { name: 'Requisition validations' });
    const second = screen.getByRole('region', { name: 'Requisition budget and headcount approvals' });
    expect(await within(first).findByRole('listitem', { name: 'REQ-000106: Synthetic QA analyst' })).toBeTruthy();
    expect(within(first).queryByRole('listitem', { name: 'REQ-000107: Synthetic support engineer' })).toBeNull();
    expect(within(second).getByRole('listitem', { name: 'REQ-000107: Synthetic support engineer' })).toBeTruthy();
    expect(within(second).queryByRole('listitem', { name: 'REQ-000106: Synthetic QA analyst' })).toBeNull();
    expect(callsTo('GET', '/v1/hiring/requisition-tasks')).toHaveLength(1);
  });
});

describe('manpower budgets (FR-011)', () => {
  it('lists the budget lines with the filters the API offers, and never invents a headcount', async () => {
    serve();
    renderAt('/hiring/budgets', [BUDGET_READ, ORG_READ]);
    const table = await screen.findByRole('table', { name: 'Budget lines' });
    expect(headers(table)).toEqual(['Department', 'Location', 'Designation', 'Period', 'Headcount in force', 'Committed', 'Revision in progress', 'Budget line']);
    expect(cells(rowWith(table, 'Developer'))).toEqual(['Engineering', 'Head office', 'Developer', '2026-04-01 to 2027-03-31', '3', '2', '—', 'Open']);
    expect(cells(rowWith(table, 'Tester'))).toEqual(['Engineering', 'Head office', 'Tester', '2026-04-01 to 2027-03-31', 'None approved yet', '0', 'Revision 1: headcount 2 (draft)', 'Open']);
    expect(within(table).getByRole('link', { name: 'Open the budget line Engineering, Head office, Developer (2026-04-01 to 2027-03-31)' }).getAttribute('href')).toBe(`/hiring/budgets/${B_DEV}`);
    expect(lastParams('/v1/hiring/budgets')).toEqual({});

    const register = await findSection('Budget lines');
    await within(register).findByRole('option', { name: 'Tester (QA)' });
    change(register, 'Designation', QA.id);
    await waitFor(() => expect(lastParams('/v1/hiring/budgets')).toEqual({ designationId: QA.id }));
    await waitFor(() => expect(bodyRows(screen.getByRole('table', { name: 'Budget lines' }))).toHaveLength(1));
    change(register, 'Department', ENG.id);
    change(register, 'Location', HQ.id);
    change(register, 'In force on', '2027-06-01');
    await waitFor(() => expect(lastParams('/v1/hiring/budgets')).toEqual({ departmentId: ENG.id, locationId: HQ.id, designationId: QA.id, on: '2027-06-01' }));
    expect(await within(register).findByText('No budget lines match these filters.')).toBeTruthy();
  });

  it('adds a budget line with a draft first revision, starting the form clean', async () => {
    serve();
    renderAt('/hiring/budgets', [BUDGET_READ, BUDGET_MANAGE, ORG_READ]);
    const form = await screen.findByRole('form', { name: 'Add a budget line' });
    await within(form).findByRole('option', { name: 'Finance (FIN)' });
    fireEvent.click(button(form, 'Add budget line'));
    expect((await within(form).findByRole('alert')).textContent).toBe('Choose the department.');
    change(form, 'Department', FIN.id);
    change(form, 'Location', PUNE.id);
    change(form, 'Designation', QA.id);
    change(form, 'Period start', '2026-11-01');
    fireEvent.click(button(form, 'Add budget line'));
    await waitFor(() => expect(within(form).getByRole('alert').textContent).toBe('Enter the last day of the period.'));
    change(form, 'Period end', '2027-03-31');
    change(form, 'Headcount', '4');
    change(form, 'Reason (required)', '  Synthetic plan for the new team ');
    const release = hold('POST /v1/hiring/budgets');
    fireEvent.click(button(form, 'Add budget line'));
    await waitFor(() => expect(callsTo('POST', '/v1/hiring/budgets')).toHaveLength(1));
    await waitFor(() => expect(button(form, 'Add budget line').disabled).toBe(true));
    expect(bodiesTo('POST', '/v1/hiring/budgets')).toEqual([
      { departmentId: FIN.id, locationId: PUNE.id, designationId: QA.id, periodStart: '2026-11-01', periodEnd: '2027-03-31', headcount: 4, reason: 'Synthetic plan for the new team' },
    ]);
    await act(async () => release());
    const done = await within(form).findByRole('status');
    expect(done.textContent).toBe('Budget line added for Finance, Pune office, Tester: draft revision 1 with headcount 4. Open the line to submit the revision for approval.');
    expect(within(done).getByRole('link').getAttribute('href')).toBe(`/hiring/budgets/${B_NEW}`);
    for (const label of ['Department', 'Location', 'Designation', 'Period start', 'Period end', 'Headcount', 'Reason (required)']) expect(field(form, label).value).toBe('');
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Budget lines' })).getByText('Finance')).toBeTruthy());
  });

  it('keeps what was typed when a budget line is refused, and says why', async () => {
    let refusal: Reply = [409, { error: 'OVERLAPPING_PERIOD', message: 'The effective period overlaps an existing record' }];
    serve({ 'POST /v1/hiring/budgets': () => refusal });
    renderAt('/hiring/budgets', [BUDGET_MANAGE, ORG_READ]);
    const form = await screen.findByRole('form', { name: 'Add a budget line' });
    await within(form).findByRole('option', { name: 'Engineering (ENG)' });
    change(form, 'Department', ENG.id);
    change(form, 'Location', HQ.id);
    change(form, 'Designation', DEV.id);
    change(form, 'Period start', '2026-10-01');
    change(form, 'Period end', '2026-12-31');
    change(form, 'Headcount', '0');
    change(form, 'Reason (required)', 'Synthetic freeze');
    fireEvent.click(button(form, 'Add budget line'));
    expect((await within(form).findByRole('alert')).textContent).toBe(
      'A budget line for this department, location and designation already covers part of that period. Add a revision to that line instead.',
    );
    expect(field(form, 'Department').value).toBe(ENG.id);
    expect(field(form, 'Headcount').value).toBe('0');
    expect(field(form, 'Reason (required)').value).toBe('Synthetic freeze');
    refusal = [422, { error: 'INVALID_PERIOD', message: 'The period ends before it starts' }];
    fireEvent.click(button(form, 'Add budget line'));
    await waitFor(() => expect(within(form).getByRole('alert').textContent).toBe('The period ends before it starts.'));
    expect(bodiesTo('POST', '/v1/hiring/budgets')).toHaveLength(2);
    expect((bodiesTo('POST', '/v1/hiring/budgets')[0] as { headcount: number }).headcount).toBe(0);
  });

  it('shows budgets only with the read permission, the form only with manage, and the queue only to approvers', async () => {
    serve();
    renderAt('/hiring/budgets', []);
    expect(screen.getByText('The selected role cannot view manpower budgets.')).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Manpower budget approvals' })).toBeNull();
    await settle();
    expect(calls).toHaveLength(0);
    cleanup();

    serve();
    renderAt('/hiring/budgets', [BUDGET_READ]);
    await screen.findByRole('table', { name: 'Budget lines' });
    expect(screen.queryByRole('heading', { name: 'Add a budget line' })).toBeNull();
    expect(screen.queryByLabelText('Department')).toBeNull();
    expect(callsTo('GET', '/v1/hiring/budget-tasks')).toHaveLength(0);
    cleanup();

    serve();
    renderAt('/hiring/budgets', [BUDGET_READ, BUDGET_MANAGE]);
    const add = await findSection('Add a budget line');
    expect(within(add).getByText('The selected role cannot list departments, locations and designations, so it cannot add a budget line here.')).toBeTruthy();
    cleanup();

    serve();
    renderAt('/hiring/budgets', [BUDGET_READ, BUDGET_APPROVE]);
    expect(await screen.findByRole('region', { name: 'Manpower budget approvals' })).toBeTruthy();
  });
});

describe('one budget line and its revisions', () => {
  it('shows the line and its revision history by what the server returned', async () => {
    serve();
    renderAt(`/hiring/budgets/${B_DEV}`, [BUDGET_READ]);
    const summary = await findSection('Engineering, Head office, Developer');
    expect(valueIn(summary, 'Period')).toBe('2026-04-01 to 2027-03-31');
    expect(valueIn(summary, 'Headcount in force')).toBe('3');
    expect(valueIn(summary, 'Committed')).toBe('2');
    const history = screen.getByRole('table', { name: 'Revision history' });
    expect(headers(history)).toEqual(['Revision', 'Headcount', 'Reason', 'State', 'Prepared by', 'Submitted', 'Decided', 'Decided by']);
    expect(bodyRows(history).map(cells)).toEqual([
      ['2', '4', 'Synthetic increase', 'rejected', 'You', localTime(SUBMITTED_AT), localTime(DECIDED_AT), 'Another user'],
      ['1', '3', 'Synthetic plan', 'approved', 'Another user', localTime(SUBMITTED_AT), localTime(VALIDATED_AT), 'You'],
    ]);
    // Reading only: no revision can be started.
    expect(screen.queryByRole('heading', { name: 'New revision' })).toBeNull();
    cleanup();

    serve();
    renderAt(`/hiring/budgets/${B_QA}`, [BUDGET_READ]);
    expect(valueIn(await findSection('Engineering, Head office, Tester'), 'Headcount in force')).toBe('None approved yet');
  });

  it('prepares a new revision, changes it, submits it and withdraws it as its preparer', async () => {
    serve();
    renderAt(`/hiring/budgets/${B_DEV}`, [BUDGET_READ, BUDGET_MANAGE]);
    const fresh = within(await findSection('New revision')).getByRole('form', { name: 'New revision' });
    fireEvent.click(button(fresh, 'Save draft revision'));
    expect((await within(fresh).findByRole('alert')).textContent).toBe('Enter the headcount as a whole number (0 or more).');
    change(fresh, 'Headcount', '4');
    change(fresh, 'Reason (required)', ' Synthetic: second team ');
    fireEvent.click(button(fresh, 'Save draft revision'));
    await waitFor(() => expect(bodiesTo('POST', `/v1/hiring/budgets/${B_DEV}/revisions`)).toEqual([{ headcount: 4, reason: 'Synthetic: second team' }]));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Draft revision 3 saved with headcount 4. Submit it for approval when it is ready.'));
    const open = await findSection('Revision 3 in progress');
    expect(valueIn(open, 'Prepared by')).toBe('You');
    expect(screen.queryByRole('heading', { name: 'New revision' })).toBeNull();

    fireEvent.click(button(open, 'Change draft'));
    const edit = within(open).getByRole('form', { name: 'Change draft revision 3' });
    expect(field(edit, 'Headcount').value).toBe('4');
    expect(field(edit, 'Reason (required)').value).toBe('Synthetic: second team');
    change(edit, 'Headcount', '5');
    fireEvent.click(button(edit, 'Save draft'));
    await waitFor(() => expect(bodiesTo('PUT', `/v1/hiring/budget-revisions/${V_NEW}`)).toEqual([{ headcount: 5, reason: 'Synthetic: second team', expectedVersion: 1 }]));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Draft revision saved with headcount 5.'));
    expect(within(open).queryByRole('form')).toBeNull();

    await waitFor(() => expect(valueIn(open, 'Headcount')).toBe('5'));
    const submit = button(open, 'Submit for approval');
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(bodiesTo('POST', `/v1/hiring/budget-revisions/${V_NEW}/submit`)).toEqual([{ expectedVersion: 2 }]));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'Revision submitted. An independent HR Administrator approves or rejects it; the headcount in force changes only when it is approved.',
      ),
    );
    await waitFor(() => expect(within(open).getByText('Waiting for an independent HR Administrator’s decision.')).toBeTruthy());
    expect(within(open).queryByRole('button', { name: 'Change draft' })).toBeNull();

    const withdraw = button(open, 'Withdraw revision');
    await waitFor(() => expect(withdraw.disabled).toBe(false));
    fireEvent.click(withdraw);
    await waitFor(() => expect(bodiesTo('POST', `/v1/hiring/budget-revisions/${V_NEW}/withdraw`)).toEqual([undefined]));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Revision withdrawn.'));
    const again = within(await findSection('New revision')).getByRole('form', { name: 'New revision' });
    expect(field(again, 'Headcount').value).toBe('');
    expect(field(again, 'Reason (required)').value).toBe('');
  });

  it('leaves another preparer’s revision to them, and says why a new revision is refused', async () => {
    serve();
    renderAt(`/hiring/budgets/${B_QA}`, [BUDGET_READ, BUDGET_MANAGE]);
    const open = await findSection('Revision 1 in progress');
    expect(valueIn(open, 'Prepared by')).toBe('Another user');
    expect(within(open).getByText('Another HR user prepared this revision; only they can change, submit or withdraw it.')).toBeTruthy();
    expect(within(open).queryByRole('button')).toBeNull();
    cleanup();

    serve({ [`POST /v1/hiring/budgets/${B_DEV}/revisions`]: [409, { error: 'OPEN_REVISION_EXISTS', message: 'This budget already has a revision in progress' }] });
    renderAt(`/hiring/budgets/${B_DEV}`, [BUDGET_READ, BUDGET_MANAGE]);
    const fresh = within(await findSection('New revision')).getByRole('form', { name: 'New revision' });
    change(fresh, 'Headcount', '6');
    change(fresh, 'Reason (required)', 'Synthetic: another');
    fireEvent.click(button(fresh, 'Save draft revision'));
    expect((await screen.findByText(/^This budget line already has a revision in progress/)).textContent).toBe(
      'This budget line already has a revision in progress. Finish or withdraw it first.',
    );
    expect(field(fresh, 'Headcount').value).toBe('6');
  });
});

describe('manpower budget decision queue (independent HR approval)', () => {
  it('approves a revision without a reason and rejects one only with a reason, sending nothing twice while in flight', async () => {
    serve();
    renderQueue('Manpower budget approvals', [BUDGET_APPROVE, BUDGET_READ]);
    const fin = await queueItem('Revision 2: Finance, Pune office, Developer');
    expect(valueIn(fin, 'Period')).toBe('2026-04-01 to 2027-03-31');
    expect(valueIn(fin, 'Proposed headcount')).toBe('4');
    expect(valueIn(fin, 'Headcount in force')).toBe('1');
    expect(valueIn(fin, 'Committed')).toBe('0');
    expect(valueIn(fin, 'Reason')).toBe('Synthetic: new client team');
    expect(within(fin).getByRole('link', { name: 'Open the budget line' }).getAttribute('href')).toBe(`/hiring/budgets/${B_FIN}`);

    const release = hold(`POST /v1/hiring/budget-tasks/${BT_FIN}/decision`);
    fireEvent.click(button(fin, 'Approve'));
    await waitFor(() => expect(callsTo('POST', `/v1/hiring/budget-tasks/${BT_FIN}/decision`)).toHaveLength(1));
    await waitFor(() => expect(button(fin, 'Approve').disabled).toBe(true));
    expect(button(fin, 'Reject').disabled).toBe(true);
    fireEvent.click(button(fin, 'Reject'));
    await settle();
    expect(bodiesTo('POST', `/v1/hiring/budget-tasks/${BT_FIN}/decision`)).toEqual([{ decision: 'APPROVE', idempotencyKey: KEY('hiring-budget') }]);
    await act(async () => release());
    const queue = screen.getByRole('region', { name: 'Manpower budget approvals' });
    expect((await within(queue).findByRole('status')).textContent).toBe('Approved revision 2 for Finance, Pune office, Developer: headcount 4 is now in force.');

    const ops = await queueItem('Revision 1: Engineering, Pune office, Tester');
    expect(valueIn(ops, 'Headcount in force')).toBe('None approved yet');
    fireEvent.click(button(ops, 'Reject'));
    expect((await within(ops).findByRole('alert')).textContent).toBe('Enter a reason to reject the revision.');
    await settle();
    expect(callsTo('POST', `/v1/hiring/budget-tasks/${BT_OPS}/decision`)).toHaveLength(0);
    change(ops, 'Decision reason (required to reject)', 'Synthetic: no desk budget this year');
    fireEvent.click(button(ops, 'Reject'));
    await waitFor(() =>
      expect(bodiesTo('POST', `/v1/hiring/budget-tasks/${BT_OPS}/decision`)).toEqual([
        { decision: 'REJECT', reason: 'Synthetic: no desk budget this year', idempotencyKey: KEY('hiring-budget') },
      ]),
    );
    await waitFor(() => expect(within(queue).getByRole('status').textContent).toBe('Rejected revision 1 for Engineering, Pune office, Tester; the headcount in force is unchanged.'));
    expect(await within(queue).findByText('No budget revisions are waiting for your decision.')).toBeTruthy();
  });

  it('is shown only to approvers, linking to the line only for readers, and drops a task decided elsewhere', async () => {
    serve();
    const reader = renderQueue('Manpower budget approvals', [BUDGET_READ, BUDGET_MANAGE]);
    expect(reader.container.innerHTML).toBe('');
    await settle();
    expect(calls).toHaveLength(0);
    cleanup();

    serve({ [`POST /v1/hiring/budget-tasks/${BT_FIN}/decision`]: [409, { error: 'TASK_CLOSED', message: 'This task has already been decided' }] });
    renderQueue('Manpower budget approvals', [BUDGET_APPROVE]);
    const fin = await queueItem('Revision 2: Finance, Pune office, Developer');
    expect(within(fin).queryByRole('link')).toBeNull();
    fireEvent.click(button(fin, 'Approve'));
    const queue = screen.getByRole('region', { name: 'Manpower budget approvals' });
    expect((await within(queue).findByRole('alert')).textContent).toBe('This task has already been decided or withdrawn.');
    expect(within(queue).queryByRole('listitem', { name: 'Revision 2: Finance, Pune office, Developer' })).toBeNull();
  });

  it('reloads the queue when the revision changed while the decision was recorded, as the refusal says', async () => {
    serve({ [`POST /v1/hiring/budget-tasks/${BT_FIN}/decision`]: [409, STALE] });
    renderQueue('Manpower budget approvals', [BUDGET_APPROVE]);
    const fin = await queueItem('Revision 2: Finance, Pune office, Developer');
    fireEvent.click(button(fin, 'Approve'));
    expect((await within(fin).findByRole('alert')).textContent).toBe('The revision changed since it was loaded. It has been reloaded: check it and try again.');
    await waitFor(() => expect(callsTo('GET', '/v1/hiring/budget-tasks')).toHaveLength(2));
  });
});
