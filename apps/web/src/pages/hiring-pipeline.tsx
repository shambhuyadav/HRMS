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
// Money is shown as the API's decimal strings through formatAmount; nothing here adds, rounds or derives an amount.
// The server authorises every call and decides every rule: this screen only hides what the selected assignment cannot
// use, explains the API's refusals in plain words, and reloads after every change (no optimistic updates).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentType, type CSSProperties, type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, download, fileToBase64, formatAmount, formatDate, idempotencyKey, localDate } from '../api';
import type { EssPanel, ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Section } from '../ui';
import { DelegatedBadge } from './delegations';

// ---------------------------------------------------------------------------------------------------------
// Permission keys the API checks (apps/api/src/modules/hiring/pipeline-routes.ts requireAccess; 0034_hiring.sql)
// ---------------------------------------------------------------------------------------------------------

/** Vendors, the candidate register, one candidate and the duplicate flags. */
const CANDIDATE_READ = 'candidate.read.operational';
/** Adding and changing vendors and candidates; reviewing duplicate flags. */
const CANDIDATE_MANAGE = 'candidate.manage.operational';
/** Confidential (F1): an eligible scoped Admin reads and records private contacts. */
const CONTACT_READ = 'candidate.read.contact';
const CONTACT_MANAGE = 'candidate.manage.contact';
/** Confidential (F1): CVs and other candidate documents. */
const DOCUMENT_READ = 'candidate.read.document';
const DOCUMENT_UPLOAD = 'candidate.upload.document';
/** Applications, the tracker and an employee's hiring origin. */
const APPLICATION_READ = 'application.read.operational';
/** New applications, stage moves and owners. */
const APPLICATION_MANAGE = 'application.manage.operational';
const OFFER_READ = 'offer.read.operational';
/** Preparing, changing, submitting and withdrawing an offer; recording the candidate's response. */
const OFFER_MANAGE = 'offer.manage.operational';
/** Confidential (F1): the offer compensation, its recording and its independent approval. */
const COMPENSATION_READ = 'offer.read.compensation';
const COMPENSATION_MANAGE = 'offer.manage.compensation';
const COMPENSATION_APPROVE = 'offer.approve.compensation';
/** The handover needs both the hiring handover duty and the ordinary employee creation duty. */
const HANDOVER = 'hiring.handover.operational';
const EMPLOYEE_CREATE = 'employee.create.operational';
/** Transferring candidate documents also needs the employee document upload grant. */
const EMPLOYEE_DOCUMENT_UPLOAD = 'document.upload.document';
const EMPLOYEE_DOCUMENT_READ = 'document.read.document';
const EMPLOYEE_READ = 'employee.read.operational';
const REQUISITION_READ = 'requisition.read.operational';

/** The screens of this file, which link to each other by these paths. */
const PATHS = {
  tracker: '/hiring/tracker',
  candidates: '/hiring/candidates',
  candidate: (id: string) => `/hiring/candidates/${id}`,
  duplicates: '/hiring/duplicates',
  cvSearch: '/hiring/cv-search',
  vendors: '/hiring/vendors',
  requisitionApplications: (id: string) => `/hiring/requisitions/${id}/applications`,
  /** hiring-requisitions.tsx (hiring part 1): the requisition itself. */
  requisition: (id: string) => `/hiring/requisitions/${id}`,
  application: (id: string) => `/hiring/applications/${id}`,
  offers: '/hiring/offers',
  offer: (id: string) => `/hiring/offers/${id}`,
  origin: (employeeId: string) => `/hiring/employees/${employeeId}/origin`,
  /** records.tsx: the employee's documents, where transferred candidate documents arrive. */
  employeeDocuments: (employeeId: string) => `/employees/${employeeId}/documents`,
} as const;

/** GET /v1/hiring/candidates and /v1/hiring/requisitions accept page sizes of 25, 50 or 100 only. */
const PAGE_SIZE = 25;
/** The upload route accepts PDF, JPEG and PNG files up to 10 MB (storage/files.ts). */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** The formats PUT /v1/hiring/offers/:id/compensation accepts; only the format is checked here. */
const MONEY = /^\d{1,15}(\.\d{1,4})?$/;
const CURRENCY = /^[A-Z]{3}$/;
/** An employee document type code, and the most documents one handover transfers, as the handover route accepts them. */
const DOCUMENT_TYPE_CODE = /^[A-Z][A-Z0-9_]{0,59}$/;
const MAX_HANDOVER_DOCUMENTS = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Row limits of the API's lists. */
const LIMITS = { trackerVacancies: 500, trackerApplications: 2000, offers: 500, flags: 500, cvSearch: 200, applications: 1000 } as const;

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------------------------------------
// Codes in words
// ---------------------------------------------------------------------------------------------------------

const STAGE_ORDER: readonly string[] = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'];
const STAGE_LABEL: Record<string, string> = {
  APPLIED: 'Applied',
  SCREENING: 'Screening',
  INTERVIEW: 'Interview',
  OFFER: 'Offer',
  HIRED: 'Hired',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};
const OPEN_STAGES: readonly string[] = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'];
/** Stages move forward one at a time (application.ts); HIRED is reached only through the handover. */
const NEXT_STAGE: Record<string, string> = { APPLIED: 'SCREENING', SCREENING: 'INTERVIEW', INTERVIEW: 'OFFER' };

/** The next thing an open application waits for (application.ts PENDING_ACTION_SQL). */
const PENDING_ACTION_LABEL: Record<string, string> = {
  START_SCREENING: 'Start screening',
  COMPLETE_SCREENING: 'Complete screening',
  COMPLETE_INTERVIEW: 'Complete the interview',
  PREPARE_OFFER: 'Prepare an offer',
  COMPLETE_OFFER: 'Complete and submit the offer',
  OFFER_APPROVAL: 'Offer approval by an independent Admin',
  CANDIDATE_RESPONSE: 'The candidate’s response to the offer',
  HANDOVER: 'Hand over to onboarding',
  DECIDE_APPLICATION: 'Prepare a new offer or end the application',
};

const OFFER_STATE_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Waiting for approval',
  APPROVED: 'Approved',
  ACCEPTED: 'Accepted',
  DECLINED: 'Declined',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};
/** An offer in one of these states keeps its application from a new offer or from ending. */
const OPEN_OFFER_STATES: readonly string[] = ['DRAFT', 'SUBMITTED', 'APPROVED', 'ACCEPTED'];
const OFFER_STATES: readonly string[] = ['DRAFT', 'SUBMITTED', 'APPROVED', 'ACCEPTED', 'DECLINED', 'REJECTED', 'WITHDRAWN'];

const REQUISITION_STATE_LABEL: Record<string, string> = { DRAFT: 'Draft', SUBMITTED: 'Submitted', APPROVED: 'Approved', REJECTED: 'Rejected', CLOSED: 'Closed' };
const CANDIDATE_STATE_LABEL: Record<string, string> = { ACTIVE: 'Active', INACTIVE: 'Inactive', DUPLICATE: 'Retired duplicate' };
const CONSENT_LABEL: Record<string, string> = { NOT_RECORDED: 'Not recorded', GIVEN: 'Given', WITHDRAWN: 'Withdrawn' };
const CONSENTS: readonly string[] = ['NOT_RECORDED', 'GIVEN', 'WITHDRAWN'];
const FLAG_STATE_LABEL: Record<string, string> = { OPEN: 'Waiting for review', NOT_DUPLICATE: 'Not a duplicate', CONFIRMED_DUPLICATE: 'Confirmed duplicate' };
const BASIS_LABEL: Record<string, string> = { EMAIL: 'Same private email address', PHONE: 'Same private phone number' };
const DECISION_LABEL: Record<string, string> = { APPROVE: 'Approved', REJECT: 'Rejected', RETURN: 'Returned for changes' };
const EMPLOYEE_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  ACTIVE_PROBATION: 'Active (probation)',
  ACTIVE_CONFIRMED: 'Active (confirmed)',
  NOTICE: 'Notice',
  INACTIVE_SEPARATED: 'Separated',
  ARCHIVED: 'Archived',
};
const SCAN_LABEL: Record<string, string> = { CLEAN: 'released', PENDING_SCAN: 'waiting for the malware scan', QUARANTINED: 'quarantined by the malware scan' };

/**
 * The seeded reference values of the module registration (CANDIDATE_SOURCE, CANDIDATE_DOCUMENT_TYPE). No API route
 * lists a company's active reference values, so these are offered; the server refuses an inactive one.
 */
const SOURCES: readonly { code: string; label: string }[] = [
  { code: 'DIRECT', label: 'Direct application' },
  { code: 'VENDOR', label: 'Recruitment vendor' },
];
const CANDIDATE_DOCUMENT_TYPES: readonly { code: string; label: string }[] = [
  { code: 'CV', label: 'Curriculum vitae' },
  { code: 'OTHER', label: 'Other candidate document' },
];
const DOCUMENT_TYPE_LABEL: Record<string, string> = Object.fromEntries(CANDIDATE_DOCUMENT_TYPES.map((t) => [t.code, t.label]));
/** The neutral employee document type seeded for every company (access/baseline.ts DOCUMENT_TYPE). */
const DEFAULT_EMPLOYEE_DOCUMENT_TYPE = 'GENERAL';

function readable(code: string): string {
  const text = code.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
const labelOf = (labels: Record<string, string>, code: string | null | undefined) => (code ? (labels[code] ?? readable(code)) : '—');

type Tone = 'neutral' | 'good' | 'warn' | 'bad';
const STAGE_TONE: Record<string, Tone> = { HIRED: 'good', REJECTED: 'bad' };
const OFFER_TONE: Record<string, Tone> = { SUBMITTED: 'warn', APPROVED: 'good', ACCEPTED: 'good', DECLINED: 'warn', REJECTED: 'bad' };
const REQUISITION_TONE: Record<string, Tone> = { SUBMITTED: 'warn', APPROVED: 'good', REJECTED: 'bad' };
const CANDIDATE_TONE: Record<string, Tone> = { ACTIVE: 'good', DUPLICATE: 'warn' };
const FLAG_TONE: Record<string, Tone> = { OPEN: 'warn', CONFIRMED_DUPLICATE: 'bad' };
const EMPLOYEE_TONE: Record<string, Tone> = { DRAFT: 'warn', ACTIVE_PROBATION: 'good', ACTIVE_CONFIRMED: 'good' };

/** Status is always text; the tone is a secondary cue only (DF10). */
function CodeBadge({ code, labels, tones }: { code: string | null | undefined; labels: Record<string, string>; tones: Record<string, Tone> }) {
  return <Badge tone={(code ? tones[code] : undefined) ?? 'neutral'}>{labelOf(labels, code)}</Badge>;
}
const StageBadge = ({ stage }: { stage: string }) => <CodeBadge code={stage} labels={STAGE_LABEL} tones={STAGE_TONE} />;
const OfferStateBadge = ({ state }: { state: string }) => <CodeBadge code={state} labels={OFFER_STATE_LABEL} tones={OFFER_TONE} />;
const RequisitionStateBadge = ({ state }: { state: string }) => <CodeBadge code={state} labels={REQUISITION_STATE_LABEL} tones={REQUISITION_TONE} />;
const CandidateStateBadge = ({ state }: { state: string }) => <CodeBadge code={state} labels={CANDIDATE_STATE_LABEL} tones={CANDIDATE_TONE} />;
const FlagStateBadge = ({ state }: { state: string }) => <CodeBadge code={state} labels={FLAG_STATE_LABEL} tones={FLAG_TONE} />;

/** FR-106: only a file the malware scanner released (CLEAN) is ever served. */
function ScanBadge({ state }: { state: string | null }) {
  const tone: Tone = state === 'CLEAN' ? 'good' : state === 'QUARANTINED' ? 'bad' : 'warn';
  return <Badge tone={tone}>{state ? (SCAN_LABEL[state] ?? readable(state).toLowerCase()) : 'not scanned yet'}</Badge>;
}

// ---------------------------------------------------------------------------------------------------------
// The API's refusals in plain words (codes of apps/api/src/modules/hiring and the shared error handler)
// ---------------------------------------------------------------------------------------------------------

type Words = Partial<Record<string, string | ((error: ApiError) => string)>>;

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

const VENDOR_WORDS: Words = {
  FORBIDDEN: 'Vendors are company-wide masters: only a company-wide role without department, location or employee filters can add or change them.',
  DUPLICATE: 'A vendor with this code already exists. Choose another code.',
  FIELD_REQUIRED: 'Enter the vendor’s name.',
  INVALID_REQUEST: 'Use a code of letters, digits, - or _ (up to 40 characters) and a name of up to 200 characters.',
};

const CANDIDATE_WORDS: Words = {
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

const CONTACT_WORDS: Words = {
  INVALID_FIELD: (e) =>
    fieldOf(e) === 'phone'
      ? 'The phone number is not valid: use 3 to 15 digits; spaces, dashes, dots, brackets and a leading + are allowed.'
      : 'The email address is not valid.',
  NOT_CONFIGURED: 'Candidate identity matching is not configured on the server yet, so private contacts cannot be recorded.',
  NOT_FOUND: 'This candidate is not available in the selected role’s scope.',
  INVALID_REQUEST: 'An email address has 3 to 254 characters and a phone number 3 to 40.',
};

const UPLOAD_WORDS: Words = {
  UNSUPPORTED_FILE: 'Only PDF, JPEG and PNG files are accepted.',
  FILE_SIZE: 'Files must be between 1 byte and 10 MB.',
  PAYLOAD_TOO_LARGE: 'The file is larger than 10 MB.',
  INVALID_REFERENCE: 'This document type is not active in this company.',
  INVALID_REQUEST: 'The file name cannot contain / \\ < > : " | ? * or control characters.',
};

const DOWNLOAD_WORDS: Words = {
  FILE_NOT_RELEASED: (e) =>
    scanStateOf(e) === 'QUARANTINED' ? 'This file was quarantined by the malware scan and can never be opened.' : 'This file has not been released by the malware scan yet.',
};

const FLAG_WORDS: Words = {
  RETIRE_CANDIDATE_REQUIRED: 'Choose which of the two records is the duplicate to retire.',
  INVALID_STATE: 'This flag has already been reviewed.',
  FIELD_REQUIRED: 'Enter a note on the review.',
  NOT_FOUND: 'This flag is not available in the selected role’s scope.',
};

const APPLY_WORDS: Words = {
  ALREADY_APPLIED: 'This candidate already has an application for this requisition.',
  REQUISITION_NOT_APPROVED: 'Candidates apply only to an approved requisition.',
  CANDIDATE_NOT_ACTIVE: 'Only an active candidate record can apply.',
  INVALID_OWNER: 'The owner must hold the application management duty in an active assignment of this company.',
};

const STAGE_WORDS: Words = {
  INVALID_TRANSITION: 'An application moves one stage forward at a time.',
  HANDOVER_REQUIRED: 'An application becomes hired only through the handover of its accepted offer.',
  NOTE_REQUIRED: 'Record why the application ends.',
  OFFER_OPEN: 'This application has an open offer. Withdraw the offer before ending the application.',
  INVALID_STATE: 'This application has already ended, so its stage and owner no longer change.',
  REQUISITION_NOT_APPROVED: 'The requisition is no longer approved, so the application cannot move forward. It can still be ended.',
  CANDIDATE_NOT_ACTIVE: 'The candidate record is not active, so the application cannot move forward. It can still be ended.',
  INVALID_OWNER: 'The owner must hold the application management duty in an active assignment of this company.',
};

const OFFER_WORDS: Words = {
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

const COMPENSATION_WORDS: Words = {
  COMPENSATION_REQUIRED: 'Give the annual CTC, the monthly gross or both.',
  INVALID_AMOUNT: 'Amounts are non-negative decimals with up to 4 decimal places.',
  INVALID_STATE: 'The compensation changes only while the offer is a draft.',
  INVALID_REQUEST: 'Use a three-letter currency code and amounts with up to 15 digits and 4 decimal places.',
};

const DECISION_WORDS: Words = {
  REASON_REQUIRED: 'Record why the offer is returned or rejected.',
  TASK_CLOSED: 'This approval has already been decided.',
  INVALID_STATE: 'This offer is no longer waiting for a decision.',
  REQUISITION_NOT_APPROVED: 'The requisition is no longer approved: return or reject the offer instead.',
  IDEMPOTENCY_KEY_REUSED: 'Nothing was recorded: this attempt was matched to a different decision. Send your decision again.',
  NOT_FOUND: 'This approval is not yours, or it is no longer in the selected role’s scope.',
};

const HANDOVER_WORDS: Words = {
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

function refusalText(error: unknown, words: Words = {}): string | null {
  if (!(error instanceof ApiError)) return null;
  const entry = words[error.code] ?? COMMON_WORDS[error.code];
  if (entry === undefined) return null;
  return typeof entry === 'function' ? entry(error) : entry;
}

/** A failed action: the API's refusal in plain words, anything else as the API sent it. */
function Refusal({ error, words }: { error: unknown; words?: Words }) {
  if (!error) return null;
  const text = refusalText(error, words);
  return text === null ? (
    <ErrorNote error={error} />
  ) : (
    <p role="alert" className="error">
      {text}
    </p>
  );
}

const isForbidden = (error: unknown) => error instanceof ApiError && error.status === 403;
const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;
const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409;
/** A refusal or bad request will not change on retry; only transient failures are retried (once). */
const retryTransient = (failureCount: number, error: Error) => !(error instanceof ApiError && error.status < 500) && failureCount < 1;

/** A list or record that did not load: a refusal of the role, a record outside its scope, or the API's error. */
function LoadProblem({ error, forbidden, missing }: { error: unknown; forbidden: string; missing?: string }) {
  if (!error) return null;
  if (isForbidden(error)) return <NotPermitted>{forbidden}</NotPermitted>;
  if (missing !== undefined && isNotFound(error)) return <Empty>{missing}</Empty>;
  return <ErrorNote error={error} />;
}

// ---------------------------------------------------------------------------------------------------------
// The API's shapes (apps/api/src/modules/hiring: candidate.ts, application.ts, offer.ts, handover.ts, requisition.ts)
// ---------------------------------------------------------------------------------------------------------

interface Vendor {
  id: string;
  code: string;
  name: string;
  active: boolean;
  version: number;
}

interface CandidateSummary {
  id: string;
  candidateCode: string;
  fullName: string;
  source: { code: string; label: string };
  vendor: { id: string; code: string; name: string } | null;
  skills: string[];
  consentStatus: string;
  consentRecordedOn: string | null;
  retainUntil: string | null;
  state: string;
  createdAt: string;
  version: number;
}

interface CandidatePage {
  items: CandidateSummary[];
  total: number;
  page: number;
  pageSize: number;
}

interface CandidateRef {
  id: string;
  candidateCode: string;
  fullName: string;
  state: string;
}

interface DuplicateFlag {
  flagId: string;
  basis: string;
  state: string;
  flaggedAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  retiredCandidateId: string | null;
  candidate: CandidateRef;
  matchedCandidate: CandidateRef;
}

interface CandidateApplication {
  applicationId: string;
  requisitionId: string;
  requisitionCode: string;
  title: string;
  stage: string;
  stageEnteredAt: string;
}

interface CandidateView extends CandidateSummary {
  /** Operational: whether a private contact exists, never what it is. */
  contactRecorded: boolean;
  applications: CandidateApplication[];
  duplicateFlags: DuplicateFlag[];
}

/** Confidential (candidate.contact): only the granted caller receives it, on request. */
interface Contact {
  candidateId: string;
  email: string | null;
  phone: string | null;
  updatedAt: string | null;
}

interface ContactSaved {
  candidateId: string;
  changedFields: string[];
  duplicateFlags: DuplicateFlag[];
}

/** Confidential (candidate.document): metadata of a CV or other candidate document. */
interface CandidateDocument {
  id: string;
  candidateId: string;
  candidateCode: string;
  documentType: string;
  fileName: string | null;
  mediaType: string;
  byteSize: number | null;
  scanState: string | null;
  uploadedAt: string;
}

interface DocumentUploaded {
  id: string;
  mediaType: string;
  byteSize: number;
  scanState: string;
}

/** An operational identity the API names (an owner, a decider, a pending approver). */
interface Person {
  userId: string;
  employeeCode: string | null;
  displayName: string | null;
}

interface ApplicationRow {
  id: string;
  stage: string;
  stageEnteredAt: string;
  /** Calendar days in the current stage, by the company business date. */
  ageingDays: number | null;
  pendingAction: string | null;
  owner: Person;
  candidate: CandidateRef;
  requisition: { id: string; code: string; title: string; state: string };
  latestOffer: { id: string; state: string } | null;
  createdAt: string;
  version: number;
}

interface StageEvent {
  fromStage: string | null;
  toStage: string;
  note: string | null;
  actorUserId: string;
  occurredAt: string;
}

interface ApplicationOffer {
  id: string;
  state: string;
  proposedJoiningDate: string;
  currentRevision: number;
  createdAt: string;
}

interface ApplicationView extends ApplicationRow {
  history: StageEvent[];
  offers: ApplicationOffer[];
}

interface StageMoved {
  applicationId: string;
  stage: string;
  version: number;
}

interface Vacancy {
  id: string;
  code: string;
  title: string;
  state: string;
  vacancies: number;
  targetDate: string;
  filled: number;
  openPlaces: number;
  byStage: Record<string, number>;
}

interface Tracker {
  vacancies: Vacancy[];
  applications: ApplicationRow[];
}

interface OfferSummary {
  id: string;
  state: string;
  proposedJoiningDate: string;
  currentRevision: number;
  application: { id: string; stage: string };
  requisition: { id: string; code: string; title: string; state: string };
  candidate: { id: string; candidateCode: string; fullName: string };
  preparedBy: string;
  submittedBy: string | null;
  submittedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  candidateResponseOn: string | null;
  withdrawnReason: string | null;
  withdrawnAt: string | null;
  handedOverEmployeeId: string | null;
  createdAt: string;
  version: number;
}

interface OfferDecision {
  revision: number;
  step: number;
  action: string;
  decision: string;
  /** Present only for a caller holding the compensation group; null when none was given. */
  reason?: string | null;
  decidedAt: string;
  decidedBy: Person;
}

interface CompensationCurrent {
  currencyCode: string;
  annualCtc: string | null;
  monthlyGross: string | null;
  setBy: string;
  updatedAt: string;
}

interface CompensationRevision {
  revision: number;
  proposedJoiningDate: string;
  currencyCode: string;
  annualCtc: string | null;
  monthlyGross: string | null;
  compensationSetBy: string;
  submittedBy: string;
  submittedAt: string;
}

interface OfferView extends OfferSummary {
  decisions: OfferDecision[];
  pendingWith: { taskId: string; step: number; action: string; assignee: Person; assignedAt: string } | null;
  /** Confidential (offer.compensation): present only for a caller holding the group; absent, never masked. */
  compensation?: { current: CompensationCurrent | null; revisions: CompensationRevision[] };
}

/** The revision an approver decides: its terms and the compensation it pinned. */
interface UnderReview {
  revision: number;
  proposedJoiningDate: string;
  currencyCode?: string | null;
  annualCtc?: string | null;
  monthlyGross?: string | null;
  submittedAt: string;
}

interface OfferTask {
  taskId: string;
  transactionId: string;
  assignedAt: string;
  /** Null when the offer's requisition is outside the selected role's scope. */
  offer: (OfferSummary & { underReview: UnderReview | null }) | null;
}

type Decision = 'APPROVE' | 'RETURN' | 'REJECT';

interface OfferDecided {
  offerId: string;
  state: string;
  replayed: boolean;
}

interface HandoverResult {
  handoverId: string;
  employeeId: string;
  employeeStatus: string;
  offerId: string;
  applicationId: string;
  requisitionId: string;
  documents: { candidateDocumentId: string; employeeDocumentId: string }[];
}

interface Origin {
  handoverId: string;
  employeeId: string;
  handedOverAt: string;
  handedOverBy: string;
  requisition: { id: string; code: string; title: string };
  application: { id: string; stage: string };
  offer: { id: string; state: string; proposedJoiningDate: string };
  candidate: { id: string; candidateCode: string };
  documents: { candidateDocumentId: string; employeeDocumentId: string }[];
}

interface RequisitionView {
  id: string;
  code: string;
  title: string;
  state: string;
  vacancies: number;
  targetDate: string;
  filled: number;
  department?: { id: string; name: string };
  location?: { id: string; name: string };
  designation?: { id: string; name: string };
  hiringManager?: { id: string; employeeCode: string; displayName: string };
}

interface RequisitionPage {
  items: RequisitionView[];
  total: number;
}

interface EmployeeRecord {
  id: string;
  employeeCode: string;
  displayName: string;
  workEmail: string | null;
  joiningDate: string;
  employmentType: string;
  status: string;
}

// ---------------------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------------------

/**
 * Query keys carry the selected company and assignment: the app keeps one query cache across role switches and
 * sign-ins, and an answer given to one assignment (a scoped list, an offer with its compensation) must never be shown
 * under another, not even from the cache while the new answer loads.
 */
function useKeys() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(() => {
    const all = ['hiring-pipeline', context] as const;
    return {
      all,
      vendors: (includeInactive: boolean) => [...all, 'vendors', includeInactive] as const,
      candidates: (query: string) => [...all, 'candidates', query] as const,
      candidate: (id: string) => [...all, 'candidate', id] as const,
      documents: (candidateId: string) => [...all, 'documents', candidateId] as const,
      cvSearch: (term: string) => [...all, 'cv-search', term] as const,
      flags: (state: string) => [...all, 'flags', state] as const,
      requisition: (id: string) => [...all, 'requisition', id] as const,
      requisitions: (query: string) => [...all, 'requisitions', query] as const,
      applications: (requisitionId: string) => [...all, 'applications', requisitionId] as const,
      application: (id: string) => [...all, 'application', id] as const,
      tracker: (query: string) => [...all, 'tracker', query] as const,
      offers: (state: string) => [...all, 'offers', state] as const,
      offer: (id: string) => [...all, 'offer', id] as const,
      offerTasks: [...all, 'offer-tasks'] as const,
      origin: (employeeId: string) => [...all, 'origin', employeeId] as const,
      employee: (id: string) => [...all, 'employee', id] as const,
      /** Outside `all`: reloading after a change never reads the private contact again (each read is audited). */
      contact: (candidateId: string) => ['hiring-pipeline-contact', context, candidateId] as const,
    };
  }, [context]);
}

/** After any change: everything this module shows is read again from the server (no optimistic updates). */
function useRefresh(): () => void {
  const qc = useQueryClient();
  const keys = useKeys();
  return () => void qc.invalidateQueries({ queryKey: keys.all });
}

/** The signed-in user (GET /v1/me/context), e.g. to tell one's own applications apart. */
function useUserId(): string | null {
  const { me } = useSession();
  return me?.userId ?? null;
}

const SCROLL: CSSProperties = { overflowX: 'auto' };
const H3: CSSProperties = { fontSize: '1rem', margin: '0.5rem 0 0' };
const GROUP: CSSProperties = { border: 'none', margin: 0, padding: 0, minWidth: 0 };
const TEXTAREA: CSSProperties = { font: 'inherit', padding: '0.4rem 0.5rem', border: '1px solid var(--line)', borderRadius: 6, color: 'var(--text)', resize: 'vertical' };
const SR_ONLY: CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 };
const LIST: CSSProperties = { margin: 0, paddingLeft: '1.1rem' };

function NotPermitted({ children }: { children: ReactNode }) {
  return (
    <p role="note">
      <Badge tone="warn">not permitted</Badge> {children}
    </p>
  );
}

function Item({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Problem({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="error wide">
      {text}
    </p>
  );
}

function Done({ children }: { children: ReactNode }) {
  return (
    <p className="ok wide" role="status">
      {children}
    </p>
  );
}

/** What the last action did, kept by a parent that stays on screen while the acted-on item reloads or goes. */
function Notice({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="ok" role="status">
      {text}
    </p>
  );
}

/** A screen the selected role cannot use: its heading and the reason, and no request at all. */
function Denied({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h1>{title}</h1>
      <NotPermitted>{children}</NotPermitted>
    </>
  );
}

function Missing({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h1>{title}</h1>
      <Empty>{children}</Empty>
    </>
  );
}

/** An operational identity as the API named it; the signed-in user is marked. */
function personText(p: Person | null | undefined, userId: string | null): string {
  if (!p) return '—';
  const name = p.displayName && p.employeeCode ? `${p.displayName}, ${p.employeeCode}` : (p.displayName ?? p.employeeCode ?? 'A user without an employee record');
  return userId !== null && p.userId === userId ? `You (${name})` : name;
}

const ageing = (days: number | null | undefined) => (days === null || days === undefined ? '—' : `${days} ${days === 1 ? 'day' : 'days'}`);

/**
 * An amount as the API sent it (a decimal string), through formatAmount. formatAmount shows two decimals, so an amount
 * with a non-zero third or fourth decimal is also given exactly as sent: the display never hides part of an amount.
 */
function Money({ value, currency }: { value: string | null | undefined; currency: string }) {
  if (value === null || value === undefined) return <>—</>;
  const finer = /\.\d{2}\d*[1-9]/.test(value);
  return (
    <>
      {formatAmount(value, currency)}
      {finer && <span className="hint"> (exactly {value})</span>}
    </>
  );
}

function CandidateLink({ candidate: c, withState = false }: { candidate: { id: string; candidateCode: string; fullName: string; state?: string }; withState?: boolean }) {
  const { can } = useSession();
  return (
    <>
      {can(CANDIDATE_READ) ? <Link to={PATHS.candidate(c.id)}>{c.fullName}</Link> : c.fullName} <span className="hint">{c.candidateCode}</span>
      {withState && c.state && (
        <>
          {' '}
          <CandidateStateBadge state={c.state} />
        </>
      )}
    </>
  );
}

function stageCounts(byStage: Record<string, number>): string {
  const present = (s: string) => (byStage[s] ?? 0) > 0;
  const stages = [...STAGE_ORDER.filter(present), ...Object.keys(byStage).filter((s) => !STAGE_ORDER.includes(s) && present(s))];
  return stages.length === 0 ? 'No candidates yet' : stages.map((s) => `${labelOf(STAGE_LABEL, s)} ${byStage[s]}`).join(' · ');
}

const parseSkills = (text: string) =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

// ---------------------------------------------------------------------------------------------------------
// FR-014 tracker: vacancies, candidates by stage, and each open application's stage, owner, pending action, ageing
// ---------------------------------------------------------------------------------------------------------

function HiringTrackerScreen() {
  const { can } = useSession();
  if (!can(APPLICATION_READ)) return <Denied title="Hiring tracker">The selected role cannot view the hiring pipeline.</Denied>;
  return (
    <>
      <h1>Hiring tracker</h1>
      <TrackerBody />
    </>
  );
}

function trackerQuery(includeClosed: boolean, ownerUserId: string | null): string {
  const q = new URLSearchParams();
  if (includeClosed) q.set('includeClosed', 'true');
  if (ownerUserId) q.set('ownerUserId', ownerUserId);
  return q.toString();
}

function TrackerBody() {
  const keys = useKeys();
  const userId = useUserId();
  const [includeClosed, setIncludeClosed] = useState(false);
  const [mine, setMine] = useState(false);
  const qs = trackerQuery(includeClosed, mine ? userId : null);
  const tracker = useQuery({ queryKey: keys.tracker(qs), queryFn: () => api<Tracker>(`/v1/hiring/tracker${qs ? `?${qs}` : ''}`), retry: retryTransient });
  const data = tracker.data;
  return (
    <>
      <div className="row">
        <label className="inline check">
          <input type="checkbox" checked={includeClosed} onChange={(e) => setIncludeClosed(e.target.checked)} /> Include closed requisitions
        </label>
        <label className="inline check">
          <input type="checkbox" checked={mine} disabled={userId === null} onChange={(e) => setMine(e.target.checked)} /> Only applications I own
        </label>
      </div>
      {tracker.isPending && <p className="hint">Loading the tracker…</p>}
      <LoadProblem error={tracker.error} forbidden="The selected role cannot view the hiring pipeline." />
      {data && (
        <>
          <Section title={`Vacancies (${data.vacancies.length})`}>
            <p className="hint">Approved requisitions{includeClosed ? ' and closed ones' : ''}: filled places are accepted offers.</p>
            {data.vacancies.length === 0 ? <Empty>No approved requisitions in the selected role’s scope.</Empty> : <VacancyTable items={data.vacancies} />}
            {data.vacancies.length >= LIMITS.trackerVacancies && <p className="hint">Showing the first {LIMITS.trackerVacancies} requisitions by target date.</p>}
          </Section>
          <Section title={`Open applications (${data.applications.length})`}>
            <p className="hint">Applications at the applied, screening, interview or offer stage, longest in their stage first. Ageing counts calendar days in the current stage.</p>
            {data.applications.length === 0 ? (
              <Empty>{mine ? 'You own no open applications.' : 'No open applications.'}</Empty>
            ) : (
              <ApplicationTable items={data.applications} showRequisition label="Open applications" />
            )}
            {data.applications.length >= LIMITS.trackerApplications && <p className="hint">Showing the first {LIMITS.trackerApplications} applications.</p>}
          </Section>
        </>
      )}
    </>
  );
}

function VacancyTable({ items }: { items: Vacancy[] }) {
  return (
    <div style={SCROLL}>
      <table aria-label="Vacancies">
        <thead>
          <tr>
            <th scope="col">Requisition</th>
            <th scope="col">State</th>
            <th scope="col">Vacancies</th>
            <th scope="col">Filled</th>
            <th scope="col">Open places</th>
            <th scope="col">Target date</th>
            <th scope="col">Candidates by stage</th>
            <th scope="col">
              <span style={SR_ONLY}>Applications</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((v) => (
            <tr key={v.id}>
              <td>
                {v.code} <span className="hint">{v.title}</span>
              </td>
              <td>
                <RequisitionStateBadge state={v.state} />
              </td>
              <td>{v.vacancies}</td>
              <td>{v.filled}</td>
              <td>{v.openPlaces}</td>
              <td>{formatDate(v.targetDate)}</td>
              <td>{stageCounts(v.byStage)}</td>
              <td>
                <Link to={PATHS.requisitionApplications(v.id)} aria-label={`Applications for ${v.code}`}>
                  Applications
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ApplicationTable({ items, showRequisition, label }: { items: ApplicationRow[]; showRequisition: boolean; label: string }) {
  const { can } = useSession();
  const userId = useUserId();
  const canOpenOffer = can(OFFER_READ) || can(COMPENSATION_READ);
  return (
    <div style={SCROLL}>
      <table aria-label={label}>
        <thead>
          <tr>
            <th scope="col">Candidate</th>
            {showRequisition && <th scope="col">Requisition</th>}
            <th scope="col">Stage</th>
            <th scope="col">In stage since</th>
            <th scope="col">Ageing</th>
            <th scope="col">Owner</th>
            <th scope="col">Pending action</th>
            <th scope="col">Latest offer</th>
            <th scope="col">
              <span style={SR_ONLY}>Application</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <td>
                <CandidateLink candidate={a.candidate} />
              </td>
              {showRequisition && (
                <td>
                  {a.requisition.code} <span className="hint">{a.requisition.title}</span>
                </td>
              )}
              <td>
                <StageBadge stage={a.stage} />
              </td>
              <td>{formatDate(a.stageEnteredAt)}</td>
              <td>{ageing(a.ageingDays)}</td>
              <td>{personText(a.owner, userId)}</td>
              <td>{a.pendingAction ? labelOf(PENDING_ACTION_LABEL, a.pendingAction) : '—'}</td>
              <td>
                {a.latestOffer === null ? (
                  '—'
                ) : canOpenOffer ? (
                  <Link to={PATHS.offer(a.latestOffer.id)} aria-label={`Offer to ${a.candidate.fullName}: ${labelOf(OFFER_STATE_LABEL, a.latestOffer.state)}`}>
                    {labelOf(OFFER_STATE_LABEL, a.latestOffer.state)}
                  </Link>
                ) : (
                  labelOf(OFFER_STATE_LABEL, a.latestOffer.state)
                )}
              </td>
              <td>
                <Link to={PATHS.application(a.id)} aria-label={`Open the application of ${a.candidate.fullName} (${a.candidate.candidateCode})`}>
                  Open
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Hiring / Masters / Vendor: company-wide masters, deactivated, never deleted (BR-004)
// ---------------------------------------------------------------------------------------------------------

function VendorsScreen() {
  const { can } = useSession();
  if (!can(CANDIDATE_READ)) return <Denied title="Recruitment vendors">The selected role cannot view recruitment vendors.</Denied>;
  return (
    <>
      <h1>Recruitment vendors</h1>
      <VendorList />
      {can(CANDIDATE_MANAGE) && <NewVendorForm />}
    </>
  );
}

function useActiveVendors(enabled: boolean) {
  const keys = useKeys();
  return useQuery({ queryKey: keys.vendors(false), enabled, queryFn: () => api<{ items: Vendor[] }>('/v1/hiring/vendors'), retry: retryTransient });
}

function VendorList() {
  const { can } = useSession();
  const keys = useKeys();
  const [includeInactive, setIncludeInactive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useQuery({
    queryKey: keys.vendors(includeInactive),
    queryFn: () => api<{ items: Vendor[] }>(`/v1/hiring/vendors${includeInactive ? '?includeInactive=true' : ''}`),
    retry: retryTransient,
  });
  const canManage = can(CANDIDATE_MANAGE);
  const items = list.data?.items ?? [];
  return (
    <Section title="Vendors">
      <p className="hint">A vendor is deactivated, never deleted: it keeps its history and its candidates, but new candidates cannot name it.</p>
      <label className="inline check">
        <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Show inactive vendors
      </label>
      {list.isPending && <p className="hint">Loading vendors…</p>}
      <LoadProblem error={list.error} forbidden="The selected role cannot view recruitment vendors." />
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
      {list.data && items.length === 0 && <Empty>{includeInactive ? 'No vendors yet.' : 'No active vendors.'}</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Vendors">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                {canManage && (
                  <th scope="col">
                    <span style={SR_ONLY}>Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {items.map((v) => (
                <VendorRow key={v.id} vendor={v} canManage={canManage} onChanged={setNotice} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function VendorRow({ vendor: v, canManage, onChanged }: { vendor: Vendor; canManage: boolean; onChanged: (notice: string) => void }) {
  const refresh = useRefresh();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(v.name);
  const [problem, setProblem] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (body: { name?: string; active?: boolean; expectedVersion: number }) => api<Vendor>(`/v1/hiring/vendors/${enc(v.id)}`, { method: 'PATCH', body }),
    onSuccess: (saved, body) => {
      setEditing(false);
      setName(saved.name);
      setProblem(null);
      onChanged(body.active === undefined ? `Renamed ${saved.code} to ${saved.name}.` : `${saved.code} is now ${saved.active ? 'active' : 'inactive'}.`);
      refresh();
    },
    onError: (error) => {
      if (isConflict(error)) refresh();
    },
  });
  const rename = (e: FormEvent) => {
    e.preventDefault();
    if (update.isPending) return;
    const text = name.trim();
    setProblem(text ? null : 'Enter the vendor’s name.');
    if (!text) return;
    update.mutate({ name: text, expectedVersion: v.version });
  };
  return (
    <tr>
      <td>{v.code}</td>
      <td>
        {editing ? (
          <form className="row" onSubmit={rename} noValidate>
            <label>
              New name for {v.code}
              <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <button type="submit" disabled={update.isPending}>
              Save name
            </button>
            <button
              type="button"
              className="secondary"
              disabled={update.isPending}
              onClick={() => {
                setEditing(false);
                setName(v.name);
                setProblem(null);
                update.reset();
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          v.name
        )}
      </td>
      <td>
        <Badge tone={v.active ? 'good' : 'neutral'}>{v.active ? 'active' : 'inactive'}</Badge>
      </td>
      {canManage && (
        <td>
          <div className="row">
            {!editing && (
              <button
                type="button"
                className="link"
                aria-label={`Rename ${v.code}`}
                onClick={() => {
                  // Start from the name shown now: the list may have been read again since this row first appeared.
                  setName(v.name);
                  setEditing(true);
                }}
              >
                Rename
              </button>
            )}
            <button
              type="button"
              className="link"
              disabled={update.isPending}
              aria-label={`${v.active ? 'Deactivate' : 'Reactivate'} ${v.code}`}
              onClick={() => update.mutate({ active: !v.active, expectedVersion: v.version })}
            >
              {v.active ? 'Deactivate' : 'Reactivate'}
            </button>
          </div>
          {problem && (
            <p role="alert" className="error">
              {problem}
            </p>
          )}
          <Refusal error={update.error} words={VENDOR_WORDS} />
        </td>
      )}
    </tr>
  );
}

function NewVendorForm() {
  const refresh = useRefresh();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: { code: string; name: string }) => api<Vendor>('/v1/hiring/vendors', { body }),
    onSuccess: () => {
      setCode('');
      setName('');
      setProblem(null);
      refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    const missing = !code.trim() ? 'Enter the vendor’s code.' : !name.trim() ? 'Enter the vendor’s name.' : null;
    setProblem(missing);
    if (missing) {
      create.reset();
      return;
    }
    create.mutate({ code: code.trim(), name: name.trim() });
  };
  return (
    <Section title="Add a vendor">
      <form className="grid-form" aria-label="Add a vendor" onSubmit={submit} noValidate>
        <label>
          Code (required)
          <input required maxLength={40} value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        <label>
          Name (required)
          <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="hint wide">The code is stored in capitals and cannot change later.</p>
        <Problem text={problem} />
        {create.error && (
          <div className="wide">
            <Refusal error={create.error} words={VENDOR_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={create.isPending}>
            Add vendor
          </button>
        </div>
        {create.isSuccess && (
          <Done>
            Added {create.data.code} ({create.data.name}).
          </Done>
        )}
      </form>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// FR-013 candidate register: search, state, paging and registration
// ---------------------------------------------------------------------------------------------------------

function CandidatesScreen() {
  const { can } = useSession();
  const canRead = can(CANDIDATE_READ);
  const canManage = can(CANDIDATE_MANAGE);
  if (!canRead && !canManage) return <Denied title="Candidates">The selected role cannot view the candidate register.</Denied>;
  return (
    <>
      <h1>Candidates</h1>
      {canRead ? (
        <CandidateRegister />
      ) : (
        <Section title="Candidate register">
          <NotPermitted>The selected role cannot view the candidate register.</NotPermitted>
        </Section>
      )}
      {canManage && <NewCandidateForm />}
    </>
  );
}

const CANDIDATE_STATE_FILTERS: readonly { value: string; label: string }[] = [
  { value: '', label: 'All states' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'DUPLICATE', label: 'Retired duplicates' },
];

function candidateListQuery(q: { term: string; state: string; page: number }): string {
  const p = new URLSearchParams();
  if (q.term) p.set('search', q.term);
  if (q.state) p.set('state', q.state);
  p.set('page', String(q.page));
  p.set('pageSize', String(PAGE_SIZE));
  return p.toString();
}

function CandidateRegister() {
  const keys = useKeys();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState({ term: '', state: '', page: 1 });
  const qs = candidateListQuery(query);
  const list = useQuery({ queryKey: keys.candidates(qs), queryFn: () => api<CandidatePage>(`/v1/hiring/candidates?${qs}`), retry: retryTransient });
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <Section title={`Candidate register${data ? ` (${data.total})` : ''}`}>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery((q) => ({ ...q, term: search.trim(), page: 1 }));
        }}
      >
        <label className="inline">
          Search code, name or skill
          <input type="search" maxLength={100} value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label className="inline">
          State
          <select value={query.state} onChange={(e) => setQuery((q) => ({ ...q, state: e.target.value, page: 1 }))}>
            {CANDIDATE_STATE_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="secondary">
          Search
        </button>
      </form>
      <p className="hint">The search covers candidate codes, names and skills, never private contacts.</p>
      {list.isPending && <p className="hint">Loading candidates…</p>}
      <LoadProblem error={list.error} forbidden="The selected role cannot view the candidate register." />
      {data && data.items.length === 0 && <Empty>{query.term ? `No candidates match “${query.term}”.` : 'No candidates in the register.'}</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Candidate register">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">Source</th>
                <th scope="col">Skills</th>
                <th scope="col">Consent</th>
                <th scope="col">Retain until</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((c) => (
                <tr key={c.id}>
                  <td>{c.candidateCode}</td>
                  <td>
                    <Link to={PATHS.candidate(c.id)}>{c.fullName}</Link>
                  </td>
                  <td>
                    {c.source.label}
                    {c.vendor && <div className="hint">{` ${c.vendor.name} (${c.vendor.code})`}</div>}
                  </td>
                  <td>{c.skills.length > 0 ? c.skills.join(', ') : '—'}</td>
                  <td>
                    {labelOf(CONSENT_LABEL, c.consentStatus)}
                    {c.consentRecordedOn && <div className="hint">{` on ${formatDate(c.consentRecordedOn)}`}</div>}
                  </td>
                  <td>{formatDate(c.retainUntil)}</td>
                  <td>
                    <CandidateStateBadge state={c.state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && pages > 1 && (
        <div className="pager">
          <button type="button" className="secondary" disabled={query.page <= 1} onClick={() => setQuery((q) => ({ ...q, page: q.page - 1 }))}>
            Previous
          </button>
          <span>
            Page {query.page} of {pages}
          </span>
          <button type="button" className="secondary" disabled={query.page >= pages} onClick={() => setQuery((q) => ({ ...q, page: q.page + 1 }))}>
            Next
          </button>
        </div>
      )}
    </Section>
  );
}

/** The candidate fields as typed (strings); the API's body is built from them only when sending. */
interface CandidateValues {
  fullName: string;
  sourceCode: string;
  vendorId: string;
  skills: string;
  consentStatus: string;
  consentRecordedOn: string;
  retainUntil: string;
  state: string;
}

const CANDIDATE_FIELDS = ['fullName', 'sourceCode', 'vendorId', 'skills', 'consentStatus', 'consentRecordedOn', 'retainUntil', 'state'] as const;

const EMPTY_CANDIDATE: CandidateValues = {
  fullName: '',
  sourceCode: 'DIRECT',
  vendorId: '',
  skills: '',
  consentStatus: 'NOT_RECORDED',
  consentRecordedOn: '',
  retainUntil: '',
  state: 'ACTIVE',
};

const candidateValues = (c: CandidateView): CandidateValues => ({
  fullName: c.fullName,
  sourceCode: c.source.code,
  vendorId: c.vendor?.id ?? '',
  skills: c.skills.join(', '),
  consentStatus: c.consentStatus,
  consentRecordedOn: c.consentRecordedOn ?? '',
  retainUntil: c.retainUntil ?? '',
  state: c.state,
});

/** Required-field checks only; whether a source, vendor or date is acceptable is the server's call. */
function candidateProblem(v: CandidateValues): string | null {
  if (!v.fullName.trim()) return 'Enter the candidate’s full name.';
  if (v.sourceCode === 'VENDOR' && !v.vendorId) return 'Choose the recruitment vendor the candidate came through.';
  if (v.consentStatus !== 'NOT_RECORDED' && !v.consentRecordedOn) return 'Enter the date the consent was given or withdrawn.';
  const skills = parseSkills(v.skills);
  if (skills.length > 50) return 'List at most 50 skills.';
  if (skills.some((s) => s.length > 100)) return 'Keep each skill to 100 characters or fewer.';
  return null;
}

function newCandidateBody(v: CandidateValues): Record<string, unknown> {
  const skills = parseSkills(v.skills);
  return {
    fullName: v.fullName.trim(),
    sourceCode: v.sourceCode,
    ...(v.sourceCode === 'VENDOR' ? { vendorId: v.vendorId } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    consentStatus: v.consentStatus,
    ...(v.consentStatus !== 'NOT_RECORDED' ? { consentRecordedOn: v.consentRecordedOn } : {}),
    ...(v.retainUntil ? { retainUntil: v.retainUntil } : {}),
  };
}

/** Only what the user changed: a concurrent change to another field is kept (the server merges the patch). */
function candidatePatch(original: CandidateValues, typed: CandidateValues): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (typed.fullName.trim() !== original.fullName.trim()) patch.fullName = typed.fullName.trim();
  if (typed.sourceCode !== original.sourceCode) patch.sourceCode = typed.sourceCode;
  // Leaving the vendor source drops the vendor on the server; a vendor source always names its vendor.
  if (typed.sourceCode === 'VENDOR' && (typed.sourceCode !== original.sourceCode || typed.vendorId !== original.vendorId)) patch.vendorId = typed.vendorId;
  if (parseSkills(typed.skills).join('\n') !== parseSkills(original.skills).join('\n')) patch.skills = parseSkills(typed.skills);
  if (typed.consentStatus !== original.consentStatus || typed.consentRecordedOn !== original.consentRecordedOn) {
    patch.consentStatus = typed.consentStatus;
    patch.consentRecordedOn = typed.consentStatus === 'NOT_RECORDED' ? null : typed.consentRecordedOn;
  }
  if (typed.retainUntil !== original.retainUntil) patch.retainUntil = typed.retainUntil || null;
  if (typed.state !== original.state) patch.state = typed.state;
  return patch;
}

function CandidateFields({
  values: v,
  set,
  vendors,
  currentVendor,
  showState,
}: {
  values: CandidateValues;
  set: (patch: Partial<CandidateValues>) => void;
  vendors: ReturnType<typeof useActiveVendors>;
  currentVendor: { id: string; code: string; name: string } | null;
  showState: boolean;
}) {
  const active = vendors.data?.items ?? [];
  // A candidate's current vendor may be inactive now: it stays selectable for that candidate only.
  const options = currentVendor && !active.some((x) => x.id === currentVendor.id) ? [{ ...currentVendor, current: true }, ...active.map((x) => ({ ...x, current: false }))] : active.map((x) => ({ ...x, current: false }));
  return (
    <>
      <label>
        Full name (required)
        <input required maxLength={200} value={v.fullName} onChange={(e) => set({ fullName: e.target.value })} />
      </label>
      <label>
        Source
        <select value={v.sourceCode} onChange={(e) => set({ sourceCode: e.target.value, vendorId: '' })}>
          {SOURCES.map((s) => (
            <option key={s.code} value={s.code}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      {v.sourceCode === 'VENDOR' && (
        <label>
          Recruitment vendor (required)
          <select required value={v.vendorId} onChange={(e) => set({ vendorId: e.target.value })}>
            <option value="">{vendors.isLoading ? 'Loading vendors…' : 'Choose a vendor…'}</option>
            {options.map((x) => (
              <option key={x.id} value={x.id}>
                {`${x.name} (${x.code})${x.current ? ' (current)' : ''}`}
              </option>
            ))}
          </select>
        </label>
      )}
      {v.sourceCode === 'VENDOR' && vendors.data && options.length === 0 && (
        <p className="hint wide">
          No active vendors yet: add one under <Link to={PATHS.vendors}>Recruitment vendors</Link>.
        </p>
      )}
      {v.sourceCode === 'VENDOR' && vendors.error && (
        <div className="wide">
          <LoadProblem error={vendors.error} forbidden="The selected role cannot list the recruitment vendors." />
        </div>
      )}
      <label className="wide">
        Skills (separated by commas)
        <input maxLength={5000} value={v.skills} onChange={(e) => set({ skills: e.target.value })} />
      </label>
      <label>
        Consent
        <select value={v.consentStatus} onChange={(e) => set({ consentStatus: e.target.value, ...(e.target.value === 'NOT_RECORDED' ? { consentRecordedOn: '' } : {}) })}>
          {CONSENTS.map((c) => (
            <option key={c} value={c}>
              {labelOf(CONSENT_LABEL, c)}
            </option>
          ))}
        </select>
      </label>
      {v.consentStatus !== 'NOT_RECORDED' && (
        <label>
          {v.consentStatus === 'WITHDRAWN' ? 'Consent withdrawn on (required)' : 'Consent given on (required)'}
          <input type="date" required value={v.consentRecordedOn} onChange={(e) => set({ consentRecordedOn: e.target.value })} />
        </label>
      )}
      <label>
        Retain until (optional)
        <input type="date" value={v.retainUntil} onChange={(e) => set({ retainUntil: e.target.value })} />
      </label>
      {showState && (
        <label>
          Record state
          <select value={v.state} onChange={(e) => set({ state: e.target.value })}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
        </label>
      )}
    </>
  );
}

function NewCandidateForm() {
  const { can } = useSession();
  const refresh = useRefresh();
  const [values, setValues] = useState<CandidateValues>(EMPTY_CANDIDATE);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<CandidateValues>) => setValues((v) => ({ ...v, ...patch }));
  const vendors = useActiveVendors(values.sourceCode === 'VENDOR' && can(CANDIDATE_READ));
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<CandidateView>('/v1/hiring/candidates', { body }),
    // A registered candidate starts the form clean; a refused one keeps what was typed.
    onSuccess: () => {
      setValues(EMPTY_CANDIDATE);
      setProblem(null);
      refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    const missing = candidateProblem(values);
    setProblem(missing);
    if (missing) {
      create.reset();
      return;
    }
    create.mutate(newCandidateBody(values));
  };
  return (
    <Section title="Register a candidate">
      <form className="grid-form" aria-label="Register a candidate" onSubmit={submit} noValidate>
        <CandidateFields values={values} set={set} vendors={vendors} currentVendor={null} showState={false} />
        <p className="hint wide">
          Private contacts and CVs are confidential: an eligible Admin records them on the candidate’s page. A likely duplicate is flagged for review, never merged.
        </p>
        <Problem text={problem} />
        {create.error && (
          <div className="wide">
            <Refusal error={create.error} words={CANDIDATE_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={create.isPending}>
            Register candidate
          </button>
        </div>
        {create.isSuccess && (
          <Done>
            Registered {create.data.candidateCode}. <Link to={PATHS.candidate(create.data.id)}>Open {create.data.fullName}</Link>
          </Done>
        )}
      </form>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// One candidate: the operational record, its duplicate flags and applications; private contact and documents for
// eligible Admin assignments only
// ---------------------------------------------------------------------------------------------------------

function CandidateScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(CANDIDATE_READ)) return <Denied title="Candidate">The selected role cannot view the candidate register.</Denied>;
  if (!UUID.test(id)) return <Missing title="Candidate">This candidate is not available in the selected role’s scope.</Missing>;
  return <CandidateDetail key={id} id={id} />;
}

function CandidateDetail({ id }: { id: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const [flagNotice, setFlagNotice] = useState<string | null>(null);
  const detail = useQuery({ queryKey: keys.candidate(id), queryFn: () => api<CandidateView>(`/v1/hiring/candidates/${enc(id)}`), retry: retryTransient });
  const c = detail.data;
  const reloading = detail.isFetching && !detail.isPending;
  return (
    <>
      <p>
        <Link to={PATHS.candidates}>← Candidates</Link>
      </p>
      <h1>{c ? `${c.fullName} (${c.candidateCode})` : 'Candidate'}</h1>
      {detail.isPending && <p className="hint">Loading the candidate…</p>}
      <LoadProblem error={detail.error} forbidden="The selected role cannot view this candidate." missing="This candidate is not available in the selected role’s scope." />
      {c && (
        <>
          <Section title="Candidate">
            <dl className="kv">
              <Item term="Candidate code">{c.candidateCode}</Item>
              <Item term="State">
                <CandidateStateBadge state={c.state} />
              </Item>
              <Item term="Source">{c.source.label}</Item>
              {c.vendor && <Item term="Vendor">{`${c.vendor.name} (${c.vendor.code})`}</Item>}
              <Item term="Skills">{c.skills.length > 0 ? c.skills.join(', ') : '—'}</Item>
              <Item term="Consent">
                {labelOf(CONSENT_LABEL, c.consentStatus)}
                {c.consentRecordedOn ? ` on ${formatDate(c.consentRecordedOn)}` : ''}
              </Item>
              <Item term="Retain until">{c.retainUntil ? formatDate(c.retainUntil) : 'No date recorded'}</Item>
              <Item term="Private contact">{c.contactRecorded ? 'Recorded' : 'Not recorded'}</Item>
              <Item term="Registered">{formatDate(c.createdAt)}</Item>
            </dl>
            {c.state === 'DUPLICATE' && (
              <p className="hint">This record was retired as a duplicate: it takes no new applications, and its history and applications are kept as they are.</p>
            )}
          </Section>
          {can(CANDIDATE_MANAGE) && <EditCandidateForm candidate={c} busy={reloading} />}
          <Section title={`Possible duplicates (${c.duplicateFlags.length})`}>
            <p className="hint">A flag means this record shares a private email address or phone number with another record. A person reviews each flag; records are never merged.</p>
            <Notice text={flagNotice} />
            {c.duplicateFlags.length === 0 ? (
              <Empty>No likely matches are flagged for this candidate.</Empty>
            ) : (
              <FlagList flags={c.duplicateFlags} label={`Possible duplicates of ${c.candidateCode}`} onResolved={setFlagNotice} />
            )}
          </Section>
          <CandidateApplications candidate={c} />
          {(can(CONTACT_READ) || can(CONTACT_MANAGE)) && <PrivateContact candidate={c} />}
          {(can(DOCUMENT_READ) || can(DOCUMENT_UPLOAD)) && <CandidateDocuments candidate={c} />}
        </>
      )}
    </>
  );
}

/**
 * Edits start from the record and send only what the user changed. When the record changes meanwhile (a reload after a
 * conflict, for instance), untouched fields follow it and what the user typed is kept, with a note.
 */
function EditCandidateForm({ candidate: c, busy }: { candidate: CandidateView; busy: boolean }) {
  const { can } = useSession();
  const refresh = useRefresh();
  const [original, setOriginal] = useState(() => candidateValues(c));
  const [typed, setTyped] = useState(() => candidateValues(c));
  const [version, setVersion] = useState(c.version);
  const [changedMeanwhile, setChangedMeanwhile] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<CandidateValues>) => setTyped((v) => ({ ...v, ...patch }));
  const vendors = useActiveVendors(typed.sourceCode === 'VENDOR' && can(CANDIDATE_READ));

  useEffect(() => {
    if (c.version === version) return;
    const latest = candidateValues(c);
    const touched = CANDIDATE_FIELDS.some((k) => typed[k] !== original[k]);
    const next = { ...typed };
    for (const k of CANDIDATE_FIELDS) if (typed[k] === original[k]) next[k] = latest[k];
    setTyped(next);
    setOriginal(latest);
    setVersion(c.version);
    setChangedMeanwhile(touched);
    // Only a new version of the record re-bases the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.version]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<CandidateView>(`/v1/hiring/candidates/${enc(c.id)}`, { method: 'PATCH', body }),
    onSuccess: (view) => {
      const latest = candidateValues(view);
      setOriginal(latest);
      setTyped(latest);
      setVersion(view.version);
      setChangedMeanwhile(false);
      setProblem(null);
      refresh();
    },
    onError: (error) => {
      if (isConflict(error)) refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending || busy) return;
    const patch = candidatePatch(original, typed);
    const missing = candidateProblem(typed) ?? (Object.keys(patch).length === 0 ? 'Nothing has changed yet.' : null);
    setProblem(missing);
    if (missing) {
      save.reset();
      return;
    }
    save.mutate({ ...patch, expectedVersion: version });
  };
  return (
    <Section title="Change the candidate">
      <form className="grid-form" aria-label="Change the candidate" onSubmit={submit} noValidate>
        <CandidateFields values={typed} set={set} vendors={vendors} currentVendor={c.vendor} showState={c.state !== 'DUPLICATE'} />
        {c.state === 'DUPLICATE' && <p className="hint wide">A retired duplicate stays retired; its other details can still be corrected.</p>}
        {changedMeanwhile && (
          <p className="hint wide" role="status">
            Someone changed this candidate meanwhile: the details above show the latest values. Your unsaved changes are kept; save again to apply them.
          </p>
        )}
        <Problem text={problem} />
        {save.error && (
          <div className="wide">
            <Refusal error={save.error} words={CANDIDATE_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={save.isPending || busy}>
            Save changes
          </button>
        </div>
        {save.isSuccess && <Done>Candidate saved.</Done>}
      </form>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// FR-013 duplicate review: a flag is reviewed by a person; confirming retires one record; nothing is merged
// ---------------------------------------------------------------------------------------------------------

function DuplicateReviewScreen() {
  const { can } = useSession();
  if (!can(CANDIDATE_READ)) return <Denied title="Duplicate review">The selected role cannot view the candidate register.</Denied>;
  return (
    <>
      <h1>Duplicate review</h1>
      <FlagQueue />
    </>
  );
}

const FLAG_FILTERS: readonly { value: string; label: string }[] = [
  { value: 'OPEN', label: 'Waiting for review' },
  { value: 'NOT_DUPLICATE', label: 'Not duplicates' },
  { value: 'CONFIRMED_DUPLICATE', label: 'Confirmed duplicates' },
  { value: '', label: 'All flags' },
];

function FlagQueue() {
  const keys = useKeys();
  const [state, setState] = useState('OPEN');
  // Kept here: a reviewed flag leaves the waiting list (and the list itself may go) once it reloads.
  const [notice, setNotice] = useState<string | null>(null);
  const flags = useQuery({
    queryKey: keys.flags(state),
    queryFn: () => api<{ items: DuplicateFlag[] }>(`/v1/hiring/duplicate-flags${state ? `?state=${state}` : ''}`),
    retry: retryTransient,
  });
  const items = flags.data?.items ?? [];
  return (
    <Section title="Likely matches">
      <p className="hint">
        A flag means two records share a private email address or phone number. A person reviews each flag and nothing is merged: confirming a duplicate retires
        the record you choose, which then takes no new applications; both records, their history and their applications are kept.
      </p>
      <label className="inline">
        Show
        <select value={state} onChange={(e) => setState(e.target.value)}>
          {FLAG_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      {flags.isPending && <p className="hint">Loading flags…</p>}
      <LoadProblem error={flags.error} forbidden="The selected role cannot view duplicate flags." />
      <Notice text={notice} />
      {flags.data && items.length === 0 && <Empty>{state === 'OPEN' ? 'No flags are waiting for review.' : 'No flags to show.'}</Empty>}
      {items.length > 0 && <FlagList flags={items} label="Duplicate flags" onResolved={setNotice} />}
      {items.length >= LIMITS.flags && <p className="hint">Showing the latest {LIMITS.flags} flags.</p>}
    </Section>
  );
}

function FlagList({ flags, label, onResolved }: { flags: DuplicateFlag[]; label: string; onResolved: (notice: string) => void }) {
  return (
    <ul className="tasks" aria-label={label}>
      {flags.map((f) => (
        <FlagItem key={f.flagId} flag={f} onResolved={onResolved} />
      ))}
    </ul>
  );
}

function FlagItem({ flag: f, onResolved }: { flag: DuplicateFlag; onResolved: (notice: string) => void }) {
  const { can } = useSession();
  const refresh = useRefresh();
  const id = useId();
  const [resolution, setResolution] = useState<'' | 'NOT_DUPLICATE' | 'CONFIRMED_DUPLICATE'>('');
  const [retire, setRetire] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const pair = `${f.candidate.candidateCode} and ${f.matchedCandidate.candidateCode}`;
  const resolve = useMutation({
    mutationFn: (body: { resolution: string; retireCandidateId?: string; note: string }) =>
      api<{ flagId: string; state: string; retiredCandidateId: string | null }>(`/v1/hiring/duplicate-flags/${enc(f.flagId)}/resolve`, { body }),
    onSuccess: (result) => {
      const retired = [f.candidate, f.matchedCandidate].find((c) => c.id === result.retiredCandidateId);
      onResolved(
        result.state === 'CONFIRMED_DUPLICATE'
          ? `Confirmed ${pair} as the same person: ${retired?.candidateCode ?? 'the chosen record'} is retired; nothing was merged.`
          : `Recorded ${pair} as different people.`,
      );
      setResolution('');
      setRetire('');
      setNote('');
      setProblem(null);
      refresh();
    },
    onError: (error) => {
      if (isConflict(error) || isNotFound(error)) refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (resolve.isPending) return;
    const text = note.trim();
    const missing =
      resolution === ''
        ? 'Choose whether the two records are the same person.'
        : resolution === 'CONFIRMED_DUPLICATE' && !retire
          ? 'Choose which of the two records is the duplicate to retire.'
          : !text
            ? 'Enter a note on the review.'
            : null;
    setProblem(missing);
    if (missing || resolution === '') {
      resolve.reset();
      return;
    }
    resolve.mutate({ resolution, ...(resolution === 'CONFIRMED_DUPLICATE' ? { retireCandidateId: retire } : {}), note: text });
  };
  const retiredRecord = [f.candidate, f.matchedCandidate].find((c) => c.id === f.retiredCandidateId);
  return (
    <li aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} style={H3}>
        {pair}: {labelOf(BASIS_LABEL, f.basis).toLowerCase()}
      </h3>
      <dl className="kv">
        <Item term="Record">
          <CandidateLink candidate={f.candidate} withState />
        </Item>
        <Item term="Matching record">
          <CandidateLink candidate={f.matchedCandidate} withState />
        </Item>
        <Item term="Flagged">{formatDate(f.flaggedAt)}</Item>
        <Item term="Review">
          <FlagStateBadge state={f.state} />
        </Item>
        {f.resolvedAt && <Item term="Reviewed">{formatDate(f.resolvedAt)}</Item>}
        {f.resolutionNote && <Item term="Review note">{f.resolutionNote}</Item>}
        {retiredRecord && <Item term="Retired record">{retiredRecord.candidateCode}</Item>}
      </dl>
      {f.state === 'OPEN' && can(CANDIDATE_MANAGE) && (
        <form className="grid-form" aria-label={`Review ${pair}`} onSubmit={submit} noValidate>
          <fieldset className="wide" style={GROUP}>
            <legend>Are they the same person?</legend>
            <div className="row">
              <label className="check">
                <input type="radio" name={`${id}-resolution`} value="NOT_DUPLICATE" checked={resolution === 'NOT_DUPLICATE'} onChange={() => setResolution('NOT_DUPLICATE')} />{' '}
                No, different people
              </label>
              <label className="check">
                <input
                  type="radio"
                  name={`${id}-resolution`}
                  value="CONFIRMED_DUPLICATE"
                  checked={resolution === 'CONFIRMED_DUPLICATE'}
                  onChange={() => setResolution('CONFIRMED_DUPLICATE')}
                />{' '}
                Yes, the same person
              </label>
            </div>
          </fieldset>
          {resolution === 'CONFIRMED_DUPLICATE' && (
            <fieldset className="wide" style={GROUP}>
              <legend>Record to retire</legend>
              <div className="row">
                {[f.candidate, f.matchedCandidate].map((c) => (
                  <label key={c.id} className="check">
                    <input type="radio" name={`${id}-retire`} value={c.id} checked={retire === c.id} onChange={() => setRetire(c.id)} /> Retire {c.candidateCode} ({c.fullName})
                  </label>
                ))}
              </div>
              <p className="hint">The retired record takes no new applications; nothing is merged, and its history and applications stay as they are.</p>
            </fieldset>
          )}
          <label className="wide">
            Review note (required)
            <textarea required maxLength={1000} rows={2} value={note} onChange={(e) => setNote(e.target.value)} style={TEXTAREA} />
          </label>
          <Problem text={problem} />
          {resolve.error && (
            <div className="wide">
              <Refusal error={resolve.error} words={FLAG_WORDS} />
            </div>
          )}
          <div className="wide row">
            <button type="submit" disabled={resolve.isPending}>
              Record review
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------
// A candidate's applications, and a new application to an approved requisition
// ---------------------------------------------------------------------------------------------------------

function CandidateApplications({ candidate: c }: { candidate: CandidateView }) {
  const { can } = useSession();
  const canOpen = can(APPLICATION_READ);
  return (
    <Section title={`Applications (${c.applications.length})`}>
      <p className="hint">A candidate may apply to several requisitions; each application is decided on its own.</p>
      {c.applications.length === 0 ? (
        <Empty>No applications yet.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label={`Applications of ${c.candidateCode}`}>
            <thead>
              <tr>
                <th scope="col">Requisition</th>
                <th scope="col">Stage</th>
                <th scope="col">In stage since</th>
                {canOpen && (
                  <th scope="col">
                    <span style={SR_ONLY}>Application</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {c.applications.map((a) => (
                <tr key={a.applicationId}>
                  <td>
                    {canOpen ? <Link to={PATHS.requisitionApplications(a.requisitionId)}>{a.requisitionCode}</Link> : a.requisitionCode} <span className="hint">{a.title}</span>
                  </td>
                  <td>
                    <StageBadge stage={a.stage} />
                  </td>
                  <td>{formatDate(a.stageEnteredAt)}</td>
                  {canOpen && (
                    <td>
                      <Link to={PATHS.application(a.applicationId)} aria-label={`Open the application for ${a.requisitionCode}`}>
                        Open
                      </Link>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can(APPLICATION_MANAGE) &&
        can(REQUISITION_READ) &&
        (c.state === 'ACTIVE' ? <ApplyToRequisition candidate={c} /> : <p className="hint">Only an active candidate record can apply to a requisition.</p>)}
    </Section>
  );
}

function requisitionSearchQuery(term: string): string {
  const q = new URLSearchParams({ state: 'APPROVED' });
  if (term) q.set('search', term);
  q.set('page', '1');
  q.set('pageSize', String(PAGE_SIZE));
  return q.toString();
}

function ApplyToRequisition({ candidate: c }: { candidate: CandidateView }) {
  const keys = useKeys();
  const refresh = useRefresh();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState<string | null>(null);
  const qs = term === null ? '' : requisitionSearchQuery(term);
  const hits = useQuery({ queryKey: keys.requisitions(qs), enabled: term !== null, queryFn: () => api<RequisitionPage>(`/v1/hiring/requisitions?${qs}`), retry: retryTransient });
  const add = useMutation({
    mutationFn: (r: RequisitionView) => api<ApplicationView>(`/v1/hiring/requisitions/${enc(r.id)}/applications`, { body: { candidateId: c.id } }),
    onSuccess: () => refresh(),
    // Applied meanwhile, or the requisition or the candidate moved on: the lists are read again to show the server's state.
    onError: (error) => {
      if (isConflict(error)) refresh();
    },
  });
  const applied = new Set(c.applications.map((a) => a.requisitionId));
  return (
    <>
      <h3 style={H3}>Apply to a requisition</h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(search.trim());
        }}
      >
        <label className="inline">
          Find an approved requisition
          <input type="search" maxLength={100} value={search} placeholder="Code or title" onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button type="submit" className="secondary">
          Search requisitions
        </button>
      </form>
      {term !== null && hits.isPending && <p className="hint">Searching…</p>}
      <LoadProblem error={hits.error} forbidden="The selected role cannot search requisitions." />
      {hits.data && hits.data.items.length === 0 && <Empty>No approved requisitions match.</Empty>}
      {hits.data && hits.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Approved requisitions">
            <thead>
              <tr>
                <th scope="col">Requisition</th>
                <th scope="col">Vacancies</th>
                <th scope="col">Target date</th>
                <th scope="col">
                  <span style={SR_ONLY}>Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {hits.data.items.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.code} <span className="hint">{r.title}</span>
                  </td>
                  <td>{r.vacancies}</td>
                  <td>{formatDate(r.targetDate)}</td>
                  <td>
                    {applied.has(r.id) ? (
                      <span className="hint">Already applied</span>
                    ) : (
                      <button type="button" disabled={add.isPending} aria-label={`Apply to ${r.code}`} onClick={() => add.mutate(r)}>
                        Apply
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hits.data.total > hits.data.items.length && <p className="hint">Showing the first {hits.data.items.length} of {hits.data.total}; refine the search.</p>}
        </div>
      )}
      <Refusal error={add.error} words={APPLY_WORDS} />
      {add.isSuccess && (
        <p className="ok" role="status">
          Application created for {add.data.requisition.code} at the applied stage. <Link to={PATHS.application(add.data.id)}>Open the application</Link>
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Private contact (confidential): read only when asked (each read is audited); recording may raise duplicate flags
// ---------------------------------------------------------------------------------------------------------

function PrivateContact({ candidate: c }: { candidate: CandidateView }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canRead = can(CONTACT_READ);
  const [shown, setShown] = useState(false);
  const contact = useQuery({
    queryKey: keys.contact(c.id),
    enabled: canRead && shown,
    queryFn: () => api<Contact>(`/v1/hiring/candidates/${enc(c.id)}/contact`),
    // Each read is recorded: never repeated on its own, never kept once hidden.
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const hide = () => {
    setShown(false);
    qc.removeQueries({ queryKey: keys.contact(c.id) });
  };
  const data = shown ? contact.data : undefined;
  return (
    <Section title="Private contact (confidential)">
      <p>{c.contactRecorded ? 'A private contact is recorded for this candidate.' : 'No private contact is recorded for this candidate.'}</p>
      {canRead && (
        <>
          <div className="row">
            {shown ? (
              <button type="button" className="secondary" onClick={hide}>
                Hide private contact
              </button>
            ) : (
              <button type="button" className="secondary" onClick={() => setShown(true)}>
                Show private contact
              </button>
            )}
          </div>
          <p className="hint">Each look at the private contact is recorded in the audit trail.</p>
          {shown && contact.isPending && <p className="hint">Loading the private contact…</p>}
          {shown && <Refusal error={contact.error} words={CONTACT_WORDS} />}
          {data && (
            <dl className="kv" aria-label="Private contact">
              <Item term="Email address">{data.email ?? 'Not recorded'}</Item>
              <Item term="Phone number">{data.phone ?? 'Not recorded'}</Item>
              <Item term="Last changed">{formatDate(data.updatedAt)}</Item>
            </dl>
          )}
        </>
      )}
      {can(CONTACT_MANAGE) && <ContactForm candidate={c} onSaved={hide} />}
    </Section>
  );
}

function ContactForm({ candidate: c, onSaved }: { candidate: CandidateView; onSaved: () => void }) {
  const refresh = useRefresh();
  const id = useId();
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [removeEmail, setRemoveEmail] = useState(false);
  const [removePhone, setRemovePhone] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: { email?: string | null; phone?: string | null }) => api<ContactSaved>(`/v1/hiring/candidates/${enc(c.id)}/contact`, { method: 'PUT', body }),
    onSuccess: () => {
      setEmail('');
      setPhone('');
      setRemoveEmail(false);
      setRemovePhone(false);
      setProblem(null);
      // What is shown was read before the change: the next look is a new, recorded read.
      onSaved();
      refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    const body: { email?: string | null; phone?: string | null } = {};
    if (removeEmail) body.email = null;
    else if (email.trim()) body.email = email.trim();
    if (removePhone) body.phone = null;
    else if (phone.trim()) body.phone = phone.trim();
    const missing = Object.keys(body).length === 0 ? 'Enter an email address or a phone number, or choose a recorded value to remove.' : null;
    setProblem(missing);
    if (missing) {
      save.reset();
      return;
    }
    save.mutate(body);
  };
  const saved = save.isSuccess ? save.data : undefined;
  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        Record the private contact
      </h3>
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <label>
          Email address
          <input type="email" maxLength={254} value={email} disabled={removeEmail} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Phone number
          <input type="tel" maxLength={40} value={phone} disabled={removePhone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        {c.contactRecorded && (
          <fieldset className="wide" style={GROUP}>
            <legend>Remove a recorded value</legend>
            <div className="row">
              <label className="check">
                <input type="checkbox" checked={removeEmail} onChange={(e) => setRemoveEmail(e.target.checked)} /> Remove the recorded email address
              </label>
              <label className="check">
                <input type="checkbox" checked={removePhone} onChange={(e) => setRemovePhone(e.target.checked)} /> Remove the recorded phone number
              </label>
            </div>
          </fieldset>
        )}
        <p className="hint wide">A blank field keeps what is recorded. A match with another candidate’s contact is flagged for review; records are never merged.</p>
        <Problem text={problem} />
        {save.error && (
          <div className="wide">
            <Refusal error={save.error} words={CONTACT_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={save.isPending}>
            Save private contact
          </button>
        </div>
        {saved && <ContactSavedNote saved={saved} candidateId={c.id} />}
      </form>
    </>
  );
}

const CONTACT_FIELD_LABEL: Record<string, string> = { email: 'email address', phone: 'phone number' };

function ContactSavedNote({ saved, candidateId }: { saved: ContactSaved; candidateId: string }) {
  const changed = saved.changedFields.map((f) => CONTACT_FIELD_LABEL[f] ?? f);
  return (
    <div className="wide" role="status">
      <p className="ok">{changed.length > 0 ? `Private contact saved: ${changed.join(' and ')} changed.` : 'Private contact saved: nothing changed.'}</p>
      {saved.duplicateFlags.length > 0 && (
        <>
          <p>Flagged for duplicate review (nothing was merged):</p>
          <ul style={LIST} aria-label="New duplicate flags">
            {saved.duplicateFlags.map((f) => {
              const other = f.candidate.id === candidateId ? f.matchedCandidate : f.candidate;
              return (
                <li key={f.flagId}>
                  {labelOf(BASIS_LABEL, f.basis)} as <Link to={PATHS.candidate(other.id)}>{other.fullName}</Link> ({other.candidateCode})
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// CV and other candidate documents (confidential): scanned before release, released files only for download
// ---------------------------------------------------------------------------------------------------------

function CandidateDocuments({ candidate: c }: { candidate: CandidateView }) {
  const { can } = useSession();
  const keys = useKeys();
  const canRead = can(DOCUMENT_READ);
  const docs = useQuery({
    queryKey: keys.documents(c.id),
    enabled: canRead,
    queryFn: () => api<{ items: CandidateDocument[] }>(`/v1/hiring/candidates/${enc(c.id)}/documents`),
    retry: retryTransient,
  });
  const open = useMutation({ mutationFn: (d: CandidateDocument) => download(`/v1/hiring/candidate-documents/${enc(d.id)}/content`) });
  return (
    <Section title="CV and documents (confidential)">
      <p className="hint">Every file is scanned for malware and can be opened only once the scan releases it; each opening is recorded in the audit trail.</p>
      {canRead ? (
        <>
          {docs.isPending && <p className="hint">Loading documents…</p>}
          <LoadProblem error={docs.error} forbidden="The selected role cannot read this candidate’s documents." missing="This candidate is not available in the selected role’s scope." />
          {docs.data && docs.data.items.length === 0 && <Empty>No documents on record.</Empty>}
          {docs.data && docs.data.items.length > 0 && <DocumentTable items={docs.data.items} showCandidate={false} busy={open.isPending} onOpen={(d) => open.mutate(d)} label="Candidate documents" />}
          <Refusal error={open.error} words={DOWNLOAD_WORDS} />
        </>
      ) : (
        <p className="hint">The selected role can add documents to this candidate but not read them.</p>
      )}
      {can(DOCUMENT_UPLOAD) && <UploadDocumentForm candidateId={c.id} />}
    </Section>
  );
}

function DocumentTable({
  items,
  showCandidate,
  busy,
  onOpen,
  label,
}: {
  items: CandidateDocument[];
  showCandidate: boolean;
  busy: boolean;
  onOpen: (d: CandidateDocument) => void;
  label: string;
}) {
  const { can } = useSession();
  return (
    <div style={SCROLL}>
      <table aria-label={label}>
        <thead>
          <tr>
            {showCandidate && <th scope="col">Candidate</th>}
            <th scope="col">Type</th>
            <th scope="col">File</th>
            <th scope="col">Uploaded</th>
            <th scope="col">Malware scan</th>
            <th scope="col">
              <span style={SR_ONLY}>Download</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id}>
              {showCandidate && <td>{can(CANDIDATE_READ) ? <Link to={PATHS.candidate(d.candidateId)}>{d.candidateCode}</Link> : d.candidateCode}</td>}
              <td>{labelOf(DOCUMENT_TYPE_LABEL, d.documentType)}</td>
              <td>{d.fileName ?? '—'}</td>
              <td>{formatDate(d.uploadedAt)}</td>
              <td>
                <ScanBadge state={d.scanState} />
              </td>
              <td>
                {d.scanState === 'CLEAN' ? (
                  <button type="button" className="secondary" disabled={busy} aria-label={`Download ${d.fileName ?? labelOf(DOCUMENT_TYPE_LABEL, d.documentType)}`} onClick={() => onOpen(d)}>
                    Download
                  </button>
                ) : (
                  <span className="hint">{d.scanState === 'QUARANTINED' ? 'Never available' : 'Available once released'}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function uploadedText(scanState: string): string {
  if (scanState === 'QUARANTINED') return 'The file failed the malware scan and was quarantined: it can never be opened.';
  if (scanState === 'CLEAN') return 'Uploaded and released by the malware scan.';
  return 'Uploaded. The file is waiting for the malware scan and can be opened once it is released.';
}

function UploadDocumentForm({ candidateId }: { candidateId: string }) {
  const refresh = useRefresh();
  const id = useId();
  const [documentType, setDocumentType] = useState('CV');
  const [file, setFile] = useState<File | null>(null);
  // Remounting the file input clears the chosen file after an upload.
  const [inputKey, setInputKey] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: async ({ type, f }: { type: string; f: File }) =>
      api<DocumentUploaded>(`/v1/hiring/candidates/${enc(candidateId)}/documents`, { body: { documentType: type, fileName: f.name, contentBase64: await fileToBase64(f) } }),
    onSuccess: () => {
      setDocumentType('CV');
      setFile(null);
      setInputKey((k) => k + 1);
      setProblem(null);
      refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (upload.isPending) return;
    const missing = file === null ? 'Choose a file to upload.' : file.size > MAX_UPLOAD_BYTES ? 'Files can be at most 10 MB.' : null;
    setProblem(missing);
    if (missing || file === null) {
      upload.reset();
      return;
    }
    upload.mutate({ type: documentType, f: file });
  };
  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        Add a document
      </h3>
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <label>
          Document type
          <select value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
            {CANDIDATE_DOCUMENT_TYPES.map((t) => (
              <option key={t.code} value={t.code}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          File (PDF, JPEG or PNG, up to 10 MB)
          <input key={inputKey} type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <Problem text={problem} />
        {upload.error && (
          <div className="wide">
            <Refusal error={upload.error} words={UPLOAD_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={upload.isPending}>
            Upload
          </button>
        </div>
        {upload.isSuccess && <Done>{uploadedText(upload.data.scanState)}</Done>}
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// FR-013 CV search: file name, document type or candidate code within the candidate scope
// ---------------------------------------------------------------------------------------------------------

function CvSearchScreen() {
  const { can } = useSession();
  if (!can(DOCUMENT_READ)) return <Denied title="CV search">CVs are confidential: the selected role holds no candidate document grant.</Denied>;
  return (
    <>
      <h1>CV search</h1>
      <CvSearch />
    </>
  );
}

function CvSearch() {
  const keys = useKeys();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const hits = useQuery({
    queryKey: keys.cvSearch(term ?? ''),
    enabled: term !== null,
    queryFn: () => api<{ items: CandidateDocument[] }>(`/v1/hiring/candidate-documents?search=${enc(term ?? '')}`),
    retry: retryTransient,
  });
  const open = useMutation({ mutationFn: (d: CandidateDocument) => download(`/v1/hiring/candidate-documents/${enc(d.id)}/content`) });
  const items = hits.data?.items ?? [];
  return (
    <Section title="Search CV metadata">
      <form
        className="row"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const text = search.trim();
          setProblem(text ? null : 'Enter a file name, document type or candidate code.');
          if (text) setTerm(text);
        }}
      >
        <label className="inline">
          File name, document type or candidate code
          <input type="search" required maxLength={100} value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button type="submit" className="secondary">
          Search
        </button>
      </form>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <p className="hint">Only the metadata is searched. Files can be opened once the malware scan releases them; each opening is recorded in the audit trail.</p>
      {term !== null && hits.isPending && <p className="hint">Searching…</p>}
      <LoadProblem error={hits.error} forbidden="The selected role cannot search candidate documents." />
      {hits.data && items.length === 0 && <Empty>{`No documents match “${term ?? ''}”.`}</Empty>}
      {items.length > 0 && <DocumentTable items={items} showCandidate busy={open.isPending} onOpen={(d) => open.mutate(d)} label="Matching documents" />}
      {items.length >= LIMITS.cvSearch && <p className="hint">Showing the latest {LIMITS.cvSearch} matches; refine the search.</p>}
      <Refusal error={open.error} words={DOWNLOAD_WORDS} />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Applications of one requisition (one per candidate and requisition)
// ---------------------------------------------------------------------------------------------------------

function RequisitionApplicationsScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(APPLICATION_READ)) return <Denied title="Applications">The selected role cannot view applications.</Denied>;
  if (!UUID.test(id)) return <Missing title="Applications">This requisition is not available in the selected role’s scope.</Missing>;
  return <RequisitionApplications key={id} id={id} />;
}

function RequisitionApplications({ id }: { id: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const requisition = useQuery({
    queryKey: keys.requisition(id),
    enabled: can(REQUISITION_READ),
    queryFn: () => api<RequisitionView>(`/v1/hiring/requisitions/${enc(id)}`),
    retry: retryTransient,
  });
  const list = useQuery({ queryKey: keys.applications(id), queryFn: () => api<{ items: ApplicationRow[] }>(`/v1/hiring/applications?requisitionId=${enc(id)}`), retry: retryTransient });
  const items = list.data?.items ?? [];
  const r = requisition.data;
  const state = r?.state ?? items[0]?.requisition.state ?? null;
  const code = r?.code ?? items[0]?.requisition.code ?? null;
  return (
    <>
      <p>
        <Link to={PATHS.tracker}>← Hiring tracker</Link>
      </p>
      <h1>{code ? `Applications for ${code}` : 'Applications for the requisition'}</h1>
      {r && <RequisitionSummary r={r} />}
      <LoadProblem error={requisition.error} forbidden="The selected role cannot view this requisition." missing="This requisition is not available in the selected role’s scope." />
      <Section title={`Applications${list.data ? ` (${items.length})` : ''}`}>
        <p className="hint">One application per candidate and requisition. Each application is decided on its own: ending one never changes the candidate’s other applications.</p>
        {list.isPending && <p className="hint">Loading applications…</p>}
        <LoadProblem error={list.error} forbidden="The selected role cannot view applications." />
        {list.data && items.length === 0 && <Empty>No candidates have applied to this requisition yet.</Empty>}
        {items.length > 0 && <ApplicationTable items={items} showRequisition={false} label="Applications" />}
        {items.length >= LIMITS.applications && <p className="hint">Showing the first {LIMITS.applications} applications.</p>}
      </Section>
      {can(APPLICATION_MANAGE) &&
        can(CANDIDATE_READ) &&
        (state === null || state === 'APPROVED' ? (
          <AddApplicationPanel requisitionId={id} appliedCandidateIds={new Set(items.map((a) => a.candidate.id))} />
        ) : (
          <Section title="Add a candidate">
            <p className="hint">Candidates apply only to an approved requisition; this one is {labelOf(REQUISITION_STATE_LABEL, state).toLowerCase()}.</p>
          </Section>
        ))}
    </>
  );
}

function RequisitionSummary({ r }: { r: RequisitionView }) {
  return (
    <Section title="Requisition">
      <dl className="kv">
        <Item term="Requisition">
          {r.code} <span className="hint">{r.title}</span>
        </Item>
        <Item term="State">
          <RequisitionStateBadge state={r.state} />
        </Item>
        <Item term="Vacancies">{r.vacancies}</Item>
        <Item term="Filled">{r.filled}</Item>
        <Item term="Target date">{formatDate(r.targetDate)}</Item>
        {r.department && <Item term="Department">{r.department.name}</Item>}
        {r.location && <Item term="Location">{r.location.name}</Item>}
        {r.designation && <Item term="Designation">{r.designation.name}</Item>}
        {r.hiringManager && (
          <Item term="Hiring manager">
            {r.hiringManager.displayName} <span className="hint">{r.hiringManager.employeeCode}</span>
          </Item>
        )}
      </dl>
      <p>
        <Link to={PATHS.requisition(r.id)}>Open requisition {r.code}</Link>
      </p>
    </Section>
  );
}

function AddApplicationPanel({ requisitionId, appliedCandidateIds }: { requisitionId: string; appliedCandidateIds: ReadonlySet<string> }) {
  const keys = useKeys();
  const refresh = useRefresh();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState<string | null>(null);
  const qs = term === null ? '' : `picker:${candidateListQuery({ term, state: 'ACTIVE', page: 1 })}`;
  const hits = useQuery({
    queryKey: keys.candidates(qs),
    enabled: term !== null,
    queryFn: () => api<CandidatePage>(`/v1/hiring/candidates?${candidateListQuery({ term: term ?? '', state: 'ACTIVE', page: 1 })}`),
    retry: retryTransient,
  });
  const add = useMutation({
    mutationFn: (candidate: CandidateSummary) => api<ApplicationView>(`/v1/hiring/requisitions/${enc(requisitionId)}/applications`, { body: { candidateId: candidate.id } }),
    onSuccess: () => refresh(),
    // Applied meanwhile, or the requisition or the candidate moved on: the lists are read again to show the server's state.
    onError: (error) => {
      if (isConflict(error)) refresh();
    },
  });
  return (
    <Section title="Add a candidate">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(search.trim());
        }}
      >
        <label className="inline">
          Find an active candidate
          <input type="search" maxLength={100} value={search} placeholder="Code, name or skill" onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button type="submit" className="secondary">
          Search candidates
        </button>
      </form>
      {term !== null && hits.isPending && <p className="hint">Searching…</p>}
      <LoadProblem error={hits.error} forbidden="The selected role cannot search the candidate register." />
      {hits.data && hits.data.items.length === 0 && <Empty>No active candidates match.</Empty>}
      {hits.data && hits.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Active candidates">
            <thead>
              <tr>
                <th scope="col">Candidate</th>
                <th scope="col">Skills</th>
                <th scope="col">
                  <span style={SR_ONLY}>Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {hits.data.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.fullName} <span className="hint">{c.candidateCode}</span>
                  </td>
                  <td>{c.skills.length > 0 ? c.skills.join(', ') : '—'}</td>
                  <td>
                    {appliedCandidateIds.has(c.id) ? (
                      <span className="hint">Already applied</span>
                    ) : (
                      <button type="button" disabled={add.isPending} aria-label={`Add ${c.fullName} (${c.candidateCode}) to this requisition`} onClick={() => add.mutate(c)}>
                        Add to this requisition
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hits.data.total > hits.data.items.length && <p className="hint">Showing the first {hits.data.items.length} of {hits.data.total}; refine the search.</p>}
        </div>
      )}
      <Refusal error={add.error} words={APPLY_WORDS} />
      {add.isSuccess && (
        <p className="ok" role="status">
          {add.data.candidate.fullName} ({add.data.candidate.candidateCode}) now has an application at the applied stage.{' '}
          <Link to={PATHS.application(add.data.id)}>Open the application</Link>
        </p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// One application: stage moves as the API allows, owner, history and its offers
// ---------------------------------------------------------------------------------------------------------

function ApplicationScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(APPLICATION_READ)) return <Denied title="Application">The selected role cannot view applications.</Denied>;
  if (!UUID.test(id)) return <Missing title="Application">This application is not available in the selected role’s scope.</Missing>;
  return <ApplicationDetail key={id} id={id} />;
}

function ApplicationDetail({ id }: { id: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const refresh = useRefresh();
  const userId = useUserId();
  const detail = useQuery({ queryKey: keys.application(id), queryFn: () => api<ApplicationView>(`/v1/hiring/applications/${enc(id)}`), retry: retryTransient });
  const a = detail.data;
  // A reload is about to replace the version an action would send: nothing is sent meanwhile.
  const reloading = detail.isFetching && !detail.isPending;
  return (
    <>
      {a && (
        <p>
          <Link to={PATHS.requisitionApplications(a.requisition.id)}>← Applications for {a.requisition.code}</Link>
        </p>
      )}
      <h1>{a ? `Application of ${a.candidate.fullName} (${a.candidate.candidateCode}) for ${a.requisition.code}` : 'Application'}</h1>
      {detail.isPending && <p className="hint">Loading the application…</p>}
      <LoadProblem error={detail.error} forbidden="The selected role cannot view this application." missing="This application is not available in the selected role’s scope." />
      {a && (
        <>
          <Section title="Application">
            <dl className="kv">
              <Item term="Candidate">
                <CandidateLink candidate={a.candidate} withState />
              </Item>
              <Item term="Requisition">
                {a.requisition.code} <span className="hint">{a.requisition.title}</span> <RequisitionStateBadge state={a.requisition.state} />
              </Item>
              <Item term="Stage">
                <StageBadge stage={a.stage} />
              </Item>
              <Item term="In stage since">{formatDate(a.stageEnteredAt)}</Item>
              <Item term="Ageing">{ageing(a.ageingDays)}</Item>
              <Item term="Owner">{personText(a.owner, userId)}</Item>
              <Item term="Pending action">{a.pendingAction ? labelOf(PENDING_ACTION_LABEL, a.pendingAction) : '—'}</Item>
            </dl>
            {can(APPLICATION_MANAGE) && OPEN_STAGES.includes(a.stage) && <OwnerAction application={a} busy={reloading} onDone={refresh} />}
          </Section>
          {can(APPLICATION_MANAGE) && <StageActions application={a} busy={reloading} onDone={refresh} />}
          <Section title="Stage history">
            {a.history.length === 0 ? (
              <Empty>No stage changes recorded.</Empty>
            ) : (
              <div style={SCROLL}>
                <table aria-label="Stage history">
                  <thead>
                    <tr>
                      <th scope="col">From</th>
                      <th scope="col">To</th>
                      <th scope="col">Note</th>
                      <th scope="col">By</th>
                      <th scope="col">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.history.map((h, index) => (
                      <tr key={`${h.occurredAt}-${index}`}>
                        <td>{h.fromStage ? labelOf(STAGE_LABEL, h.fromStage) : '—'}</td>
                        <td>{labelOf(STAGE_LABEL, h.toStage)}</td>
                        <td>{h.note ?? '—'}</td>
                        <td>{userId !== null && h.actorUserId === userId ? 'You' : 'Another user'}</td>
                        <td>{formatDate(h.occurredAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
          <ApplicationOffers application={a} busy={reloading} onDone={refresh} />
        </>
      )}
    </>
  );
}

function OwnerAction({ application: a, busy, onDone }: { application: ApplicationView; busy: boolean; onDone: () => void }) {
  const userId = useUserId();
  const assign = useMutation({
    mutationFn: (body: { ownerUserId: string; expectedVersion: number }) =>
      api<{ applicationId: string; ownerUserId: string; version: number }>(`/v1/hiring/applications/${enc(a.id)}/owner`, { method: 'PUT', body }),
    onSuccess: onDone,
    onError: (error) => {
      if (isConflict(error)) onDone();
    },
  });
  if (userId === null) return null;
  return (
    <>
      {a.owner.userId !== userId && (
        <div className="row">
          <button type="button" className="secondary" disabled={busy || assign.isPending} onClick={() => assign.mutate({ ownerUserId: userId, expectedVersion: a.version })}>
            Assign to me
          </button>
        </div>
      )}
      {assign.isSuccess && a.owner.userId === userId && (
        <p className="ok" role="status">
          You now own this application.
        </p>
      )}
      <Refusal error={assign.error} words={STAGE_WORDS} />
    </>
  );
}

function StageActions({ application: a, busy, onDone }: { application: ApplicationView; busy: boolean; onDone: () => void }) {
  const id = useId();
  const [note, setNote] = useState('');
  const [ending, setEnding] = useState<'' | 'REJECTED' | 'WITHDRAWN'>('');
  const [endNote, setEndNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const move = useMutation({
    mutationFn: (body: { toStage: string; note?: string; expectedVersion: number }) => api<StageMoved>(`/v1/hiring/applications/${enc(a.id)}/stage`, { body }),
    onSuccess: () => {
      setNote('');
      setEnding('');
      setEndNote('');
      setProblem(null);
      onDone();
    },
    // A stale version or an application that moved on: reload it, so a retry uses its current version and stage.
    onError: (error) => {
      if (isConflict(error)) onDone();
    },
  });
  const disabled = busy || move.isPending;
  const next = NEXT_STAGE[a.stage];
  const openOffer = a.offers.some((o) => OPEN_OFFER_STATES.includes(o.state));
  // The API moves an application forward only on an approved requisition and an active candidate record.
  const forwardBlocked =
    a.requisition.state !== 'APPROVED'
      ? 'The requisition is no longer approved, so the application cannot move forward. It can still be ended.'
      : a.candidate.state !== 'ACTIVE'
        ? 'The candidate record is not active, so the application cannot move forward. It can still be ended.'
        : null;
  const result = move.isSuccess ? move.data : undefined;
  const resultText = result
    ? result.stage === 'REJECTED' || result.stage === 'WITHDRAWN'
      ? `The application was ${labelOf(STAGE_LABEL, result.stage).toLowerCase()}. The candidate record and the candidate’s other applications are unchanged.`
      : `The application is now at the ${labelOf(STAGE_LABEL, result.stage).toLowerCase()} stage.`
    : null;

  if (!OPEN_STAGES.includes(a.stage)) {
    return (
      <Section title="Stage">
        {resultText && (
          <p className="ok" role="status">
            {resultText}
          </p>
        )}
        <p className="hint">This application has ended ({labelOf(STAGE_LABEL, a.stage).toLowerCase()}); its stage no longer changes.</p>
      </Section>
    );
  }

  const forward = (e: FormEvent) => {
    e.preventDefault();
    if (disabled || !next) return;
    setProblem(null);
    move.mutate({ toStage: next, ...(note.trim() ? { note: note.trim() } : {}), expectedVersion: a.version });
  };
  const end = (e: FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    const text = endNote.trim();
    const missing = ending === '' ? 'Choose how the application ends.' : !text ? 'Record why the application ends.' : null;
    setProblem(missing);
    if (missing || ending === '') {
      move.reset();
      return;
    }
    move.mutate({ toStage: ending, note: text, expectedVersion: a.version });
  };

  return (
    <Section title="Stage">
      {resultText && (
        <p className="ok" role="status">
          {resultText}
        </p>
      )}
      {next && forwardBlocked ? (
        <p className="hint">{forwardBlocked}</p>
      ) : next ? (
        <form className="grid-form" aria-label="Move forward" onSubmit={forward} noValidate>
          <label className="wide">
            Note on the move (optional)
            <textarea maxLength={1000} rows={2} value={note} onChange={(e) => setNote(e.target.value)} style={TEXTAREA} />
          </label>
          <div className="wide row">
            <button type="submit" disabled={disabled}>
              Move to {labelOf(STAGE_LABEL, next).toLowerCase()}
            </button>
          </div>
        </form>
      ) : (
        <p className="hint">At the offer stage the application becomes hired only through the handover of its accepted offer.</p>
      )}
      <form className="grid-form" aria-label="End the application" onSubmit={end} noValidate>
        <fieldset className="wide" style={GROUP}>
          <legend>End this application</legend>
          <div className="row">
            <label className="check">
              <input type="radio" name={`${id}-end`} value="REJECTED" checked={ending === 'REJECTED'} onChange={() => setEnding('REJECTED')} /> Rejected
            </label>
            <label className="check">
              <input type="radio" name={`${id}-end`} value="WITHDRAWN" checked={ending === 'WITHDRAWN'} onChange={() => setEnding('WITHDRAWN')} /> Withdrawn
            </label>
          </div>
        </fieldset>
        <label className="wide">
          Why the application ends (required)
          <textarea required maxLength={1000} rows={2} value={endNote} onChange={(e) => setEndNote(e.target.value)} style={TEXTAREA} />
        </label>
        <p className="hint wide">This ends this application only: the candidate record and the candidate’s applications to other requisitions stay as they are.</p>
        {openOffer && <p className="hint wide">This application has an open offer: withdraw the offer before ending the application.</p>}
        <Problem text={problem} />
        <div className="wide row">
          <button type="submit" className="danger" disabled={disabled}>
            End the application
          </button>
        </div>
      </form>
      <Refusal error={move.error} words={STAGE_WORDS} />
    </Section>
  );
}

function ApplicationOffers({ application: a, busy, onDone }: { application: ApplicationView; busy: boolean; onDone: () => void }) {
  const { can } = useSession();
  const canOpen = can(OFFER_READ) || can(COMPENSATION_READ);
  const openOffer = a.offers.some((o) => OPEN_OFFER_STATES.includes(o.state));
  // Kept here: the form goes once the new draft shows in the list.
  const [created, setCreated] = useState<OfferView | null>(null);
  return (
    <Section title={`Offers (${a.offers.length})`}>
      {created && (
        <p className="ok" role="status">
          Draft offer prepared. {canOpen && <Link to={PATHS.offer(created.id)}>Open the draft offer</Link>}
        </p>
      )}
      {a.offers.length === 0 ? (
        <Empty>No offers yet.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label="Offers of the application">
            <thead>
              <tr>
                <th scope="col">State</th>
                <th scope="col">Proposed joining date</th>
                <th scope="col">Revision</th>
                <th scope="col">Prepared</th>
                {canOpen && (
                  <th scope="col">
                    <span style={SR_ONLY}>Offer</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {a.offers.map((o) => (
                <tr key={o.id}>
                  <td>
                    <OfferStateBadge state={o.state} />
                  </td>
                  <td>{formatDate(o.proposedJoiningDate)}</td>
                  <td>{o.currentRevision > 0 ? o.currentRevision : 'Not submitted'}</td>
                  <td>{formatDate(o.createdAt)}</td>
                  {canOpen && (
                    <td>
                      <Link to={PATHS.offer(o.id)} aria-label={`Open the offer of ${formatDate(o.createdAt)}`}>
                        Open
                      </Link>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can(OFFER_MANAGE) &&
        a.stage === 'OFFER' &&
        !openOffer &&
        (a.requisition.state === 'APPROVED' && a.candidate.state === 'ACTIVE' ? (
          <PrepareOfferForm
            applicationId={a.id}
            busy={busy}
            onCreated={(offer) => {
              setCreated(offer);
              onDone();
            }}
            onConflict={onDone}
          />
        ) : (
          <p className="hint">An offer needs an approved requisition and an active candidate record.</p>
        ))}
      {can(OFFER_MANAGE) && OPEN_STAGES.includes(a.stage) && a.stage !== 'OFFER' && <p className="hint">An offer is prepared once the application reaches the offer stage.</p>}
    </Section>
  );
}

function PrepareOfferForm({
  applicationId,
  busy,
  onCreated,
  onConflict,
}: {
  applicationId: string;
  busy: boolean;
  onCreated: (offer: OfferView) => void;
  onConflict: () => void;
}) {
  const id = useId();
  const [joining, setJoining] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: { proposedJoiningDate: string }) => api<OfferView>(`/v1/hiring/applications/${enc(applicationId)}/offers`, { body }),
    onSuccess: (offer) => {
      setJoining('');
      setProblem(null);
      onCreated(offer);
    },
    onError: (error) => {
      if (isConflict(error)) onConflict();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending || busy) return;
    setProblem(joining ? null : 'Enter the proposed joining date.');
    if (!joining) {
      create.reset();
      return;
    }
    create.mutate({ proposedJoiningDate: joining });
  };
  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        Prepare an offer
      </h3>
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <label>
          Proposed joining date (required)
          <input type="date" required value={joining} onChange={(e) => setJoining(e.target.value)} />
        </label>
        <p className="hint wide">The offer starts as a draft. An eligible Admin records its confidential compensation before it is submitted for independent approval.</p>
        <Problem text={problem} />
        {create.error && (
          <div className="wide">
            <Refusal error={create.error} words={OFFER_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={create.isPending || busy}>
            Prepare draft offer
          </button>
        </div>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Offers (F1): an approved requisition, a confidential compensation, independent approval, response and handover
// ---------------------------------------------------------------------------------------------------------

function OffersScreen() {
  const { can } = useSession();
  const canApprove = can(COMPENSATION_APPROVE);
  if (!can(OFFER_READ) && !canApprove) return <Denied title="Offers">The selected role cannot view offers.</Denied>;
  return (
    <>
      <h1>Offers</h1>
      {canApprove && <OfferApprovalList />}
      {can(OFFER_READ) ? (
        <OfferList />
      ) : (
        <Section title="All offers">
          <NotPermitted>The selected role cannot list offers.</NotPermitted>
        </Section>
      )}
    </>
  );
}

function OfferList() {
  const keys = useKeys();
  const [state, setState] = useState('');
  const list = useQuery({ queryKey: keys.offers(state), queryFn: () => api<{ items: OfferSummary[] }>(`/v1/hiring/offers${state ? `?state=${state}` : ''}`), retry: retryTransient });
  const items = list.data?.items ?? [];
  return (
    <Section title={`All offers${list.data ? ` (${items.length})` : ''}`}>
      <label className="inline">
        State
        <select value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">All states</option>
          {OFFER_STATES.map((s) => (
            <option key={s} value={s}>
              {labelOf(OFFER_STATE_LABEL, s)}
            </option>
          ))}
        </select>
      </label>
      {list.isPending && <p className="hint">Loading offers…</p>}
      <LoadProblem error={list.error} forbidden="The selected role cannot list offers." />
      {list.data && items.length === 0 && <Empty>No offers to show.</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Offers">
            <thead>
              <tr>
                <th scope="col">Candidate</th>
                <th scope="col">Requisition</th>
                <th scope="col">State</th>
                <th scope="col">Proposed joining date</th>
                <th scope="col">Revision</th>
                <th scope="col">Prepared</th>
                <th scope="col">
                  <span style={SR_ONLY}>Offer</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.id}>
                  <td>
                    {o.candidate.fullName} <span className="hint">{o.candidate.candidateCode}</span>
                  </td>
                  <td>
                    {o.requisition.code} <span className="hint">{o.requisition.title}</span>
                  </td>
                  <td>
                    <OfferStateBadge state={o.state} />
                  </td>
                  <td>{formatDate(o.proposedJoiningDate)}</td>
                  <td>{o.currentRevision > 0 ? o.currentRevision : 'Not submitted'}</td>
                  <td>{formatDate(o.createdAt)}</td>
                  <td>
                    <Link to={PATHS.offer(o.id)} aria-label={`Open the offer to ${o.candidate.fullName} (${o.candidate.candidateCode})`}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {items.length >= LIMITS.offers && <p className="hint">Showing the latest {LIMITS.offers} offers.</p>}
    </Section>
  );
}

function OfferScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(OFFER_READ) && !can(COMPENSATION_READ)) return <Denied title="Offer">The selected role cannot view offers.</Denied>;
  if (!UUID.test(id)) return <Missing title="Offer">This offer is not available in the selected role’s scope.</Missing>;
  return <OfferDetail key={id} id={id} />;
}

function OfferDetail({ id }: { id: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const refresh = useRefresh();
  const userId = useUserId();
  const [notice, setNotice] = useState<string | null>(null);
  const detail = useQuery({ queryKey: keys.offer(id), queryFn: () => api<OfferView>(`/v1/hiring/offers/${enc(id)}`), retry: retryTransient });
  const o = detail.data;
  // A reload is about to replace the version an action would send: nothing is sent meanwhile.
  const reloading = detail.isFetching && !detail.isPending;
  const done = (text?: string) => {
    setNotice(text ?? null);
    refresh();
  };
  const withReasons = o?.decisions.some((d) => d.reason !== undefined) ?? false;
  const closed = o !== undefined && !OPEN_OFFER_STATES.includes(o.state);
  return (
    <>
      {o && (
        <p>
          <Link to={PATHS.offers}>← Offers</Link>
        </p>
      )}
      <h1>{o ? `Offer to ${o.candidate.fullName} (${o.candidate.candidateCode}) for ${o.requisition.code}` : 'Offer'}</h1>
      {detail.isPending && <p className="hint">Loading the offer…</p>}
      <LoadProblem error={detail.error} forbidden="The selected role cannot view this offer." missing="This offer is not available in the selected role’s scope." />
      {o && (
        <>
          <Section title="Offer">
            <dl className="kv">
              <Item term="Candidate">
                <CandidateLink candidate={o.candidate} />
              </Item>
              <Item term="Requisition">
                {o.requisition.code} <span className="hint">{o.requisition.title}</span> <RequisitionStateBadge state={o.requisition.state} />
              </Item>
              <Item term="Application">
                {can(APPLICATION_READ) ? <Link to={PATHS.application(o.application.id)}>{labelOf(STAGE_LABEL, o.application.stage)}</Link> : labelOf(STAGE_LABEL, o.application.stage)}
              </Item>
              <Item term="State">
                <OfferStateBadge state={o.state} />
              </Item>
              <Item term="Proposed joining date">{formatDate(o.proposedJoiningDate)}</Item>
              <Item term="Revision">{o.currentRevision > 0 ? `Revision ${o.currentRevision}` : 'Not submitted yet'}</Item>
              {o.preparedBy === userId && <Item term="Prepared by">You</Item>}
              {o.submittedAt && <Item term="Submitted">{`${formatDate(o.submittedAt)}${o.submittedBy === userId ? ' by you' : ''}`}</Item>}
              {o.decidedAt && <Item term="Decided">{formatDate(o.decidedAt)}</Item>}
              {o.candidateResponseOn && <Item term="Candidate responded on">{formatDate(o.candidateResponseOn)}</Item>}
              {o.withdrawnAt && <Item term="Withdrawn">{formatDate(o.withdrawnAt)}</Item>}
              {o.withdrawnReason && <Item term="Withdrawal reason">{o.withdrawnReason}</Item>}
            </dl>
            {o.state === 'SUBMITTED' && o.pendingWith && (
              <p>
                Waiting for approval by {personText(o.pendingWith.assignee, userId)} since {formatDate(o.pendingWith.assignedAt)}.
              </p>
            )}
            {o.state === 'SUBMITTED' && o.pendingWith && o.pendingWith.assignee.userId === userId && can(COMPENSATION_APPROVE) && (
              <p className="hint">
                It waits for your decision under <Link to={PATHS.offers}>Offer approvals</Link>.
              </p>
            )}
            {o.requisition.state !== 'APPROVED' && OPEN_OFFER_STATES.includes(o.state) && !o.handedOverEmployeeId && (
              <p className="hint">The requisition is no longer approved: the offer cannot be accepted or handed over.</p>
            )}
            {closed && !o.handedOverEmployeeId && (
              <p className="hint">This offer is closed. A new offer can be prepared from the application, or the application ended.</p>
            )}
          </Section>
          {notice && (
            <p className="ok" role="status">
              {notice}
            </p>
          )}
          {o.compensation && <CompensationView compensation={o.compensation} userId={userId} />}
          <OfferActions offer={o} busy={reloading} onDone={done} />
          {o.state === 'ACCEPTED' && !o.handedOverEmployeeId && can(HANDOVER) && (
            <HandoverSection offer={o} busy={reloading} onDone={(result) => done(`Employee draft created (status: ${labelOf(EMPLOYEE_STATUS_LABEL, result.employeeStatus).toLowerCase()}). It is not active.`)} />
          )}
          {o.handedOverEmployeeId && <Onboarding employeeId={o.handedOverEmployeeId} />}
          <Section title="Approval history">
            {o.decisions.length === 0 ? (
              <Empty>No approval decisions yet.</Empty>
            ) : (
              <div style={SCROLL}>
                <table aria-label="Approval history">
                  <thead>
                    <tr>
                      <th scope="col">Revision</th>
                      <th scope="col">Decision</th>
                      <th scope="col">Decided by</th>
                      <th scope="col">When</th>
                      {withReasons && <th scope="col">Reason</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {o.decisions.map((d, index) => (
                      <tr key={`${d.decidedAt}-${index}`}>
                        <td>{d.revision}</td>
                        <td>{labelOf(DECISION_LABEL, d.decision)}</td>
                        <td>{personText(d.decidedBy, userId)}</td>
                        <td>{formatDate(d.decidedAt)}</td>
                        {withReasons && <td>{d.reason ?? '—'}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </>
  );
}

/** Confidential (offer.compensation): rendered only when the server returned it to this caller. */
function CompensationView({ compensation: c, userId }: { compensation: NonNullable<OfferView['compensation']>; userId: string | null }) {
  return (
    <Section title="Compensation (confidential)">
      {c.current ? (
        <dl className="kv" aria-label="Current compensation">
          <Item term="Currency">{c.current.currencyCode}</Item>
          <Item term="Annual CTC">
            <Money value={c.current.annualCtc} currency={c.current.currencyCode} />
          </Item>
          <Item term="Monthly gross">
            <Money value={c.current.monthlyGross} currency={c.current.currencyCode} />
          </Item>
          <Item term="Recorded">{`${formatDate(c.current.updatedAt)}${c.current.setBy === userId ? ' by you' : ''}`}</Item>
        </dl>
      ) : (
        <Empty>No compensation recorded yet.</Empty>
      )}
      {c.revisions.length > 0 && (
        <>
          <h3 style={H3}>Submitted revisions</h3>
          <div style={SCROLL}>
            <table aria-label="Submitted revisions">
              <thead>
                <tr>
                  <th scope="col">Revision</th>
                  <th scope="col">Proposed joining date</th>
                  <th scope="col">Annual CTC</th>
                  <th scope="col">Monthly gross</th>
                  <th scope="col">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {c.revisions.map((r) => (
                  <tr key={r.revision}>
                    <td>{r.revision}</td>
                    <td>{formatDate(r.proposedJoiningDate)}</td>
                    <td>
                      <Money value={r.annualCtc} currency={r.currencyCode} />
                    </td>
                    <td>
                      <Money value={r.monthlyGross} currency={r.currencyCode} />
                    </td>
                    <td>{formatDate(r.submittedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Section>
  );
}

function OfferActions({ offer: o, busy, onDone }: { offer: OfferView; busy: boolean; onDone: (notice?: string) => void }) {
  const { can } = useSession();
  const manage = can(OFFER_MANAGE);
  const draft = o.state === 'DRAFT';
  const withdrawable = OPEN_OFFER_STATES.includes(o.state) && !o.handedOverEmployeeId;
  const priceIt = draft && can(COMPENSATION_MANAGE);
  if (!(draft && manage) && !priceIt && !(o.state === 'APPROVED' && manage) && !(withdrawable && manage)) return null;
  return (
    <Section title="Offer actions">
      {o.state === 'SUBMITTED' && <p className="hint">An independent eligible Admin decides this revision; meanwhile the offer can only be withdrawn.</p>}
      {draft && manage && <JoiningDateForm offer={o} busy={busy} onDone={onDone} />}
      {priceIt && <CompensationForm offer={o} busy={busy} onDone={onDone} />}
      {draft && manage && <SubmitOffer offer={o} busy={busy} onDone={onDone} />}
      {o.state === 'APPROVED' && manage && <ResponseForm offer={o} busy={busy} onDone={onDone} />}
      {withdrawable && manage && <WithdrawForm offer={o} busy={busy} onDone={onDone} />}
    </Section>
  );
}

function JoiningDateForm({ offer: o, busy, onDone }: { offer: OfferView; busy: boolean; onDone: (notice?: string) => void }) {
  const id = useId();
  const [joining, setJoining] = useState(o.proposedJoiningDate);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: { proposedJoiningDate: string; expectedVersion: number }) => api<{ offerId: string; version: number }>(`/v1/hiring/offers/${enc(o.id)}`, { method: 'PUT', body }),
    onSuccess: (_result, body) => {
      setProblem(null);
      onDone(`Proposed joining date saved: ${formatDate(body.proposedJoiningDate)}.`);
    },
    onError: (error) => {
      if (isConflict(error)) onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending || busy) return;
    setProblem(joining ? null : 'Enter the proposed joining date.');
    if (!joining) {
      save.reset();
      return;
    }
    save.mutate({ proposedJoiningDate: joining, expectedVersion: o.version });
  };
  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        Terms
      </h3>
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <label>
          Proposed joining date (required)
          <input type="date" required value={joining} onChange={(e) => setJoining(e.target.value)} />
        </label>
        <Problem text={problem} />
        {save.error && (
          <div className="wide">
            <Refusal error={save.error} words={OFFER_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={save.isPending || busy}>
            Save joining date
          </button>
        </div>
      </form>
    </>
  );
}

/**
 * The confidential compensation of a draft offer. Recording replaces the whole compensation, so the form starts from
 * the current values when the server returned them. Amounts travel as the decimal strings typed (format checked only).
 */
function CompensationForm({ offer: o, busy, onDone }: { offer: OfferView; busy: boolean; onDone: (notice?: string) => void }) {
  const id = useId();
  const current = o.compensation?.current ?? null;
  const [currency, setCurrency] = useState(current?.currencyCode ?? 'INR');
  const [annual, setAnnual] = useState(current?.annualCtc ?? '');
  const [monthly, setMonthly] = useState(current?.monthlyGross ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: { currencyCode: string; annualCtc?: string; monthlyGross?: string; expectedVersion: number }) =>
      api<{ offerId: string; version: number }>(`/v1/hiring/offers/${enc(o.id)}/compensation`, { method: 'PUT', body }),
    onSuccess: () => {
      // A caller the API does not show the compensation to starts the form clean again: the amounts typed are not kept on
      // screen. A caller who reads it keeps the values just recorded, which the reloaded offer shows as well.
      if (!o.compensation) {
        setCurrency('INR');
        setAnnual('');
        setMonthly('');
      }
      setProblem(null);
      onDone('Compensation recorded.');
    },
    onError: (error) => {
      if (isConflict(error)) onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending || busy) return;
    const code = currency.trim().toUpperCase();
    const a = annual.trim();
    const m = monthly.trim();
    const missing = !CURRENCY.test(code)
      ? 'Enter a three-letter currency code, such as INR.'
      : !a && !m
        ? 'Enter the annual CTC, the monthly gross or both.'
        : (a && !MONEY.test(a)) || (m && !MONEY.test(m))
          ? 'Enter amounts as digits with up to 4 decimal places and no separators, for example 1200000.00.'
          : null;
    setProblem(missing);
    if (missing) {
      save.reset();
      return;
    }
    save.mutate({ currencyCode: code, ...(a ? { annualCtc: a } : {}), ...(m ? { monthlyGross: m } : {}), expectedVersion: o.version });
  };
  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        Compensation (confidential)
      </h3>
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <label>
          Currency
          <input required maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </label>
        <label>
          Annual CTC
          <input inputMode="decimal" maxLength={20} value={annual} onChange={(e) => setAnnual(e.target.value)} />
        </label>
        <label>
          Monthly gross
          <input inputMode="decimal" maxLength={20} value={monthly} onChange={(e) => setMonthly(e.target.value)} />
        </label>
        <p className="hint wide">
          Recording replaces the whole compensation: give every amount that applies. Whoever records it cannot approve the offer, and the amounts never appear in
          notifications or the audit trail.
        </p>
        <Problem text={problem} />
        {save.error && (
          <div className="wide">
            <Refusal error={save.error} words={COMPENSATION_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={save.isPending || busy}>
            Record compensation
          </button>
        </div>
      </form>
    </>
  );
}

function SubmitOffer({ offer: o, busy, onDone }: { offer: OfferView; busy: boolean; onDone: (notice?: string) => void }) {
  const submit = useMutation({
    mutationFn: (body: { expectedVersion: number }) => api<{ offerId: string; state: string; revision: number }>(`/v1/hiring/offers/${enc(o.id)}/submit`, { body }),
    onSuccess: (result) => onDone(`Offer submitted for independent approval (revision ${result.revision}).`),
    onError: (error) => {
      if (isConflict(error)) onDone();
    },
  });
  return (
    <>
      <h3 style={H3}>Submit for approval</h3>
      <p className="hint">
        Submitting pins these terms and the compensation as revision {o.currentRevision + 1} for an independent eligible Admin, who is never the person who
        prepared the offer, recorded its compensation or submits it.
      </p>
      <div className="row">
        <button type="button" disabled={submit.isPending || busy} onClick={() => submit.mutate({ expectedVersion: o.version })}>
          Submit for approval
        </button>
      </div>
      <Refusal error={submit.error} words={OFFER_WORDS} />
    </>
  );
}

function ResponseForm({ offer: o, busy, onDone }: { offer: OfferView; busy: boolean; onDone: (notice?: string) => void }) {
  const id = useId();
  const [response, setResponse] = useState<'' | 'ACCEPTED' | 'DECLINED'>('');
  const [respondedOn, setRespondedOn] = useState(() => localDate());
  const [problem, setProblem] = useState<string | null>(null);
  const record = useMutation({
    mutationFn: (body: { response: 'ACCEPTED' | 'DECLINED'; respondedOn: string; expectedVersion: number }) =>
      api<{ offerId: string; state: string }>(`/v1/hiring/offers/${enc(o.id)}/response`, { body }),
    onSuccess: (result) => {
      setResponse('');
      setRespondedOn(localDate());
      setProblem(null);
      onDone(result.state === 'ACCEPTED' ? 'Recorded the candidate’s acceptance.' : 'Recorded that the candidate declined the offer.');
    },
    onError: (error) => {
      if (isConflict(error)) onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (record.isPending || busy) return;
    const missing = response === '' ? 'Choose whether the candidate accepted or declined.' : !respondedOn ? 'Enter the date of the response.' : null;
    setProblem(missing);
    if (missing || response === '') {
      record.reset();
      return;
    }
    record.mutate({ response, respondedOn, expectedVersion: o.version });
  };
  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        The candidate’s response
      </h3>
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <fieldset className="wide" style={GROUP}>
          <legend>Response</legend>
          <div className="row">
            <label className="check">
              <input type="radio" name={`${id}-response`} value="ACCEPTED" checked={response === 'ACCEPTED'} onChange={() => setResponse('ACCEPTED')} /> Accepted
            </label>
            <label className="check">
              <input type="radio" name={`${id}-response`} value="DECLINED" checked={response === 'DECLINED'} onChange={() => setResponse('DECLINED')} /> Declined
            </label>
          </div>
        </fieldset>
        <label>
          Responded on (required)
          <input type="date" required value={respondedOn} onChange={(e) => setRespondedOn(e.target.value)} />
        </label>
        <p className="hint wide">An acceptance needs the requisition still approved and an open vacancy; the response date cannot be in the future.</p>
        <Problem text={problem} />
        {record.error && (
          <div className="wide">
            <Refusal error={record.error} words={OFFER_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={record.isPending || busy}>
            Record response
          </button>
        </div>
      </form>
    </>
  );
}

function WithdrawForm({ offer: o, busy, onDone }: { offer: OfferView; busy: boolean; onDone: (notice?: string) => void }) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const withdraw = useMutation({
    mutationFn: (body: { reason: string }) => api<{ offerId: string; state: string }>(`/v1/hiring/offers/${enc(o.id)}/withdraw`, { body }),
    onSuccess: () => {
      setReason('');
      setProblem(null);
      onDone('Offer withdrawn.');
    },
    onError: (error) => {
      if (isConflict(error)) onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (withdraw.isPending || busy) return;
    const text = reason.trim();
    setProblem(text ? null : 'Enter why the offer is withdrawn.');
    if (!text) {
      withdraw.reset();
      return;
    }
    withdraw.mutate({ reason: text });
  };
  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        Withdraw the offer
      </h3>
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <label className="wide">
          Reason for withdrawing (required)
          <textarea required maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
        </label>
        {o.state === 'SUBMITTED' && <p className="hint wide">Withdrawing cancels the approval that is waiting.</p>}
        <Problem text={problem} />
        {withdraw.error && (
          <div className="wide">
            <Refusal error={withdraw.error} words={OFFER_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" className="danger" disabled={withdraw.isPending || busy}>
            Withdraw offer
          </button>
        </div>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// FR-014 handover: a reviewed employee DRAFT from validated fields and approved documents, at most once per offer
// ---------------------------------------------------------------------------------------------------------

function HandoverSection({ offer: o, busy, onDone }: { offer: OfferView; busy: boolean; onDone: (result: HandoverResult) => void }) {
  const { can } = useSession();
  return (
    <Section title="Hand over to onboarding">
      {can(EMPLOYEE_CREATE) ? (
        <HandoverForm offer={o} busy={busy} onDone={onDone} />
      ) : (
        <NotPermitted>Handing over creates an employee, so it also needs the employee creation duty, which the selected role does not hold.</NotPermitted>
      )}
    </Section>
  );
}

interface HandoverBody {
  employeeCode: string;
  displayName?: string;
  workEmail?: string;
  documents?: { candidateDocumentId: string; documentType: string }[];
}

function HandoverForm({ offer: o, busy, onDone }: { offer: OfferView; busy: boolean; onDone: (result: HandoverResult) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const refresh = useRefresh();
  const id = useId();
  const withDocuments = can(DOCUMENT_READ) && can(EMPLOYEE_DOCUMENT_UPLOAD);
  const docs = useQuery({
    queryKey: keys.documents(o.candidate.id),
    enabled: withDocuments,
    queryFn: () => api<{ items: CandidateDocument[] }>(`/v1/hiring/candidates/${enc(o.candidate.id)}/documents`),
    retry: retryTransient,
  });
  const [employeeCode, setEmployeeCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [workEmail, setWorkEmail] = useState('');
  /** The documents chosen for transfer, in the order chosen, each with its employee document type. */
  const [chosen, setChosen] = useState<{ candidateDocumentId: string; documentType: string }[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const handover = useMutation({
    mutationFn: (body: HandoverBody) => api<HandoverResult>(`/v1/hiring/offers/${enc(o.id)}/handover`, { body }),
    onSuccess: (result) => {
      setEmployeeCode('');
      setDisplayName('');
      setWorkEmail('');
      setChosen([]);
      setProblem(null);
      onDone(result);
    },
    onError: (error) => {
      if (isConflict(error)) refresh();
    },
  });
  const toggle = (docId: string, on: boolean) =>
    setChosen((list) => (on ? [...list.filter((d) => d.candidateDocumentId !== docId), { candidateDocumentId: docId, documentType: DEFAULT_EMPLOYEE_DOCUMENT_TYPE }] : list.filter((d) => d.candidateDocumentId !== docId)));
  const setType = (docId: string, type: string) => setChosen((list) => list.map((d) => (d.candidateDocumentId === docId ? { ...d, documentType: type.toUpperCase() } : d)));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (handover.isPending || busy) return;
    const code = employeeCode.trim();
    const documents = chosen.map((d) => ({ candidateDocumentId: d.candidateDocumentId, documentType: d.documentType.trim().toUpperCase() }));
    const missing = !code
      ? 'Enter the new employee’s code.'
      : documents.length > MAX_HANDOVER_DOCUMENTS
        ? `Choose at most ${MAX_HANDOVER_DOCUMENTS} documents to transfer.`
        : documents.some((d) => !DOCUMENT_TYPE_CODE.test(d.documentType))
          ? 'Give each chosen document an employee document type: capital letters, digits or _, for example GENERAL.'
          : null;
    setProblem(missing);
    if (missing) {
      handover.reset();
      return;
    }
    handover.mutate({
      employeeCode: code,
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      ...(workEmail.trim() ? { workEmail: workEmail.trim() } : {}),
      ...(documents.length > 0 ? { documents } : {}),
    });
  };
  const already = handover.error instanceof ApiError && handover.error.code === 'ALREADY_HANDED_OVER' ? (handover.error.details as { employeeId?: string } | undefined)?.employeeId : undefined;
  const items = docs.data?.items ?? [];
  return (
    <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
      <h3 id={`${id}-title`} className="wide" style={H3}>
        Create the employee draft
      </h3>
      <p className="hint wide">
        The employee is created as a draft from the approved requisition (department, location, designation and employment type) and this accepted offer (joining
        date {formatDate(o.proposedJoiningDate)}). Hiring never activates employment: activation is the separate employee activation action. An accepted offer
        creates at most one employee.
      </p>
      <label>
        Employee code (required)
        <input required maxLength={40} value={employeeCode} onChange={(e) => setEmployeeCode(e.target.value)} />
      </label>
      <label>
        Display name (optional)
        <input maxLength={200} value={displayName} placeholder={o.candidate.fullName} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <label>
        Work email (optional)
        <input type="email" maxLength={254} value={workEmail} onChange={(e) => setWorkEmail(e.target.value)} />
      </label>
      <p className="hint wide">A blank display name uses the candidate’s name, {o.candidate.fullName}.</p>
      {withDocuments ? (
        <fieldset className="wide" style={GROUP}>
          <legend>Candidate documents to transfer (optional)</legend>
          {docs.isPending && <p className="hint">Loading the candidate’s documents…</p>}
          <LoadProblem error={docs.error} forbidden="The selected role cannot read this candidate’s documents." />
          {docs.data && items.length === 0 && <Empty>The candidate has no documents.</Empty>}
          {items.length > 0 && (
            <ul className="choices" aria-label="Candidate documents">
              {items.map((d) => {
                const pick = chosen.find((x) => x.candidateDocumentId === d.id);
                const name = d.fileName ?? labelOf(DOCUMENT_TYPE_LABEL, d.documentType);
                return (
                  <li key={d.id}>
                    {d.scanState === 'CLEAN' ? (
                      <label className="check">
                        <input type="checkbox" checked={pick !== undefined} onChange={(e) => toggle(d.id, e.target.checked)} /> {name} ({labelOf(DOCUMENT_TYPE_LABEL, d.documentType)})
                      </label>
                    ) : (
                      <span>
                        {name} <ScanBadge state={d.scanState} /> <span className="hint">only released files can be transferred</span>
                      </span>
                    )}
                    {pick && (
                      <label>
                        Employee document type for {name}
                        <input required maxLength={60} value={pick.documentType} onChange={(e) => setType(d.id, e.target.value)} />
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
      ) : (
        <p className="hint wide">Transferring candidate documents needs the candidate document read and employee document upload grants.</p>
      )}
      <Problem text={problem} />
      {handover.error && (
        <div className="wide">
          <Refusal error={handover.error} words={HANDOVER_WORDS} />
          {already && <Link to={PATHS.origin(already)}>Open the employee created from this offer</Link>}
        </div>
      )}
      <div className="wide row">
        <button type="submit" disabled={handover.isPending || busy}>
          Create employee draft
        </button>
      </div>
    </form>
  );
}

function Onboarding({ employeeId }: { employeeId: string }) {
  const { can } = useSession();
  return (
    <Section title="Onboarding">
      <p>
        Handed over to onboarding: this accepted offer created an employee draft. Hiring never activates employment; activation is the separate employee
        activation action.
      </p>
      {can(APPLICATION_READ) && (
        <p>
          <Link to={PATHS.origin(employeeId)}>Open the employee’s hiring record</Link>
        </p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// FR-014: the onboarding record traces back to its requisition, application, offer and candidate
// ---------------------------------------------------------------------------------------------------------

function EmployeeOriginScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(APPLICATION_READ)) return <Denied title="Hiring origin">The selected role cannot view the hiring pipeline.</Denied>;
  if (!UUID.test(id)) return <Missing title="Hiring origin">This employee is not available in the selected role’s scope.</Missing>;
  return <EmployeeOrigin key={id} employeeId={id} />;
}

function EmployeeOrigin({ employeeId }: { employeeId: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const origin = useQuery({ queryKey: keys.origin(employeeId), queryFn: () => api<Origin>(`/v1/hiring/employees/${enc(employeeId)}/origin`), retry: retryTransient });
  const employee = useQuery({
    queryKey: keys.employee(employeeId),
    enabled: can(EMPLOYEE_READ),
    queryFn: () => api<EmployeeRecord>(`/v1/employees/${enc(employeeId)}`),
    retry: retryTransient,
  });
  const e = employee.data;
  const h = origin.data;
  const documentsLink = can(EMPLOYEE_DOCUMENT_READ) || can(EMPLOYEE_DOCUMENT_UPLOAD);
  return (
    <>
      <h1>{e ? `Hiring origin of ${e.displayName} (${e.employeeCode})` : 'Hiring origin'}</h1>
      {can(EMPLOYEE_READ) && (
        <Section title="Employee record">
          {employee.isPending && <p className="hint">Loading the employee…</p>}
          <LoadProblem error={employee.error} forbidden="The selected role cannot view this employee." missing="This employee is not available in the selected role’s scope." />
          {e && (
            <>
              <dl className="kv">
                <Item term="Employee code">{e.employeeCode}</Item>
                <Item term="Name">{e.displayName}</Item>
                <Item term="Status">
                  <CodeBadge code={e.status} labels={EMPLOYEE_STATUS_LABEL} tones={EMPLOYEE_TONE} />
                </Item>
                <Item term="Joining date">{formatDate(e.joiningDate)}</Item>
                <Item term="Employment type">{labelOf({}, e.employmentType)}</Item>
                <Item term="Work email">{e.workEmail ?? '—'}</Item>
              </dl>
              {e.status === 'DRAFT' && <p className="hint">This employee is a draft. Hiring never activates employment: activation is the separate employee activation action.</p>}
            </>
          )}
          {documentsLink && (
            <p>
              <Link to={PATHS.employeeDocuments(employeeId)}>Employee documents</Link>
            </p>
          )}
        </Section>
      )}
      <Section title="Recruitment history">
        {origin.isPending && <p className="hint">Loading the hiring origin…</p>}
        <LoadProblem error={origin.error} forbidden="The selected role cannot view the hiring origin." missing="No hiring origin is recorded for this employee in the selected role’s scope." />
        {h && (
          <dl className="kv">
            <Item term="Requisition">
              <Link to={PATHS.requisitionApplications(h.requisition.id)}>{h.requisition.code}</Link> <span className="hint">{h.requisition.title}</span>
            </Item>
            <Item term="Application">
              <Link to={PATHS.application(h.application.id)}>{labelOf(STAGE_LABEL, h.application.stage)}</Link>
            </Item>
            <Item term="Offer">
              {can(OFFER_READ) || can(COMPENSATION_READ) ? (
                <Link to={PATHS.offer(h.offer.id)}>{labelOf(OFFER_STATE_LABEL, h.offer.state)}</Link>
              ) : (
                labelOf(OFFER_STATE_LABEL, h.offer.state)
              )}{' '}
              <span className="hint">joining {formatDate(h.offer.proposedJoiningDate)}</span>
            </Item>
            <Item term="Candidate">{can(CANDIDATE_READ) ? <Link to={PATHS.candidate(h.candidate.id)}>{h.candidate.candidateCode}</Link> : h.candidate.candidateCode}</Item>
            <Item term="Handed over">{formatDate(h.handedOverAt)}</Item>
            <Item term="Documents transferred">{h.documents.length}</Item>
          </dl>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// F1/C4 offer approvals: the independent eligible approver's queue (GET /v1/hiring/offer-tasks)
// ---------------------------------------------------------------------------------------------------------

function OfferApprovalQueue() {
  const { can } = useSession();
  if (!can(COMPENSATION_APPROVE)) {
    return (
      <Section title="Offer approvals">
        <NotPermitted>The selected role cannot approve offers.</NotPermitted>
      </Section>
    );
  }
  return <OfferApprovalList />;
}

function OfferApprovalList() {
  const keys = useKeys();
  const region = useRef<HTMLDivElement>(null);
  const tasks = useQuery({ queryKey: keys.offerTasks, queryFn: () => api<{ items: OfferTask[] }>('/v1/hiring/offer-tasks'), retry: retryTransient });
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const items = tasks.data?.items ?? [];
  const finished = (text: string, ok: boolean) => {
    setNotice({ text, ok });
    // The decided item and its focused button go away; keep a keyboard user in the queue, unless they moved on.
    const active = document.activeElement;
    if (!active || active === document.body || region.current?.contains(active)) region.current?.focus();
  };
  return (
    <div ref={region} role="region" aria-label="Offer approvals" tabIndex={-1}>
      <Section title={`Offer approvals${tasks.data ? ` (${items.length})` : ''}`}>
        <p className="hint">
          Offers whose confidential compensation waits for your independent approval. An offer never reaches the person who prepared it, recorded its compensation
          or submitted it. Returning or rejecting needs a reason; a returned offer becomes a draft again and its next submission is a new revision.
        </p>
        {tasks.isPending && <p className="hint">Loading the offers waiting for you…</p>}
        <LoadProblem error={tasks.error} forbidden="The selected role cannot approve offers." />
        {notice && (
          <p className={notice.ok ? 'ok' : 'error'} role={notice.ok ? 'status' : 'alert'}>
            {notice.text}
          </p>
        )}
        {tasks.data && items.length === 0 && <Empty>No offers are waiting for your approval.</Empty>}
        {items.length > 0 && (
          <ul className="tasks" aria-label="Offers waiting for your approval">
            {items.map((t) => (
              <OfferTaskItem key={t.taskId} task={t} onFinished={finished} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function decidedText(result: OfferDecided, who: string): string {
  const replay = result.replayed ? ' Your earlier attempt had already been recorded, so nothing was applied twice.' : '';
  if (result.state === 'APPROVED') return `Approved the offer to ${who}.${replay}`;
  if (result.state === 'REJECTED') return `Rejected the offer to ${who}.${replay}`;
  if (result.state === 'DRAFT') return `Returned the offer to ${who} for changes: it is a draft again.${replay}`;
  return `The offer to ${who} is now ${labelOf(OFFER_STATE_LABEL, result.state).toLowerCase()}.${replay}`;
}

function OfferTaskItem({ task: t, onFinished }: { task: OfferTask; onFinished: (text: string, ok: boolean) => void }) {
  const { can } = useSession();
  const refresh = useRefresh();
  const id = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const o = t.offer;
  const who = o ? `${o.candidate.fullName} (${o.candidate.candidateCode})` : 'the candidate';
  /**
   * The decision last sent and its idempotency key (ZT07). Sending that same decision again (same choice, same reason)
   * after a failure, whose answer may have been lost on the way back, carries the same key: the server then answers from
   * what it recorded and never applies it twice. Any other decision is a new user action with a new key.
   */
  const attempt = useRef<{ decision: Decision; reason: string; key: string } | null>(null);
  const decide = useMutation({
    mutationFn: (body: { decision: Decision; reason?: string; idempotencyKey: string }) => api<OfferDecided>(`/v1/hiring/offer-tasks/${enc(t.taskId)}/decision`, { body }),
    onSuccess: (result) => {
      attempt.current = null;
      onFinished(decidedText(result, who), true);
      refresh();
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      // The server took the key for another task's decision and recorded nothing: the next attempt gets a new key.
      if (error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.current = null;
      // Decided meanwhile, or no longer this user's or in scope: nothing is left to decide here.
      if (error.status === 404 || error.code === 'TASK_CLOSED' || error.code === 'INVALID_STATE') {
        onFinished(`Offer to ${who}: ${refusalText(error, DECISION_WORDS) ?? error.message}`, false);
        refresh();
      } else if (isConflict(error)) refresh();
    },
  });
  const send = (decision: Decision) => {
    if (decide.isPending) return;
    const text = reason.trim();
    if (decision !== 'APPROVE' && !text) {
      setProblem(decision === 'RETURN' ? 'Enter a reason to return the offer for changes.' : 'Enter a reason to reject the offer.');
      decide.reset();
      return;
    }
    setProblem(null);
    const last = attempt.current;
    const key = last !== null && last.decision === decision && last.reason === text ? last.key : idempotencyKey('offer-decision');
    attempt.current = { decision, reason: text, key };
    decide.mutate({ decision, ...(text ? { reason: text } : {}), idempotencyKey: key });
  };
  const titleId = `${id}-title`;
  if (!o) {
    return (
      <li aria-labelledby={titleId}>
        <h3 id={titleId} style={H3}>
          An offer outside the selected role’s scope
        </h3>
        <p className="hint">This approval’s offer is not in the selected role’s scope, so it cannot be decided here. Assigned {formatDate(t.assignedAt)}.</p>
      </li>
    );
  }
  const review = o.underReview;
  const currency = review?.currencyCode ?? null;
  const requisitionApproved = o.requisition.state === 'APPROVED';
  return (
    <li aria-labelledby={titleId}>
      <h3 id={titleId} style={H3}>
        Offer to {who} for {o.requisition.code}
      </h3>
      <DelegatedBadge taskId={t.taskId} />
      <dl className="kv">
        <Item term="Requisition">
          {o.requisition.code} <span className="hint">{o.requisition.title}</span> <RequisitionStateBadge state={o.requisition.state} />
        </Item>
        <Item term="Revision under review">{review ? review.revision : '—'}</Item>
        <Item term="Proposed joining date">{formatDate(review?.proposedJoiningDate ?? o.proposedJoiningDate)}</Item>
        {currency && review?.annualCtc !== undefined && review.annualCtc !== null && (
          <Item term="Annual CTC">
            <Money value={review.annualCtc} currency={currency} />
          </Item>
        )}
        {currency && review?.monthlyGross !== undefined && review.monthlyGross !== null && (
          <Item term="Monthly gross">
            <Money value={review.monthlyGross} currency={currency} />
          </Item>
        )}
        <Item term="Submitted">{formatDate(review?.submittedAt ?? o.submittedAt)}</Item>
        <Item term="Assigned to you">{formatDate(t.assignedAt)}</Item>
      </dl>
      {!requisitionApproved && <p className="hint">The requisition is no longer approved: the offer can be returned or rejected, not approved.</p>}
      {(can(OFFER_READ) || can(COMPENSATION_READ)) && (
        <div>
          <Link to={PATHS.offer(o.id)}>Open the offer to {who}</Link>
        </div>
      )}
      <label>
        Reason (required to return or reject)
        <textarea maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
      </label>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <div className="row">
        <button type="button" disabled={decide.isPending || !requisitionApproved} aria-describedby={titleId} onClick={() => send('APPROVE')}>
          Approve
        </button>
        <button type="button" className="secondary" disabled={decide.isPending} aria-describedby={titleId} onClick={() => send('RETURN')}>
          Return for changes
        </button>
        <button type="button" className="danger" disabled={decide.isPending} aria-describedby={titleId} onClick={() => send('REJECT')}>
          Reject
        </button>
      </div>
      <Refusal error={decide.error} words={DECISION_WORDS} />
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Exports for the navigation step (App.tsx wires them): screens, decision queues. Hiring serves no H3 My ESS tab.
// ---------------------------------------------------------------------------------------------------------

/** The pipeline's screens; detail screens are reached through links (`nav: false`). */
export const HIRING_PIPELINE_SCREENS: ScreenRoute[] = [
  { path: PATHS.tracker, title: 'Hiring tracker', permission: APPLICATION_READ, nav: true, component: HiringTrackerScreen },
  { path: PATHS.candidates, title: 'Candidates', permission: CANDIDATE_READ, nav: true, component: CandidatesScreen },
  { path: '/hiring/candidates/:id', title: 'Candidate', permission: CANDIDATE_READ, nav: false, component: CandidateScreen },
  { path: PATHS.duplicates, title: 'Duplicate review', permission: CANDIDATE_READ, nav: true, component: DuplicateReviewScreen },
  { path: PATHS.cvSearch, title: 'CV search', permission: DOCUMENT_READ, nav: true, component: CvSearchScreen },
  { path: PATHS.vendors, title: 'Recruitment vendors', permission: CANDIDATE_READ, nav: true, component: VendorsScreen },
  { path: '/hiring/requisitions/:id/applications', title: 'Requisition applications', permission: APPLICATION_READ, nav: false, component: RequisitionApplicationsScreen },
  { path: '/hiring/applications/:id', title: 'Application', permission: APPLICATION_READ, nav: false, component: ApplicationScreen },
  { path: PATHS.offers, title: 'Offers', permission: OFFER_READ, nav: true, component: OffersScreen },
  { path: '/hiring/offers/:id', title: 'Offer', permission: OFFER_READ, nav: false, component: OfferScreen },
  { path: '/hiring/employees/:id/origin', title: 'Hiring origin', permission: APPLICATION_READ, nav: false, component: EmployeeOriginScreen },
];

/** Hiring serves no H3 My ESS tab (TN01 to TN18), and its registration declares no ESS tabs. */
export const HIRING_PIPELINE_ESS_PANELS: EssPanel[] = [];

/** The module's decision queue for the Decision inbox: offers waiting for the independent eligible approver. */
export const HIRING_PIPELINE_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [
  { permission: COMPENSATION_APPROVE, title: 'Offer approvals', component: OfferApprovalQueue },
];
