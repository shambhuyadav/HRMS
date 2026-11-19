// Letters and full-and-final settlements (FR-017, FR-018 and FR-055 letters; FR-052 to FR-054 settlements, as built;
// F1 "Exit and employee processes"; BR-016; DF02; DF03; DF09; DF12; C4; ZT07).
//
// Letters: HR keeps versioned letter templates that may use only the approved placeholders of their letter type, as the
// server lists them per type (an OFFER template has the offer's own placeholders and is issued from the approved offer in
// Hiring, never from an employee process; I-82 item 1). A template is edited as its DRAFT revision; publishing freezes the draft and retires the revision published before; a template is renamed,
// deactivated or activated again against its version. Every placeholder a template uses is mandatory unless the template
// marks it optional. For an employee process, an HR Administrator holding the confidential letter grant previews a
// letter (rendered for review only: nothing is stored and nothing is sent) and then generates the final letter, which
// the server refuses while a mandatory value is missing. The final letter is stored as a confidential file with its
// template code and revision, its generator and time; it is downloaded, or sent, which means delivered to the employee's own
// self-service with an in-app notice, never e-mailed (FR-018; DF09/DF12; I-81 item 9). Restricted HR notes and warnings appear
// only when the server returned them.
// Settlements: the preparer of a revision of an approved exit calculates it on the server (FR-052, I-88) from a versioned snapshot
// under the settlement policy and the statutory rule packs in force on the last working date; the calculation's items become its
// calculated lines, each item shown with the server's own basis, and lines for components it does not produce are entered with a
// reason. A revision that is not calculated takes lines an authorised HR Administrator enters or uploads. An item that blocks
// approval is shown as such, and the approver's refusal names every blocker; an exit's notice recovery is waived, with a reason,
// by someone other than the employee and the preparer. Nothing is calculated in the browser. Amounts are
// confidential: they appear only when the server returned them, exactly as returned, and the net amount is the
// server's (never summed or worked out here). With them come the remaining balances, read-only (FR-034): outstanding
// loans and advances (while the loans module is active) and paid leave as at the last working date; nothing here
// changes the lines or works out an encashment or a recovery. Submission freezes the revision; an independent reviewer and then an
// independent approver decide it in the settlement decision queues; a returned or rejected revision is corrected through
// a new revision. Release eligibility is a further explicit step by someone independent of all of them once the exit
// clearance is complete. It is not a payment (BR-016): the payment is made outside this system and recorded here from its
// evidence by someone independent (I-81 item 2); its date is the disbursement month. A live revision that must not be paid is
// voided by an independent approver (I-81 items 5, 6), and the final period's payroll is shown beside the balances (FR-052).
// FR-054 outputs: an approved revision downloads as CSV, Excel (XLSX) or PDF, and settlements selected from the list (by hand
// or from an uploaded list of employee codes, I-81 item 7) download as one ZIP of their files; the bulk upload takes the lines
// of several drafts in one file (shared import lifecycle). A statement is sent to the employee's own self-service, never e-mailed.
// The server authorises every call and decides every rule; these screens hide what the selected assignment cannot use,
// show only what the server returned and say its refusals in plain words.
//
// The code is in ./lifecycle-documents/: one module per screen or feature (letter-templates, letter-template, letters,
// process-letters, settlements, exit-settlements, settlement, settlement-views, settlement-preparation, settlement-actions,
// settlement-bulk-upload, settlement-queues), shared.tsx (permission keys, paths, labels, query keys, styles and small pieces),
// types.ts (the API's shapes), refusals.tsx, calculation-basis.ts, and routes.ts. This entry module re-exports what other
// modules import from it.
export { howText } from './lifecycle-documents/calculation-basis';
export { Refusal, type Words } from './lifecycle-documents/refusals';
export { LIFECYCLE_DOCUMENTS_ESS_PANELS, LIFECYCLE_DOCUMENTS_SCREENS, LIFECYCLE_DOCUMENTS_TASK_QUEUES } from './lifecycle-documents/routes';
export { Item, labelOf, LoadProblem, PACK_STATE_LABEL, RATE_BASIS_LABEL, UserRef, when } from './lifecycle-documents/shared';
export type { CalculationItem } from './lifecycle-documents/types';
