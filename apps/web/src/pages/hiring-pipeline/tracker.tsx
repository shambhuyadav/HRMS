// The hiring tracker screen (FR-014): vacancies, candidates by stage, and each open application's stage, owner, pending action and ageing.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Section } from '../../ui';
import { LoadProblem } from './refusals';
import { ageing, APPLICATION_READ, CandidateLink, COMPENSATION_READ, Denied, labelOf, LIMITS, OFFER_READ, OFFER_STATE_LABEL, PATHS, PENDING_ACTION_LABEL, personText, RequisitionStateBadge, SCROLL, SR_ONLY, StageBadge, stageCounts, useKeys, useUserId } from './shared';
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
      {tracker.isPending && <p className="hint loading">Loading the tracker…</p>}
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

export function ApplicationTable({ items, showRequisition, label }: { items: ApplicationRow[]; showRequisition: boolean; label: string }) {
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

