// The read-only check before go-live (db/pre-go-live-check.ts). Each kind of stored row is planted beside a good one on a database
// from before the guards, which then upgrades through the real migrations, so what the check reads is what they really leave. The
// good row is the control: a query that named every row would fail here. Synthetic data only.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CREATOR_NOT_RECORDED_ID } from '../../apps/api/src/audit/actors.js';
import { seedDevCompany } from '../../apps/api/src/dev/seed.js';
import { migrate } from '../migrate.js';
import { type FindingCode, type GoLiveReport, preGoLiveCheck, runPreGoLiveCheck, scanStoredRows, withReadOnlySnapshot } from '../pre-go-live-check.js';
import { PERSON, PERSON_CODE, type Planted, plantStoredRows, RUN_KEY } from './pre-go-live.fixtures.js';
import { startEmptyTestDatabase, startTestDatabase, type TestDatabase } from './test-database.js';

const TARGET = 'HRMS_CHECK_DATABASE_URL';
const READ_ONLY_TRANSACTION = '25006';

/** What the command printed and answered. */
const command = async (env: Record<string, string | undefined>) => {
  const printed: string[] = [];
  const code = await runPreGoLiveCheck(env, (text) => printed.push(text));
  return { code, text: printed.join('\n') };
};

describe('a database just migrated', () => {
  let testDb: TestDatabase;
  let db: pg.Client;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    db = testDb.client;
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it('has nothing to report, and the command says so', async () => {
    const { code, text } = await command({ [TARGET]: testDb.connectionString });
    expect((JSON.parse(text) as GoLiveReport).findings).toEqual([]);
    expect(code).toBe(0);
  });

  it('says how much it read, so a short list cannot hide a short look', async () => {
    const { scanned } = await preGoLiveCheck(db);
    expect(scanned.foreignKeys).toBeGreaterThan(1000);
    expect(scanned.transactionKinds).toBe((await db.query('select 1 from transaction_kind')).rowCount);
    expect(scanned.guards).toBe(8);
    expect(scanned.creatorTables).toBeGreaterThan(200);
  });

  it('names the checks that were never proved on stored rows, with none broken', async () => {
    const { unvalidated } = await preGoLiveCheck(db);
    expect(unvalidated).toContainEqual({ table: 'role_assignment', constraint: 'role_assignment_revoked_reason', kind: 'check', brokenRows: 0 });
    expect(unvalidated).toContainEqual({ table: 'expense_revision', constraint: 'expense_revision_purpose_present', kind: 'check', brokenRows: 0 });
  });

  it('cannot write: a write inside its transaction is refused, and the same write outside is accepted', async () => {
    const write = () => db.query(`insert into user_account (account_key, active) values ('read.only.probe', false)`);
    await expect(withReadOnlySnapshot(db, write)).rejects.toMatchObject({ code: READ_ONLY_TRANSACTION });
    await db.query('begin');
    try {
      expect((await write()).rowCount).toBe(1);
    } finally {
      await db.query('rollback');
    }
  });

  it('does not write: its whole scan never takes a transaction id', async () => {
    const assigned = await withReadOnlySnapshot(db, async () => {
      await scanStoredRows(db, null);
      return (await db.query<{ xid: string | null }>('select pg_current_xact_id_if_assigned()::text as xid')).rows[0]!.xid;
    });
    expect(assigned).toBeNull();
  });

  it('leaves no transaction open after a failed read', async () => {
    await expect(withReadOnlySnapshot(db, () => db.query('select * from no_such_table'))).rejects.toThrow();
    const inProgress = await db.query<{ open: boolean }>(`select state = 'active' and xact_start = query_start as open from pg_stat_activity where pid = pg_backend_pid()`);
    expect(inProgress.rows[0]!.open).toBe(true);
  });

  it('reads the target from its own setting only', async () => {
    const { code, text } = await command({ DATABASE_URL: testDb.connectionString });
    expect(code).toBe(2);
    expect(text).toBe(`The check could not run: ${TARGET} is not set`);
  });

  it.each([
    ['the development port', 'postgres://hrms:not-a-secret@127.0.0.1:54329/anything'],
    ['the development name', 'postgres://hrms:not-a-secret@127.0.0.1:5999/hrms_dev'],
  ])('refuses %s without connecting', async (_what, url) => {
    const { code, text } = await command({ [TARGET]: url });
    expect(code).toBe(2);
    expect(text).toMatch(/Refusing the development database/);
    expect(text).not.toContain('not-a-secret');
  });

  it('refuses the database the development API uses', async () => {
    const { code, text } = await command({ [TARGET]: testDb.connectionString, DATABASE_URL: testDb.connectionString });
    expect(code).toBe(2);
    expect(text).toMatch(/Refusing DATABASE_URL/);
  });

  it('does not print a URL it cannot read', async () => {
    const { code, text } = await command({ [TARGET]: 'not a url, with not-a-secret' });
    expect(code).toBe(2);
    expect(text).not.toContain('not-a-secret');
  });
});

describe('a database with rows written outside the guards', () => {
  let extra: TestDatabase;

  beforeAll(async () => {
    extra = await startTestDatabase();
  });

  afterAll(async () => {
    await extra?.stop();
  });

  it('counts every row and lists the first 20', async () => {
    await extra.client.query(`insert into user_account (account_key, active) select 'go.live.' || n, true from generate_series(1, 25) n`);
    const { findings } = await preGoLiveCheck(extra.client);
    const creators = findings.find((f) => f.code === 'CREATOR_MISSING' && f.table === 'user_account');
    expect(creators?.count).toBe(25);
    expect(creators?.ids).toHaveLength(20);
  });

  it('refuses a database holding the development seed', async () => {
    await extra.client.query(`insert into company (code, name, active) values ('DEMO', 'Synthetic', true)`);
    const { code, text } = await command({ [TARGET]: extra.connectionString });
    expect(code).toBe(2);
    expect(text).toMatch(/holds the development seed/);
  });
});

describe('a company written by the real seed', () => {
  let seeded: TestDatabase;

  beforeAll(async () => {
    seeded = await startTestDatabase();
    await seedDevCompany(seeded.client, 'GOLIVE');
  });

  afterAll(async () => {
    await seeded?.stop();
  });

  it('raises no false alarm on a real key, state, owner or guard', async () => {
    const { findings } = await preGoLiveCheck(seeded.client);
    expect(findings.filter((f) => !f.code.startsWith('CREATOR_'))).toEqual([]);
  });
});

describe('a database upgraded with one bad row of each kind', () => {
  let old: TestDatabase;
  let db: pg.Client;
  let tooEarly: unknown;
  let planted: Planted;
  let report: GoLiveReport;
  let printed: { code: number; text: string };

  /** One finding exactly: the planted row and nothing beside it. */
  const reported = (code: FindingCode, table: string, rule: string, ids: string[]) =>
    expect(report.findings.filter((f) => f.code === code && f.table === table && f.rule === rule)).toEqual([{ code, table, rule, count: ids.length, ids: [...ids].sort() }]);

  beforeAll(async () => {
    const empty = await startEmptyTestDatabase();
    if (!empty) throw new Error('An upgrade test needs TEST_PG_ADMIN_URL');
    old = empty;
    db = old.client;
    await migrate(db, { before: '0140' });
    tooEarly = await preGoLiveCheck(db).catch((e: unknown) => e);
    planted = await plantStoredRows(db);
    await migrate(db);
    // A check never proved, which a row breaks. A real one (0005, 0117) cannot be planted here: it is older than this starting point.
    await db.query(`alter table company add constraint go_live_probe check (code <> 'GL_B') not valid`);
    report = await preGoLiveCheck(db, 'named');
    printed = await command({ [TARGET]: old.connectionString });
  }, 420_000);

  afterAll(async () => {
    await old?.stop();
  });

  it('refuses a database from before the guards it reads', () => {
    expect(tooEarly).toBeInstanceOf(Error);
    expect((tooEarly as Error).message).toMatch(/^Needs migrations through 0151; this database is at 01[0-3]\d_/);
  });

  it('finds a root whose employee differs from its transaction owner (0142)', () => {
    reported('KEY_BROKEN', 'expense_claim', 'expense_claim_owner_agrees', [planted.bad.ownerApart]);
    expect(report.unvalidated).toContainEqual({ table: 'expense_claim', constraint: 'expense_claim_owner_agrees', kind: 'foreign key', brokenRows: 1 });
  });

  it('finds a root in another state than its transaction (0142)', () => {
    reported('TRANSACTION_STATE_APART', 'expense_claim', 'business_transaction_state_agrees', [planted.bad.stateApart]);
  });

  it('finds a transaction with no root (0142)', () => {
    reported('TRANSACTION_WITHOUT_ROOT', 'leave_request', 'business_transaction_state_agrees', [planted.bad.rootless]);
  });

  it('finds what the NOT VALID fallbacks kept (0140, 0145, 0150, 0151)', () => {
    reported('KEY_BROKEN', 'payroll_line', 'payroll_line_head_binding', [planted.bad.headBinding]);
    reported('KEY_BROKEN', 'payment_batch', 'payment_batch_currency_fk', [planted.bad.currency]);
    reported('KEY_BROKEN', 'leave_request_revision', 'leave_request_revision_policy_company_fk', [planted.bad.policyCompany]);
    reported('KEY_BROKEN', 'payroll_bank_batch', 'payroll_bank_batch_template_currency_fk', [planted.bad.manifest]);
    for (const constraint of ['payroll_line_head_binding', 'payment_batch_currency_fk', 'leave_request_revision_policy_company_fk', 'payroll_bank_batch_template_currency_fk']) {
      expect(report.unvalidated.find((u) => u.constraint === constraint)?.brokenRows).toBe(1);
    }
  });

  it('finds a row with no parent under a key that was proved', () => {
    // Written in replication mode, which a proved key cannot see: the same way a restore could leave one.
    const unproved = new Set(report.unvalidated.map((u) => u.constraint));
    const proved = report.findings.filter((f) => f.code === 'KEY_BROKEN' && f.table === 'leave_request' && !unproved.has(f.rule));
    expect(proved.length).toBeGreaterThan(0);
  });

  it('finds what a guard on new rows never read (0140, 0143, 0151, 0172, 0173)', () => {
    reported('GUARD_BROKEN', 'payroll_run', 'payroll_run_lineage_guard', [planted.bad.lineage]);
    reported('GUARD_BROKEN', 'confirmation_action', 'confirmation_action_provenance', [planted.bad.confirmationAction]);
    reported('GUARD_BROKEN', 'increment_history', 'increment_history_provenance', [planted.bad.historyDecision, planted.bad.historyBasis]);
    reported('GUARD_BROKEN', 'expense_receipt', 'expense_receipt_owner', [planted.bad.receipt]);
    reported('GUARD_BROKEN', 'notification_event', 'notification_event_subject', [planted.bad.subject]);
    reported('GUARD_BROKEN', 'biometric_ingest_event', 'biometric_event_link_covers', [planted.bad.event]);
    reported('GUARD_BROKEN', 'payroll_record', 'payroll_record_segment_currency', [planted.bad.segmentCurrency]);
    reported('GUARD_BROKEN', 'payroll_record', 'payroll_record_valuation_date', [planted.bad.valuationDate]);
  });

  it('an upgrade to 0172 leaves a stored segment in another currency where it is, and refuses the next one', async () => {
    const stored = await db.query(`select currency_code from payroll_record_segment where record_id = $1`, [planted.bad.segmentCurrency]);
    expect(stored.rows).toEqual([{ currency_code: 'USD' }]);
    const { id, employee, salary } = planted.keptRecord;
    const add = async (currency: string) => {
      await db.query('begin');
      try {
        await db.query(
          `insert into payroll_record_segment (company_id, record_id, employee_id, salary_arrangement_id, segment_start, segment_end, calendar_days, leave_lop_units, attendance_lop_units, paid_days, currency_code)
           values ($1, $2, $3, $4, '2026-05-01', '2026-05-31', 31, 0, 0, 31, $5)`,
          [planted.company, id, employee, salary, currency],
        );
        await db.query('set constraints all immediate');
      } finally {
        await db.query('rollback');
      }
    };
    await expect(add('INR')).resolves.toBeUndefined();
    await expect(add('USD')).rejects.toMatchObject({ code: '23514' });
  });

  it('finds rows a check never proved would refuse', () => {
    expect(report.findings.filter((f) => f.code === 'CHECK_BROKEN')).toEqual([{ code: 'CHECK_BROKEN', table: 'company', rule: 'go_live_probe', count: 1, ids: [planted.foreignCompany] }]);
    expect(report.unvalidated).toContainEqual({ table: 'company', constraint: 'go_live_probe', kind: 'check', brokenRows: 1 });
  });

  it('finds creators marked as not recorded (0146) and creators still missing', () => {
    reported('CREATOR_NOT_RECORDED', 'expense_policy', 'created_by', [planted.bad.creatorNotRecorded]);
    reported('CREATOR_MISSING', 'employee', 'created_by', [planted.bad.creatorMissing]);
  });

  it('excuses only what a migration wrote: the permission catalogue and the two accounts that stand for no person', async () => {
    reported('CREATOR_MISSING', 'user_account', 'created_by', [planted.bad.account]);
    expect(report.findings.some((f) => f.table === 'permission')).toBe(false);
    expect((await db.query(`select 1 from permission where created_by is null`)).rowCount).toBeGreaterThan(0);
    expect((await db.query(`select 1 from expense_policy where created_by = $1`, [CREATOR_NOT_RECORDED_ID])).rowCount).toBe(1);
  });

  it('prints ids and counts, never a value from a row or the connection details', () => {
    expect(printed.code).toBe(1);
    const shown = JSON.parse(printed.text) as GoLiveReport;
    expect(shown.findings).toEqual(report.findings);
    const target = new URL(old.connectionString);
    expect(shown.database).toBe(target.pathname.slice(1));
    expect(printed.text).toContain(planted.bad.creatorMissing);
    expect(printed.text).not.toContain(PERSON);
    expect(printed.text).not.toContain(PERSON_CODE);
    expect(printed.text).not.toContain(target.password);
    expect(printed.text).not.toContain(target.host);
  });

  it('counts a row whose key holds no uuid without printing the key', () => {
    expect(report.findings.find((f) => f.code === 'KEY_BROKEN' && f.table === 'scheduled_job_run')).toMatchObject({ count: 1, ids: [] });
    expect(printed.text).not.toContain(RUN_KEY);
  });

  it('changes nothing it finds', async () => {
    const stored = await db.query<{ created_by: string | null }>(`select created_by from employee where id = $1`, [planted.bad.creatorMissing]);
    expect(stored.rows[0]!.created_by).toBeNull();
    const pair = await db.query<{ root: string; txn: string }>(`select c.state as root, t.state as txn from expense_claim c join business_transaction t on t.id = c.transaction_id where c.id = $1`, [planted.bad.stateApart]);
    expect(pair.rows[0]).toEqual({ root: 'DRAFT', txn: 'WITHDRAWN' });
  });
});
