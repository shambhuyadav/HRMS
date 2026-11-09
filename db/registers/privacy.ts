// ZT21's privacy clause (BRD line 4788): "Final shared artefact and evidence contain no actual credentials, technical connection
// addresses or real personal data; use synthetic fixtures." A scan of the shared files for the shapes those take. A shape is all a scan
// can see: it finds a key, an address or an identity number, and it cannot prove that a name or a date is synthetic. The release gate
// (release-gate.ts) refuses a release with any hit; apps/api/src/test/acceptance-record-evidence.test.ts runs the same scan.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

/** What is shared: the code, the records and the files a developer copies to start. */
export const SHARED = ['docs', 'db', 'apps', 'load', 'README.md', '.env.example', 'docker-compose.yml'] as const;
const TEXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.md', '.sql', '.json', '.yml', '.yaml', '.css', '.html', '.csv', '.txt', '.example', '']);
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.dev-pg', '.dev-files']);

/** Every shared text file under `root`, as repository paths with forward slashes. */
export function sharedFiles(root: string): string[] {
  const under = (path: string): string[] => {
    const full = join(root, path);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      return [];
    }
    if (!stat.isDirectory()) return [path];
    return readdirSync(full).flatMap((name) => (SKIPPED_DIRS.has(name) ? [] : under(`${path}/${name}`)));
  };
  return SHARED.flatMap((p) => under(p)).filter((f) => TEXT.has(extname(f)) && !f.endsWith('package-lock.json'));
}

export interface PrivacyRule {
  code: string;
  pattern: RegExp;
  /** A match this returns true for is allowed (a reserved example domain, loopback). */
  allowed?: (match: string) => boolean;
}

/** Reserved for documentation and examples: RFC 2606 domains, loopback and the RFC 5737 ranges. */
const reservedEmail = (email: string) => /@([a-z0-9-]+\.)*(test|example|invalid)$|@example\.(com|org|net)$/i.test(email);
const reservedAddress = (ip: string) => /^(127\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(ip) || ip === '0.0.0.0';

export const PRIVACY_RULES: readonly PrivacyRule[] = [
  { code: 'PRIVATE_KEY', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { code: 'CLOUD_ACCESS_KEY', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  // India's tax (PAN) and identity (Aadhaar) number shapes, and a mobile number.
  { code: 'PAN', pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g },
  { code: 'AADHAAR', pattern: /(?<![\w-])[2-9]\d{3} \d{4} \d{4}(?![\w-])/g },
  { code: 'MOBILE', pattern: /(?<![\w.-])(?:\+91[ -]?)?[6-9]\d{9}(?![\w.-])/g },
  { code: 'EMAIL', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, allowed: reservedEmail },
  { code: 'ADDRESS', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, allowed: reservedAddress },
  {
    code: 'CONNECTION_CREDENTIAL',
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb|redis|amqp):\/\/[^\s'"`$@]+:[^\s'"`$@]+@[^\s'"`/:]+/g,
    allowed: (url) => /@(127\.0\.0\.1|localhost)$/.test(url),
  },
];

export interface PrivacyHit {
  file: string;
  /** 1-based line of the match. */
  line: number;
  code: string;
  /** The first four characters of the match and its length, so a report says where without repeating what it found. */
  masked: string;
}

/** Every match of a rule in the given texts that its rule does not allow. */
export function privacyHitsIn(texts: Iterable<[file: string, text: string]>, rules: readonly PrivacyRule[] = PRIVACY_RULES): PrivacyHit[] {
  const hits: PrivacyHit[] = [];
  for (const [file, text] of texts) {
    for (const rule of rules) {
      for (const m of text.matchAll(rule.pattern)) {
        if (rule.allowed?.(m[0])) continue;
        const line = text.slice(0, m.index).split('\n').length;
        hits.push({ file, line, code: rule.code, masked: `${m[0].slice(0, 4)}… (${m[0].length} characters)` });
      }
    }
  }
  return hits;
}

/** The scan of every shared file under `root`. */
export function scanSharedFiles(root: string): { files: number; hits: PrivacyHit[] } {
  const files = sharedFiles(root);
  function* texts(): Generator<[string, string]> {
    for (const file of files) yield [file, readFileSync(join(root, file), 'utf8')];
  }
  return { files: files.length, hits: privacyHitsIn(texts()) };
}
