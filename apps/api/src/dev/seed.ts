// Development seed: one synthetic company with ready-to-use accounts for exploring the UI.
// Synthetic data only. Policies are activated by a different user from their author (the seed approver), as
// the rules require; every grant is recorded as approved by the bootstrap approver, never self-approved.
// A seed or re-seed is one transaction, so an interrupted run leaves nothing behind.
import type pg from 'pg';
import { SYSTEM_ACTOR_ID } from '../audit/actors.js';
import type { Queryable } from '../db/queryable.js';
import { OWN_ESS_ROLE_CODES } from '../modules/access/authorize.js';
import { BASELINE_ROLES, OPERATIONAL_FIELD_GROUPS, type PermissionKey, parsePermissionKey } from '../modules/access/baseline.js';
import { provisionCompany, withGrantBootstrap } from '../modules/access/provision.js';

export const DEV_ACCOUNTS = {
  hr: 'hr.admin@demo.test',
  sysadmin: 'sys.admin@demo.test',
  manager: 'manager@demo.test',
  employee: 'employee@demo.test',
  finance: 'finance@demo.test',
  // C4 (H2): a payroll run's preparer, reviewer and approver are different people; this account approves.
  payroll: 'payroll.approver@demo.test',
} as const;

const SEED_APPROVER = 'seed.approver@demo.test';

const OPERATIONAL_GROUPS = new Set(OPERATIONAL_FIELD_GROUPS.map((g) => `${g.resource}.${g.fieldGroup}`));
const isOperational = (key: PermissionKey) => {
  const { resource, fieldGroup } = parsePermissionKey(key);
  return OPERATIONAL_GROUPS.has(`${resource}.${fieldGroup}`);
};

const FINANCE_BUNDLE: PermissionKey[] = [
  'expense.read.operational',
  'expense.manager_decide.operational',
  'expense.finance_decide.operational',
  'expense.high_value_decide.operational',
  'expense.export.operational',
  'payment.read.operational',
  'payment.prepare.operational',
  'payment.release.operational',
  'payment.confirm_outcome.operational',
  'payment.reverse.operational',
  'payment.export.operational',
];

/**
 * Seeds the development company, or brings an existing one up to the current baseline. Needs one connection
 * (a transaction cannot span a pool): the run is its own transaction, or a savepoint inside the caller's.
 */
export async function seedDevCompany(db: pg.ClientBase, code = 'DEMO'): Promise<{ companyId: string; accounts: typeof DEV_ACCOUNTS }> {
  const nested = db.getTransactionStatus() === 'T';
  await db.query(nested ? 'savepoint dev_seed' : 'begin');
  try {
    const result = await seed(db, code);
    await db.query(nested ? 'release savepoint dev_seed' : 'commit');
    return result;
  } catch (err) {
    await db.query(nested ? 'rollback to savepoint dev_seed' : 'rollback').catch(() => undefined);
    throw err;
  }
}

/**
 * DF02 re-seed: the seeded accounts' own assignments (approved by the seed approver) get the default duties
 * their role gained since the database was seeded. An existing allowlist row is never changed (a duty switched
 * off stays off), and a duty is added only when its field group is operational both in the baseline and in the
 * company's current classification: a confidential group always needs its own approved grant. The one exception
 * is I-16 (H1/BR-053): an Employee OWN assignment also gets the catalogued own-ESS groups among its default duties,
 * as a fresh seed gives them.
 */
async function grantMissingDefaultDuties(db: Queryable, companyId: string, approverId: string): Promise<void> {
  const assignments = (
    await db.query<{ id: string; role_code: string; scope_kind: string }>(
      `select ra.id, r.code as role_code, ra.scope_kind
         from role_assignment ra
         join role r on r.company_id = ra.company_id and r.id = ra.role_id
         join user_account u on u.id = ra.user_id
        where ra.company_id = $1 and u.account_key = any($2::text[]) and ra.approved_by = $3
          and ra.state = 'ACTIVE' and (ra.effective_to is null or ra.effective_to > now())`,
      [companyId, Object.values(DEV_ACCOUNTS), approverId],
    )
  ).rows;
  await withGrantBootstrap(db, async () => {
    for (const a of assignments) {
      const roleDuties = BASELINE_ROLES.find((r) => r.code === a.role_code)?.defaultDuties ?? [];
      const duties = roleDuties.filter(isOperational);
      const ownEss = OWN_ESS_ROLE_CODES.includes(a.role_code) && a.scope_kind === 'OWN' ? roleDuties.filter((k) => !isOperational(k)) : [];
      if (duties.length === 0 && ownEss.length === 0) continue;
      await db.query(
        `insert into role_assignment_permission (company_id, role_assignment_id, permission_id, active, effective_from, effective_to, created_by, updated_by)
         select ra.company_id, ra.id, p.id, true, greatest(ra.effective_from, now()), ra.effective_to, $3, $3
           from role_assignment ra
           join permission p on p.resource || '.' || p.action || '.' || p.field_group = any($4::text[] || $5::text[])
           join role_permission rp on rp.company_id = ra.company_id and rp.role_id = ra.role_id and rp.permission_id = p.id and rp.effect = 'ALLOW'
          where ra.company_id = $1 and ra.id = $2
            and ((p.resource || '.' || p.action || '.' || p.field_group = any($4::text[])
                  and exists (select 1 from confidential_field_policy cfp
                               where cfp.company_id = ra.company_id and cfp.resource_code = p.resource and cfp.field_group = p.field_group
                                 and cfp.classification = 'OPERATIONAL'
                                 and cfp.effective_from <= hrms_business_date(ra.company_id, now())
                                 and (cfp.effective_to is null or cfp.effective_to > hrms_business_date(ra.company_id, now()))))
                 or (p.own_ess and p.resource || '.' || p.action || '.' || p.field_group = any($5::text[])))
         on conflict (company_id, role_assignment_id, permission_id) do nothing`,
        [companyId, a.id, approverId, duties, ownEss],
      );
    }
  });
}

/**
 * DF03 explicit fallback lists filled by the seeded HR and finance accounts, per transaction kind (in priority order).
 * Where a later decision must come from someone else (an offer's compensation, a settlement's approval after its
 * review), the list names both accounts so the engine can route around the earlier actor.
 */
const SEED_FALLBACK_REVIEWERS: readonly (readonly [kind: string, accounts: readonly ('hr' | 'finance' | 'payroll')[]])[] = [
  ['leave_request', ['hr']],
  ['employee_confirmation', ['hr']],
  ['increment_case', ['hr']],
  ['expense_claim', ['finance']],
  ['profile_change', ['hr']],
  ['sensitive_change', ['hr']],
  // Wave-2 modules (registered kinds only; a kind that does not exist yet is skipped).
  ['requisition', ['hr']],
  ['manpower_budget_revision', ['hr']],
  ['hiring_offer', ['finance']],
  ['exit_case', ['hr']],
  // HR prepares, finance reviews, the payroll account approves (settlement_approval routes through this list). Release
  // eligibility needs a fourth independent person, so the demo stops at approval.
  ['settlement', ['hr', 'finance', 'payroll']],
  ['timesheet', ['hr']],
  // A reopen is decided from the list by someone other than its requester: two reviewers.
  ['timesheet_reopen', ['hr', 'finance']],
  ['asset_request', ['hr']],
  // The manager rates; the HR account confirms from the list (appraisal_second_review routes through this list too).
  ['appraisal', ['hr']],
  // Payroll (H2, C4): HR prepares; finance reviews runs and decides inputs, stops and holds; the payroll account approves.
  // A covering approval of the approver's own record needs a fourth person, so the demo cannot cover one.
  ['payroll_run', ['finance']],
  ['payroll_run_approval', ['payroll']],
  ['payroll_record_cover', ['payroll', 'finance']],
  ['payroll_input_batch', ['finance']],
  ['payroll_salary_stop', ['finance']],
  ['payroll_hold', ['finance', 'payroll']],
  // FR-100, FR-035: an independent reviewer of later-period cases. FR-036, FR-108: the reviewer of tax items (tax_proof routes through this list too).
  ['timesheet_adjustment', ['finance', 'payroll']],
  ['payroll_arrears_case', ['finance', 'payroll']],
  ['tax_declaration', ['hr']],
];

/**
 * Seeds a kind's fallback list only while it has none, so a re-seed adds lists for kinds introduced since the
 * database was seeded and never changes a list someone maintained. Eligibility is still checked at routing time.
 */
async function ensureFallbackReviewers(db: Queryable, companyId: string): Promise<void> {
  for (const [kind, accounts] of SEED_FALLBACK_REVIEWERS) {
    await db.query(
      `insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active)
       select $1, $2, u.id, a.priority, true
         from unnest($3::text[]) with ordinality as a (account_key, priority)
         join user_account u on u.account_key = a.account_key
        where exists (select 1 from transaction_kind k where k.kind = $2)
          and not exists (select 1 from workflow_fallback_reviewer f where f.company_id = $1 and f.kind = $2)`,
      [companyId, kind, accounts.map((a) => DEV_ACCOUNTS[a])],
    );
  }
}

/** Approved confidential grants of the seeded HR and finance accounts, so the demo can run every route (synthetic seed). */
const SEED_HR_CONFIDENTIAL: PermissionKey[] = [
  // FR-104/105: the HR account reviews sensitive changes.
  'sensitive_change.review.private',
  'sensitive_change.read.private',
  'employee.read.private',
  // Hiring: candidate contacts and documents, offer preparation.
  'candidate.read.contact',
  'candidate.read.document',
  'candidate.upload.document',
  'offer.read.compensation',
  'offer.manage.compensation',
  // Lifecycle: letters, exit reasons, settlement preparation and review.
  'letter.generate.letter',
  'letter.read.letter',
  'exit.read.reason',
  'settlement.read.amount',
  'settlement.export.amount',
  'settlement.prepare.amount',
  'settlement.review.amount',
  // Assets (FR-110): register, custody and request decisions are ceiling-only Admin duties.
  'asset.read.operational',
  'asset.manage.operational',
  'asset.custody.operational',
  'asset_request.read.operational',
  'asset_request.decide.operational',
  // Appraisal (FR-043/FR-044): confirmation, HR oversight, reports and exports of ratings and reasons.
  'appraisal.read.rating',
  'appraisal.rate.rating',
  'appraisal.confirm.rating',
  'appraisal.read.reason',
  'appraisal.report.rating',
  'appraisal.export.rating',
  // Hiring: recording a candidate's private contact.
  'candidate.manage.contact',
  // Lifecycle: process remarks and evidence, restricted HR notes.
  'employee_process.read.note',
  'employee_process.read_evidence.evidence',
  'employee_note.read.restricted',
  'employee_note.write.restricted',
  // The notes register's void and bulk upload (CL-040, 0260) and the document compliance report (CL-150, 0261).
  'employee_note.void.restricted',
  'employee_note.import.restricted',
  'document_compliance.export.document',
  // Training: restricted feedback comments and participation reasons.
  'training_feedback.read.comment',
  'training_participant.read.reason',
  // Payroll (H2): the HR account creates, calculates, processes and proposes; it never reviews or approves its runs.
  'payroll_config.read.operational',
  'payroll_config.manage.operational',
  'payroll_run.read.operational',
  'payroll_run.read.amount',
  'payroll_run.prepare.amount',
  'payroll_run.process.amount',
  'payroll_run.cancel.amount',
  'payroll_input.read.amount',
  'payroll_input.prepare.amount',
  'payroll_stop.read.hold',
  'payroll_stop.propose.hold',
  'payroll_hold.read.hold',
  'payroll_hold.propose.hold',
];
/** The demo manager rates their direct reports' appraisals (FR-043 step 1) and so needs the rating grants. */
const SEED_MANAGER_CONFIDENTIAL: PermissionKey[] = ['appraisal.read.rating', 'appraisal.rate.rating'];
const SEED_FINANCE_CONFIDENTIAL: PermissionKey[] = [
  'expense.read.reason',
  'offer.read.compensation',
  'offer.approve.compensation',
  'settlement.read.amount',
  'settlement.review.amount',
  'settlement.approve.amount',
  'settlement.release.amount',
  // Payroll: reviews runs; decides inputs, salary stops and holds (independent of the HR preparer).
  'payroll_config.read.operational',
  'payroll_config.activate.operational',
  'payroll_run.read.operational',
  'payroll_run.read.amount',
  'payroll_run.review.amount',
  'payroll_input.read.amount',
  'payroll_input.approve.amount',
  'payroll_stop.read.hold',
  'payroll_stop.decide.hold',
  'payroll_hold.read.hold',
  'payroll_hold.decide.hold',
  'payroll_hold.release.hold',
];
/** The payroll approver account: approves runs reviewed by finance and decides holds (C4: never the preparer or reviewer). */
const SEED_PAYROLL_CONFIDENTIAL: PermissionKey[] = [
  'payroll_config.read.operational',
  'payroll_run.read.operational',
  'payroll_run.read.amount',
  'payroll_run.approve.amount',
  'payroll_hold.read.hold',
  'payroll_hold.decide.hold',
  // Settlement approval after finance's review (lifecycle).
  'settlement.read.amount',
  'settlement.approve.amount',
];

async function seed(db: Queryable, code: string): Promise<{ companyId: string; accounts: typeof DEV_ACCOUNTS }> {
  const existing = (await db.query<{ id: string }>(`select id from company where code = $1`, [code])).rows[0];
  if (existing) {
    // Provisioning is idempotent: re-running it brings an existing dev company up to the current baseline
    // (new workflows and missing route steps, templates, permissions, the seeded accounts' default duties)
    // without touching seeded people or transactions.
    const approver = (await db.query<{ id: string }>(`select id from user_account where account_key = $1`, [SEED_APPROVER])).rows[0];
    if (approver) {
      await provisionCompany(db, { companyId: existing.id, approvedBy: approver.id, effectiveFrom: '2026-01-01' });
      await grantMissingDefaultDuties(db, existing.id, approver.id);
      await ensureFallbackReviewers(db, existing.id);
    }
    return { companyId: existing.id, accounts: DEV_ACCOUNTS };
  }

  const user = async (key: string) =>
    (await db.query<{ id: string }>(`insert into user_account (account_key, active) values ($1, true) on conflict (account_key) do update set active = true returning id`, [key])).rows[0]!.id;
  const approver = await user(SEED_APPROVER);
  const companyId = (await db.query<{ id: string }>(`insert into company (code, name, active, created_by) values ($1, 'Demo Company (synthetic)', true, $2) returning id`, [code, approver])).rows[0]!.id;
  await provisionCompany(db, { companyId, approvedBy: approver, effectiveFrom: '2026-01-01' });

  const master = async (table: string, c: string, name: string) =>
    (await db.query<{ id: string }>(`insert into ${table} (company_id, code, name, active, created_by) values ($1, $2, $3, true, $4) returning id`, [companyId, c, name, approver])).rows[0]!.id;
  const eng = await master('department', 'ENG', 'Engineering');
  const hq = await master('location', 'HQ', 'Head Office');
  const dev = await master('designation', 'DEV', 'Developer');
  const mgr = await master('designation', 'MGR', 'Manager');
  const shift = (
    await db.query<{ id: string }>(
      `insert into shift (company_id, code, name, in_time, out_time, spans_midnight, buffer_minutes, active, created_by) values ($1, 'DAY', 'Day shift', '09:00', '18:00', false, 240, true, $2) returning id`,
      [companyId, approver],
    )
  ).rows[0]!.id;
  await db.query(`insert into shift_break (company_id, shift_id, sequence, start_offset_minutes, end_offset_minutes) values ($1, $2, 1, 240, 300)`, [companyId, shift]);

  const status = async (s: string) => (await db.query<{ id: string }>(`select id from reference_value where company_id = $1 and category = 'EMPLOYEE_STATUS' and code = $2`, [companyId, s])).rows[0]!.id;
  const permanent = (await db.query<{ id: string }>(`select id from reference_value where company_id = $1 and category = 'EMPLOYMENT_TYPE' and code = 'PERMANENT'`, [companyId])).rows[0]!.id;
  const person = async (empCode: string, name: string, email: string, designation: string) => {
    const id = (
      await db.query<{ id: string }>(
        `insert into employee (company_id, employee_code, display_name, work_email, joining_date, employment_type_id, status_id, created_by)
         values ($1, $2, $3, $4, '2026-01-05', $5, $6, $7) returning id`,
        [companyId, empCode, name, email, permanent, await status('ACTIVE_CONFIRMED'), approver],
      )
    ).rows[0]!.id;
    await db.query(
      `insert into employment_assignment (company_id, employee_id, department_id, location_id, designation_id, effective_from) values ($1, $2, $3, $4, $5, '2026-01-05')`,
      [companyId, id, eng, hq, designation],
    );
    await db.query(`insert into shift_assignment (company_id, employee_id, shift_id, effective_from) values ($1, $2, $3, '2026-01-05')`, [companyId, id, shift]);
    return id;
  };
  const managerEmp = await person('M-001', 'Maya Manager (synthetic)', 'manager@demo.test', mgr);
  const employeeEmp = await person('E-001', 'Eli Employee (synthetic)', 'employee@demo.test', dev);
  await person('E-002', 'Ravi Teammate (synthetic)', 'teammate@demo.test', dev);
  await db.query(
    `insert into manager_assignment (company_id, employee_id, manager_employee_id, effective_from)
     select $1, e.id, $2, '2026-01-05' from employee e where e.company_id = $1 and e.employee_code in ('E-001', 'E-002')`,
    [companyId, managerEmp],
  );

  const assign = async (userId: string, roleCode: string, extra: PermissionKey[] = [], employeeId?: string) => {
    const role = BASELINE_ROLES.find((r) => r.code === roleCode)!;
    if (employeeId) await db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from) values ($1, $2, $3, '2026-01-01')`, [companyId, userId, employeeId]);
    await withGrantBootstrap(db, async () => {
      const assignment = (
        await db.query<{ id: string }>(
          `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, approved_by, approved_at, purpose, created_by)
           select $1, $2, r.id, $4, '2026-01-01T00:00:00Z', 'ACTIVE', $5, now(), 'Development seed (synthetic)', $6 from role r where r.company_id = $1 and r.code = $3 returning id`,
          [companyId, userId, roleCode, role.defaultScope, approver, SYSTEM_ACTOR_ID],
        )
      ).rows[0]!.id;
      for (const key of [...role.defaultDuties, ...extra]) {
        const { resource, action, fieldGroup } = parsePermissionKey(key);
        await db.query(
          `insert into role_assignment_permission (company_id, role_assignment_id, permission_id, active, effective_from)
           select $1, $2, p.id, true, '2026-01-01T00:00:00Z' from permission p where p.resource = $3 and p.action = $4 and p.field_group = $5`,
          [companyId, assignment, resource, action, fieldGroup],
        );
      }
    });
  };
  const hr = await user(DEV_ACCOUNTS.hr);
  const sysadmin = await user(DEV_ACCOUNTS.sysadmin);
  const managerUser = await user(DEV_ACCOUNTS.manager);
  const employeeUser = await user(DEV_ACCOUNTS.employee);
  const finance = await user(DEV_ACCOUNTS.finance);
  // Approved confidential grants for the demo routes (SEED_HR_CONFIDENTIAL; synthetic seed).
  await assign(hr, 'HR_ADMINISTRATOR', SEED_HR_CONFIDENTIAL);
  await assign(sysadmin, 'SYSTEM_ADMINISTRATOR');
  await assign(managerUser, 'REPORTING_MANAGER', SEED_MANAGER_CONFIDENTIAL, managerEmp);
  await assign(managerUser, 'EMPLOYEE');
  await assign(employeeUser, 'EMPLOYEE', [], employeeEmp);
  await assign(finance, 'HR_ADMINISTRATOR', [...FINANCE_BUNDLE, ...SEED_FINANCE_CONFIDENTIAL]);
  await assign(await user(DEV_ACCOUNTS.payroll), 'HR_ADMINISTRATOR', SEED_PAYROLL_CONFIDENTIAL);

  // Policies were authored by the seed approver; HR activates them (author != activator).
  for (const table of ['leave_policy', 'attendance_policy', 'expense_policy']) {
    await db.query(`update ${table} set state = 'ACTIVE', activated_by = $2, activated_at = now() where company_id = $1 and state = 'DRAFT'`, [companyId, hr]);
  }
  await ensureFallbackReviewers(db, companyId);
  for (const [type, units] of [
    ['ANNUAL', '12'],
    ['SICK', '6'],
    ['CASUAL', '6'],
  ] as const) {
    await db.query(
      `insert into leave_movement (company_id, employee_id, leave_type_id, movement_kind, units, effective_date, idempotency_key, reason)
       select $1, e.id, t.id, 'OPENING', $3::numeric, '2026-01-05', 'seed:opening:' || e.employee_code || ':' || t.code, 'Development seed opening balance'
         from employee e join leave_type t on t.company_id = e.company_id and t.code = $2 where e.company_id = $1`,
      [companyId, type, units],
    );
  }
  return { companyId, accounts: DEV_ACCOUNTS };
}
