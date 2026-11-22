// One participation with its history, and an employee's participations with their withdrawal (row scope; DF16).

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ButtonRow, FormField } from '@/components/form-field';
import { HintLine } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, NotPermitted, Section, When } from '../../ui';
import { Problem, QueryProblem, Refusal } from './refusals';
import {
  FeedbackState,
  has,
  HISTORY_LABEL,
  optional,
  PART_ENROL,
  PART_READ,
  participantLabel,
  ParticipationState,
  PATHS,
  PLAN_READ,
  shown,
  STATE_LABEL,
  useKeys,
  useRefetchAll,
  ViewBadge,
} from './shared';
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
      {detail.isLoading && <LoadingLine>Loading…</LoadingLine>}
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
            {t.history.length === 0 ? <Empty>No changes recorded.</Empty> : <HistoryTable history={t.history} />}
          </Section>
        </>
      )}
    </div>
  );
}

type HistoryLine = ParticipantDetail['history'][number];

/** The changes of one participation, as the server lists them, each with who made it and its reason when the role may read it. */
function HistoryTable({ history }: { history: HistoryLine[] }) {
  return (
    <Table aria-label="Participation history">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">When</TableHead>
          <TableHead scope="col">Change</TableHead>
          <TableHead scope="col">From</TableHead>
          <TableHead scope="col">To</TableHead>
          <TableHead scope="col">By</TableHead>
          <TableHead scope="col">Reason</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {history.map((h, i) => (
          <TableRow key={`${h.occurredAt}-${i}`}>
            <TableCell>
              <When at={h.occurredAt} />
            </TableCell>
            <TableCell>{HISTORY_LABEL[h.action] ?? readable(h.action)}</TableCell>
            <TableCell>{h.fromState ? (STATE_LABEL[h.fromState] ?? readable(h.fromState)) : '—'}</TableCell>
            <TableCell>{STATE_LABEL[h.toState] ?? readable(h.toState)}</TableCell>
            <TableCell>{optional(h.actorName)}</TableCell>
            <TableCell>{reasonText(h)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** A history line's reason as returned; that one was recorded when the role may not read it; a dash when there is none. */
function reasonText(h: HistoryLine): string {
  if (typeof h.reason === 'string' && h.reason !== '') return h.reason;
  if (h.reasonRecorded) return 'A reason was recorded (confidential)';
  return '—';
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
  const withdrawable = own && can(PART_ENROL);
  return (
    <>
      {list.isLoading && <LoadingLine>Loading…</LoadingLine>}
      <QueryProblem error={list.error} forbidden="The selected role cannot read these participations." />
      {data && data.items.length === 0 && <Empty>{own ? 'You have no training enrolments or assigned sessions yet.' : 'No training participations.'}</Empty>}
      {data && data.items.length > 0 && (
        <Table aria-label={own ? 'My training' : 'Training participations'}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Training</TableHead>
              <TableHead scope="col">Dates</TableHead>
              <TableHead scope="col">Mode, venue and trainer</TableHead>
              <TableHead scope="col">Nomination</TableHead>
              <TableHead scope="col">State</TableHead>
              <TableHead scope="col">Attendance recorded</TableHead>
              <TableHead scope="col">Completed</TableHead>
              <TableHead scope="col">Feedback</TableHead>
              {withReasons && <TableHead scope="col">Cancellation reason</TableHead>}
              {withdrawable && <TableHead scope="col">Withdraw</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((t) => (
              <TableRow key={t.id}>
                <TableCell>
                  {linked && can(PART_READ) ? <Link to={PATHS.participant(t.id)}>{t.plan.title}</Link> : t.plan.title} ({t.plan.code})
                  {t.plan.ownerName ? <HintLine>Owner: {t.plan.ownerName}</HintLine> : null}
                </TableCell>
                <TableCell>
                  {formatDate(t.plan.startDate)} to {formatDate(t.plan.endDate)} <ViewBadge view={t.plan.view} />
                </TableCell>
                <TableCell>
                  {t.plan.mode.label}
                  {t.plan.venue ? ` · ${t.plan.venue}` : ''}
                  {t.plan.trainer ? ` · ${t.plan.trainer}` : ''}
                </TableCell>
                <TableCell>{nominationText(t.selfNominated, own)}</TableCell>
                <TableCell>
                  <ParticipationState state={t.state} />
                </TableCell>
                <TableCell>
                  <When at={t.attendanceRecordedAt} />
                </TableCell>
                <TableCell>
                  <When at={t.completedAt} />
                </TableCell>
                <TableCell>
                  <FeedbackState status={t.feedbackStatus} />
                </TableCell>
                {withReasons && <TableCell>{optional(t.cancellationReason)}</TableCell>}
                {withdrawable && (
                  <TableCell>{t.state === 'NOMINATED' && t.selfNominated ? <WithdrawForm participation={t} /> : '—'}</TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

/** Who nominated: the employee (said to them as "you") or the coordinator. */
function nominationText(selfNominated: boolean, own: boolean | undefined): string {
  if (!selfNominated) return 'Assigned by the coordinator';
  return own ? 'You nominated yourself' : 'Self-nominated';
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
      <RowActions>
        <Button type="button" variant="danger" size="sm" onClick={() => setOpen(true)} aria-label={`Withdraw from ${participation.plan.title}`}>
          Withdraw
        </Button>
      </RowActions>
    );
  }
  return (
    <form
      aria-label={`Withdraw from ${participation.plan.title}`}
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const text = reason.trim();
        if (!text) return setProblem('Record why you withdraw.');
        setProblem(null);
        withdraw.mutate({ reason: text });
      }}
      noValidate
    >
      <FormField>
        Why you withdraw
        <Textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      <ButtonRow>
        <Button type="submit" size="sm" disabled={withdraw.isPending}>
          {withdraw.isPending ? 'Withdrawing…' : 'Withdraw my nomination'}
        </Button>{' '}
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </ButtonRow>
      <Problem text={problem} />
      <Refusal error={withdraw.error} action="withdraw" />
    </form>
  );
}
