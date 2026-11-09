// FR-013 "Search CV metadata and approved searchable content", with its consent/retention status and FR-106 released files, as
// decided under owner delegation, 6 Nov 2026 (docs/03 I-82 item 4; migration 0192): only text an eligible Admin approved for a
// released CV of a consenting candidate is searchable; nothing on upload; no extraction component is configured (plug point
// only); the search never returns the text. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { EICAR_TEST_STRING } from '../../storage/scan.js';
import { isModuleActive } from '../registry.js';
import { registerCvTextExtractor } from './cv-text.js';
import { addDays, PDF } from './test-fixtures.js';

describe.runIf(isModuleActive('hiring'))('hiring: approved searchable CV content (I-82 item 4)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let recruiter: TestActor;
  let hrDocs: TestActor;
  let hrRead: TestActor;
  let bDocs: TestActor;
  let today: string;

  const SECRET = 'Zyxquorbian';
  const candidate = async (fullName: string, consentStatus = 'GIVEN') => {
    const res = await h.call(recruiter, 'POST', '/v1/hiring/candidates', { fullName, sourceCode: 'DIRECT', consentStatus, ...(consentStatus === 'NOT_RECORDED' ? {} : { consentRecordedOn: today }) });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; candidateCode: string; version: number };
  };
  const upload = async (candidateId: string, documentType = 'CV', bytes = PDF) => {
    const res = await h.call(hrDocs, 'POST', `/v1/hiring/candidates/${candidateId}/documents`, { documentType, fileName: 'synthetic-cv.pdf', contentBase64: bytes.toString('base64') });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; scanState: string };
  };
  const approve = (a: TestActor, documentId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/hiring/candidate-documents/${documentId}/searchable-text`, body);
  const search = async (a: TestActor, q: string) => {
    const res = await h.call(a, 'GET', `/v1/hiring/candidate-documents?search=${encodeURIComponent(q)}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { items: { id: string; contentMatch: boolean }[] };
  };
  const patchCandidate = async (id: string, body: Record<string, unknown>) => {
    const current = (await h.call(recruiter, 'GET', `/v1/hiring/candidates/${id}`)).json();
    const res = await h.call(recruiter, 'PATCH', `/v1/hiring/candidates/${id}`, { ...body, expectedVersion: current.version });
    expect(res.statusCode, res.body).toBe(200);
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    recruiter = await h.actor(A, 'RECRUITER');
    hrDocs = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['candidate.read.document', 'candidate.upload.document'] });
    hrRead = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['candidate.read.document'] });
    bDocs = await h.actor(B, 'HR_ADMINISTRATOR', { extra: ['candidate.read.document', 'candidate.upload.document'] });
    today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('FR-013: nothing is searchable on upload; the search matches approved text only and never returns it', async () => {
    const c = await candidate('Synthetic Search Candidate');
    const cv = await upload(c.id);
    expect(cv.scanState).toBe('CLEAN');
    expect((await search(hrRead, SECRET)).items).toEqual([]);
    const approved = await approve(hrDocs, cv.id, { content: `Synthetic CV\r\nSkills: ${SECRET} pipelines, Kotlin\u0007` });
    expect(approved.statusCode, approved.body).toBe(201);
    expect(approved.json()).toMatchObject({ candidateDocumentId: cv.id, source: 'TRANSCRIBED', state: 'APPROVED', replacedCvTextId: null });
    const hits = await search(hrRead, `${SECRET.toLowerCase()} kotlin`);
    expect(hits.items).toEqual([expect.objectContaining({ id: cv.id, contentMatch: true })]);
    expect(JSON.stringify(hits)).not.toMatch(new RegExp(SECRET, 'i'));
    // Metadata search still works and says it did not match in the text.
    expect((await search(hrRead, c.candidateCode)).items).toEqual([expect.objectContaining({ id: cv.id, contentMatch: false })]);
    // The text is read under the grant that reads the CV itself, normalised (line breaks, no control characters).
    const text = (await h.call(hrRead, 'GET', `/v1/hiring/candidate-documents/${cv.id}/searchable-text`)).json();
    expect(text).toMatchObject({ searchable: true, approved: { source: 'TRANSCRIBED', content: `Synthetic CV\nSkills: ${SECRET} pipelines, Kotlin`, approvedBy: hrDocs.user } });
  });

  it('FR-013 decision: approval needs a released CV-type file of a consenting candidate and the confidential upload grant', async () => {
    const noConsent = await candidate('Synthetic Unconsented', 'NOT_RECORDED');
    const cv = await upload(noConsent.id);
    expect((await approve(hrDocs, cv.id, { content: 'Synthetic text' })).json()).toMatchObject({ error: 'CONSENT_REQUIRED', details: { consentStatus: 'NOT_RECORDED' } });
    const c = await candidate('Synthetic Consented');
    const other = await upload(c.id, 'OTHER');
    expect((await approve(hrDocs, other.id, { content: 'Synthetic text' })).json().error).toBe('NOT_A_CV');
    const flagged = await upload(c.id, 'CV', Buffer.concat([PDF, Buffer.from(EICAR_TEST_STRING, 'latin1')]));
    expect(flagged.scanState).toBe('QUARANTINED');
    expect((await approve(hrDocs, flagged.id, { content: 'Synthetic text' })).json().error).toBe('FILE_NOT_RELEASED');
    const good = await upload(c.id);
    expect((await approve(hrRead, good.id, { content: 'Synthetic text' })).statusCode).toBe(403);
    expect((await approve(recruiter, good.id, { content: 'Synthetic text' })).statusCode).toBe(403);
    expect((await h.call(recruiter, 'GET', `/v1/hiring/candidate-documents/${good.id}/searchable-text`)).statusCode).toBe(403);
    expect((await approve(bDocs, good.id, { content: 'Synthetic text' })).statusCode).toBe(404);
    expect((await approve(hrDocs, good.id, { content: ' \u0001 ' })).json().error).toBe('NO_TEXT');
  });

  it('FR-013 consent/retention status: withdrawn consent or a passed retention date takes the content out of search, without deleting it', async () => {
    const c = await candidate('Synthetic Withdrawing Candidate');
    const cv = await upload(c.id);
    expect((await approve(hrDocs, cv.id, { content: 'Synthetic Quillwort engineer' })).statusCode).toBe(201);
    expect((await search(hrRead, 'quillwort')).items).toHaveLength(1);
    await patchCandidate(c.id, { consentStatus: 'WITHDRAWN', consentRecordedOn: today });
    expect((await search(hrRead, 'quillwort')).items).toEqual([]);
    expect((await h.call(hrRead, 'GET', `/v1/hiring/candidate-documents/${cv.id}/searchable-text`)).json()).toMatchObject({ searchable: false, consentStatus: 'WITHDRAWN', approved: { content: 'Synthetic Quillwort engineer' } });
    const kept = await candidate('Synthetic Retained Candidate');
    const keptCv = await upload(kept.id);
    expect((await approve(hrDocs, keptCv.id, { content: 'Synthetic Brackenfold analyst' })).statusCode).toBe(201);
    await patchCandidate(kept.id, { retainUntil: addDays(today, -1) });
    expect((await search(hrRead, 'brackenfold')).items).toEqual([]);
    await patchCandidate(kept.id, { retainUntil: today });
    expect((await search(hrRead, 'brackenfold')).items).toHaveLength(1);
  });

  it('FR-013: no text-extraction component is configured; the plug point uses one only when an approved component is registered', async () => {
    const c = await candidate('Synthetic Extraction Candidate');
    const cv = await upload(c.id);
    expect((await approve(hrDocs, cv.id, {})).json()).toMatchObject({ error: 'EXTRACTION_NOT_CONFIGURED', details: { mediaType: 'application/pdf' } });
    const unregister = registerCvTextExtractor('application/pdf', async (bytes) => `Synthetic extracted ${bytes.length} bytes Marrowlight`);
    try {
      const extracted = await approve(hrDocs, cv.id, {});
      expect(extracted.statusCode, extracted.body).toBe(201);
      expect(extracted.json()).toMatchObject({ source: 'EXTRACTED' });
      expect((await search(hrRead, 'marrowlight')).items).toHaveLength(1);
    } finally {
      unregister();
    }
    expect((await approve(hrDocs, cv.id, {})).json().error).toBe('EXTRACTION_NOT_CONFIGURED');
  });

  it('FR-013: a new approval revokes the previous text; a revocation keeps the row with its reason; approved text is immutable; audit never holds the text', async () => {
    const c = await candidate('Synthetic Revising Candidate');
    const cv = await upload(c.id);
    const first = (await approve(hrDocs, cv.id, { content: 'Synthetic Larchwick first' })).json();
    const second = (await approve(hrDocs, cv.id, { content: 'Synthetic Fernhollow second' })).json();
    expect(second.replacedCvTextId).toBe(first.id);
    expect((await search(hrRead, 'larchwick')).items).toEqual([]);
    expect((await search(hrRead, 'fernhollow')).items).toHaveLength(1);
    const tamper = await h.db.query(`update candidate_cv_text set content = 'changed' where id = $1`, [second.id]).then(() => null, (e: { message: string }) => e.message);
    expect(tamper).toMatch(/immutable/);
    const revoked = await h.call(hrDocs, 'POST', `/v1/hiring/candidate-documents/${cv.id}/searchable-text/revoke`, { reason: 'Synthetic: transcription error' });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await search(hrRead, 'fernhollow')).items).toEqual([]);
    expect((await h.call(hrDocs, 'POST', `/v1/hiring/candidate-documents/${cv.id}/searchable-text/revoke`, { reason: 'again' })).json().error).toBe('NO_APPROVED_TEXT');
    const history = (await h.call(hrRead, 'GET', `/v1/hiring/candidate-documents/${cv.id}/searchable-text`)).json();
    expect(history.approved).toBeNull();
    expect(history.history).toEqual([
      expect.objectContaining({ id: second.id, state: 'REVOKED', revocationReason: 'Synthetic: transcription error' }),
      expect.objectContaining({ id: first.id, state: 'REVOKED', revocationReason: 'Replaced by a newly approved text' }),
    ]);
    const reopen = await h.db.query(`update candidate_cv_text set state = 'APPROVED', revoked_at = null, revoked_by = null, revocation_reason = null where id = $1`, [second.id]).then(() => null, (e: { message: string }) => e.message);
    expect(reopen).toMatch(/stays revoked/);
    const audits = await h.db.query<{ v: string }>(`select coalesce(after_values::text, '') || coalesce(before_values::text, '') as v from audit_event where company_id = $1 and resource_code = 'candidate_cv_text'`, [A.id]);
    expect(audits.rows.length).toBeGreaterThan(0);
    for (const a of audits.rows) expect(a.v).not.toMatch(/Larchwick|Fernhollow|Quillwort|Zyxquorbian/i);
  });
});
