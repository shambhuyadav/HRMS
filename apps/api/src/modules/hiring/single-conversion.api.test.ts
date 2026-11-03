// One candidate becomes one employee (FR-014, FR-013; 0113): over two requisitions, through a retired duplicate record,
// at the same moment, and through the database directly. A rehire after separation stays possible. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';
import { addDays, approvedRequisition, type HiringWorld, hiringWorld } from './test-fixtures.js';

describe.runIf(isModuleActive('hiring'))('hiring: one candidate, one employee (FR-014, FR-013)', () => {
  let h: Harness;
  let A: Company;
  let w: HiringWorld;
  let recruiter: TestActor;
  let hrComp: TestActor;
  let hrApprove: TestActor;
  let hrContact: TestActor;
  let joining: string;

  const candidate = async (fullName: string) =>
    (await h.call(recruiter, 'POST', '/v1/hiring/candidates', { fullName, sourceCode: 'DIRECT', consentStatus: 'GIVEN', consentRecordedOn: w.today })).json().id as string;
  const offerVersion = async (offerId: string) => (await h.call(recruiter, 'GET', `/v1/hiring/offers/${offerId}`)).json().version as number;

  /** An approved offer for the candidate on a new approved requisition, reached through the real route. */
  const approvedOffer = async (candidateId: string) => {
    const r = await approvedRequisition(h, A, w, { title: `Synthetic role ${uniq('r')}` });
    const app = (await h.call(recruiter, 'POST', `/v1/hiring/requisitions/${r.id}/applications`, { candidateId })).json();
    for (const toStage of ['SCREENING', 'INTERVIEW', 'OFFER']) {
      const current = (await h.call(recruiter, 'GET', `/v1/hiring/applications/${app.id}`)).json();
      expect((await h.call(recruiter, 'POST', `/v1/hiring/applications/${app.id}/stage`, { toStage, expectedVersion: current.version })).statusCode).toBe(200);
    }
    const created = await h.call(recruiter, 'POST', `/v1/hiring/applications/${app.id}/offers`, { proposedJoiningDate: joining });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const priced = await h.call(hrComp, 'PUT', `/v1/hiring/offers/${id}/compensation`, { currencyCode: 'INR', annualCtc: '900000.33', expectedVersion: await offerVersion(id) });
    expect(priced.statusCode, priced.body).toBe(200);
    expect((await h.call(recruiter, 'POST', `/v1/hiring/offers/${id}/submit`, { expectedVersion: await offerVersion(id) })).json().state).toBe('SUBMITTED');
    const tasks = (await h.call(hrApprove, 'GET', '/v1/hiring/offer-tasks')).json().items as { taskId: string; offer: { id: string } | null }[];
    const decided = await h.call(hrApprove, 'POST', `/v1/hiring/offer-tasks/${tasks.find((t) => t.offer?.id === id)!.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('single-key-') });
    expect(decided.json().state).toBe('APPROVED');
    return { id, requisitionId: r.id, applicationId: app.id as string };
  };
  const respond = async (offerId: string, response: 'ACCEPTED' | 'DECLINED') =>
    h.call(recruiter, 'POST', `/v1/hiring/offers/${offerId}/response`, { response, respondedOn: w.today, expectedVersion: await offerVersion(offerId) });
  const handOver = (offerId: string) => h.call(w.hr, 'POST', `/v1/hiring/offers/${offerId}/handover`, { employeeCode: uniq('HIRE-'), workEmail: `${uniq('hire')}@example.test` });
  const withdraw = (offerId: string) => h.call(recruiter, 'POST', `/v1/hiring/offers/${offerId}/withdraw`, { reason: 'Synthetic: the other offer stands' });
  const stateOf = async (offerId: string) => (await h.call(recruiter, 'GET', `/v1/hiring/offers/${offerId}`)).json().state as string;
  const employeesFrom = async (candidateIds: string[]) => (await h.one<{ n: number }>(`select count(*)::int as n from hiring_handover where candidate_id = any($1::uuid[])`, [candidateIds])).n;

  /** Two candidate records flagged as the same person by a shared synthetic email, and the open flag. */
  const flaggedPair = async () => {
    const [first, second] = [await candidate('Synthetic Record One'), await candidate('Synthetic Record Two')];
    const email = `${uniq('same.person')}@example.test`;
    expect((await h.call(hrContact, 'PUT', `/v1/hiring/candidates/${first}/contact`, { email })).statusCode).toBe(200);
    const flagged = await h.call(hrContact, 'PUT', `/v1/hiring/candidates/${second}/contact`, { email });
    expect(flagged.statusCode, flagged.body).toBe(200);
    return { first, second, flagId: flagged.json().duplicateFlags[0].flagId as string };
  };
  const confirmDuplicate = async (flagId: string, retireCandidateId: string) => {
    const res = await h.call(recruiter, 'POST', `/v1/hiring/duplicate-flags/${flagId}/resolve`, { resolution: 'CONFIRMED_DUPLICATE', retireCandidateId, note: 'Synthetic: same person' });
    expect(res.statusCode, res.body).toBe(200);
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    w = await hiringWorld(h, A);
    recruiter = await h.actor(A, 'RECRUITER');
    hrComp = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['offer.read.compensation', 'offer.manage.compensation', 'offer.approve.compensation'] });
    hrApprove = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['offer.read.compensation', 'offer.approve.compensation'] });
    hrContact = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['candidate.read.contact', 'candidate.manage.contact'] });
    expect((await h.call(w.hr, 'PUT', '/v1/workflows/hiring_offer/fallback-reviewers', { reviewers: [{ userId: hrApprove.user, priority: 1 }] })).statusCode).toBe(200);
    joining = addDays(w.today, 40);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('refuses a second acceptance across requisitions; the second offer can still be declined, and is free again once the first is withdrawn', async () => {
    const c = await candidate('Synthetic Two Offers');
    const [one, two, three] = [await approvedOffer(c), await approvedOffer(c), await approvedOffer(c)];
    expect((await respond(one.id, 'ACCEPTED')).json().state).toBe('ACCEPTED');

    const refused = await respond(two.id, 'ACCEPTED');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('CANDIDATE_OFFER_ACCEPTED');
    // The refusal names the reason, not the other record: it may lie outside the caller's scope.
    expect(refused.body).not.toContain(one.id);
    expect(await stateOf(two.id)).toBe('APPROVED');

    expect((await respond(three.id, 'DECLINED')).json().state).toBe('DECLINED');

    expect((await withdraw(one.id)).json().state).toBe('WITHDRAWN');
    expect((await respond(two.id, 'ACCEPTED')).json().state).toBe('ACCEPTED');
    expect((await handOver(two.id)).statusCode).toBe(201);
    expect(await employeesFrom([c])).toBe(1);
  });

  it('accepts only one of two offers recorded at the same moment', async () => {
    const c = await candidate('Synthetic Simultaneous');
    const [one, two] = [await approvedOffer(c), await approvedOffer(c)];
    const [v1, v2] = [await offerVersion(one.id), await offerVersion(two.id)];
    // This connection holds the conversion lock, so both recordings stand at it together and the race is not left to timing.
    const lockKey = [`hiring:conversion:${A.id}`];
    await h.db.query(`select pg_advisory_lock(hashtextextended($1, 0))`, lockKey);
    const answers = Promise.all(
      [
        { id: one.id, expectedVersion: v1 },
        { id: two.id, expectedVersion: v2 },
      ].map((o) => h.call(recruiter, 'POST', `/v1/hiring/offers/${o.id}/response`, { response: 'ACCEPTED', respondedOn: w.today, expectedVersion: o.expectedVersion })),
    );
    const early = await Promise.race([answers.then(() => 'ANSWERED'), new Promise((resolve) => setTimeout(() => resolve('WAITING'), 500))]);
    await h.db.query(`select pg_advisory_unlock(hashtextextended($1, 0))`, lockKey);
    const results = await answers;
    expect(early).toBe('WAITING');
    expect(results.map((r) => r.statusCode).sort(), results.map((r) => r.body).join(' ')).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().error).toBe('CANDIDATE_OFFER_ACCEPTED');
    expect([await stateOf(one.id), await stateOf(two.id)].sort()).toEqual(['ACCEPTED', 'APPROVED']);
  });

  it('refuses both acceptance and handover once the person is an employee, until that employment ended (a rehire stays possible)', async () => {
    const c = await candidate('Synthetic Hired Once');
    const [first, second] = [await approvedOffer(c), await approvedOffer(c)];
    expect((await respond(first.id, 'ACCEPTED')).statusCode).toBe(200);
    const done = await handOver(first.id);
    expect(done.statusCode, done.body).toBe(201);
    const employeeId = done.json().employeeId as string;

    // The employee is a DRAFT, then active: both are a current employment.
    expect((await respond(second.id, 'ACCEPTED')).json().error).toBe('CANDIDATE_ALREADY_EMPLOYED');
    await h.setStatus(A, employeeId, 'ACTIVE_CONFIRMED');
    expect((await respond(second.id, 'ACCEPTED')).json().error).toBe('CANDIDATE_ALREADY_EMPLOYED');
    await h.setStatus(A, employeeId, 'NOTICE');
    expect((await respond(second.id, 'ACCEPTED')).json().error).toBe('CANDIDATE_ALREADY_EMPLOYED');
    expect(await stateOf(second.id)).toBe('APPROVED');

    await h.setStatus(A, employeeId, 'INACTIVE_SEPARATED');
    expect((await respond(second.id, 'ACCEPTED')).json().state).toBe('ACCEPTED');
    const rehired = await handOver(second.id);
    expect(rehired.statusCode, rehired.body).toBe(201);
    expect(rehired.json().employeeId).not.toBe(employeeId);
    expect(await employeesFrom([c])).toBe(2);
  });

  it('a retired duplicate of someone already hired cannot convert, and neither can the surviving record of a retired hire', async () => {
    // The hired record stays; the duplicate is retired with its approved offer.
    const kept = await flaggedPair();
    const [hired, spare] = [await approvedOffer(kept.first), await approvedOffer(kept.second)];
    expect((await respond(hired.id, 'ACCEPTED')).statusCode).toBe(200);
    expect((await handOver(hired.id)).statusCode).toBe(201);
    await confirmDuplicate(kept.flagId, kept.second);
    expect((await respond(spare.id, 'ACCEPTED')).json().error).toBe('CANDIDATE_NOT_ACTIVE');

    // The hired record itself is the one retired: the surviving record is still the same person.
    const swapped = await flaggedPair();
    const [hiredRecord, survivor] = [await approvedOffer(swapped.first), await approvedOffer(swapped.second)];
    expect((await respond(hiredRecord.id, 'ACCEPTED')).statusCode).toBe(200);
    expect((await handOver(hiredRecord.id)).statusCode).toBe(201);
    await confirmDuplicate(swapped.flagId, swapped.first);
    expect((await respond(survivor.id, 'ACCEPTED')).json().error).toBe('CANDIDATE_ALREADY_EMPLOYED');
    expect(await employeesFrom([swapped.first, swapped.second])).toBe(1);
  });

  it('an offer accepted before its record was retired is refused at handover, and the other record waits until one offer is withdrawn', async () => {
    const pair = await flaggedPair();
    const [onRetired, onKept] = [await approvedOffer(pair.second), await approvedOffer(pair.first)];
    expect((await respond(onRetired.id, 'ACCEPTED')).json().state).toBe('ACCEPTED');
    await confirmDuplicate(pair.flagId, pair.second);

    expect((await handOver(onRetired.id)).json().error).toBe('CANDIDATE_NOT_ACTIVE');
    expect((await respond(onKept.id, 'ACCEPTED')).json().error).toBe('CANDIDATE_OFFER_ACCEPTED');
    expect(await employeesFrom([pair.first, pair.second])).toBe(0);
    // Nothing was left behind by the refused handover.
    expect((await h.one<{ n: number }>(`select count(*)::int as n from employee where company_id = $1 and display_name = 'Synthetic Record Two'`, [A.id])).n).toBe(0);

    expect((await withdraw(onRetired.id)).json().state).toBe('WITHDRAWN');
    expect((await respond(onKept.id, 'ACCEPTED')).json().state).toBe('ACCEPTED');
    expect((await handOver(onKept.id)).statusCode).toBe(201);
    expect(await employeesFrom([pair.first, pair.second])).toBe(1);
  });

  it('follows confirmed duplicate reviews over several steps; a review answered "not a duplicate" links nothing', async () => {
    const left = await flaggedPair();
    const right = await flaggedPair();
    // left.first ~ left.second ~ right.first (a shared phone), right.second stays apart.
    const phone = `+91 90000${String(Date.now()).slice(-5)}`;
    expect((await h.call(hrContact, 'PUT', `/v1/hiring/candidates/${left.second}/contact`, { phone })).statusCode).toBe(200);
    const chained = await h.call(hrContact, 'PUT', `/v1/hiring/candidates/${right.first}/contact`, { phone });
    expect(chained.statusCode, chained.body).toBe(200);
    await confirmDuplicate(left.flagId, left.first);
    await confirmDuplicate(chained.json().duplicateFlags[0].flagId, right.first);
    const notDuplicate = await h.call(recruiter, 'POST', `/v1/hiring/duplicate-flags/${right.flagId}/resolve`, { resolution: 'NOT_DUPLICATE', note: 'Synthetic: a shared mailbox' });
    expect(notDuplicate.statusCode).toBe(200);

    // left.second, the only record of the chain left ACTIVE, is hired. right.second was reviewed as someone else, so it is free.
    const [survivor, separate] = [await approvedOffer(left.second), await approvedOffer(right.second)];
    expect((await respond(survivor.id, 'ACCEPTED')).statusCode).toBe(200);
    expect((await handOver(survivor.id)).statusCode).toBe(201);
    expect((await respond(separate.id, 'ACCEPTED')).json().state).toBe('ACCEPTED');

    const identity = await h.db.query<{ candidate_id: string }>(`select candidate_id from hrms_candidate_identity($1, $2)`, [A.id, left.second]);
    expect(identity.rows.map((r) => r.candidate_id).sort()).toEqual([left.first, left.second, right.first].sort());
  });

  it('the database refuses a second conversion on any path (0113)', async () => {
    const c = await candidate('Synthetic Direct Writes');
    const [one, two] = [await approvedOffer(c), await approvedOffer(c)];
    expect((await respond(one.id, 'ACCEPTED')).statusCode).toBe(200);
    const accept = `update hiring_offer set state = 'ACCEPTED', candidate_response_on = current_date, response_recorded_by = decided_by where id = $1`;
    await expect(h.db.query(accept, [two.id])).rejects.toMatchObject({ code: '23514' });
    expect(await stateOf(two.id)).toBe('APPROVED');

    // A record that is not ACTIVE takes no acceptance, nor a handover of an offer accepted earlier.
    const inactive = await candidate('Synthetic Inactive');
    const third = await approvedOffer(inactive);
    await h.db.query(`update candidate set state = 'INACTIVE' where id = $1`, [inactive]);
    await expect(h.db.query(accept, [third.id])).rejects.toMatchObject({ code: '23514' });
    expect((await respond(third.id, 'ACCEPTED')).json().error).toBe('CANDIDATE_NOT_ACTIVE');

    // A handover row cannot appear for an offer whose person already holds another accepted offer.
    await h.db.query('begin');
    try {
      const employee = await h.one<{ id: string }>(`select id from employee where company_id = $1 limit 1`, [A.id]);
      await expect(
        h.db.query(
          `insert into hiring_handover (company_id, offer_id, application_id, requisition_id, candidate_id, employee_id, handed_over_by, acting_assignment_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [A.id, two.id, two.applicationId, two.requisitionId, c, employee.id, w.hr.user, w.hr.assignment],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await h.db.query('rollback');
    }
  });
});
