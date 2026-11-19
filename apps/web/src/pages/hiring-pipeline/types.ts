// The API's shapes the hiring pipeline screens read: vendors, candidates, applications, offers, letters, handover and requisitions.

// ---------------------------------------------------------------------------------------------------------
// The API's shapes (apps/api/src/modules/hiring: candidate.ts, application.ts, offer.ts, handover.ts, requisition.ts)
// ---------------------------------------------------------------------------------------------------------

export interface Vendor {
  id: string;
  code: string;
  name: string;
  active: boolean;
  version: number;
}

export interface CandidateSummary {
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

export interface CandidatePage {
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

export interface DuplicateFlag {
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

export interface CandidateView extends CandidateSummary {
  /** Operational: whether a private contact exists, never what it is. */
  contactRecorded: boolean;
  applications: CandidateApplication[];
  duplicateFlags: DuplicateFlag[];
}

/** Confidential (candidate.contact): only the granted caller receives it, on request. */
export interface Contact {
  candidateId: string;
  email: string | null;
  phone: string | null;
  updatedAt: string | null;
}

export interface ContactSaved {
  candidateId: string;
  changedFields: string[];
  duplicateFlags: DuplicateFlag[];
}

/** Confidential (candidate.document): metadata of a CV or other candidate document. */
export interface CandidateDocument {
  id: string;
  candidateId: string;
  candidateCode: string;
  documentType: string;
  fileName: string | null;
  mediaType: string;
  byteSize: number | null;
  scanState: string | null;
  uploadedAt: string;
  /** CV search hits only (FR-013, I-82 item 4): the hit matched the approved searchable text. The text is never returned. */
  contentMatch?: boolean;
}

export interface DocumentUploaded {
  id: string;
  mediaType: string;
  byteSize: number;
  scanState: string;
}

/** Confidential (candidate.document): a CV's approved searchable text and its approval history; each read is audited. */
export interface CvText {
  candidateDocumentId: string;
  candidateId: string;
  consentStatus: string;
  /** Approved, the consent still given and the retention date not passed: what the CV search matches now. */
  searchable: boolean;
  approved: { id: string; source: string; content: string; approvedAt: string; approvedBy: string; approvedByPerson: Person | null } | null;
  history: { id: string; state: string; source: string; approvedAt: string; approvedBy: string; approvedByPerson: Person | null; revokedAt: string | null; revocationReason: string | null }[];
}

export interface CvTextApproved {
  id: string;
  candidateDocumentId: string;
  candidateId: string;
  source: string;
  state: string;
  length: number;
  replacedCvTextId: string | null;
}

/** An operational identity the API names (an owner, a decider, a pending approver). */
export interface Person {
  userId: string;
  employeeCode: string | null;
  displayName: string | null;
}

export interface ApplicationRow {
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

export interface ApplicationView extends ApplicationRow {
  history: StageEvent[];
  offers: ApplicationOffer[];
}

export interface StageMoved {
  applicationId: string;
  stage: string;
  version: number;
}

export interface Vacancy {
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

export interface Tracker {
  vacancies: Vacancy[];
  applications: ApplicationRow[];
}

export interface OfferSummary {
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
  /** I-57 item 7: the delegator a delegate decided for (null when decided in the decider's own right). */
  onBehalfOf?: Person | null;
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

export interface OfferView extends OfferSummary {
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

export interface OfferTask {
  taskId: string;
  transactionId: string;
  assignedAt: string;
  /** Null when the offer's requisition is outside the selected role's scope. */
  offer: (OfferSummary & { underReview: UnderReview | null }) | null;
}

export type Decision = 'APPROVE' | 'RETURN' | 'REJECT';

export interface OfferDecided {
  offerId: string;
  state: string;
  replayed: boolean;
}

/** GET /v1/letter-templates (lifecycle letters.ts listLetterTemplates). */
export interface LetterTemplateSummary {
  id: string;
  code: string;
  name: string;
  letterType: string;
  active: boolean;
  version: number;
  publishedRevision: number | null;
  draftRevision: number | null;
}

/** POST /v1/hiring/offers/:id/letter-preview: rendered for review only; nothing is stored or sent. */
export interface OfferLetterPreview {
  offerId: string;
  offerRevision: number;
  templateCode: string;
  templateRevision: number;
  text: string;
  missing: string[];
  ready: boolean;
  sent: false;
}

/** A stored offer letter (confidential, like the compensation it shows). */
export interface OfferLetter {
  id: string;
  offerId: string;
  offerRevision: number;
  templateCode: string;
  templateRevision: number;
  outputNumber: number;
  checksum: string;
  byteSize: number;
  generatedAt: string;
  generatedBy: string;
  deliveryState: string;
}

export interface OfferLetterListed extends OfferLetter {
  /** Whether this letter is of the offer's current approved revision, so that its delivery can still be recorded. */
  current: boolean;
  delivery: { method: string; methodLabel: string | null; deliveredOn: string; recordedBy: string; recordedByPerson: Person | null; recordedAt: string } | null;
}

export interface OfferLetters {
  offerId: string;
  offerState: string;
  currentRevision: number | null;
  items: OfferLetterListed[];
}

export interface DeliveryRecorded {
  id: string;
  offerId: string;
  deliveryState: string;
  deliveryMethod: string;
  deliveredOn: string;
}

export interface ReferenceValues {
  category: string;
  items: { code: string; label: string }[];
}

export interface HandoverResult {
  handoverId: string;
  employeeId: string;
  employeeStatus: string;
  offerId: string;
  applicationId: string;
  requisitionId: string;
  documents: { candidateDocumentId: string; employeeDocumentId: string }[];
}

export interface Origin {
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

export interface RequisitionView {
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

export interface RequisitionPage {
  items: RequisitionView[];
  total: number;
}

export interface EmployeeRecord {
  id: string;
  employeeCode: string;
  displayName: string;
  workEmail: string | null;
  joiningDate: string;
  employmentType: string;
  status: string;
}

