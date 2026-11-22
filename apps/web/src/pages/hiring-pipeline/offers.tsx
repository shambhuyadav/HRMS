// Offers (F1): the offer list, and one offer with its compensation, joining date, submission, response and withdrawal.
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BackLink } from '@/components/back-link';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, CheckField, ChoiceRow, FilterBar, FormField, FormGrid, LabelledFieldset } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, formatDate, isConflict, localDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, NotPermitted, Section } from '../../ui';
import { HandoverSection, Onboarding } from './handover';
import { OfferApprovalList } from './offer-approvals';
import { OfferLettersSection } from './offer-letters';
import { COMPENSATION_WORDS, LoadProblem, OFFER_WORDS, Refusal } from './refusals';
import {
  APPLICATION_READ,
  CandidateLink,
  COMPENSATION_APPROVE,
  COMPENSATION_MANAGE,
  COMPENSATION_READ,
  CURRENCY,
  DECISION_LABEL,
  Denied,
  EMPLOYEE_STATUS_LABEL,
  enc,
  HANDOVER,
  ISSUE_LETTER,
  labelOf,
  LIMITS,
  Missing,
  Money,
  MONEY,
  Notice,
  OFFER_MANAGE,
  OFFER_READ,
  OFFER_STATE_LABEL,
  OFFER_STATES,
  OfferStateBadge,
  OPEN_OFFER_STATES,
  PATHS,
  personText,
  Problem,
  RequisitionStateBadge,
  STAGE_LABEL,
  useKeys,
  useRefresh,
  useUserId,
  UUID,
} from './shared';
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
      <FilterBar>
        <FormField>
          State
          <NativeSelect value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All states</option>
            {OFFER_STATES.map((s) => (
              <option key={s} value={s}>
                {labelOf(OFFER_STATE_LABEL, s)}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </FilterBar>
      {list.isPending && <LoadingLine>Loading offers…</LoadingLine>}
      <LoadProblem error={list.error} forbidden="The selected role cannot list offers." />
      {list.data && items.length === 0 && <Empty>No offers to show. An offer is prepared from a candidate’s application in the hiring tracker.</Empty>}
      {items.length > 0 && (
        <Table aria-label="Offers">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Candidate</TableHead>
              <TableHead scope="col">Requisition</TableHead>
              <TableHead scope="col">State</TableHead>
              <TableHead scope="col">Proposed joining date</TableHead>
              <TableHead scope="col">Revision</TableHead>
              <TableHead scope="col">Prepared</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Offer</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((o) => (
              <TableRow key={o.id}>
                <TableCell>
                  {o.candidate.fullName} <Hint as="span">{o.candidate.candidateCode}</Hint>
                </TableCell>
                <TableCell>
                  {o.requisition.code} <Hint as="span">{o.requisition.title}</Hint>
                </TableCell>
                <TableCell>
                  <OfferStateBadge state={o.state} />
                </TableCell>
                <TableCell>{formatDate(o.proposedJoiningDate)}</TableCell>
                <TableCell>{o.currentRevision > 0 ? o.currentRevision : 'Not submitted'}</TableCell>
                <TableCell>{formatDate(o.createdAt)}</TableCell>
                <RowActionsCell>
                  <Link to={PATHS.offer(o.id)} aria-label={`Open the offer to ${o.candidate.fullName} (${o.candidate.candidateCode})`}>
                    Open
                  </Link>
                </RowActionsCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {items.length >= LIMITS.offers && <Hint>Showing the latest {LIMITS.offers} offers.</Hint>}
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
      {o && <BackLink to={PATHS.offers}>← Offers</BackLink>}
      <h1>{o ? `Offer to ${o.candidate.fullName} (${o.candidate.candidateCode}) for ${o.requisition.code}` : 'Offer'}</h1>
      {detail.isPending && <LoadingLine>Loading the offer…</LoadingLine>}
      <LoadProblem error={detail.error} forbidden="The selected role cannot view this offer." missing="This offer is not available in the selected role’s scope." />
      {o && (
        <>
          <Section title="Offer">
            <dl className="kv">
              <Item term="Candidate">
                <CandidateLink candidate={o.candidate} />
              </Item>
              <Item term="Requisition">
                {o.requisition.code} <Hint as="span">{o.requisition.title}</Hint> <RequisitionStateBadge state={o.requisition.state} />
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
              <Hint>
                It waits for your decision under <Link to={PATHS.offers}>Offer approvals</Link>.
              </Hint>
            )}
            {o.requisition.state !== 'APPROVED' && OPEN_OFFER_STATES.includes(o.state) && !o.handedOverEmployeeId && (
              <Hint>The requisition is no longer approved: the offer cannot be accepted or handed over.</Hint>
            )}
            {closed && !o.handedOverEmployeeId && <Hint>This offer is closed. A new offer can be prepared from the application, or the application ended.</Hint>}
          </Section>
          <Notice text={notice} />
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
              <Table aria-label="Approval history">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Revision</TableHead>
                    <TableHead scope="col">Decision</TableHead>
                    <TableHead scope="col">Decided by</TableHead>
                    <TableHead scope="col">When</TableHead>
                    {withReasons && <TableHead scope="col">Reason</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {o.decisions.map((d, index) => (
                    <TableRow key={`${d.decidedAt}-${index}`}>
                      <TableCell>{d.revision}</TableCell>
                      <TableCell>{labelOf(DECISION_LABEL, d.decision)}</TableCell>
                      <TableCell>
                        {personText(d.decidedBy, userId)}
                        {d.onBehalfOf && <Hint as="span">{` on behalf of ${personText(d.onBehalfOf, userId)}`}</Hint>}
                      </TableCell>
                      <TableCell>{formatDate(d.decidedAt)}</TableCell>
                      {withReasons && <TableCell>{d.reason ?? '—'}</TableCell>}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
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
          <CardSubheading>Submitted revisions</CardSubheading>
          <Table aria-label="Submitted revisions">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Revision</TableHead>
                <TableHead scope="col">Proposed joining date</TableHead>
                <TableHead scope="col">Annual CTC</TableHead>
                <TableHead scope="col">Monthly gross</TableHead>
                <TableHead scope="col">Submitted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {c.revisions.map((r) => (
                <TableRow key={r.revision}>
                  <TableCell>{r.revision}</TableCell>
                  <TableCell>{formatDate(r.proposedJoiningDate)}</TableCell>
                  <TableCell>
                    <Money value={r.annualCtc} currency={r.currencyCode} />
                  </TableCell>
                  <TableCell>
                    <Money value={r.monthlyGross} currency={r.currencyCode} />
                  </TableCell>
                  <TableCell>{formatDate(r.submittedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
      {o.state === 'SUBMITTED' && <Hint>An independent eligible Admin decides this revision; meanwhile the offer can only be withdrawn.</Hint>}
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
      <CardSubheading id={`${id}-title`}>Terms</CardSubheading>
      <FormGrid aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <FormField>
          Proposed joining date (required)
          <Input type="date" required value={joining} onChange={(e) => setJoining(e.target.value)} />
        </FormField>
        <Problem text={problem} />
        {save.error && (
          <div className="col-span-full">
            <Refusal error={save.error} words={OFFER_WORDS} />
          </div>
        )}
        <ButtonRow className="col-span-full">
          <Button type="submit" disabled={save.isPending || busy}>
            Save joining date
          </Button>
        </ButtonRow>
      </FormGrid>
    </>
  );
}

/** The format checks made before sending (a currency code, at least one amount, plain decimals); the amounts are the server's call. */
function compensationProblem(currencyCode: string, annualCtc: string, monthlyGross: string): string | null {
  if (!CURRENCY.test(currencyCode)) return 'Enter a three-letter currency code, such as INR.';
  if (!annualCtc && !monthlyGross) return 'Enter the annual CTC, the monthly gross or both.';
  if ((annualCtc && !MONEY.test(annualCtc)) || (monthlyGross && !MONEY.test(monthlyGross))) {
    return 'Enter amounts as digits with up to 4 decimal places and no separators, for example 1200000.00.';
  }
  return null;
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
    const missing = compensationProblem(code, a, m);
    setProblem(missing);
    if (missing) {
      save.reset();
      return;
    }
    save.mutate({ currencyCode: code, ...(a ? { annualCtc: a } : {}), ...(m ? { monthlyGross: m } : {}), expectedVersion: o.version });
  };
  return (
    <>
      <CardSubheading id={`${id}-title`}>Compensation (confidential)</CardSubheading>
      <FormGrid aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <FormField>
          Currency
          <Input required maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </FormField>
        <FormField>
          Annual CTC
          <Input inputMode="decimal" maxLength={20} value={annual} onChange={(e) => setAnnual(e.target.value)} />
        </FormField>
        <FormField>
          Monthly gross
          <Input inputMode="decimal" maxLength={20} value={monthly} onChange={(e) => setMonthly(e.target.value)} />
        </FormField>
        <Hint>
          Recording replaces the whole compensation: give every amount that applies. Whoever records it cannot approve the offer, and the amounts never appear in
          notifications or the audit trail.
        </Hint>
        <Problem text={problem} />
        {save.error && (
          <div className="col-span-full">
            <Refusal error={save.error} words={COMPENSATION_WORDS} />
          </div>
        )}
        <ButtonRow className="col-span-full">
          <Button type="submit" disabled={save.isPending || busy}>
            Record compensation
          </Button>
        </ButtonRow>
      </FormGrid>
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
      <CardSubheading>Submit for approval</CardSubheading>
      <Hint>
        Submitting pins these terms and the compensation as revision {o.currentRevision + 1} for an independent eligible Admin, who is never the person who
        prepared the offer, recorded its compensation or submits it.
      </Hint>
      <ButtonRow>
        <Button type="button" disabled={submit.isPending || busy} onClick={() => submit.mutate({ expectedVersion: o.version })}>
          Submit for approval
        </Button>
      </ButtonRow>
      <Refusal error={submit.error} words={OFFER_WORDS} />
    </>
  );
}

/** The response's required answers, checked before sending. */
function responseProblem(response: string, respondedOn: string): string | null {
  if (response === '') return 'Choose whether the candidate accepted or declined.';
  if (!respondedOn) return 'Enter the date of the response.';
  return null;
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
    const missing = responseProblem(response, respondedOn);
    setProblem(missing);
    if (missing || response === '') {
      record.reset();
      return;
    }
    record.mutate({ response, respondedOn, expectedVersion: o.version });
  };
  return (
    <>
      <CardSubheading id={`${id}-title`}>The candidate’s response</CardSubheading>
      <FormGrid aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <LabelledFieldset legend="Response">
          <ChoiceRow>
            <CheckField>
              <input type="radio" name={`${id}-response`} value="ACCEPTED" checked={response === 'ACCEPTED'} onChange={() => setResponse('ACCEPTED')} /> Accepted
            </CheckField>
            <CheckField>
              <input type="radio" name={`${id}-response`} value="DECLINED" checked={response === 'DECLINED'} onChange={() => setResponse('DECLINED')} /> Declined
            </CheckField>
          </ChoiceRow>
        </LabelledFieldset>
        <FormField>
          Responded on (required)
          <Input type="date" required value={respondedOn} onChange={(e) => setRespondedOn(e.target.value)} />
        </FormField>
        <Hint>An acceptance needs the requisition still approved and an open vacancy; the response date cannot be in the future.</Hint>
        <Problem text={problem} />
        {record.error && (
          <div className="col-span-full">
            <Refusal error={record.error} words={OFFER_WORDS} />
          </div>
        )}
        <ButtonRow className="col-span-full">
          <Button type="submit" disabled={record.isPending || busy}>
            Record response
          </Button>
        </ButtonRow>
      </FormGrid>
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
      <CardSubheading id={`${id}-title`}>Withdraw the offer</CardSubheading>
      <FormGrid aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <FormField className="col-span-full">
          Reason for withdrawing (required)
          <Textarea required maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormField>
        {o.state === 'SUBMITTED' && <Hint>Withdrawing cancels the approval that is waiting.</Hint>}
        <Problem text={problem} />
        {withdraw.error && (
          <div className="col-span-full">
            <Refusal error={withdraw.error} words={OFFER_WORDS} />
          </div>
        )}
        <ButtonRow className="col-span-full">
          <Button type="submit" variant="danger" disabled={withdraw.isPending || busy}>
            Withdraw offer
          </Button>
        </ButtonRow>
      </FormGrid>
    </>
  );
}

