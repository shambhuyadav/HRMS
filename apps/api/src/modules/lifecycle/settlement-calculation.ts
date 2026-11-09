// FR-052 full-and-final settlement calculation (decided under owner delegation, 6 Nov 2026; docs/03 I-88; migration 0235). The draft's
// preparer calculates it: the facts are read once into a versioned snapshot (settlement_calculation.inputs), the items are derived from
// that snapshot, and their values become the draft's CALCULATED lines, one per component. Lines entered for other components stay, each
// with its reason. A recalculation is a new snapshot; submission freezes the one the revision carries, and the existing independent
// review and approval decide it. A blocking item (a policy, rule pack or master fact the calculation needed and did not have) refuses
// the final approval (settlement-gates.ts).
//
// Items (every rate, divisor, cap and threshold comes from the settlement policy or the statutory pack, never from here):
//  EARNINGS_DUE         the final service month (its first day, or the joining date, to the approved last working date): each monthly
//                       FIXED salary component x paid days / calendar days of the month, rounded once (DF05, as the payroll core
//                       values it, payroll/calculate.ts); paid days = each arrangement segment's days less approved unpaid leave on
//                       working days and, under a reviewed-attendance paid-day policy, attendance loss of pay. A component a monthly run
//                       APPROVED or PROCESSED_LOCKED for the period already paid (or deducted) is ALREADY_PAID (I-81 item 5).
//  LEAVE_ENCASHMENT     each encashable paid leave type: the balance as at the last working date, up to the cap, x the policy's
//                       monthly rate basis / its divisor. Other paid types with a balance are NOT_APPLICABLE (not encashable).
//  NOTICE_RECOVERY      the recorded contractual notice less the days served (resignation date to last working date, both counted),
//                       x the notice rate basis / its divisor, recovered; WAIVED when an approver waived it (settlement_notice_waiver).
//  LOAN_RECOVERY        each disbursed loan's outstanding balance (payroll/common.ts loanOutstandingSql), recovered on its own recovery
//                       head; it counts as repaid once the settlement is PAID (I-81 item 1).
//  ARREARS, ADJUSTMENT  approved FR-035 arrears and FR-100 adjustments no payroll run holds and no other live or paid settlement took,
//                       on the valuation policy's components (I-79). Taken here, payroll never takes them (calculate.ts SETTLEMENT_TAKES).
//  GRATUITY             the GRATUITY statutory pack: eligibility after its minimum continuous service (except an exempt separation),
//                       wageDays / wageDivisor x Basic + DA last drawn x counted years, capped. While the pack is not ACTIVE an eligible
//                       employee's item is RULE_PACK_NOT_CONFIGURED (blocking); an ineligible one's is NOT_ELIGIBLE.
//  STATUTORY_DEDUCTION  each payroll RULE_PACK head (tax, PF, ESIC, PT) that applies to the components calculated or entered, or that
//                       the salary arrangement lists (as payroll applies it; such a component is never an EARNINGS_DUE item): valued
//                       by statutory/evaluate.ts where its pack is ACTIVE on the last working date (I-85; an employer contribution
//                       is NOT_APPLICABLE with its cost in the basis, never a line), otherwise RULE_PACK_NOT_CONFIGURED (blocking,
//                       BRD line 5120); with none, NOT_APPLICABLE (tax not calculated, as payroll pays without a head).
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, canAccessEmployee } from '../access/authorize.js';
import { loanOutstandingSql } from '../payroll/common.js';
import { APPROVED_LEAVE_ON, policySnapshot, valuationPolicyOn } from '../payroll/calculate.js';
import { isModuleActive } from '../registry.js';
import { workingDaySql } from '../shift/calendar.js';
import { settlementStatutoryItems } from '../statutory/evaluate.js';
import { ensureStatutoryPacks, gratuityParameters, packInEffect } from '../statutory/rule-packs.js';
import { actorOf, advisoryLock, audit, holds } from './common.js';
import {
  dayRateValue,
  daysBetween,
  fromUnits,
  gratuityAmount,
  gratuityEligibility,
  isZero,
  negate,
  noticeShortfall,
  prorate,
  sum,
  toUnits,
} from './settlement-formulas.js';
import { calculationView, HOLDING_STATES, RUN_HOLDING_STATES } from './settlement-gates.js';
import { ruleOf } from './separation-types.js';
import { policyInForce, type RateBasis } from './settlement-policy.js';
import { draftForChange, refreshNet, settlementDetail } from './settlement.js';

type ItemKind = 'EARNINGS_DUE' | 'LEAVE_ENCASHMENT' | 'NOTICE_RECOVERY' | 'LOAN_RECOVERY' | 'ARREARS' | 'ADJUSTMENT' | 'GRATUITY' | 'STATUTORY_DEDUCTION';
const NON_BLOCKING = ['CALCULATED', 'ALREADY_PAID', 'NOT_APPLICABLE', 'NOT_ELIGIBLE', 'WAIVED', 'NOT_INCLUDED'];

interface Item {
  kind: ItemKind;
  status: string;
  componentId: string | null;
  amount: string | null;
  basis: Record<string, unknown>;
  leaveTypeId?: string;
  loanId?: string;
  arrearsCaseId?: string;
  adjustmentId?: string;
  headRevisionId?: string;
}

interface Head {
  headRevisionId: string;
  inUse: boolean;
  headType: string | null;
  basis: string | null;
  rulePackCode: string | null;
}

interface ArrangementComponent {
  componentId: string;
  code: string;
  kind: 'EARNING' | 'DEDUCTION';
  amount: string;
  basis: 'MONTHLY' | 'ANNUAL';
}

interface Segment {
  arrangementId: string;
  currencyCode: string;
  start: string;
  end: string;
  calendarDays: number;
  lopUnits: string;
  paidDays: string;
  components: ArrangementComponent[];
}

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const monthEnd = (d: string) => {
  const [y, m] = d.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/**
 * The monthly rate a day-rate item (encashment, notice) or gratuity (BASIC_DA) uses, from the arrangement in force on the last working
 * date: Basic, Basic + DA (DA when the policy names one and the arrangement has it), or the monthly gross (every monthly component whose
 * head is a FIXED earning). A status instead when it cannot be read.
 */
function monthlyRate(
  basis: RateBasis,
  lastDrawn: { currencyCode: string; components: ArrangementComponent[] } | null,
  policy: { basic_component_id: string; da_component_id: string | null },
  heads: Map<string, Head>,
  currency: string,
): { monthly: string; parts: { componentCode: string; amount: string }[] } | { status: string; detail: Record<string, unknown> } {
  if (!lastDrawn) return { status: 'NO_SALARY_ARRANGEMENT', detail: { reason: 'No salary arrangement is in force on the last working date' } };
  if (lastDrawn.currencyCode !== currency) return { status: 'CURRENCY_MISMATCH', detail: { arrangementCurrency: lastDrawn.currencyCode, settlementCurrency: currency } };
  const ids =
    basis === 'GROSS'
      ? lastDrawn.components.filter((c) => {
          const h = heads.get(c.componentId);
          return c.kind === 'EARNING' && h?.inUse && h.basis === 'FIXED' && h.headType === 'EARNING';
        })
      : lastDrawn.components.filter((c) => c.componentId === policy.basic_component_id || (basis === 'BASIC_DA' && c.componentId === policy.da_component_id));
  if (basis !== 'GROSS' && !ids.some((c) => c.componentId === policy.basic_component_id)) {
    return { status: 'RATE_BASIS_MISSING', detail: { reason: 'The arrangement in force on the last working date has no Basic component', rateBasis: basis } };
  }
  if (ids.length === 0) return { status: 'RATE_BASIS_MISSING', detail: { reason: 'The arrangement in force on the last working date has no fixed earning', rateBasis: basis } };
  if (ids.some((c) => c.basis !== 'MONTHLY')) return { status: 'COMPONENT_BASIS_NOT_MONTHLY', detail: { rateBasis: basis } };
  return { monthly: sum(ids.map((c) => c.amount)), parts: ids.map((c) => ({ componentCode: c.code, amount: c.amount })) };
}

/** Calculates a draft (the preparer, under the preparation grant re-checked after the locks); returns the settlement detail. */
export async function calculateSettlement(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }) {
  const { s, exit } = await draftForChange(tx, grant, id, input.expectedVersion);
  if (exit.state !== 'APPROVED' && exit.state !== 'SEPARATED') throw new HttpError(409, 'EXIT_NOT_APPROVED', 'The exit is no longer approved');
  const companyId = grant.companyId;
  // Serialised with the payroll calculation's pickup of arrears and adjustments (payroll/calculate.ts step 7b), so a case is taken once.
  await advisoryLock(tx, `payroll_arrears_pickup:${companyId}`);
  await ensureStatutoryPacks(tx, companyId);

  const who = (
    await tx.query<{ joining_date: string; separation_type: string; request_date: string; last_working_date: string; contractual_notice_days: number | null; minor: number | null }>(
      `select to_char(e.joining_date, 'YYYY-MM-DD') as joining_date, x.separation_type, to_char(x.request_date, 'YYYY-MM-DD') as request_date,
              to_char(x.approved_leaving_date, 'YYYY-MM-DD') as last_working_date, x.contractual_notice_days,
              (select minor_unit from currency where code = $3) as minor
         from exit_case x join employee e on e.company_id = x.company_id and e.id = x.employee_id
        where x.company_id = $1 and x.id = $2`,
      [companyId, s.exit_case_id, s.currency_code],
    )
  ).rows[0]!;
  if (who.minor === null) throw new HttpError(409, 'CURRENCY_UNKNOWN', 'The settlement currency is not an approved currency code, so its rounding is unknown', { currencyCode: s.currency_code });
  const minor = Number(who.minor);
  const lwd = who.last_working_date;
  const periodStart = monthStart(lwd);
  const periodEnd = monthEnd(lwd);
  const daysInMonth = daysBetween(periodStart, periodEnd) + 1;
  const eligibleFrom = who.joining_date > periodStart ? who.joining_date : periodStart;
  const currency = s.currency_code;

  // --- Snapshot: everything below is read once and frozen in the calculation's inputs. ---
  const policy = await policyInForce(tx, companyId, lwd);
  const components = new Map(
    (await tx.query<{ id: string; code: string; kind: 'EARNING' | 'DEDUCTION' }>(`select id, code, component_kind as kind from pay_component where company_id = $1`, [companyId])).rows.map((c) => [c.id, c]),
  );
  const code = (componentId: string | null | undefined) => (componentId ? (components.get(componentId)?.code ?? null) : null);
  // The head of every component in effect on the period's last day, as the payroll calculation fixes them (startCalculation).
  const heads = new Map<string, Head>(
    (
      await tx.query<{ component_id: string } & Head>(
        `select distinct on (h.component_id) h.component_id, h.id as "headRevisionId", h.in_use as "inUse", h.head_type as "headType", h.calculation_basis as basis, h.rule_pack_code as "rulePackCode"
           from payroll_head_revision h where h.company_id = $1 and h.state = 'ACTIVE' and h.effective_from <= $2::date
          order by h.component_id, h.effective_from desc`,
        [companyId, periodEnd],
      )
    ).rows.map((h) => [h.component_id, h]),
  );
  const paidDayPolicy = await policySnapshot(tx, companyId, periodEnd);
  const employee = { company: '$1::uuid', id: '$2::uuid' };
  const r = `(select ${employee.company} as company_id, ${employee.id} as employee_id) r`;
  const lop = (
    await tx.query<{ day: string; source: string; units: string }>(
      `select to_char(g.d, 'YYYY-MM-DD') as day, 'UNPAID_LEAVE' as source, (case when lr.half_day then 0.5 else 1 end)::text as units
         from leave_request lr
         join leave_type lt on lt.company_id = lr.company_id and lt.id = lr.leave_type_id and not lt.paid
         cross join lateral generate_series(greatest(lr.start_date, $3::date), least(lr.end_date, $4::date), interval '1 day') g (d)
         cross join ${r}
        where lr.company_id = $1 and lr.employee_id = $2 and lr.state = 'APPROVED' and lr.start_date <= $4::date and lr.end_date >= $3::date
          and ${workingDaySql('g.d', 'r.employee_id', 'r.company_id')}
       union all
       select to_char(ar.work_date, 'YYYY-MM-DD'), 'ATTENDANCE', u.units::text
         from attendance_record ar
         join reference_value st on st.company_id = ar.company_id and st.id = ar.status_id and st.code in ('ABSENT', 'HALF_DAY')
         cross join lateral (select case st.code when 'ABSENT' then $6::numeric else $7::numeric end as units) u
         cross join ${r}
        where $5 and ar.company_id = $1 and ar.employee_id = $2 and ar.work_date between $3::date and $4::date and u.units > 0
          and not ${APPROVED_LEAVE_ON('ar.work_date')}
        order by 1, 2`,
      [companyId, s.employee_id, eligibleFrom, lwd, paidDayPolicy.basis === 'REVIEWED_ATTENDANCE', paidDayPolicy.absent ?? '0', paidDayPolicy.half ?? '0'],
    )
  ).rows;
  // BR-049: days the payroll core would send for a documented resolution are paid here, and named in the snapshot for the reviewer.
  const attendance = (
    await tx.query<{ unevaluated: number; unresolved: number }>(
      `select (select count(*)::int from generate_series($3::date, $4::date, interval '1 day') g (d) cross join ${r}
                where $5 = 'REVIEWED_ATTENDANCE'
                  and not exists (select 1 from attendance_record ar where ar.company_id = $1 and ar.employee_id = $2 and ar.work_date = g.d::date)
                  and not ${APPROVED_LEAVE_ON('g.d::date')}) as unevaluated,
              (select count(*)::int from attendance_record ar
                 join reference_value st on st.company_id = ar.company_id and st.id = ar.status_id
                 cross join ${r}
                where ar.company_id = $1 and ar.employee_id = $2 and ar.work_date between $3::date and $4::date
                  and st.code = any(case when $5 = 'REVIEWED_ATTENDANCE' then array['EXCEPTION'] when $5 = 'NOT_CONFIGURED' then array['ABSENT', 'HALF_DAY', 'EXCEPTION'] else array[]::text[] end)
                  and not ${APPROVED_LEAVE_ON('ar.work_date')}) as unresolved`,
      [companyId, s.employee_id, eligibleFrom, lwd, paidDayPolicy.basis],
    )
  ).rows[0]!;

  const arrangementRows = (
    await tx.query<{ id: string; currency_code: string; seg_start: string; seg_end: string; effective_from: string; effective_to: string | null }>(
      `select sa.id, sa.currency_code, to_char(greatest(sa.effective_from, $3::date), 'YYYY-MM-DD') as seg_start,
              to_char(least(coalesce(sa.effective_to - 1, $4::date), $4::date), 'YYYY-MM-DD') as seg_end,
              to_char(sa.effective_from, 'YYYY-MM-DD') as effective_from, to_char(sa.effective_to, 'YYYY-MM-DD') as effective_to
         from salary_arrangement sa
        where sa.company_id = $1 and sa.employee_id = $2 and sa.superseded_at is null
          and sa.effective_from <= $4::date and (sa.effective_to is null or sa.effective_to > $3::date)
        order by sa.effective_from`,
      [companyId, s.employee_id, eligibleFrom, lwd],
    )
  ).rows;
  const arrangementComponents = new Map<string, ArrangementComponent[]>();
  for (const c of (
    await tx.query<{ salary_arrangement_id: string; component_id: string; amount: string; basis: 'MONTHLY' | 'ANNUAL' }>(
      `select salary_arrangement_id, component_id, amount::text as amount, basis from salary_component where company_id = $1 and salary_arrangement_id = any($2::uuid[]) order by component_id`,
      [companyId, arrangementRows.map((a) => a.id)],
    )
  ).rows) {
    const list = arrangementComponents.get(c.salary_arrangement_id) ?? [];
    const pc = components.get(c.component_id)!;
    list.push({ componentId: c.component_id, code: pc.code, kind: pc.kind, amount: c.amount, basis: c.basis });
    arrangementComponents.set(c.salary_arrangement_id, list);
  }
  const segments: Segment[] = arrangementRows.map((a) => {
    const lopUnits = sum(lop.filter((l) => l.day >= a.seg_start && l.day <= a.seg_end).map((l) => l.units));
    const calendarDays = daysBetween(a.seg_start, a.seg_end) + 1;
    return {
      arrangementId: a.id,
      currencyCode: a.currency_code,
      start: a.seg_start,
      end: a.seg_end,
      calendarDays,
      lopUnits,
      paidDays: sum([String(calendarDays), negate(lopUnits)]),
      components: arrangementComponents.get(a.id) ?? [],
    };
  });
  const last = arrangementRows.find((a) => a.effective_from <= lwd && (a.effective_to === null || a.effective_to > lwd));
  const lastDrawn = last ? { arrangementId: last.id, currencyCode: last.currency_code, components: arrangementComponents.get(last.id) ?? [] } : null;

  // FR-052 (I-81 item 5): what the final period's approved or processed monthly payroll already paid or deducted.
  const alreadyPaid = new Map(
    (
      await tx.query<{ component_id: string; run_id: string; period_code: string; run_state: string }>(
        `select distinct on (pl.component_id) pl.component_id, ru.id as run_id, p.period_code, ru.state as run_state
           from payroll_record pr
           join payroll_run ru on ru.company_id = pr.company_id and ru.id = pr.run_id and ru.state in ('APPROVED', 'PROCESSED_LOCKED')
           join payroll_period p on p.company_id = ru.company_id and p.id = ru.period_id
           join payroll_line pl on pl.company_id = pr.company_id and pl.record_id = pr.id and pl.amount > 0
          where pr.company_id = $1 and pr.employee_id = $2 and pr.calculation_status = 'CALCULATED' and pr.eligible_from <= $3::date and pr.eligible_to >= $3::date
          order by pl.component_id, ru.state desc, ru.revision desc`,
        [companyId, s.employee_id, lwd],
      )
    ).rows.map((x) => [x.component_id, x]),
  );

  const leave = (
    await tx.query<{ id: string; code: string; available: string; pending: string }>(
      `select t.id, t.code, coalesce(sum(m.units), 0)::numeric(12, 4)::text as available,
              coalesce(-sum(m.units) filter (where m.movement_kind in ('RESERVATION', 'RESERVATION_RELEASE')), 0)::numeric(12, 4)::text as pending
         from leave_type t
         left join leave_movement m on m.company_id = t.company_id and m.leave_type_id = t.id and m.employee_id = $2 and m.effective_date <= $3::date
        where t.company_id = $1 and t.active and t.paid
        group by t.id, t.code order by t.code`,
      [companyId, s.employee_id, lwd],
    )
  ).rows;
  const waiver = (
    await tx.query<{ id: string; reason: string; waived_by: string }>(`select id, reason, waived_by from settlement_notice_waiver where company_id = $1 and exit_case_id = $2`, [companyId, s.exit_case_id])
  ).rows[0];
  const loans = isModuleActive('payroll-outputs')
    ? (
        await tx.query<{ id: string; loan_kind: string; currency_code: string; outstanding: string; recovery_component_id: string | null; pending: boolean }>(
          `select l.id, l.loan_kind, l.currency_code, ${loanOutstandingSql('l')}::text as outstanding, l.recovery_component_id,
                  exists (select 1 from payroll_loan_settlement x where x.company_id = l.company_id and x.loan_id = l.id and x.state = 'PROPOSED') as pending
             from payroll_loan l where l.company_id = $1 and l.employee_id = $2 and l.state = 'DISBURSED' order by l.disbursement_date, l.id`,
          [companyId, s.employee_id],
        )
      ).rows
    : null;
  const valuation = await valuationPolicyOn(tx, companyId, lwd);
  // A case is free when no payroll run holds it and no other live or paid settlement's calculation took it.
  const free = (alias: string, column: 'arrears_case_id' | 'adjustment_id') => `
        not exists (select 1 from payroll_record_input x
                      join payroll_record xr on xr.company_id = x.company_id and xr.id = x.record_id
                      join payroll_run xu on xu.company_id = xr.company_id and xu.id = xr.run_id and xu.state = any($4::text[])
                     where x.company_id = ${alias}.company_id and x.${column} = ${alias}.id)
    and not exists (select 1 from settlement_calculation_item si
                      join settlement fs on fs.company_id = si.company_id and fs.calculation_id = si.calculation_id and fs.state = any($5::text[])
                     where si.company_id = ${alias}.company_id and si.${column} = ${alias}.id and si.status = 'CALCULATED' and fs.id <> $3)`;
  const caseParams = [companyId, s.employee_id, s.id, [...RUN_HOLDING_STATES], [...HOLDING_STATES]];
  const arrears = (
    await tx.query<{ id: string; currency_code: string; total: string; period_code: string }>(
      `select c.id, c.currency_code, t.total::text as total, op.period_code
         from payroll_arrears_case c
         join payroll_period op on op.company_id = c.company_id and op.id = c.origin_period_id
         cross join lateral (select sum(l.amount) as total from payroll_arrears_line l where l.company_id = c.company_id and l.case_id = c.id) t
        where c.company_id = $1 and c.employee_id = $2 and c.state = 'APPROVED' and t.total <> 0 and ${free('c', 'arrears_case_id')}
        order by op.service_start, c.id`,
      caseParams,
    )
  ).rows;
  const adjustments = (
    await tx.query<{ id: string; currency_code: string; delta: string; period_code: string }>(
      `select a.id, a.currency_code, a.delta_amount::text as delta, op.period_code
         from payroll_adjustment a
         join payroll_run orun on orun.company_id = a.company_id and orun.id = a.origin_run_id
         join payroll_period op on op.company_id = orun.company_id and op.id = orun.period_id
        where a.company_id = $1 and a.employee_id = $2 and a.state = 'APPROVED' and a.delta_amount <> 0 and ${free('a', 'adjustment_id')}
        order by op.service_start, a.id`,
      caseParams,
    )
  ).rows;
  const held = (
    await tx.query<{ id: string; kind: string; run_id: string; run_state: string }>(
      `select coalesce(x.arrears_case_id, x.adjustment_id) as id, case when x.arrears_case_id is not null then 'ARREARS' else 'ADJUSTMENT' end as kind, xu.id as run_id, xu.state as run_state
         from payroll_record_input x
         join payroll_record xr on xr.company_id = x.company_id and xr.id = x.record_id
         join payroll_run xu on xu.company_id = xr.company_id and xu.id = xr.run_id and xu.state in ('DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED')
        where x.company_id = $1 and x.employee_id = $2 and (x.arrears_case_id is not null or x.adjustment_id is not null)
        order by 1`,
      [companyId, s.employee_id],
    )
  ).rows;
  const payrollInputs = (
    await tx.query<{ id: string; component_code: string; period_code: string }>(
      `select i.id, pc.code as component_code, p.period_code
         from payroll_input i
         join payroll_period p on p.company_id = i.company_id and p.id = i.period_id and p.service_start <= $3::date and p.service_end >= $3::date
         join pay_component pc on pc.company_id = i.company_id and pc.id = i.component_id
        where i.company_id = $1 and i.employee_id = $2 and i.state = 'APPROVED' and i.consumed_record_id is null order by p.period_code, pc.code, i.id`,
      [companyId, s.employee_id, lwd],
    )
  ).rows;
  const gratuityPack = await packInEffect(tx, companyId, 'GRATUITY', lwd);

  // --- Items, from the snapshot alone. ---
  const items: Item[] = [];
  const block = (kind: ItemKind, status: string, basis: Record<string, unknown>, extra: Partial<Item> = {}) => items.push({ kind, status, componentId: null, amount: null, basis, ...extra });
  const signed = (componentId: string, magnitude: string) => (components.get(componentId)!.kind === 'DEDUCTION' && !isZero(magnitude) ? negate(magnitude) : magnitude);
  const arrangedRulePack = new Set<string>();

  // EARNINGS_DUE
  const eligibleDays = daysBetween(eligibleFrom, lwd) + 1;
  const coveredDays = segments.reduce((a, g) => a + g.calendarDays, 0);
  const segmentBasis = segments.map((g) => ({ arrangementId: g.arrangementId, start: g.start, end: g.end, calendarDays: g.calendarDays, lossOfPayUnits: g.lopUnits, paidDays: g.paidDays }));
  if (segments.length === 0 || segments.every((g) => g.components.length === 0)) {
    block('EARNINGS_DUE', 'NO_SALARY_ARRANGEMENT', { eligibleFrom, lastWorkingDate: lwd });
  } else if (coveredDays < eligibleDays) {
    block('EARNINGS_DUE', 'ARRANGEMENT_GAP', { eligibleFrom, lastWorkingDate: lwd, coveredDays, eligibleDays });
  } else if (segments.some((g) => g.currencyCode !== currency)) {
    block('EARNINGS_DUE', 'CURRENCY_MISMATCH', { settlementCurrency: currency, arrangementCurrencies: [...new Set(segments.map((g) => g.currencyCode))] });
  } else {
    const byComponent = new Map<string, { segment: Segment; component: ArrangementComponent }[]>();
    for (const g of segments) for (const c of g.components) byComponent.set(c.componentId, [...(byComponent.get(c.componentId) ?? []), { segment: g, component: c }]);
    for (const [componentId, parts] of [...byComponent.entries()].sort((a, b) => code(a[0])!.localeCompare(code(b[0])!))) {
      const h = heads.get(componentId);
      const basis = {
        daysInMonth,
        segments: parts.map((p) => ({ arrangementId: p.segment.arrangementId, start: p.segment.start, end: p.segment.end, monthlyAmount: p.component.amount, paidDays: p.segment.paidDays })),
      };
      const extra = h ? { headRevisionId: h.headRevisionId } : {};
      // A rule-pack head the arrangement lists is valued by its pack (STATUTORY_DEDUCTION below), as payroll applies it; its
      // arrangement amount is not a value (P8a gap 3).
      if (h?.inUse && h.basis === 'RULE_PACK') {
        arrangedRulePack.add(componentId);
        continue;
      }
      if (h?.inUse && h.headType === 'EMPLOYER_CONTRIBUTION') continue; // a cost of the employer, never paid to the employee
      if (!h || !h.inUse) block('EARNINGS_DUE', 'HEAD_NOT_CONFIGURED', basis, { componentId, ...extra });
      else if (h.basis !== 'FIXED') block('EARNINGS_DUE', 'COMPONENT_HEAD_NOT_FIXED', basis, { componentId, ...extra });
      else if (parts.some((p) => p.component.basis !== 'MONTHLY')) block('EARNINGS_DUE', 'COMPONENT_BASIS_NOT_MONTHLY', basis, { componentId, ...extra });
      else if (alreadyPaid.has(componentId)) {
        const paid = alreadyPaid.get(componentId)!;
        items.push({ kind: 'EARNINGS_DUE', status: 'ALREADY_PAID', componentId, amount: null, basis: { ...basis, runId: paid.run_id, periodCode: paid.period_code, runState: paid.run_state }, ...extra });
      } else {
        const value = prorate(parts.map((p) => ({ monthlyAmount: p.component.amount, paidDays: p.segment.paidDays })), daysInMonth, minor);
        items.push({ kind: 'EARNINGS_DUE', status: 'CALCULATED', componentId, amount: signed(componentId, value), basis, ...extra });
      }
    }
  }
  if (payrollInputs.length > 0) {
    // Approved payroll inputs of the final period are not valued here; named so the preparer enters them (or payroll pays them).
    block('EARNINGS_DUE', 'NOT_INCLUDED', { reason: 'Approved payroll inputs of the final period are not calculated by the settlement', inputs: payrollInputs.map((i) => ({ inputId: i.id, componentCode: i.component_code, periodCode: i.period_code })) });
  }

  // LEAVE_ENCASHMENT
  const encashable = new Map((policy?.encashable ?? []).map((e) => [e.leaveTypeId, e.maxUnits]));
  for (const t of leave) {
    const available = toUnits(t.available);
    const pending = toUnits(t.pending);
    if (available <= 0n && pending === 0n) continue;
    const basisOf = { leaveType: t.code, asOf: lwd, available: t.available, pending: t.pending };
    if (!policy) {
      block('LEAVE_ENCASHMENT', 'POLICY_NOT_CONFIGURED', { ...basisOf, reason: 'No settlement policy is in force on the last working date to say whether this leave is encashable' }, { leaveTypeId: t.id });
      continue;
    }
    if (!encashable.has(t.id)) {
      block('LEAVE_ENCASHMENT', 'NOT_APPLICABLE', { ...basisOf, encashable: false }, { leaveTypeId: t.id });
      continue;
    }
    if (pending !== 0n) {
      block('LEAVE_ENCASHMENT', 'LEAVE_DECISIONS_PENDING', { ...basisOf, reason: 'Leave requests on or before the last working date wait for a decision' }, { leaveTypeId: t.id });
      continue;
    }
    if (available <= 0n) continue;
    const cap = encashable.get(t.id)!;
    const units = toUnits(t.available) < toUnits(cap) ? t.available : sum([cap]);
    const rate = monthlyRate(policy.encashment_rate_basis, lastDrawn, policy, heads, currency);
    if ('status' in rate) {
      block('LEAVE_ENCASHMENT', rate.status, { ...basisOf, cap, units, ...rate.detail }, { leaveTypeId: t.id });
      continue;
    }
    const value = dayRateValue(rate.monthly, units, policy.encashment_divisor, minor);
    items.push({
      kind: 'LEAVE_ENCASHMENT',
      status: 'CALCULATED',
      componentId: policy.encashment_component_id,
      amount: value,
      basis: { ...basisOf, cap, units, rateBasis: policy.encashment_rate_basis, monthlyRate: rate.monthly, rateComponents: rate.parts, divisor: policy.encashment_divisor },
      leaveTypeId: t.id,
    });
  }

  // NOTICE_RECOVERY. I-89 item 7: only a resignation recovers notice from the employee. A termination's notice is the employer's (per
  // contract): the shortfall is shown and any pay in lieu is an entered line with its reason. Retirement, death, disablement and the
  // end of a contract carry no notice.
  const noticeRule = ruleOf(who.separation_type).notice;
  if (noticeRule === 'NONE') {
    block('NOTICE_RECOVERY', 'NOT_APPLICABLE', { separationType: who.separation_type, reason: 'NO_NOTICE_FOR_SEPARATION_TYPE', lastWorkingDate: lwd });
  } else if (who.contractual_notice_days === null) {
    block('NOTICE_RECOVERY', 'NOTICE_PERIOD_NOT_RECORDED', { requestDate: who.request_date, lastWorkingDate: lwd, reason: 'Record the contractual notice period (it may be 0) before calculating' });
  } else {
    const notice = noticeShortfall(who.request_date, lwd, who.contractual_notice_days);
    const basisOf = { requestDate: who.request_date, lastWorkingDate: lwd, requiredDays: notice.required, servedDays: notice.served, shortfallDays: notice.shortfall };
    if (noticeRule === 'EMPLOYER') block('NOTICE_RECOVERY', 'NOT_APPLICABLE', { ...basisOf, separationType: who.separation_type, reason: 'EMPLOYER_NOTICE_NOT_RECOVERED' });
    else if (notice.shortfall === 0) block('NOTICE_RECOVERY', 'NOT_APPLICABLE', basisOf);
    else if (waiver) block('NOTICE_RECOVERY', 'WAIVED', { ...basisOf, waiverId: waiver.id, waivedBy: waiver.waived_by });
    else if (!policy || !policy.notice_component_id) block('NOTICE_RECOVERY', 'POLICY_NOT_CONFIGURED', { ...basisOf, reason: 'No settlement policy in force names the notice recovery component' });
    else {
      const rate = monthlyRate(policy.notice_rate_basis, lastDrawn, policy, heads, currency);
      if ('status' in rate) block('NOTICE_RECOVERY', rate.status, { ...basisOf, ...rate.detail });
      else {
        const value = dayRateValue(rate.monthly, String(notice.shortfall), policy.notice_divisor, minor);
        items.push({
          kind: 'NOTICE_RECOVERY',
          status: 'CALCULATED',
          componentId: policy.notice_component_id,
          amount: negate(value),
          basis: { ...basisOf, rateBasis: policy.notice_rate_basis, monthlyRate: rate.monthly, rateComponents: rate.parts, divisor: policy.notice_divisor },
        });
      }
    }
  }

  // LOAN_RECOVERY (I-81 item 1)
  for (const l of loans ?? []) {
    const basisOf = { loanKind: l.loan_kind, currencyCode: l.currency_code, outstanding: l.outstanding };
    if (l.currency_code !== currency) block('LOAN_RECOVERY', 'CURRENCY_MISMATCH', { ...basisOf, settlementCurrency: currency }, { loanId: l.id });
    else if (l.pending) block('LOAN_RECOVERY', 'LOAN_SETTLEMENT_PENDING', { ...basisOf, reason: 'An early settlement of this loan waits for its decision' }, { loanId: l.id });
    else if (isZero(l.outstanding)) block('LOAN_RECOVERY', 'NOT_APPLICABLE', basisOf, { loanId: l.id });
    else if (!l.recovery_component_id) block('LOAN_RECOVERY', 'HEAD_NOT_CONFIGURED', { ...basisOf, reason: 'The loan names no recovery head' }, { loanId: l.id });
    else items.push({ kind: 'LOAN_RECOVERY', status: 'CALCULATED', componentId: l.recovery_component_id, amount: negate(sum([l.outstanding])), basis: basisOf, loanId: l.id });
  }

  // ARREARS and ADJUSTMENT (I-79)
  const caseItem = (kind: 'ARREARS' | 'ADJUSTMENT', caseId: string, caseCurrency: string, total: string, periodCode: string) => {
    const ref = kind === 'ARREARS' ? { arrearsCaseId: caseId } : { adjustmentId: caseId };
    const basisOf = { originPeriodCode: periodCode, total: sum([total]), currencyCode: caseCurrency };
    if (caseCurrency !== currency) return block(kind, 'CURRENCY_MISMATCH', { ...basisOf, settlementCurrency: currency }, ref);
    if (!valuation) return block(kind, 'VALUATION_POLICY_NOT_CONFIGURED', basisOf, ref);
    const positive = toUnits(total) > 0n;
    const componentId = positive ? (kind === 'ARREARS' ? valuation.arrears_component_id : valuation.adjustment_component_id) : valuation.recovery_component_id;
    if (!componentId) return block(kind, 'RECOVERY_POLICY_NOT_CONFIGURED', basisOf, ref);
    items.push({ kind, status: 'CALCULATED', componentId, amount: sum([total]), basis: { ...basisOf, valuationPolicyId: valuation.id }, ...ref });
  };
  for (const a of arrears) caseItem('ARREARS', a.id, a.currency_code, a.total, a.period_code);
  for (const a of adjustments) caseItem('ADJUSTMENT', a.id, a.currency_code, a.delta, a.period_code);

  // GRATUITY
  if (!gratuityPack) {
    block('GRATUITY', 'RULE_PACK_NOT_CONFIGURED', { rulePackCode: 'GRATUITY', reason: 'No gratuity rule pack covers the last working date, so eligibility cannot be decided' });
  } else {
    const p = gratuityParameters(gratuityPack.pack);
    const e = gratuityEligibility(p, who.joining_date, lwd, who.separation_type);
    const basisOf = {
      rulePackCode: 'GRATUITY',
      packId: gratuityPack.pack.id,
      packRevision: gratuityPack.pack.revision,
      packState: gratuityPack.pack.state,
      joiningDate: who.joining_date,
      lastWorkingDate: lwd,
      separationType: who.separation_type,
      completedYears: e.completedYears,
      partYearCounts: e.partYearCounts,
      countedYears: e.countedYears,
      minimumServiceYears: p.minimumServiceYears,
      exemptSeparation: e.exempt,
    };
    if (!e.eligible) block('GRATUITY', 'NOT_ELIGIBLE', basisOf);
    else if (!gratuityPack.active) block('GRATUITY', 'RULE_PACK_NOT_CONFIGURED', { ...basisOf, reason: 'The employee is eligible and the gratuity rule pack is not active' });
    else if (gratuityPack.pack.currencyCode !== currency) block('GRATUITY', 'CURRENCY_MISMATCH', { ...basisOf, packCurrency: gratuityPack.pack.currencyCode, settlementCurrency: currency });
    else if (!policy || !policy.gratuity_component_id) block('GRATUITY', 'POLICY_NOT_CONFIGURED', { ...basisOf, reason: 'No settlement policy in force names the gratuity component' });
    else {
      const wages = monthlyRate('BASIC_DA', lastDrawn, policy, heads, currency);
      if ('status' in wages) block('GRATUITY', wages.status, { ...basisOf, ...wages.detail });
      else {
        const g = gratuityAmount(p, wages.monthly, e.countedYears, minor);
        items.push({
          kind: 'GRATUITY',
          status: 'CALCULATED',
          componentId: policy.gratuity_component_id,
          amount: g.amount,
          basis: { ...basisOf, monthlyWages: wages.monthly, wageComponents: wages.parts, wageDays: p.wageDays, wageDivisor: p.wageDivisor, uncapped: g.uncapped, ceilingAmount: p.ceilingAmount, capped: g.capped },
        });
      }
    }
  }

  // STATUTORY_DEDUCTION: the RULE_PACK heads that apply to what this settlement pays (its calculated items and entered lines), valued
  // by the statutory evaluator from the pack ACTIVE on the last working date (I-85), RULE_PACK_NOT_CONFIGURED where there is none. The
  // heads the arrangement lists apply too (present), as in payroll.
  const entered = (
    await tx.query<{ componentId: string; amount: string }>(`select component_id as "componentId", amount::text as amount from settlement_line where company_id = $1 and settlement_id = $2 and source <> 'CALCULATED'`, [companyId, s.id])
  ).rows;
  const valuedAmounts = items.filter((i) => i.status === 'CALCULATED' && i.componentId && i.amount).map((i) => ({ componentId: i.componentId!, amount: i.amount! }));
  items.push(
    ...(await settlementStatutoryItems(tx, { companyId, employeeId: s.employee_id, headsDay: periodEnd, factsDay: lwd, currency, amounts: [...valuedAmounts, ...entered], present: [...arrangedRulePack] })),
  );

  // --- Lines: one per component, from the calculated values. ---
  const lineAmounts = new Map<string, { amount: bigint; notice: boolean }>();
  for (const i of items) {
    if (i.status !== 'CALCULATED' || !i.componentId || !i.amount) continue;
    const prior = lineAmounts.get(i.componentId) ?? { amount: 0n, notice: false };
    lineAmounts.set(i.componentId, { amount: prior.amount + toUnits(i.amount), notice: prior.notice || i.kind === 'NOTICE_RECOVERY' });
  }
  const manual = (
    await tx.query<{ component_id: string }>(`select component_id from settlement_line where company_id = $1 and settlement_id = $2 and source <> 'CALCULATED'`, [companyId, s.id])
  ).rows.filter((l) => lineAmounts.has(l.component_id));
  if (manual.length > 0) {
    throw new HttpError(409, 'MANUAL_LINE_CONFLICT', 'An entered line uses a component the calculation produces; remove it and calculate again', { components: manual.map((l) => code(l.component_id)).sort() });
  }

  const blocking = items.filter((i) => !NON_BLOCKING.includes(i.status)).length;
  const sequence =
    (await tx.query<{ n: number }>(`select coalesce(max(sequence), 0)::int + 1 as n from settlement_calculation where company_id = $1 and settlement_id = $2`, [companyId, s.id])).rows[0]!.n;
  const snapshot = {
    employee: { joiningDate: who.joining_date, separationType: who.separation_type },
    exit: { requestDate: who.request_date, lastWorkingDate: lwd, contractualNoticeDays: who.contractual_notice_days },
    period: { start: periodStart, end: periodEnd, daysInMonth, eligibleFrom },
    currency: { code: currency, minorUnit: minor },
    policy: policy ? { id: policy.id, revision: policy.revision, effectiveFrom: policy.effective_from } : null,
    paidDayPolicy: paidDayPolicy,
    arrangements: segments.map((g) => ({ ...segmentBasis.find((b) => b.arrangementId === g.arrangementId), currencyCode: g.currencyCode, components: g.components.map((c) => ({ componentCode: c.code, amount: c.amount, basis: c.basis })) })),
    lastDrawnArrangementId: lastDrawn?.arrangementId ?? null,
    lossOfPay: lop,
    attendance: { basis: paidDayPolicy.basis, unevaluatedDaysPaid: attendance.unevaluated, unresolvedDaysPaid: attendance.unresolved },
    alreadyPaid: [...alreadyPaid.values()].map((x) => ({ componentCode: code(x.component_id), runId: x.run_id, periodCode: x.period_code, runState: x.run_state })),
    leave,
    noticeWaiver: waiver ? { id: waiver.id } : null,
    loans: loans ?? 'MODULE_INACTIVE',
    valuationPolicyId: valuation?.id ?? null,
    arrears: arrears.map((a) => ({ id: a.id, total: a.total, currencyCode: a.currency_code, periodCode: a.period_code })),
    adjustments: adjustments.map((a) => ({ id: a.id, delta: a.delta, currencyCode: a.currency_code, periodCode: a.period_code })),
    heldByPayroll: held,
    gratuityPack: gratuityPack ? { id: gratuityPack.pack.id, revision: gratuityPack.pack.revision, state: gratuityPack.pack.state } : null,
  };
  const calculationId = (
    await tx.query<{ id: string }>(
      `insert into settlement_calculation (company_id, settlement_id, employee_id, sequence, calculated_by, calculated_assignment_id, last_working_date, period_start, period_end,
                                           currency_code, currency_minor_unit, policy_id, gratuity_pack_id, valuation_policy_id, paid_day_policy_id, inputs, item_count, blocking_count, created_by)
       values ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9::date, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $5) returning id`,
      [
        companyId,
        s.id,
        s.employee_id,
        sequence,
        grant.userId,
        grant.assignmentId,
        lwd,
        periodStart,
        periodEnd,
        currency,
        minor,
        policy?.id ?? null,
        gratuityPack?.pack.id ?? null,
        valuation?.id ?? null,
        paidDayPolicy.id,
        JSON.stringify(snapshot),
        items.length,
        blocking,
      ],
    )
  ).rows[0]!.id;
  for (const [i, item] of items.entries()) {
    await tx.query(
      `insert into settlement_calculation_item (company_id, calculation_id, employee_id, position, item_kind, status, blocking, component_id, amount, basis, leave_type_id, loan_id,
                                                arrears_case_id, adjustment_id, head_revision_id, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10::jsonb, $11, $12, $13, $14, $15, $16)`,
      [
        companyId,
        calculationId,
        s.employee_id,
        i + 1,
        item.kind,
        item.status,
        !NON_BLOCKING.includes(item.status),
        item.componentId,
        item.amount,
        JSON.stringify(item.basis),
        item.leaveTypeId ?? null,
        item.loanId ?? null,
        item.arrearsCaseId ?? null,
        item.adjustmentId ?? null,
        item.headRevisionId ?? null,
        grant.userId,
      ],
    );
  }
  // The draft carries the new snapshot: its earlier calculated lines go, the new ones are written; entered lines stay.
  await tx.query(`delete from settlement_line where company_id = $1 and settlement_id = $2 and source = 'CALCULATED'`, [companyId, s.id]);
  await tx.query(`update settlement set calculation_id = $3, calculation_status = 'CALCULATED', updated_by = $4 where company_id = $1 and id = $2`, [companyId, s.id, calculationId, grant.userId]);
  for (const [componentId, line] of lineAmounts) {
    if (line.amount === 0n) continue;
    await tx.query(
      `insert into settlement_line (company_id, settlement_id, component_id, amount, line_kind, source, calculation_id, created_by, updated_by)
       values ($1, $2, $3, $4::numeric, $5, 'CALCULATED', $6, $7, $7)`,
      [companyId, s.id, componentId, fromUnits(line.amount), line.notice ? 'NOTICE_ADJUSTMENT' : 'STANDARD', calculationId, grant.userId],
    );
  }
  await refreshNet(tx, grant, s.id);
  await audit(tx, actorOf(grant), 'settlement', s.id, 'CALCULATE', null, {
    operational: { revision: s.revision, calculationId, sequence, items: items.length, blocking, calculatedLines: [...lineAmounts.values()].filter((l) => l.amount !== 0n).length },
  });
  return settlementDetail(tx, grant, s.id);
}

/** Every snapshot of a revision, newest first, with its items (the settlement amount group). */
export async function settlementCalculations(db: Queryable, grant: AccessGrant, settlementId: string) {
  await settlementDetail(db, grant, settlementId); // row scope, never one's own
  if (!holds(grant, 'amount')) return { items: [] };
  const ids = (await db.query<{ id: string }>(`select id from settlement_calculation where company_id = $1 and settlement_id = $2 order by sequence desc`, [grant.companyId, settlementId])).rows;
  const items = [];
  for (const k of ids) items.push(await calculationView(db, grant.companyId, k.id));
  return { items };
}

/**
 * F1 notice (I-88): an exit's notice recovery is waived, with a reason, by someone holding the waiver right (an HR Administrator ceiling
 * that is nobody's default duty), who is neither the employee nor the preparer of the exit's live settlement revision. Once per exit;
 * a calculation from then on shows the notice item WAIVED. A revision already submitted keeps its frozen calculation (return it and
 * calculate the corrected revision).
 */
export async function waiveNoticeRecovery(tx: Queryable, grant: AccessGrant, exitCaseId: string, input: { reason: string }) {
  const x = (
    await tx.query<{ id: string; employee_id: string; state: string; separation_type: string }>(`select id, employee_id, state, separation_type from exit_case where company_id = $1 and id = $2`, [
      grant.companyId,
      exitCaseId,
    ])
  ).rows[0];
  if (!x || !(await canAccessEmployee(tx, grant, x.employee_id))) throw notFound();
  if (grant.linkedEmployeeId === x.employee_id) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot act on your own record in this context');
  await advisoryLock(tx, `settlement:${grant.companyId}:${exitCaseId}`);
  await reassertAccess(tx, grant, 'settlement', 'waive_notice', ['amount']);
  if (x.state !== 'APPROVED' && x.state !== 'SEPARATED') throw new HttpError(409, 'EXIT_NOT_APPROVED', 'A notice recovery is waived for an approved exit');
  // I-89 item 7: only a resignation's notice is recovered, so only it can be waived.
  if (ruleOf(x.separation_type).notice !== 'RECOVERED') throw new HttpError(409, 'NOTICE_NOT_RECOVERED', 'Nothing is recovered for notice on this type of separation');
  const reason = input.reason.trim();
  if (reason === '' || reason.length > 1000) throw new HttpError(422, 'REASON_REQUIRED', 'Record why the notice recovery is waived (at most 1,000 characters)');
  const revisions = (await tx.query<{ prepared_by: string; state: string }>(`select prepared_by, state from settlement where company_id = $1 and exit_case_id = $2`, [grant.companyId, exitCaseId])).rows;
  if (revisions.some((r) => r.state === 'PAID')) throw new HttpError(409, 'SETTLEMENT_PAID', 'This exit’s settlement has been paid; nothing more is waived for it');
  if (revisions.some((r) => !['RETURNED', 'REJECTED', 'CANCELLED'].includes(r.state) && r.prepared_by === grant.userId)) {
    throw new HttpError(409, 'NOT_INDEPENDENT', 'The notice recovery is waived by someone other than the settlement’s preparer');
  }
  const existing = await tx.query(`select 1 from settlement_notice_waiver where company_id = $1 and exit_case_id = $2`, [grant.companyId, exitCaseId]);
  if (existing.rowCount) throw new HttpError(409, 'ALREADY_WAIVED', 'The notice recovery of this exit is already waived');
  const id = (
    await tx.query<{ id: string }>(
      `insert into settlement_notice_waiver (company_id, exit_case_id, employee_id, reason, waived_by, waived_assignment_id, created_by) values ($1, $2, $3, $4, $5, $6, $5) returning id`,
      [grant.companyId, exitCaseId, x.employee_id, reason, grant.userId, grant.assignmentId],
    )
  ).rows[0]!.id;
  await audit(tx, actorOf(grant), 'exit_case', exitCaseId, 'WAIVE_NOTICE_RECOVERY', null, { operational: { waiverId: id } }, reason);
  return { id, exitCaseId, waivedBy: grant.userId };
}
