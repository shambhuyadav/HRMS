// The hiring API's refusals in plain words, and how a failed load is shown.
import { ApiError, formatDate, isForbidden, isNotFound } from '../../api';
import { Empty, ErrorNote, NotPermitted, Notice } from '../../ui';
import { CONSENT_LABEL, labelOf } from './shared';

// ---------------------------------------------------------------------------------------------------------
// The API's refusals in plain words (codes of apps/api/src/modules/hiring and the shared error handler)
// ---------------------------------------------------------------------------------------------------------

export type Words = Partial<Record<string, string | ((error: ApiError) => string)>>;

const fieldOf = (error: ApiError) => (error.details as { field?: string } | undefined)?.field;
const scanStateOf = (error: ApiError) => (error.details as { scanState?: string } | undefined)?.scanState;

/** Every action's fallback words; each action adds or replaces its own. Anything else shows as the API sent it. */
const COMMON_WORDS: Words = {
  FORBIDDEN: 'The selected role is not permitted to do this: its duties or its scope do not cover it.',
  NOT_FOUND: 'This record is not available in the selected role’s scope.',
  STALE_VERSION: 'Someone changed this record meanwhile. It has been reloaded: check it and try again.',
  INVALID_REQUEST: 'A value is not in the format this action accepts. Check the entries and try again.',
  REQUISITION_NOT_APPROVED: 'The requisition is not approved (or no longer is), so it takes no new applications, offers or placements.',
  CANDIDATE_NOT_ACTIVE: 'The candidate record is not active: it is inactive or retired as a duplicate.',
  INVALID_STATE: 'This record has moved on and no longer allows this. It has been reloaded.',
  RETRY: 'The change met another change at the same moment. Try again.',
  UNAVAILABLE: 'The service is busy. Try again in a few seconds.',
  SESSION_CHANGED: 'The role or company changed before this was finished; nothing more was sent.',
};

export const VENDOR_WORDS: Words = {
  FORBIDDEN: 'Vendors are company-wide masters: only a company-wide role without department, location or employee filters can add or change them.',
  DUPLICATE: 'A vendor with this code already exists. Choose another code.',
  FIELD_REQUIRED: 'Enter the vendor’s name.',
  INVALID_REQUEST: 'Use a code of letters, digits, - or _ (up to 40 characters) and a name of up to 200 characters.',
};

export const CANDIDATE_WORDS: Words = {
  FORBIDDEN: 'Registering or changing candidates needs a company-wide role without employee filters.',
  VENDOR_MISMATCH: 'Name the recruitment vendor when the candidate came through a vendor, and only then.',
  INVALID_REFERENCE: (e) =>
    fieldOf(e) === 'vendorId' ? 'The vendor is not an active vendor of this company. Choose another vendor.' : 'The source is not an active candidate source of this company.',
  CONSENT_DATE_MISMATCH: 'Give the consent date when consent is given or withdrawn, and no date when consent is not recorded.',
  INVALID_DATE: 'A date is not a valid calendar date, or the consent date is in the future.',
  INVALID_FIELD: 'List at most 50 skills of up to 100 characters each.',
  FIELD_REQUIRED: 'Enter the candidate’s full name.',
  INVALID_STATE: 'A confirmed duplicate stays retired: use the original record instead.',
};

export const CONTACT_WORDS: Words = {
  INVALID_FIELD: (e) =>
    fieldOf(e) === 'phone'
      ? 'The phone number is not valid: use 3 to 15 digits; spaces, dashes, dots, brackets and a leading + are allowed.'
      : 'The email address is not valid.',
  NOT_CONFIGURED: 'Candidate identity matching is not configured on the server yet, so private contacts cannot be recorded.',
  NOT_FOUND: 'This candidate is not available in the selected role’s scope.',
  INVALID_REQUEST: 'An email address has 3 to 254 characters and a phone number 3 to 40.',
};

export const UPLOAD_WORDS: Words = {
  UNSUPPORTED_FILE: 'Only PDF, JPEG and PNG files are accepted.',
  FILE_SIZE: 'Files must be between 1 byte and 10 MB.',
  PAYLOAD_TOO_LARGE: 'The file is larger than 10 MB.',
  INVALID_REFERENCE: 'This document type is not active in this company.',
  INVALID_REQUEST: 'The file name cannot contain / \\ < > : " | ? * or control characters.',
};

export const DOWNLOAD_WORDS: Words = {
  FILE_NOT_RELEASED: (e) =>
    scanStateOf(e) === 'QUARANTINED' ? 'This file was quarantined by the malware scan and can never be opened.' : 'This file has not been released by the malware scan yet.',
};

const consentOf = (error: ApiError) => (error.details as { consentStatus?: string } | undefined)?.consentStatus;

/** FR-013 approved searchable CV content (hiring/cv-text.ts). */
export const CV_TEXT_WORDS: Words = {
  NOT_A_CV: 'Only a CV has searchable text, and this document is not a CV.',
  FILE_NOT_RELEASED: (e) =>
    scanStateOf(e) === 'QUARANTINED'
      ? 'This file was quarantined by the malware scan, so its text can never be approved.'
      : 'This file has not been released by the malware scan yet, so its text cannot be approved.',
  CONSENT_REQUIRED: (e) => {
    const consent = consentOf(e);
    return `${consent ? `The candidate’s consent is ${labelOf(CONSENT_LABEL, consent).toLowerCase()}. ` : ''}Nothing of a candidate becomes searchable until the candidate’s consent is recorded as given.`;
  },
  EXTRACTION_NOT_CONFIGURED: 'No text extraction is configured for this kind of file, so nothing was approved. Type or paste the CV’s text and approve that.',
  NO_TEXT: 'There is no text to approve. Type or paste the CV’s text.',
  TEXT_TOO_LONG: 'Searchable text can be at most 100,000 characters.',
  NO_APPROVED_TEXT: 'This CV has no approved searchable text, so there is nothing to revoke.',
  FIELD_REQUIRED: 'Enter why the searchable text is revoked.',
  FORBIDDEN: 'Approving or revoking searchable CV text needs the candidate document upload grant in a scope covering this candidate.',
  NOT_FOUND: 'This document is not available in the selected role’s scope.',
  INVALID_REQUEST: 'Searchable text can be at most 100,000 characters, and a reason at most 1,000.',
};

export const FLAG_WORDS: Words = {
  RETIRE_CANDIDATE_REQUIRED: 'Choose which of the two records is the duplicate to retire.',
  INVALID_STATE: 'This flag has already been reviewed.',
  FIELD_REQUIRED: 'Enter a note on the review.',
  NOT_FOUND: 'This flag is not available in the selected role’s scope.',
};

export const APPLY_WORDS: Words = {
  ALREADY_APPLIED: 'This candidate already has an application for this requisition.',
  REQUISITION_NOT_APPROVED: 'Candidates apply only to an approved requisition.',
  CANDIDATE_NOT_ACTIVE: 'Only an active candidate record can apply.',
  INVALID_OWNER: 'The owner must hold the application management duty in an active assignment of this company.',
};

export const STAGE_WORDS: Words = {
  INVALID_TRANSITION: 'An application moves one stage forward at a time.',
  HANDOVER_REQUIRED: 'An application becomes hired only through the handover of its accepted offer.',
  NOTE_REQUIRED: 'Record why the application ends.',
  OFFER_OPEN: 'This application has an open offer. Withdraw the offer before ending the application.',
  INVALID_STATE: 'This application has already ended, so its stage and owner no longer change.',
  REQUISITION_NOT_APPROVED: 'The requisition is no longer approved, so the application cannot move forward. It can still be ended.',
  CANDIDATE_NOT_ACTIVE: 'The candidate record is not active, so the application cannot move forward. It can still be ended.',
  INVALID_OWNER: 'The owner must hold the application management duty in an active assignment of this company.',
};

export const OFFER_WORDS: Words = {
  INVALID_STATE: 'The offer or its application has moved on and no longer allows this. It has been reloaded.',
  OFFER_EXISTS: 'This application already has an open offer.',
  COMPENSATION_REQUIRED: 'An eligible Admin must record the compensation before the offer is submitted.',
  NO_ELIGIBLE_REVIEWER:
    'No eligible approver is available: the approver must be an eligible Admin who neither prepared the offer, recorded its compensation nor submits it. Ask HR to update the offer approver list.',
  WORKFLOW_NOT_CONFIGURED: 'No approval route is configured for offers. Ask HR to set one up.',
  NO_OPEN_VACANCY: 'Every vacancy of this requisition already has an accepted offer.',
  CANDIDATE_NOT_ACTIVE: 'The candidate record is not active, so this offer cannot be accepted.',
  CANDIDATE_ALREADY_EMPLOYED: 'This person is already an employee, through this candidate record or one confirmed as its duplicate. The offer can be declined or withdrawn.',
  CANDIDATE_OFFER_ACCEPTED: 'This person already has another accepted offer, on this candidate record or one confirmed as its duplicate. Withdraw that offer first.',
  INVALID_DATE: 'The date is not a valid calendar date; a response date cannot be in the future.',
  ALREADY_HANDED_OVER: 'The offer has already been handed over to onboarding, so it can no longer be withdrawn.',
  FIELD_REQUIRED: 'Enter a reason.',
};

export const COMPENSATION_WORDS: Words = {
  COMPENSATION_REQUIRED: 'Give the annual CTC, the monthly gross or both.',
  INVALID_AMOUNT: 'Amounts are non-negative decimals with up to 4 decimal places.',
  INVALID_STATE: 'The compensation changes only while the offer is a draft.',
  INVALID_REQUEST: 'Use a three-letter currency code and amounts with up to 15 digits and 4 decimal places.',
};

export const DECISION_WORDS: Words = {
  REASON_REQUIRED: 'Record why the offer is returned or rejected.',
  TASK_CLOSED: 'This approval has already been decided.',
  INVALID_STATE: 'This offer is no longer waiting for a decision.',
  REQUISITION_NOT_APPROVED: 'The requisition is no longer approved: return or reject the offer instead.',
  IDEMPOTENCY_KEY_REUSED: 'Nothing was recorded: this attempt was matched to a different decision. Send your decision again.',
  NOT_FOUND: 'This approval is not yours, or it is no longer in the selected role’s scope.',
};

export const HANDOVER_WORDS: Words = {
  ALREADY_HANDED_OVER: 'This accepted offer has already created an employee: an offer is handed over once only.',
  OFFER_NOT_ACCEPTED: 'Only an accepted offer is handed over to onboarding.',
  CANDIDATE_NOT_ACTIVE: 'The candidate record is not active (for example, it was retired as a duplicate), so it cannot become an employee. Withdraw this offer and use the original record.',
  CANDIDATE_ALREADY_EMPLOYED: 'This person is already an employee, through this candidate record or one confirmed as its duplicate. Withdraw this offer.',
  CANDIDATE_OFFER_ACCEPTED: 'This person has another accepted offer, on this candidate record or one confirmed as its duplicate. Withdraw one of the two before handing over.',
  REQUISITION_NOT_APPROVED: 'Only an approved requisition accepts final placement.',
  INVALID_STATE: 'The application is no longer at the offer stage.',
  INVALID_DOCUMENT: 'Only this candidate’s own documents can be transferred.',
  FILE_NOT_RELEASED: 'A chosen document has not been released by the malware scan, so it cannot be transferred.',
  DUPLICATE: 'Another employee already has this employee code or work email.',
  INVALID_REFERENCE: 'A value cannot be used: an organisation master of the requisition is no longer active, or an employee document type is unknown.',
  FORBIDDEN:
    'The selected role cannot create this employee: it needs the employee creation duty in a company-wide scope covering the requisition’s department and location, and the document grants to transfer documents.',
  INVALID_REQUEST: 'Use an employee code of letters, digits, - or _ (up to 40 characters) and a valid work email address.',
};

/** Offer letter preview and final output (hiring/offer-letter.ts; lifecycle/letters.ts publishedTemplate). */
export const LETTER_ISSUE_WORDS: Words = {
  OFFER_NOT_APPROVED: 'Only an approved or accepted offer issues an offer letter, and this offer is not approved or accepted (any more). It has been reloaded.',
  NOT_AN_OFFER_TEMPLATE: 'This template is not an offer letter template: an offer letter uses a template of the offer letter type.',
  TEMPLATE_INACTIVE: 'This letter template is inactive, so it cannot be used. Choose another template, or ask HR to activate it.',
  TEMPLATE_NOT_PUBLISHED: 'This letter template has no published revision yet, so it cannot be used.',
  INVALID_REFERENCE: 'No letter template has this code.',
  IDEMPOTENCY_KEY_REUSED: 'Nothing was generated: this attempt was matched to a different letter. Generate it again.',
  FORBIDDEN: 'The selected role cannot issue offer letters: that needs the offer letter grant in a scope covering this requisition.',
  NOT_FOUND: 'This offer is not available in the selected role’s scope.',
  INVALID_REQUEST: 'Enter a template code: a capital letter followed by capital letters, digits or _ (up to 40 characters).',
};

const generatedOnOf = (error: ApiError) => (error.details as { generatedOn?: string } | undefined)?.generatedOn;

/** Recording that a letter was handed to the candidate outside the system (FR-018; DF09). */
export const DELIVERY_WORDS: Words = {
  RECIPIENT_NOT_CONFIRMED: 'Confirm that the letter went to the offer’s candidate.',
  INVALID_DATE: (e) => {
    const generatedOn = generatedOnOf(e);
    return generatedOn
      ? `The delivery date cannot be before the letter was generated (${formatDate(generatedOn)}).`
      : 'The delivery date must be a valid date that is not in the future and not before the letter was generated.';
  },
  ALREADY_DELIVERED: 'This letter’s delivery is already recorded, and a recorded delivery is final. The letters have been reloaded.',
  LETTER_SUPERSEDED: 'This letter carries an earlier revision of the offer, so it cannot be recorded as delivered. Generate a new letter from the current revision.',
  OFFER_NOT_APPROVED: 'The offer is no longer approved or accepted, so its letter cannot be recorded as delivered.',
  INVALID_REFERENCE: 'This delivery method is not an active delivery method of this company. Choose another.',
  FORBIDDEN: 'The selected role cannot record offer letter deliveries: that needs the offer letter grant in a scope covering this requisition.',
  NOT_FOUND: 'This letter is not available in the selected role’s scope.',
  INVALID_REQUEST: 'Choose a delivery method and enter the delivery date.',
};

export const LETTER_DOWNLOAD_WORDS: Words = {
  NOT_FOUND: 'This letter is not available in the selected role’s scope.',
  FORBIDDEN: 'The selected role cannot open offer letters: that needs the grant that reads the offer compensation.',
};

export function refusalText(error: unknown, words: Words = {}): string | null {
  if (!(error instanceof ApiError)) return null;
  const entry = words[error.code] ?? COMMON_WORDS[error.code];
  if (entry === undefined) return null;
  return typeof entry === 'function' ? entry(error) : entry;
}

/** A failed action: the API's refusal in plain words, anything else as the API sent it. */
export function Refusal({ error, words }: { error: unknown; words?: Words }) {
  if (!error) return null;
  const text = refusalText(error, words);
  return text === null ? <ErrorNote error={error} /> : <Notice notice={{ text, ok: false }} />;
}

/** A list or record that did not load: a refusal of the role, a record outside its scope, or the API's error. */
export function LoadProblem({ error, forbidden, missing }: { error: unknown; forbidden: string; missing?: string }) {
  if (!error) return null;
  if (isForbidden(error)) return <NotPermitted>{forbidden}</NotPermitted>;
  if (missing !== undefined && isNotFound(error)) return <Empty>{missing}</Empty>;
  return <ErrorNote error={error} />;
}

