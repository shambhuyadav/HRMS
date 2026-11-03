// Workload model: the G2 operation mix mapped onto real routes of this API, issued by fixture identities with their
// own token and context headers, plus negative probes (requests that must be denied) for ZT32/NFR-S08 checks
// under load. Each arrival is planned independently of responses (open loop); this module never waits on the system.
import { BASELINE_ROLES } from '../../apps/api/src/modules/access/baseline.js';
import type { CorrectionItem, DecisionItem, FixtureIdentity, ResubmitItem, WithdrawItem } from './manifest.js';
import { createRng, type Rng, shuffleInPlace } from './rng.js';

export type Category = 'scopedRead' | 'ownRead' | 'teamTaskRead' | 'write' | 'metadata';
export const CATEGORIES: readonly Category[] = ['scopedRead', 'ownRead', 'teamTaskRead', 'write', 'metadata'];
export const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  scopedRead: 'scoped dashboard/list reads',
  ownRead: 'own attendance/leave/profile reads',
  teamTaskRead: 'team/task/report-status reads',
  write: 'submissions/amendments/decisions',
  metadata: 'session/notification metadata',
};

export type ProfileName = 'nominal' | 'write-heavy';

/** G2 operation mix (nominal) and the separate 50% write-heavy stress mix (other shares scaled proportionally). */
export const PROFILES: Readonly<Record<ProfileName, Readonly<Record<Category, number>>>> = {
  nominal: { scopedRead: 0.5, ownRead: 0.2, teamTaskRead: 0.1, write: 0.15, metadata: 0.05 },
  'write-heavy': (() => {
    const scale = 0.5 / 0.85;
    return { scopedRead: 0.5 * scale, ownRead: 0.2 * scale, teamTaskRead: 0.1 * scale, write: 0.5, metadata: 0.05 * scale };
  })(),
};

export type ContextKind = 'primary' | 'own' | 'none';
export type TokenKind = 'live' | 'revoked' | 'expired';

export interface RequestSpec {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface PlannedRequest {
  category: Category;
  /** Operation name, or probe:<kind> for a negative probe. */
  op: string;
  kind: 'read' | 'mutation';
  probe: string | null;
  /** Position of the identity in the loaded identity list. */
  identity: number;
  context: ContextKind;
  token: TokenKind;
  spec: RequestSpec;
  /** A negative probe is correct only with one of these statuses. */
  expectStatus: readonly number[] | null;
  /** Checks that a successful body belongs to this identity (catches cache/session mix-ups). */
  validate: ((body: unknown) => boolean) | null;
  wantBody: boolean;
  /** The fixture state this request consumes (task, request or attendance record id), if any. */
  inventoryKey: string | null;
}

export interface ExhaustedArrival {
  exhausted: true;
  category: Category;
  op: string | null;
}

/** Mutable per-identity run state: the fixture states still usable in this run and how far they are consumed. */
interface IdentityState {
  inv: { decide: DecisionItem[]; resubmit: ResubmitItem[]; withdraw: WithdrawItem[]; correct: CorrectionItem[] };
  decide: number;
  resubmit: number;
  withdraw: number;
  correct: number;
  teamCursor: number;
  nextDate: string;
  paidLeft: Map<string, number>;
}

interface Build {
  context: ContextKind;
  token?: TokenKind;
  method: RequestSpec['method'];
  path: string;
  body?: unknown;
  validate?: (body: unknown) => boolean;
  expectStatus?: readonly number[];
  inventoryKey?: string;
}

interface OperationDef {
  name: string;
  category: Category;
  kind: 'read' | 'mutation';
  weight: number;
  eligible(x: FixtureIdentity, s: IdentityState): boolean;
  /** Inventory left for this identity (consumable fixture states); absent means unlimited. */
  available?(x: FixtureIdentity, s: IdentityState): boolean;
  build(x: FixtureIdentity, s: IdentityState, seq: number): Build;
}

interface ProbeDef {
  name: string;
  category: Category;
  kind: 'read' | 'mutation';
  eligible(x: FixtureIdentity): boolean;
  build(x: FixtureIdentity, seq: number): Build | null;
}

const DUTIES = new Map(BASELINE_ROLES.map((r) => [r.code, new Set<string>(r.defaultDuties)]));
const hasDuty = (x: FixtureIdentity, key: string) => DUTIES.get(x.contexts.primary.role)?.has(key) === true;

const addDays = (day: string, n: number) => {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const isWeekend = (day: string) => {
  const w = new Date(`${day}T00:00:00Z`).getUTCDay();
  return w === 0 || w === 6;
};
const nextWeekday = (day: string) => {
  let d = day;
  while (isWeekend(d)) d = addDays(d, 1);
  return d;
};
const PAID_TYPES = ['ANNUAL', 'CASUAL', 'SICK'];

function operations(runId: string, businessDate: string): OperationDef[] {
  const allocateDate = (s: IdentityState) => {
    const d = nextWeekday(s.nextDate);
    s.nextDate = addDays(d, 1);
    return d;
  };
  const leaveType = (s: IdentityState) => {
    // Paid balance first (largest remaining), then unpaid leave, so no scripted request is refused for balance.
    let best: string | null = null;
    for (const t of PAID_TYPES) if ((s.paidLeft.get(t) ?? 0) >= 1 && (best === null || s.paidLeft.get(t)! > s.paidLeft.get(best)!)) best = t;
    if (best === null) return 'UNPAID';
    s.paidLeft.set(best, s.paidLeft.get(best)! - 1);
    return best;
  };
  const attendanceRange = (x: FixtureIdentity) => {
    const to = x.attendance.to ?? businessDate;
    const earliest = addDays(to, -30);
    const from = x.attendance.from && x.attendance.from > earliest ? x.attendance.from : earliest;
    return `from=${from}&to=${to}`;
  };
  const isObject = (b: unknown): b is Record<string, unknown> => typeof b === 'object' && b !== null;
  const all = () => true;
  return [
    // 50% scoped dashboard/list reads (role context)
    { name: 'dashboard', category: 'scopedRead', kind: 'read', weight: 4, eligible: (x) => hasDuty(x, 'dashboard.read.operational'), build: () => ({ context: 'primary', method: 'GET', path: '/v1/dashboard' }) },
    {
      name: 'employee-list',
      category: 'scopedRead',
      kind: 'read',
      weight: 1,
      eligible: (x) => hasDuty(x, 'employee.list.operational'),
      build: () => ({ context: 'primary', method: 'GET', path: '/v1/employees?page=1&pageSize=25' }),
    },
    // 20% own attendance/leave/profile reads (Employee OWN context)
    { name: 'own-ess', category: 'ownRead', kind: 'read', weight: 2, eligible: all, build: () => ({ context: 'own', method: 'GET', path: '/v1/me/ess' }) },
    {
      name: 'own-leave-balances',
      category: 'ownRead',
      kind: 'read',
      weight: 2,
      eligible: all,
      build: (x) => ({ context: 'own', method: 'GET', path: `/v1/employees/${x.employeeId}/leave-balances` }),
    },
    {
      name: 'own-attendance',
      category: 'ownRead',
      kind: 'read',
      weight: 2,
      eligible: all,
      build: (x) => ({ context: 'own', method: 'GET', path: `/v1/employees/${x.employeeId}/attendance?${attendanceRange(x)}` }),
    },
    {
      name: 'own-leave-requests',
      category: 'ownRead',
      kind: 'read',
      weight: 1,
      eligible: all,
      build: (x) => ({ context: 'own', method: 'GET', path: `/v1/employees/${x.employeeId}/leave-requests` }),
    },
    {
      name: 'own-profile',
      category: 'ownRead',
      kind: 'read',
      weight: 1,
      eligible: all,
      build: (x) => ({ context: 'own', method: 'GET', path: `/v1/employees/${x.employeeId}`, validate: (b) => isObject(b) && b.id === x.employeeId }),
    },
    { name: 'own-requests', category: 'ownRead', kind: 'read', weight: 1, eligible: all, build: () => ({ context: 'own', method: 'GET', path: '/v1/me/requests' }) },
    // 10% team/task/report-status reads (role context)
    { name: 'my-team', category: 'teamTaskRead', kind: 'read', weight: 3, eligible: (x) => hasDuty(x, 'team.list.operational'), build: () => ({ context: 'primary', method: 'GET', path: '/v1/my-team?page=1&pageSize=25' }) },
    {
      name: 'team-member',
      category: 'teamTaskRead',
      kind: 'read',
      weight: 2,
      eligible: (x) => hasDuty(x, 'team.read.operational') && x.team.length > 0,
      build: (x, s) => ({ context: 'primary', method: 'GET', path: `/v1/my-team/${x.team[s.teamCursor++ % x.team.length]}` }),
    },
    { name: 'leave-tasks', category: 'teamTaskRead', kind: 'read', weight: 3, eligible: (x) => hasDuty(x, 'leave.approve.operational'), build: () => ({ context: 'primary', method: 'GET', path: '/v1/leave/tasks' }) },
    {
      name: 'correction-tasks',
      category: 'teamTaskRead',
      kind: 'read',
      weight: 1,
      eligible: (x) => hasDuty(x, 'attendance.approve_correction.operational'),
      build: () => ({ context: 'primary', method: 'GET', path: '/v1/attendance-corrections/tasks/mine' }),
    },
    {
      name: 'work-request-tasks',
      category: 'teamTaskRead',
      kind: 'read',
      weight: 1,
      eligible: (x) => hasDuty(x, 'leave.approve.operational'),
      build: () => ({ context: 'primary', method: 'GET', path: '/v1/work-requests/tasks/mine' }),
    },
    {
      name: 'profile-change-tasks',
      category: 'teamTaskRead',
      kind: 'read',
      weight: 1,
      eligible: (x) => hasDuty(x, 'employee.update.operational'),
      build: () => ({ context: 'primary', method: 'GET', path: '/v1/profile-changes/tasks/mine' }),
    },
    {
      name: 'report-status',
      category: 'teamTaskRead',
      kind: 'read',
      weight: 1,
      eligible: (x) => x.workflow.reports.length > 0,
      build: (x, s) => ({ context: 'primary', method: 'GET', path: `/v1/reports/${x.workflow.reports[s.teamCursor++ % x.workflow.reports.length]}` }),
    },
    // 15% submissions/amendments/decisions
    {
      name: 'leave-submit',
      category: 'write',
      kind: 'mutation',
      weight: 45,
      eligible: all,
      build: (_x, s) => {
        const day = allocateDate(s);
        return { context: 'own', method: 'POST', path: '/v1/leave/requests', body: { leaveType: leaveType(s), startDate: day, endDate: day, reason: 'Synthetic load request' } };
      },
    },
    {
      name: 'leave-decide',
      category: 'write',
      kind: 'mutation',
      weight: 30,
      eligible: (_x, s) => s.inv.decide.length > 0,
      available: (_x, s) => s.decide < s.inv.decide.length,
      build: (_x, s, seq) => {
        const item = s.inv.decide[s.decide++]!;
        // Every fifth decision rejects (with the reason the rules require).
        const reject = s.decide % 5 === 0;
        return {
          context: 'primary',
          method: 'POST',
          path: `/v1/leave/tasks/${item.taskId}/decision`,
          body: { decision: reject ? 'REJECT' : 'APPROVE', idempotencyKey: `${runId}-d-${seq}`, ...(reject ? { reason: 'Synthetic load decision' } : {}) },
          inventoryKey: item.taskId,
        };
      },
    },
    {
      name: 'leave-resubmit',
      category: 'write',
      kind: 'mutation',
      weight: 10,
      eligible: (_x, s) => s.inv.resubmit.length > 0,
      available: (_x, s) => s.resubmit < s.inv.resubmit.length,
      build: (_x, s) => {
        const item = s.inv.resubmit[s.resubmit++]!;
        const day = allocateDate(s);
        return {
          context: 'own',
          method: 'PUT',
          path: `/v1/leave/requests/${item.requestId}`,
          body: { startDate: day, endDate: day, expectedVersion: item.expectedVersion },
          inventoryKey: item.requestId,
        };
      },
    },
    {
      name: 'leave-withdraw',
      category: 'write',
      kind: 'mutation',
      weight: 5,
      eligible: (_x, s) => s.inv.withdraw.length > 0,
      available: (_x, s) => s.withdraw < s.inv.withdraw.length,
      build: (_x, s) => {
        const item = s.inv.withdraw[s.withdraw++]!;
        return { context: 'own', method: 'POST', path: `/v1/leave/requests/${item.requestId}/withdraw`, inventoryKey: item.requestId };
      },
    },
    {
      name: 'attendance-correction',
      category: 'write',
      kind: 'mutation',
      weight: 10,
      eligible: (_x, s) => s.inv.correct.length > 0,
      available: (_x, s) => s.correct < s.inv.correct.length,
      build: (_x, s) => {
        const item = s.inv.correct[s.correct++]!;
        return {
          context: 'own',
          method: 'POST',
          path: '/v1/me/attendance-corrections',
          body: { attendanceRecordId: item.attendanceRecordId, status: 'PRESENT', reason: 'Synthetic: punch missed' },
          inventoryKey: item.attendanceRecordId,
        };
      },
    },
    // 5% session/notification metadata
    { name: 'notifications', category: 'metadata', kind: 'read', weight: 3, eligible: all, build: () => ({ context: 'none', method: 'GET', path: '/v1/me/notifications' }) },
    {
      name: 'me-context',
      category: 'metadata',
      kind: 'read',
      weight: 2,
      eligible: all,
      build: (x) => ({
        context: 'primary',
        method: 'GET',
        path: '/v1/me/context',
        validate: (b) => isObject(b) && b.userId === x.userId && b.roleCode === x.contexts.primary.role,
      }),
    },
    { name: 'me-assignments', category: 'metadata', kind: 'read', weight: 1, eligible: all, build: () => ({ context: 'none', method: 'GET', path: '/v1/me/assignments' }) },
    { name: 'me-permissions', category: 'metadata', kind: 'read', weight: 1, eligible: all, build: () => ({ context: 'primary', method: 'GET', path: '/v1/me/permissions' }) },
  ];
}

/** Negative probes: each must be denied. A 2xx answer is an integrity failure (zero tolerance, G4). */
function probes(identities: readonly FixtureIdentity[], runId: string): ProbeDef[] {
  const byCompany = new Map<string, FixtureIdentity[]>();
  for (const x of identities) {
    const list = byCompany.get(x.companyId);
    if (list) list.push(x);
    else byCompany.set(x.companyId, [x]);
  }
  const tasksByCompany = new Map<string, { assignee: number; taskId: string }[]>();
  const tasksOf = new Map<number, number>();
  for (const a of identities) {
    for (const d of a.workflow.decide) {
      const list = tasksByCompany.get(a.companyId);
      if (list) list.push({ assignee: a.index, taskId: d.taskId });
      else tasksByCompany.set(a.companyId, [{ assignee: a.index, taskId: d.taskId }]);
    }
    tasksOf.set(a.index, a.workflow.decide.length);
  }
  const teams = new Map<number, Set<string>>();
  const teamOf = (x: FixtureIdentity) => {
    let t = teams.get(x.index);
    if (!t) teams.set(x.index, (t = new Set(x.team)));
    return t;
  };
  // Rotating cursors pick a different target each time without building per-request candidate lists.
  const cursors = new Map<string, number>();
  const rotateWhere = <T>(key: string, items: readonly T[], ok: (item: T) => boolean): T | null => {
    const start = cursors.get(key) ?? 0;
    for (let k = 0; k < items.length; k++) {
      const item = items[(start + k) % items.length]!;
      if (ok(item)) {
        cursors.set(key, start + k + 1);
        return item;
      }
    }
    return null;
  };
  const companySize = (x: FixtureIdentity) => byCompany.get(x.companyId)?.length ?? 0;
  const multiCompany = byCompany.size > 1;
  const NOT_VISIBLE = [403, 404] as const;
  // Task and team queues guarded by one duty each; every baseline role lacks at least one of them in its own context.
  const TASK_QUEUES: readonly [duty: string, path: string][] = [
    ['leave.approve.operational', '/v1/leave/tasks'],
    ['team.list.operational', '/v1/my-team?page=1&pageSize=25'],
    ['attendance.approve_correction.operational', '/v1/attendance-corrections/tasks/mine'],
    ['employee.update.operational', '/v1/profile-changes/tasks/mine'],
  ];
  const missingQueue = (x: FixtureIdentity) => TASK_QUEUES.find(([duty]) => !hasDuty(x, duty))?.[1] ?? null;
  return [
    {
      // DB109/role permission: an Employee context has no employee list duty.
      name: 'no-permission',
      category: 'scopedRead',
      kind: 'read',
      eligible: (x) => !hasDuty(x, 'employee.list.operational'),
      build: () => ({ context: 'primary', method: 'GET', path: '/v1/employees?page=1&pageSize=25', expectStatus: [403] }),
    },
    {
      // DB109/role permission in every role's own context (G2: all 14 roles issue negative requests): a task or
      // team queue whose duty the role does not hold by default.
      name: 'no-task-permission',
      category: 'teamTaskRead',
      kind: 'read',
      eligible: (x) => missingQueue(x) !== null,
      build: (x) => {
        const path = missingQueue(x);
        return path ? { context: 'primary', method: 'GET', path, expectStatus: [403] } : null;
      },
    },
    {
      // Tenant isolation in a role context (COMPANY/ASSIGNED/TEAM scope): another company's employee record.
      name: 'foreign-company-primary',
      category: 'scopedRead',
      kind: 'read',
      eligible: (x) => multiCompany && x.contexts.primary.assignmentId !== x.contexts.own.assignmentId,
      build: (x) => {
        const other = rotateWhere('foreign-primary', identities, (c) => c.companyId !== x.companyId);
        return other ? { context: 'primary', method: 'GET', path: `/v1/employees/${other.employeeId}`, expectStatus: NOT_VISIBLE } : null;
      },
    },
    {
      // OWN row scope: a colleague's record in the same company.
      name: 'out-of-scope-record',
      category: 'ownRead',
      kind: 'read',
      eligible: (x) => companySize(x) > 1,
      build: (x) => {
        const other = rotateWhere(`scope:${x.companyId}`, byCompany.get(x.companyId)!, (c) => c.index !== x.index);
        return other ? { context: 'own', method: 'GET', path: `/v1/employees/${other.employeeId}/leave-balances`, expectStatus: NOT_VISIBLE } : null;
      },
    },
    {
      // Tenant isolation: another company's employee under this company's context.
      name: 'foreign-company-record',
      category: 'ownRead',
      kind: 'read',
      eligible: () => multiCompany,
      build: (x) => {
        const other = rotateWhere('foreign', identities, (c) => c.companyId !== x.companyId);
        return other ? { context: 'own', method: 'GET', path: `/v1/employees/${other.employeeId}/leave-balances`, expectStatus: NOT_VISIBLE } : null;
      },
    },
    {
      // TEAM scope (DF16): someone who is not a direct report.
      name: 'out-of-team-member',
      category: 'teamTaskRead',
      kind: 'read',
      eligible: (x) => hasDuty(x, 'team.read.operational') && companySize(x) - 1 - x.team.length > 0,
      build: (x) => {
        const team = teamOf(x);
        const other = rotateWhere(`team:${x.companyId}`, byCompany.get(x.companyId)!, (c) => c.index !== x.index && !team.has(c.employeeId));
        return other ? { context: 'primary', method: 'GET', path: `/v1/my-team/${other.employeeId}`, expectStatus: NOT_VISIBLE } : null;
      },
    },
    {
      // C4: a reviewer cannot decide a task assigned to someone else (indistinguishable from a missing task).
      name: 'foreign-task',
      category: 'write',
      kind: 'mutation',
      eligible: (x) => hasDuty(x, 'leave.approve.operational') && (tasksByCompany.get(x.companyId)?.length ?? 0) - (tasksOf.get(x.index) ?? 0) > 0,
      build: (x, seq) => {
        const task = rotateWhere(`task:${x.companyId}`, tasksByCompany.get(x.companyId) ?? [], (t) => t.assignee !== x.index);
        return task
          ? { context: 'primary', method: 'POST', path: `/v1/leave/tasks/${task.taskId}/decision`, body: { decision: 'APPROVE', idempotencyKey: `${runId}-p-${seq}` }, expectStatus: NOT_VISIBLE }
          : null;
      },
    },
    {
      // DF10: revocation is effective on the next request.
      name: 'revoked-session',
      category: 'metadata',
      kind: 'read',
      eligible: (x) => x.deadSessions !== undefined,
      build: () => ({ context: 'primary', token: 'revoked', method: 'GET', path: '/v1/me/context', expectStatus: [401] }),
    },
    {
      // DF10: a server-side expired session is refused although its token signature is still valid.
      name: 'expired-session',
      category: 'metadata',
      kind: 'read',
      eligible: (x) => x.deadSessions !== undefined,
      build: () => ({ context: 'primary', token: 'expired', method: 'GET', path: '/v1/me/context', expectStatus: [401] }),
    },
  ];
}

/**
 * Deterministic mix: each pick goes to the key furthest below its target share, so every prefix of the arrival
 * sequence matches the mix within one request per key. 'random' draws by weight instead.
 */
export class MixSelector<K extends string> {
  private readonly counts = new Map<K, number>();
  private total = 0;
  private readonly weights: [K, number][];

  constructor(
    weights: Readonly<Record<K, number>> | ReadonlyMap<K, number>,
    private readonly mode: 'deficit' | 'random' = 'deficit',
    private readonly rng: Rng = createRng(1),
  ) {
    const entries = (weights instanceof Map ? [...weights.entries()] : (Object.entries(weights) as [K, number][])).filter(([, w]) => w > 0);
    const sum = entries.reduce((n, [, w]) => n + w, 0);
    this.weights = entries.map(([k, w]) => [k, w / sum]);
  }

  /** Picks among available keys; `preferred` is the key the mix wanted before availability was applied. */
  next(available: (k: K) => boolean = () => true): { key: K; preferred: K } | null {
    let preferred: K | null = null;
    let best: K | null = null;
    if (this.mode === 'random') {
      const open = this.weights.filter(([k]) => available(k));
      const sum = open.reduce((n, [, w]) => n + w, 0);
      let r = this.rng.next() * sum;
      for (const [k, w] of open) {
        best = k;
        if ((r -= w) < 0) break;
      }
      preferred = best;
    } else {
      let prefD = Number.NEGATIVE_INFINITY;
      let bestD = Number.NEGATIVE_INFINITY;
      for (const [k, w] of this.weights) {
        const d = w * (this.total + 1) - (this.counts.get(k) ?? 0);
        if (d > prefD) {
          prefD = d;
          preferred = k;
        }
        if (available(k) && d > bestD) {
          bestD = d;
          best = k;
        }
      }
    }
    if (best === null || preferred === null) return null;
    this.counts.set(best, (this.counts.get(best) ?? 0) + 1);
    this.total++;
    return { key: best, preferred };
  }
}

/**
 * Identities eligible for one operation, picked least-recently-used among a window of candidates, so requests
 * spread over as many distinct identities as possible and no identity is hammered while others idle.
 */
export class IdentityPool {
  private readonly items: number[];
  private cursor = 0;
  /** Position of each member, built on the first removal (only consumable-inventory pools ever remove). */
  private positions: Map<number, number> | null = null;

  constructor(
    items: readonly number[],
    private readonly lastUsed: Float64Array,
    private readonly window = 32,
  ) {
    this.items = [...items];
  }

  get size(): number {
    return this.items.length;
  }

  pick(): number | null {
    const n = this.items.length;
    if (n === 0) return null;
    let best = -1;
    let bestPos = -1;
    for (let k = 0; k < Math.min(n, this.window); k++) {
      const pos = (this.cursor + k) % n;
      const id = this.items[pos]!;
      if (best < 0 || this.lastUsed[id]! < this.lastUsed[best]!) {
        best = id;
        bestPos = pos;
      }
    }
    this.cursor = (bestPos + 1) % n;
    return best;
  }

  remove(id: number): void {
    this.positions ??= new Map(this.items.map((item, pos) => [item, pos]));
    const pos = this.positions.get(id);
    if (pos === undefined) return;
    const last = this.items.pop()!;
    this.positions.delete(id);
    if (pos < this.items.length) {
      this.items[pos] = last;
      this.positions.set(last, pos);
    }
    if (this.cursor >= this.items.length) this.cursor = 0;
  }
}

export interface PlannerOptions {
  runId: string;
  profile: Readonly<Record<Category, number>>;
  /** Share of arrivals that are negative probes (taken within the arrival's G2 category). */
  negativeShare: number;
  seed: number;
  mixSelection?: 'deficit' | 'random';
  businessDate: string;
  /** Fixture states (task/request/attendance-record ids) already consumed by earlier runs on the same fixture. */
  consumed?: ReadonlySet<string>;
  /** Earliest leave date this run may request (shift it for each repeated run on an unrestored fixture). */
  leaveDateFrom?: string;
}

export interface PlannerStats {
  offeredByCategory: Record<string, number>;
  offeredByOperation: Record<string, number>;
  /** The mix wanted an operation no identity of this fixture/shard can issue; another operation of the same category was sent. */
  notCovered: Record<string, number>;
  /** The mix wanted a consumable operation whose fixture inventory ran out during the run (fixture undersized). */
  inventoryExhausted: Record<string, number>;
  /** Arrivals that could not be planned at all (no eligible identity in their category); they are not sent. */
  unplannable: Record<string, number>;
  probesPlanned: number;
}

/** Plans each arrival: G2 category, then operation (or probe), then the least recently used eligible identity. */
export class WorkloadPlanner {
  readonly lastUsed: Float64Array;
  private readonly ops: OperationDef[];
  private readonly probeDefs: ProbeDef[];
  private readonly pools = new Map<string, IdentityPool>();
  private readonly state: IdentityState[];
  private readonly categories: MixSelector<Category>;
  private readonly opSelectors = new Map<Category, MixSelector<string>>();
  private readonly probeSelectors = new Map<Category, MixSelector<string>>();
  private readonly stats: PlannerStats = { offeredByCategory: {}, offeredByOperation: {}, notCovered: {}, inventoryExhausted: {}, unplannable: {}, probesPlanned: 0 };
  private readonly initialPools: Record<string, number>;
  private arrivals = 0;

  constructor(
    private readonly identities: readonly FixtureIdentity[],
    private readonly opts: PlannerOptions,
  ) {
    const rng = createRng(opts.seed);
    this.lastUsed = new Float64Array(identities.length).fill(-1);
    this.ops = operations(opts.runId, opts.businessDate);
    this.probeDefs = probes(identities, opts.runId);
    const order = shuffleInPlace(
      identities.map((_, i) => i),
      rng,
    );
    const consumed = opts.consumed ?? new Set<string>();
    const fresh = <T>(items: readonly T[], key: (item: T) => string) => items.filter((item) => !consumed.has(key(item)));
    this.state = identities.map((x) => {
      const free = x.leave.nextFreeDate || opts.businessDate;
      return {
        inv: {
          decide: fresh(x.workflow.decide, (d) => d.taskId),
          resubmit: fresh(x.workflow.resubmit, (r) => r.requestId),
          withdraw: fresh(x.workflow.withdraw, (w) => w.requestId),
          correct: fresh(x.workflow.correct, (c) => c.attendanceRecordId),
        },
        decide: 0,
        resubmit: 0,
        withdraw: 0,
        correct: 0,
        teamCursor: 0,
        nextDate: opts.leaveDateFrom && opts.leaveDateFrom > free ? opts.leaveDateFrom : free,
        paidLeft: new Map(PAID_TYPES.map((t) => [t, Math.max(0, Math.floor(Number(x.leave.available[t] ?? '0')))])),
      };
    });
    for (const d of this.ops) {
      this.pools.set(d.name, new IdentityPool(order.filter((i) => d.eligible(identities[i]!, this.state[i]!)), this.lastUsed));
    }
    for (const d of this.probeDefs) {
      this.pools.set(d.name, new IdentityPool(order.filter((i) => d.eligible(identities[i]!)), this.lastUsed));
    }
    this.initialPools = this.poolSizes();
    const mode = opts.mixSelection ?? 'deficit';
    this.categories = new MixSelector(opts.profile, mode, rng);
    for (const c of CATEGORIES) {
      this.opSelectors.set(c, new MixSelector(new Map(this.ops.filter((o) => o.category === c).map((o) => [o.name, o.weight])), mode, rng));
      const ps = this.probeDefs.filter((p) => p.category === c);
      if (ps.length) this.probeSelectors.set(c, new MixSelector(new Map(ps.map((p) => [p.name, 1])), mode, rng));
    }
  }

  /** Eligible identities per operation and probe (before any inventory is consumed). */
  poolSizes(): Record<string, number> {
    return Object.fromEntries([...this.pools.entries()].map(([k, p]) => [k, p.size]));
  }

  getStats(): PlannerStats {
    return this.stats;
  }

  next(seq: number): PlannedRequest | ExhaustedArrival {
    this.arrivals++;
    const category = this.categories.next()!.key;
    this.stats.offeredByCategory[category] = (this.stats.offeredByCategory[category] ?? 0) + 1;

    if (this.stats.probesPlanned < Math.round(this.opts.negativeShare * this.arrivals)) {
      const probe = this.planProbe(category, seq);
      if (probe) return probe;
    }

    const selector = this.opSelectors.get(category)!;
    const pick = selector.next((name) => (this.pools.get(name)?.size ?? 0) > 0);
    if (!pick) {
      this.stats.unplannable[category] = (this.stats.unplannable[category] ?? 0) + 1;
      return { exhausted: true, category, op: null };
    }
    if (pick.preferred !== pick.key) {
      const bucket = (this.initialPools[pick.preferred] ?? 0) > 0 ? this.stats.inventoryExhausted : this.stats.notCovered;
      bucket[pick.preferred] = (bucket[pick.preferred] ?? 0) + 1;
    }
    const def = this.ops.find((o) => o.name === pick.key)!;
    const pool = this.pools.get(def.name)!;
    const id = pool.pick()!;
    const x = this.identities[id]!;
    const s = this.state[id]!;
    const b = def.build(x, s, seq);
    if (def.available && !def.available(x, s)) pool.remove(id);
    this.lastUsed[id] = seq;
    this.stats.offeredByOperation[def.name] = (this.stats.offeredByOperation[def.name] ?? 0) + 1;
    return this.finish(category, def.name, def.kind, null, id, b);
  }

  /**
   * One request for every operation and every negative probe that has an eligible identity: a route sweep that
   * shows, before a long run, that each scripted request is accepted and each probe denied by this API. It consumes
   * fixture inventory like a run does, so give it a planner of its own and pass its inventory keys to later runs.
   */
  sampleAll(firstSeq: number): { requests: PlannedRequest[]; uncovered: string[] } {
    const requests: PlannedRequest[] = [];
    const uncovered: string[] = [];
    let seq = firstSeq;
    for (const def of this.ops) {
      const pool = this.pools.get(def.name)!;
      const id = pool.pick();
      if (id === null) {
        uncovered.push(def.name);
        continue;
      }
      const x = this.identities[id]!;
      const s = this.state[id]!;
      const b = def.build(x, s, seq);
      if (def.available && !def.available(x, s)) pool.remove(id);
      this.lastUsed[id] = seq;
      requests.push(this.finish(def.category, def.name, def.kind, null, id, b));
      seq++;
    }
    for (const def of this.probeDefs) {
      const id = this.pools.get(def.name)!.pick();
      const b = id === null ? null : def.build(this.identities[id]!, seq);
      if (id === null || b === null) {
        uncovered.push(`probe:${def.name}`);
        continue;
      }
      this.lastUsed[id] = seq;
      requests.push(this.finish(def.category, `probe:${def.name}`, def.kind, def.name, id, b));
      seq++;
    }
    return { requests, uncovered };
  }

  private planProbe(category: Category, seq: number): PlannedRequest | null {
    const selector = this.probeSelectors.get(category);
    if (!selector) return null;
    const pick = selector.next((name) => (this.pools.get(name)?.size ?? 0) > 0);
    if (!pick) return null;
    const def = this.probeDefs.find((p) => p.name === pick.key)!;
    const id = this.pools.get(def.name)!.pick()!;
    const b = def.build(this.identities[id]!, seq);
    if (!b) return null;
    this.lastUsed[id] = seq;
    this.stats.probesPlanned++;
    const op = `probe:${def.name}`;
    this.stats.offeredByOperation[op] = (this.stats.offeredByOperation[op] ?? 0) + 1;
    return this.finish(category, op, def.kind, def.name, id, b);
  }

  private finish(category: Category, op: string, kind: 'read' | 'mutation', probe: string | null, id: number, b: Build): PlannedRequest {
    const x = this.identities[id]!;
    const tokenKind = b.token ?? 'live';
    const token = tokenKind === 'revoked' ? x.deadSessions!.revokedToken : tokenKind === 'expired' ? x.deadSessions!.expiredToken : x.session.token;
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'x-hrms-company': x.companyId };
    if (b.context !== 'none') headers['x-hrms-assignment'] = x.contexts[b.context].assignmentId;
    return {
      category,
      op,
      kind,
      probe,
      identity: id,
      context: b.context,
      token: tokenKind,
      spec: { method: b.method, path: b.path, headers, ...(b.body === undefined ? {} : { body: b.body }) },
      expectStatus: b.expectStatus ?? null,
      validate: b.validate ?? null,
      wantBody: b.validate !== undefined,
      inventoryKey: b.inventoryKey ?? null,
    };
  }

  /** Expected count of each consumable operation for a planned number of arrivals, against the fixture inventory. */
  inventoryCheck(plannedArrivals: number): { op: string; expected: number; available: number }[] {
    const out: { op: string; expected: number; available: number }[] = [];
    for (const c of CATEGORIES) {
      const ops = this.ops.filter((o) => o.category === c);
      const sum = ops.reduce((n, o) => n + o.weight, 0);
      for (const o of ops) {
        if (!o.available) continue;
        const available = this.state.reduce((n, s) => {
          const inv = { 'leave-decide': s.inv.decide, 'leave-resubmit': s.inv.resubmit, 'leave-withdraw': s.inv.withdraw, 'attendance-correction': s.inv.correct }[o.name];
          return n + (inv?.length ?? 0);
        }, 0);
        const expected = Math.ceil(plannedArrivals * (this.opts.profile[c] ?? 0) * (1 - this.opts.negativeShare) * (o.weight / sum));
        out.push({ op: o.name, expected, available });
      }
    }
    return out;
  }
}
