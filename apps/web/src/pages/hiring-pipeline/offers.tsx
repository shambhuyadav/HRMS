// Offers (F1): the offer list, and one offer with its compensation, joining date, submission, response and withdrawal.
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatDate, isConflict, localDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, NotPermitted, Section } from '../../ui';
import { HandoverSection, Onboarding } from './handover';
import { OfferApprovalList } from './offer-approvals';
import { OfferLettersSection } from './offer-letters';
import { COMPENSATION_WORDS, LoadProblem, OFFER_WORDS, Refusal } from './refusals';
import { APPLICATION_READ, CandidateLink, COMPENSATION_APPROVE, COMPENSATION_MANAGE, COMPENSATION_READ, CURRENCY, DECISION_LABEL, Denied, EMPLOYEE_STATUS_LABEL, enc, GROUP, H3, HANDOVER, ISSUE_LETTER, labelOf, LIMITS, Missing, Money, MONEY, OFFER_MANAGE, OFFER_READ, OFFER_STATE_LABEL, OFFER_STATES, OfferStateBadge, OPEN_OFFER_STATES, PATHS, personText, Problem, RequisitionStateBadge, SCROLL, SR_ONLY, STAGE_LABEL, TEXTAREA, useKeys, useRefresh, useUserId, UUID } from './shared';
import type { OfferSummary, OfferView } from './types';

// ---------------------------------------------------------------------------------------------------------
// Offers (F1): an approved requisition, a confidential compensation, independent approval, response and handover
// ---------------------------------------------------------------------------------------------------------

export function OffersScreen() {
  const { can } = useSession();
  const canApprove = can(COMPENSATION_APPROVE);
  if (!can(OFFER_READ) && !canApprove) return <Denied title="Offers">The selected role cannot view offers.</Denied>;
  return (
    <>
      <h1>Offers</h1>
      {canApprove && <OfferApprovalList />}
      {can(OFFER_READ) ? (
        <OfferList />
      ) : (
        <Section title="All offers">
          <NotPermitted>The selected role cannot list offers.</NotPermitted>
        </Section>
      )}
    </>
  );
}

function OfferList() {
  const keys = useKeys();
  const [state, setState] = useState('');
  const list = useQuery({ queryKey: keys.offers(state), queryFn: () => api<{ items: OfferSummary[] }>(`/v1/hiring/offers${state ? `?state=${state}` : ''}`), retry: retryTransient });
  const items = list.data?.items ?? [];
  return (
    <Section title={`All offers${list.data ? ` (${items.length})` : ''}`}>
      <label className="inline">
        State
        <select value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">All states</option>
          {OFFER_STATES.map((s) => (
            <option key={s} value={s}>
              {labelOf(OFFER_STATE_LABEL, s)}
            </option>
          ))}
        </select>
      </label>
      {list.isPending && <p className="hint loading">Loading offers…</p>}
      <LoadProblem error={list.error} forbidden="The selected role cannot list offers." />
      {list.data && items.length === 0 && <Empty>No offers to show. An offer is prepared from a candidate’s application in the hiring tracker.</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Offers">
            <thead>
              <tr>
                <th scope="col">Candidate</th>
                <th scope="col">Requisition</th>
                <th scope="col">State</th>
                <th scope="col">Proposed joining date</th>
                <th scope="col">Revision</th>
                <th scope="col">Prepared</th>
                <th scope="col">
                  <span style={SR_ONLY}>Offer</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.id}>
                  <td>
                    {o.candidate.fullName} <span className="hint">{o.candidate.candidateCode}</span>
                  </td>
                  <td>
                    {o.requisition.code} <span className="hint">{o.requisition.title}</span>
                  </td>
                  <td>
                    <OfferStateBadge state={o.state} />
                  </td>
                  <td>{formatDate(o.proposedJoiningDate)}</td>
                  <td>{o.currentRevision > 0 ? o.currentRevision : 'Not submitted'}</td>
                  <td>{formatDate(o.createdAt)}</td>
                  <td>
                    <Link to={PATHS.offer(o.id)} aria-label={`Open the offer to ${o.candidate.fullName} (${o.candidate.candidateCode})`}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {items.length >= LIMITS.offers && <p className="hint">Showing the latest {LIMITS.offers} offers.</p>}
    </Section>
  );
}

export function OfferScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(OFFER_READ) && !can(COMPENSATION_READ)) return <Denied title="Offer">The selected role cannot view offers.</Denied>;
  if (!UUID.test(id)) return <Missing title="Offer">This offer is not available in the selected role’s scope.</Missing>;
  return <OfferDetail key={id} id={id} />;
}

function OfferDetail({ id }: { id: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const refresh = useRefresh();
  const userId = useUserId();
  const [notice, setNotice] = useState<string | null>(null);
  const detail = useQuery({ queryKey: keys.offer(id), queryFn: () => api<OfferView>(`/v1/hiring/offers/${enc(id)}`), retry: retryTransient });
  const o = detail.data;
  // A reload is about to replace the version an action would send: nothing is sent meanwhile.
  const reloading = detail.isFetching && !detail.isPending;
  const done = (text?: string) => {
    setNotice(text ?? null);
    refresh();
  };
  const withReasons = o?.decisions.some((d) => d.reason !== undefined) ?? false;
  const closed = o !== undefined && !OPEN_OFFER_STATES.includes(o.state);
  return (
    <>
      {o && (
        <p>
          <Link className="back-link" to={PATHS.offers}>← Offers</Link>
        </p>
      )}
      <h1>{o ? `Offer to ${o.candidate.fullName} (${o.candidate.candidateCode}) for ${o.requisition.code}` : 'Offer'}</h1>
      {detail.isPending && <p className="hint loading">Loading the offer…</p>}
      <LoadProblem error={detail.error} forbidden="The selected role cannot view this offer." missing="This offer is not available in the selected role’s scope." />
      {o && (
        <>
          <Section title="Offer">
            <dl className="kv">
              <Item term="Candidate">
                <CandidateLink candidate={o.candidate} />
              </Item>
              <Item term="Requisition">
                {o.requisition.code} <span className="hint">{o.requisition.title}</span> <RequisitionStateBadge state={o.requisition.state} />
              </Item>
              <Item term="Application">
                {can(APPLICATION_READ) ? <Link to={PATHS.application(o.application.id)}>{labelOf(STAGE_LABEL, o.application.stage)}</Link> : labelOf(STAGE_LABEL, o.application.stage)}
              </Item>
              <Item term="State">
                <OfferStateBadge state={o.state} />
              </Item>
              <Item term="Proposed joining date">{formatDate(o.proposedJoiningDate)}</Item>
              <Item term="Revision">{o.currentRevision > 0 ? `Revision ${o.currentRevision}` : 'Not submitted yet'}</Item>
              {o.preparedBy === userId && <Item term="Prepared by">You</Item>}
              {o.submittedAt && <Item term="Submitted">{`${formatDate(o.submittedAt)}${o.submittedBy === userId ? ' by you' : ''}`}</Item>}
              {o.decidedAt && <Item term="Decided">{formatDate(o.decidedAt)}</Item>}
              {o.candidateResponseOn && <Item term="Candidate responded on">{formatDate(o.candidateResponseOn)}</Item>}
              {o.withdrawnAt && <Item term="Withdrawn">{formatDate(o.withdrawnAt)}</Item>}
              {o.withdrawnReason && <Item term="Withdrawal reason">{o.withdrawnReason}</Item>}
            </dl>
            {o.state === 'SUBMITTED' && o.pendingWith && (
              <p>
                Waiting for approval by {personText(o.pendingWith.assignee, userId)} since {formatDate(o.pendingWith.assignedAt)}.
              </p>
            )}
            {o.state === 'SUBMITTED' && o.pendingWith && o.pendingWith.assignee.userId === userId && can(COMPENSATION_APPROVE) && (
              <p className="hint">
                It waits for your decision under <Link to={PATHS.offers}>Offer approvals</Link>.
              </p>
            )}
            {o.requisition.state !== 'APPROVED' && OPEN_OFFER_STATES.includes(o.state) && !o.handedOverEmployeeId && (
              <p className="hint">The requisition is no longer approved: the offer cannot be accepted or handed over.</p>
            )}
            {closed && !o.handedOverEmployeeId && (
              <p className="hint">This offer is closed. A new offer can be prepared from the application, or the application ended.</p>
            )}
          </Section>
          {notice && (
            <p className="ok" role="status">
              {notice}
            </p>
          )}
          {o.compensation && <CompensationView compensation={o.compensation} userId={userId} />}
          <OfferActions offer={o} busy={reloading} onDone={done} />
          {(can(COMPENSATION_READ) || can(ISSUE_LETTER)) && <OfferLettersSection offer={o} />}
          {o.state === 'ACCEPTED' && !o.handedOverEmployeeId && can(HANDOVER) && (
            <HandoverSection offer={o} busy={reloading} onDone={(result) => done(`Employee draft created (status: ${labelOf(EMPLOYEE_STATUS_LABEL, result.employeeStatus).toLowerCase()}). It is not active.`)} />
          )}
          {o.handedOverEmployeeId && <Onboarding employeeId={o.handedOverEmployeeId} />}
          <Section title="Approval history">
            {o.decisions.length === 0 ? (
              <Empty>No approval decisions yet.</Empty>
            ) : (
              <div style={SCROLL}>
                <table aria-label="Approval history">
                  <thead>
                    <tr>
                      <th scope="col">Revision</th>
                      <th scope="col">Decision</th>
                      <th scope="col">Decided by</th>
                      <th scope="col">When</th>
                      {withReasons && <th scope="col">Reason</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {o.decisions.map((d, index) => (
                      <tr key={`${d.decidedAt}-${index}`}>
                        <td>{d.revision}</td>
                        <td>{labelOf(DECISION_LABEL, d.decision)}</td>
                        <td>
                          {personText(d.decidedBy, userId)}
                          {d.onBehalfOf && <span className="hint">{` on behalf of ${personText(d.onBehalfOf, userId)}`}</span>}
                        </td>
                        <td>{formatDate(d.decidedAt)}</td>
                        {withReasons && <td>{d.reason ?? '—'}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </>
  );
}

/** Confidential (offer.compensation): rendered only when the server returned it to this caller. */
function CompensationView({ compensation: c, userId }: { compensation: NonNullable<OfferView['compensation']>; userId: string | null }) {
  return (
    <Section title="Compensation (confidential)">
      {c.current ? (
        <dl className="kv" aria-label="Current compensation">
          <Item term="Currency">{c.current.currencyCode}</Item>
          <Item term="Annual CTC">
            <Money value={c.current.annualCtc} currency={c.current.currencyCode} />
          </Item>
          <Item term="Monthly gross">
            <Money value={c.current.monthlyGross} currency={c.current.currencyCode} />
          </Item>
          <Item term="Recorded">{`${formatDate(c.current.updatedAt)}${c.current.setBy === userId ? ' by you' : ''}`}</Item>
        </dl>
      ) : (
        <Empty>No compensation recorded yet.</Empty>
      )}
      {c.revisions.length > 0 && (
        <>
          <h3 style={H3}>Submitted revisions</h3>
          <div style={SCROLL}>
            <table aria-label="Submitted revisions">
              <thead>
                <tr>
                  <th scope="col">Revision</th>
                  <th scope="col">Proposed joining date</th>
                  <th scope="col">Annual CTC</th>
                  <th scope="col">Monthly gross</th>
                  <th scope="col">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {c.revisions.map((r) => (
                  <tr key={r.revision}>
                    <td>{r.revision}</td>
                    <td>{formatDate(r.proposedJoiningDate)}</td>
                    <td>
                      <Money value={r.annualCtc} currency={r.currencyCode} />
                    </td>
                    <td>
                      <Money value={r.monthlyGross} currency={r.currencyCode} />
                    </td>
                    <td>{formatDate(r.submittedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Section>
  );
}

function OfferActions({ offer: o, busy, onDone }: { offer: OfferView; busy: boolean; onDone: (notice?: string) => void }) {
  const { can } = useSession();
  const manage = can(OFFER_MANAGE);
  const draft = o.state === 'DRAFT';
  const withdrawable = OPEN_OFFER_STATES.includes(o.state) && !o.handedOverEmployeeId;
  const priceIt = draft && can(COMPENSATION_MANAGE);
  if (!(draft && manage) && !priceIt && !(o.state === 'APPROVED' && manage) && !(withdrawable && manage)) return null;
  return (
    <Section title="Offer actions">
      {o.state === 'SUBMITTED' && <p className="hint">An independent eligible Admin decides this revision; meanwhile the offer can only be withdrawn.</p>}
      {draft && manage && <JoiningDateForm offer={o} busy={busy} onDone={onDone} />}
      {priceIt && <CompensationForm offer={o} busy={busy} onDone={onDone} />}
      {draft && manage && <SubmitOffer offer={o} busy={busy} onDone={onDone} />}
      {o.state === 'APPROVED' && manage && <ResponseForm offer={o} busy={busy} onDone={onDone} />}
      {withdrawable && manage && <WithdrawForm offer={o} busy={busy} onDone={onDone} />}
    </Section>
  );
}

function JoiningDateForm({ offer: o, busy, onDone }: { offer: OfferView; busy: boolean; onDone: (notice?: string) => void }) {
  const id = useId();
  const [joining, setJoining] = useState(o.proposedJoiningDate);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: { proposedJoiningDate: string; expectedVersion: number }) => api<{ offerId: string; version: number }>(`/v1/hiring/offers/${enc(o.id)}`, { method: 'PUT', body }),
    onSuccess: (_result, body) => {
      setProblem(null);
      onDone(`Proposed joining date saved: ${formatDate(body.proposedJoiningDate)}.`);
    },
    onError: (error) => {
      if (isConflict(error)) onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending || busy) return;
    setProblem(joining ? null : 'Enter the proposed joining date.');
    if (!joining) {
      save.reset();
      return;
    }
    save.mutate({ proposedJoiningDate: joining, expectedVersion: o.version });
  };
  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        Terms
      </h3>
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <label>
          Proposed joining date (required)
          <input type="date" required value={joining} onChange={(e) => setJoining(e.target.value)} />
        </label>
        <Problem text={problem} />
        {save.error && (
          <div className="wide">
            <Refusal error={save.error} words={OFFER_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={save.isPending || busy}>
            Save joining date
          </button>
        </div>
      </form>
    </>
  );
}

/**
 * The confidential compensation of a draft offer. Recording replaces the whole compensation, so the form starts from
 * the current values when the server returned them. Amounts travel as the decimal strings typed (format checked only).
 */
function CompensationForm({ offer: o, busy, onDone }: { offer: OfferView; busy: boolean; onDone: (notice?: string) => void }) {
  const id = useId();
  const current = o.compensation?.current ?? null;
  const [currency, setCurrency] = useState(current?.currencyCode ?? 'INR');
  const [annual, setAnnual] = useState(current?.annualCtc ?? '');
  const [monthly, setMonthly] = useState(current?.monthlyGross ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: { currencyCode: string; annualCtc?: string; monthlyGross?: string; expectedVersion: number }) =>
      api<{ offerId: string; version: number }>(`/v1/hiring/offers/${enc(o.id)}/compensation`, { method: 'PUT', body }),
    onSuccess: () => {
      // A caller the API does not show the compensation to starts the form clean again: the amounts typed are not kept on
      // screen. A caller who reads it keeps the values just recorded, which the reloaded offer shows as well.
      if (!o.compensation) {
        setCurrency('INR');
        setAnnual('');
        setMonthly('');
      }
      setProblem(null);
      onDone('Compensation recorded.');
    },
    onError: (error) => {
      if (isConflict(error)) onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending || busy) return;
    const code = currency.trim().toUpperCase();
    const a = annual.trim();
    const m = monthly.trim();
    const missing = !CURRENCY.test(code)
      ? 'Enter a three-letter currency code, such as INR.'
      : !a && !m
        ? 'Enter the annual CTC, the monthly gross or both.'
        : (a && !MONEY.test(a)) || (m && !MONEY.test(m))
          ? 'Enter amounts as digits with up to 4 decimal places and no separators, for example 1200000.00.'
          : null;
    setProblem(missing);
    if (missing) {
      save.reset();
      return;
    }
    save.mutate({ currencyCode: code, ...(a ? { annualCtc: a } : {}), ...(m ? { monthlyGross: m } : {}), expectedVersion: o.version });
  };
  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        Compensation (confidential)
      </h3>
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <label>
          Currency
          <input required maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </label>
        <label>
          Annual CTC
          <input inputMode="decimal" maxLength={20} value={annual} onChange={(e) => setAnnual(e.target.value)} />
        </label>
        <label>
          Monthly gross
          <input inputMode="decimal" maxLength={20} value={monthly} onChange={(e) => setMonthly(e.target.value)} />
        </label>
        <p className="hint wide">
          Recording replaces the whole compensation: give every amount that applies. Whoever records it cannot approve the offer, and the amounts never appear in
          notifications or the audit trail.
        </p>
        <Problem text={problem} />
        {save.error && (
          <div className="wide">
            <Refusal error={save.error} words={COMPENSATION_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={save.isPending || busy}>
            Record compensation
          </button>
        </div>
      </form>
    </>
  );
}

function SubmitOffer({ offer: o, busy, onDone }: { offer: OfferView; busy: boolean; onDone: (notice?: string) => void }) {
  const submit = useMutation({
    mutationFn: (body: { expectedVersion: number }) => api<{ offerId: string; state: string; revision: number }>(`/v1/hiring/offers/${enc(o.id)}/submit`, { body }),
    onSuccess: (result) => onDone(`Offer submitted for independent approval (revision ${result.revision}).`),
    onError: (error) => {
      if (isConflict(error)) onDone();
    },
  });
  return (
    <>
      <h3 style={H3}>Submit for approval</h3>
      <p className="hint">
        Submitting pins these terms and the compensation as revision {o.currentRevision + 1} for an independent eligible Admin, who is never the person who
        prepared the offer, recorded its compensation or submits it.
      </p>
      <div className="row">
        <button type="button" disabled={submit.isPending || busy} onClick={() => submit.mutate({ expectedVersion: o.version })}>
          Submit for approval
        </button>
      </div>
      <Refusal error={submit.error} words={OFFER_WORDS} />
    </>
  );
}

function ResponseForm({ offer: o, busy, onDone }: { offer: OfferView; busy: boolean; onDone: (notice?: string) => void }) {
  const id = useId();
  const [response, setResponse] = useState<'' | 'ACCEPTED' | 'DECLINED'>('');
  const [respondedOn, setRespondedOn] = useState(() => localDate());
  const [problem, setProblem] = useState<string | null>(null);
  const record = useMutation({
    mutationFn: (body: { response: 'ACCEPTED' | 'DECLINED'; respondedOn: string; expectedVersion: number }) =>
      api<{ offerId: string; state: string }>(`/v1/hiring/offers/${enc(o.id)}/response`, { body }),
    onSuccess: (result) => {
      setResponse('');
      setRespondedOn(localDate());
      setProblem(null);
      onDone(result.state === 'ACCEPTED' ? 'Recorded the candidate’s acceptance.' : 'Recorded that the candidate declined the offer.');
    },
    onError: (error) => {
      if (isConflict(error)) onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (record.isPending || busy) return;
    const missing = response === '' ? 'Choose whether the candidate accepted or declined.' : !respondedOn ? 'Enter the date of the response.' : null;
    setProblem(missing);
    if (missing || response === '') {
      record.reset();
      return;
    }
    record.mutate({ response, respondedOn, expectedVersion: o.version });
  };
  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        The candidate’s response
      </h3>
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <fieldset className="wide" style={GROUP}>
          <legend>Response</legend>
          <div className="row">
            <label className="check">
              <input type="radio" name={`${id}-response`} value="ACCEPTED" checked={response === 'ACCEPTED'} onChange={() => setResponse('ACCEPTED')} /> Accepted
            </label>
            <label className="check">
              <input type="radio" name={`${id}-response`} value="DECLINED" checked={response === 'DECLINED'} onChange={() => setResponse('DECLINED')} /> Declined
            </label>
          </div>
        </fieldset>
        <label>
          Responded on (required)
          <input type="date" required value={respondedOn} onChange={(e) => setRespondedOn(e.target.value)} />
        </label>
        <p className="hint wide">An acceptance needs the requisition still approved and an open vacancy; the response date cannot be in the future.</p>
        <Problem text={problem} />
        {record.error && (
          <div className="wide">
            <Refusal error={record.error} words={OFFER_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={record.isPending || busy}>
            Record response
          </button>
        </div>
      </form>
    </>
  );
}

function WithdrawForm({ offer: o, busy, onDone }: { offer: OfferView; busy: boolean; onDone: (notice?: string) => void }) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const withdraw = useMutation({
    mutationFn: (body: { reason: string }) => api<{ offerId: string; state: string }>(`/v1/hiring/offers/${enc(o.id)}/withdraw`, { body }),
    onSuccess: () => {
      setReason('');
      setProblem(null);
      onDone('Offer withdrawn.');
    },
    onError: (error) => {
      if (isConflict(error)) onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (withdraw.isPending || busy) return;
    const text = reason.trim();
    setProblem(text ? null : 'Enter why the offer is withdrawn.');
    if (!text) {
      withdraw.reset();
      return;
    }
    withdraw.mutate({ reason: text });
  };
  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        Withdraw the offer
      </h3>
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <label className="wide">
          Reason for withdrawing (required)
          <textarea required maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
        </label>
        {o.state === 'SUBMITTED' && <p className="hint wide">Withdrawing cancels the approval that is waiting.</p>}
        <Problem text={problem} />
        {withdraw.error && (
          <div className="wide">
            <Refusal error={withdraw.error} words={OFFER_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" className="danger" disabled={withdraw.isPending || busy}>
            Withdraw offer
          </button>
        </div>
      </form>
    </>
  );
}

