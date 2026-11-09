// Grade salary structures and CTC categories (FR-028, FR-029; E08; DF05; migration 0207). Decided under owner delegation, 6 Nov 2026
// (docs/03 I-80; I-40 items 1 and 9): the approved structure rules that turn an annual CTC into monthly components, per grade, as a
// dated revision one person drafts and another activates; and the CTC category, a company list recorded on a salary arrangement.
// Amounts are exact decimals (never JavaScript numbers): each line is rounded half-up to the currency's minor unit and the BALANCE line
// takes what is left of the monthly CTC, so the lines add up to it exactly.
import type { FastifyInstance } from 'fastify';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess, requireAccess } from '../../http/guard.js';
import type { AccessGrant } from '../access/authorize.js';
import { actorOf, advisoryLock, assertInScope, audit, requireCompanyScope } from './common.js';

type Method = 'PERCENT_OF_CTC' | 'PERCENT_OF_COMPONENT' | 'FIXED_MONTHLY' | 'BALANCE';
const METHODS: Method[] = ['PERCENT_OF_CTC', 'PERCENT_OF_COMPONENT', 'FIXED_MONTHLY', 'BALANCE'];
/** CTC is pay and cost: earnings, reimbursements and employer contributions; the BALANCE line is an earning. */
const CTC_HEADS = ['EARNING', 'REIMBURSEMENT', 'EMPLOYER_CONTRIBUTION'];
const GROSS_HEADS = ['EARNING', 'REIMBURSEMENT'];

const stale = (): never => {
  throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
};
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

// ---------------------------------------------------------------------------------------------------------------
// Exact decimals: scaled BigInt, four decimals as stored (numeric(19, 4)); rounding half-up to the minor unit.
// ---------------------------------------------------------------------------------------------------------------

const SCALE = 4;
const TEN = (n: number) => 10n ** BigInt(n);
const DECIMAL = /^\d{1,15}(\.\d{1,4})?$/;

function toScaled(text: string, field: string): bigint {
  const t = text.trim();
  if (!DECIMAL.test(t)) throw new HttpError(422, 'INVALID_AMOUNT', `The ${field} is a non-negative decimal with at most four decimals`, { field });
  const [w, f = ''] = t.split('.');
  return BigInt(w!) * TEN(SCALE) + BigInt(f.padEnd(SCALE, '0'));
}
const fromScaled = (v: bigint) => {
  const negative = v < 0n;
  const a = negative ? -v : v;
  return `${negative ? '-' : ''}${a / TEN(SCALE)}.${(a % TEN(SCALE)).toString().padStart(SCALE, '0')}`;
};
/** numerator / denominator (both non-negative), rounded half-up to `minor` decimals, returned at SCALE. */
function roundHalfUp(numerator: bigint, denominator: bigint, minor: number): bigint {
  const unit = TEN(SCALE - minor);
  const q = (numerator * 2n + denominator * unit) / (denominator * unit * 2n);
  return q * unit;
}

export interface DerivedLine {
  componentId: string;
  componentCode: string;
  headType: string;
  method: Method;
  amount: string;
}
export interface Derivation {
  structureId: string;
  structureRevision: number;
  currencyCode: string;
  annualCtc: string;
  monthlyCtc: string;
  monthlyGross: string;
  lines: DerivedLine[];
}

interface LineRow {
  component_id: string;
  code: string;
  method: Method;
  percent: string | null;
  base_component_id: string | null;
  amount: string | null;
  head_type: string | null;
  calculation_basis: string | null;
}

async function structureLines(db: Queryable, companyId: string, structureId: string, day: string): Promise<LineRow[]> {
  return (
    await db.query<LineRow>(
      `select l.component_id, pc.code, l.method, l.percent::text as percent, l.base_component_id, l.amount::text as amount, h.head_type, h.calculation_basis
         from grade_salary_structure_line l
         join pay_component pc on pc.company_id = l.company_id and pc.id = l.component_id
         left join lateral (select hr.head_type, hr.calculation_basis from payroll_head_revision hr
                             where hr.company_id = l.company_id and hr.component_id = l.component_id and hr.state = 'ACTIVE' and hr.effective_from <= $3::date
                             order by hr.effective_from desc limit 1) h on true
        where l.company_id = $1 and l.structure_id = $2
        order by l.sequence`,
      [companyId, structureId, day],
    )
  ).rows;
}

/** The heads a structure's lines need on `day`: FIXED, of a CTC type, the BALANCE line an earning. */
function checkHeads(lines: LineRow[]): void {
  for (const l of lines) {
    if (l.calculation_basis !== 'FIXED' || !l.head_type || !CTC_HEADS.includes(l.head_type) || (l.method === 'BALANCE' && l.head_type !== 'EARNING')) {
      throw new HttpError(422, 'STRUCTURE_HEAD_INVALID', 'Each structure line is a FIXED earning, reimbursement or employer contribution head in effect on the start date, and the BALANCE line an earning', {
        componentCode: l.code,
      });
    }
  }
}

/** FR-028 derivation: the monthly components of `annualCtc` under one structure, as a month is paid (DF05). */
export async function derive(db: Queryable, companyId: string, structure: { id: string; revision: number; currency_code: string; effective_from: string }, annualCtc: string): Promise<Derivation> {
  const minor = (await db.query<{ minor_unit: number }>(`select minor_unit from currency where code = $1`, [structure.currency_code])).rows[0]?.minor_unit ?? 2;
  const lines = await structureLines(db, companyId, structure.id, structure.effective_from);
  checkHeads(lines);
  const annual = toScaled(annualCtc, 'annualCtc');
  const monthly = roundHalfUp(annual, 12n, minor);
  const amounts = new Map<string, bigint>();
  const out: DerivedLine[] = [];
  for (const l of lines) {
    let v = 0n;
    if (l.method === 'PERCENT_OF_CTC') v = roundHalfUp(annual * toScaled(l.percent!, 'percent'), 12n * 100n * TEN(SCALE), minor);
    else if (l.method === 'PERCENT_OF_COMPONENT') v = roundHalfUp(amounts.get(l.base_component_id!)! * toScaled(l.percent!, 'percent'), 100n * TEN(SCALE), minor);
    else if (l.method === 'FIXED_MONTHLY') v = toScaled(l.amount!, 'amount');
    amounts.set(l.component_id, v);
    out.push({ componentId: l.component_id, componentCode: l.code, headType: l.head_type!, method: l.method, amount: fromScaled(v) });
  }
  const others = [...amounts.values()].reduce((a, b) => a + b, 0n);
  const balance = monthly - others;
  if (balance < 0n) {
    throw new HttpError(422, 'STRUCTURE_EXCEEDS_CTC', 'The structure lines come to more than the monthly CTC; the balancing component would be negative', {
      monthlyCtc: fromScaled(monthly),
      linesBeforeBalance: fromScaled(others),
    });
  }
  const b = out.find((x) => x.method === 'BALANCE')!;
  b.amount = fromScaled(balance);
  amounts.set(b.componentId, balance);
  const gross = out.filter((x) => GROSS_HEADS.includes(x.headType)).reduce((a, x) => a + amounts.get(x.componentId)!, 0n);
  return {
    structureId: structure.id,
    structureRevision: structure.revision,
    currencyCode: structure.currency_code,
    annualCtc: fromScaled(annual),
    monthlyCtc: fromScaled(monthly),
    monthlyGross: fromScaled(gross),
    lines: out,
  };
}

/** The active structure in force for `gradeId` on `day` in `currency` (the latest start on or before it), if any. */
export async function structureFor(db: Queryable, companyId: string, gradeId: string, day: string, currency: string) {
  return (
    (
      await db.query<{ id: string; revision: number; currency_code: string; effective_from: string }>(
        `select id, revision, currency_code, to_char(effective_from, 'YYYY-MM-DD') as effective_from from grade_salary_structure
          where company_id = $1 and grade_id = $2 and currency_code = $3 and state = 'ACTIVE' and effective_from <= $4::date
          order by effective_from desc limit 1`,
        [companyId, gradeId, currency, day],
      )
    ).rows[0] ?? null
  );
}

/** The employee's grade on `day` (their employment assignment then). */
export async function gradeOn(db: Queryable, companyId: string, employeeId: string, day: string): Promise<string | null> {
  return (
    (
      await db.query<{ grade_id: string | null }>(
        `select grade_id from employment_assignment where company_id = $1 and employee_id = $2 and effective_from <= $3::date and (effective_to is null or effective_to > $3::date)
          order by effective_from desc limit 1`,
        [companyId, employeeId, day],
      )
    ).rows[0]?.grade_id ?? null
  );
}

/**
 * FR-029 (I-80): components set on an arrangement whose employee's grade has a structure in force on its start, in its currency, must
 * be that structure's derivation of its annual CTC, monthly and nothing more or less, and its monthly gross the derivation's gross.
 * Null when no structure applies (components are entered as before).
 */
export async function requireStructureMatch(
  db: Queryable,
  companyId: string,
  a: { employee_id: string; effective_from: string; currency_code: string; annual_ctc: string; monthly_gross: string },
  components: { componentId: string; code: string; amount: string; basis: string }[],
): Promise<Derivation | null> {
  const grade = await gradeOn(db, companyId, a.employee_id, a.effective_from);
  if (!grade) return null;
  const s = await structureFor(db, companyId, grade, a.effective_from, a.currency_code);
  if (!s) return null;
  const d = await derive(db, companyId, s, a.annual_ctc);
  const expected = new Map(d.lines.map((l) => [l.componentId, toScaled(l.amount, 'amount')]));
  const sameComponents =
    components.length === d.lines.length && components.every((c) => c.basis === 'MONTHLY' && expected.has(c.componentId) && toScaled(c.amount, 'amount') === expected.get(c.componentId));
  if (!sameComponents || toScaled(a.monthly_gross, 'monthlyGross') !== toScaled(d.monthlyGross, 'monthlyGross')) {
    throw new HttpError(422, 'STRUCTURE_MISMATCH', 'The grade salary structure in force sets these components; the arrangement must match it', {
      structureId: d.structureId,
      structureRevision: d.structureRevision,
      monthlyGross: d.monthlyGross,
      components: d.lines.map((l) => ({ componentCode: l.componentCode, amount: l.amount, basis: 'MONTHLY' })),
    });
  }
  return d;
}

// ---------------------------------------------------------------------------------------------------------------
// Structures: list, draft, activate, derive
// ---------------------------------------------------------------------------------------------------------------

const STRUCTURE_VIEW = `select s.id, s.revision, g.code as "gradeCode", g.name as "gradeName", to_char(s.effective_from, 'YYYY-MM-DD') as "effectiveFrom", s.currency_code as "currencyCode",
    s.state, s.created_by as "createdBy", s.activated_by as "activatedBy", s.activated_at as "activatedAt", s.version,
    coalesce((select json_agg(json_build_object('sequence', l.sequence, 'componentCode', pc.code, 'method', l.method, 'percent', l.percent::text,
                                                'baseComponentCode', bc.code, 'amount', l.amount::text) order by l.sequence)
                from grade_salary_structure_line l
                join pay_component pc on pc.company_id = l.company_id and pc.id = l.component_id
                left join pay_component bc on bc.company_id = l.company_id and bc.id = l.base_component_id
               where l.company_id = s.company_id and l.structure_id = s.id), '[]'::json) as lines
  from grade_salary_structure s join grade g on g.company_id = s.company_id and g.id = s.grade_id`;

export async function listStructures(db: Queryable, grant: AccessGrant) {
  return { items: (await db.query(`${STRUCTURE_VIEW} where s.company_id = $1 order by g.code, s.revision`, [grant.companyId])).rows };
}

export interface StructureInput {
  gradeCode: string;
  effectiveFrom: string;
  currencyCode: string;
  lines: { componentCode: string; method: Method; percent?: string | null; baseComponentCode?: string | null; amount?: string | null }[];
}

export async function createStructure(tx: Queryable, grant: AccessGrant, input: StructureInput) {
  requireCompanyScope(grant);
  if (!isDate(input.effectiveFrom)) throw new HttpError(422, 'INVALID_DATE', 'The start date is not a valid date', { field: 'effectiveFrom' });
  const grade = (await tx.query<{ id: string; active: boolean }>(`select id, active from grade where company_id = $1 and code = $2`, [grant.companyId, input.gradeCode.trim().toUpperCase()])).rows[0];
  if (!grade || !grade.active) throw new HttpError(422, 'UNKNOWN_GRADE', 'The grade does not exist or is not active', { field: 'gradeCode' });
  if (!(await tx.query(`select 1 from currency where code = $1`, [input.currencyCode])).rowCount) {
    throw new HttpError(422, 'UNSUPPORTED_CURRENCY', 'The currency is not one of the approved currencies', { field: 'currencyCode' });
  }
  if (input.lines.filter((l) => l.method === 'BALANCE').length !== 1) throw new HttpError(422, 'BALANCE_LINE_REQUIRED', 'A structure has exactly one BALANCE line', { field: 'lines' });
  await advisoryLock(tx, `grade_structure:${grant.companyId}:${grade.id}`);
  await reassertAccess(tx, grant, 'payroll_config', 'manage', ['operational']);
  const ids = new Map<string, string>();
  for (const [i, l] of input.lines.entries()) {
    if (!METHODS.includes(l.method)) throw new HttpError(422, 'INVALID_METHOD', 'Unknown line method', { line: i + 1 });
    const code = l.componentCode.trim().toUpperCase();
    const c = (await tx.query<{ id: string }>(`select id from pay_component where company_id = $1 and code = $2 and active`, [grant.companyId, code])).rows[0];
    if (!c) throw new HttpError(422, 'UNKNOWN_COMPONENT', 'The pay component does not exist or is not active', { line: i + 1 });
    if (ids.has(code)) throw new HttpError(422, 'DUPLICATE_COMPONENT', 'Each component appears once', { line: i + 1 });
    const percent = l.method === 'PERCENT_OF_CTC' || l.method === 'PERCENT_OF_COMPONENT' ? l.percent : null;
    if ((l.method === 'PERCENT_OF_CTC' || l.method === 'PERCENT_OF_COMPONENT') && (!percent || toScaled(percent, 'percent') === 0n || toScaled(percent, 'percent') > 100n * TEN(SCALE))) {
      throw new HttpError(422, 'INVALID_PERCENT', 'A percent is more than 0 and at most 100', { line: i + 1 });
    }
    if (l.method === 'FIXED_MONTHLY') toScaled(l.amount ?? '', 'amount');
    // A percent of a component is of an earlier line, so every line is known when it is worked out.
    if (l.method === 'PERCENT_OF_COMPONENT' && !ids.has((l.baseComponentCode ?? '').trim().toUpperCase())) {
      throw new HttpError(422, 'BASE_COMPONENT_INVALID', 'A percent of a component names an earlier line of the structure', { line: i + 1 });
    }
    ids.set(code, c.id);
  }
  const revision = (await tx.query<{ n: number }>(`select coalesce(max(revision), 0) + 1 as n from grade_salary_structure where company_id = $1 and grade_id = $2`, [grant.companyId, grade.id])).rows[0]!.n;
  const id = (
    await tx.query<{ id: string }>(
      `insert into grade_salary_structure (company_id, grade_id, revision, effective_from, currency_code, created_by, updated_by) values ($1, $2, $3, $4::date, $5, $6, $6) returning id`,
      [grant.companyId, grade.id, revision, input.effectiveFrom, input.currencyCode, grant.userId],
    )
  ).rows[0]!.id;
  for (const [i, l] of input.lines.entries()) {
    const code = l.componentCode.trim().toUpperCase();
    await tx.query(
      `insert into grade_salary_structure_line (company_id, structure_id, sequence, component_id, method, percent, base_component_id, amount, created_by)
       values ($1, $2, $3, $4, $5, $6::numeric, $7, $8::numeric, $9)`,
      [
        grant.companyId,
        id,
        i + 1,
        ids.get(code),
        l.method,
        l.method === 'PERCENT_OF_CTC' || l.method === 'PERCENT_OF_COMPONENT' ? l.percent : null,
        l.method === 'PERCENT_OF_COMPONENT' ? ids.get((l.baseComponentCode ?? '').trim().toUpperCase()) : null,
        l.method === 'FIXED_MONTHLY' ? l.amount : null,
        grant.userId,
      ],
    );
  }
  // The heads must already be right on the start date; activation checks them again.
  checkHeads(await structureLines(tx, grant.companyId, id, input.effectiveFrom));
  await audit(tx, actorOf(grant), 'grade_salary_structure', id, 'CREATE', null, { operational: { gradeCode: input.gradeCode, effectiveFrom: input.effectiveFrom, revision, state: 'DRAFT' } });
  return (await tx.query(`${STRUCTURE_VIEW} where s.company_id = $1 and s.id = $2`, [grant.companyId, id])).rows[0];
}

/** By someone other than its author; an active structure of the same grade, currency and start is superseded. */
export async function activateStructure(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }) {
  requireCompanyScope(grant);
  const s = (
    await tx.query<{ grade_id: string; state: string; created_by: string; version: number; effective_from: string; currency_code: string }>(
      `select grade_id, state, created_by, version, to_char(effective_from, 'YYYY-MM-DD') as effective_from, currency_code from grade_salary_structure where company_id = $1 and id = $2`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!s) throw notFound();
  await advisoryLock(tx, `grade_structure:${grant.companyId}:${s.grade_id}`);
  await reassertAccess(tx, grant, 'payroll_config', 'activate', ['operational']);
  const locked = (await tx.query<{ state: string; version: number }>(`select state, version from grade_salary_structure where company_id = $1 and id = $2 for update`, [grant.companyId, id])).rows[0]!;
  if (locked.version !== input.expectedVersion) stale();
  if (locked.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft structure can be activated');
  if (s.created_by === grant.userId) throw new HttpError(403, 'SELF_APPROVAL', 'A structure is activated by someone other than its author');
  checkHeads(await structureLines(tx, grant.companyId, id, s.effective_from));
  await tx.query(
    `update grade_salary_structure set state = 'SUPERSEDED', updated_by = $5 where company_id = $1 and grade_id = $2 and currency_code = $3 and effective_from = $4::date and state = 'ACTIVE'`,
    [grant.companyId, s.grade_id, s.currency_code, s.effective_from, grant.userId],
  );
  await tx.query(`update grade_salary_structure set state = 'ACTIVE', activated_by = $3, activated_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
  await audit(tx, actorOf(grant), 'grade_salary_structure', id, 'ACTIVATE', { operational: { state: 'DRAFT' } }, { operational: { state: 'ACTIVE' } });
  return (await tx.query(`${STRUCTURE_VIEW} where s.company_id = $1 and s.id = $2`, [grant.companyId, id])).rows[0];
}

/** The derivation for an employee's grade on a start date, before an arrangement is recorded: what its components must be. */
export async function previewDerivation(db: Queryable, grant: AccessGrant, q: { employeeId: string; effectiveFrom: string; annualCtc: string; currencyCode?: string | undefined }) {
  if (!isDate(q.effectiveFrom)) throw new HttpError(422, 'INVALID_DATE', 'The start date is not a valid date', { field: 'effectiveFrom' });
  await assertInScope(db, grant, q.employeeId);
  const grade = await gradeOn(db, grant.companyId, q.employeeId, q.effectiveFrom);
  const s = grade ? await structureFor(db, grant.companyId, grade, q.effectiveFrom, q.currencyCode ?? 'INR') : null;
  if (!s) return { structure: null, message: 'No grade salary structure is in force for this employee on that date: components are entered as they are.' };
  return { structure: await derive(db, grant.companyId, s, q.annualCtc) };
}

// ---------------------------------------------------------------------------------------------------------------
// CTC categories
// ---------------------------------------------------------------------------------------------------------------

export async function listCtcCategories(db: Queryable, grant: AccessGrant) {
  return {
    items: (await db.query(`select id, code, name, active, version from ctc_category where company_id = $1 order by code`, [grant.companyId])).rows,
  };
}

export async function createCtcCategory(tx: Queryable, grant: AccessGrant, input: { code: string; name: string }) {
  requireCompanyScope(grant);
  await reassertAccess(tx, grant, 'payroll_config', 'manage', ['operational']);
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,39}$/.test(code)) throw new HttpError(422, 'INVALID_CODE', 'A code is letters, digits and underscores, starting with a letter', { field: 'code' });
  const name = input.name.trim();
  if (!name || name.length > 100) throw new HttpError(422, 'NAME_REQUIRED', 'Name the category in at most 100 characters', { field: 'name' });
  const row = (
    await tx.query<{ id: string }>(`insert into ctc_category (company_id, code, name, created_by, updated_by) values ($1, $2, $3, $4, $4) returning id, code, name, active, version`, [
      grant.companyId,
      code,
      name,
      grant.userId,
    ])
  ).rows[0]!;
  await audit(tx, actorOf(grant), 'ctc_category', row.id, 'CREATE', null, { operational: { code, name } });
  return row;
}

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------

const DECIMAL_TEXT = { type: 'string', minLength: 1, maxLength: 25 } as const;

export async function gradeStructureRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;
  const config = (request: Parameters<typeof requireAccess>[1], action: 'read' | 'manage' | 'activate') =>
    requireAccess(db, request, 'payroll_config', action, ['operational'], { requireAll: true });
  app.get('/payroll/grade-structures', async (request) => listStructures(db, await config(request, 'read')));
  app.post(
    '/payroll/grade-structures',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['gradeCode', 'effectiveFrom', 'currencyCode', 'lines'],
          properties: {
            gradeCode: { type: 'string', minLength: 1, maxLength: 40 },
            effectiveFrom: { type: 'string', format: 'date' },
            currencyCode: { type: 'string', pattern: '^[A-Z]{3}$' },
            lines: {
              type: 'array',
              minItems: 1,
              maxItems: 30,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['componentCode', 'method'],
                properties: {
                  componentCode: { type: 'string', minLength: 1, maxLength: 40 },
                  method: { type: 'string', enum: METHODS },
                  percent: { type: ['string', 'null'], maxLength: 12 },
                  baseComponentCode: { type: ['string', 'null'], maxLength: 40 },
                  amount: { type: ['string', 'null'], maxLength: 25 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await config(request, 'manage');
      const result = await withTransaction(db, (tx) => createStructure(tx, grant, request.body as StructureInput));
      reply.status(201);
      return result;
    },
  );
  app.post(
    '/payroll/grade-structures/:id/activate',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion: { type: 'integer', minimum: 1 } } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await config(request, 'activate');
      return withTransaction(db, (tx) => activateStructure(tx, grant, id, request.body as { expectedVersion: number }));
    },
  );
  // What an employee's components must be: for whoever records salaries (salary manage, the salary group).
  app.get(
    '/payroll/grade-structures/derivation',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['employeeId', 'effectiveFrom', 'annualCtc'],
          properties: { employeeId: { type: 'string', format: 'uuid' }, effectiveFrom: { type: 'string', format: 'date' }, annualCtc: DECIMAL_TEXT, currencyCode: { type: 'string', pattern: '^[A-Z]{3}$' } },
        },
      },
    },
    async (request) => {
      const grant = await requireAccess(db, request, 'salary', 'manage', ['salary'], { requireAll: true });
      return previewDerivation(db, grant, request.query as { employeeId: string; effectiveFrom: string; annualCtc: string; currencyCode?: string });
    },
  );
  app.get('/payroll/ctc-categories', async (request) => listCtcCategories(db, await config(request, 'read')));
  app.post(
    '/payroll/ctc-categories',
    {
      schema: {
        body: { type: 'object', additionalProperties: false, required: ['code', 'name'], properties: { code: { type: 'string', minLength: 1, maxLength: 40 }, name: { type: 'string', minLength: 1, maxLength: 100 } } },
      },
    },
    async (request, reply) => {
      const grant = await config(request, 'manage');
      const result = await withTransaction(db, (tx) => createCtcCategory(tx, grant, request.body as { code: string; name: string }));
      reply.status(201);
      return result;
    },
  );
}
