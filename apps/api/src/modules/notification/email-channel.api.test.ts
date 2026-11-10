// The external email channel (FR-085; FR-061; DF12; BR-034; BR-044): proposed per event and published by someone else, queued by
// the dispatcher after the in-app checks, sent only by the worker and only with SMTP settings, at most once, with bounded retries.
// An in-process fake SMTP server stands in for the mail service: no real mail, no network. Synthetic data only.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_VIOLATION, expectSqlError, uniq } from '../../../../../db/tests/fixtures.js';
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import { withTransaction } from '../../db/transaction.js';
import { type EmailChannel, emailChannelFromEnv } from '../../mail/config.js';
import { bodyOf, type FakeSmtp, headersOf, startFakeSmtp } from '../../mail/fake-smtp.fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { runScheduledJobs } from '../../worker/scheduler.js';
import { type EventSpec, fanOut, runCelebrations } from './dispatcher.js';
import { deliverDueEmails } from './email-delivery.js';

let h: Harness;
let A: Company;
let admin: TestActor;
let owner: TestActor;
let hr: TestActor;
let employee: TestActor;
let employeeEmp: string;
let smtp: FakeSmtp;
let channel: EmailChannel;
let dir: string;

const PASSWORD = 'synthetic-Smtp-Pa55-for-tests-only';
const MAILER = 'hrms-mailer';
const address = () => `p${randomUUID().slice(0, 12)}@example.invalid`;
const inFuture = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const resetSmtp = () => {
  smtp.reset();
  smtp.behaviour.credentials = { user: MAILER, password: PASSWORD };
};
const setAddress = async (userId: string, key = address()) => {
  await h.db.query(`update user_account set account_key = $2 where id = $1`, [userId, key]);
  return key;
};
const pass = (c: EmailChannel | null | undefined = channel) => deliverDueEmails(h.pool, c);

interface EmailRow {
  id: string;
  state: string;
  title: string | null;
  body: string | null;
  wait: number | null;
}
const emailsOf = async (userId: string, category: string) =>
  (
    await h.db.query<EmailRow>(
      `select id, state, title, body, round(extract(epoch from email_next_attempt_at - now()) / 60)::int as wait
         from notification where recipient_user_id = $1 and channel = 'EMAIL' and category = $2 order by created_at, id`,
      [userId, category],
    )
  ).rows;
const attemptsOf = async (id: string) =>
  (
    await h.db.query<{ outcome: string; code: string | null; ref: string | null }>(
      `select outcome, failure_code as code, provider_result_reference as ref from notification_delivery_attempt where notification_id = $1 order by attempt_number`,
      [id],
    )
  ).rows;
const due = (id: string) => h.db.query(`update notification set email_next_attempt_at = now() - interval '1 second' where id = $1`, [id]);

/** FR-085 / C6: the email rule is proposed by one administrator, published by another, and comes into force at its date (moved here). */
async function enableEmail(code: string, by: { admin: TestActor; owner: TestActor } = { admin, owner }, body: Record<string, unknown> = {}) {
  const res = await h.call(by.admin, 'POST', `/v1/notifications/rules/${code}/email`, { effectiveFrom: inFuture(60), reason: 'Email for this event (synthetic)', ...body });
  expect(res.statusCode, res.body).toBe(201);
  const { id } = res.json() as { id: string };
  const { version } = await h.one<{ version: number }>(`select version from notification_rule where id = $1`, [id]);
  const published = await h.call(by.owner, 'POST', `/v1/notifications/rules/proposals/${id}/publish`, { expectedVersion: version });
  expect(published.statusCode, published.body).toBe(200);
  await h.db.query(`update notification_rule set effective_from = now() - interval '1 second' where id = $1`, [id]);
  return res.json() as { id: string; code: string };
}

const event = (companyId: string, spec: Partial<EventSpec> & { eventType: string }) =>
  withTransaction(h.pool, (tx) =>
    fanOut(tx, companyId, uniq('email-test:'), null, { subjectEmployeeId: null, transactionId: null, transactionRevision: null, taskId: null, beneficiaryUserId: null, data: {}, ...spec }),
  );
const grantEvent = (userId: string) => event(A.id, { eventType: 'ACCESS_GRANT_APPROVED', beneficiaryUserId: userId, data: { roleCode: 'EMPLOYEE' } });

beforeAll(async () => {
  h = await startHarness();
  smtp = await startFakeSmtp();
  dir = mkdtempSync(join(tmpdir(), 'hrms-email-test-'));
  const passwordFile = join(dir, 'smtp-password');
  writeFileSync(passwordFile, `${PASSWORD}\n`);
  channel = emailChannelFromEnv({
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_SECURITY: 'none',
    SMTP_USER: MAILER,
    SMTP_PASSWORD_FILE: passwordFile,
    SMTP_FROM: 'hrms@example.invalid',
    SMTP_TIMEOUT_MS: '3000',
    APP_PUBLIC_URL: 'https://hr.example.invalid',
  });
  A = await h.makeCompany();
  admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['notification.manage_rules.operational'] });
  owner = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['notification.approve_rules.operational'] });
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  employeeEmp = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id;
  await h.setStatus(A, employeeEmp, 'ACTIVE_CONFIRMED');
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
  await setAddress(employee.user);
});

afterAll(async () => {
  await smtp?.close();
  await h?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => resetSmtp());

describe('email rules (FR-085, DF12)', () => {
  it('FR-085: email is enabled per event only by an explicit proposal that someone else publishes; nothing is assumed', async () => {
    const all = (await h.call(admin, 'GET', '/v1/notifications/rules')).json().items as { channel: string }[];
    expect(all.some((r) => r.channel === 'EMAIL')).toBe(false); // provisioning creates no email rule
    await grantEvent(employee.user);
    expect(await emailsOf(employee.user, 'ACCESS_GRANT_APPROVED')).toEqual([]);

    // Only rule managers propose; the author cannot publish their own proposal (C6, 0133).
    expect((await h.call(hr, 'POST', '/v1/notifications/rules/ACCESS_GRANT_APPROVED/email', { effectiveFrom: inFuture(60), reason: 'x' })).statusCode).toBe(403);
    const proposed = await h.call(admin, 'POST', '/v1/notifications/rules/ACCESS_GRANT_APPROVED/email', { effectiveFrom: inFuture(60), reason: 'Email for grants (synthetic)' });
    expect(proposed.statusCode, proposed.body).toBe(201);
    expect(proposed.json()).toMatchObject({ code: 'ACCESS_GRANT_APPROVED_EMAIL', revision: 1, channel: 'EMAIL', status: 'PROPOSED' });
    const { id } = proposed.json() as { id: string };
    const { version } = await h.one<{ version: number }>(`select version from notification_rule where id = $1`, [id]);
    expect((await h.call(admin, 'POST', `/v1/notifications/rules/proposals/${id}/publish`, { expectedVersion: version })).statusCode).toBe(403);
    expect((await h.call(admin, 'POST', '/v1/notifications/rules/ACCESS_GRANT_APPROVED/email', { effectiveFrom: inFuture(90), reason: 'Again (synthetic)' })).json().error).toBe('EMAIL_RULE_EXISTS');

    // The email rule copies the event, recipients, retry ceiling and optional flag; its template keeps state placeholders only.
    const rule = (await h.call(admin, 'GET', '/v1/notifications/rules?code=ACCESS_GRANT_APPROVED_EMAIL')).json().items[0];
    const inApp = (await h.call(admin, 'GET', '/v1/notifications/rules?code=ACCESS_GRANT_APPROVED')).json().items[0];
    expect(rule).toMatchObject({
      channel: 'EMAIL',
      eventType: 'ACCESS_GRANT_APPROVED',
      recipientSelector: inApp.recipientSelector,
      retryCeiling: inApp.retryCeiling,
      optionalEvent: false,
      status: 'PROPOSED',
      subjectTemplate: 'Role assignment approved',
      bodyTemplate: 'There is a new notice for you in HRMS: Role assignment approved.',
      approvedPlaceholders: [],
    });

    const published = await h.call(owner, 'POST', `/v1/notifications/rules/proposals/${id}/publish`, { expectedVersion: version });
    expect(published.statusCode, published.body).toBe(200);
    await grantEvent(employee.user);
    expect(await emailsOf(employee.user, 'ACCESS_GRANT_APPROVED')).toEqual([]); // not before its date
    await h.db.query(`update notification_rule set effective_from = now() - interval '1 second' where id = $1`, [id]);

    await grantEvent(employee.user);
    const [queued] = await emailsOf(employee.user, 'ACCESS_GRANT_APPROVED');
    expect(queued).toMatchObject({ state: 'QUEUED', title: 'Role assignment approved', body: 'There is a new notice for you in HRMS: Role assignment approved.', wait: 0 });
    // The inbox is in-app only: the email is not a second notice there.
    const inbox = (await h.call(employee, 'GET', '/v1/me/notifications')).json().items as { id: string }[];
    expect(inbox.map((n) => n.id)).not.toContain(queued!.id);
    expect((await h.call(employee, 'POST', `/v1/me/notifications/${queued!.id}/read`)).statusCode).toBe(404);
    await pass();
  });

  it('FR-085: off when unconfigured: nothing is sent and the delivery log says EMAIL_NOT_CONFIGURED', async () => {
    await grantEvent(employee.user);
    await grantEvent(employee.user);
    const before = (await emailsOf(employee.user, 'ACCESS_GRANT_APPROVED')).filter((e) => e.state === 'QUEUED');
    expect(before).toHaveLength(2);
    // The scheduler with no email settings, as a worker started without SMTP_HOST.
    const tick = await runScheduledJobs({ db: h.pool, providers: new Map(), systemUserId: SYSTEM_ACTOR_ID });
    expect(tick.emails).toMatchObject({ channel: 'OFF', sent: 0, suppressed: 2 });
    expect(await pass({ state: 'OFF', reason: 'SMTP_NOT_CONFIGURED' })).toMatchObject({ channel: 'OFF', suppressed: 0 });
    expect(smtp.sessions).toHaveLength(0);
    for (const e of before) expect(await attemptsOf(e.id)).toEqual([{ outcome: 'SUPPRESSED', code: 'EMAIL_NOT_CONFIGURED', ref: null }]);
    const log = (await h.call(admin, 'GET', '/v1/notifications/delivery?category=ACCESS_GRANT_APPROVED&state=SUPPRESSED')).json().items as Record<string, unknown>[];
    expect(log.filter((r) => before.some((e) => e.id === r.id))).toEqual(
      before.map(() => expect.objectContaining({ channel: 'EMAIL', state: 'SUPPRESSED', attempts: 1, lastFailureCode: 'EMAIL_NOT_CONFIGURED' })),
    );
    // A later configuration does not send what was settled while it was off.
    expect((await pass()).sent).toBe(0);
  });
});

describe('sending (FR-085, BR-034)', () => {
  it('FR-085: sends once, by the worker: a second pass and concurrent workers never send it again', async () => {
    const to = (await h.one<{ account_key: string }>(`select account_key from user_account where id = $1`, [employee.user])).account_key;
    const deliveredSoFar = (await emailsOf(employee.user, 'ACCESS_GRANT_APPROVED')).filter((e) => e.state === 'DELIVERED').length;
    await grantEvent(employee.user);
    const tick = await runScheduledJobs({ db: h.pool, providers: new Map(), systemUserId: SYSTEM_ACTOR_ID, email: channel });
    expect(tick.emails).toMatchObject({ channel: 'ON', sent: 1, failed: 0 });
    const sent = (await emailsOf(employee.user, 'ACCESS_GRANT_APPROVED')).at(-1);
    expect(sent!.state).toBe('DELIVERED');
    expect(await attemptsOf(sent!.id)).toEqual([{ outcome: 'DELIVERED', code: null, ref: '2.0.0 Ok: queued as FAKE0001' }]);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]!.to).toEqual([to]);
    expect(headersOf(smtp.messages[0]!)).toContain(`Message-ID: <${sent!.id}@example.invalid>`);
    expect(bodyOf(smtp.messages[0]!)).toContain('Sign in to HRMS to see the details: https://hr.example.invalid');
    expect((await pass()).sent).toBe(0);
    expect(smtp.messages).toHaveLength(1);

    // Three emails due and two workers at once: each is sent exactly once.
    for (let i = 0; i < 3; i++) await grantEvent(employee.user);
    const outcomes = await Promise.all([pass(), pass()]);
    expect(outcomes[0]!.sent + outcomes[1]!.sent).toBe(3);
    expect(smtp.messages).toHaveLength(4);
    expect(new Set(smtp.messages.map((m) => headersOf(m).find((l) => l.startsWith('Message-ID')))).size).toBe(4);
    const delivered = (await emailsOf(employee.user, 'ACCESS_GRANT_APPROVED')).filter((e) => e.state === 'DELIVERED');
    expect(delivered).toHaveLength(deliveredSoFar + 4);
    for (const e of delivered) expect((await attemptsOf(e.id)).filter((a) => a.outcome === 'DELIVERED')).toHaveLength(1);
  });

  it('BR-034: the database refuses a second delivery and an email marked delivered without the send that claimed it', async () => {
    await grantEvent(employee.user);
    const [queued] = (await emailsOf(employee.user, 'ACCESS_GRANT_APPROVED')).filter((e) => e.state === 'QUEUED');
    await expectSqlError(h.db.query(`update notification set state = 'DELIVERED', email_next_attempt_at = null where id = $1`, [queued!.id]), CHECK_VIOLATION);
    await pass();
    const [last] = (await emailsOf(employee.user, 'ACCESS_GRANT_APPROVED')).filter((e) => e.id === queued!.id);
    expect(last!.state).toBe('DELIVERED');
    await expectSqlError(
      h.db.query(
        `insert into notification_delivery_attempt (company_id, notification_id, attempt_number, outcome, outcome_at, created_by, updated_by) values ($1, $2, 9, 'DELIVERED', now(), $3, $3)`,
        [A.id, last!.id, SYSTEM_ACTOR_ID],
      ),
      '23505',
    );
  });

  it('FR-085: a failed send is retried after 1, 5 and 15 minutes up to the rule ceiling, then FAILED, with every attempt recorded', async () => {
    smtp.behaviour.dataReply = '451 4.3.0 Try again later';
    await grantEvent(employee.user);
    const [email] = (await emailsOf(employee.user, 'ACCESS_GRANT_APPROVED')).filter((e) => e.state === 'QUEUED');
    const waits: (number | null)[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (attempt > 1) {
        expect((await pass()).retrying + (await pass()).failed).toBe(0); // not before its time
        await due(email!.id);
      }
      await pass();
      const now = (await emailsOf(employee.user, 'ACCESS_GRANT_APPROVED')).find((e) => e.id === email!.id)!;
      waits.push(now.state === 'RETRY_PENDING' ? now.wait : null);
      if (attempt === 4) expect(now.state).toBe('FAILED');
    }
    expect(waits).toEqual([1, 5, 15, null]);
    expect(await attemptsOf(email!.id)).toEqual(Array.from({ length: 4 }, () => ({ outcome: 'FAILED', code: 'SMTP_MESSAGE_451', ref: null })));
    expect(smtp.messages.length).toBe(4); // offered four times, never accepted
    await due(email!.id).catch(() => undefined);
    expect((await pass()).failed).toBe(0);
    expect(smtp.sessions).toHaveLength(4);
  });

  it('FR-085: the retry ceiling is the rule configuration: with none, the first failure is final', async () => {
    await h.db.query(`update notification_rule set retry_ceiling = 0 where company_id = $1 and code = 'ACCESS_GRANT_APPROVED_EMAIL'`, [A.id]);
    try {
      smtp.behaviour.dataReply = '421 4.4.2 Timeout';
      await grantEvent(employee.user);
      const [email] = (await emailsOf(employee.user, 'ACCESS_GRANT_APPROVED')).filter((e) => e.state === 'QUEUED');
      expect((await pass()).failed).toBe(1);
      expect(await attemptsOf(email!.id)).toEqual([{ outcome: 'FAILED', code: 'SMTP_MESSAGE_421', ref: null }]);
    } finally {
      await h.db.query(`update notification_rule set retry_ceiling = 3 where company_id = $1 and code = 'ACCESS_GRANT_APPROVED_EMAIL'`, [A.id]);
    }
  });

  it('FR-085: a refusal is final at once, and a send whose outcome cannot be known is never sent again', async () => {
    smtp.behaviour.rcptReply = '550 5.1.1 No such user';
    await grantEvent(employee.user);
    let [email] = (await emailsOf(employee.user, 'ACCESS_GRANT_APPROVED')).filter((e) => e.state === 'QUEUED');
    expect((await pass()).failed).toBe(1);
    expect(await attemptsOf(email!.id)).toEqual([{ outcome: 'FAILED', code: 'SMTP_RCPT_550', ref: null }]);

    resetSmtp();
    smtp.behaviour.dropAfterMessage = true;
    await grantEvent(employee.user);
    [email] = (await emailsOf(employee.user, 'ACCESS_GRANT_APPROVED')).filter((e) => e.state === 'QUEUED');
    expect((await pass()).failed).toBe(1);
    expect(await attemptsOf(email!.id)).toEqual([{ outcome: 'FAILED', code: 'SMTP_OUTCOME_UNKNOWN', ref: null }]);
    expect(smtp.messages).toHaveLength(1);
    await pass();
    expect(smtp.messages).toHaveLength(1);

    // A worker that died after claiming a send: once the lease has passed it is settled, not sent.
    resetSmtp();
    await grantEvent(employee.user);
    [email] = (await emailsOf(employee.user, 'ACCESS_GRANT_APPROVED')).filter((e) => e.state === 'QUEUED');
    await h.db.query(`update notification set email_next_attempt_at = null, email_sending_since = now() - interval '2 hours' where id = $1`, [email!.id]);
    expect((await pass()).failed).toBe(1);
    expect(await attemptsOf(email!.id)).toEqual([{ outcome: 'FAILED', code: 'OUTCOME_UNKNOWN', ref: null }]);
    expect(smtp.sessions).toHaveLength(0);
  });
});

describe('content (BR-044, DF12)', () => {
  it('BR-044: no confidential value reaches the subject or body, and a value cannot inject a header', async () => {
    await enableEmail('LEAVE_DECIDED');
    await event(A.id, {
      eventType: 'LEAVE_DECIDED',
      subjectEmployeeId: employeeEmp,
      data: {
        leaveType: 'Annual',
        startDate: '2026-12-01',
        endDate: '2026-12-03',
        outcome: 'approved\r\nBcc: someone@example.invalid',
        // Values a careless describer might add: none is an approved email placeholder.
        salary: '85,000.00',
        amount: 'INR 12345',
        bankAccount: 'GB82WEST12345698765432',
        percent: '12.5%',
      },
    });
    const [email] = await emailsOf(employee.user, 'LEAVE_DECIDED');
    expect(email).toMatchObject({ state: 'QUEUED', title: 'Leave request approved Bcc: someone at example.invalid' });
    expect((await pass()).sent).toBe(1);
    const sent = smtp.messages[0]!;
    const text = `${headersOf(sent).find((l) => l.startsWith('Subject:'))}\n${bodyOf(sent)}`;
    for (const value of ['Annual', '2026-12-01', '2026-12-03', '85,000', '12345', 'GB82', '12.5', '%', 'INR']) expect(text).not.toContain(value);
    expect(headersOf(sent).filter((l) => /^Bcc:/i.test(l))).toEqual([]);
    expect(sent.to).toHaveLength(1);
    expect(bodyOf(sent)).toBe(
      'There is a new notice for you in HRMS: Leave request approved Bcc: someone at example.invalid.\r\n\r\nSign in to HRMS to see the details: https://hr.example.invalid\r\n\r\nThis is an automatic message from HRMS; replies are not read. It never contains confidential details.',
    );
  });

  it('BR-044: a figure in an approved value is blocked when queued and again before sending; nothing is sent', async () => {
    await event(A.id, { eventType: 'LEAVE_DECIDED', subjectEmployeeId: employeeEmp, data: { outcome: 'approved for 12,500.00' } });
    const blocked = (await emailsOf(employee.user, 'LEAVE_DECIDED')).at(-1)!;
    expect(blocked.state).toBe('FAILED');
    expect(await attemptsOf(blocked.id)).toEqual([{ outcome: 'FAILED', code: 'CONFIDENTIAL_CONTENT_BLOCKED', ref: null }]);
    // Content changed after queueing (a direct write) is checked again just before the send.
    await event(A.id, { eventType: 'LEAVE_DECIDED', subjectEmployeeId: employeeEmp, data: { outcome: 'rejected' } });
    const queued = (await emailsOf(employee.user, 'LEAVE_DECIDED')).at(-1)!;
    await h.db.query(`update notification set body = 'Your salary of INR 50000 was paid' where id = $1`, [queued.id]);
    expect((await pass()).failed).toBe(1);
    expect(await attemptsOf(queued.id)).toEqual([{ outcome: 'FAILED', code: 'CONFIDENTIAL_CONTENT_BLOCKED', ref: null }]);
    expect(smtp.sessions).toHaveLength(0);
  });

  it('BR-044: email wording is refused with an unapproved placeholder, an amount, a percentage or a link, and the database refuses an unsafe template', async () => {
    const propose = (body: Record<string, unknown>) => h.call(admin, 'POST', '/v1/notifications/rules/WORK_REQUEST_DECIDED/email', { effectiveFrom: inFuture(60), reason: 'Wording (synthetic)', ...body });
    const refusal = async (body: Record<string, unknown>) => {
      const res = await propose(body);
      expect(res.statusCode, res.body).toBe(422);
      return res.json() as { error: string; details?: Record<string, unknown> };
    };
    expect(await refusal({ bodyTemplate: 'Your request from {{startDate}} was {{outcome}}.' })).toMatchObject({ error: 'PLACEHOLDER_NOT_APPROVED', details: { placeholder: 'startDate' } });
    expect(await refusal({ bodyTemplate: 'Your salary of INR 50000 is {{outcome}}.' })).toMatchObject({ error: 'EMAIL_WORDING_NOT_ALLOWED', details: { reason: 'LONG_NUMBER' } });
    expect(await refusal({ subjectTemplate: 'A 12% increment' })).toMatchObject({ error: 'EMAIL_WORDING_NOT_ALLOWED', details: { reason: 'PERCENTAGE' } });
    expect(await refusal({ bodyTemplate: 'See https://elsewhere.example.invalid/x' })).toMatchObject({ error: 'EMAIL_WORDING_NOT_ALLOWED', details: { reason: 'LINK' } });
    expect(await refusal({ bodyTemplate: 'Paid in INR: {{outcome}}' })).toMatchObject({ error: 'EMAIL_WORDING_NOT_ALLOWED', details: { reason: 'CURRENCY' } });
    const ok = await propose({ subjectTemplate: 'Work request {{outcome}}', bodyTemplate: 'Your {{requestKind}} request was {{outcome}}.' });
    expect(ok.statusCode, ok.body).toBe(201);

    // A revision of an email rule is held to the same wording rules.
    const { version } = await h.one<{ version: number }>(`select version from notification_rule where id = $1`, [ok.json().id]);
    expect((await h.call(owner, 'POST', `/v1/notifications/rules/proposals/${ok.json().id}/publish`, { expectedVersion: version })).statusCode).toBe(200);
    const revision = await h.call(admin, 'POST', '/v1/notifications/rules/WORK_REQUEST_DECIDED_EMAIL/revisions', {
      expectedRevision: 1,
      effectiveFrom: inFuture(120),
      bodyTemplate: 'Paid 15% more: {{outcome}}',
      reason: 'Wording (synthetic)',
    });
    expect(revision.json().error).toBe('EMAIL_WORDING_NOT_ALLOWED');

    await expectSqlError(
      h.db.query(
        `insert into notification_template (company_id, code, revision, language, channel, subject_template, body_template, approved_placeholders, active, created_by, updated_by)
         values ($1, 'DIRECT_EMAIL', 1, 'en', 'EMAIL', 'x', 'Hello {{employeeName}}', array['employeeName'], true, $2, $2)`,
        [A.id, SYSTEM_ACTOR_ID],
      ),
      CHECK_VIOLATION,
    );
  });

  it('FR-085: an email rule may be switched off again (DF12 keeps mandatory notices in-app); an in-app mandatory rule may not', async () => {
    const off = await h.call(admin, 'POST', '/v1/notifications/rules/LEAVE_DECIDED_EMAIL/revisions', { expectedRevision: 1, effectiveFrom: inFuture(60), active: false, reason: 'Email off (synthetic)' });
    expect(off.statusCode, off.body).toBe(201);
    const inApp = await h.call(admin, 'POST', '/v1/notifications/rules/LEAVE_DECIDED/revisions', { expectedRevision: 1, effectiveFrom: inFuture(60), active: false, reason: 'Off (synthetic)' });
    expect(inApp.json().error).toBe('MANDATORY_RULE');
    await h.call(owner, 'POST', `/v1/notifications/rules/proposals/${off.json().id}/reject`, {
      expectedVersion: (await h.one<{ version: number }>(`select version from notification_rule where id = $1`, [off.json().id])).version,
      reason: 'Keep it (synthetic)',
    });
  });
});

describe('recipients (FR-085, DF12)', () => {
  it('FR-085: an inactive account is never mailed, nor one without an address or outside the safe test list', async () => {
    const other = await h.actor(A, 'EMPLOYEE', { employeeId: (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id });
    const key = await setAddress(other.user);
    await grantEvent(other.user);
    await h.db.query(`update user_account set active = false where id = $1`, [other.user]);
    expect((await pass()).suppressed).toBe(1);
    let [email] = await emailsOf(other.user, 'ACCESS_GRANT_APPROVED');
    expect(await attemptsOf(email!.id)).toEqual([{ outcome: 'SUPPRESSED', code: 'RECIPIENT_INACTIVE', ref: null }]);
    // Inactive when the event is processed: not even queued.
    await grantEvent(other.user);
    email = (await emailsOf(other.user, 'ACCESS_GRANT_APPROVED')).at(-1);
    expect(email!.state).toBe('SUPPRESSED');
    expect(await attemptsOf(email!.id)).toEqual([{ outcome: 'SUPPRESSED', code: 'RECIPIENT_NOT_ELIGIBLE', ref: null }]);
    await h.db.query(`update user_account set active = true where id = $1`, [other.user]);

    // DF12 "safe recipient tests": with a test list, everyone else is suppressed.
    const testOnly = emailChannelFromEnv({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.port),
      SMTP_SECURITY: 'none',
      SMTP_FROM: 'hrms@example.invalid',
      APP_PUBLIC_URL: 'https://hr.example.invalid',
      EMAIL_TEST_RECIPIENTS: `${key}, @qa.example.invalid`,
    });
    smtp.behaviour.credentials = null;
    await grantEvent(other.user);
    await grantEvent(employee.user);
    const outcome = await pass(testOnly);
    expect(outcome).toMatchObject({ sent: 1, suppressed: 1 });
    expect(smtp.messages.map((m) => m.to)).toEqual([[key]]);
    expect(await attemptsOf((await emailsOf(employee.user, 'ACCESS_GRANT_APPROVED')).at(-1)!.id)).toEqual([{ outcome: 'SUPPRESSED', code: 'RECIPIENT_NOT_IN_TEST_LIST', ref: null }]);

    // An account key that is not an address (a development account) is never mailed.
    resetSmtp();
    await h.db.query(`update user_account set account_key = $2 where id = $1`, [other.user, `dev.${randomUUID().slice(0, 8)}`]);
    await grantEvent(other.user);
    expect((await pass()).suppressed).toBe(1);
    expect(await attemptsOf((await emailsOf(other.user, 'ACCESS_GRANT_APPROVED')).at(-1)!.id)).toEqual([{ outcome: 'SUPPRESSED', code: 'NO_EMAIL_ADDRESS', ref: null }]);
    expect(smtp.sessions).toHaveLength(0);
  });

  it('FR-085: preferences are respected for an optional event by email, and mandatory notices are still sent', async () => {
    const B = await h.makeCompany();
    const by = {
      admin: await h.actor(B, 'SYSTEM_ADMINISTRATOR', { extra: ['notification.manage_rules.operational'] }),
      owner: await h.actor(B, 'HR_ADMINISTRATOR', { extra: ['notification.approve_rules.operational'] }),
    };
    const hrB = await h.actor(B, 'HR_ADMINISTRATOR');
    const person = async () => {
      const e = (await h.call(hrB, 'POST', '/v1/employees', h.newEmployeeBody(B))).json().id as string;
      await h.setStatus(B, e, 'ACTIVE_CONFIRMED');
      const actor = await h.actor(B, 'EMPLOYEE', { employeeId: e });
      await setAddress(actor.user);
      return { e, actor };
    };
    const celebrant = await person();
    const [keeps, optedOut, laterOut] = [await person(), await person(), await person()];
    await enableEmail('BIRTHDAY', by);
    await h.db.query(`update employee set date_of_birth = '1990-11-10' where id = $1`, [celebrant.e]);
    expect((await h.call(celebrant.actor, 'PUT', '/v1/me/notification-preferences', { eventType: 'BIRTHDAY', publishCelebration: true })).statusCode).toBe(200);
    const optOut = await h.call(optedOut.actor, 'PUT', '/v1/me/notification-preferences', { eventType: 'BIRTHDAY', receiveEmail: false });
    expect(optOut.json()).toMatchObject({ eventType: 'BIRTHDAY', receiveOptional: true, receiveEmail: false });
    expect((await h.call(optedOut.actor, 'GET', '/v1/me/notification-preferences')).json().items[0]).toMatchObject({ eventType: 'BIRTHDAY', receiveOptional: true, receiveEmail: false });

    await runCelebrations(h.pool, B.id, '2027-11-10');
    expect((await emailsOf(keeps.actor.user, 'BIRTHDAY')).map((e) => e.state)).toEqual(['QUEUED']);
    const [suppressed] = await emailsOf(optedOut.actor.user, 'BIRTHDAY');
    expect(suppressed!.state).toBe('SUPPRESSED');
    expect(await attemptsOf(suppressed!.id)).toEqual([{ outcome: 'SUPPRESSED', code: 'RECIPIENT_OPTED_OUT', ref: null }]);
    // The in-app celebration still reaches the one who opted out of email only.
    expect(((await h.call(optedOut.actor, 'GET', '/v1/me/notifications')).json().items as { category: string }[]).some((n) => n.category === 'BIRTHDAY')).toBe(true);
    // Opting out after queueing is honoured at the send (DF12 "recheck ... preferences at delivery").
    await h.call(laterOut.actor, 'PUT', '/v1/me/notification-preferences', { eventType: 'BIRTHDAY', receiveEmail: false });
    await pass();
    expect((await emailsOf(keeps.actor.user, 'BIRTHDAY')).map((e) => e.state)).toEqual(['DELIVERED']);
    const [later] = await emailsOf(laterOut.actor.user, 'BIRTHDAY');
    expect(await attemptsOf(later!.id)).toEqual([{ outcome: 'SUPPRESSED', code: 'RECIPIENT_OPTED_OUT', ref: null }]);
    const keepsKey = (await h.one<{ account_key: string }>(`select account_key from user_account where id = $1`, [keeps.actor.user])).account_key;
    expect(smtp.messages.map((m) => m.to[0])).toContain(keepsKey);
    expect(smtp.messages.map((m) => m.to[0])).not.toContain((await h.one<{ account_key: string }>(`select account_key from user_account where id = $1`, [optedOut.actor.user])).account_key);

    // Mandatory: no preference is offered, and a stored one is not read (FR-085 "mandatory transaction alerts cannot be opted out").
    expect((await h.call(employee, 'PUT', '/v1/me/notification-preferences', { eventType: 'ACCESS_GRANT_APPROVED', receiveEmail: false })).statusCode).toBe(400);
    await h.db.query(
      `insert into notification_preference (company_id, user_id, event_type, channel, publish_celebration, receive_optional, created_by, updated_by)
       values ($1, $2, 'ACCESS_GRANT_APPROVED', 'EMAIL', false, false, $2, $2)`,
      [A.id, employee.user],
    );
    resetSmtp();
    await grantEvent(employee.user);
    expect((await pass()).sent).toBe(1);
    expect((await emailsOf(employee.user, 'ACCESS_GRANT_APPROVED')).at(-1)!.state).toBe('DELIVERED');
  });
});

describe('secrets (FR-085)', () => {
  it('FR-085: the SMTP password is read from its file, used only in the sign-in, and never written to the log, audit or output', async () => {
    const output: string[] = [];
    const spies = (['log', 'error', 'warn', 'info'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void output.push(args.map(String).join(' '))));
    try {
      await grantEvent(employee.user);
      smtp.behaviour.dataReply = '452 4.3.1 Insufficient system storage';
      const tick = await runScheduledJobs({ db: h.pool, providers: new Map(), systemUserId: SYSTEM_ACTOR_ID, email: channel });
      output.push(JSON.stringify(tick), JSON.stringify(channel));
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(smtp.messages.at(-1)!.auth).toEqual({ user: MAILER, password: PASSWORD });
    const encoded = Buffer.from(PASSWORD).toString('base64');
    const stored = await h.db.query<{ t: string }>(
      `select coalesce(string_agg(t, ' '), '') as t from (
         select coalesce(failure_code, '') || ' ' || coalesce(provider_result_reference, '') as t from notification_delivery_attempt
         union all select coalesce(title, '') || ' ' || coalesce(body, '') from notification
         union all select coalesce(after_values::text, '') || ' ' || coalesce(reason, '') from audit_event
         union all select coalesce(detail::text, '') from scheduled_job_run
         union all select coalesce(last_error, '') from outbox_event) x`,
    );
    for (const text of [output.join('\n'), stored.rows[0]!.t]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(encoded);
    }
  });
});
