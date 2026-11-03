import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, download, formatDate, localDate } from '../api';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Section, StateBadge } from '../ui';

// ---------------------------------------------------------------------------------------------------------
// Outdoor duty and work on holiday (FR-027, I-05..I-07): own requests, and the HR views within the selected scope.
// Supporting evidence (FR-027 with FR-106, I-22): the requester's own documents, never a quarantined or rejected one.
// ---------------------------------------------------------------------------------------------------------

type Kind = 'outdoor_duty' | 'holiday_work';
export const KIND_LABEL: Record<Kind, string> = { outdoor_duty: 'Outdoor duty', holiday_work: 'Work on holiday' };

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

interface WorkRequest {
  kind: Kind;
  id: string;
  employeeCode: string;
  employeeName: string;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  purpose: string;
  state: string;
  version: number;
  /** The supporting documents of the current revision. */
  evidence?: Evidence[];
}

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
const unusable = (d: { scanState: ScanState; verificationState: VerificationState }) => d.scanState === 'QUARANTINED' || d.verificationState === 'REJECTED';

/** The released content of one evidence document, for the requester or a reviewer assigned to the request (I-22). */
const evidencePath = (kind: Kind, requestId: string, documentId: string) => `/v1/work-requests/${kind}/${requestId}/evidence/${documentId}/content`;

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
const staleEvidence = (error: unknown) => error instanceof ApiError && (error.code === 'EVIDENCE_UNUSABLE' || error.code === 'INVALID_EVIDENCE');

/**
 * The selected company and assignment. The query keys of role-dependent answers carry it (as in confirmation.tsx), so
 * an answer given to one assignment is never shown under another, not even from the cache while the new answer loads.
 */
function useRoleContext(): string {
  const { stored } = useSession();
  return `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
}

/** A refused request or file: evidence refusals in plain words (the code stays beneath for reference), anything else as the API sent it. */
export function EvidenceError({ error, keptEarlier = false }: { error: unknown; keptEarlier?: boolean }) {
  if (!error) return null;
  const text = evidenceRefusal(error, keptEarlier);
  if (text === null) return <ErrorNote error={error} />;
  return (
    <div role="alert" className="error">
      <strong>{text}</strong>
      <div className="hint">{(error as ApiError).code}</div>
    </div>
  );
}

/**
 * The supporting documents of one request revision: type, scan and verification state, as text. `openPath` gives a
 * document's evidence route, or null while it is not known; without `openPath` (no work-request read duty, which the
 * route checks) nothing is offered to open. Only a released (CLEAN) file opens; the server re-checks every read.
 */
export function EvidenceList({ evidence, openPath }: { evidence: readonly Evidence[]; openPath: ((documentId: string) => string | null) | null }) {
  const open = useMutation({ mutationFn: (path: string) => download(path) });
  if (evidence.length === 0) return <span className="hint">none</span>;
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
                  <button type="button" className="secondary" disabled={e.scanState !== 'CLEAN' || path === null || open.isPending} onClick={() => path && open.mutate(path)}>
                    Open
                  </button>
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

/** Own documents can be offered where the role holds the document read duty and its scope covers the own record. */
function useCanChooseEvidence(): boolean {
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
      <div className="wide">
        <ErrorNote error={documents.error} />
      </div>
    );
  }
  if (!documents.data) return null;
  const offered = documents.data.items.filter((d) => !unusable(d) || chosen.includes(d.id));
  if (offered.length === 0) {
    return <p className="hint wide">None of your documents can be attached as supporting evidence. Upload the document first; a file that failed the malware scan or was rejected cannot be attached.</p>;
  }
  const full = chosen.length >= MAX_EVIDENCE;
  return (
    <fieldset className="wide">
      <legend>Supporting documents (optional, at most {MAX_EVIDENCE})</legend>
      {offered.map((d) => {
        const ticked = chosen.includes(d.id);
        const notes = [
          d.documentType,
          `uploaded ${formatDate(d.uploadedAt)}`,
          d.scanState === 'PENDING_SCAN' ? 'waiting for the malware scan' : null,
          d.scanState === 'QUARANTINED' ? 'quarantined by the malware scan: untick it' : d.verificationState === 'REJECTED' ? 'rejected by the verifier: untick it' : null,
          earlier.some((e) => e.documentId === d.id) ? 'attached before' : null,
        ].filter((n) => n !== null);
        return (
          <label key={d.id} className="check">
            <input type="checkbox" checked={ticked} disabled={!ticked && full} onChange={(e) => onChange(e.target.checked ? [...chosen, d.id] : chosen.filter((x) => x !== d.id))} />{' '}
            {d.fileName ?? d.documentType} <span className="hint">({notes.join(' · ')})</span>
          </label>
        );
      })}
      {full && <p className="hint">{MAX_EVIDENCE} documents are chosen, the most one request can carry.</p>}
    </fieldset>
  );
}

/** A timed outdoor-duty window whose end is before its start ends on the next day (night duty, DF05). */
const overnight = (startTime: string | null | undefined, endTime: string | null | undefined) => !!startTime && !!endTime && endTime < startTime;

/** "2026-11-04 – 2026-11-06" or "2026-11-04 22:00–06:00 (ends the next day)". */
export function describeWindow(r: { startDate: string; endDate: string; startTime: string | null; endTime: string | null }): string {
  const range = `${formatDate(r.startDate)}${r.endDate.slice(0, 10) !== r.startDate.slice(0, 10) ? ` – ${formatDate(r.endDate)}` : ''}`;
  if (!r.startTime) return range;
  return `${range} ${r.startTime}–${r.endTime}${overnight(r.startTime, r.endTime) ? ' (ends the next day)' : ''}`;
}

interface Draft {
  startDate: string;
  endDate: string;
  timed: boolean;
  startTime: string;
  endTime: string;
  purpose: string;
}
const blankDraft = (): Draft => ({ startDate: '', endDate: '', timed: false, startTime: '09:00', endTime: '13:00', purpose: '' });

/** What the API needs: a timed request (and all holiday work) covers its start date only. */
function requestBody(kind: Kind, d: Draft) {
  const singleDay = kind === 'holiday_work' || d.timed;
  return {
    startDate: d.startDate,
    endDate: singleDay ? d.startDate : d.endDate,
    ...(d.timed ? { startTime: d.startTime, endTime: d.endTime } : {}),
    purpose: d.purpose,
  };
}

type WindowProblem = 'EMPTY_WINDOW' | 'HOLIDAY_WORK_ENDS_BEFORE_START';

/** The window rules the server applies (work-request service `check`), caught before sending. */
function windowProblem(kind: Kind, d: Draft): WindowProblem | null {
  if (!d.timed) return null;
  if (d.startTime === d.endTime) return 'EMPTY_WINDOW';
  if (kind === 'holiday_work' && d.endTime < d.startTime) return 'HOLIDAY_WORK_ENDS_BEFORE_START';
  return null;
}

/** States the timed-window rule for the kind; an empty window is called out as well. */
function WindowHint({ kind, draft }: { kind: Kind; draft: Draft }) {
  if (!draft.timed) return null;
  return (
    <p className="hint wide">
      {kind === 'outdoor_duty' ? 'An end time earlier than the start time ends on the next day (overnight duty).' : 'Holiday work stays within its day: the end must be after the start.'}
      {windowProblem(kind, draft) === 'EMPTY_WINDOW' && ' The start and end times must differ.'}
    </p>
  );
}

/** Date, time and purpose inputs shared by the new-request form and the correction of a returned request. */
function WindowFields({ kind, draft, onChange }: { kind: Kind; draft: Draft; onChange: (d: Draft) => void }) {
  const singleDay = kind === 'holiday_work' || draft.timed;
  return (
    <>
      <label>
        {singleDay ? 'Date' : 'From'}
        <input type="date" required value={draft.startDate} onChange={(e) => onChange({ ...draft, startDate: e.target.value })} />
      </label>
      {!singleDay && (
        <label>
          To
          <input type="date" required value={draft.endDate} onChange={(e) => onChange({ ...draft, endDate: e.target.value })} />
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={draft.timed} onChange={(e) => onChange({ ...draft, timed: e.target.checked })} /> Part of the day
      </label>
      {draft.timed && (
        <>
          <label>
            Start
            <input type="time" required value={draft.startTime} onChange={(e) => onChange({ ...draft, startTime: e.target.value })} />
          </label>
          <label>
            End
            <input type="time" required value={draft.endTime} onChange={(e) => onChange({ ...draft, endTime: e.target.value })} />
          </label>
        </>
      )}
      <label className="wide">
        Purpose
        <input required maxLength={1000} value={draft.purpose} onChange={(e) => onChange({ ...draft, purpose: e.target.value })} />
      </label>
    </>
  );
}

/**
 * DF03/I-07: a returned request is corrected and resubmitted as a new revision (the server checks the version). I-22:
 * without a new choice of documents the server carries the earlier evidence forward; a new choice replaces it.
 */
function ResubmitWorkRequest({ request: r, onChanged }: { request: WorkRequest; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => ({
    startDate: r.startDate.slice(0, 10),
    endDate: r.endDate.slice(0, 10),
    timed: !!r.startTime,
    startTime: r.startTime ?? '09:00',
    endTime: r.endTime ?? '13:00',
    purpose: r.purpose,
  }));
  const [evidence, setEvidence] = useState<string[]>([]);
  const canChoose = useCanChooseEvidence();
  const { me } = useSession();
  const qc = useQueryClient();
  const resubmit = useMutation({
    // The choice sent is the mutation's variables, so a refusal is explained for what was sent.
    mutationFn: (chosen: string[]) =>
      api(`/v1/work-requests/${r.kind}/${r.id}`, {
        method: 'PUT',
        body: { ...requestBody(r.kind, draft), ...(chosen.length ? { evidenceDocumentIds: chosen } : {}), expectedVersion: r.version },
      }),
    onSuccess: () => {
      setOpen(false);
      setEvidence([]);
      onChanged();
    },
    // A document attached before or chosen changed meanwhile: the documents and this request's evidence are read
    // again, so the form says which one cannot be used. What was typed stays (the form is keyed by the version).
    onError: (error) => {
      if (!staleEvidence(error)) return;
      void qc.invalidateQueries({ queryKey: ['documents', me?.employeeId] });
      onChanged();
    },
  });
  if (!open) {
    return (
      <button type="button" className="link" onClick={() => setOpen(true)}>
        Correct and resubmit
      </button>
    );
  }
  const problem = windowProblem(r.kind, draft);
  const earlier = r.evidence ?? [];
  const count = earlier.length === 1 ? '1 document' : `${earlier.length} documents`;
  return (
    <form
      className="grid-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) resubmit.mutate(evidence);
      }}
    >
      <WindowFields kind={r.kind} draft={draft} onChange={setDraft} />
      <WindowHint kind={r.kind} draft={draft} />
      {earlier.length > 0 && (
        <p className="hint wide">
          {canChoose
            ? `Without a new choice, the resubmission keeps the evidence attached before (${count}). Ticking documents replaces it, so tick an earlier document again to keep it.`
            : `The resubmission keeps the evidence attached before (${count}).`}
          {canChoose && earlier.some(unusable) && ' A document attached before failed the malware scan or was rejected, so choose the documents to attach.'}
        </p>
      )}
      <EvidenceChoice chosen={evidence} onChange={setEvidence} earlier={earlier} />
      <div className="row">
        <button type="submit" disabled={!!problem || resubmit.isPending}>
          Resubmit
        </button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <EvidenceError error={resubmit.error} keptEarlier={resubmit.variables?.length === 0} />
    </form>
  );
}

/**
 * Own records are reachable only where the selected role's scope can include the caller's own record: a team scope
 * covers direct reports only and an assigned scope only the requesters of open tasks (employeeScopePredicate).
 */
export const ownRecordInScope = (scopeKind: string | undefined) => scopeKind === 'OWN' || scopeKind === 'COMPANY';

/** A 404 for one's own record: the role's scope (or its filters) leaves the own record out. */
export const ownRecordNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;

export function WorkRequestsPage() {
  const { me, can } = useSession();
  const qc = useQueryClient();
  const employeeId = me?.employeeId;
  const ownInScope = !!employeeId && ownRecordInScope(me?.scopeKind);
  const context = useRoleContext();
  const mine = useQuery({
    queryKey: ['work-requests', employeeId, context],
    enabled: ownInScope,
    queryFn: () => api<{ items: WorkRequest[] }>(`/v1/employees/${employeeId}/work-requests`),
  });
  // A company-scope role whose filters leave out the own record: nothing of one's own to show here.
  const ownHidden = ownRecordNotFound(mine.error);
  const [kind, setKind] = useState<Kind>('outdoor_duty');
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [evidence, setEvidence] = useState<string[]>([]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['work-requests'] });
    void qc.invalidateQueries({ queryKey: ['work-request-register'] });
  };
  const submit = useMutation({
    mutationFn: () => api(`/v1/work-requests/${kind}`, { body: { ...requestBody(kind, draft), ...(evidence.length ? { evidenceDocumentIds: evidence } : {}) } }),
    // A submitted request starts the form clean; a refused one keeps what was typed and chosen for correction.
    onSuccess: () => {
      setDraft(blankDraft());
      setEvidence([]);
      refresh();
    },
    // A chosen document changed meanwhile (scan, verifier): the documents are read again, so the form says which one.
    onError: (error) => {
      if (staleEvidence(error)) void qc.invalidateQueries({ queryKey: ['documents', employeeId] });
    },
  });
  const withdraw = useMutation({ mutationFn: (r: WorkRequest) => api(`/v1/work-requests/${r.kind}/${r.id}/withdraw`, { method: 'POST' }), onSuccess: refresh });
  const problem = windowProblem(kind, draft);
  // The evidence route checks the work-request read duty, for the requester as for a reviewer.
  const canOpenEvidence = can('work_request.read.operational');

  return (
    <>
      {employeeId && can('work_request.submit.operational') && (
        <Section title="New outdoor duty or holiday work request">
          <form
            className="grid-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!problem) submit.mutate();
            }}
          >
            <label>
              Kind
              <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                <option value="outdoor_duty">{KIND_LABEL.outdoor_duty}</option>
                <option value="holiday_work">{KIND_LABEL.holiday_work}</option>
              </select>
            </label>
            <WindowFields kind={kind} draft={draft} onChange={setDraft} />
            <WindowHint kind={kind} draft={draft} />
            <EvidenceChoice chosen={evidence} onChange={setEvidence} />
            <button type="submit" disabled={!!problem || submit.isPending}>
              Submit request
            </button>
          </form>
          <p className="hint">Outdoor duty covers working days. Holiday work is for one weekly off or holiday and does not create leave.</p>
          {submit.isSuccess && <p className="ok">Request submitted for review.</p>}
          <EvidenceError error={submit.error} />
        </Section>
      )}

      {ownInScope && !ownHidden && (
        <Section title="My work requests">
          {mine.data?.items.length === 0 && <Empty>No requests yet.</Empty>}
          {!!mine.data?.items.length && (
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>When</th>
                  <th>Purpose</th>
                  <th>State</th>
                  <th>Evidence</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {mine.data.items.map((r) => (
                  <tr key={`${r.kind}:${r.id}`}>
                    <td>{KIND_LABEL[r.kind]}</td>
                    <td>{describeWindow(r)}</td>
                    <td>{r.purpose}</td>
                    <td>
                      <StateBadge state={r.state} />
                    </td>
                    <td>
                      <EvidenceList evidence={r.evidence ?? []} openPath={canOpenEvidence ? (documentId) => evidencePath(r.kind, r.id, documentId) : null} />
                    </td>
                    <td>
                      {(r.state === 'SUBMITTED' || r.state === 'RETURNED') && can('work_request.withdraw.operational') && (
                        <button type="button" className="link" onClick={() => withdraw.mutate(r)}>
                          Withdraw
                        </button>
                      )}{' '}
                      {r.state === 'RETURNED' && can('work_request.submit.operational') && <ResubmitWorkRequest key={`${r.id}:${r.version}`} request={r} onChanged={refresh} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ErrorNote error={mine.error ?? withdraw.error} />
        </Section>
      )}

      {can('work_request.read.operational') && <WorkRequestRegister />}
    </>
  );
}

/** HR views "Leaves & Outdoor" and "Work On Holiday": rows limited by the selected assignment's scope. */
function WorkRequestRegister() {
  // The browser's calendar day, not the UTC one (which is still yesterday for the first hours of an Indian day).
  const today = localDate();
  const [kind, setKind] = useState<Kind>('outdoor_duty');
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const context = useRoleContext();
  const list = useQuery({
    queryKey: ['work-request-register', context, kind, from, to],
    enabled: !!from && !!to,
    queryFn: () => api<{ items: WorkRequest[] }>(`/v1/work-requests/${kind}?from=${from}&to=${to}`),
  });
  return (
    <Section title="Requests in my scope">
      <div className="row">
        <label className="inline">
          Kind{' '}
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="outdoor_duty">{KIND_LABEL.outdoor_duty}</option>
            <option value="holiday_work">{KIND_LABEL.holiday_work}</option>
          </select>
        </label>
        <label className="inline">
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="inline">
          To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {list.data?.items.length === 0 && <Empty>No requests in this period.</Empty>}
      {!!list.data?.items.length && (
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>When</th>
              <th>Purpose</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {list.data.items.map((r) => (
              <tr key={`${r.kind}:${r.id}`}>
                <td>
                  {r.employeeName} <span className="hint">{r.employeeCode}</span>
                </td>
                <td>{describeWindow(r)}</td>
                <td>{r.purpose}</td>
                <td>
                  <StateBadge state={r.state} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ErrorNote error={list.error} />
    </Section>
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
      <span className="hint">Supporting documents:</span>{' '}
      <EvidenceList evidence={evidence} openPath={canOpen ? (documentId) => (requestId ? evidencePath(summary.kind, requestId, documentId) : null) : null} />
      {canOpen && requestId === null && evidence.length > 0 && (
        <p className="hint">The request these documents belong to could not be identified, so they cannot be opened here.</p>
      )}
    </div>
  );
}
