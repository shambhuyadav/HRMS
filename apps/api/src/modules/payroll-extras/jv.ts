// Salary journal voucher (BRD coverage CL-097 "Salary JV", under FR-038 "JV" and DF07). Built 11 Nov 2026 from the reference system's
// "GL Mapping" and "Salary JV" screens; decided under owner delegation, 6 Nov 2026. The owner's chart of accounts is not available, so
// nothing is mapped until the company records its own accounts; until then the JV reads NOT_CONFIGURED.
//
// GL mapping: dated revisions, never overwritten (0270): each names the net pay (salary payable) account and, per pay head, the ledger
// account it posts to, plus, for an employer contribution, the liability account its cost is credited to. The revision in force for a
// run is the latest effective on or before the period's last day. Company configuration under payroll_gl_mapping.manage, audited.
//
// The voucher of one APPROVED or PROCESSED_LOCKED run, from its calculated records' lines (the register's amounts):
//   Dr  each earning, reimbursement and employer contribution head's account, by cost centre (the employee's department on the period's
//       last day);
//   Cr  each deduction head's account, and each employer contribution's liability account (company totals, no cost centre);
//   Cr  the net pay account, the run's total net (debited instead if it were negative).
// Debits equal credits because a record's net is its earnings and reimbursements less its deductions (DF05). Company figures: every
// record of the run must be in the requester's scope (payroll-outputs requireWholePayrollRun). NOT_CONFIGURED names what is missing: no
// revision in force, a head of the run without an account, or an employer contribution without its liability account.
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { fromUnits, toUnits } from '../lifecycle/settlement-formulas.js';
import { requireWholePayrollRun } from '../payroll-outputs/reports.js';
import { auditChange, isIsoDate, linkedToRun, optionalText, requireCompanyWide, requireText } from './common.js';

const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/;
export const JV_RUN_STATES = ['APPROVED', 'PROCESSED_LOCKED'] as const;

export interface GlMappingInput {
  effectiveFrom: string;
  netPayAccountCode: string;
  netPayAccountName?: string | null | undefined;
  reason: string;
  lines: { componentCode: string; accountCode: string; accountName?: string | null | undefined; payableAccountCode?: string | null | undefined; payableAccountName?: string | null | undefined }[];
}

const MAPPING_VIEW = `select m.id, m.revision, to_char(m.effective_from, 'YYYY-MM-DD') as "effectiveFrom", m.net_pay_account_code as "netPayAccountCode",
    m.net_pay_account_name as "netPayAccountName", m.reason, m.created_at as "createdAt", m.created_by as "createdBy",
    coalesce((select json_agg(json_build_object('componentCode', pc.code, 'componentName', pc.name, 'accountCode', l.account_code, 'accountName', l.account_name,
                                                'payableAccountCode', l.payable_account_code, 'payableAccountName', l.payable_account_name) order by pc.code)
                from payroll_gl_mapping_line l join pay_component pc on pc.company_id = l.company_id and pc.id = l.component_id
               where l.company_id = m.company_id and l.mapping_id = m.id), '[]'::json) as lines
  from payroll_gl_mapping m`;

/** Every revision, newest first, and the one in force on `day`. */
export async function listGlMappings(db: Queryable, grant: AccessGrant, day: string) {
  const items = (await db.query(`${MAPPING_VIEW} where m.company_id = $1 order by m.effective_from desc, m.revision desc`, [grant.companyId])).rows as { effectiveFrom: string }[];
  return { asOf: day, inForce: items.find((i) => i.effectiveFrom <= day) ?? null, items };
}

export async function createGlMapping(tx: Queryable, grant: AccessGrant, input: GlMappingInput) {
  requireCompanyWide(grant);
  if (!isIsoDate(input.effectiveFrom)) throw new HttpError(422, 'INVALID_DATE', 'effectiveFrom must be a date (YYYY-MM-DD)', { field: 'effectiveFrom' });
  const account = (v: unknown, field: string) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!ACCOUNT.test(s)) throw new HttpError(422, 'INVALID_ACCOUNT', `${field}: an account code is 1 to 40 letters, digits, . _ / or -, starting with a letter or digit`, { field });
    return s;
  };
  const netPay = account(input.netPayAccountCode, 'netPayAccountCode');
  const netPayName = optionalText(input.netPayAccountName, 'netPayAccountName', 120);
  const reason = requireText(input.reason, 'reason', 500);
  if (input.lines.length === 0) throw new HttpError(422, 'NO_LINES', 'Map at least one pay head');
  const codes = input.lines.map((l) => l.componentCode.trim().toUpperCase());
  if (new Set(codes).size !== codes.length) throw new HttpError(422, 'DUPLICATE_HEAD', 'Each pay head is mapped once per revision');
  const components = new Map(
    (await tx.query<{ id: string; code: string }>(`select id, code from pay_component where company_id = $1 and code = any($2::text[])`, [grant.companyId, codes])).rows.map((c) => [c.code, c.id]),
  );
  const unknown = codes.filter((c) => !components.has(c));
  if (unknown.length > 0) throw new HttpError(422, 'UNKNOWN_COMPONENT', 'Some pay heads are not components of this company', { componentCodes: unknown });
  const lines = input.lines.map((l, i) => ({
    componentId: components.get(codes[i]!)!,
    componentCode: codes[i]!,
    accountCode: account(l.accountCode, `lines[${i}].accountCode`),
    accountName: optionalText(l.accountName, `lines[${i}].accountName`, 120),
    payableAccountCode: l.payableAccountCode === undefined || l.payableAccountCode === null || String(l.payableAccountCode).trim() === '' ? null : account(l.payableAccountCode, `lines[${i}].payableAccountCode`),
    payableAccountName: optionalText(l.payableAccountName, `lines[${i}].payableAccountName`, 120),
  }));
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`payroll_gl_mapping:${grant.companyId}`]);
  const row = (
    await tx.query<{ id: string; revision: number }>(
      `insert into payroll_gl_mapping (company_id, revision, effective_from, net_pay_account_code, net_pay_account_name, reason, created_by, acting_assignment_id)
       select $1, coalesce(max(revision), 0) + 1, $2, $3, $4, $5, $6, $7 from payroll_gl_mapping where company_id = $1
       returning id, revision`,
      [grant.companyId, input.effectiveFrom, netPay, netPayName, reason, grant.userId, grant.assignmentId],
    )
  ).rows[0]!;
  for (const l of lines) {
    await tx.query(
      `insert into payroll_gl_mapping_line (company_id, mapping_id, component_id, account_code, account_name, payable_account_code, payable_account_name)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [grant.companyId, row.id, l.componentId, l.accountCode, l.accountName, l.payableAccountCode, l.payableAccountName],
    );
  }
  await auditChange(tx, grant, {
    resource: 'payroll_gl_mapping',
    recordKey: row.id,
    action: 'CREATE',
    newVersion: 1,
    after: {
      operational: {
        revision: row.revision,
        effectiveFrom: input.effectiveFrom,
        netPayAccountCode: netPay,
        lines: lines.map((l) => ({ componentCode: l.componentCode, accountCode: l.accountCode, payableAccountCode: l.payableAccountCode })),
      },
    },
    reason,
  });
  return (await tx.query(`${MAPPING_VIEW} where m.company_id = $1 and m.id = $2`, [grant.companyId, row.id])).rows[0]!;
}

export interface JvLine {
  side: 'DEBIT' | 'CREDIT';
  accountCode: string;
  accountName: string;
  costCentre: string;
  componentCode: string;
  narration: string;
  amount: string;
}

/**
 * The voucher of a run, or NOT_CONFIGURED with what is missing. Throws 409 for a run that is neither approved nor processed, and 403
 * SELF_INCLUDED when the requester is or was (in any period) linked to anyone with a record in the run: the voucher's totals hold that
 * person's pay (C4), so someone else prepares it.
 */
export async function salaryJv(db: Queryable, grant: AccessGrant, runId: string) {
  await requireWholePayrollRun(db, grant, runId);
  // requireWholePayrollRun passes any unrestricted company scope without looking (payroll/common.ts unrestricted), so a scoped DENY of
  // the report grant on another assignment of the user (C1) is checked here: the voucher's totals hold every record of the run.
  if (grant.deniedScopes.length > 0) {
    const p = new SqlParams([grant.companyId, runId]);
    const inScope = employeeScopePredicate(grant, { company: 'r.company_id', employee: 'r.employee_id' }, p);
    const outside = (await db.query<{ hit: boolean }>(`select exists (select 1 from payroll_record r where r.company_id = $1 and r.run_id = $2 and not ${inScope}) as hit`, p.values)).rows[0];
    if (outside?.hit) throw new HttpError(403, 'SCOPE_INCOMPLETE', 'This run includes employees outside your scope; its journal voucher must be prepared by someone whose scope covers all of them');
  }
  if (await linkedToRun(db, grant.companyId, grant.userId, runId)) throw new HttpError(403, 'SELF_INCLUDED', 'Your own pay is in this run; someone else prepares its journal voucher');
  const run = (
    await db.query<{ state: string; revision: number; period_code: string; service_end: string; payment_date: string; currency_code: string }>(
      `select ru.state, ru.revision, p.period_code, to_char(ru.service_end, 'YYYY-MM-DD') as service_end, to_char(ru.payment_date, 'YYYY-MM-DD') as payment_date, ru.currency_code
         from payroll_run ru join payroll_period p on p.company_id = ru.company_id and p.id = ru.period_id
        where ru.company_id = $1 and ru.id = $2`,
      [grant.companyId, runId],
    )
  ).rows[0];
  if (!run) throw notFound();
  if (!(JV_RUN_STATES as readonly string[]).includes(run.state)) {
    throw new HttpError(409, 'RUN_NOT_APPROVED', 'A journal voucher is prepared from an approved or processed payroll run only', { state: run.state });
  }
  const header = { runId, runRevision: run.revision, runState: run.state, periodCode: run.period_code, voucherDate: run.payment_date, currencyCode: run.currency_code };
  const mapping = (
    await db.query<{ id: string; revision: number; net_pay_account_code: string; net_pay_account_name: string | null }>(
      `select id, revision, net_pay_account_code, net_pay_account_name from payroll_gl_mapping
        where company_id = $1 and effective_from <= $2::date order by effective_from desc, revision desc limit 1`,
      [grant.companyId, run.service_end],
    )
  ).rows[0];
  const sums = (
    await db.query<{ component_id: string; code: string; name: string; head_type: string; department_code: string | null; amount: string }>(
      `select l.component_id, pc.code, pc.name, l.head_type, d.code as department_code, sum(l.amount)::numeric(19, 4)::text as amount
         from payroll_line l
         join payroll_record r on r.company_id = l.company_id and r.id = l.record_id and r.run_id = $2 and r.calculation_status = 'CALCULATED'
         join pay_component pc on pc.company_id = l.company_id and pc.id = l.component_id
         left join lateral (select a.department_id from employment_assignment a
                             where a.company_id = r.company_id and a.employee_id = r.employee_id and a.effective_from <= $3::date and (a.effective_to is null or a.effective_to > $3::date)
                             order by a.effective_from desc limit 1) ea on true
         left join department d on d.company_id = r.company_id and d.id = ea.department_id
        where l.company_id = $1
        group by l.component_id, pc.code, pc.name, l.head_type, d.code
        order by pc.code, d.code nulls first`,
      [grant.companyId, runId, run.service_end],
    )
  ).rows;
  const net = (
    await db.query<{ net: string }>(`select coalesce(sum(net), 0)::numeric(19, 4)::text as net from payroll_record where company_id = $1 and run_id = $2 and calculation_status = 'CALCULATED'`, [
      grant.companyId,
      runId,
    ])
  ).rows[0]!.net;
  if (!mapping) {
    return { ...header, status: 'NOT_CONFIGURED', reason: 'NO_GL_MAPPING', missing: [] as { componentCode: string; problem: string }[], mappingRevision: null, lines: [] as JvLine[], totals: null };
  }
  const accounts = new Map(
    (
      await db.query<{ component_id: string; account_code: string; account_name: string | null; payable_account_code: string | null; payable_account_name: string | null }>(
        `select component_id, account_code, account_name, payable_account_code, payable_account_name from payroll_gl_mapping_line where company_id = $1 and mapping_id = $2`,
        [grant.companyId, mapping.id],
      )
    ).rows.map((a) => [a.component_id, a]),
  );
  const missing = new Map<string, string>();
  for (const s of sums) {
    const a = accounts.get(s.component_id);
    if (!a) missing.set(s.code, 'NO_ACCOUNT');
    else if (s.head_type === 'EMPLOYER_CONTRIBUTION' && !a.payable_account_code) missing.set(s.code, 'NO_PAYABLE_ACCOUNT');
  }
  if (missing.size > 0) {
    return {
      ...header,
      status: 'NOT_CONFIGURED',
      reason: 'HEADS_NOT_MAPPED',
      missing: [...missing].map(([componentCode, problem]) => ({ componentCode, problem })),
      mappingRevision: mapping.revision,
      lines: [] as JvLine[],
      totals: null,
    };
  }
  const lines: JvLine[] = [];
  const credits = new Map<string, JvLine>();
  const credit = (accountCode: string, accountName: string, componentCode: string, narration: string, amount: string) => {
    const key = `${accountCode}|${componentCode}`;
    const c = credits.get(key) ?? { side: 'CREDIT' as const, accountCode, accountName, costCentre: '', componentCode, narration, amount: '0.0000' };
    c.amount = fromUnits(toUnits(c.amount) + toUnits(amount));
    credits.set(key, c);
  };
  for (const s of sums) {
    const a = accounts.get(s.component_id)!;
    if (toUnits(s.amount) === 0n) continue;
    if (s.head_type === 'DEDUCTION') {
      credit(a.account_code, a.account_name ?? '', s.code, `${s.name} deducted, ${run.period_code}`, s.amount);
      continue;
    }
    lines.push({ side: 'DEBIT', accountCode: a.account_code, accountName: a.account_name ?? '', costCentre: s.department_code ?? '', componentCode: s.code, narration: `${s.name}, ${run.period_code}`, amount: s.amount });
    if (s.head_type === 'EMPLOYER_CONTRIBUTION') credit(a.payable_account_code!, a.payable_account_name ?? '', s.code, `${s.name} payable, ${run.period_code}`, s.amount);
  }
  lines.push(...[...credits.values()].sort((x, y) => x.componentCode.localeCompare(y.componentCode)));
  const netUnits = toUnits(net);
  if (netUnits !== 0n) {
    lines.push({
      side: netUnits > 0n ? 'CREDIT' : 'DEBIT',
      accountCode: mapping.net_pay_account_code,
      accountName: mapping.net_pay_account_name ?? '',
      costCentre: '',
      componentCode: '',
      narration: `Net salary payable, ${run.period_code}`,
      amount: fromUnits(netUnits < 0n ? -netUnits : netUnits),
    });
  }
  const total = (side: JvLine['side']) => lines.filter((l) => l.side === side).reduce((s, l) => s + toUnits(l.amount), 0n);
  const debit = total('DEBIT');
  const creditTotal = total('CREDIT');
  return {
    ...header,
    status: 'READY',
    reason: null,
    missing: [] as { componentCode: string; problem: string }[],
    mappingRevision: mapping.revision,
    lines,
    totals: { debit: fromUnits(debit), credit: fromUnits(creditTotal), balanced: debit === creditTotal },
  };
}

/** The report's rows (SALARY_JV): the voucher's lines; a voucher that is not configured refuses (409 NOT_CONFIGURED). */
export async function salaryJvRows(db: Queryable, grant: AccessGrant, runId: string): Promise<Record<string, unknown>[]> {
  const jv = await salaryJv(db, grant, runId);
  if (jv.status !== 'READY') throw new HttpError(409, 'NOT_CONFIGURED', 'The salary JV needs a GL mapping in force with an account for every pay head of the run', { reason: jv.reason, missing: jv.missing });
  return jv.lines.map((l) => ({
    voucher_date: jv.voucherDate,
    period_code: jv.periodCode,
    account_code: l.accountCode,
    account_name: l.accountName,
    cost_centre: l.costCentre,
    pay_head: l.componentCode,
    narration: l.narration,
    debit: l.side === 'DEBIT' ? l.amount : '',
    credit: l.side === 'CREDIT' ? l.amount : '',
    currency: jv.currencyCode,
  }));
}
