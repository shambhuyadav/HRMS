// Liability provisions as on a date (BRD coverage CL-098 "Liability Provisions", under FR-038 payroll reports and FR-052 settlement
// rules). Built 11 Nov 2026 from the reference system's screen (as-on date; Gratuity, Statutory bonus, Leave encashment, Notice pay; by
// company or department); decided under owner delegation, 6 Nov 2026.
//
// Each figure is what the company's own configured rules give on the as-on date, never an assumed rate; where a rule is missing the item
// reads NOT_CONFIGURED with the reason, and no number is shown:
//  GRATUITY          the GRATUITY statutory pack ACTIVE on the date (statutory/rule-packs.ts; seeded inactive until an authorised
//                    person validates and another activates it) and the settlement policy in force (its Basic and DA components). Per
//                    employee employed on the date: wageDays / wageDivisor x Basic + DA of the salary arrangement in force x the years
//                    counted as if service ended on the date (part-year rule of the pack), capped (lifecycle/settlement-formulas.ts, as
//                    a settlement computes it). Accrued for everyone, vested or not: the Vested column says whether the pack's minimum
//                    service is met.
//  STATUTORY_BONUS   no statutory bonus (Payment of Bonus Act) rule pack is defined, so always NOT_CONFIGURED.
//  LEAVE_ENCASHMENT  the settlement policy in force (encashable leave types, their caps, the rate basis and divisor). Per employee and
//                    encashable paid leave type: the balance as at the date (the leave ledger, reservations for pending leave
//                    included, as a settlement reads it), up to the cap, x the monthly rate / the divisor, rounded to the currency.
//  NOTICE_PAY        the settlement policy in force (notice rate basis and divisor). Per approved exit whose notice runs on the date
//                    (resignation request on or before it, last working date on or after it): the notice shortfall in days (the
//                    contractual notice less the days from request to last working date) x the rate / the divisor. A resignation's
//                    shortfall is recoverable from the employee, shown negative, unless waived; an employer-notice separation
//                    (termination) is pay in lieu, shown positive; separations with no notice are left out.
// Rows are limited to the payroll register's scope (the caller's row scope, never their own record), employees employed on the date.
//
// Every figure is worked from salary arrangements, so besides the payroll report grant the same assignment needs salary.read.salary,
// and salary.history_read.salary for a date before today (C4: the financial past is its own grant); rows also keep the salary grant's
// row scope. The as-on date is today or earlier. The basis column names the rate basis and the rule (Basic + DA, ...), never an amount,
// a day count or a year count: with the provision those would give the salary back.
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import { type AccessGrant, employeeScopePredicate, resolveAccess, SqlParams } from '../access/authorize.js';
import { ruleOf } from '../lifecycle/separation-types.js';
import { dayRateValue, fromUnits, gratuityAmount, negate, noticeShortfall, serviceYears, sum, toUnits } from '../lifecycle/settlement-formulas.js';
import { policyInForce } from '../lifecycle/settlement-policy.js';
import { gratuityParameters, packInEffect } from '../statutory/rule-packs.js';
import { isCompanyWide, isIsoDate } from './common.js';

export const PROVISION_ITEMS = ['GRATUITY', 'STATUTORY_BONUS', 'LEAVE_ENCASHMENT', 'NOTICE_PAY'] as const;
export type ProvisionItem = (typeof PROVISION_ITEMS)[number];

type RateBasis = 'BASIC' | 'BASIC_DA' | 'GROSS';

interface Person {
  id: string;
  employee_code: string;
  display_name: string;
  joining_date: string;
  department_id: string | null;
  department_code: string | null;
  department: string | null;
}

interface ArrangementLine {
  employee_id: string;
  currency_code: string;
  component_id: string;
  code: string;
  kind: string;
  amount: string;
  basis: string;
}

export interface ProvisionRow {
  item: ProvisionItem;
  status: string;
  employeeId: string | null;
  employeeCode: string;
  employeeName: string;
  departmentCode: string;
  department: string;
  amount: string | null;
  currencyCode: string;
  vested: string;
  basis: string;
}

export interface ItemStanding {
  item: ProvisionItem;
  status: 'CALCULATED' | 'NOT_CONFIGURED' | 'NOT_APPLICABLE';
  reason: string | null;
  detail?: Record<string, unknown>;
}

/** How a basis column names a rate basis: the components' names, never their amounts. */
const BASIS_LABEL: Readonly<Record<RateBasis, string>> = { BASIC: 'Basic', BASIC_DA: 'Basic + DA', GROSS: 'Gross (fixed monthly earnings)' };

/**
 * The monthly rate a day-rate item or gratuity uses (as lifecycle/settlement-calculation.ts monthlyRate): Basic, Basic + DA, or every
 * monthly FIXED earning head; a status instead when it cannot be read.
 */
function monthlyRate(
  basis: RateBasis,
  lines: ArrangementLine[] | undefined,
  policy: { basic_component_id: string; da_component_id: string | null },
  heads: Map<string, { in_use: boolean; head_type: string | null; calculation_basis: string | null }>,
): { monthly: string; currency: string } | { status: string } {
  if (!lines || lines.length === 0) return { status: 'NO_SALARY_ARRANGEMENT' };
  const chosen =
    basis === 'GROSS'
      ? lines.filter((c) => {
          const h = heads.get(c.component_id);
          return c.kind === 'EARNING' && h?.in_use && h.calculation_basis === 'FIXED' && h.head_type === 'EARNING';
        })
      : lines.filter((c) => c.component_id === policy.basic_component_id || (basis === 'BASIC_DA' && c.component_id === policy.da_component_id));
  if (basis !== 'GROSS' && !chosen.some((c) => c.component_id === policy.basic_component_id)) return { status: 'RATE_BASIS_MISSING' };
  if (chosen.length === 0) return { status: 'RATE_BASIS_MISSING' };
  if (chosen.some((c) => c.basis !== 'MONTHLY')) return { status: 'COMPONENT_BASIS_NOT_MONTHLY' };
  return { monthly: sum(chosen.map((c) => c.amount)), currency: lines[0]!.currency_code };
}

/** The as-on date: a calendar date, and, given today's business date, not after it (422 FUTURE_AS_OF). */
export function checkAsOf(asOf: string | undefined, businessDate?: string): string {
  if (!asOf || !isIsoDate(asOf)) throw new HttpError(422, 'AS_OF_REQUIRED', 'Give the as-on date (YYYY-MM-DD)');
  if (businessDate !== undefined && asOf > businessDate) throw new HttpError(422, 'FUTURE_AS_OF', 'The as-on date is today or earlier', { field: 'asOf' });
  return asOf;
}

/**
 * The salary grants the provisions are worked from, resolved in the payroll report grant's own assignment (as the salary progression
 * route resolves them): salary.read.salary always, and salary.history_read.salary for an as-on date before today. Answers the read grant,
 * whose row scope (its scoped DENYs, C1) the rows keep as well.
 */
export async function provisionSalaryGrant(db: Queryable, grant: AccessGrant, asOf: string): Promise<AccessGrant> {
  const resolve = (action: 'read' | 'history_read') =>
    resolveAccess(db, { userId: grant.userId, companyId: grant.companyId, assignmentId: grant.assignmentId, resource: 'salary', action, fieldGroups: ['salary'], at: grant.at });
  const read = await resolve('read');
  if (!read.allowed) throw new HttpError(403, 'SALARY_GRANT_REQUIRED', 'Liability provisions are worked from salaries, which need the salary read grant in the same assignment');
  if (asOf < grant.businessDate && !(await resolve('history_read')).allowed) {
    throw new HttpError(403, 'HISTORY_GRANT_REQUIRED', 'An earlier as-on date reads earlier salaries, which need the salary history grant');
  }
  return read;
}

/** Every item's standing and its rows for the employees in scope employed on `asOf`. */
export async function provisionRows(db: Queryable, grant: AccessGrant, q: { asOf: string; departmentId?: string | undefined }) {
  const asOf = checkAsOf(q.asOf, grant.businessDate);
  const salary = await provisionSalaryGrant(db, grant, asOf);
  const companyId = grant.companyId;
  const p = new SqlParams([companyId, asOf]);
  // The same predicate for every scope, so a scoped DENY of another assignment (C1) applies to a company-wide one too; the salary
  // grant's as well, since every figure is worked from a salary.
  const scope = `${employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, p)} and ${employeeScopePredicate(salary, { company: 'e.company_id', employee: 'e.id' }, p)}`;
  const own = `not exists (select 1 from user_employee_link u where u.company_id = e.company_id and u.user_id = ${p.add(grant.userId)}::uuid and u.employee_id = e.id)`;
  const department = q.departmentId ? `and ea.department_id = ${p.add(q.departmentId)}::uuid` : '';
  const people = (
    await db.query<Person>(
      `select e.id, e.employee_code, e.display_name, to_char(e.joining_date, 'YYYY-MM-DD') as joining_date, d.id as department_id, d.code as department_code, d.name as department
         from employee e
         join reference_value st on st.company_id = e.company_id and st.id = e.status_id and st.code <> 'DRAFT'
         left join lateral (select a.department_id from employment_assignment a
                             where a.company_id = e.company_id and a.employee_id = e.id and a.effective_from <= $2::date and (a.effective_to is null or a.effective_to > $2::date)
                             order by a.effective_from desc limit 1) ea on true
         left join department d on d.company_id = e.company_id and d.id = ea.department_id
        where e.company_id = $1 and ${scope} and ${own} and e.joining_date <= $2::date
          and coalesce(hrms_exit_last_working_date(e.company_id, e.id) >= $2::date, true) ${department}
        order by e.employee_code`,
      p.values,
    )
  ).rows;
  const ids = people.map((x) => x.id);
  const byId = new Map(people.map((x) => [x.id, x]));

  const arrangements = new Map<string, ArrangementLine[]>();
  for (const line of (
    await db.query<ArrangementLine>(
      `select sa.employee_id, sa.currency_code, sc.component_id, pc.code, pc.component_kind as kind, sc.amount::text as amount, sc.basis
         from salary_arrangement sa
         join salary_component sc on sc.company_id = sa.company_id and sc.salary_arrangement_id = sa.id
         join pay_component pc on pc.company_id = sc.company_id and pc.id = sc.component_id
        where sa.company_id = $1 and sa.employee_id = any($2::uuid[]) and sa.superseded_at is null
          and sa.effective_from <= $3::date and (sa.effective_to is null or sa.effective_to > $3::date)
        order by pc.code`,
      [companyId, ids, asOf],
    )
  ).rows) {
    arrangements.set(line.employee_id, [...(arrangements.get(line.employee_id) ?? []), line]);
  }
  const heads = new Map(
    (
      await db.query<{ component_id: string; in_use: boolean; head_type: string | null; calculation_basis: string | null }>(
        `select distinct on (h.component_id) h.component_id, h.in_use, h.head_type, h.calculation_basis from payroll_head_revision h
          where h.company_id = $1 and h.state = 'ACTIVE' and h.effective_from <= $2::date order by h.component_id, h.effective_from desc`,
        [companyId, asOf],
      )
    ).rows.map((h) => [h.component_id, h]),
  );
  const minors = new Map((await db.query<{ code: string; minor_unit: number }>(`select code, minor_unit from currency`)).rows.map((c) => [c.code, Number(c.minor_unit)]));
  const policy = await policyInForce(db, companyId, asOf);

  const rows: ProvisionRow[] = [];
  const standing: ItemStanding[] = [];
  const row = (item: ProvisionItem, person: Person, status: string, amount: string | null, currency: string, basis: string, vested = '') =>
    rows.push({
      item,
      status,
      employeeId: person.id,
      employeeCode: person.employee_code,
      employeeName: person.display_name,
      departmentCode: person.department_code ?? '',
      department: person.department ?? '',
      amount,
      currencyCode: currency,
      vested,
      basis,
    });
  const noPolicy = { status: 'NOT_CONFIGURED' as const, reason: 'SETTLEMENT_POLICY_NOT_CONFIGURED', detail: { message: 'No settlement policy is active on the as-on date' } };

  // GRATUITY
  const gratuity = await packInEffect(db, companyId, 'GRATUITY', asOf);
  if (!gratuity || !gratuity.active) {
    standing.push({
      item: 'GRATUITY',
      status: 'NOT_CONFIGURED',
      reason: 'RULE_PACK_NOT_ACTIVE',
      detail: { rulePackCode: 'GRATUITY', packState: gratuity?.pack.state ?? null, message: 'The gratuity rule pack is not active on the as-on date; it is activated only once an authorised person has validated it' },
    });
  } else if (!policy) {
    standing.push({ item: 'GRATUITY', ...noPolicy });
  } else {
    standing.push({ item: 'GRATUITY', status: 'CALCULATED', reason: null, detail: { rulePackCode: 'GRATUITY', packRevision: gratuity.pack.revision, settlementPolicyRevision: policy.revision } });
    const parameters = gratuityParameters(gratuity.pack);
    for (const person of people) {
      const rate = monthlyRate('BASIC_DA', arrangements.get(person.id), policy, heads);
      if ('status' in rate) {
        row('GRATUITY', person, rate.status, null, gratuity.pack.currencyCode, '');
        continue;
      }
      if (rate.currency !== gratuity.pack.currencyCode) {
        row('GRATUITY', person, 'CURRENCY_MISMATCH', null, rate.currency, `pack currency ${gratuity.pack.currencyCode}`);
        continue;
      }
      const service = serviceYears(person.joining_date, asOf, parameters.partYearMonthsOver);
      const amount = gratuityAmount(parameters, rate.monthly, service.countedYears, minors.get(rate.currency) ?? 2);
      row(
        'GRATUITY',
        person,
        'CALCULATED',
        amount.amount,
        rate.currency,
        `${BASIS_LABEL.BASIC_DA} x years of service, under the gratuity pack${amount.capped ? ' (capped)' : ''}`,
        service.completedYears >= parameters.minimumServiceYears ? 'YES' : 'NO',
      );
    }
  }

  // STATUTORY_BONUS
  standing.push({
    item: 'STATUTORY_BONUS',
    status: 'NOT_CONFIGURED',
    reason: 'RULE_PACK_NOT_DEFINED',
    detail: { message: 'No statutory bonus rule pack (Payment of Bonus Act) is defined; one must be supplied and authorised before a bonus provision is calculated' },
  });

  // LEAVE_ENCASHMENT
  if (!policy) standing.push({ item: 'LEAVE_ENCASHMENT', ...noPolicy });
  else if (policy.encashable.length === 0) standing.push({ item: 'LEAVE_ENCASHMENT', status: 'NOT_APPLICABLE', reason: 'NO_ENCASHABLE_LEAVE_TYPE', detail: { settlementPolicyRevision: policy.revision } });
  else {
    standing.push({ item: 'LEAVE_ENCASHMENT', status: 'CALCULATED', reason: null, detail: { settlementPolicyRevision: policy.revision } });
    const caps = new Map(policy.encashable.map((e) => [e.leaveTypeId, e.maxUnits]));
    const balances = (
      await db.query<{ employee_id: string; leave_type_id: string; code: string; balance: string }>(
        `select m.employee_id, m.leave_type_id, t.code, coalesce(sum(m.units), 0)::numeric(12, 4)::text as balance
           from leave_movement m join leave_type t on t.company_id = m.company_id and t.id = m.leave_type_id and t.paid
          where m.company_id = $1 and m.employee_id = any($2::uuid[]) and m.leave_type_id = any($3::uuid[]) and m.effective_date <= $4::date
          group by m.employee_id, m.leave_type_id, t.code
          order by t.code`,
        [companyId, ids, [...caps.keys()], asOf],
      )
    ).rows;
    for (const b of balances.sort((a, c) => byId.get(a.employee_id)!.employee_code.localeCompare(byId.get(c.employee_id)!.employee_code) || a.code.localeCompare(c.code))) {
      if (toUnits(b.balance) <= 0n) continue;
      const person = byId.get(b.employee_id)!;
      const cap = caps.get(b.leave_type_id)!;
      const units = toUnits(b.balance) < toUnits(cap) ? b.balance : fromUnits(toUnits(cap));
      const rateBasis = policy.encashment_rate_basis as RateBasis;
      const rate = monthlyRate(rateBasis, arrangements.get(person.id), policy, heads);
      if ('status' in rate) {
        row('LEAVE_ENCASHMENT', person, rate.status, null, '', `${b.code} balance`);
        continue;
      }
      const amount = dayRateValue(rate.monthly, units, policy.encashment_divisor, minors.get(rate.currency) ?? 2);
      row('LEAVE_ENCASHMENT', person, 'CALCULATED', amount, rate.currency, `${b.code} balance at the day rate of ${BASIS_LABEL[rateBasis] ?? rateBasis}`);
    }
  }

  // NOTICE_PAY
  if (!policy) standing.push({ item: 'NOTICE_PAY', ...noPolicy });
  else {
    standing.push({ item: 'NOTICE_PAY', status: 'CALCULATED', reason: null, detail: { settlementPolicyRevision: policy.revision } });
    const exits = (
      await db.query<{ employee_id: string; separation_type: string; request_date: string; last_working_date: string; notice_days: number | null; waived: boolean }>(
        `select x.employee_id, x.separation_type, to_char(x.request_date, 'YYYY-MM-DD') as request_date, to_char(x.approved_leaving_date, 'YYYY-MM-DD') as last_working_date,
                x.contractual_notice_days as notice_days,
                exists (select 1 from settlement_notice_waiver w where w.company_id = x.company_id and w.exit_case_id = x.id) as waived
           from exit_case x
          where x.company_id = $1 and x.employee_id = any($2::uuid[]) and x.state in ('APPROVED', 'SEPARATED')
            and x.request_date <= $3::date and x.approved_leaving_date >= $3::date
          order by x.approved_leaving_date`,
        [companyId, ids, asOf],
      )
    ).rows;
    for (const x of exits.sort((a, b) => byId.get(a.employee_id)!.employee_code.localeCompare(byId.get(b.employee_id)!.employee_code))) {
      const person = byId.get(x.employee_id)!;
      const rule = ruleOf(x.separation_type).notice;
      if (rule === 'NONE') continue;
      if (x.notice_days === null) {
        row('NOTICE_PAY', person, 'NOTICE_PERIOD_NOT_RECORDED', null, '', `${x.separation_type}: contractual notice not recorded`);
        continue;
      }
      const notice = noticeShortfall(x.request_date, x.last_working_date, x.notice_days);
      if (notice.shortfall === 0) continue;
      const what = `${x.separation_type}: notice shortfall`;
      if (rule === 'RECOVERED' && x.waived) {
        row('NOTICE_PAY', person, 'WAIVED', null, '', what);
        continue;
      }
      const rateBasis = policy.notice_rate_basis as RateBasis;
      const rate = monthlyRate(rateBasis, arrangements.get(person.id), policy, heads);
      if ('status' in rate) {
        row('NOTICE_PAY', person, rate.status, null, '', what);
        continue;
      }
      const value = dayRateValue(rate.monthly, String(notice.shortfall), policy.notice_divisor, minors.get(rate.currency) ?? 2);
      row('NOTICE_PAY', person, 'CALCULATED', rule === 'RECOVERED' ? negate(value) : value, rate.currency, `${what} at the day rate of ${BASIS_LABEL[rateBasis] ?? rateBasis}${rule === 'RECOVERED' ? ', recoverable' : ', pay in lieu'}`);
    }
  }
  return { asOf, scope: isCompanyWide(grant) ? 'COMPANY' : 'ROW_SCOPE', standing, rows, employees: people.length };
}

const addTo = (m: Map<string, bigint>, key: string, amount: string) => m.set(key, (m.get(key) ?? 0n) + toUnits(amount));

/** The JSON screen: each item's standing with its totals (per currency), the totals by department, and the employee rows. */
export async function liabilityProvisions(db: Queryable, grant: AccessGrant, q: { asOf: string; departmentId?: string | undefined }) {
  const { asOf, scope, standing, rows, employees } = await provisionRows(db, grant, q);
  const calculated = rows.filter((r) => r.status === 'CALCULATED' && r.amount !== null);
  const items = standing.map((s) => {
    const totals = new Map<string, bigint>();
    for (const r of calculated.filter((x) => x.item === s.item)) addTo(totals, r.currencyCode, r.amount!);
    return {
      ...s,
      totals: [...totals].map(([currencyCode, units]) => ({ currencyCode, amount: fromUnits(units) })),
      rows: rows.filter((r) => r.item === s.item).length,
      unresolved: rows.filter((r) => r.item === s.item && r.status !== 'CALCULATED' && r.status !== 'WAIVED').length,
    };
  });
  const departments = new Map<string, { departmentCode: string; department: string; currencyCode: string; byItem: Map<string, bigint> }>();
  for (const r of calculated) {
    const key = `${r.departmentCode}|${r.currencyCode}`;
    const d = departments.get(key) ?? { departmentCode: r.departmentCode, department: r.department, currencyCode: r.currencyCode, byItem: new Map<string, bigint>() };
    addTo(d.byItem, r.item, r.amount!);
    departments.set(key, d);
  }
  return {
    asOf,
    scope,
    employees,
    items,
    departments: [...departments.values()]
      .sort((a, b) => a.departmentCode.localeCompare(b.departmentCode) || a.currencyCode.localeCompare(b.currencyCode))
      .map((d) => ({
        departmentCode: d.departmentCode,
        department: d.department,
        currencyCode: d.currencyCode,
        amounts: Object.fromEntries(PROVISION_ITEMS.filter((i) => d.byItem.has(i)).map((i) => [i, fromUnits(d.byItem.get(i)!)])),
        total: fromUnits([...d.byItem.values()].reduce((s, v) => s + v, 0n)),
      })),
    rows,
  };
}

/** The report's rows: each employee row, and one row naming each item that is not calculated (with its reason, never a number). */
export async function provisionReportRows(db: Queryable, grant: AccessGrant, q: { asOf: string; departmentId?: string | undefined }): Promise<Record<string, unknown>[]> {
  const { standing, rows } = await provisionRows(db, grant, q);
  const out: Record<string, unknown>[] = [];
  for (const s of standing) {
    if (s.status !== 'CALCULATED') {
      out.push({ item: s.item, status: s.status, employee_code: '', employee_name: '', department_code: '', department: '', amount: '', currency: '', vested: '', basis: s.reason ?? '' });
      continue;
    }
    for (const r of rows.filter((x) => x.item === s.item)) {
      out.push({
        item: r.item,
        status: r.status,
        employee_code: r.employeeCode,
        employee_name: r.employeeName,
        department_code: r.departmentCode,
        department: r.department,
        amount: r.amount ?? '',
        currency: r.currencyCode,
        vested: r.vested,
        basis: r.basis,
      });
    }
  }
  return out;
}
