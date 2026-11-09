// The release gate (db/registers/release-gate.ts; decided under owner delegation, 6 Nov 2026: I-84) for BR-028 zero tolerance business
// gates (BRD line 1803), ZT20 requirements and coverage completeness (line 4787) and ZT21 open questions and privacy (line 4788). Each
// way a release could go out wrongly is planted in an otherwise clean synthetic record, which the gate must refuse; the clean record is
// the control. The repository's own registers, owner list and shared files are read where a test says so. Synthetic data only: every
// value shaped like a secret or a personal number is assembled at run time, so this file holds none.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BlockedEntry } from '../registers/blocked.js';
import { type OpenQuestion, OPEN_QUESTIONS, openQuestionStates, parseOwnerList } from '../registers/open-questions.js';
import { privacyHitsIn, scanSharedFiles } from '../registers/privacy.js';
import { evaluateReleaseGate, type GateInput, type GateResult, latestMigrationIn, loadGateInput, type RegisterRow, runReleaseGate, type RunRecord } from '../registers/release-gate.js';
import { parseRequirements } from '../registers/requirements.js';
import { decide } from '../registers/verification.js';
import { type GoLiveReport, runPreGoLiveCheck } from '../pre-go-live-check.js';
import { startTestDatabase, type TestDatabase } from './test-database.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const BRD = read('docs/source/HRMS_AI_Developer_Master_Prompt_v8.2.md');
const TRACEABILITY = read('docs/06_traceability_register.md');
const requirements = parseRequirements(BRD);
const LATEST = latestMigrationIn(join(ROOT, 'db', 'migrations'));

const passing = (id: string): RegisterRow => ({ id, disposition: 'Pass', reason: '1 named test passed', actual: '1 passed, 0 failed, 0 skipped' });
const asRow = (id: string, verdict: { disposition: string; reason: string }, actual = ''): RegisterRow => ({ id, ...verdict, actual });
const CLEAN_RUN: RunRecord = { label: 'Run T', evidence: 'evidence/run-t.json', success: true, failed: 0, filesWithoutResults: [], citedTests: [] };
const CLEAN_GO_LIVE: GoLiveReport = {
  database: null,
  latestMigration: LATEST,
  scanned: { foreignKeys: 1, unvalidatedChecks: 0, transactionKinds: 1, guards: 1, creatorTables: 1 },
  findings: [],
  unvalidated: [],
};

/** A clean record: every row passing, one clean run, nothing open, nothing found. Each test changes one thing. */
function input(over: Partial<GateInput> = {}, rows: Record<string, RegisterRow> = {}): GateInput {
  return {
    requirements,
    register: requirements.map((r) => rows[r.id] ?? passing(r.id)),
    registerText: '| ID | Disposition |',
    runs: [CLEAN_RUN],
    blocked: [],
    testSource: () => null,
    traceability: TRACEABILITY,
    brd: BRD,
    openQuestions: [],
    privacy: { files: 1, hits: [] },
    goLive: CLEAN_GO_LIVE,
    latestMigration: LATEST,
    ...over,
  };
}

const found = (result: GateResult, check?: string) => result.findings.filter((f) => !check || f.check === check);
const gateId = (title: string) => requirements.find((r) => r.family === 'ZT' && r.title === title)!.id;

// The gates BR-028 names, by the BRD's own titles.
const GATES: [string, string][] = [
  ['cross-organisation isolation', 'Cross-company access'],
  ['self-approval restriction', 'Self decision and duties'],
  ['duplicate entitlement', 'No duplicate or excess payment'],
  ['financial reconciliation', 'Report reconciliation'],
];

describe('BR-028 zero tolerance business gates: the release gate decides', () => {
  it('BR-028: with every row passing, its run clean and the pre-go-live check clean, the release may go out (the control)', () => {
    const result = evaluateReleaseGate(input());
    expect(result.findings).toEqual([]);
    expect(result.releasable).toBe(true);
    expect(result.delivered).toHaveLength(requirements.length);
  });

  it.each(GATES)('BR-028: a failed %s gate (%s) in the cited run blocks the release, even beside passing tests', (_kind, title) => {
    const id = gateId(title);
    const failed = decide([{ status: 'passed' }, { status: 'failed' }], [], []);
    const result = evaluateReleaseGate(input({ runs: [{ ...CLEAN_RUN, success: false, failed: 1 }] }, { [id]: asRow(id, failed, '1 passed, 1 failed, 0 skipped') }));
    expect(result.releasable).toBe(false);
    expect(found(result, 'FAILED')).toEqual([{ check: 'FAILED', id, detail: 'Named tests: 1 passed, 1 failed' }]);
    expect(found(result, 'RUNS')).toHaveLength(1);
  });

  it.each(GATES)('BR-028: a required %s gate that is specified, not reported as passed, blocks the release', (_kind, title) => {
    const id = gateId(title);
    for (const verdict of [decide([], [], []), decide([{ status: 'skipped' }], [], [])]) {
      const result = evaluateReleaseGate(input({}, { [id]: asRow(id, verdict) }));
      expect(result.releasable).toBe(false);
      expect(found(result).map((f) => [f.check, f.id])).toEqual([['NOT_EVIDENCED', id]]);
    }
  });

  it('BR-028: a gate whose only test is declared it.fails blocks the release, though vitest reports that test passed', () => {
    const id = gateId('Cross-company access');
    const name = `isolation (${id}) > company B sees nothing of company A`;
    // Assembled, so this file itself declares no it.fails for the generator to find.
    const fails = ['it', 'fails'].join('.');
    const source = `describe('isolation (${id})', () => {\n  ${fails}('company B sees nothing of company A', async () => {});\n});`;
    // The generator marks it and the register says Fail; the gate also reads the test file itself, for a register made before the mark.
    expect(decide([{ status: 'passed', expectedFailure: true }], [], []).disposition).toBe('Fail');
    const cited = { file: 'apps/api/src/synthetic.api.test.ts', name, status: 'passed' };
    const result = evaluateReleaseGate(input({ runs: [{ ...CLEAN_RUN, citedTests: [cited] }], testSource: (f) => (f === cited.file ? source : null) }));
    expect(found(result).map((f) => f.check)).toEqual(['EXPECTED_FAILURE']);
    expect(found(result)[0]!.detail).toContain('declared it.fails');
    // The same test without .fails is evidence, not a finding.
    expect(evaluateReleaseGate(input({ runs: [{ ...CLEAN_RUN, citedTests: [cited] }], testSource: () => source.replace(`${fails}(`, 'it(') })).releasable).toBe(true);
  });

  it('BR-028: a run vitest reported failed, or a file that never reported its tests, blocks the release even when every row says Pass', () => {
    expect(found(evaluateReleaseGate(input({ runs: [{ ...CLEAN_RUN, success: false }] })), 'RUNS')).toHaveLength(1);
    expect(found(evaluateReleaseGate(input({ runs: [{ ...CLEAN_RUN, filesWithoutResults: ['apps/api/src/x.api.test.ts'] }] })), 'RUNS')[0]!.detail).toContain('x.api.test.ts');
    expect(found(evaluateReleaseGate(input({ runs: [] })), 'RUNS')).toHaveLength(1);
  });

  it('BR-028: a register that no longer matches the blocked list blocks the release until it is regenerated', () => {
    const entry: BlockedEntry = { ids: ['FR-036'], reason: 'Waiting on a synthetic owner input', source: 'docs/x.md', stillSays: 'x' };
    const stillPassing = evaluateReleaseGate(input({ blocked: [entry] }));
    expect(found(stillPassing).map((f) => [f.check, f.id])).toEqual([['REGISTER_CURRENT', 'FR-036']]);
    const blockedNoMore = evaluateReleaseGate(input({}, { 'FR-036': asRow('FR-036', { disposition: 'Blocked', reason: 'Old reason' }) }));
    expect(found(blockedNoMore).map((f) => [f.check, f.id])).toEqual([['REGISTER_CURRENT', 'FR-036']]);
    const missing = evaluateReleaseGate({ ...input(), register: input().register.filter((r) => r.id !== 'ZT01') });
    expect(found(missing).map((f) => [f.check, f.id])).toEqual([['REGISTER_CURRENT', 'ZT01']]);
  });

  it('BR-028: the pre-go-live check must have been run on the release’s schema and found nothing', () => {
    expect(found(evaluateReleaseGate(input({ goLive: null })), 'GO_LIVE')[0]!.detail).toContain('No pre-go-live check report');
    expect(found(evaluateReleaseGate(input({ goLive: { ...CLEAN_GO_LIVE, latestMigration: '0151_old.sql' } })), 'GO_LIVE')[0]!.detail).toContain('0151_old.sql');
    const broken = { ...CLEAN_GO_LIVE, findings: [{ code: 'KEY_BROKEN' as const, table: 'expense_claim', rule: 'expense_claim_owner_agrees', count: 2, ids: [] }] };
    expect(found(evaluateReleaseGate(input({ goLive: broken })), 'GO_LIVE')[0]!.detail).toBe('KEY_BROKEN expense_claim.expense_claim_owner_agrees: 2 rows');
  });

  describe('with the real pre-go-live check', () => {
    let testDb: TestDatabase;

    beforeAll(async () => {
      testDb = await startTestDatabase();
    });

    afterAll(async () => {
      await testDb?.stop();
    });

    it('BR-028: the report `npm run db:check-go-live` prints for a freshly migrated database is read and accepted; one with a broken row is not', async () => {
      const printed: string[] = [];
      expect(await runPreGoLiveCheck({ HRMS_CHECK_DATABASE_URL: testDb.connectionString }, (t) => printed.push(t))).toBe(0);
      const report = JSON.parse(printed.join('\n')) as GoLiveReport;
      expect(report.latestMigration).toBe(LATEST);
      expect(evaluateReleaseGate(input({ goLive: report })).releasable).toBe(true);
      // A child row whose parent is missing, written past the key as a restore would.
      await testDb.client.query('set session_replication_role = replica');
      await testDb.client.query(`insert into department (company_id, code, name, active) values ('00000000-0000-4000-8000-0000000000fe', 'GHOST', 'Synthetic', true)`);
      await testDb.client.query('set session_replication_role = origin');
      const again: string[] = [];
      expect(await runPreGoLiveCheck({ HRMS_CHECK_DATABASE_URL: testDb.connectionString }, (t) => again.push(t))).toBe(1);
      const result = evaluateReleaseGate(input({ goLive: JSON.parse(again.join('\n')) as GoLiveReport }));
      expect(result.releasable).toBe(false);
      expect(found(result, 'GO_LIVE')[0]!.detail).toMatch(/^KEY_BROKEN department\./);
    });
  });

  describe('the command', () => {
    let scratch: string;

    beforeAll(() => {
      scratch = mkdtempSync(join(tmpdir(), 'hrms-release-gate-'));
    });

    afterAll(() => {
      rmSync(scratch, { recursive: true, force: true });
    });

    it('BR-028 (the command, on this repository’s registers): with no pre-go-live report it answers 1 and says why, and it never writes into the registers', () => {
      const out = join(scratch, 'gate.md');
      const printed: string[] = [];
      expect(runReleaseGate(['--out', out], (t) => printed.push(t))).toBe(1);
      const report = readFileSync(out, 'utf8');
      expect(report).toContain('**The release is blocked**');
      expect(report).toContain('| GO_LIVE |  | No pre-go-live check report was given');
      expect(report).toContain('## Undelivered scope (Blocked: not in this release)');

      const refused: string[] = [];
      expect(runReleaseGate(['--out', join(ROOT, 'docs', 'registers', 'gate.md')], (t) => refused.push(t))).toBe(2);
      expect(refused.join('\n')).toContain('never writes into the generated registers');
      expect(existsSync(join(ROOT, 'docs', 'registers', 'gate.md'))).toBe(false);
      expect(runReleaseGate(['--registers', join(scratch, 'nothing-here')], () => undefined)).toBe(2);
    });
  });
});

describe('ZT20 requirements and coverage completeness: delivered is every row not Blocked', () => {
  const blockedEntry: BlockedEntry = { ids: ['FR-036'], reason: 'Waiting on a synthetic owner input', source: 'docs/x.md', stillSays: 'x' };
  const blockedRow = asRow('FR-036', decide([{ status: 'passed' }], [blockedEntry], []));

  it('ZT20: a Blocked row is undelivered scope, listed with its reason, and never counted as delivered or passed', () => {
    const result = evaluateReleaseGate(input({ blocked: [blockedEntry] }, { 'FR-036': blockedRow }));
    expect(result.releasable).toBe(true);
    expect(result.delivered).not.toContain('FR-036');
    expect(result.undelivered).toEqual([{ id: 'FR-036', reason: expect.stringContaining('Waiting on a synthetic owner input') }]);
  });

  it('ZT20: a delivered FR without its traceability row, source, decision, or table or stated no-storage reason blocks the release', () => {
    const lines = TRACEABILITY.split('\n');
    const withoutRow = lines.filter((l) => !l.startsWith('| FR-001 |')).join('\n');
    expect(found(evaluateReleaseGate(input({ traceability: withoutRow })))).toEqual([{ check: 'COVERAGE', id: 'FR-001', detail: expect.stringContaining('no traceability row') }]);
    const blanked = lines.map((l) => (l.startsWith('| FR-001 |') ? l.replace('| E01/E16 | DF10 | user_account |', '|  |  | — |') : l)).join('\n');
    expect(found(evaluateReleaseGate(input({ traceability: blanked })))[0]!.detail).toMatch(/no source, no decision, no table and no stated no-storage reason/);
    // A Blocked FR is not delivered, so its mapping is not this release's question.
    const blockedOnly = lines.filter((l) => !l.startsWith('| FR-036 |')).join('\n');
    expect(evaluateReleaseGate(input({ traceability: blockedOnly, blocked: [blockedEntry] }, { 'FR-036': blockedRow })).releasable).toBe(true);
  });

  it('ZT20: a delivered BR without its module, mechanism or related FR blocks the release', () => {
    const changed = TRACEABILITY.split('\n').map((l) => (l.startsWith('| BR-001 |') ? '| BR-001 | Employee identity uniqueness | Employee |  | FR-006 | ZT07 |' : l)).join('\n');
    expect(found(evaluateReleaseGate(input({ traceability: changed })))).toEqual([{ check: 'COVERAGE', id: 'BR-001', detail: expect.stringContaining('no module, mechanism or related FR') }]);
  });

  it('ZT20: a delivered row whose register shows no passing named test blocks the release', () => {
    const result = evaluateReleaseGate(input({}, { 'FR-002': { ...passing('FR-002'), actual: '0 passed, 0 failed, 1 skipped' } }));
    expect(found(result)).toEqual([{ check: 'COVERAGE', id: 'FR-002', detail: expect.stringContaining('no passing named test') }]);
  });

  it('ZT20: the Coverage Log keeps its 259 items with allowed statuses, and the register calls none of them verified', () => {
    const verified = BRD.replace(/^(\| CL-001<br>[^|]*\| )Documented<br>/m, '$1Verified<br>');
    expect(verified).not.toBe(BRD);
    expect(found(evaluateReleaseGate(input({ brd: verified })))[0]!.detail).toBe('CL-001 has status "Verified", which is not an allowed Coverage Log status');
    const lost = BRD.replace(/^\| CL-259<br>.*$/m, '');
    expect(found(evaluateReleaseGate(input({ brd: lost })))[0]!.detail).toContain('258 distinct items where 259 are recorded');
    expect(found(evaluateReleaseGate(input({ registerText: '| CL-007 | Verified |' })))[0]!.detail).toContain('CL-007');
  });

  it('ZT20 (this repository): every delivered FR and BR in the current verification register maps to its source, decision and table or no-storage reason, and shows a passing named test', () => {
    const result = evaluateReleaseGate(loadGateInput(ROOT, join(ROOT, 'docs', 'registers'), null));
    expect(result.delivered.length).toBeGreaterThan(100);
    expect(found(result, 'COVERAGE')).toEqual([]);
  });
});

describe('ZT21 open questions and privacy', () => {
  const OWNER_LIST = [
    '## A. Decisions',
    '',
    '1. Decided (I-79): arrears are calculated from the frozen records.',
    '4. Grade salary structures: the synthetic rules (FR-028/029).',
    '11a. **Sign-off needed (quick review):** the closure actions.',
    '',
    '## B. Who holds which rights',
    '',
    '1. Who approves rerouting a stuck task (I-52 item 1)?',
    '',
    '## E. Handover',
    '',
    '3. Done 6 Nov (owner: replace).',
  ].join('\n');
  const entry = (over: Partial<OpenQuestion>): OpenQuestion => ({ item: 'A4', kind: 'calculation', affects: ['FR-028'], stillSays: 'Grade salary structures', ...over });
  const ENTRIES = [entry({}), entry({ item: 'A11a', affects: ['FR-055'], stillSays: 'closure actions' }), entry({ item: 'B1', kind: 'permission', affects: ['ZT02'], stillSays: 'rerouting a stuck task', decidedIn: 'I-84' })];

  it('ZT21: reads the owner list: Decided and Done items are closed; questions and sign-offs are open', () => {
    expect(parseOwnerList(OWNER_LIST).map((i) => [i.item, i.open])).toEqual([
      ['A1', false],
      ['A4', true],
      ['A11a', true],
      ['B1', true],
      ['E3', false],
    ]);
  });

  it('ZT21: an open owner question that affects a delivered row blocks the release; on a Blocked row it does not', () => {
    const states = openQuestionStates(parseOwnerList(OWNER_LIST), ENTRIES);
    const result = evaluateReleaseGate(input({ openQuestions: states }));
    expect(found(result).map((f) => [f.check, f.id])).toEqual([
      ['OPEN_QUESTION', 'FR-028'],
      ['OPEN_QUESTION', 'FR-055'],
      ['OPEN_QUESTION', 'ZT02'],
    ]);
    expect(found(result)[2]!.detail).toContain('I-84 decided it, but docs/10 does not say so yet');
    const blocked: BlockedEntry[] = [{ ids: ['FR-028', 'FR-055', 'ZT02'], reason: 'Synthetic', source: 'docs/x.md', stillSays: 'x' }];
    const rows = Object.fromEntries(['FR-028', 'FR-055', 'ZT02'].map((id) => [id, asRow(id, { disposition: 'Blocked', reason: 'Synthetic' })]));
    expect(evaluateReleaseGate(input({ openQuestions: states, blocked }, rows)).releasable).toBe(true);
  });

  it('ZT21: the gate stops when the owner list and the mapping disagree, and a decision recorded in the owner list closes its entry', () => {
    const list = parseOwnerList(OWNER_LIST);
    expect(() => openQuestionStates(list, ENTRIES.slice(1))).toThrow(/item A4 is open, but db\/registers\/open-questions.ts does not say which rows it affects/);
    expect(() => openQuestionStates(list, [...ENTRIES, entry({ item: 'A1', stillSays: 'arrears' })])).toThrow(/item A1 is no longer open; remove it/);
    expect(() => openQuestionStates(list, [entry({ stillSays: 'something else' }), ...ENTRIES.slice(1)])).toThrow(/no longer says "something else"/);
    expect(() => openQuestionStates(list, [...ENTRIES, entry({ item: 'A99' })])).toThrow(/has no item A99/);
    expect(() => openQuestionStates(list, [entry({ affects: [] }), ...ENTRIES.slice(1)])).toThrow(/affects no row and says not why/);
    // Once the owner list says Decided, the entry naming that decision is inert.
    const decided = parseOwnerList(OWNER_LIST.replace('1. Who approves rerouting a stuck task', '1. Decided (I-84): HR Administrator reroutes a stuck task'));
    const states = openQuestionStates(decided, ENTRIES);
    expect(states.find((s) => s.entry.item === 'B1')!.open).toBe(false);
    expect(found(evaluateReleaseGate(input({ openQuestions: states }))).map((f) => f.id)).toEqual(['FR-028', 'FR-055']);
  });

  it('ZT21 (this repository): every open item in docs/10 is mapped to the rows it affects, and each entry still says what docs/10 says', () => {
    const states = openQuestionStates(parseOwnerList(read('docs/10_owner_decisions.md')));
    expect(states.filter((s) => s.open).length).toBeGreaterThan(0);
    const known = new Set(requirements.map((r) => r.id));
    for (const q of OPEN_QUESTIONS) for (const id of q.affects) expect(known.has(id), `${q.item}: ${id}`).toBe(true);
  });

  it('ZT21: a credential, a technical address or a personal-number shape in a shared file blocks the release, and the report never repeats it', () => {
    const pan = ['QWERT', '5678', 'Y'].join('');
    const ip = ['10', '20', '30', '40'].join('.');
    const key = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('');
    const reserved = `${['person', 'example.com'].join('@')} ${['192', '0', '2', '9'].join('.')}`;
    const hits = privacyHitsIn([
      ['docs/synthetic.md', `line one\nPAN ${pan}\nhost ${ip}\n${key}`],
      ['docs/reserved.md', reserved],
    ]);
    expect(hits.map((h) => [h.file, h.line, h.code])).toEqual([
      ['docs/synthetic.md', 4, 'PRIVATE_KEY'],
      ['docs/synthetic.md', 2, 'PAN'],
      ['docs/synthetic.md', 3, 'ADDRESS'],
    ]);
    const result = evaluateReleaseGate(input({ privacy: { files: 2, hits } }));
    expect(found(result).map((f) => f.check)).toEqual(['PRIVACY', 'PRIVACY', 'PRIVACY']);
    for (const f of found(result)) for (const secret of [pan, ip]) expect(f.detail).not.toContain(secret);
    expect(found(evaluateReleaseGate(input({ privacy: { files: 0, hits: [] } })), 'PRIVACY')).toHaveLength(1);
  });

  it('ZT21 (this repository, a pattern scan: it cannot prove a name or a date is synthetic): no shared file holds a credential, a technical address or a personal-number shape', () => {
    const scan = scanSharedFiles(ROOT);
    expect(scan.files).toBeGreaterThan(500);
    expect(scan.hits.map((h) => `${h.file}:${h.line} ${h.code}`)).toEqual([]);
  });
});
