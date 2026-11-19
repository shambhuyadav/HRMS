// One participation with its history, and an employee's participations with their withdrawal (row scope; DF16).

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, NotPermitted, Section, When } from '../../ui';
import { Problem, QueryProblem, Refusal } from './refusals';
import { FeedbackState, has, HISTORY_LABEL, optional, PART_ENROL, PART_READ, participantLabel, ParticipationState, PATHS, PLAN_READ, SCROLL, shown, STATE_LABEL, TEXTAREA, useKeys, useRefetchAll, ViewBadge } from './shared';
import type { EmployeeParticipation, Participant, ParticipantDetail } from './types';

// ---------------------------------------------------------------------------------------------------------
// One participation with its history, and an employee's participations (row scope; DF16 My Team)
// ---------------------------------------------------------------------------------------------------------
export function ParticipantScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const keys = useKeys();
  const allowed = can(PART_READ);
  const detail = useQuery({
    queryKey: keys.participant(id),
    queryFn: () => api<ParticipantDetail>(`/v1/training-participants/${id}`),
    enabled: allowed && id !== '',
    retry: retryTransient,
  });
  if (!allowed) return <NotPermitted>The selected role cannot read training participations.</NotPermitted>;
  const t = shown(detail);
  return (
    <div className="stack">
      {detail.isLoading && <p className="hint loading">Loading…</p>}
      <QueryProblem error={detail.error} forbidden="The selected role cannot read this participation." />
      {t && (
        <>
          <Section title={`${participantLabel(t)}: ${t.plan.title}`}>
            <dl className="kv">
              <Item term="Training">{can(PLAN_READ) ? <Link to={PATHS.plan(t.plan.id)}>{`${t.plan.title} (${t.plan.code})`}</Link> : `${t.plan.title} (${t.plan.code})`}</Item>
              <Item term="Dates">
                {formatDate(t.plan.startDate)} to {formatDate(t.plan.endDate)} <ViewBadge view={t.plan.view} />
              </Item>
              <Item term="State">
                <ParticipationState state={t.state} />
              </Item>
              <Item term="Nomination">{t.selfNominated ? 'Self-nominated' : 'Nominated by the coordinator'}</Item>
              <Item term="Feedback">
                <FeedbackState status={t.feedbackStatus} />
              </Item>
              {has(t, 'cancellationReason') && t.cancellationReason && <Item term="Cancellation reason">{t.cancellationReason}</Item>}
              <Item term="Employee’s training">
                <Link to={PATHS.employee(t.employeeId)}>All participations of {t.employeeName}</Link>
              </Item>
            </dl>
          </Section>
          <Section title="History">
            {t.history.length === 0 ? (
              <Empty>No changes recorded.</Empty>
            ) : (
              <div style={SCROLL}>
                <table aria-label="Participation history">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Change</th>
                      <th>From</th>
                      <th>To</th>
                      <th>By</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.history.map((h, i) => (
                      <tr key={`${h.occurredAt}-${i}`}>
                        <td>
                          <When at={h.occurredAt} />
                        </td>
                        <td>{HISTORY_LABEL[h.action] ?? readable(h.action)}</td>
                        <td>{h.fromState ? (STATE_LABEL[h.fromState] ?? readable(h.fromState)) : '—'}</td>
                        <td>{STATE_LABEL[h.toState] ?? readable(h.toState)}</td>
                        <td>{optional(h.actorName)}</td>
                        <td>{typeof h.reason === 'string' && h.reason !== '' ? h.reason : h.reasonRecorded ? 'A reason was recorded (confidential)' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

export function EmployeeTrainingScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(PART_READ)) return <NotPermitted>The selected role cannot read training participations.</NotPermitted>;
  return (
    <Section title="Employee’s training">
      <ParticipationList employeeId={id} linked />
    </Section>
  );
}

/** An employee's participations (GET /v1/employees/:id/training), newest first, within the caller's row scope. */
export function ParticipationList({ employeeId, linked, own }: { employeeId: string; linked?: boolean; own?: boolean }) {
  const { can } = useSession();
  const keys = useKeys();
  const list = useQuery({
    queryKey: keys.employee(employeeId),
    queryFn: () => api<{ items: EmployeeParticipation[]; businessDate: string }>(`/v1/employees/${employeeId}/training`),
    enabled: employeeId !== '',
    retry: retryTransient,
  });
  const data = shown(list);
  const withReasons = data?.items.some((t) => has(t, 'cancellationReason')) ?? false;
  return (
    <>
      {list.isLoading && <p className="hint loading">Loading…</p>}
      <QueryProblem error={list.error} forbidden="The selected role cannot read these participations." />
      {data && data.items.length === 0 && <Empty>{own ? 'You have no training enrolments or assigned sessions yet.' : 'No training participations.'}</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label={own ? 'My training' : 'Training participations'}>
            <thead>
              <tr>
                <th>Training</th>
                <th>Dates</th>
                <th>Mode, venue and trainer</th>
                <th>Nomination</th>
                <th>State</th>
                <th>Attendance recorded</th>
                <th>Completed</th>
                <th>Feedback</th>
                {withReasons && <th>Cancellation reason</th>}
                {own && can(PART_ENROL) && <th>Withdraw</th>}
              </tr>
            </thead>
            <tbody>
              {data.items.map((t) => (
                <tr key={t.id}>
                  <td>
                    {linked && can(PART_READ) ? <Link to={PATHS.participant(t.id)}>{t.plan.title}</Link> : t.plan.title} ({t.plan.code})
                    {t.plan.ownerName ? <div className="hint">Owner: {t.plan.ownerName}</div> : null}
                  </td>
                  <td>
                    {formatDate(t.plan.startDate)} to {formatDate(t.plan.endDate)} <ViewBadge view={t.plan.view} />
                  </td>
                  <td>
                    {t.plan.mode.label}
                    {t.plan.venue ? ` · ${t.plan.venue}` : ''}
                    {t.plan.trainer ? ` · ${t.plan.trainer}` : ''}
                  </td>
                  <td>{t.selfNominated ? (own ? 'You nominated yourself' : 'Self-nominated') : 'Assigned by the coordinator'}</td>
                  <td>
                    <ParticipationState state={t.state} />
                  </td>
                  <td>
                    <When at={t.attendanceRecordedAt} />
                  </td>
                  <td>
                    <When at={t.completedAt} />
                  </td>
                  <td>
                    <FeedbackState status={t.feedbackStatus} />
                  </td>
                  {withReasons && <td>{optional(t.cancellationReason)}</td>}
                  {own && can(PART_ENROL) && <td>{t.state === 'NOMINATED' && t.selfNominated ? <WithdrawForm participation={t} /> : '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function WithdrawForm({ participation }: { participation: EmployeeParticipation }) {
  const refetchAll = useRefetchAll();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const withdraw = useMutation({
    mutationFn: (body: { reason: string }) => api<Participant & { replayed: boolean }>(`/v1/me/training-nominations/${participation.id}/withdraw`, { method: 'POST', body }),
    onSuccess: () => {
      setReason('');
      setOpen(false);
      void refetchAll();
    },
  });
  if (!open) {
    return (
      <button type="button" className="secondary" onClick={() => setOpen(true)} aria-label={`Withdraw from ${participation.plan.title}`}>
        Withdraw
      </button>
    );
  }
  return (
    <form
      aria-label={`Withdraw from ${participation.plan.title}`}
      onSubmit={(e) => {
        e.preventDefault();
        const text = reason.trim();
        if (!text) return setProblem('Record why you withdraw.');
        setProblem(null);
        withdraw.mutate({ reason: text });
      }}
      noValidate
    >
      <label>
        Why you withdraw
        <textarea style={TEXTAREA} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button type="submit" disabled={withdraw.isPending}>
        {withdraw.isPending ? 'Withdrawing…' : 'Withdraw my nomination'}
      </button>{' '}
      <button type="button" className="secondary" onClick={() => setOpen(false)}>
        Keep it
      </button>
      <Problem text={problem} />
      <Refusal error={withdraw.error} action="withdraw" />
    </form>
  );
}
