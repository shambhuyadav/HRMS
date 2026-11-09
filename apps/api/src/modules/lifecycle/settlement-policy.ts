// The full-and-final settlement policy (FR-052 "eligibility, gratuity/other benefits and notice calculations need explicit payroll
// policy"; migration 0235). Decided under owner delegation, 6 Nov 2026 (docs/03 I-88): a dated company setting written by one person
// with the payroll configuration duty and activated by another, never a constant. It names the pay components that stand for Basic
// and DA, the components a calculated encashment, notice recovery and gratuity are paid or recovered on, the daily-rate basis and
// divisor of encashment and of notice recovery, and the encashable leave types with the most units each encashes. The revision in
// force on an employee's last working date is the one their settlement is calculated under.
//
// Defaults (for a field left out when a draft is written; HR changes any of them by writing a new revision): encashment on Basic + DA
// / 30, notice recovery on the monthly gross (every FIXED earning) / 30, an encashable type capped at 30 units. Basic must be named,
// and no leave type is encashable unless listed.
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import type { AccessGrant } from '../access/authorize.js';
import { actorOf, advisoryLock, audit, isIsoDate } from './common.js';

export const RATE_BASES = ['BASIC', 'BASIC_DA', 'GROSS'] as const;
export type RateBasis = (typeof RATE_BASES)[number];
export const POLICY_DEFAULTS = { encashmentRateBasis: 'BASIC_DA', encashmentDivisor: 30, noticeRateBasis: 'GROSS', noticeDivisor: 30, encashableMaxUnits: '30' } as const;

export interface SettlementPolicyRow {
  id: string;
  revision: number;
  effective_from: string;
  basic_component_id: string;
  da_component_id: string | null;
  encashment_component_id: string | null;
  encashment_rate_basis: RateBasis;
  encashment_divisor: number;
  notice_component_id: string | null;
  notice_rate_basis: RateBasis;
  notice_divisor: number;
  gratuity_component_id: string | null;
}

/** The ACTIVE revision in force on `day` (the latest start on or before it), with its encashable types; null when there is none. */
export async function policyInForce(db: Queryable, companyId: string, day: string): Promise<(SettlementPolicyRow & { encashable: { leaveTypeId: string; maxUnits: string }[] }) | null> {
  const p = (
    await db.query<SettlementPolicyRow>(
      `select id, revision, to_char(effective_from, 'YYYY-MM-DD') as effective_from, basic_component_id, da_component_id, encashment_component_id, encashment_rate_basis,
              encashment_divisor, notice_component_id, notice_rate_basis, notice_divisor, gratuity_component_id
         from settlement_policy where company_id = $1 and state = 'ACTIVE' and effective_from <= $2::date order by effective_from desc limit 1`,
      [companyId, day],
    )
  ).rows[0];
  if (!p) return null;
  const encashable = (
    await db.query<{ leaveTypeId: string; maxUnits: string }>(
      `select leave_type_id as "leaveTypeId", max_units::text as "maxUnits" from settlement_policy_encashable where company_id = $1 and policy_id = $2 order by leave_type_id`,
      [companyId, p.id],
    )
  ).rows;
  return { ...p, encashable };
}

const VIEW = `select v.id, v.revision, to_char(v.effective_from, 'YYYY-MM-DD') as "effectiveFrom", b.code as "basicComponentCode", da.code as "daComponentCode",
    ec.code as "encashmentComponentCode", v.encashment_rate_basis as "encashmentRateBasis", v.encashment_divisor as "encashmentDivisor",
    nc.code as "noticeComponentCode", v.notice_rate_basis as "noticeRateBasis", v.notice_divisor as "noticeDivisor", gc.code as "gratuityComponentCode",
    coalesce((select json_agg(json_build_object('leaveType', t.code, 'maxUnits', x.max_units::text) order by t.code)
                from settlement_policy_encashable x join leave_type t on t.company_id = x.company_id and t.id = x.leave_type_id
               where x.company_id = v.company_id and x.policy_id = v.id), '[]'::json) as encashable,
    v.state, v.created_by as "createdBy", v.activated_by as "activatedBy", v.activated_at as "activatedAt", v.version
  from settlement_policy v
  join pay_component b on b.company_id = v.company_id and b.id = v.basic_component_id
  left join pay_component da on da.company_id = v.company_id and da.id = v.da_component_id
  left join pay_component ec on ec.company_id = v.company_id and ec.id = v.encashment_component_id
  left join pay_component nc on nc.company_id = v.company_id and nc.id = v.notice_component_id
  left join pay_component gc on gc.company_id = v.company_id and gc.id = v.gratuity_component_id`;

export async function listSettlementPolicies(db: Queryable, grant: AccessGrant) {
  return { defaults: POLICY_DEFAULTS, rateBases: RATE_BASES, items: (await db.query(`${VIEW} where v.company_id = $1 order by v.revision`, [grant.companyId])).rows };
}

export interface SettlementPolicyInput {
  effectiveFrom: string;
  basicComponentCode: string;
  daComponentCode?: string | null | undefined;
  encashmentComponentCode?: string | null | undefined;
  encashmentRateBasis?: RateBasis | undefined;
  encashmentDivisor?: number | undefined;
  encashable?: { leaveType: string; maxUnits?: string | undefined }[] | undefined;
  noticeComponentCode?: string | null | undefined;
  noticeRateBasis?: RateBasis | undefined;
  noticeDivisor?: number | undefined;
  gratuityComponentCode?: string | null | undefined;
}

async function component(tx: Queryable, companyId: string, code: string | null | undefined, kind: 'EARNING' | 'DEDUCTION', field: string): Promise<string | null> {
  if (code === undefined || code === null || code.trim() === '') return null;
  const c = (await tx.query<{ id: string; kind: string; active: boolean }>(`select id, component_kind as kind, active from pay_component where company_id = $1 and code = $2`, [companyId, code.trim().toUpperCase()])).rows[0];
  if (!c || !c.active) throw new HttpError(422, 'UNKNOWN_COMPONENT', 'An active pay component of that code is not defined in this company', { field, componentCode: code });
  if (c.kind !== kind) throw new HttpError(422, 'COMPONENT_KIND_INVALID', `This component must be ${kind === 'EARNING' ? 'an earning' : 'a deduction'}`, { field, componentCode: code });
  return c.id;
}

const divisor = (v: number | undefined, fallback: number, field: string): number => {
  const d = v ?? fallback;
  if (!Number.isInteger(d) || d < 1 || d > 31) throw new HttpError(422, 'INVALID_DIVISOR', 'A divisor is a whole number of days from 1 to 31', { field });
  return d;
};

export async function createSettlementPolicy(tx: Queryable, grant: AccessGrant, input: SettlementPolicyInput) {
  if (!isIsoDate(input.effectiveFrom)) throw new HttpError(422, 'INVALID_DATE', 'The effective date is not a valid date', { field: 'effectiveFrom' });
  const encashmentDivisor = divisor(input.encashmentDivisor, POLICY_DEFAULTS.encashmentDivisor, 'encashmentDivisor');
  const noticeDivisor = divisor(input.noticeDivisor, POLICY_DEFAULTS.noticeDivisor, 'noticeDivisor');
  const encashmentRateBasis = input.encashmentRateBasis ?? POLICY_DEFAULTS.encashmentRateBasis;
  const noticeRateBasis = input.noticeRateBasis ?? POLICY_DEFAULTS.noticeRateBasis;
  await advisoryLock(tx, `settlement_policy:${grant.companyId}`);
  await reassertAccess(tx, grant, 'payroll_config', 'manage', ['operational']);
  const basic = await component(tx, grant.companyId, input.basicComponentCode, 'EARNING', 'basicComponentCode');
  if (!basic) throw new HttpError(422, 'BASIC_COMPONENT_REQUIRED', 'Name the pay component that stands for Basic', { field: 'basicComponentCode' });
  const da = await component(tx, grant.companyId, input.daComponentCode, 'EARNING', 'daComponentCode');
  if (da === basic) throw new HttpError(422, 'DA_IS_BASIC', 'DA and Basic are different components', { field: 'daComponentCode' });
  const encashment = await component(tx, grant.companyId, input.encashmentComponentCode, 'EARNING', 'encashmentComponentCode');
  const notice = await component(tx, grant.companyId, input.noticeComponentCode, 'DEDUCTION', 'noticeComponentCode');
  const gratuity = await component(tx, grant.companyId, input.gratuityComponentCode, 'EARNING', 'gratuityComponentCode');
  const encashable: { leaveTypeId: string; code: string; maxUnits: string }[] = [];
  for (const [i, e] of (input.encashable ?? []).entries()) {
    const t = (await tx.query<{ id: string; paid: boolean }>(`select id, paid from leave_type where company_id = $1 and code = $2 and active`, [grant.companyId, e.leaveType.trim().toUpperCase()])).rows[0];
    if (!t) throw new HttpError(422, 'UNKNOWN_LEAVE_TYPE', 'An active leave type of that code is not defined', { field: 'encashable', index: i, leaveType: e.leaveType });
    if (!t.paid) throw new HttpError(422, 'LEAVE_TYPE_NOT_PAID', 'Only a paid leave type is encashable', { field: 'encashable', index: i, leaveType: e.leaveType });
    const maxUnits = e.maxUnits ?? POLICY_DEFAULTS.encashableMaxUnits;
    if (!/^\d{1,4}(\.\d{1,4})?$/.test(maxUnits) || Number(maxUnits) <= 0) throw new HttpError(422, 'INVALID_CAP', 'A cap is a number of units above zero', { field: 'encashable', index: i });
    if (encashable.some((x) => x.leaveTypeId === t.id)) throw new HttpError(422, 'DUPLICATE_LEAVE_TYPE', 'Each leave type appears once', { field: 'encashable', index: i });
    encashable.push({ leaveTypeId: t.id, code: e.leaveType.trim().toUpperCase(), maxUnits });
  }
  if (encashable.length > 0 && !encashment) {
    throw new HttpError(422, 'ENCASHMENT_COMPONENT_REQUIRED', 'Name the earning component an encashment is paid on, or list no encashable leave type', { field: 'encashmentComponentCode' });
  }
  const id = (
    await tx.query<{ id: string }>(
      `insert into settlement_policy (company_id, revision, effective_from, basic_component_id, da_component_id, encashment_component_id, encashment_rate_basis, encashment_divisor,
                                      notice_component_id, notice_rate_basis, notice_divisor, gratuity_component_id, state, created_by, updated_by)
       select $1, coalesce(max(revision), 0) + 1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'DRAFT', $12, $12 from settlement_policy where company_id = $1
       returning id`,
      [grant.companyId, input.effectiveFrom, basic, da, encashment, encashmentRateBasis, encashmentDivisor, notice, noticeRateBasis, noticeDivisor, gratuity, grant.userId],
    )
  ).rows[0]!.id;
  for (const e of encashable) {
    await tx.query(`insert into settlement_policy_encashable (company_id, policy_id, leave_type_id, max_units, created_by) values ($1, $2, $3, $4::numeric, $5)`, [
      grant.companyId,
      id,
      e.leaveTypeId,
      e.maxUnits,
      grant.userId,
    ]);
  }
  await audit(tx, actorOf(grant), 'settlement_policy', id, 'CREATE', null, {
    operational: {
      effectiveFrom: input.effectiveFrom,
      basicComponentCode: input.basicComponentCode,
      daComponentCode: input.daComponentCode ?? null,
      encashmentComponentCode: input.encashmentComponentCode ?? null,
      encashmentRateBasis,
      encashmentDivisor,
      encashable: encashable.map((e) => ({ leaveType: e.code, maxUnits: e.maxUnits })),
      noticeComponentCode: input.noticeComponentCode ?? null,
      noticeRateBasis,
      noticeDivisor,
      gratuityComponentCode: input.gratuityComponentCode ?? null,
    },
  });
  return (await tx.query(`${VIEW} where v.company_id = $1 and v.id = $2`, [grant.companyId, id])).rows[0];
}

/** By someone other than its author; an active revision of the same start date is superseded. */
export async function activateSettlementPolicy(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }) {
  await advisoryLock(tx, `settlement_policy:${grant.companyId}`);
  const p = (
    await tx.query<{ state: string; created_by: string | null; version: number; effective_from: string }>(
      `select state, created_by, version, to_char(effective_from, 'YYYY-MM-DD') as effective_from from settlement_policy where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!p) throw notFound();
  await reassertAccess(tx, grant, 'payroll_config', 'activate', ['operational']);
  if (p.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  if (p.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft policy can be activated');
  if (p.created_by === grant.userId) throw new HttpError(403, 'SELF_APPROVAL', 'A policy is activated by someone other than its author');
  await tx.query(`update settlement_policy set state = 'SUPERSEDED', updated_by = $3 where company_id = $1 and effective_from = $2::date and state = 'ACTIVE'`, [grant.companyId, p.effective_from, grant.userId]);
  await tx.query(`update settlement_policy set state = 'ACTIVE', activated_by = $3, activated_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
  await audit(tx, actorOf(grant), 'settlement_policy', id, 'ACTIVATE', { operational: { state: 'DRAFT' } }, { operational: { state: 'ACTIVE' } });
  return (await tx.query(`${VIEW} where v.company_id = $1 and v.id = $2`, [grant.companyId, id])).rows[0];
}
