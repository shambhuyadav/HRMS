// State paths and write-once fields of the earlier resources (migration 0141; BRD line 80; line 81 "test direct data writes";
// CI15; CI16; C4; FR-023; FR-056; FR-088). Every refusal is matched on the guard's own message, then the same write is repeated
// with that one guard disabled and must succeed, so a test cannot pass because another check objected. Synthetic data only.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_VIOLATION, type CompanyFixture, fixtures, uniq } from './fixtures.js';
import { startTestDatabase, type TestDatabase } from './test-database.js';

let testDb: TestDatabase;
let db: pg.Client;
let f: ReturnType<typeof fixtures>;
let a: CompanyFixture;
let employee2: string;
let user1: string;
let user2: string;
let user3: string;
let assignment: string;
let file1: string;
let file2: string;

const insert = async (table: string, values: Record<string, unknown>) => {
  const columns = Object.keys(values);
  return (await db.query<{ id: string }>(`insert into ${table} (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')}) returning id`, Object.values(values))).rows[0]!.id;
};

/** For a row whose parents are of no interest here: only its later updates are under test. */
const insertWithoutParents = async (table: string, values: Record<string, unknown>) => {
  await db.query('set session_replication_role = replica');
  try {
    return await insert(table, values);
  } finally {
    await db.query('set session_replication_role = origin');
  }
};

/** Refused by this guard's own message, and accepted once this guard alone is disabled. Nothing of the attempt stays. */
const refusedBy = async (table: string, guard: string, message: RegExp, sql: string, params: unknown[], control = true) => {
  await expect(db.query(sql, params)).rejects.toMatchObject({ code: CHECK_VIOLATION, message: expect.stringMatching(message) });
  if (!control) return;
  await db.query('begin');
  try {
    await db.query(`alter table ${table} disable trigger ${guard}`);
    expect((await db.query(sql, params)).rowCount).toBe(1);
  } finally {
    await db.query('rollback');
  }
};

const accepted = async (sql: string, params: unknown[]) => {
  await db.query('begin');
  try {
    expect((await db.query(sql, params)).rowCount).toBe(1);
  } finally {
    await db.query('rollback');
  }
};

const decidedRow = (state: string) => (state === 'PENDING' ? {} : { decided_by: user3, decided_at: '2026-01-02T00:00:00Z' });

// An employee of its own each: an employee has one pending link and one active link at a time.
let employees = 0;
const makeLink = async (state: string) =>
  insert('mobile_app_link', {
    company_id: a.company,
    employee_id: await f.makeEmployee(a, `SGL${++employees}`),
    app_account_ref: uniq('app.'),
    state,
    requested_by: user1,
    ...decidedRow(state),
    ...(state === 'REVOKED' ? { revoked_by: user3, revoked_at: '2026-01-03T00:00:00Z', revoke_reason: 'Synthetic' } : {}),
  });

// A company of its own each: a company has one active rule per resource.
const makeRule = (state: string) =>
  insertWithoutParents('retention_rule', {
    company_id: randomUUID(),
    resource_code: 'audit_event',
    revision: 1,
    retain_days: 10,
    basis_note: 'Synthetic',
    state,
    created_by: user1,
    ...(state === 'DRAFT' ? {} : { approved_by: user3, approved_at: '2026-01-02T00:00:00Z' }),
  });

const makeHold = (state: string) =>
  insert('retention_hold', {
    company_id: a.company,
    resource_code: 'audit_event',
    record_key: randomUUID(),
    reason: 'Synthetic',
    state,
    requested_by: user1,
    ...decidedRow(state),
    ...(state === 'RELEASED' ? { released_by: user3, released_at: '2026-01-03T00:00:00Z', release_reason: 'Synthetic' } : {}),
  });

const makeJob = (state: string) =>
  insert('import_job', { company_id: a.company, kind: 'employee_create', state, attachment_id: file1, submitted_by: user1, idempotency_key: uniq('import-key-') });

const makeReport = (state: string) =>
  insert('report_execution', {
    company_id: a.company,
    report_code: 'SYNTHETIC',
    requested_by: user1,
    acting_assignment_id: assignment,
    filter_snapshot: '{}',
    scope_snapshot: '{}',
    state,
    generated_at: '2026-01-02T00:00:00Z',
    output_attachment_id: file1,
    ...(state === 'RUNNING' ? { running_since: '2026-01-02T00:00:00Z' } : {}),
  });

const makeNotification = (state: string) =>
  insert('notification', { company_id: a.company, recipient_user_id: user1, category: 'SYNTHETIC', state, channel: 'IN_APP', idempotency_key: uniq('notice-'), body: 'Synthetic' });

const makeRun = (state: string) =>
  insertWithoutParents('biometric_sync_run', {
    company_id: a.company,
    profile_id: randomUUID(),
    mapping_revision_id: randomUUID(),
    window_start: '2026-01-01T00:00:00Z',
    window_end: '2026-01-02T00:00:00Z',
    state,
    ...(state === 'RUNNING' ? {} : { finished_at: '2026-01-02T00:00:00Z' }),
  });

interface Machine {
  table: string;
  make: (state: string) => Promise<string>;
  /** What else a write into that state must carry to satisfy the table's other checks. */
  extra?: (to: string) => string;
  allowed: string[];
  refused: string[];
}

const fillDecision = () => `, decided_by = coalesce(decided_by, '${user3}'), decided_at = coalesce(decided_at, now())`;
const MACHINES: Machine[] = [
  {
    table: 'mobile_app_link',
    make: makeLink,
    extra: (to) => (to === 'PENDING' ? '' : fillDecision()) + (to === 'REVOKED' ? `, revoked_by = coalesce(revoked_by, '${user3}'), revoked_at = coalesce(revoked_at, now()), revoke_reason = coalesce(revoke_reason, 'Synthetic')` : ''),
    allowed: ['PENDING>ACTIVE', 'PENDING>REJECTED', 'ACTIVE>REVOKED'],
    refused: ['REJECTED>ACTIVE', 'REVOKED>ACTIVE', 'REVOKED>PENDING', 'REJECTED>PENDING', 'ACTIVE>PENDING', 'ACTIVE>REJECTED', 'PENDING>REVOKED'],
  },
  {
    table: 'retention_rule',
    make: makeRule,
    extra: (to) => (to === 'DRAFT' ? '' : `, approved_by = coalesce(approved_by, '${user3}'), approved_at = coalesce(approved_at, now())`),
    allowed: ['DRAFT>ACTIVE', 'ACTIVE>RETIRED'],
    refused: ['RETIRED>ACTIVE', 'RETIRED>DRAFT', 'ACTIVE>DRAFT', 'DRAFT>RETIRED'],
  },
  {
    table: 'retention_hold',
    make: makeHold,
    extra: (to) => (to === 'PENDING' ? '' : fillDecision()) + (to === 'RELEASED' ? `, released_by = coalesce(released_by, '${user3}'), released_at = coalesce(released_at, now()), release_reason = coalesce(release_reason, 'Synthetic')` : ''),
    allowed: ['PENDING>ACTIVE', 'PENDING>REJECTED', 'ACTIVE>RELEASED'],
    refused: ['REJECTED>ACTIVE', 'RELEASED>ACTIVE', 'RELEASED>PENDING', 'ACTIVE>PENDING', 'ACTIVE>REJECTED', 'PENDING>RELEASED'],
  },
  {
    table: 'import_job',
    make: makeJob,
    allowed: [
      'UPLOADED>VALIDATED', 'UPLOADED>PREVIEWED', 'UPLOADED>COMMITTING', 'UPLOADED>COMMITTED', 'UPLOADED>REJECTED', 'UPLOADED>CANCELLED',
      'VALIDATED>PREVIEWED', 'VALIDATED>COMMITTING', 'VALIDATED>COMMITTED', 'VALIDATED>REJECTED', 'VALIDATED>CANCELLED',
      'PREVIEWED>COMMITTING', 'PREVIEWED>COMMITTED', 'PREVIEWED>REJECTED', 'PREVIEWED>CANCELLED',
      'COMMITTING>COMMITTED', 'COMMITTING>REJECTED', 'COMMITTING>CANCELLED',
    ],
    refused: ['COMMITTED>UPLOADED', 'COMMITTED>PREVIEWED', 'COMMITTED>REJECTED', 'REJECTED>COMMITTED', 'REJECTED>PREVIEWED', 'CANCELLED>PREVIEWED', 'CANCELLED>COMMITTED', 'PREVIEWED>UPLOADED', 'PREVIEWED>VALIDATED', 'COMMITTING>PREVIEWED', 'VALIDATED>UPLOADED'],
  },
  {
    table: 'report_execution',
    make: makeReport,
    extra: (to) => `, running_since = ${to === 'RUNNING' ? 'now()' : 'null'}`,
    allowed: ['QUEUED>RUNNING', 'QUEUED>FAILED', 'RUNNING>QUEUED', 'RUNNING>COMPLETED', 'RUNNING>FAILED', 'COMPLETED>EXPIRED'],
    refused: ['COMPLETED>QUEUED', 'COMPLETED>RUNNING', 'COMPLETED>FAILED', 'FAILED>QUEUED', 'FAILED>RUNNING', 'FAILED>COMPLETED', 'EXPIRED>COMPLETED', 'QUEUED>COMPLETED'],
  },
  {
    table: 'notification',
    make: makeNotification,
    allowed: ['QUEUED>DELIVERED', 'QUEUED>RETRY_PENDING', 'QUEUED>FAILED', 'QUEUED>SUPPRESSED', 'RETRY_PENDING>DELIVERED', 'RETRY_PENDING>FAILED', 'RETRY_PENDING>SUPPRESSED'],
    refused: ['DELIVERED>QUEUED', 'DELIVERED>FAILED', 'FAILED>QUEUED', 'FAILED>DELIVERED', 'SUPPRESSED>DELIVERED', 'SUPPRESSED>QUEUED', 'RETRY_PENDING>QUEUED'],
  },
];

describe('state guards of the earlier resources', () => {
  beforeAll(async () => {
    testDb = await startTestDatabase();
    db = testDb.client;
    f = fixtures(db);
    a = await f.makeCompany();
    employee2 = await f.makeEmployee(a, 'SG2');
    [user1, user2, user3] = [await f.makeUser(), await f.makeUser(), await f.makeUser()];
    assignment = await f.makeActiveAssignment(a, user1);
    const file = () => insert('attachment', { company_id: a.company, owner_user_id: user1, content_reference: uniq('opaque-ref-'), media_type: 'application/pdf', checksum: 'a'.repeat(64) });
    [file1, file2] = [await file(), await file()];
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  for (const m of MACHINES) {
    describe(m.table, () => {
      it.each(m.refused)('refuses %s', async (path) => {
        const [from, to] = path.split('>') as [string, string];
        const id = await m.make(from);
        await refusedBy(m.table, `${m.table}_state_path`, new RegExp(`${m.table} cannot move from ${from} to ${to}`), `update ${m.table} set state = '${to}'${m.extra?.(to) ?? ''} where id = $1`, [id]);
      });

      it.each(m.allowed)('allows %s', async (path) => {
        const [from, to] = path.split('>') as [string, string];
        await accepted(`update ${m.table} set state = '${to}'${m.extra?.(to) ?? ''} where id = $1`, [await m.make(from)]);
      });

      it('lets a write that leaves the state alone through', async () => {
        const state = m.allowed[0]!.split('>')[0]!;
        await accepted(`update ${m.table} set updated_by = '${user2}' where id = $1`, [await m.make(state)]);
      });
    });
  }

  describe('expense_policy (0116 froze what follows activation)', () => {
    const draft = () =>
      insert('expense_policy', { company_id: a.company, code: uniq('SG').toUpperCase().replace(/[^A-Z0-9_]/g, '_'), revision: 1, currency_code: 'INR', submission_window_days: 30, high_value_threshold: 100, effective_from: '2026-01-01', state: 'DRAFT', created_by: user1 });

    it('refuses a draft going straight to retired', async () => {
      await refusedBy('expense_policy', 'expense_policy_state_path', /expense_policy cannot move from DRAFT to RETIRED/, `update expense_policy set state = 'RETIRED', activated_by = '${user2}', activated_at = now() where id = $1`, [await draft()]);
    });

    it('allows activation', async () => {
      await accepted(`update expense_policy set state = 'ACTIVE', activated_by = '${user2}', activated_at = now() where id = $1`, [await draft()]);
    });
  });

  describe('fixed columns', () => {
    const fixedCases = () =>
      [
        ['mobile_app_link', () => makeLink('PENDING'), { employee_id: employee2, app_account_ref: 'other.account', requested_by: user2, replaces_link_id: () => makeLink('REJECTED') }],
        ['retention_rule', () => makeRule('DRAFT'), { revision: 9000, retain_days: 11, basis_note: 'Changed' }],
        ['retention_hold', () => makeHold('PENDING'), { resource_code: 'other_resource', record_key: randomUUID(), reason: 'Changed', requested_by: user2 }],
        ['import_job', () => makeJob('UPLOADED'), { kind: 'other_kind', attachment_id: file2, submitted_by: user2, idempotency_key: uniq('import-key-') }],
      ] as const;

    it('refuses a change to each of them, in every table', async () => {
      for (const [table, make, columns] of fixedCases()) {
        for (const [column, value] of Object.entries(columns)) {
          const id = await make();
          const resolved = typeof value === 'function' ? await value() : value;
          await refusedBy(table, `${table}_fixed`, new RegExp(`${table}\\.${column} is fixed once written`), `update ${table} set ${column} = $2 where id = $1`, [id, resolved]);
        }
      }
    });

    it('refuses a change to a rule’s resource (its CHECK allows one value today, so there is no control)', async () => {
      await refusedBy('retention_rule', 'retention_rule_fixed', /retention_rule\.resource_code is fixed once written/, `update retention_rule set resource_code = 'other_resource' where id = $1`, [await makeRule('DRAFT')], false);
    });
  });

  describe('fields recorded once', () => {
    const onceCases = () =>
      [
        ['mobile_app_link', () => makeLink('REVOKED'), { decided_by: user2, decided_at: '2026-02-01T00:00:00Z', revoked_by: user2, revoked_at: '2026-02-01T00:00:00Z', revoke_reason: 'Changed' }],
        ['retention_rule', () => makeRule('ACTIVE'), { approved_by: user2, approved_at: '2026-02-01T00:00:00Z' }],
        ['retention_hold', () => makeHold('RELEASED'), { decided_by: user2, decided_at: '2026-02-01T00:00:00Z', released_by: user2, released_at: '2026-02-01T00:00:00Z', release_reason: 'Changed' }],
      ] as const;

    it('refuses a change to each of them once recorded, in every table', async () => {
      for (const [table, make, columns] of onceCases()) {
        for (const [column, value] of Object.entries(columns)) {
          await refusedBy(table, `${table}_set_once`, new RegExp(`${table}\\.${column} is final once recorded`), `update ${table} set ${column} = $2 where id = $1`, [await make(), value]);
        }
      }
    });
  });

  describe('import_row', () => {
    const row = (job: string, n = 1) => insert('import_row', { company_id: a.company, job_id: job, row_number: n, state: 'PENDING', business_key: 'K' });

    it.each(['COMMITTED', 'REJECTED', 'CANCELLED'])('a row of a %s job no longer changes, and none is added', async (state) => {
      const job = await makeJob('PREVIEWED');
      const id = await insert('import_row', { company_id: a.company, job_id: job, row_number: 1, state: 'ACCEPTED', business_key: 'K' });
      await db.query(`update import_job set state = $2, accepted_count = 1 where id = $1`, [job, state]);
      await refusedBy('import_row', 'import_row_job_open', /rows of a finished import job do not change/, `update import_row set business_key = 'Changed' where id = $1`, [id]);
      await refusedBy(
        'import_row',
        'import_row_job_open',
        /rows of a finished import job do not change/,
        `insert into import_row (company_id, job_id, row_number, state, business_key) values ($1, $2, 2, 'PENDING', 'K')`,
        [a.company, job],
      );
    });

    it('an open job’s rows can still change', async () => {
      const id = await row(await makeJob('PREVIEWED'));
      await accepted(`update import_row set state = 'VALID' where id = $1`, [id]);
    });
  });

  describe('biometric_sync_run', () => {
    it.each(['COMPLETED', 'PARTIAL', 'FAILED'])('an ended %s run changes no more: not its state, not its counts', async (state) => {
      const final = /biometric sync run that has ended does not change/;
      const id = await makeRun(state);
      await refusedBy('biometric_sync_run', 'biometric_sync_run_final', final, `update biometric_sync_run set state = 'RUNNING', finished_at = null where id = $1`, [id]);
      await refusedBy('biometric_sync_run', 'biometric_sync_run_final', final, `update biometric_sync_run set source_observation_count = 1, accepted_count = 1 where id = $1`, [id]);
    });

    it.each(['COMPLETED', 'PARTIAL', 'FAILED'])('a running run can end %s', async (state) => {
      await accepted(`update biometric_sync_run set state = '${state}', finished_at = now() where id = $1`, [await makeRun('RUNNING')]);
    });

    it('a running run can still count a page', async () => {
      await accepted(`update biometric_sync_run set source_observation_count = 1, accepted_count = 1 where id = $1`, [await makeRun('RUNNING')]);
    });
  });
});
