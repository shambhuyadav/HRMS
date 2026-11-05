// The generator behind docs/registers (gates-15). These rules decide what an acceptance record is allowed to say, so each way a row could
// be wrongly upgraded is pinned here. The catalogue part reads a real migrated database. Synthetic data only.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAccessMatrix, type TraceLine } from '../registers/access.js';
import { BLOCKED, checkBlockedSources } from '../registers/blocked.js';
import { EXPECTED_COUNTS, idsNamedIn, parseRequirements } from '../registers/requirements.js';
import { parseRun, type RunEvidence } from '../registers/runs.js';
import { buildSchemaRegister, type ColumnRow, parseEnforcementRecord, type SchemaRegister } from '../registers/schema.js';
import { buildVerification, decide } from '../registers/verification.js';
import { startTestDatabase, type TestDatabase } from './test-database.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const BRD = 'docs/source/HRMS_AI_Developer_Master_Prompt_v8.2.md';

const run = (tests: { name: string; status: 'passed' | 'failed' | 'skipped'; file?: string }[]): RunEvidence => ({
  label: 'Run T',
  sha256: 'x',
  startedAt: '2026-01-01T00:00:00.000Z',
  passed: 0,
  failed: 0,
  skipped: 0,
  success: true,
  filesWithoutResults: [],
  tests: tests.map((t) => ({ file: t.file ?? 'a.test.ts', name: t.name, status: t.status })),
});

describe('the identifiers the record must cover', () => {
  const requirements = parseRequirements(read(BRD));

  it('finds every row of every family in the BRD', () => {
    for (const [family, count] of Object.entries(EXPECTED_COUNTS)) expect(requirements.filter((r) => r.family === family)).toHaveLength(count);
  });

  it.each([
    ['FR-001', 'Authentication and session control', /disabled user cannot sign in/, /Observed control/],
    ['FR-110', 'Expose own assets and development', /./, /./],
    ['BR-001', 'Employee identity', /uniqueness scope/, /^Proposed$/],
    ['BR-047', 'Processed payroll is immutable', /no unlock-in-place/, /Appendix H/],
    ['DQ-01', 'Entity to screen', /Match each important screen/, /Business mapping documented/],
    ['CI01', 'Approval instance and task', /approval_task\.step_id/, /no per-row/],
    ['CI22', 'prove confidential access requires an eligible active assignment', /privilege stitching fails/, /no per-row/],
    ['CI23', 'dashboard definitions/widgets resolve same-company parents', /non-overlapping active definitions/, /no per-row/],
    ['CI24', 'Assignment privilege containment', /in one assignment/, /no per-row/],
    ['CI25', 'Payroll freeze', /Atomic lock commit/, /no per-row/],
    ['ZT06', 'Orphan and tenant mismatch', /Referential scan shows zero orphans/, /no per-row/],
    ['ZT40', 'Sensitive change approval', /independent approval/, /no per-row/],
  ])('reads %s from its definition', (id, title, expected, classification) => {
    const row = requirements.find((r) => r.id === id)!;
    expect(row.title).toBe(title);
    expect(row.expected).toMatch(expected);
    expect(row.classification).toMatch(classification);
  });

  it('points at the line that defines each one', () => {
    const lines = read(BRD).split(/\r?\n/);
    for (const r of requirements) expect(lines[r.line - 1], r.id).toContain(r.id);
  });

  it('refuses a BRD that has lost a row, rather than certifying less', () => {
    expect(() => parseRequirements(read(BRD).replace(/^\| ZT40 .*$/m, ''))).toThrow(/39 ZT rows where 40 are expected/);
  });
});

describe('what a test name states', () => {
  it.each([
    ['tenancy and organisation (ZT06, ZT08) rejects a value (CI15)', ['CI15', 'ZT06', 'ZT08']],
    ['employee identity (ZT07, BR-001/002) keeps it', ['BR-001', 'BR-002', 'ZT07']],
    ['leave (FR-025 to FR-027) submits', ['FR-025', 'FR-026', 'FR-027']],
    ['grants (FR-098/BR-044)', ['BR-044', 'FR-098']],
    ['ZT06 to ZT08 all hold', ['ZT06', 'ZT07', 'ZT08']],
    ['CI01–CI03 hold', ['CI01', 'CI02', 'CI03']],
    ['DQ-08 and DQ09', ['DQ-08', 'DQ-09']],
    ['nothing here', []],
    ['FR-012 to the manager', ['FR-012']],
    ['a code like FR-0123 or ZT123 is not one', []],
    ['SCI01 or CI01X is not one', []],
  ])('%s', (name, ids) => {
    expect(idsNamedIn(name)).toEqual(ids);
  });
});

describe('a disposition', () => {
  const block = { reason: 'Waiting on the owner', source: 'docs/x.md' };
  const passed = { status: 'passed' as const };
  const failed = { status: 'failed' as const };
  const skipped = { status: 'skipped' as const };

  it('is Pass only when a named test passed', () => {
    expect(decide([passed], [], []).disposition).toBe('Pass');
  });

  it('is Fail whenever a named test failed, whatever else passed or blocks it', () => {
    expect(decide([passed, failed], [], []).disposition).toBe('Fail');
    expect(decide([failed], [block], []).disposition).toBe('Fail');
  });

  it('stays Blocked when tests pass: they do not settle the open rule', () => {
    const { disposition, reason } = decide([passed], [block], []);
    expect(disposition).toBe('Blocked');
    expect(reason).toMatch(/Waiting on the owner \(docs\/x\.md\).*does not clear it/);
  });

  it('is never Pass from a skipped test', () => {
    const { disposition, reason } = decide([skipped], [], []);
    expect(disposition).toBe('Not evidenced');
    expect(reason).toMatch(/did not run/);
  });

  it('is never Pass from a mention in a file', () => {
    const { disposition, reason } = decide([], [], ['b.test.ts']);
    expect(disposition).toBe('Not evidenced');
    expect(reason).toMatch(/mentioned in 1 test file/);
  });

  it('says so when nothing names it', () => {
    expect(decide([], [], [])).toEqual({ disposition: 'Not evidenced', reason: 'No test names or mentions it' });
  });

  it('takes only what the cited run shows for that identifier', () => {
    const requirement = { id: 'FR-001', family: 'FR' as const, title: 't', line: 1, classification: 'c', expected: 'e' };
    const rows = buildVerification(
      [requirement, { ...requirement, id: 'FR-002' }, { ...requirement, id: 'FR-003' }],
      [run([{ name: 'first (FR-001) works', status: 'passed' }, { name: 'other (FR-003) works', status: 'skipped', file: 'c.test.ts' }])],
      [],
      new Map([['b.test.ts', '// about FR-002'], ['a.test.ts', '// about FR-001 and FR-002']]),
    );
    expect(rows.map((r) => r.disposition)).toEqual(['Pass', 'Not evidenced', 'Not evidenced']);
    expect(rows[0]!.named).toEqual([{ file: 'a.test.ts', name: 'first (FR-001) works', status: 'passed', run: 'Run T' }]);
    expect(rows[0]!.mentionedIn).toEqual([]);
    expect(rows[1]!.mentionedIn).toEqual(['a.test.ts', 'b.test.ts']);
  });
});

describe('a run read as evidence', () => {
  const json = JSON.stringify({
    startTime: Date.UTC(2026, 10, 4),
    success: false,
    testResults: [
      { name: join(ROOT, 'db/tests/a.test.ts'), status: 'passed', assertionResults: [{ ancestorTitles: ['outer', 'inner'], title: 'holds', status: 'passed' }, { ancestorTitles: [], title: 'waits', status: 'pending' }, { ancestorTitles: [], title: 'later', status: 'todo' }] },
      { name: join(ROOT, 'db/tests/b.test.ts'), status: 'failed', assertionResults: [] },
      { name: join(ROOT, 'db/tests/c.test.ts'), status: 'failed', assertionResults: [{ ancestorTitles: [], title: 'breaks', status: 'failed' }] },
    ],
  });

  it('names tests as the trace does, relative to the repository', () => {
    const { tests } = parseRun('Run T', json, ROOT);
    expect(tests[0]).toEqual({ file: 'db/tests/a.test.ts', name: 'outer > inner > holds', status: 'passed' });
  });

  it('counts anything not run as skipped, which is not evidence', () => {
    expect(parseRun('Run T', json, ROOT)).toMatchObject({ passed: 1, failed: 1, skipped: 2, success: false });
  });

  it('reports a file that never reached its tests', () => {
    expect(parseRun('Run T', json, ROOT).filesWithoutResults).toEqual(['db/tests/b.test.ts']);
  });

  it('keeps a hash that tells two runs apart', () => {
    expect(parseRun('Run T', json, ROOT).sha256).not.toBe(parseRun('Run T', `${json} `, ROOT).sha256);
  });
});

describe('the access matrix', () => {
  const permissions = [
    { resource: 'leave', action: 'approve', fieldGroup: 'operational' },
    { resource: 'leave', action: 'read', fieldGroup: 'operational' },
    { resource: 'salary', action: 'read', fieldGroup: 'salary' },
    { resource: 'unused', action: 'thing', fieldGroup: 'operational' },
  ];
  const roles = [{ code: 'MANAGER', ceiling: ['leave.approve.operational', 'leave.read.operational', 'ghost.read.operational'], defaultDuties: ['leave.read.operational'] }];
  const line = (over: Partial<TraceLine>): TraceLine => ({ file: 'a.test.ts', test: 'held', resource: 'leave', action: 'approve', fieldGroup: 'operational', outcome: 'ALLOW', reason: null, ...over });
  const passing = run([{ name: 'held', status: 'passed' }, { name: 'refused', status: 'passed' }, { name: 'broke', status: 'failed' }, { name: 'skipped', status: 'skipped' }]);
  const row = (matrix: ReturnType<typeof buildAccessMatrix>, key: string) => matrix.rows.find((r) => r.key === key)!;

  it('shows both sides only when a passing test asked each way', () => {
    const matrix = buildAccessMatrix(permissions, roles, [passing], [line({}), line({ test: 'refused', outcome: 'DENY', reason: 'NO_PERMISSION' })], new Map());
    expect(row(matrix, 'leave.approve.operational')).toMatchObject({ basis: 'Traced', gap: '', positive: [{ file: 'a.test.ts', name: 'held' }], negative: [{ file: 'a.test.ts', name: 'refused' }] });
  });

  it('names the missing side', () => {
    const matrix = buildAccessMatrix(permissions, roles, [passing], [line({ action: 'read' }), line({ resource: 'salary', action: 'read', fieldGroup: 'salary', test: 'refused', outcome: 'DENY', reason: 'CONFIDENTIAL_NOT_ELIGIBLE' })], new Map());
    expect(row(matrix, 'leave.read.operational').gap).toBe('No negative test');
    expect(row(matrix, 'salary.read.salary').gap).toBe('No positive test');
    expect(row(matrix, 'unused.thing.operational')).toMatchObject({ basis: 'Not exercised', gap: 'No positive or negative test' });
  });

  it('does not count a test that failed or did not run, or one the run does not contain', () => {
    const matrix = buildAccessMatrix(permissions, roles, [passing], [line({ test: 'broke' }), line({ test: 'skipped' }), line({ test: 'not in this run' })], new Map());
    expect(row(matrix, 'leave.approve.operational')).toMatchObject({ positive: [], gap: 'No positive or negative test' });
  });

  it('without a trace claims nothing a name cannot show', () => {
    const matrix = buildAccessMatrix(permissions, roles, [passing], null, new Map([['a.test.ts', `grant('leave.approve.operational')`]]));
    expect(matrix.traced).toBe(false);
    expect(row(matrix, 'leave.approve.operational')).toMatchObject({ basis: 'Name only', positive: [], negative: [], namedInFiles: ['a.test.ts'], gap: 'Not traced: a name match cannot tell positive from negative' });
    expect(row(matrix, 'unused.thing.operational')).toMatchObject({ basis: 'None', gap: 'Not traced, and no test file names it' });
  });

  it('reads the roles from the baseline', () => {
    const matrix = buildAccessMatrix(permissions, roles, [passing], null, new Map());
    expect(row(matrix, 'leave.read.operational')).toMatchObject({ ceilingRoles: ['MANAGER'], dutyRoles: ['MANAGER'] });
    expect(row(matrix, 'salary.read.salary')).toMatchObject({ ceilingRoles: [], dutyRoles: [] });
  });

  it('flags a permission granted or asked for that the catalogue does not hold', () => {
    const matrix = buildAccessMatrix(permissions, roles, [passing], [line({ resource: 'phantom' })], new Map());
    expect(matrix.grantedButNotCatalogued).toEqual(['ghost.read.operational']);
    expect(matrix.askedButNotCatalogued).toEqual(['phantom.approve.operational']);
  });
});

describe('blocked rows', () => {
  it('each still rests on what its register says today', () => {
    expect(() => checkBlockedSources(read)).not.toThrow();
  });

  it('stops the generator when a register no longer says it', () => {
    expect(() => checkBlockedSources(() => 'nothing', BLOCKED.slice(0, 1))).toThrow(/no longer says/);
  });
});

describe('the schema constraint register', () => {
  let testDb: TestDatabase;
  let db: pg.Client;
  let register: SchemaRegister;
  const column = (table: string, name: string): ColumnRow => {
    const found = register.columns.find((c) => c.table === table && c.column === name);
    if (!found) throw new Error(`No row for ${table}.${name}`);
    return found;
  };

  beforeAll(async () => {
    testDb = await startTestDatabase();
    db = testDb.client;
    register = await buildSchemaRegister(db, parseEnforcementRecord(read('docs/07_register_templates.md')));
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it('has a row for every column of every table, and no bookkeeping table', async () => {
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from information_schema.columns c join information_schema.tables t using (table_schema, table_name) where c.table_schema = current_schema() and t.table_type = 'BASE TABLE' and c.table_name <> 'schema_migration'`);
    expect(register.columns).toHaveLength(rows[0]!.n);
    expect(register.columns.some((c) => c.table === 'schema_migration')).toBe(false);
  });

  it('shows a primary key and its gate', () => {
    expect(column('employee', 'id')).toMatchObject({ pk: 'Yes', nullability: 'NOT NULL with default' });
    expect(column('employee', 'id').ciZt).toContain('ZT07');
  });

  it('shows a composite key held to the company', () => {
    const row = column('expense_claim', 'employee_id');
    expect(row.companyBoundary).toBe('Composite key with company_id');
    expect(row.fk).toContain('employee(company_id, id)');
    expect(row.ciZt).toContain('ZT06');
  });

  it('marks a deferred key as checked at commit, and takes its CI from the enforcement record', () => {
    const row = column('expense_claim', 'employee_id');
    expect(row.mechanism).toMatch(/FK expense_claim_owner_agrees \(at commit\)/);
    expect(row.ciZt).toContain('CI12');
  });

  it('marks a global table', () => {
    expect(column('user_account', 'account_key').companyBoundary).toBe('Global table');
  });

  it('names a reference category from the key that fixes it', () => {
    expect(column('employee', 'status_id').refCategory).toBe('EMPLOYEE_STATUS');
  });

  it('names a fixed list from its check', () => {
    expect(column('increment_case', 'state').refCategory).toMatch(/^Fixed list/);
    expect(column('increment_case', 'state').ciZt).toContain('ZT10');
  });

  it('shows an interval rule', () => {
    expect(column('salary_arrangement', 'effective_from').intervalRule).not.toBe('');
    expect(column('salary_arrangement', 'effective_from').ciZt).toContain('ZT09');
  });

  it('shows a column fixed once written, by its own trigger', () => {
    const row = column('employee_confirmation', 'policy_id');
    expect(row.mechanism).toContain('TR employee_confirmation_fixed');
    expect(row.ciZt).toContain('ZT12');
    expect(column('employee_confirmation', 'current_due_date').mechanism).not.toContain('employee_confirmation_fixed');
  });

  it('lists what a trigger applies to, with its arguments and timing', () => {
    expect(register.triggers.find((t) => t.trigger === 'employee_confirmation_fixed')).toEqual({
      table: 'employee_confirmation',
      trigger: 'employee_confirmation_fixed',
      when: 'before update',
      fn: 'hrms_columns_fixed(policy_id, start_date, initial_due_date)',
    });
    expect(register.triggers.find((t) => t.trigger === 'business_transaction_state_agrees')?.when).toBe('at commit update');
  });

  it('names the constraints never validated', () => {
    expect(register.unvalidated).toContainEqual({ table: 'role_assignment', constraint: 'role_assignment_revoked_reason' });
  });
});
