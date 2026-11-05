// The verification register (D2, BRD line 4807; ZT20). A row says Pass only where a test that names the identifier ran and passed in
// the cited run. Nothing is inferred from what a test does, from a document, or from a requirement being built. An honest gap is the
// right result for an acceptance record, so everything else says Not evidenced or Blocked, with the reason.
import type { BlockedEntry } from './blocked.js';
import { idsNamedIn, type Requirement } from './requirements.js';
import type { RunEvidence, TestOutcome } from './runs.js';

export type Disposition = 'Pass' | 'Fail' | 'Blocked' | 'Not evidenced';

export interface VerificationRow extends Requirement {
  disposition: Disposition;
  reason: string;
  /** Every test that names this identifier, with the run it is from. */
  named: (TestOutcome & { run: string })[];
  /** Test files whose text mentions it though no test's name does. A mention is not evidence; it says where to look. */
  mentionedIn: string[];
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A failure outranks all. A block outranks passing tests: they cover what is built, not the rule that is still unsettled. */
export function decide(named: readonly Pick<TestOutcome, 'status'>[], blocks: readonly Pick<BlockedEntry, 'reason' | 'source'>[], mentionedIn: readonly string[]): { disposition: Disposition; reason: string } {
  const passed = named.filter((t) => t.status === 'passed').length;
  const failed = named.filter((t) => t.status === 'failed').length;
  const skipped = named.length - passed - failed;
  const tally = [passed && `${passed} passed`, failed && `${failed} failed`, skipped && `${skipped} skipped`].filter(Boolean).join(', ');
  if (failed) return { disposition: 'Fail', reason: `Named tests: ${tally}` };
  if (blocks.length) {
    const why = blocks.map((b) => `${b.reason} (${b.source})`).join('; ');
    return { disposition: 'Blocked', reason: named.length ? `${why}. Named tests: ${tally}, which does not clear it` : why };
  }
  if (passed) return { disposition: 'Pass', reason: `${plural(passed, 'named test')} passed${skipped ? `, ${skipped} skipped` : ''}` };
  if (skipped) return { disposition: 'Not evidenced', reason: `Named only by ${plural(skipped, 'test')} that did not run` };
  if (mentionedIn.length) return { disposition: 'Not evidenced', reason: `No test's name states it; mentioned in ${plural(mentionedIn.length, 'test file')}` };
  return { disposition: 'Not evidenced', reason: 'No test names or mentions it' };
}

export function buildVerification(requirements: readonly Requirement[], runs: readonly RunEvidence[], blocked: readonly BlockedEntry[], testSources: ReadonlyMap<string, string>): VerificationRow[] {
  const named = new Map<string, (TestOutcome & { run: string })[]>();
  for (const run of runs) {
    for (const test of run.tests) {
      for (const id of idsNamedIn(test.name)) {
        if (!named.has(id)) named.set(id, []);
        named.get(id)!.push({ ...test, run: run.label });
      }
    }
  }
  const mentions = new Map<string, string[]>();
  for (const [file, source] of testSources) {
    for (const id of idsNamedIn(source)) {
      if (!mentions.has(id)) mentions.set(id, []);
      mentions.get(id)!.push(file);
    }
  }
  return requirements.map((requirement) => {
    const tests = named.get(requirement.id) ?? [];
    const naming = new Set(tests.map((t) => t.file));
    const mentionedIn = (mentions.get(requirement.id) ?? []).filter((file) => !naming.has(file)).sort();
    return { ...requirement, ...decide(tests, blocked.filter((b) => b.ids.includes(requirement.id)), mentionedIn), named: tests, mentionedIn };
  });
}
