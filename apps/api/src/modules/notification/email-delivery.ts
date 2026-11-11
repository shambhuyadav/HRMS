// The worker's email sends (FR-085 "delivery attempts, retry limits and visible failed-delivery outcomes"; FR-061; DF12 "retries
// 1/5/15 minutes then FAILED", "recheck recipient/classification/preferences at delivery"; BR-034, BR-044). Never in a web request.
//
// The dispatcher queues an email notice already rendered, after the full recipient check for its rule's selector (dispatcher.ts).
// Each pass here then:
//   1. settles sends whose worker died after claiming them (EMAIL_SEND_LEASE_MS): FAILED, OUTCOME_UNKNOWN, never sent again;
//   2. with the channel OFF (no SMTP settings), settles every open email SUPPRESSED, EMAIL_NOT_CONFIGURED: nothing is sent, and
//      nothing waits to be sent later about events long past;
//   3. with the channel ON, takes due emails one company at a time in turn. In one transaction it checks the recipient again (active
//      account, an active assignment in the company, the optional-event preference, a usable address, the test list; for an HR message
//      to an employee, CL-041 and 0282: still employed, with a usable work email, and the test list) and the content
//      again (email-content.ts), then claims the send (email_sending_since) and commits. Only then does it talk to the mail server,
//      holding no transaction. The outcome is recorded only by the claim that sent it (the claim's time fences it), with one
//      delivery attempt per send; the attempt keeps a failure class or the server's queue reference, never an address or text.
// So a second worker never takes a claimed email, a retry never follows an attempt that may have been accepted, and the database
// refuses a second DELIVERED attempt and an email marked DELIVERED without a claim (0247). Retries follow the rule's retry ceiling
// (default 3), waiting 1, 5 and 15 minutes (15 for any later one), as the outbox does; a 5xx refusal is final at once.
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import { companyTurns } from '../../db/company-turns.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import type { EmailChannel, EmailChannelSettings } from '../../mail/config.js';
import { isMailAddress, type MailMessage, type MailSender, type SendResult } from '../../mail/smtp.js';
import { emailBodyText, emailContentRefusal, emailSubjectLine, HR_MAIL_CATEGORY, hrMessageBodyText } from './email-content.js';

/** DF12: a failed attempt is retried after 1, 5 and 15 minutes; a rule with a higher ceiling waits 15 minutes for each later one. */
export const EMAIL_RETRY_MINUTES: readonly number[] = [1, 5, 15];

/** The wait before retry number `retry` (1 for the first). */
export const emailRetryMinutes = (retry: number): number => EMAIL_RETRY_MINUTES[Math.min(retry, EMAIL_RETRY_MINUTES.length) - 1]!;

export interface EmailPassOutcome {
  channel: 'ON' | 'OFF';
  sent: number;
  /** Failed attempts that will be tried again. */
  retrying: number;
  /** Ended FAILED in this pass: refused, out of retries, content blocked, or an outcome that cannot be known. */
  failed: number;
  /** Not sent on purpose: the channel is off, or the recipient is no longer eligible, opted out, has no address or is not on the test list. */
  suppressed: number;
  /** The pass stopped early because the mail server kept failing. */
  paused: boolean;
}

/** A send claimed before the worker's restart, longer than the lease: it may have gone, so it ends FAILED and is never retried. */
const DEFAULT_LEASE_MS = 600_000;

const ATTEMPT_NUMBER = `coalesce((select max(a.attempt_number) from notification_delivery_attempt a where a.company_id = s.company_id and a.notification_id = s.id), 0) + 1`;

async function settleLapsedSends(db: Queryable, leaseMs: number): Promise<number> {
  const res = await db.query(
    `with lapsed as (
       select id from notification where email_sending_since is not null and email_sending_since < now() - make_interval(secs => $1::double precision / 1000)
        order by email_sending_since limit 500 for update skip locked
     ), s as (
       update notification n set state = 'FAILED', email_sending_since = null, updated_by = $2 from lapsed where n.id = lapsed.id returning n.company_id, n.id
     )
     insert into notification_delivery_attempt (company_id, notification_id, attempt_number, outcome, outcome_at, failure_code, created_by, updated_by)
     select s.company_id, s.id, ${ATTEMPT_NUMBER}, 'FAILED', now(), 'OUTCOME_UNKNOWN', $2, $2 from s`,
    [leaseMs, SYSTEM_ACTOR_ID],
  );
  return res.rowCount ?? 0;
}

/** Channel OFF: every open email that is not being sent is settled SUPPRESSED, a batch at a time. */
async function suppressUnconfigured(db: Queryable, batch: number): Promise<number> {
  let total = 0;
  for (;;) {
    const res = await db.query(
      `with due as (
         select id from notification where channel = 'EMAIL' and email_next_attempt_at is not null
          order by email_next_attempt_at limit $1 for update skip locked
       ), s as (
         update notification n set state = 'SUPPRESSED', email_next_attempt_at = null, updated_by = $2 from due where n.id = due.id returning n.company_id, n.id
       )
       insert into notification_delivery_attempt (company_id, notification_id, attempt_number, outcome, outcome_at, failure_code, created_by, updated_by)
       select s.company_id, s.id, ${ATTEMPT_NUMBER}, 'SUPPRESSED', now(), 'EMAIL_NOT_CONFIGURED', $2, $2 from s`,
      [batch, SYSTEM_ACTOR_ID],
    );
    total += res.rowCount ?? 0;
    if ((res.rowCount ?? 0) < batch) return total;
  }
}

interface DueEmail {
  id: string;
  company_id: string;
  /** A user account's notice; null for an HR message to an employee (CL-041, 0282). */
  recipient_user_id: string | null;
  category: string;
  title: string | null;
  body: string | null;
  account_key: string | null;
  account_active: boolean | null;
  company_active: boolean;
  optional_event: boolean | null;
  event_type: string | null;
  retry_ceiling: number | null;
  attempts: number;
  /** An HR message's employee, with their work email and status as they are at the send (DF12 "recheck recipient at delivery"). */
  recipient_employee_id: string | null;
  employee_email: string | null;
  employee_status: string | null;
}

/** An HR message (0282) goes only to someone employed today: on probation, confirmed or on notice. */
const EMPLOYED = ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE'];

/** The columns and joins of an HR message's employee recipient (0282): their work email and status as they are now. */
const EMPLOYEE_RECIPIENT = {
  columns: `n.recipient_employee_id, re.work_email as employee_email, rs.code as employee_status`,
  joins: `left join employee re on re.company_id = n.company_id and re.id = n.recipient_employee_id
          left join reference_value rs on rs.company_id = re.company_id and rs.id = re.status_id`,
};

type Claimed = { companyId: string; settled: 'SUPPRESSED' | 'FAILED' } | { companyId: string; send: { id: string; claim: string; message: MailMessage; attempts: number; retryCeiling: number } };

/** Whether an address is on the test list (EMAIL_TEST_RECIPIENTS): the address itself, or its domain as @domain. */
export const onTestList = (address: string, list: readonly string[]): boolean => {
  const a = address.toLowerCase();
  return list.some((entry) => (entry.startsWith('@') ? a.endsWith(entry) && a.lastIndexOf('@') === a.length - entry.length : a === entry));
};

/** Why this recipient should not be emailed now, or null. Checked at the send, as DF12 asks, beside the dispatcher's check at queueing. */
async function recipientRefusal(tx: Queryable, e: DueEmail, settings: EmailChannelSettings): Promise<string | null> {
  // CL-041: an HR message goes to an employee's work email while they are employed; no account, assignment or preference applies.
  if (e.recipient_employee_id) {
    if (!e.company_active || !EMPLOYED.includes(e.employee_status ?? '')) return 'RECIPIENT_NOT_ELIGIBLE';
    if (!e.employee_email || !isMailAddress(e.employee_email)) return 'NO_EMAIL_ADDRESS';
    if (settings.testRecipients && !onTestList(e.employee_email, settings.testRecipients)) return 'RECIPIENT_NOT_IN_TEST_LIST';
    return null;
  }
  if (!e.account_active) return 'RECIPIENT_INACTIVE';
  if (!e.company_active) return 'RECIPIENT_NOT_ELIGIBLE';
  // The dispatcher's base rule (stillEligible): an active, approved assignment in the company, except for the notice that a user's own
  // role grant ended, which may leave them none.
  if (e.category !== 'ACCESS_GRANT_ENDED') {
    const holds = (
      await tx.query<{ ok: boolean }>(
        `select exists (select 1 from role_assignment ra where ra.company_id = $1 and ra.user_id = $2 and ra.state = 'ACTIVE'
                          and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now())) as ok`,
        [e.company_id, e.recipient_user_id],
      )
    ).rows[0]!.ok;
    if (!holds) return 'RECIPIENT_NOT_ELIGIBLE';
  }
  // FR-085 "optional-event preferences": an optional event's email follows the recipient's email preference; a mandatory one is sent.
  if (e.optional_event !== false) {
    const pref = (
      await tx.query<{ receive_optional: boolean }>(
        `select receive_optional from notification_preference where company_id = $1 and user_id = $2 and event_type = $3 and channel = 'EMAIL'`,
        [e.company_id, e.recipient_user_id, e.event_type ?? e.category],
      )
    ).rows[0];
    if (pref && !pref.receive_optional) return 'RECIPIENT_OPTED_OUT';
  }
  if (!e.account_key || !isMailAddress(e.account_key)) return 'NO_EMAIL_ADDRESS';
  if (settings.testRecipients && !onTestList(e.account_key, settings.testRecipients)) return 'RECIPIENT_NOT_IN_TEST_LIST';
  return null;
}

async function settle(tx: Queryable, e: { company_id: string; id: string }, state: 'SUPPRESSED' | 'FAILED', code: string) {
  await tx.query(`update notification set state = $3, email_next_attempt_at = null, updated_by = $4 where company_id = $1 and id = $2`, [e.company_id, e.id, state, SYSTEM_ACTOR_ID]);
  await tx.query(
    `insert into notification_delivery_attempt (company_id, notification_id, attempt_number, outcome, outcome_at, failure_code, created_by, updated_by)
     select s.company_id, s.id, ${ATTEMPT_NUMBER}, $3, now(), $4, $5, $5 from (select $1::uuid as company_id, $2::uuid as id) s`,
    [e.company_id, e.id, state, code, SYSTEM_ACTOR_ID],
  );
}

/** The next due email of the next company after `after`, checked and either settled or claimed, in the caller's transaction. */
async function claimNext(tx: Queryable, settings: EmailChannelSettings, after: string): Promise<Claimed | null> {
  const e = (
    await tx.query<DueEmail>(
      `select n.id, n.company_id, n.recipient_user_id, n.category, n.title, n.body, u.account_key, u.active as account_active, c.active as company_active,
              r.optional_event, r.event_type, r.retry_ceiling, ${EMPLOYEE_RECIPIENT.columns},
              (select count(*)::int from notification_delivery_attempt a where a.company_id = n.company_id and a.notification_id = n.id) as attempts
         from notification n
         left join user_account u on u.id = n.recipient_user_id
         join company c on c.id = n.company_id
         left join notification_rule r on r.company_id = n.company_id and r.id = n.rule_id
         ${EMPLOYEE_RECIPIENT.joins}
        where n.channel = 'EMAIL' and n.email_next_attempt_at <= now() and n.company_id > $1
        order by n.company_id, n.email_next_attempt_at limit 1 for update of n skip locked`,
      [after],
    )
  ).rows[0];
  if (!e) return null;
  const refusal = await recipientRefusal(tx, e, settings);
  if (refusal) {
    await settle(tx, e, 'SUPPRESSED', refusal);
    return { companyId: e.company_id, settled: 'SUPPRESSED' };
  }
  // BR-044 again, on exactly what would leave the system.
  // An HR message is free text a person wrote, so it gets the free-text rules too.
  if (e.body === null || emailContentRefusal(`${e.title ?? ''}\n${e.body}`, { freeText: e.category === HR_MAIL_CATEGORY })) {
    await settle(tx, e, 'FAILED', 'CONFIDENTIAL_CONTENT_BLOCKED');
    return { companyId: e.company_id, settled: 'FAILED' };
  }
  const claim = (
    await tx.query<{ claim: string }>(
      `update notification set email_next_attempt_at = null, email_sending_since = clock_timestamp(), updated_by = $3
        where company_id = $1 and id = $2 returning email_sending_since::text as claim`,
      [e.company_id, e.id, SYSTEM_ACTOR_ID],
    )
  ).rows[0]!.claim;
  return {
    companyId: e.company_id,
    send: {
      id: e.id,
      claim,
      attempts: e.attempts,
      retryCeiling: e.retry_ceiling ?? EMAIL_RETRY_MINUTES.length,
      message: {
        // recipientRefusal has checked whichever address applies.
        to: e.recipient_employee_id ? e.employee_email! : e.account_key!,
        subject: emailSubjectLine(e.title),
        text: e.recipient_employee_id ? hrMessageBodyText(e.body, settings.appUrl) : emailBodyText(e.body, settings.appUrl),
        messageId: `${e.id}@${settings.fromDomain}`,
      },
    },
  };
}

/** Records a send's outcome, if the send still holds its claim. The attempt is recorded with it, in one transaction. */
async function recordOutcome(db: Database, companyId: string, send: { id: string; claim: string; attempts: number; retryCeiling: number }, result: SendResult): Promise<'SENT' | 'RETRYING' | 'FAILED' | 'LOST'> {
  const retry = result.outcome === 'TRANSIENT' && send.attempts + 1 <= send.retryCeiling ? emailRetryMinutes(send.attempts + 1) : null;
  const state = result.outcome === 'SENT' ? 'DELIVERED' : retry !== null ? 'RETRY_PENDING' : 'FAILED';
  return withTransaction(db, async (tx) => {
    const updated = await tx.query(
      `update notification set state = $4, email_sending_since = null,
              email_next_attempt_at = case when $5::int is null then null else now() + make_interval(mins => $5::int) end, updated_by = $6
        where company_id = $1 and id = $2 and email_sending_since = $3::timestamptz`,
      [companyId, send.id, send.claim, state, retry, SYSTEM_ACTOR_ID],
    );
    // The lapsed-send sweep settled it first (OUTCOME_UNKNOWN): that record stands.
    if ((updated.rowCount ?? 0) === 0) return 'LOST';
    await tx.query(
      `insert into notification_delivery_attempt (company_id, notification_id, attempt_number, outcome, outcome_at, failure_code, provider_result_reference, created_by, updated_by)
       select s.company_id, s.id, ${ATTEMPT_NUMBER}, $3, now(), $4, $5, $6, $6 from (select $1::uuid as company_id, $2::uuid as id) s`,
      [companyId, send.id, result.outcome === 'SENT' ? 'DELIVERED' : 'FAILED', result.outcome === 'SENT' ? null : result.code, result.outcome === 'SENT' ? result.reference : null, SYSTEM_ACTOR_ID],
    );
    return result.outcome === 'SENT' ? 'SENT' : retry !== null ? 'RETRYING' : 'FAILED';
  });
}

/** A sender that throws has said nothing about how far it got: at most once, so it counts as an outcome that cannot be known. */
async function trySend(sender: MailSender, message: MailMessage): Promise<SendResult> {
  try {
    return await sender.send(message);
  } catch {
    return { outcome: 'UNKNOWN', code: 'SEND_OUTCOME_UNKNOWN' };
  }
}

const emailTurns = companyTurns();

/** One pass of the email channel: what the worker does on each tick (worker/scheduler.ts). */
export async function deliverDueEmails(db: Database, channel: EmailChannel | null | undefined): Promise<EmailPassOutcome> {
  const on = channel?.state === 'ON' ? channel : null;
  const outcome: EmailPassOutcome = { channel: on ? 'ON' : 'OFF', sent: 0, retrying: 0, failed: 0, suppressed: 0, paused: false };
  outcome.failed += await settleLapsedSends(db, on?.settings.leaseMs ?? DEFAULT_LEASE_MS);
  if (!on) {
    outcome.suppressed += await suppressUnconfigured(db, 500);
    return outcome;
  }
  let failuresInARow = 0;
  for (let i = 0; i < on.settings.perPass && !outcome.paused; i++) {
    const claimed = await withTransaction(db, (tx) => emailTurns.next((after) => claimNext(tx, on.settings, after)));
    if (!claimed) break;
    if ('settled' in claimed) {
      if (claimed.settled === 'SUPPRESSED') outcome.suppressed++;
      else outcome.failed++;
      continue;
    }
    const result = await trySend(on.sender, claimed.send.message);
    const recorded = await recordOutcome(db, claimed.companyId, claimed.send, result);
    if (recorded === 'SENT') outcome.sent++;
    else if (recorded === 'RETRYING') outcome.retrying++;
    else if (recorded === 'FAILED') outcome.failed++;
    // A refusal of one recipient says nothing about the server; anything else counts towards a pause.
    const recipientOnly = result.outcome === 'PERMANENT' && /^SMTP_RCPT_|^INVALID_RECIPIENT/.test(result.code);
    failuresInARow = result.outcome === 'SENT' || recipientOnly ? 0 : failuresInARow + 1;
    if (failuresInARow >= on.settings.pauseAfterErrors) outcome.paused = true;
  }
  return outcome;
}
