// One confirmation case: dates, state, decision history (CI17) and the direct manager's recommendation (FR-081, DF11).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, CheckField, ChoiceRow, FormField, FormGrid, LabelledFieldset } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, formatDate, isForbidden, isNotFound, localDateTime, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Item, NotPermitted, Notice, Section, StateBadge, WarningNote } from '../../ui';
import { CaseExceptions } from './case-exceptions';
import { type CaseAction, type CaseDetail, DECIDE, MANAGE, MONTHS, outcomeLabel, RECOMMEND, type RecommendationBody, TimingBadge, useKeys } from './shared';

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
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        }
      >
        {detail.isPending && <LoadingLine>Loading the case…</LoadingLine>}
        <CaseProblem error={detail.error} />
        {c && (
          <div className="flex flex-col gap-3">
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
              <WarningNote badge="not on probation">
                This employee is no longer on probation, so the review cannot be recommended or decided, and no reminders are sent.
                {can(MANAGE) && ' Cancel it below to close it.'}
              </WarningNote>
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
            {c.state === 'OPEN' && !can(RECOMMEND) && c.view !== 'NOT_ON_PROBATION' && <Hint>Waiting for a recommendation from the employee’s direct manager.</Hint>}

            <CardSubheading>History</CardSubheading>
            <CaseHistory kase={c} withReasons={withReasons} />

            {justSent && <Notice notice={{ text: 'Recommendation sent for HR review.', ok: true }} />}
            {showForm && <RecommendationForm version={c.version} busy={recommend.isPending || reloading} onSubmit={(body) => recommend.mutate(body)} />}
            <ErrorNote error={recommend.error} />
            {conflict && showForm && <Hint role="status">{reloading ? 'Reloading the case…' : 'The case has been reloaded with its latest details; check them and send again.'}</Hint>}

            <CaseExceptions kase={c} onCaseChanged={refresh} />
            {can(MANAGE) && (c.state === 'OPEN' || c.state === 'REVIEW_PENDING') && <CancelCaseForm kase={c} reloading={reloading} onChanged={refresh} />}
          </div>
        )}
      </Section>
    </div>
  );
}

/** A case the server would not read: refused, out of scope (or gone), or any other failure. */
function CaseProblem({ error }: { error: unknown }) {
  if (isForbidden(error)) return <NotPermitted>The selected role cannot open this confirmation case.</NotPermitted>;
  if (isNotFound(error)) return <Empty>This case is not available in the selected role’s scope.</Empty>;
  return <ErrorNote error={error} />;
}

/** The decisions so far: withheld without the history grant (said so), none yet, or the table. */
function CaseHistory({ kase, withReasons }: { kase: CaseDetail; withReasons: boolean }) {
  if (kase.historyIncluded === false) return <Hint>Earlier decisions are not shown: the selected role has no confirmation history grant.</Hint>;
  if (kase.actions.length === 0) return <Empty>No decisions recorded yet.</Empty>;
  return <HistoryTable actions={kase.actions} withReasons={withReasons} />;
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
  if (me?.employeeId && me.employeeId === kase.employeeId) return <Hint>You cannot cancel your own confirmation review.</Hint>;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = reason.trim();
    setProblem(text ? null : 'Enter why the review is cancelled.');
    if (text && !reloading) cancel.mutate({ expectedVersion: kase.version, reason: text });
  };
  return (
    <>
      <CardSubheading id={`${id}-title`}>Cancel this review</CardSubheading>
      <FormGrid aria-labelledby={`${id}-title`} onSubmit={submit}>
        <FormField className="col-span-full">
          Reason (required)
          <Textarea required maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className="resize-y" />
        </FormField>
        <Hint>
          The reason is confidential. Any decision waiting in the Decision inbox closes with the review and no more reminders are sent; the case and its history are kept. The employee’s status does not change.
        </Hint>
        {problem && <Notice notice={{ text: problem, ok: false }} />}
        <ButtonRow className="col-span-full">
          <Button type="submit" variant="outline" disabled={cancel.isPending || reloading}>
            Cancel review
          </Button>
        </ButtonRow>
      </FormGrid>
      <PlainRefusal error={cancel.error} />
    </>
  );
}

/** A refusal in the API's own plain words; anything else (a failure, a lost answer) as usual. */
export function PlainRefusal({ error }: { error: unknown }) {
  if (!error) return null;
  if (!(error instanceof ApiError) || error.status >= 500) return <ErrorNote error={error} />;
  return <Notice notice={{ text: error.message, ok: false }} />;
}

function HistoryTable({ actions, withReasons }: { actions: CaseAction[]; withReasons: boolean }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Action</TableHead>
          <TableHead scope="col">Prior due date</TableHead>
          <TableHead scope="col">New due date</TableHead>
          <TableHead scope="col">Actual confirmation date</TableHead>
          <TableHead scope="col">Occurred at</TableHead>
          {withReasons && <TableHead scope="col">Reason</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {actions.map((a, index) => (
          <TableRow key={`${a.occurredAt}-${index}`}>
            <TableCell>{outcomeLabel(a.action)}</TableCell>
            <TableCell>{formatDate(a.priorDueDate)}</TableCell>
            <TableCell>{formatDate(a.newDueDate)}</TableCell>
            <TableCell>{formatDate(a.actualConfirmationDate)}</TableCell>
            <TableCell>
              <time dateTime={a.occurredAt}>{localDateTime(a.occurredAt)}</time>
            </TableCell>
            {withReasons && <TableCell>{a.reason}</TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** What is missing before a recommendation can be sent, or null; every business rule is the server's. */
function missingRecommendation(kind: '' | 'CONFIRM' | 'EXTEND', effectiveDate: string, months: string, reason: string): string | null {
  if (kind === '') return 'Choose whether to recommend confirmation or an extension.';
  if (kind === 'CONFIRM' && !effectiveDate) return 'Enter the effective date of the confirmation.';
  if (kind === 'EXTEND' && !months) return 'Choose how many months to extend the probation by.';
  if (!reason) return 'Enter a reason.';
  return null;
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
    const missing = missingRecommendation(kind, effectiveDate, months, text);
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
      <CardSubheading id={`${id}-title`}>Your recommendation</CardSubheading>
      <FormGrid aria-labelledby={`${id}-title`} onSubmit={submit}>
        <LabelledFieldset legend="Recommendation">
          <ChoiceRow>
            <CheckField>
              <input type="radio" name={`${id}-kind`} value="CONFIRM" required checked={kind === 'CONFIRM'} onChange={() => setKind('CONFIRM')} /> Confirm
            </CheckField>
            <CheckField>
              <input type="radio" name={`${id}-kind`} value="EXTEND" required checked={kind === 'EXTEND'} onChange={() => setKind('EXTEND')} /> Extend probation
            </CheckField>
          </ChoiceRow>
        </LabelledFieldset>
        {kind === 'CONFIRM' && (
          <FormField>
            Effective date
            <Input type="date" required value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </FormField>
        )}
        {kind === 'EXTEND' && (
          <FormField>
            Extend by (months)
            <NativeSelect required value={months} onChange={(e) => setMonths(e.target.value)}>
              <option value="">Choose…</option>
              {MONTHS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </NativeSelect>
          </FormField>
        )}
        <FormField className="col-span-full">
          Reason (required)
          <Textarea required maxLength={1000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className="resize-y" />
        </FormField>
        <Hint>The reason is confidential. An HR reviewer decides the recommendation; the employee record changes only if it is approved.</Hint>
        {problem && <Notice notice={{ text: problem, ok: false }} />}
        <ButtonRow className="col-span-full">
          <Button type="submit" disabled={busy}>
            Send recommendation
          </Button>
        </ButtonRow>
      </FormGrid>
    </>
  );
}
