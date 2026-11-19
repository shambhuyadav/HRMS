// Feedback summary and register (FR-050): counts reconciled to participants; comments only when returned.

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, download, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Item, NotPermitted, Section, When } from '../../ui';
import { QueryProblem, Refusal } from './refusals';
import { FEEDBACK_EXPORT, FEEDBACK_LABEL, FEEDBACK_READ, FeedbackState, FLUSH, participantLabel, ParticipationState, PATHS, PLAN_READ, SCORES, SCROLL, shown, STATE_LABEL, STATES, useKeys } from './shared';
import type { FeedbackRegister, FeedbackSummary } from './types';

// ---------------------------------------------------------------------------------------------------------
// Feedback summary and register (FR-050): counts reconciled to participants; comments only when returned
// ---------------------------------------------------------------------------------------------------------
export function FeedbackScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const keys = useKeys();
  // Both routes check the plan read as well as the feedback read (routes.ts): an Employee holds only the latter.
  const allowed = can(FEEDBACK_READ) && can(PLAN_READ);
  const [status, setStatus] = useState('');
  const summary = useQuery({
    queryKey: keys.summary(id),
    queryFn: () => api<FeedbackSummary>(`/v1/training-plans/${id}/feedback-summary`),
    enabled: allowed && id !== '',
    retry: retryTransient,
  });
  const register = useQuery({
    queryKey: keys.register(id, status),
    queryFn: () => api<FeedbackRegister>(`/v1/training-plans/${id}/feedback${status ? `?status=${status}` : ''}`),
    enabled: allowed && id !== '',
    retry: retryTransient,
  });
  const exporter = useMutation({ mutationFn: () => download(`/v1/training-plans/${id}/feedback/export`) });
  if (!allowed) return <NotPermitted>The selected role cannot read training feedback.</NotPermitted>;
  const s = shown(summary);
  const r = shown(register);
  return (
    <div className="stack">
      <p style={FLUSH}>
        <Link to={PATHS.plan(id)}>Back to the plan</Link>
      </p>
      <Section
        title={s ? `Feedback summary: ${s.plan.title} (${s.plan.code})` : 'Feedback summary'}
        actions={
          can(FEEDBACK_EXPORT) ? (
            <button type="button" className="secondary" disabled={exporter.isPending} onClick={() => exporter.mutate()}>
              {exporter.isPending ? 'Exporting…' : 'Export scores (CSV)'}
            </button>
          ) : undefined
        }
      >
        <Refusal error={exporter.error} action="export" />
        {summary.isLoading && <p className="hint loading">Loading…</p>}
        <QueryProblem error={summary.error} forbidden="The selected role cannot read this feedback." />
        {s && <SummaryBody s={s} />}
      </Section>
      <Section title="Responses">
        <form className="grid-form" aria-label="Filter the responses" onSubmit={(e) => e.preventDefault()}>
          <label>
            Feedback status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All participants</option>
              <option value="RESPONDED">{FEEDBACK_LABEL.RESPONDED}</option>
              <option value="MISSING">{FEEDBACK_LABEL.MISSING}</option>
              <option value="NOT_APPLICABLE">{FEEDBACK_LABEL.NOT_APPLICABLE}</option>
            </select>
          </label>
        </form>
        {register.isLoading && <p className="hint loading">Loading…</p>}
        <QueryProblem error={register.error} forbidden="The selected role cannot read the responses." />
        {r && <RegisterBody r={r} />}
      </Section>
    </div>
  );
}

function SummaryBody({ s }: { s: FeedbackSummary }) {
  const reconciled = s.reconciles.participants && s.reconciles.responses && s.reconciles.questions;
  return (
    <>
      <p className="hint">
        {s.scope.companyWide ? 'All participants of the plan.' : 'Only the participants in the selected role’s scope.'} Counted on <When at={s.generatedAt} />. Counts only: no
        average score is worked out.
      </p>
      <dl className="kv" aria-label="Response counts">
        <Item term="Participants">{s.participants.total}</Item>
        <Item term="Completed (feedback expected)">{s.feedback.eligible}</Item>
        <Item term="Responded">{s.feedback.responded}</Item>
        <Item term="Missing responses">
          <Badge tone={s.feedback.missing > 0 ? 'warn' : 'neutral'}>{`${s.feedback.missing} missing`}</Badge>
        </Item>
        <Item term="Not applicable (not completed)">{s.feedback.notApplicable}</Item>
        <Item term="Reconciles to the participants">{reconciled ? 'Yes' : 'No: reload and report it'}</Item>
      </dl>
      <div style={SCROLL}>
        <table aria-label="Participants by state">
          <thead>
            <tr>
              {STATES.map((st) => (
                <th key={st}>{STATE_LABEL[st]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {STATES.map((st) => (
                <td key={st}>{s.participants.byState[st] ?? 0}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {s.questions.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Scores by question">
            <thead>
              <tr>
                <th>Question</th>
                <th>Answered</th>
                {SCORES.map((n) => (
                  <th key={n}>Score {n}</th>
                ))}
                <th>Missing</th>
              </tr>
            </thead>
            <tbody>
              {s.questions.map((q) => (
                <tr key={q.code}>
                  <td>{q.label}</td>
                  <td>{q.answered}</td>
                  {SCORES.map((n) => (
                    <td key={n}>{q.scores[n] ?? 0}</td>
                  ))}
                  <td>{q.missing}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function RegisterBody({ r }: { r: FeedbackRegister }) {
  return (
    <>
      {!r.commentsIncluded && <p className="hint">Comments are confidential and are not shown to the selected role.</p>}
      {r.items.length === 0 ? (
        <Empty>No participants match.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label="Feedback responses">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Participation</th>
                <th>Feedback</th>
                <th>Submitted</th>
                {r.questions.map((q) => (
                  <th key={q.code}>{q.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.items.map((row) => (
                <tr key={row.participantId}>
                  <td>{participantLabel(row)}</td>
                  <td>
                    <ParticipationState state={row.state} />
                  </td>
                  <td>
                    <FeedbackState status={row.feedbackStatus} />
                  </td>
                  <td>
                    <When at={row.submittedAt} />
                  </td>
                  {r.questions.map((q) => {
                    const a = row.answers.find((x) => x.questionCode === q.code);
                    return (
                      <td key={q.code}>
                        {a ? `Score ${a.score}` : '—'}
                        {a && typeof a.comment === 'string' && a.comment !== '' && (
                          <>
                            <br />
                            <span>Comment: {a.comment}</span>
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
