// Shared by the hiring pipeline screens: permission keys, paths and limits, codes in words and their badges, query keys, styles and small pieces.
import { useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, type ReactNode, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { formatAmount, readable } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, NotPermitted } from '../../ui';
import type { Person } from './types';

// ---------------------------------------------------------------------------------------------------------
// Permission keys the API checks (apps/api/src/modules/hiring/pipeline-routes.ts requireAccess; 0034_hiring.sql)
// ---------------------------------------------------------------------------------------------------------

/** Vendors, the candidate register, one candidate and the duplicate flags. */
export const CANDIDATE_READ = 'candidate.read.operational';
/** Adding and changing vendors and candidates; reviewing duplicate flags. */
export const CANDIDATE_MANAGE = 'candidate.manage.operational';
/** Confidential (F1): an eligible scoped Admin reads and records private contacts. */
export const CONTACT_READ = 'candidate.read.contact';
export const CONTACT_MANAGE = 'candidate.manage.contact';
/** Confidential (F1): CVs and other candidate documents. */
export const DOCUMENT_READ = 'candidate.read.document';
export const DOCUMENT_UPLOAD = 'candidate.upload.document';
/** Applications, the tracker and an employee's hiring origin. */
export const APPLICATION_READ = 'application.read.operational';
/** New applications, stage moves and owners. */
export const APPLICATION_MANAGE = 'application.manage.operational';
export const OFFER_READ = 'offer.read.operational';
/** Preparing, changing, submitting and withdrawing an offer; recording the candidate's response. */
export const OFFER_MANAGE = 'offer.manage.operational';
/** Confidential (F1): the offer compensation, its recording and its independent approval. */
export const COMPENSATION_READ = 'offer.read.compensation';
export const COMPENSATION_MANAGE = 'offer.manage.compensation';
export const COMPENSATION_APPROVE = 'offer.approve.compensation';
/** Confidential (F1; I-82 item 1): previewing, generating and recording the delivery of an offer letter. */
export const ISSUE_LETTER = 'offer.issue_letter.compensation';
/** lifecycle letter-routes.ts: the letter template list and the approved placeholders of a letter type. */
export const LETTER_TEMPLATE_READ = 'letter_template.read.operational';
/** The handover needs both the hiring handover duty and the ordinary employee creation duty. */
export const HANDOVER = 'hiring.handover.operational';
export const EMPLOYEE_CREATE = 'employee.create.operational';
/** Transferring candidate documents also needs the employee document upload grant. */
export const EMPLOYEE_DOCUMENT_UPLOAD = 'document.upload.document';
export const EMPLOYEE_DOCUMENT_READ = 'document.read.document';
export const EMPLOYEE_READ = 'employee.read.operational';
export const REQUISITION_READ = 'requisition.read.operational';

/** The screens of this file, which link to each other by these paths. */
export const PATHS = {
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
  /** lifecycle-documents.tsx: where HR writes and publishes letter templates, the OFFER ones included. */
  letterTemplates: '/lifecycle/letter-templates',
} as const;

/** GET /v1/hiring/candidates and /v1/hiring/requisitions accept page sizes of 25, 50 or 100 only. */
export const PAGE_SIZE = 25;
/** The upload route accepts PDF, JPEG and PNG files up to 10 MB (storage/files.ts). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** The formats PUT /v1/hiring/offers/:id/compensation accepts; only the format is checked here. */
export const MONEY = /^\d{1,15}(\.\d{1,4})?$/;
export const CURRENCY = /^[A-Z]{3}$/;
/** An employee document type code, and the most documents one handover transfers, as the handover route accepts them. */
export const DOCUMENT_TYPE_CODE = /^[A-Z][A-Z0-9_]{0,59}$/;
export const MAX_HANDOVER_DOCUMENTS = 20;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Row limits of the API's lists. */
export const LIMITS = { trackerVacancies: 500, trackerApplications: 2000, offers: 500, flags: 500, cvSearch: 200, applications: 1000 } as const;
/** The longest searchable CV text the API accepts (hiring/cv-text.ts MAX_CV_TEXT). */
export const MAX_CV_TEXT = 100_000;
/** The letter type of offer letter templates (lifecycle/letters.ts OFFER_LETTER_TYPE). */
export const OFFER_LETTER_TYPE = 'OFFER';
/** The offer states whose approved revision issues a letter (hiring/offer-letter.ts); the server checks again. */
export const LETTER_ISSUING_STATES: readonly string[] = ['APPROVED', 'ACCEPTED'];
/** A letter template code, as the letter routes accept it. */
export const TEMPLATE_CODE = /^[A-Z][A-Z0-9_]{0,39}$/;
/** The company list of offer letter delivery methods (GET /v1/hiring/reference-values). */
export const DELIVERY_CATEGORY = 'OFFER_LETTER_DELIVERY';

export const enc = encodeURIComponent;

// ---------------------------------------------------------------------------------------------------------
// Codes in words
// ---------------------------------------------------------------------------------------------------------

const STAGE_ORDER: readonly string[] = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'];
export const STAGE_LABEL: Record<string, string> = {
  APPLIED: 'Applied',
  SCREENING: 'Screening',
  INTERVIEW: 'Interview',
  OFFER: 'Offer',
  HIRED: 'Hired',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};
export const OPEN_STAGES: readonly string[] = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'];
/** Stages move forward one at a time (application.ts); HIRED is reached only through the handover. */
export const NEXT_STAGE: Record<string, string> = { APPLIED: 'SCREENING', SCREENING: 'INTERVIEW', INTERVIEW: 'OFFER' };

/** The next thing an open application waits for (application.ts PENDING_ACTION_SQL). */
export const PENDING_ACTION_LABEL: Record<string, string> = {
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

export const OFFER_STATE_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Waiting for approval',
  APPROVED: 'Approved',
  ACCEPTED: 'Accepted',
  DECLINED: 'Declined',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};
/** An offer in one of these states keeps its application from a new offer or from ending. */
export const OPEN_OFFER_STATES: readonly string[] = ['DRAFT', 'SUBMITTED', 'APPROVED', 'ACCEPTED'];
export const OFFER_STATES: readonly string[] = ['DRAFT', 'SUBMITTED', 'APPROVED', 'ACCEPTED', 'DECLINED', 'REJECTED', 'WITHDRAWN'];

export const REQUISITION_STATE_LABEL: Record<string, string> = { DRAFT: 'Draft', SUBMITTED: 'Submitted', APPROVED: 'Approved', REJECTED: 'Rejected', CLOSED: 'Closed' };
const CANDIDATE_STATE_LABEL: Record<string, string> = { ACTIVE: 'Active', INACTIVE: 'Inactive', DUPLICATE: 'Retired duplicate' };
export const CONSENT_LABEL: Record<string, string> = { NOT_RECORDED: 'Not recorded', GIVEN: 'Given', WITHDRAWN: 'Withdrawn' };
export const CONSENTS: readonly string[] = ['NOT_RECORDED', 'GIVEN', 'WITHDRAWN'];
const FLAG_STATE_LABEL: Record<string, string> = { OPEN: 'Waiting for review', NOT_DUPLICATE: 'Not a duplicate', CONFIRMED_DUPLICATE: 'Confirmed duplicate' };
export const BASIS_LABEL: Record<string, string> = { EMAIL: 'Same private email address', PHONE: 'Same private phone number' };
export const DECISION_LABEL: Record<string, string> = { APPROVE: 'Approved', REJECT: 'Rejected', RETURN: 'Returned for changes' };
export const EMPLOYEE_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  ACTIVE_PROBATION: 'Active (probation)',
  ACTIVE_CONFIRMED: 'Active (confirmed)',
  NOTICE: 'Notice',
  INACTIVE_SEPARATED: 'Separated',
  ARCHIVED: 'Archived',
};
const SCAN_LABEL: Record<string, string> = { CLEAN: 'released', PENDING_SCAN: 'waiting for the malware scan', QUARANTINED: 'quarantined by the malware scan' };
export const CV_TEXT_SOURCE_LABEL: Record<string, string> = { TRANSCRIBED: 'Typed or pasted by an Admin from the released CV', EXTRACTED: 'Extracted from the released file' };
export const CV_TEXT_STATE_LABEL: Record<string, string> = { APPROVED: 'Approved', REVOKED: 'Revoked' };
export const LETTER_DELIVERY_LABEL: Record<string, string> = { NOT_DELIVERED: 'Not delivered yet', DELIVERED: 'Delivered' };

/**
 * The seeded reference values of the module registration (CANDIDATE_SOURCE, CANDIDATE_DOCUMENT_TYPE). No API route
 * lists a company's active reference values, so these are offered; the server refuses an inactive one.
 */
export const SOURCES: readonly { code: string; label: string }[] = [
  { code: 'DIRECT', label: 'Direct application' },
  { code: 'VENDOR', label: 'Recruitment vendor' },
];
export const CANDIDATE_DOCUMENT_TYPES: readonly { code: string; label: string }[] = [
  { code: 'CV', label: 'Curriculum vitae' },
  { code: 'OTHER', label: 'Other candidate document' },
];
export const DOCUMENT_TYPE_LABEL: Record<string, string> = Object.fromEntries(CANDIDATE_DOCUMENT_TYPES.map((t) => [t.code, t.label]));
/** The neutral employee document type seeded for every company (access/baseline.ts DOCUMENT_TYPE). */
export const DEFAULT_EMPLOYEE_DOCUMENT_TYPE = 'GENERAL';

export const labelOf = (labels: Record<string, string>, code: string | null | undefined) => (code ? (labels[code] ?? readable(code)) : '—');

type Tone = 'neutral' | 'good' | 'warn' | 'bad';
const STAGE_TONE: Record<string, Tone> = { HIRED: 'good', REJECTED: 'bad' };
const OFFER_TONE: Record<string, Tone> = { SUBMITTED: 'warn', APPROVED: 'good', ACCEPTED: 'good', DECLINED: 'warn', REJECTED: 'bad' };
const REQUISITION_TONE: Record<string, Tone> = { SUBMITTED: 'warn', APPROVED: 'good', REJECTED: 'bad' };
const CANDIDATE_TONE: Record<string, Tone> = { ACTIVE: 'good', DUPLICATE: 'warn' };
const FLAG_TONE: Record<string, Tone> = { OPEN: 'warn', CONFIRMED_DUPLICATE: 'bad' };
export const EMPLOYEE_TONE: Record<string, Tone> = { DRAFT: 'warn', ACTIVE_PROBATION: 'good', ACTIVE_CONFIRMED: 'good' };

/** Status is always text; the tone is a secondary cue only (DF10). */
export function CodeBadge({ code, labels, tones }: { code: string | null | undefined; labels: Record<string, string>; tones: Record<string, Tone> }) {
  return <Badge tone={(code ? tones[code] : undefined) ?? 'neutral'}>{labelOf(labels, code)}</Badge>;
}
export const StageBadge = ({ stage }: { stage: string }) => <CodeBadge code={stage} labels={STAGE_LABEL} tones={STAGE_TONE} />;
export const OfferStateBadge = ({ state }: { state: string }) => <CodeBadge code={state} labels={OFFER_STATE_LABEL} tones={OFFER_TONE} />;
export const RequisitionStateBadge = ({ state }: { state: string }) => <CodeBadge code={state} labels={REQUISITION_STATE_LABEL} tones={REQUISITION_TONE} />;
export const CandidateStateBadge = ({ state }: { state: string }) => <CodeBadge code={state} labels={CANDIDATE_STATE_LABEL} tones={CANDIDATE_TONE} />;
export const FlagStateBadge = ({ state }: { state: string }) => <CodeBadge code={state} labels={FLAG_STATE_LABEL} tones={FLAG_TONE} />;

/** FR-106: only a file the malware scanner released (CLEAN) is ever served. */
export function ScanBadge({ state }: { state: string | null }) {
  const tone: Tone = state === 'CLEAN' ? 'good' : state === 'QUARANTINED' ? 'bad' : 'warn';
  return <Badge tone={tone}>{state ? (SCAN_LABEL[state] ?? readable(state).toLowerCase()) : 'not scanned yet'}</Badge>;
}


// ---------------------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------------------

/**
 * Query keys carry the selected company and assignment: the app keeps one query cache across role switches and
 * sign-ins, and an answer given to one assignment (a scoped list, an offer with its compensation) must never be shown
 * under another, not even from the cache while the new answer loads.
 */
export function useKeys() {
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
      offerLetters: (offerId: string) => [...all, 'offer-letters', offerId] as const,
      letterTemplates: [...all, 'letter-templates'] as const,
      offerPlaceholders: [...all, 'offer-letter-placeholders'] as const,
      referenceValues: (category: string) => [...all, 'reference-values', category] as const,
      /** Outside `all`: reloading after a change never reads the private contact again (each read is audited). */
      contact: (candidateId: string) => ['hiring-pipeline-contact', context, candidateId] as const,
      /** Outside `all` too: each read of an approved CV text is audited. */
      cvText: (documentId: string) => ['hiring-pipeline-cv-text', context, documentId] as const,
    };
  }, [context]);
}

/** After any change: everything this module shows is read again from the server (no optimistic updates). */
export function useRefresh(): () => void {
  const qc = useQueryClient();
  const keys = useKeys();
  return () => void qc.invalidateQueries({ queryKey: keys.all });
}

/** The signed-in user (GET /v1/me/context), e.g. to tell one's own applications apart. */
export function useUserId(): string | null {
  const { me } = useSession();
  return me?.userId ?? null;
}

export const SCROLL: CSSProperties = { overflowX: 'auto' };
export const H3: CSSProperties = { fontSize: '1rem', margin: '0.5rem 0 0' };
export const GROUP: CSSProperties = { border: 'none', margin: 0, padding: 0, minWidth: 0 };
export const TEXTAREA: CSSProperties = { font: 'inherit', padding: '0.4rem 0.5rem', border: '1px solid var(--line)', borderRadius: 6, color: 'var(--text)', resize: 'vertical' };
export const SR_ONLY: CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 };
export const LIST: CSSProperties = { margin: 0, paddingLeft: '1.1rem' };

export function Problem({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="error wide">
      {text}
    </p>
  );
}

export function Done({ children }: { children: ReactNode }) {
  return (
    <p className="ok wide" role="status">
      {children}
    </p>
  );
}

/** What the last action did, kept by a parent that stays on screen while the acted-on item reloads or goes. */
export function Notice({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="ok" role="status">
      {text}
    </p>
  );
}

/** A screen the selected role cannot use: its heading and the reason, and no request at all. */
export function Denied({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h1>{title}</h1>
      <NotPermitted>{children}</NotPermitted>
    </>
  );
}

export function Missing({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h1>{title}</h1>
      <Empty>{children}</Empty>
    </>
  );
}

/** An operational identity as the API named it; the signed-in user is marked. */
export function personText(p: Person | null | undefined, userId: string | null): string {
  if (!p) return '—';
  const name = p.displayName && p.employeeCode ? `${p.displayName}, ${p.employeeCode}` : (p.displayName ?? p.employeeCode ?? 'A user without an employee record');
  return userId !== null && p.userId === userId ? `You (${name})` : name;
}

export const ageing = (days: number | null | undefined) => (days === null || days === undefined ? '—' : `${days} ${days === 1 ? 'day' : 'days'}`);

/**
 * An amount as the API sent it (a decimal string), through formatAmount. formatAmount shows two decimals, so an amount
 * with a non-zero third or fourth decimal is also given exactly as sent: the display never hides part of an amount.
 */
export function Money({ value, currency }: { value: string | null | undefined; currency: string }) {
  if (value === null || value === undefined) return <>—</>;
  const finer = /\.\d{2}\d*[1-9]/.test(value);
  return (
    <>
      {formatAmount(value, currency)}
      {finer && <span className="hint"> (exactly {value})</span>}
    </>
  );
}

export function CandidateLink({ candidate: c, withState = false }: { candidate: { id: string; candidateCode: string; fullName: string; state?: string }; withState?: boolean }) {
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

export function stageCounts(byStage: Record<string, number>): string {
  const present = (s: string) => (byStage[s] ?? 0) > 0;
  const stages = [...STAGE_ORDER.filter(present), ...Object.keys(byStage).filter((s) => !STAGE_ORDER.includes(s) && present(s))];
  return stages.length === 0 ? 'No candidates yet' : stages.map((s) => `${labelOf(STAGE_LABEL, s)} ${byStage[s]}`).join(' · ');
}

export const parseSkills = (text: string) =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

