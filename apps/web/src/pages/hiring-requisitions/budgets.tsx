// The manpower budgets screen (FR-011): the register, a new budget line and the decision queue.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, isForbidden, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, NotPermitted, Section } from '../../ui';
import { BudgetDecisionQueue } from './budget-queue';
import { MasterSelect, useOrgList } from './lookups';
import { Refusal } from './refusals';
import { type Budget, BUDGET_LIST_LIMIT, BUDGET_MANAGE, BUDGET_READ, lineLabel, type MasterItem, type MasterKind, type Option, ORG_READ, PATHS, periodText, type RevisionSaved, SCROLL, shown, SR_ONLY, TEXTAREA, useKeys, wholeNumber } from './shared';

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
    <label className="inline">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{allLabel}</option>
        {(list.data?.items ?? []).map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} ({m.code})
          </option>
        ))}
      </select>
    </label>
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
      <p className="hint">The headcount in force is the latest approved revision. Committed counts the vacancies of approved requisitions on the line, plus the placements of closed ones.</p>
      <div className="row">
        {canOrg && (
          <>
            <OrgFilter label="Department" allLabel="All departments" kind="departments" value={departmentId} onChange={setDepartmentId} />
            <OrgFilter label="Location" allLabel="All locations" kind="locations" value={locationId} onChange={setLocationId} />
            <OrgFilter label="Designation" allLabel="All designations" kind="designations" value={designationId} onChange={setDesignationId} />
          </>
        )}
        <label className="inline">
          In force on
          <input type="date" value={on} onChange={(e) => setOn(e.target.value)} />
        </label>
      </div>
      {list.isPending && <p className="hint loading">Loading budget lines…</p>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot view manpower budgets.</NotPermitted> : <ErrorNote error={list.error} />}
      {data && data.items.length === 0 && <Empty>{filtered ? 'No budget lines match these filters.' : 'No budget lines in the selected role’s scope yet.'}</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Budget lines">
            <thead>
              <tr>
                <th scope="col">Department</th>
                <th scope="col">Location</th>
                <th scope="col">Designation</th>
                <th scope="col">Period</th>
                <th scope="col">Headcount in force</th>
                <th scope="col">Committed</th>
                <th scope="col">Revision in progress</th>
                <th scope="col">
                  <span style={SR_ONLY}>Budget line</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((b) => (
                <tr key={b.id}>
                  <td>{b.departmentName}</td>
                  <td>{b.locationName}</td>
                  <td>{b.designationName}</td>
                  <td>{periodText(b)}</td>
                  <td>{b.approvedHeadcount ?? 'None approved yet'}</td>
                  <td>{b.committed}</td>
                  <td>{b.openRevision ? `Revision ${b.openRevision.revision}: headcount ${b.openRevision.headcount} (${readable(b.openRevision.state).toLowerCase()})` : '—'}</td>
                  <td>
                    <Link to={PATHS.budget(b.id)} aria-label={`Open the budget line ${lineLabel(b)} (${periodText(b)})`}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.items.length >= BUDGET_LIST_LIMIT && <p className="hint">Showing the first {BUDGET_LIST_LIMIT} budget lines; filter to narrow them down.</p>}
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
    const missing = !departmentId
      ? 'Choose the department.'
      : !locationId
        ? 'Choose the location.'
        : !designationId
          ? 'Choose the designation.'
          : !periodStart
            ? 'Enter the first day of the period.'
            : !periodEnd
              ? 'Enter the last day of the period.'
              : !wholeNumber(count, 0)
                ? 'Enter the headcount as a whole number (0 or more).'
                : !text
                  ? 'Enter the reason for the budget.'
                  : null;
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
        <form className="grid-form" aria-label="Add a budget line" onSubmit={submit} noValidate>
          <p className="hint wide">One line per department, location and designation on any date. Its first revision is saved as a draft that you submit; another HR Administrator approves it.</p>
          <MasterSelect label="Department" value={departmentId} options={options(departments.data?.items)} loading={departments.isLoading} onChange={setDepartmentId} />
          <MasterSelect label="Location" value={locationId} options={options(locations.data?.items)} loading={locations.isLoading} onChange={setLocationId} />
          <MasterSelect label="Designation" value={designationId} options={options(designations.data?.items)} loading={designations.isLoading} onChange={setDesignationId} />
          <label>
            Period start
            <input type="date" required value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          </label>
          <label>
            Period end
            <input type="date" required value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </label>
          <label>
            Headcount
            <input type="number" required min={0} step={1} inputMode="numeric" value={headcount} onChange={(e) => setHeadcount(e.target.value)} />
          </label>
          <label className="wide">
            Reason (required)
            <textarea required maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
          </label>
          {(departments.error || locations.error || designations.error) && (
            <div className="wide">
              <ErrorNote error={departments.error ?? locations.error ?? designations.error} />
            </div>
          )}
          {problem && (
            <p role="alert" className="error wide">
              {problem}
            </p>
          )}
          {create.error ? (
            <div className="wide">
              <Refusal error={create.error} action="budget-create" />
            </div>
          ) : null}
          <div className="wide row">
            <button type="submit" disabled={create.isPending}>
              Add budget line
            </button>
          </div>
          {created && (
            <p className="ok wide" role="status">
              {created.text} <Link to={PATHS.budget(created.budgetId)}>Open the line to submit the revision for approval</Link>.
            </p>
          )}
        </form>
      ) : (
        <NotPermitted>The selected role cannot list departments, locations and designations, so it cannot add a budget line here.</NotPermitted>
      )}
    </Section>
  );
}

