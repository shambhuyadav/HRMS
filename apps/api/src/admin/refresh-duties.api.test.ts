// One-time refresh of default duties (admin/bootstrap.ts refreshDefaultDuties; authorised by the owner on 11 Nov 2026): a grant approved
// before a release added a duty to its role's defaults gets that duty, through the bootstrap path, marked and audited; a dry run writes
// nothing; a duty switched off on a grant stays off; nothing confidential or outside the ceiling is added; a second run adds nothing.
// Synthetic data only.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../test/harness.js';
import { BASELINE_ROLES } from '../modules/access/baseline.js';
import { refreshDefaultDuties } from './bootstrap.js';

let h: Harness;
let A: Company;
let code: string;
let own: pg.PoolClient;
let hr: TestActor;
let employee: TestActor;
const reason = 'Synthetic: refresh after a release';
const MISSING = ['announcement.manage.operational', 'announcement.read.operational'];
const HR_DEFAULTS = BASELINE_ROLES.find((r) => r.code === 'HR_ADMINISTRATOR')!.defaultDuties;

const held = async (a: TestActor) =>
  (
    await h.db.query<{ key: string; active: boolean }>(
      `select p.resource || '.' || p.action || '.' || p.field_group as key, rap.active
         from role_assignment_permission rap join permission p on p.id = rap.permission_id
        where rap.company_id = $1 and rap.role_assignment_id = $2`,
      [A.id, a.assignment],
    )
  ).rows;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  code = (await h.one<{ code: string }>(`select code from company where id = $1`, [A.id])).code;
  // Grants approved "before the release": their allowlists lack the new duties. The HR grant goes the normal way (proposed by one
  // administrator, approved by another), so it is not bootstrapped until the refresh touches it.
  const sa1 = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  const sa2 = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  const hrUser = await h.makeUser();
  const proposed = await h.call(sa1, 'POST', '/v1/access/assignments', {
    userId: hrUser,
    roleCode: 'HR_ADMINISTRATOR',
    effectiveFrom: '2026-01-01T00:00:00Z',
    permissions: HR_DEFAULTS.filter((k) => !MISSING.includes(k)),
  });
  expect(proposed.statusCode, proposed.body).toBe(201);
  const grantId = proposed.json().id as string;
  const version = (await h.one<{ version: number }>(`select version from role_assignment where id = $1`, [grantId])).version;
  const approved = await h.call(sa2, 'POST', `/v1/access/assignments/${grantId}/approve`, { expectedVersion: version });
  expect(approved.statusCode, approved.body).toBe(200);
  hr = { user: hrUser, assignment: grantId, company: A, token: await h.tokenFor(hrUser) };
  expect((await h.one<{ bootstrapped: boolean }>(`select bootstrapped from role_assignment where id = $1`, [grantId])).bootstrapped).toBe(false);
  const emp = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A));
  expect(emp.statusCode, emp.body).toBe(201);
  await h.setStatus(A, emp.json().id, 'ACTIVE_CONFIRMED');
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: emp.json().id, duties: BASELINE_ROLES.find((r) => r.code === 'EMPLOYEE')!.defaultDuties.filter((k) => !MISSING.includes(k)) });
  // "A later release": the events and messages rights reach the roles after these grants were approved (in the test company every
  // right exists from provisioning, so their ceiling rows are dated after the approvals, as a release's migration would add them).
  // (Creation metadata is immutable; it is moved with the triggers off, as a clock would.)
  await h.db.query(`set session_replication_role = replica`);
  try {
    await h.db.query(
      `update role_permission set created_at = clock_timestamp() where company_id = $1 and permission_id in (select id from permission where resource = 'announcement')`,
      [A.id],
    );
  } finally {
    await h.db.query(`set session_replication_role = origin`);
  }
  // As on the server: a connection of its own, not the harness's fixture session.
  own = await h.pool.connect();
}, 300_000);

afterAll(async () => {
  own?.release();
  await h?.stop();
});

describe('one-time refresh of default duties', () => {
  it('a dry run reports the plan and writes nothing', async () => {
    expect((await h.call(hr, 'GET', '/v1/company-events')).statusCode).toBe(403);
    const before = (await h.one<{ n: number }>(`select count(*)::int as n from role_assignment_permission where company_id = $1`, [A.id])).n;
    const plan = await refreshDefaultDuties(own, { companyCode: code, apply: false, reason });
    expect(plan.applied).toBe(false);
    expect(plan.grants.find((g) => g.assignmentId === hr.assignment)!.add.sort()).toEqual([...MISSING].sort());
    expect(plan.grants.find((g) => g.assignmentId === employee.assignment)!.add).toEqual(['announcement.read.operational']);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from role_assignment_permission where company_id = $1`, [A.id])).n).toBe(before);
    expect((await h.call(hr, 'GET', '/v1/company-events')).statusCode).toBe(403);
  });

  it('applies the role defaults a grant lacks, marks the grant bootstrapped and audits it; a second run adds nothing', async () => {
    const result = await refreshDefaultDuties(own, { companyCode: code, apply: true, reason });
    expect(result.applied).toBe(true);
    expect((await h.call(hr, 'GET', '/v1/company-events')).statusCode).toBe(200);
    expect((await h.call(employee, 'GET', '/v1/announcements/feed')).statusCode).toBe(200);
    // Still not HR's to manage for an employee: only the role's own defaults were added.
    expect((await h.call(employee, 'GET', '/v1/company-events')).statusCode).toBe(403);
    expect((await held(employee)).some((r) => r.key === 'announcement.manage.operational')).toBe(false);
    const grant = await h.one<{ bootstrapped: boolean }>(`select bootstrapped from role_assignment where company_id = $1 and id = $2`, [A.id, hr.assignment]);
    expect(grant.bootstrapped).toBe(true);
    const audit = await h.one<{ action: string; reason: string; after_values: { operational: { added: string[] } } }>(
      `select action, reason, after_values from audit_event where company_id = $1 and record_key = $2 and action = 'BOOTSTRAP_DUTIES'`,
      [A.id, hr.assignment],
    );
    expect(audit.reason).toBe(reason);
    expect(audit.after_values.operational.added.sort()).toEqual([...MISSING].sort());

    const again = await refreshDefaultDuties(own, { companyCode: code, apply: true, reason });
    expect(again.grants.every((g) => g.add.length === 0)).toBe(true);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from audit_event where company_id = $1 and action = 'BOOTSTRAP_DUTIES'`, [A.id])).n).toBe(2);
  });

  it('leaves a duty switched off on a grant off, and never adds a confidential or ceiling-only right', async () => {
    const other = await h.actor(A, 'HR_ADMINISTRATOR', { duties: HR_DEFAULTS });
    // An administrator switched one default duty off on this grant.
    await h.db.query(
      `update role_assignment_permission set active = false
        where company_id = $1 and role_assignment_id = $2 and permission_id = (select id from permission where resource = 'announcement' and action = 'manage' and field_group = 'operational')`,
      [A.id, other.assignment],
    );
    const result = await refreshDefaultDuties(own, { companyCode: code, apply: true, reason });
    const plan = result.grants.find((g) => g.assignmentId === other.assignment)!;
    expect(plan.add).toEqual([]);
    expect(plan.skipped).toContain('announcement.manage.operational: switched off on this grant, left as it is');
    expect((await held(other)).find((r) => r.key === 'announcement.manage.operational')!.active).toBe(false);
    // Ceiling-only rights of the role (confidential groups) are never among what was added to anyone.
    const added = (await h.db.query<{ after_values: { operational: { added: string[] } } }>(`select after_values from audit_event where company_id = $1 and action = 'BOOTSTRAP_DUTIES'`, [A.id])).rows.flatMap(
      (r) => r.after_values.operational.added,
    );
    const hrRole = BASELINE_ROLES.find((r) => r.code === 'HR_ADMINISTRATOR')!;
    const ceilingOnly = (hrRole.ceiling ?? []).filter((k) => !hrRole.defaultDuties.includes(k));
    expect(ceilingOnly.length).toBeGreaterThan(0);
    for (const key of ceilingOnly) expect(added).not.toContain(key);
  });

  it('never adds a duty that was already in the role when the grant was approved and left off it on purpose', async () => {
    // Approved with a narrower list: a default duty the role already had is left out, and no release has added it since.
    const narrow = HR_DEFAULTS.filter((k) => k !== 'company_policy.manage.operational');
    const narrowGrant = await h.actor(A, 'HR_ADMINISTRATOR', { duties: narrow });
    const result = await refreshDefaultDuties(own, { companyCode: code, apply: true, reason });
    const plan = result.grants.find((g) => g.assignmentId === narrowGrant.assignment)!;
    expect(plan.add).not.toContain('company_policy.manage.operational');
    expect(plan.skipped).toContain('company_policy.manage.operational: in the role before this grant was approved and not given then, left as approved');
    expect((await held(narrowGrant)).some((r) => r.key === 'company_policy.manage.operational')).toBe(false);
  });

  it('refuses an unknown company and a blank reason, writing nothing', async () => {
    await expect(refreshDefaultDuties(own, { companyCode: 'NO_SUCH_CO', apply: true, reason })).rejects.toThrow('No active company');
    await expect(refreshDefaultDuties(own, { companyCode: code, apply: true, reason: '  ' })).rejects.toThrow('reason');
  });
});
