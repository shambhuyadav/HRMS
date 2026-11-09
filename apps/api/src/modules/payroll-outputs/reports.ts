// Payroll reports and statutory outputs (FR-038; FR-039; H7 payroll freeze register, bank output manifest; DF07
// accounting exports; H8). Module-local endpoints within the caller's row scope; amounts only under the confidential
// payroll_report grant. Outputs that need content the company has not supplied are reported NOT_CONFIGURED, never
// guessed: the journal voucher needs a configured chart mapping (DF07 "configured chart mappings"), and the
// statutory registers, certificates and returns need activated rule packs and owner-supplied period templates (FR-039
// acceptance; H8), with the source labels preserved until the payroll owner confirms naming and applicability.
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { fromUnits, toUnits } from '../lifecycle/settlement-formulas.js';
import { requireRunScope, unrestricted } from '../payroll/common.js';
import { runComponents } from '../payroll/runs.js';

const LIVE_HOLDS = ['PROPOSED', 'APPROVED_ACTIVE', 'EXPIRED_REVIEW'];
const PENDING = ['RESERVED', 'SUBMITTED', 'UNKNOWN'];
const PAGE = 500;

/** A record's held, reserved and paid position ($3 live hold states, $4 pending payment states). */
const position = (cast: string) => `coalesce((select sum(h.hold_amount) from payroll_hold h where h.company_id = r.company_id and h.payroll_record_id = r.id and h.state = any($3::text[])), 0)::numeric(19, 4)${cast} as held,
      coalesce((select sum(l.payable_amount) from payroll_bank_line l where l.company_id = r.company_id and l.payroll_record_id = r.id and l.payment_state = any($4::text[])), 0)::numeric(19, 4)${cast} as reserved,
      coalesce((select sum(l.confirmed_amount - l.reversed_amount) from payroll_bank_line l where l.company_id = r.company_id and l.payroll_record_id = r.id), 0)::numeric(19, 4)${cast} as paid`;

async function runHeader(db: Queryable, companyId: string, runId: string) {
  const r = (
    await db.query<Record<string, unknown> & { state: string }>(
      `select r.id, p.period_code as "periodCode", r.revision, r.state, r.currency_code as "currencyCode", r.lock_version as "lockVersion",
              r.calculated_by as "preparedBy", r.reviewed_by as "reviewedBy", r.approved_by as "approvedBy", r.processed_by as "processedBy",
              r.processed_at as "processedAt", r.head_count as "headRevisionCount", r.paid_day_policy_id as "paidDayPolicyId", r.attendance_basis as "attendanceBasis"
         from payroll_run r join payroll_period p on p.company_id = r.company_id and p.id = r.period_id where r.company_id = $1 and r.id = $2`,
      [companyId, runId],
    )
  ).rows[0];
  if (!r) throw notFound();
  return r;
}

/** The run exists in the caller's company (404 otherwise, as the JSON reports answer). */
export async function requirePayrollRun(db: Queryable, companyId: string, runId: string): Promise<void> {
  await runHeader(db, companyId, runId);
}

/** FR-065 "record the filter/run version"; section 11.1 "source period, processing revision": what a run export's file comes from. */
export async function payrollRunRevision(db: Queryable, companyId: string, runId: string): Promise<string> {
  const run = await runHeader(db, companyId, runId);
  return `Payroll period ${String(run.periodCode)}, run revision ${String(run.revision)}, state ${run.state}`;
}

/**
 * The register's record scope: everything for an unrestricted company assignment, else the caller's row scope; never
 * the caller's own record (H1, BRD DF02: own payroll reaches an employee only as issued outputs in the Employee context).
 */
const registerScope = (grant: AccessGrant, params: SqlParams) => {
  const scope = unrestricted(grant) ? 'true' : employeeScopePredicate(grant, { company: 'r.company_id', employee: 'r.employee_id' }, params);
  return `(${scope} and r.employee_id is distinct from ${params.add(grant.linkedEmployeeId)}::uuid)`;
};

/**
 * The register's records within the caller's row scope (never their own), by employee code: one keyset page (the JSON
 * report) or, with no page, every record (the PAYROLL_REGISTER export), so both hold the same rows in the same order.
 */
async function registerRecords(db: Queryable, grant: AccessGrant, runId: string, page: { after: string; limit: number } | null) {
  const params = new SqlParams([grant.companyId, runId, LIVE_HOLDS, PENDING]);
  const scope = registerScope(grant, params);
  const keyset = page ? `and r.employee_code > ${params.add(page.after)}` : '';
  const limit = page ? `limit ${params.add(page.limit)}` : '';
  return (
    await db.query<Record<string, unknown> & { employeeCode: string }>(
      `select r.id as "recordId", r.employee_id as "employeeId", r.employee_code as "employeeCode", e.display_name as "employeeName", r.calculation_status as "calculationStatus",
              r.salary_stop_mode as "salaryStopMode", r.paid_units::text as "paidUnits", r.earnings::text as earnings, r.reimbursements::text as reimbursements, r.deductions::text as deductions, r.net::text as net,
              r.employer_contributions::text as "employerContributions", r.bank_status as "bankStatus", ${position('::text')}
         from payroll_record r join employee e on e.company_id = r.company_id and e.id = r.employee_id
        where r.company_id = $1 and r.run_id = $2 and ${scope} ${keyset}
        order by r.employee_code ${limit}`,
      params.values,
    )
  ).rows;
}

/** PAYROLL_REGISTER export rows: every record of the register within the caller's row scope, as its pages list them. */
export async function payrollRegisterRows(db: Queryable, grant: AccessGrant, runId: string) {
  await requirePayrollRun(db, grant.companyId, runId);
  return registerRecords(db, grant, runId, null);
}

/**
 * REIMBURSEMENT_REGISTER export rows (FR-038 "reimbursement"; BRD line 345 Payroll reports; I-40 item 11; decided under owner
 * delegation, 6 Nov 2026, docs/03 I-89 item 1). The source is the payroll run itself: every payroll line on a REIMBURSEMENT head
 * of the run's calculated records (only a calculated record has lines, 0043), within the payroll register's record scope (row
 * scope, never the caller's own record), one row per record and component, by employee code then component code. A record's rows
 * add up to its `reimbursements` total in the payroll register (CI25 holds that total to its lines). Expense claims are not a
 * source: payroll does not pay them (DF07 Wave 1, I-81 item 8) and the expense register and payment reconciliation list them.
 * Amounts as the payroll register states them, never rounded again; the basis says where a line came from (FIXED: the salary
 * arrangement's component; INPUT: approved payroll inputs).
 */
export async function reimbursementRegisterRows(db: Queryable, grant: AccessGrant, runId: string) {
  await requirePayrollRun(db, grant.companyId, runId);
  const params = new SqlParams([grant.companyId, runId]);
  const scope = registerScope(grant, params);
  return (
    await db.query<Record<string, unknown>>(
      `select r.id as "recordId", r.employee_code as "employeeCode", e.display_name as "employeeName", c.code as "componentCode", c.name as "componentName",
              l.calculation_basis as "calculationBasis", l.amount::text as amount, r.currency_code as "currencyCode"
         from payroll_record r
         join employee e on e.company_id = r.company_id and e.id = r.employee_id
         join payroll_line l on l.company_id = r.company_id and l.record_id = r.id and l.head_type = 'REIMBURSEMENT'
         join pay_component c on c.company_id = l.company_id and c.id = l.component_id
        where r.company_id = $1 and r.run_id = $2 and r.calculation_status = 'CALCULATED' and ${scope}
        order by r.employee_code, c.code`,
      params.values,
    )
  ).rows;
}

/**
 * Payroll (freeze) register (FR-038; H7): run revision, actors, snapshot references and lock state, and per record
 * the frozen totals with the held, reserved and paid position. Only records inside the caller's row scope are listed
 * and totalled, never the caller's own (`ownRecordExcluded` says when the run holds one); keyset pages by employee code.
 */
export async function payrollRegister(db: Queryable, grant: AccessGrant, runId: string, q: { after?: string | undefined }) {
  const run = await runHeader(db, grant.companyId, runId);
  const params = new SqlParams([grant.companyId, runId, LIVE_HOLDS, PENDING]);
  const scope = registerScope(grant, params);
  const totals = (
    await db.query(
      `with x as (select r.earnings, r.reimbursements, r.deductions, r.net, r.employer_contributions, ${position('')}
                    from payroll_record r where r.company_id = $1 and r.run_id = $2 and ${scope})
       select count(*)::int as records, coalesce(sum(earnings), 0)::text as earnings, coalesce(sum(reimbursements), 0)::text as reimbursements,
              coalesce(sum(deductions), 0)::text as deductions, coalesce(sum(net), 0)::text as net, coalesce(sum(employer_contributions), 0)::text as "employerContributions",
              coalesce(sum(held), 0)::numeric(19, 4)::text as held, coalesce(sum(reserved), 0)::numeric(19, 4)::text as reserved,
              coalesce(sum(paid), 0)::numeric(19, 4)::text as paid from x`,
      params.values,
    )
  ).rows[0];
  const items = await registerRecords(db, grant, runId, { after: q.after ?? '', limit: PAGE });
  const own = await db.query(`select 1 from payroll_record where company_id = $1 and run_id = $2 and employee_id = $3`, [grant.companyId, runId, grant.linkedEmployeeId]);
  return {
    run,
    scope: unrestricted(grant) ? 'COMPANY' : 'ROW_SCOPE',
    ownRecordExcluded: (own.rowCount ?? 0) > 0,
    totals,
    items,
    next: items.length === PAGE ? items[items.length - 1]!.employeeCode : null,
  };
}

/** The run exists and every one of its records is within the caller's scope (company figures; SCOPE_INCOMPLETE otherwise). */
export async function requireWholePayrollRun(db: Queryable, grant: AccessGrant, runId: string): Promise<void> {
  await requirePayrollRun(db, grant.companyId, runId);
  await requireRunScope(db, grant, runId);
}

/**
 * The disbursement reconciliation totals of a run whose records are all in scope (computed in numeric). FR-031 "salary-stop
 * interpretation is explicit in the result and disbursement report": what approved salary stops withhold, a part of `held`
 * and apart from policy holds and payment safety blocks, and how many employees a stop excluded from calculation. Those have no
 * net, so they are in no other figure.
 */
async function disbursementTotals(db: Queryable, grant: AccessGrant, runId: string) {
  await requireRunScope(db, grant, runId);
  return (
    await db.query<{ payable: string; held: string; heldBySalaryStop: string; salaryStopHolds: number; excludedBySalaryStop: number; reserved: string; paid: string; ready: string; reconciles: boolean }>(
      `with x as (
         select r.net,
                coalesce((select sum(h.hold_amount) from payroll_hold h where h.company_id = r.company_id and h.payroll_record_id = r.id and h.state = any($3::text[])), 0) as held,
                coalesce((select sum(h.hold_amount) from payroll_hold h where h.company_id = r.company_id and h.payroll_record_id = r.id and h.state = any($3::text[]) and h.hold_kind = 'SALARY_STOP'), 0) as stop_held,
                coalesce((select sum(l.payable_amount) from payroll_bank_line l where l.company_id = r.company_id and l.payroll_record_id = r.id and l.payment_state = any($4::text[])), 0) as reserved,
                coalesce((select sum(l.confirmed_amount - l.reversed_amount) from payroll_bank_line l where l.company_id = r.company_id and l.payroll_record_id = r.id), 0) as paid
           from payroll_record r where r.company_id = $1 and r.run_id = $2 and r.calculation_status = 'CALCULATED' and r.frozen_at is not null)
       select coalesce(sum(net), 0)::numeric(19, 4)::text as payable, coalesce(sum(held), 0)::numeric(19, 4)::text as held,
              coalesce(sum(stop_held), 0)::numeric(19, 4)::text as "heldBySalaryStop", count(*) filter (where stop_held > 0)::int as "salaryStopHolds",
              (select count(*)::int from payroll_record e where e.company_id = $1 and e.run_id = $2 and e.salary_stop_mode = 'EXCLUDE_CALCULATION') as "excludedBySalaryStop",
              coalesce(sum(reserved), 0)::numeric(19, 4)::text as reserved, coalesce(sum(paid), 0)::numeric(19, 4)::text as paid,
              coalesce(sum(greatest(net - held - reserved - paid, 0)), 0)::numeric(19, 4)::text as ready,
              coalesce(sum(net), 0) = coalesce(sum(held), 0) + coalesce(sum(reserved), 0) + coalesce(sum(paid), 0) + coalesce(sum(greatest(net - held - reserved - paid, 0)), 0) as reconciles
         from x`,
      [grant.companyId, runId, LIVE_HOLDS, PENDING],
    )
  ).rows[0]!;
}

/** PAYROLL_DISBURSEMENT export row: the run's reconciliation totals, exactly as the JSON report's `totals`. */
export async function disbursementRows(db: Queryable, grant: AccessGrant, runId: string) {
  await requirePayrollRun(db, grant.companyId, runId);
  return [await disbursementTotals(db, grant, runId)];
}

/**
 * Salary disbursement reconciliation (FR-038 "the disbursement file sum matches approved payable totals after
 * withholding rules"; H7 bank output manifest): approved payable = held + reserved + paid + ready, with every
 * manifest's count, total and ledger. Company figures, so the whole run must be in scope.
 */
export async function disbursementReport(db: Queryable, grant: AccessGrant, runId: string) {
  const run = await runHeader(db, grant.companyId, runId);
  const totals = await disbursementTotals(db, grant, runId);
  const manifests = (
    await db.query(
      `select b.id, t.template_code as "templateCode", t.template_version as "templateVersion", b.batch_revision as "batchRevision", b.state, b.line_count as "lineCount",
              b.total_amount::text as "totalAmount", b.content_hash as "contentHash", b.excluded_summary as excluded,
              (select coalesce(json_agg(json_build_object('paymentState', s.payment_state, 'lines', s.n, 'amount', s.amount) order by s.payment_state), '[]'::json)
                 from (select payment_state, count(*)::int as n, sum(payable_amount)::text as amount from payroll_bank_line l
                        where l.company_id = b.company_id and l.batch_id = b.id group by payment_state) s) as ledger
         from payroll_bank_batch b join payroll_bank_template t on t.company_id = b.company_id and t.id = b.template_id
        where b.company_id = $1 and b.run_id = $2 order by b.prepared_at, b.id`,
      [grant.companyId, runId],
    )
  ).rows;
  // Who a salary stop kept out of the calculation, so absent from every figure above (FR-031). The reason stays with the stop.
  const salaryStopExclusions = (
    await db.query(
      `select r.employee_code as "employeeCode", e.display_name as "employeeName", r.salary_stop_mode as mode
         from payroll_record r join employee e on e.company_id = r.company_id and e.id = r.employee_id
        where r.company_id = $1 and r.run_id = $2 and r.salary_stop_mode = 'EXCLUDE_CALCULATION' order by r.employee_code`,
      [grant.companyId, runId],
    )
  ).rows;
  return { run, totals, salaryStopExclusions, manifests, paymentStatusSource: 'RECORDED_OUTCOME_EVIDENCE_ONLY' };
}

/** Component totals and the prior-period comparison of the payroll core (FR-033; FR-038 comparison). */
export async function comparisonReport(db: Queryable, grant: AccessGrant, runId: string) {
  return runComponents(db, grant, runId);
}

/** PAYROLL_COMPARISON export rows: the comparison's component rows, exactly as the JSON report's `items`. */
export async function comparisonRows(db: Queryable, grant: AccessGrant, runId: string) {
  return (await comparisonReport(db, grant, runId)).items as Record<string, unknown>[];
}

/** FR-038 JV: needs a configured, approved chart mapping (DF07); none exists, so nothing is produced. */
export function journalVoucher(): never {
  throw new HttpError(409, 'NOT_CONFIGURED', 'A journal voucher needs an approved chart-of-accounts mapping for payroll heads; none is configured', {
    code: 'JV_CHART_MAPPING_NOT_CONFIGURED',
  });
}

/** FR-039 outputs with their preserved source labels; each needs an activated rule pack and an owner-supplied template. */
export const STATUTORY_OUTPUTS = [
  { code: 'PF_REGISTER', sourceLabel: 'PF register' },
  { code: 'ESIC_REGISTER', sourceLabel: 'ESIC register' },
  { code: 'PT_REGISTER', sourceLabel: 'PT register' },
  { code: 'LWF_REGISTER', sourceLabel: 'LWF register' },
  { code: 'FORM_16', sourceLabel: 'Form 16 / Form 130' },
  { code: 'FORM_24Q', sourceLabel: 'Form 24Q / Form 138' },
  { code: 'NPS_EXPORT', sourceLabel: 'NPS export' },
  { code: 'EDOC_EXPORT', sourceLabel: 'EDOC export' },
] as const;

/**
 * FR-039 statutory registers (decided under owner delegation, 6 Nov 2026; I-90 follow-up): the PF, ESIC, professional tax and labour
 * welfare fund registers are WORKING registers of a payroll run, read from what its calculation recorded (payroll_record_statutory: the
 * pinned pack revision, the wages, option, coverage, state and slab, and each output's amount), never computed again. A register is
 * AVAILABLE while its pack (PF, ESIC, or any PT_<state> or LWF_<state>) has an ACTIVE revision. It is not a filing: the filing formats
 * (ECR, ESIC, PT and LWF returns) still need the owner's period template and an approved sample, as do Form 16, Form 24Q, NPS and
 * EDOC, which stay NOT_CONFIGURED.
 */
const REGISTERS = {
  PF_REGISTER: {
    packs: (code: string) => code === 'PF',
    facts: ['pfWages', 'contributionWages', 'option'],
    outputs: { PF_EMPLOYEE: 'employee', PF_EMPLOYER_EPS: 'pension', PF_EMPLOYER_EPF: 'employerEpf', PF_EDLI: 'edli', PF_ADMIN: 'adminCharges' },
  },
  ESIC_REGISTER: {
    packs: (code: string) => code === 'ESIC',
    facts: ['esicWages', 'covered', 'coverageDate', 'periodStart'],
    outputs: { ESIC_EMPLOYEE: 'employee', ESIC_EMPLOYER: 'employer' },
  },
  PT_REGISTER: {
    packs: (code: string) => /^PT_[A-Z]{2}$/.test(code),
    facts: ['gross', 'stateCode', 'slab', 'month'],
    outputs: { PROFESSIONAL_TAX: 'tax' },
  },
  LWF_REGISTER: {
    packs: (code: string) => /^LWF_[A-Z]{2}$/.test(code),
    facts: ['wages', 'stateCode', 'slab', 'month'],
    outputs: { LWF_EMPLOYEE: 'employee', LWF_EMPLOYER: 'employer' },
  },
} as const satisfies Record<string, { packs: (code: string) => boolean; facts: readonly string[]; outputs: Record<string, string> }>;
type RegisterCode = keyof typeof REGISTERS;
const isRegister = (code: string): code is RegisterCode => Object.hasOwn(REGISTERS, code);

const NEEDS_ALL = ['activated statutory rule pack (rates and applicability)', 'owner-supplied period template', 'approved sample'];

export async function statutoryOutputs(db: Queryable, companyId: string) {
  const active = (await db.query<{ code: string }>(`select distinct code from statutory_rule_pack where company_id = $1 and state = 'ACTIVE'`, [companyId])).rows.map((r) => r.code);
  return {
    items: STATUTORY_OUTPUTS.map((o) => {
      if (!isRegister(o.code)) return { ...o, status: 'NOT_CONFIGURED', reason: 'RULE_PACK_AND_TEMPLATE_NOT_CONFIGURED', needs: NEEDS_ALL };
      const def = REGISTERS[o.code];
      return active.some((c) => def.packs(c))
        ? { ...o, status: 'AVAILABLE', format: 'WORKING_REGISTER', reason: 'WORKING_REGISTER', needs: ['owner-supplied period template and approved sample for the filing format'] }
        : { ...o, status: 'NOT_CONFIGURED', reason: 'RULE_PACK_NOT_ACTIVE', needs: NEEDS_ALL };
    }),
  };
}

export async function statutoryOutput(db: Queryable, companyId: string, code: string) {
  if (!STATUTORY_OUTPUTS.some((o) => o.code === code)) throw notFound();
  const item = (await statutoryOutputs(db, companyId)).items.find((o) => o.code === code)!;
  if (item.status === 'AVAILABLE') return { ...item, runPath: `/v1/payroll-outputs/runs/{runId}/statutory-registers/${code}` };
  throw new HttpError(409, 'NOT_CONFIGURED', 'This statutory output needs an activated rule pack and an owner-supplied template; none is configured', {
    code: item.reason,
    output: code,
  });
}

const QUARTER_MONTHS: Record<number, [number, number]> = { 1: [4, 6], 2: [7, 9], 3: [10, 12], 4: [1, 3] };

/**
 * FR-039 Form 24Q working data (decided under owner delegation, 6 Nov 2026; I-90 follow-up): the TDS on salary of one quarter of a
 * financial year, per employee within the payroll register's scope (never the caller's own) and per month: the taxable salary paid and the
 * TDS deducted, from PROCESSED_LOCKED payroll (taxable: EARNING lines whose head is not NON_TAXABLE; TDS: DEDUCTION lines on heads coded
 * TDS) and from final settlements PAID for a leaving date in the quarter (as tax-declarations/form16.ts counts them), in the leaving
 * month. Not the return: Form 24Q needs the TAN, deductee PANs, challan details and the owner's template, so FORM_24Q stays
 * NOT_CONFIGURED; this is what a return would be prepared and reconciled from.
 */
export async function tdsRegister(db: Queryable, grant: AccessGrant, q: { fiscalYear: string; quarter: number }) {
  const m = /^(\d{4})-(\d{2})$/.exec(q.fiscalYear);
  if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2])) throw new HttpError(422, 'INVALID_FISCAL_YEAR', 'A financial year looks like 2026-27');
  const [first, last] = QUARTER_MONTHS[q.quarter]!;
  const year = q.quarter === 4 ? Number(m[1]) + 1 : Number(m[1]);
  const from = `${year}-${String(first).padStart(2, '0')}-01`;
  const to = new Date(Date.UTC(year, last, 0)).toISOString().slice(0, 10);
  const params = new SqlParams([grant.companyId, from, to]);
  const scope = registerScope(grant, params);
  const rows = (
    await db.query<{ employee_id: string; employee_code: string; employee_name: string; month: string; source: string; taxable: string; tds: string }>(
      `with payroll as (
         select r.employee_id, to_char(ru.service_start, 'YYYY-MM') as month, 'PAYROLL'::text as source,
                coalesce(sum(l.amount) filter (where h.head_type = 'EARNING' and tt.code is distinct from 'NON_TAXABLE'), 0) as taxable,
                coalesce(sum(l.amount) filter (where h.head_type = 'DEDUCTION' and h.rule_pack_code = 'TDS'), 0) as tds
           from payroll_record r
           join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id and ru.state = 'PROCESSED_LOCKED'
           join payroll_line l on l.company_id = r.company_id and l.record_id = r.id
           join payroll_head_revision h on h.company_id = l.company_id and h.id = l.head_revision_id
           left join reference_value tt on tt.company_id = h.company_id and tt.id = h.tax_treatment_id
          where r.company_id = $1 and r.calculation_status = 'CALCULATED' and ru.service_start between $2::date and $3::date and ${scope}
          group by r.employee_id, ru.service_start),
       settled as (
         select s.employee_id as employee_id, to_char(x.approved_leaving_date, 'YYYY-MM') as month, 'FINAL_SETTLEMENT'::text as source,
                coalesce(sum(sl.amount) filter (where pc.component_kind = 'EARNING' and sl.amount > 0 and tt.code is distinct from 'NON_TAXABLE'), 0) as taxable,
                coalesce(-sum(sl.amount) filter (where pc.component_kind = 'DEDUCTION' and h.rule_pack_code = 'TDS'), 0) as tds
           from settlement s
           join exit_case x on x.company_id = s.company_id and x.id = s.exit_case_id and x.approved_leaving_date between $2::date and $3::date
           join settlement_line sl on sl.company_id = s.company_id and sl.settlement_id = s.id
           join pay_component pc on pc.company_id = sl.company_id and pc.id = sl.component_id
           left join lateral (select hr.tax_treatment_id, hr.rule_pack_code from payroll_head_revision hr
                               where hr.company_id = sl.company_id and hr.component_id = sl.component_id and hr.state = 'ACTIVE' and hr.effective_from <= x.approved_leaving_date
                               order by hr.effective_from desc limit 1) h on true
           left join reference_value tt on tt.company_id = s.company_id and tt.id = h.tax_treatment_id
           join lateral (select s.company_id, s.employee_id) r on true
          where s.company_id = $1 and s.state = 'PAID' and ${scope}
          group by s.employee_id, x.approved_leaving_date)
       select t.employee_id, e.employee_code, e.display_name as employee_name, t.month, t.source, t.taxable::numeric(19, 4)::text as taxable, t.tds::numeric(19, 4)::text as tds
         from (select * from payroll union all select * from settled) t
         join employee e on e.company_id = $1 and e.id = t.employee_id
        order by e.employee_code, t.month, t.source`,
      params.values,
    )
  ).rows;
  const items: { employeeId: string; employeeCode: string; employeeName: string; months: { month: string; source: string; taxableSalary: string; tds: string }[]; tds: string }[] = [];
  const add = (a: string, b: string) => fromUnits(toUnits(a) + toUnits(b));
  for (const r of rows) {
    let item = items.at(-1);
    if (!item || item.employeeId !== r.employee_id) {
      item = { employeeId: r.employee_id, employeeCode: r.employee_code, employeeName: r.employee_name, months: [], tds: '0.0000' };
      items.push(item);
    }
    item.months.push({ month: r.month, source: r.source, taxableSalary: r.taxable, tds: r.tds });
    item.tds = add(item.tds, r.tds);
  }
  const byMonth = new Map<string, { taxableSalary: string; tds: string }>();
  for (const r of rows) {
    const t = byMonth.get(r.month) ?? { taxableSalary: '0.0000', tds: '0.0000' };
    byMonth.set(r.month, { taxableSalary: add(t.taxableSalary, r.taxable), tds: add(t.tds, r.tds) });
  }
  return {
    fiscalYear: q.fiscalYear,
    quarter: q.quarter,
    from,
    to,
    format: 'WORKING_REGISTER',
    notice: 'Working data for Form 24Q / Form 138: TDS deducted on salary from processed payroll and paid final settlements. Not the return: the TAN, deductee PANs, challan details and the owner’s template are needed for that.',
    scope: unrestricted(grant) ? 'COMPANY' : 'ROW_SCOPE',
    totals: {
      employees: items.length,
      tds: rows.reduce((s, r) => add(s, r.tds), '0.0000'),
      months: [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, ...v })),
    },
    items,
  };
}

/**
 * One statutory register of a run (FR-039; see REGISTERS): per record within the payroll register's scope (never the caller's own), the
 * facts of its rows and each output's amount (null where NOT_APPLICABLE, with the reason), and the pack revisions the run pinned; totals
 * over every record in scope; keyset pages by employee code as the payroll register.
 */
export async function statutoryRegister(db: Queryable, grant: AccessGrant, runId: string, code: string, q: { after?: string | undefined }) {
  if (!isRegister(code)) throw notFound();
  const def = REGISTERS[code];
  const run = await runHeader(db, grant.companyId, runId);
  const outputCodes = Object.keys(def.outputs);
  const params = new SqlParams([grant.companyId, runId, outputCodes]);
  const scope = registerScope(grant, params);
  const rows = `from payroll_record r
                join employee e on e.company_id = r.company_id and e.id = r.employee_id
                join payroll_record_statutory s on s.company_id = r.company_id and s.record_id = r.id and s.rule_pack_code = any($3::text[])
               where r.company_id = $1 and r.run_id = $2 and r.calculation_status = 'CALCULATED' and ${scope}`;
  const totals = (
    await db.query<{ rule_pack_code: string; amount: string; records: number }>(
      `select s.rule_pack_code, coalesce(sum(s.amount), 0)::text as amount, count(distinct r.id)::int as records ${rows} group by s.rule_pack_code`,
      params.values,
    )
  ).rows;
  const records = (await db.query<{ n: number }>(`select count(distinct r.id)::int as n ${rows}`, params.values)).rows[0]!.n;
  const pageParams = new SqlParams([...params.values]);
  const after = pageParams.add(q.after ?? '');
  const limit = pageParams.add(PAGE);
  const page = (
    await db.query<{ record_id: string; employee_code: string; employee_name: string; rule_pack_code: string; status: string; amount: string | null; workings: Record<string, unknown> }>(
      `select r.id as record_id, r.employee_code, e.display_name as employee_name, s.rule_pack_code, s.status, s.amount::text as amount, s.workings
         ${rows} and r.id in (select r.id ${rows} and r.employee_code > ${after} group by r.id, r.employee_code order by r.employee_code limit ${limit})
        order by r.employee_code, s.rule_pack_code`,
      pageParams.values,
    )
  ).rows;
  const items: Record<string, unknown>[] = [];
  for (const row of page) {
    let item = items.at(-1) as (Record<string, unknown> & { recordId: string; facts: Record<string, unknown>; amounts: Record<string, string | null>; notApplicable: Record<string, string> }) | undefined;
    if (!item || item.recordId !== row.record_id) {
      item = { recordId: row.record_id, employeeCode: row.employee_code, employeeName: row.employee_name, packCode: row.workings.packCode, packRevision: row.workings.packRevision, facts: {}, amounts: {}, notApplicable: {} };
      items.push(item);
    }
    for (const f of def.facts) if (item.facts[f] === undefined && row.workings[f] !== undefined) item.facts[f] = row.workings[f];
    const column = (def.outputs as Record<string, string>)[row.rule_pack_code]!;
    item.amounts[column] = row.status === 'VALUED' ? row.amount : null;
    if (row.status !== 'VALUED') item.notApplicable[column] = String(row.workings.reason ?? 'NOT_APPLICABLE');
  }
  const pins = (
    await db.query<{ packCode: string; packRevision: number | null }>(
      `select pack_code as "packCode", pack_revision as "packRevision" from payroll_run_rule_pack where company_id = $1 and run_id = $2 order by pack_code`,
      [grant.companyId, runId],
    )
  ).rows.filter((p) => def.packs(p.packCode));
  return {
    code,
    sourceLabel: STATUTORY_OUTPUTS.find((o) => o.code === code)!.sourceLabel,
    format: 'WORKING_REGISTER',
    notice: 'A working register of what the calculation recorded; not a statutory filing. The filing format needs the owner’s period template and an approved sample.',
    run,
    packs: pins,
    scope: unrestricted(grant) ? 'COMPANY' : 'ROW_SCOPE',
    totals: {
      records,
      amounts: Object.fromEntries(Object.entries(def.outputs).map(([rulePack, column]) => [column, totals.find((t) => t.rule_pack_code === rulePack)?.amount ?? '0.0000'])),
    },
    items,
    next: new Set(page.map((p) => p.record_id)).size === PAGE ? (items.at(-1)!.employeeCode as string) : null,
  };
}
