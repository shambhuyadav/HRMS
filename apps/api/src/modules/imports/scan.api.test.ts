// Malware scanning of batch-import files (FR-106, I-21; DF09). Synthetic data only: the "infected" files are
// synthetic CSV rows carrying the EICAR anti-virus test string, which every scanner treats as a test finding (the
// string is assembled at run time; see storage/scan.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { buildApp } from '../../app.js';
import { devTokenVerifier } from '../../auth/tokens.js';
import { ASSIGNMENT_HEADER, COMPANY_HEADER } from '../../http/context.js';
import { memoryFileStore } from '../../storage/files.js';
import { developmentScanner, EICAR_TEST_STRING, scanPendingAttachments } from '../../storage/scan.js';
import { type Company, type Harness, startHarness, type TestActor, tokenConfig } from '../../test/harness.js';
import { EMPLOYEE_IMPORT_COLUMNS } from '../employee/imports.js';

let h: Harness;
let A: Company;
let hr: TestActor;

const b64 = (s: string) => Buffer.from(s, 'latin1').toString('base64');
const csv = (...rows: string[]) => [EMPLOYEE_IMPORT_COLUMNS.join(','), ...rows].join('\r\n');
const joiner = (code: string, name = 'Synthetic Joiner') => `${code},${name},,2026-03-02,PERMANENT,ENG,HQ,DEV,`;
const employees = async (codes: string[]) => (await h.one<{ n: number }>(`select count(*)::int as n from employee where company_id = $1 and employee_code = any($2)`, [A.id, codes])).n;
const jobByKey = (key: string) => h.db.query(`select id from import_job where company_id = $1 and idempotency_key = $2`, [A.id, key]);

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

describe('import files are scanned before any row is read (FR-106, I-21)', () => {
  it('refuses a flagged file on every import route: no job, nothing read or applied, audited without content', async () => {
    const code = uniq('IMP');
    // A row that would be valid if it were read: the scan must refuse it before parsing.
    const infected = b64(csv(joiner(code, EICAR_TEST_STRING)));
    const routes = ['/v1/employees/imports', '/v1/employees/update-imports', '/v1/shifts/plan-imports', '/v1/appraisal-goal-imports', '/v1/timesheet/allocation-imports', '/v1/timesheet/line-imports'];
    for (const route of routes) {
      const key = uniq('scan-key-');
      const res = await h.call(hr, 'POST', route, { fileName: 'infected.csv', contentBase64: infected, idempotencyKey: key });
      expect(res.statusCode, `${route}: ${res.body}`).toBe(422);
      expect(res.json().error).toBe('FILE_QUARANTINED');
      expect((await jobByKey(key)).rowCount).toBe(0);
    }
    expect(await employees([code])).toBe(0);
    const stored = await h.db.query<{ id: string; scan_state: string; scan_finding: string }>(
      `select id, scan_state, scan_finding from attachment where company_id = $1 and owner_user_id = $2 and file_name = 'infected.csv'`,
      [A.id, hr.user],
    );
    expect(stored.rows).toHaveLength(routes.length);
    expect(stored.rows.every((r) => r.scan_state === 'QUARANTINED' && r.scan_finding === 'EICAR-Test-File')).toBe(true);
    const audits = await h.db.query<{ after: unknown }>(`select after_values as after from audit_event where company_id = $1 and resource_code = 'attachment' and action = 'SCAN_QUARANTINED' and record_key = any($2)`, [
      A.id,
      stored.rows.map((r) => r.id),
    ]);
    expect(audits.rows).toHaveLength(routes.length);
    expect(audits.rows[0]!.after).toMatchObject({ operational: { purpose: 'IMPORT', scanState: 'QUARANTINED', fileName: 'infected.csv' } });
    expect(JSON.stringify(audits.rows)).not.toContain('EICAR-STANDARD');
    // The same key again is scanned again and refused again (no job was recorded).
    const again = await h.call(hr, 'POST', '/v1/employees/imports', { fileName: 'infected.csv', contentBase64: infected, idempotencyKey: uniq('scan-key-') });
    expect(again.json().error).toBe('FILE_QUARANTINED');
  });

  it('a clean file is released, previewed and committed', async () => {
    const code = uniq('IMP');
    const res = await h.call(hr, 'POST', '/v1/employees/imports', { fileName: 'clean.csv', contentBase64: b64(csv(joiner(code))), idempotencyKey: uniq('scan-key-') });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ state: 'PREVIEWED', scanState: 'CLEAN', rowCount: 1 });
    expect(await employees([code])).toBe(0);
    const commit = await h.call(hr, 'POST', `/v1/employees/imports/${res.json().id}/commit`);
    expect(commit.json()).toMatchObject({ state: 'COMMITTED', scanState: 'CLEAN', acceptedCount: 1 });
    expect(await employees([code])).toBe(1);
  });

  it('a file that is not a valid batch is refused and not kept on record', async () => {
    const res = await h.call(hr, 'POST', '/v1/employees/imports', { fileName: 'wrong-header.csv', contentBase64: b64('code,name\r\nX,Y'), idempotencyKey: uniq('scan-key-') });
    expect(res.json().error).toBe('INVALID_HEADER');
    expect((await h.one<{ n: number }>(`select count(*)::int as n from attachment where company_id = $1 and file_name = 'wrong-header.csv'`, [A.id])).n).toBe(0);
  });
});

describe('scanner outage: the job is held, never read or committed until the file is released (FR-106)', () => {
  // A second app on the same database whose scanner always errors; its file store is shared with the scan worker.
  const files = memoryFileStore();
  let outage: ReturnType<typeof buildApp>;
  const send = (method: 'GET' | 'POST', url: string, payload?: object) =>
    outage.inject({ method, url, headers: { authorization: `Bearer ${hr.token}`, [COMPANY_HEADER]: A.id, [ASSIGNMENT_HEADER]: hr.assignment }, ...(payload ? { payload } : {}) });
  const upload = (key: string, content: string) => send('POST', '/v1/employees/imports', { fileName: 'held.csv', contentBase64: b64(content), idempotencyKey: key });

  beforeAll(() => {
    outage = buildApp({ db: h.pool, verifier: devTokenVerifier(tokenConfig), files, scanner: { scan: async () => ({ verdict: 'ERROR' }) } });
  });
  afterAll(async () => {
    await outage?.close();
  });

  it('holds the job unread (202), refuses its commit, and previews and commits it once released', async () => {
    const code = uniq('IMP');
    const key = uniq('scan-key-');
    const held = await upload(key, csv(joiner(code)));
    expect(held.statusCode).toBe(202);
    expect(held.json()).toMatchObject({ state: 'UPLOADED', scanState: 'PENDING_SCAN', rowCount: null, rows: [] });
    const id = held.json().id as string;
    const commit = await send('POST', `/v1/employees/imports/${id}/commit`);
    expect(commit.statusCode).toBe(409);
    expect(commit.json()).toMatchObject({ error: 'FILE_NOT_RELEASED', details: { scanState: 'PENDING_SCAN' } });
    // Repeating the upload while the scanner is still down keeps it held.
    expect((await upload(key, csv(joiner(code)))).statusCode).toBe(202);
    expect(await employees([code])).toBe(0);

    // The scan worker releases it; the same upload again previews it, and only then can it be committed.
    expect((await scanPendingAttachments(h.pool, files, developmentScanner(), A.id)).clean).toBeGreaterThanOrEqual(1);
    const previewed = await upload(key, csv(joiner(code)));
    expect(previewed.statusCode).toBe(200);
    expect(previewed.json()).toMatchObject({ id, state: 'PREVIEWED', scanState: 'CLEAN', rowCount: 1, rows: [{ state: 'VALID' }] });
    expect(await employees([code])).toBe(0);
    expect((await send('POST', `/v1/employees/imports/${id}/commit`)).json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 1 });
    expect(await employees([code])).toBe(1);
    const actions = await h.db.query<{ action: string }>(`select action from audit_event where company_id = $1 and resource_code = 'import_job' and record_key = $2 order by created_at`, [A.id, id]);
    expect(actions.rows.map((r) => r.action)).toEqual(['CREATE', 'PREVIEW', 'COMMIT']);
  });

  it('a held file the worker later quarantines rejects the job without reading a row', async () => {
    const code = uniq('IMP');
    const key = uniq('scan-key-');
    const id = (await upload(key, csv(joiner(code, EICAR_TEST_STRING)))).json().id as string;
    await scanPendingAttachments(h.pool, files, developmentScanner(), A.id);
    expect((await send('POST', `/v1/employees/imports/${id}/commit`)).json()).toMatchObject({ error: 'FILE_NOT_RELEASED', details: { scanState: 'QUARANTINED' } });
    const again = await upload(key, csv(joiner(code, EICAR_TEST_STRING)));
    expect(again.statusCode).toBe(422);
    expect(again.json().error).toBe('FILE_QUARANTINED');
    const job = (await send('GET', `/v1/employees/imports/${id}`)).json();
    expect(job).toMatchObject({ state: 'REJECTED', scanState: 'QUARANTINED', rows: [] });
    expect((await send('POST', `/v1/employees/imports/${id}/commit`)).statusCode).toBe(409);
    expect(await employees([code])).toBe(0);
  });

  it('commit refuses any job whose file is not CLEAN, even one marked previewed', async () => {
    const code = uniq('IMP');
    const id = (await upload(uniq('scan-key-'), csv(joiner(code)))).json().id as string;
    // An inconsistent or pre-scanning job: previewed, but its file was never released.
    await h.db.query(`update import_job set state = 'PREVIEWED' where id = $1`, [id]);
    const commit = await send('POST', `/v1/employees/imports/${id}/commit`);
    expect(commit.statusCode).toBe(409);
    expect(commit.json()).toMatchObject({ error: 'FILE_NOT_RELEASED', details: { scanState: 'PENDING_SCAN' } });
    expect(await employees([code])).toBe(0);
  });

  it('a held job can be cancelled', async () => {
    const id = (await upload(uniq('scan-key-'), csv(joiner(uniq('IMP'))))).json().id as string;
    expect((await send('POST', `/v1/employees/imports/${id}/cancel`)).json()).toMatchObject({ state: 'CANCELLED' });
  });

  it("the submitter's key of one import is refused by another import: never resumed with the other import's rules nor answered empty", async () => {
    const code = uniq('IMP');
    const key = uniq('scan-key-');
    const id = (await upload(key, csv(joiner(code)))).json().id as string;
    await scanPendingAttachments(h.pool, files, developmentScanner(), A.id);
    // The same key on the update import (another template): refused as a key in use; the held onboarding batch is untouched.
    const other = await send('POST', '/v1/employees/update-imports', { fileName: 'other.csv', contentBase64: b64('x'), idempotencyKey: key });
    expect(other.statusCode, other.body).toBe(409);
    expect(other.json().error).toBe('IDEMPOTENCY_KEY_IN_USE');
    expect(other.body).not.toContain(id);
    expect((await send('GET', `/v1/employees/imports/${id}`)).json()).toMatchObject({ state: 'UPLOADED', scanState: 'CLEAN' });
    // It still resumes under its own import and previews its own rows.
    expect((await send('POST', `/v1/employees/imports/${id}/resume`)).json()).toMatchObject({ id, state: 'PREVIEWED', rowCount: 1 });
    // A previewed batch's key on another import is refused too, rather than answered with an empty body.
    const again = await send('POST', '/v1/employees/update-imports', { fileName: 'other.csv', contentBase64: b64('x'), idempotencyKey: key });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error).toBe('IDEMPOTENCY_KEY_IN_USE');
    expect(await employees([code])).toBe(0);
  });
});
