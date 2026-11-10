// Candidate register, private contacts, duplicate review, CV documents, applications and the tracker over HTTP
// (FR-013, FR-014; F1 hiring; DF02; DF04; DF08; ZT01/02/03/07). Synthetic data only: example.test addresses, made-up
// names and numbers, a synthetic PDF.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { devTokenVerifier } from '../../auth/tokens.js';
import { ASSIGNMENT_HEADER, COMPANY_HEADER } from '../../http/context.js';
import { memoryFileStore } from '../../storage/files.js';
import { developmentScanner, EICAR_TEST_STRING, scanPendingAttachments } from '../../storage/scan.js';
import { type Company, type Harness, startHarness, type TestActor, tokenConfig } from '../../test/harness.js';
import { resolveAccess } from '../access/authorize.js';
import { isModuleActive } from '../registry.js';
import { HIRING_METRICS, pipelineStageCounts } from './metrics.js';
import { approvedRequisition, type HiringWorld, hiringWorld, PDF } from './test-fixtures.js';

describe.runIf(isModuleActive('hiring'))('hiring: candidates and applications', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let w: HiringWorld;
  let recruiter: TestActor;
  let recruiter2: TestActor;
  let hrConf: TestActor;
  let hrConfFin: TestActor;
  let bHrConf: TestActor;
  let employee: TestActor;
  let r1: { id: string; code: string };
  let r2: { id: string; code: string };
  let one: string;

  const CONFIDENTIAL = ['candidate.read.contact', 'candidate.manage.contact', 'candidate.read.document', 'candidate.upload.document'] as const;
  const candidateBody = (overrides: Record<string, unknown> = {}) => ({
    fullName: 'Synthetic Candidate',
    sourceCode: 'DIRECT',
    skills: ['Kotlin', 'SQL'],
    consentStatus: 'GIVEN',
    consentRecordedOn: w.today,
    retainUntil: null,
    ...overrides,
  });
  const newCandidate = async (overrides: Record<string, unknown> = {}) => {
    const res = await h.call(recruiter, 'POST', '/v1/hiring/candidates', candidateBody(overrides));
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; candidateCode: string; version: number } & Record<string, unknown>;
  };
  const contact = (a: TestActor, id: string, body: Record<string, unknown>) => h.call(a, 'PUT', `/v1/hiring/candidates/${id}/contact`, body);
  const apply = (a: TestActor, requisitionId: string, candidateId: string) => h.call(a, 'POST', `/v1/hiring/requisitions/${requisitionId}/applications`, { candidateId });
  const move = async (a: TestActor, applicationId: string, toStage: string, note?: string) => {
    const current = (await h.call(a, 'GET', `/v1/hiring/applications/${applicationId}`)).json();
    return h.call(a, 'POST', `/v1/hiring/applications/${applicationId}/stage`, { toStage, expectedVersion: current.version, ...(note ? { note } : {}) });
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    w = await hiringWorld(h, A);
    recruiter = await h.actor(A, 'RECRUITER');
    recruiter2 = await h.actor(A, 'RECRUITER');
    hrConf = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...CONFIDENTIAL] });
    hrConfFin = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...CONFIDENTIAL], departmentFilter: A.financeDept });
    bHrConf = await h.actor(B, 'HR_ADMINISTRATOR', { extra: [...CONFIDENTIAL] });
    const emp = (await h.call(w.hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    employee = await h.actor(A, 'EMPLOYEE', { employeeId: emp.id });
    r1 = await approvedRequisition(h, A, w, { title: 'Synthetic backend role' });
    r2 = await approvedRequisition(h, A, w, { title: 'Synthetic data role' });
  });

  afterAll(async () => {
    await h?.stop();
  });

  describe('register and vendors (FR-013)', () => {
    it('registers candidates with source/vendor and consent/retention status', async () => {
      const c = await newCandidate({ fullName: 'Synthetic Candidate One', skills: ['Kotlin', ' kotlin', 'SQL'] });
      one = c.id;
      expect(c).toMatchObject({ candidateCode: expect.stringMatching(/^CAN-\d{6}$/), state: 'ACTIVE', source: { code: 'DIRECT' }, vendor: null, skills: ['Kotlin', 'SQL'], consentStatus: 'GIVEN', contactRecorded: false, applications: [] });
      expect(Object.keys(c)).not.toContain('email');
      const err = async (body: Record<string, unknown>) => (await h.call(recruiter, 'POST', '/v1/hiring/candidates', candidateBody(body))).json().error;
      expect(await err({ sourceCode: 'VENDOR' })).toBe('VENDOR_MISMATCH');
      expect(await err({ sourceCode: 'NOT_A_SOURCE' })).toBe('INVALID_REFERENCE');
      expect(await err({ consentStatus: 'GIVEN', consentRecordedOn: null })).toBe('CONSENT_DATE_MISMATCH');
      expect(await err({ consentStatus: 'NOT_RECORDED', consentRecordedOn: w.today })).toBe('CONSENT_DATE_MISMATCH');
      expect(await err({ consentRecordedOn: '2999-01-01' })).toBe('INVALID_DATE');

      const vendor = await h.call(recruiter, 'POST', '/v1/hiring/vendors', { code: 'synth-agency', name: 'Synthetic Staffing Agency' });
      expect(vendor.json()).toMatchObject({ code: 'SYNTH-AGENCY', active: true });
      const viaVendor = await newCandidate({ fullName: 'Synthetic Vendor Candidate', sourceCode: 'VENDOR', vendorId: vendor.json().id, consentStatus: 'NOT_RECORDED', consentRecordedOn: null });
      expect(viaVendor).toMatchObject({ source: { code: 'VENDOR' }, vendor: { code: 'SYNTH-AGENCY' } });
      expect(await err({ vendorId: vendor.json().id })).toBe('VENDOR_MISMATCH');
      // BR-004: a deactivated vendor blocks new use but keeps its history.
      expect((await h.call(recruiter, 'PATCH', `/v1/hiring/vendors/${vendor.json().id}`, { active: false, expectedVersion: 1 })).json().active).toBe(false);
      expect(await err({ sourceCode: 'VENDOR', vendorId: vendor.json().id })).toBe('INVALID_REFERENCE');
      expect((await h.call(recruiter, 'GET', `/v1/hiring/candidates/${viaVendor.id}`)).json().vendor).toMatchObject({ code: 'SYNTH-AGENCY' });

      // Updates are versioned and audited; search covers the operational metadata.
      const patched = await h.call(recruiter, 'PATCH', `/v1/hiring/candidates/${one}`, { skills: ['Kotlin', 'SQL', 'Kafka'], retainUntil: '2027-12-31', expectedVersion: c.version });
      expect(patched.json()).toMatchObject({ skills: ['Kotlin', 'SQL', 'Kafka'], retainUntil: '2027-12-31' });
      expect((await h.call(recruiter, 'PATCH', `/v1/hiring/candidates/${one}`, { fullName: 'x', expectedVersion: c.version })).json().error).toBe('STALE_VERSION');
      const found = (await h.call(recruiter, 'GET', '/v1/hiring/candidates?search=kafka')).json();
      expect(found.items.map((x: { id: string }) => x.id)).toEqual([one]);
      expect((await h.call(employee, 'GET', '/v1/hiring/candidates')).statusCode).toBe(403);
      expect((await h.call(w.requester, 'GET', '/v1/hiring/candidates')).statusCode).toBe(403);
    });
  });

  describe('private contacts and duplicate review (F1, DF02, FR-013)', () => {
    it('records contacts only through an eligible Admin grant and stores them sealed', async () => {
      expect((await contact(recruiter, one, { email: 'one@example.test' })).statusCode).toBe(403);
      expect((await h.call(recruiter, 'GET', `/v1/hiring/candidates/${one}/contact`)).statusCode).toBe(403);
      expect((await contact(w.hr, one, { email: 'one@example.test' })).statusCode).toBe(403);
      const set = await contact(hrConf, one, { email: '  Synthetic.One@Example.TEST ', phone: '+91 98765-43210' });
      expect(set.statusCode, set.body).toBe(200);
      expect(set.json()).toEqual({ candidateId: one, changedFields: ['email', 'phone'], duplicateFlags: [] });
      expect((await h.call(hrConf, 'GET', `/v1/hiring/candidates/${one}/contact`)).json()).toMatchObject({ email: 'synthetic.one@example.test', phone: '+91 98765-43210' });
      expect((await contact(hrConf, one, { email: 'not-an-email' })).json()).toMatchObject({ error: 'INVALID_FIELD', details: { field: 'email' } });
      expect((await contact(hrConf, one, { phone: '1 2' })).json()).toMatchObject({ error: 'INVALID_FIELD', details: { field: 'phone' } });

      // The operational view says contacts exist, never what they are.
      const operational = (await h.call(recruiter, 'GET', `/v1/hiring/candidates/${one}`)).json();
      expect(operational.contactRecorded).toBe(true);
      expect(JSON.stringify(operational)).not.toMatch(/synthetic\.one|98765/i);
      const stored = await h.one<{ payload: string; email_key: string; phone_key: string }>(`select payload, email_key, phone_key from candidate_contact where candidate_id = $1`, [one]);
      expect(stored.payload.startsWith('v1.')).toBe(true);
      expect(stored.payload).not.toMatch(/synthetic|98765/i);
      expect(stored.email_key).toMatch(/^[0-9a-f]{64}$/);
      // Audit carries field names only; the read is recorded too (FR-057).
      const trail = await h.one<{ t: string }>(`select string_agg(coalesce(before_values::text, '') || after_values::text, ' ') as t from audit_event where record_key = $1`, [one]);
      expect(trail.t).toContain('changedFields');
      expect(trail.t).not.toMatch(/synthetic\.one|98765/i);
      expect(await h.one<{ n: number }>(`select count(*)::int as n from audit_event where record_key = $1 and action = 'READ_CONTACT'`, [one])).toEqual({ n: 1 });
    });

    it('flags likely matches by normalised email or phone for review; never merges', async () => {
      const two = await newCandidate({ fullName: 'Synthetic Candidate Two' });
      const three = await newCandidate({ fullName: 'Synthetic Candidate Three' });
      const byEmail = await contact(hrConf, two.id, { email: 'SYNTHETIC.ONE@example.test' });
      expect(byEmail.json().duplicateFlags).toEqual([expect.objectContaining({ basis: 'EMAIL', state: 'OPEN', candidate: expect.objectContaining({ id: two.id }), matchedCandidate: expect.objectContaining({ id: one }) })]);
      const byPhone = await contact(hrConf, three.id, { phone: '(91) 98765 43210' });
      expect(byPhone.json().duplicateFlags).toEqual([expect.objectContaining({ basis: 'PHONE', matchedCandidate: expect.objectContaining({ id: one }) })]);

      // The recruiter reviews flags in the operational register (codes and basis only).
      const open = (await h.call(recruiter, 'GET', '/v1/hiring/duplicate-flags?state=OPEN')).json().items as { flagId: string; basis: string; candidate: { id: string } }[];
      expect(open).toHaveLength(2);
      expect(JSON.stringify(open)).not.toMatch(/example\.test|98765/i);
      const emailFlag = open.find((f) => f.basis === 'EMAIL')!;
      const phoneFlag = open.find((f) => f.basis === 'PHONE')!;
      expect((await h.call(recruiter, 'POST', `/v1/hiring/duplicate-flags/${emailFlag.flagId}/resolve`, { resolution: 'NOT_DUPLICATE', note: 'Synthetic: shared family mailbox' })).json().state).toBe('NOT_DUPLICATE');
      // A reviewed pair is not flagged again.
      expect((await contact(hrConf, two.id, { email: 'synthetic.one@example.test' })).json().duplicateFlags).toEqual([]);
      expect((await h.call(recruiter, 'POST', `/v1/hiring/duplicate-flags/${emailFlag.flagId}/resolve`, { resolution: 'NOT_DUPLICATE', note: 'again' })).json().error).toBe('INVALID_STATE');
      expect((await h.call(recruiter, 'POST', `/v1/hiring/duplicate-flags/${phoneFlag.flagId}/resolve`, { resolution: 'CONFIRMED_DUPLICATE', note: 'Synthetic: same person' })).json().error).toBe(
        'RETIRE_CANDIDATE_REQUIRED',
      );
      const confirmed = await h.call(recruiter, 'POST', `/v1/hiring/duplicate-flags/${phoneFlag.flagId}/resolve`, { resolution: 'CONFIRMED_DUPLICATE', retireCandidateId: three.id, note: 'Synthetic: same person' });
      expect(confirmed.json()).toMatchObject({ state: 'CONFIRMED_DUPLICATE', retiredCandidateId: three.id });
      // No merge: both records stay; the retired one takes no new applications and stays retired.
      expect((await h.call(recruiter, 'GET', `/v1/hiring/candidates/${three.id}`)).json().state).toBe('DUPLICATE');
      expect((await h.call(recruiter, 'GET', `/v1/hiring/candidates/${one}`)).json().state).toBe('ACTIVE');
      expect((await apply(recruiter, r1.id, three.id)).json().error).toBe('CANDIDATE_NOT_ACTIVE');
      const threeNow = (await h.call(recruiter, 'GET', `/v1/hiring/candidates/${three.id}`)).json();
      expect((await h.call(recruiter, 'PATCH', `/v1/hiring/candidates/${three.id}`, { state: 'ACTIVE', expectedVersion: threeNow.version })).json().error).toBe('INVALID_STATE');
    });

    it('concurrent entries of the same identity raise exactly one flag', async () => {
      const [x, y] = [await newCandidate({ fullName: 'Synthetic Race X' }), await newCandidate({ fullName: 'Synthetic Race Y' })];
      const results = await Promise.all([contact(hrConf, x.id, { email: 'race@example.test' }), contact(hrConf, y.id, { email: 'race@example.test' })]);
      expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
      const flags = await h.one<{ n: number }>(`select count(*)::int as n from candidate_duplicate_flag where candidate_id = any($1::uuid[]) or matched_candidate_id = any($1::uuid[])`, [[x.id, y.id]]);
      expect(flags.n).toBe(1);
    });
  });

  describe('CV documents (FR-013, DF02)', () => {
    it('are confidential: eligible Admin upload, list, search and audited download only', async () => {
      const body = { documentType: 'CV', fileName: 'synthetic-cv.pdf', contentBase64: PDF.toString('base64') };
      expect((await h.call(recruiter, 'POST', `/v1/hiring/candidates/${one}/documents`, body)).statusCode).toBe(403);
      expect((await h.call(w.hr, 'POST', `/v1/hiring/candidates/${one}/documents`, body)).statusCode).toBe(403);
      const up = await h.call(hrConf, 'POST', `/v1/hiring/candidates/${one}/documents`, body);
      expect(up.statusCode, up.body).toBe(201);
      // FR-106: scanned right after storing; the synthetic scanner releases a clean file.
      expect(up.json()).toMatchObject({ mediaType: 'application/pdf', scanState: 'CLEAN' });
      expect(Object.keys(up.json())).not.toContain('attachmentId');
      expect((await h.call(hrConf, 'POST', `/v1/hiring/candidates/${one}/documents`, { ...body, documentType: 'PASSPORT' })).json().error).toBe('INVALID_REFERENCE');
      expect((await h.call(hrConf, 'POST', `/v1/hiring/candidates/${one}/documents`, { ...body, contentBase64: Buffer.from('plain text').toString('base64') })).json().error).toBe('UNSUPPORTED_FILE');
      const list = (await h.call(hrConf, 'GET', `/v1/hiring/candidates/${one}/documents`)).json().items;
      expect(list).toEqual([expect.objectContaining({ id: up.json().id, documentType: 'CV', fileName: 'synthetic-cv.pdf', mediaType: 'application/pdf', scanState: 'CLEAN' })]);
      expect((await h.call(recruiter, 'GET', `/v1/hiring/candidates/${one}/documents`)).statusCode).toBe(403);
      expect((await h.call(hrConf, 'GET', '/v1/hiring/candidate-documents?search=synthetic-cv')).json().items.map((d: { id: string }) => d.id)).toEqual([up.json().id]);
      // A finding quarantines the file for good: it is never served.
      const infected = Buffer.concat([PDF, Buffer.from(EICAR_TEST_STRING, 'latin1')]);
      const bad = await h.call(hrConf, 'POST', `/v1/hiring/candidates/${one}/documents`, { ...body, fileName: 'synthetic-bad.pdf', contentBase64: infected.toString('base64') });
      expect(bad.json().scanState).toBe('QUARANTINED');
      expect((await h.call(hrConf, 'GET', `/v1/hiring/candidate-documents/${bad.json().id}/content`)).json()).toMatchObject({ error: 'FILE_NOT_RELEASED', details: { scanState: 'QUARANTINED' } });
      // Each verdict is recorded against its document (the state only).
      expect(await h.one<{ n: number }>(`select count(*)::int as n from audit_event where record_key = $1 and action = 'SCAN_RELEASED'`, [up.json().id])).toEqual({ n: 1 });
      expect(await h.one<{ n: number }>(`select count(*)::int as n from audit_event where record_key = $1 and action = 'SCAN_QUARANTINED'`, [bad.json().id])).toEqual({ n: 1 });
      const content = await h.call(hrConf, 'GET', `/v1/hiring/candidate-documents/${up.json().id}/content`);
      expect(content.statusCode).toBe(200);
      expect(content.headers['cache-control']).toBe('no-store');
      expect(content.rawPayload.equals(PDF)).toBe(true);
      expect(await h.one<{ n: number }>(`select count(*)::int as n from audit_event where record_key = $1 and action = 'READ_CONTENT'`, [up.json().id])).toEqual({ n: 1 });
      // Another company never reaches the file or the list.
      expect((await h.call(bHrConf, 'GET', `/v1/hiring/candidate-documents/${up.json().id}/content`)).statusCode).toBe(404);
      expect((await h.call(bHrConf, 'GET', `/v1/hiring/candidates/${one}/documents`)).statusCode).toBe(404);
      expect((await h.call(bHrConf, 'GET', `/v1/hiring/candidates/${one}/contact`)).statusCode).toBe(404);
    });

    it('stay pending while the scanner is unavailable and are served only once released (FR-106)', async () => {
      // A second app on the same database whose scanner always errors (e.g. an outage).
      const files = memoryFileStore();
      const outage = buildApp({ db: h.pool, verifier: devTokenVerifier(tokenConfig), files, scanner: { scan: async () => ({ verdict: 'ERROR' }) } });
      const headers = { authorization: `Bearer ${hrConf.token}`, [COMPANY_HEADER]: A.id, [ASSIGNMENT_HEADER]: hrConf.assignment };
      const pdf = Buffer.from('%PDF-1.4\n% synthetic pending curriculum vitae\n%%EOF\n');
      try {
        const res = await outage.inject({
          method: 'POST',
          url: `/v1/hiring/candidates/${one}/documents`,
          headers,
          payload: { documentType: 'CV', fileName: 'synthetic-pending.pdf', contentBase64: pdf.toString('base64') },
        });
        expect(res.statusCode, res.body).toBe(201);
        expect(res.json().scanState).toBe('PENDING_SCAN');
        const id = res.json().id as string;
        expect((await outage.inject({ method: 'GET', url: `/v1/hiring/candidate-documents/${id}/content`, headers })).json()).toMatchObject({
          error: 'FILE_NOT_RELEASED',
          details: { scanState: 'PENDING_SCAN' },
        });
        // The worker's pending-scan run releases it once the scanner answers again.
        expect(await scanPendingAttachments(h.pool, files, developmentScanner(), A.id)).toMatchObject({ clean: 1, stillPending: 0 });
        const content = await outage.inject({ method: 'GET', url: `/v1/hiring/candidate-documents/${id}/content`, headers });
        expect(content.statusCode).toBe(200);
        expect(content.rawPayload.equals(pdf)).toBe(true);
      } finally {
        await outage.close();
      }
    });
  });

  describe('applications and stages (DB062, F1)', () => {
    let appR1: string;
    let appR2: string;

    it('one application per candidate and requisition; only approved requisitions; stages move one at a time', async () => {
      const results = await Promise.all([apply(recruiter, r1.id, one), apply(recruiter2, r1.id, one)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.statusCode === 409)!.json().error).toBe('ALREADY_APPLIED');
      appR1 = results.find((r) => r.statusCode === 201)!.json().id;
      expect(results.find((r) => r.statusCode === 201)!.json()).toMatchObject({ stage: 'APPLIED', pendingAction: 'START_SCREENING', ageingDays: 0, candidate: { id: one }, requisition: { id: r1.id } });
      const draft = (await h.call(w.requester, 'POST', '/v1/hiring/requisitions', {
        title: 'Synthetic unapproved',
        departmentId: A.dept,
        locationId: A.loc,
        designationId: A.desig,
        employmentType: 'PERMANENT',
        vacancies: 1,
        reasonType: 'NEW',
        reason: 'Synthetic',
        targetDate: w.today,
        hiringManagerId: w.requesterEmp,
      })).json();
      expect((await apply(recruiter, draft.id, one)).json().error).toBe('REQUISITION_NOT_APPROVED');

      expect((await move(recruiter, appR1, 'INTERVIEW')).json().error).toBe('INVALID_TRANSITION');
      expect((await move(recruiter, appR1, 'HIRED')).json().error).toBe('HANDOVER_REQUIRED');
      expect((await move(recruiter, appR1, 'REJECTED')).json().error).toBe('NOTE_REQUIRED');
      expect((await move(recruiter, appR1, 'SCREENING')).json()).toMatchObject({ stage: 'SCREENING', version: 2 });
      expect((await h.call(recruiter, 'POST', `/v1/hiring/applications/${appR1}/stage`, { toStage: 'INTERVIEW', expectedVersion: 1 })).json().error).toBe('STALE_VERSION');
      expect((await move(recruiter, appR1, 'INTERVIEW')).json().stage).toBe('INTERVIEW');
      // The candidate also applies to an unrelated requisition.
      appR2 = (await apply(recruiter, r2.id, one)).json().id;
      expect((await move(recruiter, appR2, 'SCREENING')).json().stage).toBe('SCREENING');
      // The database refuses skipped stages too (ZT10).
      await expect(h.db.query(`update application set stage = 'OFFER' where id = $1`, [appR2])).rejects.toMatchObject({ code: '23514' });
      await expect(h.db.query(`update application set stage = 'HIRED' where id = $1`, [appR1])).rejects.toMatchObject({ code: '23514' });
    });

    it('rejecting one application never rejects the candidate’s other applications', async () => {
      expect((await move(recruiter, appR1, 'REJECTED', 'Synthetic: interview outcome')).json().stage).toBe('REJECTED');
      expect((await move(recruiter, appR1, 'SCREENING')).json().error).toBe('INVALID_STATE');
      const other = (await h.call(recruiter, 'GET', `/v1/hiring/applications/${appR2}`)).json();
      expect(other).toMatchObject({ stage: 'SCREENING', candidate: { id: one, state: 'ACTIVE' } });
      expect((await h.call(recruiter, 'GET', `/v1/hiring/candidates/${one}`)).json()).toMatchObject({ state: 'ACTIVE' });
      const history = (await h.call(recruiter, 'GET', `/v1/hiring/applications/${appR1}`)).json().history;
      expect(history.map((x: { toStage: string }) => x.toStage)).toEqual(['APPLIED', 'SCREENING', 'INTERVIEW', 'REJECTED']);
      expect(history.at(-1)).toMatchObject({ fromStage: 'INTERVIEW', note: 'Synthetic: interview outcome' });
    });

    it('owners hold the application duty; the tracker shows vacancies, stage, owner, pending action and ageing', async () => {
      const current = (await h.call(recruiter, 'GET', `/v1/hiring/applications/${appR2}`)).json();
      expect((await h.call(recruiter, 'PUT', `/v1/hiring/applications/${appR2}/owner`, { ownerUserId: employee.user, expectedVersion: current.version })).json().error).toBe('INVALID_OWNER');
      expect((await h.call(recruiter, 'PUT', `/v1/hiring/applications/${appR2}/owner`, { ownerUserId: recruiter2.user, expectedVersion: current.version })).json().ownerUserId).toBe(recruiter2.user);

      const t = (await h.call(recruiter, 'GET', '/v1/hiring/tracker')).json();
      const v1 = t.vacancies.find((v: { id: string }) => v.id === r1.id);
      expect(v1).toMatchObject({ code: r1.code, vacancies: 1, filled: 0, openPlaces: 1, byStage: { REJECTED: 1 } });
      expect(t.vacancies.find((v: { id: string }) => v.id === r2.id)).toMatchObject({ byStage: { SCREENING: 1 } });
      // Only open applications are tracked; each with its owner, pending action and ageing.
      expect(t.applications).toEqual([
        expect.objectContaining({ id: appR2, stage: 'SCREENING', pendingAction: 'COMPLETE_SCREENING', ageingDays: 0, owner: expect.objectContaining({ userId: recruiter2.user }) }),
      ]);
      expect((await h.call(recruiter, 'GET', `/v1/hiring/tracker?ownerUserId=${recruiter.user}`)).json().applications).toEqual([]);
      // Ageing counts calendar days in the current stage.
      await h.db.query(`alter table application disable trigger application_guard`);
      await h.db.query(`update application set stage_entered_at = now() - interval '3 days' where id = $1`, [appR2]);
      await h.db.query(`alter table application enable trigger application_guard`);
      expect((await h.call(recruiter, 'GET', '/v1/hiring/tracker')).json().applications[0].ageingDays).toBe(3);
      // Operational pipeline only for hiring roles.
      expect((await h.call(w.requester, 'GET', '/v1/hiring/tracker')).statusCode).toBe(403);
      expect((await h.call(employee, 'GET', '/v1/hiring/tracker')).statusCode).toBe(403);

      // F2 Recruiter metrics reconcile with the lists they summarise (same scope).
      const grant = await resolveAccess(h.db, { userId: recruiter.user, companyId: A.id, assignmentId: recruiter.assignment, resource: 'application', action: 'read', fieldGroups: ['operational'] });
      if (!grant.allowed) throw new Error('recruiter grant expected');
      expect(await HIRING_METRICS.APPROVED_REQUISITIONS!(h.db, grant)).toEqual({ status: 'OK', value: t.vacancies.length });
      expect(await HIRING_METRICS.OPEN_PIPELINE_APPLICATIONS!(h.db, grant)).toEqual({ status: 'OK', value: 1 });
      expect(await HIRING_METRICS.OFFERS_AWAITING_APPROVAL!(h.db, grant)).toEqual({ status: 'OK', value: 0 });
      // I-92 (0245): interview tasks are the viewer's own applications at the interview stage; none of the recruiter's is there.
      expect(await HIRING_METRICS.INTERVIEW_TASKS_DUE!(h.db, grant)).toEqual({ status: 'OK', value: 0 });
      expect(await pipelineStageCounts(h.db, grant)).toEqual({ REJECTED: 1, SCREENING: 1 });
    });

    it('confidential groups follow the Admin assignment’s scope (DF02 scoped Admin)', async () => {
      // A Finance-filtered Admin does not reach a candidate in an Engineering pipeline; the attempt is audited.
      expect((await h.call(hrConfFin, 'GET', `/v1/hiring/candidates/${one}/contact`)).statusCode).toBe(404);
      const denial = await h.one<{ n: number }>(`select count(*)::int as n from audit_event where actor_user_id = $1 and action = 'ACCESS_DENIED' and record_key = $2`, [hrConfFin.user, one]);
      expect(denial.n).toBe(1);
      expect((await h.call(hrConfFin, 'GET', `/v1/hiring/candidates/${one}`)).statusCode).toBe(404);
      // A candidate in the open register (no application yet) is visible to a filtered company-scope assignment.
      const open = await newCandidate({ fullName: 'Synthetic Open Register' });
      expect((await h.call(hrConfFin, 'GET', `/v1/hiring/candidates/${open.id}`)).statusCode).toBe(200);
      expect((await contact(hrConfFin, open.id, { phone: '+1 555 0100 777' })).statusCode).toBe(200);
      // Lists never cross companies.
      expect((await h.call(bHrConf, 'GET', '/v1/hiring/candidates')).json().items).toEqual([]);
      expect((await h.call(bHrConf, 'GET', '/v1/hiring/duplicate-flags')).json().items).toEqual([]);
    });
  });

  describe('form choices, eligible owners, names and paging (DF04, FR-013, FR-014)', () => {
    it('serves the candidate form lists under the permissions of their forms', async () => {
      const values = (a: TestActor, category: string) => h.call(a, 'GET', `/v1/hiring/reference-values?category=${category}`);
      const sources = await values(recruiter, 'CANDIDATE_SOURCE');
      expect(sources.statusCode, sources.body).toBe(200);
      expect(sources.json().items).toEqual(expect.arrayContaining([{ code: 'DIRECT', label: 'Direct application' }, { code: 'VENDOR', label: 'Recruitment vendor' }]));
      expect((await values(w.requester, 'CANDIDATE_SOURCE')).statusCode).toBe(403);
      expect((await values(employee, 'CANDIDATE_SOURCE')).statusCode).toBe(403);
      // CV upload types follow the confidential upload grant.
      expect((await values(hrConf, 'CANDIDATE_DOCUMENT_TYPE')).json().items.map((v: { code: string }) => v.code)).toEqual(expect.arrayContaining(['CV', 'OTHER']));
      expect((await values(recruiter, 'CANDIDATE_DOCUMENT_TYPE')).statusCode).toBe(403);
      expect((await values(w.hr, 'CANDIDATE_DOCUMENT_TYPE')).statusCode).toBe(403);
    });

    it('lists the users who may own an application, exactly as the owner check accepts them', async () => {
      const ownerEmp = (await h.call(w.hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { displayName: 'Synthetic Owner Person' }))).json();
      const hrOwner = await h.actor(A, 'HR_ADMINISTRATOR', { employeeId: ownerEmp.id });
      const owners = await h.call(recruiter, 'GET', '/v1/hiring/application-owners?pageSize=100');
      expect(owners.statusCode, owners.body).toBe(200);
      const ids = (owners.json().items as { userId: string }[]).map((o) => o.userId);
      expect(ids).toEqual(expect.arrayContaining([recruiter.user, recruiter2.user, w.hr.user, hrConf.user, hrOwner.user]));
      expect(ids).not.toContain(employee.user);
      expect(ids).not.toContain(w.requester.user);
      expect(owners.json()).toMatchObject({ total: ids.length, page: 1, pageSize: 100 });
      // Operational identity only, searchable by name or code.
      const found = (await h.call(recruiter, 'GET', `/v1/hiring/application-owners?search=${encodeURIComponent('owner person')}`)).json();
      expect(found).toEqual({ items: [{ userId: hrOwner.user, employeeCode: ownerEmp.employeeCode, displayName: 'Synthetic Owner Person' }], total: 1, page: 1, pageSize: 25 });
      expect((await h.call(recruiter, 'GET', `/v1/hiring/application-owners?search=${encodeURIComponent(ownerEmp.employeeCode)}`)).json().items.map((o: { userId: string }) => o.userId)).toEqual([hrOwner.user]);
      // Whoever the list offers, the owner check accepts.
      const c = await newCandidate({ fullName: 'Synthetic Owned Candidate' });
      const app = (await apply(recruiter, r1.id, c.id)).json();
      expect((await h.call(recruiter, 'PUT', `/v1/hiring/applications/${app.id}/owner`, { ownerUserId: hrOwner.user, expectedVersion: app.version })).json().ownerUserId).toBe(hrOwner.user);
      // Losing the duty takes the user off the list.
      await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where company_id = $1 and id = $2`, [A.id, hrOwner.assignment]);
      expect(((await h.call(recruiter, 'GET', '/v1/hiring/application-owners?pageSize=100')).json().items as { userId: string }[]).map((o) => o.userId)).not.toContain(hrOwner.user);
      // Only holders of the owner duty may list; another company sees only its own users.
      expect((await h.call(employee, 'GET', '/v1/hiring/application-owners')).statusCode).toBe(403);
      expect((await h.call(w.requester, 'GET', '/v1/hiring/application-owners')).statusCode).toBe(403);
      const bRecruiter = await h.actor(B, 'RECRUITER');
      const bOwners = ((await h.call(bRecruiter, 'GET', '/v1/hiring/application-owners?pageSize=100')).json().items as { userId: string }[]).map((o) => o.userId);
      expect(bOwners).toContain(bRecruiter.user);
      expect(bOwners).not.toContain(recruiter.user);
    });

    it('names stage actors and pages the capped pipeline lists with a total', async () => {
      const apps = (await h.call(recruiter, 'GET', '/v1/hiring/applications')).json();
      expect(apps.total).toBe(apps.items.length);
      const detail = (await h.call(recruiter, 'GET', `/v1/hiring/applications/${apps.items[0].id}`)).json();
      expect(detail.history[0]).toMatchObject({ toStage: 'APPLIED', actorPerson: { userId: detail.history[0].actorUserId, employeeCode: null, displayName: null } });
      expect((await h.call(recruiter, 'GET', '/v1/hiring/applications?page=1&pageSize=25')).json()).toMatchObject({ total: apps.total, page: 1, pageSize: 25 });
      expect((await h.call(recruiter, 'GET', '/v1/hiring/applications?page=3&pageSize=25')).json()).toEqual({ items: [], total: apps.total, page: 3, pageSize: 25 });

      const tracked = (await h.call(recruiter, 'GET', '/v1/hiring/tracker')).json();
      expect(tracked).toMatchObject({ vacanciesTotal: tracked.vacancies.length, applicationsTotal: tracked.applications.length });
      expect(tracked.vacancies.length).toBeGreaterThan(0);
      expect((await h.call(recruiter, 'GET', '/v1/hiring/tracker?page=1&pageSize=25')).json()).toMatchObject({
        vacanciesTotal: tracked.vacanciesTotal,
        applicationsTotal: tracked.applicationsTotal,
        page: 1,
        pageSize: 25,
      });
      expect((await h.call(recruiter, 'GET', '/v1/hiring/tracker?page=2&pageSize=25')).json()).toEqual({ vacancies: [], applications: [], vacanciesTotal: tracked.vacanciesTotal, applicationsTotal: 0, page: 2, pageSize: 25 });

      const flags = (await h.call(recruiter, 'GET', '/v1/hiring/duplicate-flags')).json();
      expect(flags.total).toBe(flags.items.length);
      expect(flags.total).toBeGreaterThan(0);
      expect((await h.call(recruiter, 'GET', '/v1/hiring/duplicate-flags?page=1&pageSize=25')).json()).toMatchObject({ total: flags.total, page: 1, pageSize: 25 });

      const docs = (await h.call(hrConf, 'GET', '/v1/hiring/candidate-documents?search=synthetic')).json();
      expect(docs.total).toBe(docs.items.length);
      expect(docs.total).toBeGreaterThan(0);
      expect((await h.call(hrConf, 'GET', '/v1/hiring/candidate-documents?search=synthetic&page=2&pageSize=25')).json()).toEqual({ items: [], total: docs.total, page: 2, pageSize: 25 });

      // The always-paged register reports its total on a page past the end too.
      const candidates = (await h.call(recruiter, 'GET', '/v1/hiring/candidates')).json();
      expect((await h.call(recruiter, 'GET', '/v1/hiring/candidates?page=40')).json()).toEqual({ items: [], total: candidates.total, page: 40, pageSize: 25 });
    });
  });
});
