// Confirmation exceptions (DF11; FR-080, FR-081; BR-029; C4). A due-date override is the highest-priority period
// source for one employee ("independently approved employee override"); an extra-extension exception lets a case go
// beyond its policy's extension limit ("unless a separately recorded exception approval authorises more"). HR
// proposes with a private reason; a different eligible HR user decides with a reason; the employee never proposes or
// decides for themselves. A due date changes only while the case is OPEN, so a recommendation under review is always
// decided against the date it was made for. Reminders follow the case's current due date.
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess, requireAccess } from '../../http/guard.js';
import { type AccessGrant, canAccessEmployee, employeeScopePredicate, SqlParams } from '../access/authorize.js';

export type ExceptionKind = 'DUE_DATE_OVERRIDE' | 'EXTRA_EXTENSION';

interface CaseRow {
  id: string;
  employee_id: string;
  state: string;
  start_date: string;
  current_due_date: string;
  extension_count: number;
  max_extensions: number;
  extra_extensions: number;
}

async function lockCase(tx: Queryable, grant: AccessGrant, caseId: string): Promise<CaseRow> {
  const c = (
    await tx.query<CaseRow>(
      `select c.id, c.employee_id, c.state, to_char(c.start_date, 'YYYY-MM-DD') as start_date, to_char(c.current_due_date, 'YYYY-MM-DD') as current_due_date,
              c.extension_count, p.max_extensions, c.extra_extensions
         from employee_confirmation c join confirmation_policy p on p.company_id = c.company_id and p.id = c.policy_id
        where c.company_id = $1 and c.id = $2 for update of c`,
      [grant.companyId, caseId],
    )
  ).rows[0];
  if (!c || !(await canAccessEmployee(tx, grant, c.employee_id))) throw notFound();
  return c;
}

const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export async function proposeException(tx: Queryable, grant: AccessGrant, caseId: string, input: { kind: ExceptionKind; proposedDueDate?: string | undefined; reason: string }) {
  await reassertAccess(tx, grant, 'confirmation', 'propose_exception', ['operational']);
  const c = await lockCase(tx, grant, caseId);
  if (grant.linkedEmployeeId === c.employee_id) throw new HttpError(403, 'SELF_ACTION', 'You cannot propose an exception for your own confirmation');
  if (input.kind === 'DUE_DATE_OVERRIDE') {
    if (c.state !== 'OPEN') throw new HttpError(409, 'CASE_NOT_OPEN', 'The due date can change only while no recommendation is under review');
    if (!input.proposedDueDate || !isDate(input.proposedDueDate)) throw new HttpError(422, 'INVALID_DATE', 'A valid due date is required');
    if (input.proposedDueDate < c.start_date) throw new HttpError(422, 'RULE_VIOLATION', 'The due date cannot be before the joining date');
    if (input.proposedDueDate === c.current_due_date) throw new HttpError(422, 'NO_CHANGE', 'This is already the due date');
  } else {
    if (c.state !== 'OPEN' && c.state !== 'REVIEW_PENDING') throw new HttpError(409, 'CASE_CLOSED', 'The confirmation is closed');
    if (input.proposedDueDate) throw new HttpError(422, 'RULE_VIOLATION', 'An extra-extension exception has no due date');
    if (c.extension_count < c.max_extensions + c.extra_extensions) throw new HttpError(422, 'LIMIT_NOT_REACHED', 'The case can still be extended without an exception');
  }
  const open = await tx.query(`select 1 from confirmation_exception where company_id = $1 and confirmation_id = $2 and kind = $3 and state = 'PROPOSED'`, [grant.companyId, c.id, input.kind]);
  if ((open.rowCount ?? 0) > 0) throw new HttpError(409, 'OPEN_PROPOSAL_EXISTS', 'An exception of this kind is already waiting for a decision');
  const id = (
    await tx.query<{ id: string }>(
      `insert into confirmation_exception (company_id, confirmation_id, employee_id, kind, proposed_due_date, reason, proposed_by, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $7, $7) returning id`,
      [grant.companyId, c.id, c.employee_id, input.kind, input.kind === 'DUE_DATE_OVERRIDE' ? input.proposedDueDate : null, input.reason.trim(), grant.userId],
    )
  ).rows[0]!.id;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'confirmation_exception',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: 1,
    after: { operational: { confirmationId: c.id, kind: input.kind, proposedDueDate: input.proposedDueDate ?? null, state: 'PROPOSED' } },
    reason: input.reason.trim(),
  });
  return { exceptionId: id, state: 'PROPOSED' };
}

interface ExceptionRow {
  id: string;
  confirmation_id: string;
  employee_id: string;
  kind: ExceptionKind;
  proposed_due_date: string | null;
  reason: string;
  state: string;
  proposed_by: string;
}

async function lockException(tx: Queryable, grant: AccessGrant, id: string): Promise<ExceptionRow> {
  const x = (
    await tx.query<ExceptionRow>(
      `select id, confirmation_id, employee_id, kind, to_char(proposed_due_date, 'YYYY-MM-DD') as proposed_due_date, reason, state, proposed_by
         from confirmation_exception where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!x || !(await canAccessEmployee(tx, grant, x.employee_id))) throw notFound();
  return x;
}

export async function decideException(tx: Queryable, grant: AccessGrant, id: string, input: { decision: 'APPROVE' | 'REJECT'; reason: string; idempotencyKey?: string | undefined }) {
  await reassertAccess(tx, grant, 'confirmation', 'approve_exception', ['operational']);
  const x = await lockException(tx, grant, id);
  // ZT07: a retried decision with the same key returns what was recorded, without a second effect.
  if (input.idempotencyKey) {
    const prior = (
      await tx.query<{ id: string; state: string; decided_by: string }>(`select id, state, decided_by from confirmation_exception where company_id = $1 and decision_key = $2`, [
        grant.companyId,
        input.idempotencyKey,
      ])
    ).rows[0];
    if (prior) {
      if (prior.id !== x.id || prior.decided_by !== grant.userId) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was used for another decision');
      return { exceptionId: x.id, state: prior.state, applied: null, replayed: true };
    }
  }
  if (x.state !== 'PROPOSED') throw new HttpError(409, 'INVALID_STATE', 'This exception has already been decided or withdrawn');
  // C4: independent of the proposer; never the employee concerned.
  if (x.proposed_by === grant.userId) throw new HttpError(403, 'INDEPENDENT_APPROVER_REQUIRED', 'Another eligible HR user must decide your proposal');
  if (grant.linkedEmployeeId === x.employee_id) throw new HttpError(403, 'SELF_ACTION', 'You cannot decide an exception for your own confirmation');
  let applied: Record<string, unknown> | null = null;
  if (input.decision === 'APPROVE') {
    const c = await lockCase(tx, grant, x.confirmation_id);
    if (x.kind === 'DUE_DATE_OVERRIDE') {
      if (c.state !== 'OPEN') throw new HttpError(409, 'CASE_NOT_OPEN', 'The due date can change only while no recommendation is under review');
      await tx.query(
        `update employee_confirmation set override_due_date = $3, override_duration = null, override_reason = $4, current_due_date = $3, updated_by = $5
          where company_id = $1 and id = $2`,
        [grant.companyId, c.id, x.proposed_due_date, x.reason, grant.userId],
      );
      applied = { dueDate: { from: c.current_due_date, to: x.proposed_due_date } };
    } else {
      if (c.state !== 'OPEN' && c.state !== 'REVIEW_PENDING') throw new HttpError(409, 'CASE_CLOSED', 'The confirmation is closed');
      await tx.query(`update employee_confirmation set extra_extensions = extra_extensions + 1, updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, c.id, grant.userId]);
      applied = { extensionLimit: { from: c.max_extensions + c.extra_extensions, to: c.max_extensions + c.extra_extensions + 1 } };
    }
    await writeAudit(tx, {
      companyId: grant.companyId,
      resource: 'employee_confirmation',
      recordKey: c.id,
      actorUserId: grant.userId,
      actingAssignmentId: grant.assignmentId,
      action: x.kind,
      before: { operational: { dueDate: c.current_due_date, extensionLimit: c.max_extensions + c.extra_extensions } },
      after: { operational: { ...applied, exceptionId: x.id } },
    });
  }
  const state = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  await tx.query(
    `update confirmation_exception set state = $3, decided_by = $4, decided_at = now(), decision_reason = $5, decision_key = $6, updated_by = $4 where company_id = $1 and id = $2`,
    [grant.companyId, x.id, state, grant.userId, input.reason.trim(), input.idempotencyKey ?? null],
  );
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'confirmation_exception',
    recordKey: x.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: input.decision,
    before: { operational: { state: 'PROPOSED' } },
    after: { operational: { state, applied } },
    reason: input.reason.trim(),
  });
  return { exceptionId: x.id, state, applied, replayed: false };
}

export async function withdrawException(tx: Queryable, grant: AccessGrant, id: string) {
  await reassertAccess(tx, grant, 'confirmation', 'propose_exception', ['operational']);
  const x = await lockException(tx, grant, id);
  if (x.proposed_by !== grant.userId) throw notFound();
  if (x.state !== 'PROPOSED') throw new HttpError(409, 'INVALID_STATE', 'Only a waiting proposal can be withdrawn');
  await tx.query(`update confirmation_exception set state = 'WITHDRAWN', updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, x.id, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'confirmation_exception',
    recordKey: x.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'WITHDRAW',
    before: { operational: { state: 'PROPOSED' } },
    after: { operational: { state: 'WITHDRAWN' } },
  });
  return { exceptionId: x.id, state: 'WITHDRAWN' };
}

const columns = (withReason: boolean) => `x.id, x.confirmation_id as "confirmationId", x.employee_id as "employeeId", e.employee_code as "employeeCode",
  e.display_name as "employeeName", x.kind, x.proposed_due_date as "proposedDueDate", x.state, x.proposed_by as "proposedBy",
  x.decided_by as "decidedBy", x.decided_at as "decidedAt", x.created_at as "proposedAt"${withReason ? ', x.reason, x.decision_reason as "decisionReason"' : ''}`;

/** The case's exceptions; the private reasons need the confirmation reason grant (DF02, I-16). */
export async function listExceptions(db: Queryable, grant: AccessGrant, caseId: string) {
  const c = (await db.query<{ employee_id: string }>(`select employee_id from employee_confirmation where company_id = $1 and id = $2`, [grant.companyId, caseId])).rows[0];
  if (!c || !(await canAccessEmployee(db, grant, c.employee_id))) throw notFound();
  const rows = await db.query(
    `select ${columns(grant.allowedFieldGroups.includes('reason'))} from confirmation_exception x join employee e on e.company_id = x.company_id and e.id = x.employee_id
      where x.company_id = $1 and x.confirmation_id = $2 order by x.created_at`,
    [grant.companyId, caseId],
  );
  return { items: rows.rows };
}

/** Proposals waiting for a decision within the caller's scope; the caller's own proposals are marked. */
export async function pendingExceptions(db: Queryable, grant: AccessGrant) {
  const params = new SqlParams();
  const scope = employeeScopePredicate(grant, { company: 'x.company_id', employee: 'x.employee_id' }, params);
  const me = params.add(grant.userId);
  const rows = await db.query(
    `select ${columns(grant.allowedFieldGroups.includes('reason'))}, x.proposed_by = ${me}::uuid as "ownProposal"
       from confirmation_exception x join employee e on e.company_id = x.company_id and e.id = x.employee_id
      where ${scope} and x.state = 'PROPOSED' order by x.created_at limit 200`,
    params.values,
  );
  return { items: rows.rows };
}

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const reason = { type: 'string', minLength: 1, maxLength: 1000 } as const;

export async function confirmationExceptionRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  app.post(
    '/confirmations/:id/exceptions',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'reason'],
          properties: { kind: { type: 'string', enum: ['DUE_DATE_OVERRIDE', 'EXTRA_EXTENSION'] }, proposedDueDate: { type: 'string', format: 'date' }, reason },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'confirmation', 'propose_exception', ['operational'], { requireAll: true, recordKey: id });
      const result = await withTransaction(db, (tx) => proposeException(tx, grant, id, request.body as { kind: ExceptionKind; proposedDueDate?: string; reason: string }));
      reply.status(201);
      return result;
    },
  );

  app.get('/confirmations/:id/exceptions', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'confirmation', 'read', ['operational', 'reason'], { recordKey: id });
    return listExceptions(db, grant, id);
  });

  app.get('/confirmation-exceptions/pending', async (request) => {
    const grant = await requireAccess(db, request, 'confirmation', 'approve_exception', ['operational'], { requireAll: true });
    // A decider granted the confirmation reason group also sees the proposals' private reasons.
    const reasonGrant = await requireAccess(db, request, 'confirmation', 'read', ['operational', 'reason']).catch(() => null);
    return pendingExceptions(db, reasonGrant?.allowedFieldGroups.includes('reason') ? { ...grant, allowedFieldGroups: [...grant.allowedFieldGroups, 'reason'] } : grant);
  });

  app.post(
    '/confirmation-exceptions/:id/decision',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision', 'reason'],
          properties: {
            decision: { type: 'string', enum: ['APPROVE', 'REJECT'] },
            reason,
            idempotencyKey: { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'confirmation', 'approve_exception', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => decideException(tx, grant, id, request.body as { decision: 'APPROVE' | 'REJECT'; reason: string; idempotencyKey?: string }));
    },
  );

  app.post('/confirmation-exceptions/:id/withdraw', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'confirmation', 'propose_exception', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => withdrawException(tx, grant, id));
  });
}
