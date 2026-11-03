// Bulk jobs over HTTP and the worker (NFR-S09; FR-022; DF05; ADR-15): 202 and the job states, the request itself
// evaluating no one, bounded chunks in a stable order, requester-only status, idempotent enqueue, resume after a failed
// chunk without double effects, bounded retries, authority re-checked at execution, the audit written once, row scope,
// and a result of counts only: the employees found without a policy are rows of the job (0058), read page by page.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_VIOLATION, expectSqlError, uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { runBulkJobs } from './service.js';

let h: Harness;
const MON = '2026-03-02';
const TUE = '2026-03-03';

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

async function hire(c: Company, hr: TestActor, departmentId = c.dept): Promise<string> {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(c, { departmentId }))).json();
  await h.setStatus(c, e.id, 'ACTIVE_CONFIRMED');
  return e.id as string;
}

async function activatePolicy(hr: TestActor) {
  const policy = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/attendance/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
}

/** A fresh company with an HR administrator and `n` active employees; its attendance policy is active unless `policy` is false. */
async function company(n: number, { policy = true } = {}) {
  const c = await h.makeCompany();
  const hr = await h.actor(c, 'HR_ADMINISTRATOR');
  if (policy) await activatePolicy(hr);
  const employees: string[] = [];
  for (let i = 0; i < n; i++) employees.push(await hire(c, hr));
  return { c, hr, employees };
}

const enqueue = async (a: TestActor, url = '/v1/attendance/processing', body: object = { workDate: MON }) => {
  const res = await h.call(a, 'POST', url, body);
  expect(res.statusCode).toBe(202);
  return res.json().jobId as string;
};
const status = (a: TestActor, id: string) => h.call(a, 'GET', `/v1/bulk-jobs/${id}`);
const view = async (a: TestActor, id: string) => {
  const res = await status(a, id);
  expect(res.statusCode).toBe(200);
  return res.json();
};
/** One worker step: `limit` chunk transactions of at most `chunkSize` employees. */
const step = (chunkSize = 2, limit = 1) => runBulkJobs(h.pool, limit, { chunkSize });
const drain = async () => {
  for (let i = 0; i < 100 && (await runBulkJobs(h.pool, 100)) > 0; i++);
};
const row = (id: string) =>
  h.one<{ state: string; error_code: string | null; attempts: number; processed_count: number; chunk_cursor: string | null; finished_at: Date | null }>(
    `select state, error_code, attempts, processed_count, chunk_cursor, finished_at from bulk_job where id = $1`,
    [id],
  );
const recordsOn = async (c: Company, day = MON) =>
  Number((await h.one<{ n: string }>(`select count(*) as n from attendance_record where company_id = $1 and work_date = $2`, [c.id, day])).n);
const audits = async (c: Company, resource: string) =>
  (
    await h.db.query(
      `select action, record_key, actor_user_id, acting_assignment_id, after_values from audit_event where company_id = $1 and resource_code = $2`,
      [c.id, resource],
    )
  ).rows;
const revokeDuty = (a: TestActor, resource: string, action: string) =>
  h.db.query(
    `update role_assignment_permission rap set active = false from permission p
      where p.id = rap.permission_id and rap.role_assignment_id = $1 and p.resource = $2 and p.action = $3`,
    [a.assignment, resource, action],
  );
/** Makes every insert into `table` for `employeeId` (or any employee) fail, as a broken chunk would; returns the undo. */
async function failInsertsInto(table: string, employeeId?: string): Promise<() => Promise<void>> {
  const condition = employeeId ? `new.employee_id = '${employeeId}'::uuid` : 'true';
  await h.db.query(
    `create or replace function test_failing_chunk() returns trigger language plpgsql as $$
     begin if ${condition} then raise exception 'simulated chunk failure'; end if; return new; end $$`,
  );
  await h.db.query(`create trigger test_failing_chunk before insert on ${table} for each row execute function test_failing_chunk()`);
  return async () => {
    await h.db.query(`drop trigger test_failing_chunk on ${table}`);
  };
}
const retryNow = (id: string) => h.db.query(`update bulk_job set next_attempt_at = now() - interval '1 second' where id = $1`, [id]);
const noPolicyUrl = (id: string) => `/v1/attendance/processing/${id}/no-policy-employees`;
/** Every employee a processing job found without a policy, read `limit` rows a page (small, so that paging is exercised). */
async function noPolicyListed(a: TestActor, id: string, limit = 2) {
  const items: { employeeId: string; employeeCode: string; employeeName: string }[] = [];
  let after: string | null = null;
  for (let i = 0; i < 100; i++) {
    const res = await h.call(a, 'GET', `${noPolicyUrl(id)}?${new URLSearchParams({ limit: String(limit), ...(after ? { after } : {}) })}`);
    expect(res.statusCode).toBe(200);
    const page = res.json();
    expect(page.items.length).toBeLessThanOrEqual(limit);
    items.push(...page.items);
    after = page.nextAfter;
    if (after === null) return items;
  }
  throw new Error('Too many pages');
}
/** The job's rows as stored, in the job's order. */
const noPolicyRows = async (id: string) =>
  (await h.db.query<{ employee_id: string }>(`select employee_id from attendance_processing_no_policy where bulk_job_id = $1 order by employee_code`, [id])).rows.map(
    (r) => r.employee_id,
  );
const byCode = async (c: Company) =>
  (await h.db.query<{ id: string; employee_code: string }>(`select id, employee_code from employee where company_id = $1 order by employee_code`, [c.id])).rows;
const counts = (over: Partial<Record<'employees' | 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'SKIPPED_AMENDED' | 'SKIPPED_LOCKED' | 'NO_POLICY', number>>) => ({
  workDate: MON,
  employees: 0,
  CREATED: 0,
  UPDATED: 0,
  UNCHANGED: 0,
  SKIPPED_AMENDED: 0,
  SKIPPED_LOCKED: 0,
  NO_POLICY: 0,
  ...over,
});

describe('queued processing (NFR-S09, FR-022)', () => {
  it('answers 202 without evaluating anyone; the worker runs bounded chunks in code order and audits once at completion', async () => {
    const { c, hr, employees } = await company(5);
    const res = await h.call(hr, 'POST', '/v1/attendance/processing', { workDate: MON });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ jobId: expect.any(String), state: 'QUEUED' });
    const id = res.json().jobId as string;

    // The request evaluated no one and wrote no processing audit.
    expect(await recordsOn(c)).toBe(0);
    expect(await audits(c, 'attendance_processing')).toHaveLength(0);
    expect(await view(hr, id)).toMatchObject({
      id,
      kind: 'ATTENDANCE_PROCESSING',
      state: 'QUEUED',
      parameters: { workDate: MON },
      processed: 0,
      errorCode: null,
      startedAt: null,
      finishedAt: null,
    });

    // First chunk: the two lowest employee codes, with the cursor after the second.
    const codes = (
      await h.db.query<{ id: string; employee_code: string }>(`select id, employee_code from employee where company_id = $1 order by employee_code`, [c.id])
    ).rows;
    expect(codes.map((e) => e.id).sort()).toEqual([...employees].sort());
    expect(await step()).toBe(1);
    expect(await view(hr, id)).toMatchObject({ state: 'RUNNING', processed: 2, finishedAt: null });
    expect((await row(id)).chunk_cursor).toBe(codes[1]!.employee_code);
    const evaluated = (await h.db.query<{ employee_id: string }>(`select employee_id from attendance_record where company_id = $1 and work_date = $2`, [c.id, MON])).rows;
    expect(evaluated.map((r) => r.employee_id).sort()).toEqual([codes[0]!.id, codes[1]!.id].sort());
    expect(await audits(c, 'attendance_processing')).toHaveLength(0); // only at completion

    expect(await step()).toBe(1);
    expect((await view(hr, id)).processed).toBe(4);
    expect(await step()).toBe(1);
    const done = await view(hr, id);
    expect(done).toMatchObject({ state: 'COMPLETED', processed: 5, errorCode: null, attempts: 0, nextAttemptAt: null });
    expect(done.startedAt).not.toBeNull();
    expect(done.finishedAt).not.toBeNull();
    // The counts the synchronous answer had; its list of employees without a policy is the job's rows (none here).
    expect(done.result).toEqual({ workDate: MON, employees: 5, CREATED: 5, UPDATED: 0, UNCHANGED: 0, SKIPPED_AMENDED: 0, SKIPPED_LOCKED: 0, NO_POLICY: 0 });
    expect((await h.call(hr, 'GET', noPolicyUrl(id))).json()).toEqual({ jobId: id, workDate: MON, state: 'COMPLETED', items: [], nextAfter: null });
    expect(await recordsOn(c)).toBe(5);
    expect(await step()).toBe(0);
    expect(await audits(c, 'attendance_processing')).toEqual([
      {
        action: 'PROCESS',
        record_key: hr.assignment,
        actor_user_id: hr.user,
        acting_assignment_id: hr.assignment,
        after_values: { operational: { workDate: MON, CREATED: 5, UPDATED: 0, UNCHANGED: 0, SKIPPED_AMENDED: 0, SKIPPED_LOCKED: 0, NO_POLICY: 0 } },
      },
    ]);

    // A rerun is another job; unchanged inputs change nothing.
    const rerun = await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: MON }, { chunkSize: 2 });
    expect(rerun.result).toMatchObject({ employees: 5, CREATED: 0, UPDATED: 0, UNCHANGED: 5 });
    expect(await audits(c, 'attendance_processing')).toHaveLength(2);
  });

  it("a department-filtered HR user's job processes only that user's departments", async () => {
    const { c, hr } = await company(0);
    const eng = [await hire(c, hr), await hire(c, hr)];
    const fin = await hire(c, hr, c.financeDept);
    const scoped = await h.actor(c, 'HR_ADMINISTRATOR', { departmentFilter: c.dept });
    const done = await h.runBulkJob(scoped, '/v1/attendance/processing', { workDate: MON }, { chunkSize: 1 });
    expect(done).toMatchObject({ state: 'COMPLETED', processed: 2 });
    expect(done.result).toMatchObject({ employees: 2, CREATED: 2 });
    const evaluated = (await h.db.query<{ employee_id: string }>(`select employee_id from attendance_record where company_id = $1`, [c.id])).rows.map((r) => r.employee_id);
    expect(evaluated.sort()).toEqual([...eng].sort());
    expect(evaluated).not.toContain(fin);
  });
});

describe('job status belongs to its requester', () => {
  it('only the requester, under the same assignment and still holding the permission, reads the job', async () => {
    const { c, hr } = await company(1);
    const id = await enqueue(hr);
    expect((await view(hr, id)).state).toBe('QUEUED');

    const otherHr = await h.actor(c, 'HR_ADMINISTRATOR');
    expect((await status(otherHr, id)).statusCode).toBe(404);
    // The same person under another assignment: grants never combine across assignments (BR-046).
    const sameUserAsEmployee = await h.actor(c, 'EMPLOYEE', { user: hr.user });
    expect((await status(sameUserAsEmployee, id)).statusCode).toBe(404);
    const outsider = (await company(0)).hr;
    expect((await status(outsider, id)).statusCode).toBe(404);

    expect((await h.call(hr, 'GET', '/v1/bulk-jobs')).json().items.map((j: { id: string }) => j.id)).toEqual([id]);
    expect((await h.call(hr, 'GET', '/v1/bulk-jobs?kind=ATTENDANCE_PROCESSING')).json().items).toHaveLength(1);
    expect((await h.call(hr, 'GET', '/v1/bulk-jobs?kind=LEAVE_ACCRUAL')).json().items).toEqual([]);
    expect((await h.call(hr, 'GET', '/v1/bulk-jobs?kind=NOPE')).statusCode).toBe(400);
    expect((await h.call(otherHr, 'GET', '/v1/bulk-jobs')).json().items).toEqual([]);
    expect((await h.call(sameUserAsEmployee, 'GET', '/v1/bulk-jobs')).json().items).toEqual([]);

    // The requester without the permission the job was enqueued under no longer reads it.
    await revokeDuty(hr, 'attendance', 'process');
    expect((await status(hr, id)).statusCode).toBe(403);
    expect((await h.call(hr, 'GET', '/v1/bulk-jobs')).json().items).toEqual([]);
    await drain();
    expect(await row(id)).toMatchObject({ state: 'FAILED', error_code: 'ACCESS_REVOKED' });
  });
});

describe('idempotent enqueue', () => {
  it('the same requester and parameters get the same job; the key for anything else is refused', async () => {
    const { c, hr } = await company(1);
    const key = uniq('bulk-key-');
    const first = await h.call(hr, 'POST', '/v1/attendance/processing', { workDate: MON, idempotencyKey: key });
    expect(first.statusCode).toBe(202);
    const again = await h.call(hr, 'POST', '/v1/attendance/processing', { workDate: MON, idempotencyKey: key });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(first.json());

    const otherDate = await h.call(hr, 'POST', '/v1/attendance/processing', { workDate: TUE, idempotencyKey: key });
    expect(otherDate.statusCode).toBe(409);
    expect(otherDate.json().error).toBe('IDEMPOTENCY_KEY_REUSED');
    const otherKind = await h.call(hr, 'POST', '/v1/leave/accruals', { month: '2026-02', idempotencyKey: key });
    expect(otherKind.json().error).toBe('IDEMPOTENCY_KEY_REUSED');
    const otherHr = await h.actor(c, 'HR_ADMINISTRATOR');
    const otherRequester = await h.call(otherHr, 'POST', '/v1/attendance/processing', { workDate: MON, idempotencyKey: key });
    expect(otherRequester.statusCode).toBe(409);
    expect(JSON.stringify(otherRequester.json())).not.toContain(first.json().jobId);
    expect((await h.call(hr, 'POST', '/v1/attendance/processing', { workDate: MON, idempotencyKey: 'short' })).statusCode).toBe(400);

    const jobs = async () => Number((await h.one<{ n: string }>(`select count(*) as n from bulk_job where company_id = $1`, [c.id])).n);
    expect(await jobs()).toBe(1);
    await drain();
    // A replay after completion answers the same job and runs nothing again.
    const replay = await h.call(hr, 'POST', '/v1/attendance/processing', { workDate: MON, idempotencyKey: key });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual({ jobId: first.json().jobId, state: 'COMPLETED' });
    expect(await jobs()).toBe(1);
    expect(await step()).toBe(0);
    expect(await audits(c, 'attendance_processing')).toHaveLength(1);
  });
});

describe('failures, retries and resume', () => {
  it('a failed accrual chunk rolls back alone; the retry resumes after the last committed chunk and credits nothing twice', async () => {
    const { c, hr, employees } = await company(5);
    for (const p of (await h.call(hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number }[]) {
      await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version });
    }
    const byId = [...employees].sort(); // the accrual's stable order (uuid order equals lower-case text order)
    const movements = async () =>
      (
        await h.db.query<{ employee_id: string; n: string }>(
          `select employee_id, count(*) as n from leave_movement
            where company_id = $1 and movement_kind = 'ACCRUAL' and to_char(effective_date, 'YYYY-MM') = '2026-02'
            group by employee_id`,
          [c.id],
        )
      ).rows;

    const id = await enqueue(hr, '/v1/leave/accruals', { month: '2026-02' });
    expect(await step()).toBe(1);
    expect(await view(hr, id)).toMatchObject({ state: 'RUNNING', processed: 2, result: { month: '2026-02' } });
    const perEmployee = (await movements()).map((m) => Number(m.n));
    expect(perEmployee).toHaveLength(2);
    const types = perEmployee[0]!;
    expect(types).toBeGreaterThan(0);

    // The second chunk (third and fourth employees) breaks at its second employee: the whole chunk is undone.
    const undo = await failInsertsInto('leave_movement', byId[3]);
    expect(await step()).toBe(1);
    const failed = await view(hr, id);
    expect(failed).toMatchObject({ state: 'RUNNING', processed: 2, attempts: 1, errorCode: 'PG_P0001', finishedAt: null, result: { credited: 2 * types } });
    expect(JSON.stringify(failed)).not.toContain('simulated');
    expect((await movements()).map((m) => m.employee_id).sort()).toEqual([byId[0], byId[1]].sort());
    const delay = await h.one<{ minutes: string }>(`select extract(epoch from next_attempt_at - updated_at) / 60 as minutes from bulk_job where id = $1`, [id]);
    expect(Number(delay.minutes)).toBe(1);
    expect(await step()).toBe(0); // waiting for its retry
    await undo();

    await retryNow(id);
    await drain();
    const done = await view(hr, id);
    expect(done).toMatchObject({ state: 'COMPLETED', processed: 5, attempts: 0, errorCode: null, result: { month: '2026-02', credited: 5 * types } });
    const after = await movements();
    expect(after).toHaveLength(5);
    expect(after.every((m) => Number(m.n) === types)).toBe(true);
    const duplicates = await h.db.query(
      `select employee_id, leave_type_id from leave_movement where company_id = $1 and movement_kind = 'ACCRUAL'
        group by employee_id, leave_type_id, effective_date having count(*) > 1`,
      [c.id],
    );
    expect(duplicates.rowCount).toBe(0);
    expect(await audits(c, 'leave_accrual')).toEqual([
      {
        action: 'ACCRUE',
        record_key: c.id,
        actor_user_id: hr.user,
        acting_assignment_id: hr.assignment,
        after_values: { operational: { month: '2026-02', credited: 5 * types } },
      },
    ]);
  });

  it('a chunk failing every time is retried after 1, 5 and 15 minutes, then the job is FAILED with the error class', async () => {
    const { c, hr } = await company(2);
    const undo = await failInsertsInto('attendance_record');
    try {
      const id = await enqueue(hr);
      const delays: number[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        expect(await step()).toBe(1);
        expect(await row(id)).toMatchObject({ state: 'RUNNING', attempts: attempt, error_code: 'PG_P0001', processed_count: 0 });
        delays.push(Number((await h.one<{ m: string }>(`select extract(epoch from next_attempt_at - updated_at) / 60 as m from bulk_job where id = $1`, [id])).m));
        await retryNow(id);
      }
      expect(delays).toEqual([1, 5, 15]);
      expect(await step()).toBe(1);
      expect(await view(hr, id)).toMatchObject({ state: 'FAILED', attempts: 4, errorCode: 'PG_P0001', nextAttemptAt: null, processed: 0 });
      expect((await row(id)).finished_at).not.toBeNull();
      expect(await step()).toBe(0); // FAILED is final
      expect(await recordsOn(c)).toBe(0);
      expect(await audits(c, 'attendance_processing')).toHaveLength(0);
    } finally {
      await undo();
    }
  });
});

describe('authority re-checked at execution', () => {
  it('a requester revoked before the first chunk: FAILED ACCESS_REVOKED and nothing applied', async () => {
    const { c, hr } = await company(3);
    const id = await enqueue(hr);
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where id = $1`, [hr.assignment]);
    expect(await step()).toBe(1);
    const r = await row(id);
    expect(r).toMatchObject({ state: 'FAILED', error_code: 'ACCESS_REVOKED', processed_count: 0 });
    expect(r.finished_at).not.toBeNull();
    expect(await step()).toBe(0);
    expect(await recordsOn(c)).toBe(0);
    expect(await audits(c, 'attendance_processing')).toHaveLength(0);
  });

  it('a requester who loses the permission mid-run: the job stops and nothing more runs', async () => {
    const { c, hr } = await company(5);
    const id = await enqueue(hr);
    expect(await step()).toBe(1);
    expect(await recordsOn(c)).toBe(2);
    await revokeDuty(hr, 'attendance', 'process');
    expect(await step()).toBe(1);
    expect(await row(id)).toMatchObject({ state: 'FAILED', error_code: 'ACCESS_REVOKED', processed_count: 2 });
    expect(await step()).toBe(0);
    expect(await recordsOn(c)).toBe(2);
    expect(await audits(c, 'attendance_processing')).toHaveLength(0);
  });
});

describe('employees without a policy are rows of the processing job (0058)', () => {
  it('each chunk writes them once: the result keeps the count, a failed chunk leaves none, a chunk run again writes no duplicate', async () => {
    const { c, hr } = await company(5, { policy: false });
    const ordered = (await byCode(c)).map((e) => e.id);
    const id = await enqueue(hr);
    const jobState = () => h.one<{ chunk_cursor: string; processed_count: number; result: Record<string, unknown> }>(`select chunk_cursor, processed_count, result from bulk_job where id = $1`, [id]);

    expect(await step()).toBe(1);
    const afterFirst = await jobState();
    expect(afterFirst.result).toEqual(counts({ employees: 2, NO_POLICY: 2 }));
    expect(await noPolicyRows(id)).toEqual(ordered.slice(0, 2));
    // Rows of a running job are those its committed chunks wrote.
    expect((await noPolicyListed(hr, id)).map((x) => x.employeeId)).toEqual(ordered.slice(0, 2));

    // The second chunk breaks when it writes its rows: the chunk is undone with them.
    const undo = await failInsertsInto('attendance_processing_no_policy');
    try {
      expect(await step()).toBe(1);
      expect(await row(id)).toMatchObject({ state: 'RUNNING', attempts: 1, error_code: 'PG_P0001', processed_count: 2 });
      expect(await noPolicyRows(id)).toEqual(ordered.slice(0, 2));
    } finally {
      await undo();
    }
    await retryNow(id);
    expect(await step()).toBe(1);
    const afterSecond = await view(hr, id);
    expect(afterSecond).toMatchObject({ state: 'RUNNING', processed: 4, attempts: 0, result: counts({ employees: 4, NO_POLICY: 4 }) });
    expect(await noPolicyRows(id)).toEqual(ordered.slice(0, 4));

    // A policy applies from now on, and the second chunk is delivered again after it committed (the cursor and counts
    // from before it): it finds the employees this job already found without a policy, counts them as before and
    // neither evaluates nor writes them again.
    await activatePolicy(hr);
    await h.db.query(`update bulk_job set chunk_cursor = $2, processed_count = $3, result = $4 where id = $1`, [id, afterFirst.chunk_cursor, afterFirst.processed_count, afterFirst.result]);
    expect(await step()).toBe(1);
    expect(await view(hr, id)).toMatchObject({ state: 'RUNNING', processed: 4, result: afterSecond.result });
    expect(await noPolicyRows(id)).toEqual(ordered.slice(0, 4));
    expect(await recordsOn(c)).toBe(0);

    await drain();
    const done = await view(hr, id);
    expect(done).toMatchObject({ state: 'COMPLETED', processed: 5 });
    expect(done.result).toEqual(counts({ employees: 5, CREATED: 1, NO_POLICY: 4 }));
    const listed = await noPolicyListed(hr, id);
    expect(listed.map((x) => x.employeeId)).toEqual(ordered.slice(0, 4));
    expect(listed).toHaveLength(done.result.NO_POLICY);
    const duplicates = await h.db.query(`select employee_id from attendance_processing_no_policy where bulk_job_id = $1 group by employee_id having count(*) > 1`, [id]);
    expect(duplicates.rowCount).toBe(0);
    // The audit is unchanged: counts only, no list.
    expect((await audits(c, 'attendance_processing')).map((a) => a.after_values)).toEqual([
      { operational: { workDate: MON, CREATED: 1, UPDATED: 0, UNCHANGED: 0, SKIPPED_AMENDED: 0, SKIPPED_LOCKED: 0, NO_POLICY: 4 } },
    ]);
  });

  it('a failing chunk names the employee it stopped on and lists who is left; the job still ends FAILED (FR-022, I-34)', async () => {
    const { c, hr } = await company(5);
    const ordered = await byCode(c);
    const id = await enqueue(hr);
    type Listed = { employeeId: string; employeeCode: string; errorCode: string | null };
    const unprocessed = async (a = hr): Promise<{ state: string; errorCode: string | null; items: Listed[] }> => {
      const res = await h.call(a, 'GET', `/v1/attendance/processing/${id}/unprocessed-employees?limit=2`);
      expect(res.statusCode, res.body).toBe(200);
      const first = res.json();
      const next = first.nextAfter ? (await h.call(a, 'GET', `/v1/attendance/processing/${id}/unprocessed-employees?limit=200&${new URLSearchParams({ after: first.nextAfter })}`)).json().items : [];
      return { ...first, items: [...first.items, ...next] };
    };
    // Before anything runs, everyone is left and nobody failed.
    expect((await unprocessed()).items.map((x) => x.employeeId)).toEqual(ordered.map((e) => e.id));
    expect(await step()).toBe(1);
    expect((await unprocessed()).items.map((x) => x.employeeId)).toEqual(ordered.slice(2).map((e) => e.id));

    // The fourth employee's evaluation breaks: its chunk (the third and fourth) rolls back whole.
    const undo = await failInsertsInto('attendance_record', ordered[3]!.id);
    try {
      expect(await step()).toBe(1);
      expect(await row(id)).toMatchObject({ state: 'RUNNING', attempts: 1, error_code: 'PG_P0001', processed_count: 2 });
      const during = await unprocessed();
      expect(during).toMatchObject({ state: 'RUNNING', errorCode: 'PG_P0001' });
      expect(during.items.map((x) => [x.employeeId, x.errorCode])).toEqual([
        [ordered[2]!.id, null],
        [ordered[3]!.id, 'PG_P0001'],
        [ordered[4]!.id, null],
      ]);
      // Exhaust the retries: the job ends FAILED as before, its failing employee and the rest still listed.
      for (let i = 0; i < 3; i++) {
        await retryNow(id);
        expect(await step()).toBe(1);
      }
      expect(await row(id)).toMatchObject({ state: 'FAILED', attempts: 4, error_code: 'PG_P0001', processed_count: 2 });
      const after = await unprocessed();
      expect(after.state).toBe('FAILED');
      expect(after.items.map((x) => x.errorCode)).toEqual([null, 'PG_P0001', null]);
      const stored = await h.db.query(`select employee_code from attendance_processing_failure where bulk_job_id = $1`, [id]);
      expect(stored.rows).toEqual([{ employee_code: ordered[3]!.employee_code }]);
    } finally {
      await undo();
    }
    // The audit of a finished run is never written for a job that failed.
    expect(await audits(c, 'attendance_processing')).toEqual([]);

    // Only the requester, under the role it was queued with, reads it; another requester's job does not exist for them.
    const other = await h.actor(c, 'HR_ADMINISTRATOR');
    expect((await h.call(other, 'GET', `/v1/attendance/processing/${id}/unprocessed-employees`)).statusCode).toBe(404);
  });

  it('a retry that stops on another employee replaces the failure; a job that completes lists nobody (FR-022)', async () => {
    const { c, hr } = await company(4);
    const ordered = await byCode(c);
    const id = await enqueue(hr);
    const undoFirst = await failInsertsInto('attendance_record', ordered[0]!.id);
    expect(await step()).toBe(1);
    await undoFirst();
    expect((await h.db.query(`select employee_id from attendance_processing_failure where bulk_job_id = $1`, [id])).rows).toEqual([{ employee_id: ordered[0]!.id }]);
    const undoSecond = await failInsertsInto('attendance_record', ordered[1]!.id);
    await retryNow(id);
    expect(await step()).toBe(1);
    await undoSecond();
    expect((await h.db.query(`select employee_id from attendance_processing_failure where bulk_job_id = $1`, [id])).rows).toEqual([{ employee_id: ordered[1]!.id }]);
    await retryNow(id);
    await drain();
    expect(await row(id)).toMatchObject({ state: 'COMPLETED', error_code: null });
    expect((await h.call(hr, 'GET', `/v1/attendance/processing/${id}/unprocessed-employees`)).json()).toMatchObject({ state: 'COMPLETED', items: [], nextAfter: null });
  });

  it('a job that still carries a list from before 0058 writes it as rows with its next chunk and drops it from its result', async () => {
    const { c, hr } = await company(4, { policy: false });
    const ordered = await byCode(c);
    const id = await enqueue(hr);
    // As a job of 0053 left its first chunk: the list in its result and no rows.
    await h.db.query(`update bulk_job set state = 'RUNNING', started_at = now(), chunk_cursor = $2, processed_count = 2, result = $3 where id = $1`, [
      id,
      ordered[1]!.employee_code,
      { ...counts({ employees: 2, NO_POLICY: 2 }), noPolicyEmployeeIds: [ordered[0]!.id, ordered[1]!.id] },
    ]);
    expect(await step()).toBe(1);
    const done = await view(hr, id);
    expect(done).toMatchObject({ state: 'COMPLETED', processed: 4 });
    expect(done.result).toEqual(counts({ employees: 4, NO_POLICY: 4 }));
    expect(await noPolicyRows(id)).toEqual(ordered.map((e) => e.id));
  });

  it('a row names a processing job, never a job of another kind (0066)', async () => {
    const { c, hr, employees } = await company(1, { policy: false });
    const accrual = await enqueue(hr, '/v1/leave/accruals', { month: '2026-02' });
    await drain();
    const insert = (jobId: string) =>
      h.db.query(`insert into attendance_processing_no_policy (company_id, bulk_job_id, employee_id, employee_code) values ($1, $2, $3, 'SYN-ROW')`, [c.id, jobId, employees[0]]);
    await expectSqlError(insert(accrual), CHECK_VIOLATION);
    // A processing job's chunk writes them as before.
    const done = await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: MON });
    expect(await noPolicyRows(done.id)).toEqual(employees);
  });

  it('the rows are read by the requester only, under the processing permission and within the requester’s row scope', async () => {
    const { c, hr } = await company(0, { policy: false });
    const eng = [await hire(c, hr), await hire(c, hr)];
    const fin = await hire(c, hr, c.financeDept);
    const done = await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: MON }, { chunkSize: 2 });
    expect(done.result).toEqual(counts({ employees: 3, NO_POLICY: 3 }));
    const url = noPolicyUrl(done.id);
    const ordered = (await byCode(c)).map((e) => e.id);
    const first = (await h.call(hr, 'GET', `${url}?limit=2`)).json();
    expect(first).toEqual({
      jobId: done.id,
      workDate: MON,
      state: 'COMPLETED',
      items: ordered.slice(0, 2).map((employeeId) => ({ employeeId, employeeCode: expect.any(String), employeeName: 'Synthetic Person' })),
      nextAfter: expect.any(String),
    });
    // Operational fields only.
    for (const item of first.items) expect(Object.keys(item).sort()).toEqual(['employeeCode', 'employeeId', 'employeeName']);
    expect((await noPolicyListed(hr, done.id)).map((x) => x.employeeId)).toEqual(ordered);
    expect([...ordered].sort()).toEqual([...eng, fin].sort());

    // Another company's caller: not found, revealing no row.
    const outsider = (await company(0)).hr;
    const foreign = await h.call(outsider, 'GET', url);
    expect(foreign.statusCode).toBe(404);
    expect(JSON.stringify(foreign.json())).not.toContain(fin);
    // Another holder of the permission in this company, or one with a department scope: not their job.
    expect((await h.call(await h.actor(c, 'HR_ADMINISTRATOR'), 'GET', url)).statusCode).toBe(404);
    const engHr = await h.actor(c, 'HR_ADMINISTRATOR', { departmentFilter: c.dept });
    expect((await h.call(engHr, 'GET', url)).statusCode).toBe(404);
    // A department-scoped requester's own job lists only the employees of that scope.
    const engJob = await h.runBulkJob(engHr, '/v1/attendance/processing', { workDate: MON });
    expect((await noPolicyListed(engHr, engJob.id)).map((x) => x.employeeId).sort()).toEqual([...eng].sort());
    // Without the processing permission (another role, or the same person under another assignment): refused.
    expect((await h.call(await h.actor(c, 'EMPLOYEE'), 'GET', url)).statusCode).toBe(403);
    expect((await h.call(await h.actor(c, 'EMPLOYEE', { user: hr.user }), 'GET', url)).statusCode).toBe(403);
    // Positions this list never returned, and ids that are not this requester's processing jobs.
    expect((await h.call(hr, 'GET', `${url}?after=${encodeURIComponent('not-a-position')}`)).json().error).toBe('INVALID_REQUEST');
    expect((await h.call(hr, 'GET', `${url}?after=${encodeURIComponent(JSON.stringify(['X', 'not-an-id']))}`)).json().error).toBe('INVALID_REQUEST');
    expect((await h.call(hr, 'GET', `${url}?limit=0`)).statusCode).toBe(400);
    expect((await h.call(hr, 'GET', noPolicyUrl(randomUUID()))).statusCode).toBe(404);
    const accrual = await enqueue(hr, '/v1/leave/accruals', { month: '2026-02' });
    expect((await h.call(hr, 'GET', noPolicyUrl(accrual))).statusCode).toBe(404);
    await drain();

    // The requester's scope narrowed since the job: only the employees still in scope are listed.
    await h.db.query(`insert into role_scope_filter (company_id, role_assignment_id, dimension, department_id) values ($1, $2, 'DEPARTMENT', $3)`, [
      c.id,
      hr.assignment,
      c.financeDept,
    ]);
    expect((await noPolicyListed(hr, done.id)).map((x) => x.employeeId)).toEqual([fin]);
    // The requester without the permission: refused.
    await revokeDuty(hr, 'attendance', 'process');
    expect((await h.call(hr, 'GET', url)).statusCode).toBe(403);
  });
});
