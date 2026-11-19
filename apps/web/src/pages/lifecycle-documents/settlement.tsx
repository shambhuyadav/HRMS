// One settlement revision: the screen, and the view that brings its parts together.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, NotPermitted, Section } from '../../ui';
import { RecordPayment, ReleaseEligibility, SendStatement, SettlementExport, VoidSettlement, WaiveNotice } from './settlement-actions';
import { PreparerActions } from './settlement-preparation';
import { CalculationView, DecisionTrail, recoversNotice, RemainingBalances, SettlementLines } from './settlement-views';
import { NoticePeriod } from './settlements';
import { CALCULATION_LABEL, CalculationNote, enc, EXIT_READ, Item, labelOf, LoadProblem, OUTPUT_STATES, PATHS, PAYMENT_STATUS_LABEL, SETTLEMENT_APPROVE, SETTLEMENT_EXPORT, SETTLEMENT_PREPARE, SETTLEMENT_READ, SETTLEMENT_RECORD_PAYMENT, SETTLEMENT_RELEASE, SETTLEMENT_SEND, SETTLEMENT_WAIVE_NOTICE, settlementLabel, SettlementState, STATE_EXPLANATION, useKeys, UserRef, UUID, VOIDABLE_STATES, when } from './shared';
import type { Calculation, ExitCase, SettlementDetail } from './types';

// =========================================================================================================
// One settlement revision: lines, decisions, preparation, release eligibility and export
// =========================================================================================================
export function SettlementScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!UUID.test(id)) {
    return (
      <>
        <h1>Settlement</h1>
        <Empty>This address does not name a settlement.</Empty>
      </>
    );
  }
  if (!can(SETTLEMENT_READ)) {
    return (
      <>
        <h1>Settlement</h1>
        <Section title="Settlement">
          <NotPermitted>The selected role cannot view settlements.</NotPermitted>
        </Section>
      </>
    );
  }
  return <SettlementView key={id} id={id} />;
}

function SettlementView({ id }: { id: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const detail = useQuery({ queryKey: keys.settlement(id), queryFn: () => api<SettlementDetail>(`/v1/settlements/${enc(id)}`), retry: retryTransient });
  const calculation = useQuery({ queryKey: keys.calculation, queryFn: () => api<Calculation>('/v1/settlements/calculation'), retry: retryTransient, staleTime: 5 * 60_000 });
  const s = detail.data;
  const exit = useQuery({
    enabled: s !== undefined && can(EXIT_READ),
    queryKey: keys.exit(s?.exitCaseId ?? '-'),
    queryFn: () => api<ExitCase>(`/v1/exit-cases/${enc(s!.exitCaseId)}`),
    retry: retryTransient,
  });
  /** What the last action did; it outlives the action's own panel, which goes away when the state moves on. */
  const [notice, setNotice] = useState<string | null>(null);
  const own = s !== undefined && !!me?.employeeId && me.employeeId === s.employeeId;
  return (
    <>
      <h1>{s ? `Settlement of ${s.employeeName} (${s.employeeCode}), revision ${s.revision}` : 'Settlement'}</h1>
      <p className="row">
        <Link to={PATHS.settlements}>All settlements</Link>
        {s && <Link to={PATHS.exitSettlements(s.exitCaseId)}>All revisions for this exit</Link>}
      </p>
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
      <Section title="Settlement">
        {detail.isPending && <p className="hint loading">Loading the settlement…</p>}
        <LoadProblem error={detail.error} forbidden="The selected role cannot view settlements." missing="This settlement is not available in the selected role’s scope." />
        {s && (
          <>
            <dl className="kv">
              <Item term="Employee">
                {s.employeeName} <span className="hint">{s.employeeCode}</span>
              </Item>
              <Item term="Revision">{s.revision}</Item>
              <Item term="State">
                <SettlementState state={s.state} />
              </Item>
              <Item term="Currency">{s.currencyCode}</Item>
              <Item term="Calculation">{labelOf(CALCULATION_LABEL, s.calculationStatus)}</Item>
              <Item term="Payment">{labelOf(PAYMENT_STATUS_LABEL, s.paymentStatus)}</Item>
              {s.paymentDate && <Item term="Paid on (disbursement month)">{formatDate(s.paymentDate)}</Item>}
              {s.payment && <Item term="Payment reference">{s.payment.reference}</Item>}
              {s.cancelReason && <Item term="Why it was cancelled">{s.cancelReason}</Item>}
              <Item term="Prepared by">
                <UserRef userId={s.preparedBy} />
              </Item>
              <Item term="Corrects">{s.supersedesSettlementId ? <Link to={PATHS.settlement(s.supersedesSettlementId)}>The previous revision</Link> : 'Nothing: first revision'}</Item>
              <Item term="Created">{when(s.createdAt)}</Item>
              <Item term="Submitted">{when(s.submittedAt)}</Item>
              <Item term="Reviewed">{when(s.reviewedAt)}</Item>
              <Item term="Approved">{when(s.approvedAt)}</Item>
              <Item term="Eligible for release">{when(s.releaseEligibleAt)}</Item>
              {exit.data && <Item term="Approved last working date">{formatDate(exit.data.approvedLastWorkingDate)}</Item>}
              {exit.data && (
                <Item term="Notice period">
                  <NoticePeriod notice={exit.data.noticePeriod} />
                </Item>
              )}
            </dl>
            <p>{STATE_EXPLANATION[s.state] ?? settlementLabel(s.state)}</p>
            {/* A revision not calculated: how drafts are calculated (I-88, a hint for a draft), or the older server's "not configured". */}
            {s.calculationStatus !== 'CALCULATED' && (calculation.data?.status === 'NOT_CONFIGURED' || (calculation.data?.status === 'AVAILABLE' && s.state === 'DRAFT')) && (
              <CalculationNote calculation={calculation.data} />
            )}
          </>
        )}
      </Section>
      {s && <CalculationView s={s} />}
      {s && <SettlementLines s={s} />}
      {s && <RemainingBalances s={s} />}
      {s && <DecisionTrail s={s} />}
      {s && !own && s.state === 'DRAFT' && can(SETTLEMENT_PREPARE) && <PreparerActions s={s} exit={exit.data} onNotice={setNotice} />}
      {s && !own && s.state === 'DRAFT' && can(SETTLEMENT_WAIVE_NOTICE) && s.noticeWaiver === null && recoversNotice(s) && <WaiveNotice s={s} onNotice={setNotice} />}
      {s && !own && s.state === 'APPROVED' && can(SETTLEMENT_RELEASE) && <ReleaseEligibility s={s} onNotice={setNotice} />}
      {s && !own && s.state === 'RELEASE_ELIGIBLE' && can(SETTLEMENT_RECORD_PAYMENT) && <RecordPayment s={s} onNotice={setNotice} />}
      {s && !own && VOIDABLE_STATES.has(s.state) && can(SETTLEMENT_APPROVE) && <VoidSettlement s={s} onNotice={setNotice} />}
      {s && OUTPUT_STATES.has(s.state) && can(SETTLEMENT_EXPORT) && <SettlementExport s={s} />}
      {s && !own && OUTPUT_STATES.has(s.state) && can(SETTLEMENT_SEND) && <SendStatement s={s} />}
    </>
  );
}

