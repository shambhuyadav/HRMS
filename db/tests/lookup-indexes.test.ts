// Lookup indexes (migration 0144; BRD line 4497). A static check of the catalogue: this is a schema fact, not a measurement, and
// it names no speed. It also holds later migrations to the rule: a new (company_id, employee_id) foreign key needs its index.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './test-database.js';

const EMPLOYEE_TABLES = [
  'attachment', 'attendance_correction_request', 'attendance_processing_failure', 'attendance_processing_no_policy', 'biometric_employee_link', 'biometric_ingest_event',
  'employee_confirmation', 'employee_document', 'employee_increment_plan', 'exit_case', 'expense_claim', 'holiday_work_request', 'increment_plan_change', 'increment_review_exclusion',
  'leave_request', 'mobile_app_link', 'outdoor_duty_request', 'payment_instruction', 'payroll_input', 'payroll_salary_stop', 'profile_change_request', 'role_scope_filter', 'tax_declaration',
];
const OTHER_PATHS: [string, string[]][] = [
  ['notification_event', ['company_id', 'subject_employee_id']],
  ['payroll_input_batch', ['company_id', 'period_id', 'state']],
  ['payment_instruction', ['company_id', 'batch_id']],
  ['attendance_amendment', ['company_id', 'attendance_record_id']],
  ['notification', ['company_id', 'transaction_id']],
  ['notification_event', ['company_id', 'transaction_id']],
  ['expense_line_decision', ['company_id', 'approval_decision_id']],
  ['increment_history', ['company_id', 'approval_decision_id']],
  // Already covered by 0088; held here so the path stays covered.
  ['payment_allocation', ['company_id', 'obligation_id']],
  ['payment_event', ['company_id', 'instruction_id']],
];

describe('lookup indexes', () => {
  let testDb: TestDatabase;
  let db: pg.Client;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    db = testDb.client;
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  /** The leading columns of every whole-table, valid index of a table. */
  const indexesOf = async (table: string) =>
    (
      await db.query<{ cols: string[] }>(
        `select (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
                  join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) as cols
           from pg_index i where i.indrelid = to_regclass($1) and i.indisvalid and i.indpred is null`,
        [table],
      )
    ).rows.map((r) => r.cols);
  const led = (index: string[], columns: string[]) => columns.every((c, i) => index[i] === c);

  it.each(EMPLOYEE_TABLES)('%s can be read by employee', async (table) => {
    expect((await indexesOf(table)).some((i) => led(i, ['company_id', 'employee_id']))).toBe(true);
  });

  it.each(OTHER_PATHS)('%s has its path %j', async (table, columns) => {
    expect((await indexesOf(table)).some((i) => led(i, columns))).toBe(true);
  });

  it('holds every (company_id, employee_id) foreign key to the rule, later tables included', async () => {
    const pairs = (
      await db.query<{ t: string }>(
        `select con.conrelid::regclass::text as t
           from pg_constraint con
          where con.contype = 'f' and con.connamespace = 'public'::regnamespace
            and (select array_agg(a.attname::text order by k.ord) from unnest(con.conkey) with ordinality k(attnum, ord)
                   join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) = array['company_id', 'employee_id']`,
      )
    ).rows.map((r) => r.t);
    expect(pairs.length).toBeGreaterThan(EMPLOYEE_TABLES.length);
    const missing: string[] = [];
    for (const t of pairs) {
      if (!(await indexesOf(t)).some((i) => led(i, ['company_id', 'employee_id']))) missing.push(t);
    }
    expect(missing).toEqual([]);
  });
});
