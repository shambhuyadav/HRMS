// Payroll reports and statutory outputs (FR-038; FR-039; H7 payroll freeze register, bank output manifest; DF07
// accounting exports; H8). Module-local endpoints within the caller's row scope; amounts only under the confidential
// payroll_report grant. Outputs that need content the company has not supplied are reported NOT_CONFIGURED, never
// guessed: the journal voucher needs a configured chart mapping (DF07 "configured chart mappings"), and the
// statutory registers, certificates and returns need activated rule packs and owner-supplied period templates (FR-039
// acceptance; H8), with the source labels preserved until the payroll owner confirms naming and applicability.
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
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

export function statutoryOutputs() {
  return {
    items: STATUTORY_OUTPUTS.map((o) => ({
      ...o,
      status: 'NOT_CONFIGURED',
      reason: 'RULE_PACK_AND_TEMPLATE_NOT_CONFIGURED',
      needs: ['activated statutory rule pack (rates and applicability)', 'owner-supplied period template', 'approved sample'],
    })),
  };
}

export function statutoryOutput(code: string): never {
  if (!STATUTORY_OUTPUTS.some((o) => o.code === code)) throw notFound();
  throw new HttpError(409, 'NOT_CONFIGURED', 'This statutory output needs an activated rule pack and an owner-supplied template; none is configured', {
    code: 'RULE_PACK_AND_TEMPLATE_NOT_CONFIGURED',
    output: code,
  });
}
