// Offers, the independent approval of their confidential compensation, acceptance and the handover to onboarding
// over HTTP (F1 hiring; FR-012 "only an approved requisition accepts final placement"; FR-014; DF02; C4;
// ZT03/04/07/11). Synthetic data only: made-up amounts, example.test addresses and a synthetic PDF.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import type { PermissionKey } from '../access/baseline.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { EICAR_TEST_STRING } from '../../storage/scan.js';
import { isModuleActive } from '../registry.js';
import { setCompensation } from './offer.js';
import { addDays, approvedRequisition, type HiringWorld, hiringWorld, PDF } from './test-fixtures.js';

describe.runIf(isModuleActive('hiring'))('hiring: offers and handover', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let w: HiringWorld;
  let recruiter: TestActor;
  let hrComp: TestActor;
  let hrApprove: TestActor;
  let hrDocs: TestActor;
  let bHr: TestActor;
  let employee: TestActor;
  let r1: { id: string; code: string };
  let joining: string;
  let o1: string;
  let o2: string;

  const COMPENSATION: PermissionKey[] = ['offer.read.compensation', 'offer.manage.compensation', 'offer.approve.compensation'];
  // Every synthetic amount used below, as it would appear if it leaked (dots never occur in identifiers).
  const AMOUNTS = /1234567\.5|98765\.4321|1300000\.25|100000\.75|900000\.33|75000\.66/;
  const inbox = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[];
  const setOfferList = (users: TestActor[]) => h.call(w.hr, 'PUT', '/v1/workflows/hiring_offer/fallback-reviewers', { reviewers: users.map((u, i) => ({ userId: u.user, priority: i + 1 })) });
  const offer = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/hiring/offers/${id}`)).json();
  const move = async (applicationId: string, toStage: string, note?: string) => {
    const current = (await h.call(recruiter, 'GET', `/v1/hiring/applications/${applicationId}`)).json();
    const res = await h.call(recruiter, 'POST', `/v1/hiring/applications/${applicationId}/stage`, { toStage, expectedVersion: current.version, ...(note ? { note } : {}) });
    expect(res.statusCode, res.body).toBe(200);
  };
  /** A candidate with an application at the OFFER stage of the requisition. */
  const atOffer = async (requisitionId: string, fullName: string) => {
    const c = (await h.call(recruiter, 'POST', '/v1/hiring/candidates', { fullName, sourceCode: 'DIRECT', consentStatus: 'GIVEN', consentRecordedOn: w.today })).json();
    const app = (await h.call(recruiter, 'POST', `/v1/hiring/requisitions/${requisitionId}/applications`, { candidateId: c.id })).json();
    for (const stage of ['SCREENING', 'INTERVIEW', 'OFFER']) await move(app.id, stage);
    return { candidateId: c.id as string, candidateCode: c.candidateCode as string, applicationId: app.id as string };
  };
  const newOffer = async (applicationId: string) => {
    const res = await h.call(recruiter, 'POST', `/v1/hiring/applications/${applicationId}/offers`, { proposedJoiningDate: joining });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; version: number };
  };
  const price = async (offerId: string, amounts: Record<string, string>) => {
    const res = await h.call(hrComp, 'PUT', `/v1/hiring/offers/${offerId}/compensation`, { currencyCode: 'INR', ...amounts, expectedVersion: (await offer(hrComp, offerId)).version });
    expect(res.statusCode, res.body).toBe(200);
  };
  const submit = async (offerId: string) => h.call(recruiter, 'POST', `/v1/hiring/offers/${offerId}/submit`, { expectedVersion: (await offer(recruiter, offerId)).version });
  const taskFor = async (a: TestActor, offerId: string) =>
    ((await h.call(a, 'GET', '/v1/hiring/offer-tasks')).json().items as { taskId: string; offer: { id: string; underReview: Record<string, unknown> } | null }[]).find((t) => t.offer?.id === offerId);
  const decide = (a: TestActor, taskId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/hiring/offer-tasks/${taskId}/decision`, { idempotencyKey: uniq('offer-key-'), ...body });
  const approvedOffer = async (requisitionId: string, fullName: string) => {
    const at = await atOffer(requisitionId, fullName);
    const o = await newOffer(at.applicationId);
    await price(o.id, { annualCtc: '900000.33' });
    expect((await submit(o.id)).json().state).toBe('SUBMITTED');
    expect((await decide(hrApprove, (await taskFor(hrApprove, o.id))!.taskId, { decision: 'APPROVE' })).json().state).toBe('APPROVED');
    return { ...at, offerId: o.id };
  };
  const respond = async (offerId: string, response: string, respondedOn = w.today) =>
    h.call(recruiter, 'POST', `/v1/hiring/offers/${offerId}/response`, { response, respondedOn, expectedVersion: (await offer(recruiter, offerId)).version });

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    w = await hiringWorld(h, A);
    recruiter = await h.actor(A, 'RECRUITER');
    hrComp = await h.actor(A, 'HR_ADMINISTRATOR', { extra: COMPENSATION });
    hrApprove = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['offer.read.compensation', 'offer.approve.compensation'] });
    hrDocs = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['candidate.read.document', 'candidate.upload.document', 'document.upload.document', 'document.read.document'] });
    bHr = await h.actor(B, 'HR_ADMINISTRATOR', { extra: COMPENSATION });
    employee = await h.actor(A, 'EMPLOYEE', { employeeId: (await h.call(w.hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id });
    expect((await setOfferList([hrComp, hrApprove])).statusCode).toBe(200);
    joining = addDays(w.today, 40);
    r1 = await approvedRequisition(h, A, w, { title: 'Synthetic single vacancy', vacancies: 1 });
  });

  afterAll(async () => {
    await h?.stop();
  });

  describe('offer preparation (F1)', () => {
    it('needs the OFFER stage of an approved requisition; the compensation is an Admin-only confidential group', async () => {
      const at = await atOffer(r1.id, 'Synthetic Offer One');
      // One stage back: no offer yet.
      const early = await (async () => {
        const c = (await h.call(recruiter, 'POST', '/v1/hiring/candidates', { fullName: 'Synthetic Early', sourceCode: 'DIRECT', consentStatus: 'NOT_RECORDED' })).json();
        const app = (await h.call(recruiter, 'POST', `/v1/hiring/requisitions/${r1.id}/applications`, { candidateId: c.id })).json();
        return h.call(recruiter, 'POST', `/v1/hiring/applications/${app.id}/offers`, { proposedJoiningDate: joining });
      })();
      expect(early.json().error).toBe('INVALID_STATE');

      const created = await newOffer(at.applicationId);
      o1 = created.id;
      expect(created).toMatchObject({ state: 'DRAFT', currentRevision: 0, proposedJoiningDate: joining, candidate: { id: at.candidateId }, requisition: { id: r1.id, state: 'APPROVED' } });
      expect(Object.keys(created)).not.toContain('compensation');
      expect((await h.call(recruiter, 'POST', `/v1/hiring/applications/${at.applicationId}/offers`, { proposedJoiningDate: joining })).json().error).toBe('OFFER_EXISTS');
      // Operational roles never hold the compensation group; an Admin needs the explicit grant.
      const body = { currencyCode: 'INR', annualCtc: '1234567.50', monthlyGross: '98765.4321', expectedVersion: created.version };
      expect((await h.call(recruiter, 'PUT', `/v1/hiring/offers/${o1}/compensation`, body)).statusCode).toBe(403);
      expect((await h.call(w.hr, 'PUT', `/v1/hiring/offers/${o1}/compensation`, body)).statusCode).toBe(403);
      expect((await submit(o1)).json().error).toBe('COMPENSATION_REQUIRED');
      expect((await h.call(hrComp, 'PUT', `/v1/hiring/offers/${o1}/compensation`, { currencyCode: 'INR', expectedVersion: created.version })).json().error).toBe('COMPENSATION_REQUIRED');
      expect((await h.call(hrComp, 'PUT', `/v1/hiring/offers/${o1}/compensation`, { ...body, annualCtc: '-1' })).statusCode).toBe(400);
      expect((await h.call(hrComp, 'PUT', `/v1/hiring/offers/${o1}/compensation`, body)).json()).toMatchObject({ offerId: o1, version: created.version + 1 });

      const operational = await offer(recruiter, o1);
      expect(operational.compensation).toBeUndefined();
      expect(JSON.stringify(operational)).not.toMatch(AMOUNTS);
      expect((await offer(hrComp, o1)).compensation.current).toMatchObject({ currencyCode: 'INR', annualCtc: '1234567.5000', monthlyGross: '98765.4321', setBy: hrComp.user });
      // The terms change only while the offer is a draft.
      expect((await h.call(recruiter, 'PUT', `/v1/hiring/offers/${o1}`, { proposedJoiningDate: joining, expectedVersion: operational.version })).statusCode).toBe(200);
      expect((await h.call(employee, 'GET', `/v1/hiring/offers/${o1}`)).statusCode).toBe(403);
      expect((await h.call(bHr, 'GET', `/v1/hiring/offers/${o1}`)).statusCode).toBe(404);
    });
  });

  describe('independent approval of the compensation (F1, C4)', () => {
    it('never goes to the preparer, the compensation preparer or the submitter', async () => {
      // Only the compensation preparer is listed: nobody is eligible, the submission is refused, nothing changes.
      expect((await setOfferList([hrComp])).statusCode).toBe(200);
      expect((await submit(o1)).json().error).toBe('NO_ELIGIBLE_REVIEWER');
      expect((await offer(recruiter, o1)).state).toBe('DRAFT');
      expect((await setOfferList([hrComp, hrApprove])).statusCode).toBe(200);
      expect((await submit(o1)).json()).toMatchObject({ state: 'SUBMITTED', revision: 1 });

      expect(await taskFor(hrComp, o1)).toBeUndefined();
      const task = (await taskFor(hrApprove, o1))!;
      expect(task.offer!.underReview).toMatchObject({ revision: 1, currencyCode: 'INR', annualCtc: '1234567.5000', monthlyGross: '98765.4321' });
      expect((await h.call(recruiter, 'GET', '/v1/hiring/offer-tasks')).statusCode).toBe(403);
      expect((await h.call(w.hr, 'GET', '/v1/hiring/offer-tasks')).statusCode).toBe(403);
      expect((await decide(hrComp, task.taskId, { decision: 'APPROVE' })).statusCode).toBe(404);

      await dispatchOutbox(h.pool, 500);
      const notice = (await inbox(hrApprove)).find((n) => n.category === 'OFFER_SUBMITTED')!;
      expect(notice.body).toContain(r1.code);
      expect(notice.body).not.toMatch(AMOUNTS);
      expect(notice.body).not.toContain('INR');

      // Return for correction: back to the draft; the next submission is a new revision with a new approval.
      expect((await decide(hrApprove, task.taskId, { decision: 'RETURN' })).json().error).toBe('REASON_REQUIRED');
      expect((await decide(hrApprove, task.taskId, { decision: 'RETURN', reason: 'Synthetic: check the band' })).json().state).toBe('DRAFT');
      await price(o1, { annualCtc: '1300000.25', monthlyGross: '100000.75' });
      expect((await submit(o1)).json()).toMatchObject({ state: 'SUBMITTED', revision: 2 });
      const again = (await taskFor(hrApprove, o1))!;
      expect(again.offer!.underReview).toMatchObject({ revision: 2, annualCtc: '1300000.2500', monthlyGross: '100000.7500' });
      expect((await decide(hrApprove, again.taskId, { decision: 'APPROVE' })).json()).toMatchObject({ offerId: o1, state: 'APPROVED', replayed: false });

      const stored = await h.one<{ prepared_by: string; compensation_set_by: string; submitted_by: string; decided_by: string }>(
        `select prepared_by, compensation_set_by, submitted_by, decided_by from hiring_offer where id = $1`,
        [o1],
      );
      expect(stored).toEqual({ prepared_by: recruiter.user, compensation_set_by: hrComp.user, submitted_by: recruiter.user, decided_by: hrApprove.user });
      // ZT04 at the data layer: an approver who priced the offer is refused by the database too.
      await expect(h.db.query(`update hiring_offer set decided_by = compensation_set_by where id = $1`, [o1])).rejects.toMatchObject({ code: '23514' });
      // ZT12: submitted revisions and approved terms are immutable.
      await expect(h.db.query(`update hiring_offer_revision set annual_ctc = 1 where offer_id = $1`, [o1])).rejects.toMatchObject({ code: '23514' });
      expect((await h.call(recruiter, 'PUT', `/v1/hiring/offers/${o1}`, { proposedJoiningDate: joining, expectedVersion: (await offer(recruiter, o1)).version })).json().error).toBe('INVALID_STATE');
      expect((await h.call(hrComp, 'PUT', `/v1/hiring/offers/${o1}/compensation`, { currencyCode: 'INR', annualCtc: '1', expectedVersion: (await offer(hrComp, o1)).version })).json().error).toBe('INVALID_STATE');
      const view = await offer(hrApprove, o1);
      expect(view.compensation.revisions.map((r: { revision: number; annualCtc: string }) => [r.revision, r.annualCtc])).toEqual([
        [1, '1234567.5000'],
        [2, '1300000.2500'],
      ]);
      expect(view.decisions.map((d: { decision: string }) => d.decision)).toEqual(['RETURN', 'APPROVE']);
      // Decision reasons stay with the compensation readers.
      expect((await offer(recruiter, o1)).decisions[0].reason).toBeUndefined();

      await dispatchOutbox(h.pool, 500);
      const outcomes = (await inbox(recruiter)).filter((n) => n.category === 'OFFER_DECIDED').map((n) => n.body);
      expect(outcomes).toEqual(expect.arrayContaining([expect.stringContaining('was returned for changes'), expect.stringContaining('was approved')]));
    });

    it('withdrawing a submitted offer cancels the approval and tells the approver (DF03, DF12)', async () => {
      const r = await approvedRequisition(h, A, w, { title: 'Synthetic withdrawn offer role' });
      const at = await atOffer(r.id, 'Synthetic Withdrawn Offer');
      const o = await newOffer(at.applicationId);
      await price(o.id, { annualCtc: '900000.33' });
      expect((await submit(o.id)).json().state).toBe('SUBMITTED');
      const task = (await taskFor(hrApprove, o.id))!;
      expect((await h.call(recruiter, 'POST', `/v1/hiring/offers/${o.id}/withdraw`, { reason: 'Synthetic: role put on hold' })).json().state).toBe('WITHDRAWN');
      expect(await taskFor(hrApprove, o.id)).toBeUndefined();
      expect((await decide(hrApprove, task.taskId, { decision: 'APPROVE' })).json().error).toBe('TASK_CLOSED');
      expect((await h.call(recruiter, 'POST', `/v1/hiring/offers/${o.id}/withdraw`, { reason: 'again' })).json().error).toBe('INVALID_STATE');
      await dispatchOutbox(h.pool, 500);
      const notices = (await inbox(hrApprove)).filter((n) => n.category === 'OFFER_WITHDRAWN').map((n) => n.body);
      expect(notices).toEqual([`The offer to candidate ${at.candidateCode} for requisition ${r.code} was withdrawn; no decision is needed.`]);
      // The withdrawal reason never travels in the notice.
      expect(JSON.stringify(notices)).not.toContain('on hold');
      // A new offer may follow on the same application.
      expect((await h.call(recruiter, 'POST', `/v1/hiring/applications/${at.applicationId}/offers`, { proposedJoiningDate: joining })).statusCode).toBe(201);
    });
  });

  describe('acceptance and handover (FR-012, FR-014)', () => {
    let employeeId: string;

    it('never accepts more offers than vacancies, even simultaneously', async () => {
      o2 = (await approvedOffer(r1.id, 'Synthetic Offer Two')).offerId;
      expect((await respond(o1, 'ACCEPTED', addDays(w.today, 1))).json().error).toBe('INVALID_DATE');
      const results = await Promise.all([respond(o1, 'ACCEPTED'), respond(o2, 'ACCEPTED')]);
      const states = results.map((r) => r.json().state ?? r.json().error).sort();
      expect(states).toEqual(['ACCEPTED', 'NO_OPEN_VACANCY']);
      const accepted = await h.one<{ n: number }>(`select count(*)::int as n from hiring_offer where requisition_id = $1 and state = 'ACCEPTED'`, [r1.id]);
      expect(accepted.n).toBe(1);
      // Settle the race deterministically for the rest of the file: o1 is the accepted offer.
      if ((await offer(recruiter, o1)).state !== 'ACCEPTED') [o1, o2] = [o2, o1];
      expect((await h.call(recruiter, 'POST', `/v1/hiring/offers/${o2}/withdraw`, { reason: 'Synthetic: no vacancy left' })).json().state).toBe('WITHDRAWN');
      const loser = (await offer(recruiter, o2)).application.id;
      await move(loser, 'WITHDRAWN', 'Synthetic: no vacancy left');
    });

    it('creates exactly one DRAFT employee from validated fields, traceable to its requisition and application', async () => {
      const at = await offer(recruiter, o1);
      expect((await h.call(recruiter, 'POST', `/v1/hiring/offers/${o1}/handover`, { employeeCode: uniq('HIRE-') })).statusCode).toBe(403);
      const results = await Promise.all([
        h.call(w.hr, 'POST', `/v1/hiring/offers/${o1}/handover`, { employeeCode: uniq('HIRE-'), workEmail: `${uniq('hire')}@example.test` }),
        h.call(w.hr, 'POST', `/v1/hiring/offers/${o1}/handover`, { employeeCode: uniq('HIRE-'), workEmail: `${uniq('hire')}@example.test` }),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.statusCode === 409)!.json().error).toBe('ALREADY_HANDED_OVER');
      const done = results.find((r) => r.statusCode === 201)!.json();
      employeeId = done.employeeId;
      expect(done).toMatchObject({ employeeStatus: 'DRAFT', offerId: o1, applicationId: at.application.id, requisitionId: r1.id, documents: [] });
      const handovers = await h.one<{ n: number }>(`select count(*)::int as n from hiring_handover where offer_id = $1`, [o1]);
      expect(handovers.n).toBe(1);
      const created = await h.one<{ n: number }>(`select count(*)::int as n from employee where company_id = $1 and display_name = $2`, [A.id, at.candidate.fullName]);
      expect(created.n).toBe(1);

      // Never auto-activated; the fields come from the approved requisition and the accepted offer. The assignment
      // starts on the (future) joining date, so today's current-assignment view is still empty.
      const emp = (await h.call(w.hr, 'GET', `/v1/employees/${employeeId}`)).json();
      expect(emp).toMatchObject({ status: 'DRAFT', displayName: at.candidate.fullName, joiningDate: joining, employmentType: 'PERMANENT' });
      const assignment = await h.one(
        `select department_id, location_id, designation_id, to_char(effective_from, 'YYYY-MM-DD') as effective_from from employment_assignment where employee_id = $1`,
        [employeeId],
      );
      expect(assignment).toEqual({ department_id: A.dept, location_id: A.loc, designation_id: A.desig, effective_from: joining });
      expect(Object.keys(emp)).not.toContain('dateOfBirth');

      const origin = (await h.call(recruiter, 'GET', `/v1/hiring/employees/${employeeId}/origin`)).json();
      expect(origin).toMatchObject({ employeeId, requisition: { id: r1.id, code: r1.code }, application: { id: at.application.id, stage: 'HIRED' }, offer: { id: o1, state: 'ACCEPTED' }, candidate: { id: at.candidate.id } });
      expect((await h.call(employee, 'GET', `/v1/hiring/employees/${employeeId}/origin`)).statusCode).toBe(403);
      expect((await h.call(bHr, 'GET', `/v1/hiring/employees/${employeeId}/origin`)).statusCode).toBe(404);

      const again = await h.call(w.hr, 'POST', `/v1/hiring/offers/${o1}/handover`, { employeeCode: uniq('HIRE-') });
      expect(again.json()).toMatchObject({ error: 'ALREADY_HANDED_OVER', details: { employeeId } });
      expect((await h.call(recruiter, 'POST', `/v1/hiring/offers/${o1}/withdraw`, { reason: 'Synthetic' })).json().error).toBe('ALREADY_HANDED_OVER');
      const hired = (await h.call(recruiter, 'GET', `/v1/hiring/applications/${at.application.id}`)).json();
      expect(hired.stage).toBe('HIRED');
      expect((await h.call(recruiter, 'POST', `/v1/hiring/applications/${at.application.id}/stage`, { toStage: 'WITHDRAWN', note: 'x', expectedVersion: hired.version })).json().error).toBe('INVALID_STATE');
      const tracked = (await h.call(recruiter, 'GET', `/v1/hiring/tracker?requisitionId=${r1.id}`)).json();
      expect(tracked.vacancies[0]).toMatchObject({ filled: 1, openPlaces: 0, byStage: { HIRED: 1, WITHDRAWN: 1 } });
      // Every placement done: HR closes the requisition.
      expect((await h.call(w.hr, 'POST', `/v1/hiring/requisitions/${r1.id}/close`, { reason: 'Synthetic: filled' })).json().state).toBe('CLOSED');
    });

    it('transfers only the candidate documents the reviewing Admin approves, with the document grants', async () => {
      const r2 = await approvedRequisition(h, A, w, { title: 'Synthetic documented role' });
      const at = await atOffer(r2.id, 'Synthetic Documented');
      const cv = await h.call(hrDocs, 'POST', `/v1/hiring/candidates/${at.candidateId}/documents`, { documentType: 'CV', fileName: 'synthetic-cv.pdf', contentBase64: PDF.toString('base64') });
      expect(cv.statusCode, cv.body).toBe(201);
      expect(cv.json().scanState).toBe('CLEAN');
      // A file the scan flags is quarantined for good (FR-106).
      const infected = Buffer.concat([PDF, Buffer.from(EICAR_TEST_STRING, 'latin1')]);
      const flagged = await h.call(hrDocs, 'POST', `/v1/hiring/candidates/${at.candidateId}/documents`, { documentType: 'OTHER', fileName: 'synthetic-flagged.pdf', contentBase64: infected.toString('base64') });
      expect(flagged.json().scanState).toBe('QUARANTINED');
      const other = await atOffer(r2.id, 'Synthetic Other Holder');
      const foreign = await h.call(hrDocs, 'POST', `/v1/hiring/candidates/${other.candidateId}/documents`, { documentType: 'CV', fileName: 'other-cv.pdf', contentBase64: PDF.toString('base64') });
      const o = await newOffer(at.applicationId);
      await price(o.id, { monthlyGross: '75000.66' });
      await submit(o.id);
      await decide(hrApprove, (await taskFor(hrApprove, o.id))!.taskId, { decision: 'APPROVE' });
      expect((await respond(o.id, 'ACCEPTED')).json().state).toBe('ACCEPTED');

      const body = (documents: { candidateDocumentId: string; documentType: string }[]) => ({ employeeCode: uniq('HIRE-'), documents });
      expect((await h.call(w.hr, 'POST', `/v1/hiring/offers/${o.id}/handover`, body([{ candidateDocumentId: cv.json().id, documentType: 'GENERAL' }]))).statusCode).toBe(403);
      expect((await h.call(hrDocs, 'POST', `/v1/hiring/offers/${o.id}/handover`, body([{ candidateDocumentId: foreign.json().id, documentType: 'GENERAL' }]))).json().error).toBe('INVALID_DOCUMENT');
      // FR-106: a file the malware scan has not released never reaches the employee record.
      const refused = await h.call(hrDocs, 'POST', `/v1/hiring/offers/${o.id}/handover`, body([{ candidateDocumentId: cv.json().id, documentType: 'GENERAL' }, { candidateDocumentId: flagged.json().id, documentType: 'GENERAL' }]));
      expect(refused.json()).toMatchObject({ error: 'FILE_NOT_RELEASED', details: { candidateDocumentId: flagged.json().id, scanState: 'QUARANTINED' } });
      // The refused attempt left nothing behind.
      expect((await h.one<{ n: number }>(`select count(*)::int as n from hiring_handover where offer_id = $1`, [o.id])).n).toBe(0);
      expect((await h.one<{ n: number }>(`select count(*)::int as n from employee where company_id = $1 and display_name = 'Synthetic Documented'`, [A.id])).n).toBe(0);
      const done = await h.call(hrDocs, 'POST', `/v1/hiring/offers/${o.id}/handover`, body([{ candidateDocumentId: cv.json().id, documentType: 'GENERAL' }]));
      expect(done.statusCode, done.body).toBe(201);
      expect(done.json().documents).toEqual([{ candidateDocumentId: cv.json().id, employeeDocumentId: expect.any(String) }]);
      const docs = (await h.call(hrDocs, 'GET', `/v1/employees/${done.json().employeeId}/documents`)).json().items;
      expect(docs).toEqual([expect.objectContaining({ documentType: 'GENERAL', fileName: 'synthetic-cv.pdf', mediaType: 'application/pdf', scanState: 'CLEAN', verificationState: 'UNVERIFIED' })]);
      const content = await h.call(hrDocs, 'GET', `/v1/documents/${docs[0].id}/content`);
      expect(content.statusCode, content.body).toBe(200);
      expect(content.rawPayload.equals(PDF)).toBe(true);
    });

    it('open offers block closure; a closed requisition takes no new application', async () => {
      const r3 = await approvedRequisition(h, A, w, { title: 'Synthetic declined role' });
      const declined = await approvedOffer(r3.id, 'Synthetic Decliner');
      expect((await h.call(w.hr, 'POST', `/v1/hiring/requisitions/${r3.id}/close`, { reason: 'Synthetic' })).json().error).toBe('OPEN_OFFERS');
      expect((await respond(declined.offerId, 'DECLINED')).json().state).toBe('DECLINED');
      expect((await h.call(recruiter, 'GET', `/v1/hiring/tracker?requisitionId=${r3.id}`)).json().applications[0]).toMatchObject({ pendingAction: 'DECIDE_APPLICATION' });
      await move(declined.applicationId, 'WITHDRAWN', 'Synthetic: candidate declined');
      expect((await h.call(w.hr, 'POST', `/v1/hiring/requisitions/${r3.id}/close`, { reason: 'Synthetic: cancelled' })).json().state).toBe('CLOSED');
      const c = (await h.call(recruiter, 'POST', '/v1/hiring/candidates', { fullName: 'Synthetic Late', sourceCode: 'DIRECT', consentStatus: 'NOT_RECORDED' })).json();
      expect((await h.call(recruiter, 'POST', `/v1/hiring/requisitions/${r3.id}/applications`, { candidateId: c.id })).json().error).toBe('REQUISITION_NOT_APPROVED');
    });

    it('a new offer and the closure of its requisition never both succeed, even simultaneously', async () => {
      const r = await approvedRequisition(h, A, w, { title: 'Synthetic race role' });
      const at = await atOffer(r.id, 'Synthetic Race Candidate');
      const [created, closed] = await Promise.all([
        h.call(recruiter, 'POST', `/v1/hiring/applications/${at.applicationId}/offers`, { proposedJoiningDate: joining }),
        h.call(w.hr, 'POST', `/v1/hiring/requisitions/${r.id}/close`, { reason: 'Synthetic: cancelled' }),
      ]);
      expect([created.statusCode, closed.statusCode].filter((s) => s < 300), `${created.body} ${closed.body}`).toHaveLength(1);
      expect([created.json().error, closed.json().error].filter(Boolean)).toEqual([created.statusCode < 300 ? 'OPEN_OFFERS' : 'REQUISITION_NOT_APPROVED']);
      const stranded = await h.one<{ n: number }>(
        `select count(*)::int as n from hiring_offer o join requisition q on q.company_id = o.company_id and q.id = o.requisition_id
          where q.id = $1 and q.state <> 'APPROVED' and o.state in ('DRAFT', 'SUBMITTED', 'APPROVED')`,
        [r.id],
      );
      expect(stranded.n).toBe(0);
    });
  });

  describe('leakage (ZT03, DF12)', () => {
    it('compensation values never reach audit records, events or notifications', async () => {
      const audit = await h.one<{ t: string }>(`select string_agg(coalesce(before_values::text, '') || coalesce(after_values::text, ''), ' ') as t from audit_event where company_id = $1`, [A.id]);
      expect(audit.t).toContain('compensationFields');
      expect(audit.t).not.toMatch(AMOUNTS);
      const events = await h.one<{ t: string }>(`select coalesce(string_agg(payload::text, ' '), '') as t from outbox_event where company_id = $1`, [A.id]);
      expect(events.t).not.toMatch(AMOUNTS);
      await dispatchOutbox(h.pool, 500);
      const notices = await h.one<{ t: string }>(`select coalesce(string_agg(coalesce(title, '') || ' ' || coalesce(body, ''), ' '), '') as t from notification where company_id = $1`, [A.id]);
      expect(notices.t).not.toMatch(AMOUNTS);
      // The amounts are stored only in the confidential compensation tables.
      const stored = await h.one<{ n: number }>(`select count(*)::int as n from hiring_offer_revision r join hiring_offer o on o.id = r.offer_id where o.company_id = $1`, [A.id]);
      expect(stored.n).toBeGreaterThan(3);
      expect((await h.call(bHr, 'GET', '/v1/hiring/offer-tasks')).json().items).toEqual([]);
      expect((await h.call(bHr, 'GET', '/v1/hiring/offers')).json().items).toEqual([]);
    });
  });

  describe('routing within scope, re-checked compensation, names and paging (DF03, I-25, docs/09 §6.5)', () => {
    it('an offer approval never goes to a listed approver whose scope does not reach the requisition', async () => {
      // An eligible Admin with the approval grant whose Finance filter does not reach this Engineering requisition.
      const hrFinApprove = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['offer.read.compensation', 'offer.approve.compensation'], departmentFilter: A.financeDept });
      const r = await approvedRequisition(h, A, w, { title: 'Synthetic scoped offer role', vacancies: 2 });
      expect((await setOfferList([hrFinApprove, hrApprove])).statusCode).toBe(200);
      const first = await atOffer(r.id, 'Synthetic Scoped One');
      const o = await newOffer(first.applicationId);
      await price(o.id, { annualCtc: '900000.33' });
      expect((await submit(o.id)).json().state).toBe('SUBMITTED');
      expect((await h.call(hrFinApprove, 'GET', '/v1/hiring/offer-tasks')).json().items).toEqual([]);
      expect((await taskFor(hrApprove, o.id))!.offer!.id).toBe(o.id);
      // Nobody in scope is listed: refused with the repairable routing error; the offer stays a draft.
      expect((await setOfferList([hrFinApprove])).statusCode).toBe(200);
      const second = await atOffer(r.id, 'Synthetic Scoped Two');
      const o2 = await newOffer(second.applicationId);
      await price(o2.id, { annualCtc: '900000.33' });
      expect((await submit(o2.id)).json().error).toBe('NO_ELIGIBLE_REVIEWER');
      expect((await offer(recruiter, o2.id)).state).toBe('DRAFT');
      expect((await h.call(hrFinApprove, 'GET', '/v1/hiring/offer-tasks')).json().items).toEqual([]);
      expect((await setOfferList([hrComp, hrApprove])).statusCode).toBe(200);
    });

    it('records compensation only while the compensation grant still holds, re-checked inside the transaction', async () => {
      const r = await approvedRequisition(h, A, w, { title: 'Synthetic stale grant role' });
      const at = await atOffer(r.id, 'Synthetic Stale Grant');
      const o = await newOffer(at.applicationId);
      const pricer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: COMPENSATION });
      // What the route guard resolved, before the grant was withdrawn.
      const grant = (await resolveAccess(h.pool, { userId: pricer.user, companyId: A.id, assignmentId: pricer.assignment, resource: 'offer', action: 'manage', fieldGroups: ['compensation'] })) as AccessGrant;
      expect(grant.allowed).toBe(true);
      await h.db.query(
        `update role_assignment_permission set active = false where company_id = $1 and role_assignment_id = $2
            and permission_id = (select id from permission where resource = 'offer' and action = 'manage' and field_group = 'compensation')`,
        [A.id, pricer.assignment],
      );
      await expect(withTransaction(h.pool, (tx) => setCompensation(tx, grant, o.id, { currencyCode: 'INR', annualCtc: '900000.33', expectedVersion: o.version }))).rejects.toMatchObject({ statusCode: 403 });
      expect((await h.one<{ n: number }>(`select count(*)::int as n from hiring_offer_compensation where offer_id = $1`, [o.id])).n).toBe(0);
      expect((await offer(recruiter, o.id)).version).toBe(o.version);
      expect((await h.call(pricer, 'PUT', `/v1/hiring/offers/${o.id}/compensation`, { currencyCode: 'INR', annualCtc: '900000.33', expectedVersion: o.version })).statusCode).toBe(403);
    });

    it('names the people behind user ids only where the caller sees them; lists page with a total; handover choices', async () => {
      const operational = await offer(recruiter, o1);
      expect(operational).toMatchObject({ preparedByPerson: { userId: recruiter.user, employeeCode: null, displayName: null }, submittedByPerson: { userId: recruiter.user }, decidedByPerson: { userId: hrApprove.user } });
      expect(operational.compensation).toBeUndefined();
      const confidential = await offer(hrComp, o1);
      expect(confidential.compensation.current.setByPerson).toEqual({ userId: hrComp.user, employeeCode: null, displayName: null });
      expect(confidential.compensation.revisions.length).toBeGreaterThan(0);
      for (const v of confidential.compensation.revisions) expect(v).toMatchObject({ compensationSetByPerson: { userId: hrComp.user }, submittedByPerson: { userId: recruiter.user } });
      // A draft names nobody who has not acted yet.
      const draft = (await h.call(recruiter, 'GET', '/v1/hiring/offers?state=DRAFT')).json().items[0];
      expect(draft).toMatchObject({ submittedBy: null, submittedByPerson: null, decidedBy: null, decidedByPerson: null });

      const all = (await h.call(recruiter, 'GET', '/v1/hiring/offers')).json();
      expect(all.total).toBe(all.items.length);
      const page = (await h.call(recruiter, 'GET', '/v1/hiring/offers?page=1&pageSize=25')).json();
      expect(page).toMatchObject({ total: all.total, page: 1, pageSize: 25 });
      expect(page.items.map((x: { id: string }) => x.id)).toEqual(all.items.slice(0, 25).map((x: { id: string }) => x.id));
      expect(page.items[0]).not.toHaveProperty('transaction_id');
      expect((await h.call(recruiter, 'GET', '/v1/hiring/offers?page=2&pageSize=25')).json()).toEqual({ items: [], total: all.total, page: 2, pageSize: 25 });

      // The handover form's employee document types, under the handover duty.
      const types = await h.call(w.hr, 'GET', '/v1/hiring/reference-values?category=DOCUMENT_TYPE');
      expect(types.statusCode, types.body).toBe(200);
      expect(types.json().items.map((t: { code: string }) => t.code)).toContain('GENERAL');
      expect((await h.call(recruiter, 'GET', '/v1/hiring/reference-values?category=DOCUMENT_TYPE')).statusCode).toBe(403);

      // The onboarding record names who handed it over.
      const handover = await h.one<{ employee_id: string }>(`select employee_id from hiring_handover where offer_id = $1`, [o1]);
      expect((await h.call(recruiter, 'GET', `/v1/hiring/employees/${handover.employee_id}/origin`)).json()).toMatchObject({ handedOverBy: w.hr.user, handedOverByPerson: { userId: w.hr.user } });
    });
  });
});
