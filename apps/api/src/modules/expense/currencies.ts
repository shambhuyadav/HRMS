// Currencies Finance enables for expense claims and their exchange rates (OQ-17; FR-071; DF07; BR-022; migrations 0208, 0212). Decided
// under owner delegation, 6 Nov 2026 (docs/03 I-80 A6, I-87): a currency of the approved reference is usable on a claim line only once
// one person asks for it and another enables it for the company, and is converted at a dated rate entered by one person and activated
// by another (expense/service convertForeignLines, at submission). A claim itself stays in the policy currency, which it is reimbursed in.
// Payroll currencies are not enabled here: they are the currencies of active payroll calendars.
import type { FastifyInstance } from 'fastify';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { writeAudit } from '../../audit/audit.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess, requireAccess } from '../../http/guard.js';
import type { AccessGrant } from '../access/authorize.js';

/** The company currency every expense policy and payroll calendar starts from (DF06). */
export const COMPANY_CURRENCY = 'INR';

const VIEW = `select c.id, c.currency_code as "currencyCode", r.minor_unit as "minorUnit", c.purpose, c.state, c.reason, c.created_by as "createdBy", c.created_at as "createdAt",
    c.activated_by as "activatedBy", c.activated_at as "activatedAt", c.retired_at as "retiredAt", c.version
  from company_currency c join currency r on r.code = c.currency_code`;

const stale = (): never => {
  throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
};

/** Is `code` enabled for expenses in this company today? */
export async function expenseCurrencyEnabled(db: Queryable, companyId: string, code: string): Promise<boolean> {
  return ((await db.query(`select 1 from company_currency where company_id = $1 and currency_code = $2 and purpose = 'EXPENSE' and state = 'ACTIVE'`, [companyId, code])).rowCount ?? 0) > 0;
}

export async function listExpenseCurrencies(db: Queryable, grant: AccessGrant) {
  const reference = (await db.query<{ code: string; minorUnit: number }>(`select code, minor_unit as "minorUnit" from currency order by code`)).rows;
  const items = (await db.query(`${VIEW} where c.company_id = $1 order by c.currency_code, c.created_at`, [grant.companyId])).rows;
  return { companyCurrency: COMPANY_CURRENCY, reference, items };
}

async function audit(tx: Queryable, grant: AccessGrant, id: string, action: string, before: Record<string, unknown> | null, after: Record<string, unknown>) {
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'company_currency',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action,
    newVersion: 1,
    before,
    after,
  });
}

export async function requestExpenseCurrency(tx: Queryable, grant: AccessGrant, input: { currencyCode: string; reason: string }) {
  await reassertAccess(tx, grant, 'expense_policy', 'manage', ['operational']);
  const code = input.currencyCode.trim().toUpperCase();
  if (code === COMPANY_CURRENCY) throw new HttpError(422, 'COMPANY_CURRENCY', 'The company currency needs no enabling');
  if (!(await tx.query(`select 1 from currency where code = $1`, [code])).rowCount) {
    throw new HttpError(422, 'UNSUPPORTED_CURRENCY', 'The currency is not one of the approved currencies', { field: 'currencyCode' });
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) throw new HttpError(422, 'REASON_REQUIRED', 'Say why the currency is needed, in at most 500 characters', { field: 'reason' });
  const live = (await tx.query(`select 1 from company_currency where company_id = $1 and currency_code = $2 and purpose = 'EXPENSE' and state in ('DRAFT', 'ACTIVE')`, [grant.companyId, code]))
    .rowCount;
  if (live) throw new HttpError(409, 'CURRENCY_ALREADY_REQUESTED', 'This currency is already requested or enabled');
  const id = (
    await tx.query<{ id: string }>(`insert into company_currency (company_id, currency_code, reason, created_by, updated_by) values ($1, $2, $3, $4, $4) returning id`, [
      grant.companyId,
      code,
      reason,
      grant.userId,
    ])
  ).rows[0]!.id;
  await audit(tx, grant, id, 'CREATE', null, { operational: { currencyCode: code, state: 'DRAFT' } });
  return (await tx.query(`${VIEW} where c.company_id = $1 and c.id = $2`, [grant.companyId, id])).rows[0];
}

/** Enable (from DRAFT, by someone other than the requester) or retire (an enabled one). */
export async function decideExpenseCurrency(tx: Queryable, grant: AccessGrant, id: string, input: { action: 'ACTIVATE' | 'RETIRE'; expectedVersion: number }) {
  await reassertAccess(tx, grant, 'expense_policy', 'activate', ['operational']);
  const c = (
    await tx.query<{ state: string; created_by: string; version: number }>(`select state, created_by, version from company_currency where company_id = $1 and id = $2 for update`, [
      grant.companyId,
      id,
    ])
  ).rows[0];
  if (!c) throw notFound();
  if (c.version !== input.expectedVersion) stale();
  if (input.action === 'ACTIVATE') {
    if (c.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a requested currency can be enabled');
    if (c.created_by === grant.userId) throw new HttpError(403, 'SELF_APPROVAL', 'A currency is enabled by someone other than the person who asked for it');
    await tx.query(`update company_currency set state = 'ACTIVE', activated_by = $3, activated_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
  } else {
    if (c.state !== 'ACTIVE') throw new HttpError(409, 'INVALID_STATE', 'Only an enabled currency can be retired');
    await tx.query(`update company_currency set state = 'RETIRED', retired_by = $3, retired_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
  }
  await audit(tx, grant, id, input.action, { operational: { state: c.state } }, { operational: { state: input.action === 'ACTIVATE' ? 'ACTIVE' : 'RETIRED' } });
  return (await tx.query(`${VIEW} where c.company_id = $1 and c.id = $2`, [grant.companyId, id])).rows[0];
}

// ---------------------------------------------------------------------------------------------------------------
// I-87 exchange rates (0212): dated, INR for one unit of an enabled currency, entered by one person and activated by another.
// ---------------------------------------------------------------------------------------------------------------

const RATE_VIEW = `select x.id, x.currency_code as "currencyCode", to_char(x.effective_from, 'YYYY-MM-DD') as "effectiveFrom", x.rate::text as rate, x.reason, x.state,
    x.created_by as "createdBy", x.created_at as "createdAt", x.activated_by as "activatedBy", x.activated_at as "activatedAt", x.version
  from expense_exchange_rate x`;
const RATE = /^\d{1,10}(\.\d{1,8})?$/;

export async function listExchangeRates(db: Queryable, grant: AccessGrant) {
  return { companyCurrency: COMPANY_CURRENCY, items: (await db.query(`${RATE_VIEW} where x.company_id = $1 order by x.currency_code, x.effective_from desc, x.created_at desc`, [grant.companyId])).rows };
}

export async function createExchangeRate(tx: Queryable, grant: AccessGrant, input: { currencyCode: string; effectiveFrom: string; rate: string; reason: string }) {
  await reassertAccess(tx, grant, 'expense_policy', 'manage', ['operational']);
  const code = input.currencyCode.trim().toUpperCase();
  if (!(await expenseCurrencyEnabled(tx, grant.companyId, code))) {
    throw new HttpError(422, 'CURRENCY_NOT_ENABLED', 'A rate is entered for a currency Finance has enabled for claims', { field: 'currencyCode' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom) || Number.isNaN(Date.parse(`${input.effectiveFrom}T00:00:00Z`))) {
    throw new HttpError(422, 'INVALID_DATE', 'The start date is not a valid date', { field: 'effectiveFrom' });
  }
  const rate = input.rate.trim();
  if (!RATE.test(rate) || Number(rate) <= 0) throw new HttpError(422, 'INVALID_RATE', 'A rate is a positive decimal with at most eight decimals', { field: 'rate' });
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) throw new HttpError(422, 'REASON_REQUIRED', 'Name the source of the rate, in at most 500 characters', { field: 'reason' });
  const id = (
    await tx.query<{ id: string }>(
      `insert into expense_exchange_rate (company_id, currency_code, effective_from, rate, reason, created_by, updated_by) values ($1, $2, $3::date, $4::numeric, $5, $6, $6) returning id`,
      [grant.companyId, code, input.effectiveFrom, rate, reason, grant.userId],
    )
  ).rows[0]!.id;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'expense_exchange_rate',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: 1,
    after: { operational: { currencyCode: code, effectiveFrom: input.effectiveFrom, rate, state: 'DRAFT' } },
  });
  return (await tx.query(`${RATE_VIEW} where x.company_id = $1 and x.id = $2`, [grant.companyId, id])).rows[0];
}

/** Activate (by someone other than its author; an active rate of the same currency and start is superseded) or cancel a draft. */
export async function decideExchangeRate(tx: Queryable, grant: AccessGrant, id: string, input: { action: 'ACTIVATE' | 'CANCEL'; expectedVersion: number }) {
  await reassertAccess(tx, grant, 'expense_policy', 'activate', ['operational']);
  const x = (
    await tx.query<{ state: string; created_by: string; version: number; currency_code: string; effective_from: string }>(
      `select state, created_by, version, currency_code, to_char(effective_from, 'YYYY-MM-DD') as effective_from from expense_exchange_rate where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!x) throw notFound();
  if (x.version !== input.expectedVersion) stale();
  if (x.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft rate can be activated or cancelled');
  if (input.action === 'ACTIVATE') {
    if (x.created_by === grant.userId) throw new HttpError(403, 'SELF_APPROVAL', 'A rate is activated by someone other than the person who entered it');
    await tx.query(
      `update expense_exchange_rate set state = 'SUPERSEDED', updated_by = $4 where company_id = $1 and currency_code = $2 and effective_from = $3::date and state = 'ACTIVE'`,
      [grant.companyId, x.currency_code, x.effective_from, grant.userId],
    );
    await tx.query(`update expense_exchange_rate set state = 'ACTIVE', activated_by = $3, activated_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
  } else {
    await tx.query(`update expense_exchange_rate set state = 'CANCELLED', updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
  }
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'expense_exchange_rate',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: input.action,
    newVersion: x.version + 1,
    before: { operational: { state: 'DRAFT' } },
    after: { operational: { state: input.action === 'ACTIVATE' ? 'ACTIVE' : 'CANCELLED' } },
  });
  return (await tx.query(`${RATE_VIEW} where x.company_id = $1 and x.id = $2`, [grant.companyId, id])).rows[0];
}

export async function expenseCurrencyRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;
  app.get('/expense/exchange-rates', async (request) => listExchangeRates(db, await requireAccess(db, request, 'expense_policy', 'manage', ['operational'])));
  app.post(
    '/expense/exchange-rates',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['currencyCode', 'effectiveFrom', 'rate', 'reason'],
          properties: {
            currencyCode: { type: 'string', pattern: '^[A-Za-z]{3}$' },
            effectiveFrom: { type: 'string', format: 'date' },
            rate: { type: 'string', minLength: 1, maxLength: 25 },
            reason: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'expense_policy', 'manage', ['operational']);
      const result = await withTransaction(db, (tx) => createExchangeRate(tx, grant, request.body as { currencyCode: string; effectiveFrom: string; rate: string; reason: string }));
      reply.status(201);
      return result;
    },
  );
  app.post(
    '/expense/exchange-rates/:id/decision',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'expectedVersion'],
          properties: { action: { type: 'string', enum: ['ACTIVATE', 'CANCEL'] }, expectedVersion: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'expense_policy', 'activate', ['operational']);
      return withTransaction(db, (tx) => decideExchangeRate(tx, grant, id, request.body as { action: 'ACTIVATE' | 'CANCEL'; expectedVersion: number }));
    },
  );
  app.get('/expense/currencies', async (request) => listExpenseCurrencies(db, await requireAccess(db, request, 'expense_policy', 'manage', ['operational'])));
  app.post(
    '/expense/currencies',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['currencyCode', 'reason'],
          properties: { currencyCode: { type: 'string', pattern: '^[A-Za-z]{3}$' }, reason: { type: 'string', minLength: 1, maxLength: 500 } },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'expense_policy', 'manage', ['operational']);
      const result = await withTransaction(db, (tx) => requestExpenseCurrency(tx, grant, request.body as { currencyCode: string; reason: string }));
      reply.status(201);
      return result;
    },
  );
  app.post(
    '/expense/currencies/:id/decision',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'expectedVersion'],
          properties: { action: { type: 'string', enum: ['ACTIVATE', 'RETIRE'] }, expectedVersion: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'expense_policy', 'activate', ['operational']);
      return withTransaction(db, (tx) => decideExpenseCurrency(tx, grant, id, request.body as { action: 'ACTIVATE' | 'RETIRE'; expectedVersion: number }));
    },
  );
}
