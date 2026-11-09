// What the registers and the repository show of three whole-system rules: BR-028 zero tolerance business gates (BRD line 1803), ZT20
// requirements and coverage completeness (line 4787) and ZT21 open questions and privacy (line 4788). The release gate that decides on
// them (db/registers/release-gate.ts, I-84) is tested in db/tests/release-gate.test.ts; here are the register's side and the scans of
// what is shared. Each test's name says what it does not cover. Reads the repository's own text and the generator's own rules.
// Synthetic data only.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { PRIVACY_RULES, privacyHitsIn, sharedFiles } from '../../../../db/registers/privacy.js';
import { parseRequirements } from '../../../../db/registers/requirements.js';
import type { RunEvidence } from '../../../../db/registers/runs.js';
import { buildVerification } from '../../../../db/registers/verification.js';
import { loggerOptions } from '../http/logging.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const BRD = read('docs/source/HRMS_AI_Developer_Master_Prompt_v8.2.md');
const requirements = parseRequirements(BRD);

/** The rows of a markdown table by its first header, as { header: cell }. */
function tableRows(text: string, firstHeader: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`| ${firstHeader} |`));
  expect(start, `a table starting with "${firstHeader}"`).toBeGreaterThanOrEqual(0);
  const headers = lines[start]!.split('|').slice(1, -1).map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    rows.push(Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])));
  }
  return rows;
}

describe('zero tolerance business gates', () => {
  // The gates BR-028 names, by the BRD's own titles.
  const GATES: [string, string][] = [
    ['cross-organisation isolation', 'Cross-company access'],
    ['self-approval restriction', 'Self decision and duties'],
    ['duplicate entitlement', 'No duplicate or excess payment'],
    ['financial reconciliation', 'Report reconciliation'],
  ];
  const gateId = (title: string) => {
    const row = requirements.find((r) => r.family === 'ZT' && r.title === title);
    expect(row, title).toBeDefined();
    return row!.id;
  };
  const verdicts = (tests: { name: string; status: 'passed' | 'failed' | 'skipped' }[]) => {
    const run: RunEvidence = { label: 'Synthetic', sha256: 'x', startedAt: '2026-01-01T00:00:00.000Z', passed: 0, failed: 0, skipped: 0, success: false, filesWithoutResults: [], tests: tests.map((t) => ({ file: 'synthetic.test.ts', ...t })) };
    return new Map(buildVerification(requirements, [run], [], new Map()).map((r) => [r.id, r.disposition]));
  };

  it.each(GATES)('BR-028 (the register the release gate reads): a failed %s gate shows Fail in the register, even beside passing tests', (_kind, title) => {
    const id = gateId(title);
    expect(verdicts([{ name: `${id} one`, status: 'passed' }, { name: `${id} two`, status: 'failed' }]).get(id)).toBe('Fail');
    expect(verdicts([{ name: `${id} one`, status: 'passed' }]).get(id)).toBe('Pass');
  });

  it.each(GATES)('BR-028 (the register the release gate reads): a required %s gate with no run behind it is specified, not reported as passed', (_kind, title) => {
    const id = gateId(title);
    expect(requirements.find((r) => r.id === id)!.expected.length).toBeGreaterThan(20);
    expect(verdicts([]).get(id)).toBe('Not evidenced');
    expect(verdicts([{ name: `${id} one`, status: 'skipped' }]).get(id)).toBe('Not evidenced');
  });
});

describe('requirements and coverage completeness', () => {
  const trace = read('docs/06_traceability_register.md');

  it('ZT20 (mapping of every FR, delivered or not; the passing-test clause is the release gate’s): every FR has a row with its source, decision and table or stated no-storage reason', () => {
    const rows = new Map(tableRows(trace, 'FR').map((r) => [r.FR!, r]));
    const frs = requirements.filter((r) => r.family === 'FR');
    expect(frs).toHaveLength(110);
    const unmapped: string[] = [];
    for (const fr of frs) {
      const row = rows.get(fr.id);
      if (!row) {
        unmapped.push(`${fr.id}: no row`);
        continue;
      }
      if (!row.Source) unmapped.push(`${fr.id}: no source`);
      if (!row.Decision) unmapped.push(`${fr.id}: no decision`);
      const tables = row['Primary tables'] ?? '';
      // A dash alone is no reason: "no storage" has to say so.
      if (!tables || (/^[—-]/.test(tables) && !/no-storage|no storage/i.test(tables))) unmapped.push(`${fr.id}: no table and no stated no-storage reason ("${tables}")`);
    }
    expect(unmapped).toEqual([]);
  });

  it('ZT20 (mapping of every BR, as above): every BR has a row with its module, mechanism and the requirement it serves', () => {
    const rows = new Map(tableRows(trace, 'BR').map((r) => [r.BR!, r]));
    const brs = requirements.filter((r) => r.family === 'BR');
    expect(brs).toHaveLength(55);
    const unmapped = brs.filter((br) => {
      const row = rows.get(br.id);
      return !row || !row['Enforced in (module)'] || !row['Mechanism (proposed)'] || !row['Related FR'];
    });
    expect(unmapped.map((b) => b.id)).toEqual([]);
  });

  it('ZT20 (coverage log only): all 259 CL entries keep an allowed status, 258 Documented and 1 Not reachable, and none is called verified', () => {
    const entries = [...BRD.matchAll(/^\| (CL-\d{3})<br>[^|]*\| ([^|<]+)<br>/gm)].map((m) => [m[1]!, m[2]!.trim()] as const);
    expect(new Set(entries.map(([id]) => id)).size).toBe(259);
    expect(entries.map(([id]) => id).sort()).toEqual(Array.from({ length: 259 }, (_, i) => `CL-${String(i + 1).padStart(3, '0')}`));
    const count = (status: string) => entries.filter(([, s]) => s === status).length;
    expect([count('Documented'), count('Restricted'), count('Not reachable')]).toEqual([258, 0, 1]);
    expect(entries.filter(([, s]) => s === 'Not reachable').map(([id]) => id)).toEqual(['CL-219']);
    // The acceptance record keeps these out: nothing here claims a live item was verified.
    expect(read('docs/registers/verification-register.md')).not.toMatch(/\bCL-\d{3}\b/);
  });

  it('ZT20 (register only, not the rows’ content): every FR, BR, DQ, CI and ZT has a row in the verification register, and a Pass always shows a passed named test', () => {
    const rows = tableRows(read('docs/registers/verification-register.md'), 'ID');
    expect(rows.map((r) => r.ID).sort()).toEqual(requirements.map((r) => r.id).sort());
    for (const row of rows) {
      expect(['Pass', 'Fail', 'Blocked', 'Not evidenced'], row.ID).toContain(row.Disposition);
      if (row.Disposition === 'Pass') expect(row.Actual, row.ID).toMatch(/^[1-9]\d* passed, 0 failed/);
    }
  });
});

describe('privacy of what is shared', () => {
  // The release gate's own scan (db/registers/privacy.ts), over the same files.
  const files = sharedFiles(ROOT);
  const texts = () => files.map((f) => [f, read(f)] as [string, string]);
  const hits = (...codes: string[]) =>
    privacyHitsIn(
      texts(),
      PRIVACY_RULES.filter((r) => codes.includes(r.code)),
    ).map((h) => `${h.file}:${h.line} ${h.code} ${h.masked}`);

  it('ZT21 (a pattern scan of shared files only: it cannot prove data is synthetic; the open-questions clause is the release gate’s): no private key, cloud access key, or identity, tax or mobile number', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(hits('PRIVATE_KEY', 'CLOUD_ACCESS_KEY')).toEqual([]);
    // India's tax (PAN) and identity (Aadhaar) number shapes, and a mobile number.
    expect(hits('PAN', 'AADHAAR', 'MOBILE')).toEqual([]);
  });

  it('ZT21 (pattern scan only, as above): every email address is on a domain reserved for examples, every address is loopback, and any connection string with a credential points at this machine', () => {
    expect(hits('EMAIL', 'ADDRESS', 'CONNECTION_CREDENTIAL')).toEqual([]);
  });

  it('ZT21 (logs only, not the open-questions clause): a request log holds no token, cookie, search term, raw identifier or client address', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const app = Fastify({ logger: loggerOptions(stream) });
    app.get('/v1/people/:id', async () => ({ ok: true }));
    await app.inject({
      method: 'GET',
      url: '/v1/people/SYNTHETIC-RAW-ID?search=SyntheticSearchTerm',
      headers: { authorization: 'Bearer SyntheticToken', cookie: 'session=SyntheticCookie' },
      remoteAddress: '192.0.2.44',
    });
    await app.close();
    const text = lines.join('');
    expect(text).toContain('"route":"/v1/people/:id"');
    for (const secret of ['SyntheticToken', 'SyntheticCookie', 'SyntheticSearchTerm', 'SYNTHETIC-RAW-ID', '192.0.2.44']) expect(text).not.toContain(secret);
  });
});
