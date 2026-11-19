// A settlement revision's read-only parts: the calculation, the lines, the final period's payroll, the balances and the decision trail.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Section } from '../../ui';
import { howText, plural } from './calculation-basis';
import { COMPONENT_KIND_LABEL, DECISION_LABEL, enc, H3, Item, ITEM_KIND_LABEL, ITEM_STATUS_LABEL, labelOf, LINE_KIND_LABEL, LINE_SOURCE_LABEL, LoadProblem, LOAN_KIND_LABEL, Money, PATHS, POLICY_READ, SCROLL, STATUTORY_READ, STEP_LABEL, useKeys, UserRef, when } from './shared';
import { type CalculationItem, deciderLabel, type FinalPeriodRun, type SettlementCalculation, type SettlementDetail, type SettlementLine } from './types';

/** Whether the amount group came back (the lines, the net amount, the calculation and the waiver come with it, or none of them). */
const withAmounts = (s: SettlementDetail) => s.lines !== undefined || s.netAmount !== undefined || s.calculation !== undefined;
export const isCalculatedLine = (l: SettlementLine) => l.source === 'CALCULATED';
/** The calculation the revision carries recovers unserved notice, so there is something a waiver would change. */
export const recoversNotice = (s: SettlementDetail) => (s.calculation?.items ?? []).some((i) => i.kind === 'NOTICE_RECOVERY' && i.status === 'CALCULATED');

/**
 * FR-052 (I-88): the calculation snapshot the revision carries, exactly as the server recorded it: when and by whom, the period, and
 * each item with what it is, whether it blocks the approval and the basis the server used. Confidential like the lines.
 */
export function CalculationView({ s }: { s: SettlementDetail }) {
  const { can } = useSession();
  if (!withAmounts(s)) {
    return (
      <Section title="Calculation">
        <p className="hint">The calculation is confidential like the settlement amounts, and the selected role does not receive it.</p>
      </Section>
    );
  }
  const k = s.calculation ?? null;
  return (
    <Section title="Calculation">
      {s.noticeWaiver && (
        <p role="note">
          <Badge tone="warn">waived</Badge> Notice recovery waived: {s.noticeWaiver.reason}{' '}
          <span className="hint">
            (by <UserRef userId={s.noticeWaiver.waivedBy} />, {when(s.noticeWaiver.waivedAt)})
          </span>
        </p>
      )}
      {k === null ? (
        <Empty>Not calculated yet.</Empty>
      ) : (
        <>
          <dl className="kv">
            <Item term="Snapshot">{k.sequence}</Item>
            <Item term="Calculated">
              {when(k.calculatedAt)} by <UserRef userId={k.calculatedBy} />
            </Item>
            <Item term="Last working date">{formatDate(k.lastWorkingDate)}</Item>
            <Item term="Period">
              {formatDate(k.periodStart)} to {formatDate(k.periodEnd)}
            </Item>
            <Item term="Settlement policy">{k.policyRevision !== null && k.policyRevision !== undefined ? `Revision ${k.policyRevision}` : 'None in force on the last working date'}</Item>
            <Item term="Blocking items">
              {k.blockingCount}
              {k.blockingCount > 0 && (
                <>
                  {' '}
                  <Badge tone="bad">{k.blockingCount === 1 ? 'blocks approval' : 'block approval'}</Badge>
                </>
              )}
            </Item>
          </dl>
          {k.blockingCount > 0 && (
            <p className="hint">
              An item that blocks approval needs a policy, rule pack or record that is missing. Once it is in place the draft is calculated again; a submitted revision is
              returned and corrected through a new revision.
            </p>
          )}
          <CalculationItems items={k.items} currency={k.currencyCode} />
          {k.sequence > 1 && <EarlierSnapshots s={s} current={k} />}
        </>
      )}
      {(can(POLICY_READ) || can(STATUTORY_READ)) && (
        <p>
          <Link to={PATHS.settlementSettings}>Settlement policy and statutory packs</Link>
        </p>
      )}
    </Section>
  );
}

function CalculationItems({ items, currency }: { items: readonly CalculationItem[]; currency: string }) {
  if (items.length === 0) return <Empty>The calculation has no items.</Empty>;
  return (
    <div style={SCROLL}>
      <table aria-label="Calculation items">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Status</th>
            <th scope="col">Pay component</th>
            <th scope="col">Leave type</th>
            <th scope="col">Amount</th>
            <th scope="col">How</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.position}>
              <td>{labelOf(ITEM_KIND_LABEL, i.kind)}</td>
              <td>
                {labelOf(ITEM_STATUS_LABEL, i.status)}
                {i.blocking && (
                  <>
                    {' '}
                    <Badge tone="bad">Blocks approval</Badge>
                  </>
                )}
              </td>
              <td>{i.componentCode ?? ''}</td>
              <td>{i.leaveTypeCode ?? ''}</td>
              <td>{i.amount === null ? '' : <Money value={i.amount} currency={currency} />}</td>
              <td>{howText(i)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Earlier snapshots of the revision (GET /v1/settlements/:id/calculations, newest first), read only when opened. */
function EarlierSnapshots({ s, current }: { s: SettlementDetail; current: SettlementCalculation }) {
  const keys = useKeys();
  const [open, setOpen] = useState(false);
  const list = useQuery({
    enabled: open,
    queryKey: keys.calculations(s.id),
    queryFn: () => api<{ items: SettlementCalculation[] }>(`/v1/settlements/${enc(s.id)}/calculations`),
    retry: retryTransient,
  });
  const earlier = (list.data?.items ?? []).filter((k) => k.id !== current.id);
  return (
    <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>Earlier snapshots</summary>
      {list.isFetching && !list.data && <p className="hint loading">Loading the earlier snapshots…</p>}
      <LoadProblem error={list.error} forbidden="The selected role cannot read the calculation snapshots." />
      {list.data && earlier.length === 0 && <Empty>No earlier snapshot.</Empty>}
      {earlier.length > 0 && (
        <ul aria-label="Earlier snapshots">
          {earlier.map((k) => (
            <li key={k.id}>
              {`Snapshot ${k.sequence}, calculated ${when(k.calculatedAt)}: ${plural(String(k.itemCount), 'item', 'items')}, ${k.blockingCount} blocking approval`}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/**
 * Confidential lines and net amount, exactly as returned; the net is the server's, never a sum worked out here. The calculated
 * lines (I-88) and the lines entered, uploaded or copied for other components are shown apart, the entered ones with their reason.
 */
export function SettlementLines({ s }: { s: SettlementDetail }) {
  if (s.lines === undefined && s.netAmount === undefined) {
    return (
      <Section title="Lines and net amount">
        <p className="hint">Settlement amounts are confidential, and the selected role does not receive them.</p>
      </Section>
    );
  }
  const calculated = (s.lines ?? []).filter(isCalculatedLine);
  const entered = (s.lines ?? []).filter((l) => !isCalculatedLine(l));
  return (
    <Section title="Lines and net amount">
      {s.lines && (
        <>
          <h3 style={H3}>Calculated lines</h3>
          {calculated.length > 0 ? (
            <LineTable lines={calculated} currency={s.currencyCode} label="Calculated lines" source={false} reasons={false} />
          ) : (
            <Empty>{s.calculationStatus === 'CALCULATED' ? 'The calculation produced no line.' : 'None: this revision is not calculated.'}</Empty>
          )}
          <h3 style={H3}>Entered lines</h3>
          {entered.length > 0 ? (
            <LineTable lines={entered} currency={s.currencyCode} label="Entered lines" reasons />
          ) : (
            <Empty>{s.calculationStatus === 'CALCULATED' ? 'No line entered for other components.' : 'No lines yet.'}</Empty>
          )}
        </>
      )}
      {s.netAmount !== undefined && (
        <p>
          <strong>Net amount:</strong> <Money value={s.netAmount} currency={s.currencyCode} /> <span className="hint">(as recorded by the server for these lines)</span>
        </p>
      )}
    </Section>
  );
}

/** Settlement lines; the Reason column shows where asked, or (by default) when some line has one. */
export function LineTable({
  lines,
  currency,
  label = 'Settlement lines',
  source = true,
  reasons = lines.some((l) => !!l.reason),
}: {
  lines: readonly SettlementLine[];
  currency: string;
  label?: string;
  source?: boolean;
  reasons?: boolean;
}) {
  return (
    <div style={SCROLL}>
      <table aria-label={label}>
        <thead>
          <tr>
            <th scope="col">Pay component</th>
            <th scope="col">Kind</th>
            <th scope="col">Line kind</th>
            {source && <th scope="col">Source</th>}
            <th scope="col">Amount</th>
            {reasons && <th scope="col">Reason</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.componentCode}>
              <td>
                {l.componentName} <span className="hint">{l.componentCode}</span>
              </td>
              <td>{labelOf(COMPONENT_KIND_LABEL, l.componentKind)}</td>
              <td>{labelOf(LINE_KIND_LABEL, l.lineKind)}</td>
              {source && <td>{labelOf(LINE_SOURCE_LABEL, l.source)}</td>}
              <td>
                <Money value={l.amount} currency={currency} />
              </td>
              {reasons && <td>{l.reason || '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


/**
 * FR-052 (I-81 item 5): monthly payroll for the final period, components only (payroll amounts stay with the payroll grants). A
 * component paid by an approved or processed run is not paid again in the settlement; the server refuses such a line.
 */
function FinalPeriodPayroll({ runs }: { runs: readonly FinalPeriodRun[] }) {
  return (
    <>
      <h3 style={H3}>Monthly payroll for the final period</h3>
      {runs.length === 0 ? (
        <Empty>No payroll run covers the last working date yet.</Empty>
      ) : (
        <ul>
          {runs.map((r) => (
            <li key={r.runId}>
              {`${r.periodCode}, revision ${r.revision} (${readable(r.runState)}): `}
              {r.components.map((c) => `${c.componentCode}${c.alreadyPaid ? ' (already paid: not paid again here)' : ''}`).join(', ') || 'no component'}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Leave days with 2 decimals (DF05 display), and the exact value too when the server holds a finer one. */
function Days({ value }: { value: string }) {
  const finer = /\.\d{2}\d*[1-9]/.test(value);
  return (
    <>
      {Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      {finer && <span className="hint"> (exactly {value})</span>}
    </>
  );
}

/**
 * FR-034 "settlement shows remaining balance": the outstanding loans and the paid leave balances as at the last working
 * date, exactly as the server returned them and read-only. They are information for the preparer and the deciders:
 * nothing here changes the lines or works out an encashment or a recovery.
 */
export function RemainingBalances({ s }: { s: SettlementDetail }) {
  const b = s.balances;
  if (!b) {
    return (
      <Section title="Remaining balances">
        <p className="hint">Remaining loan and leave balances are shown with the settlement amounts, and the selected role does not receive them.</p>
      </Section>
    );
  }
  return (
    <Section title="Remaining balances">
      <p className="hint">Read-only. These balances do not change the settlement lines; no encashment or recovery is worked out from them.</p>
      {b.finalPeriodPayroll !== undefined && <FinalPeriodPayroll runs={b.finalPeriodPayroll} />}
      <h3 style={H3}>Paid leave as at the last working date ({formatDate(b.asOf)})</h3>
      {b.leave.length === 0 ? (
        <Empty>No paid leave type is active.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label="Leave balances at the last working date">
            <thead>
              <tr>
                <th scope="col">Leave type</th>
                <th scope="col">Available (days)</th>
                <th scope="col">Pending (days)</th>
                <th scope="col">Taken (days)</th>
              </tr>
            </thead>
            <tbody>
              {b.leave.map((l) => (
                <tr key={l.leaveType}>
                  <td>{l.leaveType}</td>
                  <td>
                    <Days value={l.available} />
                  </td>
                  <td>
                    <Days value={l.pending} />
                  </td>
                  <td>
                    <Days value={l.taken} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3 style={H3}>Outstanding loans and advances</h3>
      {b.loans === undefined ? (
        <p className="hint">Loans and advances are not in use, so no loan balance is shown.</p>
      ) : b.loans.length === 0 ? (
        <Empty>No outstanding loan or advance.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label="Outstanding loans and advances">
            <thead>
              <tr>
                <th scope="col">Kind</th>
                <th scope="col">Disbursed</th>
                <th scope="col">Principal</th>
                <th scope="col">Recovered</th>
                <th scope="col">Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {b.loans.map((l) => (
                <tr key={l.id}>
                  <td>{labelOf(LOAN_KIND_LABEL, l.loanKind)}</td>
                  <td>{formatDate(l.disbursementDate)}</td>
                  <td>
                    <Money value={l.principal} currency={l.currencyCode} />
                  </td>
                  <td>
                    <Money value={l.recovered} currency={l.currencyCode} />
                  </td>
                  <td>
                    <Money value={l.outstanding} currency={l.currencyCode} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

export function DecisionTrail({ s }: { s: SettlementDetail }) {
  const { me } = useSession();
  const myUserId = me?.userId ?? null;
  return (
    <Section title="Decisions">
      {s.decisions.length === 0 ? (
        <Empty>No review or approval decision yet.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label="Decisions">
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col">Decision</th>
                <th scope="col">Decided by</th>
                <th scope="col">Decided</th>
              </tr>
            </thead>
            <tbody>
              {s.decisions.map((d, i) => (
                <tr key={`${d.transactionId}-${d.step}-${i}`}>
                  <td>{labelOf(STEP_LABEL, d.action)}</td>
                  <td>{labelOf(DECISION_LABEL, d.decision)}</td>
                  <td>
                    {d.decidedBy ? deciderLabel(d.decidedBy, myUserId) : '—'}
                    {d.onBehalfOf && <span className="hint">{` on behalf of ${deciderLabel(d.onBehalfOf, myUserId)}`}</span>}
                  </td>
                  <td>
                    <time dateTime={d.decidedAt}>{when(d.decidedAt)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

