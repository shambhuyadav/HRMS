// One application: stage moves as the API allows, owner, history, and its offers.
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BackLink } from '@/components/back-link';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, CheckField, ChoiceRow, FormField, FormGrid, LabelledFieldset } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActionsCell } from '@/components/row-actions';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, formatDate, isConflict, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, Section } from '../../ui';
import { LoadProblem, OFFER_WORDS, Refusal, STAGE_WORDS } from './refusals';
import {
  ageing,
  APPLICATION_MANAGE,
  APPLICATION_READ,
  CandidateLink,
  COMPENSATION_READ,
  Denied,
  enc,
  labelOf,
  Missing,
  NEXT_STAGE,
  Notice,
  OFFER_MANAGE,
  OFFER_READ,
  OfferStateBadge,
  OPEN_OFFER_STATES,
  OPEN_STAGES,
  PATHS,
  PENDING_ACTION_LABEL,
  personText,
  Problem,
  RequisitionStateBadge,
  STAGE_LABEL,
  StageBadge,
  useKeys,
  useRefresh,
  useUserId,
  UUID,
} from './shared';
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
      {a && <BackLink to={PATHS.requisitionApplications(a.requisition.id)}>← Applications for {a.requisition.code}</BackLink>}
      <h1>{a ? `Application of ${a.candidate.fullName} (${a.candidate.candidateCode}) for ${a.requisition.code}` : 'Application'}</h1>
      {detail.isPending && <LoadingLine>Loading the application…</LoadingLine>}
      <LoadProblem error={detail.error} forbidden="The selected role cannot view this application." missing="This application is not available in the selected role’s scope." />
      {a && (
        <>
          <Section title="Application">
            <dl className="kv">
              <Item term="Candidate">
                <CandidateLink candidate={a.candidate} withState />
              </Item>
              <Item term="Requisition">
                {a.requisition.code} <Hint as="span">{a.requisition.title}</Hint> <RequisitionStateBadge state={a.requisition.state} />
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
            {a.history.length === 0 ? <Empty>No stage changes recorded.</Empty> : <StageHistoryTable history={a.history} userId={userId} />}
          </Section>
          <ApplicationOffers application={a} busy={reloading} onDone={refresh} />
        </>
      )}
    </>
  );
}

function StageHistoryTable({ history, userId }: { history: ApplicationView['history']; userId: string | null }) {
  return (
    <Table aria-label="Stage history">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">From</TableHead>
          <TableHead scope="col">To</TableHead>
          <TableHead scope="col">Note</TableHead>
          <TableHead scope="col">By</TableHead>
          <TableHead scope="col">When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {history.map((h, index) => (
          <TableRow key={`${h.occurredAt}-${index}`}>
            <TableCell>{h.fromStage ? labelOf(STAGE_LABEL, h.fromStage) : '—'}</TableCell>
            <TableCell>{labelOf(STAGE_LABEL, h.toStage)}</TableCell>
            <TableCell>{h.note ?? '—'}</TableCell>
            <TableCell>{userId !== null && h.actorUserId === userId ? 'You' : 'Another user'}</TableCell>
            <TableCell>{formatDate(h.occurredAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
        // Set apart from the application's facts above it, which end without a margin of their own.
        <ButtonRow className="mt-4">
          <Button type="button" variant="outline" disabled={busy || assign.isPending} onClick={() => assign.mutate({ ownerUserId: userId, expectedVersion: a.version })}>
            Assign to me
          </Button>
        </ButtonRow>
      )}
      {assign.isSuccess && a.owner.userId === userId && <Notice text="You now own this application." />}
      <Refusal error={assign.error} words={STAGE_WORDS} />
    </>
  );
}

/** Why the application cannot move forward, if it cannot: the API moves it only on an approved requisition and an active candidate. */
function forwardBlockedText(a: ApplicationView): string | null {
  if (a.requisition.state !== 'APPROVED') return 'The requisition is no longer approved, so the application cannot move forward. It can still be ended.';
  if (a.candidate.state !== 'ACTIVE') return 'The candidate record is not active, so the application cannot move forward. It can still be ended.';
  return null;
}

/** What a stage move did, in words: an ending leaves the candidate's other applications as they are. */
function movedText(result: StageMoved | undefined): string | null {
  if (!result) return null;
  const stage = labelOf(STAGE_LABEL, result.stage).toLowerCase();
  if (result.stage === 'REJECTED' || result.stage === 'WITHDRAWN') {
    return `The application was ${stage}. The candidate record and the candidate’s other applications are unchanged.`;
  }
  return `The application is now at the ${stage} stage.`;
}

/** The ending's required answers, checked before sending. */
function endProblem(ending: string, note: string): string | null {
  if (ending === '') return 'Choose how the application ends.';
  if (!note) return 'Record why the application ends.';
  return null;
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
  const forwardBlocked = forwardBlockedText(a);
  const resultText = movedText(move.isSuccess ? move.data : undefined);

  if (!OPEN_STAGES.includes(a.stage)) {
    return (
      <Section title="Stage">
        <Notice text={resultText} />
        <Hint>This application has ended ({labelOf(STAGE_LABEL, a.stage).toLowerCase()}); its stage no longer changes.</Hint>
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
    const missing = endProblem(ending, text);
    setProblem(missing);
    if (missing || ending === '') {
      move.reset();
      return;
    }
    move.mutate({ toStage: ending, note: text, expectedVersion: a.version });
  };

  return (
    <Section title="Stage">
      <Notice text={resultText} />
      {next && forwardBlocked && <Hint>{forwardBlocked}</Hint>}
      {next && !forwardBlocked && (
        <FormGrid aria-label="Move forward" onSubmit={forward} noValidate>
          <FormField className="col-span-full">
            Note on the move (optional)
            <Textarea maxLength={1000} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </FormField>
          <ButtonRow className="col-span-full">
            <Button type="submit" disabled={disabled}>
              Move to {labelOf(STAGE_LABEL, next).toLowerCase()}
            </Button>
          </ButtonRow>
        </FormGrid>
      )}
      {!next && <Hint>At the offer stage the application becomes hired only through the handover of its accepted offer.</Hint>}
      <FormGrid aria-label="End the application" onSubmit={end} noValidate>
        <LabelledFieldset legend="End this application">
          <ChoiceRow>
            <CheckField>
              <input type="radio" name={`${id}-end`} value="REJECTED" checked={ending === 'REJECTED'} onChange={() => setEnding('REJECTED')} /> Rejected
            </CheckField>
            <CheckField>
              <input type="radio" name={`${id}-end`} value="WITHDRAWN" checked={ending === 'WITHDRAWN'} onChange={() => setEnding('WITHDRAWN')} /> Withdrawn
            </CheckField>
          </ChoiceRow>
        </LabelledFieldset>
        <FormField className="col-span-full">
          Why the application ends (required)
          <Textarea required maxLength={1000} rows={2} value={endNote} onChange={(e) => setEndNote(e.target.value)} />
        </FormField>
        <Hint>This ends this application only: the candidate record and the candidate’s applications to other requisitions stay as they are.</Hint>
        {openOffer && <Hint>This application has an open offer: withdraw the offer before ending the application.</Hint>}
        <Problem text={problem} />
        <ButtonRow className="col-span-full">
          <Button type="submit" variant="danger" disabled={disabled}>
            End the application
          </Button>
        </ButtonRow>
      </FormGrid>
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
        <StatusNote tone="success" role="status">
          Draft offer prepared. {canOpen && <Link to={PATHS.offer(created.id)}>Open the draft offer</Link>}
        </StatusNote>
      )}
      {a.offers.length === 0 ? <Empty>No offers yet.</Empty> : <ApplicationOfferTable offers={a.offers} canOpen={canOpen} />}
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
          <Hint>An offer needs an approved requisition and an active candidate record.</Hint>
        ))}
      {can(OFFER_MANAGE) && OPEN_STAGES.includes(a.stage) && a.stage !== 'OFFER' && <Hint>An offer is prepared once the application reaches the offer stage.</Hint>}
    </Section>
  );
}

function ApplicationOfferTable({ offers, canOpen }: { offers: ApplicationView['offers']; canOpen: boolean }) {
  return (
    <Table aria-label="Offers of the application">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">State</TableHead>
          <TableHead scope="col">Proposed joining date</TableHead>
          <TableHead scope="col">Revision</TableHead>
          <TableHead scope="col">Prepared</TableHead>
          {canOpen && (
            <TableHead scope="col">
              <span className="sr-only">Offer</span>
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {offers.map((o) => (
          <TableRow key={o.id}>
            <TableCell>
              <OfferStateBadge state={o.state} />
            </TableCell>
            <TableCell>{formatDate(o.proposedJoiningDate)}</TableCell>
            <TableCell>{o.currentRevision > 0 ? o.currentRevision : 'Not submitted'}</TableCell>
            <TableCell>{formatDate(o.createdAt)}</TableCell>
            {canOpen && (
              <RowActionsCell>
                <Link to={PATHS.offer(o.id)} aria-label={`Open the offer of ${formatDate(o.createdAt)}`}>
                  Open
                </Link>
              </RowActionsCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
      <CardSubheading id={`${id}-title`}>Prepare an offer</CardSubheading>
      <FormGrid aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <FormField>
          Proposed joining date (required)
          <Input type="date" required value={joining} onChange={(e) => setJoining(e.target.value)} />
        </FormField>
        <Hint>The offer starts as a draft. An eligible Admin records its confidential compensation before it is submitted for independent approval.</Hint>
        <Problem text={problem} />
        {create.error && (
          <div className="col-span-full">
            <Refusal error={create.error} words={OFFER_WORDS} />
          </div>
        )}
        <ButtonRow className="col-span-full">
          <Button type="submit" disabled={create.isPending || busy}>
            Prepare draft offer
          </Button>
        </ButtonRow>
      </FormGrid>
    </>
  );
}
