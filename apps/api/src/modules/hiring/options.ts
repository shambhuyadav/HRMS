// Choices the hiring forms offer (FR-011, FR-013, FR-014; DF04 "controlled active reference codes ... No free-text
// value silently creates a master"): the active reference values of the categories the hiring forms use, and the
// masters a requisition may name. Each list is served under the permission its form already needs, so a form can
// offer exactly what the server will accept; nothing here is confidential.
import type { Queryable } from '../../db/queryable.js';
import type { AccessGrant } from '../access/authorize.js';
import type { StepPermission } from './scope.js';

/** Reference categories the hiring forms use, each with the permission of the form that uses it. */
export const HIRING_REFERENCE_CATEGORIES: Readonly<Record<string, StepPermission>> = {
  // FR-011 requisition form (DF04 employment types).
  EMPLOYMENT_TYPE: { resource: 'requisition', action: 'create', fieldGroup: 'operational' },
  // FR-013 candidate register form (source/vendor).
  CANDIDATE_SOURCE: { resource: 'candidate', action: 'manage', fieldGroup: 'operational' },
  // FR-013 CV and other candidate document upload.
  CANDIDATE_DOCUMENT_TYPE: { resource: 'candidate', action: 'upload', fieldGroup: 'document' },
  // FR-014 handover: the employee document type each transferred document takes.
  DOCUMENT_TYPE: { resource: 'hiring', action: 'handover', fieldGroup: 'operational' },
};

export async function listReferenceValues(db: Queryable, grant: AccessGrant, category: string) {
  const rows = await db.query<{ code: string; label: string }>(
    `select code, label from reference_value_in_force where company_id = $1 and category = $2 order by label, code`,
    [grant.companyId, category],
  );
  return { category, items: rows.rows };
}

/**
 * The active departments, locations and designations a requisition may name in the selected assignment: its
 * department and location filters apply exactly as they do when the requisition is created (admitsRequisition).
 */
export async function requisitionMasters(db: Queryable, grant: AccessGrant) {
  const list = async (table: 'department' | 'location' | 'designation', only: readonly string[]) =>
    (
      await db.query<{ id: string; code: string; name: string }>(
        `select id, code, name from ${table} where company_id = $1 and active and ($2::uuid[] is null or id = any($2::uuid[])) order by name, code`,
        [grant.companyId, only.length > 0 ? only : null],
      )
    ).rows;
  return {
    departments: await list('department', grant.filters.departments),
    locations: await list('location', grant.filters.locations),
    designations: await list('designation', []),
  };
}
