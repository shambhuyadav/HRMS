// Reports and exports (FR-056, FR-065, FR-093; BR-026; DF09; ZT03, ZT05, ZT17).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { leaveQueue, leaveTasks } from '../workflow/leave-tasks.fixtures.js';
import { csvCell, REPORTS, toXlsx } from './catalogue.js';
import { csvContext, csvTable } from './csv.fixtures.js';
import { processReportQueue, RUNNING_LEASE_MINUTES } from './service.js';
import { readZip, sheetRows } from './xlsx.fixtures.js';

let h: Harness;
let A: Company;
let hr: TestActor;

const request = (a: TestActor, reportCode: string, filters: object = {}) => h.call(a, 'POST', '/v1/reports', { reportCode, filters });
const generate = () => processReportQueue(h.pool);
const download = (a: TestActor, id: string) => h.call(a, 'GET', `/v1/reports/${id}/download`);
const lines = (csv: string) => csvTable(csv).trimEnd().split('\r\n');

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  for (let i = 0; i < 3; i++) await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A));
  await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { displayName: '=HYPERLINK("http://example.test","x")', departmentId: A.financeDept }));
});

afterAll(async () => {
  await h?.stop();
});

describe('a failing generation (FR-056 "no-data is distinguished from a failed query")', () => {
  const statementTimeout = () => Object.assign(new Error('canceling statement due to statement timeout (synthetic value 4242)'), { code: '57014' });
  const status = async (id: string) => (await h.call(hr, 'GET', `/v1/reports/${id}`)).json();
  const attempt = (id: string) => h.one<{ attempts: number; waits_minutes: string | null }>(
    `select attempts, round(extract(epoch from next_attempt_at - now()) / 60) as waits_minutes from report_execution where id = $1`,
    [id],
  );
  const makeDue = (id: string) => h.db.query(`update report_execution set next_attempt_at = now() where id = $1`, [id]);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is retried after 1, 5 and 15 minutes, then ends FAILED with an error class and no output, and is never shown as no data', async () => {
    await generate(); // reports left by other tests
    const failing = vi.spyOn(REPORTS.EMPLOYEE_REGISTER!, 'rows').mockRejectedValue(statementTimeout());
    const { id } = (await request(hr, 'EMPLOYEE_REGISTER')).json();

    await generate();
    expect(await status(id)).toMatchObject({ state: 'QUEUED', failureCode: 'PG_57014', rowCount: null });
    expect(await attempt(id)).toMatchObject({ attempts: 1, waits_minutes: '1' });
    // Not due yet: the same tick does not claim it again.
    await generate();
    expect(failing).toHaveBeenCalledTimes(1);

    await makeDue(id);
    await generate();
    expect(await attempt(id)).toMatchObject({ attempts: 2, waits_minutes: '5' });
    await makeDue(id);
    await generate();
    expect(await attempt(id)).toMatchObject({ attempts: 3, waits_minutes: '15' });
    await makeDue(id);
    await generate();
    expect(await attempt(id)).toMatchObject({ attempts: 4, waits_minutes: null });

    const ended = await status(id);
    expect(ended).toMatchObject({ state: 'FAILED', failureCode: 'PG_57014', rowCount: null });
    // The class only: the error's message may hold values.
    expect(JSON.stringify(ended)).not.toContain('4242');
    expect((await download(hr, id)).statusCode).toBe(409);
    expect((await h.one<{ n: string }>(`select count(*) as n from attachment where content_reference = $1`, [`report_output:${id}`])).n).toBe('0');
    expect((await h.one<{ n: string }>(`select count(*) as n from report_output where execution_id = $1`, [id])).n).toBe('0');
    await makeDue(id).catch(() => undefined);
    await generate();
    expect(failing).toHaveBeenCalledTimes(4);
  });

  it('does not block other reports while it waits, and an empty result is COMPLETED with zero rows', async () => {
    await generate();
    vi.spyOn(REPORTS.EMPLOYEE_REGISTER!, 'rows').mockRejectedValue(statementTimeout());
    const failing = (await request(hr, 'EMPLOYEE_REGISTER')).json().id as string;
    const empty = (await request(hr, 'LEAVE_REGISTER', { from: '2001-01-01', to: '2001-01-31' })).json().id as string;

    await generate();
    expect(await status(failing)).toMatchObject({ state: 'QUEUED', failureCode: 'PG_57014' });
    expect(await status(empty)).toMatchObject({ state: 'COMPLETED', rowCount: 0, failureCode: null });
  });

  it('completes on a later attempt and clears the failure', async () => {
    await generate();
    vi.spyOn(REPORTS.EMPLOYEE_REGISTER!, 'rows').mockRejectedValueOnce(statementTimeout());
    const { id } = (await request(hr, 'EMPLOYEE_REGISTER')).json();
    await generate();
    expect(await status(id)).toMatchObject({ state: 'QUEUED', failureCode: 'PG_57014' });
    await makeDue(id);
    await generate();
    expect(await status(id)).toMatchObject({ state: 'COMPLETED', failureCode: null });
    expect((await download(hr, id)).statusCode).toBe(200);
  });

  it('treats a failure while writing the file the same way', async () => {
    await generate();
    vi.spyOn(REPORTS.EMPLOYEE_REGISTER!, 'rows').mockResolvedValue(null as never);
    const { id } = (await request(hr, 'EMPLOYEE_REGISTER')).json();
    await generate();
    expect(await status(id)).toMatchObject({ state: 'QUEUED', failureCode: 'TypeError' });
  });

  it('keeps the report’s own refusal final, with no retry', async () => {
    await generate();
    const { HttpError } = await import('../../http/errors.js');
    const refusing = vi.spyOn(REPORTS.EMPLOYEE_REGISTER!, 'rows').mockRejectedValue(new HttpError(422, 'SCOPE_INCOMPLETE', 'Synthetic refusal'));
    const { id } = (await request(hr, 'EMPLOYEE_REGISTER')).json();
    await generate();
    expect(await status(id)).toMatchObject({ state: 'FAILED', failureCode: 'SCOPE_INCOMPLETE' });
    expect((await attempt(id)).attempts).toBe(0);
    await generate();
    expect(refusing).toHaveBeenCalledTimes(1);
  });
});

describe('progress and recoverable downloads (FR-056)', () => {
  const list = async (a: TestActor = hr, query = '') => {
    const res = await h.call(a, 'GET', `/v1/reports${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { items: { id: string; reportCode: string; title: string; state: string; rowCount: number | null; failureCode: string | null; expiresAt: string | null; requestedAt: string; filters: object; format: string }[]; total: number; page?: number; pageSize?: number };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows RUNNING to the requester while the report is being generated, committed before the generation starts', async () => {
    await generate();
    const seen: unknown[] = [];
    const rows = REPORTS.EMPLOYEE_REGISTER!.rows;
    vi.spyOn(REPORTS.EMPLOYEE_REGISTER!, 'rows').mockImplementation(async (db, grant, f) => {
      // Read over HTTP on another connection, as the requester's browser does.
      seen.push((await h.call(hr, 'GET', `/v1/reports/${id}`)).json().state);
      seen.push((await list()).items.find((r) => r.id === id)?.state);
      return rows(db, grant, f);
    });
    const { id } = (await request(hr, 'EMPLOYEE_REGISTER')).json() as { id: string };
    expect((await list()).items.find((r) => r.id === id)?.state).toBe('QUEUED');
    await generate();
    expect(seen).toEqual(['RUNNING', 'RUNNING']);
    expect((await h.call(hr, 'GET', `/v1/reports/${id}`)).json().state).toBe('COMPLETED');
  });

  it('a failed attempt leaves RUNNING for QUEUED, and the later attempt completes with the failure cleared', async () => {
    await generate();
    vi.spyOn(REPORTS.EMPLOYEE_REGISTER!, 'rows').mockRejectedValueOnce(Object.assign(new Error('synthetic'), { code: '57014' }));
    const { id } = (await request(hr, 'EMPLOYEE_REGISTER')).json() as { id: string };
    await generate();
    expect(await h.one(`select state, running_since from report_execution where id = $1`, [id])).toEqual({ state: 'QUEUED', running_since: null });
    await h.db.query(`update report_execution set next_attempt_at = now() where id = $1`, [id]);
    await generate();
    expect(await h.one(`select state, running_since, failure_code from report_execution where id = $1`, [id])).toEqual({ state: 'COMPLETED', running_since: null, failure_code: null });
  });

  it('a worker that died mid-generation does not strand the report: it runs again after the lease, and ends FAILED if it keeps dying', async () => {
    await generate();
    const { id } = (await request(hr, 'EMPLOYEE_REGISTER')).json() as { id: string };
    const abandoned = (minutes: number) => h.db.query(`update report_execution set state = 'RUNNING', running_since = now() - make_interval(mins => $2) where id = $1`, [id, minutes]);
    // Inside the lease it is left alone (a live worker may be about to take its row lock).
    await abandoned(RUNNING_LEASE_MINUTES - 1);
    await generate();
    expect((await h.one<{ state: string; attempts: number }>(`select state, attempts from report_execution where id = $1`, [id]))).toEqual({ state: 'RUNNING', attempts: 0 });
    // After it, the report runs again and the interruption counts as an attempt.
    await abandoned(RUNNING_LEASE_MINUTES + 1);
    await generate();
    expect((await h.one<{ state: string; attempts: number }>(`select state, attempts from report_execution where id = $1`, [id]))).toEqual({ state: 'COMPLETED', attempts: 1 });

    const { id: dying } = (await request(hr, 'EMPLOYEE_REGISTER')).json() as { id: string };
    await h.db.query(`update report_execution set state = 'RUNNING', running_since = now() - interval '1 hour', attempts = 3 where id = $1`, [dying]);
    await generate();
    expect((await h.call(hr, 'GET', `/v1/reports/${dying}`)).json()).toMatchObject({ state: 'FAILED', failureCode: 'WORKER_INTERRUPTED' });
    expect((await download(hr, dying)).statusCode).toBe(409);
  });

  it('a live generation holds its row, so a second worker’s claim, which skips locked rows, cannot take it past the lease', async () => {
    await generate();
    const { id } = (await request(hr, 'EMPLOYEE_REGISTER')).json() as { id: string };
    let second = -1;
    const rows = REPORTS.EMPLOYEE_REGISTER!.rows;
    const spy = vi.spyOn(REPORTS.EMPLOYEE_REGISTER!, 'rows').mockImplementation(async (db, grant, f) => {
      const seen = await h.pool.query(`select 1 from report_execution where id = $1 and state = 'RUNNING' for update skip locked`, [id]);
      second = seen.rowCount ?? 0;
      return rows(db, grant, f);
    });
    await generate();
    expect(second).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await h.call(hr, 'GET', `/v1/reports/${id}`)).json().state).toBe('COMPLETED');
  });

  it('lists the requester’s own executions newest first, so a download survives a page reload', async () => {
    const user = await h.actor(A, 'HR_ADMINISTRATOR');
    expect(await list(user)).toEqual({ items: [], total: 0 });
    const first = (await request(user, 'EMPLOYEE_REGISTER', { status: 'ACTIVE_CONFIRMED' })).json().id as string;
    await generate();
    const second = (await request(user, 'LEAVE_REGISTER', { from: '2026-01-01', to: '2026-01-31' })).json().id as string;
    const shown = await list(user);
    expect(shown.total).toBe(2);
    expect(shown.items.map((r) => r.id)).toEqual([second, first]);
    expect(shown.items[0]).toMatchObject({ reportCode: 'LEAVE_REGISTER', title: REPORTS.LEAVE_REGISTER!.title, state: 'QUEUED', rowCount: null, failureCode: null, expiresAt: null, format: 'CSV', filters: { from: '2026-01-01', to: '2026-01-31' } });
    expect(shown.items[1]).toMatchObject({ reportCode: 'EMPLOYEE_REGISTER', state: 'COMPLETED', filters: { status: 'ACTIVE_CONFIRMED' } });
    expect(shown.items[1]!.expiresAt).not.toBeNull();
    // What the list names can be downloaded with nothing else remembered.
    expect((await download(user, shown.items[1]!.id)).statusCode).toBe(200);
  });

  it('pages with a total, and validates the paging', async () => {
    const user = await h.actor(A, 'HR_ADMINISTRATOR');
    for (let i = 0; i < 3; i++) await request(user, 'EMPLOYEE_REGISTER');
    await generate();
    const page1 = await list(user, '?page=1&pageSize=25');
    expect(page1).toMatchObject({ total: 3, page: 1, pageSize: 25 });
    expect(page1.items).toHaveLength(3);
    expect(await list(user, '?page=2&pageSize=25')).toMatchObject({ items: [], total: 3, page: 2 });
    expect((await h.call(user, 'GET', '/v1/reports?pageSize=7')).statusCode).toBe(400);
    // Another requester cannot be named: the route takes no such filter, so the answer is still the caller's own.
    expect((await h.call(user, 'GET', `/v1/reports?requestedBy=${hr.user}`)).json().total).toBe(3);
  });

  it('shows no one else’s executions, nor the same user’s under another assignment or company', async () => {
    const user = await h.actor(A, 'HR_ADMINISTRATOR');
    const id = (await request(user, 'EMPLOYEE_REGISTER')).json().id as string;
    expect((await list(user)).items.map((r) => r.id)).toEqual([id]);
    const stranger = await h.actor(A, 'HR_ADMINISTRATOR');
    expect((await list(stranger)).items).toEqual([]);
    const otherAssignment = await h.actor(A, 'HR_ADMINISTRATOR', { user: user.user });
    expect((await list(otherAssignment)).items).toEqual([]);
    const B = await h.makeCompany();
    const inB = await h.actor(B, 'HR_ADMINISTRATOR', { user: user.user });
    expect((await list(inB)).items).toEqual([]);
  });

  it('marks an expired output; once the export right is gone the report leaves the list as well as the download (FR-065, ZT05, F3 row 9)', async () => {
    const user = await h.actor(A, 'HR_ADMINISTRATOR');
    const { id } = (await request(user, 'EMPLOYEE_REGISTER')).json();
    await generate();
    expect((await list(user)).items.map((r) => [r.id, r.state])).toEqual([[id, 'COMPLETED']]);
    const setExportRight = (active: boolean) =>
      h.db.query(
        `update role_assignment_permission set active = $2
          where role_assignment_id = $1 and permission_id = (select id from permission where resource = 'employee' and action = 'export' and field_group = 'operational')`,
        [user.assignment, active],
      );
    await setExportRight(false);
    expect(await list(user)).toMatchObject({ items: [], total: 0 });
    expect((await h.call(user, 'GET', `/v1/reports/${id}`)).statusCode).toBe(403);
    expect((await download(user, id)).statusCode).toBe(403);
    // The rule is live both ways: the right back, the report is back.
    await setExportRight(true);
    expect((await list(user)).items.map((r) => [r.id, r.state])).toEqual([[id, 'COMPLETED']]);
    await h.db.query(`update report_execution set expires_at = now() - interval '1 minute' where id = $1`, [id]);
    expect((await list(user)).items.map((r) => [r.id, r.state])).toEqual([[id, 'EXPIRED']]);
    // A report whose module is gone is not served: its rule can no longer be judged, so it is not listed or answered either.
    await h.db.query(`update report_execution set report_code = 'RETIRED_REPORT' where id = $1`, [id]);
    expect(await list(user)).toMatchObject({ items: [], total: 0 });
    expect((await h.call(user, 'GET', `/v1/reports/${id}`)).statusCode).toBe(404);
  });
});

describe('generation and reconciliation (FR-056, BR-026, ZT17)', () => {
  it('queues, generates and downloads a CSV whose row count equals the list total', async () => {
    const res = await request(hr, 'EMPLOYEE_REGISTER');
    expect(res.json()).toMatchObject({ state: 'QUEUED' });
    const { id } = res.json();
    expect((await h.call(hr, 'GET', `/v1/reports/${id}`)).json().state).toBe('QUEUED');
    expect((await download(hr, id)).statusCode).toBe(409); // not ready

    expect(await generate()).toBeGreaterThanOrEqual(1);
    const status = (await h.call(hr, 'GET', `/v1/reports/${id}`)).json();
    const listTotal = (await h.call(hr, 'GET', '/v1/employees')).json().total;
    expect(status).toMatchObject({ state: 'COMPLETED', rowCount: listTotal });

    const file = await download(hr, id);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('text/csv');
    expect(file.headers['cache-control']).toBe('no-store');
    const rows = lines(file.body);
    expect(rows[0]).toBe('"Employee code","Name","Work email","Joining date","Status","Department","Location","Designation"');
    expect(rows).toHaveLength(listTotal + 1);
  });

  it('writes formula-like text as data (FR-065)', async () => {
    const { id } = (await request(hr, 'EMPLOYEE_REGISTER')).json();
    await generate();
    expect((await download(hr, id)).body).toContain(`"'=HYPERLINK(""http://example.test"",""x"")"`);
    expect(csvCell('-5')).toBe(`"'-5"`);
    expect(csvCell('plain')).toBe('"plain"');
  });

  it('a department-filtered exporter only exports its department', async () => {
    const finance = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    const { id } = (await request(finance, 'EMPLOYEE_REGISTER')).json();
    await generate();
    const rows = lines((await download(finance, id)).body);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('"FIN"');
  });

  it('period reports need a valid period', async () => {
    expect((await request(hr, 'LEAVE_REGISTER')).json().error).toBe('PERIOD_REQUIRED');
    expect((await request(hr, 'LEAVE_REGISTER', { from: '2026-05-01', to: '2026-04-01' })).json().error).toBe('INVALID_PERIOD');
    expect((await request(hr, 'LEAVE_REGISTER', { from: '2026-01-01', to: '2026-12-31' })).statusCode).toBe(202);
  });
});

describe('access at request, generation and download (ZT03, ZT05)', () => {
  it('confidential reports need their confidential export grant', async () => {
    expect((await request(hr, 'INCREMENT_HISTORY', { from: '2026-01-01', to: '2026-12-31' })).statusCode).toBe(403);
    expect((await request(hr, 'EXPENSE_REGISTER', { from: '2026-01-01', to: '2026-12-31' })).statusCode).toBe(403);
    // C4: the export grant alone does not reach into history.
    const exportOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['increment.export.salary'] });
    expect((await request(exportOnly, 'INCREMENT_HISTORY', { from: '2026-01-01', to: '2026-12-31' })).json().error).toBe('HISTORY_GRANT_REQUIRED');
    const payroll = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['increment.export.salary', 'increment.history_read.salary'] });
    expect((await request(payroll, 'INCREMENT_HISTORY', { from: '2026-01-01', to: '2026-12-31' })).statusCode).toBe(202);
    const manager = await h.actor(A, 'REPORTING_MANAGER');
    expect((await request(manager, 'EMPLOYEE_REGISTER')).statusCode).toBe(403);
  });

  it('access revoked after the request means nothing is generated', async () => {
    const temp = await h.actor(A, 'HR_ADMINISTRATOR');
    const { id } = (await request(temp, 'EMPLOYEE_REGISTER')).json();
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where id = $1`, [temp.assignment]);
    await generate();
    // The requester is refused now (F3 row 9), so the row says what happened.
    expect((await h.call(temp, 'GET', `/v1/reports/${id}`)).statusCode).toBe(403);
    expect(await h.one(`select state, failure_code from report_execution where id = $1`, [id])).toEqual({ state: 'FAILED', failure_code: 'ACCESS_REVOKED' });
  });

  it('a revoked requester is refused on an unfinished report too, so the download does not say how far it got (ZT05)', async () => {
    const temp = await h.actor(A, 'HR_ADMINISTRATOR');
    const { id } = (await request(temp, 'EMPLOYEE_REGISTER')).json();
    expect((await download(temp, id)).statusCode).toBe(409); // still live: not ready
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where id = $1`, [temp.assignment]);
    const refused = await download(temp, id);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'FORBIDDEN' });
    await generate();
  });

  it('a completed output cannot be downloaded after revocation, by another user, under another assignment or after expiry', async () => {
    const temp = await h.actor(A, 'HR_ADMINISTRATOR');
    const { id } = (await request(temp, 'EMPLOYEE_REGISTER')).json();
    await generate();
    expect((await download(temp, id)).statusCode).toBe(200);

    expect((await download(hr, id)).statusCode).toBe(404); // someone else's output
    const second = await h.actor(A, 'HR_ADMINISTRATOR', { user: temp.user });
    expect((await download(second, id)).statusCode).toBe(403); // same user, different assignment

    await h.db.query(
      `update role_assignment_permission set active = false
        where role_assignment_id = $1 and permission_id = (select id from permission where resource = 'employee' and action = 'export' and field_group = 'operational')`,
      [temp.assignment],
    );
    expect((await download(temp, id)).statusCode).toBe(403);

    const other = (await request(hr, 'EMPLOYEE_REGISTER')).json();
    await generate();
    await h.db.query(`update report_execution set expires_at = now() - interval '1 minute' where id = $1`, [other.id]);
    expect((await download(hr, other.id)).statusCode).toBe(410);
    expect((await h.call(hr, 'GET', `/v1/reports/${other.id}`)).json().state).toBe('EXPIRED');
  });
});

describe('the current row scope at download (DF09 "recheck current access at download"; DF16; FR-065; ZT05; decisions-3)', () => {
  const person = async (name: string, overrides: Record<string, unknown> = {}) => {
    const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { displayName: name, ...overrides }));
    expect(res.statusCode, res.body).toBe(201);
    await h.setStatus(A, res.json().id, 'ACTIVE_CONFIRMED');
    return res.json().id as string;
  };
  const transfer = async (employeeId: string, departmentId: string, effectiveFrom: string) => {
    const res = await h.call(hr, 'POST', `/v1/employees/${employeeId}/assignment`, { departmentId, locationId: A.loc, designationId: A.desig, effectiveFrom });
    expect(res.statusCode, res.body).toBeLessThan(300);
  };
  const generated = async (a: TestActor, reportCode: string, filters: object = {}) => {
    const res = await request(a, reportCode, filters);
    expect(res.statusCode, res.body).toBe(202);
    await generate();
    return res.json().id as string;
  };
  const refusedForScope = (res: { statusCode: number; json(): { error: string } }) => {
    expect([res.statusCode, res.json().error]).toEqual([403, 'SCOPE_CHANGED']);
  };

  it('a department-filtered exporter cannot download a file holding someone transferred out; a new request leaves them out', async () => {
    const mover = uniq('Synthetic Mover ');
    const moverId = await person(mover, { departmentId: A.financeDept });
    const finance = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    const id = await generated(finance, 'EMPLOYEE_REGISTER');
    expect((await download(finance, id)).body).toContain(mover);

    await transfer(moverId, A.dept, '2026-03-01');
    const refused = await download(finance, id);
    refusedForScope(refused);
    expect(refused.body).not.toContain(mover);
    const denied = await h.one<{ n: string; reason: string }>(
      `select count(*) as n, max(after_values->>'reason') as reason from audit_event where actor_user_id = $1 and action = 'ACCESS_DENIED' and record_key = $2`,
      [finance.user, id],
    );
    expect(denied).toMatchObject({ n: '1', reason: 'SCOPE_NARROWED' });

    const again = await generated(finance, 'EMPLOYEE_REGISTER');
    const file = await download(finance, again);
    expect(file.statusCode).toBe(200);
    expect(file.body).not.toContain(mover);
  });

  it('a manager cannot download a team file once a member has moved to another manager (DF16 "later requests lose former-team access")', async () => {
    const bossId = await person('Synthetic Boss');
    const member = uniq('Synthetic Member ');
    const memberId = await person(member);
    const boss = await h.actor(A, 'REPORTING_MANAGER', { employeeId: bossId, extra: ['team.export.operational'] });
    expect((await h.call(hr, 'POST', `/v1/employees/${memberId}/manager`, { managerEmployeeId: bossId, effectiveFrom: '2026-01-05' })).statusCode).toBeLessThan(300);
    const id = await generated(boss, 'MY_TEAM');
    expect((await download(boss, id)).body).toContain(member);

    expect((await h.call(hr, 'POST', `/v1/employees/${memberId}/manager`, { managerEmployeeId: await person('Synthetic New Boss'), effectiveFrom: '2026-03-01' })).statusCode).toBeLessThan(300);
    const refused = await download(boss, id);
    refusedForScope(refused);
    expect(refused.body).not.toContain(member);
  });

  it('an ASSIGNED exporter cannot download a file once the task that opened the employee has closed (C1)', async () => {
    const world = leaveTasks(h, A, hr);
    await world.activatePolicies();
    const reviewer = await h.customActor(A, { scope: 'ASSIGNED', permissions: ['leave.export.operational', 'leave.read.operational', 'leave.approve.operational'] });
    expect((await h.call(hr, 'PUT', '/v1/workflows/leave_request/fallback-reviewers', { reviewers: [{ userId: reviewer.user, priority: 1 }] })).statusCode).toBe(200);
    const ownerId = await person('Synthetic Task Owner');
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: ownerId });
    const owner = (await h.one<{ employee_code: string }>(`select employee_code from employee where id = $1`, [ownerId])).employee_code;
    await world.submitLeave(self);
    const id = await generated(reviewer, 'LEAVE_REGISTER', { from: '2026-01-01', to: '2030-12-31' });
    expect((await download(reviewer, id)).body).toContain(`"${owner}"`);

    const [task] = await leaveQueue(h, reviewer);
    expect((await h.call(reviewer, 'POST', `/v1/leave/tasks/${task!.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('scope-download-') })).statusCode).toBe(200);
    refusedForScope(await download(reviewer, id));
  });

  it('a wider scope refuses nothing: someone joining the scope afterwards, or a transfer under an unrestricted exporter', async () => {
    const finance = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    const joiner = await person(uniq('Synthetic Joiner '));
    const inFinance = await generated(finance, 'EMPLOYEE_REGISTER');
    const whole = await generated(hr, 'EMPLOYEE_REGISTER');
    await transfer(joiner, A.financeDept, '2026-03-01');
    expect((await download(finance, inFinance)).statusCode).toBe(200);
    await transfer(joiner, A.dept, '2026-04-01');
    expect((await download(finance, inFinance)).statusCode).toBe(200);
    expect((await download(hr, whole)).statusCode).toBe(200);
  });

  it('a filter added to the exporter’s assignment after generation refuses an unrestricted file', async () => {
    const exporter = await h.actor(A, 'HR_ADMINISTRATOR');
    const id = await generated(exporter, 'EMPLOYEE_REGISTER');
    expect((await download(exporter, id)).statusCode).toBe(200);
    await h.db.query(`insert into role_scope_filter (company_id, role_assignment_id, dimension, department_id) values ($1, $2, 'DEPARTMENT', $3)`, [A.id, exporter.assignment, A.financeDept]);
    refusedForScope(await download(exporter, id));
  });

  it('a file from before membership was recorded is served only to an unrestricted company scope', async () => {
    const finance = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    const filtered = await generated(finance, 'EMPLOYEE_REGISTER');
    const whole = await generated(hr, 'EMPLOYEE_REGISTER');
    await h.db.query(`update report_execution set scope_members = null where id = any($1::uuid[])`, [[filtered, whole]]);
    refusedForScope(await download(finance, filtered));
    expect((await download(hr, whole)).statusCode).toBe(200);
  });
});

describe('every file carries its context (DF09 "filter/period/revision/generated-time context"; FR-056; FR-065; decisions-11)', () => {
  const generatedAt = async (id: string) =>
    (
      await h.one<{ at: string }>(
        `select to_char(x.generated_at at time zone c.business_timezone, 'YYYY-MM-DD HH24:MI:SS') || ' ' || c.business_timezone as at from report_execution x join company c on c.id = x.company_id where x.id = $1`,
        [id],
      )
    ).at;

  it('a CSV starts with the report, company, role, scope, period, filters, generated time and row count, and the table follows', async () => {
    const finance = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    const { id } = (await request(finance, 'LEAVE_REGISTER', { from: '2026-01-01', to: '2026-12-31' })).json();
    await generate();
    const { body } = await download(finance, id);
    const company = await h.one<{ name: string; code: string }>(`select name, code from company where id = $1`, [A.id]);
    expect(csvContext(body)).toEqual({
      Report: 'Leave register',
      'Report code': 'LEAVE_REGISTER',
      Company: `${company.name} (${company.code})`,
      'Acting role': 'HR_ADMINISTRATOR',
      'Row scope': 'COMPANY; departments FIN',
      Period: '2026-01-01 to 2026-12-31',
      Filters: 'None',
      'Generated at': await generatedAt(id),
      Rows: '0',
    });
    expect(lines(body)).toEqual(['"Employee code","Leave type","Start date","End date","Days","State"']);
  });

  it('names the filters applied, says when no period applied, and counts the rows of the table', async () => {
    const { id } = (await request(hr, 'EMPLOYEE_REGISTER', { status: 'ACTIVE_CONFIRMED', departmentId: A.financeDept })).json();
    await generate();
    const { body } = await download(hr, id);
    const context = csvContext(body);
    expect(context.Period).toBe('None');
    expect(context.Filters!.split('; ').sort()).toEqual([`departmentId: ${A.financeDept}`, 'status: ACTIVE_CONFIRMED'].sort());
    expect(Number(context.Rows)).toBe(lines(body).length - 1);
    expect(context['Row scope']).toBe('COMPANY');
    expect(context).not.toHaveProperty('Record revision');
  });

  it('a value cannot start a formula or end the block: the same guard as every cell, in CSV and XLSX', async () => {
    const B = await h.makeCompany();
    const hrB = await h.actor(B, 'HR_ADMINISTRATOR');
    await h.db.query(`update company set name = '=SUM(1,2)' where id = $1`, [B.id]);
    const twoLines = 'first\r\n\r\nsecond';
    const { id } = (await request(hrB, 'EMPLOYEE_REGISTER', { search: twoLines })).json();
    await generate();
    const { body } = await download(hrB, id);
    expect(body).toContain(`"Company","'=SUM(1,2) (`);
    expect(csvContext(body).Filters).toBe('search: first second');
    expect(lines(body)[0]).toContain('"Employee code"');
  });

  it('an XLSX keeps the report on the first sheet with its header in row 1, and the context on a second sheet', () => {
    const def = REPORTS.LEAVE_REGISTER!;
    const context = [
      ['Report', def.title],
      ['Company', '=SUM(1,2)'],
      ['Filters', 'a\r\nb'],
    ] as const;
    const rows = [Object.fromEntries(def.columns.map((c) => [c.key, 'x']))];
    const entries = readZip(toXlsx(def, rows, context));
    expect(entries.get('xl/workbook.xml')!.toString('utf8')).toContain('<sheet name="Report context" sheetId="2" r:id="rId2"/>');
    expect(entries.get('xl/_rels/workbook.xml.rels')!.toString('utf8')).toContain('Target="worksheets/sheet2.xml"');
    expect(entries.get('[Content_Types].xml')!.toString('utf8')).toContain('/xl/worksheets/sheet2.xml');
    expect(sheetRows(entries.get('xl/worksheets/sheet1.xml')!.toString('utf8'), def.columns.length)[0]).toEqual(def.columns.map((c) => c.header));
    expect(sheetRows(entries.get('xl/worksheets/sheet2.xml')!.toString('utf8'), 2)).toEqual([
      ['Report', def.title],
      ['Company', "'=SUM(1,2)"],
      ['Filters', 'a b'],
    ]);
  });
});

describe('list and export use identical filters (FR-007)', () => {
  it('search, status, department and joining-date range give the same employees in the list and the register', async () => {
    const tag = `Filterpair${Date.now()}`;
    const make = async (overrides: Record<string, unknown>) => (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { displayName: `${tag} person`, ...overrides }))).json();
    await make({ joiningDate: '2026-02-02' });
    await make({ joiningDate: '2026-03-02' });
    const finance = await make({ joiningDate: '2026-03-16', departmentId: A.financeDept });
    await h.setStatus(A, finance.id, 'ACTIVE_CONFIRMED');

    const listCodes = async (filters: Record<string, string>) => {
      const res = await h.call(hr, 'GET', `/v1/employees?pageSize=100&${new URLSearchParams(filters).toString()}`);
      expect(res.statusCode).toBe(200);
      return (res.json().items as { employeeCode: string }[]).map((i) => i.employeeCode).sort();
    };
    const exportCodes = async (filters: Record<string, string>) => {
      const res = await request(hr, 'EMPLOYEE_REGISTER', filters);
      expect(res.statusCode).toBe(202);
      await generate();
      const rows = lines((await download(hr, res.json().id)).body).slice(1);
      return rows.map((r) => JSON.parse(r.split(',')[0]!) as string).sort();
    };
    const cases: Record<string, string>[] = [
      { search: tag },
      { search: tag, joinedFrom: '2026-03-01' },
      { search: tag, joinedFrom: '2026-03-01', joinedTo: '2026-03-10' },
      { search: tag, departmentId: A.financeDept },
      { search: tag, status: 'ACTIVE_CONFIRMED' },
      { joinedFrom: '2026-02-02', joinedTo: '2026-02-02' },
    ];
    const expected = [3, 2, 1, 1, 1];
    for (const [i, filters] of cases.entries()) {
      const fromList = await listCodes(filters);
      expect(await exportCodes(filters)).toEqual(fromList);
      if (expected[i] !== undefined) expect(fromList).toHaveLength(expected[i]!);
    }
    // The execution records the filters it applied (FR-058 / DF09 requester, scope and filters).
    const snapshot = (await h.one<{ filter_snapshot: Record<string, string> }>(
      `select filter_snapshot from report_execution where company_id = $1 order by created_at desc limit 1`,
      [A.id],
    )).filter_snapshot;
    expect(snapshot).toEqual({ joinedFrom: '2026-02-02', joinedTo: '2026-02-02' });
  });

  it('validates the joining-date range the same way on both, and other reports refuse list filters', async () => {
    const reversed = { joinedFrom: '2026-03-10', joinedTo: '2026-03-01' };
    const list = await h.call(hr, 'GET', `/v1/employees?${new URLSearchParams(reversed).toString()}`);
    expect([list.statusCode, list.json().error]).toEqual([422, 'INVALID_PERIOD']);
    const exp = await request(hr, 'EMPLOYEE_REGISTER', reversed);
    expect([exp.statusCode, exp.json().error]).toEqual([422, 'INVALID_PERIOD']);
    expect((await h.call(hr, 'GET', '/v1/employees?joinedFrom=March')).statusCode).toBe(400);
    const leave = await request(hr, 'LEAVE_REGISTER', { from: '2026-01-01', to: '2026-12-31', search: 'x' });
    expect([leave.statusCode, leave.json().error]).toEqual([422, 'FILTER_NOT_SUPPORTED']);
  });

  it('a report refuses record filters and the XLSX format it does not declare (FR-046), queuing nothing', async () => {
    const queued = async () => (await h.one<{ n: number }>(`select count(*)::int as n from report_execution where company_id = $1`, [A.id])).n;
    const before = await queued();
    const xlsx = await h.call(hr, 'POST', '/v1/reports', { reportCode: 'EMPLOYEE_REGISTER', format: 'XLSX' });
    expect([xlsx.statusCode, xlsx.json().error]).toEqual([422, 'FORMAT_NOT_SUPPORTED']);
    const record = await request(hr, 'LEAVE_REGISTER', { from: '2026-01-01', to: '2026-12-31', employeeId: '00000000-0000-4000-8000-000000000001' });
    expect([record.statusCode, record.json().error]).toEqual([422, 'FILTER_NOT_SUPPORTED']);
    expect((await h.call(hr, 'POST', '/v1/reports', { reportCode: 'EMPLOYEE_REGISTER', format: 'PDF' })).statusCode).toBe(400);
    expect(await queued()).toBe(before);
    // CSV is every report's format, named or not; the catalogue lists formats only for a report that offers XLSX.
    const csv = await h.call(hr, 'POST', '/v1/reports', { reportCode: 'EMPLOYEE_REGISTER', format: 'CSV' });
    expect(csv.json()).toMatchObject({ state: 'QUEUED', format: 'CSV' });
    await generate();
    expect((await h.call(hr, 'GET', `/v1/reports/${csv.json().id}`)).json()).toMatchObject({ state: 'COMPLETED', format: 'CSV' });
    expect((await download(hr, csv.json().id)).headers['content-disposition']).toMatch(/\.csv"$/);
    const items = (await h.call(hr, 'GET', '/v1/reports/catalogue')).json().items as { code: string; formats?: string[] }[];
    expect(items.find((r) => r.code === 'EMPLOYEE_REGISTER')).not.toHaveProperty('formats');
  });

  it('the catalogue lists only the reports the selected role may request (FR-046), each of which it may then request', async () => {
    const codes = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/reports/catalogue')).json().items as { code: string }[]).map((r) => r.code);
    const hrCodes = await codes(hr);
    expect(hrCodes).toContain('EMPLOYEE_REGISTER');
    // The baseline manager holds no export grant, so nothing is offered, and asking anyway is still refused.
    const manager = await h.actor(A, 'REPORTING_MANAGER');
    expect(await codes(manager)).toEqual([]);
    expect((await h.call(manager, 'POST', '/v1/reports', { reportCode: 'EMPLOYEE_REGISTER' })).statusCode).toBe(403);
    // With the team export grant, the team report is offered; the company-wide employee register is not, because a team scope is
    // not unrestricted company scope.
    const exporting = await codes(await h.actor(A, 'REPORTING_MANAGER', { extra: ['team.export.operational'] }));
    expect(exporting).toContain('MY_TEAM');
    expect(exporting).not.toContain('EMPLOYEE_REGISTER');
    // An employee with no export grant is offered nothing.
    expect(await codes(await h.actor(A, 'EMPLOYEE'))).toEqual([]);
  });

  it('a report that does not apply a status filter refuses it rather than ignoring it', async () => {
    const queued = async () => (await h.one<{ n: number }>(`select count(*)::int as n from report_execution where company_id = $1 and report_code = 'LEAVE_REGISTER'`, [A.id])).n;
    const before = await queued();
    const leave = await request(hr, 'LEAVE_REGISTER', { from: '2026-01-01', to: '2026-12-31', status: 'APPROVED' });
    expect([leave.statusCode, leave.json().error]).toEqual([422, 'FILTER_NOT_SUPPORTED']);
    expect(await queued()).toBe(before);
    // The employee register applies it, as the employee list does (FR-007).
    expect((await request(hr, 'EMPLOYEE_REGISTER', { status: 'ACTIVE_CONFIRMED' })).statusCode).toBe(202);
  });
});
