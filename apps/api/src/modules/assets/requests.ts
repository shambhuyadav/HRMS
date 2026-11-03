// Custody requests (H3 TN16 "custody request only"; FR-110; DF03; C4). The employee, in their own Employee OWN
// context, asks for an item of a controlled category with a reason; an independent eligible Admin from the explicit
// list approves or rejects (the requester is never eligible, and nobody decides their own request). Approval issues
// nothing by itself: an Admin issues an item through the separate custody action and may link it to the request.
// The employee may withdraw before the decision. Reviewer notes never reach the employee (I-16).
import { enqueueEvent } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, canAccessEmployee, employeeScopePredicate, resolveAccess, SqlParams } from '../access/authorize.js';
import { cancelActiveApproval, type Decision, decideTask, lockTransaction, myOpenTasks, startApproval } from '../workflow/engine.js';
import { ACTIVE_STATUSES, audit, categoryId, employeeStatus, ownEmployee } from './common.js';

export const ASSET_REQUEST_KIND = 'asset_request';

export interface RequestInput {
  categoryCode: string;
  itemDescription?: string | undefined;
  reason: string;
  idempotencyKey: string;
}

async function setState(tx: Queryable, companyId: string, r: { id: string; transaction_id: string }, state: string, actor: string, extra = '') {
  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [companyId, r.transaction_id, state, actor]);
  await tx.query(`update asset_request set state = $3, updated_by = $4 ${extra} where company_id = $1 and id = $2`, [companyId, r.id, state, actor]);
}

export async function submitRequest(tx: Queryable, grant: AccessGrant, input: RequestInput) {
  const employeeId = ownEmployee(grant);
  // One employee's submissions serialise, so a retried submission finds the request it created.
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('asset_request:' || $1 || ':' || $2, 0))`, [grant.companyId, employeeId]);
  const itemDescription = input.itemDescription?.trim() || null;
  const reason = input.reason.trim();
  const prior = (
    await tx.query<{ id: string; state: string; category_code: string; item_description: string | null; reason: string }>(
      `select r.id, r.state, c.code as category_code, r.item_description, r.reason from asset_request r
         join reference_value c on c.company_id = r.company_id and c.id = r.category_id
        where r.company_id = $1 and r.employee_id = $2 and r.submit_key = $3`,
      [grant.companyId, employeeId, input.idempotencyKey],
    )
  ).rows[0];
  if (prior) {
    if (prior.category_code !== input.categoryCode || prior.item_description !== itemDescription || prior.reason !== reason) {
      throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for another request');
    }
    return { requestId: prior.id, state: prior.state, replayed: true };
  }
  if (reason === '') throw new HttpError(422, 'REASON_REQUIRED', 'Explain why you need the item', { field: 'reason' });
  const status = await employeeStatus(tx, grant.companyId, employeeId);
  if (!status || !(ACTIVE_STATUSES as readonly string[]).includes(status)) throw new HttpError(422, 'EMPLOYEE_NOT_ACTIVE', 'Only active employees can ask for an item');
  const category = await categoryId(tx, grant.companyId, input.categoryCode);

  const transactionId = (
    await tx.query<{ id: string }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, created_by, updated_by) values ($1, $2, $3, 'SUBMITTED', $4, $4) returning id`,
      [grant.companyId, ASSET_REQUEST_KIND, employeeId, grant.userId],
    )
  ).rows[0]!.id;
  const requestId = (
    await tx.query<{ id: string }>(
      `insert into asset_request (company_id, employee_id, transaction_id, category_id, item_description, reason, submit_key, state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, 'SUBMITTED', $8, $8) returning id`,
      [grant.companyId, employeeId, transactionId, category, itemDescription, reason, input.idempotencyKey, grant.userId],
    )
  ).rows[0]!.id;
  const { taskId } = await startApproval(tx, { companyId: grant.companyId, kind: ASSET_REQUEST_KIND, transactionId, ownerEmployeeId: employeeId, actorUserId: grant.userId });
  await audit(tx, grant, {
    resource: 'asset_request',
    recordKey: requestId,
    action: 'CREATE',
    newVersion: 1,
    after: { category: input.categoryCode, itemDescription, reason, state: 'SUBMITTED' },
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'asset_request.submitted',
    aggregateId: requestId,
    dedupeKey: `asset_request.submitted:${requestId}`,
    payload: { requestId, taskId },
  });
  return { requestId, state: 'SUBMITTED', replayed: false };
}

export async function withdrawRequest(tx: Queryable, grant: AccessGrant, requestId: string) {
  const employeeId = ownEmployee(grant);
  const target = (
    await tx.query<{ transaction_id: string }>(`select transaction_id from asset_request where company_id = $1 and id = $2 and employee_id = $3`, [grant.companyId, requestId, employeeId])
  ).rows[0];
  if (!target) throw notFound();
  await lockTransaction(tx, target.transaction_id);
  const r = (await tx.query<{ id: string; transaction_id: string; state: string }>(`select id, transaction_id, state from asset_request where company_id = $1 and id = $2 for update`, [grant.companyId, requestId]))
    .rows[0]!;
  if (r.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'Only a request waiting for a decision can be withdrawn');
  await cancelActiveApproval(tx, grant.companyId, r.transaction_id, grant.userId);
  await setState(tx, grant.companyId, r, 'WITHDRAWN', grant.userId);
  await audit(tx, grant, { resource: 'asset_request', recordKey: r.id, action: 'WITHDRAW', before: { state: 'SUBMITTED' }, after: { state: 'WITHDRAWN' } });
  return { requestId: r.id, state: 'WITHDRAWN' };
}

// What each viewer may see: the request, who it waits for, the decision history (outcomes only, never the
// reviewer's note) and the item issued for it, if any.
const REQUEST_VIEW = `select r.id, r.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",
       json_build_object('code', c.code, 'label', c.label) as category, r.item_description as "itemDescription", r.reason, r.state,
       r.created_at as "submittedAt", r.decided_at as "decidedAt", r.version,
       (select coalesce(pe.display_name, 'Reviewer')
          from approval_instance i
          join approval_task t on t.company_id = i.company_id and t.instance_id = i.id and t.state = 'PENDING'
          left join user_employee_link l on l.company_id = t.company_id and l.user_id = t.assignee_user_id
               and l.effective_from <= hrms_business_date(r.company_id, now()) and (l.effective_to is null or l.effective_to > hrms_business_date(r.company_id, now()))
          left join employee pe on pe.company_id = l.company_id and pe.id = l.employee_id
         where i.company_id = r.company_id and i.transaction_id = r.transaction_id and i.state = 'ACTIVE' limit 1) as "pendingWith",
       coalesce((select json_agg(json_build_object('decision', d.decision, 'decidedAt', d.occurred_at) order by d.occurred_at)
                   from approval_instance i
                   join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
                   join approval_decision d on d.company_id = t.company_id and d.task_id = t.id
                  where i.company_id = r.company_id and i.transaction_id = r.transaction_id), '[]'::json) as decisions,
       (select json_build_object('custodyId', k.id, 'assetId', k.asset_id, 'assetCode', a.asset_code, 'issuedOn', to_char(k.issued_on, 'YYYY-MM-DD'))
          from asset_custody k join asset a on a.company_id = k.company_id and a.id = k.asset_id
         where k.company_id = r.company_id and k.request_id = r.id) as fulfilment
  from asset_request r
  join employee e on e.company_id = r.company_id and e.id = r.employee_id
  join reference_value c on c.company_id = r.company_id and c.id = r.category_id`;

/** An employee's requests within the caller's row scope (the Employee OWN context: its own only). */
export async function listEmployeeRequests(db: Queryable, grant: AccessGrant, employeeId: string) {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  const rows = await db.query(`${REQUEST_VIEW} where r.company_id = $1 and r.employee_id = $2 order by r.created_at desc limit 200`, [grant.companyId, employeeId]);
  return { items: rows.rows };
}

export interface RequestListQuery {
  state?: string | undefined;
  /** Approved requests no item has been issued for yet. */
  unfulfilled?: boolean | undefined;
  page: number;
  pageSize: number;
}

/** Requests of the employees in the caller's row scope, e.g. approved ones still waiting for an item. */
export async function listRequests(db: Queryable, grant: AccessGrant, q: RequestListQuery) {
  const params = new SqlParams();
  const where = [employeeScopePredicate(grant, { company: 'r.company_id', employee: 'r.employee_id' }, params)];
  if (q.state) where.push(`r.state = ${params.add(q.state)}`);
  if (q.unfulfilled) where.push(`r.state = 'APPROVED' and not exists (select 1 from asset_custody k where k.company_id = r.company_id and k.request_id = r.id)`);
  const filter = where.join(' and ');
  const total = Number((await db.query<{ n: string }>(`select count(*) as n from asset_request r where ${filter}`, params.values)).rows[0]?.n ?? 0);
  const limit = params.add(q.pageSize);
  const offset = params.add((q.page - 1) * q.pageSize);
  const rows = await db.query(`${REQUEST_VIEW} where ${filter} order by r.created_at desc, r.id limit ${limit} offset ${offset}`, params.values);
  return { items: rows.rows, total, page: q.page, pageSize: q.pageSize };
}

// The items the requester holds now (register data, resource `asset`).
const CURRENTLY_HELD = `coalesce((select json_agg(json_build_object('assetCode', a.asset_code, 'category', hc.label, 'description', a.description,
                                                          'issuedOn', to_char(k.issued_on, 'YYYY-MM-DD')) order by k.issued_on)
                          from asset_custody k
                          join asset a on a.company_id = k.company_id and a.id = k.asset_id
                          join reference_value hc on hc.company_id = a.company_id and hc.id = a.category_id
                         where k.company_id = r.company_id and k.employee_id = r.employee_id and k.returned_on is null), '[]'::json) as "currentlyHeld"`;

/**
 * The reviewer's queue. Each request carries the items the employee holds now, so the decision is informed, but only
 * when the same selected assignment may also read asset custody (C1/BR-046: each value needs its own grant in one
 * assignment; the decision duty alone does not open the register).
 */
export async function requestTasks(db: Queryable, grant: AccessGrant) {
  const tasks = (await myOpenTasks(db, grant, ASSET_REQUEST_KIND)).items as { taskId: string; transactionId: string; ownerEmployeeId: string }[];
  if (tasks.length === 0) return { items: [] };
  const custody = await resolveAccess(db, { userId: grant.userId, companyId: grant.companyId, assignmentId: grant.assignmentId, resource: 'asset', action: 'read', fieldGroups: ['operational'] });
  const rows = (
    await db.query<{ transaction_id: string; employeeId: string } & Record<string, unknown>>(
      `select q.*, r.transaction_id${custody.allowed ? `, ${CURRENTLY_HELD}` : ''}
         from (${REQUEST_VIEW} where r.company_id = $1 and r.transaction_id = any($2::uuid[])) q
         join asset_request r on r.company_id = $1 and r.id = q.id`,
      [grant.companyId, tasks.map((t) => t.transactionId)],
    )
  ).rows;
  const items = [];
  for (const t of tasks) {
    const row = rows.find((r) => r.transaction_id === t.transactionId);
    if (!row || !(await canAccessEmployee(db, grant, row.employeeId))) {
      items.push({ ...t, request: null });
      continue;
    }
    const { transaction_id: _transaction, ...request } = row;
    items.push({ ...t, request });
  }
  return { items };
}

export interface DecisionInput {
  decision: Decision;
  /** The reviewer's note: required to reject (DF03 reasoned rejection); never shown to the employee. */
  reason?: string | undefined;
  idempotencyKey: string;
}

export async function decideRequest(tx: Queryable, grant: AccessGrant, taskId: string, input: DecisionInput) {
  // One decision route per module: another kind's task reads as missing before any rule is applied.
  const kind = (
    await tx.query<{ kind: string }>(
      `select i.transaction_kind as kind from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
        where t.company_id = $1 and t.id = $2 and t.assignee_user_id = $3`,
      [grant.companyId, taskId, grant.userId],
    )
  ).rows[0]?.kind;
  if (kind !== ASSET_REQUEST_KIND) throw notFound();
  if (input.decision === 'RETURN') throw new HttpError(422, 'RETURN_NOT_ALLOWED', 'A custody request is approved or rejected; the employee can submit a new one');
  if (input.decision === 'REJECT' && !input.reason?.trim()) throw new HttpError(422, 'REASON_REQUIRED', 'Record why the request is rejected');

  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason: input.reason, idempotencyKey: input.idempotencyKey, permission: { resource: 'asset_request', action: 'decide' } });
  const r = (
    await tx.query<{ id: string; transaction_id: string; employee_id: string; state: string }>(
      `select id, transaction_id, employee_id, state from asset_request where company_id = $1 and transaction_id = $2 for update`,
      [grant.companyId, result.transactionId],
    )
  ).rows[0];
  if (!r) throw notFound();
  if (result.replayed) return { requestId: r.id, state: r.state, replayed: true };
  if (result.outcome === 'NEXT_STEP') return { requestId: r.id, state: r.state, replayed: false };

  const outcome = result.outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED';
  await setState(tx, grant.companyId, r, outcome, grant.userId, ', decided_at = now()');
  await audit(tx, grant, { resource: 'asset_request', recordKey: r.id, action: input.decision, before: { state: 'SUBMITTED' }, after: { state: outcome }, reason: input.reason?.trim() || null });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'asset_request.decided',
    aggregateId: r.id,
    dedupeKey: `asset_request.decided:${r.id}`,
    payload: { requestId: r.id, outcome },
  });
  return { requestId: r.id, state: outcome, replayed: false };
}
