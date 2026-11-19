// One training plan: facts, changes, cancellation and participants (FR-049, FR-050).

import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type EmployeeHit, formatDate, personLabel, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, Notice, NotPermitted, Section, When } from '../../ui';
import { EmployeeSearch, QuestionChoice, useChoices } from './lookups';
import { AMOUNT, WHOLE } from './plans';
import { Pager, Problem, QueryProblem, Refusal } from './refusals';
import { COST_MANAGE, CostText, FEEDBACK_READ, FeedbackState, FLUSH, has, optional, PAGE_SIZE, PART_MANAGE, PART_READ, participantLabel, ParticipationState, PATHS, PLAN_MANAGE, PLAN_READ, SCROLL, shown, STATE_LABEL, STATES, TEXTAREA, type TransitionAction, TRANSITIONS, useKeys, useRefetchAll, ViewBadge } from './shared';
import type { Participant, ParticipantPage, PlanDetail } from './types';

// ---------------------------------------------------------------------------------------------------------
// One plan: facts, changes, cancellation and participants (FR-049, FR-050)
// ---------------------------------------------------------------------------------------------------------
export function PlanScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const keys = useKeys();
  const allowed = can(PLAN_READ);
  const detail = useQuery({ queryKey: keys.plan(id), queryFn: () => api<PlanDetail>(`/v1/training-plans/${id}`), enabled: allowed && id !== '', retry: retryTransient });
  if (!allowed) return <NotPermitted>The selected role cannot read training plans.</NotPermitted>;
  const plan = shown(detail);
  const active = plan?.state === 'ACTIVE';
  return (
    <div className="stack">
      <p style={FLUSH}>
        <Link to={PATHS.plans}>Back to the training plans</Link>
      </p>
      {detail.isLoading && <p className="hint loading">Loading…</p>}
      <QueryProblem error={detail.error} forbidden="The selected role cannot read this plan." />
      {plan && (
        <>
          <PlanFacts plan={plan} />
          {can(PLAN_MANAGE) && active && <EditPlanForm plan={plan} />}
          {can(PLAN_MANAGE) && active && <CancelPlanForm plan={plan} />}
          {can(PART_READ) ? <Participants plan={plan} /> : <NotPermitted>The selected role cannot read the participants.</NotPermitted>}
        </>
      )}
    </div>
  );
}

function PlanFacts({ plan }: { plan: PlanDetail }) {
  const { can } = useSession();
  return (
    <Section title={`${plan.title} (${plan.code})`} actions={can(FEEDBACK_READ) ? <Link to={PATHS.feedback(plan.id)}>Feedback summary</Link> : undefined}>
      <dl className="kv">
        <Item term="View">
          <ViewBadge view={plan.view} />
        </Item>
        <Item term="Dates">
          {formatDate(plan.startDate)} to {formatDate(plan.endDate)}
        </Item>
        <Item term="Mode">{plan.mode.label}</Item>
        <Item term="Venue">{optional(plan.venue)}</Item>
        <Item term="Trainer">{optional(plan.trainer)}</Item>
        <Item term="Capacity">{plan.capacity} places</Item>
        <Item term="Places taken">
          {plan.seatsTaken} taken, {plan.seatsAvailable} available, {plan.nominationsPending} waiting for confirmation
        </Item>
        <Item term="Owner">
          {plan.owner.name} ({plan.owner.employeeCode})
        </Item>
        <Item term="Self-nomination">{plan.selfNomination ? 'Employees may nominate themselves' : 'Coordinator nominations only'}</Item>
        {has(plan, 'cost') && (
          <Item term="Cost">
            <CostText plan={plan} />
          </Item>
        )}
        <Item term="Feedback questions">{plan.feedbackQuestions.length ? plan.feedbackQuestions.map((q) => q.label).join('; ') : '—'}</Item>
        {plan.cancellation && (
          <Item term="Cancellation">
            Cancelled on <When at={plan.cancellation.cancelledAt} />
            {plan.cancellation.cancelledByName ? ` by ${plan.cancellation.cancelledByName}` : ''}
            {plan.cancellation.reason ? `. Reason: ${plan.cancellation.reason}` : ''}
          </Item>
        )}
      </dl>
      {plan.state === 'CANCELLED' && <p className="hint">A cancelled plan is final: it takes no changes, nominations or attendance.</p>}
    </Section>
  );
}

function EditPlanForm({ plan }: { plan: PlanDetail }) {
  const { can } = useSession();
  const refetchAll = useRefetchAll();
  const modes = useChoices('modes', true);
  const questions = useChoices('questions', true);
  const costEditable = can(COST_MANAGE) && has(plan, 'cost');
  const original = useMemo(
    () => ({
      title: plan.title,
      startDate: plan.startDate,
      endDate: plan.endDate,
      modeCode: plan.mode.code,
      venue: plan.venue ?? '',
      trainer: plan.trainer ?? '',
      capacity: String(plan.capacity),
      selfNomination: plan.selfNomination,
      questionCodes: plan.feedbackQuestions.map((q) => q.code),
      noCost: plan.cost === null || plan.cost === undefined,
      costAmount: plan.cost?.amount ?? '',
      costCurrency: plan.cost?.currency ?? 'INR',
    }),
    [plan],
  );
  const [draft, setDraft] = useState(original);
  const [owner, setOwner] = useState<{ id: string; label: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // A new version of the plan (after a save) resets the form to what the server now holds.
  const version = plan.version;
  useEffect(() => {
    setDraft(original);
    setOwner(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<PlanDetail>(`/v1/training-plans/${plan.id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      setSaved(true);
      void refetchAll();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const changes: Record<string, unknown> = {};
    const title = draft.title.trim();
    if (!title) return setProblem('Give the course title.');
    if (draft.endDate < draft.startDate) return setProblem('The end date cannot be before the start date.');
    if (!WHOLE.test(draft.capacity.trim()) || Number(draft.capacity.trim()) < 1) return setProblem('The capacity is a whole number of places, at least 1.');
    if (title !== original.title) changes.title = title;
    if (draft.startDate !== original.startDate) changes.startDate = draft.startDate;
    if (draft.endDate !== original.endDate) changes.endDate = draft.endDate;
    if (draft.modeCode !== original.modeCode) changes.modeCode = draft.modeCode;
    if (draft.venue.trim() !== original.venue) changes.venue = draft.venue.trim() || null;
    if (draft.trainer.trim() !== original.trainer) changes.trainer = draft.trainer.trim() || null;
    if (draft.capacity.trim() !== original.capacity) changes.capacity = Number(draft.capacity.trim());
    if (draft.selfNomination !== original.selfNomination) changes.selfNomination = draft.selfNomination;
    if (draft.questionCodes.join(',') !== original.questionCodes.join(',')) {
      if (draft.questionCodes.length === 0) return setProblem('Keep at least one feedback question.');
      changes.feedbackQuestionCodes = draft.questionCodes;
    }
    if (owner && owner.id !== plan.owner.employeeId) changes.ownerEmployeeId = owner.id;
    if (costEditable) {
      const amount = draft.costAmount.trim();
      const currency = draft.costCurrency.trim().toUpperCase();
      if (draft.noCost) {
        if (!original.noCost) changes.cost = null;
      } else {
        if (!AMOUNT.test(amount)) return setProblem('The cost is a non-negative amount with at most two decimals.');
        if (original.noCost || amount !== original.costAmount || currency !== original.costCurrency) changes.cost = { amount, currency };
      }
    }
    if (Object.keys(changes).length === 0) return setProblem('Nothing was changed.');
    setProblem(null);
    save.mutate({ expectedVersion: plan.version, ...changes });
  };
  return (
    <Section title="Change the plan">
      <form className="grid-form" aria-label="Change the plan" onSubmit={submit} noValidate>
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
            {!(shown(modes)?.items ?? []).some((m) => m.code === original.modeCode) && <option value={original.modeCode}>{plan.mode.label}</option>}
            {(shown(modes)?.items ?? []).map((m) => (
              <option key={m.code} value={m.code}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Venue
          <input value={draft.venue} maxLength={300} onChange={(e) => setDraft({ ...draft, venue: e.target.value })} />
        </label>
        <label>
          Trainer
          <input value={draft.trainer} maxLength={200} onChange={(e) => setDraft({ ...draft, trainer: e.target.value })} />
        </label>
        <label>
          Capacity (places)
          <input inputMode="numeric" value={draft.capacity} maxLength={9} onChange={(e) => setDraft({ ...draft, capacity: e.target.value })} />
        </label>
        {costEditable && (
          <>
            <label>
              <input type="checkbox" checked={draft.noCost} onChange={(e) => setDraft({ ...draft, noCost: e.target.checked })} /> No cost
            </label>
            {!draft.noCost && (
              <>
                <label>
                  Cost
                  <input inputMode="decimal" value={draft.costAmount} maxLength={18} onChange={(e) => setDraft({ ...draft, costAmount: e.target.value })} />
                </label>
                <label>
                  Cost currency
                  <input value={draft.costCurrency} maxLength={3} onChange={(e) => setDraft({ ...draft, costCurrency: e.target.value })} />
                </label>
              </>
            )}
          </>
        )}
        <label className="wide">
          <input type="checkbox" checked={draft.selfNomination} onChange={(e) => setDraft({ ...draft, selfNomination: e.target.checked })} /> Employees may nominate
          themselves
        </label>
        {!plan.feedbackRecorded && (
          <QuestionChoice
            legend="Feedback questions"
            questions={shown(questions)?.items}
            chosen={draft.questionCodes}
            onChange={(questionCodes) => setDraft({ ...draft, questionCodes })}
          />
        )}
        <div className="wide">
          <p style={FLUSH}>
            New owner: <strong>{owner ? owner.label : 'unchanged'}</strong>{' '}
            {owner && (
              <button type="button" className="secondary" onClick={() => setOwner(null)}>
                Keep the current owner
              </button>
            )}
          </p>
          <EmployeeSearch label="Find a new owner" onPick={(e) => setOwner({ id: e.id, label: personLabel(e) })} exclude={[plan.owner.employeeId]} />
        </div>
        <div className="wide">
          <button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save the changes'}
          </button>
        </div>
      </form>
      <Problem text={problem} />
      <Refusal error={save.error} action="update" />
      {saved && (
        <p role="status" className="ok">
          The plan was saved.
        </p>
      )}
    </Section>
  );
}

function CancelPlanForm({ plan }: { plan: PlanDetail }) {
  const refetchAll = useRefetchAll();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const cancel = useMutation({
    mutationFn: (body: { reason: string; expectedVersion: number }) =>
      api<PlanDetail & { cancelledParticipations: number; replayed: boolean }>(`/v1/training-plans/${plan.id}/cancel`, { method: 'POST', body }),
    onSuccess: (r) => {
      setReason('');
      setNotice({
        ok: true,
        text: r.replayed
          ? 'The plan was already cancelled.'
          : `The plan was cancelled. ${r.cancelledParticipations} nomination${r.cancelledParticipations === 1 ? '' : 's'} and confirmed place${r.cancelledParticipations === 1 ? ' was' : 's were'} cancelled with it.`,
      });
      void refetchAll();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setNotice(null);
    const text = reason.trim();
    if (!text) return setProblem('Record why the plan is cancelled.');
    setProblem(null);
    cancel.mutate({ reason: text, expectedVersion: plan.version });
  };
  return (
    <Section title="Cancel the plan">
      <form className="grid-form" aria-label="Cancel the plan" onSubmit={submit} noValidate>
        <label className="wide">
          Reason for cancelling
          <textarea style={TEXTAREA} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <p className="hint wide">Cancelling is final. Nominations and confirmed places are cancelled with the plan; a plan with recorded attendance cannot be cancelled.</p>
        <div className="wide">
          <button type="submit" disabled={cancel.isPending}>
            {cancel.isPending ? 'Cancelling…' : 'Cancel the plan'}
          </button>
        </div>
      </form>
      <Problem text={problem} />
      <Refusal error={cancel.error} action="cancel" />
      <Notice notice={notice} />
    </Section>
  );
}

function Participants({ plan }: { plan: PlanDetail }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const refetchAll = useRefetchAll();
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const query = new URLSearchParams({ ...(state ? { state } : {}), page: String(page), pageSize: String(PAGE_SIZE) }).toString();
  const list = useQuery({
    queryKey: keys.participants(plan.id, query),
    queryFn: () => api<ParticipantPage>(`/v1/training-plans/${plan.id}/participants?${query}`),
    retry: retryTransient,
  });
  const manage = can(PART_MANAGE) && plan.state === 'ACTIVE';
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const data = shown(list);
  const names = useMemo(() => new Map((data?.items ?? []).map((t) => [t.employeeId, participantLabel(t)])), [data]);
  const act = useMutation({
    mutationFn: (body: { action: TransitionAction; participantIds: string[]; reason?: string }) =>
      api<{ action: string; items: Participant[]; changed: number; replayed: number }>(`/v1/training-plans/${plan.id}/participant-actions`, { method: 'POST', body }),
    onSuccess: (r) => {
      const done = TRANSITIONS.find(([a]) => a === r.action)?.[2] ?? 'updated';
      setSelected([]);
      setReason('');
      setNotice({ ok: true, text: `${r.changed} participation${r.changed === 1 ? '' : 's'} ${done}${r.replayed ? `; ${r.replayed} already were` : ''}.` });
      void refetchAll();
    },
  });
  const run = (action: TransitionAction) => {
    setNotice(null);
    if (selected.length === 0) return setProblem('Select the participations first.');
    const text = reason.trim();
    if (action === 'CANCEL' && !text) return setProblem('Record why the participation is cancelled.');
    setProblem(null);
    act.mutate({ action, participantIds: selected, ...(text ? { reason: text } : {}) });
  };
  const withReasons = data?.items.some((t) => has(t, 'cancellationReason')) ?? false;
  const toggle = (id: string, on: boolean) => setSelected(on ? [...selected, id] : selected.filter((x) => x !== id));
  return (
    <>
      <Section title="Participants">
        <form className="grid-form" aria-label="Filter the participants" onSubmit={(e) => e.preventDefault()}>
          <label>
            Participation state
            <select
              value={state}
              onChange={(e) => {
                setState(e.target.value);
                setPage(1);
                // A selection is only of the rows on screen: an action never reaches a participation no longer shown.
                setSelected([]);
              }}
            >
              <option value="">All states</option>
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {STATE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
        </form>
        {data && !data.scope.companyWide && <p className="hint">Only the participants in the selected role’s scope are listed.</p>}
        {list.isLoading && <p className="hint loading">Loading…</p>}
        <QueryProblem error={list.error} forbidden="The selected role cannot read the participants." />
        {data && data.items.length === 0 && <Empty>No participants{state ? ' in this state' : ' yet'}.</Empty>}
        {data && data.items.length > 0 && (
          <div style={SCROLL}>
            <table aria-label="Participants">
              <thead>
                <tr>
                  {manage && <th>Select</th>}
                  <th>Employee</th>
                  <th>State</th>
                  <th>Nominated</th>
                  <th>Confirmed</th>
                  <th>Attendance recorded</th>
                  <th>Completed</th>
                  <th>Cancelled</th>
                  <th>Feedback</th>
                  {withReasons && <th>Cancellation reason</th>}
                </tr>
              </thead>
              <tbody>
                {data.items.map((t) => {
                  const own = me?.employeeId === t.employeeId;
                  return (
                    <tr key={t.id}>
                      {manage && (
                        <td>
                          {own ? (
                            <span className="hint">Your own: another coordinator records it</span>
                          ) : (
                            <input
                              type="checkbox"
                              aria-label={`Select ${participantLabel(t)}`}
                              checked={selected.includes(t.id)}
                              onChange={(e) => toggle(t.id, e.target.checked)}
                            />
                          )}
                        </td>
                      )}
                      <td>{can(PART_READ) ? <Link to={PATHS.participant(t.id)}>{participantLabel(t)}</Link> : participantLabel(t)}</td>
                      <td>
                        <ParticipationState state={t.state} />
                      </td>
                      <td>
                        <When at={t.nominatedAt} /> {t.selfNominated ? '(self-nominated)' : ''}
                      </td>
                      <td>
                        <When at={t.confirmedAt} />
                      </td>
                      <td>
                        <When at={t.attendanceRecordedAt} />
                      </td>
                      <td>
                        <When at={t.completedAt} />
                      </td>
                      <td>
                        <When at={t.cancelledAt} />
                      </td>
                      <td>
                        <FeedbackState status={t.feedbackStatus} />
                      </td>
                      {withReasons && <td>{optional(t.cancellationReason)}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && (
          <Pager
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            label="Participant pages"
            onPage={(next) => {
              setPage(next);
              setSelected([]);
            }}
          />
        )}
        {manage && data && data.items.length > 0 && (
          <div className="stack" role="group" aria-label="Participation actions">
            <label>
              Reason (needed to cancel, or to correct recorded attendance)
              <textarea style={TEXTAREA} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="row">
              {TRANSITIONS.map(([action, label]) => (
                <button key={action} type="button" className={action === 'CANCEL' ? 'secondary' : undefined} disabled={act.isPending} onClick={() => run(action)}>
                  {label}
                </button>
              ))}
            </div>
            <p className="hint" style={FLUSH}>
              {selected.length} selected. Confirmation is checked against the capacity; attendance is recorded from the start date and completion from the end date.
            </p>
            <Problem text={problem} />
            <Refusal error={act.error} action="transition" nameOf={(id) => names.get(id)} />
            <Notice notice={notice} />
          </div>
        )}
      </Section>
      {manage && <NominateForm plan={plan} />}
    </>
  );
}

function NominateForm({ plan }: { plan: PlanDetail }) {
  const refetchAll = useRefetchAll();
  const [chosen, setChosen] = useState<EmployeeHit[]>([]);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const nominate = useMutation({
    mutationFn: (body: { employeeIds: string[] }) => api<{ items: Participant[]; nominated: number }>(`/v1/training-plans/${plan.id}/participants`, { method: 'POST', body }),
    onSuccess: (r) => {
      setChosen([]);
      setNotice({ ok: true, text: `${r.nominated} employee${r.nominated === 1 ? ' was' : 's were'} nominated. Confirm each place separately.` });
      void refetchAll();
    },
  });
  const nameOf = (id: string) => {
    const e = chosen.find((x) => x.id === id);
    return e ? personLabel(e) : undefined;
  };
  return (
    <Section title="Nominate employees">
      <EmployeeSearch label="Find an employee to nominate" exclude={chosen.map((e) => e.id)} onPick={(e) => setChosen([...chosen, e])} />
      {chosen.length > 0 && (
        <ul aria-label="Chosen employees">
          {chosen.map((e) => (
            <li key={e.id}>
              {personLabel(e)}{' '}
              <button type="button" className="secondary" aria-label={`Remove ${personLabel(e)}`} onClick={() => setChosen(chosen.filter((x) => x.id !== e.id))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        disabled={chosen.length === 0 || nominate.isPending}
        onClick={() => {
          setNotice(null);
          nominate.mutate({ employeeIds: chosen.map((e) => e.id) });
        }}
      >
        {nominate.isPending ? 'Nominating…' : chosen.length === 0 ? 'Nominate' : `Nominate ${chosen.length} employee${chosen.length === 1 ? '' : 's'}`}
      </button>
      <Refusal error={nominate.error} action="nominate" nameOf={nameOf} />
      <Notice notice={notice} />
    </Section>
  );
}
