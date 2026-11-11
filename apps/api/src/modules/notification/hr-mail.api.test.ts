// HR sends one message to chosen employees by email (BRD coverage CL-041 "Send Mail", under FR-085 channels and the delivery log; FR-061;
// DF12 email only once configured; BR-026 row scope; BR-034; BR-044 and H7 email content; migration 0282). The mail server is the
// channel's test transport: an in-process fake SMTP server (mail/fake-smtp.fixtures.ts), no real mail, no network. Synthetic data only.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type EmailChannel, emailChannelFromEnv } from '../../mail/config.js';
import { bodyOf, type FakeSmtp, headersOf, startFakeSmtp } from '../../mail/fake-smtp.fixtures.js';
import { EICAR_TEST_STRING } from '../../storage/scan.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { deliverDueEmails } from './email-delivery.js';
import { MAX_RECIPIENTS, MAX_RECIPIENTS_PER_DAY } from './hr-mail.js';

let h: Harness;
let A: Company;
let B: Company;
let hr: TestActor;
let hrEng: TestActor;
let hrPlain: TestActor;
let employee: TestActor;
let hrB: TestActor;
let smtp: FakeSmtp;
let channel: EmailChannel;
type Person = { id: string; code: string; email: string | null };
let eng1: Person;
let eng2: Person;
let fin1: Person;
let noEmail: Person;
let left: Person;
let other: Person;

const SEND: 'hr_mail.send.message' = 'hr_mail.send.message';
const csv = (lines: string[]) => Buffer.from(`${lines.join('\r\n')}\r\n`).toString('base64');
const emailOn = () => vi.stubEnv('SMTP_HOST', '127.0.0.1');
const review = (a: TestActor, body: object) => h.call(a, 'POST', '/v1/hr-mail/recipients', body);
const send = (a: TestActor, body: Record<string, unknown>) =>
  h.call(a, 'POST', '/v1/hr-mail/messages', { subject: 'Office closed on Friday', message: 'The office is closed this Friday for maintenance.\nPlease work from home.', idempotencyKey: uniq('mail-key-'), ...body });
const sends = async (companyId: string) => (await h.one<{ n: number }>(`select count(*)::int as n from hr_mail_send where company_id = $1`, [companyId])).n;
const queued = async (sendId: string) =>
  (await h.db.query<{ employee: string; state: string; user: string | null }>(`select recipient_employee_id as employee, state, recipient_user_id as user from notification where hr_mail_send_id = $1 order by 1`, [sendId])).rows;

beforeAll(async () => {
  h = await startHarness();
  smtp = await startFakeSmtp();
  channel = emailChannelFromEnv({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURITY: 'none', SMTP_FROM: 'hrms@example.invalid', SMTP_TIMEOUT_MS: '3000', APP_PUBLIC_URL: 'https://hr.example.invalid' });
  A = await h.makeCompany();
  B = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [SEND] });
  hrEng = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [SEND], departmentFilter: A.dept });
  hrPlain = await h.actor(A, 'HR_ADMINISTRATOR');
  hrB = await h.actor(B, 'HR_ADMINISTRATOR', { extra: [SEND] });
  const person = async (company: Company, departmentId: string, email: string | null, status = 'ACTIVE_CONFIRMED'): Promise<Person> => {
    const body = h.newEmployeeBody(company, { departmentId, workEmail: email ?? undefined });
    if (email === null) delete body.workEmail;
    const res = await h.call(company === A ? hr : hrB, 'POST', '/v1/employees', body);
    expect(res.statusCode, res.body).toBe(201);
    await h.setStatus(company, res.json().id, status);
    return { id: res.json().id as string, code: String(body.employeeCode).toUpperCase(), email };
  };
  const mail = () => `p${randomUUID().slice(0, 12)}@example.invalid`;
  eng1 = await person(A, A.dept, mail());
  eng2 = await person(A, A.dept, mail(), 'NOTICE');
  fin1 = await person(A, A.financeDept, mail());
  noEmail = await person(A, A.dept, null);
  left = await person(A, A.dept, mail(), 'INACTIVE_SEPARATED');
  other = await person(B, B.dept, mail());
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: eng1.id });
});

afterEach(() => {
  vi.unstubAllEnvs();
  smtp.reset();
});

afterAll(async () => {
  await smtp?.close();
  await h?.stop();
});

describe('CL-041 send mail: the email channel decides', () => {
  it('CL-041 DF12: with no mail server configured the screen is told plainly that email is off and a send queues nothing', async () => {
    vi.stubEnv('SMTP_HOST', '');
    const state = await h.call(hr, 'GET', '/v1/hr-mail/channel');
    expect(state.statusCode, state.body).toBe(200);
    expect(state.json()).toEqual({ email: 'OFF', reason: 'EMAIL_NOT_CONFIGURED', attachments: false, limits: { recipients: MAX_RECIPIENTS, subject: 150, message: 5000, listRows: 2000 } });
    const before = await sends(A.id);
    const res = await send(hr, { employeeIds: [eng1.id] });
    expect([res.statusCode, res.json().error]).toEqual([409, 'EMAIL_NOT_CONFIGURED']);
    expect(await sends(A.id)).toBe(before);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from notification where company_id = $1 and category = 'HR_MESSAGE'`, [A.id])).n).toBe(0);
    // The review still works, so the list can be prepared.
    expect((await review(hr, { employeeIds: [eng1.id] })).json()).toMatchObject({ eligible: 1 });
    emailOn();
    expect((await h.call(hr, 'GET', '/v1/hr-mail/channel')).json()).toMatchObject({ email: 'ON', attachments: false });
  });
});

describe('CL-041 recipients and their review', () => {
  it('CL-041 BR-026: recipients chosen on screen are reviewed: employed, with a work email, in the sender\'s scope; anyone else reads as not found', async () => {
    const res = await review(hr, { employeeIds: [eng1.id, eng2.id, noEmail.id, left.id, other.id, eng1.id] });
    expect(res.statusCode, res.body).toBe(200);
    const byId = new Map((res.json().recipients as { employeeId: string; outcome: string; workEmail: string | null; displayName: string | null }[]).map((r) => [r.employeeId, r]));
    expect(byId.get(eng1.id)).toMatchObject({ outcome: 'ELIGIBLE', workEmail: eng1.email });
    expect(byId.get(eng2.id)).toMatchObject({ outcome: 'ELIGIBLE' });
    expect(byId.get(noEmail.id)).toMatchObject({ outcome: 'NO_WORK_EMAIL', workEmail: null });
    expect(byId.get(left.id)).toMatchObject({ outcome: 'NOT_EMPLOYED', workEmail: null });
    // Another company's employee: not found, and nothing about them is answered.
    expect(byId.get(other.id)).toEqual({ employeeId: other.id, employeeCode: null, displayName: null, workEmail: null, outcome: 'NOT_FOUND' });
    expect(res.json()).toMatchObject({ eligible: 2, refused: 3, maxRecipients: MAX_RECIPIENTS, tooMany: false });

    // A department-filtered sender does not reach the finance employee.
    const scoped = await review(hrEng, { employeeIds: [eng1.id, fin1.id] });
    expect((scoped.json().recipients as { employeeId: string; outcome: string; displayName: string | null }[]).find((r) => r.employeeId === fin1.id)).toMatchObject({ outcome: 'NOT_FOUND', displayName: null });
  });

  it('CL-041 FR-106: an uploaded list of employee codes is scanned in memory, matched exactly ignoring case, and each row says why it is refused', async () => {
    // A blank line is skipped by the CSV reader; a row with more than one cell names no code.
    const res = await review(hr, { contentBase64: csv(['employee_code', eng1.code.toLowerCase(), '', 'ONE,TWO', ` ${fin1.code} `, eng1.code, 'NO-SUCH-CODE', other.code, noEmail.code]) });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json().recipients as { row: number; employeeCode: string | null; outcome: string }[]).map((r) => [r.row, r.employeeCode, r.outcome])).toEqual([
      [2, eng1.code, 'ELIGIBLE'],
      [3, null, 'INVALID_CODE'],
      [4, fin1.code, 'ELIGIBLE'],
      [5, eng1.code, 'DUPLICATE'],
      [6, 'NO-SUCH-CODE', 'NOT_FOUND'],
      [7, other.code, 'NOT_FOUND'],
      [8, noEmail.code, 'NO_WORK_EMAIL'],
    ]);
    expect((await review(hr, { contentBase64: csv(['code', eng1.code]) })).json().error).toBe('INVALID_HEADER');
    expect((await review(hr, { contentBase64: Buffer.from(`employee_code\r\n${EICAR_TEST_STRING}\r\n`, 'latin1').toString('base64') })).json().error).toBe('UPLOAD_QUARANTINED');
    const template = await h.call(hr, 'GET', '/v1/hr-mail/recipients/template');
    expect([template.statusCode, template.body]).toEqual([200, 'employee_code\r\n']);
  });
});

describe('CL-041 sending', () => {
  it('CL-041 FR-085 BR-034: one message is queued per reviewed recipient on the email channel, sent by the worker to the work email, logged per delivery, audited without its text', async () => {
    emailOn();
    const key = uniq('mail-key-');
    const res = await send(hr, { employeeIds: [eng1.id, eng2.id], idempotencyKey: key });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ recipientCount: 2, replayed: false, state: 'QUEUED' });
    const id = res.json().id as string;
    expect((await queued(id)).map((r) => [r.state, r.user])).toEqual([
      ['QUEUED', null],
      ['QUEUED', null],
    ]);
    // A repeat with the same key sends nothing more; the key for anything else is refused.
    const again = await send(hr, { employeeIds: [eng2.id, eng1.id], idempotencyKey: key });
    expect([again.statusCode, again.json().id, again.json().replayed]).toEqual([200, id, true]);
    expect((await send(hr, { employeeIds: [eng1.id], idempotencyKey: key })).json().error).toBe('IDEMPOTENCY_KEY_IN_USE');
    expect(await queued(id)).toHaveLength(2);

    // The audit holds the count only, never the subject or the text.
    const audit = await h.one<{ action: string; resource_code: string; after_values: unknown; actor_user_id: string }>(`select action, resource_code, after_values, actor_user_id from audit_event where record_key = $1`, [id]);
    expect(audit).toEqual({ action: 'SEND', resource_code: 'hr_mail', actor_user_id: hr.user, after_values: { message: { channel: 'EMAIL', recipientCount: 2 } } });
    const trail = (await h.one<{ t: string }>(`select coalesce(string_agg(coalesce(before_values::text, '') || coalesce(after_values::text, ''), ' '), '') as t from audit_event where company_id = $1`, [A.id])).t;
    expect(trail).not.toContain('Office closed');
    expect(trail).not.toContain('maintenance');

    // The worker sends through the channel's transport, to each work email.
    const outcome = await deliverDueEmails(h.pool, channel);
    expect(outcome).toMatchObject({ channel: 'ON', sent: 2, failed: 0 });
    expect(smtp.messages.map((m) => m.to[0]).sort()).toEqual([eng1.email, eng2.email].sort());
    const one = smtp.messages[0]!;
    expect(headersOf(one)).toContain('Subject: Office closed on Friday');
    expect(bodyOf(one)).toContain('The office is closed this Friday for maintenance.');
    expect(bodyOf(one)).toContain('Sent by HR through HRMS: https://hr.example.invalid');
    expect((await queued(id)).map((r) => r.state)).toEqual(['DELIVERED', 'DELIVERED']);

    // The delivery log lists each delivery by employee code, never the address or the text.
    const log = await h.call(await h.actor(A, 'SYSTEM_ADMINISTRATOR'), 'GET', '/v1/notifications/delivery?category=HR_MESSAGE');
    expect(log.statusCode, log.body).toBe(200);
    const rows = log.json().items as { recipientAccount: string; channel: string; state: string; attempts: number }[];
    expect(rows.map((r) => r.recipientAccount).sort()).toEqual([eng1.code, eng2.code].sort());
    expect(rows.every((r) => r.channel === 'EMAIL' && r.state === 'DELIVERED' && r.attempts === 1)).toBe(true);
    expect(log.body).not.toContain('@example.invalid');
    expect(log.body).not.toContain('maintenance');
    // A delivery log reader whose scope leaves those employees out does not see that HR mailed them (security review, 11 Nov 2026).
    const narrowLog = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.financeDept });
    const narrowRows = (await h.call(narrowLog, 'GET', '/v1/notifications/delivery?category=HR_MESSAGE')).json().items as { recipientAccount: string }[];
    expect(narrowRows.map((r) => r.recipientAccount)).not.toContain(eng1.code);
    expect(narrowRows.map((r) => r.recipientAccount)).not.toContain(eng2.code);

    // The sender's own list and the message's deliveries.
    const mine = await h.call(hr, 'GET', '/v1/hr-mail/messages');
    expect(mine.json().items[0]).toMatchObject({ id, recipientCount: 2, subject: 'Office closed on Friday', delivery: { delivered: 2, queued: 0, failed: 0, suppressed: 0 } });
    expect((await h.call(hr, 'GET', `/v1/hr-mail/messages/${id}`)).json().recipients).toHaveLength(2);
    expect((await h.call(hrEng, 'GET', `/v1/hr-mail/messages/${id}`)).statusCode).toBe(404);
  });

  it('CL-041 BR-044 H7: the subject and message are bounded plain text without figures, currency or links; recipients are bounded', async () => {
    emailOn();
    const before = await sends(A.id);
    for (const [body, code] of [
      [{ message: 'Your bonus of Rs 50,000 is credited.' }, 'CONTENT_NOT_ALLOWED'],
      [{ message: 'Read https://example.invalid/policy before Monday.' }, 'CONTENT_NOT_ALLOWED'],
      // Security review, 11 Nov 2026: what mail clients turn into links, and identifiers or amounts written to slip the plain rules.
      [{ message: 'Reset your password at hrstop-login.example/reset today.' }, 'CONTENT_NOT_ALLOWED'],
      [{ message: 'Questions to payroll@elsewhere.example please.' }, 'CONTENT_NOT_ALLOWED'],
      [{ message: 'Your number on record is 1234 5678 9012.' }, 'CONTENT_NOT_ALLOWED'],
      [{ message: 'Your number on record is 1234-5678-9012.' }, 'CONTENT_NOT_ALLOWED'],
      [{ message: `Your bonus is ${String.fromCharCode(0x0967, 0x0968, 0x0969, 0x096a, 0x096b)} now.` }, 'CONTENT_NOT_ALLOWED'],
      [{ message: 'Your bonus is about two lakh this year.' }, 'CONTENT_NOT_ALLOWED'],
      // A tax-number shape, built from parts so the repository's own privacy scan (ZT21) finds no such value in this file.
      [{ message: `Your tax number ${['ABCDE', '1234', 'F'].join('')} is on record.` }, 'CONTENT_NOT_ALLOWED'],
      [{ subject: 'Line one\nBcc: someone@example.invalid' }, 'INVALID_SUBJECT'],
      [{ subject: 'x'.repeat(151) }, 'INVALID_SUBJECT'],
      [{ message: 'y'.repeat(5001) }, 'INVALID_MESSAGE'],
    ] as const) {
      const res = await send(hr, { employeeIds: [eng1.id], ...body });
      expect([res.statusCode, res.json().error], JSON.stringify(body).slice(0, 60)).toEqual([422, code]);
    }
    const tooMany = await send(hr, { employeeIds: Array.from({ length: MAX_RECIPIENTS + 1 }, () => randomUUID()) });
    expect([tooMany.statusCode, tooMany.json().error]).toEqual([422, 'TOO_MANY_RECIPIENTS']);
    expect(await sends(A.id)).toBe(before);
  });

  it('CL-041: one sender mails at most MAX_RECIPIENTS_PER_DAY recipients in any 24 hours, over all their messages', async () => {
    emailOn();
    const sender = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [SEND] });
    // Four earlier messages of 500 today fill the day.
    for (let i = 0; i < MAX_RECIPIENTS_PER_DAY / MAX_RECIPIENTS; i++) {
      await h.db.query(
        `insert into hr_mail_send (company_id, sent_by, acting_assignment_id, idempotency_key, request_hash, recipient_count) values ($1, $2, $3, $4, $5, $6)`,
        [A.id, sender.user, sender.assignment, uniq('daily-fill-'), 'a'.repeat(64), MAX_RECIPIENTS],
      );
    }
    const before = await sends(A.id);
    const res = await send(sender, { employeeIds: [eng1.id] });
    expect([res.statusCode, res.json().error]).toEqual([429, 'DAILY_LIMIT']);
    expect(res.json().details).toMatchObject({ max: MAX_RECIPIENTS_PER_DAY, sentToday: MAX_RECIPIENTS_PER_DAY });
    expect(await sends(A.id)).toBe(before);
  });

  it('CL-041 BR-026: the send re-checks every reviewed recipient and is refused whole when one is no longer eligible or outside the scope', async () => {
    emailOn();
    const before = await sends(A.id);
    const changed = await send(hr, { employeeIds: [eng1.id, noEmail.id] });
    expect([changed.statusCode, changed.json().error]).toEqual([422, 'RECIPIENTS_NOT_ELIGIBLE']);
    expect(changed.json().details.recipients).toEqual([{ employeeId: noEmail.id, outcome: 'NO_WORK_EMAIL' }]);
    const scoped = await send(hrEng, { employeeIds: [eng1.id, fin1.id] });
    expect(scoped.json().details.recipients).toEqual([{ employeeId: fin1.id, outcome: 'NOT_FOUND' }]);
    expect((await send(hrB, { employeeIds: [eng1.id] })).json().details.recipients).toEqual([{ employeeId: eng1.id, outcome: 'NOT_FOUND' }]);
    expect(await sends(A.id)).toBe(before);
  });

  it('CL-041 DF12: the worker checks each recipient again when it sends: someone who left is suppressed; with the channel off everything open is suppressed', async () => {
    emailOn();
    const res = await send(hr, { employeeIds: [eng1.id, fin1.id] });
    expect(res.statusCode, res.body).toBe(201);
    await h.setStatus(A, fin1.id, 'INACTIVE_SEPARATED');
    await deliverDueEmails(h.pool, channel);
    const states = await h.db.query<{ employee: string; state: string; code: string | null }>(
      `select n.recipient_employee_id as employee, n.state, (select a.failure_code from notification_delivery_attempt a where a.notification_id = n.id order by a.attempt_number desc limit 1) as code
         from notification n where n.hr_mail_send_id = $1`,
      [res.json().id],
    );
    expect(Object.fromEntries(states.rows.map((r) => [r.employee, [r.state, r.code]]))).toEqual({ [eng1.id]: ['DELIVERED', null], [fin1.id]: ['SUPPRESSED', 'RECIPIENT_NOT_ELIGIBLE'] });
    expect(smtp.messages.map((m) => m.to[0])).toEqual([eng1.email]);
    await h.setStatus(A, fin1.id, 'ACTIVE_CONFIRMED');

    // Queued while configured, then the worker runs without settings: nothing is sent.
    const late = await send(hr, { employeeIds: [eng2.id] });
    smtp.reset();
    const off = await deliverDueEmails(h.pool, { state: 'OFF', reason: 'SMTP_NOT_CONFIGURED' });
    expect(off).toMatchObject({ channel: 'OFF', sent: 0 });
    expect(smtp.messages).toEqual([]);
    expect((await queued(late.json().id)).map((r) => r.state)).toEqual(['SUPPRESSED']);
  });

  it('CL-041 BR-044: only an assignment granted the confidential send right can send, review or read sent messages', async () => {
    emailOn();
    for (const a of [hrPlain, employee]) {
      expect((await h.call(a, 'GET', '/v1/hr-mail/channel')).statusCode).toBe(403);
      expect((await review(a, { employeeIds: [eng1.id] })).statusCode).toBe(403);
      expect((await send(a, { employeeIds: [eng1.id] })).statusCode).toBe(403);
      expect((await h.call(a, 'GET', '/v1/hr-mail/messages')).statusCode).toBe(403);
    }
    // The right is not a default duty of any role.
    expect((await h.one<{ n: number }>(`select count(*)::int as n from role_assignment_permission rap join permission p on p.id = rap.permission_id where rap.role_assignment_id = $1 and p.resource = 'hr_mail'`, [hrPlain.assignment])).n).toBe(0);
  });
});
