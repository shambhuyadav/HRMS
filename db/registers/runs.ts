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
