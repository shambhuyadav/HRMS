// Feedback summary and register (FR-050): counts reconciled to participants; comments only when returned.

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { BackLink } from '@/components/back-link';
import { FilterBar, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, download, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Item, NotPermitted, Section, When } from '../../ui';
import { QueryProblem, Refusal } from './refusals';
import {
  FEEDBACK_EXPORT,
  FEEDBACK_LABEL,
  FEEDBACK_READ,
  FeedbackState,
  participantLabel,
  ParticipationState,
  PATHS,
  PLAN_READ,
  SCORES,
  shown,
  STATE_LABEL,
  STATES,
  useKeys,
} from './shared';
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
    <>
      {/* A direct child of the page, so the way back shows above the page's title; the cards keep their own spacing below. */}
      <BackLink to={PATHS.plan(id)}>Back to the plan</BackLink>
      <div className="stack">
        <Section
          title={s ? `Feedback summary: ${s.plan.title} (${s.plan.code})` : 'Feedback summary'}
          actions={
            can(FEEDBACK_EXPORT) ? (
              <Button type="button" variant="outline" disabled={exporter.isPending} onClick={() => exporter.mutate()}>
                {exporter.isPending ? 'Exporting…' : 'Export scores (CSV)'}
              </Button>
            ) : undefined
          }
        >
          <Refusal error={exporter.error} action="export" />
          {summary.isLoading && <LoadingLine>Loading…</LoadingLine>}
          <QueryProblem error={summary.error} forbidden="The selected role cannot read this feedback." />
          {s && <SummaryBody s={s} />}
        </Section>
        <Section title="Responses">
          <FilterBar asChild>
            <form aria-label="Filter the responses" onSubmit={(e) => e.preventDefault()}>
              <FormField>
                Feedback status
                <NativeSelect value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">All participants</option>
                  <option value="RESPONDED">{FEEDBACK_LABEL.RESPONDED}</option>
                  <option value="MISSING">{FEEDBACK_LABEL.MISSING}</option>
                  <option value="NOT_APPLICABLE">{FEEDBACK_LABEL.NOT_APPLICABLE}</option>
                </NativeSelect>
              </FormField>
            </form>
          </FilterBar>
          {register.isLoading && <LoadingLine>Loading…</LoadingLine>}
          <QueryProblem error={register.error} forbidden="The selected role cannot read the responses." />
          {r && <RegisterBody r={r} />}
        </Section>
      </div>
    </>
  );
}

function SummaryBody({ s }: { s: FeedbackSummary }) {
  const reconciled = s.reconciles.participants && s.reconciles.responses && s.reconciles.questions;
  return (
    <>
      <Hint>
        {s.scope.companyWide ? 'All participants of the plan.' : 'Only the participants in the selected role’s scope.'} Counted on <When at={s.generatedAt} />. Counts only: no
        average score is worked out.
      </Hint>
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
      <Table aria-label="Participants by state" className="mt-4">
        <TableHeader>
          <TableRow>
            {STATES.map((st) => (
              <TableHead key={st} scope="col">
                {STATE_LABEL[st]}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            {STATES.map((st) => (
              <TableCell key={st}>{s.participants.byState[st] ?? 0}</TableCell>
            ))}
          </TableRow>
        </TableBody>
      </Table>
      {s.questions.length > 0 && (
        <Table aria-label="Scores by question" className="mt-4">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Question</TableHead>
              <TableHead scope="col">Answered</TableHead>
              {SCORES.map((n) => (
                <TableHead key={n} scope="col">
                  Score {n}
                </TableHead>
              ))}
              <TableHead scope="col">Missing</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.questions.map((q) => (
              <TableRow key={q.code}>
                <TableCell>{q.label}</TableCell>
                <TableCell>{q.answered}</TableCell>
                {SCORES.map((n) => (
                  <TableCell key={n}>{q.scores[n] ?? 0}</TableCell>
                ))}
                <TableCell>{q.missing}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

function RegisterBody({ r }: { r: FeedbackRegister }) {
  return (
    <>
      {!r.commentsIncluded && <Hint>Comments are confidential and are not shown to the selected role.</Hint>}
      {r.items.length === 0 ? (
        <Empty>No participants match.</Empty>
      ) : (
        <Table aria-label="Feedback responses">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Employee</TableHead>
              <TableHead scope="col">Participation</TableHead>
              <TableHead scope="col">Feedback</TableHead>
              <TableHead scope="col">Submitted</TableHead>
              {r.questions.map((q) => (
                <TableHead key={q.code} scope="col">
                  {q.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.items.map((row) => (
              <TableRow key={row.participantId}>
                <TableCell>{participantLabel(row)}</TableCell>
                <TableCell>
                  <ParticipationState state={row.state} />
                </TableCell>
                <TableCell>
                  <FeedbackState status={row.feedbackStatus} />
                </TableCell>
                <TableCell>
                  <When at={row.submittedAt} />
                </TableCell>
                {r.questions.map((q) => {
                  const a = row.answers.find((x) => x.questionCode === q.code);
                  return (
                    <TableCell key={q.code}>
                      {a ? `Score ${a.score}` : '—'}
                      {a && typeof a.comment === 'string' && a.comment !== '' && (
                        <>
                          <br />
                          <span>Comment: {a.comment}</span>
                        </>
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
