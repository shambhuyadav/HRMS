// Notification rule configuration: versioned templates, future-dated audited revisions, one revision in force,
// mandatory rules stay on, approved placeholders only (FR-085, FR-061; BR-034; DF12; ZT23).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_VIOLATION, expectSqlError, uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { fanOut } from './dispatcher.js';

let h: Harness;
let A: Company;
let admin: TestActor;
let hr: TestActor;
let employee: TestActor;
let owner: TestActor;

const inFuture = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const rules = async (code: string) => (await h.call(admin, 'GET', `/v1/notifications/rules?code=${code}`)).json().items as Record<string, unknown>[];
const propose = (code: string, body: Record<string, unknown>, a: TestActor = admin) =>
  h.call(a, 'POST', `/v1/notifications/rules/${code}/revisions`, { reason: 'Wording review (synthetic)', ...body });
const versionOf = async (id: string) => (await h.one<{ version: number }>(`select version from notification_rule where id = $1`, [id])).version;
const publish = async (id: string, a: TestActor = owner) => h.call(a, 'POST', `/v1/notifications/rules/proposals/${id}/publish`, { expectedVersion: await versionOf(id) });
const rejectIt = async (id: string, a: TestActor = owner, reason = 'Not this wording (synthetic)') => h.call(a, 'POST', `/v1/notifications/rules/proposals/${id}/reject`, { expectedVersion: await versionOf(id), reason });
/** I-35's flow with the publication C6 adds: the change, then the independent approval. Refusals of the change come back as they are. */
const revise = async (code: string, body: Record<string, unknown>, a: TestActor = admin) => {
  const res = await propose(code, body, a);
  if (res.statusCode === 201) {
    const published = await publish(res.json().id);
    expect(published.statusCode, published.body).toBe(200);
  }
  return res;
};
/** One committed role-grant event for the employee's user, as the access module raises it. */
const grantEvent = () =>
  withTransaction(h.pool, (tx) =>
    fanOut(tx, A.id, uniq('test-grant:'), null, {
      eventType: 'ACCESS_GRANT_APPROVED',
      subjectEmployeeId: null,
      transactionId: null,
      transactionRevision: null,
      taskId: null,
      beneficiaryUserId: employee.user,
      data: { roleCode: 'EMPLOYEE' },
    }),
  );
const grantNotices = async () =>
  ((await h.call(employee, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[]).filter((n) => n.category === 'ACCESS_GRANT_APPROVED');
/** Simulates the configured instant arriving: the revisions' boundary is moved into the past, keeping them adjacent. */
const arrive = async (code: string, revision: number) => {
  await h.db.query(`update notification_rule set effective_to = now() - interval '1 second' where company_id = $1 and code = $2 and revision = $3`, [A.id, code, revision - 1]);
  await h.db.query(`update notification_rule set effective_from = now() - interval '1 second' where company_id = $1 and code = $2 and revision = $3`, [A.id, code, revision]);
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['notification.manage_rules.operational'] });
  owner = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['notification.approve_rules.operational'] });
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
});

afterAll(async () => {
  await h?.stop();
});

describe('rule revisions (FR-085)', () => {
  it('needs the explicit rule-management grant (ceiling only, never a default duty)', async () => {
    const defaultAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    for (const a of [defaultAdmin, hr, employee]) {
      expect((await h.call(a, 'GET', '/v1/notifications/rules')).statusCode).toBe(403);
      const denied = await revise('ACCESS_GRANT_APPROVED', { expectedRevision: 1, effectiveFrom: inFuture(60), bodyTemplate: 'x' }, a);
      expect(denied.statusCode).toBe(403);
    }
    const all = (await h.call(admin, 'GET', '/v1/notifications/rules')).json().items as { code: string; status: string; channel: string }[];
    expect(all.length).toBeGreaterThan(10);
    expect(all.every((r) => r.status === 'IN_FORCE' && r.channel === 'IN_APP')).toBe(true);
  });

  it('a change takes effect only from its configured date, is audited, and one revision is in force at a time', async () => {
    const before = await grantEvent();
    expect(before.created).toBe(1);
    const res = await revise('ACCESS_GRANT_APPROVED', {
      expectedRevision: 1,
      effectiveFrom: inFuture(60),
      subjectTemplate: 'Access approved',
      bodyTemplate: 'Your {{roleCode}} access is now approved.',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ revision: 2, templateRevision: 2, active: true, status: 'PROPOSED' });

    const revisions = await rules('ACCESS_GRANT_APPROVED');
    expect(revisions.map((r) => [r.revision, r.status, r.templateRevision])).toEqual([
      [1, 'IN_FORCE', 1],
      [2, 'SCHEDULED', 2],
    ]);
    expect(revisions[0]!.effectiveTo).toBe(revisions[1]!.effectiveFrom);
    // Event, channel, recipients and retry ceiling are carried over unchanged.
    expect(revisions[1]).toMatchObject({ eventType: 'ACCESS_GRANT_APPROVED', channel: 'IN_APP', recipientSelector: 'BENEFICIARY_USER', retryCeiling: revisions[0]!.retryCeiling });

    // Before the date: the old wording, once.
    await grantEvent();
    expect((await grantNotices()).map((n) => n.body)).toEqual(['A EMPLOYEE role assignment was approved for you.', 'A EMPLOYEE role assignment was approved for you.']);

    await arrive('ACCESS_GRANT_APPROVED', 2);
    expect((await rules('ACCESS_GRANT_APPROVED')).map((r) => r.status)).toEqual(['SUPERSEDED', 'IN_FORCE']);
    const after = await grantEvent();
    expect(after.created).toBe(1); // only the revision in force notifies
    const notices = await grantNotices();
    expect(notices).toHaveLength(3);
    expect(notices[0]!.body).toBe('Your EMPLOYEE access is now approved.');

    const audit = await h.db.query<{ resource_code: string; action: string; reason: string | null; after_values: { operational: Record<string, unknown> } }>(
      `select resource_code, action, reason, after_values from audit_event where company_id = $1 and resource_code in ('notification_rule', 'notification_template') order by occurred_at, resource_code desc`,
      [A.id],
    );
    expect(audit.rows.map((r) => [r.resource_code, r.action, r.reason])).toEqual([
      ['notification_template', 'CREATE', 'Wording review (synthetic)'],
      ['notification_rule', 'REVISE', 'Wording review (synthetic)'],
      ['notification_rule', 'PUBLISH', null],
    ]);
    expect(audit.rows[1]!.after_values.operational).toMatchObject({ code: 'ACCESS_GRANT_APPROVED', revision: 2, templateRevision: 2, active: true });
  });

  it('refuses past dates, stale revisions, unapproved placeholders, no-op changes and switching off a mandatory rule', async () => {
    const count = async () => Number((await h.one<{ n: string }>(`select count(*) as n from notification_rule where company_id = $1`, [A.id])).n);
    const n = await count();
    const error = async (code: string, body: Record<string, unknown>) => {
      const res = await revise(code, body);
      return [res.statusCode, res.json().error];
    };
    expect(await error('LEAVE_SUBMITTED', { expectedRevision: 1, effectiveFrom: new Date(Date.now() - 60_000).toISOString(), bodyTemplate: 'x' })).toEqual([
      422,
      'EFFECTIVE_DATE_NOT_FUTURE',
    ]);
    expect(await error('LEAVE_SUBMITTED', { expectedRevision: 2, effectiveFrom: inFuture(60), bodyTemplate: 'x' })).toEqual([409, 'STALE_VERSION']);
    // A reason or amount is never an approved placeholder of a broadcast-safe template.
    const leak = await revise('LEAVE_SUBMITTED', { expectedRevision: 1, effectiveFrom: inFuture(60), bodyTemplate: 'Leave for {{reason}} waits.' });
    expect(leak.statusCode).toBe(422);
    expect(leak.json()).toMatchObject({ error: 'PLACEHOLDER_NOT_APPROVED' });
    expect(await error('LEAVE_SUBMITTED', { expectedRevision: 1, effectiveFrom: inFuture(60), active: true })).toEqual([422, 'NO_CHANGE']);
    expect(await error('LEAVE_SUBMITTED', { expectedRevision: 1, effectiveFrom: inFuture(60), active: false })).toEqual([422, 'MANDATORY_RULE']);
    expect(await error('NO_SUCH_RULE', { expectedRevision: 1, effectiveFrom: inFuture(60), active: false })).toEqual([404, 'NOT_FOUND']);
    expect(await count()).toBe(n);
  });

  it('an optional rule can be switched off from a future date; a later change must start after it', async () => {
    const res = await revise('BIRTHDAY', { expectedRevision: 1, effectiveFrom: inFuture(120), active: false });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ revision: 2, templateRevision: 1, active: false });
    expect((await revise('BIRTHDAY', { expectedRevision: 2, effectiveFrom: inFuture(60), active: true })).json().error).toBe('EFFECTIVE_DATE_BEFORE_LATEST');
    const third = await revise('BIRTHDAY', { expectedRevision: 2, effectiveFrom: inFuture(180), active: true });
    expect(third.statusCode).toBe(201);
    const revisions = await rules('BIRTHDAY');
    expect(revisions.map((r) => [r.revision, r.status, r.active])).toEqual([
      [1, 'IN_FORCE', true],
      [2, 'SCHEDULED', false],
      [3, 'SCHEDULED', true],
    ]);
    expect(revisions[0]!.effectiveTo).toBe(revisions[1]!.effectiveFrom);
    expect(revisions[1]!.effectiveTo).toBe(revisions[2]!.effectiveFrom);
  });
});

describe('publication needs independent approval (C6 Notification Administrator; DF12)', () => {
  const proposed = async (code: string, body: Record<string, unknown> = {}) => {
    const res = await propose(code, { expectedRevision: (await latestRevision(code)), effectiveFrom: inFuture(60), bodyTemplate: `Reworded ${Date.now()}.`, ...body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; revision: number };
  };
  const latestRevision = async (code: string) =>
    ((await rules(code)) as { revision: number; status: string }[]).filter((r) => r.status !== 'REJECTED').at(-1)!.revision;

  it('the approval is its own grant, ceiling only, and manage_rules alone does not hold it', async () => {
    const { BASELINE_ROLES } = await import('../access/baseline.js');
    const key = 'notification.approve_rules.operational';
    expect(BASELINE_ROLES.filter((r) => r.ceiling.includes(key)).map((r) => r.code).sort()).toEqual(['HR_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR']);
    expect(BASELINE_ROLES.filter((r) => r.defaultDuties.includes(key))).toEqual([]);
    const p = await proposed('WORK_ANNIVERSARY');
    expect((await publish(p.id, admin)).statusCode).toBe(403); // holds manage_rules only, and is the author too
    const anotherManager = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['notification.manage_rules.operational'] });
    expect((await publish(p.id, anotherManager)).statusCode).toBe(403);
    expect((await h.call(anotherManager, 'GET', '/v1/notifications/rules/proposals')).statusCode).toBe(403);
    expect((await rejectIt(p.id)).statusCode).toBe(200);
  });

  it('the author cannot publish or reject their own change, even holding the approval', async () => {
    const both = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['notification.manage_rules.operational', 'notification.approve_rules.operational'] });
    const own = await propose('DOCUMENT_EXPIRING', { expectedRevision: 1, effectiveFrom: inFuture(60), bodyTemplate: 'Own change {{employeeName}}.' }, both);
    expect(own.statusCode, own.body).toBe(201);
    const refused = await publish(own.json().id, both);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('SELF_APPROVAL');
    expect((await rejectIt(own.json().id, both)).json().error).toBe('SELF_APPROVAL');
    expect((await publish(own.json().id, owner)).statusCode).toBe(200);
  });

  it('until published the revision in force is untouched and nothing is scheduled; its date passing brings nothing into force', async () => {
    const p = await proposed('ACCESS_GRANT_ENDED', { subjectTemplate: 'Grant {{outcome}}', bodyTemplate: 'Reworded {{roleCode}} {{outcome}}.' });
    const before = (await rules('ACCESS_GRANT_ENDED')) as { revision: number; status: string; effectiveTo: string | null }[];
    expect(before.map((r) => [r.revision, r.status])).toEqual([
      [1, 'IN_FORCE'],
      [p.revision, 'PROPOSED'],
    ]);
    expect(before[0]!.effectiveTo).toBeNull();
    // The configured instant arrives with nobody having approved.
    await h.db.query(`update notification_rule set effective_from = now() - interval '1 second' where id = $1`, [p.id]);
    const ended = await withTransaction(h.pool, (tx) =>
      fanOut(tx, A.id, uniq('test-ended:'), null, {
        eventType: 'ACCESS_GRANT_ENDED',
        subjectEmployeeId: null,
        transactionId: null,
        transactionRevision: null,
        taskId: null,
        beneficiaryUserId: employee.user,
        data: { roleCode: 'EMPLOYEE', outcome: 'revoked' },
      }),
    );
    expect(ended.created).toBe(1); // one notice, from revision 1
    const notices = ((await h.call(employee, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[]).filter((n) => n.category === 'ACCESS_GRANT_ENDED');
    expect(notices.map((n) => n.body)).toEqual(['A EMPLOYEE role assignment for you was revoked.']);
    // A date gone by cannot be approved: I-35 keeps a change from the future only.
    const late = await publish(p.id);
    expect(late.statusCode).toBe(422);
    expect(late.json().error).toBe('EFFECTIVE_DATE_NOT_FUTURE');
    // Written past the service, by someone holding the duty, it is refused all the same.
    await expectSqlError(h.db.query(`update notification_rule set publication_state = 'PUBLISHED', decided_by = $2, decided_at = now() where id = $1`, [p.id, owner.user]), CHECK_VIOLATION);
    expect((await rejectIt(p.id)).statusCode).toBe(200);
  });

  it('a rejection keeps the record and its reason, comes into force never, and the next change builds on what is in force with its own number', async () => {
    const p = await proposed('EXPENSE_PAYMENT_STATUS');
    const res = await rejectIt(p.id, owner, 'Tone is wrong (synthetic)');
    expect(res.statusCode, res.body).toBe(200);
    const after = (await rules('EXPENSE_PAYMENT_STATUS')) as { revision: number; status: string; effectiveTo: string | null; decisionReason: string | null; proposalReason: string | null }[];
    expect(after.map((r) => [r.revision, r.status])).toEqual([
      [1, 'IN_FORCE'],
      [2, 'REJECTED'],
    ]);
    expect(after[1]).toMatchObject({ decisionReason: 'Tone is wrong (synthetic)', proposalReason: 'Wording review (synthetic)' });
    expect(after[0]!.effectiveTo).toBeNull();
    const audit = await h.one<{ reason: string }>(`select reason from audit_event where company_id = $1 and resource_code = 'notification_rule' and record_key = $2 and action = 'REJECT'`, [A.id, p.id]);
    expect(audit.reason).toBe('Tone is wrong (synthetic)');
    expect((await publish(p.id)).json().error).toBe('INVALID_STATE');
    // The next proposal names revision 1 as the one it follows, and takes the next number.
    const ok = await propose('EXPENSE_PAYMENT_STATUS', { expectedRevision: 1, effectiveFrom: inFuture(90), subjectTemplate: 'Payment update' });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().revision).toBe(3);
    expect((await rejectIt(ok.json().id)).statusCode).toBe(200);
  });

  it('one open change per rule; a filtered approver cannot publish a company-wide rule; a stale decision is refused', async () => {
    const p = await proposed('DELEGATION_CHANGED');
    const second = await propose('DELEGATION_CHANGED', { expectedRevision: p.revision, effectiveFrom: inFuture(120), bodyTemplate: 'Another.' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('REVISION_PENDING');
    const filtered = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['notification.approve_rules.operational'], departmentFilter: A.dept });
    expect((await publish(p.id, filtered)).json().error).toBe('SCOPE_EXCEEDS_ADMINISTRATOR');
    const stale = await h.call(owner, 'POST', `/v1/notifications/rules/proposals/${p.id}/publish`, { expectedVersion: (await versionOf(p.id)) + 1 });
    expect(stale.json().error).toBe('STALE_VERSION');
    const listed = (await h.call(owner, 'GET', '/v1/notifications/rules/proposals')).json().items as { id: string; proposedBy: string; proposalReason: string; bodyTemplate: string; currentBodyTemplate: string }[];
    const shown = listed.find((i) => i.id === p.id)!;
    expect(shown).toMatchObject({ proposedBy: admin.user, proposalReason: 'Wording review (synthetic)' });
    expect(shown.bodyTemplate).not.toBe(shown.currentBodyTemplate);
    expect((await publish(p.id)).statusCode).toBe(200);
    expect(((await h.call(owner, 'GET', '/v1/notifications/rules/proposals')).json().items as { id: string }[]).map((i) => i.id)).not.toContain(p.id);
    // Published, the end of the revision before it lines up with its start.
    const revisions = (await rules('DELEGATION_CHANGED')) as { effectiveFrom: string; effectiveTo: string | null; status: string }[];
    expect(revisions.map((r) => r.status)).toEqual(['IN_FORCE', 'SCHEDULED']);
    expect(revisions[0]!.effectiveTo).toBe(revisions[1]!.effectiveFrom);
  });

  it('a proposal and a decision re-check authority inside their transactions', async () => {
    const narrowed = async (a: TestActor, fire: () => ReturnType<typeof h.call>) => {
      await h.db.query('begin');
      let pending: ReturnType<typeof h.call> | undefined;
      try {
        await h.db.query(`select 1 from role_assignment where company_id = $1 and id = $2 for update`, [A.id, a.assignment]);
        pending = fire();
        let blocked = false;
        for (let i = 0; i < 400 && !blocked; i++) {
          blocked = ((await h.pool.query(`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`)).rowCount ?? 0) > 0;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(blocked).toBe(true);
        await h.db.query(`update role_assignment_permission set active = false where company_id = $1 and role_assignment_id = $2`, [A.id, a.assignment]);
      } finally {
        await h.db.query('commit');
      }
      return pending!;
    };
    const leavingAuthor = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['notification.manage_rules.operational'] });
    const refused = await narrowed(leavingAuthor, () => propose('APPROVAL_REROUTED', { expectedRevision: 1, effectiveFrom: inFuture(60), bodyTemplate: 'Rerouted {{requestKind}}.' }, leavingAuthor));
    expect(refused.statusCode, refused.body).toBe(403);
    expect((await rules('APPROVAL_REROUTED')).map((r) => r.revision)).toEqual([1]);

    const p = await proposed('APPROVAL_REROUTED', { bodyTemplate: 'Rerouted {{requestKind}}.' });
    const leavingOwner = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['notification.approve_rules.operational'] });
    const version = await versionOf(p.id);
    const late = await narrowed(leavingOwner, () => h.call(leavingOwner, 'POST', `/v1/notifications/rules/proposals/${p.id}/publish`, { expectedVersion: version }));
    expect(late.statusCode, late.body).toBe(403);
    expect((await rules('APPROVAL_REROUTED')).map((r) => r.status)).toEqual(['IN_FORCE', 'PROPOSED']);
    expect((await rejectIt(p.id)).statusCode).toBe(200);
  });

  it('the database holds it too: a revision starts proposed; the author, or someone without the duty, cannot decide it; a decision stays', async () => {
    const p = await proposed('ATTENDANCE_CORRECTION_DECIDED', { bodyTemplate: 'Your correction for {{workDate}} was {{outcome}}.' });
    const decide = (user: string, state = 'PUBLISHED') => h.db.query(`update notification_rule set publication_state = $3, decided_by = $2, decided_at = now(), decision_reason = 'Direct (synthetic)' where id = $1`, [p.id, user, state]);
    await expectSqlError(decide(hr.user), CHECK_VIOLATION); // no approval duty
    // The author, even holding the approval duty.
    const both = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['notification.manage_rules.operational', 'notification.approve_rules.operational'] });
    const own = await propose('ATTENDANCE_CORRECTION_SUBMITTED', { expectedRevision: 1, effectiveFrom: inFuture(60), bodyTemplate: 'A correction for {{employeeName}} waits.' }, both);
    expect(own.statusCode, own.body).toBe(201);
    await expectSqlError(h.db.query(`update notification_rule set publication_state = 'PUBLISHED', decided_by = $2, decided_at = now() where id = $1`, [own.json().id, both.user]), CHECK_VIOLATION);
    expect((await rejectIt(own.json().id)).statusCode).toBe(200);
    await expectSqlError(h.db.query(`update notification_rule set publication_state = 'PUBLISHED' where id = $1`, [p.id]), CHECK_VIOLATION); // nobody named
    await expectSqlError(h.db.query(`update notification_rule set publication_state = 'REJECTED', decided_by = $2, decided_at = now() where id = $1`, [p.id, owner.user]), CHECK_VIOLATION); // no reason
    await expectSqlError(
      h.db.query(
        `insert into notification_rule (company_id, code, revision, event_type, channel, recipient_selector, template_code, template_revision, template_id, optional_event, effective_from, active, created_by)
         select company_id, code, 99, event_type, channel, recipient_selector, template_code, template_revision, template_id, optional_event, now() + interval '1 day', active, created_by from notification_rule where id = $1`,
        [p.id],
      ),
      CHECK_VIOLATION,
    ); // a later revision cannot be written straight in force
    expect((await publish(p.id)).statusCode).toBe(200);
    await expectSqlError(decide(owner.user, 'REJECTED'), CHECK_VIOLATION);
    await expectSqlError(h.db.query(`update notification_rule set publication_state = 'PROPOSED', decided_by = null, decided_at = null where id = $1`, [p.id]), CHECK_VIOLATION);
  });
});
