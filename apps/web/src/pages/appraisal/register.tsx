// The appraisal register (FR-044 lists within row scope) and enrolment.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type EmployeeHit, personLabel, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, NotPermitted, Section, StateBadge, When } from '../../ui';
import { type GoalDraft, goalsBody, GoalsEditor } from './goals';
import { CycleSelect, DepartmentSelect, EmployeePicker } from './lookups';
import { QueryProblem, Refusal } from './refusals';
import { type Appraisal, APPRAISAL_STATES, type AppraisalPage, CYCLE_READ, type GoalInput, MANAGE, PAGE_SIZES, PATHS, READ, SCROLL, shown, SOURCE_LABEL, taskStatusText, useKeys, UUID } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Screen: the appraisal register (FR-044 lists within row scope) and enrolment
// ---------------------------------------------------------------------------------------------------------

interface ListFilters {
  cycleId: string;
  state: string;
  departmentId: string;
  page: number;
  pageSize: number;
}
/** FR-041 KRA review: complete goal sets waiting for their review (GET /v1/appraisals?stateGroup=AWAITING_GOAL_REVIEW). */
const GOAL_REVIEW_GROUP = 'AWAITING_GOAL_REVIEW';
function readFilters(params: URLSearchParams): ListFilters {
  const cycleId = params.get('cycleId') ?? '';
  const departmentId = params.get('departmentId') ?? '';
  const state = params.get('stateGroup') === GOAL_REVIEW_GROUP ? GOAL_REVIEW_GROUP : (params.get('state') ?? '');
  const page = Number(params.get('page') ?? '1');
  const pageSize = Number(params.get('pageSize') ?? '25');
  return {
    cycleId: UUID.test(cycleId) ? cycleId : '',
    departmentId: UUID.test(departmentId) ? departmentId : '',
    state: state === GOAL_REVIEW_GROUP || (APPRAISAL_STATES as readonly string[]).includes(state) ? state : '',
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    pageSize: (PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : 25,
  };
}
function listQuery(f: ListFilters): string {
  const q = new URLSearchParams();
  if (f.cycleId) q.set('cycleId', f.cycleId);
  if (f.state === GOAL_REVIEW_GROUP) q.set('stateGroup', f.state);
  else if (f.state) q.set('state', f.state);
  if (f.departmentId) q.set('departmentId', f.departmentId);
  q.set('page', String(f.page));
  q.set('pageSize', String(f.pageSize));
  return q.toString();
}

export function AppraisalsScreen() {
  const { can } = useSession();
  if (!can(READ)) {
    return (
      <Section title="Appraisals">
        <NotPermitted>The selected role cannot view appraisals.</NotPermitted>
      </Section>
    );
  }
  return (
    <div className="stack">
      <AppraisalRegister />
      {can(MANAGE) && <EnrolSection />}
    </div>
  );
}

function AppraisalRegister() {
  const keys = useKeys();
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const query = listQuery(filters);
  const list = useQuery({ queryKey: keys.appraisalList(query), queryFn: () => api<AppraisalPage>(`/v1/appraisals?${query}`), retry: retryTransient });
  const data = shown(list);
  const setFilter = (patch: Partial<ListFilters>) => setParams(listQuery({ ...filters, page: 1, ...patch }));
  const withRating = (data?.items ?? []).some((r) => 'finalRating' in r || 'weightedResult' in r);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <Section title="Appraisals">
      <div className="row">
        {can(CYCLE_READ) && <CycleSelect label="Cycle" allLabel="All cycles" value={filters.cycleId} onChange={(cycleId) => setFilter({ cycleId })} />}
        <label>
          State
          <select value={filters.state} onChange={(e) => setFilter({ state: e.target.value })}>
            <option value="">All states</option>
            {APPRAISAL_STATES.map((s) => (
              <option key={s} value={s}>
                {readable(s)}
              </option>
            ))}
            <option value={GOAL_REVIEW_GROUP}>{taskStatusText(GOAL_REVIEW_GROUP)}</option>
          </select>
        </label>
        <DepartmentSelect value={filters.departmentId} onChange={(departmentId) => setFilter({ departmentId })} />
        <label>
          Rows per page
          <select value={String(filters.pageSize)} onChange={(e) => setFilter({ pageSize: Number(e.target.value) })}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={String(n)}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {list.isPending && <p className="hint loading">Loading appraisals…</p>}
      <QueryProblem error={list.error} forbidden="The selected role cannot view appraisals." />
      {data && data.items.length === 0 && <Empty>No appraisals match.</Empty>}
      {data && data.items.length > 0 && (
        <>
          <div style={SCROLL}>
            <table aria-label="Appraisal register">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Department</th>
                  <th>Cycle</th>
                  <th>State</th>
                  <th>Task status</th>
                  <th>Goals</th>
                  <th>Weight total</th>
                  <th>Revision</th>
                  <th>Source</th>
                  {withRating && <th>Weighted manager result</th>}
                  {withRating && <th>Final rating</th>}
                  <th>Completed</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={PATHS.appraisal(r.id)}>{personLabel(r.employee)}</Link>
                    </td>
                    <td>{r.employee.department?.name ?? '—'}</td>
                    <td>{r.cycle.code}</td>
                    <td>
                      <StateBadge state={r.state} />
                    </td>
                    <td>{taskStatusText(r.taskStatus)}</td>
                    <td>{r.goalCount}</td>
                    <td>{r.goalWeightTotal === 100 ? '100' : `${r.goalWeightTotal} (must be 100)`}</td>
                    <td>{r.revision}</td>
                    <td>{SOURCE_LABEL[r.source] ?? readable(r.source)}</td>
                    {withRating && <td>{r.weightedResult ?? '—'}</td>}
                    {withRating && <td>{r.finalRating ?? '—'}</td>}
                    <td>
                      <When at={r.completedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <button type="button" className="secondary" disabled={filters.page <= 1} onClick={() => setParams(listQuery({ ...filters, page: filters.page - 1 }))}>
              Previous page
            </button>
            <span>
              Page {data.page} of {pages} · {data.total} appraisal{data.total === 1 ? '' : 's'}
            </span>
            <button type="button" className="secondary" disabled={filters.page >= pages} onClick={() => setParams(listQuery({ ...filters, page: filters.page + 1 }))}>
              Next page
            </button>
          </div>
        </>
      )}
    </Section>
  );
}

function EnrolSection() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [cycleId, setCycleId] = useState('');
  const [employee, setEmployee] = useState<EmployeeHit | null>(null);
  const [drafts, setDrafts] = useState<GoalDraft[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: { cycleId: string; employeeId: string; goals?: GoalInput[] }) => api<Appraisal>('/v1/appraisals', { body }),
    onSuccess: (a) => {
      setCycleId('');
      setEmployee(null);
      setDrafts([]);
      void qc.invalidateQueries({ queryKey: keys.appraisals });
      navigate(PATHS.appraisal(a.id));
    },
  });
  if (!can(CYCLE_READ)) {
    return (
      <Section title="Enrol an employee">
        <NotPermitted>The selected role cannot list appraisal cycles, so it cannot choose one to enrol in.</NotPermitted>
      </Section>
    );
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    if (!cycleId) return setProblem('Choose an open cycle.');
    if (!employee) return setProblem('Choose the employee to appraise.');
    const g = goalsBody(drafts);
    if ('problem' in g) return setProblem(g.problem);
    setProblem(null);
    create.mutate({ cycleId, employeeId: employee.id, ...(g.goals.length > 0 ? { goals: g.goals } : {}) });
  };
  return (
    <Section title="Enrol an employee">
      <p className="hint">
        Enrols the employee in an open cycle as a draft appraisal. Goals are optional here and can be set later, inside the goal-setting window. Nobody enrols themselves.
      </p>
      <form className="grid-form" aria-label="Enrol an employee" onSubmit={submit} noValidate>
        <CycleSelect label="Cycle" openOnly value={cycleId} onChange={setCycleId} />
        <EmployeePicker value={employee} onChange={setEmployee} />
        <GoalsEditor drafts={drafts} onChange={setDrafts} />
        {problem && (
          <p role="alert" className="error">
            {problem}
          </p>
        )}
        <div className="row">
          <button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Enrolling…' : 'Enrol as a draft'}
          </button>
        </div>
        <Refusal error={create.error} action="enrol" />
      </form>
    </Section>
  );
}
