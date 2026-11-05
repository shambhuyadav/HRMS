// Biometric employee mapping (FR-088 "versioned effective employee links"; BR-036; DF09 "Employee mapping is effective-dated
// and same-company"). The database refuses overlaps and another company's employee (0014). A link is never rewritten: it is
// ended or superseded by a dated successor with a reason, and every change is audited. Punches already made under a link stay
// as they are; ending one affects later fetches and reprocessing only. Locks: the actor's assignment, then the link row.
import { writeAudit } from '../../audit/audit.js';
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, assertNotOwnRecord } from '../access/authorize.js';

const LINK_LIST_CAP = 500;

interface LinkRow {
  id: string;
  profile_id: string;
  external_employee_key: string;
  employee_id: string;
  effective_from: Date;
  effective_to: Date | null;
  version: number;
}

const audit = (tx: Queryable, grant: AccessGrant, linkId: string, action: string, before: Record<string, unknown> | null, after: Record<string, unknown>, reason?: string, version?: { priorVersion: number; newVersion: number }) =>
  writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'biometric_employee_link',
    recordKey: linkId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action,
    before: before ? { operational: before } : null,
    after: { operational: after },
    reason: reason ?? null,
    ...(version ?? {}),
  });

async function lockLink(tx: Queryable, grant: AccessGrant, id: string, expectedVersion: number): Promise<LinkRow> {
  await reassertAccess(tx, grant, 'biometric', 'employee_link_manage', ['operational']);
  const link = (
    await tx.query<LinkRow>(
      `select id, profile_id, external_employee_key, employee_id, effective_from, effective_to, version from biometric_employee_link where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!link) throw notFound();
  if (link.version !== expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The link changed; reload and retry');
  return link;
}

async function insertLink(tx: Queryable, grant: AccessGrant, profileId: string, key: string, employeeId: string, from: Date, to: Date | null, reason?: string): Promise<string> {
  await assertNotOwnRecord(tx, grant, employeeId);
  const id = (
    await tx.query<{ id: string }>(
      `insert into biometric_employee_link (company_id, profile_id, external_employee_key, employee_id, effective_from, effective_to, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $7) returning id`,
      [grant.companyId, profileId, key, employeeId, from, to, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, grant, id, 'CREATE', null, { profileId, externalEmployeeKey: key, employeeId, effectiveFrom: from.toISOString(), effectiveTo: to?.toISOString() ?? null }, reason);
  return id;
}

export async function createLink(tx: Queryable, grant: AccessGrant, profileId: string, input: { externalEmployeeKey: string; employeeId: string; effectiveFrom: string; effectiveTo?: string | undefined }) {
  await reassertAccess(tx, grant, 'biometric', 'employee_link_manage', ['operational']);
  const profile = await tx.query(`select 1 from biometric_profile where company_id = $1 and id = $2`, [grant.companyId, profileId]);
  if (!profile.rowCount) throw notFound();
  const from = new Date(input.effectiveFrom);
  const to = input.effectiveTo ? new Date(input.effectiveTo) : null;
  if (to && to <= from) throw new HttpError(422, 'INVALID_PERIOD', 'The end must be after the start');
  const id = await insertLink(tx, grant, profileId, input.externalEmployeeKey, input.employeeId, from, to);
  return { id, linked: true };
}

/** Ends a link not yet ended. A back-dated end corrects a wrong link; punches it already made stay on record. */
export async function endLink(tx: Queryable, grant: AccessGrant, id: string, input: { effectiveTo: string; reason: string; expectedVersion: number }) {
  const link = await lockLink(tx, grant, id, input.expectedVersion);
  if (link.effective_to && link.effective_to.getTime() <= Date.now()) throw new HttpError(409, 'LINK_ENDED', 'This link has already ended; add a new link instead');
  const to = new Date(input.effectiveTo);
  if (to <= link.effective_from) throw new HttpError(422, 'INVALID_PERIOD', 'The end must be after the link’s start');
  await tx.query(`update biometric_employee_link set effective_to = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, id, to, grant.userId]);
  await audit(tx, grant, id, 'END', { effectiveTo: link.effective_to?.toISOString() ?? null }, { effectiveTo: to.toISOString() }, input.reason.trim(), { priorVersion: link.version, newVersion: link.version + 1 });
  return { id, effectiveTo: to.toISOString() };
}

/**
 * The same identity moves to another employee from a date: the link ends there and its successor runs for the rest of its
 * period, in one transaction, so the identity is never left unmatched between them.
 */
export async function supersedeLink(tx: Queryable, grant: AccessGrant, id: string, input: { employeeId: string; effectiveFrom: string; reason: string; expectedVersion: number }) {
  const link = await lockLink(tx, grant, id, input.expectedVersion);
  const from = new Date(input.effectiveFrom);
  if (from <= link.effective_from || (link.effective_to && from >= link.effective_to)) throw new HttpError(422, 'INVALID_PERIOD', 'The change must fall inside the link’s period');
  if (input.employeeId === link.employee_id) throw new HttpError(422, 'NO_CHANGE', 'The link already points to this employee');
  const reason = input.reason.trim();
  await tx.query(`update biometric_employee_link set effective_to = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, id, from, grant.userId]);
  const successorId = await insertLink(tx, grant, link.profile_id, link.external_employee_key, input.employeeId, from, link.effective_to, reason);
  await audit(tx, grant, id, 'SUPERSEDE', { effectiveTo: link.effective_to?.toISOString() ?? null }, { effectiveTo: from.toISOString(), supersededBy: successorId }, reason, { priorVersion: link.version, newVersion: link.version + 1 });
  return { id: successorId, supersededId: id };
}

/** One profile's links by identity, latest first: one page (FR-056), or the first 500 without page/pageSize; `total` counts all. */
export async function listLinks(db: Queryable, grant: AccessGrant, profileId: string, q: { current?: boolean | undefined; search?: string | undefined } & Paging) {
  const profile = await db.query(`select 1 from biometric_profile where company_id = $1 and id = $2`, [grant.companyId, profileId]);
  if (!profile.rowCount) throw notFound();
  const search = q.search?.trim() ? `%${q.search.trim().replace(/[\\%_]/g, '\\$&')}%` : null;
  return pageOf(
    db,
    `select l.id, l.external_employee_key as "externalEmployeeKey", l.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",
            l.effective_from as "effectiveFrom", l.effective_to as "effectiveTo", (l.effective_from <= now() and (l.effective_to is null or l.effective_to > now())) as current, l.version
       from biometric_employee_link l join employee e on e.company_id = l.company_id and e.id = l.employee_id
      where l.company_id = $1 and l.profile_id = $2
        and ($3::boolean is null or $3 = (l.effective_from <= now() and (l.effective_to is null or l.effective_to > now())))
        and ($4::text is null or l.external_employee_key ilike $4 or e.employee_code ilike $4 or e.display_name ilike $4)`,
    [grant.companyId, profileId, q.current ?? null, search],
    '"externalEmployeeKey", "effectiveFrom" desc, id',
    q,
    LINK_LIST_CAP,
  );
}
