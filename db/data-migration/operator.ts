// The operator a load runs as (named on the command line by their sign-in account): every stage acts under one of the operator's
// own active role assignments in the target company, resolved exactly as the matching upload route resolves the request's selected
// assignment (resolveAccess, every field group required), so a load can do nothing the operator could not do on the screen.
import type { Queryable } from '../../apps/api/src/db/queryable.js';
import { type AccessGrant, resolveAccess } from '../../apps/api/src/modules/access/authorize.js';

export interface Operator {
  companyId: string;
  companyCode: string;
  userId: string;
  accountKey: string;
  /** Active assignments in the company, oldest first (the first that allows a stage is used). */
  assignments: { id: string; roleCode: string }[];
}

export interface Need {
  resource: string;
  action: string;
  groups: string[];
}

/**
 * The grants each stage's own route requires, in the route's order (the last one is the grant rows apply under):
 * org/routes.ts POST /org/:kind; employee/imports.ts and update-import.ts importGrants; shift/plan-import.ts grants;
 * employee/routes.ts POST /employees/:id/activate; increment/salary-master.ts manage; leave/opening-import.ts grants;
 * payroll-outputs/loan-import.ts enter.
 */
export const STAGE_NEEDS = {
  masters: [{ resource: 'org_master', action: 'create', groups: ['operational'] }],
  employees: [
    { resource: 'employee', action: 'import', groups: ['operational'] },
    { resource: 'employee', action: 'create', groups: ['operational'] },
  ],
  employeeUpdates: [
    { resource: 'employee', action: 'import', groups: ['operational'] },
    { resource: 'employee', action: 'update', groups: ['operational'] },
  ],
  shifts: [
    { resource: 'shift', action: 'import', groups: ['operational'] },
    { resource: 'shift', action: 'assign', groups: ['operational'] },
  ],
  activation: [{ resource: 'employee', action: 'activate', groups: ['operational'] }],
  salary: [{ resource: 'salary', action: 'manage', groups: ['salary'] }],
  leaveOpening: [
    { resource: 'leave', action: 'import', groups: ['operational'] },
    { resource: 'leave', action: 'adjust', groups: ['operational'] },
  ],
  loans: [{ resource: 'payroll_loan', action: 'request', groups: ['loan'] }],
} satisfies Record<string, Need[]>;

export type StageNeed = keyof typeof STAGE_NEEDS;

export class OperatorError extends Error {}

export async function resolveOperator(db: Queryable, companyCode: string, accountKey: string): Promise<Operator> {
  const company = (await db.query<{ id: string; code: string }>(`select id, code from company where code = $1 and active`, [companyCode.trim().toUpperCase()])).rows[0];
  if (!company) throw new OperatorError(`No active company ${companyCode}`);
  const key = accountKey.trim().toLowerCase();
  const user = (await db.query<{ id: string }>(`select id from user_account where account_key = $1 and active`, [key])).rows[0];
  if (!user) throw new OperatorError(`No active account ${key}`);
  const assignments = (
    await db.query<{ id: string; role_code: string }>(
      `select ra.id, r.code as role_code from role_assignment ra join role r on r.company_id = ra.company_id and r.id = ra.role_id
        where ra.company_id = $1 and ra.user_id = $2 and ra.state = 'ACTIVE' order by ra.created_at, ra.id`,
      [company.id, user.id],
    )
  ).rows.map((a) => ({ id: a.id, roleCode: a.role_code }));
  if (assignments.length === 0) throw new OperatorError(`${key} holds no active role assignment in ${company.code}`);
  return { companyId: company.id, companyCode: company.code, userId: user.id, accountKey: key, assignments };
}

/** The grant of the first of the operator's assignments that allows every need with every field group (as requireAccess requireAll). */
export async function grantFor(db: Queryable, op: Operator, needs: readonly Need[]): Promise<AccessGrant> {
  for (const a of op.assignments) {
    let last: AccessGrant | null = null;
    for (const n of needs) {
      const d = await resolveAccess(db, { userId: op.userId, companyId: op.companyId, assignmentId: a.id, resource: n.resource, action: n.action, fieldGroups: n.groups });
      if (!d.allowed || d.deniedFieldGroups.length > 0 || n.groups.some((g) => !d.allowedFieldGroups.includes(g))) {
        last = null;
        break;
      }
      last = d;
    }
    if (last) return last;
  }
  throw new OperatorError(`${op.accountKey} holds no active role assignment in ${op.companyCode} allowing ${needs.map((n) => `${n.resource}.${n.action}.${n.groups.join('+')}`).join(' and ')}`);
}
