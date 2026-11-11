// HR sends one message to chosen employees by email (BRD coverage CL-041 "Send Mail", under FR-085 channels and the delivery log; FR-061;
// DF12; BR-026 row scope; BR-034; BR-044; H7; migration 0282; built 11 Nov 2026 from the reference system's screen: subject, message,
// recipients chosen on screen or from an uploaded list of employee codes, an optional attachment; decided under owner delegation,
// 6 Nov 2026).
//
// The existing email channel carries it (email-delivery.ts): one EMAIL notification per recipient, queued here with its content already
// checked and sent by the worker only, with the channel's retries (1, 5 and 15 minutes), at-most-once claim, delivery attempts and the
// delivery log. Nothing new talks to a mail server.
//   * Email off: with no SMTP settings (mail/config.ts emailConfigured) the screen says so and a send is refused, EMAIL_NOT_CONFIGURED:
//     nothing is queued. Anything queued before the settings went away is settled SUPPRESSED by the worker, as every email is.
//   * Right: hr_mail.send.message, a confidential group, ceiling only for the HR Administrator (0282). Everything here needs it.
//   * Recipients: employees in the sender's row scope (employeeScopePredicate), employed (on probation, confirmed or on notice), with a
//     work email; the email goes to that work email, read again by the worker when it sends. Chosen on screen (employee ids) or from an
//     uploaded list of employee codes (HR_MAIL_RECIPIENTS_V1, one column employee_code; scanned in memory, never stored). The review
//     (POST /hr-mail/recipients) shows each one's outcome before anything is sent; the send takes the reviewed ids and is refused whole
//     if any of them is no longer eligible (RECIPIENTS_NOT_ELIGIBLE), so what was reviewed is what is sent. Someone outside the scope
//     reads as not found, exactly like an unknown code.
//   * Bounds: at most MAX_RECIPIENTS recipients per message, a one-line subject of at most MAX_SUBJECT characters and a plain-text
//     message of at most MAX_MESSAGE characters. The channel's content rule applies (email-content.ts, BR-044/H7): no long or formatted
//     numbers, percentages, currency, account identifiers or links, refused with the rule's code (CONTENT_NOT_ALLOWED).
//   * No attachment: the channel sends one plain-text part (mail/smtp.ts), so the screen offers none.
//   * Once: a repeated submission with the same idempotency key returns the first send and queues nothing; the key used for anything
//     else is refused (IDEMPOTENCY_KEY_IN_USE).
//   * Audit: one SEND record per message with the recipient count only. The subject and text are never copied into the audit (they
//     stay on the recipients' notifications, which only the worker and the delivery log's states read).
//   * A message belongs to its sender: the list of sent messages and each one's delivery are the sender's own.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess, requireAccess } from '../../http/guard.js';
import { emailConfigured } from '../../mail/config.js';
import { isMailAddress } from '../../mail/smtp.js';
import { type ScanProvider, type ScanVerdict, scanInMemory } from '../../storage/scan.js';
import type { FileStore } from '../../storage/files.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { CsvError, parseCsv } from '../employee/csv.js';
import { sendTemplate } from '../imports/routes.js';
import { emailContentRefusal, HR_MAIL_CATEGORY } from './email-content.js';

export { HR_MAIL_CATEGORY };
/** Technical bounds of one message (not business rules). */
export const MAX_RECIPIENTS = 500;
/** Recipients one sender may mail in any 24 hours, over all their messages. */
export const MAX_RECIPIENTS_PER_DAY = 2000;
export const MAX_SUBJECT = 150;
export const MAX_MESSAGE = 5000;
/** The uploaded list's rows (a list may repeat or name people who are refused, so it may be longer than the recipient bound). */
export const MAX_LIST_ROWS = 2000;
export const RECIPIENT_TEMPLATE = { code: 'HR_MAIL_RECIPIENTS_V1', columns: ['employee_code'] } as const;
/** A byte order mark a spreadsheet may put before the header (built from its code point, so no invisible character sits in this file). */
const BYTE_ORDER_MARK = new RegExp(`^${String.fromCharCode(0xfeff)}`);
/** The employee statuses a message may go to: employed today. */
const EMPLOYED = ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE'];

export type RecipientOutcome = 'ELIGIBLE' | 'NOT_FOUND' | 'NOT_EMPLOYED' | 'NO_WORK_EMAIL' | 'INVALID_CODE' | 'DUPLICATE';

export interface ReviewedRecipient {
  /** The uploaded list's row (2 is the first data row), when the recipient came from a list. */
  row?: number;
  employeeId: string | null;
  employeeCode: string | null;
  displayName: string | null;
  workEmail: string | null;
  outcome: RecipientOutcome;
}

interface EmployeeFacts {
  id: string;
  code: string;
  name: string;
  work_email: string | null;
  status: string;
}

/** The employees named by id or code, in the grant's row scope only (anyone else is not returned, as if unknown). */
async function inScope(db: Queryable, grant: AccessGrant, ids: readonly string[], codes: readonly string[]): Promise<EmployeeFacts[]> {
  const p = new SqlParams([grant.companyId, ids, codes]);
  const scope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, p);
  return (
    await db.query<EmployeeFacts>(
      `select e.id, e.employee_code as code, e.display_name as name, e.work_email, st.code as status
         from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id
        where e.company_id = $1 and (e.id = any($2::uuid[]) or e.employee_code = any($3::text[])) and ${scope}`,
      p.values,
    )
  ).rows;
}

function outcomeOf(e: EmployeeFacts | undefined): RecipientOutcome {
  if (!e) return 'NOT_FOUND';
  if (!EMPLOYED.includes(e.status)) return 'NOT_EMPLOYED';
  if (!e.work_email || !isMailAddress(e.work_email)) return 'NO_WORK_EMAIL';
  return 'ELIGIBLE';
}

/** One reviewed recipient: who it is only when they are in scope; the work email only when it is where the message would go. */
function reviewed(e: EmployeeFacts | undefined, given: { employeeId?: string; employeeCode?: string; row?: number }): ReviewedRecipient {
  const outcome = outcomeOf(e);
  return {
    ...(given.row !== undefined ? { row: given.row } : {}),
    employeeId: e?.id ?? given.employeeId ?? null,
    employeeCode: e?.code ?? given.employeeCode ?? null,
    displayName: e?.name ?? null,
    workEmail: outcome === 'ELIGIBLE' ? e!.work_email : null,
    outcome,
  };
}

const summarise = (recipients: ReviewedRecipient[]) => {
  const eligible = recipients.filter((r) => r.outcome === 'ELIGIBLE').length;
  return { recipients, eligible, refused: recipients.length - eligible, maxRecipients: MAX_RECIPIENTS, tooMany: eligible > MAX_RECIPIENTS };
};

/** The review of recipients chosen on screen: each id once, in the order given. */
export async function reviewChosen(db: Queryable, grant: AccessGrant, employeeIds: readonly string[]) {
  const ids = [...new Set(employeeIds.map((i) => i.toLowerCase()))];
  const found = new Map((await inScope(db, grant, ids, [])).map((e) => [e.id, e]));
  return summarise(ids.map((id) => reviewed(found.get(id), { employeeId: id })));
}

/**
 * The review of an uploaded list (HR_MAIL_RECIPIENTS_V1): scanned in memory before it is read (FR-106) and never stored. Each code is
 * trimmed and matched exactly, ignoring case; a blank row is INVALID_CODE and a code repeated is DUPLICATE after its first row.
 */
export async function reviewUploadedList(db: Queryable, grant: AccessGrant, verdict: ScanVerdict, contentBase64: string) {
  if (verdict.verdict === 'INFECTED') throw new HttpError(422, 'UPLOAD_QUARANTINED', 'The malware scan flagged the file; it was not read');
  if (verdict.verdict !== 'CLEAN') throw new HttpError(503, 'SCAN_UNAVAILABLE', 'The file could not be scanned now; try again later');
  let rows: string[][];
  try {
    rows = parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(contentBase64, 'base64')));
  } catch (e) {
    if (e instanceof CsvError || e instanceof TypeError) throw new HttpError(422, 'INVALID_FILE', 'The file is not valid UTF-8 CSV');
    throw e;
  }
  const header = rows[0]?.map((h) => h.trim().replace(BYTE_ORDER_MARK, '').toLowerCase());
  if (!header || header.join(',') !== RECIPIENT_TEMPLATE.columns.join(',')) {
    throw new HttpError(422, 'INVALID_HEADER', `The file must use the ${RECIPIENT_TEMPLATE.code} header: ${RECIPIENT_TEMPLATE.columns.join(',')}`);
  }
  const data = rows.slice(1);
  if (data.length === 0) throw new HttpError(422, 'EMPTY_FILE', 'The file has no employee codes');
  if (data.length > MAX_LIST_ROWS) throw new HttpError(422, 'TOO_MANY_ROWS', `At most ${MAX_LIST_ROWS} rows per list`, { max: MAX_LIST_ROWS });
  const codeOf = (cells: string[]) => (cells.length === 1 ? (cells[0] ?? '').trim().toUpperCase() : '');
  const codes = [...new Set(data.map(codeOf).filter((c) => c !== ''))];
  const found = new Map((await inScope(db, grant, [], codes)).map((e) => [e.code, e]));
  const seen = new Set<string>();
  return summarise(
    data.map((cells, i) => {
      const code = codeOf(cells);
      const row = i + 2;
      if (code === '') return { row, employeeId: null, employeeCode: null, displayName: null, workEmail: null, outcome: 'INVALID_CODE' as const };
      if (seen.has(code)) return { row, employeeId: null, employeeCode: code, displayName: null, workEmail: null, outcome: 'DUPLICATE' as const };
      seen.add(code);
      return reviewed(found.get(code), { employeeCode: code, row });
    }),
  );
}

export interface HrMailInput {
  subject: string;
  message: string;
  employeeIds: string[];
  idempotencyKey: string;
}

/** The subject on one line and the message as plain text with line feeds; refused when empty, too long or holding control characters. */
function normalise(input: HrMailInput): { subject: string; message: string } {
  const subject = input.subject.normalize('NFC').trim();
  const message = input.message.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  // Line breaks and other control characters in a subject would change the mail's headers.
  if (!subject || subject.length > MAX_SUBJECT || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(subject)) {
    throw new HttpError(422, 'INVALID_SUBJECT', `The subject is one line of at most ${MAX_SUBJECT} characters`, { field: 'subject', max: MAX_SUBJECT });
  }
  if (!message || message.length > MAX_MESSAGE || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(message)) {
    throw new HttpError(422, 'INVALID_MESSAGE', `The message is plain text of at most ${MAX_MESSAGE} characters`, { field: 'message', max: MAX_MESSAGE });
  }
  return { subject, message };
}

/**
 * Queues one message to the reviewed recipients, all or none, inside one transaction: the email channel must be on, the right is
 * re-checked, every recipient re-checked (scope, employed, work email), then the send row, one EMAIL notification per recipient and
 * the audit record (the count only). The worker sends them.
 */
export async function sendHrMail(db: Database, grant: AccessGrant, input: HrMailInput, emailOn: boolean) {
  if (!emailOn) throw new HttpError(409, 'EMAIL_NOT_CONFIGURED', 'Email is off: no mail server is configured, so nothing was sent');
  const { subject, message } = normalise(input);
  const rule = emailContentRefusal(`${subject}\n${message}`, { freeText: true });
  if (rule) throw new HttpError(422, 'CONTENT_NOT_ALLOWED', 'An email may not carry this: write it without figures, amounts, percentages, currency, account numbers or links', { rule });
  const ids = [...new Set(input.employeeIds.map((i) => i.toLowerCase()))].sort();
  if (ids.length === 0) throw new HttpError(422, 'NO_RECIPIENTS', 'Choose at least one recipient');
  if (ids.length > MAX_RECIPIENTS) throw new HttpError(422, 'TOO_MANY_RECIPIENTS', `At most ${MAX_RECIPIENTS} recipients per message`, { max: MAX_RECIPIENTS });
  const hash = createHash('sha256').update(JSON.stringify([subject, message, ids])).digest('hex');

  return withTransaction(db, async (tx) => {
    await reassertAccess(tx, grant, 'hr_mail', 'send', ['message']);
    // One submission per key and sender at a time; a repeat returns the first send.
    await tx.query(`select pg_advisory_xact_lock(hashtextextended('hr_mail_send:' || $1 || ':' || $2 || ':' || $3, 0))`, [grant.companyId, grant.userId, input.idempotencyKey]);
    const earlier = (
      await tx.query<{ id: string; request_hash: string; recipient_count: number }>(
        `select id, request_hash, recipient_count from hr_mail_send where company_id = $1 and sent_by = $2 and idempotency_key = $3`,
        [grant.companyId, grant.userId, input.idempotencyKey],
      )
    ).rows[0];
    if (earlier) {
      if (earlier.request_hash !== hash) throw new HttpError(409, 'IDEMPOTENCY_KEY_IN_USE', 'Use a new idempotency key for this message');
      return { id: earlier.id, recipientCount: earlier.recipient_count, replayed: true };
    }
    const facts = new Map((await inScope(tx, grant, ids, [])).map((e) => [e.id, e]));
    const refused = ids.map((id) => ({ employeeId: id, outcome: outcomeOf(facts.get(id)) })).filter((r) => r.outcome !== 'ELIGIBLE');
    if (refused.length > 0) throw new HttpError(422, 'RECIPIENTS_NOT_ELIGIBLE', 'Some recipients can no longer be sent to; review the recipients again', { recipients: refused });
    // A daily bound per sender (any number of keys): whole-company mailings repeated without end would harm the sender domain and
    // flood the queue. Counted under a per-sender lock, so two sends at once cannot both pass it.
    await tx.query(`select pg_advisory_xact_lock(hashtextextended('hr_mail_daily:' || $1 || ':' || $2, 0))`, [grant.companyId, grant.userId]);
    const sentToday = (
      await tx.query<{ n: number }>(
        `select coalesce(sum(recipient_count), 0)::int as n from hr_mail_send where company_id = $1 and sent_by = $2 and created_at > now() - interval '24 hours'`,
        [grant.companyId, grant.userId],
      )
    ).rows[0]!.n;
    if (sentToday + ids.length > MAX_RECIPIENTS_PER_DAY) {
      throw new HttpError(429, 'DAILY_LIMIT', `At most ${MAX_RECIPIENTS_PER_DAY} recipients a day per sender; ${Math.max(0, MAX_RECIPIENTS_PER_DAY - sentToday)} left`, {
        max: MAX_RECIPIENTS_PER_DAY,
        sentToday,
      });
    }

    const send = (
      await tx.query<{ id: string }>(
        `insert into hr_mail_send (company_id, sent_by, acting_assignment_id, idempotency_key, request_hash, recipient_count) values ($1, $2, $3, $4, $5, $6) returning id`,
        [grant.companyId, grant.userId, grant.assignmentId, input.idempotencyKey, hash, ids.length],
      )
    ).rows[0]!;
    await tx.query(
      `insert into notification (company_id, recipient_user_id, recipient_employee_id, hr_mail_send_id, category, state, channel, idempotency_key, title, body,
                                 email_next_attempt_at, created_by, updated_by)
       select $1, null, r.id, $2::uuid, $3, 'QUEUED', 'EMAIL', 'hr-mail:' || $2::text || ':' || r.id::text, $4, $5, now(), $6, $6
         from unnest($7::uuid[]) as r (id)`,
      [grant.companyId, send.id, HR_MAIL_CATEGORY, subject, message, grant.userId, ids],
    );
    // The subject and text are never copied into the audit.
    await writeAudit(tx, {
      companyId: grant.companyId,
      resource: 'hr_mail',
      recordKey: send.id,
      actorUserId: grant.userId,
      actingAssignmentId: grant.assignmentId,
      action: 'SEND',
      after: { message: { channel: 'EMAIL', recipientCount: ids.length } },
    });
    return { id: send.id, recipientCount: ids.length, replayed: false };
  });
}

const STATE_COUNTS = `(select json_build_object('queued', count(*) filter (where n.state in ('QUEUED', 'RETRY_PENDING')), 'delivered', count(*) filter (where n.state = 'DELIVERED'),
                                               'failed', count(*) filter (where n.state = 'FAILED'), 'suppressed', count(*) filter (where n.state = 'SUPPRESSED'))
                         from notification n where n.company_id = s.company_id and n.hr_mail_send_id = s.id)`;

/** The sender's own messages, newest first (at most 100): when, to how many, the subject, and where their delivery stands. */
export async function listSent(db: Queryable, grant: AccessGrant) {
  const rows = await db.query(
    `select s.id, s.created_at as "sentAt", s.recipient_count as "recipientCount",
            (select n.title from notification n where n.company_id = s.company_id and n.hr_mail_send_id = s.id limit 1) as subject,
            ${STATE_COUNTS} as delivery
       from hr_mail_send s where s.company_id = $1 and s.sent_by = $2 order by s.created_at desc, s.id limit 100`,
    [grant.companyId, grant.userId],
  );
  return { items: rows.rows };
}

/** One of the sender's messages with each recipient's delivery: state, attempts and the last failure class (never an address). */
export async function sentMessage(db: Queryable, grant: AccessGrant, id: string) {
  const send = (
    await db.query(
      `select s.id, s.created_at as "sentAt", s.recipient_count as "recipientCount",
              (select n.title from notification n where n.company_id = s.company_id and n.hr_mail_send_id = s.id limit 1) as subject
         from hr_mail_send s where s.company_id = $1 and s.id = $2 and s.sent_by = $3`,
      [grant.companyId, id, grant.userId],
    )
  ).rows[0];
  if (!send) throw notFound();
  const recipients = await db.query(
    `select e.id as "employeeId", e.employee_code as "employeeCode", e.display_name as "displayName", n.state,
            (select count(*)::int from notification_delivery_attempt a where a.company_id = n.company_id and a.notification_id = n.id) as attempts,
            (select a.failure_code from notification_delivery_attempt a where a.company_id = n.company_id and a.notification_id = n.id order by a.attempt_number desc limit 1) as "lastFailureCode"
       from notification n join employee e on e.company_id = n.company_id and e.id = n.recipient_employee_id
      where n.company_id = $1 and n.hr_mail_send_id = $2 order by e.employee_code`,
    [grant.companyId, id],
  );
  return { ...send, recipients: recipients.rows };
}

const uuid = { type: 'string', format: 'uuid' } as const;

export async function hrMailRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, scanner } = opts;
  const right = (request: Parameters<typeof requireAccess>[1], recordKey?: string) =>
    requireAccess(db, request, 'hr_mail', 'send', ['message'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });

  // Whether email is on, in so many words, and the bounds of one message.
  app.get('/hr-mail/channel', async (request) => {
    await right(request);
    const on = emailConfigured();
    return {
      email: on ? 'ON' : 'OFF',
      ...(on ? {} : { reason: 'EMAIL_NOT_CONFIGURED' }),
      attachments: false,
      limits: { recipients: MAX_RECIPIENTS, subject: MAX_SUBJECT, message: MAX_MESSAGE, listRows: MAX_LIST_ROWS },
    };
  });

  app.get('/hr-mail/recipients/template', async (request, reply) => {
    await right(request);
    return sendTemplate(reply, RECIPIENT_TEMPLATE);
  });

  // The review: recipients chosen on screen (employeeIds) or an uploaded list of employee codes (contentBase64), one or the other.
  app.post(
    '/hr-mail/recipients',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          maxProperties: 1,
          properties: { employeeIds: { type: 'array', minItems: 1, maxItems: MAX_LIST_ROWS, items: uuid }, contentBase64: { type: 'string', minLength: 4, maxLength: 1_000_000 } },
        },
      },
    },
    async (request) => {
      const grant = await right(request);
      const body = request.body as { employeeIds?: string[]; contentBase64?: string };
      if (body.employeeIds) return reviewChosen(db, grant, body.employeeIds);
      const verdict = await scanInMemory(scanner, Buffer.from(body.contentBase64!, 'base64'));
      return reviewUploadedList(db, grant, verdict, body.contentBase64!);
    },
  );

  app.post(
    '/hr-mail/messages',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['subject', 'message', 'employeeIds', 'idempotencyKey'],
          properties: {
            subject: { type: 'string', minLength: 1, maxLength: MAX_SUBJECT + 50 },
            message: { type: 'string', minLength: 1, maxLength: MAX_MESSAGE + 500 },
            // Longer lists are refused in words (TOO_MANY_RECIPIENTS) by sendHrMail.
            employeeIds: { type: 'array', minItems: 1, maxItems: MAX_LIST_ROWS, items: uuid },
            idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await right(request);
      const result = await sendHrMail(db, grant, request.body as HrMailInput, emailConfigured());
      reply.status(result.replayed ? 200 : 201);
      return { ...result, state: 'QUEUED' };
    },
  );

  app.get('/hr-mail/messages', async (request) => listSent(db, await right(request)));

  app.get('/hr-mail/messages/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request) => {
    const { id } = request.params as { id: string };
    return sentMessage(db, await right(request, id), id);
  });
}
