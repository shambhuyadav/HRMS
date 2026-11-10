// First run of a production database (owner-authorised deployment, 9 Nov 2026; ADR-06): one company, provisioned with the baseline
// (roles, permissions, reference values, workflows, templates, the inactive statutory and tax packs: access/provision.ts), and its first
// two people: a System Administrator and an HR Administrator. Two, because a role grant and many decisions need an independent second
// person (BR-007); everyone else is invited through access administration by them. Their accounts are their sign-in emails at the
// provider (auth/oidc.ts links the provider identity on their first sign-in). Each grant is written by the system account and recorded
// as approved by the other administrator, with the purpose saying so. Re-running changes nothing that exists: it brings the company up
// to the current baseline and adds only a missing account or role.
// One transaction on a connection of its own (the command line's, db/bootstrap-production.ts): all of it or nothing, and the grant
// bootstrap setting (withGrantBootstrap) is transaction-local, so outside a transaction it would end with its own statement.
import type pg from 'pg';
import { SYSTEM_ACTOR_ID } from '../audit/actors.js';
import type { Queryable } from '../db/queryable.js';
import { BASELINE_ROLES, parsePermissionKey } from '../modules/access/baseline.js';
import { provisionCompany, withGrantBootstrap } from '../modules/access/provision.js';

export interface BootstrapOptions {
  companyCode: string;
  companyName: string;
  /** Sign-in email of the first System Administrator. */
  adminEmail: string;
  /** Sign-in email of the first HR Administrator (another person). */
  hrEmail: string;
  /** The day the grants and the baseline policies start (YYYY-MM-DD). */
  effectiveFrom: string;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface BootstrapResult {
  companyId: string;
  companyCreated: boolean;
  granted: string[];
}

/** Runs the bootstrap in one transaction of this connection, which must not be in a transaction already. */
export async function bootstrapCompany(connection: pg.ClientBase, o: BootstrapOptions): Promise<BootstrapResult> {
  await connection.query('begin');
  try {
    const result = await bootstrapInTransaction(connection, o);
    await connection.query('commit');
    return result;
  } catch (err) {
    await connection.query('rollback');
    throw err;
  }
}

async function bootstrapInTransaction(db: Queryable, o: BootstrapOptions): Promise<BootstrapResult> {
  const code = o.companyCode.trim().toUpperCase();
  const name = o.companyName.trim();
  const admin = o.adminEmail.trim().toLowerCase();
  const hr = o.hrEmail.trim().toLowerCase();
  if (!/^[A-Z][A-Z0-9_-]{1,19}$/.test(code)) throw new Error('The company code is 2 to 20 letters, digits, - or _, starting with a letter');
  if (!name) throw new Error('The company name is required');
  if (!EMAIL.test(admin) || !EMAIL.test(hr)) throw new Error('Both administrators need a sign-in email');
  if (admin === hr) throw new Error('The System Administrator and the HR Administrator are two different people (BR-007)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.effectiveFrom)) throw new Error('effectiveFrom is a date (YYYY-MM-DD)');

  const account = async (key: string) => {
    const created = await db.query<{ id: string }>(`insert into user_account (account_key, active, created_by) values ($1, true, $2) on conflict (account_key) do nothing returning id`, [
      key,
      SYSTEM_ACTOR_ID,
    ]);
    return created.rows[0]?.id ?? (await db.query<{ id: string }>(`select id from user_account where account_key = $1`, [key])).rows[0]!.id;
  };
  const existing = (await db.query<{ id: string }>(`select id from company where code = $1`, [code])).rows[0];
  const companyId =
    existing?.id ??
    (await db.query<{ id: string }>(`insert into company (code, name, active, created_by) values ($1, $2, true, $3) returning id`, [code, name, SYSTEM_ACTOR_ID])).rows[0]!.id;
  await provisionCompany(db, { companyId, approvedBy: SYSTEM_ACTOR_ID, effectiveFrom: o.effectiveFrom });

  const granted: string[] = [];
  // A grant is approved by a person other than its writer (0146: never the system account): each of the two first administrators,
  // both named by the owner at deployment, is recorded as approving the other's grant.
  const assign = async (userId: string, roleCode: string, approvedBy: string) => {
    const role = BASELINE_ROLES.find((r) => r.code === roleCode)!;
    const held = await db.query(
      `select 1 from role_assignment ra join role r on r.id = ra.role_id where ra.company_id = $1 and ra.user_id = $2 and r.code = $3 and ra.state = 'ACTIVE'`,
      [companyId, userId, roleCode],
    );
    if (held.rowCount) return;
    await withGrantBootstrap(db, async () => {
      const assignment = (
        await db.query<{ id: string }>(
          `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, approved_by, approved_at, purpose, created_by)
           select $1, $2, r.id, $4, $5::date, 'ACTIVE', $7, now(), 'Production bootstrap: the first two administrators, named by the owner at deployment; each grant approved by the other', $6
             from role r where r.company_id = $1 and r.code = $3 returning id`,
          [companyId, userId, roleCode, role.defaultScope, o.effectiveFrom, SYSTEM_ACTOR_ID, approvedBy],
        )
      ).rows[0]!.id;
      for (const key of role.defaultDuties) {
        const { resource, action, fieldGroup } = parsePermissionKey(key);
        await db.query(
          `insert into role_assignment_permission (company_id, role_assignment_id, permission_id, active, effective_from)
           select $1, $2, p.id, true, $6::date from permission p where p.resource = $3 and p.action = $4 and p.field_group = $5`,
          [companyId, assignment, resource, action, fieldGroup, o.effectiveFrom],
        );
      }
    });
    granted.push(roleCode);
  };
  const adminId = await account(admin);
  const hrId = await account(hr);
  await assign(adminId, 'SYSTEM_ADMINISTRATOR', hrId);
  await assign(hrId, 'HR_ADMINISTRATOR', adminId);
  return { companyId, companyCreated: !existing, granted };
}
