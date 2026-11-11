// ZT21's open-questions clause (BRD line 4788): "No unresolved rule affecting delivered permission/calculation/payment/schema
// requiredness." The owner's list of what is still open is docs/10_owner_decisions.md: every numbered item there that does not say
// "Decided" or "Done" is open (docs/10 section C: the readings listed in the decision register stand as decided under the owner's
// delegation of 6 Nov 2026). This file says, for each open item, which requirement rows its answer can change. The release gate
// (release-gate.ts) refuses a release while an open item affects a row it would deliver, that is any row not Blocked.
//
// Like blocked.ts, nothing is decided here. Each entry copies what docs/10 says (`stillSays`, checked on every run), and the gate stops
// when docs/10 lists an open item this file does not map, or when an entry's item has since been decided (unless the entry names the
// decision that closed it, `decidedIn`, whose docs/10 update is pending: then it stays open until docs/10 says Decided, and is inert
// after). The mapping of an item to rows is a reading, made for I-84 on 6 Nov 2026: review it when an item is added.

export type RuleKind = 'permission' | 'calculation' | 'payment' | 'schema' | 'output' | 'environment' | 'handover';

export interface OpenQuestion {
  /** docs/10 section letter and item number, as "A4", "A11a", "B3". */
  item: string;
  /** What kind of rule it leaves open (ZT21 names permission, calculation, payment and schema requiredness). */
  kind: RuleKind;
  /** Requirement rows whose behaviour the answer can change. Empty only for a handover step that is no rule (`why` says so). */
  affects: readonly string[];
  /** Copied from docs/10's item text; the item must still contain it while it is open. */
  stillSays: string;
  /** The decision that closed it, where docs/10 has not caught up yet. */
  decidedIn?: string;
  why?: string;
}

const range = (prefix: string, first: number, last: number, width: number) =>
  Array.from({ length: last - first + 1 }, (_, i) => `${prefix}${String(first + i).padStart(width, '0')}`);

/** Report families whose columns and samples section 11 wants approved before release (docs/10 item 29; I-40 item 12). */
const REPORT_ROWS = ['FR-007', 'FR-029', 'FR-038', 'FR-044', 'FR-048', 'FR-054', 'FR-056', 'FR-058', 'FR-079', 'FR-090', 'FR-093', 'BR-026', 'BR-039'];

export const OPEN_QUESTIONS: readonly OpenQuestion[] = [
  // A11a, A12a, A16a, A23a and A28b: signed off by the owner on 11 Nov 2026 (docs/10 says Decided), so no longer open.
  // A29 (report columns, signed off 11 Nov 2026), D8 and E6 (decided 11 Nov 2026) are no longer open.
  { item: 'A33', kind: 'schema', affects: ['ZT20', 'BR-028'], stillSays: 'What counts as "delivered"', decidedIn: 'I-84' },
  { item: 'A35', kind: 'schema', affects: [...range('DQ-', 1, 15, 2), 'ZT19'], stillSays: 'Data migration needs authorised extracts' },
  { item: 'B1', kind: 'permission', affects: ['ZT02', 'FR-060'], stillSays: 'rerouting a stuck task', decidedIn: 'I-84' },
  { item: 'B2', kind: 'permission', affects: ['FR-066', 'FR-067'], stillSays: "System Administrator's role change", decidedIn: 'I-84' },
  // B3 also asks about team.export (I-62 item 1), which another package decides; open until docs/10 marks the whole item decided.
  { item: 'B3', kind: 'permission', affects: ['FR-003', 'FR-068', 'FR-095'], stillSays: '`access.delegate`', decidedIn: 'I-84 (access.delegate) with team.export decided elsewhere' },
  { item: 'B4', kind: 'permission', affects: ['FR-083', 'BR-032', 'FR-056', 'FR-089', 'FR-090', 'ZT26'], stillSays: '`celebration.read`', decidedIn: 'I-84' },
  { item: 'B5', kind: 'permission', affects: ['FR-054', 'FR-096'], stillSays: 'settlement export right', decidedIn: 'I-84' },
  { item: 'B6', kind: 'permission', affects: ['FR-066', 'FR-067', 'FR-085'], stillSays: 'approves role changes and notification rules', decidedIn: 'I-84' },
  { item: 'B7', kind: 'permission', affects: ['FR-066', 'BR-044'], stillSays: 'baseline role ceilings', decidedIn: 'I-84' },
  { item: 'D1', kind: 'calculation', affects: ['FR-036', 'FR-108', 'FR-107'], stillSays: 'Tax rule pack' },
  { item: 'D2', kind: 'payment', affects: ['FR-102'], stillSays: 'bank file specification' },
  { item: 'D3', kind: 'calculation', affects: ['FR-028', 'FR-039'], stillSays: 'professional tax slabs' },
  { item: 'D4', kind: 'output', affects: ['FR-038'], stillSays: 'NPS, EDOC and liability-provision' },
  { item: 'D5', kind: 'schema', affects: ['FR-019'], stillSays: 'biometric device export format' },
  { item: 'D7', kind: 'environment', affects: range('ZT', 31, 35, 2), stillSays: 'capacity test environment' },
  { item: 'E2', kind: 'handover', affects: [], stillSays: 'The development database', why: 'The development database only; nothing shipped depends on it' },
  { item: 'E5', kind: 'schema', affects: ['FR-106'], stillSays: 'malware scan keeps failing', decidedIn: 'I-84' },
];

export interface OwnerItem {
  /** Section letter and number, as "A4" or "A11a". */
  item: string;
  text: string;
  open: boolean;
}

/** The numbered items of docs/10's sections. An item is open unless its text starts with "Decided" or "Done". */
export function parseOwnerList(text: string): OwnerItem[] {
  const items: OwnerItem[] = [];
  let section: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^## ([A-Z])\. /.exec(line);
    if (heading) {
      section = heading[1]!;
      continue;
    }
    if (line.startsWith('#')) section = null;
    const numbered = section ? /^(\d+[a-z]?)\. (.+)$/.exec(line) : null;
    if (!numbered) continue;
    const body = numbered[2]!.trim();
    items.push({ item: `${section}${numbered[1]}`, text: body, open: !/^(?:\*\*)?(?:Decided|Done)\b/.test(body) });
  }
  return items;
}

export interface OpenQuestionState {
  entry: OpenQuestion;
  /** True while docs/10 lists the item as open. */
  open: boolean;
}

/**
 * Pairs docs/10's items with this file's entries. Throws when they disagree, as blocked.ts does when a register has moved: an open
 * item nobody mapped, an entry whose item is gone or now says something else, or an entry whose item was decided with no decision
 * named here.
 */
export function openQuestionStates(ownerList: readonly OwnerItem[], entries: readonly OpenQuestion[] = OPEN_QUESTIONS): OpenQuestionState[] {
  const problems: string[] = [];
  const byItem = new Map(ownerList.map((i) => [i.item, i]));
  const mapped = new Set(entries.map((e) => e.item));
  for (const i of ownerList) if (i.open && !mapped.has(i.item)) problems.push(`docs/10 item ${i.item} is open, but db/registers/open-questions.ts does not say which rows it affects`);
  const states: OpenQuestionState[] = [];
  for (const entry of entries) {
    const owner = byItem.get(entry.item);
    if (!owner) {
      problems.push(`docs/10 has no item ${entry.item}; update or remove it in db/registers/open-questions.ts`);
      continue;
    }
    if (!owner.open) {
      if (!entry.decidedIn) problems.push(`docs/10 item ${entry.item} is no longer open; remove it from db/registers/open-questions.ts`);
      states.push({ entry, open: false });
      continue;
    }
    if (!owner.text.includes(entry.stillSays)) problems.push(`docs/10 item ${entry.item} no longer says "${entry.stillSays}"; update db/registers/open-questions.ts`);
    if (!entry.affects.length && !entry.why) problems.push(`db/registers/open-questions.ts: ${entry.item} affects no row and says not why`);
    states.push({ entry, open: true });
  }
  if (problems.length) throw new Error(problems.join('\n'));
  return states;
}
