// FR-064 import lifecycle (BRD line 1139), BR-027 import and message actions (BRD line 1797) and the import half of FR-063 (BRD line
// 1127), proved on the employee import, which DF09 makes all-or-nothing. Expected counts and reasons are worked from the file each test
// sends. Synthetic CSV rows only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { EMPLOYEE_IMPORT_COLUMNS } from '../employee/imports.js';

let h: Harness;
let A: Company;
let hr: TestActor;

const PATH = '/v1/employees/imports';
const b64 = (text: string) => Buffer.from(text).toString('base64');
const csv = (...rows: string[]) => [EMPLOYEE_IMPORT_COLUMNS.join(','), ...rows].join('\r\n');
const row = (code: string, department = 'ENG') => `${code},Synthetic Joiner,,2026-03-02,PERMANENT,${department},HQ,DEV,`;
const upload = (file: string, key = uniq('life-key-')) => h.call(hr, 'POST', PATH, { fileName: 'joiners.csv', contentBase64: b64(file), idempotencyKey: key });
const employeesNamed = async (codes: string[]) => (await h.one<{ n: number }>(`select count(*)::int as n from employee where company_id = $1 and employee_code = any($2)`, [A.id, codes])).n;
const createAudits = async (codes: string[]) =>
  (await h.one<{ n: number }>(`select count(*)::int as n from audit_event where resource_code = 'employee' and action = 'CREATE' and record_key in (select id from employee where company_id = $1 and employee_code = any($2))`, [A.id, codes])).n;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

describe('import lifecycle (FR-064, DF09)', () => {
  it('FR-064: the user can read accepted and rejected counts and each row’s reason, and they add up to the file', async () => {
    const [good1, unknown, good2] = [uniq('LIFE'), uniq('LIFE'), uniq('LIFE')];
    const uploaded = await upload(csv(row(good1), row(unknown, 'NOPE'), row(good2)));
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const id = uploaded.json().id as string;
    // Read back by its reference: three rows in the file; one has an error and DF09 rejects the whole batch, naming each row's reason.
    const job = (await h.call(hr, 'GET', `${PATH}/${id}`)).json();
    expect(job).toMatchObject({ id, fileName: 'joiners.csv', state: 'REJECTED', rowCount: 3, acceptedCount: 0, rejectedCount: 3 });
    expect(job.rows.map((r: { rowNumber: number; businessKey: string; state: string; errorCode: string }) => [r.rowNumber, r.businessKey, r.state, r.errorCode])).toEqual([
      [1, good1, 'REJECTED', 'BATCH_REJECTED'],
      [2, unknown, 'REJECTED', 'UNKNOWN_DEPARTMENT'],
      [3, good2, 'REJECTED', 'BATCH_REJECTED'],
    ]);
    // No silent partial processing: nothing was applied, and a rejected batch cannot be committed.
    expect(await employeesNamed([good1, unknown, good2])).toBe(0);
    expect((await h.call(hr, 'POST', `${PATH}/${id}/commit`)).statusCode).toBe(409);
    // A clean batch reports what it applied the same way.
    const [ok1, ok2] = [uniq('LIFE'), uniq('LIFE')];
    const clean = (await upload(csv(row(ok1), row(ok2)))).json();
    const committed = (await h.call(hr, 'POST', `${PATH}/${clean.id}/commit`)).json();
    expect(committed).toMatchObject({ state: 'COMMITTED', rowCount: 2, acceptedCount: 2, rejectedCount: 0 });
    expect(committed.acceptedCount + committed.rejectedCount).toBe(committed.rowCount);
    expect(await employeesNamed([ok1, ok2])).toBe(2);
  });

  it('FR-064: cancelling before commit creates no business record, and a cancelled batch cannot be committed', async () => {
    const codes = [uniq('LIFE'), uniq('LIFE')];
    const job = (await upload(csv(...codes.map((c) => row(c))))).json();
    expect(job).toMatchObject({ state: 'PREVIEWED', rowCount: 2 });
    expect(await employeesNamed(codes)).toBe(0);
    expect((await h.call(hr, 'POST', `${PATH}/${job.id}/cancel`)).json().state).toBe('CANCELLED');
    expect(await employeesNamed(codes)).toBe(0);
    expect((await h.call(hr, 'POST', `${PATH}/${job.id}/commit`)).statusCode).toBe(409);
    expect(await employeesNamed(codes)).toBe(0);
    expect(await createAudits(codes)).toBe(0);
  });

  it('FR-064: a repeated commit cannot double apply, one after the other or at the same moment', async () => {
    const codes = [uniq('LIFE'), uniq('LIFE')];
    const job = (await upload(csv(...codes.map((c) => row(c))))).json();
    const commit = () => h.call(hr, 'POST', `${PATH}/${job.id}/commit`);
    const [first, second] = await Promise.all([commit(), commit()]);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    const third = await commit();
    for (const res of [first, second, third]) expect(res.json()).toMatchObject({ id: job.id, state: 'COMMITTED', acceptedCount: 2, rejectedCount: 0 });
    expect(await employeesNamed(codes)).toBe(2);
    expect(await createAudits(codes)).toBe(2);
    // A commit that has applied is not undone by a cancellation afterwards.
    expect((await h.call(hr, 'POST', `${PATH}/${job.id}/cancel`)).statusCode).toBe(409);
    expect(await employeesNamed(codes)).toBe(2);
  });
});

describe('retried import requests (FR-063)', () => {
  it('FR-063 (import half): a retried upload returns the original job and creates no second one or business record', async () => {
    const code = uniq('LIFE');
    const file = csv(row(code));
    const key = uniq('life-key-');
    const first = await upload(file, key);
    expect(first.statusCode, first.body).toBe(201);
    const again = await upload(file, key);
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.json().id);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from import_job where company_id = $1 and idempotency_key = $2`, [A.id, key])).n).toBe(1);
    expect(await employeesNamed([code])).toBe(0);
    // The same key after the commit still answers the job, applied once.
    await h.call(hr, 'POST', `${PATH}/${first.json().id}/commit`);
    const late = await upload(file, key);
    expect(late.json()).toMatchObject({ id: first.json().id, state: 'COMMITTED', acceptedCount: 1 });
    expect(await employeesNamed([code])).toBe(1);
  });
});

describe('import and message actions (BR-027)', () => {
  it('BR-027 (the owner’s confirmation itself is not a test): a mandatory template: a file with any other header is refused whole, and the published template is the header the upload checks', async () => {
    const template = await h.call(hr, 'GET', `${PATH}/template`);
    expect(template.statusCode, template.body).toBe(200);
    expect(template.body.trim()).toBe(EMPLOYEE_IMPORT_COLUMNS.join(','));
    const code = uniq('LIFE');
    const extraColumn = `${EMPLOYEE_IMPORT_COLUMNS.join(',')},dateOfBirth\r\n${row(code)},1990-01-01`;
    const missingColumn = `${EMPLOYEE_IMPORT_COLUMNS.slice(1).join(',')}\r\nSynthetic Joiner,,2026-03-02,PERMANENT,ENG,HQ,DEV,`;
    for (const bad of [extraColumn, missingColumn]) {
      const res = await upload(bad);
      expect([res.statusCode, res.json().error]).toEqual([422, 'INVALID_HEADER']);
    }
    expect(await employeesNamed([code])).toBe(0);
  });

  it('BR-027: a rejected row takes its whole batch with it: this import never partly accepts', async () => {
    const [good, bad] = [uniq('LIFE'), uniq('LIFE')];
    const job = (await upload(csv(row(good), `${bad},Synthetic Joiner,,2026-02-30,PERMANENT,ENG,HQ,DEV,`))).json();
    expect(job).toMatchObject({ state: 'REJECTED', acceptedCount: 0, rejectedCount: 2 });
    expect(job.rows.map((r: { errorCode: string }) => r.errorCode)).toEqual(['BATCH_REJECTED', 'INVALID_JOINING_DATE']);
    expect(await employeesNamed([good, bad])).toBe(0);
  });

  it('BR-027: no recipient rule is confirmed, so sending stays disabled: the send action refuses and tells nobody', async () => {
    const letters = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['letter.read.letter'] });
    const before = await h.one<{ outbox: number; notifications: number }>(
      `select (select count(*)::int from outbox_event where company_id = $1) as outbox, (select count(*)::int from notification where company_id = $1) as notifications`,
      [A.id],
    );
    const res = await h.call(letters, 'POST', '/v1/letter-outputs/00000000-0000-4000-8000-000000000123/send');
    expect([res.statusCode, res.json().error]).toEqual([422, 'SENDING_NOT_AVAILABLE']);
    expect(
      await h.one<{ outbox: number; notifications: number }>(`select (select count(*)::int from outbox_event where company_id = $1) as outbox, (select count(*)::int from notification where company_id = $1) as notifications`, [A.id]),
    ).toEqual(before);
    // Without the letter grant the action is not even reached.
    expect((await h.call(hr, 'POST', '/v1/letter-outputs/00000000-0000-4000-8000-000000000123/send')).statusCode).toBe(403);
  });
});
