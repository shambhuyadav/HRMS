// Appraisal reports (FR-044) within row scope, the export, and the training needs suggested to training planning.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, download, personLabel, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, NotPermitted, Section, When } from '../../ui';
import { CycleSelect, DepartmentSelect } from './lookups';
import { QueryProblem, Refusal } from './refusals';
import { CYCLE_READ, EXPORT, FLUSH, H3, periodText, REPORT, type Report, REPORT_RATING, SCROLL, shown, SPACED, useKeys } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Screen: reports (FR-044) within row scope, and the export
// ---------------------------------------------------------------------------------------------------------

export function ReportsScreen() {
  const { can } = useSession();
  const [cycleId, setCycleId] = useState('');
  if (!can(REPORT)) {
    return (
      <Section title="Appraisal reports">
        <NotPermitted>The selected role cannot view appraisal reports.</NotPermitted>
      </Section>
    );
  }
  return (
    <div className="stack">
      <Section title="Appraisal reports">
        {can(CYCLE_READ) ? (
          <div className="row">
            <CycleSelect label="Cycle" value={cycleId} onChange={setCycleId} />
          </div>
        ) : (
          <NotPermitted>The selected role cannot list appraisal cycles, so it cannot choose one to report on.</NotPermitted>
        )}
        {!cycleId && can(CYCLE_READ) && <p className="hint">Choose a cycle to see its report.</p>}
      </Section>
      {cycleId && <CycleReport key={cycleId} cycleId={cycleId} />}
    </div>
  );
}

export function CycleReport({ cycleId }: { cycleId: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const [departmentId, setDepartmentId] = useState('');
  const query = departmentId ? `?departmentId=${departmentId}` : '';
  const report = useQuery({ queryKey: keys.report(cycleId, departmentId), queryFn: () => api<Report>(`/v1/appraisal-cycles/${cycleId}/report${query}`), retry: retryTransient });
  const exportCsv = useMutation({ mutationFn: () => download(`/v1/appraisal-cycles/${cycleId}/export${query}`) });
  const data = shown(report);
  return (
    <Section title="Cycle report">
      <div className="row">
        <DepartmentSelect value={departmentId} onChange={setDepartmentId} />
      </div>
      {report.isPending && <p className="hint loading">Loading the report…</p>}
      <QueryProblem error={report.error} forbidden="The selected role cannot view appraisal reports." />
      {data && (
        <>
          <p>
            {data.cycle.code}: {data.cycle.name} ({periodText(data.cycle)}). Scope: {readable(data.scope).toLowerCase()}
            {data.filters.departmentId ? ', one department' : ', all departments in scope'}. Generated <When at={data.generatedAt} />.
          </p>
          {data.ownAppraisalExcluded && <p className="hint">Your own appraisal is never included in reports or exports.</p>}
          <p>
            Appraisals in the population: <strong>{data.population}</strong> (cancelled ones are counted apart).
          </p>
          <div style={SCROLL}>
            <table aria-label="Appraisals by state">
              <thead>
                <tr>
                  <th>State</th>
                  <th>Appraisals</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.byState).map(([state, n]) => (
                  <tr key={state}>
                    <td>{readable(state)}</td>
                    <td>{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.ratings && (
            <>
              <h3 style={H3}>Final ratings of completed appraisals</h3>
              <p className="hint" style={FLUSH}>
                Exact final ratings, counted as they are: no bins, targets or expected shares. The counts add up to the {data.ratings.completed} completed appraisal
                {data.ratings.completed === 1 ? '' : 's'}.
              </p>
              {data.ratings.distribution.length === 0 ? (
                <Empty>No completed appraisals yet.</Empty>
              ) : (
                <div style={SCROLL}>
                  <table aria-label="Final rating distribution">
                    <thead>
                      <tr>
                        <th>Final rating</th>
                        <th>Appraisals</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.ratings.distribution.map((r) => (
                        <tr key={r.finalRating}>
                          <td>{r.finalRating}</td>
                          <td>{r.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
      {can(EXPORT) && (
        <div style={SPACED}>
          <div className="row">
            <button type="button" className="secondary" disabled={exportCsv.isPending} onClick={() => exportCsv.mutate()}>
              {exportCsv.isPending ? 'Preparing the export…' : 'Export as CSV'}
            </button>
          </div>
          <p className="hint">The export covers the same population; rating columns are included only when the selected role may see them.</p>
          <Refusal error={exportCsv.error} action="export" />
        </div>
      )}
      {can(REPORT_RATING) && <TrainingNeeds cycleId={cycleId} departmentId={departmentId} />}
    </Section>
  );
}

/** FR-042 training needs from completed appraisals, offered to training planning as a suggestion only (nobody is enrolled). */
function TrainingNeeds({ cycleId, departmentId }: { cycleId: string; departmentId: string }) {
  const keys = useKeys();
  const query = useQuery({
    queryKey: keys.trainingNeeds(cycleId, departmentId),
    queryFn: () =>
      api<{
        sectionIncluded: boolean;
        population: number;
        items: { appraisalId: string; employee: { employeeCode: string; displayName: string }; employeeStated: string | null; managerRecommended: string | null }[];
      }>(`/v1/appraisal-cycles/${cycleId}/training-needs${departmentId ? `?departmentId=${departmentId}` : ''}`),
    retry: retryTransient,
  });
  const data = shown(query);
  return (
    <div style={SPACED}>
      <h3 style={H3}>Training needs (suggestions for training planning)</h3>
      {query.isPending && <p className="hint loading">Loading training needs…</p>}
      <QueryProblem error={query.error} forbidden="Training needs are confidential: the selected role cannot see them." />
      {data && !data.sectionIncluded && <Empty>This cycle does not include the training needs section.</Empty>}
      {data && data.sectionIncluded && data.items.length === 0 && <Empty>No completed appraisal in scope has training needs yet.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Training needs">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Stated by the employee</th>
                <th>Recommended by the manager</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.appraisalId}>
                  <td>{personLabel(r.employee)}</td>
                  <td>{r.employeeStated ?? '—'}</td>
                  <td>{r.managerRecommended ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint" style={FLUSH}>
        A suggestion only: nominate people from the training module; nobody is enrolled from here.
      </p>
    </div>
  );
}
