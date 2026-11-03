// Synthetic appraisal fixtures for the module's API tests (not a test file): obviously fake names, example.test
// addresses and made-up goals only.
import { expect } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import type { Company, Harness, TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';

/** Confidential grants (approved per assignment in tests, as an independent approval would add them). */
export const RATER: PermissionKey[] = ['appraisal.read.rating', 'appraisal.rate.rating'];
export const REVIEWER: PermissionKey[] = ['appraisal.read.rating', 'appraisal.rate.rating', 'appraisal.confirm.rating'];
export const HR_OVERSIGHT: PermissionKey[] = ['appraisal.read.rating', 'appraisal.read.reason', 'appraisal.report.rating', 'appraisal.export.rating'];

export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const key = () => uniq('appraisal-key-');

export const GOALS = [
  { sequence: 1, description: 'Synthetic delivery goal', weight: 30 },
  { sequence: 2, description: 'Synthetic quality goal', weight: 30 },
  { sequence: 3, description: 'Synthetic learning goal', target: 'Two synthetic courses', weight: 40 },
];

export async function businessDate(h: Harness, company: Company): Promise<string> {
  return (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [company.id])).d;
}

/** The April-to-March financial year containing the date (the tests configure cycle start month 4). */
export function fyStart(day: string, offsetYears = 0): string {
  const year = Number(day.slice(0, 4)) - (Number(day.slice(5, 7)) < 4 ? 1 : 0) + offsetYears;
  return `${year}-04-01`;
}

/** An active employee created through the API, optionally reporting to a manager. */
export async function person(h: Harness, company: Company, hr: TestActor, opts: { managerId?: string; name?: string; departmentId?: string } = {}): Promise<string> {
  const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(company, { displayName: opts.name ?? 'Synthetic Person', ...(opts.departmentId ? { departmentId: opts.departmentId } : {}) }));
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  await h.setStatus(company, id, 'ACTIVE_CONFIRMED');
  if (opts.managerId) {
    const m = await h.call(hr, 'POST', `/v1/employees/${id}/manager`, { managerEmployeeId: opts.managerId, effectiveFrom: '2026-01-05' });
    expect(m.statusCode, m.body).toBeLessThan(300);
  }
  return id;
}

export interface World {
  A: Company;
  /** HR with the operational duties and the confidential oversight grants (read ratings and reasons, reports). */
  hr: TestActor;
  /** HR with the default (operational) duties only. */
  hrPlain: TestActor;
  /** Independent eligible HR reviewers on the appraisal list (priority 1 and 2). */
  rev1: TestActor;
  rev2: TestActor;
  managerEmp: string;
  manager: TestActor;
  today: string;
}

export async function appraisalWorld(h: Harness, A: Company): Promise<World> {
  const hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_OVERSIGHT });
  const hrPlain = await h.actor(A, 'HR_ADMINISTRATOR');
  const rev1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEWER });
  const rev2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEWER });
  const listed = await h.call(hr, 'PUT', '/v1/workflows/appraisal/fallback-reviewers', { reviewers: [{ userId: rev1.user, priority: 1 }, { userId: rev2.user, priority: 2 }] });
  expect(listed.statusCode, listed.body).toBe(200);
  const setting = await h.call(hr, 'PUT', '/v1/appraisal-settings', { cycleStartMonth: 4 });
  expect(setting.statusCode, setting.body).toBe(200);
  const managerEmp = await person(h, A, hr, { name: 'Synthetic Manager Mira' });
  const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp, extra: [...RATER, 'appraisal.report.rating'] });
  return { A, hr, hrPlain, rev1, rev2, managerEmp, manager, today: await businessDate(h, A) };
}

/** Windows that are all open on the given day, in process order. */
export const openWindows = (day: string) => ({
  goalSetting: { opensOn: addDays(day, -5), closesOn: addDays(day, 5) },
  selfEntry: { opensOn: addDays(day, -5), closesOn: addDays(day, 10) },
  managerRating: { opensOn: addDays(day, -5), closesOn: addDays(day, 20) },
});

export async function openCycle(h: Harness, w: World, opts: { approvalLevels?: 1 | 2; windows?: Record<string, unknown>; offsetYears?: number } = {}) {
  const res = await h.call(w.hr, 'POST', '/v1/appraisal-cycles', {
    code: uniq('FY-'),
    name: 'Synthetic annual cycle',
    startDate: fyStart(w.today, opts.offsetYears ?? 0),
    ...(opts.approvalLevels ? { approvalLevels: opts.approvalLevels } : {}),
    windows: opts.windows ?? openWindows(w.today),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; code: string; startDate: string; endDate: string; version: number; approvalLevels: number };
}

export type View = Record<string, unknown> & {
  id: string;
  state: string;
  revision: number;
  version: number;
  taskStatus: string;
  goals: { id: string; sequence: number; description: string; weight: number; selfEntryComplete: boolean; managerRatingComplete?: boolean }[];
  revisions: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
  pending: { taskId?: string; step: number; with: { displayName: string | null } } | null;
};

export async function enrol(h: Harness, a: TestActor, cycleId: string, employeeId: string, goals: unknown[] = GOALS): Promise<View> {
  const res = await h.call(a, 'POST', '/v1/appraisals', { cycleId, employeeId, goals });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as View;
}

export const ownView = async (h: Harness, e: TestActor, id: string) => (await h.call(e, 'GET', `/v1/me/appraisals/${id}`)).json() as View;
export const staffView = async (h: Harness, a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/appraisals/${id}`)).json() as View;

/** Scores every goal (in sequence order) and submits the self-entry. */
export async function selfAssess(h: Harness, e: TestActor, id: string, scores: number[], comment = 'Synthetic self comment') {
  const v = await ownView(h, e, id);
  const saved = await h.call(e, 'PUT', `/v1/me/appraisals/${id}/self-entry`, {
    entries: v.goals.map((g, i) => ({ goalId: g.id, score: scores[i] ?? null, comment: `Synthetic self note ${g.sequence}` })),
    comment,
    expectedVersion: v.version,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const submitted = await h.call(e, 'POST', `/v1/me/appraisals/${id}/submit`, { expectedVersion: (saved.json() as View).version });
  expect(submitted.statusCode, submitted.body).toBe(200);
  return submitted.json() as View;
}

export type Task = { taskId: string; step: number; stage: string; level: number | null; appraisal: View | null };

export async function taskOf(h: Harness, a: TestActor, appraisalId: string): Promise<Task | undefined> {
  const res = await h.call(a, 'GET', '/v1/appraisal-tasks/mine');
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as Task[]).find((t) => t.appraisal?.id === appraisalId);
}

export const decide = (h: Harness, a: TestActor, taskId: string, body: Record<string, unknown>) =>
  h.call(a, 'POST', `/v1/appraisal-tasks/${taskId}/decision`, { idempotencyKey: key(), ...body });

/** The rater enters every manager score and submits the rating. */
export async function rate(h: Harness, rater: TestActor, id: string, scores: number[], comment = 'Synthetic manager comment') {
  const t = (await taskOf(h, rater, id))!;
  expect(t, 'rating task').toBeDefined();
  const saved = await h.call(rater, 'PUT', `/v1/appraisal-tasks/${t.taskId}/rating`, {
    entries: t.appraisal!.goals.map((g, i) => ({ goalId: g.id, score: scores[i] ?? null, comment: `Synthetic manager note ${g.sequence}` })),
    comment,
    expectedVersion: t.appraisal!.version,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const decided = await decide(h, rater, t.taskId, { decision: 'APPROVE', reason: 'Synthetic private rater remark' });
  expect(decided.statusCode, decided.body).toBe(200);
  return decided.json() as { state: string; pendingStep?: number };
}

export async function confirm(h: Harness, reviewer: TestActor, id: string) {
  const t = (await taskOf(h, reviewer, id))!;
  expect(t, 'review task').toBeDefined();
  const decided = await decide(h, reviewer, t.taskId, { decision: 'APPROVE', reason: 'Synthetic private reviewer remark' });
  expect(decided.statusCode, decided.body).toBe(200);
  return decided.json() as { state: string; pendingStep?: number };
}

/** Audit before/after values and outbox payloads of the company, as one text for leak checks. */
export async function trailText(h: Harness, companyId: string): Promise<string> {
  const a = await h.one<{ t: string }>(
    `select coalesce(string_agg(coalesce(before_values::text, '') || ' ' || coalesce(after_values::text, ''), ' '), '') as t from audit_event where company_id = $1`,
    [companyId],
  );
  const o = await h.one<{ t: string }>(`select coalesce(string_agg(payload::text, ' '), '') as t from outbox_event where company_id = $1`, [companyId]);
  return `${a.t} ${o.t}`;
}
