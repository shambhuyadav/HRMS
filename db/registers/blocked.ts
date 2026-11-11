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
  // FR-007, FR-005/BR-008, FR-042/BR-014, FR-052, FR-055 and FR-020 left this list on 11 Nov 2026: the owner signed off docs/10
  // A16a, A23a, A28b, A12a and A11a (recorded in docs/03 I-82, I-78, I-86, I-88, I-81 and I-53).
  { ids: ['FR-038'], reason: 'Sign-off pending and outside inputs: section 11 (line 2274) needs owner-approved samples for each output, line 835 needs approved bank and accounting formats, and the NPS, EDOC and liability-provision specifications are outside inputs. The progression chart is decided in I-83 item 6', source: REGISTER, stillSays: 'FR-038 stays Blocked: section 11' },
  { ids: ['ZT19'], reason: 'OQ-19: needs authorised extracts; no migration tool exists and no source validation has been performed', source: REGISTER, stillSays: 'ZT19 (no migration tool, OQ-19)' },
  { ids: ['ZT21'], reason: 'The release gate (I-84 item 17) refuses while open owner items in docs/10 affect delivered permission, calculation, payment or schema rows (db/registers/open-questions.ts), and its privacy clause can be shown only by a pattern scan', source: REGISTER, stillSays: 'ZT21 stays Blocked: the release gate refuses while open owner items' },
  { ids: ['ZT16'], reason: "Sign-off pending: line 4783 needs module-owner-approved fixtures, and a delegated decision is not that approval. The I-70 formulas are decided in I-79; those in I-28 and I-40 items 1 and 10 are still open. Its one named test is the F3 row 4 leave fixture", source: REGISTER, stillSays: 'ZT16 (its fixtures need module-owner approval' },
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
