// Choices the lifecycle forms offer (DF04 "controlled active reference codes ... no free-text value silently creates a
// master"): the active reference values of the categories the forms use, and the roles a task may be owned by. Each
// list is served under the permission its form already needs, so a form offers exactly what the server accepts.
// Nothing here is confidential (codes and labels only).
import type { Queryable } from '../../db/queryable.js';
import type { AccessGrant } from '../access/authorize.js';
import { COMPLETE_TASK } from './templates.js';

/** Reference categories the lifecycle forms use, each with the permission (operational group) of its form. */
export const LIFECYCLE_REFERENCE_CATEGORIES: Readonly<Record<string, { resource: string; action: string }>> = {
  // FR-015 process template form.
  LIFECYCLE_PROCESS_TYPE: { resource: 'lifecycle_process', action: 'read' },
  // FR-017 letter template form.
  LETTER_TYPE: { resource: 'letter_template', action: 'read' },
  // FR-051 resignation form (the company configures its exit reasons; none is seeded).
  EXIT_REASON: { resource: 'exit', action: 'submit' },
};

export async function listLifecycleReferenceValues(db: Queryable, grant: AccessGrant, category: string) {
  const rows = await db.query<{ code: string; label: string }>(
    `select code, label from reference_value_in_force where company_id = $1 and category = $2 order by label, code`,
    [grant.companyId, category],
  );
  return { category, items: rows.rows };
}

/** The active company roles a task may be owned by: exactly those validateOwner accepts (the completion duty allowed). */
export async function taskOwnerRoles(db: Queryable, grant: AccessGrant) {
  const rows = await db.query<{ code: string; name: string }>(
    `select r.code, r.name from role r
       join role_permission rp on rp.company_id = r.company_id and rp.role_id = r.id and rp.effect = 'ALLOW'
       join permission p on p.id = rp.permission_id and p.resource = $2 and p.action = $3 and p.field_group = $4
      where r.company_id = $1 and r.active
      group by r.code, r.name order by r.name, r.code`,
    [grant.companyId, COMPLETE_TASK.resource, COMPLETE_TASK.action, COMPLETE_TASK.fieldGroup],
  );
  return { items: rows.rows };
}
