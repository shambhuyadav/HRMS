// Training: plans, participants and feedback (FR-049, FR-050; F1 "Training"; H3 TN17; decision I-26; DF02; DF04; DF09).
//
// Plans are company records kept by a coordinator or HR Administrator in an unrestricted company-scope assignment: title,
// dates, mode and venue, trainer, capacity, cost (company spend, its own field group: shown only when the API returns it,
// zero distinct from no cost) and owner. The FUTURE / CURRENT / PAST view is worked out by the server from the company's
// business date, CANCELLED overriding it; these screens show the view exactly as returned. A cancellation records a reason.
// Participants are nominated (never twice for one session), confirmed within capacity (the server refuses a full plan),
// marked attended or no-show from the start date and completed from the end date, or cancelled with a reason, only by the
// coordinator role the API allows and never on one's own participation. No approval workflow exists, so the module has
// no decision queue. The feedback summary reconciles to the participants and shows missing responses distinctly; scores
// are counts only (no averages); comments and participation reasons are confidential and rendered only when returned.
// My ESS TN17 (Employee OWN context): own participations, self-nomination where a plan allows it, withdrawal of an own
// unconfirmed self-nomination, and own feedback (a score 1 to 5 per question, an optional confidential comment) only
// after completion. The employee never marks attendance or completion. The server authorises every call and decides
// every rule; these screens hide what the selected assignment cannot use and render only what the API returned.
export { TRAINING_ESS_PANELS, TRAINING_SCREENS, TRAINING_TASK_QUEUES } from './training/routes';
