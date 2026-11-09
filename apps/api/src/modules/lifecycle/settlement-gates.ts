// What a calculated settlement must still satisfy at its later steps (FR-052; decided under owner delegation, 6 Nov 2026; docs/03 I-88).
// Kept apart from settlement.ts (which calls these) and settlement-calculation.ts (which calls settlement.ts), so neither imports the
// other in a cycle.
//
// - approvalBlockers: what refuses the final approval. A blocking item of the frozen calculation (a rule pack, policy or master fact
//   the calculation needed and did not have); any statutory RULE_PACK head that applies to the components the revision pays, evaluated
//   on its frozen lines (BRD line 5120 "any required missing deduction rule pack blocks final calculation approval", as the payroll core
//   blocks the employee); and, for a revision without a calculation, an employee the gratuity pack makes eligible (so leaving the
//   calculation out never avoids the gratuity rule).
// - assertCalculationStillHolds: the arrears and adjustments a calculation took are still unpaid and held by no payroll run, and a loan
//   it recovers still owes at least that much; checked at submission, release eligibility and payment, beside ALREADY_PAID_IN_PAYROLL.
// - encashOnPayment: a paid settlement consumes the leave it encashed, once (BRD line 4939).
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import { loanOutstandingSql } from '../payroll/common.js';
import { statutoryLineBlockers } from '../statutory/evaluate.js';
import { ensureStatutoryPacks, gratuityParameters, packInEffect } from '../statutory/rule-packs.js';
import { advisoryLock, type Actor } from './common.js';
import { gratuityEligibility } from './settlement-formulas.js';

/** Settlement states whose carried calculation holds the arrears and adjustments it took (live, or paid for good). */
export const HOLDING_STATES = ['DRAFT', 'SUBMITTED', 'REVIEWED', 'APPROVED', 'RELEASE_ELIGIBLE', 'PAID'] as const;
/** Payroll run states whose records hold the inputs they took (a returned or cancelled revision holds nothing). */
export const RUN_HOLDING_STATES = ['DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED', 'PROCESSED_LOCKED'] as const;

export interface Blocker {
  source: 'CALCULATION' | 'STATUTORY' | 'GRATUITY';
  kind: string;
  code: string;
  componentCode?: string | null;
  rulePackCode?: string | null;
}

// The RULE_PACK heads that apply to a settlement's components are found by statutory/evaluate.ts rulePackHeadsFor (I-85).

interface GateSettlement {
  id: string;
  employee_id: string;
  exit_case_id: string;
}

async function carried(db: Queryable, companyId: string, settlementId: string) {
  return (
    await db.query<{ calculation_id: string | null; last_working_date: string; joining_date: string; separation_type: string }>(
      `select s.calculation_id, to_char(x.approved_leaving_date, 'YYYY-MM-DD') as last_working_date, to_char(e.joining_date, 'YYYY-MM-DD') as joining_date, x.separation_type
         from settlement s join exit_case x on x.company_id = s.company_id and x.id = s.exit_case_id
         join employee e on e.company_id = s.company_id and e.id = s.employee_id
        where s.company_id = $1 and s.id = $2`,
      [companyId, settlementId],
    )
  ).rows[0]!;
}

/** Everything that refuses the final approval of this revision now (see the file header); empty when it may be approved. */
export async function approvalBlockers(tx: Queryable, companyId: string, s: GateSettlement): Promise<Blocker[]> {
  const c = await carried(tx, companyId, s.id);
  const blockers: Blocker[] = [];
  if (c.calculation_id) {
    const items = (
      await tx.query<{ kind: string; code: string; componentCode: string | null }>(
        `select i.item_kind as kind, i.status as code, pc.code as "componentCode"
           from settlement_calculation_item i left join pay_component pc on pc.company_id = i.company_id and pc.id = i.component_id
          where i.company_id = $1 and i.calculation_id = $2 and i.blocking order by i.position`,
        [companyId, c.calculation_id],
      )
    ).rows;
    blockers.push(...items.map((i) => ({ source: 'CALCULATION' as const, ...i })));
  }
  // The frozen lines decide which statutory packs apply, whether calculated or entered; I-85: each is evaluated again from them
  // (statutory/evaluate.ts), so an unconfigured pack still blocks and a valued deduction must still equal its frozen line.
  for (const b of await statutoryLineBlockers(tx, companyId, s.id, c.last_working_date)) {
    if (blockers.some((x) => x.code === b.code && x.componentCode === b.componentCode)) continue;
    blockers.push(b);
  }
  if (!c.calculation_id) {
    // A revision without a calculation: only an employee the gratuity pack makes ineligible may be approved without one.
    await ensureStatutoryPacks(tx, companyId);
    const pack = await packInEffect(tx, companyId, 'GRATUITY', c.last_working_date);
    const eligible = pack ? gratuityEligibility(gratuityParameters(pack.pack), c.joining_date, c.last_working_date, c.separation_type).eligible : true;
    if (eligible) blockers.push({ source: 'GRATUITY', kind: 'GRATUITY', code: pack?.active ? 'CALCULATION_REQUIRED' : 'RULE_PACK_NOT_CONFIGURED', rulePackCode: 'GRATUITY' });
  }
  return blockers;
}

/** 409 CALCULATION_BLOCKED naming every blocker, when there is one. */
export async function assertApprovable(tx: Queryable, companyId: string, s: GateSettlement): Promise<void> {
  const blockers = await approvalBlockers(tx, companyId, s);
  if (blockers.length > 0) {
    throw new HttpError(409, 'CALCULATION_BLOCKED', 'This settlement cannot be approved: a rule pack, policy or record it needs is missing. Return it for a corrected revision once that is in place.', {
      blockers,
    });
  }
}

/**
 * The cases and loans the carried calculation took still stand (FR-035, FR-100, FR-034; I-79, I-81 item 1): each arrears case and
 * timesheet adjustment is still approved and unpaid, and no payroll run holds it; each loan is still disbursed and owes at least what
 * the settlement recovers. 409 ARREARS_TAKEN_BY_PAYROLL or LOAN_BALANCE_CHANGED: prepare a corrected revision (a new calculation).
 */
export async function assertCalculationStillHolds(tx: Queryable, companyId: string, settlementId: string): Promise<void> {
  const c = (await tx.query<{ calculation_id: string | null }>(`select calculation_id from settlement where company_id = $1 and id = $2`, [companyId, settlementId])).rows[0];
  if (!c?.calculation_id) return;
  const runs = [...RUN_HOLDING_STATES];
  const taken = (
    await tx.query<{ id: string }>(
      `select coalesce(i.arrears_case_id, i.adjustment_id) as id
         from settlement_calculation_item i
         left join payroll_arrears_case ac on ac.company_id = i.company_id and ac.id = i.arrears_case_id
         left join payroll_adjustment ad on ad.company_id = i.company_id and ad.id = i.adjustment_id
        where i.company_id = $1 and i.calculation_id = $2 and i.status = 'CALCULATED' and (i.arrears_case_id is not null or i.adjustment_id is not null)
          and (coalesce(ac.state, ad.state) <> 'APPROVED'
               or exists (select 1 from payroll_record_input x
                            join payroll_record xr on xr.company_id = x.company_id and xr.id = x.record_id
                            join payroll_run xu on xu.company_id = xr.company_id and xu.id = xr.run_id and xu.state = any($3::text[])
                           where x.company_id = i.company_id and (x.arrears_case_id = i.arrears_case_id or x.adjustment_id = i.adjustment_id)))
        order by 1`,
      [companyId, c.calculation_id, runs],
    )
  ).rows.map((r) => r.id);
  if (taken.length > 0) {
    throw new HttpError(409, 'ARREARS_TAKEN_BY_PAYROLL', 'Payroll has paid or holds an arrear or adjustment this calculation took; prepare a corrected revision', { cases: taken });
  }
  const loans = (
    await tx.query<{ id: string }>(
      `select l.id from settlement_calculation_item i
         join payroll_loan l on l.company_id = i.company_id and l.id = i.loan_id
        where i.company_id = $1 and i.calculation_id = $2 and i.status = 'CALCULATED'
          and (l.state <> 'DISBURSED' or ${loanOutstandingSql('l')} < -i.amount)
        order by l.id`,
      [companyId, c.calculation_id],
    )
  ).rows.map((r) => r.id);
  if (loans.length > 0) throw new HttpError(409, 'LOAN_BALANCE_CHANGED', 'A loan this calculation recovers owes less than it did; prepare a corrected revision', { loans });
}

/**
 * BRD line 4939 "settlement consumes approved balances once": when a calculated settlement is recorded as paid, each leave type it
 * encashed loses those units, as an ENCASHMENT dated the last working date (its key makes a repeat change nothing). The database
 * refuses taking a balance below zero as at that date.
 */
export async function encashOnPayment(tx: Queryable, actor: Actor, settlementId: string): Promise<number> {
  const rows = (
    await tx.query<{ item_id: string; employee_id: string; leave_type_id: string; units: string; last_working_date: string; revision: number }>(
      `select i.id as item_id, i.employee_id, i.leave_type_id, i.basis ->> 'units' as units, to_char(k.last_working_date, 'YYYY-MM-DD') as last_working_date, s.revision
         from settlement s
         join settlement_calculation k on k.company_id = s.company_id and k.id = s.calculation_id
         join settlement_calculation_item i on i.company_id = k.company_id and i.calculation_id = k.id
        where s.company_id = $1 and s.id = $2 and i.item_kind = 'LEAVE_ENCASHMENT' and i.status = 'CALCULATED' and i.leave_type_id is not null
        order by i.position`,
      [actor.companyId, settlementId],
    )
  ).rows;
  let written = 0;
  for (const r of rows) {
    await advisoryLock(tx, `leave_balance:${r.employee_id}:${r.leave_type_id}`);
    const inserted = await tx.query(
      `insert into leave_movement (company_id, employee_id, leave_type_id, movement_kind, units, effective_date, idempotency_key, reason, created_by, updated_by)
       values ($1, $2, $3, 'ENCASHMENT', -($4::numeric), $5::date, $6, $7, $8, $8)
       on conflict (company_id, idempotency_key) do nothing`,
      [actor.companyId, r.employee_id, r.leave_type_id, r.units, r.last_working_date, `settlement:encashment:${r.item_id}`, `Encashed in the full and final settlement (revision ${r.revision})`, actor.userId],
    );
    written += inserted.rowCount ?? 0;
  }
  return written;
}

/** The carried calculation of a revision, with its items, for readers holding the settlement amount group. */
export async function calculationView(db: Queryable, companyId: string, calculationId: string | null) {
  if (!calculationId) return null;
  const k = (
    await db.query(
      `select k.id, k.sequence, k.calculated_at as "calculatedAt", k.calculated_by as "calculatedBy", to_char(k.last_working_date, 'YYYY-MM-DD') as "lastWorkingDate",
              to_char(k.period_start, 'YYYY-MM-DD') as "periodStart", to_char(k.period_end, 'YYYY-MM-DD') as "periodEnd", k.currency_code as "currencyCode",
              k.policy_id as "policyId", (select revision from settlement_policy p where p.company_id = k.company_id and p.id = k.policy_id) as "policyRevision",
              k.gratuity_pack_id as "gratuityPackId", k.valuation_policy_id as "valuationPolicyId", k.paid_day_policy_id as "paidDayPolicyId",
              k.item_count as "itemCount", k.blocking_count as "blockingCount", k.inputs
         from settlement_calculation k where k.company_id = $1 and k.id = $2`,
      [companyId, calculationId],
    )
  ).rows[0];
  if (!k) return null;
  const items = (
    await db.query(
      `select i.position, i.item_kind as kind, i.status, i.blocking, pc.code as "componentCode", pc.component_kind as "componentKind", i.amount::text as amount, i.basis,
              lt.code as "leaveTypeCode", i.loan_id as "loanId", i.arrears_case_id as "arrearsCaseId", i.adjustment_id as "adjustmentId", i.head_revision_id as "headRevisionId"
         from settlement_calculation_item i
         left join pay_component pc on pc.company_id = i.company_id and pc.id = i.component_id
         left join leave_type lt on lt.company_id = i.company_id and lt.id = i.leave_type_id
        where i.company_id = $1 and i.calculation_id = $2 order by i.position`,
      [companyId, calculationId],
    )
  ).rows;
  return { ...k, items };
}

/** The notice recovery waiver of an exit, if any (confidential with the settlement amounts). */
export async function noticeWaiverOf(db: Queryable, companyId: string, exitCaseId: string) {
  return (
    (
      await db.query<{ id: string; reason: string; waivedBy: string; waivedAt: string }>(
        `select id, reason, waived_by as "waivedBy", waived_at as "waivedAt" from settlement_notice_waiver where company_id = $1 and exit_case_id = $2`,
        [companyId, exitCaseId],
      )
    ).rows[0] ?? null
  );
}
