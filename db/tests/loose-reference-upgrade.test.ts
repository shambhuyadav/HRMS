// Upgrade behaviour of 0150 and 0151: a stored row that breaks a new key never stops the migration and is never changed. That one key
// stays NOT VALID and still applies to new and changed rows, and a clean table's key validates. The new trigger does not re-judge a
// stored event when a run merely sees it again. Synthetic data only.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { insertRow, type TableShape, tableShapes } from './catalogue.fixtures.js';
import { FK_VIOLATION } from './fixtures.js';
import { startEmptyTestDatabase, type TestDatabase } from './test-database.js';

describe('0150 and 0151 on a database that already holds rows', () => {
  let old: TestDatabase;
  let db: pg.Client;
  let shapes: Map<string, TableShape>;
  const company = randomUUID();
  const foreignCompany = randomUUID();
  const [employee, user] = [randomUUID(), randomUUID()];
  const [policy, request, revision] = [randomUUID(), randomUUID(), randomUUID()];
  const [run, otherPeriod, ownPeriod, record, attachment, output] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const [template, batch] = [randomUUID(), randomUUID()];
  const [profile, mapping, syncRun, punch, event] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const HASH = 'a'.repeat(64);
  const instant = '2026-04-01T09:00:00.000Z';
  const put = (table: string, values: Record<string, string | null>) => insertRow(db, shapes, table, { company_id: company, ...values });

  beforeAll(async () => {
    const empty = await startEmptyTestDatabase();
    if (!empty) throw new Error('An upgrade test needs TEST_PG_ADMIN_URL');
    old = empty;
    db = old.client;
    await migrate(db, { before: '0150' });
    shapes = await tableShapes(db);
    await db.query('set session_replication_role = replica');
    await db.query(`insert into company (id, code, name, active) values ($1, 'UP_A', 'Synthetic', true), ($2, 'UP_B', 'Synthetic', true)`, [company, foreignCompany]);
    // A revision naming another company's policy.
    await put('leave_policy', { id: policy, company_id: foreignCompany, leave_type_id: randomUUID(), revision: '1', effective_from: '2026-01-01', eligibility_code: 'ALL', accrual_rule_code: 'NONE', annual_entitlement: '0', state: 'DRAFT' });
    await put('leave_request', { id: request, employee_id: employee, leave_type_id: randomUUID(), policy_id: policy, transaction_id: randomUUID(), start_date: '2026-02-02', end_date: '2026-02-02', requested_units: '1', state: 'SUBMITTED' });
    await put('leave_request_revision', { id: revision, request_id: request, revision: '1', policy_id: policy, start_date: '2026-02-02', end_date: '2026-02-02', half_day: 'false', requested_units: '1' });
    // A payslip naming a period that is not its run's.
    await put('payroll_run', {
      id: run, calendar_id: randomUUID(), period_id: ownPeriod, lineage_id: run, revision: '1', transaction_id: randomUUID(), state: 'DRAFT', scope_token: HASH, service_start: '2026-01-01', service_end: '2026-01-31', input_cutoff: '2026-01-25', payment_date: '2026-01-31', days_in_month: '31', currency_code: 'INR', currency_minor_unit: '2', member_count: '0',
    });
    await put('employee_issued_output', {
      id: output, employee_id: employee, kind: 'PAYSLIP', period_id: otherPeriod, period_code: '2026-01', output_version: '1', payroll_record_id: record, run_id: run, publication_state: 'ISSUED', attachment_id: attachment, content_hash: HASH, file_name: 'payslip.json', issued_at: '2026-02-01T00:00:00Z', issued_by: user, supersedes_output_id: null, supersession_reason: null,
    });
    // A manifest in another currency than its template.
    await put('payroll_bank_template', { id: template, template_code: 'UP_TEMPLATE', template_version: '1', name: 'Synthetic', currency_code: 'USD', format_definition: '{}', definition_hash: HASH, bank_specification_reference: 'spec', test_only: 'true', state: 'DRAFT' });
    await put('payroll_bank_batch', { id: batch, run_id: run, template_id: template, batch_revision: '1', currency_code: 'INR', payment_date: '2026-01-31', state: 'VALIDATED', line_count: '1', total_amount: '1', manifest_hash: HASH, prepared_by: user, supersedes_batch_id: null });
    // An accepted event with no link behind it.
    await put('biometric_profile', { id: profile, code: 'UP_PROFILE', name: 'Synthetic', request_config_reference: 'config', auth_reference: 'auth', provider_timezone: 'UTC', pagination_mode: 'CURSOR', schedule_reference: 'schedule', lookback_minutes: '60', active: 'true' });
    await put('biometric_mapping_revision', { id: mapping, profile_id: profile, revision: '1', effective_from: '2026-01-01T00:00:00Z', dedupe_strategy: 'PROVIDER_EVENT_KEY', timestamp_rule: 'ISO_WITH_OFFSET' });
    await put('biometric_sync_run', { id: syncRun, profile_id: profile, mapping_revision_id: mapping, window_start: '2026-01-01T00:00:00Z', window_end: '2026-01-02T00:00:00Z', state: 'RUNNING', finished_at: null });
    await put('attendance_punch', { id: punch, employee_id: employee, occurred_at: instant, direction: 'IN', source_kind: 'BIOMETRIC_API', source_identity_key: 'up-1', biometric_profile_id: profile });
    await put('biometric_ingest_event', { id: event, profile_id: profile, first_run_id: syncRun, latest_run_id: syncRun, mapping_revision_id: mapping, source_event_key: 'up-key', fingerprint: 'fp', external_employee_key: 'NOBODY', employee_id: employee, normalised_time: instant, direction: 'IN', punch_id: punch, state: 'ACCEPTED' });
    await db.query('set session_replication_role = origin');
    await migrate(db);
  }, 180_000);

  afterAll(async () => {
    await old?.stop();
  });

  const validated = async (name: string) => (await db.query<{ convalidated: boolean }>(`select convalidated from pg_constraint where conname = $1`, [name])).rows[0]!.convalidated;

  it('both applied', async () => {
    expect((await db.query(`select 1 from schema_migration where filename like '0150%' or filename like '0151%'`)).rowCount).toBe(2);
  });

  it('keeps the stored rows as they were', async () => {
    expect((await db.query<{ policy_id: string }>(`select policy_id from leave_request_revision where id = $1`, [revision])).rows[0]!.policy_id).toBe(policy);
    expect((await db.query<{ period_id: string }>(`select period_id from employee_issued_output where id = $1`, [output])).rows[0]!.period_id).toBe(otherPeriod);
    expect((await db.query<{ currency_code: string }>(`select currency_code from payroll_bank_batch where id = $1`, [batch])).rows[0]!.currency_code).toBe('INR');
  });

  it('leaves only the keys those rows break unvalidated', async () => {
    expect(await validated('leave_request_revision_policy_company_fk')).toBe(false);
    expect(await validated('employee_issued_output_run_period_fk')).toBe(false);
    expect(await validated('payroll_bank_batch_template_currency_fk')).toBe(false);
    expect(await validated('payroll_bank_batch_run_currency_fk')).toBe(true);
    expect(await validated('attendance_record_shift_revision_company_fk')).toBe(true);
    expect(await validated('payroll_bank_line_record_currency_fk')).toBe(true);
  });

  it('a NOT VALID key still applies to new rows', async () => {
    await db.query('begin');
    try {
      await expect(
        db.query(`insert into leave_request_revision (company_id, request_id, revision, policy_id, start_date, end_date, half_day, requested_units) values ($1, $2, 2, $3, '2026-02-03', '2026-02-03', false, 1)`, [company, request, policy]),
      ).rejects.toMatchObject({ code: FK_VIOLATION, constraint: 'leave_request_revision_policy_company_fk' });
    } finally {
      await db.query('rollback');
    }
  });

  it('a stored event with no link is not re-judged when a run merely sees it again', async () => {
    await db.query('begin');
    try {
      await expect(db.query(`update biometric_ingest_event set latest_run_id = latest_run_id where id = $1`, [event])).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await db.query('rollback');
    }
  });
});
