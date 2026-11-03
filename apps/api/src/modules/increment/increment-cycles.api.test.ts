// Increment cycle management (DF15; FR-091; BR-040; DB101; DB102; C4; ZT25): cycle definitions and revisions with
// independent activation, service-anniversary cycles, employee cycle assignment, review-date overrides and the review
// due reminders. Dates are taken relative to the company business date so the fixtures stay valid as time passes.
// Synthetic data only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_VIOLATION, expectSqlError } from '../../../../../db/tests/fixtures.js';
import type { PermissionKey } from '../access/baseline.js';
import { runBulkJobs } from '../bulk/service.js';
import { type BulkJobResult, type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { INCREMENT_REVIEW_NOTIFICATIONS, runIncrementReviewReminders } from './reminders.js';

const FINANCE_GRANTS: PermissionKey[] = ['salary.manage.salary', 'salary.read.salary', 'increment.read.salary', 'increment.propose.salary', 'increment.approve.salary'];
const REASON = 'Review schedule change (synthetic)';

interface Org {
  co: Company;
  hr1: TestActor;
  hr2: TestActor;
  hrPlain: TestActor;
  manager: TestActor;
  managerEmp: string;
}

/**
 * What an opening reports: the job's counts and fixed values (its result), with the cases it created and the employees
 * it excluded as read, page by page, from GET /v1/increment-review-openings/:id/cases and /exclusions.
 */
interface Roster {
  created: number;
  run: number;
  rerun: boolean;
  caseIds: string[];
  roster: { caseId: string; employeeId: string; occurrence: string; effectiveDate: string; decisionDueOn: string }[];
  excluded: { employeeId: string; reason: string }[];
  repairPaths: Record<string, string>;
}

let h: Harness;
let A: Org;
let B: Org;
let today: string;
/** Next calendar year: every date in it is still ahead of the business date. */
let Y: number;
let annivId: string;
let annualB: string;
const e: Record<string, string> = {};

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
/** The next anniversary of (month, day) on or after today, for a service base at least a year back. */
const nextAnniversary = (m: number, d: number) => (iso(Y - 1, m, d) >= today ? iso(Y - 1, m, d) : iso(Y, m, d));
const reasonsOf = (r: Roster) => Object.fromEntries(r.excluded.map((x) => [x.employeeId, x.reason]));
const withoutCode = ({ code: _code, ...rest }: Record<string, unknown>) => rest;

const anniversaryBody = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  recurrenceBasis: 'SERVICE_ANNIVERSARY',
  recurrenceUnit: 'YEAR',
  recurrenceInterval: 1,
  compensationBasis: 'MONTHLY_GROSS',
  excludeNotice: true,
  assignmentRule: 'ASSIGNED_ONLY',
  effectiveFrom: '2026-01-01',
  ...extra,
});
const OFFSETS = { reviewOpenOffsetDays: 90, rosterFreezeOffsetDays: 60, decisionDueOffsetDays: 15 };
const commonBody = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  recurrenceBasis: 'COMMON_DATE',
  recurrenceUnit: 'YEAR',
  recurrenceInterval: 1,
  compensationBasis: 'MONTHLY_GROSS',
  excludeNotice: true,
  assignmentRule: 'ASSIGNED_ONLY',
  effectiveFrom: '2026-01-01',
  effectiveDate: { month: 10, day: 1 },
  reviewOpens: { month: 7, day: 1 },
  rosterFreezes: { month: 7, day: 31 },
  decisionsDue: { month: 9, day: 15 },
  joiningCutoff: { month: 3, day: 31 },
  ...extra,
});
/** The DF15 annual definition, stated explicitly as a company would for a new revision. */
const annualBody = (extra: Record<string, unknown> = {}) =>
  commonBody('ANNUAL', {
    assignmentRule: 'COMPANY_DEFAULT',
    effectiveDate: { month: 4, day: 1 },
    reviewOpens: { month: 1, day: 1 },
    rosterFreezes: { month: 1, day: 31 },
    decisionsDue: { month: 3, day: 15 },
    joiningCutoff: { month: 9, day: 30 },
    ...extra,
  });

async function org(): Promise<Org> {
  const co = await h.makeCompany();
  const hr1 = await h.actor(co, 'HR_ADMINISTRATOR', { extra: FINANCE_GRANTS });
  const hr2 = await h.actor(co, 'HR_ADMINISTRATOR', { extra: FINANCE_GRANTS });
  const hrPlain = await h.actor(co, 'HR_ADMINISTRATOR');
  await h.db.query(
    `insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'increment_case', $2, 1, true), ($1, 'increment_case', $3, 2, true)`,
    [co.id, hr1.user, hr2.user],
  );
  const m = (await h.call(hrPlain, 'POST', '/v1/employees', h.newEmployeeBody(co))).json();
  await h.setStatus(co, m.id, 'ACTIVE_CONFIRMED');
  const manager = await h.actor(co, 'REPORTING_MANAGER', { employeeId: m.id, extra: ['increment.propose.salary', 'increment.read.salary'] });
  return { co, hr1, hr2, hrPlain, manager, managerEmp: m.id };
}

async function employee(o: Org, status: string, joiningDate: string, opts: { salary?: boolean; serviceDate?: string } = {}): Promise<string> {
  const res = await h.call(o.hrPlain, 'POST', '/v1/employees', h.newEmployeeBody(o.co, { joiningDate }));
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;
  await h.setStatus(o.co, id, status);
  await h.call(o.hrPlain, 'POST', `/v1/employees/${id}/manager`, { managerEmployeeId: o.managerEmp, effectiveFrom: joiningDate });
  // A carried service date (DF12 "unless HR explicitly approves carried service date"), set directly as a fixture.
  if (opts.serviceDate) await h.db.query(`update employee set service_anniversary_date = $2 where id = $1`, [id, opts.serviceDate]);
  if (opts.salary !== false) {
    const s = await h.call(o.hr1, 'POST', `/v1/employees/${id}/salary`, { effectiveFrom: joiningDate, monthlyGross: '50000', annualCtc: '600000', currency: 'INR' });
    expect(s.statusCode).toBe(201);
  }
  return id;
}

const cycles = async (o: Org) => (await h.call(o.hr1, 'GET', '/v1/increment-cycles')).json().items as { id: string; code: string; revision: number; state: string; effectiveFrom: string; effectiveTo: string | null; version: number }[];
const reviewsUrl = (cycleId: string) => `/v1/increment-cycles/${cycleId}/reviews`;
/** The request alone: 202 with a queued job, or the refusal of a bad request. */
const open = (a: TestActor, cycleId: string, year: number, month?: number) => h.call(a, 'POST', reviewsUrl(cycleId), month ? { year, month } : { year });
const openingUrl = (jobId: string, list: 'cases' | 'exclusions') => `/v1/increment-review-openings/${jobId}/${list}`;
/** Every row of an opening's cases or exclusions, read `limit` rows a page (small, so that paging is exercised). */
async function allRows(a: TestActor, jobId: string, list: 'cases' | 'exclusions', limit = 2) {
  const items: Record<string, any>[] = [];
  let after: string | null = null;
  for (let i = 0; i < 500; i++) {
    const res = await h.call(a, 'GET', `${openingUrl(jobId, list)}?${new URLSearchParams({ limit: String(limit), ...(after ? { after } : {}) })}`);
    expect(res.statusCode).toBe(200);
    const page = res.json();
    expect(page.items.length).toBeLessThanOrEqual(limit);
    items.push(...page.items);
    after = page.nextAfter;
    if (after === null) return items;
  }
  throw new Error('Too many pages');
}
/** The roster of a finished opening job: its counts (no list in the result) and its rows from the opening's lists. */
async function rosterOf(a: TestActor, job: BulkJobResult): Promise<Roster> {
  expect(Object.values(job.result).some(Array.isArray)).toBe(false);
  const cases = await allRows(a, job.id, 'cases');
  const exclusions = await allRows(a, job.id, 'exclusions');
  expect(cases).toHaveLength(job.result.created);
  expect(exclusions).toHaveLength(job.result.excluded);
  const byReason: Record<string, number> = {};
  for (const x of exclusions) byReason[x.reason] = (byReason[x.reason] ?? 0) + 1;
  expect(job.result.excludedByReason).toEqual(byReason);
  return {
    ...job.result,
    caseIds: cases.map((x) => x.caseId),
    roster: cases.map(({ caseId, employeeId, occurrence, effectiveDate, decisionDueOn }) => ({ caseId, employeeId, occurrence, effectiveDate, decisionDueOn })),
    excluded: exclusions.map(({ employeeId, reason }) => ({ employeeId, reason })),
    repairPaths: Object.fromEntries(exclusions.map((x) => [x.reason, x.repairPath])),
  };
}
/** NFR-S09: the opening is a queued bulk job; this enqueues it, runs the worker and returns what the opening reports. */
const roster = async (a: TestActor, cycleId: string, year: number, month?: number): Promise<Roster> =>
  rosterOf(a, await h.runBulkJob(a, reviewsUrl(cycleId), month ? { year, month } : { year }));
const job = async (a: TestActor, id: string) => {
  const res = await h.call(a, 'GET', `/v1/bulk-jobs/${id}`);
  expect(res.statusCode).toBe(200);
  return res.json();
};
const drain = async () => {
  for (let i = 0; i < 100 && (await runBulkJobs(h.pool, 100)) > 0; i++);
};
const proposeChange = (a: TestActor, employeeId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/employees/${employeeId}/increment-plan/changes`, { reason: REASON, ...body });
const proposeOverride = (a: TestActor, employeeId: string, overrideDate: string) => proposeChange(a, employeeId, { kind: 'REVIEW_DATE_OVERRIDE', overrideDate });
const decideChange = (a: TestActor, id: string, decision: 'APPROVE' | 'REJECT') => h.call(a, 'POST', `/v1/increment-plan-changes/${id}/decision`, { decision, reason: 'Checked against the schedule (synthetic)' });
const plan = async (a: TestActor, employeeId: string) => (await h.call(a, 'GET', `/v1/employees/${employeeId}/increment-plan`)).json();

async function assign(o: Org, employeeId: string, cycleId: string) {
  const p = await proposeChange(o.hr1, employeeId, { kind: 'ASSIGN_CYCLE', cycleId, effectiveFrom: today });
  expect(p.statusCode).toBe(201);
  const d = await decideChange(o.hr2, p.json().changeId, 'APPROVE');
  expect(d.statusCode).toBe(200);
  return d.json();
}

/** An approved resignation with its last working date (lifecycle fixture, written in one transaction like the module). */
async function approvedExit(co: Company, employeeId: string, lastWorkingDate: string) {
  await h.db.query('begin');
  try {
    const bt = (await h.db.query<{ id: string }>(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'exit_case', $2, 'SUBMITTED') returning id`, [co.id, employeeId])).rows[0]!.id;
    await h.db.query(
      `insert into exit_case (company_id, employee_id, transaction_id, separation_type, request_date, proposed_leaving_date, leaving_date, state)
       values ($1, $2, $3, 'RESIGNATION', $4, $5, $5, 'SUBMITTED')`,
      [co.id, employeeId, bt, today, lastWorkingDate],
    );
    for (const state of ['RECOMMENDED', 'APPROVED']) await h.db.query(`update business_transaction set state = $2 where id = $1`, [bt, state]);
    await h.db.query(
      `update exit_case set state = 'APPROVED', recommended_leaving_date = $2, recommended_at = now(), approved_leaving_date = $2, approved_at = now(),
                            prior_status_code = 'ACTIVE_CONFIRMED'
        where transaction_id = $1`,
      [bt, lastWorkingDate],
    );
    await h.db.query('commit');
  } catch (err) {
    await h.db.query('rollback');
    throw err;
  }
}

async function anniversaryCycle(o: Org, code: string): Promise<string> {
  const d = (await h.call(o.hr1, 'POST', '/v1/increment-cycles', anniversaryBody(code, OFFSETS))).json();
  const act = await h.call(o.hr2, 'POST', `/v1/increment-cycles/${d.id}/activate`, { expectedVersion: d.version });
  expect(act.statusCode).toBe(200);
  return d.id;
}

beforeAll(async () => {
  h = await startHarness();
  A = await org();
  B = await org();
  today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.co.id])).d;
  Y = Number(today.slice(0, 4)) + 1;
  annualB = (await cycles(B)).find((c) => c.code === 'ANNUAL')!.id;
});

afterAll(async () => {
  await h?.stop();
});

describe('cycle definitions, revisions and independent activation (DF15, DB101, C4)', () => {
  it('only a company-scope HR user with the cycle duty drafts a cycle, and the definition is explicit and consistent', async () => {
    const body = commonBody('MIDYEAR');
    expect((await h.call(A.manager, 'POST', '/v1/increment-cycles', body)).statusCode).toBe(403);
    expect((await h.call(await h.actor(A.co, 'EMPLOYEE'), 'POST', '/v1/increment-cycles', body)).statusCode).toBe(403);
    const deptHr = await h.actor(A.co, 'HR_ADMINISTRATOR', { departmentFilter: A.co.dept });
    expect((await h.call(deptHr, 'POST', '/v1/increment-cycles', body)).statusCode).toBe(403);

    const { joiningCutoff: _cutoff, ...noCutoff } = body;
    const missing = await h.call(A.hr1, 'POST', '/v1/increment-cycles', noCutoff);
    expect(missing.statusCode).toBe(422);
    expect(missing.json().details.problems).toContain('joiningCutoff is required for a common-date cycle');
    expect((await h.call(A.hr1, 'POST', '/v1/increment-cycles', { ...body, reviewOpenOffsetDays: 10 })).json().error).toBe('INVALID_CYCLE');
    expect((await h.call(A.hr1, 'POST', '/v1/increment-cycles', { ...body, effectiveDate: { month: 4, day: 31 } })).json().error).toBe('INVALID_CYCLE');
    // The roster cannot freeze after decisions are due.
    expect((await h.call(A.hr1, 'POST', '/v1/increment-cycles', { ...body, rosterFreezes: { month: 9, day: 30 } })).json().error).toBe('INVALID_CYCLE');
    // A multi-year common-date cycle would need an anchor year; it is refused rather than treated as yearly.
    expect((await h.call(A.hr1, 'POST', '/v1/increment-cycles', { ...body, recurrenceInterval: 2 })).json().error).toBe('INVALID_CYCLE');
    expect((await cycles(A)).map((c) => c.code)).toEqual(['ANNUAL']);
  });

  it('a draft is activated by someone other than its author; an activated definition never changes in place', async () => {
    const created = await h.call(A.hr1, 'POST', '/v1/increment-cycles', commonBody('MIDYEAR'));
    expect(created.statusCode).toBe(201);
    const c = created.json();
    expect(c).toMatchObject({ code: 'MIDYEAR', revision: 1, state: 'DRAFT', configurationNeeded: [], eligibilityRule: 'CONFIRMED_JOINED_BY_CUTOFF', effectiveDate: { month: 10, day: 1 } });
    expect((await h.call(A.hr1, 'POST', '/v1/increment-cycles', commonBody('MIDYEAR'))).json().error).toBe('CYCLE_EXISTS');
    expect((await open(A.hr1, c.id, Y)).json().error).toBe('CYCLE_NOT_CONFIGURED'); // a draft schedules nothing

    const self = await h.call(A.hr1, 'POST', `/v1/increment-cycles/${c.id}/activate`, { expectedVersion: c.version });
    expect(self.statusCode).toBe(403);
    expect(self.json().error).toBe('SELF_APPROVAL');
    expect((await h.call(A.manager, 'POST', `/v1/increment-cycles/${c.id}/activate`, { expectedVersion: c.version })).statusCode).toBe(403);
    const deptHr = await h.actor(A.co, 'HR_ADMINISTRATOR', { departmentFilter: A.co.dept });
    expect((await h.call(deptHr, 'POST', `/v1/increment-cycles/${c.id}/activate`, { expectedVersion: c.version })).statusCode).toBe(403);
    expect((await h.call(A.hr2, 'POST', `/v1/increment-cycles/${randomUUID()}/activate`, { expectedVersion: 1 })).statusCode).toBe(404);
    expect((await h.call(B.hr2, 'POST', `/v1/increment-cycles/${c.id}/activate`, { expectedVersion: c.version })).statusCode).toBe(404);
    expect((await h.call(A.hr2, 'POST', `/v1/increment-cycles/${c.id}/activate`, { expectedVersion: c.version + 1 })).json().error).toBe('STALE_VERSION');

    const act = await h.call(A.hr2, 'POST', `/v1/increment-cycles/${c.id}/activate`, { expectedVersion: c.version });
    expect(act.statusCode).toBe(200);
    expect(act.json()).toMatchObject({ state: 'ACTIVE', activatedBy: A.hr2.user, closedRevisionId: null });
    expect((await h.call(A.hr2, 'POST', `/v1/increment-cycles/${c.id}/activate`, { expectedVersion: act.json().version })).json().error).toBe('INVALID_STATE');

    const edit = await h.call(A.hr1, 'PUT', `/v1/increment-cycles/${c.id}`, { ...withoutCode(commonBody('MIDYEAR', { excludeNotice: false })), expectedVersion: act.json().version });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error).toBe('CYCLE_ACTIVE');
    await expect(h.db.query(`update increment_cycle set exclude_notice = false where id = $1`, [c.id])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`update increment_cycle set active = false where id = $1`, [c.id])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`delete from increment_cycle where id = $1`, [c.id])).rejects.toMatchObject({ code: '23514' });

    const audit = await h.one<{ after_values: { operational: Record<string, unknown> }; acting_assignment_id: string; actor_user_id: string }>(
      `select after_values, acting_assignment_id, actor_user_id from audit_event where record_key = $1 and action = 'ACTIVATE'`,
      [c.id],
    );
    expect(audit).toMatchObject({ actor_user_id: A.hr2.user, acting_assignment_id: A.hr2.assignment });
    expect(audit.after_values.operational).toMatchObject({ code: 'MIDYEAR', revision: 1, state: 'ACTIVE', recurrenceBasis: 'COMMON_DATE' });
  });

  it('a new revision closes the previous one on its first day; both stay on record', async () => {
    const rev1 = (await cycles(A)).find((c) => c.code === 'MIDYEAR')!;
    const early = await h.call(A.hr1, 'POST', `/v1/increment-cycles/${rev1.id}/revisions`, withoutCode(commonBody('MIDYEAR', { effectiveFrom: '2025-06-01' })));
    expect(early.statusCode).toBe(422);

    const from = iso(Y + 1, 1, 1);
    const draft = await h.call(A.hr1, 'POST', `/v1/increment-cycles/${rev1.id}/revisions`, withoutCode(commonBody('MIDYEAR', { effectiveFrom: from })));
    expect(draft.statusCode).toBe(201);
    expect(draft.json()).toMatchObject({ code: 'MIDYEAR', revision: 2, state: 'DRAFT' });
    expect((await h.call(A.hr1, 'POST', `/v1/increment-cycles/${rev1.id}/revisions`, withoutCode(commonBody('MIDYEAR', { effectiveFrom: from })))).json().error).toBe('DRAFT_EXISTS');
    const edited = await h.call(A.hr1, 'PUT', `/v1/increment-cycles/${draft.json().id}`, {
      ...withoutCode(commonBody('MIDYEAR', { effectiveFrom: from, effectiveDate: { month: 11, day: 1 }, decisionsDue: { month: 10, day: 15 } })),
      expectedVersion: draft.json().version,
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ effectiveDate: { month: 11, day: 1 }, decisionsDue: { month: 10, day: 15 } });

    const act = await h.call(A.hr2, 'POST', `/v1/increment-cycles/${draft.json().id}/activate`, { expectedVersion: edited.json().version });
    expect(act.statusCode).toBe(200);
    expect(act.json()).toMatchObject({ state: 'ACTIVE', revision: 2, closedRevisionId: rev1.id });
    const history = (await cycles(A)).filter((c) => c.code === 'MIDYEAR');
    expect(history).toMatchObject([
      { revision: 1, state: 'ACTIVE', effectiveFrom: '2026-01-01', effectiveTo: from },
      { revision: 2, state: 'ACTIVE', effectiveFrom: from, effectiveTo: null },
    ]);
    // Each occurrence belongs to the revision in force on its date.
    expect((await open(A.hr1, rev1.id, Y + 1)).json().error).toBe('CYCLE_NOT_EFFECTIVE');
    expect(await roster(A.hr1, draft.json().id, Y + 1)).toMatchObject({ occurrence: `MIDYEAR:${Y + 1}`, effectiveDate: iso(Y + 1, 11, 1), decisionsDueOn: iso(Y + 1, 10, 15) });
    await expect(h.db.query(`update increment_cycle set effective_to = null where id = $1`, [rev1.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('activation never strands reviews of the revision in force, and only one company default is in force', async () => {
    const annual = (await cycles(A)).find((c) => c.code === 'ANNUAL')!;
    const joiner = await employee(A, 'ACTIVE_CONFIRMED', iso(Y - 2, 1, 10));
    const r = await roster(A.hr1, annual.id, Y);
    expect(r.roster.map((x) => x.employeeId)).toContain(joiner);

    const draft = (await h.call(A.hr1, 'POST', `/v1/increment-cycles/${annual.id}/revisions`, withoutCode(annualBody({ effectiveFrom: iso(Y, 1, 1) })))).json();
    const stranded = await h.call(A.hr2, 'POST', `/v1/increment-cycles/${draft.id}/activate`, { expectedVersion: draft.version });
    expect(stranded.statusCode).toBe(409);
    expect(stranded.json().error).toBe('CYCLE_IN_USE');
    // Starting after the opened review is accepted.
    const later = (await h.call(A.hr1, 'PUT', `/v1/increment-cycles/${draft.id}`, { ...withoutCode(annualBody({ effectiveFrom: iso(Y, 6, 1) })), expectedVersion: draft.version })).json();
    expect((await h.call(A.hr2, 'POST', `/v1/increment-cycles/${draft.id}/activate`, { expectedVersion: later.version })).json()).toMatchObject({ closedRevisionId: annual.id });

    const second = (await h.call(A.hr1, 'POST', '/v1/increment-cycles', commonBody('GROUPWIDE', { assignmentRule: 'COMPANY_DEFAULT' }))).json();
    const clash = await h.call(A.hr2, 'POST', `/v1/increment-cycles/${second.id}/activate`, { expectedVersion: second.version });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toBe('DEFAULT_CYCLE_EXISTS');
  });
});

describe('service-anniversary cycles (DF15, FR-091, ZT25)', () => {
  it('an anniversary cycle has no default offsets: the draft reports what is needed and cannot be activated', async () => {
    const d = (await h.call(B.hr1, 'POST', '/v1/increment-cycles', anniversaryBody('ANNIV'))).json();
    expect(d).toMatchObject({
      state: 'DRAFT',
      eligibilityRule: 'CONFIRMED_SERVICE_INTERVAL',
      effectiveDate: null,
      configurationNeeded: ['reviewOpenOffsetDays', 'rosterFreezeOffsetDays', 'decisionDueOffsetDays'],
    });
    const blocked = await h.call(B.hr2, 'POST', `/v1/increment-cycles/${d.id}/activate`, { expectedVersion: d.version });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({ error: 'CONFIGURATION_INCOMPLETE', details: { configurationNeeded: ['reviewOpenOffsetDays', 'rosterFreezeOffsetDays', 'decisionDueOffsetDays'] } });

    const put = (body: Record<string, unknown>, expectedVersion: number) => h.call(B.hr1, 'PUT', `/v1/increment-cycles/${d.id}`, { ...withoutCode(anniversaryBody('ANNIV', body)), expectedVersion });
    expect((await put({ reviewOpens: { month: 1, day: 1 } }, d.version)).json().error).toBe('INVALID_CYCLE');
    expect((await put({ reviewOpenOffsetDays: 30, rosterFreezeOffsetDays: 60, decisionDueOffsetDays: 15 }, d.version)).json().error).toBe('INVALID_CYCLE');
    expect((await put({ reviewOpenOffsetDays: 15, rosterFreezeOffsetDays: 15, decisionDueOffsetDays: 15 }, d.version)).json().error).toBe('INVALID_CYCLE');
    const partial = (await put({ reviewOpenOffsetDays: 90 }, d.version)).json();
    expect(partial.configurationNeeded).toEqual(['rosterFreezeOffsetDays', 'decisionDueOffsetDays']);
    const complete = (await put(OFFSETS, partial.version)).json();
    expect(complete.configurationNeeded).toEqual([]);
    const act = await h.call(B.hr2, 'POST', `/v1/increment-cycles/${d.id}/activate`, { expectedVersion: complete.version });
    expect(act.statusCode).toBe(200);
    annivId = d.id;
    await expect(h.db.query(`update increment_cycle set review_open_offset_days = null where id = $1`, [d.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('employees join the anniversary cycle through an independently approved assignment that keeps plan history', async () => {
    e.june = await employee(B, 'ACTIVE_CONFIRMED', iso(Y - 2, 6, 15));
    e.notice = await employee(B, 'NOTICE', iso(Y - 2, 6, 20));
    e.fresh = await employee(B, 'ACTIVE_CONFIRMED', iso(Y, 6, 5));
    e.noSalary = await employee(B, 'ACTIVE_CONFIRMED', iso(Y - 3, 6, 1), { salary: false });
    e.probation = await employee(B, 'ACTIVE_PROBATION', iso(Y - 2, 6, 25));
    e.annualJune = await employee(B, 'ACTIVE_CONFIRMED', iso(Y - 2, 6, 10)); // stays on the company default
    e.leap = await employee(B, 'ACTIVE_CONFIRMED', '2024-02-29');
    e.carried = await employee(B, 'ACTIVE_CONFIRMED', iso(Y - 2, 1, 10), { serviceDate: '2020-02-29' });
    e.over = await employee(B, 'ACTIVE_CONFIRMED', iso(Y - 2, 8, 20));

    const before = await plan(B.hr1, e.june!);
    expect(before).toMatchObject({ cycleCode: 'ANNUAL', assignment: 'COMPANY_DEFAULT', revisions: [] });

    // The proposer cannot approve; the decision is the other HR user's.
    const p = (await proposeChange(B.hr1, e.june!, { kind: 'ASSIGN_CYCLE', cycleId: annivId, effectiveFrom: today })).json();
    expect(p).toMatchObject({ kind: 'ASSIGN_CYCLE', state: 'PROPOSED', fromCycle: null, toCycle: 'ANNIV', effectiveFrom: today, nextReviewDate: nextAnniversary(6, 15) });
    expect((await decideChange(B.hr1, p.changeId, 'APPROVE')).json().error).toBe('INDEPENDENT_APPROVER_REQUIRED');
    const approved = (await decideChange(B.hr2, p.changeId, 'APPROVE')).json();
    expect(approved).toMatchObject({ state: 'APPROVED', applied: { toCycle: 'ANNIV', effectiveFrom: today } });
    for (const k of ['notice', 'fresh', 'noSalary', 'probation', 'leap', 'carried', 'over']) await assign(B, e[k]!, annivId);

    const after = await plan(B.hr1, e.june!);
    expect(after).toMatchObject({
      cycleCode: 'ANNIV',
      assignment: 'PLAN',
      nextReview: { occurrence: `ANNIV:${nextAnniversary(6, 15).slice(0, 4)}`, scheduledDate: nextAnniversary(6, 15), effectiveDate: nextAnniversary(6, 15), overridden: false },
    });
    expect(after.revisions).toMatchObject([{ cycleCode: 'ANNIV', effectiveFrom: today, effectiveTo: null, active: true, changeId: p.changeId }]);
    expect(after.changes).toMatchObject([{ id: p.changeId, kind: 'ASSIGN_CYCLE', state: 'APPROVED', decidedBy: B.hr2.user }]);
    expect(after.changes[0]).not.toHaveProperty('reason');
    expect((await proposeChange(B.hr1, e.june!, { kind: 'ASSIGN_CYCLE', cycleId: annivId, effectiveFrom: today })).json().error).toBe('NO_CHANGE');
    expect((await proposeChange(B.hr1, e.june!, { kind: 'ASSIGN_CYCLE', cycleId: annualB, effectiveFrom: addDays(today, -1) })).statusCode).toBe(422);
  });

  it('opens the cases of a month for the employees whose anniversary falls in it and explains every exclusion', async () => {
    const r = await roster(B.hr1, annivId, Y, 6);
    const eff = iso(Y, 6, 15);
    expect(r).toMatchObject({ cycleCode: 'ANNIV', period: `${Y}-06`, created: 1, run: 1 });
    expect(r.roster).toEqual([{ caseId: r.caseIds[0], employeeId: e.june, occurrence: `ANNIV:${Y}`, effectiveDate: eff, decisionDueOn: addDays(eff, -15) }]);
    const reasons = reasonsOf(r);
    expect(reasons[e.notice!]).toBe('ON_NOTICE');
    expect(reasons[e.fresh!]).toBe('SERVICE_INTERVAL_NOT_COMPLETED');
    expect(reasons[e.noSalary!]).toBe('NO_SALARY_BASELINE');
    expect(reasons[e.probation!]).toBe('NOT_CONFIRMED');
    expect(reasons).not.toHaveProperty(e.annualJune!); // on the company default cycle, not this one
    expect(reasons).not.toHaveProperty(e.over!); // August anniversary
    expect(r.repairPaths.NO_SALARY_BASELINE).toMatch(/salary arrangement/);
    expect(r.repairPaths.SERVICE_INTERVAL_NOT_COMPLETED).toBeDefined();

    const k = await h.one(
      `select state, cycle_occurrence_key, proposed_effective_date, review_opens_on, roster_freezes_on, decision_due_on, baseline_amount::text as baseline
         from increment_case where id = $1`,
      [r.caseIds[0]],
    );
    expect(k).toEqual({
      state: 'DRAFT',
      cycle_occurrence_key: `ANNIV:${Y}`,
      proposed_effective_date: eff,
      review_opens_on: addDays(eff, -90),
      roster_freezes_on: addDays(eff, -60),
      decision_due_on: addDays(eff, -15),
      baseline: '50000.0000',
    });
    // A due review is not a raise.
    expect((await h.call(B.hr1, 'GET', `/v1/employees/${e.june}/salary`)).json().items).toHaveLength(1);

    const again = await roster(B.hr1, annivId, Y, 6);
    expect(again).toMatchObject({ created: 0, run: 2 });
    expect(again.excluded).toContainEqual({ employeeId: e.june, reason: 'ALREADY_IN_REVIEW' });
    expect((await h.one<{ n: number }>(`select count(*)::int as n from increment_case where employee_id = $1`, [e.june])).n).toBe(1);

    const audit = await h.one<{ after_values: { operational: Record<string, unknown> } }>(
      `select after_values from audit_event where record_key = $1 and action = 'OPEN_REVIEW' order by created_at desc limit 1`,
      [annivId],
    );
    expect(audit.after_values.operational).toEqual({ period: `${Y}-06`, run: 2, created: 0, excluded: again.excluded.length });
  });

  it('the company-default annual cycle reviews unassigned employees only', async () => {
    const r = await roster(B.hr1, annualB, Y);
    expect(r.roster.map((x) => x.employeeId)).toContain(e.annualJune);
    const listed = new Set([...r.roster.map((x) => x.employeeId), ...r.excluded.map((x) => x.employeeId)]);
    for (const k of ['june', 'notice', 'fresh', 'noSalary', 'probation', 'leap', 'carried', 'over']) expect(listed.has(e[k]!)).toBe(false);
    expect(reasonsOf(r)[B.managerEmp]).toBe('NO_SALARY_BASELINE');
  });

  it('29 February falls on 28 February in a non-leap year, and a carried service date replaces the joining date', async () => {
    let nonLeap = Y;
    while (isLeap(nonLeap)) nonLeap++;
    const r = await roster(B.hr1, annivId, nonLeap, 2);
    expect(r.roster).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ employeeId: e.leap, occurrence: `ANNIV:${nonLeap}`, effectiveDate: iso(nonLeap, 2, 28) }),
        expect.objectContaining({ employeeId: e.carried, occurrence: `ANNIV:${nonLeap}`, effectiveDate: iso(nonLeap, 2, 28) }),
      ]),
    );
    // The carried employee joined in January: the January roster does not include them.
    const january = await roster(B.hr1, annivId, nonLeap, 1);
    expect(new Set([...january.roster.map((x) => x.employeeId), ...january.excluded.map((x) => x.employeeId)]).has(e.carried!)).toBe(false);
  });

  it('a two-year interval reviews whole intervals of service only', async () => {
    const d = (await h.call(B.hr1, 'POST', '/v1/increment-cycles', anniversaryBody('BIENNIAL', { ...OFFSETS, recurrenceInterval: 2 }))).json();
    const biennial = d.id as string;
    expect((await h.call(B.hr2, 'POST', `/v1/increment-cycles/${biennial}/activate`, { expectedVersion: d.version })).statusCode).toBe(200);
    const one = await employee(B, 'ACTIVE_CONFIRMED', iso(Y - 1, 3, 10));
    const two = await employee(B, 'ACTIVE_CONFIRMED', iso(Y - 2, 3, 12));
    const three = await employee(B, 'ACTIVE_CONFIRMED', iso(Y - 3, 3, 14));
    for (const x of [one, two, three]) await assign(B, x, biennial);
    const r = await roster(B.hr1, biennial, Y, 3);
    expect(r.roster.map((x) => x.employeeId)).toEqual([two]);
    expect(r.roster[0]).toMatchObject({ occurrence: `BIENNIAL:${Y}`, effectiveDate: iso(Y, 3, 12) });
    expect(reasonsOf(r)[one]).toBe('SERVICE_INTERVAL_NOT_COMPLETED');
    expect(reasonsOf(r)).not.toHaveProperty(three); // three years of service: not a review year
    const threeNext = iso(Y - 1, 3, 14) >= today ? Y - 1 : Y + 1; // the 2nd or the 4th year of service
    expect((await plan(B.hr1, three)).nextReview).toMatchObject({ occurrence: `BIENNIAL:${threeNext}`, scheduledDate: iso(threeNext, 3, 14) });
  });

  it('an approved separation before the effective date excludes the employee (DF15)', async () => {
    const leaving = await employee(B, 'ACTIVE_CONFIRMED', iso(Y - 2, 12, 1));
    const staying = await employee(B, 'ACTIVE_CONFIRMED', iso(Y - 2, 12, 3));
    await assign(B, leaving, annivId);
    await assign(B, staying, annivId);
    await approvedExit(B.co, leaving, iso(Y, 11, 30));
    await approvedExit(B.co, staying, iso(Y, 12, 31));
    const r = await roster(B.hr1, annivId, Y, 12);
    expect(reasonsOf(r)[leaving]).toBe('SEPARATION_BEFORE_EFFECTIVE_DATE');
    expect(r.roster.map((x) => x.employeeId)).toEqual([staying]);
  });

  it('concurrent openings of the same month never duplicate a case', async () => {
    const j1 = await employee(B, 'ACTIVE_CONFIRMED', iso(Y - 2, 7, 3));
    const j2 = await employee(B, 'ACTIVE_CONFIRMED', iso(Y - 3, 7, 21));
    await assign(B, j1, annivId);
    await assign(B, j2, annivId);
    const [a, b] = await Promise.all([open(B.hr1, annivId, Y, 7), open(B.hr2, annivId, Y, 7)]);
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    // Two workers at once: each claims one job, and the chunks take the cycle code lock one after the other.
    await Promise.all([drain(), drain()]);
    const [ja, jb] = [await job(B.hr1, a.json().jobId), await job(B.hr2, b.json().jobId)];
    expect([ja.state, jb.state]).toEqual(['COMPLETED', 'COMPLETED']);
    expect(ja.result.created + jb.result.created).toBe(2);
    expect([ja.result.run, jb.result.run].sort()).toEqual([1, 2]);
    const n = await h.one<{ n: number }>(`select count(*)::int as n from increment_case where employee_id = any($1::uuid[]) and cycle_occurrence_key = $2`, [[j1, j2], `ANNIV:${Y}`]);
    expect(n.n).toBe(2);
  });

  it('a month opens only on an anniversary cycle in force, for the right role and scope', async () => {
    expect((await open(B.hr1, annivId, Y)).json().error).toBe('RULE_VIOLATION'); // the month is required
    expect((await open(B.hr1, annualB, Y, 6)).json().error).toBe('RULE_VIOLATION'); // a common-date review opens for a year
    expect((await open(B.manager, annivId, Y, 6)).statusCode).toBe(403);
    const deptHr = await h.actor(B.co, 'HR_ADMINISTRATOR', { departmentFilter: B.co.dept });
    expect((await open(deptHr, annivId, Y, 6)).statusCode).toBe(403);
    expect((await open(A.hr1, annivId, Y, 6)).json().error).toBe('CYCLE_NOT_CONFIGURED'); // another company's cycle
    expect((await open(B.hr1, annivId, 2025, 12)).json().error).toBe('CYCLE_NOT_EFFECTIVE');
  });

  it('after an employee\'s roster freeze date a rerun adds no case for them', async () => {
    const C = await org();
    const cycle = await anniversaryCycle(C, 'ANNIV');
    let anniversary = addDays(today, 30); // roster froze 30 days ago, decisions due in 15 days
    if (anniversary.endsWith('-02-29')) anniversary = addDays(today, 31);
    const [ay, am, ad] = anniversary.split('-').map(Number) as [number, number, number];
    const first = await employee(C, 'ACTIVE_CONFIRMED', iso(ay - 2, am, ad));
    const late = await employee(C, 'ACTIVE_PROBATION', iso(ay - 2, am, ad));
    await assign(C, first, cycle);
    await assign(C, late, cycle);

    // The first opening takes the snapshot even though the freeze date has passed.
    const r1 = await roster(C.hr1, cycle, ay, am);
    expect(r1.roster.map((x) => x.employeeId)).toEqual([first]);
    expect(reasonsOf(r1)[late]).toBe('NOT_CONFIRMED');
    await h.setStatus(C.co, late, 'ACTIVE_CONFIRMED');
    const r2 = await roster(C.hr1, cycle, ay, am);
    expect(r2.created).toBe(0);
    expect(reasonsOf(r2)[late]).toBe('ROSTER_FROZEN');
    expect(r2.repairPaths.ROSTER_FROZEN).toMatch(/off-cycle/);
  });

  it('an opening that ended FAILED after creating cases makes the next opening of the month a rerun', async () => {
    const C = await org();
    const cycle = await anniversaryCycle(C, 'ANNIV');
    let anniversary = addDays(today, 30); // roster froze 30 days ago
    if (anniversary.endsWith('-02-29')) anniversary = addDays(today, 31);
    const [ay, am, ad] = anniversary.split('-').map(Number) as [number, number, number];
    const pair = [await employee(C, 'ACTIVE_CONFIRMED', iso(ay - 2, am, ad)), await employee(C, 'ACTIVE_CONFIRMED', iso(ay - 2, am, ad))];
    for (const id of pair) await assign(C, id, cycle);
    // In the opening's order (employee code): the failed job reaches the first and never the second.
    const [first, second] = (await h.db.query<{ id: string }>(`select id from employee where id = any($1::uuid[]) order by employee_code`, [pair])).rows.map((r) => r.id);
    const hasCase = async (employeeId: string) =>
      (await h.one<{ n: number }>(`select count(*)::int as n from increment_case where employee_id = $1 and cycle_occurrence_key = $2`, [employeeId, `ANNIV:${ay}`])).n > 0;

    const opener = await h.actor(C.co, 'HR_ADMINISTRATOR');
    const res = await open(opener, cycle, ay, am);
    expect(res.statusCode).toBe(202);
    const failed = res.json().jobId as string;
    for (let i = 0; i < 5 && !(await hasCase(first!)); i++) expect(await runBulkJobs(h.pool, 1, { chunkSize: 1 })).toBe(1);
    expect([await hasCase(first!), await hasCase(second!)]).toEqual([true, false]);
    // The opener loses the cycle duty: the next chunk ends the job FAILED, and no run is recorded.
    await h.db.query(
      `update role_assignment_permission rap set active = false from permission p
        where p.id = rap.permission_id and rap.role_assignment_id = $1 and p.resource = 'increment_cycle' and p.action = 'manage'`,
      [opener.assignment],
    );
    expect(await runBulkJobs(h.pool, 1, { chunkSize: 1 })).toBe(1);
    expect(await h.one(`select state, error_code from bulk_job where id = $1`, [failed])).toEqual({ state: 'FAILED', error_code: 'ACCESS_REVOKED' });
    expect(await h.one(`select count(*)::int as n from increment_review_run where company_id = $1`, [C.co.id])).toEqual({ n: 0 });

    // The failed job's case stands, so the next opening is a rerun: past the freeze date it adds no case for the
    // employee the failed job never reached. Its run number counts completed openings only.
    const r = await roster(C.hr1, cycle, ay, am);
    expect(r).toMatchObject({ rerun: true, run: 1, created: 0 });
    expect(reasonsOf(r)).toEqual({ [first!]: 'ALREADY_IN_REVIEW', [second!]: 'ROSTER_FROZEN' });
  });
});

describe('employee-specific review-date overrides (DF15, DB102, C4)', () => {
  let next: { occurrence: string; scheduledDate: string; effectiveDate: string };
  let target: string;
  let changeId: string;

  it('validates the new date against the schedule and refuses the employee concerned and the proposer as decider', async () => {
    next = (await plan(B.hr1, e.over!)).nextReview;
    expect(next).toMatchObject({ scheduledDate: nextAnniversary(8, 20), effectiveDate: nextAnniversary(8, 20) });
    target = addDays(next.scheduledDate, 45);

    expect((await proposeOverride(B.hr1, e.over!, addDays(today, -1))).statusCode).toBe(422);
    expect((await proposeOverride(B.hr1, e.over!, next.scheduledDate)).json().error).toBe('NO_CHANGE');
    expect((await proposeOverride(B.hr1, e.over!, addDays(next.scheduledDate, 400))).json().error).toBe('RULE_VIOLATION'); // past the following review
    expect((await proposeChange(B.hr1, e.over!, { kind: 'REVIEW_DATE_OVERRIDE' })).statusCode).toBe(422);

    // The employee concerned never proposes or decides, whatever their role.
    const selfHr = await h.actor(B.co, 'HR_ADMINISTRATOR', { employeeId: e.over! });
    expect((await proposeOverride(selfHr, e.over!, target)).json().error).toBe('SELF_ACTION');
    // Out of scope or without the duty.
    const finHr = await h.actor(B.co, 'HR_ADMINISTRATOR', { departmentFilter: B.co.financeDept });
    expect((await proposeOverride(finHr, e.over!, target)).statusCode).toBe(404);
    expect((await proposeOverride(B.manager, e.over!, target)).statusCode).toBe(403);
    expect((await proposeOverride(A.hr1, e.over!, target)).statusCode).toBe(404);

    const p = await proposeOverride(B.hr1, e.over!, target);
    expect(p.statusCode).toBe(201);
    expect(p.json()).toMatchObject({ state: 'PROPOSED', occurrence: next.occurrence, scheduledDate: next.scheduledDate, currentDate: next.scheduledDate, overrideDate: target });
    changeId = p.json().changeId;
    expect((await proposeOverride(B.hr2, e.over!, addDays(target, 1))).json().error).toBe('OPEN_PROPOSAL_EXISTS');

    const pending = (await h.call(B.hr2, 'GET', '/v1/increment-plan-changes/pending')).json().items;
    expect(pending).toContainEqual(expect.objectContaining({ id: changeId, ownProposal: false, overrideDate: target }));
    expect(pending.find((x: { id: string }) => x.id === changeId)).not.toHaveProperty('reason');
    const reasonDecider = await h.actor(B.co, 'HR_ADMINISTRATOR', { extra: ['increment.read.reason'] });
    expect((await h.call(reasonDecider, 'GET', '/v1/increment-plan-changes/pending')).json().items.find((x: { id: string }) => x.id === changeId)).toMatchObject({ reason: REASON });
    expect((await h.call(B.manager, 'GET', '/v1/increment-plan-changes/pending')).statusCode).toBe(403);

    expect((await decideChange(B.hr1, changeId, 'APPROVE')).json().error).toBe('INDEPENDENT_APPROVER_REQUIRED');
    expect((await decideChange(selfHr, changeId, 'APPROVE')).json().error).toBe('SELF_ACTION');
    expect((await decideChange(finHr, changeId, 'APPROVE')).statusCode).toBe(404);
    expect((await decideChange(A.hr2, changeId, 'APPROVE')).statusCode).toBe(404);
    expect((await decideChange(B.manager, changeId, 'APPROVE')).statusCode).toBe(403);
    expect((await decideChange(B.hr2, randomUUID(), 'APPROVE')).statusCode).toBe(404);
    expect((await h.call(B.hr2, 'POST', `/v1/increment-plan-changes/${changeId}/withdraw`)).statusCode).toBe(404); // not the proposer
  });

  it('the approved override is a new plan revision; the replaced revision is kept and approved rows never change', async () => {
    const ok = await decideChange(B.hr2, changeId, 'APPROVE');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ state: 'APPROVED', applied: { occurrence: next.occurrence, scheduledDate: next.scheduledDate, from: next.scheduledDate, to: target } });
    expect((await decideChange(B.hr2, changeId, 'REJECT')).json().error).toBe('INVALID_STATE');

    const after = await plan(B.hr1, e.over!);
    expect(after.nextReview).toEqual({ occurrence: next.occurrence, scheduledDate: next.scheduledDate, effectiveDate: target, overridden: true });
    expect(after.revisions).toHaveLength(2);
    const [assigned, overridden] = after.revisions;
    expect(assigned).toMatchObject({ active: false, effectiveTo: null, overrideReviewDate: null });
    expect(assigned.supersededAt).not.toBeNull();
    expect(overridden).toMatchObject({
      active: true,
      cycleCode: 'ANNIV',
      effectiveFrom: assigned.effectiveFrom,
      nextReviewDate: next.scheduledDate,
      overrideReviewDate: target,
      overrideOccurrence: next.occurrence,
      overrideApprovedBy: B.hr2.user,
      supersedesId: assigned.id,
      changeId,
    });
    expect(overridden).not.toHaveProperty('overrideReason'); // the reason is its own confidential group
    const reader = await h.actor(B.co, 'HR_ADMINISTRATOR', { extra: ['increment.read.reason'] });
    expect((await plan(reader, e.over!)).revisions[1].overrideReason).toBe(REASON);
    expect((await h.call(await h.actor(B.co, 'AUDITOR'), 'GET', `/v1/employees/${e.over}/increment-plan`)).statusCode).toBe(403);

    await expect(h.db.query(`update employee_increment_plan set override_review_date = $2 where id = $1`, [overridden.id, addDays(target, 1)])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`update employee_increment_plan set superseded_at = null where id = $1`, [assigned.id])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`delete from employee_increment_plan where id = $1`, [overridden.id])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`update increment_plan_change set state = 'REJECTED' where id = $1`, [changeId])).rejects.toMatchObject({ code: '23514' });

    const audit = await h.one<{ after_values: Record<string, unknown>; reason: string | null }>(
      `select after_values, reason from audit_event where resource_code = 'employee_increment_plan' and record_key = $1`,
      [overridden.id],
    );
    expect(audit.after_values).toMatchObject({ operational: { occurrence: next.occurrence, from: next.scheduledDate, to: target } });
    expect(JSON.stringify(audit.after_values)).not.toContain(REASON);
    const decision = await h.one<{ reason: string | null }>(`select reason from audit_event where resource_code = 'increment_plan_change' and record_key = $1 and action = 'APPROVE'`, [changeId]);
    expect(decision.reason).toBe('Checked against the schedule (synthetic)');
  });

  it('the override decides the effective date when the review opens', async () => {
    const [sy, sm] = next.scheduledDate.split('-').map(Number) as [number, number];
    const scheduled = await roster(B.hr1, annivId, sy, sm);
    expect(scheduled.excluded).toContainEqual({ employeeId: e.over, reason: 'REVIEW_RESCHEDULED' });
    expect(scheduled.roster.map((x) => x.employeeId)).not.toContain(e.over);

    const [ty, tm] = target.split('-').map(Number) as [number, number];
    const moved = await roster(B.hr1, annivId, ty, tm);
    expect(moved.roster).toContainEqual({ caseId: expect.any(String), employeeId: e.over, occurrence: next.occurrence, effectiveDate: target, decisionDueOn: addDays(target, -15) });
    expect((await roster(B.hr1, annivId, ty, tm)).excluded).toContainEqual({ employeeId: e.over, reason: 'ALREADY_IN_REVIEW' });
    // The review that took place is no longer the next one.
    expect((await plan(B.hr1, e.over!)).nextReview.occurrence).not.toBe(next.occurrence);
  });

  it('a common-date override lets a late joiner be reviewed, with the cutoff and window of the new date', async () => {
    const ay = iso(Y - 1, 4, 1) >= today ? Y - 1 : Y;
    const late = await employee(B, 'ACTIVE_CONFIRMED', iso(ay - 1, 10, 15));
    expect(reasonsOf(await roster(B.hr1, annualB, ay))[late]).toBe('JOINED_AFTER_CUTOFF');
    expect(await plan(B.hr1, late)).toMatchObject({
      cycleCode: 'ANNUAL',
      assignment: 'COMPANY_DEFAULT',
      nextReview: { occurrence: `ANNUAL:${ay}`, scheduledDate: iso(ay, 4, 1), effectiveDate: iso(ay, 4, 1), overridden: false },
    });
    const newDate = iso(ay, 10, 15);
    const p = (await proposeOverride(B.hr1, late, newDate)).json();
    expect((await decideChange(B.hr2, p.changeId, 'APPROVE')).statusCode).toBe(200);
    const plans = (await plan(B.hr1, late)).revisions;
    expect(plans).toMatchObject([{ cycleCode: 'ANNUAL', effectiveFrom: iso(ay - 1, 10, 15), overrideReviewDate: newDate, supersedesId: null, active: true }]);

    const r = await roster(B.hr1, annualB, ay);
    // 1 April with decisions due 15 March: the same 17-day lead before the new date.
    expect(r.roster).toContainEqual({ caseId: expect.any(String), employeeId: late, occurrence: `ANNUAL:${ay}`, effectiveDate: newDate, decisionDueOn: addDays(newDate, -17) });
  });

  it('concurrent decisions apply one revision; rejected and withdrawn proposals change nothing', async () => {
    const hr3 = await h.actor(B.co, 'HR_ADMINISTRATOR');
    const x = await employee(B, 'ACTIVE_CONFIRMED', iso(Y - 2, 9, 9));
    const p = (await proposeChange(B.hr1, x, { kind: 'ASSIGN_CYCLE', cycleId: annivId, effectiveFrom: today })).json();
    const [d1, d2] = await Promise.all([decideChange(B.hr2, p.changeId, 'APPROVE'), decideChange(hr3, p.changeId, 'APPROVE')]);
    expect([d1.statusCode, d2.statusCode].sort()).toEqual([200, 409]);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from employee_increment_plan where employee_id = $1`, [x])).n).toBe(1);

    const nextReview = (await plan(B.hr1, x)).nextReview;
    const rejected = (await proposeOverride(B.hr1, x, addDays(nextReview.scheduledDate, 10))).json();
    expect((await decideChange(B.hr2, rejected.changeId, 'REJECT')).json()).toMatchObject({ state: 'REJECTED', planId: null });
    const withdrawn = (await proposeOverride(B.hr1, x, addDays(nextReview.scheduledDate, 20))).json();
    expect((await h.call(B.hr1, 'POST', `/v1/increment-plan-changes/${withdrawn.changeId}/withdraw`)).json()).toMatchObject({ state: 'WITHDRAWN' });
    expect((await h.call(B.hr1, 'POST', `/v1/increment-plan-changes/${withdrawn.changeId}/withdraw`)).json().error).toBe('INVALID_STATE');
    const after = await plan(B.hr1, x);
    expect(after.revisions).toHaveLength(1);
    expect(after.nextReview).toMatchObject({ effectiveDate: nextReview.scheduledDate, overridden: false });
    expect(after.changes.map((c: { state: string }) => c.state)).toEqual(['APPROVED', 'REJECTED', 'WITHDRAWN']);
  });

  it("a new revision cannot start between a review's scheduled date and its approved new date", async () => {
    const D = await org();
    const cycle = await anniversaryCycle(D, 'ANNIV');
    const x = await employee(D, 'ACTIVE_CONFIRMED', iso(Y - 2, 5, 5));
    await assign(D, x, cycle);
    const scheduled = (await plan(D.hr1, x)).nextReview.scheduledDate as string;
    expect(scheduled).toBe(nextAnniversary(5, 5));
    const moved = addDays(scheduled, 30);
    expect((await decideChange(D.hr2, (await proposeOverride(D.hr1, x, moved)).json().changeId, 'APPROVE')).statusCode).toBe(200);

    const draft = (await h.call(D.hr1, 'POST', `/v1/increment-cycles/${cycle}/revisions`, withoutCode(anniversaryBody('ANNIV', { ...OFFSETS, effectiveFrom: addDays(scheduled, 10) })))).json();
    const crossing = await h.call(D.hr2, 'POST', `/v1/increment-cycles/${draft.id}/activate`, { expectedVersion: draft.version });
    expect(crossing.statusCode).toBe(409);
    expect(crossing.json().error).toBe('CYCLE_IN_USE');
    expect(crossing.json().message).toContain(moved);
    const later = (
      await h.call(D.hr1, 'PUT', `/v1/increment-cycles/${draft.id}`, { ...withoutCode(anniversaryBody('ANNIV', { ...OFFSETS, effectiveFrom: addDays(moved, 1) })), expectedVersion: draft.version })
    ).json();
    expect((await h.call(D.hr2, 'POST', `/v1/increment-cycles/${draft.id}/activate`, { expectedVersion: later.version })).statusCode).toBe(200);
    // The rescheduled review still opens under the revision that governs it.
    const [my, mm] = moved.split('-').map(Number) as [number, number];
    expect((await roster(D.hr1, cycle, my, mm)).roster).toContainEqual(expect.objectContaining({ employeeId: x, occurrence: `ANNIV:${scheduled.slice(0, 4)}`, effectiveDate: moved }));
  });

  it('an assignment never starts before a review of the current cycle that takes effect on or after it', async () => {
    // annualJune has an ANNUAL case effective 1 April of next year (opened above).
    const res = await proposeChange(B.hr1, e.annualJune!, { kind: 'ASSIGN_CYCLE', cycleId: annivId, effectiveFrom: today });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('PLAN_CHANGE_CONFLICT');
  });

  it('approval re-validates the plan the proposal was made for', async () => {
    const x = await employee(B, 'ACTIVE_CONFIRMED', iso(Y - 2, 11, 11));
    const p = (await proposeChange(B.hr1, x, { kind: 'ASSIGN_CYCLE', cycleId: annivId, effectiveFrom: today })).json();
    // The plan changes underneath the proposal (synthetic: an implicit company-default plan appears).
    await h.db.query(
      `insert into employee_increment_plan (company_id, employee_id, cycle_id, effective_from, next_review_date, active) values ($1, $2, $3, $4, $5, true)`,
      [B.co.id, x, annualB, iso(Y - 2, 11, 11), iso(Y, 4, 1)],
    );
    const stale = await decideChange(B.hr2, p.changeId, 'APPROVE');
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('STALE_PLAN');
    expect((await h.one<{ state: string }>(`select state from increment_plan_change where id = $1`, [p.changeId])).state).toBe('PROPOSED');
  });
});

describe('review due reminders (DF15 30/7/1 days before closing)', () => {
  let caseId: string;
  let due: string;

  beforeAll(async () => {
    // Provisioning adds the reminder templates and rules (in-app, operational placeholders) with the core catalogue.
    for (const n of INCREMENT_REVIEW_NOTIFICATIONS) {
      const rule = await h.one<{ selector: string }>(`select recipient_selector as selector from notification_rule where company_id = $1 and code = $2 and active`, [B.co.id, n.code]);
      expect(rule.selector).toBe(n.selector);
    }
    const k = await h.one<{ id: string; due: string }>(
      `select id, to_char(decision_due_on, 'YYYY-MM-DD') as due from increment_case where employee_id = $1 and cycle_occurrence_key = $2`,
      [e.june, `ANNIV:${Y}`],
    );
    caseId = k.id;
    due = k.due;
  });

  const notified = async (userId: string, category: string) =>
    (
      await h.db.query<{ title: string; body: string }>(
        `select n.title, n.body from notification n join notification_event ev on ev.company_id = n.company_id and ev.id = n.event_id
          where n.company_id = $1 and n.recipient_user_id = $2 and n.category = $3 and ev.event_key like $4 and n.state = 'DELIVERED'`,
        [B.co.id, userId, category, `%${caseId}%`],
      )
    ).rows;

  it('reminds the manager while the proposal is open, once per lead day and never on other days', async () => {
    const r30 = await runIncrementReviewReminders(h.pool, B.co.id, addDays(due, -30));
    expect(r30.events).toBeGreaterThanOrEqual(1);
    const sent = await notified(B.manager.user, 'INCREMENT_PROPOSAL_DUE');
    expect(sent).toHaveLength(1);
    const code = (await h.one<{ code: string }>(`select employee_code as code from employee where id = $1`, [e.june])).code;
    expect(sent[0]!.body).toContain(code);
    expect(sent[0]!.body).toContain(due);
    expect(sent[0]!.body).not.toMatch(/50000|600000/);

    await runIncrementReviewReminders(h.pool, B.co.id, addDays(due, -30));
    await runIncrementReviewReminders(h.pool, B.co.id, addDays(due, -29));
    expect(await notified(B.manager.user, 'INCREMENT_PROPOSAL_DUE')).toHaveLength(1);
    const data = await h.one<{ data: Record<string, string> }>(`select data from notification_event where company_id = $1 and event_key = $2`, [
      B.co.id,
      `INCREMENT_PROPOSAL_DUE:${caseId}:${due}:30`,
    ]);
    expect(Object.keys(data.data).sort()).toEqual(['days', 'dueDate', 'employeeCode', 'employeeName']);
  });

  it('a submitted proposal reminds the assigned reviewer of the decision; a terminal outcome stops the reminders', async () => {
    const c = (await h.call(B.hr1, 'GET', '/v1/increment-cases')).json().items.find((x: { id: string }) => x.id === caseId);
    expect(c).toMatchObject({ state: 'DRAFT', decisionDueOn: due });
    const proposal = await h.call(B.manager, 'POST', `/v1/increment-cases/${caseId}/proposal`, {
      expectedVersion: c.version,
      outcome: 'INCREASE',
      proposedAmount: '55000',
      proposedCounterpart: '660000',
      reason: 'Anniversary review (synthetic)',
    });
    expect(proposal.statusCode).toBe(200);
    await runIncrementReviewReminders(h.pool, B.co.id, addDays(due, -7));
    expect(await notified(B.hr2.user, 'INCREMENT_DECISION_DUE')).toHaveLength(1);
    expect(await notified(B.manager.user, 'INCREMENT_DECISION_DUE')).toHaveLength(0);
    expect(await notified(B.manager.user, 'INCREMENT_PROPOSAL_DUE')).toHaveLength(1);

    const task = ((await h.call(B.hr2, 'GET', '/v1/increment-cases/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[]).find((t) => t.ownerEmployeeId === e.june)!;
    const decided = await h.call(B.hr2, 'POST', `/v1/increment-cases/tasks/${task.taskId}/decision`, { decision: 'APPROVE', reason: 'Independent review (synthetic)', idempotencyKey: `inc-${randomUUID()}` });
    expect(decided.json()).toMatchObject({ state: 'APPLIED', changePercent: '10.00' });
    const quiet = await runIncrementReviewReminders(h.pool, B.co.id, addDays(due, -1));
    expect(await h.one<{ n: number }>(`select count(*)::int as n from notification_event where company_id = $1 and event_key like $2`, [B.co.id, `%${caseId}:${due}:1`])).toEqual({ n: 0 });
    expect(quiet.day).toBe(addDays(due, -1));
  });

  it('off-cycle cases carry no review window and are never reminded', async () => {
    const res = await h.call(B.hr2, 'POST', '/v1/increment-cases/off-cycle', {
      employeeId: e.annualJune,
      effectiveDate: iso(Y, 9, 1),
      proposedAmount: '52000',
      proposedCounterpart: '624000',
      reason: 'Off-cycle adjustment (synthetic)',
    });
    expect(res.statusCode).toBe(201);
    const k = await h.one(`select review_opens_on, roster_freezes_on, decision_due_on from increment_case where id = $1`, [res.json().caseId]);
    expect(k).toEqual({ review_opens_on: null, roster_freezes_on: null, decision_due_on: null });
  });
});

describe('required appraisal (DF15 "completed required appraisal where that module is enabled")', () => {
  let C: Org;
  let apprCycle: string;
  let apprCycleA: string;
  let cycle: string;

  /** An appraisal cycle of a company (appraisal fixture: a twelve-month period starting on the first of a month). */
  const appraisalCycle = async (co: Company, code: string) =>
    (
      await h.one<{ id: string }>(`insert into appraisal_cycle (company_id, code, name, start_date, end_date) values ($1, $2, $3, $4, $5) returning id`, [
        co.id,
        code,
        `${code} appraisal (synthetic)`,
        iso(Y - 2, 4, 1),
        iso(Y - 1, 3, 31),
      ])
    ).id;

  /** Moves an appraisal to APPROVED with its transaction in one transaction, as the appraisal module does. */
  async function approveAppraisal(appraisalId: string) {
    await h.db.query('begin');
    try {
      const bt = (await h.db.query<{ transaction_id: string }>(`select transaction_id from appraisal where id = $1`, [appraisalId])).rows[0]!.transaction_id;
      for (const s of ['SUBMITTED', 'IN_REVIEW', 'APPROVED']) await h.db.query(`update business_transaction set state = $2 where id = $1`, [bt, s]);
      await h.db.query(`update appraisal set state = 'APPROVED', final_rating = 4, completed_at = now() where id = $1`, [appraisalId]);
      await h.db.query('commit');
    } catch (err) {
      await h.db.query('rollback');
      throw err;
    }
  }

  /** A draft appraisal of the employee in the cycle (appraisal fixture). */
  async function draftAppraisal(co: Company, employeeId: string, cycleId: string): Promise<string> {
    await h.db.query('begin');
    try {
      const bt = (await h.db.query<{ id: string }>(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'appraisal', $2, 'DRAFT') returning id`, [co.id, employeeId]))
        .rows[0]!.id;
      const id = (
        await h.db.query<{ id: string }>(
          `insert into appraisal (company_id, cycle_id, period_start, period_end, employee_id, transaction_id, state, source)
           select $1, c.id, c.start_date, c.end_date, $2, $3, 'DRAFT', 'MANUAL' from appraisal_cycle c where c.id = $4 returning id`,
          [co.id, employeeId, bt, cycleId],
        )
      ).rows[0]!.id;
      await h.db.query('commit');
      return id;
    } catch (err) {
      await h.db.query('rollback');
      throw err;
    }
  }

  beforeAll(async () => {
    C = await org();
    apprCycle = await appraisalCycle(C.co, 'PERF-PRIOR');
    apprCycleA = await appraisalCycle(A.co, 'PERF-OTHER');
  });

  it('the required appraisal cycle is company configuration: validated, no default, frozen with the activated revision', async () => {
    for (const id of [randomUUID(), apprCycleA]) {
      const bad = await h.call(C.hr1, 'POST', '/v1/increment-cycles', commonBody('APPRAISED', { requiredAppraisalCycleId: id }));
      expect(bad.statusCode).toBe(422);
      expect(bad.json()).toMatchObject({ error: 'INVALID_CYCLE', details: { problems: [expect.stringContaining('requiredAppraisalCycleId')] } });
    }
    const d0 = (await h.call(C.hr1, 'POST', '/v1/increment-cycles', commonBody('APPRAISED'))).json();
    expect(d0).toMatchObject({ state: 'DRAFT', requiredAppraisalCycleId: null });
    // The editor who sets the requirement authors the definition and cannot activate it either (C4).
    const d = (
      await h.call(C.hr2, 'PUT', `/v1/increment-cycles/${d0.id}`, { ...withoutCode(commonBody('APPRAISED', { requiredAppraisalCycleId: apprCycle })), expectedVersion: d0.version })
    ).json();
    expect(d).toMatchObject({ state: 'DRAFT', requiredAppraisalCycleId: apprCycle });
    const selfActivation = await h.call(C.hr2, 'POST', `/v1/increment-cycles/${d.id}/activate`, { expectedVersion: d.version });
    expect(selfActivation.statusCode).toBe(403);
    expect(selfActivation.json().error).toBe('SELF_APPROVAL');
    const hr3 = await h.actor(C.co, 'HR_ADMINISTRATOR', { extra: FINANCE_GRANTS });
    const act = await h.call(hr3, 'POST', `/v1/increment-cycles/${d.id}/activate`, { expectedVersion: d.version });
    expect(act.statusCode).toBe(200);
    cycle = d.id;
    await expect(h.db.query(`update increment_cycle set required_appraisal_cycle_id = null where id = $1`, [d.id])).rejects.toMatchObject({ code: '23514' });
    // The provisioned DF15 annual cycle requires no appraisal until the company names one.
    expect((await h.call(C.hr1, 'GET', `/v1/increment-cycles`)).json().items.find((c: { code: string }) => c.code === 'ANNUAL')).toMatchObject({ requiredAppraisalCycleId: null });
  });

  it('an employee without an APPROVED appraisal in that cycle is excluded with a repair path until it is approved', async () => {
    const done = await employee(C, 'ACTIVE_CONFIRMED', iso(Y - 2, 1, 10));
    const pending = await employee(C, 'ACTIVE_CONFIRMED', iso(Y - 2, 1, 11));
    const none = await employee(C, 'ACTIVE_CONFIRMED', iso(Y - 2, 1, 12));
    for (const id of [done, pending, none]) await assign(C, id, cycle);
    await approveAppraisal(await draftAppraisal(C.co, done, apprCycle));
    const pendingAppraisal = await draftAppraisal(C.co, pending, apprCycle);

    const first = await roster(C.hr1, cycle, Y);
    expect(first.roster.map((r) => r.employeeId)).toEqual([done]);
    expect(reasonsOf(first)).toMatchObject({ [pending]: 'APPRAISAL_NOT_COMPLETED', [none]: 'APPRAISAL_NOT_COMPLETED' });
    expect(first.repairPaths.APPRAISAL_NOT_COMPLETED).toMatch(/appraisal/i);

    // Repaired before the roster freezes: the rerun opens the case.
    await approveAppraisal(pendingAppraisal);
    const second = await roster(C.hr1, cycle, Y);
    expect(second.roster.map((r) => r.employeeId)).toEqual([pending]);
    expect(reasonsOf(second)).toMatchObject({ [done]: 'ALREADY_IN_REVIEW', [none]: 'APPRAISAL_NOT_COMPLETED' });
  });
});

describe('the review opening is a queued bulk job (NFR-S09, ADR-15)', () => {
  const occurrence = (year = Y) => `ANNUAL:${year}`;
  /** One worker step: `limit` chunk transactions of at most two candidates each. */
  const step = (limit = 1) => runBulkJobs(h.pool, limit, { chunkSize: 2 });
  const retryNow = (id: string) => h.db.query(`update bulk_job set next_attempt_at = now() - interval '1 second' where id = $1`, [id]);
  const jobRow = (id: string) =>
    h.one<{ state: string; error_code: string | null; processed_count: number; chunk_cursor: string | null }>(
      `select state, error_code, processed_count, chunk_cursor from bulk_job where id = $1`,
      [id],
    );
  const casesOf = async (co: Company, key: string) =>
    (await h.db.query<{ employee_id: string }>(`select employee_id from increment_case where company_id = $1 and cycle_occurrence_key = $2`, [co.id, key])).rows
      .map((r) => r.employee_id)
      .sort();
  const runs = async (co: Company) =>
    (
      await h.db.query(
        `select period_key, run_number, created_count, excluded_count from increment_review_run where company_id = $1 order by period_key, run_number`,
        [co.id],
      )
    ).rows;
  const openAudits = async (co: Company, cycleId: string) =>
    (
      await h.db.query(`select actor_user_id, acting_assignment_id, after_values from audit_event where company_id = $1 and record_key = $2 and action = 'OPEN_REVIEW'`, [
        co.id,
        cycleId,
      ])
    ).rows;
  const byCode = async (co: Company) =>
    (await h.db.query<{ id: string; employee_code: string }>(`select id, employee_code from employee where company_id = $1 order by employee_code`, [co.id])).rows;

  /** A fresh company whose active employees (the manager and `n` more) are all eligible for ANNUAL:Y. */
  async function eligibleCompany(n = 4) {
    const o = await org();
    const joined = (await h.one<{ d: string }>(`select to_char(joining_date, 'YYYY-MM-DD') as d from employee where id = $1`, [o.managerEmp])).d;
    const s = await h.call(o.hr1, 'POST', `/v1/employees/${o.managerEmp}/salary`, { effectiveFrom: joined, monthlyGross: '50000', annualCtc: '600000', currency: 'INR' });
    expect(s.statusCode).toBe(201);
    for (let i = 0; i < n; i++) await employee(o, 'ACTIVE_CONFIRMED', iso(Y - 2, 1, 10));
    return { o, annual: (await cycles(o)).find((c) => c.code === 'ANNUAL')!.id };
  }

  it('answers 202 without opening anything; the worker opens the roster in chunks in employee-code order and records the run once', async () => {
    const { o, annual } = await eligibleCompany();
    const probation = await employee(o, 'ACTIVE_PROBATION', iso(Y - 2, 1, 10));
    const ordered = await byCode(o.co);
    expect(ordered).toHaveLength(6);
    const eligibleIn = (n: number) => ordered.slice(0, n).map((x) => x.id).filter((x) => x !== probation);

    const res = await open(o.hr1, annual, Y);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ jobId: expect.any(String), state: 'QUEUED' });
    const id = res.json().jobId as string;
    // The request opened nothing and recorded no run.
    expect(await casesOf(o.co, occurrence())).toEqual([]);
    expect(await runs(o.co)).toEqual([]);
    expect(await openAudits(o.co, annual)).toEqual([]);
    expect(await job(o.hr1, id)).toMatchObject({ kind: 'INCREMENT_REVIEW_OPENING', state: 'QUEUED', parameters: { cycleId: annual, year: Y }, processed: 0, startedAt: null });

    for (const n of [2, 4]) {
      expect(await step()).toBe(1);
      expect(await job(o.hr1, id)).toMatchObject({ state: 'RUNNING', processed: n, result: { cycleCode: 'ANNUAL', asOf: today, rerun: false, run: null, created: eligibleIn(n).length } });
      expect(JSON.parse((await jobRow(id)).chunk_cursor!)).toEqual([ordered[n - 1]!.employee_code, occurrence()]);
      expect(await casesOf(o.co, occurrence())).toEqual(eligibleIn(n).sort());
      // Each committed chunk's cases are the job's rows already, before the job completes.
      expect((await allRows(o.hr1, id, 'cases')).map((x) => x.employeeId)).toEqual(eligibleIn(n));
      // The run record and its audit come with the last chunk only.
      expect(await runs(o.co)).toEqual([]);
      expect(await openAudits(o.co, annual)).toEqual([]);
    }
    expect(await step()).toBe(1);
    const done = await job(o.hr1, id);
    expect(done).toMatchObject({ state: 'COMPLETED', processed: 6, errorCode: null, attempts: 0 });
    // The result is counts and the fixed values of the opening: no per-employee list (BulkKind contract).
    expect(done.result).toEqual({
      cycleId: annual,
      cycleCode: 'ANNUAL',
      period: String(Y),
      occurrence: occurrence(),
      effectiveDate: iso(Y, 4, 1),
      cutoffDate: iso(Y - 1, 9, 30),
      reviewOpensOn: iso(Y, 1, 1),
      rosterFreezesOn: iso(Y, 1, 31),
      decisionsDueOn: iso(Y, 3, 15),
      asOf: today,
      rerun: false,
      run: 1,
      created: 5,
      excluded: 1,
      excludedByReason: { NOT_CONFIRMED: 1 },
    });
    // The roster the synchronous opening answered, read from the job's rows with operational fields only.
    const first = ordered.find((x) => x.id !== probation)!;
    const cases = (await h.call(o.hr1, 'GET', `${openingUrl(id, 'cases')}?limit=1`)).json();
    expect(cases).toEqual({
      jobId: id,
      state: 'COMPLETED',
      run: 1,
      nextAfter: JSON.stringify([first.employee_code, occurrence()]),
      items: [
        {
          caseId: expect.any(String),
          employeeId: first.id,
          employeeCode: first.employee_code,
          employeeName: expect.any(String),
          occurrence: occurrence(),
          effectiveDate: iso(Y, 4, 1),
          decisionDueOn: iso(Y, 3, 15),
          state: 'DRAFT',
        },
      ],
    });
    const exclusions = (await h.call(o.hr1, 'GET', openingUrl(id, 'exclusions'))).json();
    expect(exclusions).toEqual({
      jobId: id,
      state: 'COMPLETED',
      run: 1,
      nextAfter: null,
      items: [
        {
          employeeId: probation,
          employeeCode: ordered.find((x) => x.id === probation)!.employee_code,
          employeeName: expect.any(String),
          occurrence: occurrence(),
          reason: 'NOT_CONFIRMED',
          repairPath: expect.stringContaining('confirmation'),
        },
      ],
    });
    const listed = await rosterOf(o.hr1, done);
    expect(listed.roster.map((x) => x.employeeId)).toEqual(eligibleIn(6));
    expect(await step()).toBe(0);
    expect(await runs(o.co)).toEqual([{ period_key: String(Y), run_number: 1, created_count: 5, excluded_count: 1 }]);
    // The run names its job, which links the job's cases and exclusions to it.
    expect(await h.one(`select bulk_job_id from increment_review_run where company_id = $1`, [o.co.id])).toEqual({ bulk_job_id: id });
    expect(await openAudits(o.co, annual)).toEqual([
      {
        actor_user_id: o.hr1.user,
        acting_assignment_id: o.hr1.assignment,
        after_values: { operational: { period: String(Y), occurrence: occurrence(), run: 1, created: 5, excluded: 1 } },
      },
    ]);
  });

  it('a failed chunk rolls back alone; the retry resumes after the last committed chunk and opens no case twice', async () => {
    const { o, annual } = await eligibleCompany();
    const ordered = (await byCode(o.co)).map((x) => x.id);
    expect(ordered).toHaveLength(5);
    const id = (await open(o.hr1, annual, Y)).json().jobId as string;
    expect(await step()).toBe(1);
    expect(await casesOf(o.co, occurrence())).toEqual(ordered.slice(0, 2).sort());

    // The second chunk (third and fourth employees) breaks at its second case: the whole chunk is undone.
    await h.db.query(
      `create or replace function test_failing_case() returns trigger language plpgsql as $$
       begin if new.employee_id = '${ordered[3]}'::uuid then raise exception 'simulated chunk failure'; end if; return new; end $$`,
    );
    await h.db.query(`create trigger test_failing_case before insert on increment_case for each row execute function test_failing_case()`);
    try {
      expect(await step()).toBe(1);
      const failed = await job(o.hr1, id);
      expect(failed).toMatchObject({ state: 'RUNNING', processed: 2, attempts: 1, errorCode: 'PG_P0001', finishedAt: null, result: { created: 2 } });
      expect(JSON.stringify(failed)).not.toContain('simulated');
      expect(await casesOf(o.co, occurrence())).toEqual(ordered.slice(0, 2).sort());
      // The third employee's plan and case transaction went with the chunk.
      expect(await h.one(`select count(*)::int as n from employee_increment_plan where employee_id = $1`, [ordered[2]])).toEqual({ n: 0 });
      expect(await h.one(`select count(*)::int as n from business_transaction where kind = 'increment_case' and owner_employee_id = $1`, [ordered[2]])).toEqual({ n: 0 });
      expect(await step()).toBe(0); // waiting for its retry
    } finally {
      await h.db.query(`drop trigger test_failing_case on increment_case`);
    }

    await retryNow(id);
    await drain();
    const done = await job(o.hr1, id);
    expect(done).toMatchObject({ state: 'COMPLETED', processed: 5, attempts: 0, errorCode: null, result: { run: 1, created: 5, excluded: 0, excludedByReason: {} } });
    expect((await rosterOf(o.hr1, done)).roster.map((x) => x.employeeId)).toEqual(ordered);
    expect(await casesOf(o.co, occurrence())).toEqual([...ordered].sort());
    expect(await runs(o.co)).toEqual([{ period_key: String(Y), run_number: 1, created_count: 5, excluded_count: 0 }]);
    expect(await openAudits(o.co, annual)).toHaveLength(1);
  });

  it('authority is re-checked for every chunk: a lost duty or a narrowed scope ends the job and opens nothing more', async () => {
    const { o, annual } = await eligibleCompany();
    const revokeDuty = (a: TestActor) =>
      h.db.query(
        `update role_assignment_permission rap set active = false from permission p
          where p.id = rap.permission_id and rap.role_assignment_id = $1 and p.resource = 'increment_cycle' and p.action = 'manage'`,
        [a.assignment],
      );

    const lostDuty = await h.actor(o.co, 'HR_ADMINISTRATOR');
    const first = (await open(lostDuty, annual, Y)).json().jobId as string;
    expect(await step()).toBe(1);
    expect(await casesOf(o.co, occurrence())).toHaveLength(2);
    await revokeDuty(lostDuty);
    expect(await step()).toBe(1);
    expect(await jobRow(first)).toMatchObject({ state: 'FAILED', error_code: 'ACCESS_REVOKED', processed_count: 2 });
    expect(await step()).toBe(0);
    expect(await casesOf(o.co, occurrence())).toHaveLength(2);
    expect((await h.call(lostDuty, 'GET', `/v1/bulk-jobs/${first}`)).statusCode).toBe(403);

    // Cycle reviews need an unrestricted company scope, re-checked for every chunk as well.
    const narrowed = await h.actor(o.co, 'HR_ADMINISTRATOR');
    const second = (await open(narrowed, annual, Y + 1)).json().jobId as string;
    expect(await step()).toBe(1);
    expect(await casesOf(o.co, occurrence(Y + 1))).toHaveLength(2);
    await h.db.query(`insert into role_scope_filter (company_id, role_assignment_id, dimension, department_id) values ($1, $2, 'DEPARTMENT', $3)`, [
      o.co.id,
      narrowed.assignment,
      o.co.dept,
    ]);
    expect(await step()).toBe(1);
    expect(await jobRow(second)).toMatchObject({ state: 'FAILED', error_code: 'ACCESS_REVOKED', processed_count: 2 });
    expect(await step()).toBe(0);
    expect(await casesOf(o.co, occurrence(Y + 1))).toHaveLength(2);
    expect((await h.call(narrowed, 'GET', `/v1/bulk-jobs/${second}`)).statusCode).toBe(403);
    // Neither job recorded a run or its audit.
    expect(await runs(o.co)).toEqual([]);
    expect(await openAudits(o.co, annual)).toEqual([]);
  });

  it('the same key replays the same job without running it again; a new opening of the period is a rerun', async () => {
    const { o, annual } = await eligibleCompany();
    const key = `review-${randomUUID()}`;
    const first = await h.call(o.hr1, 'POST', reviewsUrl(annual), { year: Y, idempotencyKey: key });
    expect(first.statusCode).toBe(202);
    const again = await h.call(o.hr1, 'POST', reviewsUrl(annual), { year: Y, idempotencyKey: key });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(first.json());
    // The key for another period or by anyone else is refused without revealing the job.
    expect((await h.call(o.hr1, 'POST', reviewsUrl(annual), { year: Y + 1, idempotencyKey: key })).json().error).toBe('IDEMPOTENCY_KEY_REUSED');
    const other = await h.call(o.hr2, 'POST', reviewsUrl(annual), { year: Y, idempotencyKey: key });
    expect(other.statusCode).toBe(409);
    expect(JSON.stringify(other.json())).not.toContain(first.json().jobId);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from bulk_job where company_id = $1`, [o.co.id])).n).toBe(1);

    await drain();
    const replay = await h.call(o.hr1, 'POST', reviewsUrl(annual), { year: Y, idempotencyKey: key });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual({ jobId: first.json().jobId, state: 'COMPLETED' });
    expect(await step()).toBe(0);
    expect(await casesOf(o.co, occurrence())).toHaveLength(5);
    expect(await runs(o.co)).toHaveLength(1);
    expect(await openAudits(o.co, annual)).toHaveLength(1);

    // Another opening of the period (a new job) is a rerun: every case exists already and nothing is added.
    const rerun = await rosterOf(o.hr1, await h.runBulkJob(o.hr1, reviewsUrl(annual), { year: Y }, { chunkSize: 2 }));
    expect(rerun).toMatchObject({ run: 2, rerun: true, created: 0 });
    expect(rerun.excluded.map((x) => x.reason)).toEqual(Array(5).fill('ALREADY_IN_REVIEW'));
    expect(await casesOf(o.co, occurrence())).toHaveLength(5);
    expect(await runs(o.co)).toHaveLength(2);
  });

  it('each chunk writes its cases and exclusions once: a failed chunk leaves none, and a chunk run again writes no duplicate', async () => {
    const { o, annual } = await eligibleCompany();
    const ordered = (await byCode(o.co)).map((x) => x.id);
    expect(ordered).toHaveLength(5);
    await h.setStatus(o.co, ordered[2]!, 'ACTIVE_PROBATION'); // the second chunk: one exclusion, then one case
    const id = (await open(o.hr1, annual, Y)).json().jobId as string;
    const exclusionRows = async () =>
      (await h.db.query(`select employee_id, occurrence_key, reason_code from increment_review_exclusion where bulk_job_id = $1 order by employee_id`, [id])).rows;
    const jobState = () => h.one<{ chunk_cursor: string; processed_count: number; result: Record<string, unknown> }>(`select chunk_cursor, processed_count, result from bulk_job where id = $1`, [id]);
    expect(await step()).toBe(1);
    const afterFirst = await jobState();

    // The second chunk breaks when it writes its exclusion row, after its case: the chunk is undone with both.
    await h.db.query(`create or replace function test_failing_exclusion() returns trigger language plpgsql as $$ begin raise exception 'simulated chunk failure'; end $$`);
    await h.db.query(`create trigger test_failing_exclusion before insert on increment_review_exclusion for each row execute function test_failing_exclusion()`);
    try {
      expect(await step()).toBe(1);
      expect(await jobRow(id)).toMatchObject({ state: 'RUNNING', error_code: 'PG_P0001', processed_count: 2 });
      expect(await exclusionRows()).toEqual([]);
      expect(await casesOf(o.co, occurrence())).toEqual(ordered.slice(0, 2).sort());
      expect(await allRows(o.hr1, id, 'exclusions')).toEqual([]);
    } finally {
      await h.db.query(`drop trigger test_failing_exclusion on increment_review_exclusion`);
    }
    await retryNow(id);
    expect(await step()).toBe(1);
    const afterSecond = await job(o.hr1, id);
    expect(afterSecond).toMatchObject({ state: 'RUNNING', processed: 4, result: { created: 3, excluded: 1, excludedByReason: { NOT_CONFIRMED: 1 } } });
    const written = [{ employee_id: ordered[2], occurrence_key: occurrence(), reason_code: 'NOT_CONFIRMED' }];
    expect(await exclusionRows()).toEqual(written);

    // The same chunk delivered again after it committed (the cursor and counts from before it ran): it finds the case and
    // the exclusion this job wrote, counts them as before and writes neither again.
    await h.db.query(`update bulk_job set chunk_cursor = $2, processed_count = $3, result = $4 where id = $1`, [id, afterFirst.chunk_cursor, afterFirst.processed_count, afterFirst.result]);
    expect(await step()).toBe(1);
    expect(await job(o.hr1, id)).toMatchObject({ state: 'RUNNING', processed: 4, result: afterSecond.result });
    expect(await exclusionRows()).toEqual(written);
    expect(await casesOf(o.co, occurrence())).toEqual([ordered[0]!, ordered[1]!, ordered[3]!].sort());

    await drain();
    const done = await job(o.hr1, id);
    expect(done).toMatchObject({ state: 'COMPLETED', processed: 5, result: { run: 1, created: 4, excluded: 1, excludedByReason: { NOT_CONFIRMED: 1 } } });
    const listed = await rosterOf(o.hr1, done);
    expect(listed.roster.map((x) => x.employeeId)).toEqual([ordered[0], ordered[1], ordered[3], ordered[4]]);
    expect(listed.excluded).toEqual([{ employeeId: ordered[2], reason: 'NOT_CONFIRMED' }]);
    expect(await runs(o.co)).toEqual([{ period_key: String(Y), run_number: 1, created_count: 4, excluded_count: 1 }]);
  });

  it("the opening's cases and exclusions are read under the opening's authority: not by another company, a role without the cycle duty or a narrowed scope", async () => {
    const { o, annual } = await eligibleCompany(2);
    await employee(o, 'ACTIVE_PROBATION', iso(Y - 2, 1, 10));
    const done = await h.runBulkJob(o.hr1, reviewsUrl(annual), { year: Y });
    expect(done.result).toMatchObject({ created: 3, excluded: 1 });
    const deptHr = await h.actor(o.co, 'HR_ADMINISTRATOR', { departmentFilter: o.co.dept });
    for (const list of ['cases', 'exclusions'] as const) {
      const url = openingUrl(done.id, list);
      // Company records: any holder of the cycle duty in an unrestricted company scope reads them, not only the requester.
      const other = await h.call(o.hr2, 'GET', url);
      expect(other.statusCode).toBe(200);
      expect(other.json().items).toHaveLength(list === 'cases' ? 3 : 1);
      // Another company's opening is not found; the refusals reveal no row.
      const foreign = await h.call(A.hr1, 'GET', url);
      expect(foreign.statusCode).toBe(404);
      expect(JSON.stringify(foreign.json())).not.toContain(o.managerEmp);
      expect((await h.call(o.manager, 'GET', url)).statusCode).toBe(403);
      expect((await h.call(deptHr, 'GET', url)).statusCode).toBe(403);
      expect((await h.call(o.hr1, 'GET', `${url}?after=${encodeURIComponent('not-a-position')}`)).json().error).toBe('INVALID_REQUEST');
      expect((await h.call(o.hr1, 'GET', `${url}?limit=0`)).statusCode).toBe(400);
      expect((await h.call(o.hr1, 'GET', openingUrl(randomUUID(), list))).statusCode).toBe(404);
    }
    // No salary figure travels with the roster.
    const cases = (await h.call(o.hr1, 'GET', openingUrl(done.id, 'cases'))).json().items as Record<string, unknown>[];
    for (const c of cases) expect(Object.keys(c).sort()).toEqual(['caseId', 'decisionDueOn', 'effectiveDate', 'employeeCode', 'employeeId', 'employeeName', 'occurrence', 'state']);
    expect(JSON.stringify(cases)).not.toContain('50000');
  });

  it('a case keeps the opening job that created it, and the rows of an opening name an opening job (0066)', async () => {
    const { o, annual } = await eligibleCompany(1);
    const done = await h.runBulkJob(o.hr1, reviewsUrl(annual), { year: Y });
    const later = await h.runBulkJob(o.hr1, reviewsUrl(annual), { year: Y + 1 });
    const k = await h.one<{ id: string; employee_id: string }>(`select id, employee_id from increment_case where company_id = $1 and opened_by_job_id = $2 limit 1`, [
      o.co.id,
      done.id,
    ]);
    // Never moved to another opening's roster, nor cleared.
    await expectSqlError(h.db.query(`update increment_case set opened_by_job_id = $2 where id = $1`, [k.id, later.id]), CHECK_VIOLATION);
    await expectSqlError(h.db.query(`update increment_case set opened_by_job_id = null where id = $1`, [k.id]), CHECK_VIOLATION);
    expect(await h.one(`select opened_by_job_id from increment_case where id = $1`, [k.id])).toEqual({ opened_by_job_id: done.id });

    // Direct writes in a transaction rolled back at the end: a job of another kind is refused for each row of an
    // opening, and an opening job (one without rows yet) is accepted.
    await h.db.query('begin');
    try {
      const jobOf = async (kind: string, resource: string, action: string) =>
        (
          await h.one<{ id: string }>(
            `insert into bulk_job (company_id, kind, parameters, requested_by, acting_assignment_id, permission_resource, permission_action, permission_field_groups)
             select company_id, $2, parameters, requested_by, acting_assignment_id, $3, $4, permission_field_groups from bulk_job where id = $1 returning id`,
            [done.id, kind, resource, action],
          )
        ).id;
      const processing = await jobOf('ATTENDANCE_PROCESSING', 'attendance', 'process');
      const opening = await jobOf('INCREMENT_REVIEW_OPENING', 'increment_cycle', 'manage');
      const bt = (
        await h.one<{ id: string }>(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'increment_case', $2, 'DRAFT') returning id`, [
          o.co.id,
          k.employee_id,
        ])
      ).id;
      const occurrence = 'ANNUAL:SYNTHETIC';
      const writes = [
        (job: string) =>
          h.db.query(
            `insert into increment_case (company_id, employee_id, plan_id, cycle_id, transaction_id, cycle_occurrence_key, off_cycle, prepared_by, baseline_salary_id,
                                         compensation_basis, currency_code, baseline_amount, proposed_effective_date, state, reason, review_opens_on,
                                         roster_freezes_on, decision_due_on, opened_by_job_id)
             select company_id, employee_id, plan_id, cycle_id, $2, $3, off_cycle, prepared_by, baseline_salary_id, compensation_basis, currency_code, baseline_amount,
                    proposed_effective_date, state, reason, review_opens_on, roster_freezes_on, decision_due_on, $4
               from increment_case where id = $1`,
            [k.id, bt, occurrence, job],
          ),
        (job: string) =>
          h.db.query(
            `insert into increment_review_exclusion (company_id, bulk_job_id, cycle_id, employee_id, occurrence_key, reason_code) values ($1, $2, $3, $4, $5, 'ALREADY_IN_REVIEW')`,
            [o.co.id, job, annual, k.employee_id, occurrence],
          ),
        (job: string) =>
          h.db.query(
            `insert into increment_review_run (company_id, cycle_id, cycle_code, period_key, run_number, created_count, excluded_count, bulk_job_id)
             values ($1, $2, 'ANNUAL', '2099', 1, 0, 0, $3)`,
            [o.co.id, annual, job],
          ),
      ];
      for (const write of writes) {
        await h.db.query('savepoint wrong_kind');
        await expectSqlError(write(processing), CHECK_VIOLATION);
        await h.db.query('rollback to savepoint wrong_kind');
        expect((await write(opening)).rowCount).toBe(1);
      }
    } finally {
      await h.db.query('rollback');
    }
  });
});
