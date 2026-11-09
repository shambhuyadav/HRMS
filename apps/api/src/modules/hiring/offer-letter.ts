// Offer letters while an offer is being made, before the candidate is an employee (FR-014, FR-017, FR-018; DF09; F1; C4).
// Decided under owner delegation, 6 Nov 2026 (docs/03 I-82 item 1, answering I-48 item 2); migration 0190.
//
//   Wording    a published letter template of the OFFER type (FR-017 versioned templates, lifecycle/letters.ts), using only the
//              offer placeholders: HR writes and publishes it; nothing is seeded.
//   Values     the current revision of an APPROVED or ACCEPTED offer, which an independent eligible Admin approved (F1, C4):
//              candidate, the requisition's post, proposed joining date and compensation. No figure is ever typed into a
//              letter, and a missing mandatory value blocks the final output (FR-017).
//   Prepared   by an eligible HR Administrator assignment holding offer.issue_letter.compensation (ceiling only), within the
//              requisition's scope: a preview stores and sends nothing; a final output stores the exact text as a
//              confidential attachment with template code and revision, offer revision, generator and assignment.
//   Delivered  never by e-mail or any other channel of the system (DF09: confidential e-mail attachments are disabled). The
//              issuing Admin downloads the letter in-app, hands it to the candidate outside the system, and records the
//              method (company list OFFER_LETTER_DELIVERY), the date and that the recipient is the offer's candidate (FR-018
//              recipient review and delivery status). A recorded delivery is final; a letter of a superseded revision or of
//              an offer no longer approved or accepted cannot be recorded as delivered.
// Reading stored letters needs offer.read.compensation: the letter shows the approved compensation that grant reads. Audit
// records identifiers, template and revision numbers and checksums only, never a value of the letter.
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { AccessGrant } from '../access/authorize.js';
import { advisoryLock } from '../lifecycle/common.js';
import { publishedTemplate, renderLetter } from '../lifecycle/letters.js';
import { audit, personSql, referenceId, requireDate } from './common.js';
import { lockOffer } from './offer.js';
import { canAccessRequisition } from './scope.js';

/** The offer states whose current revision an independent Admin approved: only these issue a letter. */
const ISSUING_STATES = ['APPROVED', 'ACCEPTED'];

interface OfferFacts {
  offer_id: string;
  state: string;
  requisition_id: string;
  revision: number;
  candidate_name: string;
  candidate_code: string;
  requisition_code: string;
  job_title: string;
  department: string;
  designation: string;
  location: string;
  employment_type: string;
  proposed_joining_date: string;
  currency_code: string;
  annual_ctc: string | null;
  monthly_gross: string | null;
  company_name: string;
  company_code: string;
}

async function offerFacts(db: Queryable, companyId: string, offerId: string): Promise<OfferFacts | undefined> {
  return (
    await db.query<OfferFacts>(
      `select o.id as offer_id, o.state, o.requisition_id, v.revision, c.full_name as candidate_name, c.candidate_code, r.code as requisition_code, r.title as job_title,
              d.name as department, g.name as designation, l.name as location, et.label as employment_type,
              to_char(v.proposed_joining_date, 'YYYY-MM-DD') as proposed_joining_date, v.currency_code,
              v.annual_ctc::numeric(19, 2)::text as annual_ctc, v.monthly_gross::numeric(19, 2)::text as monthly_gross, co.name as company_name, co.code as company_code
         from hiring_offer o
         join requisition r on r.company_id = o.company_id and r.id = o.requisition_id
         join candidate c on c.company_id = o.company_id and c.id = o.candidate_id
         join department d on d.company_id = r.company_id and d.id = r.department_id
         join designation g on g.company_id = r.company_id and g.id = r.designation_id
         join location l on l.company_id = r.company_id and l.id = r.location_id
         join reference_value et on et.company_id = r.company_id and et.id = r.employment_type_id
         join company co on co.id = o.company_id
         left join hiring_offer_revision v on v.company_id = o.company_id and v.offer_id = o.id and v.revision = o.current_revision
        where o.company_id = $1 and o.id = $2`,
      [companyId, offerId],
    )
  ).rows[0];
}

/** The letter values of an offer: its current approved revision only (never a draft or a revision under review). */
function letterValues(f: OfferFacts, letterDate: string): Record<string, string> {
  if (!ISSUING_STATES.includes(f.state)) throw new HttpError(409, 'OFFER_NOT_APPROVED', 'An offer letter is issued only for an approved or accepted offer', { state: f.state });
  const data: Record<string, string> = {
    candidateName: f.candidate_name,
    candidateCode: f.candidate_code,
    requisitionCode: f.requisition_code,
    jobTitle: f.job_title,
    department: f.department,
    designation: f.designation,
    location: f.location,
    employmentType: f.employment_type,
    proposedJoiningDate: f.proposed_joining_date,
    offerRevision: String(f.revision),
    currencyCode: f.currency_code,
    companyName: f.company_name,
    companyCode: f.company_code,
    letterDate,
  };
  // The approved offer may carry the annual CTC, the monthly gross or both; an absent one is a missing value, never a zero.
  if (f.annual_ctc !== null) data.annualCtc = f.annual_ctc;
  if (f.monthly_gross !== null) data.monthlyGross = f.monthly_gross;
  return data;
}

async function scopedFacts(db: Queryable, grant: AccessGrant, offerId: string): Promise<OfferFacts> {
  const f = await offerFacts(db, grant.companyId, offerId);
  if (!f || !(await canAccessRequisition(db, grant, f.requisition_id))) throw notFound();
  return f;
}

/** FR-018: a preview renders the letter for review; nothing is stored and nothing is sent. */
export async function previewOfferLetter(db: Queryable, grant: AccessGrant, offerId: string, input: { templateCode: string }) {
  const f = await scopedFacts(db, grant, offerId);
  const data = letterValues(f, grant.businessDate);
  const t = await publishedTemplate(db, grant.companyId, input.templateCode, 'OFFER');
  const { text, missing } = renderLetter(t.body, t.optional, data);
  await audit(db, grant, 'hiring_offer_letter', offerId, 'PREVIEW', null, { offerId, offerRevision: f.revision, templateCode: t.code, templateRevision: t.revision, missing });
  return { offerId, offerRevision: f.revision, templateCode: t.code, templateRevision: t.revision, text, missing, ready: missing.length === 0, sent: false };
}

interface LetterRow {
  id: string;
  offer_id: string;
  offer_revision: number;
  template_code: string;
  template_revision: number;
  output_number: number;
  checksum: string;
  generated_at: Date;
  generated_by: string;
  delivery_state: string;
  byte_size: number;
}

const LETTER_COLUMNS = `l.id, l.offer_id, l.offer_revision, l.template_code, l.template_revision, l.output_number, l.checksum, l.generated_at, l.generated_by, l.delivery_state, a.byte_size`;

const shown = (r: LetterRow) => ({
  id: r.id,
  offerId: r.offer_id,
  offerRevision: r.offer_revision,
  templateCode: r.template_code,
  templateRevision: r.template_revision,
  outputNumber: r.output_number,
  checksum: r.checksum,
  byteSize: r.byte_size,
  generatedAt: r.generated_at,
  generatedBy: r.generated_by,
  deliveryState: r.delivery_state,
});

export async function generateOfferLetter(tx: Queryable, grant: AccessGrant, files: FileStore, offerId: string, input: { templateCode: string; idempotencyKey?: string | undefined }) {
  // The offer's transaction lock: no decision, return or withdrawal moves the revision while its letter is generated.
  await lockOffer(tx, grant, offerId);
  await reassertAccess(tx, grant, 'offer', 'issue_letter', ['compensation']);
  if (input.idempotencyKey) {
    // A retried generation (e.g. after a lost answer) returns the output stored under its key; never a second one.
    await advisoryLock(tx, `hiring_offer_letter:${grant.companyId}:${input.idempotencyKey}`);
    const prior = (
      await tx.query<LetterRow>(`select ${LETTER_COLUMNS} from hiring_offer_letter l join attachment a on a.company_id = l.company_id and a.id = l.attachment_id where l.company_id = $1 and l.idempotency_key = $2`, [
        grant.companyId,
        input.idempotencyKey,
      ])
    ).rows[0];
    if (prior) {
      if (prior.offer_id !== offerId || prior.template_code !== input.templateCode || prior.generated_by !== grant.userId) {
        throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for another letter');
      }
      return { ...shown(prior), replayed: true };
    }
  }
  const f = (await offerFacts(tx, grant.companyId, offerId))!;
  const data = letterValues(f, grant.businessDate);
  const t = await publishedTemplate(tx, grant.companyId, input.templateCode, 'OFFER');
  const { text, missing } = renderLetter(t.body, t.optional, data);
  if (missing.length > 0) throw new HttpError(422, 'MISSING_PLACEHOLDER', 'Mandatory letter values are missing', { missing });
  const stored = await files.put(grant.companyId, Buffer.from(text, 'utf8'));
  const outputNumber = (await tx.query<{ n: number }>(`select coalesce(max(output_number), 0) + 1 as n from hiring_offer_letter where company_id = $1 and offer_id = $2`, [grant.companyId, offerId])).rows[0]!.n;
  const fileName = `${t.code}-${f.candidate_code}-${outputNumber}.txt`.replace(/[^A-Za-z0-9._-]/g, '_');
  // A candidate is not an employee: the confidential attachment belongs to no employee record (as a candidate's CV).
  const attachmentId = (
    await tx.query<{ id: string }>(
      `insert into attachment (company_id, owner_user_id, employee_id, content_reference, media_type, checksum, classification, file_name, byte_size, created_by, updated_by)
       values ($1, $2, null, $3, 'text/plain', $4, 'CONFIDENTIAL', $5, $6, $2, $2) returning id`,
      [grant.companyId, grant.userId, stored.reference, stored.checksum, fileName, stored.byteSize],
    )
  ).rows[0]!.id;
  const row = (
    await tx.query<{ id: string }>(
      `insert into hiring_offer_letter (company_id, offer_id, offer_revision, template_id, template_revision_id, template_code, template_revision, output_number,
                                        attachment_id, checksum, generated_by, generated_assignment_id, idempotency_key, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $11) returning id`,
      [grant.companyId, offerId, f.revision, t.templateId, t.revisionId, t.code, t.revision, outputNumber, attachmentId, stored.checksum, grant.userId, grant.assignmentId, input.idempotencyKey ?? null],
    )
  ).rows[0]!;
  await audit(tx, grant, 'hiring_offer_letter', row.id, 'GENERATE', null, { offerId, offerRevision: f.revision, templateCode: t.code, templateRevision: t.revision, outputNumber, checksum: stored.checksum });
  const created = (await tx.query<LetterRow>(`select ${LETTER_COLUMNS} from hiring_offer_letter l join attachment a on a.company_id = l.company_id and a.id = l.attachment_id where l.company_id = $1 and l.id = $2`, [grant.companyId, row.id])).rows[0]!;
  return { ...shown(created), replayed: false };
}

/** An offer's letters, newest first, with their delivery records (the offer's scope; offer.read.compensation). */
export async function listOfferLetters(db: Queryable, grant: AccessGrant, offerId: string) {
  const f = await scopedFacts(db, grant, offerId);
  const rows = (
    await db.query<LetterRow & { delivery_method: string | null; delivery_method_label: string | null; delivered_on: string | null; delivery_recorded_by: string | null; delivery_recorded_at: Date | null; recorded_by_person: unknown }>(
      `select ${LETTER_COLUMNS}, m.code as delivery_method, m.label as delivery_method_label, to_char(l.delivered_on, 'YYYY-MM-DD') as delivered_on,
              l.delivery_recorded_by, l.delivery_recorded_at, ${personSql('l.company_id', 'l.delivery_recorded_by', 'l.delivery_recorded_at')} as recorded_by_person
         from hiring_offer_letter l join attachment a on a.company_id = l.company_id and a.id = l.attachment_id
         left join reference_value m on m.company_id = l.company_id and m.id = l.delivery_method_id
        where l.company_id = $1 and l.offer_id = $2 order by l.generated_at desc, l.output_number desc`,
      [grant.companyId, offerId],
    )
  ).rows;
  return {
    offerId,
    offerState: f.state,
    currentRevision: f.revision ?? null,
    items: rows.map((r) => ({
      ...shown(r),
      // Only a letter of the current revision of an approved or accepted offer can still be recorded as delivered.
      current: r.offer_revision === f.revision && ISSUING_STATES.includes(f.state),
      delivery:
        r.delivery_state === 'DELIVERED'
          ? { method: r.delivery_method, methodLabel: r.delivery_method_label, deliveredOn: r.delivered_on, recordedBy: r.delivery_recorded_by, recordedByPerson: r.recorded_by_person, recordedAt: r.delivery_recorded_at }
          : null,
    })),
  };
}

/** The stored letter for an in-app download (DF09 "in-app authorised access only"), rechecked against the offer's scope. */
export async function offerLetterContent(db: Queryable, grant: AccessGrant, files: FileStore, letterId: string) {
  const l = (
    await db.query<{ offer_id: string; requisition_id: string; content_reference: string; media_type: string; file_name: string | null }>(
      `select l.offer_id, o.requisition_id, a.content_reference, a.media_type, a.file_name
         from hiring_offer_letter l join hiring_offer o on o.company_id = l.company_id and o.id = l.offer_id
         join attachment a on a.company_id = l.company_id and a.id = l.attachment_id
        where l.company_id = $1 and l.id = $2`,
      [grant.companyId, letterId],
    )
  ).rows[0];
  if (!l || !(await canAccessRequisition(db, grant, l.requisition_id))) return null;
  const bytes = await files.get(l.content_reference);
  // FR-057: recorded once the bytes are in hand.
  await audit(db, grant, 'hiring_offer_letter', letterId, 'READ_CONTENT', null, { offerId: l.offer_id });
  return { bytes, mediaType: l.media_type, fileName: l.file_name };
}

export interface DeliveryInput {
  deliveryMethod: string;
  deliveredOn: string;
  /** FR-018 recipient review: the person who received the letter is the offer's candidate. */
  recipientConfirmed: boolean;
}

/** Records that the letter was handed to the candidate outside the system (DF09); final once recorded. */
export async function recordOfferLetterDelivery(tx: Queryable, grant: AccessGrant, letterId: string, input: DeliveryInput) {
  const target = (await tx.query<{ offer_id: string }>(`select offer_id from hiring_offer_letter where company_id = $1 and id = $2`, [grant.companyId, letterId])).rows[0];
  if (!target) throw notFound();
  const o = await lockOffer(tx, grant, target.offer_id);
  await reassertAccess(tx, grant, 'offer', 'issue_letter', ['compensation']);
  const l = (
    await tx.query<{ offer_revision: number; delivery_state: string; generated_on: string }>(
      `select offer_revision, delivery_state, to_char(hrms_business_date(company_id, generated_at), 'YYYY-MM-DD') as generated_on from hiring_offer_letter where company_id = $1 and id = $2 for update`,
      [grant.companyId, letterId],
    )
  ).rows[0]!;
  if (l.delivery_state === 'DELIVERED') throw new HttpError(409, 'ALREADY_DELIVERED', 'This letter’s delivery is already recorded');
  if (!ISSUING_STATES.includes(o.state)) throw new HttpError(409, 'OFFER_NOT_APPROVED', 'The offer is no longer approved or accepted', { state: o.state });
  if (l.offer_revision !== o.current_revision) throw new HttpError(409, 'LETTER_SUPERSEDED', 'This letter carries an earlier revision of the offer; generate a new one', { letterRevision: l.offer_revision, currentRevision: o.current_revision });
  if (input.recipientConfirmed !== true) throw new HttpError(422, 'RECIPIENT_NOT_CONFIRMED', 'Confirm that the letter went to the offer’s candidate');
  const deliveredOn = requireDate(input.deliveredOn, 'deliveredOn');
  if (deliveredOn > grant.businessDate) throw new HttpError(422, 'INVALID_DATE', 'The delivery date cannot be in the future', { field: 'deliveredOn' });
  if (deliveredOn < l.generated_on) throw new HttpError(422, 'INVALID_DATE', 'The delivery date cannot be before the letter was generated', { field: 'deliveredOn', generatedOn: l.generated_on });
  const methodId = await referenceId(tx, grant.companyId, 'OFFER_LETTER_DELIVERY', input.deliveryMethod);
  await tx.query(
    `update hiring_offer_letter set delivery_state = 'DELIVERED', delivery_method_id = $3, delivered_on = $4, delivery_recorded_by = $5, delivery_assignment_id = $6, delivery_recorded_at = now()
      where company_id = $1 and id = $2`,
    [grant.companyId, letterId, methodId, deliveredOn, grant.userId, grant.assignmentId],
  );
  await audit(tx, grant, 'hiring_offer_letter', letterId, 'DELIVER', { deliveryState: 'NOT_DELIVERED' }, { deliveryState: 'DELIVERED', deliveryMethod: input.deliveryMethod, deliveredOn, recipientConfirmed: true });
  return { id: letterId, offerId: o.id, deliveryState: 'DELIVERED', deliveryMethod: input.deliveryMethod, deliveredOn };
}
