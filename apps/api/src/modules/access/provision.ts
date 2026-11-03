// Company provisioning: baseline roles with ceilings, reference values and field classification.
// Runs inside the caller's transaction. `approvedBy` is the independent actor recorded on classification
// policies; it must be a real user (no anonymous approvals).
//
// Re-running it is safe and brings an existing company up to the current baseline:
//   * a row that already matches is never rewritten, so its version stays put for expectedVersion holders;
//     only a baseline name that differs is updated;
//   * every child row (route step, policy mapping/rule, widget, notification rule) is ensured on its own key,
//     so a parent that an earlier, interrupted run left incomplete is completed;
//   * what the rules freeze is never changed: an activated policy (frozen; a change is a new revision) and a
//     route already used by a transaction (workflow definitions in use are immutable).
import type { Queryable } from '../../db/queryable.js';
import { dashboardFor, widgetPermission } from '../dashboard/service.js';
import { INCREMENT_REVIEW_NOTIFICATIONS } from '../increment/notifications.js';
import { EVENT_NOTICE_CATALOGUE } from '../notification/catalogue.js';
import { MODULE_REGISTRATIONS } from '../registry.js';
import {
  BASELINE_ATTENDANCE_POLICY,
  BASELINE_EXPENSE_CATEGORIES,
  BASELINE_LEAVE_POLICIES,
  BASELINE_LEAVE_TYPES,
  BASELINE_NOTIFICATIONS,
  BASELINE_REFERENCE_VALUES,
  BASELINE_ROLES,
  OPERATIONAL_FIELD_GROUPS,
  type PermissionKey,
} from './baseline.js';

interface ProvisionOptions {
  companyId: string;
  approvedBy: string;
  effectiveFrom: string;
}

interface StepSpec {
  sequence: number;
  permission: PermissionKey;
  rule: 'DIRECT_MANAGER' | 'HR_FALLBACK_LIST';
  /** workflow_step.condition_code, evaluated by the owning module (e.g. EXPENSE_HIGH_VALUE). */
  condition?: string;
}

/** The global permission catalogue (key -> id); a key that is not catalogued is a programming error. */
async function loadCatalogue(db: Queryable): Promise<(key: string) => string> {
  const rows = (await db.query<{ id: string; key: string }>(`select id, resource || '.' || action || '.' || field_group as key from permission`)).rows;
  const ids = new Map(rows.map((r) => [r.key, r.id]));
  return (key) => {
    const id = ids.get(key);
    if (!id) throw new Error(`Permission ${key} is not in the catalogue`);
    return id;
  };
}

/** Revision 1 of a kind's approval route; each step is ensured on (workflow, sequence) while no transaction uses it. */
async function ensureRoute(db: Queryable, opts: ProvisionOptions, permissionId: (key: string) => string, kind: string, steps: StepSpec[]): Promise<void> {
  await db.query(
    `insert into workflow_definition (company_id, kind, revision, effective_from, active, created_by, updated_by)
     values ($1, $2, 1, $3::date, true, $4, $4) on conflict (company_id, kind, revision) do nothing`,
    [opts.companyId, kind, opts.effectiveFrom, opts.approvedBy],
  );
  for (const step of steps) {
    await db.query(
      `insert into workflow_step (company_id, workflow_id, sequence, permission_id, selection_rule, completion_rule, condition_code, created_by, updated_by)
       select w.company_id, w.id, $3, $4, $5, 'ANY_ONE_ELIGIBLE', $6, $7, $7
         from workflow_definition w
        where w.company_id = $1 and w.kind = $2 and w.revision = 1
          and not exists (select 1 from approval_instance ai where ai.company_id = w.company_id and ai.workflow_id = w.id)
       on conflict (company_id, workflow_id, sequence) do nothing`,
      [opts.companyId, kind, step.sequence, permissionId(step.permission), step.rule, step.condition ?? null, opts.approvedBy],
    );
  }
}

/**
 * The controlled bootstrap path for grants (CI09, migration 0099). The database lets a role assignment become usable
 * only through proposal and independent approval; the very first administrator has nobody to approve them, so grant rows
 * may be written directly only inside this helper, within the caller's transaction (the setting is transaction-local).
 * Such rows are marked bootstrapped for good. The development seed is the only application caller and serving code
 * never calls it (db/tests/grant-guards.test.ts scans the source). Provisioning a company creates no assignment.
 */
export async function withGrantBootstrap<T>(tx: Queryable, write: () => Promise<T>): Promise<T> {
  const previous = (await tx.query<{ v: string }>(`select coalesce(current_setting('hrms.grant_bootstrap', true), 'off') as v`)).rows[0]!.v;
  await tx.query(`select set_config('hrms.grant_bootstrap', 'on', true)`);
  const result = await write();
  await tx.query(`select set_config('hrms.grant_bootstrap', $1, true)`, [previous]);
  return result;
}

export async function provisionCompany(db: Queryable, opts: ProvisionOptions): Promise<void> {
  const permissionId = await loadCatalogue(db);

  for (const [category, values] of Object.entries(BASELINE_REFERENCE_VALUES)) {
    for (const [code, label] of Object.entries(values)) {
      await db.query(
        `insert into reference_value (company_id, category, code, label, active, created_by)
         values ($1, $2, $3, $4, true, $5) on conflict (company_id, category, code) do nothing`,
        [opts.companyId, category, code, label, opts.approvedBy],
      );
    }
  }

  for (const role of BASELINE_ROLES) {
    const roleId =
      (
        await db.query<{ id: string }>(
          `insert into role (company_id, code, name, active, access_class, created_by)
           values ($1, $2, $3, true, $4, $5)
           on conflict (company_id, code) do update set name = excluded.name, updated_by = excluded.created_by
            where role.name is distinct from excluded.name
           returning id`,
          [opts.companyId, role.code, role.name, role.accessClass, opts.approvedBy],
        )
      ).rows[0]?.id ?? (await db.query<{ id: string }>(`select id from role where company_id = $1 and code = $2`, [opts.companyId, role.code])).rows[0]!.id;

    for (const key of role.ceiling) {
      await db.query(
        `insert into role_permission (company_id, role_id, permission_id, effect, created_by)
         values ($1, $2, $3, 'ALLOW', $4) on conflict (company_id, role_id, permission_id) do nothing`,
        [opts.companyId, roleId, permissionId(key), opts.approvedBy],
      );
    }
  }

  for (const t of BASELINE_LEAVE_TYPES) {
    await db.query(
      `insert into leave_type (company_id, code, name, unit, paid, active, created_by, updated_by)
       values ($1, $2, $3, 'DAY', $4, true, $5, $5) on conflict (company_id, code) do nothing`,
      [opts.companyId, t.code, t.name, t.paid, opts.approvedBy],
    );
  }
  for (const p of BASELINE_LEAVE_POLICIES) {
    await db.query(
      `insert into leave_policy (company_id, leave_type_id, revision, effective_from, eligibility_code, accrual_rule_code,
                                 annual_entitlement, min_service_days, state, created_by, updated_by)
       select $1, t.id, $3, $4, $5, $6, $7::numeric, $8, 'DRAFT', $9, $9 from leave_type t where t.company_id = $1 and t.code = $2
       on conflict (company_id, leave_type_id, revision) do nothing`,
      [opts.companyId, p.leaveType, p.revision, opts.effectiveFrom, p.eligibility, p.annualEntitlement === '0' ? 'NONE' : 'MONTHLY_PRORATED', p.annualEntitlement, p.minServiceDays, opts.approvedBy],
    );
    // Eligibility mappings are part of the draft; an activated policy is frozen.
    for (const employmentType of p.employmentTypes) {
      await db.query(
        `insert into leave_policy_mapping (company_id, policy_id, employment_type_id, created_by, updated_by)
         select lp.company_id, lp.id, rv.id, $5, $5
           from leave_policy lp
           join leave_type t on t.company_id = lp.company_id and t.id = lp.leave_type_id and t.code = $2
           join reference_value rv on rv.company_id = lp.company_id and rv.category = 'EMPLOYMENT_TYPE' and rv.code = $4
          where lp.company_id = $1 and lp.revision = $3 and lp.state = 'DRAFT'
         on conflict do nothing`,
        [opts.companyId, p.leaveType, p.revision, employmentType, opts.approvedBy],
      );
    }
  }

  // DF03 leave route: one step, current direct manager, HR fallback list when the manager is ineligible.
  // Cancelling approved leave is a controlled action reviewed on the same route (FR-026).
  // FR-027 outdoor duty and holiday work are reviewed on the same route; they are not leave.
  for (const kind of ['leave_request', 'leave_cancellation', 'outdoor_duty', 'holiday_work']) {
    await ensureRoute(db, opts, permissionId, kind, [{ sequence: 1, permission: 'leave.approve.operational', rule: 'DIRECT_MANAGER' }]);
  }

  // FR-059 self-service: profile changes are decided by HR from the explicit list with the employee update
  // duty; attendance corrections route like attendance amendments (direct manager, HR fallback; DF03).
  await ensureRoute(db, opts, permissionId, 'profile_change', [{ sequence: 1, permission: 'employee.update.operational', rule: 'HR_FALLBACK_LIST' }]);
  await ensureRoute(db, opts, permissionId, 'attendance_correction', [
    { sequence: 1, permission: 'attendance.approve_correction.operational', rule: 'DIRECT_MANAGER' },
  ]);

  // DF11 default confirmation policy: 3 calendar months from joining, month-end clamp, max 2 extensions.
  await db.query(
    `insert into confirmation_policy (company_id, code, revision, duration, duration_unit, start_basis, month_end_rule, start_day_inclusive,
                                      max_extensions, effective_from, created_by, updated_by)
     values ($1, 'DEFAULT', 1, 3, 'CALENDAR_MONTHS', 'JOINING_DATE', 'CLAMP_TO_MONTH_END', false, 2, '2000-01-01', $2, $2)
     on conflict (company_id, code, revision) do nothing`,
    [opts.companyId, opts.approvedBy],
  );
  // DF11: an independent scoped HR Administrator decides; reviewers come from the explicit fallback list.
  await ensureRoute(db, opts, permissionId, 'employee_confirmation', [{ sequence: 1, permission: 'confirmation.decide.operational', rule: 'HR_FALLBACK_LIST' }]);

  // DF15 default annual cycle: effective 1 Apr, review opens 1 Jan, roster freezes 31 Jan, decisions by 15 Mar,
  // eligibility = confirmed and joined on/before prior 30 Sep, notice excluded, basis monthly gross fixed.
  await db.query(
    `insert into increment_cycle (company_id, code, revision, recurrence_basis, recurrence_unit, recurrence_interval, recurrence_anchor_month,
                                  recurrence_anchor_day, review_open_month, review_open_day, roster_freeze_month, roster_freeze_day,
                                  decision_due_month, decision_due_day, eligibility_rule_code, cutoff_month, cutoff_day, exclude_notice,
                                  compensation_basis, effective_from, active, created_by, updated_by)
     values ($1, 'ANNUAL', 1, 'COMMON_DATE', 'YEAR', 1, 4, 1, 1, 1, 1, 31, 3, 15, 'CONFIRMED_JOINED_BY_CUTOFF', 9, 30, true,
             'MONTHLY_GROSS', '2000-01-01', true, $2, $2)
     on conflict (company_id, code, revision) do nothing`,
    [opts.companyId, opts.approvedBy],
  );
  await ensureRoute(db, opts, permissionId, 'increment_case', [{ sequence: 1, permission: 'increment.approve.salary', rule: 'HR_FALLBACK_LIST' }]);

  // DF06 expense policy: INR, 30-day window, high value above 50,000; seeded DRAFT for independent activation.
  await db.query(
    `insert into expense_policy (company_id, code, revision, currency_code, submission_window_days, high_value_threshold, effective_from, state, created_by, updated_by)
     values ($1, 'DEFAULT', 1, 'INR', 30, 50000, '2000-01-01', 'DRAFT', $2, $2) on conflict (company_id, code, revision) do nothing`,
    [opts.companyId, opts.approvedBy],
  );
  for (const c of BASELINE_EXPENSE_CATEGORIES) {
    const categoryId =
      (
        await db.query<{ id: string }>(
          `insert into expense_category (company_id, code, name, limit_basis, active, created_by, updated_by) values ($1, $2, $3, $4, true, $5, $5)
           on conflict (company_id, code) do update set name = excluded.name, updated_by = excluded.updated_by
            where expense_category.name is distinct from excluded.name
           returning id`,
          [opts.companyId, c.code, c.name, c.limitBasis, opts.approvedBy],
        )
      ).rows[0]?.id ??
      (await db.query<{ id: string }>(`select id from expense_category where company_id = $1 and code = $2`, [opts.companyId, c.code])).rows[0]!.id;
    // Category limits are part of the draft policy; an activated policy is frozen.
    await db.query(
      `insert into expense_policy_rule (company_id, policy_id, category_id, limit_amount, receipt_required, created_by, updated_by)
       select ep.company_id, ep.id, $2, $3::numeric, true, $4, $4
         from expense_policy ep
        where ep.company_id = $1 and ep.code = 'DEFAULT' and ep.revision = 1 and ep.state = 'DRAFT'
       on conflict do nothing`,
      [opts.companyId, categoryId, c.limit, opts.approvedBy],
    );
  }
  // DF03/DF06 expense route: direct manager -> independent financial Admin -> high-value Admin above the threshold.
  await ensureRoute(db, opts, permissionId, 'expense_claim', [
    { sequence: 1, permission: 'expense.manager_decide.operational', rule: 'DIRECT_MANAGER' },
    { sequence: 2, permission: 'expense.finance_decide.operational', rule: 'HR_FALLBACK_LIST' },
    { sequence: 3, permission: 'expense.high_value_decide.operational', rule: 'HR_FALLBACK_LIST', condition: 'EXPENSE_HIGH_VALUE' },
  ]);

  // F2 / DF17 role home dashboards: one active HOME definition per baseline role; widgets ensured on their code.
  for (const role of BASELINE_ROLES) {
    const spec = dashboardFor(role.code, role.name);
    await db.query(
      `insert into role_dashboard_definition (company_id, role_id, dashboard_code, revision, title, state, created_by, updated_by)
       select $1, r.id, 'HOME', 1, $3, 'ACTIVE', $4, $4 from role r where r.company_id = $1 and r.code = $2
       on conflict (company_id, role_id, dashboard_code, revision) do nothing`,
      [opts.companyId, role.code, spec.title, opts.approvedBy],
    );
    let position = 0;
    for (const w of spec.widgets) {
      const { fieldGroup } = widgetPermission(w.permission);
      await db.query(
        `insert into role_dashboard_widget (company_id, dashboard_id, permission_id, widget_code, position, title, metric_code, field_group, scope_rule, display_kind, created_by, updated_by)
         select d.company_id, d.id, $3, $4, $5, $6, $7, $8, 'ASSIGNMENT_SCOPE', $9, $10, $10
           from role_dashboard_definition d
           join role r on r.company_id = d.company_id and r.id = d.role_id and r.code = $2
          where d.company_id = $1 and d.dashboard_code = 'HOME' and d.revision = 1
         on conflict do nothing`,
        [opts.companyId, role.code, permissionId(w.permission), w.code, position++, w.title, w.metric, fieldGroup, w.kind, opts.approvedBy],
      );
    }
  }

  // Approval routes of registered business modules (modules/registry.ts), ensured like the core routes.
  for (const m of MODULE_REGISTRATIONS) {
    for (const w of m.workflows ?? []) {
      await ensureRoute(
        db,
        opts,
        permissionId,
        w.kind,
        w.steps.map((s) => ({ sequence: s.sequence, permission: s.permission, rule: s.selectionRule, ...(s.conditionCode ? { condition: s.conditionCode } : {}) })),
      );
    }
  }

  // DF12 notifications, core and module: each rule is ensured on its own key and pinned to revision 1 of its template.
  // The core increment module's DF15 review reminders (30/7/1 days before the decision due date) are core templates too.
  for (const n of [...BASELINE_NOTIFICATIONS, ...INCREMENT_REVIEW_NOTIFICATIONS, ...EVENT_NOTICE_CATALOGUE, ...MODULE_REGISTRATIONS.flatMap((m) => m.notifications ?? [])]) {
    await db.query(
      `insert into notification_template (company_id, code, revision, language, channel, subject_template, body_template, approved_placeholders, active, created_by, updated_by)
       values ($1, $2, 1, 'en', 'IN_APP', $3, $4, $5, true, $6, $6) on conflict (company_id, code, revision, language, channel) do nothing`,
      [opts.companyId, n.code, n.subject, n.body, n.placeholders, opts.approvedBy],
    );
    await db.query(
      `insert into notification_rule (company_id, code, revision, event_type, channel, recipient_selector, template_code, template_revision, template_id,
                                      optional_event, effective_from, active, created_by, updated_by)
       select t.company_id, t.code, 1, $3, 'IN_APP', $4, t.code, 1, t.id, $5, $6::date, true, $7, $7
         from notification_template t
        where t.company_id = $1 and t.code = $2 and t.revision = 1 and t.language = 'en' and t.channel = 'IN_APP'
       on conflict (company_id, code, revision) do nothing`,
      [opts.companyId, n.code, n.eventType, n.selector, n.optional, opts.effectiveFrom, opts.approvedBy],
    );
  }

  const ap = BASELINE_ATTENDANCE_POLICY;
  await db.query(
    `insert into attendance_policy (company_id, code, revision, effective_from, grace_minutes, present_percent, half_day_percent,
                                    overtime_enabled, state, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8, 'DRAFT', $9, $9)
     on conflict (company_id, code, revision) do nothing`,
    [opts.companyId, ap.code, ap.revision, opts.effectiveFrom, ap.graceMinutes, ap.presentPercent, ap.halfDayPercent, ap.overtimeEnabled, opts.approvedBy],
  );
  // The company-wide mapping is part of the draft policy; an activated policy is frozen.
  await db.query(
    `insert into attendance_policy_mapping (company_id, policy_id, created_by, updated_by)
     select p.company_id, p.id, $4, $4 from attendance_policy p
      where p.company_id = $1 and p.code = $2 and p.revision = $3 and p.state = 'DRAFT'
     on conflict do nothing`,
    [opts.companyId, ap.code, ap.revision, opts.approvedBy],
  );

  for (const { resource, fieldGroup } of OPERATIONAL_FIELD_GROUPS) {
    await db.query(
      `insert into confidential_field_policy
         (company_id, resource_code, field_group, classification, effective_from, approved_by, approved_at, created_by)
       select $1, $2, $3, 'OPERATIONAL', $4, $5, now(), $5
        where not exists (select 1 from confidential_field_policy
                           where company_id = $1 and resource_code = $2 and field_group = $3)`,
      [opts.companyId, resource, fieldGroup, opts.effectiveFrom, opts.approvedBy],
    );
  }
}
