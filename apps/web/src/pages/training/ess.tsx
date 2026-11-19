// My ESS TN17 (Employee OWN context): own participations, self-nomination and feedback.

import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useMemo, useState } from 'react';
import { api, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Notice, NotPermitted, Section, When } from '../../ui';
import { ParticipationList } from './participants';
import { Problem, QueryProblem, Refusal } from './refusals';
import { COMMENT_SUBMIT, FEEDBACK_READ, FEEDBACK_SUBMIT, FeedbackState, FLUSH, inOwnContext, PART_ENROL, PART_READ, ParticipationState, SCORES, SCROLL, shown, TEXTAREA, useKeys, useRefetchAll, ViewBadge } from './shared';
import type { OpenPlan, OwnFeedback, Participant } from './types';

// ---------------------------------------------------------------------------------------------------------
// My ESS TN17 (Employee OWN context): own participations, self-nomination, withdrawal and feedback
// ---------------------------------------------------------------------------------------------------------
export function MyTrainingPanel() {
  const { me, can } = useSession();
  if (!inOwnContext(me)) return <Empty>Select your Employee role to see your own training.</Empty>;
  return (
    <div className="stack">
      <Section title="My training">
        {can(PART_READ) ? <ParticipationList employeeId={me!.employeeId!} own /> : <NotPermitted>Your Employee role cannot read your training.</NotPermitted>}
        <p className="hint">Attendance and completion are recorded by the training coordinator, never by you.</p>
      </Section>
      {can(PART_ENROL) && <OpenPlans />}
      {can(FEEDBACK_READ) && <MyFeedback />}
    </div>
  );
}

function OpenPlans() {
  const keys = useKeys();
  const refetchAll = useRefetchAll();
  const list = useQuery({ queryKey: keys.openPlans, queryFn: () => api<{ items: OpenPlan[]; businessDate: string }>('/v1/me/training-plans'), retry: retryTransient });
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const enrol = useMutation({
    mutationFn: (plan: OpenPlan) => api<Participant>('/v1/me/training-nominations', { method: 'POST', body: { planId: plan.id } }),
    onSuccess: (_r, plan) => {
      setNotice({ ok: true, text: `You nominated yourself for ${plan.title}. The training coordinator confirms your place separately.` });
      void refetchAll();
    },
  });
  const data = shown(list);
  return (
    <Section title="Training open for self-nomination">
      {list.isLoading && <p className="hint loading">Loading…</p>}
      <QueryProblem error={list.error} forbidden="Your Employee role cannot see the training open for self-nomination." action="enrol" />
      {data && data.items.length === 0 && <Empty>No training is open for self-nomination at the moment.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Open training">
            <thead>
              <tr>
                <th>Training</th>
                <th>Dates</th>
                <th>Mode, venue and trainer</th>
                <th>My participation</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => {
                const mine = p.myParticipation;
                const canEnrol = mine === null || mine.state === 'CANCELLED';
                return (
                  <tr key={p.id}>
                    <td>
                      {p.title} ({p.code}){p.ownerName ? <div className="hint">Owner: {p.ownerName}</div> : null}
                    </td>
                    <td>
                      {formatDate(p.startDate)} to {formatDate(p.endDate)} <ViewBadge view={p.view} />
                    </td>
                    <td>
                      {p.mode.label}
                      {p.venue ? ` · ${p.venue}` : ''}
                      {p.trainer ? ` · ${p.trainer}` : ''}
                    </td>
                    <td>
                      {mine && <ParticipationState state={mine.state} />}{' '}
                      {canEnrol && (
                        <button
                          type="button"
                          disabled={enrol.isPending}
                          aria-label={`Nominate myself for ${p.title}`}
                          onClick={() => {
                            setNotice(null);
                            enrol.mutate(p);
                          }}
                        >
                          {mine ? 'Nominate myself again' : 'Nominate myself'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Refusal error={enrol.error} action="enrol" />
      <Notice notice={notice} />
    </Section>
  );
}

function MyFeedback() {
  const { can } = useSession();
  const keys = useKeys();
  const list = useQuery({ queryKey: keys.ownFeedback, queryFn: () => api<{ items: OwnFeedback[] }>('/v1/me/training-feedback'), retry: retryTransient });
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const data = shown(list);
  return (
    <Section title="My training feedback">
      <p className="hint">Feedback opens once your completion is recorded. It is given once and cannot be changed afterwards. Your comment is confidential.</p>
      {list.isLoading && <p className="hint loading">Loading…</p>}
      <QueryProblem error={list.error} forbidden="Your Employee role cannot read your training feedback." action="feedback" />
      {data && data.items.length === 0 && <Empty>No completed training waits for feedback.</Empty>}
      <Notice notice={notice} />
      {data?.items.map((f) => (
        <article key={f.participantId} aria-label={`Feedback for ${f.plan.title}`} className="stack">
          <h3 style={FLUSH}>
            {f.plan.title} ({f.plan.code})
          </h3>
          <p style={FLUSH}>
            Completed on <When at={f.completedAt} />. <FeedbackState status={f.status} />
            {f.submittedAt ? (
              <>
                {' '}
                Submitted on <When at={f.submittedAt} />.
              </>
            ) : null}
          </p>
          {f.status === 'RESPONDED' && (
            <ul aria-label={`My answers for ${f.plan.title}`}>
              {f.answers.map((a) => (
                <li key={a.questionCode}>
                  {f.questions.find((q) => q.code === a.questionCode)?.label ?? a.questionCode}: score {a.score}
                  {typeof a.comment === 'string' && a.comment !== '' ? `. My comment: ${a.comment}` : ''}
                </li>
              ))}
            </ul>
          )}
          {f.status === 'MISSING' &&
            (can(FEEDBACK_SUBMIT) ? (
              <FeedbackForm item={f} onDone={(text) => setNotice({ ok: true, text })} />
            ) : (
              <NotPermitted>Your Employee role cannot give training feedback.</NotPermitted>
            ))}
        </article>
      ))}
    </Section>
  );
}

function FeedbackForm({ item, onDone }: { item: OwnFeedback; onDone: (text: string) => void }) {
  const { can } = useSession();
  const refetchAll = useRefetchAll();
  const withComment = can(COMMENT_SUBMIT);
  const empty = useMemo(() => Object.fromEntries(item.questions.map((q) => [q.code, { score: '', comment: '' }])) as Record<string, { score: string; comment: string }>, [item]);
  const [draft, setDraft] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: (body: { participantId: string; answers: { questionCode: string; score: number; comment?: string }[] }) =>
      api<{ participantId: string; status: string; replayed: boolean }>('/v1/me/training-feedback', { method: 'POST', body }),
    onSuccess: () => {
      setDraft(empty);
      onDone(`Your feedback for ${item.plan.title} was recorded. It cannot be changed.`);
      void refetchAll();
    },
  });
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (item.questions.some((q) => !SCORES.includes((draft[q.code]?.score ?? '') as (typeof SCORES)[number]))) {
      setProblem('Give a score from 1 to 5 for each question.');
      return;
    }
    setProblem(null);
    submit.mutate({
      participantId: item.participantId,
      answers: item.questions.map((q) => {
        const entry = draft[q.code] ?? { score: '', comment: '' };
        const comment = withComment ? entry.comment.trim() : '';
        return { questionCode: q.code, score: Number(entry.score), ...(comment ? { comment } : {}) };
      }),
    });
  };
  const set = (code: string, patch: Partial<{ score: string; comment: string }>) =>
    setDraft({ ...draft, [code]: { ...(draft[code] ?? { score: '', comment: '' }), ...patch } });
  return (
    <form className="grid-form" aria-label={`Give feedback for ${item.plan.title}`} onSubmit={send} noValidate>
      {item.questions.map((q) => (
        <fieldset key={q.code} className="wide">
          <legend>{q.label}</legend>
          <label>
            Score for {q.label} (1 lowest, 5 highest)
            <select value={draft[q.code]?.score ?? ''} onChange={(e) => set(q.code, { score: e.target.value })}>
              <option value="">Choose a score</option>
              {SCORES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {withComment && (
            <label>
              Comment on {q.label} (optional, confidential)
              <textarea style={TEXTAREA} rows={2} maxLength={2000} value={draft[q.code]?.comment ?? ''} onChange={(e) => set(q.code, { comment: e.target.value })} />
            </label>
          )}
        </fieldset>
      ))}
      <div className="wide">
        <button type="submit" disabled={submit.isPending}>
          {submit.isPending ? 'Sending…' : 'Send my feedback'}
        </button>
      </div>
      <Problem text={problem} />
      <Refusal error={submit.error} action="feedback" />
    </form>
  );
}
