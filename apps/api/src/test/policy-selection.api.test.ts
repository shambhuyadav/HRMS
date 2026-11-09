// Exactly one policy on a boundary day, and a refusal on a tie (gates-11: ZT09, BR-010, BR-019, BR-029, DF05), reached through real
// requests. Ties cannot be created through today's routes or guards (0110, 0115), so each is staged as data from before those guards,
// with the guard's trigger off for that one write, as leave-policies.api.test.ts and confirmation/policies.api.test.ts do.
// Held elsewhere and not repeated here: expense POLICY_AMBIGUOUS on tied rules and across revisions (expense/policies.api.test.ts), the
// confirmation refusal and its boundary day (confirmation/policies.api.test.ts). Synthetic values, not policy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../db/tests/fixtures.js';
import { runBulkJobs } from '../modules/bulk/service.js';
import { changedTables, companyState } from './company-state.fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from './harness.js';

let h: Harness;

const errorOf = (res: { statusCode: number; json(): { error?: string } }) => [res.statusCode, res.json().error];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));
const addDays = (day: string, n: number) => iso(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));
/** The Tuesday on or after today + `days`, so that it and the day before it are both working days. */
const tuesdayAfter = (days: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
};
const code = (prefix: string) => `${prefix}${uniq('').replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`.slice(0, 30);

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

/** One company of its own per block: policies apply company-wide, and a staged tie must touch nothing else. */
async function people(c: Company) {
  const author = await h.actor(c, 'HR_ADMINISTRATOR');
  const activator = await h.actor(c, 'HR_ADMINISTRATOR');
  const person = async () => {
    const e = (await h.call(author, 'POST', '/v1/employees', h.newEmployeeBody(c))).json();
    await h.setStatus(c, e.id, 'ACTIVE_CONFIRMED');
    return { id: e.id as string, code: e.employeeCode as string };
  };
  const boss = await person();
  const member = await person();
  expect((await h.call(author, 'POST', `/v1/employees/${member.id}/manager`, { managerEmployeeId: boss.id, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
  await h.actor(c, 'REPORTING_MANAGER', { employeeId: boss.id });
  return { author, activator, member, employee: await h.actor(c, 'EMPLOYEE', { employeeId: member.id }) };
}

const businessDate = async (c: Company) => (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [c.id])).d;

/**
 * 0155: a revision that has ended earlier is past the check only while it keeps narrowing. Each statement runs with the freeze and transition
 * guards off, so that only the no-overlap guard can answer: with them on, they would refuse first and this would prove nothing about it.
 */
async function expectOnlyNarrowingPasses(table: string, otherGuards: string[], id: string) {
  const guardsOff = async (statement: () => Promise<unknown>) => {
    for (const g of otherGuards) await h.db.query(`alter table ${table} disable trigger ${g}`);
    try {
      await statement();
    } finally {
      for (const g of otherGuards) await h.db.query(`alter table ${table} enable trigger ${g}`);
    }
  };
  for (const [what, set] of [
    ['a later end', 'effective_to = effective_to + 1'],
    ['back in force with no end', `state = 'ACTIVE', effective_to = null`],
    ['an earlier start', 'effective_from = effective_from - 1'],
    ['a later start', 'effective_from = effective_from + 1'],
    ['a later start with an earlier end', 'effective_from = effective_from + 1, effective_to = effective_to - 1'],
  ] as const) {
    await guardsOff(() => expect(h.db.query(`update ${table} set ${set} where id = $1`, [id]), `${table}: ${what}`).rejects.toThrow(/overlaps another revision/));
  }
  // With those guards on, the same changes are refused as well, by them.
  await expect(h.db.query(`update ${table} set effective_to = effective_to + 1 where id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
  await expect(h.db.query(`update ${table} set effective_from = effective_from - 1 where id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
  // The one thing that still passes is ending earlier again.
  await guardsOff(() => h.db.query(`update ${table} set effective_to = effective_to - 1 where id = $1`, [id]));
}

describe('leave (BR-010, DF05, ZT09)', () => {
  let c: Company;
  let author: TestActor;
  let activator: TestActor;
  let employee: TestActor;
  let member: { id: string; code: string };
  let permanent: string;

  const VALUES = { eligibility: 'SYNTHETIC_GROUP', accrualRule: 'NONE', annualEntitlement: '0', minServiceDays: 0 };
  const newType = async (paid: boolean) => {
    const leaveType = code('T');
    expect((await h.call(author, 'POST', '/v1/leave/types', { code: leaveType, name: `Synthetic ${leaveType}`, paid })).statusCode).toBe(201);
    return leaveType;
  };
  const version = async (leaveType: string, id: string) => ((await h.call(author, 'GET', `/v1/leave/policies?leaveType=${leaveType}`)).json().items as { id: string; version: number }[]).find((p) => p.id === id)!.version;
  /** A draft mapped to the employee's employment type. */
  const draft = async (leaveType: string, effectiveFrom: string, by = author, typeId = permanent) => {
    const res = await h.call(by, 'POST', '/v1/leave/policies', { leaveType, effectiveFrom, ...VALUES });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    const current = ((await h.call(by, 'GET', `/v1/leave/policies?leaveType=${leaveType}`)).json().items as { id: string; version: number }[]).find((p) => p.id === id)!.version;
    expect((await h.call(by, 'POST', `/v1/leave/policies/${id}/mappings`, { expectedVersion: current, employmentTypeId: typeId })).statusCode).toBe(201);
    return id;
  };
  /** Two activated revisions in force on the same dates for the same employees: data from before the activation guard. */
  const stageTie = async (leaveType: string, by: TestActor, activatedBy: string, typeId: string) => {
    const ids: string[] = [];
    await h.db.query(`alter table leave_policy disable trigger leave_policy_no_overlap`);
    try {
      for (let i = 0; i < 2; i++) {
        const id = await draft(leaveType, '2026-01-01', by, typeId);
        await h.db.query(`update leave_policy set state = 'ACTIVE', activated_by = $2, activated_at = now(), updated_by = $2 where id = $1`, [id, activatedBy]);
        ids.push(id);
      }
    } finally {
      await h.db.query(`alter table leave_policy enable trigger leave_policy_no_overlap`);
    }
    return ids;
  };
  const request = (leaveType: string, day: string) => h.call(employee, 'POST', '/v1/leave/requests', { leaveType, startDate: day, endDate: day });
  const pinned = async (requestId: string) => (await h.one<{ policy_id: string }>(`select policy_id from leave_request where id = $1`, [requestId])).policy_id;

  beforeAll(async () => {
    c = await h.makeCompany();
    ({ author, activator, employee, member } = await people(c));
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'leave_request', $2, 1, true)`, [c.id, author.user]);
    permanent = ((await h.call(author, 'GET', '/v1/leave/policy-options')).json().employmentTypes as { id: string; code: string }[]).find((t) => t.code === 'PERMANENT')!.id;
  });

  it('a tie refuses the request through the route, recording nothing; with the tie resolved the same request is accepted', async () => {
    const leaveType = await newType(false);
    await stageTie(leaveType, author, activator.user, permanent);
    const day = tuesdayAfter(30);

    const before = await companyState(h, c.id);
    expect(errorOf(await request(leaveType, day))).toEqual([422, 'POLICY_AMBIGUOUS']);
    expect(changedTables(before, await companyState(h, c.id))).toEqual([]);

    // A mapping naming more dimensions decides it by the documented priority, so the refusal came from the tie and nothing else.
    const grade = (await h.one<{ id: string }>(`insert into grade (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [c.id, code('G')])).id;
    await h.db.query(`update employment_assignment set grade_id = $2 where employee_id = $1`, [member.id, grade]);
    const specific = await h.call(author, 'POST', '/v1/leave/policies', { leaveType, effectiveFrom: '2026-01-01', ...VALUES });
    expect(specific.statusCode, specific.body).toBe(201);
    const specificId = specific.json().id as string;
    expect((await h.call(author, 'POST', `/v1/leave/policies/${specificId}/mappings`, { expectedVersion: await version(leaveType, specificId), employmentTypeId: permanent, gradeId: grade })).statusCode).toBe(201);
    expect((await h.call(activator, 'POST', `/v1/leave/policies/${specificId}/activate`, { expectedVersion: await version(leaveType, specificId) })).statusCode).toBe(200);
    const accepted = await request(leaveType, day);
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(await pinned(accepted.json().requestId)).toBe(specificId);
  });

  it('a tie from before the guard can be ended by retiring one of its revisions: later dates take the other alone, earlier days stay refused (0155)', async () => {
    const leaveType = await newType(false);
    const [kept, retired] = await stageTie(leaveType, author, activator.user, permanent);
    const today = await businessDate(c);
    const res = await h.call(activator, 'POST', `/v1/leave/policies/${retired}/retire`, { expectedVersion: await version(leaveType, retired!), effectiveTo: today, reason: 'Synthetic: resolving the tie' });
    expect(res.json(), res.body).toMatchObject({ state: 'RETIRED', effectiveTo: today });

    const later = await request(leaveType, tuesdayAfter(45));
    expect(later.statusCode, later.body).toBe(201);
    expect(await pinned(later.json().requestId)).toBe(kept);
    expect(errorOf(await request(leaveType, addDays(today, -10)))).toEqual([422, 'POLICY_AMBIGUOUS']);

    await expectOnlyNarrowingPasses('leave_policy', ['leave_policy_frozen', 'leave_policy_transition'], retired!);
  });

  it('the day a revision ends belongs to its successor alone: the day before takes the earlier, that day the later, and each keeps it', async () => {
    const leaveType = await newType(false);
    const boundary = tuesdayAfter(60);
    const earlier = await draft(leaveType, '2026-01-01');
    expect((await h.call(activator, 'POST', `/v1/leave/policies/${earlier}/activate`, { expectedVersion: await version(leaveType, earlier) })).statusCode).toBe(200);
    const later = await draft(leaveType, boundary);
    const activated = await h.call(activator, 'POST', `/v1/leave/policies/${later}/activate`, { expectedVersion: await version(leaveType, later), closePredecessors: true });
    expect(activated.json()).toMatchObject({ state: 'ACTIVE', closed: [earlier] });
    const shown = (await h.call(author, 'GET', `/v1/leave/policies?leaveType=${leaveType}`)).json().items as { id: string; effectiveFrom: string; effectiveTo: string | null }[];
    expect(shown.find((p) => p.id === earlier)!.effectiveTo).toBe(boundary);

    const lastDay = await request(leaveType, addDays(boundary, -1));
    const firstDay = await request(leaveType, boundary);
    expect(lastDay.statusCode, lastDay.body).toBe(201);
    expect(firstDay.statusCode, firstDay.body).toBe(201);
    expect(await pinned(lastDay.json().requestId)).toBe(earlier);
    expect(await pinned(firstDay.json().requestId)).toBe(later);
  });

  it('a tie on a paid type stops the accrual run with its reason: nothing credited, nothing marked complete', async () => {
    const other = await h.makeCompany();
    const { author: hr, activator: second, member } = await people(other);
    const typeId = ((await h.call(hr, 'GET', '/v1/leave/policy-options')).json().employmentTypes as { id: string; code: string }[]).find((t) => t.code === 'PERMANENT')!.id;
    const leaveType = code('T');
    expect((await h.call(hr, 'POST', '/v1/leave/types', { code: leaveType, name: `Synthetic ${leaveType}`, paid: true })).statusCode).toBe(201);
    await stageTie(leaveType, hr, second.user, typeId);

    const queued = await h.call(hr, 'POST', '/v1/leave/accruals', { month: '2026-02' });
    expect(queued.statusCode, queued.body).toBe(202);
    const jobId = queued.json().jobId as string;
    expect(await runBulkJobs(h.pool, 1)).toBe(1);
    expect((await h.call(hr, 'GET', `/v1/bulk-jobs/${jobId}`)).json()).toMatchObject({ state: 'RUNNING', errorCode: 'POLICY_AMBIGUOUS', processed: 0 });
    const credited = await h.one<{ n: number }>(`select count(*)::int as n from leave_movement where company_id = $1 and employee_id = $2`, [other.id, member.id]);
    expect(credited.n).toBe(0);
  });
});

describe('attendance (DF05, ZT09)', () => {
  const HOURS = { inTime: '09:00', outTime: '18:00', bufferMinutes: 240, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] };
  const POLICIES = '/v1/attendance/policies';
  const thresholds = (over: Record<string, unknown>) => ({ graceMinutes: 5, presentPercent: '60', halfDayPercent: '40', overtimeEnabled: false, ...over });
  /** An employee on the day shift who worked 09:00 to 15:00 on each date: 300 of 480 minutes, 62.5%. */
  const worker = async (author: TestActor, member: { id: string; code: string }, days: string[]) => {
    const shiftId = (await h.call(author, 'POST', '/v1/shifts', { code: code('S'), name: 'Day', ...HOURS })).json().id as string;
    expect((await h.call(author, 'POST', `/v1/employees/${member.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' })).statusCode).toBeLessThan(300);
    for (const day of days) {
      const res = await h.call(author, 'POST', '/v1/attendance/punches', {
        punches: [
          { employeeCode: member.code, occurredAt: `${day}T09:00:00+05:30`, direction: 'IN', externalEventKey: uniq('evt-') },
          { employeeCode: member.code, occurredAt: `${day}T15:00:00+05:30`, direction: 'OUT', externalEventKey: uniq('evt-') },
        ],
      });
      expect(res.json().accepted).toBe(2);
    }
  };
  const draftMapped = async (author: TestActor, policyCode: string, over: Record<string, unknown>) => {
    const created = await h.call(author, 'POST', POLICIES, { code: policyCode, ...thresholds(over) });
    expect(created.statusCode, created.body).toBe(201);
    const mapped = await h.call(author, 'POST', `${POLICIES}/${created.json().id}/mappings`, { expectedVersion: created.json().version });
    expect(mapped.statusCode, mapped.body).toBe(201);
    return created.json().id as string;
  };
  const policyVersion = async (a: TestActor, id: string) => ((await h.call(a, 'GET', POLICIES)).json().items as { id: string; version: number }[]).find((p) => p.id === id)!.version;
  const recordOn = async (a: TestActor, employeeId: string, day: string) => (await h.call(a, 'GET', `/v1/employees/${employeeId}/attendance?from=${day}&to=${day}`)).json().items[0];

  it('the day a revision ends belongs to its successor alone: the day before is judged by the earlier thresholds, that day by the later', async () => {
    const c = await h.makeCompany();
    const { author, activator, member } = await people(c);
    const [monday, tuesday] = ['2026-04-13', '2026-04-14'];
    await worker(author, member, [monday, tuesday]);

    const policyCode = code('P');
    const earlier = await draftMapped(author, policyCode, { effectiveFrom: '2026-04-06', presentPercent: '95', halfDayPercent: '90' });
    expect((await h.call(activator, 'POST', `${POLICIES}/${earlier}/activate`, { expectedVersion: await policyVersion(author, earlier) })).statusCode).toBe(200);
    const later = await draftMapped(author, policyCode, { effectiveFrom: tuesday });
    expect((await h.call(activator, 'POST', `${POLICIES}/${later}/activate`, { expectedVersion: await policyVersion(author, later) })).json()).toMatchObject({ closed: [earlier] });
    expect(((await h.call(author, 'GET', POLICIES)).json().items as { id: string; effectiveTo: string }[]).find((p) => p.id === earlier)!.effectiveTo).toBe(tuesday);

    await h.runBulkJob(author, '/v1/attendance/processing', { workDate: monday });
    await h.runBulkJob(author, '/v1/attendance/processing', { workDate: tuesday });
    expect(await recordOn(author, member.id, monday)).toMatchObject({ status: 'ABSENT', policyCode, policyRevision: 1 });
    expect(await recordOn(author, member.id, tuesday)).toMatchObject({ status: 'PRESENT', policyCode, policyRevision: 2 });
  });

  it('a tie stops processing with its reason and names the employee: no record written; with it resolved the run completes', async () => {
    const c = await h.makeCompany();
    const { author, activator, member } = await people(c);
    const day = '2026-04-14';
    await worker(author, member, [day]);
    const seeded = ((await h.call(author, 'GET', POLICIES)).json().items as { id: string; code: string; version: number }[]).find((p) => p.code === 'DEFAULT')!;
    expect((await h.call(activator, 'POST', `${POLICIES}/${seeded.id}/activate`, { expectedVersion: seeded.version })).statusCode).toBe(200);

    // A second company-wide revision over the same days: from before the guard (0115).
    const tied = await draftMapped(author, code('P'), { effectiveFrom: '2026-01-01' });
    await h.db.query(`alter table attendance_policy disable trigger attendance_policy_no_overlap`);
    try {
      await h.db.query(`update attendance_policy set state = 'ACTIVE', activated_by = $2, activated_at = now(), updated_by = $2 where id = $1`, [tied, activator.user]);
    } finally {
      await h.db.query(`alter table attendance_policy enable trigger attendance_policy_no_overlap`);
    }

    const queued = await h.call(author, 'POST', '/v1/attendance/processing', { workDate: day });
    expect(queued.statusCode, queued.body).toBe(202);
    const jobId = queued.json().jobId as string;
    expect(await runBulkJobs(h.pool, 1)).toBe(1);
    expect((await h.call(author, 'GET', `/v1/bulk-jobs/${jobId}`)).json()).toMatchObject({ state: 'RUNNING', errorCode: 'POLICY_AMBIGUOUS' });
    const records = async () => (await h.one<{ n: number }>(`select count(*)::int as n from attendance_record where company_id = $1 and work_date = $2`, [c.id, day])).n;
    expect(await records()).toBe(0);
    const failure = await h.db.query<{ employee_code: string; error_code: string }>(`select employee_code, error_code from attendance_processing_failure where bulk_job_id = $1`, [jobId]);
    expect(failure.rows.map((r) => r.error_code)).toEqual(['POLICY_AMBIGUOUS']);
    const unprocessed = (await h.call(author, 'GET', `/v1/attendance/processing/${jobId}/unprocessed-employees`)).json();
    expect(unprocessed.items.filter((x: { errorCode: string | null }) => x.errorCode === 'POLICY_AMBIGUOUS').map((x: { employeeCode: string }) => x.employeeCode)).toEqual([failure.rows[0]!.employee_code]);

    // A mapping naming more dimensions decides it for everyone by the documented priority, so the refusal came from the tie and nothing else.
    const grade = (await h.one<{ id: string }>(`insert into grade (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [c.id, code('G')])).id;
    await h.db.query(`update employment_assignment set grade_id = $2 where company_id = $1`, [c.id, grade]);
    const specificCode = code('P');
    const created = await h.call(author, 'POST', POLICIES, { code: specificCode, ...thresholds({ effectiveFrom: '2026-01-01' }) });
    expect(created.statusCode, created.body).toBe(201);
    const mapped = await h.call(author, 'POST', `${POLICIES}/${created.json().id}/mappings`, { expectedVersion: created.json().version, gradeId: grade });
    expect(mapped.statusCode, mapped.body).toBe(201);
    expect((await h.call(activator, 'POST', `${POLICIES}/${created.json().id}/activate`, { expectedVersion: await policyVersion(author, created.json().id) })).statusCode).toBe(200);
    await h.db.query(`update bulk_job set next_attempt_at = now() - interval '1 second' where id = $1`, [jobId]);
    await runBulkJobs(h.pool, 5);
    expect((await h.call(author, 'GET', `/v1/bulk-jobs/${jobId}`)).json()).toMatchObject({ state: 'COMPLETED', errorCode: null });
    expect(await recordOn(author, member.id, day)).toMatchObject({ status: 'PRESENT', policyCode: specificCode, policyRevision: 1 });
  });

  it('a tie from before the guard can be ended by retiring one of its revisions: today takes the other alone, earlier days stay refused (0155)', async () => {
    const c = await h.makeCompany();
    const { author, activator, member } = await people(c);
    const pastDay = '2026-04-14';
    await worker(author, member, [pastDay]);
    const seeded = ((await h.call(author, 'GET', POLICIES)).json().items as { id: string; code: string; version: number }[]).find((p) => p.code === 'DEFAULT')!;
    expect((await h.call(activator, 'POST', `${POLICIES}/${seeded.id}/activate`, { expectedVersion: seeded.version })).statusCode).toBe(200);
    const tied = await draftMapped(author, code('P'), { effectiveFrom: '2026-01-01' });
    await h.db.query(`alter table attendance_policy disable trigger attendance_policy_no_overlap`);
    try {
      await h.db.query(`update attendance_policy set state = 'ACTIVE', activated_by = $2, activated_at = now(), updated_by = $2 where id = $1`, [tied, activator.user]);
    } finally {
      await h.db.query(`alter table attendance_policy enable trigger attendance_policy_no_overlap`);
    }
    const today = await businessDate(c);
    const retired = await h.call(activator, 'POST', `${POLICIES}/${tied}/retire`, { expectedVersion: await policyVersion(author, tied), effectiveTo: today, reason: 'Synthetic: resolving the tie' });
    expect(retired.json(), retired.body).toMatchObject({ state: 'RETIRED', effectiveTo: today });

    const past = await h.call(author, 'POST', '/v1/attendance/processing', { workDate: pastDay });
    expect(past.statusCode, past.body).toBe(202);
    await runBulkJobs(h.pool, 1);
    expect((await h.call(author, 'GET', `/v1/bulk-jobs/${past.json().jobId}`)).json()).toMatchObject({ errorCode: 'POLICY_AMBIGUOUS' });

    await h.runBulkJob(author, '/v1/attendance/processing', { workDate: today });
    expect(await recordOn(author, member.id, today)).toMatchObject({ policyCode: 'DEFAULT' });

    await expectOnlyNarrowingPasses('attendance_policy', ['attendance_policy_frozen', 'attendance_policy_transition'], tied);
  });
});

describe('expense (BR-019, DF06, ZT09)', () => {
  const POLICIES = '/v1/expense/policies';
  const receipt = async (a: TestActor) => {
    const res = await h.call(a, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic boundary receipt ${uniq('p')}\n%%EOF\n`).toString('base64') });
    expect(res.statusCode, res.body).toBe(201);
    return { receiptId: res.json().receiptId as string };
  };

  it('a tie from before the guard can be ended by retiring one of its revisions: today takes the other alone, earlier days stay refused (0155)', async () => {
    const c = await h.makeCompany();
    const { author, activator, employee } = await people(c);
    const reviewer = await h.actor(c, 'HR_ADMINISTRATOR', { extra: ['expense.read.operational', 'expense.manager_decide.operational', 'expense.finance_decide.operational', 'expense.high_value_decide.operational'] });
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true)`, [c.id, reviewer.user]);
    const list = async () => (await h.call(author, 'GET', POLICIES)).json().items as { id: string; code: string; version: number }[];
    const seeded = (await list()).find((p) => p.code === 'DEFAULT')!;
    expect((await h.call(activator, 'POST', `${POLICIES}/${seeded.id}/activate`, { expectedVersion: seeded.version })).statusCode).toBe(200);

    const created = await h.call(author, 'POST', POLICIES, { code: code('P'), effectiveFrom: daysAgo(20), submissionWindowDays: 30, highValueThreshold: '50000' });
    expect(created.statusCode, created.body).toBe(201);
    const tied = created.json().id as string;
    const categories = Object.fromEntries(((await h.call(author, 'GET', '/v1/expense/policy-options')).json().categories as { code: string; id: string }[]).map((x) => [x.code, x.id]));
    expect((await h.call(author, 'POST', `${POLICIES}/${tied}/rules`, { expectedVersion: created.json().version, categoryId: categories.OTHER, limitAmount: '500', receiptRequired: true })).statusCode).toBe(201);
    await h.db.query(`alter table expense_policy disable trigger expense_policy_no_overlap`);
    try {
      await h.db.query(`update expense_policy set state = 'ACTIVE', activated_by = $2, activated_at = now(), updated_by = $2 where id = $1`, [tied, activator.user]);
    } finally {
      await h.db.query(`alter table expense_policy enable trigger expense_policy_no_overlap`);
    }

    const today = await businessDate(c);
    const version = (await list()).find((p) => p.id === tied)!.version;
    const retired = await h.call(activator, 'POST', `${POLICIES}/${tied}/retire`, { expectedVersion: version, effectiveTo: today, reason: 'Synthetic: resolving the tie' });
    expect(retired.json(), retired.body).toMatchObject({ state: 'RETIRED', effectiveTo: today });

    const claim = async (expenseDate: string) => {
      const res = await h.call(employee, 'POST', '/v1/expense/claims', {
        purpose: 'Tie check (synthetic)',
        currency: 'INR',
        lines: [{ category: 'OTHER', expenseDate, merchant: `Synthetic Merchant ${uniq('m')}`, grossAmount: '10', claimedAmount: '10', description: 'Tie (synthetic)', receipt: await receipt(employee) }],
      });
      expect(res.statusCode, res.body).toBe(201);
      const id = res.json().claimId as string;
      return { id, submitted: await h.call(employee, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await h.call(employee, 'GET', `/v1/expense/claims/${id}`)).json().version }) };
    };
    const onToday = await claim(today);
    expect(onToday.submitted.statusCode, onToday.submitted.body).toBe(200);
    expect((await h.one<{ policy_id: string }>(`select r.policy_id from expense_claim c join expense_revision r on r.company_id = c.company_id and r.claim_id = c.id and r.revision = c.current_revision where c.id = $1`, [onToday.id])).policy_id).toBe(seeded.id);
    expect(errorOf((await claim(addDays(today, -2))).submitted)).toEqual([422, 'POLICY_AMBIGUOUS']);

    await expectOnlyNarrowingPasses('expense_policy', ['expense_policy_frozen', 'expense_policy_state_path'], tied);
  });

  it('the first day of a revision belongs to it alone: the day before keeps the earlier revision, and lines on both sides are refused', async () => {
    const c = await h.makeCompany();
    const { author, activator, employee } = await people(c);
    const reviewer = await h.actor(c, 'HR_ADMINISTRATOR', { extra: ['expense.read.operational', 'expense.manager_decide.operational', 'expense.finance_decide.operational', 'expense.high_value_decide.operational'] });
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true)`, [c.id, reviewer.user]);
    const list = async () => (await h.call(author, 'GET', POLICIES)).json().items as { id: string; code: string; version: number; revision: number; effectiveTo: string | null }[];
    const seeded = (await list()).find((p) => p.code === 'DEFAULT')!;
    expect((await h.call(activator, 'POST', `${POLICIES}/${seeded.id}/activate`, { expectedVersion: seeded.version })).statusCode).toBe(200);

    const boundary = daysAgo(3);
    const created = await h.call(author, 'POST', POLICIES, { code: 'DEFAULT', effectiveFrom: boundary, submissionWindowDays: 30, highValueThreshold: '50000' });
    expect(created.statusCode, created.body).toBe(201);
    const later = created.json().id as string;
    const categories = Object.fromEntries(((await h.call(author, 'GET', '/v1/expense/policy-options')).json().categories as { code: string; id: string }[]).map((x) => [x.code, x.id]));
    const ruled = await h.call(author, 'POST', `${POLICIES}/${later}/rules`, { expectedVersion: created.json().version, categoryId: categories.OTHER, limitAmount: '500', receiptRequired: true });
    expect(ruled.statusCode, ruled.body).toBe(201);
    const activated = await h.call(activator, 'POST', `${POLICIES}/${later}/activate`, { expectedVersion: ruled.json().policyVersion });
    expect(activated.json()).toMatchObject({ id: later, state: 'ACTIVE', closed: [seeded.id] });
    expect((await list()).find((p) => p.id === seeded.id)!.effectiveTo).toBe(boundary);

    const claim = async (dates: string[]) => {
      const lines = [];
      for (const expenseDate of dates) lines.push({ category: 'OTHER', expenseDate, merchant: `Synthetic Merchant ${uniq('m')}`, grossAmount: '10', claimedAmount: '10', description: 'Boundary (synthetic)', receipt: await receipt(employee) });
      const res = await h.call(employee, 'POST', '/v1/expense/claims', { purpose: 'Boundary check (synthetic)', currency: 'INR', lines });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().claimId as string;
    };
    const submit = async (id: string) => h.call(employee, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await h.call(employee, 'GET', `/v1/expense/claims/${id}`)).json().version });
    const pinned = async (id: string) => (await h.one<{ policy_id: string }>(`select r.policy_id from expense_claim c join expense_revision r on r.company_id = c.company_id and r.claim_id = c.id and r.revision = c.current_revision where c.id = $1`, [id])).policy_id;

    const lastDay = await claim([addDays(boundary, -1)]);
    const firstDay = await claim([boundary]);
    expect((await submit(lastDay)).statusCode).toBe(200);
    expect((await submit(firstDay)).statusCode).toBe(200);
    expect(await pinned(lastDay)).toBe(seeded.id);
    expect(await pinned(firstDay)).toBe(later);

    const across = await claim([addDays(boundary, -1), boundary]);
    expect(errorOf(await submit(across))).toEqual([422, 'POLICY_AMBIGUOUS']);
    expect((await h.one<{ state: string }>(`select state from expense_claim where id = $1`, [across])).state).toBe('DRAFT');
  });
});
