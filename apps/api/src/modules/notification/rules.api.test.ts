// Notification rule configuration: versioned templates, future-dated audited revisions, one revision in force,
// mandatory rules stay on, approved placeholders only (FR-085, FR-061; BR-034; DF12; ZT23).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { fanOut } from './dispatcher.js';

let h: Harness;
let A: Company;
let admin: TestActor;
let hr: TestActor;
let employee: TestActor;

const inFuture = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const rules = async (code: string) => (await h.call(admin, 'GET', `/v1/notifications/rules?code=${code}`)).json().items as Record<string, unknown>[];
const revise = (code: string, body: Record<string, unknown>, a: TestActor = admin) =>
  h.call(a, 'POST', `/v1/notifications/rules/${code}/revisions`, { reason: 'Wording review (synthetic)', ...body });
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
    expect(res.json()).toMatchObject({ revision: 2, templateRevision: 2, active: true, status: 'SCHEDULED' });

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
