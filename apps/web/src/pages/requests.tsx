// Outdoor duty and work on holiday (FR-027, I-05..I-07): own requests, and the HR views within the selected scope.
// Supporting evidence (FR-027 with FR-106, I-22): the requester's own documents, never a quarantined or rejected one.
//
// The code is in ./requests/: the own requests page and its follow-ups (own-requests), the HR register (register), the time a
// request covers (window), supporting evidence (evidence), raising a rejected request again (raise-again) and shared.tsx (the
// request's shape, the role context, the own-record scope and a layout piece). This entry module re-exports what other modules
// import from it: the leave, expense, asset, profile and attendance screens, the decision inbox and the Home charts.
export { EvidenceChoice, EvidenceError, EvidenceList, type Evidence, WorkTaskEvidence } from './requests/evidence';
export { WorkRequestsPage } from './requests/own-requests';
export { canRaiseAgain, followedRequests, RaiseAgainNote, RaisedAgainHint } from './requests/raise-again';
export { KIND_LABEL, ownRecordInScope, ownRecordNotFound } from './requests/shared';
export { describeWindow } from './requests/window';
