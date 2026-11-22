// Supporting evidence (FR-027 with FR-106, I-22): the requester's own documents, never a quarantined or rejected one; the documents
// of a request revision with their scan and verification state; the refusals about them in plain words. The leave screen and the
// decision inbox use these too.
import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleAlertIcon } from 'lucide-react';
import { CheckField, LabelledFieldset } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { api, ApiError, download, formatDate } from '../../api';
import { useSession } from '../../session';
import { Badge, ErrorNote } from '../../ui';
import { type Kind, ownRecordInScope, ownRecordNotFound, useRoleContext } from './shared';

/** FR-106: an upload is served only once the malware scan has released it (CLEAN). */
type ScanState = 'PENDING_SCAN' | 'CLEAN' | 'QUARANTINED' | null;
type VerificationState = 'UNVERIFIED' | 'VERIFIED' | 'REJECTED';

/** One supporting document of a request revision, as metadata only (the request lists and the task summary). */
export interface Evidence {
  documentId: string;
  documentType: string;
  scanState: ScanState;
  verificationState: VerificationState;
}

/** At most this many documents per request revision (MAX_EVIDENCE_DOCUMENTS in the API). */
const MAX_EVIDENCE = 10;

/** GET /v1/employees/{id}/documents: the fields the evidence choice uses. */
interface OwnDocument {
  id: string;
  documentType: string;
  fileName: string | null;
  uploadedAt: string;
  scanState: ScanState;
  verificationState: VerificationState;
}

const SCAN_TEXT: Record<string, string> = {
  CLEAN: 'released by the malware scan',
  PENDING_SCAN: 'waiting for the malware scan',
  QUARANTINED: 'quarantined by the malware scan',
};
const SCAN_TONE: Record<string, 'good' | 'warn' | 'bad'> = { CLEAN: 'good', PENDING_SCAN: 'warn', QUARANTINED: 'bad' };
const VERIFICATION_TEXT: Record<string, string> = { UNVERIFIED: 'not verified', VERIFIED: 'verified', REJECTED: 'rejected by the verifier' };
const VERIFICATION_TONE: Record<string, 'good' | 'bad' | 'neutral'> = { UNVERIFIED: 'neutral', VERIFIED: 'good', REJECTED: 'bad' };

/** A quarantined or rejected document is never evidence (the server refuses it with EVIDENCE_UNUSABLE). */
export const unusable = (d: { scanState: ScanState; verificationState: VerificationState }) => d.scanState === 'QUARANTINED' || d.verificationState === 'REJECTED';

/** The released content of one evidence document, for the requester or a reviewer assigned to the request (I-22). */
export const evidencePath = (kind: Kind, requestId: string, documentId: string) => `/v1/work-requests/${kind}/${requestId}/evidence/${documentId}/content`;

/**
 * The API's evidence refusals (employee/evidence.ts and the evidence content route) in plain words; null for anything
 * else, which is shown as the API sent it. `keptEarlier`: a resubmission that sent no new choice, so the server
 * checked the documents attached before.
 */
function evidenceRefusal(error: unknown, keptEarlier: boolean): string | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    case 'INVALID_EVIDENCE':
      return 'Supporting documents must be your own uploaded documents. Choose them again from your documents.';
    case 'EVIDENCE_UNUSABLE':
      return keptEarlier
        ? 'A document attached before has since failed the malware scan or been rejected, so it cannot be kept. Choose the documents to attach instead.'
        : 'A chosen document failed the malware scan or was rejected, so it cannot be supporting evidence. Choose other documents.';
    case 'TOO_MUCH_EVIDENCE':
      return `Attach at most ${MAX_EVIDENCE} supporting documents to one request.`;
    case 'FILE_NOT_RELEASED':
      return (error.details as { scanState?: string | null } | undefined)?.scanState === 'QUARANTINED'
        ? 'This file failed the malware scan, so it cannot be opened.'
        : 'This file cannot be opened until the malware scan releases it.';
    default:
      return null;
  }
}

/** A refusal meaning the documents shown are out of date: a chosen one changed meanwhile (scan, verifier) or is not one's own. */
export const staleEvidence = (error: unknown) => error instanceof ApiError && (error.code === 'EVIDENCE_UNUSABLE' || error.code === 'INVALID_EVIDENCE');

/** A refused request or file: evidence refusals in plain words (the code stays beneath for reference), anything else as the API sent it. */
export function EvidenceError({ error, keptEarlier = false }: { error: unknown; keptEarlier?: boolean }) {
  if (!error) return null;
  const text = evidenceRefusal(error, keptEarlier);
  if (text === null) return <ErrorNote error={error} />;
  return (
    <Alert variant="destructive" className="error">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle asChild>
        <strong>{text}</strong>
      </AlertTitle>
      <AlertDescription className="block">{(error as ApiError).code}</AlertDescription>
    </Alert>
  );
}

/**
 * The supporting documents of one request revision: type, scan and verification state, as text. `openPath` gives a
 * document's evidence route, or null while it is not known; without `openPath` (no work-request read duty, which the
 * route checks) nothing is offered to open. Only a released (CLEAN) file opens; the server re-checks every read.
 */
export function EvidenceList({ evidence, openPath }: { evidence: readonly Evidence[]; openPath: ((documentId: string) => string | null) | null }) {
  const open = useMutation({ mutationFn: (path: string) => download(path) });
  if (evidence.length === 0) return <Hint as="span">none</Hint>;
  return (
    <>
      <div role="list" aria-label="Supporting documents">
        {evidence.map((e) => {
          const path = openPath?.(e.documentId) ?? null;
          return (
            <div role="listitem" key={e.documentId}>
              <strong>{e.documentType}</strong> <Badge tone={(e.scanState && SCAN_TONE[e.scanState]) || 'warn'}>{e.scanState ? (SCAN_TEXT[e.scanState] ?? e.scanState) : 'not scanned'}</Badge>{' '}
              <Badge tone={VERIFICATION_TONE[e.verificationState] ?? 'neutral'}>{VERIFICATION_TEXT[e.verificationState] ?? e.verificationState}</Badge>
              {openPath && (
                <>
                  {' '}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={e.scanState !== 'CLEAN' || path === null || open.isPending}
                    onClick={() => path && open.mutate(path)}
                  >
                    Open
                  </Button>
                </>
              )}
            </div>
          );
        })}
      </div>
      <EvidenceError error={open.error} />
    </>
  );
}

/** Why a chosen document must be unticked, when the scan quarantined it or a verifier rejected it meanwhile. */
function untickNote(d: OwnDocument): string | null {
  if (d.scanState === 'QUARANTINED') return 'quarantined by the malware scan: untick it';
  return d.verificationState === 'REJECTED' ? 'rejected by the verifier: untick it' : null;
}

/** Own documents can be offered where the role holds the document read duty and its scope covers the own record. */
export function useCanChooseEvidence(): boolean {
  const { me, can } = useSession();
  return !!me?.employeeId && ownRecordInScope(me.scopeKind) && can('document.read.document');
}

/**
 * The requester's own documents to choose as supporting evidence (GET /v1/employees/{id}/documents). A quarantined or
 * rejected document is not offered; one still waiting for the malware scan can be chosen and opens once released. A
 * chosen document that the scan quarantines or a verifier rejects meanwhile stays listed, so it can be unticked.
 * `earlier`: the evidence of the revision being corrected, marked so it can be ticked again.
 */
export function EvidenceChoice({ chosen, onChange, earlier = [] }: { chosen: readonly string[]; onChange: (ids: string[]) => void; earlier?: readonly Evidence[] }) {
  const { me } = useSession();
  const employeeId = me?.employeeId;
  const allowed = useCanChooseEvidence();
  const context = useRoleContext();
  const documents = useQuery({
    // Begins as the documents page's key does (records.tsx), so an upload there refreshes this choice.
    queryKey: ['documents', employeeId, context],
    enabled: allowed,
    queryFn: () => api<{ items: OwnDocument[] }>(`/v1/employees/${employeeId}/documents`),
  });
  if (!allowed || ownRecordNotFound(documents.error)) return null;
  if (documents.error) {
    return (
      <div className="col-span-full">
        <ErrorNote error={documents.error} />
      </div>
    );
  }
  if (!documents.data) return null;
  const offered = documents.data.items.filter((d) => !unusable(d) || chosen.includes(d.id));
  if (offered.length === 0) {
    return <Hint>To attach a supporting document, upload it in My documents first.</Hint>;
  }
  const full = chosen.length >= MAX_EVIDENCE;
  return (
    <LabelledFieldset legend={<>Supporting documents (optional, at most {MAX_EVIDENCE})</>}>
      {offered.map((d) => {
        const ticked = chosen.includes(d.id);
        const notes = [
          d.documentType,
          `uploaded ${formatDate(d.uploadedAt)}`,
          d.scanState === 'PENDING_SCAN' ? 'waiting for the malware scan' : null,
          untickNote(d),
          earlier.some((e) => e.documentId === d.id) ? 'attached before' : null,
        ].filter((n) => n !== null);
        return (
          <CheckField key={d.id}>
            <input type="checkbox" checked={ticked} disabled={!ticked && full} onChange={(e) => onChange(e.target.checked ? [...chosen, d.id] : chosen.filter((x) => x !== d.id))} />{' '}
            {/* One run of text, so the notes follow the file's name on its line rather than standing in a column of their own. */}
            <span>
              {d.fileName ?? d.documentType} <Hint as="span">({notes.join(' · ')})</Hint>
            </span>
          </CheckField>
        );
      })}
      {full && <Hint>{MAX_EVIDENCE} documents are chosen, the most one request can carry.</Hint>}
    </LabelledFieldset>
  );
}

/** What a work-request task decides (GET /v1/work-requests/tasks/mine `summary`), with its supporting documents. */
interface TaskSummary {
  /** The request the task decides; its evidence route takes this id. */
  requestId?: string | undefined;
  kind: Kind;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  purpose: string;
  evidence?: readonly Evidence[] | undefined;
}

/**
 * The supporting documents of a work-request task, for the reviewer it is assigned to (FR-106, I-22): type, scan and
 * verification state, and "Open" for a released file through the request's evidence route, named by the task's own
 * summary (nothing else about the requester is read). The server re-checks the assignment on every read.
 */
export function WorkTaskEvidence({ summary }: { summary: TaskSummary }) {
  const { can } = useSession();
  const evidence = summary.evidence ?? [];
  const canOpen = can('work_request.read.operational');
  const requestId = summary.requestId ?? null;
  return (
    <div>
      <Hint as="span">Supporting documents:</Hint>{' '}
      <EvidenceList evidence={evidence} openPath={canOpen ? (documentId) => (requestId ? evidencePath(summary.kind, requestId, documentId) : null) : null} />
      {canOpen && requestId === null && evidence.length > 0 && <Hint>The request these documents belong to could not be identified, so they cannot be opened here.</Hint>}
    </div>
  );
}
