// Writes docs/registers from a finished test run and a migrated database: the schema constraint register, the access matrix and the
// verification register (gates-15; BRD lines 124-126, 4807, 4812, 4813). Nothing in those files is typed by hand, so re-run this after
// a full run rather than editing them. It starts a private throwaway PostgreSQL and never reads a development database.
//
//   npx tsx db/registers/generate.ts --results <vitest.json> --label "Run 32" [--results <web.json> --label "Run 32 web"] [--access-trace <dir>] [--out <dir>]
//
// Exit code 0 whatever the registers show: a gap is a result. 2 when a register could not be produced.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { BASELINE_ROLES } from '../../apps/api/src/modules/access/baseline.js';
import { migrate } from '../migrate.js';
import { type AccessMatrix, buildAccessMatrix, readTrace, type TestRef } from './access.js';
import { BLOCKED, checkBlockedSources } from './blocked.js';
import { parseRequirements } from './requirements.js';
import { loadRun, type RunEvidence } from './runs.js';
import { buildSchemaRegister, parseEnforcementRecord, type SchemaRegister } from './schema.js';
import { buildVerification, type Disposition, type VerificationRow } from './verification.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRD = 'docs/source/HRMS_AI_Developer_Master_Prompt_v8.2.md';
const FIRST_CITED = 3;

const cell = (text: string | number) => String(text).replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ');
const table = (headers: readonly string[], rows: readonly (readonly (string | number)[])[]) =>
  [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const evidenceFile = (run: RunEvidence) => `evidence/${slug(run.label)}.json`;
const testRef = (t: TestRef) => `${t.file} › ${t.name}`;

/** Rows of a markdown table from docs/06, by header name, for the rows of one identifier family. */
function registerRows(text: string, firstHeader: string): Map<string, Record<string, string>> {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`| ${firstHeader} |`));
  const rows = new Map<string, Record<string, string>>();
  if (start < 0) return rows;
  const headers = lines[start]!.split('|').slice(1, -1).map((h) => h.trim());
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    rows.set(cells[0]!, Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])));
  }
  return rows;
}

const runsLine = (runs: readonly RunEvidence[]) =>
  runs
    .map((r) => `**${r.label}**, started ${r.startedAt}: ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped${r.success ? '' : ', and vitest reported the run as failed'}. Source hash \`${r.sha256}\`; the tests cited here are copied to \`${evidenceFile(r)}\`.${r.filesWithoutResults.length ? ` Files that reported no tests, so whatever they would show is unknown: ${r.filesWithoutResults.join(', ')}.` : ''}`)
    .join('\n\n');

function renderVerification(rows: readonly VerificationRow[], runs: readonly RunEvidence[], docs06: string, docs07: string): string {
  const fr = registerRows(docs06, 'FR');
  const br = registerRows(docs06, 'BR');
  const ci = registerRows(docs07, 'CI');
  const dispositions: Disposition[] = ['Pass', 'Fail', 'Blocked', 'Not evidenced'];
  const families = ['FR', 'BR', 'DQ', 'CI', 'ZT'] as const;
  const summary = table(['', ...dispositions, 'Total'], [
    ...families.map((f) => [f, ...dispositions.map((d) => rows.filter((r) => r.family === f && r.disposition === d).length), rows.filter((r) => r.family === f).length]),
    ['All', ...dispositions.map((d) => rows.filter((r) => r.disposition === d).length), rows.length],
  ]);

  const decisionOf = (r: VerificationRow) => (r.family === 'FR' ? fr.get(r.id)?.Decision : undefined) ?? '';
  const referenceOf = (r: VerificationRow) => (r.family === 'FR' ? fr.get(r.id)?.['Primary tables'] : r.family === 'BR' ? br.get(r.id)?.['Mechanism (proposed)'] : r.family === 'CI' ? ci.get(r.id)?.Where : undefined) ?? '';
  const fixture = (r: VerificationRow) => {
    const files = [...new Set(r.named.map((t) => t.file))].sort();
    if (!files.length) return '';
    return `Synthetic: ${files.slice(0, 2).join(', ')}${files.length > 2 ? ` and ${files.length - 2} more` : ''}`;
  };
  const actual = (r: VerificationRow) => {
    if (!r.named.length) return 'No named test';
    const count = (s: string) => r.named.filter((t) => t.status === s).length;
    return `${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped`;
  };
  const evidence = (r: VerificationRow) => {
    const passedFirst = [...r.named].sort((a, b) => Number(b.status === 'passed') - Number(a.status === 'passed'));
    return passedFirst.slice(0, FIRST_CITED).map((t) => shorten(testRef(t), 160)).join('; ');
  };

  const gaps = rows.filter((r) => r.disposition !== 'Pass');
  return `# Verification register

Generated by \`db/registers/generate.ts\`; do not edit by hand. One row per FR, BR, DQ, CI and ZT in the BRD (D2, line 4807; ZT20). Coverage Log items are not here: their only statuses are Documented, Restricted and Not reachable, which are not test results.

${runsLine(runs)}

## What each disposition means

- **Pass**: at least one test whose own name states the identifier ran and passed in the run above, none failed, and no open block applies. It does not mean the whole of the requirement's acceptance clause is covered, and it does not clear an open audit finding (\`docs/audit\`, \`docs/06_traceability_register.md\`): read the count and the test names. A name is the only link used, so a test that proves a rule without naming it earns nothing here.
- **Fail**: a test naming the identifier failed in that run.
- **Blocked**: the project's own registers say it waits on an owner input or an environment that does not exist (\`db/registers/blocked.ts\`, each entry citing its source). Passing tests do not clear this (BRD line 126).
- **Not evidenced**: nothing above applies. This is a gap in the evidence, not a statement that the behaviour is missing. A test file that mentions the identifier without any test naming it is noted as a place to look.

Nobody has reviewed these rows: the tester is the automated run, and no person has signed them. Whether a rule was approved by the owner is recorded separately from whether its behaviour was observed (D2).

## Summary

${summary}

## Register

${table(
  ['ID', 'Title', 'Classification', 'Owner decision', 'Table/column/FK', 'Test fixture', 'Expected (BRD line)', 'Actual', 'Evidence', 'Tester', 'Review date', 'Disposition', 'Reason'],
  rows.map((r) => [r.id, shorten(r.title, 90), shorten(r.classification, 70), decisionOf(r), shorten(referenceOf(r), 120), fixture(r), `Line ${r.line}: ${shorten(r.expected, 220)}`, actual(r), evidence(r), r.named.length ? 'vitest (automated)' : '', 'Not reviewed', r.disposition, r.reason]),
)}

## Gaps: every row that is not Pass

${gaps.length} of ${rows.length}.

${table(['ID', 'Disposition', 'Reason', 'Where to look'], gaps.map((r) => [r.id, r.disposition, r.reason, r.mentionedIn.slice(0, 3).join(', ')]))}
`;
}

function renderAccess(matrix: AccessMatrix, runs: readonly RunEvidence[]): string {
  const complete = matrix.rows.filter((r) => !r.gap).length;
  const shown = (refs: readonly TestRef[]) => (refs.length ? `${refs.length}: ${shorten(testRef(refs[0]!), 150)}` : '');
  const gapCounts = new Map<string, number>();
  for (const r of matrix.rows) if (r.gap) gapCounts.set(r.gap, (gapCounts.get(r.gap) ?? 0) + 1);
  const noRole = matrix.rows.filter((r) => !r.ceilingRoles.length).map((r) => r.key);
  const howMatched = matrix.traced
    ? `**Matched from what the tests exercised**: the run recorded each permission a test put to \`resolveAccess\` and the answer (\`apps/api/src/test/access-trace.setup.ts\`). Positive means the permission was allowed for that field group in a test that passed; negative means it was refused for that permission (NO_PERMISSION, CONFIDENTIAL_NOT_ELIGIBLE or SCOPED_DENY) in a test that passed. A refusal for an ended assignment or a disabled user is not a test of the permission and is not counted, and neither is anything asked in a \`beforeAll\`. Being asked does not prove the test asserted the answer: read the test.`
    : '**Matched by name only**: this run recorded no trace, so all that is known is which test files spell the permission (`resource.action`). A name cannot tell a positive test from a negative one, so both columns stay empty and every row counts as a gap. Run the suite with `HRMS_ACCESS_TRACE_DIR` set and pass that folder as `--access-trace` to get the real matrix.';
  return `# Access matrix

Generated by \`db/registers/generate.ts\`; do not edit by hand. One row per permission in the catalogue, with the baseline roles from \`apps/api/src/modules/access/baseline.ts\` (BRD line 4813).

${runsLine(runs)}

${howMatched}

## Summary

${table(['', 'Permissions'], [['With a positive and a negative test', complete], ...[...gapCounts.entries()].sort(), ['Total', matrix.rows.length]])}

${noRole.length} permissions are in no baseline role's ceiling, so no baseline role can be granted them: ${noRole.join(', ') || 'none'}.

Asked for by a test but not in the migrated catalogue: either a test's own synthetic permission or a name the code asks for that no migration creates, so read each one: ${matrix.askedButNotCatalogued.join(', ') || 'none'}.

In a role's ceiling or duties but not in the catalogue: ${matrix.grantedButNotCatalogued.join(', ') || 'none'}.

## Matrix

${table(
  ['Permission', 'Ceiling of', 'Default duty of', 'Positive tests', 'Negative tests', 'Basis', 'Named in test files', 'Gap'],
  matrix.rows.map((r) => [r.key, r.ceilingRoles.join(', '), r.dutyRoles.join(', '), shown(r.positive), shown(r.negative), r.basis, r.namedInFiles.length, r.gap]),
)}
`;
}

function renderSchema(schema: SchemaRegister, latestMigration: string): string {
  return `# Schema constraint register

Generated by \`db/registers/generate.ts\` from the catalogue of a database migrated through \`${latestMigration}\`; do not edit by hand. ${schema.tableCount} tables, ${schema.columns.length} columns, ${schema.triggers.length} triggers. Columns are those of the docs/07 template.

- **CI/ZT**: ZT06 to ZT12 are given by the kind of rule on the column, following the wording of those gates (BRD lines 4773-4779): ZT06 a foreign key; ZT07 a primary or unique key; ZT08 a required field, a check or a reference category; ZT09 an interval rule; ZT10 a state column; ZT11 a version column; ZT12 a column fixed once written. This says which gate the rule belongs to, not that the gate passed: that is the verification register. A CI appears only where the docs/07 enforcement record names this mechanism, so an empty CI does not mean no invariant applies.
- **Company boundary**: "NOT held to the row's company" names a foreign key that reaches a company-owned table without carrying company_id. \`db/tests/fk-catalogue.test.ts\` is the gate for those.
- **Enforcement mechanism**: PK, FK, UQ, CK, EX (exclusion), TR (trigger). "(NOT VALID)" still applies to new and changed rows but was never proved on stored ones; \`npm run db:check-go-live\` reports any stored row that breaks one. Rules a trigger holds over the whole row are listed under Table triggers, not against each column.

Constraints not validated on this database: ${schema.unvalidated.map((u) => `${u.table}.${u.constraint}`).join(', ') || 'none'}.

## Columns

${table(
  ['Table', 'Column', 'PK', 'FK', 'Unique', 'Nullability', 'Ref category', 'Interval rule', 'Company boundary', 'CI/ZT', 'Enforcement mechanism'],
  schema.columns.map((c) => [c.table, c.column, c.pk, c.fk, c.unique, c.nullability, c.refCategory, c.intervalRule, c.companyBoundary, c.ciZt, c.mechanism]),
)}

## Table triggers

${table(['Table', 'Trigger', 'When', 'Function'], schema.triggers.map((t) => [t.table, t.trigger, t.when, t.fn]))}
`;
}

function renderReadme(runs: readonly RunEvidence[], counts: { pass: number; requirements: number; accessComplete: number; permissions: number; traced: boolean; columns: number }): string {
  const labels = runs.map((r) => r.label).join(', ');
  return `# Registers

Acceptance-gate records generated from the code, the catalogue and a cited test run (BRD lines 124-126, 4807, 4812, 4813). Generated by \`db/registers/generate.ts\`; do not edit these files by hand. They describe the cited run, **${labels}**, not the code as it stands today.

| File | What it is | Now |
|---|---|---|
| [verification-register.md](verification-register.md) | One row per FR, BR, DQ, CI and ZT with its disposition | ${counts.pass} of ${counts.requirements} Pass; the rest say why not |
| [access-matrix.md](access-matrix.md) | Each permission's positive and negative test | ${counts.traced ? `${counts.accessComplete} of ${counts.permissions} have both` : `Not traced: ${counts.permissions} permissions matched by name only`} |
| [schema-constraint-register.md](schema-constraint-register.md) | Every column's constraints and the mechanism behind them | ${counts.columns} columns |
| \`evidence/\` | The tests these files cite, with the hash of the run they came from | |

To regenerate after a full run:

\`\`\`powershell
$env:HRMS_ACCESS_TRACE_DIR = 'C:\\somewhere\\trace'   # optional, and the only way to fill the access matrix
npx vitest run --reporter=json --outputFile=C:\\somewhere\\run.json
npx tsx db/registers/generate.ts --results C:\\somewhere\\run.json --label "Run NN" --access-trace C:\\somewhere\\trace
\`\`\`

The Coverage Log is a separate record with its own statuses (Documented, Restricted, Not reachable), and is not here.
`;
}

async function withMigratedCatalogue<T>(read: (db: pg.Client) => Promise<T>): Promise<T> {
  const port: number = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
  const dir = await mkdtemp(join(tmpdir(), 'hrms-registers-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'registers', password: 'registers_only', port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale-provider=icu', '--icu-locale=und', '--locale=C'], onLog: () => undefined });
  await server.initialise();
  await server.start();
  try {
    await server.createDatabase('registers');
    const db = new pg.Client({ host: '127.0.0.1', port, user: 'registers', password: 'registers_only', database: 'registers' });
    await db.connect();
    try {
      await migrate(db);
      return await read(db);
    } finally {
      await db.end();
    }
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function generateRegisters(options: { results: { path: string; label: string }[]; accessTrace: string | null; out: string }): Promise<{ verification: VerificationRow[]; matrix: AccessMatrix }> {
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
  checkBlockedSources(read);
  const requirements = parseRequirements(read(BRD));
  const runs = options.results.map((r) => loadRun(r.label, r.path, ROOT));
  const docs06 = read('docs/06_traceability_register.md');
  const docs07 = read('docs/07_register_templates.md');

  const testSources = new Map<string, string>();
  for (const file of new Set(runs.flatMap((r) => r.tests.map((t) => t.file)))) {
    if (existsSync(join(ROOT, file))) testSources.set(file, read(file));
  }

  const verification = buildVerification(requirements, runs, BLOCKED, testSources);
  const trace = options.accessTrace ? readTrace(options.accessTrace) : null;

  const { schema, permissions, latestMigration } = await withMigratedCatalogue(async (db) => ({
    schema: await buildSchemaRegister(db, parseEnforcementRecord(docs07)),
    permissions: (await db.query<{ resource: string; action: string; fieldGroup: string }>(`select resource, action, field_group as "fieldGroup" from permission`)).rows,
    latestMigration: (await db.query<{ latest: string }>(`select max(filename) as latest from schema_migration`)).rows[0]!.latest,
  }));
  const matrix = buildAccessMatrix(permissions, BASELINE_ROLES, runs, trace, testSources);

  mkdirSync(join(options.out, 'evidence'), { recursive: true });
  writeFileSync(join(options.out, 'verification-register.md'), renderVerification(verification, runs, docs06, docs07));
  writeFileSync(join(options.out, 'access-matrix.md'), renderAccess(matrix, runs));
  writeFileSync(join(options.out, 'schema-constraint-register.md'), renderSchema(schema, latestMigration));
  writeFileSync(join(options.out, 'README.md'), renderReadme(runs, {
    pass: verification.filter((r) => r.disposition === 'Pass').length,
    requirements: verification.length,
    accessComplete: matrix.rows.filter((r) => !r.gap).length,
    permissions: matrix.rows.length,
    traced: matrix.traced,
    columns: schema.columns.length,
  }));

  // The audit's complaint was evidence kept only in a session's scratch folder: the cited tests live here, under the run's own hash.
  const cited = new Set([
    ...verification.flatMap((r) => r.named.map((t) => `${t.file}\n${t.name}`)),
    ...matrix.rows.flatMap((r) => [...r.positive, ...r.negative].map((t) => `${t.file}\n${t.name}`)),
  ]);
  for (const run of runs) {
    const { tests, ...summary } = run;
    const kept = tests.filter((t) => cited.has(`${t.file}\n${t.name}`)).sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
    writeFileSync(join(options.out, evidenceFile(run)), `${JSON.stringify({ ...summary, citedTests: kept }, null, 1)}\n`);
  }
  return { verification, matrix };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { results: { type: 'string', multiple: true }, label: { type: 'string', multiple: true }, 'access-trace': { type: 'string' }, out: { type: 'string' } } });
    const paths = values.results ?? [];
    if (!paths.length) throw new Error('Pass --results with the JSON output of a full test run');
    if ((values.label ?? []).length !== paths.length) throw new Error('Pass one --label for each --results, naming the run');
    const { verification, matrix } = await generateRegisters({
      results: paths.map((path, i) => ({ path, label: values.label![i]! })),
      accessTrace: values['access-trace'] ?? null,
      out: values.out ?? join(ROOT, 'docs', 'registers'),
    });
    const tally = (d: Disposition) => verification.filter((r) => r.disposition === d).length;
    console.log(`Verification: ${tally('Pass')} Pass, ${tally('Fail')} Fail, ${tally('Blocked')} Blocked, ${tally('Not evidenced')} Not evidenced, of ${verification.length}`);
    console.log(`Access: ${matrix.rows.filter((r) => !r.gap).length} of ${matrix.rows.length} permissions with a positive and a negative test${matrix.traced ? '' : ' (not traced: name match only)'}`);
  } catch (err) {
    console.error(`The registers could not be produced: ${(err as Error).message}`);
    process.exitCode = 2;
  }
}
