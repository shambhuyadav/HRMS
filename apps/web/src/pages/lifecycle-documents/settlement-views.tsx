// A settlement revision's read-only parts: the calculation, the lines, the final period's payroll, the balances and the decision trail.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CardSubheading } from '@/components/card-subheading';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Section, WarningNote } from '../../ui';
import { howText, plural } from './calculation-basis';
import { COMPONENT_KIND_LABEL, DECISION_LABEL, enc, FOLD, FOLD_SUMMARY, Item, ITEM_KIND_LABEL, ITEM_STATUS_LABEL, labelOf, LINE_KIND_LABEL, LINE_SOURCE_LABEL, LoadProblem, LOAN_KIND_LABEL, Money, PATHS, POLICY_READ, STATUTORY_READ, STEP_LABEL, useKeys, UserRef, when } from './shared';
import { type CalculationItem, deciderLabel, type FinalPeriodRun, type OutstandingLoan, type SettlementCalculation, type SettlementDetail, type SettlementLine } from './types';

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
        <Hint>The calculation is confidential like the settlement amounts, and the selected role does not receive it.</Hint>
      </Section>
    );
  }
  const k = s.calculation ?? null;
  return (
    <Section title="Calculation">
      {s.noticeWaiver && (
        <WarningNote badge="waived">
          Notice recovery waived: {s.noticeWaiver.reason}{' '}
          <Hint as="span">
            (by <UserRef userId={s.noticeWaiver.waivedBy} />, {when(s.noticeWaiver.waivedAt)})
          </Hint>
        </WarningNote>
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
            <Hint>
              An item that blocks approval needs a policy, rule pack or record that is missing. Once it is in place the draft is calculated again; a submitted revision is
              returned and corrected through a new revision.
            </Hint>
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
    <Table aria-label="Calculation items">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Item</TableHead>
          <TableHead scope="col">Status</TableHead>
          <TableHead scope="col">Pay component</TableHead>
          <TableHead scope="col">Leave type</TableHead>
          <TableHead scope="col">Amount</TableHead>
          <TableHead scope="col">How</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((i) => (
          <TableRow key={i.position}>
            <TableCell>{labelOf(ITEM_KIND_LABEL, i.kind)}</TableCell>
            <TableCell>
              {labelOf(ITEM_STATUS_LABEL, i.status)}
              {i.blocking && (
                <>
                  {' '}
                  <Badge tone="bad">Blocks approval</Badge>
                </>
              )}
            </TableCell>
            <TableCell>{i.componentCode ?? ''}</TableCell>
            <TableCell>{i.leaveTypeCode ?? ''}</TableCell>
            <TableCell>{i.amount === null ? '' : <Money value={i.amount} currency={currency} />}</TableCell>
            <TableCell>{howText(i)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
    <details className={FOLD} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className={FOLD_SUMMARY}>Earlier snapshots</summary>
      {list.isFetching && !list.data && <LoadingLine>Loading the earlier snapshots…</LoadingLine>}
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
        <Hint>Settlement amounts are confidential, and the selected role does not receive them.</Hint>
      </Section>
    );
  }
  const calculated = (s.lines ?? []).filter(isCalculatedLine);
  const entered = (s.lines ?? []).filter((l) => !isCalculatedLine(l));
  return (
    <Section title="Lines and net amount">
      {s.lines && (
        <>
          <CardSubheading>Calculated lines</CardSubheading>
          {calculated.length > 0 ? (
            <LineTable lines={calculated} currency={s.currencyCode} label="Calculated lines" source={false} reasons={false} />
          ) : (
            <Empty>{s.calculationStatus === 'CALCULATED' ? 'The calculation produced no line.' : 'None: this revision is not calculated.'}</Empty>
          )}
          <CardSubheading>Entered lines</CardSubheading>
          {entered.length > 0 ? (
            <LineTable lines={entered} currency={s.currencyCode} label="Entered lines" reasons />
          ) : (
            <Empty>{s.calculationStatus === 'CALCULATED' ? 'No line entered for other components.' : 'No lines yet.'}</Empty>
          )}
        </>
      )}
      {s.netAmount !== undefined && (
        <p>
          <strong>Net amount:</strong> <Money value={s.netAmount} currency={s.currencyCode} /> <Hint as="span">(as recorded by the server for these lines)</Hint>
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
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Pay component</TableHead>
          <TableHead scope="col">Kind</TableHead>
          <TableHead scope="col">Line kind</TableHead>
          {source && <TableHead scope="col">Source</TableHead>}
          <TableHead scope="col">Amount</TableHead>
          {reasons && <TableHead scope="col">Reason</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((l) => (
          <TableRow key={l.componentCode}>
            <TableCell>
              {l.componentName} <Hint as="span">{l.componentCode}</Hint>
            </TableCell>
            <TableCell>{labelOf(COMPONENT_KIND_LABEL, l.componentKind)}</TableCell>
            <TableCell>{labelOf(LINE_KIND_LABEL, l.lineKind)}</TableCell>
            {source && <TableCell>{labelOf(LINE_SOURCE_LABEL, l.source)}</TableCell>}
            <TableCell>
              <Money value={l.amount} currency={currency} />
            </TableCell>
            {reasons && <TableCell>{l.reason || '—'}</TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}


/**
 * FR-052 (I-81 item 5): monthly payroll for the final period, components only (payroll amounts stay with the payroll grants). A
 * component paid by an approved or processed run is not paid again in the settlement; the server refuses such a line.
 */
function FinalPeriodPayroll({ runs }: { runs: readonly FinalPeriodRun[] }) {
  return (
    <>
      <CardSubheading>Monthly payroll for the final period</CardSubheading>
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
      {finer && <Hint as="span"> (exactly {value})</Hint>}
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
        <Hint>Remaining loan and leave balances are shown with the settlement amounts, and the selected role does not receive them.</Hint>
      </Section>
    );
  }
  return (
    <Section title="Remaining balances">
      <Hint>Read-only. These balances do not change the settlement lines; no encashment or recovery is worked out from them.</Hint>
      {b.finalPeriodPayroll !== undefined && <FinalPeriodPayroll runs={b.finalPeriodPayroll} />}
      <CardSubheading>Paid leave as at the last working date ({formatDate(b.asOf)})</CardSubheading>
      {b.leave.length === 0 ? (
        <Empty>No paid leave type is active.</Empty>
      ) : (
        <Table aria-label="Leave balances at the last working date">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Leave type</TableHead>
              <TableHead scope="col">Available (days)</TableHead>
              <TableHead scope="col">Pending (days)</TableHead>
              <TableHead scope="col">Taken (days)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {b.leave.map((l) => (
              <TableRow key={l.leaveType}>
                <TableCell>{l.leaveType}</TableCell>
                <TableCell>
                  <Days value={l.available} />
                </TableCell>
                <TableCell>
                  <Days value={l.pending} />
                </TableCell>
                <TableCell>
                  <Days value={l.taken} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <CardSubheading>Outstanding loans and advances</CardSubheading>
      <LoanBalances loans={b.loans} />
    </Section>
  );
}

/** The outstanding loans and advances; `undefined` while the loans module is not in use. */
function LoanBalances({ loans }: { loans: readonly OutstandingLoan[] | undefined }) {
  if (loans === undefined) return <Hint>Loans and advances are not in use, so no loan balance is shown.</Hint>;
  if (loans.length === 0) return <Empty>No outstanding loan or advance.</Empty>;
  return (
    <Table aria-label="Outstanding loans and advances">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Kind</TableHead>
          <TableHead scope="col">Disbursed</TableHead>
          <TableHead scope="col">Principal</TableHead>
          <TableHead scope="col">Recovered</TableHead>
          <TableHead scope="col">Outstanding</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {loans.map((l) => (
          <TableRow key={l.id}>
            <TableCell>{labelOf(LOAN_KIND_LABEL, l.loanKind)}</TableCell>
            <TableCell>{formatDate(l.disbursementDate)}</TableCell>
            <TableCell>
              <Money value={l.principal} currency={l.currencyCode} />
            </TableCell>
            <TableCell>
              <Money value={l.recovered} currency={l.currencyCode} />
            </TableCell>
            <TableCell>
              <Money value={l.outstanding} currency={l.currencyCode} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
        <Table aria-label="Decisions">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Step</TableHead>
              <TableHead scope="col">Decision</TableHead>
              <TableHead scope="col">Decided by</TableHead>
              <TableHead scope="col">Decided</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.decisions.map((d, i) => (
              <TableRow key={`${d.transactionId}-${d.step}-${i}`}>
                <TableCell>{labelOf(STEP_LABEL, d.action)}</TableCell>
                <TableCell>{labelOf(DECISION_LABEL, d.decision)}</TableCell>
                <TableCell>
                  {d.decidedBy ? deciderLabel(d.decidedBy, myUserId) : '—'}
                  {d.onBehalfOf && <Hint as="span">{` on behalf of ${deciderLabel(d.onBehalfOf, myUserId)}`}</Hint>}
                </TableCell>
                <TableCell>
                  <time dateTime={d.decidedAt}>{when(d.decidedAt)}</time>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

