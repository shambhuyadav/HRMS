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
import { writeAudit } from '../audit/audit.js';
import type { Queryable } from '../db/queryable.js';
import { OWN_ESS_ROLE_CODES } from '../modules/access/authorize.js';
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

// ---------------------------------------------------------------------------------------------------------
// One-time refresh of default duties (authorised by the owner on 11 Nov 2026). An approved grant's allowlist is fixed (0099), so a duty
// a later release adds to a role's defaults never reaches the grants approved before it; the normal path is a new grant, proposed and
// approved by someone who is neither its requester nor its beneficiary. A deployment with only its two first administrators has no
// such person. This adds, to every active grant of a baseline role in one company, the role's current default duties that the grant
// lacks and that a release added to the role after the grant was approved (security review, 11 Nov 2026: a duty that was already in
// the role then but not on the grant was left out on purpose, and is never added), through the same bootstrap path as the first grants
// (so each row is marked bootstrapped and an access review lists it), and
// audits each grant it widens with the owner's reason. It adds nothing else: no ceiling-only right, no confidential group (but the
// own-record groups an Employee OWN grant holds by default), nothing outside the role's ceiling, nothing to a grant that ends or a role
// that is not a baseline one. A dry run (apply: false) reports the same plan and writes nothing; a second run adds nothing.
// ---------------------------------------------------------------------------------------------------------

export interface DutyRefreshOptions {
  companyCode: string;
  apply: boolean;
  /** Recorded on each widened grant's audit entry. */
  reason: string;
}

export interface DutyRefreshPlan {
  assignmentId: string;
  accountKey: string;
  roleCode: string;
  add: string[];
  /** Default duties left out, each with why (confidential, outside the ceiling, not in the catalogue). */
  skipped: string[];
}

export interface DutyRefreshResult {
  companyId: string;
  applied: boolean;
  grants: DutyRefreshPlan[];
}

/** Runs the refresh in one transaction of this connection, which must not be in a transaction already. */
export async function refreshDefaultDuties(connection: pg.ClientBase, o: DutyRefreshOptions): Promise<DutyRefreshResult> {
  if (!o.reason.trim()) throw new Error('A reason is required');
  await connection.query('begin');
  try {
    const result = await refreshInTransaction(connection, o);
    await connection.query(o.apply ? 'commit' : 'rollback');
    return result;
  } catch (err) {
    await connection.query('rollback');
    throw err;
  }
}

async function refreshInTransaction(db: Queryable, o: DutyRefreshOptions): Promise<DutyRefreshResult> {
  const code = o.companyCode.trim().toUpperCase();
  const company = (await db.query<{ id: string }>(`select id from company where code = $1 and active`, [code])).rows[0];
  if (!company) throw new Error(`No active company ${code}`);
  const companyId = company.id;
  const grants = (
    await db.query<{ id: string; role_id: string; role_code: string; scope_kind: string; account_key: string; effective_to: string | null; approved_at: string }>(
      `select ra.id, ra.role_id, r.code as role_code, ra.scope_kind, ua.account_key, ra.effective_to, coalesce(ra.approved_at, ra.created_at) as approved_at
         from role_assignment ra
         join role r on r.company_id = ra.company_id and r.id = ra.role_id
         join user_account ua on ua.id = ra.user_id and ua.active
        where ra.company_id = $1 and ra.state = 'ACTIVE' and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now())
        order by ua.account_key, r.code
        for update of ra`,
      [companyId],
    )
  ).rows;

  const plans: DutyRefreshPlan[] = [];
  for (const g of grants) {
    const baseline = BASELINE_ROLES.find((r) => r.code === g.role_code);
    if (!baseline) continue;
    const add: { id: string; key: string }[] = [];
    const skipped: string[] = [];
    for (const key of baseline.defaultDuties) {
      const { resource, action, fieldGroup } = parsePermissionKey(key);
      const p = (
        await db.query<{ id: string; own_ess: boolean; allowed: boolean; released_later: boolean; classification: string; held: 'HELD' | 'ENDED' | null }>(
          `select p.id, p.own_ess,
                  exists (select 1 from role_permission rp where rp.company_id = $1 and rp.role_id = $2 and rp.permission_id = p.id and rp.effect = 'ALLOW') as allowed,
                  exists (select 1 from role_permission rp where rp.company_id = $1 and rp.role_id = $2 and rp.permission_id = p.id and rp.effect = 'ALLOW'
                                                             and rp.created_at > $7::timestamptz) as released_later,
                  coalesce((select cfp.classification from confidential_field_policy cfp
                             where cfp.company_id = $1 and cfp.resource_code = p.resource and cfp.field_group = p.field_group
                               and cfp.effective_from <= hrms_business_date($1, now())
                               and (cfp.effective_to is null or cfp.effective_to > hrms_business_date($1, now()))), 'CONFIDENTIAL') as classification,
                  (select case when rap.active and (rap.effective_to is null or rap.effective_to > now()) then 'HELD' else 'ENDED' end
                     from role_assignment_permission rap
                    where rap.company_id = $1 and rap.role_assignment_id = $3 and rap.permission_id = p.id) as held
             from permission p where p.resource = $4 and p.action = $5 and p.field_group = $6`,
          [companyId, g.role_id, g.id, resource, action, fieldGroup, g.approved_at],
        )
      ).rows[0];
      if (!p) {
        skipped.push(`${key}: not in the catalogue`);
        continue;
      }
      if (p.held === 'HELD') continue;
      // Switched off or ended on this grant by an administrator: that decision stands.
      if (p.held === 'ENDED') {
        skipped.push(`${key}: switched off on this grant, left as it is`);
        continue;
      }
      if (!p.allowed) {
        skipped.push(`${key}: outside the role ceiling`);
        continue;
      }
      // Only a duty a release added after this grant was approved: one already in the role's ceiling then, and not on the grant, was
      // left out by whoever proposed and approved it (a narrower list), and that decision stands.
      if (!p.released_later) {
        skipped.push(`${key}: in the role before this grant was approved and not given then, left as approved`);
        continue;
      }
      const ownRecord = OWN_ESS_ROLE_CODES.includes(g.role_code) && g.scope_kind === 'OWN' && p.own_ess;
      if (p.classification === 'CONFIDENTIAL' && !ownRecord) {
        skipped.push(`${key}: confidential, needs a grant of its own`);
        continue;
      }
      add.push({ id: p.id, key });
    }
    if (add.length === 0 && skipped.length === 0) continue;
    plans.push({ assignmentId: g.id, accountKey: g.account_key, roleCode: g.role_code, add: add.map((a) => a.key), skipped });
    if (add.length === 0) continue;
    await withGrantBootstrap(db, async () => {
      for (const a of add) {
        await db.query(
          `insert into role_assignment_permission (company_id, role_assignment_id, permission_id, active, effective_from, effective_to, created_by, updated_by)
           values ($1, $2, $3, true, now(), $4, $5, $5)`,
          [companyId, g.id, a.id, g.effective_to, SYSTEM_ACTOR_ID],
        );
      }
      // Touching the grant in this mode marks it bootstrapped for good (0099), so an access review lists it with the first grants.
      await db.query(`update role_assignment set updated_by = $3 where company_id = $1 and id = $2`, [companyId, g.id, SYSTEM_ACTOR_ID]);
    });
    await writeAudit(db, {
      companyId,
      resource: 'access_grant',
      recordKey: g.id,
      actorUserId: SYSTEM_ACTOR_ID,
      actingAssignmentId: null,
      action: 'BOOTSTRAP_DUTIES',
      after: { operational: { roleCode: g.role_code, added: add.map((x) => x.key) } },
      reason: o.reason.trim(),
    });
  }
  return { companyId, applied: o.apply, grants: plans };
}
