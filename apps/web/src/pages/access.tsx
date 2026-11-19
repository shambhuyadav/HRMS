// Access administration (FR-066/FR-067/FR-068; C4; DF02). A role grant is proposed for a user, gives no access
// until an independent approver approves it, and is rejected or revoked with a reason; the record is kept.
// The server authorises every call and decides every rule (role ceilings, confidential eligibility, business
// purpose, administrative scope, self-approval). This screen only hides the actions the selected assignment
// cannot use, shows exactly what the server returned, and never reconstructs anything it did not return.
// Cached answers are keyed by the selected company and assignment, and a refusal hides what an earlier answer
// showed, so one role's view of who holds which access is never shown under another.
export { AccessAdminPage } from './access/page';
