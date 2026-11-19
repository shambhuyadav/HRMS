// Company policy documents and bulk document mapping (FR-010; DF02; DF09; FR-106; FR-057; BR-043; decision I-38).
//
// Company policies: a policy is a company record with a permanent code, a title, a classification and numbered
// versions, each its own scanned file with an optional expiry. Every role of the company reads OPERATIONAL policies; a
// CONFIDENTIAL one, its title included, exists only for holders of the confidential group, so these screens show
// exactly what the API lists and never hint that anything was left out. Only a version the malware scan released is
// served; versions are immutable (an expiry belongs to its version) and nothing is deleted. Publishing a policy or a
// version and changing a title or classification need the manage duty in an unrestricted company-scope assignment; a
// confidential classification needs the confidential manage group as well. There is no ESS tab for policies (H3
// lists none), so employees read them on the Company policies screen.
// Bulk document mapping: the user stages employee documents (each scanned), then uploads a DOCUMENT_MAPPING_V1 file
// (fileName, employeeCode, documentType, expiresOn) on the shared batch framework: a row-by-row preview, then an
// explicit commit or cancel, all or nothing. An unknown employee code is reported on its row and nothing is assigned.
// A staged file not mapped yet can be discarded by its uploader: it stays on record as discarded (DF08: nothing is
// deleted), is never mapped and frees its file name. The user's staged files are listed a page at a time with the
// total, per state. The user's own mapping batches are listed, so a batch held for the
// malware scan can be opened again, checked again (resumed from its stored file) and then committed or cancelled.
// Staging needs the confidential document upload grant; the mapping file also needs the import duty.
// The server authorises every call and decides every rule; these screens only hide what the selected assignment cannot
// use and render only what the API returned.
//
// The code is in ./documents/: one module per screen (policies, manage-policies, bulk-mapping, mandatory-documents,
// document-export), shared.ts (permission keys, paths and the API's shapes), refusals.tsx, shared-views.tsx (classification,
// scan state, expiry, version history), and routes.ts, which this entry module re-exports.
export { DOCUMENTS_ESS_PANELS, DOCUMENTS_SCREENS, DOCUMENTS_TASK_QUEUES } from './documents/routes';
