// Attendance punch imports over HTTP (FR-019; DF05; DF09; 0114): tracked submissions with a stored file, published
// templates, dry-run preview, partial acceptance with quarantine, the error report, event-key replay protection across
// sources, repeated and future punches, in/out-time rows and the punch list. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { memoryFileStore } from '../../storage/files.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import { followUpSuite } from '../imports/follow-up.fixtures.js';
import { commitBatch, submitBatch } from '../imports/jobs.js';
import { PUNCH_IMPORT_SPEC } from './punch-import.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let hrFinance: TestActor;
let shiftId: string;

// Fixed past dates (2026-03-02 is a Monday). Asia/Kolkata is UTC+05:30.
const MON = '2026-03-02';
const TUE = '2026-03-03';
const PUNCH_HEADER = 'employeeCode,occurredAt,direction,externalEventKey,sourceIdentity';
const IN_OUT_HEADER = 'employeeCode,workDate,inTime,outTime';
const at = (d: string, hhmm: string) => `${d}T${hhmm}:00+05:30`;
const file = (header: string, rows: string[]) => [header, ...rows].join('\r\n');
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

type Row = { rowNumber: number; state: string; errorCode: string | null; businessKey: string; proposedChanges: Record<string, { to: string | null }> | null };
type Job = { id: string; state: string; template: string; rowCount: number; acceptedCount: number; rejectedCount: number; rows: Row[] };

const upload = (a: TestActor, path: string, text: string, key = uniq('punch-key-')) => h.call(a, 'POST', path, { fileName: 'punches.csv', contentBase64: b64(text), idempotencyKey: key });
const PUNCHES = '/v1/attendance/punch-imports';
const IN_OUT = '/v1/attendance/in-out-imports';
const commit = async (a: TestActor, path: string, id: string) => {
  const res = await h.call(a, 'POST', `${path}/${id}/commit`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Job;
};
const previewed = async (a: TestActor, path: string, text: string) => {
  const res = await upload(a, path, text);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Job;
};
const stateOf = (job: Job) => job.rows.map((r) => [r.state, r.errorCode]);

async function activeEmployee(overrides: Record<string, unknown> = {}): Promise<{ id: string; code: string }> {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, overrides))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' });
  return { id: e.id, code: e.employeeCode };
}
const punchesOf = async (employeeId: string, from = MON, to = TUE) =>
  (await h.call(hr, 'GET', `/v1/employees/${employeeId}/punches?from=${from}&to=${to}`)).json().items as {
    occurredAt: string;
    direction: string;
    source: string;
    eventKey: string;
    importJobId: string | null;
    importRowNumber: number | null;
    repeatOfPunchId: string | null;
  }[];

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  hrFinance = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
  shiftId = (await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] })).json().id;
});

afterAll(async () => {
  await h?.stop();
});

describe('a tracked submission (FR-019, DF09)', () => {
  it('previews without storing, commits the valid events, quarantines the invalid ones, and every punch names its submission', async () => {
    const e = await activeEmployee();
    const job = await previewed(hr, PUNCHES, file(PUNCH_HEADER, [
      `${e.code},${at(MON, '09:00')},IN,${uniq('evt-')},`,
      `NOPE-404,${at(MON, '09:00')},IN,${uniq('evt-')},`,
      `${e.code},${MON}T09:00:00,IN,${uniq('evt-')},`,
      `${e.code},2026-02-30T09:00:00+05:30,IN,${uniq('evt-')},`,
      `${e.code},${at(MON, '18:00')},SIDEWAYS,${uniq('evt-')},`,
      `${e.code},${at(MON, '18:00')},OUT,,`,
      `${e.code},${at(MON, '18:00')},OUT,${uniq('evt-')},`,
      `${e.code},${at(MON, '19:00')},OUT`,
    ]));
    // A preview is a dry run with results for every row (DF09); nothing is stored yet.
    expect(job).toMatchObject({ state: 'PREVIEWED', template: 'ATTENDANCE_PUNCH_V1', rowCount: 8 });
    const expected = [
      ['VALID', null],
      ['QUARANTINED', 'UNKNOWN_EMPLOYEE'],
      ['QUARANTINED', 'INVALID_TIMESTAMP'],
      ['QUARANTINED', 'INVALID_TIMESTAMP'],
      ['QUARANTINED', 'INVALID_DIRECTION'],
      ['QUARANTINED', 'MISSING_EVENT_KEY'],
      ['VALID', null],
      ['QUARANTINED', 'COLUMN_COUNT'],
    ];
    expect(stateOf(job)).toEqual(expected);
    expect(await punchesOf(e.id)).toEqual([]);

    const done = await commit(hr, PUNCHES, job.id);
    expect(done).toMatchObject({ state: 'COMMITTED', acceptedCount: 2, rejectedCount: 6 });
    expect(stateOf(done)).toEqual(expected.map(([state, code]) => [state === 'VALID' ? 'ACCEPTED' : state, code]));
    const stored = await punchesOf(e.id);
    expect(stored.map((p) => [p.direction, p.importJobId, p.importRowNumber, p.source])).toEqual([
      ['IN', job.id, 1, 'manual-import'],
      ['OUT', job.id, 7, 'manual-import'],
    ]);

    // Committing again changes nothing; the stored file is the job's confidential attachment, and the job its audit trail.
    expect((await commit(hr, PUNCHES, job.id)).acceptedCount).toBe(2);
    expect(await punchesOf(e.id)).toHaveLength(2);
    const attachment = await h.one<{ classification: string; scan_state: string; checksum: string }>(
      `select a.classification, a.scan_state, a.checksum from import_job j join attachment a on a.company_id = j.company_id and a.id = j.attachment_id where j.id = $1`,
      [job.id],
    );
    expect(attachment).toMatchObject({ classification: 'CONFIDENTIAL', scan_state: 'CLEAN' });
    const trail = (await h.db.query<{ action: string; after: { operational: Record<string, unknown> } }>(`select action, after_values as after from audit_event where resource_code = 'import_job' and record_key = $1 order by created_at, id`, [job.id])).rows;
    expect(trail.map((t) => t.action)).toEqual(['CREATE', 'COMMIT']);
    expect(trail[1]!.after.operational).toMatchObject({ acceptedCount: 2, rejectedCount: 6, rowCount: 8 });
  });

  it('the stored error report lists every row left out with its submitted cells, guarded against spreadsheet formulas', async () => {
    const e = await activeEmployee();
    const job = await previewed(hr, PUNCHES, file(PUNCH_HEADER, [
      `${e.code},${at(MON, '09:00')},IN,${uniq('evt-')},`,
      `=HYPERLINK(1),${at(MON, '09:00')},IN,formula-row,`,
      `${e.code},not-a-time,IN,bad-time-row,`,
    ]));
    await commit(hr, PUNCHES, job.id);
    const report = await h.call(hr, 'GET', `${PUNCHES}/${job.id}/error-report`);
    expect(report.statusCode, report.body).toBe(200);
    expect(report.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(report.headers['content-disposition']).toBe('attachment; filename="ATTENDANCE_PUNCH_V1-errors.csv"');
    const lines = report.body.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('"rowNumber","state","errorCode","employeeCode","occurredAt","direction","externalEventKey","sourceIdentity"');
    expect(lines[1]).toContain('"2","QUARANTINED","UNKNOWN_EMPLOYEE"');
    // The guard writes formula-like text as text.
    expect(lines[1]).toContain(`"'=HYPERLINK`);
    expect(lines[2]).toContain('"3","QUARANTINED","INVALID_TIMESTAMP"');
    expect(lines[2]).toContain('"not-a-time"');
    expect((await h.db.query(`select 1 from audit_event where resource_code = 'import_job' and record_key = $1 and action = 'EXPORT_ERROR_REPORT'`, [job.id])).rowCount).toBe(1);

    // Only the submitter's own batch, under the import grant.
    const other = await h.actor(A, 'HR_ADMINISTRATOR');
    expect((await h.call(other, 'GET', `${PUNCHES}/${job.id}/error-report`)).statusCode).toBe(404);
    expect((await h.call(await h.actor(A, 'AUDITOR'), 'GET', `${PUNCHES}/${job.id}/error-report`)).statusCode).toBe(403);
  });

  it('refuses a file with the wrong header; a row out of scope reads as unknown; the commit re-checks the duty', async () => {
    expect((await upload(hr, PUNCHES, 'employeeCode,occurredAt\r\nE1,x')).json().error).toBe('INVALID_HEADER');
    const e = await activeEmployee();
    const scoped = await previewed(hrFinance, PUNCHES, file(PUNCH_HEADER, [`${e.code},${at(MON, '09:00')},IN,${uniq('evt-')},`]));
    expect(stateOf(scoped)).toEqual([['QUARANTINED', 'UNKNOWN_EMPLOYEE']]);

    // What the route guard resolved, before the duty was withdrawn: the commit refuses and stores nothing.
    const importer = await h.actor(A, 'HR_ADMINISTRATOR');
    const job = await previewed(importer, PUNCHES, file(PUNCH_HEADER, [`${e.code},${at(MON, '09:00')},IN,${uniq('evt-')},`]));
    const grant = (await resolveAccess(h.pool, { userId: importer.user, companyId: A.id, assignmentId: importer.assignment, resource: 'attendance', action: 'import', fieldGroups: ['operational'] })) as AccessGrant;
    expect(grant.allowed).toBe(true);
    await h.db.query(
      `update role_assignment_permission set active = false where company_id = $1 and role_assignment_id = $2
          and permission_id = (select id from permission where resource = 'attendance' and action = 'import' and field_group = 'operational')`,
      [A.id, importer.assignment],
    );
    // The stored file is in the app's own store, out of reach here; the duty is checked before the file is read.
    await expect(commitBatch(h.pool, memoryFileStore(), grant, PUNCH_IMPORT_SPEC, job.id)).rejects.toMatchObject({ statusCode: 403 });
    expect(await punchesOf(e.id)).toEqual([]);
    expect((await h.call(importer, 'POST', `${PUNCHES}/${job.id}/commit`)).statusCode).toBe(403);
    expect(await h.one<{ state: string }>(`select state from import_job where id = $1`, [job.id])).toEqual({ state: 'PREVIEWED' });
  });

  it('the database refuses a manual punch that names no submission (0114)', async () => {
    const e = await activeEmployee();
    await expect(
      h.db.query(
        `insert into attendance_punch (company_id, employee_id, occurred_at, direction, source_kind, external_event_key, source_identity_key) values ($1, $2, now() - interval '1 day', 'IN', 'MANUAL_IMPORT', $3, 'manual-import')`,
        [A.id, e.id, uniq('evt-')],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('replay protection and repeated punches (FR-019, DF09, ZT07)', () => {
  it('reimporting an identical file doubles nothing: the same key is a duplicate, a changed one a conflict for review', async () => {
    const e = await activeEmployee();
    const [k1, k2] = [uniq('evt-'), uniq('evt-')];
    const text = file(PUNCH_HEADER, [`${e.code},${at(MON, '09:00')},IN,${k1},`, `${e.code},${at(MON, '18:00')},OUT,${k2},`]);
    const first = await previewed(hr, PUNCHES, text);
    expect((await commit(hr, PUNCHES, first.id)).acceptedCount).toBe(2);

    const again = await previewed(hr, PUNCHES, text);
    expect(stateOf(again)).toEqual([['REJECTED', 'DUPLICATE_EVENT'], ['REJECTED', 'DUPLICATE_EVENT']]);
    const done = await commit(hr, PUNCHES, again.id);
    expect(done).toMatchObject({ state: 'COMMITTED', acceptedCount: 0, rejectedCount: 2 });
    expect(await punchesOf(e.id)).toHaveLength(2);

    const changed = await previewed(hr, PUNCHES, file(PUNCH_HEADER, [`${e.code},${at(MON, '09:05')},IN,${k1},`]));
    expect(stateOf(changed)).toEqual([['QUARANTINED', 'CONFLICTING_DUPLICATE_KEY']]);
    await commit(hr, PUNCHES, changed.id);
    expect((await punchesOf(e.id)).map((p) => p.occurredAt)).not.toContain(new Date(at(MON, '09:05')).toISOString());
  });

  it('keeps event keys apart by device: equal device-local keys are two punches; repeats within one device still replay', async () => {
    const [e, f] = [await activeEmployee(), await activeEmployee()];
    const key = uniq('device-local-');
    const job = await previewed(hr, PUNCHES, file(PUNCH_HEADER, [
      `${e.code},${at(MON, '09:00')},IN,${key},dev-1`,
      `${f.code},${at(MON, '09:01')},IN,${key},DEV-2`,
      `${e.code},${at(MON, '09:00')},IN,${key},DEV-1`,
      `${f.code},${at(MON, '09:30')},IN,${key},dev-2`,
      `${f.code},${at(MON, '09:40')},IN,${uniq('evt-')},bad source`,
    ]));
    expect(stateOf(job)).toEqual([
      ['VALID', null],
      ['VALID', null],
      ['REJECTED', 'DUPLICATE_EVENT'],
      ['QUARANTINED', 'CONFLICTING_DUPLICATE_KEY'],
      ['QUARANTINED', 'INVALID_SOURCE'],
    ]);
    await commit(hr, PUNCHES, job.id);
    expect((await punchesOf(e.id)).map((p) => p.source)).toEqual(['manual-import:DEV-1']);
    expect((await punchesOf(f.id)).map((p) => p.source)).toEqual(['manual-import:DEV-2']);
  });

  it('keeps replay protection for punches stored before submissions were tracked', async () => {
    const e = await activeEmployee();
    const key = uniq('evt-');
    const old = new Date(at(MON, '09:00')).toISOString();
    // A punch from before 0114: the trigger that wants a submission applies to new rows only, so it is set aside here.
    await h.db.query('begin');
    await h.db.query(`set local session_replication_role = 'replica'`);
    await h.db.query(`insert into attendance_punch (company_id, employee_id, occurred_at, direction, source_kind, external_event_key, source_identity_key) values ($1, $2, $3, 'IN', 'MANUAL_IMPORT', $4, 'manual-import')`, [A.id, e.id, old, key]);
    await h.db.query('commit');
    const job = await previewed(hr, PUNCHES, file(PUNCH_HEADER, [`${e.code},${at(MON, '09:00')},IN,${key},`]));
    expect(stateOf(job)).toEqual([['REJECTED', 'DUPLICATE_EVENT']]);
  });

  it('reports a repeated punch under another key instead of storing it: stored already, or earlier in the same file', async () => {
    const e = await activeEmployee();
    const first = await previewed(hr, PUNCHES, file(PUNCH_HEADER, [
      `${e.code},${at(MON, '09:00')},IN,${uniq('evt-')},`,
      `${e.code},${at(MON, '09:00')},IN,${uniq('evt-')},`,
      `${e.code},${at(MON, '09:00')},OUT,${uniq('evt-')},`,
    ]));
    // The same instant the other way is a different event; pairing it is the evaluator's business.
    expect(stateOf(first)).toEqual([['VALID', null], ['REJECTED', 'REPEATED_PUNCH'], ['VALID', null]]);
    await commit(hr, PUNCHES, first.id);
    const second = await previewed(hr, PUNCHES, file(PUNCH_HEADER, [`${e.code},${at(MON, '09:00')},IN,${uniq('evt-')},`]));
    expect(stateOf(second)).toEqual([['REJECTED', 'REPEATED_PUNCH']]);
    await commit(hr, PUNCHES, second.id);
    expect(await punchesOf(e.id)).toHaveLength(2);
  });

  it('stores a repeat arriving from another source and flags it; pairing is left as it is until FR-020 is approved', async () => {
    const e = await activeEmployee();
    const job = await previewed(hr, PUNCHES, file(PUNCH_HEADER, [`${e.code},${at(MON, '09:00')},IN,${uniq('evt-')},DEV-1`]));
    await commit(hr, PUNCHES, job.id);
    const other = await previewed(hr, PUNCHES, file(PUNCH_HEADER, [`${e.code},${at(MON, '09:00')},IN,${uniq('evt-')},DEV-2`]));
    expect(other.rows[0]).toMatchObject({ state: 'VALID', errorCode: null, proposedChanges: { repeatOfSource: { from: null, to: 'manual-import:DEV-1' } } });
    expect((await commit(hr, PUNCHES, other.id)).rows[0]).toMatchObject({ state: 'ACCEPTED', proposedChanges: { repeatOfSource: { to: 'manual-import:DEV-1' } } });
    const [original, repeat] = await punchesOf(e.id);
    expect(original!.repeatOfPunchId).toBeNull();
    expect(repeat).toMatchObject({ source: 'manual-import:DEV-2', importJobId: other.id, repeatOfPunchId: expect.any(String) });
  });

  it('two submissions of one punch committed at the same moment store it once', async () => {
    const e = await activeEmployee();
    const line = () => `${e.code},${at(MON, '09:00')},IN,${uniq('evt-')},`;
    const [a, b] = [await previewed(hr, PUNCHES, file(PUNCH_HEADER, [line()])), await previewed(hr, PUNCHES, file(PUNCH_HEADER, [line()]))];
    // This connection holds the import lock, so both commits stand at it together and the race is not left to timing.
    const lockKey = [`attendance:punch-import:${A.id}`];
    await h.db.query(`select pg_advisory_lock(hashtextextended($1, 0))`, lockKey);
    const answers = Promise.all([commit(hr, PUNCHES, a.id), commit(hr, PUNCHES, b.id)]);
    const early = await Promise.race([answers.then(() => 'ANSWERED'), new Promise((resolve) => setTimeout(() => resolve('WAITING'), 500))]);
    await h.db.query(`select pg_advisory_unlock(hashtextextended($1, 0))`, lockKey);
    const [x, y] = await answers;
    expect(early).toBe('WAITING');
    expect([x.acceptedCount, y.acceptedCount].sort()).toEqual([0, 1]);
    expect([x.rows[0]!.errorCode, y.rows[0]!.errorCode].filter(Boolean)).toEqual(['REPEATED_PUNCH']);
    expect(await punchesOf(e.id)).toHaveLength(1);
  });

  it('a row valid in the preview that became a repeat since stays out alone; a row refused in the preview is not revived', async () => {
    const e = await activeEmployee();
    const [late, unknownCode] = [`${e.code},${at(MON, '09:00')},IN,${uniq('evt-')},`, uniq('LATE-').toUpperCase()];
    const job = await previewed(hr, PUNCHES, file(PUNCH_HEADER, [late, `${unknownCode},${at(MON, '09:00')},IN,${uniq('evt-')},`, `${e.code},${at(MON, '18:00')},OUT,${uniq('evt-')},`]));
    expect(stateOf(job)).toEqual([['VALID', null], ['QUARANTINED', 'UNKNOWN_EMPLOYEE'], ['VALID', null]]);
    // Another submission gets there first, and the employee code appears after the preview.
    const first = await previewed(hr, PUNCHES, file(PUNCH_HEADER, [`${e.code},${at(MON, '09:00')},IN,${uniq('evt-')},`]));
    await commit(hr, PUNCHES, first.id);
    const late2 = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { employeeCode: unknownCode }))).json();
    const done = await commit(hr, PUNCHES, job.id);
    expect(stateOf(done)).toEqual([['REJECTED', 'REPEATED_PUNCH'], ['QUARANTINED', 'UNKNOWN_EMPLOYEE'], ['ACCEPTED', null]]);
    expect(await punchesOf(late2.id)).toEqual([]);
  });

  it('a punch later than the submission is invalid', async () => {
    const e = await activeEmployee();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const job = await previewed(hr, PUNCHES, file(PUNCH_HEADER, [`${e.code},${future},IN,${uniq('evt-')},`, `${e.code},${past},IN,${uniq('evt-')},`]));
    expect(stateOf(job)).toEqual([['QUARANTINED', 'FUTURE_TIMESTAMP'], ['VALID', null]]);
  });
});

describe('in/out-time rows (FR-019)', () => {
  it('turns a day into IN and OUT punches in company time; an out time before the in time is the next day (DF05)', async () => {
    const [day, night, only] = [await activeEmployee(), await activeEmployee(), await activeEmployee()];
    const job = await previewed(hr, IN_OUT, file(IN_OUT_HEADER, [`${day.code},${MON},09:00,18:00`, `${night.code},${MON},22:00,06:00`, `${only.code},${MON},09:00,`]));
    expect(job).toMatchObject({ state: 'PREVIEWED', template: 'ATTENDANCE_IN_OUT_V1', rowCount: 3 });
    const done = await commit(hr, IN_OUT, job.id);
    expect(done).toMatchObject({ state: 'COMMITTED', acceptedCount: 3, rejectedCount: 0 });
    expect((await punchesOf(day.id)).map((p) => [p.direction, p.occurredAt, p.importRowNumber])).toEqual([
      ['IN', '2026-03-02T03:30:00.000Z', 1],
      ['OUT', '2026-03-02T12:30:00.000Z', 1],
    ]);
    expect((await punchesOf(night.id)).map((p) => [p.direction, p.occurredAt, p.importJobId])).toEqual([
      ['IN', '2026-03-02T16:30:00.000Z', job.id],
      ['OUT', '2026-03-03T00:30:00.000Z', job.id],
    ]);
    expect((await punchesOf(only.id)).map((p) => p.direction)).toEqual(['IN']);
  });

  it('quarantines a row as a whole: it is never partly accepted (DF09)', async () => {
    const e = await activeEmployee();
    const first = await previewed(hr, IN_OUT, file(IN_OUT_HEADER, [`${e.code},${MON},09:00,`]));
    await commit(hr, IN_OUT, first.id);
    // The IN time differs from the day's stored IN, so the new OUT beside it is not stored either.
    const conflict = await previewed(hr, IN_OUT, file(IN_OUT_HEADER, [`${e.code},${MON},09:30,18:00`]));
    expect(stateOf(conflict)).toEqual([['QUARANTINED', 'CONFLICTING_DUPLICATE_KEY']]);
    await commit(hr, IN_OUT, conflict.id);
    expect((await punchesOf(e.id)).map((p) => p.direction)).toEqual(['IN']);

    // The day's IN unchanged and its OUT added: one new event from the row.
    const completed = await previewed(hr, IN_OUT, file(IN_OUT_HEADER, [`${e.code},${MON},09:00,18:00`]));
    expect(stateOf(completed)).toEqual([['VALID', null]]);
    await commit(hr, IN_OUT, completed.id);
    expect((await punchesOf(e.id)).map((p) => p.direction)).toEqual(['IN', 'OUT']);

    // Replaying the whole file again adds nothing.
    const replay = await previewed(hr, IN_OUT, file(IN_OUT_HEADER, [`${e.code},${MON},09:00,18:00`]));
    expect(stateOf(replay)).toEqual([['REJECTED', 'DUPLICATE_EVENT']]);
  });

  it('reports dates, times and employees it cannot use', async () => {
    const e = await activeEmployee();
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const job = await previewed(hr, IN_OUT, file(IN_OUT_HEADER, [
      `${e.code},2026-02-30,09:00,18:00`,
      `${e.code},${MON},,`,
      `${e.code},${MON},9am,18:00`,
      `${e.code},${MON},25:00,18:00`,
      `${e.code},${MON},09:00,09:00`,
      `${e.code},${future},09:00,18:00`,
      `NOPE-404,${MON},09:00,18:00`,
    ]));
    expect(stateOf(job)).toEqual([
      ['QUARANTINED', 'INVALID_DATE'],
      ['QUARANTINED', 'MISSING_TIMES'],
      ['QUARANTINED', 'INVALID_TIME'],
      ['QUARANTINED', 'INVALID_TIME'],
      ['QUARANTINED', 'ZERO_DURATION'],
      ['QUARANTINED', 'FUTURE_TIMESTAMP'],
      ['QUARANTINED', 'UNKNOWN_EMPLOYEE'],
    ]);
  });

  it('a local time a daylight-saving change makes ambiguous is quarantined, not guessed (DF09)', async () => {
    const e = await activeEmployee();
    await h.db.query(`update company set business_timezone = 'America/New_York' where id = $1`, [A.id]);
    try {
      // 2026-03-08 02:30 does not exist in New York; 2026-11-01 01:30 happens twice.
      const job = await previewed(hr, IN_OUT, file(IN_OUT_HEADER, [`${e.code},2026-03-08,02:30,`, `${e.code},2026-11-01,01:30,`, `${e.code},2026-03-09,09:00,`]));
      expect(stateOf(job)).toEqual([['QUARANTINED', 'AMBIGUOUS_LOCAL_TIME'], ['QUARANTINED', 'AMBIGUOUS_LOCAL_TIME'], ['VALID', null]]);
    } finally {
      await h.db.query(`update company set business_timezone = 'Asia/Kolkata' where id = $1`, [A.id]);
    }
  });
});

describe('the JSON submission stays as it was, and is tracked (FR-019)', () => {
  it('answers its counts, stores a file and traces its punches to the job', async () => {
    const e = await activeEmployee();
    const key = uniq('evt-');
    const res = await h.call(hr, 'POST', '/v1/attendance/punches', {
      punches: [
        { employeeCode: e.code, occurredAt: at(MON, '09:00'), direction: 'IN', externalEventKey: key },
        { employeeCode: e.code, occurredAt: at(MON, '09:00'), direction: 'IN', externalEventKey: key },
        { employeeCode: e.code, occurredAt: at(MON, '09:00'), direction: 'IN', externalEventKey: uniq('evt-') },
        { employeeCode: 'NOPE-404', occurredAt: at(MON, '09:00'), direction: 'IN', externalEventKey: uniq('evt-') },
        { employeeCode: e.code, occurredAt: at(MON, '18:00'), direction: 'OUT', externalEventKey: uniq('evt-'), sourceIdentity: 'DEV-1' },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ received: 5, accepted: 2, duplicates: 1 });
    expect(body.rejected).toEqual([{ index: 2, code: 'REPEATED_PUNCH' }, { index: 3, code: 'UNKNOWN_EMPLOYEE' }]);
    expect((await punchesOf(e.id)).map((p) => [p.importJobId, p.importRowNumber, p.source])).toEqual([
      [body.jobId, 1, 'manual-import'],
      [body.jobId, 5, 'manual-import:DEV-1'],
    ]);
    const job = (await h.call(hr, 'GET', `${PUNCHES}/${body.jobId}`)).json() as Job;
    expect(job).toMatchObject({ state: 'COMMITTED', template: 'ATTENDANCE_PUNCH_V1', acceptedCount: 2, rejectedCount: 3 });
    expect((await h.call(hr, 'GET', `${PUNCHES}/${body.jobId}/error-report`)).body).toContain('NOPE-404');
  });

  it('a repeat under the same idempotency key answers the same job', async () => {
    const e = await activeEmployee();
    const payload = { idempotencyKey: uniq('json-key-'), punches: [{ employeeCode: e.code, occurredAt: at(TUE, '09:00'), direction: 'IN', externalEventKey: uniq('evt-') }] };
    const first = (await h.call(hr, 'POST', '/v1/attendance/punches', payload)).json();
    const second = (await h.call(hr, 'POST', '/v1/attendance/punches', payload)).json();
    expect(second).toEqual(first);
    expect(await punchesOf(e.id)).toHaveLength(1);
  });

  it('holds a submission while the scanner cannot judge it', async () => {
    const e = await activeEmployee();
    const grant = (await resolveAccess(h.pool, { userId: hr.user, companyId: A.id, assignmentId: hr.assignment, resource: 'attendance', action: 'import', fieldGroups: ['operational'] })) as AccessGrant;
    const files = memoryFileStore();
    const text = file(PUNCH_HEADER, [`${e.code},${at(TUE, '09:00')},IN,${uniq('evt-')},`]);
    const held = await submitBatch(h.pool, files, { scan: async () => ({ verdict: 'ERROR' }) }, grant, PUNCH_IMPORT_SPEC, { fileName: 'held.csv', contentBase64: b64(text), idempotencyKey: uniq('held-') });
    expect(held.status).toBe(202);
    await expect(commitBatch(h.pool, files, grant, PUNCH_IMPORT_SPEC, (held.view as unknown as { id: string }).id)).rejects.toMatchObject({ code: 'FILE_NOT_RELEASED' });
    expect(await punchesOf(e.id)).toEqual([]);
  });
});

describe('who may do what (FR-019)', () => {
  it('needs the import duty for uploads and the read duty, in scope, for the punch list', async () => {
    const e = await activeEmployee();
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
    const other = await activeEmployee();
    const text = file(PUNCH_HEADER, [`${e.code},${at(MON, '09:00')},IN,${uniq('evt-')},`]);
    expect((await upload(self, PUNCHES, text)).statusCode).toBe(403);
    expect((await upload(self, IN_OUT, file(IN_OUT_HEADER, [`${e.code},${MON},09:00,18:00`]))).statusCode).toBe(403);
    expect((await h.call(self, 'POST', '/v1/attendance/punches', { punches: [{ employeeCode: e.code, occurredAt: at(MON, '09:00'), direction: 'IN', externalEventKey: uniq('evt-') }] })).statusCode).toBe(403);
    expect((await h.call(self, 'GET', `/v1/employees/${e.id}/punches?from=${MON}&to=${TUE}`)).statusCode).toBe(200);
    expect((await h.call(self, 'GET', `/v1/employees/${other.id}/punches?from=${MON}&to=${TUE}`)).statusCode).toBe(404);
    expect((await h.call(hr, 'GET', `/v1/employees/${e.id}/punches?from=${TUE}&to=${MON}`)).statusCode).toBe(400);
  });
});

followUpSuite({
  path: PUNCHES,
  template: 'ATTENDANCE_PUNCH_V1',
  harness: () => h,
  company: () => A,
  submitter: () => h.actor(A, 'HR_ADMINISTRATOR'),
  denied: async () => [await h.actor(A, 'REPORTING_MANAGER'), await h.actor(A, 'AUDITOR')],
  validFile: async () => {
    const e = await activeEmployee();
    return { text: file(PUNCH_HEADER, [`${e.code},${at(MON, '09:00')},IN,${uniq('evt-')},`]), rows: 1 };
  },
});

followUpSuite({
  path: IN_OUT,
  template: 'ATTENDANCE_IN_OUT_V1',
  harness: () => h,
  company: () => A,
  submitter: () => h.actor(A, 'HR_ADMINISTRATOR'),
  denied: async () => [await h.actor(A, 'REPORTING_MANAGER'), await h.actor(A, 'AUDITOR')],
  validFile: async () => {
    const e = await activeEmployee();
    return { text: file(IN_OUT_HEADER, [`${e.code},${MON},09:00,18:00`]), rows: 1 };
  },
});
