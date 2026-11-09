// Upgrade behaviour of 0195-0197 (I-83, decided under owner delegation, 6 Nov 2026) on a database that already holds a company: it gets
// its first dated reporting setting, the two new resources are classified operational under its employee policy's approver, the two
// finance roles and HR gain the new ceilings (no assignment changes), the ordinary finance roles' widgets move to the state metrics,
// and a widget the company had pointed elsewhere is left alone. Synthetic data only.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { startEmptyTestDatabase, type TestDatabase } from './test-database.js';

describe('0195-0197 on a database with an existing company', () => {
  let old: TestDatabase;
  let db: pg.Client;
  let company: string;
  let approver: string;

  beforeAll(async () => {
    const empty = await startEmptyTestDatabase();
    if (!empty) throw new Error('An upgrade test needs TEST_PG_ADMIN_URL');
    old = empty;
    db = old.client;
    await migrate(db, { before: '0195' });
    await db.query('set session_replication_role = replica');
    company = (await db.query<{ id: string }>(`insert into company (code, name, active) values ('UP_REP', 'Synthetic', true) returning id`)).rows[0]!.id;
    approver = (await db.query<{ id: string }>(`insert into user_account (account_key, active) values ('up.rep.approver', true) returning id`)).rows[0]!.id;
    await db.query(
      `insert into confidential_field_policy (company_id, resource_code, field_group, classification, effective_from, approved_by, approved_at, created_by)
       values ($1, 'employee', 'operational', 'OPERATIONAL', '2026-01-01', $2, now(), $2)`,
      [company, approver],
    );
    const dashboard = (await db.query<{ id: string }>(`select id from permission where resource = 'dashboard' and action = 'read' and field_group = 'operational'`)).rows[0]!.id;
    const widgets: Record<string, [string, string][]> = {
      FINANCE_REVIEWER: [['EXPENSE_REVIEW_TASKS', 'EXPENSE_REVIEW_TASKS']],
      // The company had pointed RETURNED elsewhere: left alone.
      EXPENSE_FINANCE_APPROVER: [['FINAL_DECISIONS', 'EXPENSE_FINAL_DECISION_TASKS'], ['LATE_RECEIPT', 'EXPENSE_LATE_RECEIPT_EXCEPTIONS'], ['RETURNED', 'MY_OPEN_TASKS']],
      PAYROLL_APPROVER: [['REVIEW_TASKS', 'PAYROLL_REVIEW_TASKS'], ['OVERDUE_REVIEWS', 'PAYROLL_REVIEW_TASKS_OVERDUE']],
      HR_ADMINISTRATOR: [],
      TREASURY_APPROVER: [],
    };
    for (const [code, list] of Object.entries(widgets)) {
      const role = (await db.query<{ id: string }>(`insert into role (company_id, code, name, active, access_class) values ($1, $2, $2, true, $3) returning id`, [company, code, code === 'HR_ADMINISTRATOR' ? 'ADMIN' : 'OTHER'])).rows[0]!.id;
      const def = (await db.query<{ id: string }>(`insert into role_dashboard_definition (company_id, role_id, dashboard_code, revision, title, state) values ($1, $2, 'HOME', 1, 'Synthetic', 'ACTIVE') returning id`, [company, role])).rows[0]!.id;
      for (const [i, [widget, metric]] of list.entries()) {
        await db.query(
          `insert into role_dashboard_widget (company_id, dashboard_id, permission_id, widget_code, position, title, metric_code, field_group, scope_rule, display_kind)
           values ($1, $2, $3, $4, $5, 'Old title', $6, 'operational', 'ASSIGNMENT_SCOPE', 'COUNT')`,
          [company, def, dashboard, widget, i, metric],
        );
      }
    }
    await db.query('set session_replication_role = origin');
    await migrate(db);
  }, 180_000);

  afterAll(async () => {
    await old?.stop();
  });

  it('applies all three', async () => {
    expect((await db.query(`select filename from schema_migration where filename between '0195' and '0198' order by 1`)).rows.map((r) => r.filename)).toEqual([
      '0195_finance_approver_record_scopes.sql',
      '0196_reporting_settings.sql',
      '0197_finance_role_widgets.sql',
    ]);
  });

  it('the existing company starts with the delegated defaults, written by the system actor', async () => {
    expect((await db.query(`select effective_from::text, effective_to, small_count_threshold, recent_activity_days, salary_progression_years, created_by from reporting_setting where company_id = $1`, [company])).rows).toEqual([
      { effective_from: '2000-01-01', effective_to: null, small_count_threshold: 5, recent_activity_days: 14, salary_progression_years: 5, created_by: '00000000-0000-4000-8000-000000000001' },
    ]);
  });

  it('the new resources are operational under the employee policy’s approver, and the ceilings are added without any assignment', async () => {
    const classified = (await db.query(`select resource_code, classification, approved_by from confidential_field_policy where company_id = $1 and resource_code in ('reporting_setting', 'expense_state') order by 1`, [company])).rows;
    expect(classified).toEqual([
      { resource_code: 'expense_state', classification: 'OPERATIONAL', approved_by: approver },
      { resource_code: 'reporting_setting', classification: 'OPERATIONAL', approved_by: approver },
    ]);
    const ceilings = (
      await db.query(
        `select r.code, p.resource || '.' || p.action || '.' || p.field_group as key from role_permission rp join role r on r.id = rp.role_id join permission p on p.id = rp.permission_id
          where rp.company_id = $1 and p.resource in ('reporting_setting', 'expense_state') order by 1, 2`,
        [company],
      )
    ).rows;
    expect(ceilings).toEqual([
      { code: 'EXPENSE_FINANCE_APPROVER', key: 'expense_state.read.operational' },
      { code: 'FINANCE_REVIEWER', key: 'expense_state.read.operational' },
      { code: 'HR_ADMINISTRATOR', key: 'reporting_setting.manage.operational' },
    ]);
    expect((await db.query(`select 1 from role_assignment where company_id = $1`, [company])).rowCount).toBe(0);
  });

  it('the finance widgets count states now; the one the company had changed is as it was', async () => {
    const rows = (
      await db.query(
        `select r.code, w.widget_code, w.metric_code, w.title from role_dashboard_widget w join role_dashboard_definition d on d.id = w.dashboard_id join role r on r.id = d.role_id
          where w.company_id = $1 order by 1, 2`,
        [company],
      )
    ).rows;
    expect(rows).toEqual([
      { code: 'EXPENSE_FINANCE_APPROVER', widget_code: 'FINAL_DECISIONS', metric_code: 'EXPENSE_CLAIMS_AWAITING_FINAL', title: 'Claims awaiting a final decision' },
      { code: 'EXPENSE_FINANCE_APPROVER', widget_code: 'LATE_RECEIPT', metric_code: 'EXPENSE_CLAIMS_LATE_RECEIPT', title: 'Late or missing-receipt claims awaiting a final decision' },
      { code: 'EXPENSE_FINANCE_APPROVER', widget_code: 'RETURNED', metric_code: 'MY_OPEN_TASKS', title: 'Old title' },
      { code: 'FINANCE_REVIEWER', widget_code: 'EXPENSE_REVIEW_TASKS', metric_code: 'EXPENSE_CLAIMS_IN_REVIEW', title: 'Claims in expense review' },
      { code: 'PAYROLL_APPROVER', widget_code: 'OVERDUE_REVIEWS', metric_code: 'PAYROLL_RUNS_IN_REVIEW_OVERDUE', title: 'Runs in review past the payment date' },
      { code: 'PAYROLL_APPROVER', widget_code: 'REVIEW_TASKS', metric_code: 'PAYROLL_RUNS_IN_REVIEW', title: 'Runs awaiting review or approval' },
    ]);
  });

  it('0195: both approver roles may now hold an organisation scope, and still nothing wider than C2 gives them', async () => {
    for (const role of ['TREASURY_APPROVER', 'EXPENSE_FINANCE_APPROVER']) {
      expect((await db.query<{ s: string[] }>(`select hrms_role_record_scopes($1) as s`, [role])).rows[0]!.s, role).toEqual(['ASSIGNED', 'COMPANY']);
    }
  });
});
