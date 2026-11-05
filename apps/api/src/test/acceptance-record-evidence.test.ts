// What a test can show of three whole-system rules, and only that: BR-028 zero tolerance business gates (BRD line 1803), ZT20 requirements
// and coverage completeness (line 4787) and ZT21 open questions and privacy (line 4788). Each test's name says what it does not cover.
// A release decision, the passing-test clause of ZT20 and the open-questions clause of ZT21 are not tested here: see each name.
// Reads the repository's own text and the generator's own rules. Synthetic data only.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
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

  it.each(GATES)('BR-028 (the record only: who blocks a release is a person, and no release pipeline exists here to test): a failed %s gate shows Fail in the register, even beside passing tests', (_kind, title) => {
    const id = gateId(title);
    expect(verdicts([{ name: `${id} one`, status: 'passed' }, { name: `${id} two`, status: 'failed' }]).get(id)).toBe('Fail');
    expect(verdicts([{ name: `${id} one`, status: 'passed' }]).get(id)).toBe('Pass');
  });

  it.each(GATES)('BR-028 (the record only): a required %s gate with no run behind it is specified, not reported as passed', (_kind, title) => {
    const id = gateId(title);
    expect(requirements.find((r) => r.id === id)!.expected.length).toBeGreaterThan(20);
    expect(verdicts([]).get(id)).toBe('Not evidenced');
    expect(verdicts([{ name: `${id} one`, status: 'skipped' }]).get(id)).toBe('Not evidenced');
  });
});

describe('requirements and coverage completeness', () => {
  const trace = read('docs/06_traceability_register.md');

  it('ZT20 (mapping only; the passing-test clause is the verification register itself and does not hold yet): every FR has a row with its source, decision and table or stated no-storage reason', () => {
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

  it('ZT20 (mapping only, as above): every BR has a row with its module, mechanism and the requirement it serves', () => {
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
  const SCANNED = ['docs', 'db', 'apps', 'load', 'README.md', '.env.example', 'docker-compose.yml'];
  const TEXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.md', '.sql', '.json', '.yml', '.yaml', '.css', '.html', '.csv', '.txt', '.example', '']);
  const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.dev-pg', '.dev-files']);
  const filesUnder = (path: string): string[] => {
    const full = join(ROOT, path);
    if (!statSync(full).isDirectory()) return [path];
    return readdirSync(full).flatMap((name) => (SKIPPED_DIRS.has(name) ? [] : filesUnder(join(path, name))));
  };
  const files = SCANNED.flatMap(filesUnder).filter((f) => TEXT.has(extname(f)) && !f.endsWith('package-lock.json'));
  const hits = (pattern: RegExp, allowed: (match: string) => boolean = () => false) => {
    const found: string[] = [];
    for (const file of files) {
      for (const m of readFileSync(join(ROOT, file), 'utf8').matchAll(pattern)) {
        if (!allowed(m[0])) found.push(`${relative(ROOT, join(ROOT, file)).replace(/\\/g, '/')}: ${m[0].slice(0, 60)}`);
      }
    }
    return found;
  };

  it('ZT21 (a pattern scan of shared files only: it cannot prove data is synthetic, and the open-questions clause is not tested and does not hold yet): no private key, cloud access key, or identity, tax or mobile number', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(hits(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g)).toEqual([]);
    expect(hits(/\bAKIA[0-9A-Z]{16}\b/g)).toEqual([]);
    // India's tax (PAN) and identity (Aadhaar) number shapes, and a mobile number.
    expect(hits(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g)).toEqual([]);
    expect(hits(/(?<![\w-])[2-9]\d{3} \d{4} \d{4}(?![\w-])/g)).toEqual([]);
    expect(hits(/(?<![\w.-])(?:\+91[ -]?)?[6-9]\d{9}(?![\w.-])/g)).toEqual([]);
  });

  it('ZT21 (pattern scan only, as above): every email address is on a domain reserved for examples, every address is loopback, and any connection string with a credential points at this machine', () => {
    const reserved = (email: string) => /@([a-z0-9-]+\.)*(test|example|invalid)$|@example\.(com|org|net)$/i.test(email);
    expect(hits(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, reserved)).toEqual([]);
    // Loopback, the wildcard listen address, and the ranges reserved for documentation (RFC 5737).
    expect(hits(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) => /^(127\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(ip) || ip === '0.0.0.0')).toEqual([]);
    expect(hits(/\b(?:postgres(?:ql)?|mysql|mongodb|redis|amqp):\/\/[^\s'"`$@]+:[^\s'"`$@]+@[^\s'"`/:]+/g, (url) => /@(127\.0\.0\.1|localhost)$/.test(url))).toEqual([]);
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
