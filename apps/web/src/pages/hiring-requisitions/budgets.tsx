// The manpower budgets screen (FR-011): the register, a new budget line and the decision queue.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { ButtonRow, FilterBar, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActionsCell } from '@/components/row-actions';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, isForbidden, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Notice, NotPermitted, Section } from '../../ui';
import { BudgetDecisionQueue } from './budget-queue';
import { MasterSelect, useOrgList } from './lookups';
import { Refusal } from './refusals';
import {
  type Budget,
  BUDGET_LIST_LIMIT,
  BUDGET_MANAGE,
  BUDGET_READ,
  lineLabel,
  type MasterItem,
  type MasterKind,
  type Option,
  ORG_READ,
  PATHS,
  periodText,
  type RevisionSaved,
  shown,
  useKeys,
  wholeNumber,
} from './shared';

// ---------------------------------------------------------------------------------------------------------
// Screen: manpower budgets (register with the filters the API offers, a new budget line, the decision queue)
// ---------------------------------------------------------------------------------------------------------

export function BudgetsScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Manpower budgets</h1>
      <BudgetDecisionQueue />
      {can(BUDGET_READ) ? (
        <BudgetRegister />
      ) : (
        <Section title="Budget lines">
          <NotPermitted>The selected role cannot view manpower budgets.</NotPermitted>
        </Section>
      )}
      {can(BUDGET_MANAGE) && <NewBudgetLine />}
    </>
  );
}

function OrgFilter({ label, allLabel, kind, value, onChange }: { label: string; allLabel: string; kind: MasterKind; value: string; onChange: (id: string) => void }) {
  const list = useOrgList(kind, true);
  return (
    <FormField>
      {label}
      <NativeSelect value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{allLabel}</option>
        {(list.data?.items ?? []).map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} ({m.code})
          </option>
        ))}
      </NativeSelect>
    </FormField>
  );
}

function BudgetRegister() {
  const { can } = useSession();
  const keys = useKeys();
  const canOrg = can(ORG_READ);
  const [departmentId, setDepartmentId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [designationId, setDesignationId] = useState('');
  const [on, setOn] = useState('');
  const q = new URLSearchParams();
  if (departmentId) q.set('departmentId', departmentId);
  if (locationId) q.set('locationId', locationId);
  if (designationId) q.set('designationId', designationId);
  if (/^\d{4}-\d{2}-\d{2}$/.test(on)) q.set('on', on);
  const query = q.toString();
  const list = useQuery({ queryKey: keys.budgetList(query), queryFn: () => api<{ items: Budget[] }>(`/v1/hiring/budgets${query ? `?${query}` : ''}`), retry: retryTransient });
  const data = shown(list);
  const filtered = query !== '';
  return (
    <Section title="Budget lines">
      <Hint>The headcount in force is the latest approved revision. Committed counts the vacancies of approved requisitions on the line, plus the placements of closed ones.</Hint>
      <FilterBar>
        {canOrg && (
          <>
            <OrgFilter label="Department" allLabel="All departments" kind="departments" value={departmentId} onChange={setDepartmentId} />
            <OrgFilter label="Location" allLabel="All locations" kind="locations" value={locationId} onChange={setLocationId} />
            <OrgFilter label="Designation" allLabel="All designations" kind="designations" value={designationId} onChange={setDesignationId} />
          </>
        )}
        <FormField>
          In force on
          <Input type="date" value={on} onChange={(e) => setOn(e.target.value)} />
        </FormField>
      </FilterBar>
      {list.isPending && <LoadingLine>Loading budget lines…</LoadingLine>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot view manpower budgets.</NotPermitted> : <ErrorNote error={list.error} />}
      {data && data.items.length === 0 && <Empty>{filtered ? 'No budget lines match these filters.' : 'No budget lines in the selected role’s scope yet.'}</Empty>}
      {data && data.items.length > 0 && (
        <Table aria-label="Budget lines">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Department</TableHead>
              <TableHead scope="col">Location</TableHead>
              <TableHead scope="col">Designation</TableHead>
              <TableHead scope="col">Period</TableHead>
              <TableHead scope="col">Headcount in force</TableHead>
              <TableHead scope="col">Committed</TableHead>
              <TableHead scope="col">Revision in progress</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Budget line</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((b) => (
              <TableRow key={b.id}>
                <TableCell>{b.departmentName}</TableCell>
                <TableCell>{b.locationName}</TableCell>
                <TableCell>{b.designationName}</TableCell>
                <TableCell>{periodText(b)}</TableCell>
                <TableCell>{b.approvedHeadcount ?? 'None approved yet'}</TableCell>
                <TableCell>{b.committed}</TableCell>
                <TableCell>{b.openRevision ? `Revision ${b.openRevision.revision}: headcount ${b.openRevision.headcount} (${readable(b.openRevision.state).toLowerCase()})` : '—'}</TableCell>
                <RowActionsCell>
                  <Link to={PATHS.budget(b.id)} aria-label={`Open the budget line ${lineLabel(b)} (${periodText(b)})`}>
                    Open
                  </Link>
                </RowActionsCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {data && data.items.length >= BUDGET_LIST_LIMIT && <Hint>Showing the first {BUDGET_LIST_LIMIT} budget lines; filter to narrow them down.</Hint>}
    </Section>
  );
}

interface BudgetBody {
  departmentId: string;
  locationId: string;
  designationId: string;
  periodStart: string;
  periodEnd: string;
  headcount: number;
  reason: string;
}

/** The first required field of a new budget line missing or malformed, in words; null when it can be sent. */
function firstProblem(typed: { departmentId: string; locationId: string; designationId: string; periodStart: string; periodEnd: string; count: string; reason: string }): string | null {
  if (!typed.departmentId) return 'Choose the department.';
  if (!typed.locationId) return 'Choose the location.';
  if (!typed.designationId) return 'Choose the designation.';
  if (!typed.periodStart) return 'Enter the first day of the period.';
  if (!typed.periodEnd) return 'Enter the last day of the period.';
  if (!wholeNumber(typed.count, 0)) return 'Enter the headcount as a whole number (0 or more).';
  if (!typed.reason) return 'Enter the reason for the budget.';
  return null;
}

/** A new budget line with its first revision as a draft; the preparer submits it from the line. */
function NewBudgetLine() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canOrg = can(ORG_READ);
  const departments = useOrgList('departments', canOrg);
  const locations = useOrgList('locations', canOrg);
  const designations = useOrgList('designations', canOrg);
  const [departmentId, setDepartmentId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [designationId, setDesignationId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [headcount, setHeadcount] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<{ budgetId: string; text: string } | null>(null);
  const nameOf = (items: MasterItem[] | undefined, id: string) => items?.find((m) => m.id === id)?.name;
  const create = useMutation({
    mutationFn: (body: BudgetBody) => api<RevisionSaved & { budgetId: string }>('/v1/hiring/budgets', { body }),
    onMutate: () => setCreated(null),
    onSuccess: (result, body) => {
      const names = [nameOf(departments.data?.items, body.departmentId), nameOf(locations.data?.items, body.locationId), nameOf(designations.data?.items, body.designationId)];
      const line = names.every((n) => n !== undefined) ? ` for ${names.join(', ')}` : '';
      setCreated({ budgetId: result.budgetId, text: `Budget line added${line}: draft revision ${result.revision ?? 1} with headcount ${result.headcount}.` });
      // A line added starts the form clean; a refused one keeps what was typed.
      setDepartmentId('');
      setLocationId('');
      setDesignationId('');
      setPeriodStart('');
      setPeriodEnd('');
      setHeadcount('');
      setReason('');
      void qc.invalidateQueries({ queryKey: keys.budgets });
    },
  });
  const options = (items: MasterItem[] | undefined): Option[] => (items ?? []).map((m) => ({ id: m.id, label: `${m.name} (${m.code})` }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const count = headcount.trim();
    const text = reason.trim();
    const missing = firstProblem({ departmentId, locationId, designationId, periodStart, periodEnd, count, reason: text });
    setProblem(missing);
    if (missing !== null) {
      create.reset();
      return;
    }
    if (create.isPending) return;
    create.mutate({ departmentId, locationId, designationId, periodStart, periodEnd, headcount: Number(count), reason: text });
  };

  return (
    <Section title="Add a budget line">
      {canOrg ? (
        <FormGrid aria-label="Add a budget line" onSubmit={submit} noValidate>
          <Hint>One line per department, location and designation on any date. Its first revision is saved as a draft that you submit; another HR Administrator approves it.</Hint>
          <MasterSelect label="Department" value={departmentId} options={options(departments.data?.items)} loading={departments.isLoading} onChange={setDepartmentId} />
          <MasterSelect label="Location" value={locationId} options={options(locations.data?.items)} loading={locations.isLoading} onChange={setLocationId} />
          <MasterSelect label="Designation" value={designationId} options={options(designations.data?.items)} loading={designations.isLoading} onChange={setDesignationId} />
          <FormField>
            Period start
            <Input type="date" required value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          </FormField>
          <FormField>
            Period end
            <Input type="date" required value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </FormField>
          <FormField>
            Headcount
            <Input type="number" required min={0} step={1} inputMode="numeric" value={headcount} onChange={(e) => setHeadcount(e.target.value)} />
          </FormField>
          <FormField className="col-span-full">
            Reason (required)
            <Textarea required maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          {(departments.error || locations.error || designations.error) && (
            <div className="col-span-full">
              <ErrorNote error={departments.error ?? locations.error ?? designations.error} />
            </div>
          )}
          {problem && <Notice notice={{ text: problem, ok: false }} />}
          {create.error ? (
            <div className="col-span-full">
              <Refusal error={create.error} action="budget-create" />
            </div>
          ) : null}
          <ButtonRow className="col-span-full">
            <Button type="submit" disabled={create.isPending}>
              Add budget line
            </Button>
          </ButtonRow>
          {created && (
            <StatusNote tone="success" role="status">
              {created.text} <Link to={PATHS.budget(created.budgetId)}>Open the line to submit the revision for approval</Link>.
            </StatusNote>
          )}
        </FormGrid>
      ) : (
        <NotPermitted>The selected role cannot list departments, locations and designations, so it cannot add a budget line here.</NotPermitted>
      )}
    </Section>
  );
}

