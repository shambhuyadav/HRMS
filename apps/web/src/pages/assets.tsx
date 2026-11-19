// Assets: register, custody and custody requests (FR-110 assets part; H3 TN16; decision I-31; DF02; DF03; DF04; C4).
//
// A minimal custody register: no valuation, depreciation, cost, transfer or write-off. Items are IN_STOCK, ISSUED,
// RETURNED_TO_STOCK or RETIRED (final, never deleted). The register, issue, return and retirement are Admin duties of an
// unrestricted company-scope assignment, never recorded on one's own items; the server refuses anything else and these
// screens say so in plain words. An item is issued only from stock to an active employee and returned from ISSUED
// whatever the employee's status; dates are never in the future or before the last return; the history is append-only.
// Custody requests are submitted by the employee in the Employee OWN context (My ESS TN16: item or category with a
// reason) and decided by an independent eligible Admin: approve, or reject with a note the employee never sees.
// Approval issues nothing: issuing stays the separate custody action on the item, which may name the approved request.
// The employee reads their own items and history, acknowledges receipt once per issue and never issues, returns,
// retires, transfers or writes off anything. The server authorises every call and decides every rule; these screens
// hide what the selected assignment cannot use and render only what the API returned.
export { ASSETS_ESS_PANELS, ASSETS_SCREENS, ASSETS_TASK_QUEUES } from './assets/routes';
