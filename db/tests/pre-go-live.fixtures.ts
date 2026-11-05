// Stored rows for db/tests/pre-go-live-check.test.ts: one that breaks each rule and, beside it, one that keeps it. Call on a database
// migrated to just before 0140, then upgrade it. Written in replication mode, as a row from before a guard would stand, with parents
// of no interest left out. Synthetic data only.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { insertRow, tableShapes } from './catalogue.fixtures.js';

export const PERSON = 'Synthetic Person Marker';
export const PERSON_CODE = 'GL-MISSING';
export const RUN_KEY = 'SYNTHETIC-KEY-MARKER';

export type BadRows = Record<
  | 'ownerApart'
  | 'stateApart'
  | 'rootless'
  | 'headBinding'
  | 'lineage'
  | 'confirmationAction'
  | 'historyDecision'
  | 'historyBasis'
  | 'receipt'
  | 'subject'
  | 'currency'
  | 'creatorNotRecorded'
  | 'creatorMissing'
  | 'account'
  | 'policyCompany'
  | 'manifest'
  | 'event'
  | 'segmentCurrency',
  string
>;

export interface Planted {
  company: string;
  foreignCompany: string;
  bad: BadRows;
  /** A calculated record keeping the 0172 rule, with real parents, so a write after the upgrade reaches that guard and no other. */
  keptRecord: { id: string; employee: string; salary: string };
}

export async function plantStoredRows(db: pg.ClientBase): Promise<Planted> {
  const shapes = await tableShapes(db);
  const company = randomUUID();
  const foreignCompany = randomUUID();
  const actor = randomUUID();
  const HASH = 'a'.repeat(64);
  let decisions = 0;

  const newEmployee = () => randomUUID();
  /** A row of `table` with a known id. */
  const row = async (table: string, values: Record<string, string | null>) => {
    const id = randomUUID();
    await insertRow(db, shapes, table, { company_id: company, id, ...values });
    return id;
  };
  const transaction = (kind: string, owner: string | null, state: string) => row('business_transaction', { kind, owner_employee_id: owner, state });
  const claim = async (employee: string, owner = employee, transactionState = 'DRAFT') =>
    row('expense_claim', { employee_id: employee, transaction_id: await transaction('expense_claim', owner, transactionState), purpose: 'Synthetic', currency_code: 'INR', current_revision: '1', state: 'DRAFT', payment_state: 'NOT_APPLICABLE' });
  const decisionOf = async (kind: string, txn: string) => {
    const instance = await row('approval_instance', { transaction_kind: kind, transaction_id: txn, transaction_revision: String(++decisions), workflow_id: randomUUID(), state: 'APPROVED' });
    const task = await row('approval_task', { instance_id: instance, workflow_id: randomUUID(), step_id: randomUUID(), assignee_user_id: actor, state: 'PENDING' });
    return row('approval_decision', { task_id: task, actor_user_id: actor, acting_assignment_id: randomUUID(), decision: 'APPROVE', expected_version: '1', idempotency_key: `go-live-${randomUUID()}` });
  };

  await db.query('set session_replication_role = replica');
  try {
    await db.query(`insert into company (id, code, name, active) values ($1, 'GL_A', 'Synthetic', true), ($2, 'GL_B', 'Synthetic', true)`, [company, foreignCompany]);

    // 0142: a root and its transaction with different owners, in different states, and a transaction with no root.
    const ownerApart = await claim(newEmployee(), newEmployee());
    const stateApart = await claim(newEmployee(), undefined, 'WITHDRAWN');
    const rootless = await transaction('leave_request', newEmployee(), 'SUBMITTED');

    // 0140: a line naming a head revision of another component, and a second revision whose first is in another period.
    const [component, otherComponent] = [randomUUID(), randomUUID()];
    const head = await row('payroll_head_revision', { component_id: component, revision: '1', effective_from: '2020-01-01', in_use: 'true', head_type: 'EARNING', calculation_basis: 'FIXED', rounding_rule: 'HALF_UP_MINOR_UNIT', tax_treatment_id: randomUUID(), display_sequence: '1', state: 'ACTIVE', activated_by: actor, activated_at: '2026-01-01T00:00:00Z' });
    const line = (forComponent: string) => row('payroll_line', { record_id: randomUUID(), component_id: forComponent, head_revision_id: head, head_type: 'EARNING', calculation_basis: 'FIXED', amount: '1', rule_version: 'old' });
    const headBinding = await line(otherComponent);
    await line(component);
    const run = (id: string, lineage: string, revision: string, supersedes: string | null, period: string, calendar: string) =>
      insertRow(db, shapes, 'payroll_run', {
        company_id: company, id, lineage_id: lineage, revision, supersedes_run_id: supersedes, period_id: period, calendar_id: calendar, transaction_id: randomUUID(), state: 'CANCELLED', scope_token: HASH, service_start: '2026-04-01', service_end: '2026-04-30', input_cutoff: '2026-04-30', payment_date: '2026-04-30', days_in_month: '30', currency_code: 'INR', currency_minor_unit: '2', member_count: '0', closed_at: '2026-05-01T00:00:00Z', close_reason: 'Synthetic',
      });
    const [firstBad, firstGood, secondGood, lineage] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const [period, calendar] = [randomUUID(), randomUUID()];
    await run(firstBad, firstBad, '1', null, randomUUID(), calendar);
    await run(lineage, firstBad, '2', firstBad, randomUUID(), calendar);
    await run(firstGood, firstGood, '1', null, period, calendar);
    await run(secondGood, firstGood, '2', firstGood, period, calendar);

    // 0143: rows from before the provenance guards.
    const confirmationCase = async () => {
      const employee = newEmployee();
      const txn = await transaction('employee_confirmation', employee, 'OPEN');
      const id = await row('employee_confirmation', { employee_id: employee, policy_id: randomUUID(), transaction_id: txn, start_date: '2026-01-01', initial_due_date: '2026-07-01', current_due_date: '2026-07-01', state: 'OPEN' });
      return { id, txn, employee };
    };
    const action = (c: { id: string; employee: string }, decision: string) =>
      row('confirmation_action', { confirmation_id: c.id, employee_id: c.employee, approval_decision_id: decision, action: 'RETURNED', prior_due_date: '2026-07-01', new_due_date: '2026-07-01', reason: 'Synthetic' });
    const [mineCase, otherCase] = [await confirmationCase(), await confirmationCase()];
    const confirmationAction = await action(mineCase, await decisionOf('employee_confirmation', otherCase.txn));
    await action(otherCase, await decisionOf('employee_confirmation', otherCase.txn));

    const arrangement = (employee: string, from: string, to: string | null) => row('salary_arrangement', { employee_id: employee, effective_from: from, effective_to: to, annual_ctc: '12', monthly_gross: '1', currency_code: 'INR' });
    const incrementCase = async () => {
      const employee = newEmployee();
      const txn = await transaction('increment_case', employee, 'SUBMITTED');
      const baseline = await arrangement(employee, '2026-01-01', '2026-04-01');
      const id = await row('increment_case', { employee_id: employee, transaction_id: txn, cycle_occurrence_key: randomUUID(), off_cycle: 'true', prepared_by: actor, baseline_salary_id: baseline, applied_salary_id: null, compensation_basis: 'MONTHLY_GROSS', currency_code: 'INR', baseline_amount: '1', proposed_effective_date: '2026-04-01', state: 'SUBMITTED', reason: 'Synthetic' });
      return { id, txn, baseline, employee };
    };
    const history = async (c: { id: string; baseline: string; employee: string }, decision: string, basis = 'MONTHLY_GROSS') =>
      row('increment_history', { employee_id: c.employee, case_id: c.id, approval_decision_id: decision, old_salary_id: c.baseline, new_salary_id: await arrangement(c.employee, '2026-04-01', null), effective_date: '2026-04-01', compensation_basis: basis, currency_code: 'INR', before_amount: '1', after_amount: '2', change_amount: '1', change_percent: '100', reason: 'Synthetic', applied_by: actor });
    const [wrongDecision, wrongBasis, rightCase] = [await incrementCase(), await incrementCase(), await incrementCase()];
    const historyDecision = await history(wrongDecision, await decisionOf('increment_case', rightCase.txn));
    const historyBasis = await history(wrongBasis, await decisionOf('increment_case', wrongBasis.txn), 'ANNUAL_CTC');
    await history(rightCase, await decisionOf('increment_case', rightCase.txn));

    // 0172: a calculated record with a segment in another currency. In its own currency, or on a record that failed, there is nothing to report.
    // Under a draft whose calculation has started, the only state in which a later segment gets past the snapshot guard to 0172.
    const draftRun = randomUUID();
    await insertRow(db, shapes, 'payroll_run', {
      company_id: company, id: draftRun, lineage_id: draftRun, revision: '1', supersedes_run_id: null, period_id: randomUUID(), calendar_id: randomUUID(), transaction_id: randomUUID(), state: 'DRAFT', scope_token: HASH, service_start: '2026-04-01', service_end: '2026-04-30', input_cutoff: '2026-04-30', payment_date: '2026-04-30', days_in_month: '30', currency_code: 'INR', currency_minor_unit: '2', member_count: '0', calculation_started_at: '2026-05-01T00:00:00Z', calculated_by: actor, attendance_basis: 'NOT_CONFIGURED', head_count: '0',
    });
    const recordWith = async (status: 'CALCULATED' | 'FAILED', segmentCurrency: string) => {
      const employee = newEmployee();
      const salary = await arrangement(employee, '2026-01-01', null);
      const figures = status === 'CALCULATED' ? { salary_arrangement_id: salary, paid_units: '30', earnings: '0', reimbursements: '0', gross: '0', deductions: '0', net: '0', employer_contributions: '0' } : {};
      const id = await row('payroll_record', { run_id: draftRun, employee_id: employee, employee_code: 'GL-PAY', joining_date: '2026-01-01', status_code: 'ACTIVE_CONFIRMED', calculation_status: status, currency_code: 'INR', days_in_month: '30', created_by: actor, ...figures });
      await row('payroll_record_segment', { record_id: id, employee_id: employee, salary_arrangement_id: salary, segment_start: '2026-04-01', segment_end: '2026-04-30', calendar_days: '30', leave_lop_units: '0', attendance_lop_units: '0', paid_days: '30', currency_code: segmentCurrency, created_by: actor });
      return { id, employee, salary };
    };
    const segmentCurrency = (await recordWith('CALCULATED', 'USD')).id;
    const keptRecord = await recordWith('CALCULATED', 'INR');
    await recordWith('FAILED', 'USD');

    const lineOf = async (employee: string) => {
      const revision = await row('expense_revision', { claim_id: await claim(employee), revision: '1', currency_code: 'INR', purpose: 'Synthetic' });
      return row('expense_line', { revision_id: revision, sequence: '1', category_id: randomUUID(), expense_date: '2026-01-01', merchant: 'Synthetic', gross_amount: '1', claimed_amount: '1', description: 'Synthetic', fingerprint: 'synthetic' });
    };
    const file = (employee: string | null) => row('attachment', { owner_user_id: actor, employee_id: employee, content_reference: `go-live-${randomUUID()}`, media_type: 'application/pdf', checksum: HASH });
    const claimant = newEmployee();
    const receipt = await row('expense_receipt', { line_id: await lineOf(claimant), attachment_id: await file(newEmployee()) });
    await row('expense_receipt', { line_id: await lineOf(claimant), attachment_id: await file(claimant) });

    const owner = newEmployee();
    const ownedTxn = await transaction('payroll_run', owner, 'DRAFT');
    const event = (subject: string | null, txn: string | null) => row('notification_event', { event_key: `go-live-${randomUUID()}`, event_type: 'SYNTHETIC', subject_employee_id: subject, transaction_id: txn, occurrence_date: '2026-01-01', business_timezone: 'Asia/Kolkata' });
    const subject = await event(newEmployee(), ownedTxn);
    await event(owner, ownedTxn);
    await event(null, ownedTxn);
    await event(newEmployee(), null);

    // 0145: a payment in a currency outside the approved codes.
    const payment = (currency: string) => row('payment_batch', { transaction_id: randomUUID(), state: 'DRAFT', prepared_by: actor, currency_code: currency });
    const currency = await payment('USD');
    await payment('INR');

    // 0146: a table it backfills and a table it does not; a record with personal values, to prove they are not printed.
    const policy = (code: string, creator: string | null) => row('expense_policy', { code, revision: '1', currency_code: 'INR', submission_window_days: '30', high_value_threshold: '100', effective_from: '2026-01-01', state: 'DRAFT', created_by: creator });
    const creatorNotRecorded = await policy('GL_OLD', null);
    await policy('GL_KEPT', actor);
    const creatorMissing = await row('employee', { employee_code: PERSON_CODE, display_name: PERSON, joining_date: '2026-01-01', employment_type_id: randomUUID(), status_id: randomUUID(), created_by: null });
    await row('employee', { employee_code: 'GL-KEPT', display_name: 'Synthetic', joining_date: '2026-01-01', employment_type_id: randomUUID(), status_id: randomUUID(), created_by: actor });
    const account = randomUUID();
    await db.query(`insert into user_account (id, account_key, active, created_by) values ($1, 'go.live.nobody', true, null), ($2, 'go.live.someone', true, $1)`, [account, actor]);

    // A key with no uuid in it: no id can be printed, only the count.
    await db.query(`insert into scheduled_job_run (run_key, job_code, company_id) values ($1, 'SYNTHETIC', $2)`, [RUN_KEY, randomUUID()]);

    // 0150: a revision naming another company's policy.
    const leavePolicy = (forCompany: string) => row('leave_policy', { company_id: forCompany, leave_type_id: randomUUID(), revision: '1', effective_from: '2026-01-01', eligibility_code: 'ALL', accrual_rule_code: 'NONE', annual_entitlement: '0', state: 'DRAFT' });
    const [foreignPolicy, ownPolicy] = [await leavePolicy(foreignCompany), await leavePolicy(company)];
    const request = await row('leave_request', { employee_id: newEmployee(), leave_type_id: randomUUID(), policy_id: ownPolicy, transaction_id: randomUUID(), start_date: '2026-02-02', end_date: '2026-02-02', requested_units: '1', state: 'SUBMITTED' });
    const revision = (number: string, named: string) => row('leave_request_revision', { request_id: request, revision: number, policy_id: named, start_date: '2026-02-02', end_date: '2026-02-02', half_day: 'false', requested_units: '1' });
    const policyCompany = await revision('1', foreignPolicy);
    await revision('2', ownPolicy);

    // 0151: a manifest in another currency than its template, and an accepted event with no link behind it.
    const template = (code: string, templateCurrency: string) => row('payroll_bank_template', { template_code: code, template_version: '1', name: 'Synthetic', currency_code: templateCurrency, format_definition: '{}', definition_hash: HASH, bank_specification_reference: 'spec', test_only: 'true', state: 'DRAFT' });
    const bankBatch = (forRun: string, forTemplate: string) => row('payroll_bank_batch', { run_id: forRun, template_id: forTemplate, batch_revision: '1', currency_code: 'INR', payment_date: '2026-04-30', state: 'VALIDATED', line_count: '1', total_amount: '1', manifest_hash: HASH, prepared_by: actor, supersedes_batch_id: null });
    const manifest = await bankBatch(firstBad, await template('GL_USD', 'USD'));
    await bankBatch(firstGood, await template('GL_INR', 'INR'));

    const profile = await row('biometric_profile', { code: 'GL_PROFILE', name: 'Synthetic', request_config_reference: 'config', auth_reference: 'auth', provider_timezone: 'UTC', pagination_mode: 'CURSOR', schedule_reference: 'schedule', lookback_minutes: '60', active: 'true' });
    const mapping = await row('biometric_mapping_revision', { profile_id: profile, revision: '1', effective_from: '2026-01-01T00:00:00Z', dedupe_strategy: 'PROVIDER_EVENT_KEY', timestamp_rule: 'ISO_WITH_OFFSET' });
    const syncRun = await row('biometric_sync_run', { profile_id: profile, mapping_revision_id: mapping, window_start: '2026-01-01T00:00:00Z', window_end: '2026-01-02T00:00:00Z', state: 'RUNNING', finished_at: null });
    const worker = newEmployee();
    await row('biometric_employee_link', { profile_id: profile, employee_id: worker, external_employee_key: 'LINKED', effective_from: '2026-01-01T00:00:00Z', effective_to: null });
    const instant = '2026-04-01T09:00:00.000Z';
    const accepted = async (key: string, external: string) => {
      const punch = await row('attendance_punch', { employee_id: worker, occurred_at: instant, direction: 'IN', source_kind: 'BIOMETRIC_API', source_identity_key: key, biometric_profile_id: profile });
      return row('biometric_ingest_event', { profile_id: profile, first_run_id: syncRun, latest_run_id: syncRun, mapping_revision_id: mapping, source_event_key: key, fingerprint: key, external_employee_key: external, employee_id: worker, normalised_time: instant, direction: 'IN', punch_id: punch, state: 'ACCEPTED' });
    };
    const event2 = await accepted('gl-bad', 'NOBODY');
    await accepted('gl-good', 'LINKED');

    return {
      company,
      foreignCompany,
      bad: { ownerApart, stateApart, rootless, headBinding, lineage, confirmationAction, historyDecision, historyBasis, receipt, subject, currency, creatorNotRecorded, creatorMissing, account, policyCompany, manifest, event: event2, segmentCurrency },
      keptRecord,
    };
  } finally {
    await db.query('set session_replication_role = origin');
  }
}
