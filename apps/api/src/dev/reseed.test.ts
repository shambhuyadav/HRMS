// Re-seeding an existing development company and re-running provisioning (data-8, data-9 / brd-8).
//   * A provisioning re-run changes no row when nothing differs (no version churn for expectedVersion holders).
//   * A re-seed brings a database seeded by an older baseline, or left behind by an interrupted run, up to date:
//     the seeded accounts get the default duties added since, and missing workflow steps are restored.
//   * A re-seed never grants a confidential field group, and runs in one transaction.
// Older databases are recreated by removing rows the application itself never deletes. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASELINE_ROLES, OPERATIONAL_FIELD_GROUPS, type PermissionKey, parsePermissionKey } from '../modules/access/baseline.js';
import { provisionCompany } from '../modules/access/provision.js';
import { type Harness, startHarness } from '../test/harness.js';
import { DEV_ACCOUNTS, seedDevCompany } from './seed.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

const OPERATIONAL = new Set(OPERATIONAL_FIELD_GROUPS.map((g) => `${g.resource}.${g.fieldGroup}`));
const isOperational = (key: PermissionKey) => {
  const { resource, fieldGroup } = parsePermissionKey(key);
  return OPERATIONAL.has(`${resource}.${fieldGroup}`);
};
const defaultDuties = (roleCode: string) => BASELINE_ROLES.find((r) => r.code === roleCode)!.defaultDuties;

/** The assignments the development seed creates (account, role). */
const SEEDED_ASSIGNMENTS: [string, string][] = [
  [DEV_ACCOUNTS.hr, 'HR_ADMINISTRATOR'],
  [DEV_ACCOUNTS.sysadmin, 'SYSTEM_ADMINISTRATOR'],
  [DEV_ACCOUNTS.manager, 'REPORTING_MANAGER'],
  [DEV_ACCOUNTS.manager, 'EMPLOYEE'],
  [DEV_ACCOUNTS.employee, 'EMPLOYEE'],
  [DEV_ACCOUNTS.finance, 'HR_ADMINISTRATOR'],
  [DEV_ACCOUNTS.payroll, 'HR_ADMINISTRATOR'],
];

// Default duties that a database seeded before these features existed does not hold (the finding's examples).
const EMPLOYEE_ADDED_LATER: PermissionKey[] = [
  'leave.cancel.operational',
  'work_request.submit.operational',
  'work_request.read.operational',
  'work_request.withdraw.operational',
  'profile_change.submit.operational',
  'profile_change.read.operational',
  'attendance.request_correction.operational',
  'mobile_link.request.operational',
  'mobile_link.read.operational',
];
const HR_ADDED_LATER: PermissionKey[] = [
  'employee.import.operational',
  'work_request.read.operational',
  'shift.import.operational',
  'mobile_link.request.operational',
  'mobile_link.read.operational',
  'mobile_link.approve.operational',
  'attendance.approve_correction.operational',
];

/** Active, effective allowlist keys of an account's assignment for a role. */
async function duties(companyId: string, account: string, roleCode: string): Promise<string[]> {
  return (
    await h.db.query<{ key: string }>(
      `select p.resource || '.' || p.action || '.' || p.field_group as key
         from role_assignment ra
         join role r on r.company_id = ra.company_id and r.id = ra.role_id and r.code = $3
         join user_account u on u.id = ra.user_id and u.account_key = $2
         join role_assignment_permission rap on rap.company_id = ra.company_id and rap.role_assignment_id = ra.id and rap.active
              and rap.effective_from <= now() and (rap.effective_to is null or rap.effective_to > now())
         join permission p on p.id = rap.permission_id
        where ra.company_id = $1 and ra.state = 'ACTIVE'
        order by 1`,
      [companyId, account, roleCode],
    )
  ).rows.map((r) => r.key);
}

/** Every allowlist row of the company for a confidential group (active or not), as "account role key". */
async function confidentialAllowlist(companyId: string): Promise<string[]> {
  const rows = (
    await h.db.query<{ account: string; role: string; resource: string; action: string; field_group: string; active: boolean }>(
      `select u.account_key as account, r.code as role, p.resource, p.action, p.field_group, rap.active
         from role_assignment_permission rap
         join role_assignment ra on ra.company_id = rap.company_id and ra.id = rap.role_assignment_id
         join role r on r.company_id = ra.company_id and r.id = ra.role_id
         join user_account u on u.id = ra.user_id
         join permission p on p.id = rap.permission_id
        where rap.company_id = $1`,
      [companyId],
    )
  ).rows;
  return rows
    .filter((r) => !OPERATIONAL.has(`${r.resource}.${r.field_group}`))
    .map((r) => `${r.account} ${r.role} ${r.resource}.${r.action}.${r.field_group} ${r.active ? 'active' : 'inactive'}`)
    .sort();
}

/** Recreates an assignment that never received `keys` (the application never deletes allowlist rows). */
async function removeDuties(companyId: string, account: string, roleCode: string, keys: PermissionKey[]): Promise<void> {
  await h.db.query('begin');
  try {
    await h.db.query('alter table role_assignment_permission disable trigger role_assignment_permission_no_delete');
    const deleted = await h.db.query(
      `delete from role_assignment_permission rap
        using role_assignment ra, role r, user_account u, permission p
        where rap.company_id = $1 and ra.company_id = rap.company_id and ra.id = rap.role_assignment_id
          and r.company_id = ra.company_id and r.id = ra.role_id and r.code = $3
          and u.id = ra.user_id and u.account_key = $2
          and p.id = rap.permission_id and p.resource || '.' || p.action || '.' || p.field_group = any($4::text[])`,
      [companyId, account, roleCode, keys],
    );
    await h.db.query('alter table role_assignment_permission enable trigger role_assignment_permission_no_delete');
    await h.db.query('commit');
    expect(deleted.rowCount).toBe(keys.length);
  } catch (err) {
    await h.db.query('rollback');
    throw err;
  }
}

/** Every workflow step of the company's routes. */
async function routes(companyId: string) {
  return (
    await h.db.query(
      `select w.kind, w.revision, s.sequence, p.resource || '.' || p.action || '.' || p.field_group as permission,
              s.selection_rule, s.completion_rule, s.condition_code
         from workflow_definition w
         join workflow_step s on s.company_id = w.company_id and s.workflow_id = w.id
         join permission p on p.id = s.permission_id
        where w.company_id = $1
        order by w.kind, w.revision, s.sequence`,
      [companyId],
    )
  ).rows;
}

/** Kinds whose active route has no unconditional first step: the engine answers WORKFLOW_NOT_CONFIGURED. */
async function unconfiguredKinds(companyId: string): Promise<string[]> {
  return (
    await h.db.query<{ kind: string }>(
      `select w.kind from workflow_definition w
        where w.company_id = $1 and w.active
          and w.effective_from <= now() and (w.effective_to is null or w.effective_to > now())
          and not exists (select 1 from workflow_step s where s.company_id = w.company_id and s.workflow_id = w.id and s.condition_code is null)
        order by 1`,
      [companyId],
    )
  ).rows.map((r) => r.kind);
}

async function deleteSteps(companyId: string, where: string): Promise<void> {
  await h.db.query(
    `delete from workflow_step s using workflow_definition w
      where s.company_id = $1 and w.company_id = s.company_id and w.id = s.workflow_id and (${where})`,
    [companyId],
  );
}

/**
 * Full contents of every row the company owns (one hash per table), plus the company row and the seed's
 * global accounts: any insert, update (version/updated_at) or delete changes the result.
 */
async function fingerprint(companyId: string): Promise<Record<string, string>> {
  const tables = (
    await h.db.query<{ table_name: string }>(
      `select c.table_name from information_schema.columns c
         join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
        where c.table_schema = 'public' and c.column_name = 'company_id'
        order by 1`,
    )
  ).rows.map((r) => r.table_name);
  const result: Record<string, string> = {};
  for (const table of tables) {
    result[table] = (
      await h.one<{ f: string }>(
        `select md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) as f from ${table} x where x.company_id = $1`,
        [companyId],
      )
    ).f;
  }
  result['company (row)'] = (await h.one<{ f: string }>(`select md5(to_jsonb(c)::text) as f from company c where c.id = $1`, [companyId])).f;
  result['user_account (seed accounts)'] = (
    await h.one<{ f: string }>(
      `select md5(string_agg(to_jsonb(u)::text, '|' order by u.account_key)) as f from user_account u where u.account_key = any($1::text[])`,
      [[...Object.values(DEV_ACCOUNTS), 'seed.approver@demo.test']],
    )
  ).f;
  return result;
}

/** Makes every insert into `table` fail, as an interruption at that point of a run would; returns the undo. */
async function interruptInsertsInto(table: string): Promise<() => Promise<void>> {
  await h.db.query(
    `create or replace function test_simulated_interruption() returns trigger language plpgsql as $$
     begin raise exception 'simulated interruption'; end $$`,
  );
  await h.db.query(`create trigger test_simulated_interruption before insert on ${table} for each row execute function test_simulated_interruption()`);
  return async () => {
    await h.db.query(`drop trigger test_simulated_interruption on ${table}`);
  };
}

describe('data-8: re-running provisioning on an existing company', () => {
  const approverOf = async (companyId: string) =>
    (await h.one<{ created_by: string }>(`select created_by from role where company_id = $1 and code = 'EMPLOYEE'`, [companyId])).created_by;

  it('writes no row when nothing differs (roles and expense categories keep their version)', async () => {
    const c = await h.makeCompany();
    const approvedBy = await approverOf(c.id);
    const before = await fingerprint(c.id);
    await provisionCompany(h.db, { companyId: c.id, approvedBy, effectiveFrom: '2026-01-01' });
    await provisionCompany(h.db, { companyId: c.id, approvedBy, effectiveFrom: '2026-01-01' });
    const versions = await h.db.query<{ t: string; v: number }>(
      `select 'role' as t, max(version) as v from role where company_id = $1
       union all select 'expense_category', max(version) from expense_category where company_id = $1`,
      [c.id],
    );
    expect(versions.rows).toEqual([
      { t: 'role', v: 1 },
      { t: 'expense_category', v: 1 },
    ]);
    expect(await fingerprint(c.id)).toEqual(before);
  });

  it('updates a baseline name that differs exactly once and leaves every other row alone', async () => {
    const c = await h.makeCompany();
    const approvedBy = await approverOf(c.id);
    await h.db.query(`update role set name = 'Outdated name' where company_id = $1 and code = 'AUDITOR'`, [c.id]);
    await h.db.query(`update expense_category set name = 'Outdated name' where company_id = $1 and code = 'MEALS'`, [c.id]);
    const state = async () =>
      (
        await h.db.query<{ code: string; name: string; version: number }>(
          `select 'role:' || code as code, name, version from role where company_id = $1
           union all select 'expense_category:' || code, name, version from expense_category where company_id = $1
           order by 1`,
          [c.id],
        )
      ).rows;

    await provisionCompany(h.db, { companyId: c.id, approvedBy, effectiveFrom: '2026-01-01' });
    const once = await state();
    expect(once.find((r) => r.code === 'role:AUDITOR')).toEqual({ code: 'role:AUDITOR', name: 'Auditor', version: 3 });
    expect(once.find((r) => r.code === 'expense_category:MEALS')).toEqual({ code: 'expense_category:MEALS', name: 'Meals', version: 3 });
    expect(once.filter((r) => r.code !== 'role:AUDITOR' && r.code !== 'expense_category:MEALS').every((r) => r.version === 1)).toBe(true);

    await provisionCompany(h.db, { companyId: c.id, approvedBy, effectiveFrom: '2026-01-01' });
    expect(await state()).toEqual(once);
  });
});

describe('data-9 / brd-8: re-seeding a database seeded by an older baseline', () => {
  let companyId: string;
  let completeRoutes: unknown[];
  let confidentialBefore: string[];
  // Confidential default duties (the Employee OWN ESS groups today) that an older database lacked.
  const employeeConfidential = defaultDuties('EMPLOYEE').filter((k) => !isOperational(k));

  beforeAll(async () => {
    ({ companyId } = await seedDevCompany(h.db, 'OLDER'));
    completeRoutes = await routes(companyId);
    expect(completeRoutes.length).toBeGreaterThan(0);

    // The older database: duties added to the baseline since it was seeded are missing, and an interrupted
    // provisioning run left the leave route without its step and the expense route without its last step.
    await removeDuties(companyId, DEV_ACCOUNTS.employee, 'EMPLOYEE', [...EMPLOYEE_ADDED_LATER, ...employeeConfidential]);
    await removeDuties(companyId, DEV_ACCOUNTS.hr, 'HR_ADMINISTRATOR', HR_ADDED_LATER);
    await deleteSteps(companyId, `w.kind = 'leave_request' or (w.kind = 'expense_claim' and s.sequence = 3)`);
    expect(await unconfiguredKinds(companyId)).toEqual(['leave_request']);
    confidentialBefore = await confidentialAllowlist(companyId);

    await seedDevCompany(h.db, 'OLDER');
  });

  it("grants the seeded accounts' active assignments the operational default duties added since", async () => {
    expect(await duties(companyId, DEV_ACCOUNTS.employee, 'EMPLOYEE')).toEqual(expect.arrayContaining(EMPLOYEE_ADDED_LATER));
    expect(await duties(companyId, DEV_ACCOUNTS.hr, 'HR_ADMINISTRATOR')).toEqual(expect.arrayContaining(HR_ADDED_LATER));
    for (const [account, roleCode] of SEEDED_ASSIGNMENTS) {
      expect({ account, roleCode, duties: await duties(companyId, account, roleCode) }).toEqual({
        account,
        roleCode,
        duties: expect.arrayContaining(defaultDuties(roleCode).filter(isOperational)),
      });
    }
  });

  it('restores the workflow steps an interrupted run left out', async () => {
    expect(await unconfiguredKinds(companyId)).toEqual([]);
    expect(await routes(companyId)).toEqual(completeRoutes);
  });

  it('grants the Employee OWN assignment its own-ESS duties (I-16) and never any other confidential field group', async () => {
    const employee = await duties(companyId, DEV_ACCOUNTS.employee, 'EMPLOYEE');
    expect(employee).toEqual(expect.arrayContaining(employeeConfidential));
    const added = (await confidentialAllowlist(companyId)).filter((r) => !confidentialBefore.includes(r));
    expect(added).toEqual(employeeConfidential.map((k) => `${DEV_ACCOUNTS.employee} EMPLOYEE ${k} active`).sort());
  });

  it('data-8: a second re-seed changes no row', async () => {
    const restored = await fingerprint(companyId);
    await seedDevCompany(h.db, 'OLDER');
    expect(await fingerprint(companyId)).toEqual(restored);
  });
});

describe('data-9: re-seeding is limited and atomic', () => {
  it('does not grant a duty whose group the company classifies as confidential (BR-043)', async () => {
    const { companyId } = await seedDevCompany(h.db, 'CLASSIFIED');
    await removeDuties(companyId, DEV_ACCOUNTS.hr, 'HR_ADMINISTRATOR', ['mobile_link.approve.operational']);
    await h.db.query(
      `update confidential_field_policy set classification = 'CONFIDENTIAL' where company_id = $1 and resource_code = 'mobile_link' and field_group = 'operational'`,
      [companyId],
    );
    await seedDevCompany(h.db, 'CLASSIFIED');
    expect(await duties(companyId, DEV_ACCOUNTS.hr, 'HR_ADMINISTRATOR')).not.toContain('mobile_link.approve.operational');
  });

  it('never changes a route that an approval instance already uses (definitions are immutable once used)', async () => {
    const { companyId } = await seedDevCompany(h.db, 'IN-USE');
    const workflowId = (await h.one<{ id: string }>(`select id from workflow_definition where company_id = $1 and kind = 'expense_claim'`, [companyId])).id;
    const step3 = `select 1 from workflow_step where company_id = $1 and workflow_id = $2 and sequence = 3`;
    // Inside one transaction that is rolled back: the claim below has no typed root, so it could never commit.
    await h.db.query('begin');
    try {
      await h.db.query(`delete from workflow_step where company_id = $1 and workflow_id = $2 and sequence = 3`, [companyId, workflowId]);
      const tx = (await h.one<{ id: string }>(`insert into business_transaction (company_id, kind, state) values ($1, 'expense_claim', 'DRAFT') returning id`, [companyId])).id;
      await h.db.query(
        `insert into approval_instance (company_id, transaction_kind, transaction_id, transaction_revision, workflow_id, state)
         values ($1, 'expense_claim', $2, 1, $3, 'ACTIVE')`,
        [companyId, tx, workflowId],
      );
      await seedDevCompany(h.db, 'IN-USE'); // runs in a savepoint of the open transaction
      expect((await h.db.query(step3, [companyId, workflowId])).rowCount).toBe(0);
    } finally {
      await h.db.query('rollback');
    }
    expect((await h.db.query(step3, [companyId, workflowId])).rowCount).toBe(1);
  });

  it('an interrupted first seed leaves nothing behind, so the next run seeds the whole company', async () => {
    const undo = await interruptInsertsInto('workflow_step');
    try {
      await expect(seedDevCompany(h.db, 'INTERRUPTED')).rejects.toThrow('simulated interruption');
    } finally {
      await undo();
    }
    // No company (hence no route without its steps) survives the interrupted run.
    expect((await h.db.query(`select 1 from company where code = 'INTERRUPTED'`)).rowCount).toBe(0);

    const { companyId } = await seedDevCompany(h.db, 'INTERRUPTED');
    expect(await unconfiguredKinds(companyId)).toEqual([]);
    expect(await duties(companyId, DEV_ACCOUNTS.employee, 'EMPLOYEE')).toContain('leave.submit.operational');
  });

  it('an interrupted re-seed is rolled back as a whole', async () => {
    const { companyId } = await seedDevCompany(h.db, 'ROLLBACK');
    const ceiling = `select 1 from role_permission rp join role r on r.company_id = rp.company_id and r.id = rp.role_id and r.code = 'AUDITOR'
                       join permission p on p.id = rp.permission_id and p.resource = 'audit' and p.action = 'export' and p.field_group = 'operational'
                      where rp.company_id = $1`;
    // The older database lacks one ceiling entry, the leave route's step and two of the employee's duties.
    await h.db.query(`delete from role_permission rp using role r where rp.company_id = $1 and r.company_id = rp.company_id and r.id = rp.role_id and r.code = 'AUDITOR'
                        and rp.permission_id = (select id from permission where resource = 'audit' and action = 'export' and field_group = 'operational')`, [companyId]);
    await deleteSteps(companyId, `w.kind = 'leave_request'`);
    await removeDuties(companyId, DEV_ACCOUNTS.employee, 'EMPLOYEE', ['leave.cancel.operational', 'work_request.submit.operational']);
    const before = await fingerprint(companyId);

    // The run fails late (at the notification catalogue, after roles, routes and policies).
    const undo = await interruptInsertsInto('notification_template');
    try {
      await expect(seedDevCompany(h.db, 'ROLLBACK')).rejects.toThrow('simulated interruption');
    } finally {
      await undo();
    }
    expect(await fingerprint(companyId)).toEqual(before);

    await seedDevCompany(h.db, 'ROLLBACK');
    expect((await h.db.query(ceiling, [companyId])).rowCount).toBe(1);
    expect(await unconfiguredKinds(companyId)).toEqual([]);
    expect(await duties(companyId, DEV_ACCOUNTS.employee, 'EMPLOYEE')).toEqual(expect.arrayContaining(['leave.cancel.operational', 'work_request.submit.operational']));
  });
});
