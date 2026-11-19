// The applications of one requisition (one per candidate and requisition), and adding a candidate to it.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatDate, isConflict, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, Section } from '../../ui';
import { candidateListQuery } from './candidates';
import { APPLY_WORDS, LoadProblem, Refusal } from './refusals';
import { APPLICATION_MANAGE, APPLICATION_READ, CANDIDATE_READ, Denied, enc, labelOf, LIMITS, Missing, PATHS, REQUISITION_READ, REQUISITION_STATE_LABEL, RequisitionStateBadge, SCROLL, SR_ONLY, useKeys, useRefresh, UUID } from './shared';
import { ApplicationTable } from './tracker';
import type { ApplicationRow, ApplicationView, CandidatePage, CandidateSummary, RequisitionView } from './types';

// ---------------------------------------------------------------------------------------------------------
// Applications of one requisition (one per candidate and requisition)
// ---------------------------------------------------------------------------------------------------------

export function RequisitionApplicationsScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(APPLICATION_READ)) return <Denied title="Applications">The selected role cannot view applications.</Denied>;
  if (!UUID.test(id)) return <Missing title="Applications">This requisition is not available in the selected role’s scope.</Missing>;
  return <RequisitionApplications key={id} id={id} />;
}

function RequisitionApplications({ id }: { id: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const requisition = useQuery({
    queryKey: keys.requisition(id),
    enabled: can(REQUISITION_READ),
    queryFn: () => api<RequisitionView>(`/v1/hiring/requisitions/${enc(id)}`),
    retry: retryTransient,
  });
  const list = useQuery({ queryKey: keys.applications(id), queryFn: () => api<{ items: ApplicationRow[] }>(`/v1/hiring/applications?requisitionId=${enc(id)}`), retry: retryTransient });
  const items = list.data?.items ?? [];
  const r = requisition.data;
  const state = r?.state ?? items[0]?.requisition.state ?? null;
  const code = r?.code ?? items[0]?.requisition.code ?? null;
  return (
    <>
      <p>
        <Link className="back-link" to={PATHS.tracker}>← Hiring tracker</Link>
      </p>
      <h1>{code ? `Applications for ${code}` : 'Applications for the requisition'}</h1>
      {r && <RequisitionSummary r={r} />}
      <LoadProblem error={requisition.error} forbidden="The selected role cannot view this requisition." missing="This requisition is not available in the selected role’s scope." />
      <Section title={`Applications${list.data ? ` (${items.length})` : ''}`}>
        <p className="hint">One application per candidate and requisition. Each application is decided on its own: ending one never changes the candidate’s other applications.</p>
        {list.isPending && <p className="hint loading">Loading applications…</p>}
        <LoadProblem error={list.error} forbidden="The selected role cannot view applications." />
        {list.data && items.length === 0 && <Empty>No candidates have applied to this requisition yet.</Empty>}
        {items.length > 0 && <ApplicationTable items={items} showRequisition={false} label="Applications" />}
        {items.length >= LIMITS.applications && <p className="hint">Showing the first {LIMITS.applications} applications.</p>}
      </Section>
      {can(APPLICATION_MANAGE) &&
        can(CANDIDATE_READ) &&
        (state === null || state === 'APPROVED' ? (
          <AddApplicationPanel requisitionId={id} appliedCandidateIds={new Set(items.map((a) => a.candidate.id))} />
        ) : (
          <Section title="Add a candidate">
            <p className="hint">Candidates apply only to an approved requisition; this one is {labelOf(REQUISITION_STATE_LABEL, state).toLowerCase()}.</p>
          </Section>
        ))}
    </>
  );
}

function RequisitionSummary({ r }: { r: RequisitionView }) {
  return (
    <Section title="Requisition">
      <dl className="kv">
        <Item term="Requisition">
          {r.code} <span className="hint">{r.title}</span>
        </Item>
        <Item term="State">
          <RequisitionStateBadge state={r.state} />
        </Item>
        <Item term="Vacancies">{r.vacancies}</Item>
        <Item term="Filled">{r.filled}</Item>
        <Item term="Target date">{formatDate(r.targetDate)}</Item>
        {r.department && <Item term="Department">{r.department.name}</Item>}
        {r.location && <Item term="Location">{r.location.name}</Item>}
        {r.designation && <Item term="Designation">{r.designation.name}</Item>}
        {r.hiringManager && (
          <Item term="Hiring manager">
            {r.hiringManager.displayName} <span className="hint">{r.hiringManager.employeeCode}</span>
          </Item>
        )}
      </dl>
      <p>
        <Link to={PATHS.requisition(r.id)}>Open requisition {r.code}</Link>
      </p>
    </Section>
  );
}

function AddApplicationPanel({ requisitionId, appliedCandidateIds }: { requisitionId: string; appliedCandidateIds: ReadonlySet<string> }) {
  const keys = useKeys();
  const refresh = useRefresh();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState<string | null>(null);
  const qs = term === null ? '' : `picker:${candidateListQuery({ term, state: 'ACTIVE', page: 1 })}`;
  const hits = useQuery({
    queryKey: keys.candidates(qs),
    enabled: term !== null,
    queryFn: () => api<CandidatePage>(`/v1/hiring/candidates?${candidateListQuery({ term: term ?? '', state: 'ACTIVE', page: 1 })}`),
    retry: retryTransient,
  });
  const add = useMutation({
    mutationFn: (candidate: CandidateSummary) => api<ApplicationView>(`/v1/hiring/requisitions/${enc(requisitionId)}/applications`, { body: { candidateId: candidate.id } }),
    onSuccess: () => refresh(),
    // Applied meanwhile, or the requisition or the candidate moved on: the lists are read again to show the server's state.
    onError: (error) => {
      if (isConflict(error)) refresh();
    },
  });
  return (
    <Section title="Add a candidate">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(search.trim());
        }}
      >
        <label className="inline">
          Find an active candidate
          <input type="search" maxLength={100} value={search} placeholder="Code, name or skill" onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button type="submit" className="secondary">
          Search candidates
        </button>
      </form>
      {term !== null && hits.isPending && <p className="hint">Searching…</p>}
      <LoadProblem error={hits.error} forbidden="The selected role cannot search the candidate register." />
      {hits.data && hits.data.items.length === 0 && <Empty>No active candidates match.</Empty>}
      {hits.data && hits.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Active candidates">
            <thead>
              <tr>
                <th scope="col">Candidate</th>
                <th scope="col">Skills</th>
                <th scope="col">
                  <span style={SR_ONLY}>Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {hits.data.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.fullName} <span className="hint">{c.candidateCode}</span>
                  </td>
                  <td>{c.skills.length > 0 ? c.skills.join(', ') : '—'}</td>
                  <td>
                    {appliedCandidateIds.has(c.id) ? (
                      <span className="hint">Already applied</span>
                    ) : (
                      <button type="button" disabled={add.isPending} aria-label={`Add ${c.fullName} (${c.candidateCode}) to this requisition`} onClick={() => add.mutate(c)}>
                        Add to this requisition
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hits.data.total > hits.data.items.length && <p className="hint">Showing the first {hits.data.items.length} of {hits.data.total}; refine the search.</p>}
        </div>
      )}
      <Refusal error={add.error} words={APPLY_WORDS} />
      {add.isSuccess && (
        <p className="ok" role="status">
          {add.data.candidate.fullName} ({add.data.candidate.candidateCode}) now has an application at the applied stage.{' '}
          <Link to={PATHS.application(add.data.id)}>Open the application</Link>
        </p>
      )}
    </Section>
  );
}

