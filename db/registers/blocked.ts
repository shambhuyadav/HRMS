// Rows that cannot pass yet whatever their tests say (BRD line 126: a gate that "depends on an unresolved business rule blocks the
// affected release scope"). Each entry copies a statement the project's own registers already make; none is decided here. `stillSays`
// is checked against the source on every run, so an entry the register has since dropped stops the generator instead of going stale.
const range = (prefix: string, first: number, last: number, width: number) =>
  Array.from({ length: last - first + 1 }, (_, i) => `${prefix}${String(first + i).padStart(width, '0')}`);

export interface BlockedEntry {
  ids: readonly string[];
  reason: string;
  source: string;
  stillSays: string;
}

const REGISTER = 'docs/03_decision_register.md';
const TRACEABILITY = 'docs/06_traceability_register.md';
const LOG = 'docs/08_verification_log.md';

export const BLOCKED: readonly BlockedEntry[] = [
  { ids: range('ZT', 31, 35, 2), reason: 'Full-capacity gate: needs the G4 environment, which does not exist. The workload harness proves its mechanics only', source: LOG, stillSays: 'ZT31–ZT35: BLOCKED until the G4 environment exists' },
  { ids: range('DQ-', 1, 15, 2), reason: 'OQ-19: needs authorised extracts; no source validation has been performed', source: REGISTER, stillSays: 'SRC: needs authorised extracts' },
  { ids: ['FR-036', 'FR-108'], reason: 'Owner input: an active tax rule pack with regimes and categories. Capture and review are built', source: TRACEABILITY, stillSays: 'FR-036/FR-108 tax declarations and investment proofs' },
  { ids: ['FR-107'], reason: 'Form 16 needs the statutory template and rule pack (H8)', source: TRACEABILITY, stillSays: 'Form 16 needs the statutory template' },
  { ids: ['FR-102'], reason: 'Production bank files need a bank-accepted specification and sample validation', source: TRACEABILITY, stillSays: 'bank files in production (need a bank-accepted specification and sample validation)' },
  { ids: ['FR-007'], reason: 'Sign-off pending: line 465 needs export column definitions approved before release; the family, qualification and prior-employment export columns (I-82 item 2) await the owner', source: REGISTER, stillSays: 'FR-007 stays Blocked for sign-off' },
  { ids: ['FR-005', 'BR-008'], reason: 'I-78: the shift buffer and overnight rules were decided under owner delegation, but FR-005 asks for an owner-approved duration and attendance date and BR-008 for signed business examples; the owner’s sign-off is pending', source: REGISTER, stillSays: "the owner's sign-off of them is still pending" },
  { ids: ['FR-042', 'BR-014'], reason: 'Sign-off pending: FR-042 needs "the approved test score" (line 885) and BR-014 says weights and formula/manual results "require owner confirmation"; the I-86 worked examples await the owner (docs/10 A28b)', source: REGISTER, stillSays: 'FR-042 and BR-014 stay Blocked for sign-off' },
  { ids: ['FR-038'], reason: 'Sign-off pending and outside inputs: section 11 (line 2274) needs owner-approved samples for each output, line 835 needs approved bank and accounting formats, and the NPS, EDOC and liability-provision specifications are outside inputs. The progression chart is decided in I-83 item 6', source: REGISTER, stillSays: 'FR-038 stays Blocked: section 11' },
  { ids: ['ZT19'], reason: 'OQ-19: needs authorised extracts; no migration tool exists and no source validation has been performed', source: REGISTER, stillSays: 'ZT19 (no migration tool, OQ-19)' },
  { ids: ['ZT21'], reason: 'The release gate (I-84 item 17) refuses while open owner items in docs/10 affect delivered permission, calculation, payment or schema rows (db/registers/open-questions.ts), and its privacy clause can be shown only by a pattern scan', source: REGISTER, stillSays: 'ZT21 stays Blocked: the release gate refuses while open owner items' },
  { ids: ['FR-052'], reason: 'Sign-off pending: line 995 needs owner-approved joiner and leaver examples; the calculation is built (I-88) and its worked examples A to F await the owner (docs/10 A12a)', source: REGISTER, stillSays: 'FR-052 stays Blocked for sign-off: its acceptance needs owner-approved joiner and leaver examples' },
  { ids: ['FR-055'], reason: 'Sign-off pending: line 1031 makes the closure actions depend on an owner-approved offboarding policy; I-81 item 4 is a delegated decision, not that approval', source: REGISTER, stillSays: 'FR-055 stays Blocked for sign-off' },
  { ids: ['ZT16'], reason: "Sign-off pending: line 4783 needs module-owner-approved fixtures, and a delegated decision is not that approval. The I-70 formulas are decided in I-79; those in I-28 and I-40 items 1 and 10 are still open. Its one named test is the F3 row 4 leave fixture", source: REGISTER, stillSays: 'ZT16 (its fixtures need module-owner approval' },
  { ids: ['FR-020'], reason: 'Line 611 needs approved test vectors and the owner-approved result; I-53 still lists the sign-off of the midnight test vectors and the next-day out-time rule', source: REGISTER, stillSays: 'sign-off of the midnight test vectors' },
  { ids: ['FR-039'], reason: 'Line 839 needs approved sample files and owner-supplied period templates; the statutory outputs are not configured until those and the rate packs arrive', source: TRACEABILITY, stillSays: 'FR-039 statutory outputs NOT_CONFIGURED' },
];

/** Refuses an entry whose source no longer says what it copied. `read` gives a repository file's text. */
export function checkBlockedSources(read: (path: string) => string, entries: readonly BlockedEntry[] = BLOCKED): void {
  for (const entry of entries) {
    if (!read(entry.source).includes(entry.stillSays)) {
      throw new Error(`db/registers/blocked.ts: ${entry.source} no longer says "${entry.stillSays}". Update or remove ${entry.ids.join(', ')}`);
    }
  }
}
