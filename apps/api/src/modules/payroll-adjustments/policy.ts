// The valuation policy (FR-035, FR-100; H2; BR-048; migration 0205). Decided under owner delegation, 6 Nov 2026 (docs/03 I-79): how
// approved arrears and late-timesheet adjustments are paid is a dated company setting, written by one person with the payroll
// configuration duty and activated by another, never a constant. It names the pay components they are paid through (EARNING heads on
// the INPUT basis) and recovered through (a DEDUCTION head on the INPUT basis; without one a negative case is not approved), and what
// one timesheet unit is: a day of the origin month, or an hour of such a day.
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import type { AccessGrant } from '../access/authorize.js';
import { actorOf, advisoryLock, audit, requireCompanyScope } from '../payroll/common.js';

const VIEW = `select v.id, v.revision, to_char(v.effective_from, 'YYYY-MM-DD') as "effectiveFrom", ac.code as "arrearsComponentCode",
    dc.code as "adjustmentComponentCode", rc.code as "recoveryComponentCode", v.timesheet_unit as "timesheetUnit",
    v.hours_per_day::text as "hoursPerDay", v.state, v.created_by as "createdBy", v.activated_by as "activatedBy", v.activated_at as "activatedAt", v.version
  from payroll_valuation_policy v
  join pay_component ac on ac.company_id = v.company_id and ac.id = v.arrears_component_id
  join pay_component dc on dc.company_id = v.company_id and dc.id = v.adjustment_component_id
  left join pay_component rc on rc.company_id = v.company_id and rc.id = v.recovery_component_id`;

export interface ValuationPolicyInput {
  effectiveFrom: string;
  arrearsComponentCode: string;
  adjustmentComponentCode: string;
  recoveryComponentCode?: string | null | undefined;
  timesheetUnit: 'DAY' | 'HOUR';
  hoursPerDay?: string | null | undefined;
}

const stale = (): never => {
  throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
};

export async function listValuationPolicies(db: Queryable, grant: AccessGrant) {
  return { items: (await db.query(`${VIEW} where v.company_id = $1 order by v.revision`, [grant.companyId])).rows };
}

/** The component of `code`, whose head in effect on `day` is of `headType` on the INPUT basis (the amount is the case's, not a rate). */
async function componentWithHead(tx: Queryable, companyId: string, code: string, headType: 'EARNING' | 'DEDUCTION', day: string, field: string): Promise<string> {
  const c = (
    await tx.query<{ id: string; head_type: string | null; calculation_basis: string | null }>(
      `select pc.id, h.head_type, h.calculation_basis
         from pay_component pc
         left join lateral (select h.head_type, h.calculation_basis from payroll_head_revision h
                             where h.company_id = pc.company_id and h.component_id = pc.id and h.state = 'ACTIVE' and h.effective_from <= $3::date
                             order by h.effective_from desc limit 1) h on true
        where pc.company_id = $1 and pc.code = $2`,
      [companyId, code.trim().toUpperCase(), day],
    )
  ).rows[0];
  if (!c) throw new HttpError(422, 'UNKNOWN_COMPONENT', 'A pay component is not defined in this company', { field, componentCode: code });
  if (c.head_type !== headType || c.calculation_basis !== 'INPUT') {
    throw new HttpError(422, 'COMPONENT_HEAD_INVALID', `This component needs an active ${headType} head on the INPUT basis from that date`, { field, componentCode: code });
  }
  return c.id;
}

export async function createValuationPolicy(tx: Queryable, grant: AccessGrant, input: ValuationPolicyInput) {
  requireCompanyScope(grant);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom) || Number.isNaN(Date.parse(`${input.effectiveFrom}T00:00:00Z`))) {
    throw new HttpError(422, 'INVALID_DATE', 'The effective date is not a valid date', { field: 'effectiveFrom' });
  }
  let hours: string | null = null;
  if (input.timesheetUnit === 'HOUR') {
    hours = input.hoursPerDay ?? null;
    if (!hours || !/^\d{1,2}(\.\d{1,2})?$/.test(hours) || Number(hours) <= 0 || Number(hours) > 24) {
      throw new HttpError(422, 'HOURS_REQUIRED', 'State the hours of one day (more than 0, at most 24) when a timesheet unit is an hour', { field: 'hoursPerDay' });
    }
  } else if (input.hoursPerDay !== undefined && input.hoursPerDay !== null) {
    throw new HttpError(422, 'HOURS_NOT_ALLOWED', 'Hours per day apply only when a timesheet unit is an hour', { field: 'hoursPerDay' });
  }
  await advisoryLock(tx, `payroll_valuation:${grant.companyId}`);
  await reassertAccess(tx, grant, 'payroll_config', 'manage', ['operational']);
  const arrears = await componentWithHead(tx, grant.companyId, input.arrearsComponentCode, 'EARNING', input.effectiveFrom, 'arrearsComponentCode');
  const adjustment = await componentWithHead(tx, grant.companyId, input.adjustmentComponentCode, 'EARNING', input.effectiveFrom, 'adjustmentComponentCode');
  const recovery = input.recoveryComponentCode ? await componentWithHead(tx, grant.companyId, input.recoveryComponentCode, 'DEDUCTION', input.effectiveFrom, 'recoveryComponentCode') : null;
  const id = (
    await tx.query<{ id: string }>(
      `insert into payroll_valuation_policy (company_id, revision, effective_from, arrears_component_id, adjustment_component_id, recovery_component_id, timesheet_unit,
                                             hours_per_day, state, created_by, updated_by)
       select $1, coalesce(max(revision), 0) + 1, $2::date, $3, $4, $5, $6, $7::numeric, 'DRAFT', $8, $8 from payroll_valuation_policy where company_id = $1
       returning id`,
      [grant.companyId, input.effectiveFrom, arrears, adjustment, recovery, input.timesheetUnit, hours, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, actorOf(grant), 'payroll_valuation_policy', id, 'CREATE', null, {
    operational: {
      effectiveFrom: input.effectiveFrom,
      arrearsComponentCode: input.arrearsComponentCode,
      adjustmentComponentCode: input.adjustmentComponentCode,
      recoveryComponentCode: input.recoveryComponentCode ?? null,
      timesheetUnit: input.timesheetUnit,
      hoursPerDay: hours,
    },
  });
  return (await tx.query(`${VIEW} where v.company_id = $1 and v.id = $2`, [grant.companyId, id])).rows[0];
}

/** By someone other than its author; an active policy of the same start date is superseded. */
export async function activateValuationPolicy(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }) {
  requireCompanyScope(grant);
  await advisoryLock(tx, `payroll_valuation:${grant.companyId}`);
  const p = (
    await tx.query<{ state: string; created_by: string | null; version: number; effective_from: string }>(
      `select state, created_by, version, effective_from from payroll_valuation_policy where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!p) throw notFound();
  await reassertAccess(tx, grant, 'payroll_config', 'activate', ['operational']);
  if (p.version !== input.expectedVersion) stale();
  if (p.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft policy can be activated');
  if (p.created_by === grant.userId) throw new HttpError(403, 'SELF_APPROVAL', 'A policy is activated by someone other than its author');
  await tx.query(`update payroll_valuation_policy set state = 'SUPERSEDED', updated_by = $3 where company_id = $1 and effective_from = $2::date and state = 'ACTIVE'`, [
    grant.companyId,
    p.effective_from,
    grant.userId,
  ]);
  await tx.query(`update payroll_valuation_policy set state = 'ACTIVE', activated_by = $3, activated_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [
    grant.companyId,
    id,
    grant.userId,
  ]);
  await audit(tx, actorOf(grant), 'payroll_valuation_policy', id, 'ACTIVATE', { operational: { state: 'DRAFT' } }, { operational: { state: 'ACTIVE' } });
  return (await tx.query(`${VIEW} where v.company_id = $1 and v.id = $2`, [grant.companyId, id])).rows[0];
}
