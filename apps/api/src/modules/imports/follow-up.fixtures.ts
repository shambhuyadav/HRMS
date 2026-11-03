// Shared API tests for the follow-up routes every batch import has (imports/routes.ts; DF09; FR-106, I-21), run from
// each import's own test file against its harness (not a test file): the caller's own batches (GET <path>) and resuming
// a batch held for the malware scan (POST <path>/:id/resume). Synthetic data only: each import supplies a synthetic
// valid file; the flagged file carries the EICAR anti-virus test string, assembled at run time (storage/scan.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { buildApp } from '../../app.js';
import { devTokenVerifier } from '../../auth/tokens.js';
import { ASSIGNMENT_HEADER, COMPANY_HEADER } from '../../http/context.js';
import { memoryFileStore } from '../../storage/files.js';
import { developmentScanner, EICAR_TEST_STRING, scanPendingAttachments } from '../../storage/scan.js';
import { type Company, type Harness, type TestActor, tokenConfig } from '../../test/harness.js';

export interface FollowUpCase {
  /** The import's collection route, e.g. /v1/employees/imports. */
  path: string;
  /** Its published template code. */
  template: string;
  harness: () => Harness;
  company: () => Company;
  /** A new actor holding every grant the import's upload and commit require (so it has no batches yet). */
  submitter: () => Promise<TestActor>;
  /** Actors without the import's read grant. */
  denied: () => Promise<TestActor[]>;
  /** A synthetic CSV file (header first) whose every row is valid for a submitter, with its number of data rows. */
  validFile: () => Promise<{ text: string; rows: number }>;
}

/** Exactly the job facts a list item carries: never a row, its key or its proposed changes. */
const LIST_FIELDS = ['acceptedCount', 'createdAt', 'fileName', 'id', 'rejectedCount', 'rowCount', 'scanState', 'state', 'template', 'updatedAt'];

export function followUpSuite(c: FollowUpCase): void {
  describe(`${c.path}: the caller's own batches, and a batch held for the malware scan resumed from its stored file (DF09, FR-106)`, () => {
    // A second app on the same database whose scanner always errors (an outage); its file store is shared with the
    // scan worker run below.
    const files = memoryFileStore();
    let outage: ReturnType<typeof buildApp>;
    let owner: TestActor;
    let peer: TestActor;
    const b64 = (text: string) => Buffer.from(text, 'latin1').toString('base64');
    const send = (a: TestActor, method: 'GET' | 'POST', url: string, payload?: object) =>
      outage.inject({ method, url, headers: { authorization: `Bearer ${a.token}`, [COMPANY_HEADER]: c.company().id, [ASSIGNMENT_HEADER]: a.assignment }, ...(payload ? { payload } : {}) });
    const uploadHeld = (a: TestActor, text: string) => send(a, 'POST', c.path, { fileName: 'held.csv', contentBase64: b64(text), idempotencyKey: uniq('held-key-') });
    const upload = (a: TestActor, fileName: string, text: string) => c.harness().call(a, 'POST', c.path, { fileName, contentBase64: b64(text), idempotencyKey: uniq('list-key-') });
    const list = (a: TestActor, query = '') => c.harness().call(a, 'GET', `${c.path}${query}`);
    const resume = (a: TestActor, id: string) => send(a, 'POST', `${c.path}/${id}/resume`);
    const actions = async (id: string) =>
      (
        await c.harness().db.query<{ action: string }>(`select action from audit_event where company_id = $1 and resource_code = 'import_job' and record_key = $2 order by created_at, id`, [
          c.company().id,
          id,
        ])
      ).rows.map((r) => r.action);
    const releaseHeldFiles = () => scanPendingAttachments(c.harness().pool, files, developmentScanner(), c.company().id);

    beforeAll(async () => {
      outage = buildApp({ db: c.harness().pool, verifier: devTokenVerifier(tokenConfig), files, scanner: { scan: async () => ({ verdict: 'ERROR' }) } });
      owner = await c.submitter();
      peer = await c.submitter();
    });
    afterAll(async () => {
      await outage?.close();
    });

    it('lists only the caller’s own batches, newest first and paged, job facts only; a role without the read grant is refused', async () => {
      const submitted: string[] = [];
      let firstCell = '';
      for (const name of ['list-1.csv', 'list-2.csv']) {
        const file = await c.validFile();
        firstCell = file.text.split(/\r?\n/)[1]!.split(',')[0]!;
        const res = await upload(owner, name, file.text);
        expect(res.statusCode, res.body).toBe(201);
        submitted.push(res.json().id);
      }
      const theirs = await upload(peer, 'theirs.csv', (await c.validFile()).text);
      expect(theirs.statusCode, theirs.body).toBe(201);

      const page = await list(owner);
      expect(page.statusCode, page.body).toBe(200);
      expect(page.json()).toMatchObject({ total: 2, page: 1, pageSize: 25 });
      expect(page.json().items.map((j: { id: string }) => j.id)).toEqual([...submitted].reverse());
      expect(page.json().items[0]).toMatchObject({ state: 'PREVIEWED', template: c.template, fileName: 'list-2.csv', scanState: 'CLEAN', acceptedCount: 0, rejectedCount: 0 });
      expect(Object.keys(page.json().items[0]).sort()).toEqual(LIST_FIELDS);
      // No row content is listed, nor anyone else's batch.
      expect(page.body).not.toContain(firstCell);
      expect(page.body).not.toContain(theirs.json().id);
      expect((await list(peer)).json().items.map((j: { id: string }) => j.id)).toEqual([theirs.json().id]);

      expect((await list(owner, '?state=PREVIEWED&page=2')).json()).toMatchObject({ items: [], total: 2, page: 2, pageSize: 25 });
      expect((await list(owner, '?state=COMMITTED&pageSize=50')).json()).toMatchObject({ items: [], total: 0, pageSize: 50 });
      expect((await list(owner, '?pageSize=10')).statusCode).toBe(400);
      expect((await list(owner, '?state=DELETED')).statusCode).toBe(400);
      for (const a of await c.denied()) expect((await list(a)).statusCode).toBe(403);
    });

    it('resumes a held batch once the scan releases its file (idempotently), and refuses one the scan quarantines', async () => {
      const file = await c.validFile();
      const held = await uploadHeld(owner, file.text);
      expect(held.statusCode, held.body).toBe(202);
      const id = held.json().id as string;
      const listed = ((await list(owner, '?state=UPLOADED')).json().items as Record<string, unknown>[]).find((j) => j.id === id);
      expect(listed).toMatchObject({ state: 'UPLOADED', scanState: 'PENDING_SCAN', rowCount: null, fileName: 'held.csv' });

      // Only its submitter, with the upload grants, resumes it; while the scanner is still down it stays held, unread.
      expect((await resume(peer, id)).statusCode).toBe(404);
      for (const a of await c.denied()) expect((await resume(a, id)).statusCode).toBe(403);
      const still = await resume(owner, id);
      expect(still.statusCode).toBe(202);
      expect(still.json()).toMatchObject({ id, state: 'UPLOADED', scanState: 'PENDING_SCAN', rowCount: null, rows: [] });

      // The scan worker releases the file: resuming previews it without a second upload; again returns the same preview.
      await releaseHeldFiles();
      const previewed = await resume(owner, id);
      expect(previewed.statusCode, previewed.body).toBe(200);
      expect(previewed.json()).toMatchObject({ id, state: 'PREVIEWED', scanState: 'CLEAN', template: c.template, rowCount: file.rows });
      expect((previewed.json().rows as { state: string }[]).map((r) => r.state)).toEqual(Array.from({ length: file.rows }, () => 'VALID'));
      const again = await resume(owner, id);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual(previewed.json());
      expect(await actions(id)).toEqual(['CREATE', 'PREVIEW']);
      // It is then an ordinary previewed batch; a closed batch is returned as it stands, never resumed.
      expect((await send(owner, 'POST', `${c.path}/${id}/cancel`)).json()).toMatchObject({ state: 'CANCELLED' });
      expect((await resume(owner, id)).json()).toMatchObject({ id, state: 'CANCELLED' });

      // A held file the scan then flags: resuming refuses it and closes the batch without reading a row.
      const header = file.text.split(/\r?\n/)[0]!;
      const flagged = await uploadHeld(owner, `${header}\r\n${EICAR_TEST_STRING}`);
      expect(flagged.statusCode, flagged.body).toBe(202);
      const flaggedId = flagged.json().id as string;
      await releaseHeldFiles();
      const refused = await resume(owner, flaggedId);
      expect(refused.statusCode).toBe(422);
      expect(refused.json().error).toBe('FILE_QUARANTINED');
      expect(((await list(owner)).json().items as Record<string, unknown>[]).find((j) => j.id === flaggedId)).toMatchObject({ state: 'REJECTED', scanState: 'QUARANTINED', rowCount: null });
      const closed = await resume(owner, flaggedId);
      expect(closed.statusCode).toBe(200);
      expect(closed.json()).toMatchObject({ id: flaggedId, state: 'REJECTED', scanState: 'QUARANTINED', rows: [] });
      expect(await actions(flaggedId)).toEqual(['CREATE', 'SCAN_QUARANTINED']);
    });

    it('serves the published template: exactly the header the upload accepts and no rows, under the upload grants (DF09)', async () => {
      const template = (a: TestActor) => c.harness().call(a, 'GET', `${c.path}/template`);
      const res = await template(owner);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(`attachment; filename="${c.template}.csv"`);
      expect(res.headers['cache-control']).toBe('no-store');
      // One header line and nothing else.
      const lines = res.body.split('\r\n');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toBe('');
      const file = await c.validFile();
      const [header, ...data] = file.text.split(/\r?\n/);
      expect(lines[0]).toBe(header);
      // Round trip: the downloaded file filled in with valid synthetic rows passes the upload's validation.
      const filled = await upload(owner, 'from-template.csv', `${res.body}${data.join('\r\n')}`);
      expect(filled.statusCode, filled.body).toBe(201);
      expect(filled.json()).toMatchObject({ state: 'PREVIEWED', template: c.template, rowCount: file.rows });
      expect((filled.json().rows as { state: string }[]).every((r) => r.state === 'VALID')).toBe(true);
      expect((await c.harness().call(owner, 'POST', `${c.path}/${filled.json().id}/cancel`)).json()).toMatchObject({ state: 'CANCELLED' });
      // The template alone holds no row to import.
      expect((await upload(owner, 'template-only.csv', res.body)).json().error).toBe('EMPTY_FILE');
      for (const a of await c.denied()) expect((await template(a)).statusCode).toBe(403);
    });
  });
}
