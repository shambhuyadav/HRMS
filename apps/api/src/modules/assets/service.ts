// Asset register and custody (FR-110; H3 TN16; DF02; DF04; DF08; C4).
// An authorised Admin, in an unrestricted company-scope assignment, keeps the register (code, controlled category,
// description, identifier) and records custody: issue to an employee (effective date, condition note), return
// (date, condition note) and retirement of an item in stock. Custody is an effective-dated history with one holder
// at a time; the register and the history agree at commit (migration 0049). The employee acknowledges receipt of
// their own items, once per issue. Nothing here values, depreciates, writes off or transfers an item, and the
// employee never issues, returns or retires one (FR-110 acceptance).
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, canAccessEmployee, SqlParams } from '../access/authorize.js';
import { lockTransaction } from '../workflow/engine.js';
import { ACTIVE_STATUSES, assertCompanyWide, audit, categoryId, employeeStatus, ownEmployee, requireDate, userIsEmployee } from './common.js';

const CODE = /^[A-Z0-9][A-Z0-9._/-]{0,39}$/;

interface AssetRow {
  id: string;
  asset_code: string;
  category_id: string;
  category_code: string;
  description: string;
  identifier: string | null;
  state: string;
  version: number;
}

const ASSET_VIEW = `select a.id, a.asset_code as "assetCode", json_build_object('code', c.code, 'label', c.label) as category,
       a.description, a.identifier, a.state, to_char(a.retired_on, 'YYYY-MM-DD') as "retiredOn", a.retirement_note as "retirementNote",
       (select json_build_object('custodyId', k.id, 'employeeId', k.employee_id, 'employeeCode', e.employee_code, 'employeeName', e.display_name,
                                 'issuedOn', to_char(k.issued_on, 'YYYY-MM-DD'), 'acknowledgedAt', ack.acknowledged_at)
          from asset_custody k
          join employee e on e.company_id = k.company_id and e.id = k.employee_id
          left join asset_custody_acknowledgment ack on ack.company_id = k.company_id and ack.custody_id = k.id
         where k.company_id = a.company_id and k.asset_id = a.id and k.returned_on is null) as holder,
       a.created_at as "createdAt", a.updated_at as "updatedAt", a.version
  from asset a
  join reference_value c on c.company_id = a.company_id and c.id = a.category_id`;

const CUSTODY_COLUMNS = `k.id as "custodyId", k.asset_id as "assetId", k.employee_id as "employeeId", to_char(k.issued_on, 'YYYY-MM-DD') as "issuedOn",
       k.issue_condition as "issueCondition", ack.acknowledged_at as "acknowledgedAt", to_char(k.returned_on, 'YYYY-MM-DD') as "returnedOn",
       k.return_condition as "returnCondition", k.request_id as "requestId",
       case when k.returned_on is null then 'HELD' else 'RETURNED' end as status`;

/** The asset, locked for the rest of the transaction (every custody change of one item serialises on it). */
async function lockAsset(tx: Queryable, companyId: string, assetId: string): Promise<AssetRow> {
  const row = (
    await tx.query<AssetRow>(
      `select a.id, a.asset_code, a.category_id, c.code as category_code, a.description, a.identifier, a.state, a.version
         from asset a join reference_value c on c.company_id = a.company_id and c.id = a.category_id
        where a.company_id = $1 and a.id = $2 for update of a`,
      [companyId, assetId],
    )
  ).rows[0];
  if (!row) throw notFound();
  return row;
}

/** The latest return date of an item: a new issue or a retirement cannot be dated before it. */
async function lastReturn(tx: Queryable, companyId: string, assetId: string): Promise<string | null> {
  return (
    (
      await tx.query<{ d: string | null }>(`select to_char(max(returned_on), 'YYYY-MM-DD') as d from asset_custody where company_id = $1 and asset_id = $2`, [
        companyId,
        assetId,
      ])
    ).rows[0]?.d ?? null
  );
}

async function setAssetState(tx: Queryable, grant: AccessGrant, a: AssetRow, state: string, extra = '', extraValues: unknown[] = []): Promise<number> {
  return (
    await tx.query<{ version: number }>(`update asset set state = $3, updated_by = $4 ${extra} where company_id = $1 and id = $2 returning version`, [
      grant.companyId,
      a.id,
      state,
      grant.userId,
      ...extraValues,
    ])
  ).rows[0]!.version;
}

// ---------------------------------------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------------------------------------

export interface AssetInput {
  assetCode: string;
  categoryCode: string;
  description: string;
  identifier?: string | null | undefined;
}

const blankToNull = (v: string | null | undefined): string | null => (v === undefined || v === null || v.trim() === '' ? null : v.trim());

export async function createAsset(tx: Queryable, grant: AccessGrant, input: AssetInput) {
  assertCompanyWide(grant);
  const code = input.assetCode.trim().toUpperCase();
  if (!CODE.test(code)) throw new HttpError(422, 'INVALID_ASSET_CODE', 'An asset code is 1 to 40 letters, digits, dots, dashes, slashes or underscores', { field: 'assetCode' });
  const description = input.description.trim();
  if (description === '') throw new HttpError(422, 'INVALID_DESCRIPTION', 'Describe the item', { field: 'description' });
  const identifier = blankToNull(input.identifier);
  const category = await categoryId(tx, grant.companyId, input.categoryCode);
  const taken = await tx.query(`select 1 from asset where company_id = $1 and asset_code = $2`, [grant.companyId, code]);
  if ((taken.rowCount ?? 0) > 0) throw new HttpError(409, 'ASSET_CODE_EXISTS', 'An item with this code exists; asset codes are permanent and never reused');
  const id = (
    await tx.query<{ id: string }>(
      `insert into asset (company_id, asset_code, category_id, description, identifier, state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'IN_STOCK', $6, $6) returning id`,
      [grant.companyId, code, category, description, identifier, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, grant, {
    resource: 'asset',
    recordKey: id,
    action: 'CREATE',
    newVersion: 1,
    after: { assetCode: code, category: input.categoryCode, description, identifier, state: 'IN_STOCK' },
  });
  return (await assetView(tx, grant.companyId, id))!;
}

async function assetView(db: Queryable, companyId: string, id: string) {
  return (await db.query(`${ASSET_VIEW} where a.company_id = $1 and a.id = $2`, [companyId, id])).rows[0] as Record<string, unknown> | undefined;
}

export interface AssetListQuery {
  state?: string | undefined;
  categoryCode?: string | undefined;
  search?: string | undefined;
  page: number;
  pageSize: number;
}

export async function listAssets(db: Queryable, grant: AccessGrant, q: AssetListQuery) {
  assertCompanyWide(grant);
  const params = new SqlParams([grant.companyId]);
  const where = ['a.company_id = $1'];
  if (q.state) where.push(`a.state = ${params.add(q.state)}`);
  if (q.categoryCode) where.push(`c.code = ${params.add(q.categoryCode)}`);
  const search = q.search?.trim();
  if (search) {
    // % _ and \ match literally.
    const pattern = params.add(`%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    where.push(`(a.asset_code ilike ${pattern} or a.description ilike ${pattern} or a.identifier ilike ${pattern})`);
  }
  const filter = where.join(' and ');
  const total = Number(
    (await db.query<{ n: string }>(`select count(*) as n from asset a join reference_value c on c.company_id = a.company_id and c.id = a.category_id where ${filter}`, params.values))
      .rows[0]?.n ?? 0,
  );
  const limit = params.add(q.pageSize);
  const offset = params.add((q.page - 1) * q.pageSize);
  const rows = await db.query(`${ASSET_VIEW} where ${filter} order by a.asset_code limit ${limit} offset ${offset}`, params.values);
  return { items: rows.rows, total, page: q.page, pageSize: q.pageSize };
}

/** One item with its whole custody history (newest first). */
export async function getAsset(db: Queryable, grant: AccessGrant, id: string) {
  assertCompanyWide(grant);
  const asset = await assetView(db, grant.companyId, id);
  if (!asset) throw notFound();
  const custody = await db.query(
    `select ${CUSTODY_COLUMNS}, e.employee_code as "employeeCode", e.display_name as "employeeName"
       from asset_custody k
       join employee e on e.company_id = k.company_id and e.id = k.employee_id
       left join asset_custody_acknowledgment ack on ack.company_id = k.company_id and ack.custody_id = k.id
      where k.company_id = $1 and k.asset_id = $2
      order by k.issued_on desc, k.created_at desc`,
    [grant.companyId, id],
  );
  return { ...asset, custody: custody.rows };
}

export interface AssetUpdate {
  expectedVersion: number;
  categoryCode?: string | undefined;
  description?: string | undefined;
  identifier?: string | null | undefined;
}

/** Corrects the description, category or identifier of an item that is not retired (the code is permanent). */
export async function updateAsset(tx: Queryable, grant: AccessGrant, id: string, input: AssetUpdate) {
  assertCompanyWide(grant);
  const a = await lockAsset(tx, grant.companyId, id);
  if (a.state === 'RETIRED') throw new HttpError(409, 'ASSET_RETIRED', 'A retired item is final');
  if (a.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The item changed; reload and retry');
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  let category = a.category_id;
  if (input.categoryCode !== undefined && input.categoryCode !== a.category_code) {
    category = await categoryId(tx, grant.companyId, input.categoryCode);
    before.category = a.category_code;
    after.category = input.categoryCode;
  }
  let description = a.description;
  if (input.description !== undefined) {
    const d = input.description.trim();
    if (d === '') throw new HttpError(422, 'INVALID_DESCRIPTION', 'Describe the item', { field: 'description' });
    if (d !== a.description) {
      before.description = a.description;
      after.description = d;
      description = d;
    }
  }
  let identifier = a.identifier;
  if (input.identifier !== undefined) {
    const i = blankToNull(input.identifier);
    if (i !== a.identifier) {
      before.identifier = a.identifier;
      after.identifier = i;
      identifier = i;
    }
  }
  if (Object.keys(after).length === 0) throw new HttpError(422, 'NO_CHANGE', 'Nothing differs from the register entry');
  const version = (
    await tx.query<{ version: number }>(
      `update asset set category_id = $3, description = $4, identifier = $5, updated_by = $6 where company_id = $1 and id = $2 returning version`,
      [grant.companyId, a.id, category, description, identifier, grant.userId],
    )
  ).rows[0]!.version;
  await audit(tx, grant, { resource: 'asset', recordKey: a.id, action: 'UPDATE', before, after, priorVersion: a.version, newVersion: version });
  return (await assetView(tx, grant.companyId, a.id))!;
}

export interface RetireInput {
  retiredOn?: string | undefined;
  note: string;
  expectedVersion: number;
}

/** Takes an item in stock permanently out of use. It stays in the register with its history (never deleted). */
export async function retireAsset(tx: Queryable, grant: AccessGrant, id: string, input: RetireInput) {
  assertCompanyWide(grant);
  const a = await lockAsset(tx, grant.companyId, id);
  // Authority narrowed after the route check refuses the change (docs/09 §6.5).
  await reassertAccess(tx, grant, 'asset', 'manage', ['operational']);
  if (a.state === 'RETIRED') throw new HttpError(409, 'ASSET_RETIRED', 'The item is already retired');
  if (a.state === 'ISSUED') throw new HttpError(409, 'ASSET_ISSUED', 'The item is held by an employee; record its return first');
  if (a.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The item changed; reload and retry');
  const retiredOn = requireDate(input.retiredOn ?? grant.businessDate, 'retirement date');
  if (retiredOn > grant.businessDate) throw new HttpError(422, 'DATE_IN_FUTURE', 'A retirement is recorded on or after the day it happens', { field: 'retiredOn' });
  const returned = await lastReturn(tx, grant.companyId, a.id);
  if (returned && retiredOn < returned) throw new HttpError(422, 'DATE_BEFORE_LAST_RETURN', `The item was last returned on ${returned}`, { field: 'retiredOn' });
  const note = input.note.trim();
  if (note === '') throw new HttpError(422, 'NOTE_REQUIRED', 'Record why the item is retired', { field: 'note' });
  const version = await setAssetState(tx, grant, a, 'RETIRED', ', retired_on = $5, retirement_note = $6', [retiredOn, note]);
  await audit(tx, grant, {
    resource: 'asset',
    recordKey: a.id,
    action: 'RETIRE',
    before: { state: a.state },
    after: { state: 'RETIRED', retiredOn },
    reason: note,
    priorVersion: a.version,
    newVersion: version,
  });
  return (await assetView(tx, grant.companyId, a.id))!;
}

// ---------------------------------------------------------------------------------------------------------
// Custody: issue and return (Admin)
// ---------------------------------------------------------------------------------------------------------

export interface IssueInput {
  employeeId: string;
  issuedOn?: string | undefined;
  condition: string;
  /** The approved custody request of this employee that the issue fulfils. */
  requestId?: string | undefined;
  idempotencyKey: string;
}

/** DF02 / C4: an administrator never records custody of their own record. */
async function assertNotSelf(db: Queryable, grant: AccessGrant, employeeId: string): Promise<void> {
  if (grant.linkedEmployeeId === employeeId || (await userIsEmployee(db, grant.companyId, grant.userId, employeeId))) {
    throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'Another administrator records custody of your own items');
  }
}

/**
 * Issues an item in stock to an employee. Concurrency: every custody change of an item takes the item's row lock,
 * and the database keeps one open custody per item, so an item is never issued to two employees at once.
 * The same idempotency key replays the recorded issue without a second effect.
 */
export async function issueAsset(tx: Queryable, grant: AccessGrant, assetId: string, input: IssueInput) {
  assertCompanyWide(grant);
  // A fulfilled request serialises with its decision and withdrawal: transaction lock first, then row locks.
  let requestTransaction: string | undefined;
  if (input.requestId) {
    requestTransaction = (
      await tx.query<{ transaction_id: string }>(`select transaction_id from asset_request where company_id = $1 and id = $2`, [grant.companyId, input.requestId])
    ).rows[0]?.transaction_id;
    if (requestTransaction) await lockTransaction(tx, requestTransaction);
  }
  const a = await lockAsset(tx, grant.companyId, assetId);
  // Authority narrowed after the route check refuses the change (docs/09 §6.5).
  await reassertAccess(tx, grant, 'asset', 'custody', ['operational']);
  const prior = (
    await tx.query<{ id: string; asset_id: string; employee_id: string; issued_on: string }>(
      `select id, asset_id, employee_id, to_char(issued_on, 'YYYY-MM-DD') as issued_on from asset_custody where company_id = $1 and issue_key = $2`,
      [grant.companyId, input.idempotencyKey],
    )
  ).rows[0];
  if (prior) {
    if (prior.asset_id !== assetId || prior.employee_id !== input.employeeId) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for another issue');
    return { custodyId: prior.id, assetId, employeeId: prior.employee_id, issuedOn: prior.issued_on, state: a.state, replayed: true };
  }
  if (a.state === 'RETIRED') throw new HttpError(409, 'ASSET_RETIRED', 'A retired item cannot be issued');
  if (a.state === 'ISSUED') throw new HttpError(409, 'ASSET_NOT_AVAILABLE', 'The item is held by an employee; record its return first');

  if (!(await canAccessEmployee(tx, grant, input.employeeId))) throw notFound();
  await assertNotSelf(tx, grant, input.employeeId);
  // A new holding of this employee serialises with a clearance check reading their held items under the same lock
  // (assetsStillHeld with `lock`). Taken before the status is read, so an exit that cleared the employee and ended
  // their employment while this issue waited is seen here, not after the item is recorded.
  await lockEmployeeCustody(tx, grant.companyId, input.employeeId);
  const status = await employeeStatus(tx, grant.companyId, input.employeeId);
  if (!status || !(ACTIVE_STATUSES as readonly string[]).includes(status)) throw new HttpError(422, 'EMPLOYEE_NOT_ACTIVE', 'Items are issued to active employees only');

  const issuedOn = requireDate(input.issuedOn ?? grant.businessDate, 'issue date');
  if (issuedOn > grant.businessDate) throw new HttpError(422, 'DATE_IN_FUTURE', 'An issue is recorded on or after the day the item is handed over', { field: 'issuedOn' });
  const returned = await lastReturn(tx, grant.companyId, a.id);
  if (returned && issuedOn < returned) throw new HttpError(422, 'DATE_BEFORE_LAST_RETURN', `The item was last returned on ${returned}`, { field: 'issuedOn' });
  const condition = input.condition.trim();
  if (condition === '') throw new HttpError(422, 'CONDITION_REQUIRED', 'Record the condition of the item', { field: 'condition' });

  if (input.requestId) {
    const r = requestTransaction
      ? (
          await tx.query<{ employee_id: string; state: string }>(`select employee_id, state from asset_request where company_id = $1 and id = $2 for update`, [
            grant.companyId,
            input.requestId,
          ])
        ).rows[0]
      : undefined;
    if (!r || r.employee_id !== input.employeeId) throw new HttpError(422, 'REQUEST_NOT_APPLICABLE', 'The custody request is not a request of this employee', { field: 'requestId' });
    if (r.state !== 'APPROVED') throw new HttpError(409, 'REQUEST_NOT_APPROVED', 'Only an approved custody request can be fulfilled');
    const fulfilled = await tx.query(`select 1 from asset_custody where company_id = $1 and request_id = $2`, [grant.companyId, input.requestId]);
    if ((fulfilled.rowCount ?? 0) > 0) throw new HttpError(409, 'REQUEST_ALREADY_FULFILLED', 'An item was already issued for this request');
  }

  const custodyId = (
    await tx.query<{ id: string }>(
      `insert into asset_custody (company_id, asset_id, employee_id, request_id, issued_on, issue_condition, issue_key, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $8) returning id`,
      [grant.companyId, a.id, input.employeeId, input.requestId ?? null, issuedOn, condition, input.idempotencyKey, grant.userId],
    )
  ).rows[0]!.id;
  const version = await setAssetState(tx, grant, a, 'ISSUED');
  await audit(tx, grant, {
    resource: 'asset_custody',
    recordKey: custodyId,
    action: 'ISSUE',
    after: { assetId: a.id, assetCode: a.asset_code, employeeId: input.employeeId, issuedOn, condition, requestId: input.requestId ?? null },
  });
  await audit(tx, grant, {
    resource: 'asset',
    recordKey: a.id,
    action: 'ISSUE',
    before: { state: a.state },
    after: { state: 'ISSUED', custodyId, employeeId: input.employeeId, issuedOn },
    priorVersion: a.version,
    newVersion: version,
  });
  return { custodyId, assetId: a.id, employeeId: input.employeeId, issuedOn, state: 'ISSUED', replayed: false };
}

export interface ReturnInput {
  returnedOn?: string | undefined;
  condition: string;
  idempotencyKey: string;
}

/** Records the return of an issued item to stock, closing its custody interval. */
export async function returnAsset(tx: Queryable, grant: AccessGrant, assetId: string, input: ReturnInput) {
  assertCompanyWide(grant);
  const a = await lockAsset(tx, grant.companyId, assetId);
  // Authority narrowed after the route check refuses the change (docs/09 §6.5).
  await reassertAccess(tx, grant, 'asset', 'custody', ['operational']);
  const prior = (
    await tx.query<{ id: string; asset_id: string; employee_id: string; returned_on: string }>(
      `select id, asset_id, employee_id, to_char(returned_on, 'YYYY-MM-DD') as returned_on from asset_custody where company_id = $1 and return_key = $2`,
      [grant.companyId, input.idempotencyKey],
    )
  ).rows[0];
  if (prior) {
    if (prior.asset_id !== assetId) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for another return');
    return { custodyId: prior.id, assetId, employeeId: prior.employee_id, returnedOn: prior.returned_on, state: a.state, replayed: true };
  }
  if (a.state !== 'ISSUED') throw new HttpError(409, 'ASSET_NOT_ISSUED', 'The item is not held by anyone');
  const k = (
    await tx.query<{ id: string; employee_id: string; issued_on: string }>(
      `select id, employee_id, to_char(issued_on, 'YYYY-MM-DD') as issued_on from asset_custody where company_id = $1 and asset_id = $2 and returned_on is null for update`,
      [grant.companyId, a.id],
    )
  ).rows[0]!;
  if (!(await canAccessEmployee(tx, grant, k.employee_id))) throw notFound();
  await assertNotSelf(tx, grant, k.employee_id);
  const returnedOn = requireDate(input.returnedOn ?? grant.businessDate, 'return date');
  if (returnedOn > grant.businessDate) throw new HttpError(422, 'DATE_IN_FUTURE', 'A return is recorded on or after the day the item comes back', { field: 'returnedOn' });
  if (returnedOn < k.issued_on) throw new HttpError(422, 'DATE_BEFORE_ISSUE', `The item was issued on ${k.issued_on}`, { field: 'returnedOn' });
  const condition = input.condition.trim();
  if (condition === '') throw new HttpError(422, 'CONDITION_REQUIRED', 'Record the condition of the item', { field: 'condition' });

  await tx.query(
    `update asset_custody set returned_on = $3, return_condition = $4, returned_by = $5, returned_at = now(), return_key = $6, updated_by = $5
      where company_id = $1 and id = $2`,
    [grant.companyId, k.id, returnedOn, condition, grant.userId, input.idempotencyKey],
  );
  const version = await setAssetState(tx, grant, a, 'RETURNED_TO_STOCK');
  await audit(tx, grant, {
    resource: 'asset_custody',
    recordKey: k.id,
    action: 'RETURN',
    before: { status: 'HELD' },
    after: { assetId: a.id, assetCode: a.asset_code, employeeId: k.employee_id, returnedOn, condition, status: 'RETURNED' },
  });
  await audit(tx, grant, {
    resource: 'asset',
    recordKey: a.id,
    action: 'RETURN',
    before: { state: 'ISSUED' },
    after: { state: 'RETURNED_TO_STOCK', custodyId: k.id, employeeId: k.employee_id, returnedOn },
    priorVersion: a.version,
    newVersion: version,
  });
  return { custodyId: k.id, assetId: a.id, employeeId: k.employee_id, returnedOn, state: 'RETURNED_TO_STOCK', replayed: false };
}

// ---------------------------------------------------------------------------------------------------------
// Employee: own items and acknowledgment (H3 TN16)
// ---------------------------------------------------------------------------------------------------------

/**
 * The employee acknowledges receipt of an item they hold: once per issue, timestamped; a repeated acknowledgment
 * returns the recorded one. Another employee's custody record reads as missing.
 */
export async function acknowledgeCustody(tx: Queryable, grant: AccessGrant, custodyId: string) {
  const employeeId = ownEmployee(grant);
  const k = (
    await tx.query<{ id: string; asset_id: string; returned_on: string | null }>(
      `select id, asset_id, to_char(returned_on, 'YYYY-MM-DD') as returned_on from asset_custody where company_id = $1 and id = $2 and employee_id = $3 for update`,
      [grant.companyId, custodyId, employeeId],
    )
  ).rows[0];
  if (!k) throw notFound();
  const recorded = (
    await tx.query<{ acknowledged_at: Date }>(`select acknowledged_at from asset_custody_acknowledgment where company_id = $1 and custody_id = $2`, [grant.companyId, k.id])
  ).rows[0];
  if (recorded) return { custodyId: k.id, acknowledgedAt: recorded.acknowledged_at, replayed: true };
  if (k.returned_on) throw new HttpError(409, 'CUSTODY_CLOSED', 'The item has been returned; there is nothing to acknowledge');
  const ack = (
    await tx.query<{ acknowledged_at: Date }>(
      `insert into asset_custody_acknowledgment (company_id, custody_id, employee_id, acknowledged_by, created_by) values ($1, $2, $3, $4, $4) returning acknowledged_at`,
      [grant.companyId, k.id, employeeId, grant.userId],
    )
  ).rows[0]!;
  await audit(tx, grant, { resource: 'asset_custody', recordKey: k.id, action: 'ACKNOWLEDGE', after: { assetId: k.asset_id, acknowledgedAt: ack.acknowledged_at.toISOString() } });
  return { custodyId: k.id, acknowledgedAt: ack.acknowledged_at, replayed: false };
}

/**
 * An employee's items with their issue/return history (newest first), within the caller's row scope: the Employee
 * OWN context sees its own record only, an Admin the employees in scope. Out of scope reads as missing.
 */
export async function listEmployeeAssets(db: Queryable, grant: AccessGrant, employeeId: string, status?: 'HELD' | 'RETURNED') {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  const rows = await db.query(
    `select ${CUSTODY_COLUMNS}, a.asset_code as "assetCode", json_build_object('code', c.code, 'label', c.label) as category, a.description, a.identifier
       from asset_custody k
       join asset a on a.company_id = k.company_id and a.id = k.asset_id
       join reference_value c on c.company_id = a.company_id and c.id = a.category_id
       left join asset_custody_acknowledgment ack on ack.company_id = k.company_id and ack.custody_id = k.id
      where k.company_id = $1 and k.employee_id = $2
        and ($3::text is null or ($3 = 'HELD') = (k.returned_on is null))
      order by (k.returned_on is null) desc, k.issued_on desc, k.created_at desc
      limit 500`,
    [grant.companyId, employeeId, status ?? null],
  );
  // The holder's identity, so a screen opened on the employee id can name them without an employee read grant.
  const holder = await db.query<{ id: string; employeeCode: string; employeeName: string }>(
    `select id, employee_code as "employeeCode", display_name as "employeeName" from employee where company_id = $1 and id = $2`,
    [grant.companyId, employeeId],
  );
  return { employee: holder.rows[0], items: rows.rows };
}

// ---------------------------------------------------------------------------------------------------------
// Lifecycle clearance
// ---------------------------------------------------------------------------------------------------------

export interface HeldAsset {
  custodyId: string;
  assetId: string;
  assetCode: string;
  categoryCode: string;
  categoryLabel: string;
  description: string;
  identifier: string | null;
  issuedOn: string;
  acknowledgedAt: Date | null;
}

/** Transaction-scoped lock on one employee's holdings: every issue to the employee takes it before recording custody. */
async function lockEmployeeCustody(tx: Queryable, companyId: string, employeeId: string): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('asset_custody:' || $1 || ':' || $2, 0))`, [companyId, employeeId]);
}

/**
 * The items an employee still holds (open custody), for exit clearance (FR-051 clearance tasks; FR-055 "asset
 * clearance depends on an owner-approved offboarding policy"). Operational fields only. It performs no access
 * check: the caller (e.g. the lifecycle module, inside its own authorised exit flow) has already established that
 * it may act on this employee. A caller that gates a decision on the result (nothing held) passes `lock: true`
 * inside its own transaction, so no item can be issued to the employee until that transaction ends; a return
 * running at the same moment can only make the answer stale in the safe direction (still held).
 */
export async function assetsStillHeld(db: Queryable, companyId: string, employeeId: string, opts: { lock?: boolean } = {}): Promise<HeldAsset[]> {
  if (opts.lock) await lockEmployeeCustody(db, companyId, employeeId);
  return (
    await db.query<HeldAsset>(
      `select k.id as "custodyId", a.id as "assetId", a.asset_code as "assetCode", c.code as "categoryCode", c.label as "categoryLabel",
              a.description, a.identifier, to_char(k.issued_on, 'YYYY-MM-DD') as "issuedOn", ack.acknowledged_at as "acknowledgedAt"
         from asset_custody k
         join asset a on a.company_id = k.company_id and a.id = k.asset_id
         join reference_value c on c.company_id = a.company_id and c.id = a.category_id
         left join asset_custody_acknowledgment ack on ack.company_id = k.company_id and ack.custody_id = k.id
        where k.company_id = $1 and k.employee_id = $2 and k.returned_on is null
        order by k.issued_on, a.asset_code`,
      [companyId, employeeId],
    )
  ).rows;
}
