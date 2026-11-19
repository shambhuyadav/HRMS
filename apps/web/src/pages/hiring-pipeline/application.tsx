// One application: stage moves as the API allows, owner, history, and its offers.
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatDate, isConflict, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, Section } from '../../ui';
import { LoadProblem, OFFER_WORDS, Refusal, STAGE_WORDS } from './refusals';
import { ageing, APPLICATION_MANAGE, APPLICATION_READ, CandidateLink, COMPENSATION_READ, Denied, enc, GROUP, H3, labelOf, Missing, NEXT_STAGE, OFFER_MANAGE, OFFER_READ, OfferStateBadge, OPEN_OFFER_STATES, OPEN_STAGES, PATHS, PENDING_ACTION_LABEL, personText, Problem, RequisitionStateBadge, SCROLL, SR_ONLY, STAGE_LABEL, StageBadge, TEXTAREA, useKeys, useRefresh, useUserId, UUID } from './shared';
import type { ApplicationView, OfferView, StageMoved } from './types';

// ---------------------------------------------------------------------------------------------------------
// One application: stage moves as the API allows, owner, history and its offers
// ---------------------------------------------------------------------------------------------------------

export function ApplicationScreen() {
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
          <Link className="back-link" to={PATHS.requisitionApplications(a.requisition.id)}>← Applications for {a.requisition.code}</Link>
        </p>
      )}
      <h1>{a ? `Application of ${a.candidate.fullName} (${a.candidate.candidateCode}) for ${a.requisition.code}` : 'Application'}</h1>
      {detail.isPending && <p className="hint loading">Loading the application…</p>}
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

