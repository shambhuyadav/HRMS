// Opening balances, the ledger and leave attachments over HTTP (FR-025 "Opening plus credits minus debits equals closing
// balance; duplicate opening-balance batches are blocked; an adjustment preserves actor and reason"; FR-026 attachment;
// FR-106; ZT07; ZT11). Real races are staged: the test holds the balance lock, starts both requests, waits until
// PostgreSQL shows them blocked, then releases it. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { EICAR_TEST_STRING } from '../../storage/scan.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let managerEmp: string;
let manager: TestActor;

const toBase64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const adjust = (body: Record<string, unknown>, actor = hr) =>
  h.call(actor, 'POST', '/v1/leave/adjustments', { kind: 'OPENING', leaveType: 'ANNUAL', units: '10', effectiveDate: '2026-01-05', reason: 'Opening balance (synthetic)', idempotencyKey: uniq('opening-key-'), ...body });
const available = async (employee: string, type = 'ANNUAL') => ((await h.call(hr, 'GET', `/v1/employees/${employee}/leave-balances`)).json().items as { leaveType: string; available: string }[]).find((b) => b.leaveType === type)!.available;
const movements = async (employee: string) => (await h.one<{ n: number }>(`select count(*)::int as n from leave_movement where employee_id = $1`, [employee])).n;
const audits = async (employee: string) => (await h.one<{ n: number }>(`select count(*)::int as n from audit_event where resource_code = 'leave_balance' and record_key = $1`, [employee])).n;

async function person(over: Record<string, unknown> = {}): Promise<{ id: string; code: string }> {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, over))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  return { id: e.id, code: e.employeeCode };
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  for (const p of (await h.call(hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number }[]) {
    expect((await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version })).statusCode).toBe(200);
  }
  managerEmp = (await person()).id;
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  // DF05: leave back-dated beyond 7 days goes to the HR fallback list.
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'leave_request', $2, 1, true)`, [A.id, hr.user]);
});

afterAll(async () => {
  await h?.stop();
});

describe('one opening balance, however it arrives (FR-025, ZT07, ZT11)', () => {
  it('two concurrent openings with different keys record one; the other is refused and the balance is not doubled', async () => {
    const e = await person();
    const type = await h.one<{ id: string }>(`select id from leave_type where company_id = $1 and code = 'ANNUAL'`, [A.id]);
    await h.db.query(`select pg_advisory_lock(hashtextextended('leave_balance:' || $1 || ':' || $2, 0))`, [e.id, type.id]);
    let results: Awaited<ReturnType<typeof adjust>>[];
    try {
      const running = Promise.all([adjust({ employeeId: e.id }), adjust({ employeeId: e.id })]);
      let waiting = 0;
      for (let i = 0; i < 200 && waiting < 2; i++) {
        waiting = (await h.one<{ n: number }>(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`)).n;
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(2);
      await h.db.query(`select pg_advisory_unlock(hashtextextended('leave_balance:' || $1 || ':' || $2, 0))`, [e.id, type.id]);
      results = await running;
    } finally {
      await h.db.query(`select pg_advisory_unlock_all()`);
    }
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().error).toBe('OPENING_EXISTS');
    expect(await available(e.id)).toBe('10.0000');
    expect(await audits(e.id)).toBe(1);
  });

  it('the database refuses a second opening by any other path, while adjustments stay free', async () => {
    const e = await person();
    expect((await adjust({ employeeId: e.id })).statusCode).toBe(201);
    const insert = (kind: string) =>
      h.db.query(
        `insert into leave_movement (company_id, employee_id, leave_type_id, movement_kind, units, effective_date, idempotency_key, reason)
         select $1, $2, id, $3, 5, '2026-01-05', $4, 'Synthetic' from leave_type where company_id = $1 and code = 'ANNUAL'`,
        [A.id, e.id, kind, uniq('direct-key-')],
      );
    await expect(insert('OPENING')).rejects.toThrow(/leave_movement_one_opening_uq/);
    await insert('ADJUSTMENT');
    expect(await available(e.id)).toBe('15.0000');
  });

  it('an exact replay records nothing new and says so; the key reused with other content is refused and records nothing', async () => {
    const e = await person();
    const other = await person();
    const key = uniq('opening-key-');
    const first = await adjust({ employeeId: e.id, idempotencyKey: key });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ status: 'RECORDED', replayed: false });
    const replay = await adjust({ employeeId: e.id, idempotencyKey: key });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual({ status: 'RECORDED', replayed: true });
    expect(await movements(e.id)).toBe(1);
    expect(await audits(e.id)).toBe(1);

    for (const reused of [
      { employeeId: other.id, idempotencyKey: key },
      { employeeId: e.id, idempotencyKey: key, units: '11' },
      { employeeId: e.id, idempotencyKey: key, leaveType: 'SICK' },
      { employeeId: e.id, idempotencyKey: key, kind: 'ADJUSTMENT' },
      { employeeId: e.id, idempotencyKey: key, effectiveDate: '2026-01-06' },
    ]) {
      const res = await adjust(reused);
      expect([res.statusCode, res.json().error]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
    }
    // Another actor's use of the key does not reveal or repeat the movement.
    const otherHr = await h.actor(A, 'HR_ADMINISTRATOR');
    expect((await adjust({ employeeId: e.id, idempotencyKey: key }, otherHr)).statusCode).toBe(409);
    expect(await movements(e.id)).toBe(1);
    expect(await movements(other.id)).toBe(0);
    expect(await audits(e.id)).toBe(1);
    expect(await audits(other.id)).toBe(0);
  });

  it('the same key racing for two employees: one records, the other is refused', async () => {
    const [one, two] = [await person(), await person()];
    const key = uniq('opening-key-');
    const results = await Promise.all([adjust({ employeeId: one.id, idempotencyKey: key }), adjust({ employeeId: two.id, idempotencyKey: key })]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect((await movements(one.id)) + (await movements(two.id))).toBe(1);
    expect((await audits(one.id)) + (await audits(two.id))).toBe(1);
  });
});

describe('opening-balance upload (FR-025, DF09)', () => {
  const HEADER = 'employeeCode,leaveType,units,effectiveDate,reason';
  const csv = (...rows: string[]) => `${HEADER}\r\n${rows.join('\r\n')}\r\n`;
  const upload = (a: TestActor, text: string, key = uniq('opening-batch-')) => h.call(a, 'POST', '/v1/leave/opening-imports', { fileName: 'opening.csv', contentBase64: toBase64(text), idempotencyKey: key });
  type Job = { id: string; state: string; template: string; acceptedCount: number; rejectedCount: number; rows: { businessKey: string; state: string; errorCode: string | null }[] };

  it('serves the template, previews without effect, commits all rows with actor and reason, and repeats nothing', async () => {
    const template = await h.call(hr, 'GET', '/v1/leave/opening-imports/template');
    expect(template.statusCode).toBe(200);
    expect(template.body).toBe(`${HEADER}\r\n`);

    const [one, two] = [await person(), await person()];
    const text = csv(`${one.code},ANNUAL,12.5,2026-01-05,Migrated balance (synthetic)`, `${two.code},annual,3,2026-01-05,Migrated balance (synthetic)`);
    const key = uniq('opening-batch-');
    const res = await upload(hr, text, key);
    expect(res.statusCode, res.body).toBe(201);
    const job = res.json() as Job;
    expect(job).toMatchObject({ state: 'PREVIEWED', template: 'LEAVE_OPENING_V1' });
    expect(job.rows.map((r) => r.state)).toEqual(['VALID', 'VALID']);
    expect(await movements(one.id)).toBe(0);

    // The same upload again is the same job.
    expect((await upload(hr, text, key)).json().id).toBe(job.id);

    const done = (await h.call(hr, 'POST', `/v1/leave/opening-imports/${job.id}/commit`)).json() as Job;
    expect(done).toMatchObject({ state: 'COMMITTED', acceptedCount: 2, rejectedCount: 0 });
    expect(await available(one.id)).toBe('12.5000');
    expect(await available(two.id)).toBe('3.0000');
    const stored = await h.one<{ movement_kind: string; reason: string; created_by: string }>(`select movement_kind, reason, created_by from leave_movement where employee_id = $1`, [one.id]);
    expect(stored).toEqual({ movement_kind: 'OPENING', reason: 'Migrated balance (synthetic)', created_by: hr.user });
    expect(await audits(one.id)).toBe(1);
    expect((await h.call(hr, 'POST', `/v1/leave/opening-imports/${job.id}/commit`)).json().state).toBe('COMMITTED');
    expect(await movements(one.id)).toBe(1);

    // FR-025: the same batch under a new key is blocked, whole.
    const again = (await upload(hr, text)).json() as Job;
    expect(again.state).toBe('REJECTED');
    expect(again.rows.map((r) => r.errorCode)).toEqual(['OPENING_EXISTS', 'OPENING_EXISTS']);
    expect(await movements(one.id)).toBe(1);
  });

  it('rejects the whole batch for any bad row, with row codes, and applies nothing', async () => {
    const good = await person();
    const repeated = await person();
    const other = await person();
    const job = (
      await upload(
        hr,
        csv(
          `${repeated.code},ANNUAL,1,2026-01-05,Synthetic`,
          `${repeated.code},annual,2,2026-01-05,Synthetic`,
          `NOBODY,ANNUAL,1,2026-01-05,Synthetic`,
          `${good.code},NOSUCHTYPE,1,2026-01-05,Synthetic`,
          `${good.code},ANNUAL,-1,2026-01-05,Synthetic`,
          `${good.code},SICK,0,2026-01-05,Synthetic`,
          `${good.code},CASUAL,1,2026-02-30,Synthetic`,
          `${good.code},UNPAID,1,2026-01-05,`,
          `${other.code},ANNUAL,1,2026-01-05,Synthetic,extra`,
          `${other.code},SICK,1,2026-01-05,Synthetic`,
        ),
      )
    ).json() as Job;
    expect(job.state).toBe('REJECTED');
    expect(job.rows.map((r) => r.errorCode)).toEqual([
      'BATCH_REJECTED',
      'DUPLICATE_IN_BATCH',
      'UNKNOWN_EMPLOYEE',
      'UNKNOWN_LEAVE_TYPE',
      'INVALID_UNITS',
      'INVALID_UNITS',
      'INVALID_DATE',
      'INVALID_REASON',
      'COLUMN_COUNT',
      'BATCH_REJECTED',
    ]);
    expect((await h.call(hr, 'POST', `/v1/leave/opening-imports/${job.id}/commit`)).statusCode).toBe(409);
    expect((await movements(good.id)) + (await movements(repeated.id)) + (await movements(other.id))).toBe(0);
  });

  it('applies the row scope and own-record rule per row; needs both duties; batches belong to their submitter', async () => {
    const eng = await person();
    const fin = await person({ departmentId: A.financeDept });
    const deptHr = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
    const job = (await upload(deptHr, csv(`${eng.code},ANNUAL,1,2026-01-05,Synthetic`, `${fin.code},ANNUAL,1,2026-01-05,Synthetic`))).json() as Job;
    expect(job.rows.map((r) => r.errorCode)).toEqual(['BATCH_REJECTED', 'OUT_OF_SCOPE']);

    const selfEmp = await person();
    const selfHr = await h.actor(A, 'HR_ADMINISTRATOR', { employeeId: selfEmp.id });
    const own = (await upload(selfHr, csv(`${selfEmp.code},ANNUAL,1,2026-01-05,Synthetic`))).json() as Job;
    expect(own.rows.map((r) => r.errorCode)).toEqual(['OUT_OF_SCOPE']);

    const self = await h.actor(A, 'EMPLOYEE', { employeeId: eng.id });
    expect((await upload(self, csv(`${eng.code},ANNUAL,1,2026-01-05,Synthetic`))).statusCode).toBe(403);
    const adjustOnly = await h.actor(A, 'HR_ADMINISTRATOR', { duties: ['leave.adjust.operational'] });
    expect((await upload(adjustOnly, csv(`${eng.code},ANNUAL,1,2026-01-05,Synthetic`))).statusCode).toBe(403);
    expect((await h.call(hr, 'GET', `/v1/leave/opening-imports/${job.id}`)).statusCode).toBe(404);
  });
});

describe('the employee ledger (FR-025)', () => {
  const ledger = async (actor: TestActor, employee: string, query: string) => {
    const res = await h.call(actor, 'GET', `/v1/employees/${employee}/leave-ledger?${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { items: { leaveType: string; opening: string; credits: string; debits: string; closing: string; movements: Record<string, unknown>[] }[] };
  };
  const reviewedLeave = async () => {
    const e = await person();
    await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
    const actor = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
    return { ...e, actor };
  };

  it('opening + credits - debits = closing, per period and type, with kind, actor and linked request', async () => {
    const e = await reviewedLeave();
    await adjust({ employeeId: e.id, leaveType: 'CASUAL', units: '6', effectiveDate: '2026-01-05' });
    await adjust({ employeeId: e.id, leaveType: 'CASUAL', kind: 'ADJUSTMENT', units: '-1.5', effectiveDate: '2026-02-10', reason: 'Correction (synthetic)' });
    await adjust({ employeeId: e.id, leaveType: 'CASUAL', kind: 'ADJUSTMENT', units: '0.25', effectiveDate: '2026-04-01', reason: 'Later correction (synthetic)' });
    // Taken inside the period: reserved, released and consumed on approval (2026-03-02 is a Monday).
    const submitted = await h.call(e.actor, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: '2026-03-02', endDate: '2026-03-03' });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const task = ((await h.call(hr, 'GET', '/v1/leave/tasks')).json().items as { taskId: string; summary: { requestId: string } }[]).find((t) => t.summary.requestId === submitted.json().requestId)!;
    expect((await h.call(hr, 'POST', `/v1/leave/tasks/${task.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('decision-key-') })).statusCode).toBe(200);

    const period = (await ledger(hr, e.id, 'from=2026-02-01&to=2026-03-31&leaveType=CASUAL')).items;
    expect(period).toHaveLength(1);
    expect(period[0]).toMatchObject({ leaveType: 'CASUAL', opening: '6.0000', credits: '2.0000', debits: '5.5000', closing: '2.5000' });
    expect(period[0]!.movements.map((m) => [m.kind, m.units])).toEqual([
      ['ADJUSTMENT', '-1.5000'],
      ['RESERVATION', '-2.0000'],
      ['RESERVATION_RELEASE', '2.0000'],
      ['CONSUMPTION', '-2.0000'],
    ]);
    expect(period[0]!.movements[0]).toMatchObject({ actorUserId: hr.user, requestId: null, effectiveDate: '2026-02-10' });
    expect(period[0]!.movements[3]).toMatchObject({ requestId: submitted.json().requestId });

    // Consecutive periods chain, and the last closing is the balance read.
    const all = (await ledger(hr, e.id, 'from=2026-01-01&to=2026-12-31&leaveType=CASUAL')).items[0]!;
    expect(all).toMatchObject({ opening: '0.0000', closing: '2.7500' });
    expect(await available(e.id, 'CASUAL')).toBe('2.7500');
    const after = (await ledger(hr, e.id, 'from=2026-04-01&to=2026-04-30&leaveType=CASUAL')).items[0]!;
    expect(after.opening).toBe(period[0]!.closing);
    const sum = await h.one<{ total: string }>(
      `select sum(units)::numeric(12,4)::text as total from leave_movement m join leave_type t on t.id = m.leave_type_id where m.employee_id = $1 and t.code = 'CASUAL' and m.effective_date <= '2026-03-31'`,
      [e.id],
    );
    expect(sum.total).toBe(period[0]!.closing);
  });

  it('an HR note needs the reason group and is never part of the own-record view; scope applies', async () => {
    const e = await reviewedLeave();
    await adjust({ employeeId: e.id, leaveType: 'SICK', units: '2', effectiveDate: '2026-01-05', reason: 'Private HR note (synthetic)' });
    const q = 'from=2026-01-01&to=2026-01-31&leaveType=SICK';
    expect(JSON.stringify(await ledger(hr, e.id, q))).not.toContain('Private HR note');
    const reader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['leave.read.reason'] });
    expect((await ledger(reader, e.id, q)).items[0]!.movements[0]).toMatchObject({ reason: 'Private HR note (synthetic)', actorUserId: hr.user });
    const own = await ledger(e.actor, e.id, q);
    expect(own.items[0]).toMatchObject({ closing: '2.0000' });
    expect(JSON.stringify(own)).not.toContain('Private HR note');
    const stranger = await h.actor(A, 'EMPLOYEE', { employeeId: (await person()).id });
    expect((await h.call(stranger, 'GET', `/v1/employees/${e.id}/leave-ledger?${q}`)).statusCode).toBe(404);
    expect((await h.call(hr, 'GET', `/v1/employees/${e.id}/leave-ledger?from=2026-02-01&to=2026-01-01`)).statusCode).toBe(422);
  });
});

describe('leave attachments (FR-026, FR-106, I-22)', () => {
  const pdf = (s: string) => Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`, 'latin1').toString('base64');
  const uploadDocument = async (a: TestActor, employeeId: string, content = pdf(`synthetic ${uniq('e')}`)) =>
    (await h.call(a, 'POST', `/v1/employees/${employeeId}/documents`, { documentType: 'GENERAL', fileName: 'medical-note.pdf', contentBase64: content })).json().id as string;
  const taskOf = async (a: TestActor, requestId: string) =>
    ((await h.call(a, 'GET', '/v1/leave/tasks')).json().items as { taskId: string; summary: { requestId: string; evidence: { documentId: string; scanState: string }[] } }[]).find((t) => t.summary.requestId === requestId);
  const contentUrl = (requestId: string, documentId: string) => `/v1/leave/requests/${requestId}/evidence/${documentId}/content`;
  // Unpaid leave: no balance is needed for these.
  const leave = (a: TestActor, day: string, extra: Record<string, unknown> = {}) => h.call(a, 'POST', '/v1/leave/requests', { leaveType: 'UNPAID', startDate: day, endDate: day, ...extra });
  const monday = (weeks: number) => {
    const d = new Date(Date.now() + weeks * 7 * 86_400_000);
    while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };

  it('links own released documents; the requester and the assigned reviewer read them, nobody else does', async () => {
    const e = await person();
    await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
    const doc = await uploadDocument(self, e.id);
    const created = await leave(self, monday(3), { evidenceDocumentIds: [doc] });
    expect(created.statusCode, created.body).toBe(201);
    const { requestId } = created.json();

    const own = ((await h.call(self, 'GET', `/v1/employees/${e.id}/leave-requests`)).json().items as { id: string; evidence: { documentId: string }[] }[]).find((r) => r.id === requestId)!;
    expect(own.evidence.map((x) => x.documentId)).toEqual([doc]);
    const task = await taskOf(manager, requestId);
    expect(task!.summary.evidence).toMatchObject([{ documentId: doc, scanState: 'CLEAN' }]);

    expect((await h.call(self, 'GET', contentUrl(requestId, doc))).statusCode).toBe(200);
    expect((await h.call(manager, 'GET', contentUrl(requestId, doc))).statusCode).toBe(200);
    const otherManagerEmp = (await person()).id;
    const otherManager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: otherManagerEmp });
    expect((await h.call(otherManager, 'GET', contentUrl(requestId, doc))).statusCode).toBe(404);
    expect((await h.call(hr, 'GET', contentUrl(requestId, doc))).statusCode).toBe(404); // not assigned, not the owner
    const reads = await h.one<{ n: number }>(`select count(*)::int as n from audit_event where resource_code = 'employee_document' and record_key = $1 and action = 'READ_CONTENT'`, [doc]);
    expect(reads.n).toBe(2);
  });

  it('refuses another person’s or a quarantined document; a refused request records nothing', async () => {
    const e = await person();
    await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
    const other = await person();
    const foreign = await uploadDocument(await h.actor(A, 'EMPLOYEE', { employeeId: other.id }), other.id);
    const day = monday(5);
    expect((await leave(self, day, { evidenceDocumentIds: [foreign] })).json().error).toBe('INVALID_EVIDENCE');
    const infected = await uploadDocument(self, e.id, pdf(EICAR_TEST_STRING));
    expect((await leave(self, day, { evidenceDocumentIds: [infected] })).json().error).toBe('EVIDENCE_UNUSABLE');
    const none = await h.one<{ n: number }>(`select count(*)::int as n from leave_request where employee_id = $1`, [e.id]);
    expect(none.n).toBe(0);
  });

  it('a resubmission keeps the earlier documents unless new ones are chosen; each revision keeps its own', async () => {
    const e = await person();
    await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
    const first = await uploadDocument(self, e.id);
    const day = monday(7);
    const { requestId } = (await leave(self, day, { evidenceDocumentIds: [first] })).json();
    const giveBack = async () => {
      const task = await taskOf(manager, requestId);
      expect((await h.call(manager, 'POST', `/v1/leave/tasks/${task!.taskId}/decision`, { decision: 'RETURN', reason: 'Please correct (synthetic)', idempotencyKey: uniq('decision-key-') })).statusCode).toBe(200);
      return ((await h.call(self, 'GET', `/v1/employees/${e.id}/leave-requests`)).json().items as { id: string; version: number }[]).find((r) => r.id === requestId)!.version;
    };
    const resubmit = async (version: number, extra: Record<string, unknown> = {}) =>
      h.call(self, 'PUT', `/v1/leave/requests/${requestId}`, { startDate: day, endDate: day, expectedVersion: version, ...extra });
    expect((await resubmit(await giveBack())).statusCode).toBe(200);
    expect((await taskOf(manager, requestId))!.summary.evidence.map((x) => x.documentId)).toEqual([first]);

    const second = await uploadDocument(self, e.id);
    expect((await resubmit(await giveBack(), { evidenceDocumentIds: [second] })).statusCode).toBe(200);
    expect((await taskOf(manager, requestId))!.summary.evidence.map((x) => x.documentId)).toEqual([second]);
    const revisions = await h.db.query<{ transaction_revision: number; document_id: string }>(
      `select te.transaction_revision, te.document_id from transaction_evidence te join leave_request lr on lr.transaction_id = te.transaction_id where lr.id = $1 order by 1`,
      [requestId],
    );
    expect(revisions.rows).toEqual([
      { transaction_revision: 1, document_id: first },
      { transaction_revision: 2, document_id: first },
      { transaction_revision: 3, document_id: second },
    ]);
  });
});
