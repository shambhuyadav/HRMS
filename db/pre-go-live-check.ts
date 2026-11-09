// A read-only look for stored rows the database guards cannot see until their next write (ZT06, ZT19). A migration must not stop
// on existing data, so it keeps a row that breaks a new rule, and a guard that fires on insert never reads an older row. This
// finds those rows for their data owner; what they should have said is not for a tool to guess, so it corrects nothing.
//
// Usage: HRMS_CHECK_DATABASE_URL=... npm run db:check-go-live   (the setting is its only input; DATABASE_URL is never read as a target)
// Exit code: 0 nothing to report, 1 something to report, 2 the check could not run. Prints counts and row ids, never a value from a row.
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { CREATOR_NOT_RECORDED_ID } from '../apps/api/src/audit/actors.js';
import { assertNoDevelopmentSeed, assertNotDevelopmentDatabase, databaseIdentity } from './development-target.js';
import { foreignKeys, quote } from './tests/catalogue.fixtures.js';

const TARGET_SETTING = 'HRMS_CHECK_DATABASE_URL';
/** The last migration whose guards this reads. */
const REQUIRED_MIGRATION = '0151';
const ID_LIMIT = 20;

export type FindingCode =
  /** A key's rows that have no parent row. Covers a root's employee differing from its transaction owner (`<root>_owner_agrees`). */
  | 'KEY_BROKEN'
  /** Rows a CHECK that was never validated would refuse. */
  | 'CHECK_BROKEN'
  /** A transaction and its root in different states: the transaction's next state change is refused until they agree. */
  | 'TRANSACTION_STATE_APART'
  /** A transaction with no root row (`table` names the missing root; the ids are of business_transaction). */
  | 'TRANSACTION_WITHOUT_ROOT'
  /** Rows a guard that fires only on new rows would refuse. */
  | 'GUARD_BROKEN'
  /** No creator on a table that still allows that. */
  | 'CREATOR_MISSING'
  /** Marked by 0146 as having no recorded creator. */
  | 'CREATOR_NOT_RECORDED';

export interface Finding {
  code: FindingCode;
  table: string;
  /** The constraint, guard or column that the rows break. */
  rule: string;
  count: number;
  /** The first ids, as the uuid columns of the table's primary key. Empty when the key has none. */
  ids: string[];
}

export interface UnvalidatedConstraint {
  table: string;
  constraint: string;
  kind: 'foreign key' | 'check';
  /** Zero means it could now be validated. */
  brokenRows: number;
}

export interface GoLiveReport {
  database: string | null;
  latestMigration: string;
  /** What was read, so a short list of findings can be told from a short look. */
  scanned: { foreignKeys: number; unvalidatedChecks: number; transactionKinds: number; guards: number; creatorTables: number };
  findings: Finding[];
  /** Constraints that still apply to new and changed rows but were never proved on stored ones. */
  unvalidated: UnvalidatedConstraint[];
}

/** Guards that read only the row being written, as `from` (the guarded table as c, plus what it reads) and the rows they would refuse. */
const INSERT_ONLY_GUARDS: { table: string; rule: string; from: string; refused: string }[] = [
  {
    table: 'payroll_run',
    rule: 'payroll_run_lineage_guard',
    from: 'payroll_run c',
    refused: `c.supersedes_run_id is not null and not exists (
      select 1 from payroll_run s where s.company_id = c.company_id and s.id = c.supersedes_run_id
         and (s.lineage_id, s.period_id, s.calendar_id, s.revision + 1) is not distinct from (c.lineage_id, c.period_id, c.calendar_id, c.revision))`,
  },
  {
    table: 'confirmation_action',
    rule: 'confirmation_action_provenance',
    from: `confirmation_action c left join employee_confirmation k on k.company_id = c.company_id and k.id = c.confirmation_id`,
    refused: 'not hrms_decision_of_transaction(c.company_id, c.approval_decision_id, k.transaction_id)',
  },
  {
    table: 'increment_history',
    rule: 'increment_history_provenance',
    from: `increment_history c
      left join increment_case k on k.company_id = c.company_id and k.id = c.case_id
      left join salary_arrangement a on a.company_id = c.company_id and a.id = c.new_salary_id`,
    refused: `not hrms_decision_of_transaction(c.company_id, c.approval_decision_id, k.transaction_id)
      or (c.compensation_basis, c.currency_code) is distinct from (k.compensation_basis, k.currency_code)
      or c.currency_code is distinct from a.currency_code`,
  },
  {
    table: 'expense_receipt',
    rule: 'expense_receipt_owner',
    from: `expense_receipt c
      left join expense_line l on l.company_id = c.company_id and l.id = c.line_id
      left join expense_revision r on r.company_id = l.company_id and r.id = l.revision_id
      left join expense_claim k on k.company_id = r.company_id and k.id = r.claim_id
      left join attachment f on f.company_id = c.company_id and f.id = c.attachment_id`,
    refused: 'f.employee_id is distinct from k.employee_id',
  },
  {
    table: 'notification_event',
    rule: 'notification_event_subject',
    from: `notification_event c join business_transaction t on t.company_id = c.company_id and t.id = c.transaction_id`,
    refused: 'c.subject_employee_id <> t.owner_employee_id',
  },
  {
    table: 'biometric_ingest_event',
    rule: 'biometric_event_link_covers',
    from: 'biometric_ingest_event c',
    refused: `c.state = 'ACCEPTED' and not exists (
      select 1 from biometric_employee_link l
       where l.company_id = c.company_id and l.profile_id = c.profile_id and l.employee_id = c.employee_id
         and l.external_employee_key = c.external_employee_key
         and l.effective_from <= c.normalised_time and (l.effective_to is null or l.effective_to > c.normalised_time))`,
  },
  {
    table: 'payroll_record',
    rule: 'payroll_record_segment_currency',
    from: 'payroll_record c',
    refused: `c.calculation_status = 'CALCULATED' and exists (
      select 1 from payroll_record_segment s where s.company_id = c.company_id and s.record_id = c.id and s.currency_code <> c.currency_code)`,
  },
  {
    // 0173 reads an arrangement's end and its supersession as they stand at completion; both may change later for good reason (a later
    // arrangement closes this one, a correction supersedes it), so a stored record is read only for what never changes: an arrangement
    // starting after its segment, and the record naming another arrangement than its last segment's.
    table: 'payroll_record',
    rule: 'payroll_record_valuation_date',
    from: 'payroll_record c',
    refused: `c.calculation_status = 'CALCULATED' and (exists (
      select 1 from payroll_record_segment s join salary_arrangement a on a.company_id = s.company_id and a.id = s.salary_arrangement_id
       where s.company_id = c.company_id and s.record_id = c.id and a.effective_from > s.segment_start)
      or c.salary_arrangement_id is distinct from (
        select s.salary_arrangement_id from payroll_record_segment s where s.company_id = c.company_id and s.record_id = c.id order by s.segment_end desc limit 1))`,
  },
];

/**
 * Rows a migration writes, which nobody created, so no creator is expected: the permission catalogue and the two accounts that
 * stand for no person. Each value says which rows of that table are still reported.
 */
const REPORTED_WITHOUT_CREATOR: Record<string, string> = {
  permission: 'false',
  user_account: 'not hrms_is_non_person_actor(c.id)',
};

/** One transaction that cannot write, reading one snapshot: every count below describes the same moment. */
export async function withReadOnlySnapshot<T>(db: pg.ClientBase, read: () => Promise<T>): Promise<T> {
  await db.query('begin transaction isolation level repeatable read read only');
  try {
    return await read();
  } finally {
    await db.query('rollback');
  }
}

export function preGoLiveCheck(db: pg.ClientBase, database: string | null = null): Promise<GoLiveReport> {
  return withReadOnlySnapshot(db, () => scanStoredRows(db, database));
}

/** The reads themselves. Call through `withReadOnlySnapshot`. */
export async function scanStoredRows(db: pg.ClientBase, database: string | null): Promise<GoLiveReport> {
  const latestMigration = (await db.query<{ latest: string | null }>(`select max(filename) as latest from schema_migration`)).rows[0]!.latest ?? '';
  if (latestMigration < REQUIRED_MIGRATION) throw new Error(`Needs migrations through ${REQUIRED_MIGRATION}; this database is at ${latestMigration || 'none'}`);

  const uuidKeys = await db.query<{ table_name: string; columns: string[] }>(`
    select c.relname::text as table_name, array_agg(a.attname::text order by k.ord) as columns
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      join unnest(con.conkey) with ordinality k(attnum, ord) on true
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
     where con.contype = 'p' and n.nspname = current_schema() and a.atttypid = 'uuid'::regtype
     group by c.relname`);
  const idColumns = new Map(uuidKeys.rows.map((r) => [r.table_name, r.columns]));

  /** How many rows of `table` (as c) match, and the first ids. Selects nothing else from a row, so nothing else can be printed. */
  const matching = async (table: string, from: string, where: string, params: string[]): Promise<{ count: number; ids: string[] }> => {
    const key = idColumns.get(table);
    const id = key ? `concat_ws(':', ${key.map((col) => `c.${quote(col)}`).join(', ')})` : 'null::text';
    const found = await db.query<{ id: string | null; total: string }>(`select ${id} as id, count(*) over () as total from ${from} where ${where} order by 1 limit ${ID_LIMIT}`, params);
    return { count: Number(found.rows[0]?.total ?? 0), ids: found.rows.flatMap((r) => (r.id === null ? [] : [r.id])) };
  };

  const findings: Finding[] = [];
  const unvalidated: UnvalidatedConstraint[] = [];
  const report = async (code: FindingCode, table: string, rule: string, from: string, where: string, params: string[] = []): Promise<number> => {
    const { count, ids } = await matching(table, from, where, params);
    if (count) findings.push({ code, table, rule, count, ids });
    return count;
  };

  // Every key, proved or not: a proved key has no broken row unless a write went round it (replication mode, a restore).
  const keys = await foreignKeys(db);
  for (const key of keys) {
    const present = key.childColumns.map((col) => `c.${quote(col)} is not null`).join(' and ');
    const parent = key.childColumns.map((col, i) => `p.${quote(key.parentColumns[i]!)} = c.${quote(col)}`).join(' and ');
    const brokenRows = await report('KEY_BROKEN', key.child, key.name, `${quote(key.child)} c`, `${present} and not exists (select 1 from ${quote(key.parent)} p where ${parent})`);
    if (!key.validated) unvalidated.push({ table: key.child, constraint: key.name, kind: 'foreign key', brokenRows });
  }

  // A proved check needs no scan: unlike a key's trigger, replication mode does not switch it off.
  const checks = await db.query<{ table_name: string; name: string; expression: string }>(`
    select c.relname::text as table_name, con.conname::text as name, pg_get_expr(con.conbin, con.conrelid) as expression
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
     where con.contype = 'c' and not con.convalidated and n.nspname = current_schema()
     order by 1, 2`);
  for (const check of checks.rows) {
    const brokenRows = await report('CHECK_BROKEN', check.table_name, check.name, `${quote(check.table_name)} c`, `(${check.expression}) is false`);
    unvalidated.push({ table: check.table_name, constraint: check.name, kind: 'check', brokenRows });
  }

  // A state write is compared with the root only at the transaction's next state change (0142), so a pair already apart waits there.
  const kinds = await db.query<{ kind: string; root_table: string; has_state: boolean }>(`
    select tk.kind, tk.root_table,
           exists (select 1 from information_schema.columns x where x.table_schema = current_schema() and x.table_name = tk.root_table and x.column_name = 'state') as has_state
      from transaction_kind tk
     where to_regclass(tk.root_table) is not null
     order by tk.kind`);
  for (const { kind, root_table: root, has_state: hasState } of kinds.rows) {
    if (hasState) {
      await report('TRANSACTION_STATE_APART', root, 'business_transaction_state_agrees', `${quote(root)} c join business_transaction t on t.company_id = c.company_id and t.id = c.transaction_id`, 't.kind = $1 and t.state is distinct from c.state', [kind]);
    }
    const { count, ids } = await matching('business_transaction', 'business_transaction c', `c.kind = $1 and not exists (select 1 from ${quote(root)} r where r.company_id = c.company_id and r.transaction_id = c.id)`, [kind]);
    if (count) findings.push({ code: 'TRANSACTION_WITHOUT_ROOT', table: root, rule: 'business_transaction_state_agrees', count, ids });
  }

  for (const guard of INSERT_ONLY_GUARDS) await report('GUARD_BROKEN', guard.table, guard.rule, guard.from, guard.refused);

  const creatorTables = await db.query<{ table_name: string; nullable: string }>(`
    select c.table_name::text as table_name, c.is_nullable as nullable
      from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
     where c.table_schema = current_schema() and c.column_name = 'created_by'
     order by 1`);
  for (const { table_name: table, nullable } of creatorTables.rows) {
    if (nullable === 'YES') {
      await report('CREATOR_MISSING', table, 'created_by', `${quote(table)} c`, `c.created_by is null and (${REPORTED_WITHOUT_CREATOR[table] ?? 'true'})`);
    }
    await report('CREATOR_NOT_RECORDED', table, 'created_by', `${quote(table)} c`, 'c.created_by = $1', [CREATOR_NOT_RECORDED_ID]);
  }

  return {
    database,
    latestMigration,
    scanned: { foreignKeys: keys.length, unvalidatedChecks: checks.rows.length, transactionKinds: kinds.rows.length, guards: INSERT_ONLY_GUARDS.length, creatorTables: creatorTables.rows.length },
    findings,
    unvalidated,
  };
}

/** The command: the target comes from `env` alone, and the answer is one JSON document or one line saying why there is none. */
export async function runPreGoLiveCheck(env: Record<string, string | undefined>, write: (text: string) => void): Promise<0 | 1 | 2> {
  try {
    const url = env[TARGET_SETTING];
    if (!url) throw new Error(`${TARGET_SETTING} is not set`);
    assertNotDevelopmentDatabase(url, env);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await assertNoDevelopmentSeed(client);
      const report = await preGoLiveCheck(client, databaseIdentity(url).database);
      write(JSON.stringify(report, null, 2));
      return report.findings.length ? 1 : 0;
    } finally {
      await client.end();
    }
  } catch (err) {
    write(`The check could not run: ${(err as Error).message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runPreGoLiveCheck(process.env, console.log);
}
