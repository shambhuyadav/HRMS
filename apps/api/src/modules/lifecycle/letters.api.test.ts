// Letters over HTTP (FR-017, FR-018, FR-055; DB077): versioned templates with approved placeholders, preview without
// storing or sending, final output stored as a confidential attachment with template code/revision and generator,
// regeneration as a new output, approved exit data for relieving letters, sending not available. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';
import { addDays, HR_LETTERS, key, narrowedGrant, person, publishedTemplate, today as businessDate, trailText } from './lifecycle.fixtures.js';
import { generateLetter, publishLetterTemplate } from './letters.js';
import { withTransaction } from '../../db/transaction.js';
import { resolveAccess } from '../access/authorize.js';
import type { AccessGrant } from '../access/authorize.js';

describe.runIf(isModuleActive('lifecycle'))('letters (FR-017, FR-018, FR-055)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let hr: TestActor;
  let hrLetters: TestActor;
  let hrLettersEng: TestActor;
  let hrB: TestActor;
  let manager: TestActor;
  let employee: TestActor;
  let employeeEmp: string;
  let financeEmp: string;
  let processId: string;
  let financeProcess: string;
  let today: string;
  let joiningDate: string;

  const RELIEVING = 'Dear {{employeeName}} ({{employeeCode}}),\nYou served {{companyName}} from {{joiningDate}} to {{lastWorkingDate}} as {{designation}}.\nIssued on {{letterDate}}.';
  const preview = (a: TestActor, pid: string, templateCode: string) => h.call(a, 'POST', `/v1/employee-processes/${pid}/letters/preview`, { templateCode });
  const generate = (a: TestActor, pid: string, templateCode: string) => h.call(a, 'POST', `/v1/employee-processes/${pid}/letters`, { templateCode });
  const createTemplate = (body: Record<string, unknown>) => h.call(hr, 'POST', '/v1/letter-templates', { name: 'Synthetic letter', letterType: 'RELIEVING', ...body });
  const publish = async (id: string) => {
    const t = (await h.call(hr, 'GET', `/v1/letter-templates/${id}`)).json();
    const draft = t.revisions.find((r: { state: string }) => r.state === 'DRAFT');
    const res = await h.call(hr, 'POST', `/v1/letter-templates/${id}/publish`, { revision: draft.revision, expectedVersion: draft.version });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    hrLetters = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_LETTERS });
    hrLettersEng = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_LETTERS, departmentFilter: A.financeDept });
    hrB = await h.actor(B, 'HR_ADMINISTRATOR', { extra: HR_LETTERS });
    const managerEmp = await person(h, A, hr, { name: 'Maya Manager (synthetic)' });
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    employeeEmp = await person(h, A, hr, { managerId: managerEmp, name: 'Eli Employee (synthetic)' });
    employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
    const fin = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { departmentId: A.financeDept, displayName: 'Finn Finance (synthetic)' }));
    financeEmp = fin.json().id;
    await h.setStatus(A, financeEmp, 'ACTIVE_CONFIRMED');
    joiningDate = (await h.one<{ d: string }>(`select to_char(joining_date, 'YYYY-MM-DD') as d from employee where id = $1`, [employeeEmp])).d;
    today = await businessDate(h, A);
    await publishedTemplate(h, hr, 'LETTERS', 'TRANSFER', [{ code: 'ISSUE', title: 'Issue letter', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 0, evidenceRequired: false }]);
    processId = (await h.call(hr, 'POST', `/v1/employees/${employeeEmp}/processes`, { processCode: 'LETTERS' })).json().id;
    financeProcess = (await h.call(hr, 'POST', `/v1/employees/${financeEmp}/processes`, { processCode: 'LETTERS' })).json().id;
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('accepts only approved placeholders and versions templates', async () => {
    const placeholders = (await h.call(hr, 'GET', '/v1/letter-placeholders')).json().items.map((p: { key: string }) => p.key);
    expect(placeholders).toEqual(expect.arrayContaining(['employeeName', 'joiningDate', 'lastWorkingDate', 'companyName']));
    // Confidential values are not placeholders.
    expect(placeholders).not.toContain('salary');
    expect(placeholders).not.toContain('dateOfBirth');
    expect((await createTemplate({ code: 'BAD1', body: 'Pay: {{salary}}' })).json()).toMatchObject({ error: 'UNKNOWN_PLACEHOLDER', details: { placeholders: ['salary'] } });
    expect((await createTemplate({ code: 'BAD2', body: 'Hello {{ employee-name }}' })).json().error).toBe('MALFORMED_PLACEHOLDER');
    expect((await createTemplate({ code: 'BAD3', body: 'Hello {{employeeName}}', optionalPlaceholders: ['designation'] })).json().error).toBe('INVALID_OPTIONAL_PLACEHOLDER');
    expect((await createTemplate({ code: 'BAD4', letterType: 'NOT_A_TYPE', body: 'Hello' })).json().error).toBe('INVALID_REFERENCE');

    const created = await createTemplate({ code: 'RELIEVING', body: RELIEVING, optionalPlaceholders: ['designation'] });
    expect(created.statusCode).toBe(201);
    expect(created.json().revisions[0]).toMatchObject({
      revision: 1,
      state: 'DRAFT',
      placeholders: ['companyName', 'designation', 'employeeCode', 'employeeName', 'joiningDate', 'lastWorkingDate', 'letterDate'],
      optionalPlaceholders: ['designation'],
    });
    // Unpublished templates cannot be used.
    expect((await preview(hrLetters, processId, 'RELIEVING')).json().error).toBe('TEMPLATE_NOT_PUBLISHED');
    const published = await publish(created.json().id);
    expect(published.revisions[0].state).toBe('PUBLISHED');
    await expect(h.db.query(`update letter_template_revision set body = 'changed' where template_id = $1`, [created.json().id])).rejects.toThrow(/frozen/);
    // Template administration is an HR duty; letters need the confidential letter grant.
    expect((await h.call(manager, 'GET', '/v1/letter-templates')).statusCode).toBe(403);
    expect((await h.call(employee, 'POST', '/v1/letter-templates', { code: 'EMP', name: 'x', letterType: 'OFFER', body: 'x' })).statusCode).toBe(403);
  });

  it('previews without storing or sending, and blocks final output while a mandatory value is missing', async () => {
    expect((await preview(hr, processId, 'RELIEVING')).statusCode).toBe(403);
    expect((await preview(employee, processId, 'RELIEVING')).statusCode).toBe(403);
    expect((await preview(hrLettersEng, processId, 'RELIEVING')).statusCode).toBe(404);
    expect((await preview(hrB, processId, 'RELIEVING')).statusCode).toBe(404);
    const created = await createTemplate({ code: 'NOTICE_LETTER', letterType: 'WARNING', body: 'Dear {{employeeName}}, last working date {{lastWorkingDate}}.' });
    await publish(created.json().id);
    const outbox = (await h.one<{ n: number }>(`select count(*)::int as n from outbox_event where company_id = $1`, [A.id])).n;
    const p = await preview(hrLetters, processId, 'NOTICE_LETTER');
    expect(p.json()).toMatchObject({ templateCode: 'NOTICE_LETTER', templateRevision: 1, missing: ['lastWorkingDate'], ready: false, sent: false });
    expect(p.json().text).toBe('Dear Eli Employee (synthetic), last working date .');
    // Nothing stored, nothing queued for delivery.
    expect(await h.one<{ n: number }>(`select count(*)::int as n from letter_output where company_id = $1`, [A.id])).toEqual({ n: 0 });
    expect((await h.one<{ n: number }>(`select count(*)::int as n from outbox_event where company_id = $1`, [A.id])).n).toBe(outbox);
    expect((await generate(hrLetters, processId, 'NOTICE_LETTER')).json()).toMatchObject({ error: 'MISSING_PLACEHOLDER', details: { missing: ['lastWorkingDate'] } });
  });

  it('a relieving or experience template shows the employment period as mandatory, or it is not published (FR-055)', async () => {
    const draftOf = async (letterType: string, code: string, body: string, optionalPlaceholders: string[] = []) => {
      const created = await createTemplate({ code, letterType, body, optionalPlaceholders });
      expect(created.statusCode, created.body).toBe(201);
      const draft = created.json().revisions[0];
      return { id: created.json().id as string, publish: () => h.call(hr, 'POST', `/v1/letter-templates/${created.json().id}/publish`, { revision: draft.revision, expectedVersion: draft.version }) };
    };
    for (const letterType of ['RELIEVING', 'EXPERIENCE']) {
      const neither = await draftOf(letterType, `${letterType}_NONE`, 'Dear {{employeeName}}, thank you.');
      expect((await neither.publish()).json()).toMatchObject({ error: 'EMPLOYMENT_PERIOD_REQUIRED', details: { placeholders: ['joiningDate', 'lastWorkingDate'] } });
      const noEnd = await draftOf(letterType, `${letterType}_NOEND`, 'You joined on {{joiningDate}}.');
      expect((await noEnd.publish()).json()).toMatchObject({ error: 'EMPLOYMENT_PERIOD_REQUIRED', details: { placeholders: ['lastWorkingDate'] } });
      const optional = await draftOf(letterType, `${letterType}_OPT`, 'From {{joiningDate}} to {{lastWorkingDate}}.', ['lastWorkingDate']);
      const refused = await optional.publish();
      expect([refused.statusCode, refused.json().error, refused.json().details]).toEqual([422, 'EMPLOYMENT_PERIOD_REQUIRED', { placeholders: ['lastWorkingDate'] }]);
      // A refused draft stays a draft and can be corrected.
      expect((await h.call(hr, 'GET', `/v1/letter-templates/${optional.id}`)).json().revisions[0].state).toBe('DRAFT');
      const good = await draftOf(letterType, `${letterType}_OK`, 'From {{joiningDate}} to {{lastWorkingDate}}.');
      expect((await good.publish()).statusCode).toBe(200);
    }
    // Other letter types are not bound by the rule.
    const other = await draftOf('TRANSFER', 'TRANSFER_PLAIN', 'Dear {{employeeName}}, you move.');
    expect((await other.publish()).statusCode).toBe(200);
  });

  it('a relieving or experience letter needs an approved exit: no preview or output before one (FR-055)', async () => {
    const stored = async () => (await h.one<{ n: number }>(`select count(*)::int as n from letter_output where company_id = $1`, [A.id])).n;
    const before = await stored();
    for (const code of ['RELIEVING', 'EXPERIENCE_OK']) {
      const shown = await preview(hrLetters, processId, code);
      expect([shown.statusCode, shown.json().error]).toEqual([409, 'EXIT_NOT_APPROVED']);
      const made = await generate(hrLetters, processId, code);
      expect([made.statusCode, made.json().error]).toEqual([409, 'EXIT_NOT_APPROVED']);
    }
    expect(await stored()).toBe(before);
    // A revision published before this rule, without the period, is refused too, even after an exit is approved.
    const legacy = await createTemplate({ code: 'RELIEVING_LEGACY', body: 'Dear {{employeeName}}, goodbye.' });
    const rev = await h.one<{ id: string }>(`select id from letter_template_revision where template_id = $1`, [legacy.json().id]);
    await h.db.query(`update letter_template_revision set state = 'PUBLISHED', published_at = now(), published_by = $2 where id = $1`, [rev.id, hr.user]);
    const refused = await preview(hrLetters, processId, 'RELIEVING_LEGACY');
    expect([refused.statusCode, refused.json().error]).toEqual([422, 'EMPLOYMENT_PERIOD_REQUIRED']);
    expect((await generate(hrLetters, processId, 'RELIEVING_LEGACY')).json().error).toBe('EMPLOYMENT_PERIOD_REQUIRED');
  });

  it('re-checks the grants inside publishing and generating: one revoked after the route guard refuses and records nothing', async () => {
    const stale = await narrowedGrant(h, A, await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_LETTERS }), 'letter.generate.letter');
    const before = (await h.one<{ n: number }>(`select count(*)::int as n from letter_output where company_id = $1`, [A.id])).n;
    const noFiles = {} as Parameters<typeof generateLetter>[2];
    await expect(withTransaction(h.pool, (tx) => generateLetter(tx, stale, noFiles, processId, { templateCode: 'NOTICE_LETTER' }))).rejects.toMatchObject({ statusCode: 403 });
    expect((await h.one<{ n: number }>(`select count(*)::int as n from letter_output where company_id = $1`, [A.id])).n).toBe(before);

    const created = await createTemplate({ code: 'STALE_PUBLISH', letterType: 'TRANSFER', body: 'Dear {{employeeName}}.' });
    const draft = created.json().revisions[0];
    const manager2 = await h.actor(A, 'HR_ADMINISTRATOR');
    const grant = (await resolveAccess(h.pool, { userId: manager2.user, companyId: A.id, assignmentId: manager2.assignment, resource: 'letter_template', action: 'manage', fieldGroups: ['operational'] })) as AccessGrant;
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where id = $1`, [manager2.assignment]);
    await expect(withTransaction(h.pool, (tx) => publishLetterTemplate(tx, grant, created.json().id, { revision: draft.revision, expectedVersion: draft.version }))).rejects.toMatchObject({ statusCode: 403 });
    expect((await h.call(hr, 'GET', `/v1/letter-templates/${created.json().id}`)).json().revisions[0].state).toBe('DRAFT');
  });

  it('generates relieving letters from approved exit data, keeping each exact output', async () => {
    // An approved exit provides the last working date (FR-055: the approved employment period).
    expect((await h.call(hr, 'PUT', '/v1/workflows/exit_case/fallback-reviewers', { reviewers: [{ userId: hr.user, priority: 1 }] })).statusCode).toBe(200);
    const lwd = addDays(today, 14);
    const exitId = (await h.call(employee, 'POST', '/v1/me/resignation', { proposedLastWorkingDate: lwd })).json().exitCaseId;
    // A proposal is not approved exit data.
    expect((await preview(hrLetters, processId, 'RELIEVING')).json().error).toBe('EXIT_NOT_APPROVED');
    const mt = (await h.call(manager, 'GET', '/v1/exit-cases/tasks/mine')).json().items[0].taskId;
    await h.call(manager, 'POST', `/v1/exit-cases/tasks/${mt}/recommend`, { recommendedLastWorkingDate: lwd, idempotencyKey: key() });
    const ht = (await h.call(hr, 'GET', '/v1/exit-cases/tasks/mine')).json().items[0].taskId;
    expect((await h.call(hr, 'POST', `/v1/exit-cases/tasks/${ht}/decision`, { decision: 'APPROVE', idempotencyKey: key() })).json().state).toBe('APPROVED');
    expect(exitId).toBeDefined();

    const shown = (await preview(hrLetters, processId, 'RELIEVING')).json();
    expect(shown).toMatchObject({ missing: [], ready: true });
    const first = await generate(hrLetters, processId, 'RELIEVING');
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ templateCode: 'RELIEVING', templateRevision: 1, outputNumber: 1, generatedBy: hrLetters.user, deliveryState: 'NOT_SENT' });
    const content = await h.call(hrLetters, 'GET', `/v1/letter-outputs/${first.json().id}/content`);
    expect(content.statusCode).toBe(200);
    expect(content.headers['content-type']).toContain('text/plain');
    expect(content.headers['cache-control']).toBe('no-store');
    expect(content.body).toBe(shown.text);
    expect(content.body).toContain(`from ${joiningDate} to ${lwd}`);
    // The stored output is a confidential attachment of the employee, recorded with its template revision.
    const stored = await h.one<{ classification: string; employee_id: string; template_revision: number; generated_by: string; checksum_ok: boolean }>(
      `select a.classification, a.employee_id, o.template_revision, o.generated_by, a.checksum = o.checksum as checksum_ok
         from letter_output o join attachment a on a.id = o.attachment_id where o.id = $1`,
      [first.json().id],
    );
    expect(stored).toEqual({ classification: 'CONFIDENTIAL', employee_id: employeeEmp, template_revision: 1, generated_by: hrLetters.user, checksum_ok: true });

    // A new template revision applies to new outputs only; regeneration is a new output.
    const tpl = (await h.call(hr, 'GET', '/v1/letter-templates')).json().items.find((t: { code: string }) => t.code === 'RELIEVING');
    const draft = await h.call(hr, 'PUT', `/v1/letter-templates/${tpl.id}/draft`, { body: `${RELIEVING}\nWith best wishes.`, optionalPlaceholders: ['designation'] });
    expect(draft.statusCode, draft.body).toBe(200);
    await publish(tpl.id);
    const second = await generate(hrLetters, processId, 'RELIEVING');
    expect(second.json()).toMatchObject({ templateRevision: 2, outputNumber: 2 });
    const outputs = (await h.call(hrLetters, 'GET', `/v1/employees/${employeeEmp}/letter-outputs`)).json().items;
    expect(outputs.map((o: { outputNumber: number; templateRevision: number }) => [o.outputNumber, o.templateRevision])).toEqual([
      [2, 2],
      [1, 1],
    ]);
    expect((await h.call(hrLetters, 'GET', `/v1/letter-outputs/${first.json().id}/content`)).body).toBe(shown.text);
    // An idempotency key makes a retried generation (also two at once) return the one stored output.
    const k = key('lc-letter-');
    const [x, y] = await Promise.all([
      h.call(hrLetters, 'POST', `/v1/employee-processes/${processId}/letters`, { templateCode: 'RELIEVING', idempotencyKey: k }),
      h.call(hrLetters, 'POST', `/v1/employee-processes/${processId}/letters`, { templateCode: 'RELIEVING', idempotencyKey: k }),
    ]);
    expect([x.statusCode, y.statusCode]).toEqual([201, 201]);
    expect(x.json().id).toBe(y.json().id);
    expect([x.json().replayed, y.json().replayed].sort()).toEqual([false, true]);
    expect(x.json()).toMatchObject({ outputNumber: 3, templateRevision: 2 });
    expect(await h.one<{ n: number }>(`select count(*)::int as n from letter_output where employee_process_id = $1`, [processId])).toEqual({ n: 3 });
    expect((await h.call(hrLetters, 'POST', `/v1/employee-processes/${processId}/letters`, { templateCode: 'OTHER_CODE', idempotencyKey: k })).json().error).toBe('IDEMPOTENCY_KEY_REUSED');
    // Outputs are append-only.
    await expect(h.db.query(`update letter_output set template_revision = 2 where id = $1`, [first.json().id])).rejects.toThrow(/append-only/);

    // Reading needs the letter grant and scope, never one's own letters; reads are audited.
    expect((await h.call(hr, 'GET', `/v1/letter-outputs/${first.json().id}/content`)).statusCode).toBe(403);
    expect((await h.call(hrLettersEng, 'GET', `/v1/letter-outputs/${first.json().id}/content`)).statusCode).toBe(404);
    expect((await h.call(hrB, 'GET', `/v1/employees/${employeeEmp}/letter-outputs`)).statusCode).toBe(404);
    expect((await h.call(employee, 'GET', `/v1/letter-outputs/${first.json().id}/content`)).statusCode).toBe(403);
    expect(await h.one<{ n: number }>(`select count(*)::int as n from audit_event where record_key = $1 and action = 'READ_CONTENT'`, [first.json().id])).toEqual({ n: 2 });
    // The audit records template code and revision in the letter group, never the letter text.
    const trail = await trailText(h, A.id, [first.json().id, processId]);
    expect(trail).toContain('RELIEVING');
    expect(trail).not.toContain('You served');
    expect(trail).not.toContain('Eli Employee');
  });

  it('FR-018 sends only in-app, as its own right: the reviewed recipient, delivery status and no e-mail (I-81 item 9)', async () => {
    const output = (await h.call(hrLetters, 'GET', `/v1/employees/${employeeEmp}/letter-outputs`)).json().items[0];
    const send = (a: TestActor, recipientEmployeeId = employeeEmp) => h.call(a, 'POST', `/v1/letter-outputs/${output.id}/send`, { recipientEmployeeId });
    // Generating and reading do not include sending (FR-002, FR-018).
    expect((await send(hrLetters)).statusCode).toBe(403);
    expect((await send(hr)).statusCode).toBe(403);
    const sender = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...HR_LETTERS, 'letter.send.letter'] });
    expect((await send(sender, financeEmp)).json().error).toBe('RECIPIENT_MISMATCH');
    const sent = await send(sender);
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json()).toMatchObject({ kind: 'LETTER', format: 'TEXT', channel: 'IN_APP', status: 'DELIVERED' });
    // The output itself is unchanged (append-only); its list shows the in-app delivery.
    expect(await h.one<{ s: string }>(`select delivery_state as s from letter_output where id = $1`, [output.id])).toEqual({ s: 'NOT_SENT' });
    expect(((await h.call(hrLetters, 'GET', `/v1/employees/${employeeEmp}/letter-outputs`)).json().items as { id: string; deliveryState: string }[]).find((o) => o.id === output.id)!.deliveryState).toBe('DELIVERED_IN_APP');
    // The employee opens the exact stored letter in their own self-service.
    const mine = (await h.call(employee, 'GET', '/v1/me/deliveries')).json().items as { id: string; kind: string }[];
    expect(mine.map((d) => [d.id, d.kind])).toEqual([[sent.json().id, 'LETTER']]);
    const opened = await h.call(employee, 'GET', `/v1/me/deliveries/${sent.json().id}/file`);
    expect(opened.body).toBe((await h.call(hrLetters, 'GET', `/v1/letter-outputs/${output.id}/content`)).body);
    // A letter of a colleague's process in another department is out of this assignment's scope only.
    expect((await generate(hrLettersEng, financeProcess, 'RELIEVING')).json().error).toBe('EXIT_NOT_APPROVED');
  });

  it('a clearance checklist uses its own exit, and a withdrawn exit gives no letter (FR-055)', async () => {
    const leaver = await person(h, A, hr, { name: 'Wes Withdrawn (synthetic)' });
    /** An approved exit of the leaver, written directly (the exit journey itself is tested in exit.api.test.ts). */
    const approvedExit = async (leaving: string) => {
      await h.db.query('begin');
      try {
        const bt = await h.one<{ id: string }>(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'exit_case', $2, 'SUBMITTED') returning id`, [A.id, leaver]);
        const x = await h.one<{ id: string }>(
          `insert into exit_case (company_id, employee_id, transaction_id, separation_type, request_date, proposed_leaving_date, leaving_date, state)
           values ($1, $2, $3, 'RESIGNATION', $4, $5, $5, 'SUBMITTED') returning id`,
          [A.id, leaver, bt.id, today, leaving],
        );
        await h.db.query(`update business_transaction set state = 'RECOMMENDED' where id = $1`, [bt.id]);
        await h.db.query(`update exit_case set state = 'RECOMMENDED', recommended_leaving_date = $2, recommended_at = now() where id = $1`, [x.id, leaving]);
        await h.db.query(`update business_transaction set state = 'APPROVED' where id = $1`, [bt.id]);
        await h.db.query(`update exit_case set state = 'APPROVED', approved_leaving_date = $2, approved_at = now(), prior_status_code = 'ACTIVE_CONFIRMED' where id = $1`, [x.id, leaving]);
        await h.db.query('commit');
        return { id: x.id, transactionId: bt.id };
      } catch (e) {
        await h.db.query('rollback');
        throw e;
      }
    };
    const withdraw = async (x: { id: string; transactionId: string }) => {
      await h.db.query('begin');
      await h.db.query(`update business_transaction set state = 'WITHDRAWN' where id = $1`, [x.transactionId]);
      await h.db.query(`update exit_case set state = 'WITHDRAWN', closed_at = now() where id = $1`, [x.id]);
      await h.db.query('commit');
    };
    const first = addDays(today, 10);
    const later = addDays(today, 20);
    const exit = await approvedExit(first);
    await publishedTemplate(h, hr, 'CLEARANCE', 'EXIT', [{ code: 'RETURN_ASSETS', title: 'Return assets', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 0, evidenceRequired: false }]);
    const checklist = await h.call(hr, 'POST', `/v1/employees/${leaver}/processes`, { processCode: 'CLEARANCE', exitCaseId: exit.id });
    expect(checklist.statusCode, checklist.body).toBe(201);
    const plain = (await h.call(hr, 'POST', `/v1/employees/${leaver}/processes`, { processCode: 'LETTERS' })).json().id as string;
    expect((await preview(hrLetters, checklist.json().id, 'RELIEVING')).json().text).toContain(`to ${first} `);
    expect((await preview(hrLetters, plain, 'RELIEVING')).json().text).toContain(`to ${first} `);

    // Withdrawn, it does not stand: neither process gives a letter.
    await withdraw(exit);
    for (const processOf of [checklist.json().id as string, plain]) {
      expect((await preview(hrLetters, processOf, 'RELIEVING')).json().error).toBe('EXIT_NOT_APPROVED');
      expect((await generate(hrLetters, processOf, 'RELIEVING')).json().error).toBe('EXIT_NOT_APPROVED');
    }
    // A later approved exit serves a process of no particular exit, but never the checklist of the withdrawn one.
    await approvedExit(later);
    expect((await preview(hrLetters, plain, 'RELIEVING')).json().text).toContain(`to ${later} `);
    expect((await preview(hrLetters, checklist.json().id, 'RELIEVING')).json().error).toBe('EXIT_NOT_APPROVED');
  });
});
