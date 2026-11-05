// The identifiers an acceptance record must cover, read from the BRD itself so none can be left out by a hand-kept list (D2, BRD line
// 4807; ZT20). Coverage Log items are not here: their only statuses are Documented, Restricted and Not reachable, which are not results.
export type Family = 'FR' | 'BR' | 'DQ' | 'CI' | 'ZT';

export interface Requirement {
  id: string;
  family: Family;
  title: string;
  /** 1-based line of its definition in the BRD. */
  line: number;
  /** Observed or proposed, as far as the BRD states one for this row. */
  classification: string;
  expected: string;
}

export const EXPECTED_COUNTS: Record<Family, number> = { FR: 110, BR: 55, DQ: 15, CI: 30, ZT: 40 };

const clean = (text: string) =>
  text
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/&#124;/g, '|')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** Every FR, BR, DQ, CI and ZT, first definition wins. Throws when a family does not reach its count: the BRD's format has changed. */
export function parseRequirements(brd: string): Requirement[] {
  const lines = brd.split(/\r?\n/);
  const found = new Map<string, Requirement>();
  const add = (r: Requirement) => {
    if (!found.has(r.id)) found.set(r.id, r);
  };

  lines.forEach((text, index) => {
    const line = index + 1;
    const heading = /^#{4,5} ((FR|BR)-\d{3}) (.+)$/.exec(text);
    if (heading) {
      const [, id, family, rawTitle] = heading as unknown as [string, string, 'FR' | 'BR', string];
      const title = clean(rawTitle.replace(/ H1\/BR-053 controls.*$/, ''));
      const body: string[] = [];
      for (let i = index + 1; i < lines.length && !lines[i]!.startsWith('#'); i++) if (lines[i]!.trim()) body.push(lines[i]!);
      const labelled = (label: string) => {
        const row = body.find((b) => b.startsWith(`${label}:`));
        return row ? clean(row.slice(label.length + 1)) : null;
      };
      if (family === 'FR') {
        add({ id, family, title, line, classification: labelled('Classification') ?? 'Not stated', expected: labelled('Acceptance') ?? body.map(clean).join(' ') });
      } else {
        const dependency = labelled('Evidence and decision dependency');
        add({ id, family, title, line, classification: dependency?.split(';')[0]?.trim() || 'Not stated', expected: clean(body[0] ?? title) });
      }
      return;
    }
    // CI22 and CI23 share a paragraph ("CI22: prove ... CI23: dashboard ..."); CI24 has one of its own ("CI24 Title: rule").
    for (const m of text.matchAll(/(?:^|\. )(CI\d{2}): (.+?)(?=\. CI\d{2}:|$)/g)) {
      const [, id, rule] = m as unknown as [string, string, string];
      add({ id, family: 'CI', title: clean(rule).split(/[;,]/)[0]!, line, classification: 'Target rule (no per-row classification in the BRD)', expected: clean(rule) });
    }
    const invariant = /^(CI\d{2}) ([^:|]+): (.+)$/.exec(text);
    if (invariant) {
      const [, id, title, rule] = invariant as unknown as [string, string, string, string];
      add({ id, family: 'CI', title: clean(title), line, classification: 'Target rule (no per-row classification in the BRD)', expected: clean(rule) });
      return;
    }
    const paragraph = /^(BR-\d{3}) (.+)$/.exec(text);
    if (paragraph) {
      const [, id, rule] = paragraph as unknown as [string, string, string];
      add({ id, family: 'BR', title: clean(rule).split('. ')[0]!.replace(/\.$/, ''), line, classification: 'Appendix H target rule', expected: clean(rule) });
      return;
    }
    const quality = /^\| (DQ-\d{2}) ([^|]+?) \| ([^|]+?) \| ([^|]+?) \|$/.exec(text);
    if (quality) {
      const [, id, title, activity, status] = quality as unknown as [string, string, string, string, string];
      add({ id, family: 'DQ', title: clean(title), line, classification: clean(status), expected: clean(activity) });
      return;
    }
    const named = /^\| ((CI|ZT)\d{2}) ([^|]+?) \| ([^|]+?) \|/.exec(text);
    if (named) {
      const [, id, family, title, rule] = named as unknown as [string, string, 'CI' | 'ZT', string, string];
      add({ id, family, title: clean(title), line, classification: 'Target rule (no per-row classification in the BRD)', expected: clean(rule) });
      return;
    }
    const split = /^\| (CI\d{2}) \| ([^|]+?) \| ([^|]+?) \|/.exec(text);
    if (split) {
      const [, id, title, rule] = split as unknown as [string, string, string, string];
      add({ id, family: 'CI', title: clean(title), line, classification: 'Target rule (no per-row classification in the BRD)', expected: clean(rule) });
    }
  });

  const all = [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const [family, count] of Object.entries(EXPECTED_COUNTS)) {
    const have = all.filter((r) => r.family === family).length;
    if (have !== count) throw new Error(`The BRD gave ${have} ${family} rows where ${count} are expected; its format has changed`);
  }
  return all;
}

/**
 * The identifiers a test's own name states. "BR-001/002" and "FR-025 to FR-027" state each one they span; anything else, however
 * related, is not named. Never inferred from what the test does.
 */
export function idsNamedIn(text: string): string[] {
  const ids = new Set<string>();
  const span = (make: (n: number) => string, first: string, slashed: string | undefined, last: string | undefined) => {
    ids.add(make(Number(first)));
    for (const part of (slashed ?? '').split('/').filter(Boolean)) ids.add(make(Number(part)));
    if (last !== undefined) for (let n = Number(first); n <= Number(last) && n - Number(first) < 200; n++) ids.add(make(n));
  };
  for (const m of text.matchAll(/\b(FR|BR)-(\d{3})((?:\/\d{3}(?!\d))*)(?:\s*(?:to|–)\s*(?:\1-)?(\d{3}))?(?![A-Za-z0-9])/g)) {
    const family = m[1];
    span((n) => `${family}-${String(n).padStart(3, '0')}`, m[2]!, m[3], m[4]);
  }
  for (const m of text.matchAll(/\b(CI|ZT)(\d{2})((?:\/\d{2}(?!\d))*)(?:\s*(?:to|–)\s*(?:\1)?(\d{2}))?(?![A-Za-z0-9])/g)) {
    const family = m[1];
    span((n) => `${family}${String(n).padStart(2, '0')}`, m[2]!, m[3], m[4]);
  }
  for (const m of text.matchAll(/\bDQ-?(\d{2})(?![A-Za-z0-9])/g)) ids.add(`DQ-${m[1]}`);
  return [...ids].sort();
}
