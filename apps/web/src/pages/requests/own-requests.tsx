// Outdoor duty and work on holiday (FR-027, I-05..I-07): the own new request and the own requests, each with its follow-ups
// (withdraw, correct and resubmit a returned one, cancel an approved one, raise a rejected one again); the HR register below for
// team and company scopes.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { ButtonRow, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions } from '@/components/row-actions';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, localDate } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section, StateBadge } from '../../ui';
import { EvidenceChoice, EvidenceError, EvidenceList, evidencePath, staleEvidence, unusable, useCanChooseEvidence } from './evidence';
import { canRaiseAgain, followedRequests, RaiseAgainNote, RaisedAgainHint } from './raise-again';
import { WorkRequestRegister } from './register';
import { CELL_FORM, type Kind, KIND_LABEL, ownRecordInScope, ownRecordNotFound, useRoleContext, type WorkRequest } from './shared';
import { blankDraft, type Draft, describeWindow, requestBody, WindowFields, WindowHint, windowProblem } from './window';

/** Which inline follow-up an own request has open: correcting a returned one, or cancelling an approved one. */
type FollowUp = 'resubmit' | 'cancel' | null;

/**
 * An own request's actions cell: the actions given as children (withdraw, raise again), the button of each follow-up the request
 * offers, and below them the follow-up's form once opened (its button gives way to it, and Close brings it back). A closed form
 * stays mounted, so what was typed in it is still there when it is opened again. The column is not narrowed to its buttons (as
 * row-actions.tsx suggests): a form may open in any row, and one narrow cell would narrow the whole column, the form with it.
 */
function OwnRequestActionsCell({
  request: r,
  resubmit,
  cancel,
  onChanged,
  children,
}: {
  request: WorkRequest;
  resubmit: boolean;
  cancel: boolean;
  onChanged: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<FollowUp>(null);
  const close = () => setOpen(null);
  return (
    <TableCell>
      <RowActions>
        {children}
        {resubmit && open !== 'resubmit' && (
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen('resubmit')}>
            Correct and resubmit
          </Button>
        )}
        {cancel && open !== 'cancel' && (
          <Button type="button" variant="danger" size="sm" aria-label={`Cancel the approved ${KIND_LABEL[r.kind]} request`} onClick={() => setOpen('cancel')}>
            Cancel
          </Button>
        )}
      </RowActions>
      {resubmit && <ResubmitWorkRequest request={r} open={open === 'resubmit'} onClose={close} onChanged={onChanged} />}
      {cancel && <CancelApprovedRequest request={r} open={open === 'cancel'} onClose={close} onChanged={onChanged} />}
    </TableCell>
  );
}

interface FollowUpProps {
  request: WorkRequest;
  /** Closed, the form draws nothing but keeps what was typed. */
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

/**
 * DF03/I-07: a returned request is corrected and resubmitted as a new revision (the server checks the version). I-22:
 * without a new choice of documents the server carries the earlier evidence forward; a new choice replaces it.
 */
function ResubmitWorkRequest({ request: r, open, onClose, onChanged }: FollowUpProps) {
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
      onClose();
      setEvidence([]);
      onChanged();
    },
    // A document attached before or chosen changed meanwhile: the documents and this request's evidence are read
    // again, so the form says which one cannot be used. What was typed stays (the actions cell is keyed by the version).
    onError: (error) => {
      if (!staleEvidence(error)) return;
      void qc.invalidateQueries({ queryKey: ['documents', me?.employeeId] });
      onChanged();
    },
  });
  if (!open) return null;
  const problem = windowProblem(r.kind, draft);
  const earlier = r.evidence ?? [];
  const count = earlier.length === 1 ? '1 document' : `${earlier.length} documents`;
  return (
    <FormGrid
      className={CELL_FORM}
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) resubmit.mutate(evidence);
      }}
    >
      <WindowFields kind={r.kind} draft={draft} onChange={setDraft} />
      <WindowHint kind={r.kind} draft={draft} />
      {earlier.length > 0 && (
        <Hint>
          {canChoose
            ? `Without a new choice, the resubmission keeps the evidence attached before (${count}). Ticking documents replaces it, so tick an earlier document again to keep it.`
            : `The resubmission keeps the evidence attached before (${count}).`}
          {canChoose && earlier.some(unusable) && ' A document attached before failed the malware scan or was rejected, so choose the documents to attach.'}
        </Hint>
      )}
      <EvidenceChoice chosen={evidence} onChange={setEvidence} earlier={earlier} />
      <ButtonRow>
        <Button type="submit" disabled={!!problem || resubmit.isPending}>
          Resubmit
        </Button>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </ButtonRow>
      <EvidenceError error={resubmit.error} keptEarlier={resubmit.variables?.length === 0} />
    </FormGrid>
  );
}

/**
 * I-84 item 15: an approved request is cancelled by its employee before its first day, with a reason and the version. The server
 * decides by the company's business date; this offers it while the first day is still ahead on this device's calendar.
 */
function CancelApprovedRequest({ request: r, open, onClose, onChanged }: FollowUpProps) {
  const [reason, setReason] = useState('');
  const cancel = useMutation({
    mutationFn: () => api(`/v1/work-requests/${r.kind}/${r.id}/cancel`, { body: { reason: reason.trim(), expectedVersion: r.version } }),
    onSuccess: () => {
      onClose();
      setReason('');
      onChanged();
    },
  });
  if (!open) return null;
  return (
    <FormGrid
      className={CELL_FORM}
      aria-label="Cancel an approved request"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) cancel.mutate();
      }}
    >
      <FormField className="col-span-full">
        Reason for cancelling
        <Input required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      <ButtonRow>
        <Button type="submit" disabled={!reason.trim() || cancel.isPending}>
          Cancel request
        </Button>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </ButtonRow>
      <ErrorNote error={cancel.error} />
    </FormGrid>
  );
}

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
  const [raisingAgain, setRaisingAgain] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['work-requests'] });
    void qc.invalidateQueries({ queryKey: ['work-request-register'] });
  };
  const submit = useMutation({
    mutationFn: () =>
      api(`/v1/work-requests/${kind}`, {
        body: { ...requestBody(kind, draft), ...(evidence.length ? { evidenceDocumentIds: evidence } : {}), ...(raisingAgain ? { predecessorRequestId: raisingAgain } : {}) },
      }),
    // A submitted request starts the form clean; a refused one keeps what was typed and chosen for correction.
    onSuccess: () => {
      setDraft(blankDraft());
      setEvidence([]);
      setRaisingAgain(null);
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
          <Hint>Outdoor duty covers working days. Holiday work is for one weekly off or holiday and does not create leave.</Hint>
          {raisingAgain && <RaiseAgainNote onCancel={() => setRaisingAgain(null)} />}
          <FormGrid
            onSubmit={(e) => {
              e.preventDefault();
              if (!problem) submit.mutate();
            }}
          >
            <FormField>
              Type
              <NativeSelect
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as Kind);
                  // A request follows only one of its own kind.
                  setRaisingAgain(null);
                }}
              >
                <option value="outdoor_duty">{KIND_LABEL.outdoor_duty}</option>
                <option value="holiday_work">{KIND_LABEL.holiday_work}</option>
              </NativeSelect>
            </FormField>
            <WindowFields kind={kind} draft={draft} onChange={setDraft} />
            <WindowHint kind={kind} draft={draft} />
            <EvidenceChoice chosen={evidence} onChange={setEvidence} />
            <Button type="submit" disabled={!!problem || submit.isPending}>
              Submit request
            </Button>
          </FormGrid>
          {submit.isSuccess && <StatusNote tone="success">Request submitted for review.</StatusNote>}
          <EvidenceError error={submit.error} />
        </Section>
      )}

      {ownInScope && !ownHidden && (
        <Section title="My work requests">
          {mine.data?.items.length === 0 && (
            <Empty>{can('work_request.submit.operational') ? 'No requests yet. Use the form above to request outdoor duty or holiday work.' : 'No requests yet.'}</Empty>
          )}
          {!!mine.data?.items.length && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Type</TableHead>
                  <TableHead scope="col">When</TableHead>
                  <TableHead scope="col">Purpose</TableHead>
                  <TableHead scope="col">State</TableHead>
                  <TableHead scope="col">Evidence</TableHead>
                  <TableHead scope="col">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mine.data.items.map((r) => (
                  <TableRow key={`${r.kind}:${r.id}`}>
                    <TableCell>{KIND_LABEL[r.kind]}</TableCell>
                    <TableCell>{describeWindow(r)}</TableCell>
                    <TableCell>{r.purpose}</TableCell>
                    <TableCell>
                      <StateBadge state={r.state} />
                      <RaisedAgainHint predecessorRequestId={r.predecessorRequestId} />
                    </TableCell>
                    <TableCell>
                      <EvidenceList evidence={r.evidence ?? []} openPath={canOpenEvidence ? (documentId) => evidencePath(r.kind, r.id, documentId) : null} />
                    </TableCell>
                    {/* Keyed by the version: a request changed meanwhile closes its open form and starts it again from the new revision. */}
                    <OwnRequestActionsCell
                      key={`${r.id}:${r.version}`}
                      request={r}
                      resubmit={r.state === 'RETURNED' && can('work_request.submit.operational')}
                      cancel={r.state === 'APPROVED' && r.startDate.slice(0, 10) > localDate() && can('work_request.withdraw.operational')}
                      onChanged={refresh}
                    >
                      {(r.state === 'SUBMITTED' || r.state === 'RETURNED') && can('work_request.withdraw.operational') && (
                        <Button type="button" variant="danger" size="sm" onClick={() => withdraw.mutate(r)}>
                          Withdraw
                        </Button>
                      )}{' '}
                      {canRaiseAgain(r, followedRequests(mine.data?.items ?? [])) && can('work_request.submit.operational') && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label={`Raise again the rejected ${KIND_LABEL[r.kind]} request`}
                          onClick={() => {
                            submit.reset();
                            setKind(r.kind);
                            setDraft({
                              startDate: r.startDate.slice(0, 10),
                              endDate: r.endDate.slice(0, 10),
                              timed: r.startTime !== null,
                              startTime: r.startTime ?? '09:00',
                              endTime: r.endTime ?? '13:00',
                              purpose: r.purpose,
                            });
                            setEvidence([]);
                            setRaisingAgain(r.id);
                          }}
                        >
                          Raise again
                        </Button>
                      )}
                    </OwnRequestActionsCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <ErrorNote error={mine.error ?? withdraw.error} />
        </Section>
      )}

      {/* An own-scope role would see only its own requests again: the register is for team and company scopes. */}
      {can('work_request.read.operational') && me?.scopeKind !== 'OWN' && <WorkRequestRegister />}
    </>
  );
}
