// A completed test run as evidence: what ran, under which name, with what result. Read from vitest's JSON output.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface TestOutcome {
  file: string;
  /** Describe blocks and title joined by " > ", which is how the access trace names a test too. */
  name: string;
  status: TestStatus;
  /**
   * Declared with `it.fails` / `test.fails` in its file: vitest reports it passed only while its assertion fails, so a pass is a
   * known wrong behaviour recorded as a test, never evidence that the behaviour holds (I-84). Absent in runs read before I-84.
   */
  expectedFailure?: boolean;
}

export interface RunEvidence {
  label: string;
  /** Hash of the JSON file as read, so a copy elsewhere can be matched to this record. */
  sha256: string;
  startedAt: string;
  passed: number;
  failed: number;
  skipped: number;
  /** vitest's own verdict: false if anything failed, including a file that never reached its tests. */
  success: boolean;
  /** Files that failed without reporting a test: whatever they would have shown is unknown. */
  filesWithoutResults: string[];
  tests: TestOutcome[];
}

interface VitestJson {
  startTime: number;
  success: boolean;
  testResults: {
    name: string;
    status: string;
    assertionResults: { ancestorTitles: string[]; title: string; status: string }[];
  }[];
}

/** Anything vitest did not report as run and passed or failed counts as skipped: it is not evidence either way. */
const statusOf = (status: string): TestStatus => (status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'skipped');

export function parseRun(label: string, text: string, root: string): RunEvidence {
  const json = JSON.parse(text) as VitestJson;
  const tests: TestOutcome[] = [];
  const filesWithoutResults: string[] = [];
  for (const file of json.testResults) {
    const path = relative(root, file.name).replace(/\\/g, '/');
    if (file.assertionResults.length === 0 && file.status !== 'passed') filesWithoutResults.push(path);
    for (const test of file.assertionResults) tests.push({ file: path, name: [...test.ancestorTitles, test.title].join(' > '), status: statusOf(test.status) });
  }
  const count = (status: TestStatus) => tests.filter((t) => t.status === status).length;
  return {
    label,
    sha256: createHash('sha256').update(text).digest('hex'),
    startedAt: new Date(json.startTime).toISOString(),
    passed: count('passed'),
    failed: count('failed'),
    skipped: count('skipped'),
    success: json.success,
    filesWithoutResults,
    tests,
  };
}

export const loadRun = (label: string, path: string, root: string): RunEvidence => parseRun(label, readFileSync(path, 'utf8'), root);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The titles a test file declares with `it.fails` or `test.fails`, as patterns over a test's own title. A template literal's `${...}`
 * parts match anything. A declaration whose title cannot be read from the source (`it.fails.each`, a title held in a variable) is
 * returned as a pattern matching every title, so the whole file's tests count as declared to fail rather than as evidence.
 */
export function declaredToFail(source: string): RegExp[] {
  const patterns: RegExp[] = [];
  for (const m of source.matchAll(/\b(?:it|test)\.fails\b(\.each)?\s*\(\s*(?:(['"])((?:\\.|(?!\2)[^\\\r\n])*)\2|`((?:\\.|[^`\\])*)`)?/g)) {
    const [, each, , quoted, template] = m;
    if (each || (quoted === undefined && template === undefined)) {
      patterns.push(/^/);
      continue;
    }
    const title = (quoted ?? template ?? '').replace(/\\(.)/g, '$1');
    const body = template === undefined ? escapeRegExp(title) : title.split(/\$\{[^}]*\}/).map(escapeRegExp).join('.*');
    patterns.push(new RegExp(`(?:^| > )${body}$`));
  }
  return patterns;
}

/** Marks each test its file declares with `.fails` (sources by repository path; a file not given is left as it is). */
export function markExpectedFailures(runs: readonly RunEvidence[], sources: ReadonlyMap<string, string>): RunEvidence[] {
  const patternsOf = new Map<string, RegExp[]>();
  for (const [file, source] of sources) patternsOf.set(file, declaredToFail(source));
  return runs.map((run) => ({
    ...run,
    tests: run.tests.map((t) => ((patternsOf.get(t.file) ?? []).some((p) => p.test(t.name)) ? { ...t, expectedFailure: true } : t)),
  }));
}
