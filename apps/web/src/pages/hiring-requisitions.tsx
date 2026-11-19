// Hiring part 1: manpower budgets and requisitions (FR-011, FR-012 approval; F1 "Hiring"; DF02; DF03; DF08; C4).
//
// Manpower budgets (FR-011): an approved headcount per department, location, designation and inclusive period. Every
// change is a revision that its preparer saves as a draft, submits or withdraws; an independent HR Administrator approves
// or rejects it in the budget queue (whoever prepared or submitted it never decides it). The latest approved revision is
// the headcount in force; a rejected revision is final and a new revision follows.
// Requisitions (FR-011, FR-012, F1): the requester's own draft with the FR-011 fields. Submission pins a revision with
// its budget check and starts the F1 route: validation by the requester's direct manager (HR fallback list when the
// manager cannot), then budget and headcount approval by an independent HR Administrator. Either step approves, returns
// for changes (back to the draft, the decision and reason kept) or rejects (final, with approver, time and reason). A
// requisition beyond its budget, or with none, needs a recorded exception reason to be submitted, and the HR approver
// approves the exception explicitly. A copy gets a new reference and inherits no approval; a draft is discarded (kept as
// closed), never deleted; HR closes an approved requisition.
// The server authorises every call and decides every rule; these screens hide what the selected assignment cannot use,
// show only what the server returned and say its refusals in plain words. Hiring has no My ESS tab (H3).
//
// The code is in ./hiring-requisitions/: one module per screen or feature (requisitions, requisition, requisition-queues,
// budgets, budget, budget-queue), the pieces they share (lookups, requisition-form, requisition-views), shared.ts (permission
// keys, paths, the API shapes and helpers), refusals.tsx, and routes.ts, which this entry module re-exports.
export { HIRING_REQUISITIONS_ESS_PANELS, HIRING_REQUISITIONS_SCREENS, HIRING_REQUISITIONS_TASK_QUEUES } from './hiring-requisitions/routes';
