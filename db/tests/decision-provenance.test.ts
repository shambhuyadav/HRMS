// Where a recorded decision came from, and whose records it touches (migration 0143; CI11; CI17; CI18; CI20; DB092; line 81 "test
// direct data writes"). Each refusal is matched on the guard's own message, then the same write is repeated with that one guard
// disabled and must succeed, so a test cannot pass because another check objected. Parents of no interest are written without
// their own parents. Synthetic data only.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_VIOLATION, type CompanyFixture, fixtures, uniq } from './fixtures.js';
import { startTestDatabase, type TestDatabase } from './test-database.js';

describe('decision provenance', () => {
  let testDb: TestDatabase;
  let db: pg.Client;
  let f: ReturnType<typeof fixtures>;
  let a: CompanyFixture;
  let e1: string;
  let e2: string;
  let actor: string;
  let preparer: string;

  /** Rows only their later use is under test for: nothing above them matters here. */
  const bare = async <T>(write: () => Promise<T>) => {
    await db.query('set session_replication_role = replica');
    try {
      return await write();
    } finally {
      await db.query('set session_replication_role = origin');
    }
  };
  const row = (sql: string, params: unknown[]) => bare(() => f.id(sql, params));

  let employees = 0;
  const newEmployee = () => f.makeEmployee(a, `DPE${++employees}`);

  const transaction = (kind: string, owner: string | null, state: string) => row(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, $2, $3, $4)`, [a.company, kind, owner, state]);

  const decisionOf = async (kind: string, txn: string) => {
    const instance = await row(`insert into approval_instance (company_id, transaction_kind, transaction_id, transaction_revision, workflow_id, state) values ($1, $2, $3, 1, $4, 'APPROVED')`, [a.company, kind, txn, randomUUID()]);
    const task = await row(`insert into approval_task (company_id, instance_id, workflow_id, step_id, assignee_user_id, state) values ($1, $2, $3, $4, $5, 'PENDING')`, [a.company, instance, randomUUID(), randomUUID(), actor]);
    return row(`insert into approval_decision (company_id, task_id, actor_user_id, acting_assignment_id, decision, expected_version, idempotency_key) values ($1, $2, $3, $4, 'APPROVE', 1, $5)`, [a.company, task, actor, randomUUID(), uniq('decision-key-')]);
  };

  const refusedBy = async (table: string, guard: string, message: RegExp, write: () => Promise<pg.QueryResult>) => {
    await expect(write()).rejects.toMatchObject({ code: CHECK_VIOLATION, message: expect.stringMatching(message) });
    await db.query('begin');
    try {
      await db.query(`alter table ${table} disable trigger ${guard}`);
      expect((await write()).rowCount).toBe(1);
      await db.query('set constraints all immediate');
    } finally {
      await db.query('rollback');
    }
  };

  const accepted = async (write: () => Promise<pg.QueryResult>) => {
    await db.query('begin');
    try {
      expect((await write()).rowCount).toBe(1);
      await db.query('set constraints all immediate');
    } finally {
      await db.query('rollback');
    }
  };

  beforeAll(async () => {
    testDb = await startTestDatabase();
    db = testDb.client;
    f = fixtures(db);
    a = await f.makeCompany();
    e1 = await f.makeEmployee(a, 'DP1');
    e2 = await f.makeEmployee(a, 'DP2');
    actor = await f.makeUser();
    preparer = await f.makeUser();
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  describe('a confirmation action', () => {
    // An employee of its own each: an employee has one live confirmation case.
    const confirmationCase = async () => {
      const employee = await newEmployee();
      const txn = await transaction('employee_confirmation', employee, 'OPEN');
      const id = await row(`insert into employee_confirmation (company_id, employee_id, policy_id, transaction_id, start_date, initial_due_date, current_due_date, state) values ($1, $2, $3, $4, '2026-01-01', '2026-07-01', '2026-07-01', 'OPEN')`, [a.company, employee, randomUUID(), txn]);
      return { id, txn, employee };
    };
    const insertAction = (c: { id: string; employee: string }, decision: string) =>
      db.query(`insert into confirmation_action (company_id, confirmation_id, employee_id, approval_decision_id, action, prior_due_date, new_due_date, reason) values ($1, $2, $3, $4, 'RETURNED', '2026-07-01', '2026-07-01', 'Synthetic')`, [a.company, c.id, c.employee, decision]);

    it('refuses a decision of another case', async () => {
      const mine = await confirmationCase();
      const other = await confirmationCase();
      const decision = await decisionOf('employee_confirmation', other.txn);
      await refusedBy('confirmation_action', 'confirmation_action_provenance', /names a decision of its own case/, () => insertAction(mine, decision));
    });

    it('accepts a decision of its own case', async () => {
      const mine = await confirmationCase();
      const decision = await decisionOf('employee_confirmation', mine.txn);
      await accepted(() => insertAction(mine, decision));
    });

    it.each([
      ['policy_id', () => randomUUID()],
      ['start_date', () => '2026-02-01'],
      ['initial_due_date', () => '2026-09-01'],
    ])('the case keeps its %s', async (column, value) => {
      const { id } = await confirmationCase();
      // A replaced policy needs a row to point at, or the control would stop at the foreign key.
      const v =
        column === 'policy_id'
          ? await row(`insert into confirmation_policy (company_id, code, revision, duration, duration_unit, start_basis, month_end_rule, start_day_inclusive, effective_from) values ($1, $2, 1, 6, 'CALENDAR_MONTHS', 'JOINING_DATE', 'CLAMP_TO_MONTH_END', true, '2026-01-01')`, [a.company, `DP_${randomUUID().slice(0, 8).toUpperCase()}`])
          : value();
      await refusedBy('employee_confirmation', 'employee_confirmation_fixed', new RegExp(`employee_confirmation\\.${column} is fixed once written`), () => db.query(`update employee_confirmation set ${column} = $2 where id = $1`, [id, v]));
    });

    it('its current due date can still move', async () => {
      const { id } = await confirmationCase();
      await accepted(() => db.query(`update employee_confirmation set current_due_date = '2026-08-01' where id = $1`, [id]));
    });
  });

  describe('an increment history row', () => {
    // An employee of its own each: an employee's salary periods cannot overlap. The baseline ends where the new one starts.
    const arrangement = (employee: string, from: string, to: string | null, currency = 'INR') =>
      row(`insert into salary_arrangement (company_id, employee_id, effective_from, effective_to, annual_ctc, monthly_gross, currency_code) values ($1, $2, $3, $4, 12, 1, $5)`, [a.company, employee, from, to, currency]);
    const incrementCase = async () => {
      const employee = await newEmployee();
      const txn = await transaction('increment_case', employee, 'SUBMITTED');
      const baseline = await arrangement(employee, '2026-01-01', '2026-04-01');
      const id = await row(
        `insert into increment_case (company_id, employee_id, transaction_id, cycle_occurrence_key, off_cycle, prepared_by, baseline_salary_id, compensation_basis, currency_code, baseline_amount, proposed_effective_date, state, reason)
         values ($1, $2, $3, $4, true, $5, $6, 'MONTHLY_GROSS', 'INR', 1, '2026-04-01', 'SUBMITTED', 'Synthetic')`,
        [a.company, employee, txn, uniq('occ-'), preparer, baseline],
      );
      return { id, txn, baseline, employee };
    };
    const insertHistory = (c: { id: string; baseline: string; employee: string }, decision: string, newSalary: string, basis = 'MONTHLY_GROSS', currency = 'INR') =>
      db.query(
        `insert into increment_history (company_id, employee_id, case_id, approval_decision_id, old_salary_id, new_salary_id, effective_date, compensation_basis, currency_code, before_amount, after_amount, change_amount, change_percent, reason, applied_by)
         values ($1, $2, $3, $4, $5, $6, '2026-04-01', $7, $8, 1, 2, 1, 100, 'Synthetic', $9)`,
        [a.company, c.employee, c.id, decision, c.baseline, newSalary, basis, currency, actor],
      );

    it('refuses a decision of another case', async () => {
      const mine = await incrementCase();
      const other = await incrementCase();
      const decision = await decisionOf('increment_case', other.txn);
      const salary = await arrangement(mine.employee, '2026-04-01', null);
      await refusedBy('increment_history', 'increment_history_provenance', /names a decision of its own case/, () => insertHistory(mine, decision, salary));
    });

    it('refuses a basis other than the case’s', async () => {
      const mine = await incrementCase();
      const decision = await decisionOf('increment_case', mine.txn);
      const salary = await arrangement(mine.employee, '2026-04-01', null);
      await refusedBy('increment_history', 'increment_history_provenance', /keeps the basis and currency/, () => insertHistory(mine, decision, salary, 'ANNUAL_CTC'));
    });

    it('refuses a currency other than the case’s', async () => {
      const mine = await incrementCase();
      const decision = await decisionOf('increment_case', mine.txn);
      const salary = await arrangement(mine.employee, '2026-04-01', null, 'XTS');
      await refusedBy('increment_history', 'increment_history_provenance', /keeps the basis and currency/, () => insertHistory(mine, decision, salary, 'MONTHLY_GROSS', 'XTS'));
    });

    it('refuses a new arrangement in another currency', async () => {
      const mine = await incrementCase();
      const decision = await decisionOf('increment_case', mine.txn);
      const salary = await arrangement(mine.employee, '2026-04-01', null, 'XTS');
      await refusedBy('increment_history', 'increment_history_provenance', /keeps the basis and currency/, () => insertHistory(mine, decision, salary));
    });

    it('accepts its own decision, basis and currency', async () => {
      const mine = await incrementCase();
      const decision = await decisionOf('increment_case', mine.txn);
      const salary = await arrangement(mine.employee, '2026-04-01', null);
      await accepted(() => insertHistory(mine, decision, salary));
    });
  });

  describe('an expense receipt', () => {
    const lineOf = async (employee: string) => {
      const claim = await row(`insert into expense_claim (company_id, employee_id, transaction_id, purpose, currency_code, current_revision, state, payment_state) values ($1, $2, $3, 'Synthetic', 'INR', 1, 'DRAFT', 'NOT_APPLICABLE')`, [a.company, employee, randomUUID()]);
      const revision = await row(`insert into expense_revision (company_id, claim_id, revision, currency_code, purpose) values ($1, $2, 1, 'INR', 'Synthetic')`, [a.company, claim]);
      return row(`insert into expense_line (company_id, revision_id, sequence, category_id, expense_date, merchant, gross_amount, claimed_amount, description, fingerprint) values ($1, $2, 1, $3, '2026-01-01', 'Synthetic', 1, 1, 'Synthetic', 'synthetic')`, [a.company, revision, randomUUID()]);
    };
    const file = (employee: string | null) => f.id(`insert into attachment (company_id, owner_user_id, employee_id, content_reference, media_type, checksum) values ($1, $2, $3, $4, 'application/pdf', $5)`, [a.company, actor, employee, uniq('opaque-ref-'), 'a'.repeat(64)]);
    const insertReceipt = (line: string, attachment: string) => db.query(`insert into expense_receipt (company_id, line_id, attachment_id) values ($1, $2, $3)`, [a.company, line, attachment]);

    it('refuses another employee’s file', async () => {
      const [line, other] = [await lineOf(e1), await file(e2)];
      await refusedBy('expense_receipt', 'expense_receipt_owner', /a receipt is a file of the claimant/, () => insertReceipt(line, other));
    });

    it('refuses a file belonging to no one', async () => {
      const [line, nobody] = [await lineOf(e1), await file(null)];
      await refusedBy('expense_receipt', 'expense_receipt_owner', /a receipt is a file of the claimant/, () => insertReceipt(line, nobody));
    });

    it('accepts the claimant’s own file', async () => {
      const [line, own] = [await lineOf(e1), await file(e1)];
      await accepted(() => insertReceipt(line, own));
    });
  });

  describe('a notification event', () => {
    const insertEvent = (subject: string | null, txn: string | null) =>
      db.query(`insert into notification_event (company_id, event_key, event_type, subject_employee_id, transaction_id, occurrence_date, business_timezone) values ($1, $2, 'SYNTHETIC', $3, $4, '2026-01-01', 'Asia/Kolkata')`, [a.company, uniq('event-'), subject, txn]);

    it('refuses a subject other than the transaction’s owner', async () => {
      const txn = await transaction('expense_claim', e1, 'DRAFT');
      await refusedBy('notification_event', 'notification_event_subject', /has its owner as subject/, () => insertEvent(e2, txn));
    });

    it('accepts the owner, no subject, no transaction, or a transaction with no owner', async () => {
      const owned = await transaction('expense_claim', e1, 'DRAFT');
      const unowned = await transaction('payroll_run', null, 'DRAFT');
      await accepted(() => insertEvent(e1, owned));
      await accepted(() => insertEvent(null, owned));
      await accepted(() => insertEvent(e2, null));
      await accepted(() => insertEvent(e2, unowned));
    });
  });
});
