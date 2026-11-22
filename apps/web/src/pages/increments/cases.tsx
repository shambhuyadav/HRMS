// FR-092 / DF15: increment cases, with amounts only when the server returned them, and the manager's proposal.

import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, Fragment, useId, useState } from 'react';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, FilterBar, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, formatDate, isConflict, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Notice, Section, StateBadge } from '../../ui';
import {
  answered,
  DecisionInboxLink,
  type IncrementCase,
  LoadProblem,
  money,
  moneyProblem,
  occurrenceText,
  type Outcome,
  outcomeLabel,
  OUTCOMES,
  type PickedEmployee,
  type ProposalBody,
  type ProposalResult,
  PROPOSE,
  STATE_FILTERS,
  useKeys,
  useReloadCases,
} from './shared';

// ---------------------------------------------------------------------------------------------------------
// FR-092 / DF15: cases, with amounts only when the server returned them, and the direct manager's proposal.
// ---------------------------------------------------------------------------------------------------------

/** Which review a case belongs to: a correction of an applied change, an off-cycle change, or a cycle occurrence. */
function reviewText(c: IncrementCase): string {
  if (c.correctsHistoryId) return 'Correction';
  return c.offCycle ? 'Off-cycle' : occurrenceText(c.occurrence);
}

export function CasesSection({ onShowSalary }: { onShowSalary: ((employee: PickedEmployee) => void) | undefined }) {
  const { me, can } = useSession();
  const keys = useKeys();
  const [state, setState] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [sentFor, setSentFor] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ caseId: string; employeeCode: string; error: unknown } | null>(null);
  const cases = useQuery({
    queryKey: keys.cases(state),
    queryFn: () => api<{ items: IncrementCase[] }>(`/v1/increment-cases${state ? `?${new URLSearchParams({ state })}` : ''}`),
    retry: retryTransient,
  });
  const data = answered(cases);
  const items = data?.items ?? [];
  // The server includes amounts only for a caller holding the salary field grant (BR-044). The columns follow the
  // response, never the client's own reading of the permissions.
  const withAmounts = items.some((c) => c.baselineAmount !== undefined);
  // Only the employee's current direct manager may propose a cycle outcome, so a role without a linked employee record
  // cannot use the form. Off-cycle cases and cases that are pending or decided take no proposal.
  const canPropose = can(PROPOSE) && !!me?.employeeId;
  const proposable = (c: IncrementCase) => canPropose && !c.offCycle && (c.state === 'DRAFT' || c.state === 'RETURNED');
  const hasActions = !!onShowSalary || items.some(proposable);
  const columns = 5 + (withAmounts ? 2 : 0) + (hasActions ? 1 : 0);
  const filterLabel = STATE_FILTERS.find((f) => f.value === state)?.label ?? state;
  const formId = (caseId: string) => `increment-proposal-${caseId}`;
  // A refused proposal (409) reloads the list. When the case is still open its form stays and shows the refusal; when it
  // has moved on, the form closes, so the refusal is kept here: the new state must not read as this proposal being sent.
  const conflictCase = conflict ? items.find((c) => c.id === conflict.caseId) : undefined;
  const conflictInForm = conflict !== null && openId === conflict.caseId && conflictCase !== undefined && proposable(conflictCase);
  const toggle = (caseId: string | null) => {
    setSentFor(null);
    setConflict(null);
    setOpenId(caseId);
  };

  return (
    <Section title={`Increment cases${data ? ` (${items.length})` : ''}`}>
      <Hint>
        Submitted cases are decided by another administrator on the <DecisionInboxLink /> page, not here. A case changes no salary until it is approved.
      </Hint>
      {can(PROPOSE) && <Hint>Cycle outcomes are proposed by the employee’s current direct manager.</Hint>}
      <FilterBar>
        <FormField>
          State{' '}
          <NativeSelect
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              toggle(null);
            }}
          >
            {STATE_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </FilterBar>
      {sentFor && <Notice notice={{ text: `Proposal for ${sentFor} sent for an independent decision.`, ok: true }} />}
      {conflict && !conflictInForm && (
        <div className="flex flex-col gap-3">
          <Hint>The proposal for {conflict.employeeCode} was not accepted, and the case list was reloaded. Check the case’s current state.</Hint>
          <ErrorNote error={conflict.error} />
        </div>
      )}
      {cases.isPending && <LoadingLine>Loading cases…</LoadingLine>}
      <LoadProblem error={cases.error} forbidden="The selected role cannot view increment cases." />
      {data && items.length === 0 && (
        <Empty>{state ? `No increment cases are in the state “${filterLabel}”.` : 'No increment cases yet. Cases appear when a review is opened or an off-cycle change is proposed.'}</Empty>
      )}
      {items.length > 0 && !withAmounts && <Hint role="note">Amounts are shown only to roles holding a confidential salary grant.</Hint>}
      {items.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Employee</TableHead>
              <TableHead scope="col">Review</TableHead>
              <TableHead scope="col">Effective date</TableHead>
              <TableHead scope="col">State</TableHead>
              <TableHead scope="col">Proposed outcome</TableHead>
              {withAmounts && <TableHead scope="col">Baseline</TableHead>}
              {withAmounts && <TableHead scope="col">Proposed amount</TableHead>}
              {hasActions && (
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((c) => {
              const canOpen = proposable(c);
              const open = canOpen && openId === c.id;
              return (
                <Fragment key={c.id}>
                  <TableRow aria-current={open ? 'true' : undefined}>
                    <TableCell>{c.employeeCode}</TableCell>
                    <TableCell>{reviewText(c)}</TableCell>
                    <TableCell>{formatDate(c.effectiveDate)}</TableCell>
                    <TableCell>
                      <StateBadge state={c.state} />
                    </TableCell>
                    <TableCell>{c.proposedOutcome ? outcomeLabel(c.proposedOutcome) : '—'}</TableCell>
                    {withAmounts && <TableCell>{money(c.baselineAmount, c.currency)}</TableCell>}
                    {withAmounts && <TableCell>{money(c.proposedAmount, c.currency)}</TableCell>}
                    {hasActions && (
                      <RowActionsCell>
                        <RowActions>
                          {canOpen && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              aria-expanded={open}
                              aria-controls={open ? formId(c.id) : undefined}
                              aria-label={`${open ? 'Close proposal' : 'Propose outcome'} for ${c.employeeCode}`}
                              onClick={() => toggle(open ? null : c.id)}
                            >
                              {open ? 'Close proposal' : 'Propose outcome'}
                            </Button>
                          )}
                          {onShowSalary && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              aria-label={`Salary for ${c.employeeCode}`}
                              onClick={() => onShowSalary({ id: c.employeeId, employeeCode: c.employeeCode })}
                            >
                              Salary
                            </Button>
                          )}
                        </RowActions>
                      </RowActionsCell>
                    )}
                  </TableRow>
                  {open && (
                    <TableRow>
                      <TableCell colSpan={columns} id={formId(c.id)}>
                        <ProposalForm
                          kase={c}
                          onSent={() => {
                            toggle(null);
                            setSentFor(c.employeeCode);
                          }}
                          onConflict={(error) => setConflict({ caseId: c.id, employeeCode: c.employeeCode, error })}
                          onCancel={() => toggle(null)}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

/** The check of a proposal before it is sent: required fields and the money format only; every business rule is the server's. */
function proposalProblem(outcome: Outcome | '', amount: string, counterpart: string, reason: string): string | null {
  if (outcome === '') return 'Choose the proposed outcome.';
  if (outcome === 'INCREASE') {
    const amountProblem = moneyProblem(amount, 'the new amount') ?? moneyProblem(counterpart, 'the counterpart figure');
    if (amountProblem) return amountProblem;
  }
  return reason === '' ? 'Enter a reason.' : null;
}

/**
 * The direct manager's proposal for one cycle case (DF15). It is sent against the case version shown; an increase
 * states the new amount on the cycle's basis and the counterpart figure on the other basis, both exactly as typed.
 * No change and defer send no amounts.
 */
function ProposalForm({
  kase,
  onSent,
  onConflict,
  onCancel,
}: {
  kase: IncrementCase;
  onSent: () => void;
  onConflict: (error: unknown) => void;
  onCancel: () => void;
}) {
  const reloadCases = useReloadCases();
  const id = useId();
  const [outcome, setOutcome] = useState<Outcome | ''>('');
  const [amount, setAmount] = useState('');
  const [counterpart, setCounterpart] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const propose = useMutation({
    mutationFn: (body: ProposalBody) => api<ProposalResult>(`/v1/increment-cases/${encodeURIComponent(kase.id)}/proposal`, { body }),
    onSuccess: () => {
      reloadCases();
      onSent();
    },
    // A stale version or a case that moved on: reload so that a retry uses the current version and state.
    onError: (error) => {
      if (!isConflict(error)) return;
      reloadCases();
      onConflict(error);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = reason.trim();
    const missing = proposalProblem(outcome, amount, counterpart, text);
    setProblem(missing);
    if (missing !== null || outcome === '') {
      propose.reset();
      return;
    }
    propose.mutate(
      outcome === 'INCREASE'
        ? { expectedVersion: kase.version, outcome, proposedAmount: amount, proposedCounterpart: counterpart, reason: text }
        : { expectedVersion: kase.version, outcome, reason: text },
    );
  };

  return (
    <>
      <CardSubheading id={`${id}-title`}>
        Proposal for {kase.employeeCode} ({kase.occurrence})
      </CardSubheading>
      {kase.state === 'RETURNED' && <Hint>The decision maker returned this case; propose again with any changes.</Hint>}
      <FormGrid aria-labelledby={`${id}-title`} onSubmit={submit}>
        <FormField>
          Proposed outcome
          <NativeSelect required value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome | '')}>
            <option value="">Choose…</option>
            {OUTCOMES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        {outcome === 'INCREASE' && (
          <>
            <FormField>
              New amount on the cycle basis
              <Input inputMode="decimal" autoComplete="off" required value={amount} aria-describedby={`${id}-money`} onChange={(e) => setAmount(e.target.value)} />
            </FormField>
            <FormField>
              Counterpart figure
              <Input inputMode="decimal" autoComplete="off" required value={counterpart} aria-describedby={`${id}-money`} onChange={(e) => setCounterpart(e.target.value)} />
            </FormField>
            <Hint id={`${id}-money`}>
              {kase.baselineAmount !== undefined && <>Current baseline on the cycle basis: {money(kase.baselineAmount, kase.currency)}. </>}
              Enter the new figure on the cycle’s basis and the matching figure on the other basis (annual CTC when the basis is monthly gross, monthly gross when it
              is annual CTC). Neither figure is worked out from the other.
            </Hint>
          </>
        )}
        {(outcome === 'NO_CHANGE' || outcome === 'DEFER') && <Hint>No change and defer outcomes create no salary revision.</Hint>}
        <FormField className="col-span-full">
          Reason (required)
          <Textarea required maxLength={1000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormField>
        {problem && <Notice notice={{ text: problem, ok: false }} />}
        <ButtonRow className="col-span-full">
          <Button type="submit" disabled={propose.isPending}>
            Send proposal
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </ButtonRow>
        <div className="col-span-full">
          <ErrorNote error={propose.error} />
          {isConflict(propose.error) && <Hint>The case list was reloaded; check this case and send the proposal again.</Hint>}
        </div>
      </FormGrid>
    </>
  );
}
