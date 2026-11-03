// FR-014 handover to onboarding (F1: "Hiring creates a reviewed employee draft, never auto-activates employment").
//
// The reviewing HR Administrator confirms the employee fields; the employee is created through the ordinary
// employee creation path (employee/service.ts createEmployee: DRAFT status, its own validation, history, audit and
// event) from validated values only: department, location, designation and employment type of the approved
// requisition, the joining date of the approved and accepted offer, and the code, legal display name and work
// email the reviewer confirms. Candidate documents the reviewer selects are copied onto the employee record as
// confidential employee documents. The offer transaction lock plus unique keys on the offer, the application and
// the employee guarantee that one accepted offer creates at most one employee, and the conversion check (0113) that one
// person, across requisitions and confirmed duplicate records, holds one employment at a time; the employee stays
// traceable to its requisition, application, offer and candidate. Activation remains the separate employee activation action.
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, canAccessEmployee } from '../access/authorize.js';
import { createEmployee } from '../employee/service.js';
import { lockTransaction } from '../workflow/engine.js';
import { assertConvertible, audit, lockRequisition, personSql, referenceId } from './common.js';
import { canAccessRequisition } from './scope.js';

export interface HandoverInput {
  employeeCode: string;
  displayName?: string | undefined;
  workEmail?: string | undefined;
  documents?: { candidateDocumentId: string; documentType: string }[] | undefined;
}

export interface HandoverGrants {
  hiring: AccessGrant;
  employee: AccessGrant;
  /** Present when documents are transferred: reading candidate documents and creating employee documents. */
  documents?: { read: AccessGrant; upload: AccessGrant } | undefined;
}

interface Target {
  id: string;
  transaction_id: string;
  state: string;
  application_id: string;
  requisition_id: string;
  candidate_id: string;
  proposed_joining_date: string;
  requisition_state: string;
  department_id: string;
  location_id: string;
  designation_id: string;
  employment_type: string;
  application_stage: string;
  full_name: string;
}

export async function handOver(tx: Queryable, grants: HandoverGrants, offerId: string, input: HandoverInput) {
  const grant = grants.hiring;
  const located = (await tx.query<{ transaction_id: string; requisition_id: string }>(`select transaction_id, requisition_id from hiring_offer where company_id = $1 and id = $2`, [grant.companyId, offerId])).rows[0];
  if (!located || !(await canAccessRequisition(tx, grant, located.requisition_id))) throw notFound();
  // One handover per accepted offer: concurrent attempts queue here and the later one finds the first one's result.
  await lockTransaction(tx, located.transaction_id);
  await lockRequisition(tx, grant.companyId, located.requisition_id);
  const o = (
    await tx.query<Target>(
      `select o.id, o.transaction_id, o.state, o.application_id, o.requisition_id, o.candidate_id, to_char(o.proposed_joining_date, 'YYYY-MM-DD') as proposed_joining_date,
              r.state as requisition_state, r.department_id, r.location_id, r.designation_id, et.code as employment_type, a.stage as application_stage, c.full_name
         from hiring_offer o
         join requisition r on r.company_id = o.company_id and r.id = o.requisition_id
         join reference_value et on et.company_id = r.company_id and et.id = r.employment_type_id
         join application a on a.company_id = o.company_id and a.id = o.application_id
         join candidate c on c.company_id = o.company_id and c.id = o.candidate_id
        where o.company_id = $1 and o.id = $2 for update of o, a`,
      [grant.companyId, offerId],
    )
  ).rows[0]!;
  const existing = (await tx.query<{ employee_id: string }>(`select employee_id from hiring_handover where company_id = $1 and offer_id = $2`, [grant.companyId, o.id])).rows[0];
  if (existing) throw new HttpError(409, 'ALREADY_HANDED_OVER', 'This accepted offer has already created an employee', { employeeId: existing.employee_id });
  if (o.state !== 'ACCEPTED') throw new HttpError(409, 'OFFER_NOT_ACCEPTED', 'Only an accepted offer is handed over to onboarding');
  if (o.requisition_state !== 'APPROVED') throw new HttpError(409, 'REQUISITION_NOT_APPROVED', 'Only an approved requisition accepts final placement');
  if (o.application_stage !== 'OFFER') throw new HttpError(409, 'INVALID_STATE', 'The application is no longer at the OFFER stage');
  // FR-014, FR-013: one person becomes one employee, whichever requisition or duplicate record the offer is on.
  await assertConvertible(tx, grant.companyId, o.candidate_id, o.id);
  const documents = input.documents ?? [];
  if (documents.length > 0 && !grants.documents) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  // The reviewed onboarding decision re-checks every duty it uses after the locks (docs/09 §6.5).
  await reassertAccess(tx, grant, 'hiring', 'handover', ['operational']);
  await reassertAccess(tx, grants.employee, 'employee', 'create', ['operational']);
  if (documents.length > 0 && grants.documents) {
    await reassertAccess(tx, grants.documents.read, 'candidate', 'read', ['document']);
    await reassertAccess(tx, grants.documents.upload, 'document', 'upload', ['document']);
  }

  // The ordinary creation path: DRAFT status, scope and master checks, unique code and work email, history, audit.
  const employeeId = await createEmployee(tx, grants.employee, {
    employeeCode: input.employeeCode,
    displayName: input.displayName?.trim() || o.full_name,
    workEmail: input.workEmail,
    joiningDate: o.proposed_joining_date,
    employmentType: o.employment_type,
    departmentId: o.department_id,
    locationId: o.location_id,
    designationId: o.designation_id,
  });
  const handoverId = (
    await tx.query<{ id: string }>(
      `insert into hiring_handover (company_id, offer_id, application_id, requisition_id, candidate_id, employee_id, handed_over_by, acting_assignment_id, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $7) returning id`,
      [grant.companyId, o.id, o.application_id, o.requisition_id, o.candidate_id, employeeId, grant.userId, grant.assignmentId],
    )
  ).rows[0]!.id;

  const transferred: { candidateDocumentId: string; employeeDocumentId: string }[] = [];
  for (const d of documents) {
    const source = (
      await tx.query<{ attachment_id: string; scan_state: string | null }>(
        `select d.attachment_id, a.scan_state from candidate_document d join attachment a on a.company_id = d.company_id and a.id = d.attachment_id
          where d.company_id = $1 and d.id = $2 and d.candidate_id = $3`,
        [grant.companyId, d.candidateDocumentId, o.candidate_id],
      )
    ).rows[0];
    if (!source) throw new HttpError(422, 'INVALID_DOCUMENT', 'Only this candidate’s documents can be transferred', { candidateDocumentId: d.candidateDocumentId });
    // FR-106: only a file the malware scanner released can become part of the employee record.
    if (source.scan_state !== 'CLEAN') {
      throw new HttpError(409, 'FILE_NOT_RELEASED', 'This file has not been released by the malware scan', { candidateDocumentId: d.candidateDocumentId, scanState: source.scan_state });
    }
    const typeId = await referenceId(tx, grant.companyId, 'DOCUMENT_TYPE', d.documentType);
    // The employee's own attachment row points at the same stored content (content-addressed store, ADR-07) and
    // keeps the scan verdict of those very bytes.
    const attachmentId = (
      await tx.query<{ id: string }>(
        `insert into attachment (company_id, owner_user_id, employee_id, content_reference, media_type, checksum, classification, file_name, byte_size,
                                 scan_state, scan_checked_at, created_by, updated_by)
         select company_id, $3, $4, content_reference, media_type, checksum, 'CONFIDENTIAL', file_name, byte_size, scan_state, scan_checked_at, $3, $3
           from attachment where company_id = $1 and id = $2
         returning id`,
        [grant.companyId, source.attachment_id, grant.userId, employeeId],
      )
    ).rows[0]!.id;
    const employeeDocumentId = (
      await tx.query<{ id: string }>(
        `insert into employee_document (company_id, employee_id, document_type_id, attachment_id, created_by, updated_by) values ($1, $2, $3, $4, $5, $5) returning id`,
        [grant.companyId, employeeId, typeId, attachmentId, grant.userId],
      )
    ).rows[0]!.id;
    await tx.query(
      `insert into hiring_handover_document (company_id, handover_id, candidate_id, employee_id, candidate_document_id, employee_document_id, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [grant.companyId, handoverId, o.candidate_id, employeeId, d.candidateDocumentId, employeeDocumentId, grant.userId],
    );
    await audit(tx, grant, 'employee_document', employeeDocumentId, 'CREATE', null, { employeeId, documentType: d.documentType, sourceCandidateDocumentId: d.candidateDocumentId });
    transferred.push({ candidateDocumentId: d.candidateDocumentId, employeeDocumentId });
  }

  // The application becomes HIRED (the database accepts it only with this handover recorded).
  await tx.query(`update application set stage = 'HIRED', updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, o.application_id, grant.userId]);
  await tx.query(
    `insert into application_stage_event (company_id, application_id, from_stage, to_stage, actor_user_id, acting_assignment_id, created_by) values ($1, $2, 'OFFER', 'HIRED', $3, $4, $3)`,
    [grant.companyId, o.application_id, grant.userId, grant.assignmentId],
  );
  await audit(tx, grant, 'application', o.application_id, 'STAGE', { stage: 'OFFER' }, { stage: 'HIRED', employeeId });
  await audit(tx, grant, 'hiring_offer', o.id, 'HANDOVER', null, { handoverId, employeeId, applicationId: o.application_id, requisitionId: o.requisition_id, documentsTransferred: transferred.length });
  return { handoverId, employeeId, employeeStatus: 'DRAFT', offerId: o.id, applicationId: o.application_id, requisitionId: o.requisition_id, documents: transferred };
}

/** FR-014: the onboarding record's origin (requisition, application, offer, candidate), within the caller's scope. */
export async function employeeOrigin(db: Queryable, grant: AccessGrant, employeeId: string) {
  if (!(await canAccessEmployee(db, grant, employeeId))) return null;
  const row = (
    await db.query(
      `select h.id as "handoverId", h.employee_id as "employeeId", h.handed_over_at as "handedOverAt", h.handed_over_by as "handedOverBy",
              ${personSql('h.company_id', 'h.handed_over_by', 'h.handed_over_at')} as "handedOverByPerson",
              json_build_object('id', r.id, 'code', r.code, 'title', r.title) as requisition,
              json_build_object('id', a.id, 'stage', a.stage) as application,
              json_build_object('id', o.id, 'state', o.state, 'proposedJoiningDate', to_char(o.proposed_joining_date, 'YYYY-MM-DD')) as offer,
              json_build_object('id', c.id, 'candidateCode', c.candidate_code) as candidate,
              (select coalesce(json_agg(json_build_object('candidateDocumentId', d.candidate_document_id, 'employeeDocumentId', d.employee_document_id)), '[]'::json)
                 from hiring_handover_document d where d.company_id = h.company_id and d.handover_id = h.id) as documents
         from hiring_handover h
         join requisition r on r.company_id = h.company_id and r.id = h.requisition_id
         join application a on a.company_id = h.company_id and a.id = h.application_id
         join hiring_offer o on o.company_id = h.company_id and o.id = h.offer_id
         join candidate c on c.company_id = h.company_id and c.id = h.candidate_id
        where h.company_id = $1 and h.employee_id = $2`,
      [grant.companyId, employeeId],
    )
  ).rows[0];
  return row ?? null;
}
