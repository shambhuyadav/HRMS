// One appraisal, staff view: goals, goal review, windows, revisions, decision history, exceptions and cancellation.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, formatDate, isNotFound, personLabel, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, Notice, NotPermitted, Section, StateBadge, When } from '../../ui';
import { CompetenciesTable, CompetencyEntriesTable, RatingResults, SectionsTable, SectionTexts } from './competency-views';
import { draftsOf, EntriesTable, type GoalDraft, goalsBody, GoalsEditor, GoalsTable } from './goals';
import { QueryProblem, Refusal } from './refusals';
import { type Appraisal, CANCEL, CYCLE_READ, decisionText, type GoalInput, GRANT_EXCEPTION, GROUP, MANAGE, PATHS, periodText, READ, type Revision, shown, SOURCE_LABEL, type Stage, STAGE_LABEL, stepText, taskStatusText, useKeys, userLabel, UUID, WINDOWS, windowText, yesNo } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Screen: one appraisal (staff view): goals, windows, revisions, decision history, exceptions, cancellation
// ---------------------------------------------------------------------------------------------------------

export function AppraisalDetailScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(READ)) {
    return (
      <Section title="Appraisal">
        <NotPermitted>The selected role cannot view appraisals.</NotPermitted>
      </Section>
    );
  }
  if (!UUID.test(id)) {
    return (
      <Section title="Appraisal">
        <Empty>This appraisal does not exist.</Empty>
      </Section>
    );
  }
  return <AppraisalDetailView id={id} />;
}

const finished = (a: Pick<Appraisal, 'state'>) => a.state === 'APPROVED' || a.state === 'CANCELLED';

function AppraisalDetailView({ id }: { id: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const query = useQuery({ queryKey: keys.appraisal(id), queryFn: () => api<Appraisal>(`/v1/appraisals/${id}`), retry: retryTransient });
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const a = shown(query);
  if (query.isPending) return <Section title="Appraisal">{<LoadingLine>Loading the appraisal…</LoadingLine>}</Section>;
  if (!a) {
    return (
      <Section title="Appraisal">
        {isNotFound(query.error) ? <Empty>This appraisal is not available in the selected role’s scope.</Empty> : <QueryProblem error={query.error} forbidden="The selected role cannot view appraisals." />}
      </Section>
    );
  }
  const myUserId = me?.userId ?? null;
  const own = me?.employeeId !== null && me?.employeeId !== undefined && me.employeeId === a.employee.id;
  const showRemark = a.decisions.some((d) => 'remark' in d);
  const showDecider = a.decisions.some((d) => d.decidedBy !== undefined);
  return (
    <div className="stack">
      <Section
        title={`Appraisal of ${personLabel(a.employee)}`}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to={PATHS.appraisals}>All appraisals</Link>
          </Button>
        }
      >
        <Notice notice={notice} />
        {own && <p role="note">This is your own appraisal: it is shown without ratings, decider identities or rating progress. Your self-entry is on My ESS in your Employee role.</p>}
        <dl className="kv">
          <Item term="Department">{a.employee.department?.name ?? '—'}</Item>
          <Item term="Cycle">{can(CYCLE_READ) ? <Link to={PATHS.cycle(a.cycle.id)}>{`${a.cycle.code}: ${a.cycle.name}`}</Link> : `${a.cycle.code}: ${a.cycle.name}`}</Item>
          <Item term="Period">{periodText(a.cycle)}</Item>
          <Item term="State">
            <StateBadge state={a.state} />
          </Item>
          <Item term="Task status">{taskStatusText(a.taskStatus)}</Item>
          <Item term="Revision">{a.revision}</Item>
          <Item term="Source">{SOURCE_LABEL[a.source] ?? readable(a.source)}</Item>
          <Item term="Waiting for">
            {a.pending ? (
              <>
                {stepText(a.pending.stage, a.pending.level)}: {userLabel(a.pending.with, myUserId)}, since <When at={a.pending.assignedAt} />
              </>
            ) : (
              'Nobody'
            )}
          </Item>
          {'finalRating' in a && (
            <Item term={a.cycle.ratingMode === 'MANUAL' ? 'Final rating (confirmed overall rating of the manager)' : 'Final rating (confirmed weighted manager result)'}>
              {a.finalRating ?? 'Not final yet'}
            </Item>
          )}
          <Item term="Completed">
            <When at={a.completedAt} />
          </Item>
          {a.cancelledAt && (
            <Item term="Cancelled">
              <When at={a.cancelledAt} />
            </Item>
          )}
          {a.cancelReason !== undefined && a.cancelReason !== null && <Item term="Cancellation reason">{a.cancelReason}</Item>}
        </dl>
      </Section>

      <Section title="Goals">
        <GoalsTable a={a} label="Goals" />
        {a.goalReview?.required && <GoalReviewBlock a={a} myUserId={myUserId} canReview={can(MANAGE) && !own} onNotice={setNotice} />}
        {can(MANAGE) && !own && a.state === 'DRAFT' && a.revision === 1 && <GoalsForm key={a.version} a={a} onNotice={setNotice} />}
        {a.state !== 'DRAFT' && <Hint>Goals are fixed once the appraisal has been submitted.</Hint>}
      </Section>

      {a.competencies !== undefined && (
        <Section title="Competencies">
          <CompetenciesTable a={a} label="Competencies" />
        </Section>
      )}

      {a.sections !== undefined && a.sections.length > 0 && (
        <Section title="Sections">
          <SectionsTable a={a} label="Sections" />
        </Section>
      )}

      <Section title="Windows">
        <Table aria-label="Entry windows">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Stage</TableHead>
              <TableHead scope="col">Window</TableHead>
              <TableHead scope="col">Open today</TableHead>
              <TableHead scope="col">Exception through</TableHead>
              <TableHead scope="col">Entries accepted today</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {WINDOWS.map((w) => {
              const s = a.windows[w.key];
              return (
                <TableRow key={w.key}>
                  <TableCell>{w.label}</TableCell>
                  <TableCell>{windowText(s)}</TableCell>
                  <TableCell>{s ? yesNo(s.openToday) : '—'}</TableCell>
                  <TableCell>{s?.exceptionUntil ? formatDate(s.exceptionUntil) : '—'}</TableCell>
                  <TableCell>{s ? yesNo(s.entryAllowed) : '—'}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Section>

      <Section title="Revisions">
        {a.revisions.map((r) => (
          <RevisionBlock key={r.revision} a={a} r={r} />
        ))}
      </Section>

      <Section title="Decision history">
        {a.decisions.length === 0 ? (
          <Empty>No decisions yet.</Empty>
        ) : (
          <Table aria-label="Decision history">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Revision</TableHead>
                <TableHead scope="col">Step</TableHead>
                <TableHead scope="col">Decision</TableHead>
                {showDecider && <TableHead scope="col">Decided by</TableHead>}
                {showRemark && <TableHead scope="col">Private remark</TableHead>}
                <TableHead scope="col">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {a.decisions.map((d, i) => (
                <TableRow key={`${d.revision}-${d.step}-${i}`}>
                  <TableCell>{d.revision}</TableCell>
                  <TableCell>{stepText(d.stage, d.level)}</TableCell>
                  <TableCell>{decisionText(d.decision, d.stage)}</TableCell>
                  {showDecider && (
                    <TableCell>
                      {userLabel(d.decidedBy, myUserId)}
                      {d.onBehalfOf && <Hint as="span">{` on behalf of ${userLabel(d.onBehalfOf, myUserId)}`}</Hint>}
                    </TableCell>
                  )}
                  {showRemark && <TableCell>{d.remark ?? '—'}</TableCell>}
                  <TableCell>
                    <When at={d.decidedAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title="Window exceptions">
        <ExceptionsTable a={a} myUserId={myUserId} />
        {can(GRANT_EXCEPTION) && !own && !finished(a) && <ExceptionForm a={a} onNotice={setNotice} />}
      </Section>

      {can(CANCEL) && !own && !finished(a) && (
        <Section title="Cancel the appraisal">
          <CancelForm a={a} onNotice={setNotice} />
        </Section>
      )}
    </div>
  );
}

function RevisionBlock({ a, r }: { a: Appraisal; r: Revision }) {
  return (
    <div className={GROUP} role="group" aria-label={`Revision ${r.revision}`}>
      <CardSubheading>
        Revision {r.revision}: <StateBadge state={r.state} />
      </CardSubheading>
      <dl className="kv">
        <Item term="Submitted">
          <When at={r.submittedAt} />
        </Item>
        {'ratedAt' in r && (
          <Item term="Rated">
            <When at={r.ratedAt} />
          </Item>
        )}
        <Item term="Returned">
          <When at={r.returnedAt} />
        </Item>
        <Item term="Confirmed">
          <When at={r.confirmedAt} />
        </Item>
        {r.approvalLevels !== undefined && r.approvalLevels !== null && <Item term="Reviewer levels (pinned at submission)">{r.approvalLevels}</Item>}
      </dl>
      {r.employeeMessage && <p className="m-0">Message to the employee: {r.employeeMessage}</p>}
      {r.selfEntry && (
        <>
          <CardSubheading level={4}>Self-entry</CardSubheading>
          <EntriesTable goals={a.goals} set={r.selfEntry} label={`Self-entry of revision ${r.revision}`} />
          <CompetencyEntriesTable items={a.competencies ?? []} entries={r.selfEntry.competencies ?? []} label={`Competency self-entry of revision ${r.revision}`} />
          <SectionTexts sections={a.sections ?? []} texts={r.selfEntry.sections} label={`Employee sections of revision ${r.revision}`} />
        </>
      )}
      {r.managerRating && (
        <>
          <CardSubheading level={4}>Manager rating</CardSubheading>
          <EntriesTable goals={a.goals} set={r.managerRating} label={`Manager rating of revision ${r.revision}`} />
          <CompetencyEntriesTable items={a.competencies ?? []} entries={r.managerRating.competencies ?? []} label={`Competency rating of revision ${r.revision}`} />
          <SectionTexts sections={a.sections ?? []} texts={r.managerRating.sections} label={`Manager sections of revision ${r.revision}`} />
          <RatingResults rating={r.managerRating} />
          {a.cycle.ratingMode === 'MANUAL' && (
            <p className="m-0">
              Overall rating of the manager (the final rating in this cycle): <strong>{r.managerRating.overallRating ?? 'not entered yet'}</strong>
            </p>
          )}
        </>
      )}
      {r.reviewerScores && r.reviewerScores.length > 0 && (
        <>
          <CardSubheading level={4}>Reviewer scores</CardSubheading>
          <ul aria-label={`Reviewer scores of revision ${r.revision}`} className="m-0">
            {r.reviewerScores.map((s) => (
              <li key={s.level}>
                Level {s.level}: <strong>{s.score}</strong> (kept apart; the final rating is the manager’s)
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * FR-041 KRA review (I-77 item 3): whether the goals took effect, who set and reviewed them (staff views), and the review
 * itself for an eligible user other than the setter. The server refuses the setter and anyone out of scope.
 */
function GoalReviewBlock({
  a,
  myUserId,
  canReview,
  onNotice,
}: {
  a: Appraisal;
  myUserId: string | null;
  canReview: boolean;
  onNotice: (n: { text: string; ok: boolean } | null) => void;
}) {
  const keys = useKeys();
  const qc = useQueryClient();
  const review = a.goalReview!;
  const mine = review.setBy?.userId !== undefined && review.setBy.userId === myUserId;
  const reviewable = !review.reviewed && a.state === 'DRAFT' && a.revision === 1 && a.goals.length > 0 && a.goalWeightTotal === 100;
  const submit = useMutation({
    mutationFn: () => api<Appraisal>(`/v1/appraisals/${a.id}/goal-review`, { body: { expectedVersion: a.version } }),
    onSuccess: () => {
      onNotice({ text: 'Reviewed the goals: they have taken effect, and the employee can enter the self-entry.', ok: true });
      void qc.invalidateQueries({ queryKey: keys.appraisals });
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === 'STALE_VERSION' || e.code === 'GOALS_ALREADY_REVIEWED')) void qc.invalidateQueries({ queryKey: keys.appraisal(a.id) });
    },
  });
  return (
    <div role="group" aria-label="Goal review" className={GROUP}>
      <dl className="kv">
        <Item term="Goal review">
          {review.reviewed ? (
            <>
              Reviewed <When at={review.reviewedAt} />
            </>
          ) : (
            'Waiting: the goals take effect once someone other than their setter reviews them'
          )}
        </Item>
        {review.setBy !== undefined && <Item term="Goals set by">{review.setBy ? userLabel(review.setBy, myUserId) : 'Not recorded'}</Item>}
        {review.reviewedBy !== undefined && review.reviewedBy !== null && <Item term="Goals reviewed by">{userLabel(review.reviewedBy, myUserId)}</Item>}
      </dl>
      {canReview && reviewable && (
        mine ? (
          <Hint className="m-0">You set these goals, so someone else reviews them.</Hint>
        ) : (
          <ButtonRow>
            <Button
              type="button"
              disabled={submit.isPending}
              onClick={() => {
                onNotice(null);
                submit.mutate();
              }}
            >
              {submit.isPending ? 'Reviewing…' : 'Review the goals'}
            </Button>
          </ButtonRow>
        )
      )}
      {canReview && !review.reviewed && a.goalWeightTotal !== 100 && <Hint className="m-0">Only a complete goal set (weights totalling 100) is reviewed.</Hint>}
      <Refusal error={submit.error} action="goal-review" />
    </div>
  );
}

function GoalsForm({ a, onNotice }: { a: Appraisal; onNotice: (n: { text: string; ok: boolean } | null) => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<GoalDraft[]>(() => draftsOf(a.goals));
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (goals: GoalInput[]) => api<Appraisal>(`/v1/appraisals/${a.id}/goals`, { method: 'PUT', body: { goals, expectedVersion: a.version } }),
    onSuccess: (view) => {
      onNotice({ text: `Saved ${view.goals.length} goal${view.goals.length === 1 ? '' : 's'}; the weights total ${view.goalWeightTotal}.`, ok: true });
      void qc.invalidateQueries({ queryKey: keys.appraisals });
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === 'STALE_VERSION' || e.code === 'GOALS_FIXED')) void qc.invalidateQueries({ queryKey: keys.appraisal(a.id) });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    const g = goalsBody(drafts);
    if ('problem' in g) return setProblem(g.problem);
    setProblem(null);
    onNotice(null);
    save.mutate(g.goals);
  };
  return (
    <FormGrid aria-label="Set the goals" onSubmit={submit} noValidate>
      <Hint className="m-0">
        The goals are replaced as a set, inside the goal-setting window or an exception. They are fixed from the first submission.
        {a.goalReview?.required ? ' Where the cycle reviews goals, a changed set is yours and starts unreviewed.' : ''}
      </Hint>
      <GoalsEditor drafts={drafts} onChange={setDrafts} />
      {problem && <Notice notice={{ text: problem, ok: false }} />}
      <ButtonRow>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save the goals'}
        </Button>
      </ButtonRow>
      <Refusal error={save.error} action="goals" />
    </FormGrid>
  );
}

function ExceptionsTable({ a, myUserId }: { a: Appraisal; myUserId: string | null }) {
  if (a.exceptions.length === 0) return <Empty>No exceptions recorded.</Empty>;
  const showBy = a.exceptions.some((x) => x.recordedBy !== undefined);
  const showReason = a.exceptions.some((x) => 'reason' in x);
  return (
    <Table aria-label="Window exceptions">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Stage</TableHead>
          <TableHead scope="col">Valid through</TableHead>
          {showBy && <TableHead scope="col">Recorded by</TableHead>}
          {showReason && <TableHead scope="col">Reason</TableHead>}
          <TableHead scope="col">Recorded</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {a.exceptions.map((x, i) => (
          <TableRow key={`${x.stage}-${x.recordedAt}-${i}`}>
            <TableCell>{STAGE_LABEL[x.stage] ?? readable(x.stage)}</TableCell>
            <TableCell>{formatDate(x.validUntil)}</TableCell>
            {showBy && <TableCell>{userLabel(x.recordedBy, myUserId)}</TableCell>}
            {showReason && <TableCell>{x.reason ?? '—'}</TableCell>}
            <TableCell>
              <When at={x.recordedAt} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ExceptionForm({ a, onNotice }: { a: Appraisal; onNotice: (n: { text: string; ok: boolean } | null) => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [stage, setStage] = useState<Stage | ''>('');
  const [validUntil, setValidUntil] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const record = useMutation({
    mutationFn: (body: { stage: Stage; validUntil: string; reason: string }) => api<Appraisal>(`/v1/appraisals/${a.id}/window-exceptions`, { body }),
    onSuccess: (_view, body) => {
      setStage('');
      setValidUntil('');
      setReason('');
      onNotice({ text: `Recorded an exception: ${STAGE_LABEL[body.stage]?.toLowerCase()} entries are accepted through ${formatDate(body.validUntil)}.`, ok: true });
      void qc.invalidateQueries({ queryKey: keys.appraisal(a.id) });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (record.isPending) return;
    if (!stage) return setProblem('Choose the stage the exception is for.');
    if (!validUntil) return setProblem('Enter the date the exception is valid through.');
    if (!reason.trim()) return setProblem('Enter the reason for the exception.');
    setProblem(null);
    onNotice(null);
    record.mutate({ stage, validUntil, reason: reason.trim() });
  };
  return (
    <FormGrid aria-label="Record a window exception" onSubmit={submit} noValidate>
      <Hint className="m-0">
        Admits entries at one stage of this appraisal outside its window, through the date given (inclusive). The reason is confidential. Exceptions are kept; they are never changed or removed.
      </Hint>
      <FormField>
        Stage
        <NativeSelect value={stage} onChange={(e) => setStage(e.target.value as Stage | '')}>
          <option value="">Choose…</option>
          {WINDOWS.map((w) => (
            <option key={w.stage} value={w.stage}>
              {w.label}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      <FormField>
        Valid through
        <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
      </FormField>
      <FormField className="col-span-full">
        Reason (confidential)
        <Textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      {problem && <Notice notice={{ text: problem, ok: false }} />}
      <ButtonRow>
        <Button type="submit" disabled={record.isPending}>
          {record.isPending ? 'Recording…' : 'Record the exception'}
        </Button>
      </ButtonRow>
      <Refusal error={record.error} action="exception" />
    </FormGrid>
  );
}

function CancelForm({ a, onNotice }: { a: Appraisal; onNotice: (n: { text: string; ok: boolean } | null) => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: (text: string) => api<Appraisal>(`/v1/appraisals/${a.id}/cancel`, { body: { reason: text, expectedVersion: a.version } }),
    onSuccess: () => {
      setReason('');
      onNotice({ text: 'Cancelled the appraisal. It and its history are kept.', ok: true });
      void qc.invalidateQueries({ queryKey: keys.appraisals });
      void qc.invalidateQueries({ queryKey: keys.tasks });
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === 'STALE_VERSION' || e.code === 'INVALID_STATE')) void qc.invalidateQueries({ queryKey: keys.appraisal(a.id) });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (cancel.isPending) return;
    if (!reason.trim()) return setProblem('Enter the reason for cancelling.');
    setProblem(null);
    onNotice(null);
    cancel.mutate(reason.trim());
  };
  return (
    <FormGrid aria-label="Cancel the appraisal" onSubmit={submit} noValidate>
      <Hint className="m-0">
        An unfinished appraisal can be cancelled with a confidential reason; any open rating or review task closes. A cancelled appraisal no longer blocks a new one.
      </Hint>
      <FormField className="col-span-full">
        Reason for cancelling (confidential)
        <Textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      {problem && <Notice notice={{ text: problem, ok: false }} />}
      <ButtonRow>
        <Button type="submit" variant="danger" disabled={cancel.isPending}>
          {cancel.isPending ? 'Cancelling…' : 'Cancel the appraisal'}
        </Button>
      </ButtonRow>
      <Refusal error={cancel.error} action="cancel" />
    </FormGrid>
  );
}
