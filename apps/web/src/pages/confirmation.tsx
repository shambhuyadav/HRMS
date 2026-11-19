// Confirmation management (FR-080/FR-081/FR-082; BR-029/BR-030; DF11; DF02).
// HR opens a case for an employee on probation; the planned due date comes from the policy that applies on the start
// date. The employee's direct manager recommends confirming (with an effective date) or extending (by months); an
// independent HR reviewer decides in the Decision inbox (/tasks), never on this screen. Upcoming, due and overdue are
// views the server derives from the company business date: a due date passing never changes a case (BR-030).
// DF11 exceptions (I-19): HR proposes a due date override or an extra extension (one beyond the policy limit) with a
// private reason; a different eligible HR user approves or rejects it with a reason under Pending exceptions; neither
// the proposer nor the employee concerned decides it, and the proposer may withdraw it while it waits.
// The server authorises every call and decides every rule; this screen only hides what the selected assignment cannot
// use. Decision and exception reasons are confidential (DF02/DF11): they are shown only when the server returned them,
// and nothing here hints that a withheld reason exists.
// HR cancels a live review with a reason (FR-082, DF11); an approved exit or a separation closes it the same way.
// Confirmation policies (FR-080, BR-029, DF11) are their own screen, /confirmations/policies: every dated revision of
// every policy, a new policy, a new revision, and ending a policy; the server refuses overlaps and what a case in use
// forbids, and the screen shows its words.
//
// The code is in ./confirmation/: the confirmations page and its register (cases), one case (case-panel, case-exceptions),
// the exception decision queue (pending-exceptions), the attention list and a new case (attention), the policies screen
// (policies), shared.tsx (permission keys, limits, the API's shapes, query keys, styles and helpers), refusals.tsx, and
// routes.ts. This entry module re-exports what other modules import from it.
export { ConfirmationsPage } from './confirmation/cases';
export { ConfirmationPoliciesPage } from './confirmation/policies';
export { CONFIRMATION_SCREENS } from './confirmation/routes';
