// Company maintenance of reference values (FR-004 "configurable entities"; DF04; DB006; BR-004; 0105). Create, relabel,
// deactivate or end-date, audited; never delete, and a value keeps its category and code, so records that point at it keep
// their meaning. Default deny: only the lists named here can be changed, because the code matches every other list by code
// (employee status, employment type, attendance outcome, the payroll lists). A code the application itself uses inside a
// maintainable list can be relabelled but stays in force.
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import type { AccessGrant } from '../access/authorize.js';
import { isModuleActive } from '../registry.js';

interface MaintainableList {
  /** The module that uses the list, when not a core one; the list is maintained only while that module is active. */
  module?: string;
  /** Codes the application uses by name. */
  protectedCodes?: readonly string[];
}

const MAINTAINABLE_LISTS: Readonly<Record<string, MaintainableList>> = {
  DOCUMENT_TYPE: {},
  // The holiday route's default type (shift/routes.ts).
  HOLIDAY_TYPE: { protectedCodes: ['HOLIDAY'] },
  TRAINING_MODE: { module: 'training' },
  TRAINING_FEEDBACK_QUESTION: { module: 'training' },
  ASSET_CATEGORY: { module: 'assets' },
  EXIT_REASON: { module: 'lifecycle' },
  // Naming a vendor depends on this source (hiring/candidate.ts).
  CANDIDATE_SOURCE: { module: 'hiring', protectedCodes: ['VENDOR'] },
  CANDIDATE_DOCUMENT_TYPE: { module: 'hiring' },
  // An exit clearance process depends on this type (lifecycle/processes.ts).
  LIFECYCLE_PROCESS_TYPE: { module: 'lifecycle', protectedCodes: ['EXIT'] },
  LETTER_TYPE: { module: 'lifecycle' },
};

function maintainable(category: string): MaintainableList | null {
  const list = Object.hasOwn(MAINTAINABLE_LISTS, category) ? MAINTAINABLE_LISTS[category]! : null;
  return list && (!list.module || isModuleActive(list.module)) ? list : null;
}

const refuseProtectedList = () => new HttpError(422, 'REFERENCE_CATEGORY_PROTECTED', 'The application depends on this list, so it cannot be changed here');

// Reference lists are company-wide; changing them needs unrestricted company scope, as organisation masters do.
function assertCompanyWide(grant: AccessGrant): void {
  const { departments, locations, employees } = grant.filters;
  if (grant.scopeKind !== 'COMPANY' || departments.length + locations.length + employees.length > 0) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
}

function assertPeriod(validFrom: string | null, validTo: string | null): void {
  if (validFrom !== null && validTo !== null && validTo <= validFrom) throw new HttpError(422, 'INVALID_PERIOD', 'A value must end after it starts');
}

export interface ReferenceValueRow {
  id: string;
  category: string;
  code: string;
  label: string;
  active: boolean;
  validFrom: string | null;
  validTo: string | null;
  version: number;
}

const COLUMNS = `id, category, code, label, active, valid_from as "validFrom", valid_to as "validTo", version`;

/** Every list of the company, maintainable or not (a protected list is shown read-only). */
export async function listReferenceCategories(db: Queryable, grant: AccessGrant) {
  const rows = (await db.query<{ category: string }>(`select distinct category from reference_value where company_id = $1`, [grant.companyId])).rows.map((r) => r.category);
  const names = new Set([...rows, ...Object.keys(MAINTAINABLE_LISTS).filter((c) => maintainable(c))]);
  return {
    items: [...names].sort().map((category) => {
      const list = maintainable(category);
      return { category, maintainable: list !== null, protectedCodes: list?.protectedCodes ?? [] };
    }),
  };
}

export async function listReferenceValues(db: Queryable, grant: AccessGrant, q: { category: string; includeInactive: boolean; validOn?: string | undefined }) {
  const rows = await db.query<ReferenceValueRow>(
    `select ${COLUMNS} from reference_value
      where company_id = $1 and category = $2 and ($3 or active)
        and ($4::date is null or ((valid_from is null or valid_from <= $4::date) and (valid_to is null or valid_to > $4::date)))
      order by label, code`,
    [grant.companyId, q.category, q.includeInactive, q.validOn ?? null],
  );
  return { category: q.category, items: rows.rows };
}

export interface NewReferenceValue {
  category: string;
  code: string;
  label: string;
  validFrom?: string | undefined;
  validTo?: string | undefined;
}

export async function createReferenceValue(tx: Queryable, grant: AccessGrant, input: NewReferenceValue): Promise<ReferenceValueRow> {
  assertCompanyWide(grant);
  await reassertAccess(tx, grant, 'reference_value', 'manage', ['operational']);
  if (!maintainable(input.category)) throw refuseProtectedList();
  const validFrom = input.validFrom ?? null;
  const validTo = input.validTo ?? null;
  assertPeriod(validFrom, validTo);
  const code = input.code.trim().toUpperCase();
  const label = input.label.trim();
  // A repeated code is refused by the unique key (409 DUPLICATE), concurrent requests included.
  const created = (
    await tx.query<ReferenceValueRow>(
      `insert into reference_value (company_id, category, code, label, active, valid_from, valid_to, created_by, updated_by)
       values ($1, $2, $3, $4, true, $5, $6, $7, $7) returning ${COLUMNS}`,
      [grant.companyId, input.category, code, label, validFrom, validTo, grant.userId],
    )
  ).rows[0]!;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'reference_value',
    recordKey: created.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: created.version,
    after: { operational: { category: input.category, code, label, active: true, validFrom, validTo } },
  });
  return created;
}

export interface ReferenceValuePatch {
  expectedVersion: number;
  label?: string | undefined;
  active?: boolean | undefined;
  validFrom?: string | null | undefined;
  validTo?: string | null | undefined;
}

export async function updateReferenceValue(tx: Queryable, grant: AccessGrant, id: string, patch: ReferenceValuePatch): Promise<ReferenceValueRow> {
  assertCompanyWide(grant);
  const current = (await tx.query<ReferenceValueRow>(`select ${COLUMNS} from reference_value where company_id = $1 and id = $2 for no key update`, [grant.companyId, id])).rows[0];
  if (!current) throw notFound();
  await reassertAccess(tx, grant, 'reference_value', 'manage', ['operational']);
  const list = maintainable(current.category);
  if (!list) throw refuseProtectedList();
  if (current.version !== patch.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  const label = patch.label?.trim() ?? current.label;
  const active = patch.active ?? current.active;
  const validFrom = patch.validFrom === undefined ? current.validFrom : patch.validFrom;
  const validTo = patch.validTo === undefined ? current.validTo : patch.validTo;
  assertPeriod(validFrom, validTo);
  if (list.protectedCodes?.includes(current.code) && (!active || validFrom !== null || validTo !== null)) {
    throw new HttpError(422, 'REFERENCE_CODE_PROTECTED', 'The application depends on this value: it can be relabelled but stays in force');
  }
  // Nothing to change writes nothing: no new version and no audit record of a change that did not happen.
  if (label === current.label && active === current.active && validFrom === current.validFrom && validTo === current.validTo) return current;
  const updated = (
    await tx.query<ReferenceValueRow>(
      `update reference_value set label = $3, active = $4, valid_from = $5, valid_to = $6, updated_by = $7 where company_id = $1 and id = $2 returning ${COLUMNS}`,
      [grant.companyId, id, label, active, validFrom, validTo, grant.userId],
    )
  ).rows[0]!;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'reference_value',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: active === current.active ? 'UPDATE' : active ? 'REACTIVATE' : 'DEACTIVATE',
    priorVersion: current.version,
    newVersion: updated.version,
    before: { operational: { label: current.label, active: current.active, validFrom: current.validFrom, validTo: current.validTo } },
    after: { operational: { category: current.category, code: current.code, label, active, validFrom, validTo } },
  });
  return updated;
}
