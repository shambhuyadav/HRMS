// Company policy documents (FR-010 "documents and policies with version, classification, employee/company scope,
// expiry and access controls"; DF02; FR-106; FR-057; BR-043). Migration 0054_company_documents.
//   * A policy belongs to one company (company scope): every query is filtered by the caller's company, so another
//     company's policy reads as not found (FR-010 acceptance: it cannot be downloaded by another company's user).
//   * Classification: an OPERATIONAL policy is readable by every employee of the company; a CONFIDENTIAL one, its
//     title included, exists only for callers holding the confidential group (DF02), and is otherwise not found
//     (a recorded denial). Reclassification applies to every version (the latest restriction governs history).
//   * Versions: each new file is the next version, quarantined and scanned like every upload (FR-106); only released
//     (CLEAN) content is served. Versions are immutable and nothing is deleted (history kept). Expiry is an optional
//     date per version; an expired version stays on record and is flagged, and its policy's managers are notified on
//     the expiry date (DF12; expiry.ts).
//   * Publishing needs an unrestricted company-scope assignment (company property, like organisation masters).
//   * Audit records name the policy, version and file (keyed by the policy's field group); never file content.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { auditDenial, reassertAccess, requireAccess } from '../../http/guard.js';
import { decodeUpload, downloadHeaders, type FileStore, MAX_UPLOAD_BYTES, UPLOAD_FILE_NAME } from '../../storage/files.js';
import { type ScanProvider, scanAttachment } from '../../storage/scan.js';
import type { AccessGrant } from '../access/authorize.js';

export type Classification = 'OPERATIONAL' | 'CONFIDENTIAL';
const CLASSIFICATIONS = ['OPERATIONAL', 'CONFIDENTIAL'] as const;
const RESOURCE = 'company_policy';
const BOTH = ['operational', 'confidential'] as const;

/** The field group a policy's metadata and content belong to. */
const groupOf = (c: Classification) => (c === 'CONFIDENTIAL' ? 'confidential' : 'operational');
const groupsFor = (c: Classification): string[] => (c === 'CONFIDENTIAL' ? ['operational', 'confidential'] : ['operational']);
const mayHandle = (grant: AccessGrant, c: Classification) => c === 'OPERATIONAL' || grant.allowedFieldGroups.includes('confidential');

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const file = { fileName: UPLOAD_FILE_NAME, contentBase64: { type: 'string', minLength: 4 }, expiresOn: { type: 'string', format: 'date' }, changeNote: { type: 'string', minLength: 1, maxLength: 1000 } } as const;

interface PolicyRow {
  id: string;
  policy_code: string;
  title: string;
  classification: Classification;
  version: number;
}

interface FileInput {
  fileName: string;
  contentBase64: string;
  expiresOn?: string;
  changeNote?: string;
}

function isCompanyWide(grant: AccessGrant): boolean {
  const { departments, locations, employees } = grant.filters;
  return grant.scopeKind === 'COMPANY' && departments.length + locations.length + employees.length === 0;
}

function checkExpiry(expiresOn: string | undefined, businessDate: string): void {
  if (expiresOn !== undefined && expiresOn < businessDate) throw new HttpError(422, 'EXPIRY_IN_PAST', 'A new policy version cannot already be expired');
}

const audit = (tx: Queryable, grant: AccessGrant, recordKey: string, action: string, before: Record<string, unknown> | null, after: Record<string, unknown>) =>
  writeAudit(tx, { companyId: grant.companyId, resource: RESOURCE, recordKey, actorUserId: grant.userId, actingAssignmentId: grant.assignmentId, action, before, after });

/** Appends the next version of a locked policy; the file stays quarantined (PENDING_SCAN) until scanned. */
async function insertVersion(
  tx: Queryable,
  grant: AccessGrant,
  p: Pick<PolicyRow, 'id' | 'classification'>,
  input: FileInput,
  stored: { reference: string; checksum: string; byteSize: number },
  mediaType: string,
) {
  const versionNumber = (
    await tx.query<{ n: number }>(`select coalesce(max(version_number), 0)::int + 1 as n from company_policy_version where company_id = $1 and policy_id = $2`, [grant.companyId, p.id])
  ).rows[0]!.n;
  const attachmentId = (
    await tx.query<{ id: string }>(
      `insert into attachment (company_id, owner_user_id, content_reference, media_type, checksum, classification, file_name, byte_size, scan_state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING_SCAN', $2, $2) returning id`,
      [grant.companyId, grant.userId, stored.reference, mediaType, stored.checksum, p.classification, input.fileName.trim(), stored.byteSize],
    )
  ).rows[0]!.id;
  const versionId = (
    await tx.query<{ id: string }>(
      `insert into company_policy_version (company_id, policy_id, version_number, attachment_id, expires_on, change_note, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $7) returning id`,
      [grant.companyId, p.id, versionNumber, attachmentId, input.expiresOn ?? null, input.changeNote?.trim() || null, grant.userId],
    )
  ).rows[0]!.id;
  return { versionId, versionNumber, attachmentId };
}

/** FR-106: scans the stored upload after its transaction; a scanner error leaves it pending for the retry worker. */
async function scanVersion(db: Database, scanner: ScanProvider, grant: AccessGrant, policy: { id: string; classification: Classification }, v: { versionNumber: number; attachmentId: string }, bytes: Buffer) {
  const scanState = await scanAttachment(db, scanner, { companyId: grant.companyId, id: v.attachmentId, bytes });
  if (scanState !== 'PENDING_SCAN') {
    await audit(db, grant, policy.id, scanState === 'CLEAN' ? 'SCAN_RELEASED' : 'SCAN_QUARANTINED', null, {
      [groupOf(policy.classification)]: { versionNumber: v.versionNumber, scanState },
    });
  }
  return scanState;
}

export async function companyPolicyRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;

  /** Publishing is company-wide: a narrower assignment is a recorded denial (FR-098). */
  const requireCompanyWide = async (request: FastifyRequest, grant: AccessGrant, recordKey?: string) => {
    if (isCompanyWide(grant)) return;
    await auditDenial(db, request, { resource: RESOURCE, action: 'manage', reason: 'OUT_OF_SCOPE', ...(recordKey ? { recordKey } : {}) });
    throw new HttpError(403, 'FORBIDDEN', 'Company policies are published from an unrestricted company-scope assignment');
  };

  /** The caller's company's policy; a confidential one without the confidential group is a recorded denial; both read as not found. */
  const visiblePolicy = async (request: FastifyRequest, grant: AccessGrant, id: string, action: 'read' | 'manage', q: Queryable = db, lock = false): Promise<PolicyRow> => {
    const p = (
      await q.query<PolicyRow>(`select id, policy_code, title, classification, version from company_policy where company_id = $1 and id = $2${lock ? ' for update' : ''}`, [grant.companyId, id])
    ).rows[0];
    if (!p) throw notFound();
    if (!mayHandle(grant, p.classification)) {
      await auditDenial(db, request, { resource: RESOURCE, action, reason: 'FIELD_GROUP_DENIED', fieldGroups: ['confidential'], recordKey: id });
      throw notFound();
    }
    return p;
  };

  app.post(
    '/company-policies',
    {
      bodyLimit: Math.ceil(MAX_UPLOAD_BYTES * 1.4),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['policyCode', 'title', 'classification', 'fileName', 'contentBase64'],
          properties: {
            policyCode: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' },
            title: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
            classification: { type: 'string', enum: [...CLASSIFICATIONS] },
            ...file,
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as FileInput & { policyCode: string; title: string; classification: Classification };
      const grant = await requireAccess(db, request, RESOURCE, 'manage', groupsFor(body.classification), { requireAll: true });
      await requireCompanyWide(request, grant);
      checkExpiry(body.expiresOn, grant.businessDate);
      const { bytes, mediaType } = decodeUpload(body.contentBase64);
      const stored = await files.put(grant.companyId, bytes);
      const title = body.title.trim();
      const created = await withTransaction(db, async (tx) => {
        await tx.query(`select pg_advisory_xact_lock(hashtextextended('company_policy:' || $1 || ':' || $2, 0))`, [grant.companyId, body.policyCode]);
        const exists = await tx.query(`select 1 from company_policy where company_id = $1 and policy_code = $2`, [grant.companyId, body.policyCode]);
        if ((exists.rowCount ?? 0) > 0) throw new HttpError(409, 'POLICY_EXISTS', 'A policy with this code exists; publish a new version of it instead');
        const id = (
          await tx.query<{ id: string }>(
            `insert into company_policy (company_id, policy_code, title, classification, created_by, updated_by) values ($1, $2, $3, $4, $5, $5) returning id`,
            [grant.companyId, body.policyCode, title, body.classification, grant.userId],
          )
        ).rows[0]!.id;
        const v = await insertVersion(tx, grant, { id, classification: body.classification }, body, stored, mediaType);
        await audit(tx, grant, id, 'CREATE', null, {
          [groupOf(body.classification)]: {
            policyCode: body.policyCode,
            title,
            classification: body.classification,
            versionNumber: v.versionNumber,
            fileName: body.fileName.trim(),
            byteSize: stored.byteSize,
            expiresOn: body.expiresOn ?? null,
          },
        });
        return { id, ...v };
      });
      const scanState = await scanVersion(db, scanner, grant, { id: created.id, classification: body.classification }, created, bytes);
      reply.status(201);
      return {
        id: created.id,
        policyCode: body.policyCode,
        title,
        classification: body.classification,
        version: 1,
        versionId: created.versionId,
        versionNumber: created.versionNumber,
        mediaType,
        byteSize: stored.byteSize,
        scanState,
      };
    },
  );

  app.post(
    '/company-policies/:id/versions',
    {
      bodyLimit: Math.ceil(MAX_UPLOAD_BYTES * 1.4),
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['fileName', 'contentBase64', 'expectedVersion'], properties: { ...file, expectedVersion: { type: 'integer', minimum: 1 } } },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as FileInput & { expectedVersion: number };
      const grant = await requireAccess(db, request, RESOURCE, 'manage', [...BOTH], { recordKey: id });
      await visiblePolicy(request, grant, id, 'manage');
      await requireCompanyWide(request, grant, id);
      checkExpiry(body.expiresOn, grant.businessDate);
      const { bytes, mediaType } = decodeUpload(body.contentBase64);
      const stored = await files.put(grant.companyId, bytes);
      const { policy, v } = await withTransaction(db, async (tx) => {
        const p = await visiblePolicy(request, grant, id, 'manage', tx, true);
        if (p.version !== body.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The policy changed; reload and retry');
        const added = await insertVersion(tx, grant, p, body, stored, mediaType);
        await tx.query(`update company_policy set version = version + 1, updated_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
        await audit(
          tx,
          grant,
          id,
          'CREATE_VERSION',
          { [groupOf(p.classification)]: { versionNumber: added.versionNumber - 1 } },
          { [groupOf(p.classification)]: { versionNumber: added.versionNumber, fileName: body.fileName.trim(), byteSize: stored.byteSize, expiresOn: body.expiresOn ?? null } },
        );
        return { policy: p, v: added };
      });
      const scanState = await scanVersion(db, scanner, grant, policy, v, bytes);
      reply.status(201);
      return { id, version: policy.version + 1, versionId: v.versionId, versionNumber: v.versionNumber, mediaType, byteSize: stored.byteSize, scanState };
    },
  );

  // Title and classification. Making a policy confidential, or confidential content operational, needs the
  // confidential group; the grant is re-resolved after the lock because a downgrade exposes every version.
  app.patch(
    '/company-policies/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion'],
          minProperties: 2,
          properties: {
            expectedVersion: { type: 'integer', minimum: 1 },
            title: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
            classification: { type: 'string', enum: [...CLASSIFICATIONS] },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { expectedVersion: number; title?: string; classification?: Classification };
      const grant = await requireAccess(db, request, RESOURCE, 'manage', [...BOTH], { recordKey: id });
      await visiblePolicy(request, grant, id, 'manage');
      if (body.classification && !mayHandle(grant, body.classification)) {
        await auditDenial(db, request, { resource: RESOURCE, action: 'manage', reason: 'FIELD_GROUP_DENIED', fieldGroups: ['confidential'], recordKey: id });
        throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
      }
      await requireCompanyWide(request, grant, id);
      return withTransaction(db, async (tx) => {
        const p = await visiblePolicy(request, grant, id, 'manage', tx, true);
        if (p.version !== body.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The policy changed; reload and retry');
        const title = body.title?.trim() ?? p.title;
        const classification = body.classification ?? p.classification;
        const needed = p.classification === 'CONFIDENTIAL' || classification === 'CONFIDENTIAL' ? [...BOTH] : ['operational'];
        await reassertAccess(tx, grant, RESOURCE, 'manage', needed);
        if (title === p.title && classification === p.classification) return policyView(tx, grant, id);
        await tx.query(`update company_policy set title = $3, classification = $4, version = version + 1, updated_at = now(), updated_by = $5 where company_id = $1 and id = $2`, [
          grant.companyId,
          id,
          title,
          classification,
          grant.userId,
        ]);
        // The files follow their policy's classification.
        await tx.query(
          `update attachment a set classification = $3, updated_at = now(), updated_by = $4
             from company_policy_version v where v.company_id = $1 and v.policy_id = $2 and a.company_id = v.company_id and a.id = v.attachment_id`,
          [grant.companyId, id, classification, grant.userId],
        );
        await audit(
          tx,
          grant,
          id,
          'UPDATE',
          { [groupOf(p.classification)]: { title: p.title, classification: p.classification } },
          { [groupOf(classification)]: { title, classification } },
        );
        return policyView(tx, grant, id);
      });
    },
  );

  app.get('/company-policies', async (request) => {
    const grant = await requireAccess(db, request, RESOURCE, 'read', [...BOTH]);
    const rows = await db.query(
      `select p.id, p.policy_code as "policyCode", p.title, p.classification, p.version,
              (select max(v.version_number) from company_policy_version v where v.company_id = p.company_id and v.policy_id = p.id) as "latestVersionNumber",
              cv.current as "currentVersion"
         from company_policy p
         left join lateral (
           select json_build_object('id', v.id, 'versionNumber', v.version_number, 'fileName', a.file_name, 'mediaType', a.media_type, 'byteSize', a.byte_size,
                                    'expiresOn', to_char(v.expires_on, 'YYYY-MM-DD'), 'expired', coalesce(v.expires_on < hrms_business_date(v.company_id, now()), false),
                                    'publishedAt', v.created_at) as current
             from company_policy_version v join attachment a on a.company_id = v.company_id and a.id = v.attachment_id
            where v.company_id = p.company_id and v.policy_id = p.id and a.scan_state = 'CLEAN'
            order by v.version_number desc limit 1) cv on true
        where p.company_id = $1 and (p.classification = 'OPERATIONAL' or $2::boolean)
        order by p.policy_code`,
      [grant.companyId, mayHandle(grant, 'CONFIDENTIAL')],
    );
    return { items: rows.rows };
  });

  app.get('/company-policies/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, RESOURCE, 'read', [...BOTH], { recordKey: id });
    await visiblePolicy(request, grant, id, 'read');
    return policyView(db, grant, id);
  });

  app.get('/company-policy-versions/:id/content', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, RESOURCE, 'read', [...BOTH], { recordKey: id });
    const v = (
      await db.query<{ policy_id: string; version_number: number; classification: Classification; content_reference: string; media_type: string; file_name: string | null; scan_state: string | null }>(
        `select v.policy_id, v.version_number, p.classification, a.content_reference, a.media_type, a.file_name, a.scan_state
           from company_policy_version v
           join company_policy p on p.company_id = v.company_id and p.id = v.policy_id
           join attachment a on a.company_id = v.company_id and a.id = v.attachment_id
          where v.company_id = $1 and v.id = $2`,
        [grant.companyId, id],
      )
    ).rows[0];
    if (!v) throw notFound();
    if (!mayHandle(grant, v.classification)) {
      await auditDenial(db, request, { resource: RESOURCE, action: 'read', reason: 'FIELD_GROUP_DENIED', fieldGroups: ['confidential'], recordKey: id });
      throw notFound();
    }
    // FR-106: quarantined or not-yet-scanned content is never served, to anyone.
    if (v.scan_state !== 'CLEAN') throw new HttpError(409, 'FILE_NOT_RELEASED', 'This file has not been released by the malware scan', { scanState: v.scan_state });
    const headers = downloadHeaders({ mediaType: v.media_type, fileName: v.file_name }, 'policy');
    const bytes = await files.get(v.content_reference);
    // FR-057: recorded once the bytes are in hand; names the version, never the content.
    await audit(db, grant, v.policy_id, 'READ_CONTENT', null, { [groupOf(v.classification)]: { versionId: id, versionNumber: v.version_number } });
    reply.headers(headers);
    return bytes;
  });
}

/** A policy with its whole version history (caller has checked visibility). */
async function policyView(db: Queryable, grant: AccessGrant, id: string) {
  const p = (
    await db.query<Record<string, unknown>>(
      `select id, policy_code as "policyCode", title, classification, version, created_at as "createdAt", updated_at as "updatedAt"
         from company_policy where company_id = $1 and id = $2`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!p) throw notFound();
  const versions = await db.query(
    `select v.id, v.version_number as "versionNumber", a.file_name as "fileName", a.media_type as "mediaType", a.byte_size as "byteSize",
            to_char(v.expires_on, 'YYYY-MM-DD') as "expiresOn", coalesce(v.expires_on < hrms_business_date(v.company_id, now()), false) as expired,
            a.scan_state as "scanState", v.change_note as "changeNote", v.created_at as "publishedAt"
       from company_policy_version v join attachment a on a.company_id = v.company_id and a.id = v.attachment_id
      where v.company_id = $1 and v.policy_id = $2 order by v.version_number desc`,
    [grant.companyId, id],
  );
  return { ...p, versions: versions.rows };
}
