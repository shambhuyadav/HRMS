// Offer letters while an offer is being made, before the candidate is an employee (FR-014, FR-017, FR-018; DF09; F1; C4), as
// decided under owner delegation, 6 Nov 2026 (docs/03 I-82 item 1; migration 0190). Synthetic data only: made-up amounts and
// names, no real candidate.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { HR_LETTERS, person, publishedTemplate as processTemplate } from '../lifecycle/lifecycle.fixtures.js';
import { isModuleActive } from '../registry.js';
import { addDays, approvedRequisition, type HiringWorld, hiringWorld } from './test-fixtures.js';

describe.runIf(isModuleActive('hiring') && isModuleActive('lifecycle'))('hiring: offer letters before employment (I-82 item 1)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let w: HiringWorld;
  let recruiter: TestActor;
  let hrComp: TestActor;
  let hrApprove: TestActor;
  let issuer: TestActor;
  let reader: TestActor;
  let bIssuer: TestActor;
  let employee: TestActor;
  let joining: string;
  let requisitionId: string;

  const COMPENSATION: PermissionKey[] = ['offer.read.compensation', 'offer.manage.compensation', 'offer.approve.compensation'];
  const ISSUE: PermissionKey[] = ['offer.read.compensation', 'offer.issue_letter.compensation'];
  const OFFER_BODY =
    'Dear {{candidateName}} ({{candidateCode}}),\nWe offer you the post of {{jobTitle}} ({{designation}}, {{department}}, {{location}}), {{employmentType}}, from {{proposedJoiningDate}}.\n' +
    'Annual CTC: {{currencyCode}} {{annualCtc}}. Monthly gross: {{monthlyGross}}.\nOffer revision {{offerRevision}} of {{requisitionCode}}, {{companyName}} ({{companyCode}}), {{letterDate}}.';

  const offer = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/hiring/offers/${id}`)).json();
  const setOfferList = (users: TestActor[]) => h.call(w.hr, 'PUT', '/v1/workflows/hiring_offer/fallback-reviewers', { reviewers: users.map((u, i) => ({ userId: u.user, priority: i + 1 })) });
  const move = async (applicationId: string, toStage: string) => {
    const current = (await h.call(recruiter, 'GET', `/v1/hiring/applications/${applicationId}`)).json();
    expect((await h.call(recruiter, 'POST', `/v1/hiring/applications/${applicationId}/stage`, { toStage, expectedVersion: current.version })).statusCode).toBe(200);
  };
  const taskFor = async (a: TestActor, offerId: string) =>
    ((await h.call(a, 'GET', '/v1/hiring/offer-tasks')).json().items as { taskId: string; offer: { id: string } | null }[]).find((t) => t.offer?.id === offerId);
  const decide = (a: TestActor, taskId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/hiring/offer-tasks/${taskId}/decision`, { idempotencyKey: uniq('letter-key-'), ...body });
  const submit = (offerId: string) => offer(recruiter, offerId).then((o) => h.call(recruiter, 'POST', `/v1/hiring/offers/${offerId}/submit`, { expectedVersion: o.version }));
  const price = async (offerId: string, amounts: Record<string, string>) => {
    const res = await h.call(hrComp, 'PUT', `/v1/hiring/offers/${offerId}/compensation`, { currencyCode: 'INR', ...amounts, expectedVersion: (await offer(hrComp, offerId)).version });
    expect(res.statusCode, res.body).toBe(200);
  };
  /** A draft offer for a new synthetic candidate at the OFFER stage. */
  const draftOffer = async (fullName: string) => {
    const c = (await h.call(recruiter, 'POST', '/v1/hiring/candidates', { fullName, sourceCode: 'DIRECT', consentStatus: 'GIVEN', consentRecordedOn: w.today })).json();
    const app = (await h.call(recruiter, 'POST', `/v1/hiring/requisitions/${requisitionId}/applications`, { candidateId: c.id })).json();
    for (const stage of ['SCREENING', 'INTERVIEW', 'OFFER']) await move(app.id, stage);
    const o = await h.call(recruiter, 'POST', `/v1/hiring/applications/${app.id}/offers`, { proposedJoiningDate: joining });
    expect(o.statusCode, o.body).toBe(201);
    return { offerId: o.json().id as string, candidateCode: c.candidateCode as string };
  };
  const approve = async (offerId: string) => {
    expect((await submit(offerId)).json().state).toBe('SUBMITTED');
    expect((await decide(hrApprove, (await taskFor(hrApprove, offerId))!.taskId, { decision: 'APPROVE' })).json().state).toBe('APPROVED');
  };
  const template = async (code: string, letterType: string, body: string, optionalPlaceholders: string[] = []) => {
    const created = await h.call(w.hr, 'POST', '/v1/letter-templates', { code, name: `${code} (synthetic)`, letterType, body, optionalPlaceholders });
    expect(created.statusCode, created.body).toBe(201);
    const draft = created.json().revisions[0];
    const published = await h.call(w.hr, 'POST', `/v1/letter-templates/${created.json().id}/publish`, { revision: draft.revision, expectedVersion: draft.version });
    expect(published.statusCode, published.body).toBe(200);
  };
  const preview = (a: TestActor, offerId: string, templateCode: string) => h.call(a, 'POST', `/v1/hiring/offers/${offerId}/letter-preview`, { templateCode });
  const generate = (a: TestActor, offerId: string, templateCode: string, idempotencyKey?: string) =>
    h.call(a, 'POST', `/v1/hiring/offers/${offerId}/letters`, { templateCode, ...(idempotencyKey ? { idempotencyKey } : {}) });
  const deliver = (a: TestActor, letterId: string, body: Record<string, unknown>) =>
    h.call(a, 'POST', `/v1/hiring/offer-letters/${letterId}/delivery`, { deliveryMethod: 'IN_PERSON', deliveredOn: w.today, recipientConfirmed: true, ...body });

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    w = await hiringWorld(h, A);
    recruiter = await h.actor(A, 'RECRUITER');
    hrComp = await h.actor(A, 'HR_ADMINISTRATOR', { extra: COMPENSATION });
    hrApprove = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['offer.read.compensation', 'offer.approve.compensation'] });
    issuer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ISSUE });
    reader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['offer.read.compensation'] });
    bIssuer = await h.actor(B, 'HR_ADMINISTRATOR', { extra: ISSUE });
    employee = await h.actor(A, 'EMPLOYEE', { employeeId: (await h.call(w.hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id });
    expect((await setOfferList([hrComp, hrApprove])).statusCode).toBe(200);
    joining = addDays(w.today, 40);
    requisitionId = (await approvedRequisition(h, A, w, { title: 'Synthetic Analyst', vacancies: 5 })).id;
    await template('OFFER_STD', 'OFFER', OFFER_BODY, ['monthlyGross']);
    await template('OFFER_STRICT', 'OFFER', OFFER_BODY);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('FR-017: an OFFER template uses only the offer placeholders (no employee or exit value), and no other letter type may use them', async () => {
    const listed = (await h.call(w.hr, 'GET', '/v1/letter-placeholders?letterType=OFFER')).json().items.map((p: { key: string }) => p.key);
    expect(listed).toEqual(expect.arrayContaining(['candidateName', 'annualCtc', 'monthlyGross', 'proposedJoiningDate', 'companyName', 'letterDate']));
    expect(listed).not.toContain('employeeName');
    expect(listed).not.toContain('lastWorkingDate');
    const asOffer = await h.call(w.hr, 'POST', '/v1/letter-templates', { code: 'OFFER_BAD', name: 'x', letterType: 'OFFER', body: 'Dear {{employeeName}}' });
    expect(asOffer.json()).toMatchObject({ error: 'UNKNOWN_PLACEHOLDER', details: { placeholders: ['employeeName'] } });
    const asTransfer = await h.call(w.hr, 'POST', '/v1/letter-templates', { code: 'TRANSFER_BAD', name: 'x', letterType: 'TRANSFER', body: 'Your CTC is {{annualCtc}}' });
    expect(asTransfer.json()).toMatchObject({ error: 'UNKNOWN_PLACEHOLDER', details: { placeholders: ['annualCtc'] } });
  });

  it('FR-014 / FR-017: no letter for an offer whose values are not approved yet (no invented pay figures)', async () => {
    const { offerId } = await draftOffer('Synthetic Draft Candidate');
    expect((await preview(issuer, offerId, 'OFFER_STD')).json()).toMatchObject({ error: 'OFFER_NOT_APPROVED', details: { state: 'DRAFT' } });
    await price(offerId, { annualCtc: '612345.67' });
    expect((await submit(offerId)).json().state).toBe('SUBMITTED');
    expect((await preview(issuer, offerId, 'OFFER_STD')).json()).toMatchObject({ error: 'OFFER_NOT_APPROVED', details: { state: 'SUBMITTED' } });
    expect((await generate(issuer, offerId, 'OFFER_STD')).json().error).toBe('OFFER_NOT_APPROVED');
  });

  it('FR-017: the letter substitutes the approved offer values; a missing mandatory placeholder blocks the final output; a preview stores and sends nothing', async () => {
    const { offerId, candidateCode } = await draftOffer('Synthetic Asha Candidate');
    await price(offerId, { annualCtc: '612345.67' });
    await approve(offerId);
    const shown = await preview(issuer, offerId, 'OFFER_STD');
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.json()).toMatchObject({ offerRevision: 1, templateCode: 'OFFER_STD', ready: true, missing: [], sent: false });
    const text = shown.json().text as string;
    expect(text).toContain(`Dear Synthetic Asha Candidate (${candidateCode})`);
    expect(text).toContain('Annual CTC: INR 612345.67.');
    expect(text).toContain(`from ${joining}`);
    expect(text).toContain('Synthetic Analyst');
    // The monthly gross was never approved: an optional placeholder renders empty, never a typed or zero figure.
    expect(text).toContain('Monthly gross: .');
    expect((await h.call(issuer, 'GET', `/v1/hiring/offers/${offerId}/letters`)).json().items).toEqual([]);
    // The same value is mandatory in the strict template: the final output is refused.
    expect((await preview(issuer, offerId, 'OFFER_STRICT')).json()).toMatchObject({ ready: false, missing: ['monthlyGross'] });
    expect((await generate(issuer, offerId, 'OFFER_STRICT')).json()).toMatchObject({ error: 'MISSING_PLACEHOLDER', details: { missing: ['monthlyGross'] } });
    expect((await h.call(issuer, 'GET', `/v1/hiring/offers/${offerId}/letters`)).json().items).toEqual([]);
  });

  it('FR-017: the rendered letter stores the template version, offer revision and generator identity; a retry with its key returns the same output', async () => {
    const { offerId } = await draftOffer('Synthetic Bharat Candidate');
    await price(offerId, { annualCtc: '700000.10', monthlyGross: '50000.20' });
    await approve(offerId);
    const key = uniq('offer-letter-');
    const created = await generate(issuer, offerId, 'OFFER_STRICT', key);
    expect(created.statusCode, created.body).toBe(201);
    const letter = created.json();
    expect(letter).toMatchObject({ offerId, offerRevision: 1, templateCode: 'OFFER_STRICT', templateRevision: 1, outputNumber: 1, generatedBy: issuer.user, deliveryState: 'NOT_DELIVERED', replayed: false });
    const row = await h.one<{ generated_assignment_id: string; template_revision: number }>(`select generated_assignment_id, template_revision from hiring_offer_letter where id = $1`, [letter.id]);
    expect(row).toEqual({ generated_assignment_id: issuer.assignment, template_revision: 1 });
    const replay = await generate(issuer, offerId, 'OFFER_STRICT', key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: letter.id, replayed: true });
    // The stored text is the exact rendering of the approved values, downloaded in-app (DF09).
    const content = await h.call(reader, 'GET', `/v1/hiring/offer-letters/${letter.id}/content`);
    expect(content.statusCode, content.body).toBe(200);
    expect(content.body).toContain('Annual CTC: INR 700000.10. Monthly gross: 50000.20.');
    // A regeneration is a new output with the next number.
    expect((await generate(issuer, offerId, 'OFFER_STRICT')).json()).toMatchObject({ outputNumber: 2 });
    // Audit keeps identifiers and checksums, never a value of the letter.
    const audits = await h.db.query<{ v: string }>(`select coalesce(after_values::text, '') as v from audit_event where company_id = $1 and resource_code = 'hiring_offer_letter'`, [A.id]);
    expect(audits.rows.length).toBeGreaterThan(0);
    for (const a of audits.rows) expect(a.v).not.toMatch(/700000|50000\.2|Bharat/);
  });

  it('DF02 / F1: issuing needs the confidential issue grant on an eligible Admin, reading the compensation grant, within the company', async () => {
    const { offerId } = await draftOffer('Synthetic Chitra Candidate');
    await price(offerId, { annualCtc: '650000.00', monthlyGross: '45000.00' });
    await approve(offerId);
    for (const a of [recruiter, w.hr, reader, employee]) {
      expect((await preview(a, offerId, 'OFFER_STD')).statusCode).toBe(403);
      expect((await generate(a, offerId, 'OFFER_STD')).statusCode).toBe(403);
    }
    expect((await preview(bIssuer, offerId, 'OFFER_STD')).statusCode).toBe(404);
    const letter = (await generate(issuer, offerId, 'OFFER_STD')).json();
    for (const a of [recruiter, w.hr, employee]) {
      expect((await h.call(a, 'GET', `/v1/hiring/offers/${offerId}/letters`)).statusCode).toBe(403);
      expect((await h.call(a, 'GET', `/v1/hiring/offer-letters/${letter.id}/content`)).statusCode).toBe(403);
    }
    expect((await h.call(bIssuer, 'GET', `/v1/hiring/offer-letters/${letter.id}/content`)).statusCode).toBe(404);
    expect((await h.call(reader, 'GET', `/v1/hiring/offers/${offerId}/letters`)).json().items).toHaveLength(1);
    expect((await deliver(reader, letter.id, {})).statusCode).toBe(403);
  });

  it('FR-018 / DF09: the system never sends the letter; delivery outside it is recorded once, with method, date and the confirmed recipient', async () => {
    const { offerId } = await draftOffer('Synthetic Deepa Candidate');
    await price(offerId, { annualCtc: '640000.00', monthlyGross: '44000.00' });
    await approve(offerId);
    const letter = (await generate(issuer, offerId, 'OFFER_STD')).json();
    // Nothing queued for any channel: no outbox event names the letter.
    expect((await h.one<{ n: number }>(`select count(*)::int as n from outbox_event where company_id = $1 and aggregate_id = $2`, [A.id, letter.id])).n).toBe(0);
    expect((await deliver(issuer, letter.id, { recipientConfirmed: false })).json().error).toBe('RECIPIENT_NOT_CONFIRMED');
    expect((await deliver(issuer, letter.id, { deliveryMethod: 'EMAIL' })).json()).toMatchObject({ error: 'INVALID_REFERENCE' });
    expect((await deliver(issuer, letter.id, { deliveredOn: addDays(w.today, 1) })).json()).toMatchObject({ error: 'INVALID_DATE', details: { field: 'deliveredOn' } });
    expect((await deliver(issuer, letter.id, { deliveredOn: addDays(w.today, -1) })).json()).toMatchObject({ error: 'INVALID_DATE', details: { field: 'deliveredOn' } });
    const delivered = await deliver(issuer, letter.id, {});
    expect(delivered.statusCode, delivered.body).toBe(200);
    expect(delivered.json()).toMatchObject({ deliveryState: 'DELIVERED', deliveryMethod: 'IN_PERSON', deliveredOn: w.today });
    expect((await deliver(issuer, letter.id, {})).json().error).toBe('ALREADY_DELIVERED');
    const listed = (await h.call(reader, 'GET', `/v1/hiring/offers/${offerId}/letters`)).json().items[0];
    expect(listed).toMatchObject({ deliveryState: 'DELIVERED', delivery: { method: 'IN_PERSON', deliveredOn: w.today, recordedBy: issuer.user } });
  });

  it('FR-018: once the offer is withdrawn its letter can no longer be recorded as delivered, nor a new one issued', async () => {
    const { offerId } = await draftOffer('Synthetic Esha Candidate');
    await price(offerId, { annualCtc: '630000.00', monthlyGross: '43000.00' });
    await approve(offerId);
    const letter = (await generate(issuer, offerId, 'OFFER_STD')).json();
    expect((await h.call(recruiter, 'POST', `/v1/hiring/offers/${offerId}/withdraw`, { reason: 'Synthetic: position re-scoped' })).json().state).toBe('WITHDRAWN');
    expect((await deliver(issuer, letter.id, {})).json()).toMatchObject({ error: 'OFFER_NOT_APPROVED', details: { state: 'WITHDRAWN' } });
    expect((await generate(issuer, offerId, 'OFFER_STD')).json().error).toBe('OFFER_NOT_APPROVED');
    expect((await h.call(reader, 'GET', `/v1/hiring/offers/${offerId}/letters`)).json().items[0]).toMatchObject({ current: false, deliveryState: 'NOT_DELIVERED' });
  });

  it('FR-014 (0190 guard): the database refuses a letter of a superseded revision, a non-offer template, and any change to a stored or delivered letter', async () => {
    // An offer returned once and approved on its second revision: revision 1 exists but is superseded.
    const { offerId } = await draftOffer('Synthetic Farid Candidate');
    await price(offerId, { annualCtc: '620000.00', monthlyGross: '42000.00' });
    expect((await submit(offerId)).json().state).toBe('SUBMITTED');
    expect((await decide(hrApprove, (await taskFor(hrApprove, offerId))!.taskId, { decision: 'RETURN', reason: 'Synthetic: recheck the date' })).json().state).toBe('DRAFT');
    await approve(offerId);
    expect((await offer(recruiter, offerId)).currentRevision).toBe(2);
    const letter = (await generate(issuer, offerId, 'OFFER_STD')).json();
    expect(letter.offerRevision).toBe(2);
    const stored = await h.one<Record<string, unknown>>(`select * from hiring_offer_letter where id = $1`, [letter.id]);
    let next = 98;
    const copy = async (changes: Record<string, unknown>) => {
      // A fresh attachment and number, so nothing but the guard can refuse the copy.
      const attachment = await h.one<{ id: string }>(
        `insert into attachment (company_id, owner_user_id, content_reference, media_type, checksum, classification, file_name, byte_size, created_by, updated_by)
         select company_id, owner_user_id, content_reference, media_type, checksum, classification, file_name, byte_size, created_by, updated_by from attachment where id = $1 returning id`,
        [stored.attachment_id],
      );
      next += 1;
      const row = { ...stored, id: undefined, idempotency_key: null, output_number: next, attachment_id: attachment.id, ...changes } as Record<string, unknown>;
      const cols = Object.keys(row).filter((k) => row[k] !== undefined);
      return h.db.query(`insert into hiring_offer_letter (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((c) => row[c])).then(
        () => null,
        (e: { message: string }) => e.message,
      );
    };
    // Control: the same copy on the current revision is accepted, so the refusal below is the revision rule alone.
    expect(await copy({})).toBeNull();
    expect(await copy({ offer_revision: 1 })).toMatch(/current revision of an approved or accepted offer/);
    await template('TRANSFER_GUARD', 'TRANSFER', 'Dear {{employeeName}}, issued {{letterDate}}.');
    const transfer = await h.one<{ id: string; code: string; revision_id: string; revision: number }>(
      `select t.id, t.code, r.id as revision_id, r.revision from letter_template t join letter_template_revision r on r.company_id = t.company_id and r.template_id = t.id
        where t.company_id = $1 and t.code = 'TRANSFER_GUARD'`,
      [A.id],
    );
    expect(await copy({ template_id: transfer.id, template_code: transfer.code, template_revision_id: transfer.revision_id, template_revision: transfer.revision })).toMatch(/OFFER letter template/);
    const tamper = await h.db.query(`update hiring_offer_letter set checksum = repeat('0', 64) where id = $1`, [letter.id]).then(() => null, (e: { message: string }) => e.message);
    expect(tamper).toMatch(/immutable/);
    expect((await deliver(issuer, letter.id, {})).statusCode).toBe(200);
    const undo = await h.db.query(`update hiring_offer_letter set delivery_state = 'NOT_DELIVERED', delivery_method_id = null, delivered_on = null, delivery_recorded_by = null, delivery_assignment_id = null, delivery_recorded_at = null where id = $1`, [letter.id]).then(() => null, (e: { message: string }) => e.message);
    expect(undo).toMatch(/final/);
  });

  it('FR-017: an offer letter template is issued only from the offer, and an offer issues only offer templates', async () => {
    await template('TRANSFER_STD', 'TRANSFER', 'Dear {{employeeName}}, your post is {{designation}} from {{letterDate}}.');
    const { offerId } = await draftOffer('Synthetic Gita Candidate');
    await price(offerId, { annualCtc: '610000.00', monthlyGross: '41000.00' });
    await approve(offerId);
    expect((await preview(issuer, offerId, 'TRANSFER_STD')).json().error).toBe('NOT_AN_OFFER_TEMPLATE');
    // An employee process refuses the OFFER template (the letter comes from the approved offer, not employee data).
    const hrLetters = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_LETTERS });
    const emp = await person(h, A, w.hr, { name: 'Synthetic Process Person' });
    await processTemplate(h, w.hr, 'OFFER_LETTERS', 'ONBOARDING', [{ code: 'ISSUE', title: 'Issue letter', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 0, evidenceRequired: false }]);
    const processId = (await h.call(w.hr, 'POST', `/v1/employees/${emp}/processes`, { processCode: 'OFFER_LETTERS' })).json().id;
    expect((await h.call(hrLetters, 'POST', `/v1/employee-processes/${processId}/letters/preview`, { templateCode: 'OFFER_STD' })).json().error).toBe('OFFER_TEMPLATE');
    expect((await h.call(hrLetters, 'POST', `/v1/employee-processes/${processId}/letters`, { templateCode: 'OFFER_STD' })).json().error).toBe('OFFER_TEMPLATE');
    expect((await h.call(hrLetters, 'POST', `/v1/employee-processes/${processId}/letters/preview`, { templateCode: 'TRANSFER_STD' })).statusCode).toBe(200);
  });

  it('FR-014: the delivery list is a company list HR maintains (OFFER_LETTER_DELIVERY), served to the issuer only', async () => {
    const choices = await h.call(issuer, 'GET', '/v1/hiring/reference-values?category=OFFER_LETTER_DELIVERY');
    expect(choices.statusCode, choices.body).toBe(200);
    expect(choices.json().items.map((i: { code: string }) => i.code).sort()).toEqual(['IN_PERSON', 'POST']);
    expect((await h.call(recruiter, 'GET', '/v1/hiring/reference-values?category=OFFER_LETTER_DELIVERY')).statusCode).toBe(403);
  });
});
