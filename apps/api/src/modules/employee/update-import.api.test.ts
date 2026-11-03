// Bulk employee update import EMPLOYEE_UPDATE_V1 (FR-009; DF09; I-13), with the caller's own batches and resuming one
// held for the malware scan (FR-106). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { followUpSuite } from '../imports/follow-up.fixtures.js';
import { EMPLOYEE_UPDATE_COLUMNS } from './update-import.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let hrEngOnly: TestActor;
let colleague: TestActor;
const people: Record<string, { id: string; code: string }> = {};

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const csv = (...rows: string[]) => [EMPLOYEE_UPDATE_COLUMNS.join(','), ...rows].join('\r\n');
const upload = (a: TestActor, file: string, key = uniq('upd-key-')) => h.call(a, 'POST', '/v1/employees/update-imports', { fileName: 'updates.csv', contentBase64: b64(file), idempotencyKey: key });
type Row = { rowNumber: number; businessKey: string; state: string; errorCode: string | null; proposedChanges: Record<string, { from: string | null; to: string | null }> | null };

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  colleague = await h.actor(A, 'HR_ADMINISTRATOR');
  hrEngOnly = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
  for (const name of ['p1', 'p2', 'p3', 'boss', 'fin']) {
    const code = uniq('UPD').toUpperCase();
    const body = h.newEmployeeBody(A, { employeeCode: code, displayName: `Synthetic ${name}`, ...(name === 'fin' ? { departmentId: A.financeDept } : {}) });
    const e = (await h.call(hr, 'POST', '/v1/employees', body)).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    people[name] = { id: e.id, code };
  }
});

afterAll(async () => {
  await h?.stop();
});

describe('employee update import (FR-009)', () => {
  it('previews each row’s proposed changes, changes nothing until commit, then applies every row', async () => {
    const p1 = people.p1!;
    const p2 = people.p2!;
    const boss = people.boss!;
    const file = csv(`${p1.code},Synthetic Renamed,,,,,,,`, `${p2.code},,,2026-11-01,FIN,,,,${boss.code}`);
    const res = await upload(hr, file);
    expect(res.statusCode).toBe(201);
    const job = res.json() as { id: string; state: string; template: string; rows: Row[] };
    expect(job).toMatchObject({ state: 'PREVIEWED', template: 'EMPLOYEE_UPDATE_V1' });
    expect(job.rows[0]).toMatchObject({ state: 'VALID', proposedChanges: { displayName: { from: 'Synthetic p1', to: 'Synthetic Renamed' } } });
    expect(job.rows[1]!.proposedChanges).toEqual({
      department: { from: 'ENG', to: 'FIN' },
      manager: { from: null, to: boss.code },
      effectiveFrom: { from: null, to: '2026-11-01' },
    });
    // The preview changed nothing.
    expect((await h.one<{ n: string }>(`select display_name as n from employee where id = $1`, [p1.id])).n).toBe('Synthetic p1');
    expect((await h.one<{ n: number }>(`select count(*)::int as n from employment_assignment where employee_id = $1`, [p2.id])).n).toBe(1);

    const committed = (await h.call(hr, 'POST', `/v1/employees/update-imports/${job.id}/commit`)).json();
    expect(committed).toMatchObject({ state: 'COMMITTED', acceptedCount: 2 });
    expect((await h.one<{ n: string }>(`select display_name as n from employee where id = $1`, [p1.id])).n).toBe('Synthetic Renamed');
    const periods = await h.db.query<{ f: string; t: string | null; code: string }>(
      `select to_char(a.effective_from, 'YYYY-MM-DD') as f, to_char(a.effective_to, 'YYYY-MM-DD') as t, d.code from employment_assignment a
         join department d on d.id = a.department_id where a.employee_id = $1 order by a.effective_from`,
      [p2.id],
    );
    expect(periods.rows).toEqual([
      { f: '2026-01-05', t: '2026-11-01', code: 'ENG' },
      { f: '2026-11-01', t: null, code: 'FIN' },
    ]);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from manager_assignment where employee_id = $1 and manager_employee_id = $2`, [p2.id, boss.id])).n).toBe(1);
    // Committing again is an idempotent repeat.
    expect((await h.call(hr, 'POST', `/v1/employees/update-imports/${job.id}/commit`)).json().state).toBe('COMMITTED');
  });

  it('rejects the whole batch for any row error and applies nothing (DF09)', async () => {
    const p3 = people.p3!;
    const file = csv(
      `${p3.code},Should Not Apply,,,,,,,`,
      `NO-SUCH-CODE,Anyone,,,,,,,`,
      `${p3.code},Repeated Row,,,,,,,`,
      `${people.p1!.code},,,,,,,,`,
      `${people.p1!.code.toLowerCase()}x,,,,,,,,`,
      `${people.boss!.code},,,,ZZZ,,,,`,
      `${people.fin!.code},,,2026-11-01,,,,,NO-SUCH-BOSS`,
      `${people.p2!.code},,,,,,,,${people.boss!.code}`,
    );
    const job = (await upload(hr, file)).json() as { id: string; state: string; rows: Row[] };
    expect(job.state).toBe('REJECTED');
    expect(job.rows.map((r) => r.errorCode)).toEqual([
      'BATCH_REJECTED',
      'UNKNOWN_EMPLOYEE',
      'DUPLICATE_IN_BATCH',
      'NO_CHANGE',
      'UNKNOWN_EMPLOYEE',
      'EFFECTIVE_DATE_REQUIRED',
      'UNKNOWN_MANAGER',
      'EFFECTIVE_DATE_REQUIRED',
    ]);
    expect((await h.call(hr, 'POST', `/v1/employees/update-imports/${job.id}/commit`)).statusCode).toBe(409);
    expect((await h.one<{ n: string }>(`select display_name as n from employee where id = $1`, [p3.id])).n).toBe('Synthetic p3');
  });

  it('matches employee and manager codes whatever their case (codes are stored upper-case)', async () => {
    const p3 = people.p3!;
    const job = (await upload(hr, csv(`${p3.code.toLowerCase()},Synthetic Lowercase Match,,2026-12-15,,,,,${people.boss!.code.toLowerCase()}`))).json() as { state: string; rows: Row[] };
    expect(job.state).toBe('PREVIEWED');
    expect(job.rows[0]!.proposedChanges).toMatchObject({ displayName: { to: 'Synthetic Lowercase Match' }, manager: { to: people.boss!.code } });
  });

  it('applies under the caller’s scope: a department-filtered HR user cannot move or rename others (BR-006)', async () => {
    const job = (await upload(hrEngOnly, csv(`${people.fin!.code},Renamed Outside,,,,,,,`, `${people.p3!.code},,,2026-12-01,FIN,,,,`))).json() as { state: string; rows: Row[] };
    expect(job.state).toBe('REJECTED');
    expect(job.rows.map((r) => r.errorCode)).toEqual(['OUT_OF_SCOPE', 'OUT_OF_SCOPE']);
  });

  it('keeps jobs private to the submitter and refuses a header that is not the template', async () => {
    const key = uniq('upd-key-');
    const job = (await upload(hr, csv(`${people.p3!.code},Private Rename,,,,,,,`), key)).json();
    expect((await h.call(colleague, 'GET', `/v1/employees/update-imports/${job.id}`)).statusCode).toBe(404);
    expect((await h.call(colleague, 'POST', `/v1/employees/update-imports/${job.id}/commit`)).statusCode).toBe(404);
    expect((await upload(colleague, csv(`${people.p3!.code},Theirs,,,,,,,`), key)).json().error).toBe('IDEMPOTENCY_KEY_IN_USE');
    expect((await upload(hr, csv(`${people.p3!.code},Private Rename,,,,,,,`), key)).statusCode).toBe(200);
    const wrong = await h.call(hr, 'POST', '/v1/employees/update-imports', { fileName: 'x.csv', contentBase64: b64('employeeCode,displayName\r\nX,Y'), idempotencyKey: uniq('upd-key-') });
    expect(wrong.json().error).toBe('INVALID_HEADER');
    // An employee onboarding job is not visible through the update-import routes.
    expect((await h.call(hr, 'POST', `/v1/employees/update-imports/${job.id}/cancel`)).json().state).toBe('CANCELLED');
  });
});

followUpSuite({
  path: '/v1/employees/update-imports',
  template: 'EMPLOYEE_UPDATE_V1',
  harness: () => h,
  company: () => A,
  submitter: () => h.actor(A, 'HR_ADMINISTRATOR'),
  denied: async () => [await h.actor(A, 'REPORTING_MANAGER'), await h.actor(A, 'AUDITOR')],
  // A new display name each time, so the row always changes something (nothing is committed).
  validFile: async () => ({ text: csv(`${people.p1!.code},Synthetic ${uniq('Rename')},,,,,,,`), rows: 1 }),
});
