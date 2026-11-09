// Payroll masters (FR-028, FR-029, FR-030, FR-032; DF05; DB033 to DB035 reconciled with 0011).
//   * Pay components (0011) are the heads' identities; payroll_head_revision classifies them for payroll in
//     effective-dated revisions (type, basis, rounding, recorded tax treatment). A revision is created whole, never
//     edited, and becomes ACTIVE only through a different user, after the activation checks refuse missing or cyclic
//     definitions. The latest active revision on or before a date is the one in effect, so a past month's structure
//     is reproduced exactly after a new revision is introduced.
//   * The payroll calendar and its periods are company configuration with no default (H2, H8); a calendar is
//     activated by someone other than its author.
//   * The paid-day policy decides whether reviewed attendance reduces paid days (BR-049); none exists by default.
//   * Salary components break an arrangement down into pay components; they are set once and are immutable, like the
//     arrangement itself (a change is a new arrangement through the salary master).
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import type { AccessGrant } from '../access/authorize.js';
import { holdsSalaryHistoryGrant } from '../increment/service.js';
import { actorOf, advisoryLock, assertInScope, assertNotSelf, audit, checkAmount, requireCompanyScope, requireDate, requireText } from './common.js';
import { requireStructureMatch } from './grade-structures.js';

/**
 * docs/09 §6.5: configuration changes and independent activations re-resolve their permission inside their own
 * transaction after their locks, so authority narrowed since the route guard refuses the change and records nothing.
 */
const reassertConfig = (tx: Queryable, grant: AccessGrant, action: 'manage' | 'activate') => reassertAccess(tx, grant, 'payroll_config', action, ['operational']);

export const HEAD_TYPES = ['EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'REIMBURSEMENT'] as const;
export const CALCULATION_BASES = ['FIXED', 'INPUT', 'RULE_PACK'] as const;
export type HeadType = (typeof HEAD_TYPES)[number];
export type CalculationBasis = (typeof CALCULATION_BASES)[number];
/** DF05: the only rounding there is (currency minor unit, half-up, at component output). */
export const ROUNDING_RULE = 'HALF_UP_MINOR_UNIT';

const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;

function stale(): never {
  throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
}

// ---------------------------------------------------------------------------------------------------------------
// Pay components
// ---------------------------------------------------------------------------------------------------------------

export async function listComponents(db: Queryable, grant: AccessGrant) {
  const rows = await db.query(
    `select c.id, c.code, c.name, c.component_kind as "componentKind", c.active,
            (select json_build_object('revisionId', h.id, 'revision', h.revision, 'effectiveFrom', h.effective_from, 'inUse', h.in_use,
                                      'headType', h.head_type, 'calculationBasis', h.calculation_basis)
               from payroll_head_revision h
              where h.company_id = c.company_id and h.component_id = c.id and h.state = 'ACTIVE' and h.effective_from <= $2::date
              order by h.effective_from desc limit 1) as "headInEffect"
       from pay_component c where c.company_id = $1 order by c.code`,
    [grant.companyId, grant.businessDate],
  );
  return { items: rows.rows };
}

export async function createComponent(tx: Queryable, grant: AccessGrant, input: { code: string; name: string; componentKind: 'EARNING' | 'DEDUCTION' }) {
  requireCompanyScope(grant);
  const code = input.code.trim().toUpperCase();
  if (!CODE.test(code)) throw new HttpError(422, 'INVALID_CODE', 'A component code is upper-case letters, digits and underscores');
  const name = requireText(input.name, 'name', 200, 'NAME_REQUIRED');
  await advisoryLock(tx, `pay_component:${grant.companyId}:${code}`);
  await reassertConfig(tx, grant, 'manage');
  const existing = await tx.query(`select 1 from pay_component where company_id = $1 and code = $2`, [grant.companyId, code]);
  if ((existing.rowCount ?? 0) > 0) throw new HttpError(409, 'COMPONENT_EXISTS', 'A pay component with this code exists');
  const id = (
    await tx.query<{ id: string }>(
      `insert into pay_component (company_id, code, name, component_kind, active, created_by, updated_by) values ($1, $2, $3, $4, true, $5, $5) returning id`,
      [grant.companyId, code, name, input.componentKind, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, actorOf(grant), 'pay_component', id, 'CREATE', null, { operational: { code, componentKind: input.componentKind } });
  return { id, code, name, componentKind: input.componentKind, active: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Payroll head revisions
// ---------------------------------------------------------------------------------------------------------------

export interface HeadInput {
  componentCode: string;
  effectiveFrom: string;
  inUse: boolean;
  headType?: HeadType | undefined;
  calculationBasis?: CalculationBasis | undefined;
  taxTreatment?: string | undefined;
  rulePackCode?: string | undefined;
  displaySequence?: number | undefined;
  baseComponentCodes?: string[] | undefined;
}

interface HeadRow {
  id: string;
  component_id: string;
  component_code: string;
  revision: number;
  effective_from: string;
  in_use: boolean;
  head_type: HeadType | null;
  calculation_basis: CalculationBasis | null;
  rule_pack_code: string | null;
  state: string;
  created_by: string | null;
  version: number;
}

const HEAD_COLUMNS = `h.id, h.component_id, c.code as component_code, h.revision, h.effective_from, h.in_use, h.head_type, h.calculation_basis,
  h.rule_pack_code, h.state, h.created_by, h.version`;

async function componentByCode(tx: Queryable, companyId: string, code: string) {
  return (
    await tx.query<{ id: string; code: string; component_kind: string; active: boolean }>(
      `select id, code, component_kind, active from pay_component where company_id = $1 and code = $2`,
      [companyId, code.trim().toUpperCase()],
    )
  ).rows[0];
}

export async function createHeadRevision(tx: Queryable, grant: AccessGrant, input: HeadInput) {
  requireCompanyScope(grant);
  const component = await componentByCode(tx, grant.companyId, input.componentCode);
  if (!component) throw new HttpError(422, 'UNKNOWN_COMPONENT', 'No pay component has this code', { componentCode: input.componentCode });
  const effectiveFrom = requireDate(input.effectiveFrom, 'effective date');
  let taxTreatmentId: string | null = null;
  const bases: string[] = [];
  if (input.inUse) {
    if (!input.headType || !input.calculationBasis || !input.taxTreatment || input.displaySequence === undefined) {
      throw new HttpError(422, 'DEFINITION_INCOMPLETE', 'A head in use needs its type, calculation basis, tax treatment and display sequence');
    }
    if ((component.component_kind === 'DEDUCTION') !== (input.headType === 'DEDUCTION')) {
      throw new HttpError(422, 'KIND_MISMATCH', 'The head type does not match the pay component kind (deductions use deduction components; earnings, reimbursements and employer costs use earning components)');
    }
    taxTreatmentId =
      (
        await tx.query<{ id: string }>(`select id from reference_value where company_id = $1 and category = 'PAYROLL_TAX_TREATMENT' and code = $2 and active`, [
          grant.companyId,
          input.taxTreatment.trim().toUpperCase(),
        ])
      ).rows[0]?.id ?? null;
    if (!taxTreatmentId) throw new HttpError(422, 'UNKNOWN_TAX_TREATMENT', 'The tax treatment is not an active PAYROLL_TAX_TREATMENT value');
    if (input.calculationBasis === 'RULE_PACK') {
      const pack = input.rulePackCode?.trim().toUpperCase() ?? '';
      if (!CODE.test(pack)) throw new HttpError(422, 'RULE_PACK_REQUIRED', 'A rule-pack head names the rule pack that will calculate it');
      input.rulePackCode = pack;
      for (const code of new Set((input.baseComponentCodes ?? []).map((c) => c.trim().toUpperCase()))) {
        const base = await componentByCode(tx, grant.companyId, code);
        if (!base) throw new HttpError(422, 'UNKNOWN_COMPONENT', 'A base component does not exist', { componentCode: code });
        if (base.id === component.id) throw new HttpError(422, 'CYCLIC_DEFINITION', 'A head cannot be its own base');
        bases.push(base.id);
      }
    } else if (input.rulePackCode || (input.baseComponentCodes ?? []).length > 0) {
      throw new HttpError(422, 'BASE_NOT_ALLOWED', 'Only a rule-pack head names a rule pack and base heads');
    }
  } else if (input.headType || input.calculationBasis || input.taxTreatment || input.rulePackCode || (input.baseComponentCodes ?? []).length > 0) {
    throw new HttpError(422, 'DISCONTINUATION_HAS_NO_DEFINITION', 'A revision that discontinues a head carries no definition');
  }
  // Serialise revision numbering per component.
  await advisoryLock(tx, `payroll_head:${grant.companyId}:${component.id}`);
  await reassertConfig(tx, grant, 'manage');
  const created = (
    await tx.query<{ id: string; revision: number }>(
      `insert into payroll_head_revision (company_id, component_id, revision, effective_from, in_use, head_type, calculation_basis, rounding_rule,
                                          tax_treatment_id, rule_pack_code, display_sequence, state, created_by, updated_by)
       select $1, $2, coalesce(max(revision), 0) + 1, $3, $4, $5, $6, $7, $8, $9, $10, 'DRAFT', $11, $11
         from payroll_head_revision where company_id = $1 and component_id = $2
       returning id, revision`,
      [
        grant.companyId,
        component.id,
        effectiveFrom,
        input.inUse,
        input.inUse ? input.headType : null,
        input.inUse ? input.calculationBasis : null,
        input.inUse ? ROUNDING_RULE : null,
        taxTreatmentId,
        input.inUse && input.calculationBasis === 'RULE_PACK' ? input.rulePackCode : null,
        input.inUse ? input.displaySequence : null,
        grant.userId,
      ],
    )
  ).rows[0]!;
  for (const base of bases) {
    await tx.query(`insert into payroll_head_base (company_id, head_revision_id, base_component_id, created_by) values ($1, $2, $3, $4)`, [
      grant.companyId,
      created.id,
      base,
      grant.userId,
    ]);
  }
  await audit(tx, actorOf(grant), 'payroll_head_revision', created.id, 'CREATE', null, {
    operational: {
      componentCode: component.code,
      revision: created.revision,
      effectiveFrom,
      inUse: input.inUse,
      headType: input.inUse ? input.headType : null,
      calculationBasis: input.inUse ? input.calculationBasis : null,
      rulePackCode: input.inUse ? (input.rulePackCode ?? null) : null,
      baseCount: bases.length,
    },
  });
  return headRevision(tx, grant, created.id);
}

interface EffectiveHead {
  revisionId: string;
  inUse: boolean;
  basis: CalculationBasis | null;
  bases: string[];
}

/** Heads in effect on a day (latest active revision on or before it), with the bases of rule-pack heads. */
async function headsOn(tx: Queryable, companyId: string, day: string): Promise<Map<string, EffectiveHead>> {
  const rows = (
    await tx.query<{ component_id: string; id: string; in_use: boolean; calculation_basis: CalculationBasis | null; bases: string[] }>(
      `select distinct on (h.component_id) h.component_id, h.id, h.in_use, h.calculation_basis,
              array(select b.base_component_id::text from payroll_head_base b where b.company_id = h.company_id and b.head_revision_id = h.id) as bases
         from payroll_head_revision h
        where h.company_id = $1 and h.state = 'ACTIVE' and h.effective_from <= $2::date
        order by h.component_id, h.effective_from desc`,
      [companyId, day],
    )
  ).rows;
  return new Map(rows.map((r) => [r.component_id, { revisionId: r.id, inUse: r.in_use, basis: r.calculation_basis, bases: r.bases }]));
}

/**
 * FR-028 activation checks on every date the head graph can change from the new revision's start until this
 * component's next active revision: each base of a rule-pack head is an active head in use (no missing definition),
 * a discontinued head is no rule-pack head's base, and no rule-pack head reaches itself through its bases (no cycle).
 */
async function validateHeadGraph(tx: Queryable, companyId: string, rev: HeadRow, revBases: string[]): Promise<void> {
  const next = (
    await tx.query<{ d: string | null }>(
      `select min(effective_from) as d from payroll_head_revision where company_id = $1 and component_id = $2 and state = 'ACTIVE' and effective_from > $3::date`,
      [companyId, rev.component_id, rev.effective_from],
    )
  ).rows[0]?.d;
  const dates = (
    await tx.query<{ d: string }>(
      `select distinct effective_from as d from payroll_head_revision
        where company_id = $1 and state = 'ACTIVE' and effective_from > $2::date and ($3::date is null or effective_from < $3::date)
        order by 1`,
      [companyId, rev.effective_from, next ?? null],
    )
  ).rows.map((r) => r.d);
  const codes = new Map(
    (await tx.query<{ id: string; code: string }>(`select id, code from pay_component where company_id = $1`, [companyId])).rows.map((r) => [r.id, r.code]),
  );
  for (const day of [rev.effective_from, ...dates]) {
    const heads = await headsOn(tx, companyId, day);
    heads.set(rev.component_id, { revisionId: rev.id, inUse: rev.in_use, basis: rev.calculation_basis, bases: rev.in_use && rev.calculation_basis === 'RULE_PACK' ? revBases : [] });
    for (const [componentId, head] of heads) {
      if (!head.inUse || head.basis !== 'RULE_PACK') continue;
      for (const base of head.bases) {
        const b = heads.get(base);
        if (!b || !b.inUse) {
          throw new HttpError(422, 'MISSING_DEFINITION', 'A rule-pack head names a base head that is not defined and in use on that date', {
            componentCode: codes.get(componentId) ?? null,
            baseComponentCode: codes.get(base) ?? null,
            date: day,
          });
        }
      }
    }
    // Cycle: walk the bases from the new revision's component.
    const seen = new Set<string>();
    const stack = [...(heads.get(rev.component_id)?.bases ?? [])];
    while (stack.length > 0) {
      const c = stack.pop()!;
      if (c === rev.component_id) throw new HttpError(422, 'CYCLIC_DEFINITION', 'The head would depend on itself through its base heads', { componentCode: rev.component_code, date: day });
      if (seen.has(c)) continue;
      seen.add(c);
      const h = heads.get(c);
      if (h?.inUse && h.basis === 'RULE_PACK') stack.push(...h.bases);
    }
  }
}

async function lockHead(tx: Queryable, grant: AccessGrant, id: string): Promise<HeadRow> {
  const row = (
    await tx.query<HeadRow>(
      `select ${HEAD_COLUMNS} from payroll_head_revision h join pay_component c on c.company_id = h.company_id and c.id = h.component_id
        where h.company_id = $1 and h.id = $2 for update of h`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!row) throw notFound();
  return row;
}

export async function activateHeadRevision(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }) {
  requireCompanyScope(grant);
  const peek = (await tx.query<{ component_id: string }>(`select component_id from payroll_head_revision where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
  if (!peek) throw notFound();
  // Activations are serialised company-wide: the graph checks read every component's heads.
  await advisoryLock(tx, `payroll_head_graph:${grant.companyId}`);
  const rev = await lockHead(tx, grant, id);
  await reassertConfig(tx, grant, 'activate');
  if (rev.version !== input.expectedVersion) stale();
  if (rev.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft revision can be activated');
  if (rev.created_by === grant.userId) throw new HttpError(403, 'SELF_APPROVAL', 'A head revision is activated by someone other than its author');
  if (rev.in_use) {
    const c = (await tx.query<{ active: boolean }>(`select active from pay_component where company_id = $1 and id = $2`, [grant.companyId, rev.component_id])).rows[0];
    if (!c?.active) throw new HttpError(422, 'COMPONENT_INACTIVE', 'The pay component is not active');
  }
  const revBases = (
    await tx.query<{ base_component_id: string }>(`select base_component_id from payroll_head_base where company_id = $1 and head_revision_id = $2`, [grant.companyId, id])
  ).rows.map((r) => r.base_component_id);
  await validateHeadGraph(tx, grant.companyId, rev, revBases);
  // A correction effective on the same date supersedes the active revision of that date (it stays on record).
  const superseded = (
    await tx.query<{ id: string }>(
      `update payroll_head_revision set state = 'SUPERSEDED', updated_by = $4
        where company_id = $1 and component_id = $2 and effective_from = $3::date and state = 'ACTIVE' returning id`,
      [grant.companyId, rev.component_id, rev.effective_from, grant.userId],
    )
  ).rows[0]?.id;
  await tx.query(`update payroll_head_revision set state = 'ACTIVE', activated_by = $3, activated_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [
    grant.companyId,
    id,
    grant.userId,
  ]);
  await audit(tx, actorOf(grant), 'payroll_head_revision', id, 'ACTIVATE', { operational: { state: 'DRAFT' } }, {
    operational: { state: 'ACTIVE', componentCode: rev.component_code, revision: rev.revision, effectiveFrom: rev.effective_from, supersedes: superseded ?? null },
  });
  return headRevision(tx, grant, id);
}

export async function cancelHeadRevision(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }) {
  requireCompanyScope(grant);
  const rev = await lockHead(tx, grant, id);
  await reassertConfig(tx, grant, 'manage');
  if (rev.version !== input.expectedVersion) stale();
  if (rev.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft revision can be cancelled');
  await tx.query(`update payroll_head_revision set state = 'CANCELLED', updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
  await audit(tx, actorOf(grant), 'payroll_head_revision', id, 'CANCEL', { operational: { state: 'DRAFT' } }, { operational: { state: 'CANCELLED' } });
  return headRevision(tx, grant, id);
}

const HEAD_VIEW = `select h.id, c.code as "componentCode", c.name as "componentName", c.component_kind as "componentKind", h.revision,
    h.effective_from as "effectiveFrom", h.in_use as "inUse", h.head_type as "headType", h.calculation_basis as "calculationBasis",
    h.rounding_rule as "roundingRule", tt.code as "taxTreatment", h.rule_pack_code as "rulePackCode", h.display_sequence as "displaySequence",
    array(select bc.code from payroll_head_base b join pay_component bc on bc.company_id = b.company_id and bc.id = b.base_component_id
           where b.company_id = h.company_id and b.head_revision_id = h.id order by bc.code) as "baseComponentCodes",
    h.state, h.created_by as "createdBy", h.activated_by as "activatedBy", h.activated_at as "activatedAt", h.version
  from payroll_head_revision h
  join pay_component c on c.company_id = h.company_id and c.id = h.component_id
  left join reference_value tt on tt.company_id = h.company_id and tt.id = h.tax_treatment_id`;

export async function headRevision(db: Queryable, grant: AccessGrant, id: string) {
  const row = (await db.query(`${HEAD_VIEW} where h.company_id = $1 and h.id = $2`, [grant.companyId, id])).rows[0];
  if (!row) throw notFound();
  return row;
}

/** Every revision, or (with `asOf`) the structure in effect on a date: what a payroll of that date would use. */
export async function listHeads(db: Queryable, grant: AccessGrant, q: { componentCode?: string | undefined; asOf?: string | undefined }) {
  if (q.asOf) {
    const day = requireDate(q.asOf, 'date');
    const inEffect = await db.query(
      `${HEAD_VIEW.replace('from payroll_head_revision h', `from (select distinct on (component_id) * from payroll_head_revision
                                                               where company_id = $1 and state = 'ACTIVE' and effective_from <= $2::date
                                                               order by component_id, effective_from desc) h`)}
        where h.in_use order by "displaySequence", "componentCode"`,
      [grant.companyId, day],
    );
    return { asOf: day, items: inEffect.rows };
  }
  const rows = await db.query(`${HEAD_VIEW} where h.company_id = $1 and ($2::text is null or c.code = $2) order by c.code, h.revision`, [
    grant.companyId,
    q.componentCode?.trim().toUpperCase() ?? null,
  ]);
  return { items: rows.rows };
}

// ---------------------------------------------------------------------------------------------------------------
// Payroll calendar and periods
// ---------------------------------------------------------------------------------------------------------------

const CALENDAR_VIEW = `select k.id, k.code, k.name, k.currency_code as "currencyCode", k.currency_minor_unit as "currencyMinorUnit", k.state,
    k.created_by as "createdBy", k.activated_by as "activatedBy", k.activated_at as "activatedAt", k.version,
    coalesce((select json_agg(json_build_object('id', p.id, 'periodCode', p.period_code, 'financialYear', p.financial_year,
                                                'serviceStart', p.service_start, 'serviceEnd', p.service_end, 'inputCutoff', p.input_cutoff,
                                                'paymentDate', p.payment_date, 'version', p.version) order by p.service_start)
                from payroll_period p where p.company_id = k.company_id and p.calendar_id = k.id), '[]'::json) as periods
  from payroll_calendar k`;

export async function listCalendars(db: Queryable, grant: AccessGrant) {
  return { items: (await db.query(`${CALENDAR_VIEW} where k.company_id = $1 order by k.code`, [grant.companyId])).rows };
}

export async function calendar(db: Queryable, grant: AccessGrant, id: string) {
  const row = (await db.query(`${CALENDAR_VIEW} where k.company_id = $1 and k.id = $2`, [grant.companyId, id])).rows[0];
  if (!row) throw notFound();
  return row;
}

export async function createCalendar(tx: Queryable, grant: AccessGrant, input: { code: string; name: string; currencyCode: string; currencyMinorUnit: number }) {
  requireCompanyScope(grant);
  const code = input.code.trim().toUpperCase();
  if (!CODE.test(code)) throw new HttpError(422, 'INVALID_CODE', 'A calendar code is upper-case letters, digits and underscores');
  await advisoryLock(tx, `payroll_calendar:${grant.companyId}:${code}`);
  await reassertConfig(tx, grant, 'manage');
  const exists = await tx.query(`select 1 from payroll_calendar where company_id = $1 and code = $2`, [grant.companyId, code]);
  if ((exists.rowCount ?? 0) > 0) throw new HttpError(409, 'CALENDAR_EXISTS', 'A payroll calendar with this code exists');
  // OQ-17 (I-80, decided under owner delegation, 6 Nov 2026): a payroll currency is one of the approved codes (0145, 0208), with the
  // reference's minor unit. A second currency exists only once someone activates a calendar in it (maker-checker, as every calendar).
  const reference = (await tx.query<{ minor_unit: number }>(`select minor_unit from currency where code = $1`, [input.currencyCode])).rows[0];
  if (!reference) throw new HttpError(422, 'UNSUPPORTED_CURRENCY', 'The currency is not one of the approved currencies', { field: 'currencyCode' });
  if (reference.minor_unit !== input.currencyMinorUnit) {
    throw new HttpError(422, 'CURRENCY_MINOR_UNIT_MISMATCH', `This currency has ${reference.minor_unit} decimal places`, { field: 'currencyMinorUnit', minorUnit: reference.minor_unit });
  }
  const id = (
    await tx.query<{ id: string }>(
      `insert into payroll_calendar (company_id, code, name, currency_code, currency_minor_unit, state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'DRAFT', $6, $6) returning id`,
      [grant.companyId, code, requireText(input.name, 'name', 200, 'NAME_REQUIRED'), input.currencyCode, input.currencyMinorUnit, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, actorOf(grant), 'payroll_calendar', id, 'CREATE', null, { operational: { code, currencyCode: input.currencyCode, currencyMinorUnit: input.currencyMinorUnit } });
  return calendar(tx, grant, id);
}

async function lockCalendar(tx: Queryable, grant: AccessGrant, id: string) {
  const row = (
    await tx.query<{ id: string; state: string; created_by: string | null; version: number; code: string }>(
      `select id, state, created_by, version, code from payroll_calendar where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!row) throw notFound();
  return row;
}

export async function activateCalendar(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }) {
  requireCompanyScope(grant);
  const k = await lockCalendar(tx, grant, id);
  await reassertConfig(tx, grant, 'activate');
  if (k.version !== input.expectedVersion) stale();
  if (k.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft calendar can be activated');
  if (k.created_by === grant.userId) throw new HttpError(403, 'SELF_APPROVAL', 'A calendar is activated by someone other than its author');
  const periods = (await tx.query<{ n: number }>(`select count(*)::int as n from payroll_period where company_id = $1 and calendar_id = $2`, [grant.companyId, id])).rows[0]!.n;
  if (periods === 0) throw new HttpError(422, 'NO_PERIODS', 'Add the calendar periods before activating it');
  await tx.query(`update payroll_calendar set state = 'ACTIVE', activated_by = $3, activated_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [
    grant.companyId,
    id,
    grant.userId,
  ]);
  await audit(tx, actorOf(grant), 'payroll_calendar', id, 'ACTIVATE', { operational: { state: 'DRAFT' } }, { operational: { state: 'ACTIVE', periods } });
  return calendar(tx, grant, id);
}

export interface PeriodInput {
  periodCode: string;
  financialYear: string;
  serviceStart: string;
  serviceEnd: string;
  inputCutoff: string;
  paymentDate: string;
}

function checkPeriod(input: PeriodInput) {
  const serviceStart = requireDate(input.serviceStart, 'service start');
  const serviceEnd = requireDate(input.serviceEnd, 'service end');
  const inputCutoff = requireDate(input.inputCutoff, 'input cutoff');
  const paymentDate = requireDate(input.paymentDate, 'payment date');
  const monthEnd = addMonthEnd(serviceStart);
  if (serviceStart.slice(8) !== '01' || serviceEnd !== monthEnd) {
    // DF05 divides by the calendar days "in that month"; another service period needs an approved denominator rule.
    throw new HttpError(422, 'SERVICE_PERIOD_NOT_A_MONTH', 'A service period is one whole calendar month (DF05 proration uses the days of that month)');
  }
  if (inputCutoff > paymentDate) throw new HttpError(422, 'CUTOFF_AFTER_PAYMENT', 'The input cutoff is on or before the payment date');
  const periodCode = input.periodCode.trim().toUpperCase();
  const financialYear = input.financialYear.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(periodCode)) throw new HttpError(422, 'INVALID_CODE', 'The period code is letters, digits, dashes and underscores');
  if (!/^[A-Z0-9][A-Z0-9_/-]{0,19}$/.test(financialYear)) throw new HttpError(422, 'INVALID_FINANCIAL_YEAR', 'The financial year label is letters, digits, dashes, slashes and underscores');
  return { periodCode, financialYear, serviceStart, serviceEnd, inputCutoff, paymentDate };
}

/** Last day of the month of a date. */
function addMonthEnd(day: string): string {
  const [y, m] = day.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export async function createPeriod(tx: Queryable, grant: AccessGrant, calendarId: string, input: PeriodInput) {
  requireCompanyScope(grant);
  const k = await lockCalendar(tx, grant, calendarId);
  await reassertConfig(tx, grant, 'manage');
  if (k.state === 'RETIRED') throw new HttpError(409, 'INVALID_STATE', 'The calendar is retired');
  const p = checkPeriod(input);
  const clash = await tx.query(
    `select 1 from payroll_period where company_id = $1 and calendar_id = $2 and (period_code = $3 or daterange(service_start, service_end, '[]') && daterange($4::date, $5::date, '[]'))`,
    [grant.companyId, calendarId, p.periodCode, p.serviceStart, p.serviceEnd],
  );
  if ((clash.rowCount ?? 0) > 0) throw new HttpError(409, 'PERIOD_EXISTS', 'The calendar already has this period code or a period covering these dates');
  const id = (
    await tx.query<{ id: string }>(
      `insert into payroll_period (company_id, calendar_id, period_code, financial_year, service_start, service_end, input_cutoff, payment_date, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) returning id`,
      [grant.companyId, calendarId, p.periodCode, p.financialYear, p.serviceStart, p.serviceEnd, p.inputCutoff, p.paymentDate, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, actorOf(grant), 'payroll_period', id, 'CREATE', null, { operational: { calendar: k.code, ...p } });
  return period(tx, grant, id);
}

export async function updatePeriod(tx: Queryable, grant: AccessGrant, id: string, input: Omit<PeriodInput, 'periodCode'> & { expectedVersion: number }) {
  requireCompanyScope(grant);
  const current = (
    await tx.query<{
      period_code: string;
      version: number;
      calendar_id: string;
      financial_year: string;
      service_start: string;
      service_end: string;
      input_cutoff: string;
      payment_date: string;
    }>(
      `select period_code, version, calendar_id, financial_year, to_char(service_start, 'YYYY-MM-DD') as service_start, to_char(service_end, 'YYYY-MM-DD') as service_end,
              to_char(input_cutoff, 'YYYY-MM-DD') as input_cutoff, to_char(payment_date, 'YYYY-MM-DD') as payment_date
         from payroll_period where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!current) throw notFound();
  await reassertConfig(tx, grant, 'manage');
  if (current.version !== input.expectedVersion) stale();
  const used = await tx.query(
    `select 1 where exists (select 1 from payroll_run where company_id = $1 and period_id = $2)
                 or exists (select 1 from payroll_input_batch where company_id = $1 and period_id = $2)
                 or exists (select 1 from payroll_salary_stop where company_id = $1 and period_id = $2)`,
    [grant.companyId, id],
  );
  if ((used.rowCount ?? 0) > 0) throw new HttpError(409, 'PERIOD_IN_USE', 'A period is fixed once runs, inputs or salary stops use it');
  const p = checkPeriod({ ...input, periodCode: current.period_code });
  const clash = await tx.query(
    `select 1 from payroll_period where company_id = $1 and calendar_id = $2 and id <> $3 and daterange(service_start, service_end, '[]') && daterange($4::date, $5::date, '[]')`,
    [grant.companyId, current.calendar_id, id, p.serviceStart, p.serviceEnd],
  );
  if ((clash.rowCount ?? 0) > 0) throw new HttpError(409, 'PERIOD_EXISTS', 'Another period of the calendar covers these dates');
  await tx.query(
    `update payroll_period set financial_year = $3, service_start = $4, service_end = $5, input_cutoff = $6, payment_date = $7, updated_by = $8
      where company_id = $1 and id = $2`,
    [grant.companyId, id, p.financialYear, p.serviceStart, p.serviceEnd, p.inputCutoff, p.paymentDate, grant.userId],
  );
  // An UPDATE audit carries both sides (audit_event check).
  await audit(
    tx,
    actorOf(grant),
    'payroll_period',
    id,
    'UPDATE',
    {
      operational: {
        financialYear: current.financial_year,
        serviceStart: current.service_start,
        serviceEnd: current.service_end,
        inputCutoff: current.input_cutoff,
        paymentDate: current.payment_date,
      },
    },
    { operational: { financialYear: p.financialYear, serviceStart: p.serviceStart, serviceEnd: p.serviceEnd, inputCutoff: p.inputCutoff, paymentDate: p.paymentDate } },
  );
  return period(tx, grant, id);
}

export interface PeriodRow {
  id: string;
  calendar_id: string;
  calendar_code: string;
  calendar_state: string;
  period_code: string;
  financial_year: string;
  service_start: string;
  service_end: string;
  input_cutoff: string;
  payment_date: string;
  currency_code: string;
  currency_minor_unit: number;
  version: number;
}

export async function periodRow(db: Queryable, companyId: string, id: string): Promise<PeriodRow | undefined> {
  return (
    await db.query<PeriodRow>(
      `select p.id, p.calendar_id, k.code as calendar_code, k.state as calendar_state, p.period_code, p.financial_year, p.service_start, p.service_end,
              p.input_cutoff, p.payment_date, k.currency_code, k.currency_minor_unit, p.version
         from payroll_period p join payroll_calendar k on k.company_id = p.company_id and k.id = p.calendar_id
        where p.company_id = $1 and p.id = $2`,
      [companyId, id],
    )
  ).rows[0];
}

export async function period(db: Queryable, grant: AccessGrant, id: string) {
  const p = await periodRow(db, grant.companyId, id);
  if (!p) throw notFound();
  return {
    id: p.id,
    calendarId: p.calendar_id,
    calendarCode: p.calendar_code,
    calendarState: p.calendar_state,
    periodCode: p.period_code,
    financialYear: p.financial_year,
    serviceStart: p.service_start,
    serviceEnd: p.service_end,
    inputCutoff: p.input_cutoff,
    paymentDate: p.payment_date,
    currencyCode: p.currency_code,
    currencyMinorUnit: p.currency_minor_unit,
    version: p.version,
  };
}

/** A period of an active calendar (runs and inputs need one). */
export async function activePeriod(db: Queryable, companyId: string, id: string): Promise<PeriodRow> {
  const p = await periodRow(db, companyId, id);
  if (!p) throw notFound();
  if (p.calendar_state !== 'ACTIVE') throw new HttpError(409, 'CALENDAR_NOT_ACTIVE', 'The payroll calendar of this period is not active');
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// Paid-day policy (BR-049; DF05)
// ---------------------------------------------------------------------------------------------------------------

const POLICY_VIEW = `select id, revision, effective_from as "effectiveFrom", attendance_basis as "attendanceBasis", absent_unpaid_units as "absentUnpaidUnits",
    half_day_unpaid_units as "halfDayUnpaidUnits", state, created_by as "createdBy", activated_by as "activatedBy", activated_at as "activatedAt", version
  from payroll_paid_day_policy`;

export async function listPaidDayPolicies(db: Queryable, grant: AccessGrant) {
  return { items: (await db.query(`${POLICY_VIEW} where company_id = $1 order by revision`, [grant.companyId])).rows };
}

export async function createPaidDayPolicy(
  tx: Queryable,
  grant: AccessGrant,
  input: { effectiveFrom: string; attendanceBasis: 'APPROVED_LEAVE_ONLY' | 'REVIEWED_ATTENDANCE'; absentUnpaidUnits?: string | undefined; halfDayUnpaidUnits?: string | undefined },
) {
  requireCompanyScope(grant);
  const effectiveFrom = requireDate(input.effectiveFrom, 'effective date');
  let absent: string | null = null;
  let half: string | null = null;
  if (input.attendanceBasis === 'REVIEWED_ATTENDANCE') {
    // The company states both values; nothing is assumed.
    if (input.absentUnpaidUnits === undefined || input.halfDayUnpaidUnits === undefined) {
      throw new HttpError(422, 'UNITS_REQUIRED', 'State the unpaid part of a reviewed ABSENT day and of a HALF_DAY');
    }
    absent = checkAmount(input.absentUnpaidUnits, 2, { field: 'absentUnpaidUnits' });
    half = checkAmount(input.halfDayUnpaidUnits, 2, { field: 'halfDayUnpaidUnits', allowZero: true });
    const ok = await tx.query<{ ok: boolean }>(`select ($1::numeric <= 1 and $2::numeric <= 1) as ok`, [absent, half]);
    if (!ok.rows[0]?.ok) throw new HttpError(422, 'INVALID_AMOUNT', 'Unpaid units are at most one day');
  } else if (input.absentUnpaidUnits !== undefined || input.halfDayUnpaidUnits !== undefined) {
    throw new HttpError(422, 'UNITS_NOT_ALLOWED', 'Attendance units apply only when reviewed attendance is valued');
  }
  await advisoryLock(tx, `payroll_paid_day:${grant.companyId}`);
  await reassertConfig(tx, grant, 'manage');
  const id = (
    await tx.query<{ id: string }>(
      `insert into payroll_paid_day_policy (company_id, revision, effective_from, attendance_basis, absent_unpaid_units, half_day_unpaid_units, state, created_by, updated_by)
       select $1, coalesce(max(revision), 0) + 1, $2, $3, $4::numeric, $5::numeric, 'DRAFT', $6, $6 from payroll_paid_day_policy where company_id = $1
       returning id`,
      [grant.companyId, effectiveFrom, input.attendanceBasis, absent, half, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, actorOf(grant), 'payroll_paid_day_policy', id, 'CREATE', null, {
    operational: { effectiveFrom, attendanceBasis: input.attendanceBasis, absentUnpaidUnits: absent, halfDayUnpaidUnits: half },
  });
  return (await tx.query(`${POLICY_VIEW} where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
}

export async function activatePaidDayPolicy(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }) {
  requireCompanyScope(grant);
  await advisoryLock(tx, `payroll_paid_day:${grant.companyId}`);
  const p = (
    await tx.query<{ state: string; created_by: string | null; version: number; effective_from: string }>(
      `select state, created_by, version, effective_from from payroll_paid_day_policy where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!p) throw notFound();
  await reassertConfig(tx, grant, 'activate');
  if (p.version !== input.expectedVersion) stale();
  if (p.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft policy can be activated');
  if (p.created_by === grant.userId) throw new HttpError(403, 'SELF_APPROVAL', 'A policy is activated by someone other than its author');
  await tx.query(`update payroll_paid_day_policy set state = 'SUPERSEDED', updated_by = $3 where company_id = $1 and effective_from = $2::date and state = 'ACTIVE'`, [
    grant.companyId,
    p.effective_from,
    grant.userId,
  ]);
  await tx.query(`update payroll_paid_day_policy set state = 'ACTIVE', activated_by = $3, activated_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [
    grant.companyId,
    id,
    grant.userId,
  ]);
  await audit(tx, actorOf(grant), 'payroll_paid_day_policy', id, 'ACTIVATE', { operational: { state: 'DRAFT' } }, { operational: { state: 'ACTIVE' } });
  return (await tx.query(`${POLICY_VIEW} where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
}

// ---------------------------------------------------------------------------------------------------------------
// Salary components of an arrangement (FR-029 permitted components; DB035)
// ---------------------------------------------------------------------------------------------------------------

async function arrangement(db: Queryable, grant: AccessGrant, id: string) {
  const a = (
    await db.query<{ id: string; employee_id: string; effective_from: string; effective_to: string | null; annual_ctc: string; monthly_gross: string; currency_code: string; superseded_at: Date | null }>(
      `select id, employee_id, effective_from, effective_to, annual_ctc, monthly_gross, currency_code, superseded_at from salary_arrangement where company_id = $1 and id = $2`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!a) throw notFound();
  await assertInScope(db, grant, a.employee_id);
  return a;
}

export async function salaryComponents(db: Queryable, grant: AccessGrant, arrangementId: string) {
  const a = await arrangement(db, grant, arrangementId);
  assertNotSelf(grant, a.employee_id);
  // C4: an arrangement that has ended is the financial past (a retired one too), and its id must not open it without the grant.
  if (a.effective_to !== null && a.effective_to <= grant.businessDate && !(await holdsSalaryHistoryGrant(db, grant, 'salary'))) {
    throw new HttpError(403, 'HISTORY_GRANT_REQUIRED', 'An earlier salary arrangement needs the salary history grant');
  }
  const components = (
    await db.query(
      `select c.code as "componentCode", c.name as "componentName", c.component_kind as "componentKind", sc.amount, sc.basis
         from salary_component sc join pay_component c on c.company_id = sc.company_id and c.id = sc.component_id
        where sc.company_id = $1 and sc.salary_arrangement_id = $2 order by c.code`,
      [grant.companyId, arrangementId],
    )
  ).rows;
  // Shown for the reviewer's reconciliation with the arrangement; no reconciliation rule is assumed (FR-029).
  const totals = (
    await db.query(
      `select sc.basis, c.component_kind as "componentKind", sum(sc.amount) as total
         from salary_component sc join pay_component c on c.company_id = sc.company_id and c.id = sc.component_id
        where sc.company_id = $1 and sc.salary_arrangement_id = $2 group by sc.basis, c.component_kind order by 1, 2`,
      [grant.companyId, arrangementId],
    )
  ).rows;
  return {
    arrangementId: a.id,
    employeeId: a.employee_id,
    effectiveFrom: a.effective_from,
    effectiveTo: a.effective_to,
    annualCtc: a.annual_ctc,
    monthlyGross: a.monthly_gross,
    currencyCode: a.currency_code,
    components,
    totals,
  };
}

export async function setSalaryComponents(
  tx: Queryable,
  grant: AccessGrant,
  arrangementId: string,
  input: { components: { componentCode: string; amount: string; basis: 'MONTHLY' | 'ANNUAL' }[] },
) {
  const a = await arrangement(tx, grant, arrangementId);
  assertNotSelf(grant, a.employee_id);
  await advisoryLock(tx, `salary:${a.employee_id}`);
  await reassertAccess(tx, grant, 'salary', 'manage', ['salary']);
  if (a.superseded_at) throw new HttpError(409, 'ARRANGEMENT_SUPERSEDED', 'A correction replaced this arrangement, so no payroll reads it; set the components on the one in force');
  const existing = (await tx.query<{ n: number }>(`select count(*)::int as n from salary_component where company_id = $1 and salary_arrangement_id = $2`, [grant.companyId, arrangementId]))
    .rows[0]!.n;
  if (existing > 0) throw new HttpError(409, 'COMPONENTS_ALREADY_SET', 'The components of an arrangement are set once; a change is a new arrangement');
  if (input.components.length === 0) throw new HttpError(422, 'COMPONENTS_REQUIRED', 'Give at least one component');
  const seen = new Set<string>();
  const rows: { id: string; amount: string; basis: string; code: string }[] = [];
  for (const [i, c] of input.components.entries()) {
    const component = await componentByCode(tx, grant.companyId, c.componentCode);
    if (!component || !component.active) throw new HttpError(422, 'UNKNOWN_COMPONENT', 'The pay component does not exist or is not active', { line: i + 1 });
    if (seen.has(component.id)) throw new HttpError(422, 'DUPLICATE_COMPONENT', 'Each component appears once', { line: i + 1 });
    seen.add(component.id);
    rows.push({ id: component.id, amount: checkAmount(c.amount, 4, { allowZero: true }), basis: c.basis, code: component.code });
  }
  // FR-028/029 (I-80): with a grade salary structure in force for the employee's grade on the start, the components are its derivation.
  const structure = await requireStructureMatch(tx, grant.companyId, a, rows.map((r) => ({ componentId: r.id, code: r.code, amount: r.amount, basis: r.basis })));
  for (const r of rows) {
    await tx.query(
      `insert into salary_component (company_id, salary_arrangement_id, component_id, amount, basis, created_by, updated_by) values ($1, $2, $3, $4::numeric, $5, $6, $6)`,
      [grant.companyId, arrangementId, r.id, r.amount, r.basis, grant.userId],
    );
  }
  await audit(tx, actorOf(grant), 'salary_arrangement', arrangementId, 'SET_COMPONENTS', null, {
    operational: { componentCodes: rows.map((r) => r.code), count: rows.length, gradeStructureId: structure?.structureId ?? null },
    salary: { components: rows.map((r) => ({ code: r.code, amount: r.amount, basis: r.basis })) },
  });
  return salaryComponents(tx, grant, arrangementId);
}
