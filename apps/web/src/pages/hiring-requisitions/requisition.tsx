// One requisition: details, budget, actions, approval history and submitted revisions.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, isConflict, isForbidden, isNotFound, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, Item, NotPermitted, Section, When } from '../../ui';
import { Refusal } from './refusals';
import { ReasonForm, RequisitionForm } from './requisition-form';
import { BudgetCheckText, DecisionTable, RequisitionFacts, RevisionTable } from './requisition-views';
import { BUDGET_READ, FLUSH, PATHS, personLabel, REQ_CLOSE, REQ_CREATE, REQ_READ, type RequisitionDetail, type RequisitionInput, shown, SPACED, stepText, type SubmitResult, useKeys, userInSentence, UUID } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Screen: one requisition (details, budget, actions, approval history, submitted revisions)
// ---------------------------------------------------------------------------------------------------------

export function RequisitionDetailScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(REQ_READ)) {
    return (
      <>
        <h1>Requisition</h1>
        <NotPermitted>The selected role cannot view requisitions.</NotPermitted>
      </>
    );
  }
  if (!UUID.test(id)) {
    return (
      <>
        <p style={FLUSH}>
          <Link to={PATHS.requisitions}>Back to requisitions</Link>
        </p>
        <h1>Requisition</h1>
        <Empty>This requisition is not available in the selected role’s scope.</Empty>
      </>
    );
  }
  // A new requisition (a copy) starts with its own state.
  return <RequisitionDetailView key={id} id={id} />;
}

function RequisitionDetailView({ id }: { id: string }) {
  const { me } = useSession();
  const keys = useKeys();
  const location = useLocation();
  const [notice, setNotice] = useState<string | null>(() => {
    const arrived = (location.state as { notice?: unknown } | null)?.notice;
    return typeof arrived === 'string' ? arrived : null;
  });
  const detail = useQuery({ queryKey: keys.requisition(id), queryFn: () => api<RequisitionDetail>(`/v1/hiring/requisitions/${encodeURIComponent(id)}`), retry: retryTransient });
  const r = shown(detail);
  // A background reload (after a change or a conflict) is about to replace the version an action would send.
  const reloading = detail.isFetching && !detail.isPending;
  const myUserId = me?.userId ?? null;
  const returned = r && r.state === 'DRAFT' ? [...r.decisions].reverse().find((d) => d.decision === 'RETURN' && d.revision === r.currentRevision) : undefined;

  return (
    <>
      <p style={FLUSH}>
        <Link to={PATHS.requisitions}>Back to requisitions</Link>
      </p>
      <h1>{r ? `Requisition ${r.code}` : 'Requisition'}</h1>
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
      {detail.isPending && <p className="hint loading">Loading the requisition…</p>}
      {isForbidden(detail.error) ? (
        <NotPermitted>The selected role cannot view this requisition.</NotPermitted>
      ) : isNotFound(detail.error) ? (
        <Empty>This requisition is not available in the selected role’s scope.</Empty>
      ) : (
        <ErrorNote error={detail.error} />
      )}
      {r && (
        <>
          <Section title={r.title}>
            <RequisitionFacts r={r} />
            <dl className="kv" style={SPACED}>
              <Item term="Filled (accepted offers)">{r.filled}</Item>
              <Item term="Created">
                <When at={r.createdAt} />
              </Item>
              {r.submittedAt && (
                <Item term="Last submitted">
                  <When at={r.submittedAt} />
                </Item>
              )}
              {r.decidedAt && (
                <Item term="Decided">
                  <When at={r.decidedAt} />
                </Item>
              )}
              {r.closedAt && (
                <Item term="Closed">
                  <When at={r.closedAt} />
                </Item>
              )}
              {r.closureReason && <Item term="Closure reason">{r.closureReason}</Item>}
              {r.copiedFromRequisitionId && (
                <Item term="Copied from">
                  <Link to={PATHS.requisition(r.copiedFromRequisitionId)}>The requisition it was copied from</Link>
                </Item>
              )}
              {r.predecessorRequestId && (
                <Item term="Raised again after">
                  <Link to={PATHS.requisition(r.predecessorRequestId)}>The rejected requisition</Link>
                </Item>
              )}
            </dl>
            {r.pendingWith && (
              <p>
                Waiting for {userInSentence(r.pendingWith.assignee, myUserId)}: {stepText(r.pendingWith.step, r.pendingWith.action)}, since <When at={r.pendingWith.assignedAt} />.
              </p>
            )}
            {returned && (
              <p role="note">
                Returned for changes by {userInSentence(returned.decidedBy, myUserId)}
                {returned.onBehalfOf ? ` on behalf of ${userInSentence(returned.onBehalfOf, myUserId)}` : ''} on <When at={returned.decidedAt} />
                {returned.reason ? `: ${returned.reason}` : '.'}
              </p>
            )}
          </Section>
          <BudgetSection r={r} />
          <RequisitionActions r={r} reloading={reloading} onNotice={setNotice} />
          <Section title="Approval history">
            {r.decisions.length === 0 ? <Empty>No decisions recorded yet.</Empty> : <DecisionTable decisions={r.decisions} myUserId={myUserId} />}
          </Section>
          <Section title="Submitted revisions">
            {r.revisions.length === 0 ? <Empty>Not submitted yet.</Empty> : <RevisionTable revisions={r.revisions} />}
          </Section>
        </>
      )}
    </>
  );
}

function BudgetSection({ r }: { r: RequisitionDetail }) {
  const { can } = useSession();
  // The budget reference (FR-011), once a submission recorded one: a link for roles that can view manpower budgets
  // (a draft's own check is the live one above; the reference it may carry belongs to an earlier submission).
  const line = r.state !== 'DRAFT' && r.budgetId && can(BUDGET_READ) ? r.budgetId : null;
  if (!r.budgetCheck && !r.budgetExceptionReason && !r.budgetExceptionApprovedAt && !line) return null;
  return (
    <Section title="Budget">
      {r.budgetCheck && <BudgetCheckText check={r.budgetCheck} state={r.state} exceptionReason={r.budgetExceptionReason} />}
      {r.budgetExceptionReason && <p>Budget exception reason: {r.budgetExceptionReason}</p>}
      {r.budgetExceptionApprovedAt && (
        <p>
          <Badge tone="good">exception approved</Badge> The HR approver approved the budget exception on <When at={r.budgetExceptionApprovedAt} />.
        </p>
      )}
      {line && (
        <p>
          Budget reference: <Link to={PATHS.budget(line)}>open the manpower budget line it was checked against</Link>
        </p>
      )}
      {!r.budgetCheck && r.revisions.length > 0 && <p className="hint">The budget check made at each submission is listed under Submitted revisions.</p>}
    </Section>
  );
}

type RequisitionCommand =
  | { kind: 'update'; body: RequisitionInput & { expectedVersion: number } }
  | { kind: 'submit'; expectedVersion: number }
  | { kind: 'withdraw' }
  | { kind: 'discard'; reason: string }
  | { kind: 'copy' }
  | { kind: 'raiseAgain' }
  | { kind: 'close'; reason: string };

function RequisitionActions({ r, reloading, onNotice }: { r: RequisitionDetail; reloading: boolean; onNotice: (text: string | null) => void }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState<'edit' | 'discard' | 'close' | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.requisitions });
    void qc.invalidateQueries({ queryKey: keys.requisitionTasks });
  };
  const run = useMutation({
    mutationFn: (c: RequisitionCommand): Promise<unknown> => {
      const base = `/v1/hiring/requisitions/${encodeURIComponent(r.id)}`;
      switch (c.kind) {
        case 'update':
          return api<RequisitionDetail>(base, { method: 'PUT', body: c.body });
        case 'submit':
          return api<SubmitResult>(`${base}/submit`, { body: { expectedVersion: c.expectedVersion } });
        case 'withdraw':
          return api(`${base}/withdraw`, { method: 'POST' });
        case 'discard':
          return api(`${base}/discard`, { body: { reason: c.reason } });
        case 'copy':
          return api<RequisitionDetail>(`${base}/copy`, { method: 'POST' });
        case 'raiseAgain':
          return api<RequisitionDetail>(`${base}/raise-again`, { method: 'POST' });
        case 'close':
          return api(`${base}/close`, { body: { reason: c.reason } });
      }
    },
    onMutate: () => onNotice(null),
    onSuccess: (result, c) => {
      refresh();
      switch (c.kind) {
        case 'update':
          setOpen(null);
          onNotice('Draft saved.');
          break;
        case 'submit': {
          const s = result as SubmitResult;
          onNotice(`Submitted for approval as revision ${s.revision}${s.budgetStatus === 'WITHIN_BUDGET' ? '' : ', with its budget exception'}. It now waits for validation.`);
          break;
        }
        case 'withdraw':
          onNotice('Withdrawn. The requisition is a draft again, and its reviewer no longer needs to decide it.');
          break;
        case 'discard':
          setOpen(null);
          onNotice('Draft discarded. It is kept as a closed requisition with your reason.');
          break;
        case 'copy': {
          const copy = result as RequisitionDetail;
          navigate(PATHS.requisition(copy.id), { state: { notice: `Copied to ${copy.code}, a new draft with no approvals or decisions. Review it, then submit it for approval.` } });
          break;
        }
        case 'raiseAgain': {
          const raised = result as RequisitionDetail;
          navigate(PATHS.requisition(raised.id), { state: { notice: `Raised again as ${raised.code}, a new draft linked to the rejected requisition. Review it, then submit it for approval.` } });
          break;
        }
        case 'close':
          setOpen(null);
          onNotice('Requisition closed.');
          break;
      }
    },
    // A stale version or a requisition that moved on: reload it, so a retry uses its current version and state.
    onError: (error) => {
      if (isConflict(error) || isNotFound(error)) refresh();
    },
  });

  const isRequester = !!me?.employeeId && me.employeeId === r.requester.id;
  const canCreate = can(REQ_CREATE);
  const mayChange = canCreate && isRequester;
  const draft = r.state === 'DRAFT';
  const waiting = r.state === 'SUBMITTED';
  const mayCopy = canCreate && !!me?.employeeId;
  const mayClose = can(REQ_CLOSE) && r.state === 'APPROVED';
  const othersDraft = canCreate && !isRequester && (draft || waiting);
  // Nothing left to offer (the requisition moved on, perhaps by the refused action itself): the refusal stays shown.
  if (!mayChange && !mayCopy && !mayClose && !othersDraft) return <Refusal error={run.error} action={run.variables?.kind ?? 'update'} />;

  const busy = run.isPending || reloading;
  const needsException = draft && r.budgetCheck !== null && r.budgetCheck.budgetStatus !== 'WITHIN_BUDGET' && !r.budgetExceptionReason;
  const toggle = (panel: 'edit' | 'discard' | 'close') => {
    run.reset();
    setOpen((current) => (current === panel ? null : panel));
  };

  return (
    <Section title="Actions">
      {othersDraft && (
        <p className="hint">
          Only the requester, {personLabel(r.requester)}, can {draft ? 'change, submit or discard this draft' : 'withdraw this requisition'}.
        </p>
      )}
      {mayChange && needsException && <p className="hint">Record a budget exception reason (Edit draft) before submitting: this requisition exceeds its approved budget or has none.</p>}
      <div className="row">
        {mayChange && draft && (
          <>
            <button type="button" className="secondary" aria-expanded={open === 'edit'} disabled={busy} onClick={() => toggle('edit')}>
              Edit draft
            </button>
            <button type="button" disabled={busy} onClick={() => run.mutate({ kind: 'submit', expectedVersion: r.version })}>
              Submit for approval
            </button>
            <button type="button" className="danger" aria-expanded={open === 'discard'} disabled={busy} onClick={() => toggle('discard')}>
              Discard draft
            </button>
          </>
        )}
        {mayChange && waiting && (
          <button type="button" className="secondary" disabled={busy} onClick={() => run.mutate({ kind: 'withdraw' })}>
            Withdraw
          </button>
        )}
        {mayCopy && (
          <button type="button" className="secondary" disabled={busy} onClick={() => run.mutate({ kind: 'copy' })}>
            Copy to a new requisition
          </button>
        )}
        {mayChange && r.state === 'REJECTED' && (
          <button type="button" className="secondary" disabled={busy} onClick={() => run.mutate({ kind: 'raiseAgain' })}>
            Raise again
          </button>
        )}
        {mayClose && (
          <button type="button" className="danger" aria-expanded={open === 'close'} disabled={busy} onClick={() => toggle('close')}>
            Close requisition
          </button>
        )}
      </div>
      {mayCopy && <p className="hint">A copy gets a new reference and keeps the job details only: no approvals, decisions, budget exception or candidates.</p>}
      {open === 'edit' && mayChange && draft && (
        <div style={SPACED}>
          <RequisitionForm
            initial={r}
            busy={busy}
            submitLabel="Save draft"
            onSubmit={(input) => run.mutate({ kind: 'update', body: { ...input, expectedVersion: r.version } })}
            onCancel={() => setOpen(null)}
          />
        </div>
      )}
      {open === 'discard' && mayChange && draft && (
        <ReasonForm
          title="Discard this draft"
          label="Reason for discarding (required)"
          hint="The draft is kept as a closed requisition with your reason; it cannot be submitted afterwards."
          submitLabel="Discard this draft"
          busy={busy}
          onSubmit={(reason) => run.mutate({ kind: 'discard', reason })}
          onCancel={() => setOpen(null)}
        />
      )}
      {open === 'close' && mayClose && (
        <ReasonForm
          title="Close this requisition"
          label="Reason for closing (required)"
          hint="Close it when its vacancies are filled or no longer needed. Open offers must be finished, withdrawn or handed over first."
          submitLabel="Close this requisition"
          busy={busy}
          onSubmit={(reason) => run.mutate({ kind: 'close', reason })}
          onCancel={() => setOpen(null)}
        />
      )}
      <Refusal error={run.error} action={run.variables?.kind ?? 'update'} />
    </Section>
  );
}

