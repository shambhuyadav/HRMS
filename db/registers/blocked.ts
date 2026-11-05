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
  { ids: ['FR-035', 'FR-100'], reason: "Owner input: treatment of closed periods and tax differences, an adjustment valuation policy and a calculation hook. Case records are built; nothing calculates or feeds payroll", source: TRACEABILITY, stillSays: 'FR-035 arrears and FR-100 late-timesheet adjustments' },
  { ids: ['FR-036', 'FR-108'], reason: 'Owner input: an active tax rule pack with regimes and categories. Capture and review are built', source: TRACEABILITY, stillSays: 'FR-036/FR-108 tax declarations and investment proofs' },
  { ids: ['FR-107'], reason: 'Form 16 needs the statutory template and rule pack (H8)', source: TRACEABILITY, stillSays: 'Form 16 needs the statutory template' },
  { ids: ['FR-102'], reason: 'Production bank files need a bank-accepted specification and sample validation', source: TRACEABILITY, stillSays: 'bank files in production (need a bank-accepted specification and sample validation)' },
  { ids: ['FR-014', 'FR-017'], reason: 'I-48 item 2: offer letters while an offer is being made, before the candidate is an employee', source: REGISTER, stillSays: '(2) FR-017/FR-014 offer letters' },
  { ids: ['FR-007', 'FR-008'], reason: 'I-48 item 3: field dictionary for family, qualification, prior-employment and payroll-identifier sections', source: REGISTER, stillSays: '(3) FR-008/FR-007 field dictionary' },
  { ids: ['FR-005', 'BR-008'], reason: 'I-48 item 4: meaning and range of the shift buffer, and the 24-hour-cycle indicator', source: REGISTER, stillSays: '(4) FR-005/BR-008 meaning and range of the shift buffer' },
  { ids: ['FR-024', 'FR-025'], reason: 'I-48 item 5: leave-year boundary and the year-end expiry run above the carry cap', source: REGISTER, stillSays: '(5) FR-024/FR-025 leave-year boundary' },
  { ids: ['FR-043'], reason: 'I-48 item 7: reviewer scores, per goal or overall, and their effect on the final rating', source: REGISTER, stillSays: '(7) FR-043/DF04 reviewer scores' },
  { ids: ['FR-043', 'BR-013'], reason: 'I-48 item 8: whether level 1 completes at the manager’s approval without an HR reviewer', source: REGISTER, stillSays: '(8) FR-043/BR-013 whether level 1 completes' },
  { ids: ['FR-041'], reason: 'I-48 item 9: KRA setting review before goals take effect', source: REGISTER, stillSays: '(9) FR-041/F1 KRA setting review' },
  { ids: ['FR-042', 'BR-014'], reason: 'I-48 item 10: manual rating mode', source: REGISTER, stillSays: '(10) FR-042/BR-014 manual rating mode' },
  { ids: ['FR-038'], reason: 'I-48 item 11: salary progression chart measure, grouping and span', source: REGISTER, stillSays: '(11) FR-038 salary progression chart' },
  { ids: ['FR-034'], reason: 'I-48 item 12: loan early settlement route, waiver or write-off, evidence and approver', source: REGISTER, stillSays: '(12) FR-034 loan early settlement' },
  { ids: ['FR-055'], reason: 'I-48 item 13: offboarding of a separated user’s assignments, own-ESS access and pending tasks', source: REGISTER, stillSays: '(13) FR-055 offboarding' },
  { ids: ['FR-052'], reason: 'I-48 item 14: what "already paid" means between a settlement and monthly payroll', source: REGISTER, stillSays: '(14) FR-052 what' },
  { ids: ['FR-051', 'FR-053'], reason: 'I-48 item 15: what an approved withdrawal does to a live settlement', source: REGISTER, stillSays: '(15) FR-051/FR-053 what an approved withdrawal does' },
  { ids: ['FR-054'], reason: 'I-48 item 16: matching rules for uploaded-list selection', source: REGISTER, stillSays: '(16) FR-054 matching rules' },
  { ids: ['BR-024'], reason: 'I-48 item 17: a claim reimbursed through a payroll input while still showing unpaid, so a second direct payment is possible', source: REGISTER, stillSays: '(17) BR-024/OQ-17' },
  { ids: ['ZT19'], reason: 'OQ-19: needs authorised extracts; no migration tool exists and no source validation has been performed', source: REGISTER, stillSays: 'ZT19 (no migration tool, OQ-19)' },
  { ids: ['ZT20'], reason: 'I-75 item 6: what "delivered" means, given rows blocked on owner inputs. Its tests prove the mappings and coverage log only, not the passing-test clause', source: REGISTER, stillSays: '(6) ZT20: what does "delivered" mean' },
  { ids: ['ZT21'], reason: 'Open owner questions in I-40, I-48 and I-74 affect delivered permission, calculation, payment and schema rules. Its tests prove a pattern scan and logs only (I-75)', source: REGISTER, stillSays: 'BR-028, ZT20 and ZT21, whose tests prove only' },
  { ids: ['BR-028'], reason: 'I-75 item 7: who or what blocks a release. The BRD says its required tests are "specified, not reported as passed"; its tests prove the record only', source: REGISTER, stillSays: '(7) BR-028: who or what blocks a release' },
  { ids: ['BR-045', 'FR-096', 'FR-097', 'ZT28'], reason: 'I-74 items 1 and 2: Treasury Approver and Expense Finance Approver widgets can only be 0 until the owner decides', source: REGISTER, stillSays: 'BR-045, FR-096, FR-097 and ZT28 (the widgets in I-74 items 1 and 2)' },
  { ids: ['BR-003'], reason: 'I-75 item 1: Offered and Offered Rejected views, and whether Current includes On Notice', source: REGISTER, stillSays: '(1) BR-003/FR-006: should Offered' },
  { ids: ['BR-012'], reason: 'I-75 item 2: whether the payroll run list needs a financial-year filter', source: REGISTER, stillSays: '(2) BR-012: is a financial-year filter needed' },
  { ids: ['BR-011'], reason: 'I-75 item 3 and I-40 item 10: the estimated in-hand formula', source: REGISTER, stillSays: '(3) BR-011: the estimated in-hand formula' },
  { ids: ['CI07'], reason: 'I-75 item 4: the valuation-date rule for salary arrangements; a record completed by hand with an arrangement outside its period is refused by the calculation but not the database', source: REGISTER, stillSays: '(4) CI07: which valuation-date rule' },
  { ids: ['FR-063'], reason: 'I-75 item 5: whether payroll run creation takes an idempotency key; a retry gets 409 rather than the recorded result', source: REGISTER, stillSays: '(5) FR-063: should payroll run creation' },
];

/** Refuses an entry whose source no longer says what it copied. `read` gives a repository file's text. */
export function checkBlockedSources(read: (path: string) => string, entries: readonly BlockedEntry[] = BLOCKED): void {
  for (const entry of entries) {
    if (!read(entry.source).includes(entry.stillSays)) {
      throw new Error(`db/registers/blocked.ts: ${entry.source} no longer says "${entry.stillSays}". Update or remove ${entry.ids.join(', ')}`);
    }
  }
}
