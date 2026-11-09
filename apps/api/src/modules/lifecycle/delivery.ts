// In-app delivery of letters and settlement statements to the employee's own self-service (FR-018, FR-054, FR-055; DF09; H7; BR-053).
// Decided under owner delegation, 6 Nov 2026 (docs/03 I-40 item 3, I-81 item 9): "send" never means e-mail. DF09 disables e-mail
// attachments of confidential records ("in-app authorised access only") and H7 keeps salary and private documents out of e-mail, so
// sending puts the exact file into the employee's own self-service and tells them in-app, with no attachment and no amount in the
// notice. FR-018 "recipient review and delivery status": the sender names the employee they reviewed as the recipient (it must be the
// record's own employee, never anyone else), the delivery records recipient, sender, template or settlement revision, file and time,
// and its status moves from DELIVERED to READ when the employee first opens it. Preview, download and export never send (FR-054).
import { enqueueEvent, writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import { type AccessGrant, canAccessEmployee } from '../access/authorize.js';
import { actorOf, advisoryLock, assertNotSelf, audit } from './common.js';
import { renderStatement } from './settlement.js';

export type StatementFormat = 'PDF' | 'XLSX';

interface DeliveryRow {
  id: string;
  source_kind: 'LETTER' | 'SETTLEMENT_STATEMENT';
  letter_output_id: string | null;
  settlement_id: string | null;
  file_format: string;
  source_revision: number;
  sent_by: string;
  sent_at: Date;
  first_read_at: Date | null;
}

const DELIVERY_COLUMNS = `d.id, d.source_kind, d.letter_output_id, d.settlement_id, d.file_format, d.source_revision, d.sent_by, d.sent_at, d.first_read_at`;

const view = (d: DeliveryRow) => ({
  id: d.id,
  kind: d.source_kind,
  letterOutputId: d.letter_output_id,
  settlementId: d.settlement_id,
  format: d.file_format,
  sourceRevision: d.source_revision,
  channel: 'IN_APP',
  status: d.first_read_at ? 'READ' : 'DELIVERED',
  sentBy: d.sent_by,
  sentAt: d.sent_at,
  firstReadAt: d.first_read_at,
});

/**
 * The account a delivery reaches: the user linked to the employee today, active, holding an active Employee assignment in OWN scope
 * (the self-service context that reads it). A leaver keeps it (I-81 item 4). Without one, nothing can be delivered.
 */
async function recipientUser(tx: Queryable, grant: AccessGrant, employeeId: string): Promise<string> {
  // I-89 item 7: nothing is delivered to a deceased employee's self-service; HR hands documents to the nominee or legal heir.
  const deceased = await tx.query(`select 1 from exit_case where company_id = $1 and employee_id = $2 and separation_type = 'DEATH' and state in ('SUBMITTED', 'RECOMMENDED', 'APPROVED', 'SEPARATED')`, [
    grant.companyId,
    employeeId,
  ]);
  if (deceased.rowCount) throw new HttpError(409, 'EMPLOYEE_DECEASED', 'The employee has died: hand the document to the nominee or legal heir outside self-service');
  const r = (
    await tx.query<{ user_id: string }>(
      `select l.user_id from user_employee_link l join user_account u on u.id = l.user_id and u.active
        where l.company_id = $1 and l.employee_id = $2 and l.effective_from <= $3::date and (l.effective_to is null or l.effective_to > $3::date)
          and exists (select 1 from role_assignment ra join role r on r.company_id = ra.company_id and r.id = ra.role_id and r.active
                       where ra.company_id = l.company_id and ra.user_id = l.user_id and ra.state = 'ACTIVE' and r.code = 'EMPLOYEE' and ra.scope_kind = 'OWN'
                         and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now()))
        order by l.effective_from desc, l.user_id limit 1`,
      [grant.companyId, employeeId, grant.businessDate],
    )
  ).rows[0];
  if (!r) throw new HttpError(409, 'NO_SELF_SERVICE_ACCESS', 'The employee has no active self-service account to deliver to; hand the document over another way');
  return r.user_id;
}

/** A retried send under its key returns the delivery it made; the key used for anything else is refused. */
async function replayed(tx: Queryable, grant: AccessGrant, key: string | undefined, source: { letterOutputId?: string; settlementId?: string }) {
  if (!key) return null;
  await advisoryLock(tx, `ess_delivery:${grant.companyId}:${key}`);
  const prior = (await tx.query<DeliveryRow>(`select ${DELIVERY_COLUMNS} from ess_delivery d where d.company_id = $1 and d.idempotency_key = $2`, [grant.companyId, key])).rows[0];
  if (!prior) return null;
  if (prior.sent_by !== grant.userId || prior.letter_output_id !== (source.letterOutputId ?? null) || prior.settlement_id !== (source.settlementId ?? null)) {
    throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'This key was used for another delivery');
  }
  return { ...view(prior), replayed: true };
}

function assertRecipient(reviewed: string, actual: string) {
  if (reviewed.toLowerCase() !== actual.toLowerCase()) throw new HttpError(422, 'RECIPIENT_MISMATCH', 'A document is delivered only to the employee it is about');
}

async function deliver(
  tx: Queryable,
  grant: AccessGrant,
  d: { employeeId: string; recipient: string; kind: 'LETTER' | 'SETTLEMENT_STATEMENT'; letterOutputId: string | null; settlementId: string | null; attachmentId: string; format: string; revision: number; key: string | undefined },
) {
  const row = (
    await tx.query<DeliveryRow>(
      `insert into ess_delivery (company_id, employee_id, source_kind, letter_output_id, settlement_id, attachment_id, file_format, source_revision, recipient_user_id,
                                 sent_by, sent_assignment_id, idempotency_key, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $10)
       returning id, source_kind, letter_output_id, settlement_id, file_format, source_revision, sent_by, sent_at, first_read_at`,
      [grant.companyId, d.employeeId, d.kind, d.letterOutputId, d.settlementId, d.attachmentId, d.format, d.revision, d.recipient, grant.userId, grant.assignmentId, d.key ?? null],
    )
  ).rows[0]!;
  // DF12 / H7: an in-app notice naming the kind of document only; no content, amount or attachment travels.
  await enqueueEvent(tx, { companyId: grant.companyId, topic: 'ess.delivered', aggregateId: row.id, dedupeKey: `ess.delivered:${row.id}`, payload: { deliveryId: row.id } });
  return row;
}

/** FR-018: sends a generated letter to the employee's own self-service (the letter's stored output, unchanged). */
export async function sendLetter(tx: Queryable, grant: AccessGrant, outputId: string, input: { recipientEmployeeId: string; idempotencyKey?: string | undefined }) {
  const o = (
    await tx.query<{ employee_id: string; attachment_id: string; template_revision: number; template_code: string }>(
      `select employee_id, attachment_id, template_revision, template_code from letter_output where company_id = $1 and id = $2`,
      [grant.companyId, outputId],
    )
  ).rows[0];
  if (!o || !(await canAccessEmployee(tx, grant, o.employee_id))) throw notFound();
  assertNotSelf(grant, o.employee_id);
  // Sending is its own right (FR-002, FR-018), checked again under the transaction (docs/09 §6.5).
  await reassertAccess(tx, grant, 'letter', 'send', ['letter']);
  const again = await replayed(tx, grant, input.idempotencyKey, { letterOutputId: outputId });
  if (again) return again;
  assertRecipient(input.recipientEmployeeId, o.employee_id);
  const recipient = await recipientUser(tx, grant, o.employee_id);
  const row = await deliver(tx, grant, {
    employeeId: o.employee_id,
    recipient,
    kind: 'LETTER',
    letterOutputId: outputId,
    settlementId: null,
    attachmentId: o.attachment_id,
    format: 'TEXT',
    revision: o.template_revision,
    key: input.idempotencyKey,
  });
  await audit(tx, actorOf(grant), 'letter_output', outputId, 'SEND', null, {
    operational: { deliveryId: row.id, channel: 'IN_APP', templateCode: o.template_code, templateRevision: o.template_revision, recipientEmployeeId: o.employee_id },
  });
  return { ...view(row), replayed: false };
}

/**
 * FR-054 "Send PDF" / "Send Excel": the approved (release-eligible or paid) settlement's statement, rendered once exactly as its
 * export and stored as a confidential attachment of the employee, is delivered to their own self-service.
 */
export async function sendSettlementStatement(
  tx: Queryable,
  grant: AccessGrant,
  files: FileStore,
  settlementId: string,
  input: { format: StatementFormat; recipientEmployeeId: string; idempotencyKey?: string | undefined },
) {
  const s = (await tx.query<{ employee_id: string }>(`select employee_id from settlement where company_id = $1 and id = $2`, [grant.companyId, settlementId])).rows[0];
  if (!s || !(await canAccessEmployee(tx, grant, s.employee_id))) throw notFound();
  assertNotSelf(grant, s.employee_id);
  await reassertAccess(tx, grant, 'settlement', 'send', ['amount']);
  const again = await replayed(tx, grant, input.idempotencyKey, { settlementId });
  if (again) return again;
  assertRecipient(input.recipientEmployeeId, s.employee_id);
  const recipient = await recipientUser(tx, grant, s.employee_id);
  const { detail, file } = await renderStatement(tx, grant, settlementId, input.format);
  const bytes = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : file.content;
  const stored = await files.put(grant.companyId, bytes);
  const attachmentId = (
    await tx.query<{ id: string }>(
      `insert into attachment (company_id, owner_user_id, employee_id, content_reference, media_type, checksum, classification, file_name, byte_size, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, 'CONFIDENTIAL', $7, $8, $2, $2) returning id`,
      [grant.companyId, grant.userId, s.employee_id, stored.reference, file.mediaType, stored.checksum, file.fileName, stored.byteSize],
    )
  ).rows[0]!.id;
  const row = await deliver(tx, grant, {
    employeeId: s.employee_id,
    recipient,
    kind: 'SETTLEMENT_STATEMENT',
    letterOutputId: null,
    settlementId,
    attachmentId,
    format: input.format,
    revision: detail.revision,
    key: input.idempotencyKey,
  });
  await audit(tx, actorOf(grant), 'settlement', settlementId, 'SEND', null, {
    operational: { deliveryId: row.id, channel: 'IN_APP', revision: detail.revision, format: input.format, lineCount: file.lineCount, recipientEmployeeId: s.employee_id },
  });
  return { ...view(row), replayed: false };
}

/** The deliveries of one letter or settlement, for the sender's screens (FR-018 delivery status). */
export async function deliveriesOf(db: Queryable, companyId: string, source: { letterOutputId?: string; settlementId?: string }) {
  const rows = (
    await db.query<DeliveryRow>(
      `select ${DELIVERY_COLUMNS} from ess_delivery d where d.company_id = $1 and (d.letter_output_id = $2 or d.settlement_id = $3) order by d.sent_at, d.id`,
      [companyId, source.letterOutputId ?? null, source.settlementId ?? null],
    )
  ).rows;
  return rows.map(view);
}

function ownEmployee(grant: AccessGrant): string {
  if (!grant.linkedEmployeeId) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  return grant.linkedEmployeeId;
}

/** BR-053: the employee's own delivered letters and statements, newest first (titles and dates; the files open one by one). */
export async function ownDeliveries(db: Queryable, grant: AccessGrant) {
  const employeeId = ownEmployee(grant);
  const rows = (
    await db.query<DeliveryRow & { title: string; file_name: string | null }>(
      `select ${DELIVERY_COLUMNS}, a.file_name,
              case when d.source_kind = 'LETTER' then coalesce(t.name, o.template_code) else 'Full and final settlement statement' end as title
         from ess_delivery d
         join attachment a on a.company_id = d.company_id and a.id = d.attachment_id
         left join letter_output o on o.company_id = d.company_id and o.id = d.letter_output_id
         left join letter_template t on t.company_id = o.company_id and t.id = o.template_id
        where d.company_id = $1 and d.employee_id = $2
        order by d.sent_at desc, d.id`,
      [grant.companyId, employeeId],
    )
  ).rows;
  return { items: rows.map((r) => ({ ...view(r), title: r.title, fileName: r.file_name })) };
}

/** Opens one of the employee's own deliveries; the first opening is recorded (FR-018 delivery status) and every opening audited. */
export async function ownDeliveryFile(tx: Queryable, grant: AccessGrant, files: FileStore, deliveryId: string) {
  const employeeId = ownEmployee(grant);
  const d = (
    await tx.query<{ id: string; first_read_at: Date | null; content_reference: string; media_type: string; file_name: string | null }>(
      `select d.id, d.first_read_at, a.content_reference, a.media_type, a.file_name
         from ess_delivery d join attachment a on a.company_id = d.company_id and a.id = d.attachment_id
        where d.company_id = $1 and d.id = $2 and d.employee_id = $3 for update of d`,
      [grant.companyId, deliveryId, employeeId],
    )
  ).rows[0];
  if (!d) throw notFound();
  if (!d.first_read_at) await tx.query(`update ess_delivery set first_read_at = now() where company_id = $1 and id = $2`, [grant.companyId, d.id]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'ess_delivery',
    recordKey: d.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'READ_CONTENT',
    after: { operational: { firstReading: d.first_read_at === null } },
  });
  return { bytes: await files.get(d.content_reference), mediaType: d.media_type, fileName: d.file_name };
}
