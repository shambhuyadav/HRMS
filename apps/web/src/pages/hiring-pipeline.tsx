// Hiring pipeline (FR-012 to FR-014; F1 "Hiring"; OQ-04 minimum form contracts; DF02; FR-057; FR-106).
//
// The recruitment pipeline after an approved requisition: recruitment vendors (company-wide masters, deactivated, never
// deleted), the candidate register with source/vendor and consent/retention status, likely duplicates flagged from the
// private contacts for a person to review (never merged), CV search, applications per requisition (one per candidate
// and requisition; stages move one at a time; ending one application never touches the candidate's others), offers
// on an approved requisition with their independent approval, the tracker (vacancies, candidates, stage, owner,
// pending action, ageing), and the handover of an accepted offer to a reviewed employee DRAFT, at most once, with the
// employee's hiring origin. The employee is never activated here.
//
// Confidential groups (F1, DF02) belong to eligible scoped Admin assignments: private contacts (candidate.contact), CV
// and other candidate documents (candidate.document) and the offer compensation (offer.compensation). They are shown
// only when the server returned them, and the private contact is read only when asked for, because every read of it
// is audited (FR-057). Uploads wait for the malware scan; only released files are offered for download (FR-106).
// Searchable CV content (FR-013; decided under owner delegation, 6 Nov 2026, I-82 item 4): nothing is searchable on upload.
// An eligible Admin with the document upload grant approves the text of a released CV of a candidate whose consent is
// given; no text extraction is configured, so the Admin types or pastes it. The approved text is read only when asked for
// (each read is audited); the CV search matches approved text and marks such a hit, never showing the text.
// Offer letters (FR-014, FR-017, FR-018, DF09; I-82 item 1): an eligible HR Administrator previews and generates the
// letter from a published OFFER template and the approved or accepted offer, before the candidate is an employee. The
// system never sends it: the issuer downloads it here, hands it to the candidate outside the system and records the
// delivery method, date and that the recipient is the offer's candidate.
// Money is shown as the API's decimal strings through formatAmount; nothing here adds, rounds or derives an amount.
// The server authorises every call and decides every rule: this screen only hides what the selected assignment cannot
// use, explains the API's refusals in plain words, and reloads after every change (no optimistic updates).
//
// The code is in ./hiring-pipeline/: one module per screen or feature (tracker, vendors, candidates, candidate, duplicates,
// candidate-documents, cv-search, requisition-applications, application, offers, offer-letters, handover, offer-approvals),
// shared.tsx (permission keys, constants, codes in words, query keys, styles and small pieces), types.ts (the API's shapes),
// refusals.tsx, and routes.ts, which this entry module re-exports.
export { HIRING_PIPELINE_ESS_PANELS, HIRING_PIPELINE_SCREENS, HIRING_PIPELINE_TASK_QUEUES } from './hiring-pipeline/routes';
