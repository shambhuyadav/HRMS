// FR-092 / DF15: increment cases, with amounts only when the server returned them, and the manager's proposal.

import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, Fragment, useId, useState } from 'react';
import { api, formatDate, isConflict, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section, StateBadge } from '../../ui';
import { answered, DecisionInboxLink, H3, type IncrementCase, LoadProblem, money, moneyProblem, occurrenceText, type Outcome, outcomeLabel, OUTCOMES, type PickedEmployee, type ProposalBody, type ProposalResult, PROPOSE, SCROLL, SR_ONLY, STATE_FILTERS, TEXTAREA, useKeys, useReloadCases } from './shared';

// ---------------------------------------------------------------------------------------------------------
// FR-092 / DF15: cases, with amounts only when the server returned them, and the direct manager's proposal.
// ---------------------------------------------------------------------------------------------------------

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
      <p className="hint">
        Submitted cases are decided by another administrator on the <DecisionInboxLink /> page, not here. A case changes no salary until it is approved.
      </p>
      {can(PROPOSE) && <p className="hint">Cycle outcomes are proposed by the employee’s current direct manager.</p>}
      <label className="inline">
        State{' '}
        <select
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
        </select>
      </label>
      {sentFor && (
        <p className="ok" role="status">
          Proposal for {sentFor} sent for an independent decision.
        </p>
      )}
      {conflict && !conflictInForm && (
        <div className="stack">
          <p className="hint">The proposal for {conflict.employeeCode} was not accepted, and the case list was reloaded. Check the case’s current state.</p>
          <ErrorNote error={conflict.error} />
        </div>
      )}
      {cases.isPending && <p className="hint loading">Loading cases…</p>}
      <LoadProblem error={cases.error} forbidden="The selected role cannot view increment cases." />
      {data && items.length === 0 && (
        <Empty>{state ? `No increment cases are in the state “${filterLabel}”.` : 'No increment cases yet. Cases appear when a review is opened or an off-cycle change is proposed.'}</Empty>
      )}
      {items.length > 0 && !withAmounts && (
        <p className="hint" role="note">
          Amounts are shown only to roles holding a confidential salary grant.
        </p>
      )}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table>
            <thead>
              <tr>
                <th scope="col">Employee</th>
                <th scope="col">Review</th>
                <th scope="col">Effective date</th>
                <th scope="col">State</th>
                <th scope="col">Proposed outcome</th>
                {withAmounts && <th scope="col">Baseline</th>}
                {withAmounts && <th scope="col">Proposed amount</th>}
                {hasActions && (
                  <th scope="col">
                    <span style={SR_ONLY}>Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {items.map((c) => {
                const canOpen = proposable(c);
                const open = canOpen && openId === c.id;
                return (
                  <Fragment key={c.id}>
                    <tr aria-current={open ? 'true' : undefined}>
                      <td>{c.employeeCode}</td>
                      <td>{c.correctsHistoryId ? 'Correction' : c.offCycle ? 'Off-cycle' : occurrenceText(c.occurrence)}</td>
                      <td>{formatDate(c.effectiveDate)}</td>
                      <td>
                        <StateBadge state={c.state} />
                      </td>
                      <td>{c.proposedOutcome ? outcomeLabel(c.proposedOutcome) : '—'}</td>
                      {withAmounts && <td>{money(c.baselineAmount, c.currency)}</td>}
                      {withAmounts && <td>{money(c.proposedAmount, c.currency)}</td>}
                      {hasActions && (
                        <td>
                          <div className="row">
                            {canOpen && (
                              <button
                                type="button"
                                className="link"
                                aria-expanded={open}
                                aria-controls={open ? formId(c.id) : undefined}
                                aria-label={`${open ? 'Close proposal' : 'Propose outcome'} for ${c.employeeCode}`}
                                onClick={() => toggle(open ? null : c.id)}
                              >
                                {open ? 'Close proposal' : 'Propose outcome'}
                              </button>
                            )}
                            {onShowSalary && (
                              <button type="button" className="link" aria-label={`Salary for ${c.employeeCode}`} onClick={() => onShowSalary({ id: c.employeeId, employeeCode: c.employeeCode })}>
                                Salary
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={columns} id={formId(c.id)}>
                          <ProposalForm
                            kase={c}
                            onSent={() => {
                              toggle(null);
                              setSentFor(c.employeeCode);
                            }}
                            onConflict={(error) => setConflict({ caseId: c.id, employeeCode: c.employeeCode, error })}
                            onCancel={() => toggle(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
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

  // Required fields and the money format only; every business rule (manager, state, version) is the server's.
  const check = (text: string): string | null => {
    if (outcome === '') return 'Choose the proposed outcome.';
    if (outcome === 'INCREASE') {
      const amountProblem = moneyProblem(amount, 'the new amount') ?? moneyProblem(counterpart, 'the counterpart figure');
      if (amountProblem) return amountProblem;
    }
    return text === '' ? 'Enter a reason.' : null;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = reason.trim();
    const missing = check(text);
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
      <h3 id={`${id}-title`} style={H3}>
        Proposal for {kase.employeeCode} ({kase.occurrence})
      </h3>
      {kase.state === 'RETURNED' && <p className="hint">The decision maker returned this case; propose again with any changes.</p>}
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit}>
        <label>
          Proposed outcome
          <select required value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome | '')}>
            <option value="">Choose…</option>
            {OUTCOMES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {outcome === 'INCREASE' && (
          <>
            <label>
              New amount on the cycle basis
              <input inputMode="decimal" autoComplete="off" required value={amount} aria-describedby={`${id}-money`} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label>
              Counterpart figure
              <input inputMode="decimal" autoComplete="off" required value={counterpart} aria-describedby={`${id}-money`} onChange={(e) => setCounterpart(e.target.value)} />
            </label>
            <p className="hint wide" id={`${id}-money`}>
              {kase.baselineAmount !== undefined && <>Current baseline on the cycle basis: {money(kase.baselineAmount, kase.currency)}. </>}
              Enter the new figure on the cycle’s basis and the matching figure on the other basis (annual CTC when the basis is monthly gross, monthly gross when it
              is annual CTC). Neither figure is worked out from the other.
            </p>
          </>
        )}
        {(outcome === 'NO_CHANGE' || outcome === 'DEFER') && <p className="hint wide">No change and defer outcomes create no salary revision.</p>}
        <label className="wide">
          Reason (required)
          <textarea required maxLength={1000} rows={3} style={TEXTAREA} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        {problem && (
          <p role="alert" className="error wide">
            {problem}
          </p>
        )}
        <div className="wide row">
          <button type="submit" disabled={propose.isPending}>
            Send proposal
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
        <div className="wide">
          <ErrorNote error={propose.error} />
          {isConflict(propose.error) && <p className="hint">The case list was reloaded; check this case and send the proposal again.</p>}
        </div>
      </form>
    </>
  );
}
