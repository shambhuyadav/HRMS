// Exit separation types (FR-051, FR-052, FR-055; I-88 item 8; decided under owner delegation, 6 Nov 2026, docs/03 I-89 item 7; 0242):
// retirement, termination, death, disablement and end of contract are HR's entries only, each with one verified document; each
// type's date rule, fixed date and (for a termination) required ground; only a resignation is withdrawn; a death ends the own
// self-service and is never notified to it or delivered to it; the settlement recovers notice only for a resignation and a death is
// gratuity-eligible whatever the service. Synthetic people, documents and dates only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { dispatchOutbox, fanOut } from '../notification/dispatcher.js';
import { DOCUMENTS, evidenceDocument, VERIFY_DOCUMENTS } from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';
import { separateDueExits } from './exit.js';
import { addDays, HR_SETTLEMENT, key, person, publishedTemplate, statusOf, today as businessDate } from './lifecycle.fixtures.js';

describe.runIf(isModuleActive('lifecycle'))('exit separation types (I-89 item 7)', () => {
  let h: Harness;
  let A: Company;
  let hrEntry: TestActor;
  let hr1: TestActor;
  let hr2: TestActor;
  let uploader: TestActor;
  let verifier: TestActor;
  let manager: TestActor;
  let managerEmp: string;
  let today: string;
  let letters: TestActor;
  const staff: Record<string, { emp: string; actor: TestActor }> = {};
  const letterOutputs: Record<string, string> = {};

  const enter = (a: TestActor, emp: string, body: Record<string, unknown>) =>
    h.call(a, 'POST', `/v1/employees/${emp}/separations`, { evidenceReference: 'Synthetic document reference', ...body });
  const doc = (emp: string, verify = true) => evidenceDocument(h, uploader, verifier, emp, { verify });
  const tasks = async (a: TestActor) => (await h.call(a, 'GET', '/v1/exit-cases/tasks/mine')).json().items as { taskId: string; kind: string; exitCase: { id: string } | null }[];
  const taskFor = async (a: TestActor, id: string) => (await tasks(a)).find((t) => t.kind === 'exit_case' && t.exitCase?.id === id);
  const recommend = async (id: string, date: string) => h.call(manager, 'POST', `/v1/exit-cases/tasks/${(await taskFor(manager, id))!.taskId}/recommend`, { recommendedLastWorkingDate: date, idempotencyKey: key() });
  const approve = async (id: string, body: Record<string, unknown> = {}) => {
    const approver = (await taskFor(hr1, id)) ? hr1 : hr2;
    return h.call(approver, 'POST', `/v1/exit-cases/tasks/${(await taskFor(approver, id))!.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: key(), ...body });
  };
  /** Entered by HR, recommended and approved on its own date; returns the exit case id. */
  const approvedSeparation = async (name: string, separationType: string, date: string, extra: Record<string, unknown> = {}) => {
    const s = staff[name]!;
    const created = await enter(hrEntry, s.emp, { separationType, proposedLastWorkingDate: date, evidenceDocumentIds: [await doc(s.emp)], ...extra });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().exitCaseId as string;
    expect((await recommend(id, date)).json().state).toBe('RECOMMENDED');
    const approved = await approve(id);
    expect(approved.json().state, approved.body).toBe('APPROVED');
    return id;
  };
  const inbox = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; title: string | null; body: string }[];

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hrEntry = await h.actor(A, 'HR_ADMINISTRATOR');
    hr1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['exit.read.reason'] });
    hr2 = await h.actor(A, 'HR_ADMINISTRATOR');
    uploader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCUMENTS });
    verifier = await h.actor(A, 'HR_ADMINISTRATOR', { extra: VERIFY_DOCUMENTS });
    managerEmp = await person(h, A, hrEntry, { name: 'Synthetic Separation Lead' });
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    for (const name of ['rules', 'retire', 'terminate', 'death', 'disable', 'contract', 'living']) {
      const emp = await person(h, A, hrEntry, { managerId: managerEmp, name: `Synthetic ${name} person` });
      staff[name] = { emp, actor: await h.actor(A, 'EMPLOYEE', { employeeId: emp }) };
    }
    expect((await h.call(hrEntry, 'PUT', '/v1/workflows/exit_case/fallback-reviewers', { reviewers: [{ userId: hr1.user, priority: 1 }, { userId: hr2.user, priority: 2 }] })).statusCode).toBe(200);
    await h.db.query(`insert into reference_value (company_id, category, code, label, active) values ($1, 'EXIT_REASON', 'SYN_MISCONDUCT', 'Misconduct (synthetic)', true)`, [A.id]);
    today = await businessDate(h, A);
    // A letter for two employees, generated while both are active, to be sent after one of them has died.
    letters = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['letter.generate.letter', 'letter.read.letter', 'letter.send.letter'] });
    await publishedTemplate(h, hrEntry, 'SYN_LETTERS', 'TRANSFER', [{ code: 'ISSUE', title: 'Issue letter', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 0, evidenceRequired: false }]);
    const template = await h.call(hrEntry, 'POST', '/v1/letter-templates', { code: 'SYN_NOTE', name: 'Synthetic note', letterType: 'TRANSFER', body: 'Dear {{employeeName}},\nSynthetic note.' });
    expect(template.statusCode, template.body).toBe(201);
    const draft = (await h.call(hrEntry, 'GET', `/v1/letter-templates/${template.json().id}`)).json().revisions.find((r: { state: string }) => r.state === 'DRAFT');
    expect((await h.call(hrEntry, 'POST', `/v1/letter-templates/${template.json().id}/publish`, { revision: draft.revision, expectedVersion: draft.version })).statusCode).toBe(200);
    for (const emp of [staff.death!.emp, staff.living!.emp]) {
      const process = await h.call(hrEntry, 'POST', `/v1/employees/${emp}/processes`, { processCode: 'SYN_LETTERS' });
      expect(process.statusCode, process.body).toBe(201);
      const output = await h.call(letters, 'POST', `/v1/employee-processes/${process.json().id}/letters`, { templateCode: 'SYN_NOTE' });
      expect(output.statusCode, output.body).toBe(201);
      letterOutputs[emp] = output.json().id as string;
    }
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('is HR’s entry only, with one verified document, under the exit management duty, never on one’s own record; the employee route stays a resignation', async () => {
    const s = staff.rules!;
    const date = addDays(today, 30);
    // The employee's own route is a resignation whatever is sent (an unknown field is dropped); the HR route takes no resignation.
    const own = await h.call(s.actor, 'POST', '/v1/me/resignation', { proposedLastWorkingDate: date, separationType: 'RETIREMENT' });
    expect(own.statusCode, own.body).toBe(201);
    expect(await h.one(`select separation_type, request_origin from exit_case where id = $1`, [own.json().exitCaseId])).toEqual({ separation_type: 'RESIGNATION', request_origin: 'EMPLOYEE' });
    expect((await h.call(s.actor, 'POST', `/v1/me/exit-cases/${own.json().exitCaseId}/withdraw`)).json().state).toBe('WITHDRAWN');
    expect((await enter(hrEntry, s.emp, { separationType: 'RESIGNATION', proposedLastWorkingDate: date, evidenceDocumentIds: [await doc(s.emp)] })).statusCode).toBe(400);
    // A manager does not hold the duty; the employee cannot enter one for themselves.
    expect((await enter(manager, s.emp, { separationType: 'RETIREMENT', proposedLastWorkingDate: date, evidenceDocumentIds: [await doc(s.emp)] })).statusCode).toBe(403);
    expect((await enter(s.actor, s.emp, { separationType: 'RETIREMENT', proposedLastWorkingDate: date, evidenceDocumentIds: [await doc(s.emp)] })).statusCode).toBe(403);
    // Evidence: one released and verified document of this employee.
    expect((await enter(hrEntry, s.emp, { separationType: 'DEATH', proposedLastWorkingDate: today, evidenceDocumentIds: [] })).statusCode).toBe(400);
    expect((await enter(hrEntry, s.emp, { separationType: 'DEATH', proposedLastWorkingDate: today, evidenceDocumentIds: [await doc(s.emp, false)] })).json().error).toBe('EVIDENCE_NOT_VERIFIED');
    expect((await enter(hrEntry, s.emp, { separationType: 'DEATH', proposedLastWorkingDate: today, evidenceDocumentIds: [await doc(staff.living!.emp)] })).json().error).toBe('INVALID_EVIDENCE');
    // A termination records its ground as an exit reason code.
    expect((await enter(hrEntry, s.emp, { separationType: 'TERMINATION', proposedLastWorkingDate: date, evidenceDocumentIds: [await doc(s.emp)] })).json().error).toBe('REASON_CODE_REQUIRED');
    expect(await h.one<{ n: number }>(`select count(*)::int as n from exit_case where employee_id = $1 and separation_type <> 'RESIGNATION'`, [s.emp])).toEqual({ n: 0 });
    // The database holds the origin and the ground for every writer.
    const evidence = await doc(s.emp);
    const insert = (type: string, origin: string, reason: string | null) =>
      h.db.query(
        `insert into exit_case (company_id, employee_id, transaction_id, separation_type, request_date, proposed_leaving_date, leaving_date, state, request_origin, entered_by,
                                evidence_document_id, evidence_reference, reason_code_id)
         values ($1, $2, gen_random_uuid(), $3, $4, $4, $4, 'SUBMITTED', $5, $6, $7, $8, (select id from reference_value where company_id = $1 and code = $9))`,
        [A.id, s.emp, type, date, origin, origin === 'HR' ? hrEntry.user : null, origin === 'HR' ? evidence : null, origin === 'HR' ? 'Synthetic ref' : null, reason],
      );
    await expect(insert('RETIREMENT', 'EMPLOYEE', null)).rejects.toMatchObject({ code: '23514', constraint: 'exit_case_type_origin' });
    await expect(insert('TERMINATION', 'HR', null)).rejects.toMatchObject({ code: '23514', constraint: 'exit_case_termination_ground' });
    await expect(insert('NOT_A_TYPE', 'HR', null)).rejects.toMatchObject({ code: '23514', constraint: 'exit_case_separation_type_check' });
  });

  it('applies each type’s date rule; an event’s own date is fixed through recommendation and approval, and may be past for a death; nothing reaches a deceased employee’s self-service', async () => {
    const s = staff.rules!;
    const enterOn = async (separationType: string, date: string) =>
      (await enter(hrEntry, s.emp, { separationType, proposedLastWorkingDate: date, evidenceDocumentIds: [await doc(s.emp)], ...(separationType === 'TERMINATION' ? { reasonCode: 'SYN_MISCONDUCT' } : {}) })).json();
    expect((await enterOn('RETIREMENT', addDays(today, -1))).error).toBe('INVALID_LAST_WORKING_DATE');
    expect((await enterOn('END_OF_CONTRACT', addDays(today, -1))).error).toBe('INVALID_LAST_WORKING_DATE');
    expect((await enterOn('TERMINATION', addDays(today, -1))).error).toBe('INVALID_LAST_WORKING_DATE');
    expect((await enterOn('DEATH', addDays(today, 1))).error).toBe('INVALID_LAST_WORKING_DATE');
    expect((await enterOn('DEATH', '2025-12-31')).error).toBe('INVALID_LAST_WORKING_DATE'); // before joining (5 Jan 2026)

    // A death recorded afterwards: the request date is the date of death, and nobody moves it.
    const d = staff.death!;
    const died = addDays(today, -3);
    const created = await enter(hrEntry, d.emp, { separationType: 'DEATH', proposedLastWorkingDate: died, evidenceDocumentIds: [await doc(d.emp)] });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ separationType: 'DEATH', requestDate: died, proposedLastWorkingDate: died, origin: 'HR' });
    const id = created.json().exitCaseId as string;
    // The database holds the event's date for every writer, too.
    await expect(h.db.query(`update exit_case set recommended_leaving_date = $2, leaving_date = $2, recommended_at = now() where id = $1`, [id, today])).rejects.toMatchObject({
      code: '23514',
      constraint: 'exit_case_event_date_fixed',
    });
    expect((await recommend(id, today)).json()).toMatchObject({ error: 'LAST_WORKING_DATE_FIXED' });
    expect((await recommend(id, died)).json().state).toBe('RECOMMENDED');
    // Whoever entered it never decides it.
    expect(await taskFor(hrEntry, id)).toBeUndefined();
    expect((await approve(id, { approvedLastWorkingDate: today })).json().error).toBe('LAST_WORKING_DATE_FIXED');
    expect((await approve(id)).json()).toMatchObject({ state: 'APPROVED', approvedLastWorkingDate: died });
    await expect(h.db.query(`update exit_case set approved_leaving_date = $2, leaving_date = $2 where id = $1`, [id, today])).rejects.toMatchObject({ code: '23514' });

    // Nothing is delivered to a deceased employee's self-service, though it is still open until separation; a living one's letter goes.
    const send = (emp: string) => h.call(letters, 'POST', `/v1/letter-outputs/${letterOutputs[emp]}/send`, { recipientEmployeeId: emp });
    expect((await send(staff.living!.emp)).statusCode).toBe(201);
    const refused = await send(d.emp);
    expect([refused.statusCode, refused.json().error]).toEqual([409, 'EMPLOYEE_DECEASED']);
    expect(await h.one<{ n: number }>(`select count(*)::int as n from ess_delivery where employee_id = $1`, [d.emp])).toEqual({ n: 0 });

    // Whatever the event, a subject-employee notice never reaches a deceased employee, though their self-service is still open until
    // separation; a living one still gets it.
    const living = staff.living!;
    await withTransaction(h.pool, async (tx) => {
      for (const emp of [d.emp, living.emp]) {
        await fanOut(tx, A.id, `SYNTHETIC_CHECK:${emp}`, null, {
          eventType: 'EXIT_DECIDED',
          subjectEmployeeId: emp,
          transactionId: null,
          transactionRevision: null,
          taskId: null,
          beneficiaryUserId: null,
          data: { employeeName: 'Synthetic', employeeCode: 'SYN', outcome: 'recorded (synthetic check)' },
        });
      }
    });
    const reached = async (a: TestActor) => (await h.one<{ n: number }>(`select count(*)::int as n from notification where company_id = $1 and recipient_user_id = $2 and body like '%synthetic check%'`, [A.id, a.user])).n;
    expect(await reached(living.actor)).toBe(1);
    expect(await reached(d.actor)).toBe(0);

    // The daily job separates the next day after a past date; a death ends the own self-service too, a retirement keeps it (BR-053).
    const retired = await approvedSeparation('retire', 'RETIREMENT', today);
    expect(await statusOf(h, staff.retire!.emp)).toBe('NOTICE');
    await separateDueExits(h.pool, A.id, addDays(today, 1), SYSTEM_ACTOR_ID);
    expect(await statusOf(h, d.emp)).toBe('INACTIVE_SEPARATED');
    expect(await statusOf(h, staff.retire!.emp)).toBe('INACTIVE_SEPARATED');
    const ownEss = async (actor: TestActor) =>
      (await h.one<{ live: boolean }>(`select (effective_to is null or effective_to > now() + interval '2 days') as live from role_assignment where id = $1`, [actor.assignment])).live;
    expect(await ownEss(d.actor)).toBe(false);
    expect(await ownEss(staff.retire!.actor)).toBe(true);
    expect((await h.call(hr1, 'GET', `/v1/exit-cases/${retired}`)).json()).toMatchObject({ separationType: 'RETIREMENT', state: 'SEPARATED' });
  });

  it('only a resignation is withdrawn, through the service and in the database', async () => {
    const t = staff.terminate!;
    const date = addDays(today, 10);
    const created = await enter(hrEntry, t.emp, { separationType: 'TERMINATION', proposedLastWorkingDate: date, reasonCode: 'SYN_MISCONDUCT', evidenceDocumentIds: [await doc(t.emp)] });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().exitCaseId as string;
    expect((await h.call(t.actor, 'POST', `/v1/me/exit-cases/${id}/withdraw`)).json().error).toBe('WITHDRAWAL_NOT_ALLOWED');
    // A termination's date may be recommended later than entered, as for a resignation.
    expect((await recommend(id, addDays(date, 5))).json()).toMatchObject({ state: 'RECOMMENDED', recommendedLastWorkingDate: addDays(date, 5) });
    expect((await approve(id)).json().state).toBe('APPROVED');
    expect((await h.call(t.actor, 'POST', `/v1/me/exit-cases/${id}/withdrawal-request`, { reason: 'Synthetic' })).json().error).toBe('WITHDRAWAL_NOT_ALLOWED');
    await expect(h.db.query(`update exit_case set state = 'WITHDRAWN', closed_at = now() where id = $1`, [id])).rejects.toMatchObject({ code: '23514', constraint: 'exit_case_withdrawn_resignation' });
    await expect(
      h.db.query(`insert into exit_withdrawal_request (company_id, exit_case_id, employee_id, transaction_id, reason, state) values ($1, $2, $3, gen_random_uuid(), 'Synthetic', 'SUBMITTED')`, [A.id, id, t.emp]),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/only a resignation can be withdrawn/) });
  });

  it('notifies reviewers and the manager in the separation’s own words, never the employee', async () => {
    const x = staff.disable!;
    const dispatched = async () => {
      while ((await dispatchOutbox(h.pool)) > 0);
    };
    const date = addDays(today, 2);
    const created = await enter(hrEntry, x.emp, { separationType: 'DISABLEMENT', proposedLastWorkingDate: date, evidenceDocumentIds: [await doc(x.emp)] });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().exitCaseId as string;
    // Each task's reviewer is told while the task waits for them.
    await dispatched();
    expect((await inbox(manager)).some((n) => n.body.startsWith('Disablement of Synthetic disable person') && n.body.includes('Please review it'))).toBe(true);
    expect((await recommend(id, date)).json().state).toBe('RECOMMENDED');
    await dispatched();
    expect((await inbox(hr1)).concat(await inbox(hr2)).some((n) => n.body.startsWith('Disablement of Synthetic disable person') && n.body.includes('waiting for your approval'))).toBe(true);
    expect((await approve(id)).json().state).toBe('APPROVED');
    await dispatched();
    const managerNotices = (await inbox(manager)).map((n) => n.body);
    expect(managerNotices.some((b) => b.startsWith('Disablement of Synthetic disable person') && b.includes('approved'))).toBe(true);
    expect(managerNotices.some((b) => b.includes('resignation of Synthetic disable person'))).toBe(false);
    // The employee hears through HR's letter, not an in-app "your resignation" notice.
    expect((await inbox(x.actor)).some((n) => /resignation/i.test(n.body))).toBe(false);
  });

  it('settlement: notice is recovered only for a resignation, and a death is gratuity-eligible whatever the service (I-88 item 8)', async () => {
    const prep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    const waiver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...HR_SETTLEMENT, 'settlement.waive_notice.amount'] });
    const calculated = async (exitId: string) => {
      const created = await h.call(prep, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' });
      expect(created.statusCode, created.body).toBe(201);
      const res = await h.call(prep, 'POST', `/v1/settlements/${created.json().id}/calculate`, { expectedVersion: created.json().version });
      expect(res.statusCode, res.body).toBe(200);
      const items = res.json().calculation.items as { kind: string; status: string; basis: Record<string, unknown> }[];
      return (kind: string) => items.find((i) => i.kind === kind)!;
    };
    // Death (joined 5 Jan 2026, far short of five years): eligible through the exempt type; the pack is not active, so it blocks.
    const death = await h.one<{ id: string }>(`select id from exit_case where employee_id = $1`, [staff.death!.emp]);
    const ofDeath = await calculated(death.id);
    expect(ofDeath('GRATUITY')).toMatchObject({ status: 'RULE_PACK_NOT_CONFIGURED', basis: { separationType: 'DEATH', exemptSeparation: true, completedYears: 0 } });
    expect(ofDeath('NOTICE_RECOVERY')).toMatchObject({ status: 'NOT_APPLICABLE', basis: { separationType: 'DEATH', reason: 'NO_NOTICE_FOR_SEPARATION_TYPE' } });
    expect((await h.call(waiver, 'POST', `/v1/exit-cases/${death.id}/notice-waiver`, { reason: 'Synthetic' })).json().error).toBe('NOTICE_NOT_RECOVERED');

    // A retirement is not exempt: the minimum service applies.
    const retire = await h.one<{ id: string }>(`select id from exit_case where employee_id = $1`, [staff.retire!.emp]);
    const ofRetire = await calculated(retire.id);
    expect(ofRetire('GRATUITY')).toMatchObject({ status: 'NOT_ELIGIBLE', basis: { exemptSeparation: false } });
    expect(ofRetire('NOTICE_RECOVERY').status).toBe('NOT_APPLICABLE');

    // A termination's notice is the employer's: once recorded, the shortfall is shown and nothing is recovered.
    const term = await h.one<{ id: string; version: number }>(`select id, version from exit_case where employee_id = $1`, [staff.terminate!.emp]);
    const before = await calculated(term.id);
    expect(before('NOTICE_RECOVERY').status).toBe('NOTICE_PERIOD_NOT_RECORDED');
    expect((await h.call(hrEntry, 'PUT', `/v1/exit-cases/${term.id}/notice-period`, { contractualNoticeDays: 90, expectedVersion: term.version })).statusCode).toBe(200);
    const settlement = (await h.call(prep, 'GET', `/v1/exit-cases/${term.id}/settlements`)).json().items[0];
    const recalculated = await h.call(prep, 'POST', `/v1/settlements/${settlement.id}/calculate`, { expectedVersion: settlement.version });
    expect(recalculated.statusCode, recalculated.body).toBe(200);
    const notice = (recalculated.json().calculation.items as { kind: string; status: string; amount: string | null; basis: Record<string, unknown> }[]).find((i) => i.kind === 'NOTICE_RECOVERY')!;
    expect(notice).toMatchObject({ status: 'NOT_APPLICABLE', amount: null, basis: { separationType: 'TERMINATION', reason: 'EMPLOYER_NOTICE_NOT_RECOVERED', requiredDays: 90 } });
    expect(Number(notice.basis.shortfallDays)).toBeGreaterThan(0);
  });
});
