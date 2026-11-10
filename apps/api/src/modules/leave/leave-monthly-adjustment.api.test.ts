// Monthly leave-balance upload over HTTP (the reference system's "Upload Monthly Leave Balance"; FR-025 "a leave ledger ... rather
// than an untraceable editable total", "an adjustment preserves actor and reason"; DF05 "no negative paid balance"; DF09
// imports; ZT07 idempotency; BR-026 row scope): preview, ledger movements, idempotency and the row rules. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;

const HEADER = 'employeeCode,leaveType,month,units,reason';
const PATH = '/v1/leave/monthly-adjustment-imports';
const csv = (...rows: string[]) => `${HEADER}\r\n${rows.join('\r\n')}\r\n`;
const toBase64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
type Job = {
  id: string;
  state: string;
  template: string;
  acceptedCount: number;
  rejectedCount: number;
  rows: { businessKey: string; state: string; errorCode: string | null; proposedChanges: Record<string, { from: string; to: string }> | null }[];
};
const upload = async (a: TestActor, text: string, key = uniq('monthly-batch-')) => h.call(a, 'POST', PATH, { fileName: 'monthly.csv', contentBase64: toBase64(text), idempotencyKey: key });
const uploaded = async (a: TestActor, text: string, key?: string) => {
  const res = await upload(a, text, key);
  expect([200, 201], res.body).toContain(res.statusCode);
  return res.json() as Job;
};
const commit = async (a: TestActor, id: string) => (await h.call(a, 'POST', `${PATH}/${id}/commit`)).json() as Job;
const available = async (employee: string, type = 'ANNUAL') => ((await h.call(hr, 'GET', `/v1/employees/${employee}/leave-balances`)).json().items as { leaveType: string; available: string }[]).find((b) => b.leaveType === type)!.available;
const movements = async (employee: string) =>
  (
    await h.db.query<{ movement_kind: string; units: string; effective_date: string; reason: string | null; created_by: string }>(
      `select movement_kind, units::text, to_char(effective_date, 'YYYY-MM-DD') as effective_date, reason, created_by from leave_movement where employee_id = $1 order by effective_date, leave_type_id, created_at, id`,
      [employee],
    )
  ).rows;
const adjust = (body: Record<string, unknown>) =>
  h.call(hr, 'POST', '/v1/leave/adjustments', { kind: 'OPENING', leaveType: 'ANNUAL', effectiveDate: '2026-01-05', reason: 'Opening balance (synthetic)', idempotencyKey: uniq('opening-key-'), ...body });

async function person(over: Record<string, unknown> = {}): Promise<{ id: string; code: string }> {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, over))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  return { id: e.id, code: e.employeeCode };
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
}, 300_000);

afterAll(async () => {
  await h?.stop();
});

describe('monthly leave-balance upload (FR-025, DF09)', () => {
  it('FR-025: serves the template; the preview shows each balance at the month end and applies nothing; the commit adds reasoned ADJUSTMENT movements, never overwriting', async () => {
    const template = await h.call(hr, 'GET', `${PATH}/template`);
    expect(template.statusCode).toBe(200);
    expect(template.body).toBe(`${HEADER}\r\n`);

    const [one, two] = [await person(), await person()];
    expect((await adjust({ employeeId: one.id, units: '10' })).statusCode).toBe(201);
    expect((await adjust({ employeeId: two.id, leaveType: 'SICK', units: '3' })).statusCode).toBe(201);
    const key = uniq('monthly-batch-');
    const text = csv(`${one.code},ANNUAL,2026-10,+1.5,October credit (synthetic)`, `${two.code},sick,2026-09,-1,September correction (synthetic)`);
    const job = await uploaded(hr, text, key);
    expect(job).toMatchObject({ state: 'PREVIEWED', template: 'LEAVE_MONTHLY_ADJUSTMENT_V1' });
    expect(job.rows.map((r) => [r.businessKey, r.state, r.proposedChanges])).toEqual([
      [`${one.code.toUpperCase()}@ANNUAL@2026-10`, 'VALID', { balanceAtMonthEnd: { from: '10.0000', to: '11.5000' } }],
      [`${two.code.toUpperCase()}@SICK@2026-09`, 'VALID', { balanceAtMonthEnd: { from: '3.0000', to: '2.0000' } }],
    ]);
    expect(await movements(one.id)).toHaveLength(1);

    const done = await commit(hr, job.id);
    expect(done).toMatchObject({ state: 'COMMITTED', acceptedCount: 2, rejectedCount: 0 });
    expect(await movements(one.id)).toEqual([
      { movement_kind: 'OPENING', units: '10.0000', effective_date: '2026-01-05', reason: 'Opening balance (synthetic)', created_by: hr.user },
      { movement_kind: 'ADJUSTMENT', units: '1.5000', effective_date: '2026-10-31', reason: 'October credit (synthetic)', created_by: hr.user },
    ]);
    expect(await available(one.id)).toBe('11.5000');
    expect(await available(two.id, 'SICK')).toBe('2.0000');
    // The ledger: opening + credits - debits = closing, the upload a credit of the month.
    const ledger = (await h.call(hr, 'GET', `/v1/employees/${one.id}/leave-ledger?from=2026-10-01&to=2026-10-31&leaveType=ANNUAL`)).json();
    expect(ledger.items[0]).toMatchObject({ opening: '10.0000', credits: '1.5000', debits: '0.0000', closing: '11.5000' });
    const audit = await h.one<{ n: number }>(`select count(*)::int as n from audit_event where resource_code = 'leave_balance' and record_key = $1 and action = 'ADJUSTMENT'`, [one.id]);
    expect(audit.n).toBe(1);
  });

  it('FR-025 ZT07: the same upload is the same job, a repeated commit changes nothing, and the same file under a new key is rejected whole', async () => {
    const e = await person();
    const key = uniq('monthly-batch-');
    const text = csv(`${e.code},CASUAL,2026-08,2,August credit (synthetic)`, `${e.code},CASUAL,2026-09,0.5,September credit (synthetic)`);
    const job = await uploaded(hr, text, key);
    expect((await uploaded(hr, text, key)).id).toBe(job.id);
    expect((await commit(hr, job.id)).state).toBe('COMMITTED');
    expect((await commit(hr, job.id)).state).toBe('COMMITTED');
    expect((await movements(e.id)).map((m) => [m.units, m.effective_date])).toEqual([
      ['2.0000', '2026-08-31'],
      ['0.5000', '2026-09-30'],
    ]);

    // One upload adjustment per employee, leave type and month: the file again is refused, row by row, and nothing is applied.
    const again = await uploaded(hr, text);
    expect(again.state).toBe('REJECTED');
    expect(again.rows.map((r) => r.errorCode)).toEqual(['MONTH_ALREADY_ADJUSTED', 'MONTH_ALREADY_ADJUSTED']);
    // A changed amount for the same month is refused too; another month or another type is accepted.
    const changed = await uploaded(hr, csv(`${e.code},CASUAL,2026-09,1,September again (synthetic)`, `${e.code},CASUAL,2026-10,1,October credit (synthetic)`));
    expect(changed.rows.map((r) => r.errorCode)).toEqual(['MONTH_ALREADY_ADJUSTED', 'BATCH_REJECTED']);
    const next = await uploaded(hr, csv(`${e.code},CASUAL,2026-10,1,October credit (synthetic)`, `${e.code},SICK,2026-09,1,September sick credit (synthetic)`));
    expect((await commit(hr, next.id)).state).toBe('COMMITTED');
    expect(await movements(e.id)).toHaveLength(4);
    // The database's own key refuses any other path to a second movement of the month.
    const type = await h.one<{ id: string }>(`select id from leave_type where company_id = $1 and code = 'CASUAL'`, [A.id]);
    await expect(
      h.db.query(
        `insert into leave_movement (company_id, employee_id, leave_type_id, movement_kind, units, effective_date, idempotency_key, reason)
         values ($1, $2, $3, 'ADJUSTMENT', 1, '2026-09-30', $4, 'Synthetic')`,
        [A.id, e.id, type.id, `leave:monthly-upload:${e.id}:${type.id}:2026-09`],
      ),
    ).rejects.toThrow(/leave_movement_company_id_idempotency_key_key|duplicate key/);
  });

  it('DF05: a deduction may not take a paid balance below zero, at the month end or overall; an unpaid type is not limited', async () => {
    const e = await person();
    expect((await adjust({ employeeId: e.id, units: '2' })).statusCode).toBe(201);
    // 1.5 units already taken from December: 0.5 are left overall, though 2 are held at the end of October.
    expect((await adjust({ employeeId: e.id, kind: 'ADJUSTMENT', units: '-1.5', effectiveDate: '2026-12-15', reason: 'Later correction (synthetic)' })).statusCode).toBe(201);
    const refused = async (row: string) => (await uploaded(hr, csv(row))).rows.map((r) => r.errorCode);
    expect(await refused(`${e.code},ANNUAL,2026-10,-3,Too much (synthetic)`)).toEqual(['NEGATIVE_BALANCE']);
    expect(await refused(`${e.code},ANNUAL,2026-10,-1,Above what is left overall (synthetic)`)).toEqual(['NEGATIVE_BALANCE']);
    expect(await refused(`${e.code},ANNUAL,2026-10,-0.5,Exactly what is left (synthetic)`)).toEqual([null]);
    expect(await refused(`${e.code},UNPAID,2026-10,-1,Unpaid correction (synthetic)`)).toEqual([null]);
    expect(await available(e.id)).toBe('0.5000');
  });

  it('DF09: any bad row rejects the whole batch with its code, and nothing is applied', async () => {
    const good = await person();
    const later = await person({ joiningDate: '2026-06-15' });
    const job = await uploaded(
      hr,
      csv(
        `${good.code},ANNUAL,2026-09,1,Synthetic`,
        `${good.code},annual,2026-09,2,Synthetic`,
        `NOBODY,ANNUAL,2026-09,1,Synthetic`,
        `${good.code},NOSUCHTYPE,2026-09,1,Synthetic`,
        `${good.code},SICK,2026-09,0,Synthetic`,
        `${good.code},SICK,2026-08,1.00001,Synthetic`,
        `${good.code},SICK,2026-07,one,Synthetic`,
        `${good.code},CASUAL,2026-13,1,Synthetic`,
        `${good.code},CASUAL,2026-07-01,1,Synthetic`,
        `${good.code},CASUAL,2026-06,1,`,
        `${good.code},CASUAL,2099-01,1,Synthetic`,
        `${later.code},ANNUAL,2026-05,1,Synthetic`,
        `${later.code},ANNUAL,2026-06,1,Synthetic,extra`,
        `${later.code},ANNUAL,2026-07,1,Synthetic`,
      ),
    );
    expect(job.state).toBe('REJECTED');
    expect(job.rows.map((r) => r.errorCode)).toEqual([
      'BATCH_REJECTED',
      'DUPLICATE_IN_BATCH',
      'UNKNOWN_EMPLOYEE',
      'UNKNOWN_LEAVE_TYPE',
      'INVALID_UNITS',
      'INVALID_UNITS',
      'INVALID_UNITS',
      'INVALID_MONTH',
      'INVALID_MONTH',
      'INVALID_REASON',
      'FUTURE_MONTH',
      'NOT_EMPLOYED_IN_MONTH',
      'COLUMN_COUNT',
      'BATCH_REJECTED',
    ]);
    expect((await h.call(hr, 'POST', `${PATH}/${job.id}/commit`)).statusCode).toBe(409);
    expect((await movements(good.id)).length + (await movements(later.id)).length).toBe(0);
  });

  it('BR-026: the row scope and the own-record rule apply per row; both duties are needed; batches belong to their submitter', async () => {
    const eng = await person();
    const fin = await person({ departmentId: A.financeDept });
    const deptHr = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
    const job = await uploaded(deptHr, csv(`${eng.code},ANNUAL,2026-09,1,Synthetic`, `${fin.code},ANNUAL,2026-09,1,Synthetic`));
    expect(job.rows.map((r) => r.errorCode)).toEqual(['BATCH_REJECTED', 'OUT_OF_SCOPE']);
    // Nothing about the out-of-scope employee is shown, not even a balance.
    expect(job.rows[1]!.proposedChanges).toBeNull();

    const selfEmp = await person();
    const selfHr = await h.actor(A, 'HR_ADMINISTRATOR', { employeeId: selfEmp.id });
    expect((await uploaded(selfHr, csv(`${selfEmp.code},ANNUAL,2026-09,1,Synthetic`))).rows.map((r) => r.errorCode)).toEqual(['OUT_OF_SCOPE']);

    const self = await h.actor(A, 'EMPLOYEE', { employeeId: eng.id });
    expect((await upload(self, csv(`${eng.code},ANNUAL,2026-09,1,Synthetic`))).statusCode).toBe(403);
    const adjustOnly = await h.actor(A, 'HR_ADMINISTRATOR', { duties: ['leave.adjust.operational'] });
    expect((await upload(adjustOnly, csv(`${eng.code},ANNUAL,2026-09,1,Synthetic`))).statusCode).toBe(403);
    expect((await h.call(hr, 'GET', `${PATH}/${job.id}`)).statusCode).toBe(404);
    expect(((await h.call(deptHr, 'GET', PATH)).json().items as { id: string }[]).map((b) => b.id)).toContain(job.id);
  });
});
