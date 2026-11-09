// Files whose malware scan could not be completed (I-84 item 8, decided under owner delegation, 6 Nov 2026; I-73 item 1; FR-106; H4
// "failed scan quarantines"; H7 "scan"; docs/09 §7.2, §8.3).
//
// End state: a file whose attempts ran out stays PENDING_SCAN with scan_failed_at set: never served, never released, and never called
// a finding, because a scanner outage is not a verdict. QUARANTINED stays the final state of a file the scanner flagged. The uploader is
// told once per failure (FILE_SCAN_FAILED: the upload date only) and may upload a replacement.
// Requeue: a holder of attachment.requeue_scan (a System Administrator's default duty: an operational step that reads no file and no
// record) in an unrestricted company-wide assignment sends named failed files back to the scan worker, with a reason. Their attempts
// start again, so the worker's backoff and limit bound them as before; every requeue is audited on the attachment. The list shows
// identifiers, dates, attempts and the failure class only: never a file's name, type, owner or content.
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit/audit.js';
import type { Queryable } from '../db/queryable.js';
import { type Database, withTransaction } from '../db/transaction.js';
import { HttpError } from '../http/errors.js';
import { reassertAccess, requireAccess } from '../http/guard.js';
import type { AccessGrant } from '../modules/access/authorize.js';

/** Most files one requeue names (a starting value, as the other scan limits). */
export const MAX_REQUEUE = 500;

/** The action reaches files of every employee and of nobody, so it needs the whole company. */
function assertWholeCompany(grant: AccessGrant): void {
  const { departments, locations, employees } = grant.filters;
  if (grant.scopeKind !== 'COMPANY' || departments.length + locations.length + employees.length > 0) {
    throw new HttpError(403, 'SCOPE_EXCEEDS_ADMINISTRATOR', 'Failed scans are listed and requeued for the whole company, which is wider than your scope');
  }
}

export interface ScanFailure {
  id: string;
  uploadedAt: string;
  scanFailedAt: string;
  scanAttempts: number;
  scanLastError: string | null;
}

export async function listScanFailures(db: Queryable, grant: AccessGrant, limit = 200): Promise<{ items: ScanFailure[]; total: number }> {
  assertWholeCompany(grant);
  const rows = await db.query<ScanFailure & { total: string }>(
    `select id, created_at as "uploadedAt", scan_failed_at as "scanFailedAt", scan_attempts as "scanAttempts", scan_last_error as "scanLastError",
            count(*) over () as total
       from attachment
      where company_id = $1 and scan_state = 'PENDING_SCAN' and scan_failed_at is not null
      order by scan_failed_at, id limit $2`,
    [grant.companyId, limit],
  );
  return { items: rows.rows.map(({ total: _total, ...r }) => r), total: Number(rows.rows[0]?.total ?? 0) };
}

/**
 * Sends the named failed files back to the scan worker. Ids that are not a failed file of this company (unknown, another company's,
 * released, flagged or already requeued) are returned as not requeued, all alike, and nothing happens to them.
 */
export async function requeueScanFailures(tx: Queryable, grant: AccessGrant, input: { attachmentIds: string[]; reason: string }): Promise<{ requeued: string[]; notRequeued: string[] }> {
  assertWholeCompany(grant);
  await reassertAccess(tx, grant, 'attachment', 'requeue_scan', ['operational']);
  const reason = input.reason.trim();
  if (!reason) throw new HttpError(422, 'REASON_REQUIRED', 'Say why the files are sent back to the scanner');
  const ids = [...new Set(input.attachmentIds.map((i) => i.toLowerCase()))];
  const requeued = (
    await tx.query<{ id: string; scan_attempts_before: number; scan_last_error_before: string | null }>(
      `with target as (
         select id, scan_attempts, scan_last_error from attachment
          where company_id = $1 and id = any($2::uuid[]) and scan_state = 'PENDING_SCAN' and scan_failed_at is not null
          order by id for update
       )
       update attachment a set scan_failed_at = null, scan_attempts = 0, scan_next_attempt_at = null, scan_last_error = null, updated_by = $3
         from target t where a.company_id = $1 and a.id = t.id
       returning a.id, t.scan_attempts as scan_attempts_before, t.scan_last_error as scan_last_error_before`,
      [grant.companyId, ids, grant.userId],
    )
  ).rows;
  for (const r of requeued) {
    await writeAudit(tx, {
      companyId: grant.companyId,
      resource: 'attachment',
      recordKey: r.id,
      actorUserId: grant.userId,
      actingAssignmentId: grant.assignmentId,
      action: 'SCAN_REQUEUED',
      before: { operational: { scanState: 'PENDING_SCAN', scanFailed: true, attempts: r.scan_attempts_before, errorCode: r.scan_last_error_before } },
      after: { operational: { scanState: 'PENDING_SCAN', scanFailed: false, attempts: 0 } },
      reason,
    });
  }
  const done = new Set(requeued.map((r) => r.id));
  return { requeued: [...done].sort(), notRequeued: ids.filter((i) => !done.has(i)).sort() };
}

const uuid = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' };

export async function scanFailureRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  app.get('/attachments/scan-failures', async (request) => {
    const grant = await requireAccess(db, request, 'attachment', 'requeue_scan', ['operational']);
    return listScanFailures(db, grant);
  });

  app.post(
    '/attachments/scan-failures/requeue',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['attachmentIds', 'reason'],
          properties: { attachmentIds: { type: 'array', minItems: 1, maxItems: MAX_REQUEUE, items: uuid }, reason: { type: 'string', minLength: 1, maxLength: 500 } },
        },
      },
    },
    async (request) => {
      const grant = await requireAccess(db, request, 'attachment', 'requeue_scan', ['operational'], { requireAll: true });
      return withTransaction(db, (tx) => requeueScanFailures(tx, grant, request.body as { attachmentIds: string[]; reason: string }));
    },
  );
}
