// The hiring tracker screen (FR-014): vacancies, candidates by stage, and each open application's stage, owner, pending action and ageing.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckField, ChoiceRow } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActionsCell } from '@/components/row-actions';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Section } from '../../ui';
import { LoadProblem } from './refusals';
import { ageing, APPLICATION_READ, CandidateLink, COMPENSATION_READ, Denied, labelOf, LIMITS, OFFER_READ, OFFER_STATE_LABEL, PATHS, PENDING_ACTION_LABEL, personText, RequisitionStateBadge, StageBadge, stageCounts, useKeys, useUserId } from './shared';
import type { ApplicationRow, Tracker, Vacancy } from './types';

// ---------------------------------------------------------------------------------------------------------
// FR-014 tracker: vacancies, candidates by stage, and each open application's stage, owner, pending action, ageing
// ---------------------------------------------------------------------------------------------------------

export function HiringTrackerScreen() {
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
  const noApplications = mine ? 'You own no open applications.' : 'No open applications.';
  return (
    <>
      <ChoiceRow>
        <CheckField>
          <input type="checkbox" checked={includeClosed} onChange={(e) => setIncludeClosed(e.target.checked)} /> Include closed requisitions
        </CheckField>
        <CheckField>
          <input type="checkbox" checked={mine} disabled={userId === null} onChange={(e) => setMine(e.target.checked)} /> Only applications I own
        </CheckField>
      </ChoiceRow>
      {tracker.isPending && <LoadingLine>Loading the tracker…</LoadingLine>}
      <LoadProblem error={tracker.error} forbidden="The selected role cannot view the hiring pipeline." />
      {data && (
        <>
          <Section title={`Vacancies (${data.vacancies.length})`}>
            <Hint>Approved requisitions{includeClosed ? ' and closed ones' : ''}: filled places are accepted offers.</Hint>
            {data.vacancies.length === 0 ? <Empty>No approved requisitions in the selected role’s scope.</Empty> : <VacancyTable items={data.vacancies} />}
            {data.vacancies.length >= LIMITS.trackerVacancies && <Hint>Showing the first {LIMITS.trackerVacancies} requisitions by target date.</Hint>}
          </Section>
          <Section title={`Open applications (${data.applications.length})`}>
            <Hint>Applications at the applied, screening, interview or offer stage, longest in their stage first. Ageing counts calendar days in the current stage.</Hint>
            {data.applications.length === 0 ? <Empty>{noApplications}</Empty> : <ApplicationTable items={data.applications} showRequisition label="Open applications" />}
            {data.applications.length >= LIMITS.trackerApplications && <Hint>Showing the first {LIMITS.trackerApplications} applications.</Hint>}
          </Section>
        </>
      )}
    </>
  );
}

function VacancyTable({ items }: { items: Vacancy[] }) {
  return (
    <Table aria-label="Vacancies">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Requisition</TableHead>
          <TableHead scope="col">State</TableHead>
          <TableHead scope="col">Vacancies</TableHead>
          <TableHead scope="col">Filled</TableHead>
          <TableHead scope="col">Open places</TableHead>
          <TableHead scope="col">Target date</TableHead>
          <TableHead scope="col">Candidates by stage</TableHead>
          <TableHead scope="col">
            <span className="sr-only">Applications</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((v) => (
          <TableRow key={v.id}>
            <TableCell>
              {v.code} <Hint as="span">{v.title}</Hint>
            </TableCell>
            <TableCell>
              <RequisitionStateBadge state={v.state} />
            </TableCell>
            <TableCell>{v.vacancies}</TableCell>
            <TableCell>{v.filled}</TableCell>
            <TableCell>{v.openPlaces}</TableCell>
            <TableCell>{formatDate(v.targetDate)}</TableCell>
            <TableCell>{stageCounts(v.byStage)}</TableCell>
            <RowActionsCell>
              <Link to={PATHS.requisitionApplications(v.id)} aria-label={`Applications for ${v.code}`}>
                Applications
              </Link>
            </RowActionsCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The latest offer's state, as a link to the offer for a role that may open it. */
function LatestOffer({ application: a, canOpen }: { application: ApplicationRow; canOpen: boolean }) {
  if (a.latestOffer === null) return <>—</>;
  const state = labelOf(OFFER_STATE_LABEL, a.latestOffer.state);
  if (!canOpen) return <>{state}</>;
  return (
    <Link to={PATHS.offer(a.latestOffer.id)} aria-label={`Offer to ${a.candidate.fullName}: ${state}`}>
      {state}
    </Link>
  );
}

export function ApplicationTable({ items, showRequisition, label }: { items: ApplicationRow[]; showRequisition: boolean; label: string }) {
  const { can } = useSession();
  const userId = useUserId();
  const canOpenOffer = can(OFFER_READ) || can(COMPENSATION_READ);
  return (
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Candidate</TableHead>
          {showRequisition && <TableHead scope="col">Requisition</TableHead>}
          <TableHead scope="col">Stage</TableHead>
          <TableHead scope="col">In stage since</TableHead>
          <TableHead scope="col">Ageing</TableHead>
          <TableHead scope="col">Owner</TableHead>
          <TableHead scope="col">Pending action</TableHead>
          <TableHead scope="col">Latest offer</TableHead>
          <TableHead scope="col">
            <span className="sr-only">Application</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((a) => (
          <TableRow key={a.id}>
            <TableCell>
              <CandidateLink candidate={a.candidate} />
            </TableCell>
            {showRequisition && (
              <TableCell>
                {a.requisition.code} <Hint as="span">{a.requisition.title}</Hint>
              </TableCell>
            )}
            <TableCell>
              <StageBadge stage={a.stage} />
            </TableCell>
            <TableCell>{formatDate(a.stageEnteredAt)}</TableCell>
            <TableCell>{ageing(a.ageingDays)}</TableCell>
            <TableCell>{personText(a.owner, userId)}</TableCell>
            <TableCell>{a.pendingAction ? labelOf(PENDING_ACTION_LABEL, a.pendingAction) : '—'}</TableCell>
            <TableCell>
              <LatestOffer application={a} canOpen={canOpenOffer} />
            </TableCell>
            <RowActionsCell>
              <Link to={PATHS.application(a.id)} aria-label={`Open the application of ${a.candidate.fullName} (${a.candidate.candidateCode})`}>
                Open
              </Link>
            </RowActionsCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
