// Plans register (FR-049): views, search and date filters, export and new plans.

import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, download, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, NotPermitted, Section } from '../../ui';
import { OwnerPicker, QuestionChoice, useChoices } from './lookups';
import { Pager, Problem, QueryProblem, Refusal } from './refusals';
import { COST_MANAGE, CostText, has, optional, PAGE_SIZE, PATHS, PLAN_EXPORT, PLAN_MANAGE, PLAN_READ, SCROLL, shown, useKeys, useRefetchAll, VIEW_LABEL, ViewBadge, VIEWS } from './shared';
import type { PlanDetail, PlanPage } from './types';

// ---------------------------------------------------------------------------------------------------------
// Plans register (FR-049): views, search and date filters, export, new plans
// ---------------------------------------------------------------------------------------------------------
interface PlanFilters {
  view: string;
  search: string;
  from: string;
  to: string;
  page: number;
}

function planQuery(f: Omit<PlanFilters, 'page'>, page?: number): string {
  const q = new URLSearchParams();
  if (f.view) q.set('view', f.view);
  if (f.search.trim()) q.set('search', f.search.trim());
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  if (page !== undefined) {
    q.set('page', String(page));
    q.set('pageSize', String(PAGE_SIZE));
  }
  return q.toString();
}

export function PlansScreen() {
  const { can } = useSession();
  const keys = useKeys();
  const allowed = can(PLAN_READ);
  const [filters, setFilters] = useState<PlanFilters>({ view: '', search: '', from: '', to: '', page: 1 });
  const [typed, setTyped] = useState('');
  const query = planQuery(filters, filters.page);
  const list = useQuery({ queryKey: keys.plans(query), queryFn: () => api<PlanPage>(`/v1/training-plans?${query}`), enabled: allowed, retry: retryTransient });
  const exporter = useMutation({ mutationFn: () => download(`/v1/training-plans/export${planQuery(filters) ? `?${planQuery(filters)}` : ''}`) });
  if (!allowed) return <NotPermitted>The selected role cannot read training plans.</NotPermitted>;
  const data = shown(list);
  const withCost = data?.items.some((p) => has(p, 'cost')) ?? false;
  return (
    <div className="stack">
      <Section
        title="Training plans"
        actions={
          can(PLAN_EXPORT) ? (
            <button type="button" className="secondary" disabled={exporter.isPending} onClick={() => exporter.mutate()}>
              {exporter.isPending ? 'Exporting…' : 'Export (CSV)'}
            </button>
          ) : undefined
        }
      >
        <form
          className="grid-form"
          aria-label="Filter the plans"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters({ ...filters, search: typed, page: 1 });
          }}
        >
          <label>
            View
            <select value={filters.view} onChange={(e) => setFilters({ ...filters, view: e.target.value, page: 1 })}>
              <option value="">All views</option>
              {VIEWS.map((v) => (
                <option key={v} value={v}>
                  {VIEW_LABEL[v]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Search
            <input type="search" value={typed} maxLength={100} placeholder="Code, title, trainer or venue" onChange={(e) => setTyped(e.target.value)} />
          </label>
          <label>
            From
            <input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value, page: 1 })} />
          </label>
          <label>
            To
            <input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value, page: 1 })} />
          </label>
          <div>
            <button type="submit">Search</button>
          </div>
        </form>
        <p className="hint">
          The view is worked out from the company’s business date{data ? ` (${formatDate(data.businessDate)})` : ''}: future before the start date, current from the start
          to the end date, past after it. A cancelled plan is shown as cancelled whatever its dates.
        </p>
        <Refusal error={exporter.error} action="export" />
        {list.isLoading && <p className="hint loading">Loading…</p>}
        <QueryProblem error={list.error} forbidden="The selected role cannot read training plans." />
        {data && data.items.length === 0 && <Empty>No training plans match.</Empty>}
        {data && data.items.length > 0 && (
          <div style={SCROLL}>
            <table aria-label="Training plans">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Title</th>
                  <th>Dates</th>
                  <th>View</th>
                  <th>Mode and venue</th>
                  <th>Trainer</th>
                  <th>Places</th>
                  <th>Owner</th>
                  {withCost && <th>Cost</th>}
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={PATHS.plan(p.id)}>{p.code}</Link>
                    </td>
                    <td>{p.title}</td>
                    <td>
                      {formatDate(p.startDate)} to {formatDate(p.endDate)}
                    </td>
                    <td>
                      <ViewBadge view={p.view} />
                    </td>
                    <td>
                      {p.mode.label}
                      {p.venue ? ` · ${p.venue}` : ''}
                    </td>
                    <td>{optional(p.trainer)}</td>
                    <td>
                      {p.seatsTaken} of {p.capacity} taken · {p.nominationsPending} waiting for confirmation
                    </td>
                    <td>{p.owner.name}</td>
                    {withCost && (
                      <td>
                        <CostText plan={p} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} label="Plan pages" onPage={(page) => setFilters({ ...filters, page })} />}
      </Section>
      {can(PLAN_MANAGE) && <CreatePlanForm />}
    </div>
  );
}

interface PlanDraft {
  code: string;
  title: string;
  startDate: string;
  endDate: string;
  modeCode: string;
  venue: string;
  trainer: string;
  capacity: string;
  owner: { id: string; label: string } | null;
  selfNomination: boolean;
  questionCodes: string[];
  costAmount: string;
  costCurrency: string;
}

const EMPTY_PLAN: PlanDraft = {
  code: '',
  title: '',
  startDate: '',
  endDate: '',
  modeCode: '',
  venue: '',
  trainer: '',
  capacity: '',
  owner: null,
  selfNomination: false,
  questionCodes: [],
  costAmount: '',
  costCurrency: 'INR',
};

export const WHOLE = /^\d{1,9}$/;
export const AMOUNT = /^\d{1,15}(\.\d{1,2})?$/;

function CreatePlanForm() {
  const { can } = useSession();
  const refetchAll = useRefetchAll();
  const modes = useChoices('modes', true);
  const questions = useChoices('questions', true);
  const withCost = can(COST_MANAGE);
  const [draft, setDraft] = useState<PlanDraft>(EMPTY_PLAN);
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<PlanDetail | null>(null);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<PlanDetail>('/v1/training-plans', { method: 'POST', body }),
    onSuccess: (plan) => {
      setCreated(plan);
      setDraft(EMPTY_PLAN);
      void refetchAll();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setCreated(null);
    const code = draft.code.trim();
    const title = draft.title.trim();
    if (!code || !title || !draft.startDate || !draft.endDate || !draft.modeCode || !draft.capacity.trim() || !draft.owner) {
      setProblem('Enter the code, title, start and end dates, mode, capacity and owner.');
      return;
    }
    if (draft.endDate < draft.startDate) {
      setProblem('The end date cannot be before the start date.');
      return;
    }
    if (!WHOLE.test(draft.capacity.trim()) || Number(draft.capacity.trim()) < 1) {
      setProblem('The capacity is a whole number of places, at least 1.');
      return;
    }
    const amount = draft.costAmount.trim();
    if (withCost && amount && !AMOUNT.test(amount)) {
      setProblem('The cost is a non-negative amount with at most two decimals.');
      return;
    }
    setProblem(null);
    const venue = draft.venue.trim();
    const trainer = draft.trainer.trim();
    create.mutate({
      code,
      title,
      startDate: draft.startDate,
      endDate: draft.endDate,
      modeCode: draft.modeCode,
      ...(venue ? { venue } : {}),
      ...(trainer ? { trainer } : {}),
      capacity: Number(draft.capacity.trim()),
      ownerEmployeeId: draft.owner.id,
      selfNomination: draft.selfNomination,
      ...(draft.questionCodes.length > 0 ? { feedbackQuestionCodes: draft.questionCodes } : {}),
      ...(withCost && amount ? { cost: { amount, currency: draft.costCurrency.trim().toUpperCase() } } : {}),
    });
  };
  return (
    <Section title="New training plan">
      <form className="grid-form" aria-label="New training plan" onSubmit={submit} noValidate>
        <label>
          Plan code
          <input value={draft.code} maxLength={40} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
        </label>
        <label className="wide">
          Course title
          <input value={draft.title} maxLength={200} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        </label>
        <label>
          Start date
          <input type="date" value={draft.startDate} onChange={(e) => setDraft({ ...draft, startDate: e.target.value })} />
        </label>
        <label>
          End date
          <input type="date" value={draft.endDate} onChange={(e) => setDraft({ ...draft, endDate: e.target.value })} />
        </label>
        <label>
          Mode
          <select value={draft.modeCode} onChange={(e) => setDraft({ ...draft, modeCode: e.target.value })}>
            <option value="">Choose a mode</option>
            {(shown(modes)?.items ?? []).map((m) => (
              <option key={m.code} value={m.code}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Venue (optional)
          <input value={draft.venue} maxLength={300} onChange={(e) => setDraft({ ...draft, venue: e.target.value })} />
        </label>
        <label>
          Trainer (optional)
          <input value={draft.trainer} maxLength={200} onChange={(e) => setDraft({ ...draft, trainer: e.target.value })} />
        </label>
        <label>
          Capacity (places)
          <input inputMode="numeric" value={draft.capacity} maxLength={9} onChange={(e) => setDraft({ ...draft, capacity: e.target.value })} />
        </label>
        {withCost && (
          <>
            <label>
              Cost (optional, company spend)
              <input inputMode="decimal" value={draft.costAmount} maxLength={18} placeholder="e.g. 1500.00" onChange={(e) => setDraft({ ...draft, costAmount: e.target.value })} />
            </label>
            <label>
              Cost currency
              <input value={draft.costCurrency} maxLength={3} onChange={(e) => setDraft({ ...draft, costCurrency: e.target.value })} />
            </label>
          </>
        )}
        <label className="wide">
          <input type="checkbox" checked={draft.selfNomination} onChange={(e) => setDraft({ ...draft, selfNomination: e.target.checked })} /> Employees may nominate
          themselves
        </label>
        <QuestionChoice
          legend="Feedback questions (when none is chosen, every active question is used)"
          questions={shown(questions)?.items}
          chosen={draft.questionCodes}
          onChange={(questionCodes) => setDraft({ ...draft, questionCodes })}
        />
        <OwnerPicker value={draft.owner} onChange={(owner) => setDraft({ ...draft, owner })} />
        <p className="hint wide">The plan code is permanent and never reused. A cost left empty means no cost; 0 is recorded as a zero cost.</p>
        <div className="wide">
          <button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Saving…' : 'Create the plan'}
          </button>
        </div>
      </form>
      <Problem text={problem} />
      <Refusal error={create.error} action="create" />
      <QueryProblem error={modes.error} forbidden="The selected role cannot read the training modes." />
      {created && (
        <p role="status" className="ok">
          The plan <Link to={PATHS.plan(created.id)}>{created.code}</Link> was created ({VIEW_LABEL[created.view] ?? readable(created.view)}).
        </p>
      )}
    </Section>
  );
}
