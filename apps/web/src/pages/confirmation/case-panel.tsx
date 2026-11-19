// One confirmation case: dates, state, decision history (CI17) and the direct manager's recommendation (FR-081, DF11).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, formatDate, isForbidden, isNotFound, localDateTime, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, Item, NotPermitted, Section, StateBadge } from '../../ui';
import { CaseExceptions } from './case-exceptions';
import { type CaseAction, type CaseDetail, DECIDE, GROUP, H3, MANAGE, MONTHS, outcomeLabel, RECOMMEND, type RecommendationBody, SCROLL, TEXTAREA, TimingBadge, useKeys } from './shared';

// ---------------------------------------------------------------------------------------------------------
// One case: dates, state, decision history (CI17) and the direct manager's recommendation (FR-081, DF11).
// ---------------------------------------------------------------------------------------------------------

/** `focusRequest`: a new number each time the user picks this case, which moves focus to the panel; null otherwise. */
export function CasePanel({ id, focusRequest, onClose }: { id: string; focusRequest: number | null; onClose: () => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const region = useRef<HTMLDivElement>(null);
  const detail = useQuery({ queryKey: keys.case(id), queryFn: () => api<CaseDetail>(`/v1/confirmations/${encodeURIComponent(id)}`), retry: retryTransient });
  /** The case version a recommendation was sent against; the form stays hidden until the case has moved on. */
  const [sentVersion, setSentVersion] = useState<number | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.case(id) });
    void qc.invalidateQueries({ queryKey: keys.allCases });
  };
  const recommend = useMutation({
    mutationFn: (body: RecommendationBody) => api<{ caseId: string; taskId: string; state: string }>(`/v1/confirmations/${encodeURIComponent(id)}/recommendation`, { body }),
    onSuccess: (_result, body) => {
      setSentVersion(body.expectedVersion);
      refresh();
      // The form and its focused button go away; keep a keyboard user in the case panel, unless they moved on.
      const active = document.activeElement;
      if (!active || active === document.body || region.current?.contains(active)) region.current?.focus();
    },
    // A stale version or a case that moved on: reload it so a retry uses the current version and state.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) refresh();
    },
  });

  useEffect(() => {
    if (focusRequest !== null) region.current?.focus();
  }, [focusRequest]);

  const c = detail.data;
  const title = c ? `Confirmation case: ${c.employeeName} (${c.employeeCode})` : 'Confirmation case';
  const withReasons = c?.actions.some((a) => typeof a.reason === 'string') ?? false;
  const awaitingReload = c !== undefined && sentVersion !== null && c.version === sentVersion;
  const showForm = c?.state === 'OPEN' && c.view !== 'NOT_ON_PROBATION' && can(RECOMMEND) && !awaitingReload;
  // Only while it is still true: once a reviewer has decided, the case shows its new state instead.
  const justSent = sentVersion !== null && (awaitingReload || c?.state === 'REVIEW_PENDING');
  // A background reload (after a conflict, for instance) is about to replace the version the form would send.
  const reloading = detail.isFetching && !detail.isPending;
  const conflict = recommend.error instanceof ApiError && recommend.error.status === 409;

  return (
    <div ref={region} role="region" aria-label={title} tabIndex={-1}>
      <Section
        title={title}
        actions={
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        }
      >
        {detail.isPending && <p className="hint loading">Loading the case…</p>}
        {isForbidden(detail.error) ? (
          <NotPermitted>The selected role cannot open this confirmation case.</NotPermitted>
        ) : isNotFound(detail.error) ? (
          <Empty>This case is not available in the selected role’s scope.</Empty>
        ) : (
          <ErrorNote error={detail.error} />
        )}
        {c && (
          <div className="stack">
            <dl className="kv">
              <Item term="Start date">{formatDate(c.startDate)}</Item>
              <Item term="Initial due date">{formatDate(c.initialDueDate)}</Item>
              <Item term="Current due date">
                {formatDate(c.dueDate)} <TimingBadge view={c.view} />
              </Item>
              <Item term="Extensions">{c.extensionCount}</Item>
              <Item term="State">
                <StateBadge state={c.state} />
              </Item>
              <Item term="Last outcome">{c.lastOutcome ? outcomeLabel(c.lastOutcome) : 'No decision yet'}</Item>
              <Item term="Actual confirmation date">{c.actualConfirmationDate ? formatDate(c.actualConfirmationDate) : 'Not confirmed'}</Item>
              {c.state === 'CANCELLED' && c.cancelledAt && <Item term="Cancelled on">{formatDate(c.cancelledAt)}</Item>}
              {c.state === 'CANCELLED' && typeof c.cancelReason === 'string' && <Item term="Reason for cancelling">{c.cancelReason}</Item>}
            </dl>
            {c.view === 'NOT_ON_PROBATION' && (
              <p role="note">
                <Badge tone="warn">not on probation</Badge> This employee is no longer on probation, so the review cannot be recommended or decided, and no reminders are sent.
                {can(MANAGE) && ' Cancel it below to close it.'}
              </p>
            )}
            {c.state === 'REVIEW_PENDING' && c.view !== 'NOT_ON_PROBATION' && (
              <p>
                A recommendation is waiting for an HR decision.
                {can(DECIDE) && (
                  <>
                    {' '}
                    Reviewers decide it in the <Link to="/tasks">Decision inbox</Link>.
                  </>
                )}
              </p>
            )}
            {c.state === 'OPEN' && !can(RECOMMEND) && c.view !== 'NOT_ON_PROBATION' && <p className="hint">Waiting for a recommendation from the employee’s direct manager.</p>}

            <h3 style={H3}>History</h3>
            {c.historyIncluded === false ? (
              <p className="hint">Earlier decisions are not shown: the selected role has no confirmation history grant.</p>
            ) : c.actions.length === 0 ? (
              <Empty>No decisions recorded yet.</Empty>
            ) : (
              <HistoryTable actions={c.actions} withReasons={withReasons} />
            )}

            {justSent && (
              <p className="ok" role="status">
                Recommendation sent for HR review.
              </p>
            )}
            {showForm && <RecommendationForm version={c.version} busy={recommend.isPending || reloading} onSubmit={(body) => recommend.mutate(body)} />}
            <ErrorNote error={recommend.error} />
            {conflict && showForm && (
              <p className="hint" role="status">
                {reloading ? 'Reloading the case…' : 'The case has been reloaded with its latest details; check them and send again.'}
              </p>
            )}

            <CaseExceptions kase={c} onCaseChanged={refresh} />
            {can(MANAGE) && (c.state === 'OPEN' || c.state === 'REVIEW_PENDING') && <CancelCaseForm kase={c} reloading={reloading} onChanged={refresh} />}
          </div>
        )}
      </Section>
    </div>
  );
}

/** FR-082, DF11: HR closes a live review with a reason; its pending decision task closes with it. */
function CancelCaseForm({ kase, reloading, onChanged }: { kase: CaseDetail; reloading: boolean; onChanged: () => void }) {
  const { me } = useSession();
  const id = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: (body: { expectedVersion: number; reason: string }) => api<{ caseId: string; state: string }>(`/v1/confirmations/${encodeURIComponent(kase.id)}/cancel`, { body }),
    onSuccess: onChanged,
    // A stale version or a case that closed meanwhile: reload it so the panel shows where it stands.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) onChanged();
    },
  });
  if (me?.employeeId && me.employeeId === kase.employeeId) return <p className="hint">You cannot cancel your own confirmation review.</p>;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = reason.trim();
    setProblem(text ? null : 'Enter why the review is cancelled.');
    if (text && !reloading) cancel.mutate({ expectedVersion: kase.version, reason: text });
  };
  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        Cancel this review
      </h3>
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit}>
        <label className="wide">
          Reason (required)
          <textarea required maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
        </label>
        <p className="hint wide">
          The reason is confidential. Any decision waiting in the Decision inbox closes with the review and no more reminders are sent; the case and its history are kept. The employee’s status does not change.
        </p>
        {problem && (
          <p role="alert" className="error wide">
            {problem}
          </p>
        )}
        <div className="wide row">
          <button type="submit" className="secondary" disabled={cancel.isPending || reloading}>
            Cancel review
          </button>
        </div>
      </form>
      <PlainRefusal error={cancel.error} />
    </>
  );
}

/** A refusal in the API's own plain words; anything else (a failure, a lost answer) as usual. */
export function PlainRefusal({ error }: { error: unknown }) {
  if (!error) return null;
  if (!(error instanceof ApiError) || error.status >= 500) return <ErrorNote error={error} />;
  return (
    <p role="alert" className="error">
      {error.message}
    </p>
  );
}

function HistoryTable({ actions, withReasons }: { actions: CaseAction[]; withReasons: boolean }) {
  return (
    <div style={SCROLL}>
      <table>
        <thead>
          <tr>
            <th scope="col">Action</th>
            <th scope="col">Prior due date</th>
            <th scope="col">New due date</th>
            <th scope="col">Actual confirmation date</th>
            <th scope="col">Occurred at</th>
            {withReasons && <th scope="col">Reason</th>}
          </tr>
        </thead>
        <tbody>
          {actions.map((a, index) => (
            <tr key={`${a.occurredAt}-${index}`}>
              <td>{outcomeLabel(a.action)}</td>
              <td>{formatDate(a.priorDueDate)}</td>
              <td>{formatDate(a.newDueDate)}</td>
              <td>{formatDate(a.actualConfirmationDate)}</td>
              <td>
                <time dateTime={a.occurredAt}>{localDateTime(a.occurredAt)}</time>
              </td>
              {withReasons && <td>{a.reason}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `busy`: sending, or the case is reloading (its version is about to change), so nothing is sent meanwhile. */
function RecommendationForm({ version, busy, onSubmit }: { version: number; busy: boolean; onSubmit: (body: RecommendationBody) => void }) {
  const id = useId();
  const [kind, setKind] = useState<'' | 'CONFIRM' | 'EXTEND'>('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [months, setMonths] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  // Required-field checks only; every business rule (manager, state, version, extension limit) is the server's.
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = reason.trim();
    const missing =
      kind === ''
        ? 'Choose whether to recommend confirmation or an extension.'
        : kind === 'CONFIRM' && !effectiveDate
          ? 'Enter the effective date of the confirmation.'
          : kind === 'EXTEND' && !months
            ? 'Choose how many months to extend the probation by.'
            : !text
              ? 'Enter a reason.'
              : null;
    setProblem(missing);
    // The disabled button already blocks sending while busy; this guard keeps a version that is being replaced unsent.
    if (missing !== null || kind === '' || busy) return;
    onSubmit(
      kind === 'CONFIRM'
        ? { expectedVersion: version, recommendation: 'CONFIRM', effectiveDate, reason: text }
        : { expectedVersion: version, recommendation: 'EXTEND', extensionMonths: Number(months), reason: text },
    );
  };

  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        Your recommendation
      </h3>
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit}>
        <fieldset className="wide" style={GROUP}>
          <legend>Recommendation</legend>
          <div className="row">
            <label className="check">
              <input type="radio" name={`${id}-kind`} value="CONFIRM" required checked={kind === 'CONFIRM'} onChange={() => setKind('CONFIRM')} /> Confirm
            </label>
            <label className="check">
              <input type="radio" name={`${id}-kind`} value="EXTEND" required checked={kind === 'EXTEND'} onChange={() => setKind('EXTEND')} /> Extend probation
            </label>
          </div>
        </fieldset>
        {kind === 'CONFIRM' && (
          <label>
            Effective date
            <input type="date" required value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </label>
        )}
        {kind === 'EXTEND' && (
          <label>
            Extend by (months)
            <select required value={months} onChange={(e) => setMonths(e.target.value)}>
              <option value="">Choose…</option>
              {MONTHS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="wide">
          Reason (required)
          <textarea required maxLength={1000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
        </label>
        <p className="hint wide">The reason is confidential. An HR reviewer decides the recommendation; the employee record changes only if it is approved.</p>
        {problem && (
          <p role="alert" className="error wide">
            {problem}
          </p>
        )}
        <div className="wide row">
          <button type="submit" disabled={busy}>
            Send recommendation
          </button>
        </div>
      </form>
    </>
  );
}
