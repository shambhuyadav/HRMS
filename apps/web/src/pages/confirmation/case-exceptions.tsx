// DF11 exceptions of one case (I-19): their history, the proposer's withdrawal, and a new proposal.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useRef, useState } from 'react';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, CheckField, ChoiceRow, FormField, FormGrid, LabelledFieldset } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, formatDate, isForbidden, localDateTime, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, NotPermitted, Notice, StateBadge } from '../../ui';
import { Refusal } from './refusals';
import { APPROVE_EXCEPTION, type CaseDetail, type CaseException, type ExceptionBody, type ExceptionKind, kindLabel, PROPOSE_EXCEPTION, useKeys, useUserId } from './shared';

// ---------------------------------------------------------------------------------------------------------
// DF11 exceptions of one case (I-19): their history, the proposer's withdrawal, and a new proposal.
// ---------------------------------------------------------------------------------------------------------

export function CaseExceptions({ kase, onCaseChanged }: { kase: CaseDetail; onCaseChanged: () => void }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const userId = useUserId();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const tableBox = useRef<HTMLDivElement>(null);
  const canPropose = can(PROPOSE_EXCEPTION);
  const list = useQuery({
    queryKey: keys.exceptions(kase.id),
    queryFn: () => api<{ items: CaseException[] }>(`/v1/confirmations/${encodeURIComponent(kase.id)}/exceptions`),
    retry: retryTransient,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.exceptions(kase.id) });
    void qc.invalidateQueries({ queryKey: keys.pendingExceptions });
  };
  const withdraw = useMutation({
    mutationFn: (x: CaseException) => api<{ exceptionId: string; state: string }>(`/v1/confirmation-exceptions/${encodeURIComponent(x.id)}/withdraw`, { method: 'POST' }),
    onSuccess: () => {
      refresh();
      // The row's button goes away; keep a keyboard user in the case panel, unless they moved on.
      const active = document.activeElement;
      if (!active || active === document.body || tableBox.current?.contains(active)) heading.current?.focus();
    },
    // Decided or withdrawn meanwhile: reload, so the row shows where it stands now.
    onError: (error) => {
      if (error instanceof ApiError && (error.status === 409 || error.status === 404)) refresh();
    },
  });

  const items = list.data?.items ?? [];
  const mayWithdraw = (x: CaseException) => canPropose && userId !== null && x.state === 'PROPOSED' && x.proposedBy === userId;
  // Sending, and until the list shows the withdrawal, so it cannot be sent twice.
  const withdrawing = withdraw.isPending || (withdraw.isSuccess && list.isFetching);
  // DF11: an exception can be proposed while the case is open or under review, never once it is closed.
  const canStillChange = kase.state === 'OPEN' || kase.state === 'REVIEW_PENDING';
  const ownCase = !!me?.employeeId && me.employeeId === kase.employeeId;

  return (
    <>
      <CardSubheading id={headingId} ref={heading} tabIndex={-1}>
        Exceptions
      </CardSubheading>
      <Hint>An approved due date override replaces the case’s due date; an approved extra extension allows one extension beyond the policy limit.</Hint>
      {list.isPending && <LoadingLine>Loading exceptions…</LoadingLine>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot view this case’s exceptions.</NotPermitted> : <ErrorNote error={list.error} />}
      {list.data && items.length === 0 && <Empty>No exceptions have been proposed for this case.</Empty>}
      {items.length > 0 && (
        <div ref={tableBox}>
          <ExceptionTable items={items} labelledBy={headingId} mayWithdraw={mayWithdraw} busy={withdrawing} onWithdraw={(x) => withdraw.mutate(x)} />
        </div>
      )}
      {withdraw.isSuccess && <Notice notice={{ text: 'Proposal withdrawn.', ok: true }} />}
      <Refusal error={withdraw.error} action="withdraw" />
      {can(APPROVE_EXCEPTION) && items.some((x) => x.state === 'PROPOSED') && <Hint>Waiting proposals are decided under Pending exceptions on this page.</Hint>}
      {canPropose &&
        canStillChange &&
        (ownCase ? (
          <Hint>You cannot propose an exception for your own confirmation.</Hint>
        ) : (
          <ProposeExceptionForm
            kase={kase}
            onProposed={refresh}
            onConflict={() => {
              onCaseChanged();
              refresh();
            }}
          />
        ))}
    </>
  );
}

function ExceptionTable({
  items,
  labelledBy,
  mayWithdraw,
  busy,
  onWithdraw,
}: {
  items: CaseException[];
  labelledBy: string;
  mayWithdraw: (x: CaseException) => boolean;
  busy: boolean;
  onWithdraw: (x: CaseException) => void;
}) {
  // The private reasons arrive for every row or for none (the confirmation reason group).
  const withReasons = items.some((x) => typeof x.reason === 'string');
  const withAction = items.some(mayWithdraw);
  return (
    <Table aria-labelledby={labelledBy}>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Exception</TableHead>
          <TableHead scope="col">Proposed due date</TableHead>
          <TableHead scope="col">State</TableHead>
          <TableHead scope="col">Proposed at</TableHead>
          <TableHead scope="col">Decided at</TableHead>
          {withReasons && <TableHead scope="col">Reason</TableHead>}
          {withReasons && <TableHead scope="col">Decision reason</TableHead>}
          {withAction && (
            <TableHead scope="col">
              <span className="sr-only">Action</span>
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((x) => (
          <TableRow key={x.id}>
            <TableCell>{kindLabel(x.kind)}</TableCell>
            <TableCell>{formatDate(x.proposedDueDate)}</TableCell>
            <TableCell>
              <StateBadge state={x.state} />
            </TableCell>
            <TableCell>
              <time dateTime={x.proposedAt}>{localDateTime(x.proposedAt)}</time>
            </TableCell>
            <TableCell>{x.decidedAt ? <time dateTime={x.decidedAt}>{localDateTime(x.decidedAt)}</time> : '—'}</TableCell>
            {withReasons && <TableCell>{x.reason}</TableCell>}
            {withReasons && <TableCell>{x.decisionReason ?? '—'}</TableCell>}
            {withAction && (
              <RowActionsCell>
                {mayWithdraw(x) && (
                  <RowActions>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      aria-label={`Withdraw your ${kindLabel(x.kind).toLowerCase()} proposal`}
                      onClick={() => onWithdraw(x)}
                    >
                      Withdraw
                    </Button>
                  </RowActions>
                )}
              </RowActionsCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** What is missing before an exception can be proposed, or null; whether the case allows it is the server's call. */
function missingException(chosen: '' | ExceptionKind, dueDate: string, reason: string): string | null {
  if (chosen === '') return 'Choose the kind of exception.';
  if (chosen === 'DUE_DATE_OVERRIDE' && !dueDate) return 'Enter the new due date.';
  if (!reason) return 'Enter a reason.';
  return null;
}

/**
 * A new exception with its private reason; another HR user decides it. Required-field checks only: whether the case
 * allows it (state, extension limit, an open proposal of the kind, the employee's start date) is the server's call.
 */
function ProposeExceptionForm({ kase, onProposed, onConflict }: { kase: CaseDetail; onProposed: () => void; onConflict: () => void }) {
  const id = useId();
  const [kind, setKind] = useState<'' | ExceptionKind>('');
  const [dueDate, setDueDate] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  // DF11: the due date changes only while the case is open; a recommendation under review keeps the date it was made
  // for. A choice made before the case moved on no longer applies (what was typed is kept).
  const overrideOpen = kase.state === 'OPEN';
  const chosen = kind === 'DUE_DATE_OVERRIDE' && !overrideOpen ? '' : kind;
  const propose = useMutation({
    mutationFn: (body: ExceptionBody) => api<{ exceptionId: string; state: string }>(`/v1/confirmations/${encodeURIComponent(kase.id)}/exceptions`, { body }),
    // A proposal sent starts the form clean; a refused one keeps what was typed.
    onSuccess: () => {
      setKind('');
      setDueDate('');
      setReason('');
      onProposed();
    },
    // The case moved on (a recommendation arrived, it closed, a proposal of this kind appeared): show it as it is now.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) onConflict();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = reason.trim();
    const missing = missingException(chosen, dueDate, text);
    setProblem(missing);
    if (missing !== null) {
      propose.reset();
      return;
    }
    if (chosen === '' || propose.isPending) return;
    propose.mutate(chosen === 'DUE_DATE_OVERRIDE' ? { kind: chosen, proposedDueDate: dueDate, reason: text } : { kind: chosen, reason: text });
  };

  const overrideHint = `${id}-override`;
  return (
    <>
      <CardSubheading id={`${id}-title`}>Propose an exception</CardSubheading>
      <FormGrid aria-labelledby={`${id}-title`} onSubmit={submit}>
        <LabelledFieldset legend="Exception">
          <ChoiceRow>
            <CheckField>
              <input
                type="radio"
                name={`${id}-kind`}
                value="DUE_DATE_OVERRIDE"
                required
                disabled={!overrideOpen}
                aria-describedby={overrideOpen ? undefined : overrideHint}
                checked={chosen === 'DUE_DATE_OVERRIDE'}
                onChange={() => setKind('DUE_DATE_OVERRIDE')}
              />{' '}
              Due date override
            </CheckField>
            <CheckField>
              <input type="radio" name={`${id}-kind`} value="EXTRA_EXTENSION" required checked={chosen === 'EXTRA_EXTENSION'} onChange={() => setKind('EXTRA_EXTENSION')} />{' '}
              Extra extension
            </CheckField>
          </ChoiceRow>
          {!overrideOpen && (
            <Hint className="m-0" id={overrideHint}>
              The due date cannot change while a recommendation is under review.
            </Hint>
          )}
        </LabelledFieldset>
        {chosen === 'DUE_DATE_OVERRIDE' && (
          <FormField>
            New due date
            <Input type="date" required value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </FormField>
        )}
        <FormField className="col-span-full">
          Reason (required)
          <Textarea required maxLength={1000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className="resize-y" />
        </FormField>
        <Hint>The reason is confidential. Another HR user decides the exception; the case changes only if it is approved.</Hint>
        {problem && <Notice notice={{ text: problem, ok: false }} />}
        {propose.error && (
          <div className="col-span-full">
            <Refusal error={propose.error} action="propose" sent={{ kind: propose.variables?.kind, startDate: kase.startDate }} />
          </div>
        )}
        <ButtonRow className="col-span-full">
          <Button type="submit" disabled={propose.isPending}>
            Propose exception
          </Button>
        </ButtonRow>
        {propose.isSuccess && <Notice notice={{ text: 'Exception proposed. Another HR user decides it; the case changes only if it is approved.', ok: true }} />}
      </FormGrid>
    </>
  );
}
