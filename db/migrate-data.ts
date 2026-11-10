// Data migration toolkit (BRD §9.4 DQ-01 to DQ-15, ZT19, OQ-19; db/data-migration/README.md). Three steps over an extract
// folder (the old HR system's Excel exports saved as CSV UTF-8, plus manifest.json):
//   validate   the DQ checks; writes validation.json/.md and nothing else. With --company (and DATABASE_URL) it also checks the
//              extract against the company, in a read-only transaction.
//   load       validate against the company, then load through the existing import pipelines as --operator. Without --commit
//              it is a dry run that writes nothing; with --commit it also needs --confirm <company code> (records are permanent).
//   reconcile  compares the extract with the company after the load and writes the ZT19 report (reconcile.json/.md).
// Usage (on the server, with the production environment loaded for load and reconcile):
//   npx tsx db/migrate-data.ts validate  --extract <folder> [--company ACME] [--out <folder>] [--manifest <file>]
//   npx tsx db/migrate-data.ts load      --extract <folder> --company ACME --operator hr.admin@acme.example [--commit --confirm ACME]
//   npx tsx db/migrate-data.ts reconcile --extract <folder> --company ACME [--operator hr.admin@acme.example]
// Environment: DATABASE_URL; FILE_STORE_DIR for load (the API's upload directory, where import files are kept); with
// NODE_ENV=production the malware scanner is ClamAV (CLAMD_SOCKET or CLAMD_HOST/CLAMD_PORT), as for the API.
// Exit code: 0 success; 1 validation failure, a rejected stage or a ZT19 failure; 2 a refused or malformed command.
import { join } from 'node:path';
import type pg from 'pg';
import { createPool } from '../apps/api/src/db/pool.js';
import { clamavScannerFromEnv } from '../apps/api/src/storage/clamav.js';
import { localFileStore } from '../apps/api/src/storage/files.js';
import { developmentScanner } from '../apps/api/src/storage/scan.js';
import { analyse } from './data-migration/analyse.js';
import { buildStages, LoadRefused, loadExtract } from './data-migration/load.js';
import { ManifestError } from './data-migration/model.js';
import { reconcile } from './data-migration/reconcile.js';
import { loadJson, loadMarkdown, planMarkdown, readExtract, reconcileMarkdown, validationJson, validationMarkdown, writeReport } from './data-migration/report.js';
import { readOnly, readTargetFacts } from './data-migration/target.js';

const [command, ...rest] = process.argv.slice(2);
const args = new Map<string, string | true>();
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!;
  if (!a.startsWith('--')) usage(`unexpected argument ${a}`);
  const next = rest[i + 1];
  if (next !== undefined && !next.startsWith('--')) {
    args.set(a.slice(2), next);
    i++;
  } else args.set(a.slice(2), true);
}

function usage(problem: string): never {
  console.error(`${problem}\nUsage: npx tsx db/migrate-data.ts validate|load|reconcile --extract <folder> [--company <code>] [--operator <account>] [--commit --confirm <code>] [--out <folder>] [--manifest <file>]`);
  process.exit(2);
}
const text = (name: string) => {
  const v = args.get(name);
  return typeof v === 'string' ? v : undefined;
};
const need = (name: string) => text(name) ?? usage(`--${name} is required`);
const known = new Set(['extract', 'manifest', 'out', 'company', 'operator', 'commit', 'confirm']);
for (const k of args.keys()) if (!known.has(k)) usage(`unknown option --${k}`);
if (!command || !['validate', 'load', 'reconcile'].includes(command)) usage('the first argument is validate, load or reconcile');

const extractDir = need('extract');
const outDir = text('out') ?? join(extractDir, 'reports');
const extract = await readExtract(extractDir, text('manifest')).catch((err: unknown) => {
  if (err instanceof ManifestError) usage(err.message);
  throw err;
});
const company = text('company') ?? (command === 'validate' ? undefined : extract.manifest.company);
const now = new Date();

const database = () => {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) usage('DATABASE_URL must be set to check against or load into a company');
  return createPool(url, 2);
};

let exitCode = 0;
if (command === 'validate') {
  let pool: pg.Pool | null = null;
  try {
    let facts = null;
    if (company) {
      pool = database();
      facts = await readOnly(pool, (tx) => readTargetFacts(tx, company, extract.manifest.migrationId));
    }
    const a = analyse(extract, facts);
    const paths = await writeReport(outDir, 'validation', validationJson(a), validationMarkdown(a, now));
    for (const c of a.checks) console.log(`${c.id} ${c.title}: ${c.status}${c.findings.length ? ` (${c.findings.length})` : ''}`);
    console.log(`Report: ${paths.markdown}`);
    exitCode = a.failed ? 1 : 0;
  } finally {
    await pool?.end();
  }
} else if (command === 'load') {
  if (!company) usage('--company is required');
  const operator = need('operator');
  const pool = database();
  try {
    if (args.get('commit') !== true) {
      // Dry run: validation against the company and the stages the load would run; nothing is written.
      const a = analyse(extract, await readOnly(pool, (tx) => readTargetFacts(tx, company, extract.manifest.migrationId)));
      const paths = await writeReport(outDir, 'validation', validationJson(a), validationMarkdown(a, now));
      console.log(planMarkdown(buildStages(a, extract.manifest)));
      console.log(a.failed ? `Validation failed; the load would refuse. Report: ${paths.markdown}` : `Dry run: nothing was written. To load as ${operator}, add --commit --confirm ${company.toUpperCase()}.`);
      exitCode = a.failed ? 1 : 0;
    } else {
      const fileDir = process.env.FILE_STORE_DIR?.trim();
      if (!fileDir) usage('FILE_STORE_DIR must be set to the API\'s upload directory (import files are kept with their batches)');
      const scanner = process.env.NODE_ENV === 'production' ? clamavScannerFromEnv() : developmentScanner();
      const result = await loadExtract({ db: pool, files: localFileStore(fileDir), scanner, extract, companyCode: company, operator, commit: true, confirm: text('confirm'), log: (l) => console.log(l) });
      const paths = await writeReport(outDir, 'load', loadJson(result), loadMarkdown(result, now));
      console.log(`${result.ok ? 'Loaded' : 'Stopped'}. Report: ${paths.markdown}`);
      exitCode = result.ok ? 0 : 1;
    }
  } catch (err) {
    if (!(err instanceof LoadRefused)) throw err;
    if (err.analysis) await writeReport(outDir, 'validation', validationJson(err.analysis), validationMarkdown(err.analysis, now));
    console.error(err.message);
    exitCode = err.code === 'VALIDATION_FAILED' ? 1 : 2;
  } finally {
    await pool.end();
  }
} else {
  if (!company) usage('--company is required');
  const pool = database();
  try {
    const r = await reconcile({ db: pool, extract, companyCode: company, operator: text('operator'), now });
    const paths = await writeReport(outDir, 'reconcile', r, reconcileMarkdown(r));
    console.log(`ZT19: ${r.zt19} (${r.unexplained} unexplained). Report: ${paths.markdown}`);
    exitCode = r.zt19 === 'PASS' ? 0 : 1;
  } finally {
    await pool.end();
  }
}
process.exit(exitCode);
