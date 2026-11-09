// The release gate (decided under owner delegation, 6 Nov 2026: I-84; BR-028 "any failed cross-organisation isolation, self-approval
// restriction, duplicate entitlement or financial reconciliation blocks release of the affected scope. Required tests are specified,
// not reported as passed"; ZT20; ZT21; BRD lines 124-126 and Appendix D).
//
// What blocks a release is this gate, run on the release candidate's registers; who may override it is nobody: a failed gate is fixed
// and the run repeated (Appendix D), and scope leaves a release only through an owner-approved deferral recorded in the registers.
// It reads what db/registers/generate.ts wrote and the JSON of `npm run db:check-go-live` on a copy of the live database, and refuses
// the release when:
//   * a cited run failed, or a file in it reported no tests;
//   * the register no longer matches db/registers/blocked.ts (regenerate it);
//   * a row in the release scope is Fail or Not evidenced (BR-028: "specified, not reported as passed" is not a pass);
//   * a cited test is declared it.fails (it passes only while its behaviour is wrong);
//   * an open owner question (docs/10, mapped in open-questions.ts) affects a delivered row (ZT21);
//   * a delivered FR or BR lacks its traceability or a passing named test, or a Coverage Log item lost its allowed status (ZT20);
//   * a shared file holds a credential, a technical address or a personal-number shape (ZT21; privacy.ts);
//   * the pre-go-live check was not run, was run on another schema, or found rows the guards would refuse.
// "Delivered" (ZT20, I-84): every row not Blocked. A Blocked row waits on an owner input or an environment (blocked.ts), so BRD line
// 126 keeps it out of the release; the gate lists it as undelivered scope with its reason, and never counts it as passed.
//
//   npm run release:gate -- [--registers <dir>] [--go-live <check.json>] [--out <report.md>]
//
// Exit code 0: the release may go out. 1: it is blocked, and the report says why. 2: the gate could not run (a register missing or
// unreadable, or a source that blocked.ts or open-questions.ts copied has moved). It changes nothing; it writes only to --out.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { GoLiveReport } from '../pre-go-live-check.js';
import { BLOCKED, type BlockedEntry, checkBlockedSources } from './blocked.js';
import { type OpenQuestionState, openQuestionStates, parseOwnerList } from './open-questions.js';
import { type PrivacyHit, scanSharedFiles } from './privacy.js';
import { parseRequirements, type Requirement } from './requirements.js';
import { declaredToFail } from './runs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRD = 'docs/source/HRMS_AI_Developer_Master_Prompt_v8.2.md';
const TRACEABILITY = 'docs/06_traceability_register.md';
const OWNER_LIST = 'docs/10_owner_decisions.md';
const REGISTERS = 'docs/registers';
const VERIFICATION = 'verification-register.md';

/** Coverage Log statuses that are not results (BRD Appendix A): an item keeps one of these and is never called verified (ZT20). */
export const CL_ALLOWED_STATUSES = ['Documented', 'Restricted', 'Not reachable'] as const;
export const CL_COUNT = 259;

export type GateCheck = 'RUNS' | 'REGISTER_CURRENT' | 'FAILED' | 'NOT_EVIDENCED' | 'EXPECTED_FAILURE' | 'OPEN_QUESTION' | 'COVERAGE' | 'PRIVACY' | 'GO_LIVE';

export interface GateFinding {
  check: GateCheck;
  /** The requirement row, where the finding is about one. */
  id?: string;
  detail: string;
}

export interface RegisterRow {
  id: string;
  disposition: string;
  reason: string;
  /** The register's "Actual" cell: "3 passed, 0 failed, 0 skipped". */
  actual: string;
}

export interface CitedTest {
  file: string;
  name: string;
  status: string;
  expectedFailure?: boolean;
}

export interface RunRecord {
  label: string;
  /** The evidence file the register names for it. */
  evidence: string;
  success: boolean;
  failed: number;
  filesWithoutResults: string[];
  citedTests: CitedTest[];
}

export interface GateInput {
  requirements: readonly Requirement[];
  register: readonly RegisterRow[];
  /** The register's own text, for anything it must never say (a Coverage Log identifier). */
  registerText: string;
  runs: readonly RunRecord[];
  blocked: readonly BlockedEntry[];
  /** A repository test file's text, or null when it is not there. */
  testSource: (file: string) => string | null;
  traceability: string;
  brd: string;
  openQuestions: readonly OpenQuestionState[];
  privacy: { files: number; hits: readonly PrivacyHit[] };
  goLive: GoLiveReport | null;
  /** The newest migration in the tree (not a draft), which the pre-go-live check must have read. */
  latestMigration: string;
}

export interface GateResult {
  releasable: boolean;
  findings: GateFinding[];
  /** Rows in the release scope. */
  delivered: string[];
  /** Blocked rows: not in this release, with the reason the register gives. */
  undelivered: { id: string; reason: string }[];
}

/** The rows of a markdown table whose header row starts with `| firstHeader |`, as { header: cell }; an escaped `\|` stays in its cell. */
export function tableRows(text: string, firstHeader: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`| ${firstHeader} |`));
  if (start < 0) return [];
  const headers = lines[start]!.split('|').slice(1, -1).map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim().replace(/\\\|/g, '|'));
    rows.push(Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])));
  }
  return rows;
}

/** The verification register's rows. */
export function parseRegister(text: string): RegisterRow[] {
  return tableRows(text, 'ID').map((r) => ({ id: r.ID ?? '', disposition: r.Disposition ?? '', reason: r.Reason ?? '', actual: r.Actual ?? '' }));
}

/** The evidence files the register says its runs were copied to, in order. */
export function evidenceFilesNamed(registerText: string): string[] {
  return [...registerText.matchAll(/the tests cited here are copied to `([^`]+\.json)`/g)].map((m) => m[1]!);
}

/** Coverage Log entries as the BRD records them: identifier and status. */
export function coverageLog(brd: string): { id: string; status: string }[] {
  return [...brd.matchAll(/^\| (CL-\d{3})<br>[^|]*\| ([^|<]+)<br>/gm)].map((m) => ({ id: m[1]!, status: m[2]!.trim() }));
}

const PASSED_ACTUAL = /^([1-9]\d*) passed, 0 failed\b/;

export function evaluateReleaseGate(input: GateInput): GateResult {
  const findings: GateFinding[] = [];
  const add = (check: GateCheck, detail: string, id?: string) => findings.push(id ? { check, id, detail } : { check, detail });
  const blockedIds = new Set(input.blocked.flatMap((b) => b.ids));
  const rowById = new Map(input.register.map((r) => [r.id, r]));

  // The evidence itself: a failed run, or a file that never reported, can hide a failure the register cannot show.
  if (!input.runs.length) add('RUNS', 'The register cites no test run');
  for (const run of input.runs) {
    if (!run.success || run.failed > 0) add('RUNS', `${run.label}: vitest reported the run as failed (${run.failed} failed tests)`);
    if (run.filesWithoutResults.length) add('RUNS', `${run.label}: files that reported no tests, so what they would show is unknown: ${run.filesWithoutResults.join(', ')}`);
  }

  // The register must be the one the current blocked list gives; otherwise it is stale and says nothing about this release.
  for (const r of input.requirements) if (!rowById.has(r.id)) add('REGISTER_CURRENT', 'The register has no row for it: regenerate the registers', r.id);
  const known = new Set(input.requirements.map((r) => r.id));
  for (const row of input.register) {
    if (!known.has(row.id)) add('REGISTER_CURRENT', 'The register has a row the BRD does not define: regenerate the registers', row.id);
    else if (row.disposition === 'Blocked' && !blockedIds.has(row.id)) add('REGISTER_CURRENT', 'Blocked in the register, but db/registers/blocked.ts no longer blocks it: regenerate the registers', row.id);
    else if (blockedIds.has(row.id) && (row.disposition === 'Pass' || row.disposition === 'Not evidenced')) add('REGISTER_CURRENT', `db/registers/blocked.ts blocks it, but the register says ${row.disposition}: regenerate the registers`, row.id);
  }

  const delivered = input.register.filter((r) => known.has(r.id) && r.disposition !== 'Blocked');
  const undelivered = input.register.filter((r) => known.has(r.id) && r.disposition === 'Blocked').map((r) => ({ id: r.id, reason: r.reason }));
  for (const row of delivered) {
    if (row.disposition === 'Fail') add('FAILED', row.reason || 'A named test failed', row.id);
    else if (row.disposition === 'Not evidenced') add('NOT_EVIDENCED', `Specified, not reported as passed (BR-028): ${row.reason}`, row.id);
    else if (row.disposition !== 'Pass') add('FAILED', `Unknown disposition "${row.disposition}"`, row.id);
  }

  // A test declared it.fails records a known wrong behaviour, wherever it is cited: by the generator's mark, or by its file today.
  const patterns = new Map<string, RegExp[]>();
  const declared = (t: CitedTest) => {
    if (t.expectedFailure) return true;
    if (!patterns.has(t.file)) patterns.set(t.file, declaredToFail(input.testSource(t.file) ?? ''));
    return patterns.get(t.file)!.some((p) => p.test(t.name));
  };
  for (const run of input.runs) {
    for (const t of run.citedTests) if (t.status === 'passed' && declared(t)) add('EXPECTED_FAILURE', `${t.file} › ${t.name} is declared it.fails: it passes only while the behaviour is wrong`);
  }

  // ZT21: an open owner question must not touch anything this release delivers.
  for (const { entry, open } of input.openQuestions) {
    if (!open) continue;
    const touched = entry.affects.filter((id) => known.has(id) && rowById.get(id)?.disposition !== 'Blocked');
    for (const id of touched) {
      add('OPEN_QUESTION', `docs/10 item ${entry.item} (${entry.kind}) is open and affects this delivered row${entry.decidedIn ? `; ${entry.decidedIn} decided it, but docs/10 does not say so yet` : ''}`, id);
    }
  }

  // ZT20: every delivered FR and BR maps to its source, decision and table (or a stated no-storage reason), and has a passing test.
  const fr = new Map(tableRows(input.traceability, 'FR').map((r) => [r.FR!, r]));
  const br = new Map(tableRows(input.traceability, 'BR').map((r) => [r.BR!, r]));
  for (const row of delivered) {
    const requirement = input.requirements.find((r) => r.id === row.id)!;
    if (requirement.family !== 'FR' && requirement.family !== 'BR') continue;
    const missing: string[] = [];
    if (requirement.family === 'FR') {
      const t = fr.get(row.id);
      if (!t) missing.push('no traceability row');
      else {
        if (!t.Source) missing.push('no source');
        if (!t.Decision) missing.push('no decision');
        const tables = t['Primary tables'] ?? '';
        if (!tables || (/^[—-]/.test(tables) && !/no-storage|no storage/i.test(tables))) missing.push('no table and no stated no-storage reason');
      }
    } else {
      const t = br.get(row.id);
      if (!t) missing.push('no traceability row');
      else if (!t['Enforced in (module)'] || !t['Mechanism (proposed)'] || !t['Related FR']) missing.push('no module, mechanism or related FR');
    }
    if (row.disposition === 'Pass' && !PASSED_ACTUAL.test(row.actual)) missing.push(`no passing named test ("${row.actual}")`);
    if (missing.length) add('COVERAGE', `Delivered, but ${missing.join(', ')} (${TRACEABILITY})`, row.id);
  }
  const log = coverageLog(input.brd);
  const ids = new Set(log.map((e) => e.id));
  if (ids.size !== CL_COUNT || log.length !== CL_COUNT) add('COVERAGE', `The Coverage Log holds ${ids.size} distinct items where ${CL_COUNT} are recorded`);
  for (const e of log) if (!(CL_ALLOWED_STATUSES as readonly string[]).includes(e.status)) add('COVERAGE', `${e.id} has status "${e.status}", which is not an allowed Coverage Log status`);
  const called = [...new Set([...input.registerText.matchAll(/\bCL-\d{3}\b/g)].map((m) => m[0]))];
  if (called.length) add('COVERAGE', `The verification register names Coverage Log items, which it must not call verified: ${called.slice(0, 5).join(', ')}`);

  // ZT21: what is shared holds no credential, technical address or personal-number shape.
  if (input.privacy.files === 0) add('PRIVACY', 'No shared file was scanned');
  for (const h of input.privacy.hits) add('PRIVACY', `${h.file}:${h.line}: ${h.code} ${h.masked}`);

  // The stored rows of the database being released: what its guards would refuse, read by the pre-go-live check (ZT06, ZT19).
  if (!input.goLive) add('GO_LIVE', 'No pre-go-live check report was given (npm run --silent db:check-go-live on a copy of the live database, saved to a file, then --go-live <file>)');
  else {
    if (input.goLive.latestMigration !== input.latestMigration) add('GO_LIVE', `The pre-go-live check read a database at ${input.goLive.latestMigration || 'no migration'}, not at this release's ${input.latestMigration}`);
    for (const f of input.goLive.findings) add('GO_LIVE', `${f.code} ${f.table}.${f.rule}: ${f.count} rows`);
  }

  return { releasable: findings.length === 0, findings, delivered: delivered.map((r) => r.id), undelivered };
}

const CHECK_TITLES: Record<GateCheck, string> = {
  RUNS: 'Test runs',
  REGISTER_CURRENT: 'Register matches the blocked list',
  FAILED: 'Failed rows (BR-028)',
  NOT_EVIDENCED: 'Rows specified but not reported as passed (BR-028)',
  EXPECTED_FAILURE: 'Tests declared it.fails',
  OPEN_QUESTION: 'Open owner questions on delivered rows (ZT21)',
  COVERAGE: 'Requirements and coverage completeness (ZT20)',
  PRIVACY: 'Shared files (ZT21)',
  GO_LIVE: 'Pre-go-live check',
};

const escapeCell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ');

export function renderGate(result: GateResult, sources: { registers: string; goLive: string | null }): string {
  const lines = [
    '# Release gate',
    '',
    `Read ${sources.registers} and ${sources.goLive ?? 'no pre-go-live check report'}. Decided under owner delegation, 6 Nov 2026 (I-84). Synthetic data only.`,
    '',
    `**${result.releasable ? 'The release may go out' : 'The release is blocked'}**: ${result.findings.length} findings; ${result.delivered.length} rows delivered, ${result.undelivered.length} undelivered.`,
    '',
    '| Check | Findings |',
    '|---|---|',
    ...(Object.keys(CHECK_TITLES) as GateCheck[]).map((c) => `| ${CHECK_TITLES[c]} | ${result.findings.filter((f) => f.check === c).length} |`),
  ];
  if (result.findings.length) {
    lines.push('', '## Findings', '', '| Check | Row | Detail |', '|---|---|---|');
    for (const f of result.findings) lines.push(`| ${f.check} | ${f.id ?? ''} | ${escapeCell(f.detail)} |`);
  }
  lines.push('', '## Undelivered scope (Blocked: not in this release)', '', '| Row | Reason |', '|---|---|');
  for (const u of result.undelivered) lines.push(`| ${u.id} | ${escapeCell(u.reason)} |`);
  return `${lines.join('\n')}\n`;
}

/** The newest migration file that is not a draft. */
export function latestMigrationIn(dir: string): string {
  return readdirSync(dir).filter((f) => f.endsWith('.sql') && !f.endsWith('.draft.sql')).sort().at(-1) ?? '';
}

/** Reads every input from the repository at `root` and the registers at `registers`. Throws when one cannot be read. */
export function loadGateInput(root: string, registers: string, goLivePath: string | null): GateInput {
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  checkBlockedSources(read);
  const registerText = readFileSync(join(registers, VERIFICATION), 'utf8');
  const register = parseRegister(registerText);
  if (!register.length) throw new Error(`${join(registers, VERIFICATION)} holds no register table`);
  const runs = evidenceFilesNamed(registerText).map((evidence): RunRecord => {
    const json = JSON.parse(readFileSync(join(registers, evidence), 'utf8')) as Omit<RunRecord, 'evidence'>;
    return { label: json.label, evidence, success: json.success, failed: json.failed, filesWithoutResults: json.filesWithoutResults ?? [], citedTests: json.citedTests ?? [] };
  });
  const goLive = goLivePath ? (JSON.parse(readFileSync(goLivePath, 'utf8')) as GoLiveReport) : null;
  if (goLive && (!Array.isArray(goLive.findings) || typeof goLive.latestMigration !== 'string')) throw new Error(`${goLivePath} is not a pre-go-live check report`);
  return {
    requirements: parseRequirements(read(BRD)),
    register,
    registerText,
    runs,
    blocked: BLOCKED,
    testSource: (file) => (existsSync(join(root, file)) ? read(file) : null),
    traceability: read(TRACEABILITY),
    brd: read(BRD),
    openQuestions: openQuestionStates(parseOwnerList(read(OWNER_LIST))),
    privacy: scanSharedFiles(root),
    goLive,
    latestMigration: latestMigrationIn(join(root, 'db', 'migrations')),
  };
}

/** The command. Writes the report to `out` (never into the generated registers) or through `write`. */
export function runReleaseGate(args: string[], write: (text: string) => void, root: string = ROOT): 0 | 1 | 2 {
  try {
    const { values } = parseArgs({ args, options: { registers: { type: 'string' }, 'go-live': { type: 'string' }, out: { type: 'string' } } });
    const registers = resolve(root, values.registers ?? REGISTERS);
    const goLive = values['go-live'] ? resolve(values['go-live']) : null;
    const input = loadGateInput(root, registers, goLive);
    const result = evaluateReleaseGate(input);
    const report = renderGate(result, { registers: relative(root, registers).replace(/\\/g, '/') || '.', goLive: goLive ? 'the given pre-go-live check report' : null });
    if (values.out) {
      const out = resolve(values.out);
      const inside = (dir: string) => {
        const rel = relative(dir, out);
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
      };
      if (inside(resolve(root, REGISTERS)) || inside(registers)) throw new Error('The gate never writes into the generated registers; choose another --out');
      writeFileSync(out, report);
      write(`${result.releasable ? 'Releasable' : 'Blocked'}: ${result.findings.length} findings; report written to ${out}`);
    } else {
      write(report);
    }
    return result.releasable ? 0 : 1;
  } catch (err) {
    write(`The release gate could not run: ${(err as Error).message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runReleaseGate(process.argv.slice(2), console.log);
}
