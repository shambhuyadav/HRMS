// Appraisal reports (FR-044) within row scope, the export, and the training needs suggested to training planning.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, FilterBar } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, download, personLabel, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, NotPermitted, Section, When } from '../../ui';
import { CycleSelect, DepartmentSelect } from './lookups';
import { QueryProblem, Refusal } from './refusals';
import { CYCLE_READ, EXPORT, ORG_READ, periodText, REPORT, type Report, REPORT_RATING, shown, useKeys } from './shared';

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
          <FilterBar>
            <CycleSelect label="Cycle" value={cycleId} onChange={setCycleId} />
          </FilterBar>
        ) : (
          <NotPermitted>The selected role cannot list appraisal cycles, so it cannot choose one to report on.</NotPermitted>
        )}
        {!cycleId && can(CYCLE_READ) && <Hint>Choose a cycle to see its report.</Hint>}
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
      {can(ORG_READ) && (
        <FilterBar>
          <DepartmentSelect value={departmentId} onChange={setDepartmentId} />
        </FilterBar>
      )}
      {report.isPending && <LoadingLine>Loading the report…</LoadingLine>}
      <QueryProblem error={report.error} forbidden="The selected role cannot view appraisal reports." />
      {data && (
        <>
          <p>
            {data.cycle.code}: {data.cycle.name} ({periodText(data.cycle)}). Scope: {readable(data.scope).toLowerCase()}
            {data.filters.departmentId ? ', one department' : ', all departments in scope'}. Generated <When at={data.generatedAt} />.
          </p>
          {data.ownAppraisalExcluded && <Hint>Your own appraisal is never included in reports or exports.</Hint>}
          <p>
            Appraisals in the population: <strong>{data.population}</strong> (cancelled ones are counted apart).
          </p>
          <Table aria-label="Appraisals by state">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">State</TableHead>
                <TableHead scope="col">Appraisals</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(data.byState).map(([state, n]) => (
                <TableRow key={state}>
                  <TableCell>{readable(state)}</TableCell>
                  <TableCell>{n}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {data.ratings && (
            <>
              <CardSubheading>Final ratings of completed appraisals</CardSubheading>
              <Hint className="m-0">
                Exact final ratings, counted as they are: no bins, targets or expected shares. The counts add up to the {data.ratings.completed} completed appraisal
                {data.ratings.completed === 1 ? '' : 's'}.
              </Hint>
              {data.ratings.distribution.length === 0 ? (
                <Empty>No completed appraisals yet.</Empty>
              ) : (
                <Table aria-label="Final rating distribution">
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Final rating</TableHead>
                      <TableHead scope="col">Appraisals</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.ratings.distribution.map((r) => (
                      <TableRow key={r.finalRating}>
                        <TableCell>{r.finalRating}</TableCell>
                        <TableCell>{r.count}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </>
          )}
        </>
      )}
      {can(EXPORT) && (
        <div className="mt-3">
          <ButtonRow>
            <Button type="button" variant="outline" disabled={exportCsv.isPending} onClick={() => exportCsv.mutate()}>
              {exportCsv.isPending ? 'Preparing the export…' : 'Export as CSV'}
            </Button>
          </ButtonRow>
          <Hint>The export covers the same population; rating columns are included only when the selected role may see them.</Hint>
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
    <div className="mt-3">
      <CardSubheading>Training needs (suggestions for training planning)</CardSubheading>
      {query.isPending && <LoadingLine>Loading training needs…</LoadingLine>}
      <QueryProblem error={query.error} forbidden="Training needs are confidential: the selected role cannot see them." />
      {data && !data.sectionIncluded && <Empty>This cycle does not include the training needs section.</Empty>}
      {data && data.sectionIncluded && data.items.length === 0 && <Empty>No completed appraisal in scope has training needs yet.</Empty>}
      {data && data.items.length > 0 && (
        <Table aria-label="Training needs">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Employee</TableHead>
              <TableHead scope="col">Stated by the employee</TableHead>
              <TableHead scope="col">Recommended by the manager</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((r) => (
              <TableRow key={r.appraisalId}>
                <TableCell>{personLabel(r.employee)}</TableCell>
                <TableCell>{r.employeeStated ?? '—'}</TableCell>
                <TableCell>{r.managerRecommended ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Hint className="m-0">A suggestion only: nominate people from the training module; nobody is enrolled from here.</Hint>
    </div>
  );
}
