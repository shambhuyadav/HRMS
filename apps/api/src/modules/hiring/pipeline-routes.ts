// Hiring pipeline routes (FR-013, FR-014; F1): candidates and vendors, private contacts and documents (confidential),
// duplicate review, applications and stages, the tracker, offers with their confidential compensation, the
// independent offer approval and the handover to onboarding. Every route calls requireAccess first.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { notFound } from '../../http/errors.js';
import { auditDenial, requireAccess } from '../../http/guard.js';
import { decodeUpload, downloadHeaders, type FileStore, MAX_UPLOAD_BYTES, UPLOAD_FILE_NAME } from '../../storage/files.js';
import { type ScanProvider, scanAttachment } from '../../storage/scan.js';
import type { AccessGrant } from '../access/authorize.js';
import { type ApplicationQuery, createApplication, getApplication, listApplicationOwners, listApplications, moveStage, type Stage, setApplicationOwner, tracker } from './application.js';
import type { Paging } from './common.js';
import {
  addCandidateDocument,
  type CandidateInput,
  type CandidatePatch,
  candidateDocumentContent,
  candidateExists,
  createCandidate,
  createVendor,
  getCandidate,
  getContact,
  listCandidateDocuments,
  listCandidates,
  listDuplicateFlags,
  listVendors,
  recordCandidateScanVerdict,
  resolveDuplicateFlag,
  searchCandidateDocuments,
  setContact,
  updateCandidate,
  updateVendor,
} from './candidate.js';
import { employeeOrigin, type HandoverInput, handOver } from './handover.js';
import { type CompensationInput, createOffer, decideOffer, getOffer, listOffers, type OfferDecisionInput, offerTasks, recordResponse, setCompensation, submitOffer, updateOffer, withdrawOffer } from './offer.js';
import { canAccessCandidate } from './scope.js';
import { date, decisionBody, expectedVersion, idParams, optionalPaging, paging, reasonBody, skills, uuid, versionBody } from './schemas.js';

const consent = { type: 'string', enum: ['NOT_RECORDED', 'GIVEN', 'WITHDRAWN'] } as const;
const nullableDate = { anyOf: [date, { type: 'null' }] } as const;
const candidateProperties = {
  fullName: { type: 'string', minLength: 1, maxLength: 200 },
  sourceCode: { type: 'string', pattern: '^[A-Z0-9][A-Z0-9_]{0,59}$' },
  vendorId: { anyOf: [uuid, { type: 'null' }] },
  skills,
  consentStatus: consent,
  consentRecordedOn: nullableDate,
  retainUntil: nullableDate,
} as const;
const stages = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'] as const;
const amount = { type: 'string', pattern: '^\\d{1,15}(\\.\\d{1,4})?$' } as const;
const employeeCode = { type: 'string', minLength: 1, maxLength: 40, pattern: '^\\s*[A-Za-z0-9][A-Za-z0-9_-]*\\s*$' } as const;

export async function pipelineRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;

  /** A candidate outside the scope reads as missing; an existing one is a recorded denial (FR-098). */
  const requireCandidateInScope = async (request: FastifyRequest, grant: AccessGrant, candidateId: string, action: string) => {
    if (await canAccessCandidate(db, grant, candidateId)) return;
    if (await candidateExists(db, grant.companyId, candidateId)) await auditDenial(db, request, { resource: 'candidate', action, reason: 'OUT_OF_SCOPE', recordKey: candidateId });
    throw notFound();
  };

  // -------------------------------------------------------------------------------------------------------
  // Vendors (Hiring / Masters / Vendor)
  // -------------------------------------------------------------------------------------------------------
  app.get('/hiring/vendors', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { includeInactive: { type: 'boolean', default: false } } } } }, async (request) =>
    listVendors(db, await requireAccess(db, request, 'candidate', 'read', ['operational']), (request.query as { includeInactive: boolean }).includeInactive),
  );

  app.post(
    '/hiring/vendors',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'name'],
          properties: { code: { type: 'string', pattern: '^\\s*[A-Za-z0-9][A-Za-z0-9_-]{0,39}\\s*$' }, name: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'candidate', 'manage', ['operational'], { requireAll: true });
      const result = await withTransaction(db, (tx) => createVendor(tx, grant, request.body as { code: string; name: string }));
      reply.status(201);
      return result;
    },
  );

  app.patch(
    '/hiring/vendors/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion'],
          minProperties: 2,
          properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, active: { type: 'boolean' }, expectedVersion },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'candidate', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => updateVendor(tx, grant, id, request.body as { name?: string; active?: boolean; expectedVersion: number }));
    },
  );

  // -------------------------------------------------------------------------------------------------------
  // FR-013 candidate register (operational)
  // -------------------------------------------------------------------------------------------------------
  app.get(
    '/hiring/candidates',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { search: { type: 'string', maxLength: 100 }, state: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'DUPLICATE'] }, ...paging },
        },
      },
    },
    async (request) => listCandidates(db, await requireAccess(db, request, 'candidate', 'read', ['operational']), request.query as Parameters<typeof listCandidates>[2]),
  );

  app.post(
    '/hiring/candidates',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['fullName', 'sourceCode', 'consentStatus'], properties: candidateProperties } } },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'candidate', 'manage', ['operational'], { requireAll: true });
      const id = await withTransaction(db, (tx) => createCandidate(tx, grant, request.body as CandidateInput));
      reply.status(201);
      return getCandidate(db, grant, id);
    },
  );

  app.get('/hiring/candidates/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const view = await getCandidate(db, await requireAccess(db, request, 'candidate', 'read', ['operational'], { recordKey: id }), id);
    if (!view) throw notFound();
    return view;
  });

  app.patch(
    '/hiring/candidates/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion'],
          minProperties: 2,
          properties: { ...candidateProperties, state: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] }, expectedVersion },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'candidate', 'manage', ['operational'], { requireAll: true, recordKey: id });
      await withTransaction(db, (tx) => updateCandidate(tx, grant, id, request.body as CandidatePatch));
      return getCandidate(db, grant, id);
    },
  );

  // F1: private contacts need an eligible scoped Admin assignment holding the confidential grant.
  app.get('/hiring/candidates/:id/contact', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'candidate', 'read', ['contact'], { requireAll: true, recordKey: id });
    await requireCandidateInScope(request, grant, id, 'read_contact');
    return getContact(db, grant, id);
  });

  app.put(
    '/hiring/candidates/:id/contact',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { email: { anyOf: [{ type: 'string', minLength: 3, maxLength: 254 }, { type: 'null' }] }, phone: { anyOf: [{ type: 'string', minLength: 3, maxLength: 40 }, { type: 'null' }] } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'candidate', 'manage', ['contact'], { requireAll: true, recordKey: id });
      await requireCandidateInScope(request, grant, id, 'manage_contact');
      return withTransaction(db, (tx) => setContact(tx, grant, id, request.body as { email?: string | null; phone?: string | null }));
    },
  );

  // CV and other candidate documents (confidential).
  app.post(
    '/hiring/candidates/:id/documents',
    {
      bodyLimit: Math.ceil(MAX_UPLOAD_BYTES * 1.4),
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['documentType', 'fileName', 'contentBase64'],
          properties: { documentType: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' }, fileName: UPLOAD_FILE_NAME, contentBase64: { type: 'string', minLength: 4 } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { documentType: string; fileName: string; contentBase64: string };
      const grant = await requireAccess(db, request, 'candidate', 'upload', ['document'], { requireAll: true, recordKey: id });
      await requireCandidateInScope(request, grant, id, 'upload_document');
      const { bytes, mediaType } = decodeUpload(body.contentBase64);
      const stored = await files.put(grant.companyId, bytes);
      const { attachmentId, ...document } = await withTransaction(db, (tx) => addCandidateDocument(tx, grant, id, { documentType: body.documentType, fileName: body.fileName, stored, mediaType }));
      // FR-106: the stored file stays PENDING_SCAN for the scan worker; in every deployment nothing is scanned in this request (NFR-S09; storage/scan.ts).
      const scanState = await scanAttachment(db, scanner, { companyId: grant.companyId, id: attachmentId, bytes });
      if (scanState !== 'PENDING_SCAN') await recordCandidateScanVerdict(db, grant, document.id, scanState);
      reply.status(201);
      return { ...document, scanState };
    },
  );

  app.get('/hiring/candidates/:id/documents', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'candidate', 'read', ['document'], { requireAll: true, recordKey: id });
    await requireCandidateInScope(request, grant, id, 'read_document');
    return listCandidateDocuments(db, grant, id);
  });

  app.get(
    '/hiring/candidate-documents',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, required: ['search'], properties: { search: { type: 'string', minLength: 1, maxLength: 100 }, ...optionalPaging } },
      },
    },
    async (request) => {
      const { search, ...page } = request.query as { search: string } & Paging;
      return searchCandidateDocuments(db, await requireAccess(db, request, 'candidate', 'read', ['document'], { requireAll: true }), search, page);
    },
  );

  app.get('/hiring/candidate-documents/:id/content', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'candidate', 'read', ['document'], { requireAll: true, recordKey: id });
    const content = await candidateDocumentContent(db, grant, files, id);
    if (!content) {
      const existing = await db.query(`select 1 from candidate_document where company_id = $1 and id = $2`, [grant.companyId, id]);
      if (existing.rowCount) await auditDenial(db, request, { resource: 'candidate_document', action: 'read', reason: 'OUT_OF_SCOPE', recordKey: id });
      throw notFound();
    }
    reply.headers(downloadHeaders({ mediaType: content.mediaType, fileName: content.fileName }, 'candidate-document'));
    return content.bytes;
  });

  // FR-013 duplicate review (no automatic merge).
  app.get(
    '/hiring/duplicate-flags',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', enum: ['OPEN', 'NOT_DUPLICATE', 'CONFIRMED_DUPLICATE'] }, ...optionalPaging } } } },
    async (request) => listDuplicateFlags(db, await requireAccess(db, request, 'candidate', 'read', ['operational']), request.query as { state?: string } & Paging),
  );

  app.post(
    '/hiring/duplicate-flags/:id/resolve',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['resolution', 'note'],
          properties: { resolution: { type: 'string', enum: ['NOT_DUPLICATE', 'CONFIRMED_DUPLICATE'] }, retireCandidateId: uuid, note: { type: 'string', minLength: 1, maxLength: 1000 } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'candidate', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) =>
        resolveDuplicateFlag(tx, grant, id, request.body as { resolution: 'NOT_DUPLICATE' | 'CONFIRMED_DUPLICATE'; retireCandidateId?: string; note: string }),
      );
    },
  );

  // -------------------------------------------------------------------------------------------------------
  // Applications (DB062) and the tracker (FR-014)
  // -------------------------------------------------------------------------------------------------------
  app.post(
    '/hiring/requisitions/:id/applications',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['candidateId'], properties: { candidateId: uuid, ownerUserId: uuid } } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'application', 'manage', ['operational'], { requireAll: true, recordKey: id });
      const applicationId = await withTransaction(db, (tx) => createApplication(tx, grant, id, request.body as { candidateId: string; ownerUserId?: string }));
      reply.status(201);
      return getApplication(db, grant, applicationId);
    },
  );

  app.get(
    '/hiring/applications',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: { requisitionId: uuid, candidateId: uuid, stage: { type: 'string', enum: stages }, open: { type: 'boolean' }, ownerUserId: uuid, ...optionalPaging } },
      },
    },
    async (request) => listApplications(db, await requireAccess(db, request, 'application', 'read', ['operational']), request.query as ApplicationQuery),
  );

  app.get('/hiring/applications/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const view = await getApplication(db, await requireAccess(db, request, 'application', 'read', ['operational'], { recordKey: id }), id);
    if (!view) throw notFound();
    return view;
  });

  app.post(
    '/hiring/applications/:id/stage',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['toStage', 'expectedVersion'], properties: { toStage: { type: 'string', enum: stages }, note: { type: 'string', minLength: 1, maxLength: 1000 }, expectedVersion } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'application', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => moveStage(tx, grant, id, request.body as { toStage: Stage; note?: string; expectedVersion: number }));
    },
  );

  app.put(
    '/hiring/applications/:id/owner',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['ownerUserId', 'expectedVersion'], properties: { ownerUserId: uuid, expectedVersion } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'application', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => setApplicationOwner(tx, grant, id, request.body as { ownerUserId: string; expectedVersion: number }));
    },
  );

  // Users eligible to own an application (the owner duty), for whoever assigns owners.
  app.get(
    '/hiring/application-owners',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { search: { type: 'string', maxLength: 100 }, ...paging } } } },
    async (request) =>
      listApplicationOwners(db, await requireAccess(db, request, 'application', 'manage', ['operational'], { requireAll: true }), request.query as { search?: string; page: number; pageSize: number }),
  );

  app.get(
    '/hiring/tracker',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: { requisitionId: uuid, ownerUserId: uuid, includeClosed: { type: 'boolean', default: false }, ...optionalPaging } },
      },
    },
    async (request) => tracker(db, await requireAccess(db, request, 'application', 'read', ['operational']), request.query as Parameters<typeof tracker>[2]),
  );

  // -------------------------------------------------------------------------------------------------------
  // Offers (F1) and handover (FR-014)
  // -------------------------------------------------------------------------------------------------------
  app.post(
    '/hiring/applications/:id/offers',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['proposedJoiningDate'], properties: { proposedJoiningDate: date } } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'offer', 'manage', ['operational'], { requireAll: true, recordKey: id });
      const offerId = await withTransaction(db, (tx) => createOffer(tx, grant, id, request.body as { proposedJoiningDate: string }));
      reply.status(201);
      return getOffer(db, grant, offerId);
    },
  );

  app.get(
    '/hiring/offers',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { requisitionId: uuid, state: { type: 'string', enum: ['DRAFT', 'SUBMITTED', 'APPROVED', 'ACCEPTED', 'DECLINED', 'REJECTED', 'WITHDRAWN'] }, ...optionalPaging },
        },
      },
    },
    async (request) => listOffers(db, await requireAccess(db, request, 'offer', 'read', ['operational']), request.query as { requisitionId?: string; state?: string } & Paging),
  );

  // Operational view for every offer reader; the compensation only within an eligible Admin assignment holding the grant.
  app.get('/hiring/offers/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const view = await getOffer(db, await requireAccess(db, request, 'offer', 'read', ['operational', 'compensation'], { recordKey: id }), id);
    if (!view) throw notFound();
    return view;
  });

  app.put(
    '/hiring/offers/:id',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['proposedJoiningDate', 'expectedVersion'], properties: { proposedJoiningDate: date, expectedVersion } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'offer', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => updateOffer(tx, grant, id, request.body as { proposedJoiningDate: string; expectedVersion: number }));
    },
  );

  app.put(
    '/hiring/offers/:id/compensation',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['currencyCode', 'expectedVersion'],
          properties: { currencyCode: { type: 'string', pattern: '^[A-Z]{3}$' }, annualCtc: amount, monthlyGross: amount, expectedVersion },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'offer', 'manage', ['compensation'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => setCompensation(tx, grant, id, request.body as CompensationInput));
    },
  );

  app.post('/hiring/offers/:id/submit', { schema: { params: idParams, body: versionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'offer', 'manage', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => submitOffer(tx, grant, id, request.body as { expectedVersion: number }));
  });

  app.post('/hiring/offers/:id/withdraw', { schema: { params: idParams, body: reasonBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'offer', 'manage', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => withdrawOffer(tx, grant, id, request.body as { reason: string }));
  });

  app.post(
    '/hiring/offers/:id/response',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['response', 'respondedOn', 'expectedVersion'],
          properties: { response: { type: 'string', enum: ['ACCEPTED', 'DECLINED'] }, respondedOn: date, expectedVersion },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'offer', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => recordResponse(tx, grant, id, request.body as { response: 'ACCEPTED' | 'DECLINED'; respondedOn: string; expectedVersion: number }));
    },
  );

  app.get('/hiring/offer-tasks', async (request) => offerTasks(db, await requireAccess(db, request, 'offer', 'approve', ['compensation'], { requireAll: true })));

  app.post('/hiring/offer-tasks/:id/decision', { schema: { params: idParams, body: decisionBody(['APPROVE', 'REJECT', 'RETURN']) } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'offer', 'approve', ['compensation'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => decideOffer(tx, grant, id, request.body as OfferDecisionInput));
  });

  app.post(
    '/hiring/offers/:id/handover',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['employeeCode'],
          properties: {
            employeeCode,
            displayName: { type: 'string', minLength: 1, maxLength: 200 },
            workEmail: { type: 'string', format: 'email', maxLength: 254 },
            documents: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['candidateDocumentId', 'documentType'],
                properties: { candidateDocumentId: uuid, documentType: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' } },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as HandoverInput;
      const hiring = await requireAccess(db, request, 'hiring', 'handover', ['operational'], { requireAll: true, recordKey: id });
      // The ordinary employee creation duty applies too (same assignment, same scope).
      const employee = await requireAccess(db, request, 'employee', 'create', ['operational'], { requireAll: true, recordKey: id });
      const documents =
        body.documents && body.documents.length > 0
          ? {
              read: await requireAccess(db, request, 'candidate', 'read', ['document'], { requireAll: true, recordKey: id }),
              upload: await requireAccess(db, request, 'document', 'upload', ['document'], { requireAll: true, recordKey: id }),
            }
          : undefined;
      const result = await withTransaction(db, (tx) => handOver(tx, { hiring, employee, documents }, id, body));
      reply.status(201);
      return result;
    },
  );

  // FR-014: the onboarding record traces back to its requisition, application, offer and candidate.
  app.get('/hiring/employees/:id/origin', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const origin = await employeeOrigin(db, await requireAccess(db, request, 'application', 'read', ['operational'], { recordKey: id }), id);
    if (!origin) throw notFound();
    return origin;
  });
}
