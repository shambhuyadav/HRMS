// The appraisal decision queues (FR-043): the manager's rating and the reviewer confirmation, and their screens.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, formatDate, idempotencyKey, personLabel, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Notice, NotPermitted, Section, When } from '../../ui';
import { DelegatedBadge } from '../delegations';
import { CompetenciesTable, CompetencyEntriesTable, RatingResults, SectionTexts } from './competency-views';
import { EntriesTable, GoalsTable } from './goals';
import { QueryProblem, Refusal, refusalText } from './refusals';
import { ScoreForm } from './score-form';
import { type Appraisal, type AppraisalTask, CONFIRM, type DecisionResult, type EntryChanges, FLUSH, H3, PATHS, RATE, READ, READ_RATING, SCORES, shown, SPACED, stepText, TEXTAREA, useKeys } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Decision queues (FR-043): the manager's rating, then the independent reviewer confirmation
// ---------------------------------------------------------------------------------------------------------
type QueueKind = 'MANAGER_RATING' | 'REVIEW';
const QUEUES: Record<QueueKind, { title: string; hint: string; list: string; empty: string; forbidden: string }> = {
  MANAGER_RATING: {
    title: 'Appraisal ratings',
    hint: 'Submitted appraisals waiting for your rating: score every goal from 1 to 5 and save, then submit the rating or return the appraisal to the employee.',
    list: 'Appraisals waiting for your rating',
    empty: 'No appraisals are waiting for your rating.',
    forbidden: 'The selected role cannot rate appraisals.',
  },
  REVIEW: {
    title: 'Appraisal reviews',
    hint: 'Rated appraisals waiting for your independent confirmation: confirm the rating or return the appraisal to the employee.',
    list: 'Appraisals waiting for your review',
    empty: 'No appraisals are waiting for your review.',
    forbidden: 'The selected role cannot review appraisals.',
  },
};

export function RatingQueue() {
  return <AppraisalQueue kind="MANAGER_RATING" />;
}
export function ReviewQueue() {
  return <AppraisalQueue kind="REVIEW" />;
}

function AppraisalQueue({ kind }: { kind: QueueKind }) {
  const queue = QUEUES[kind];
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const region = useRef<HTMLDivElement>(null);
  // GET /v1/appraisal-tasks/mine checks appraisal.read (operational or rating); the decision duty alone lists nothing.
  const canList = can(READ) || can(READ_RATING);
  // Both queues read the same route under the same key: one request, each listing its own stage's tasks.
  const tasks = useQuery({ queryKey: keys.tasks, queryFn: () => api<{ items: AppraisalTask[] }>('/v1/appraisal-tasks/mine'), retry: retryTransient, enabled: canList });
  /** Tasks seen decided here, or found closed: they leave the queue at once, before it has reloaded. */
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const data = shown(tasks);
  const items = (data?.items ?? []).filter((t) => (kind === 'REVIEW' ? t.stage === 'REVIEW' : t.stage === 'MANAGER_RATING') && !gone.has(t.taskId));
  const done = (t: AppraisalTask, text: string, ok: boolean) => {
    setGone((prev) => new Set(prev).add(t.taskId));
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: keys.tasks });
    void qc.invalidateQueries({ queryKey: keys.appraisals });
    const active = document.activeElement;
    if (!active || active === document.body || region.current?.contains(active)) region.current?.focus();
  };
  if (!canList) {
    return (
      <Section title={queue.title}>
        <NotPermitted>The selected role cannot read appraisals, so it cannot list the appraisals waiting for it.</NotPermitted>
      </Section>
    );
  }
  return (
    <div ref={region} role="region" aria-label={queue.title} tabIndex={-1}>
      <Section title={`${queue.title}${data ? ` (${items.length})` : ''}`}>
        <p className="hint">{queue.hint}</p>
        {tasks.isPending && <p className="hint loading">Loading the appraisals waiting for you…</p>}
        <QueryProblem error={tasks.error} forbidden={queue.forbidden} />
        <Notice notice={notice} />
        {data && items.length === 0 && <Empty>{queue.empty}</Empty>}
        {items.length > 0 && (
          <ul className="tasks" aria-label={queue.list}>
            {items.map((t) => (
              <TaskItem key={t.taskId} task={t} onFinished={done} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function decidedText(name: string, decision: 'APPROVE' | 'RETURN', stage: string, r: DecisionResult): string {
  if (r.replayed) return `Your earlier decision on the appraisal of ${name} had already been recorded, so nothing was applied twice. Its state is now: ${readable(r.state).toLowerCase()}.`;
  if (decision === 'RETURN') return `Returned the appraisal of ${name} to the employee; revision ${r.revision} is open for the self-entry.`;
  // BR-013 one-level manager review (I-77 item 2): the manager's approval completes the appraisal.
  if (stage === 'MANAGER_RATING' && r.state === 'APPROVED') return `Submitted the rating of ${name}: this cycle has no reviewer level, so the appraisal is complete.`;
  if (stage === 'MANAGER_RATING') return `Submitted the rating of ${name}. It now waits for the independent reviewer confirmation.`;
  if (r.state === 'APPROVED') return `Confirmed the rating of ${name}: the appraisal is complete.`;
  if (r.pendingStep === 3) return `Confirmed the rating of ${name} at level 1. It now waits for the level-2 reviewer.`;
  return `The appraisal of ${name} is now ${readable(r.state).toLowerCase()}.`;
}

function TaskItem({ task: t, onFinished }: { task: AppraisalTask; onFinished: (t: AppraisalTask, text: string, ok: boolean) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const id = useId();
  const rating = t.stage === 'MANAGER_RATING';
  const permitted = can(rating ? RATE : CONFIRM);
  /** The answer to the last save (the server's view of the appraisal), until the queue has reloaded past it. */
  const [saved, setSaved] = useState<Appraisal | null>(null);
  const a = saved && (!t.appraisal || saved.version > t.appraisal.version) ? saved : t.appraisal;
  const [dirty, setDirty] = useState(false);
  const [remark, setRemark] = useState('');
  const [message, setMessage] = useState('');
  /** FR-043 / DF04 (I-77 item 1): the reviewer's overall score, given with a confirmation. */
  const [reviewerScore, setReviewerScore] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  /**
   * The decision last sent and its idempotency key (ZT07). Sending that same decision again after a failure, whose
   * answer may have been lost, carries the same key: the server answers from what it recorded and never applies it
   * twice. Any other decision, remark, message or score is a new action with a new key.
   */
  const attempt = useRef<{ decision: string; remark: string; message: string; score: string; key: string } | null>(null);
  const name = a ? personLabel(a.employee) : 'this employee';
  const working = a?.revisions.find((r) => r.revision === a.revision);
  const save = useMutation({
    mutationFn: (body: EntryChanges & { expectedVersion: number }) => api<Appraisal>(`/v1/appraisal-tasks/${encodeURIComponent(t.taskId)}/rating`, { method: 'PUT', body }),
    onSuccess: (view) => {
      setSaved(view);
      setSavedNote('Scores saved.');
      void qc.invalidateQueries({ queryKey: keys.tasks });
    },
    onError: (e) => {
      if (!(e instanceof ApiError)) return;
      if (e.code === 'TASK_CLOSED' || e.code === 'INVALID_STATE' || e.status === 404) onFinished(t, refusalText(e, 'rating') ?? e.message, false);
      else if (e.code === 'STALE_VERSION' || e.code === 'UNKNOWN_GOAL') void qc.invalidateQueries({ queryKey: keys.tasks });
    },
  });
  const decide = useMutation({
    mutationFn: (body: { decision: 'APPROVE' | 'RETURN'; reason?: string; employeeMessage?: string; reviewerScore?: number; idempotencyKey: string }) =>
      api<DecisionResult>(`/v1/appraisal-tasks/${encodeURIComponent(t.taskId)}/decision`, { body }),
    onSuccess: (result, body) => {
      attempt.current = null;
      onFinished(t, decidedText(name, body.decision, t.stage, result), true);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.current = null;
      else if (error.code === 'TASK_CLOSED' || error.code === 'INVALID_STATE' || error.status === 404) onFinished(t, refusalText(error, 'decide') ?? error.message, false);
    },
  });
  const busy = save.isPending || decide.isPending;
  const send = (decision: 'APPROVE' | 'RETURN') => {
    if (!permitted || busy || !a) return;
    const msg = message.trim();
    const rem = remark.trim();
    if (decision === 'RETURN' && !msg) {
      setProblem('Tell the employee what to revise before returning the appraisal.');
      decide.reset();
      return;
    }
    if (decision === 'APPROVE' && rating && dirty) {
      setProblem('Save the scores first: the rating is submitted as saved.');
      decide.reset();
      return;
    }
    const confirming = decision === 'APPROVE' && !rating;
    if (confirming && !reviewerScore) {
      setProblem('Choose your overall score (1 to 5) to confirm the rating.');
      decide.reset();
      return;
    }
    setProblem(null);
    const sentMessage = decision === 'RETURN' ? msg : '';
    const sentScore = confirming ? reviewerScore : '';
    const last = attempt.current;
    const key =
      last !== null && last.decision === decision && last.remark === rem && last.message === sentMessage && last.score === sentScore ? last.key : idempotencyKey('appraisal-decision');
    attempt.current = { decision, remark: rem, message: sentMessage, score: sentScore, key };
    decide.mutate({
      decision,
      idempotencyKey: key,
      ...(rem ? { reason: rem } : {}),
      ...(decision === 'RETURN' ? { employeeMessage: msg } : {}),
      ...(confirming ? { reviewerScore: Number(sentScore) } : {}),
    });
  };
  const titleId = `${id}-title`;
  return (
    <li aria-labelledby={titleId}>
      <h3 id={titleId} style={H3}>
        {a ? `${personLabel(a.employee)} · ${a.cycle.code}` : 'Appraisal'}
      </h3>
      <DelegatedBadge taskId={t.taskId} />
      <p className="hint" style={FLUSH}>
        {stepText(t.stage, t.level)} · assigned <When at={t.assignedAt} />
        {t.dueOn ? ` · due ${formatDate(t.dueOn)}` : ' · no due date'}
        {a ? ` · revision ${a.revision}` : ''}
      </p>
      {t.overdue && <Badge tone="warn">overdue</Badge>}
      {!a ? (
        <Empty>This appraisal is not available in the selected role’s scope.</Empty>
      ) : (
        <>
          <GoalsTable a={a} label={`Goals of ${name}`} />
          {a.competencies !== undefined && a.competencies.length > 0 && <CompetenciesTable a={a} label={`Competencies of ${name}`} />}
          {working?.selfEntry ? (
            <>
              <h4 style={H3}>The employee’s self-entry</h4>
              <EntriesTable goals={a.goals} set={working.selfEntry} label={`Self-entry of ${name}`} />
              <CompetencyEntriesTable items={a.competencies ?? []} entries={working.selfEntry.competencies ?? []} label={`Competency self-entry of ${name}`} />
              <SectionTexts sections={a.sections ?? []} texts={working.selfEntry.sections} label={`Sections filled by ${name}`} />
            </>
          ) : (
            <p className="hint">The self-entry is confidential and not shown to the selected role.</p>
          )}
          {!rating && working?.managerRating && (
            <>
              <h4 style={H3}>The manager’s rating</h4>
              <EntriesTable goals={a.goals} set={working.managerRating} label={`Manager rating of ${name}`} />
              <CompetencyEntriesTable items={a.competencies ?? []} entries={working.managerRating.competencies ?? []} label={`Competency rating of ${name}`} />
              <SectionTexts sections={a.sections ?? []} texts={working.managerRating.sections} label={`Manager sections of ${name}`} />
              <RatingResults rating={working.managerRating} />
              {a.cycle.ratingMode === 'MANUAL' && (
                <p style={FLUSH}>
                  Overall rating of the manager (the final rating in this cycle): <strong>{working.managerRating.overallRating ?? '—'}</strong>
                </p>
              )}
            </>
          )}
          {!rating && !working?.managerRating && <p className="hint">The manager’s rating is confidential and not shown to the selected role.</p>}
          <p style={FLUSH}>
            <Link to={PATHS.appraisal(a.id)}>Open the appraisal</Link>
          </p>
        </>
      )}
      {a &&
        (permitted ? (
          <>
            {rating && (
              <ScoreForm
                key={`${a.id}:${a.version}`}
                goals={a.goals}
                saved={working?.managerRating}
                label={`Rating of ${name}`}
                saveLabel="Save the scores"
                busy={busy}
                hiddenSaved={(g) => !working?.managerRating && g.managerRatingComplete === true}
                overall={a.cycle.ratingMode === 'MANUAL' ? { saved: working?.managerRating?.overallRating ?? null } : undefined}
                competencies={a.competencies}
                sections={{ party: 'MANAGER', items: a.sections ?? [] }}
                onDirty={setDirty}
                onSave={(changes) => {
                  setSavedNote(null);
                  save.mutate({ ...changes, expectedVersion: a.version });
                }}
              >
                {savedNote && !dirty && (
                  <p className="ok" role="status">
                    {savedNote}
                  </p>
                )}
                <Refusal error={save.error} action="rating" />
              </ScoreForm>
            )}
            <div style={SPACED}>
              {!rating && (
                <label>
                  Your overall score (1 to 5; required to confirm, kept apart from the manager’s rating)
                  <select value={reviewerScore} onChange={(e) => setReviewerScore(e.target.value)}>
                    <option value="">Not scored</option>
                    {SCORES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Private remark (optional; never shown to the employee)
                <textarea rows={2} maxLength={1000} value={remark} onChange={(e) => setRemark(e.target.value)} style={TEXTAREA} />
              </label>
              <label>
                Message to the employee (required to return)
                <textarea rows={2} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} style={TEXTAREA} />
              </label>
              {problem && (
                <p role="alert" className="error">
                  {problem}
                </p>
              )}
              <div className="row">
                <button type="button" disabled={busy} onClick={() => send('APPROVE')}>
                  {rating ? 'Submit the rating' : 'Confirm the rating'}
                </button>
                <button type="button" className="secondary" disabled={busy} onClick={() => send('RETURN')}>
                  Return to the employee
                </button>
              </div>
              <Refusal error={decide.error} action="decide" />
            </div>
          </>
        ) : (
          <p className="hint">{QUEUES[rating ? 'MANAGER_RATING' : 'REVIEW'].forbidden}</p>
        ))}
    </li>
  );
}

export function RatingsScreen() {
  const { can } = useSession();
  if (!can(RATE)) {
    return (
      <Section title="Appraisal ratings">
        <NotPermitted>The selected role cannot rate appraisals.</NotPermitted>
      </Section>
    );
  }
  return <RatingQueue />;
}

export function ReviewsScreen() {
  const { can } = useSession();
  if (!can(CONFIRM)) {
    return (
      <Section title="Appraisal reviews">
        <NotPermitted>The selected role cannot review appraisals.</NotPermitted>
      </Section>
    );
  }
  return <ReviewQueue />;
}
