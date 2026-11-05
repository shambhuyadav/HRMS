import type { FastifyInstance } from 'fastify';
import { optionalPaging } from '../../db/paging.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { actorOf } from '../../http/context.js';
import { writeAudit } from '../../audit/audit.js';
import { HttpError, notFound } from '../../http/errors.js';
import { auditDenial, requireAccess } from '../../http/guard.js';
import { decodeUpload, downloadHeaders, type FileStore, MAX_UPLOAD_BYTES, UPLOAD_FILE_NAME } from '../../storage/files.js';
import { type ScanProvider, scanAttachment } from '../../storage/scan.js';
import { canAccessEmployee, resolveAccess } from '../access/authorize.js';
import { myOpenTasks } from '../workflow/engine.js';
import { listPaymentInstructions, type PaymentListQuery } from './payment-list.js';
import { expensePolicyRoutes } from './policies.js';
import {
  canReadClaim,
  createDraft,
  decideExpense,
  type DraftInput,
  type ExpenseDecisionInput,
  getClaim,
  listClaims,
  listInstructions,
  listPayables,
  preparePayment,
  assignOutcomeActor,
  listOutcomeActors,
  markPaymentReady,
  recordOutcome,
  releasePayment,
  reversePayment,
  reviseDraft,
  submitClaim,
  taskAction,
  withdrawClaim,
} from './service.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date' } as const;
const money2 = { type: 'string', pattern: '^\\d{1,13}(\\.\\d{1,2})?$' } as const;
const key = { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const version = { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion: { type: 'integer', minimum: 1 } } } as const;

const line = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'expenseDate', 'merchant', 'grossAmount', 'claimedAmount', 'description'],
  properties: {
    category: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' },
    expenseDate: date,
    nights: { type: 'integer', minimum: 1, maximum: 60 },
    merchant: { type: 'string', minLength: 1, maxLength: 200 },
    invoiceReference: { type: 'string', maxLength: 100 },
    grossAmount: money2,
    claimedAmount: money2,
    description: { type: 'string', minLength: 1, maxLength: 1000 },
    exceptionReason: { type: 'string', minLength: 1, maxLength: 1000 },
    receipt: { type: 'object', additionalProperties: false, required: ['receiptId'], properties: { receiptId: uuid } },
  },
} as const;

const draftBody = {
  type: 'object',
  additionalProperties: false,
  required: ['purpose', 'currency', 'lines'],
  properties: { purpose: { type: 'string', minLength: 1, maxLength: 500 }, currency: { type: 'string', pattern: '^[A-Z]{3}$' }, lines: { type: 'array', minItems: 1, maxItems: 50, items: line } },
} as const;

export async function expenseRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;

  // Receipt upload (DF06): the claimant uploads first and attaches the returned id to a draft line.
  app.post(
    '/expense/receipts',
    {
      bodyLimit: Math.ceil(MAX_UPLOAD_BYTES * 1.4),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['fileName', 'contentBase64'],
          properties: { fileName: UPLOAD_FILE_NAME, contentBase64: { type: 'string', minLength: 4 } },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { fileName: string; contentBase64: string };
      const grant = await requireAccess(db, request, 'expense', 'draft', ['operational'], { requireAll: true });
      if (!grant.linkedEmployeeId) throw new HttpError(422, 'NO_EMPLOYEE_LINK', 'Your account is not linked to an employee record');
      const { bytes, mediaType } = decodeUpload(body.contentBase64);
      const stored = await files.put(grant.companyId, bytes);
      const receiptId = (
        await db.query<{ id: string }>(
          `insert into attachment (company_id, owner_user_id, employee_id, content_reference, media_type, checksum, classification, file_name, byte_size,
                                   scan_state, created_by, updated_by)
           values ($1, $2, $3, $4, $5, $6, 'CONFIDENTIAL', $7, $8, 'PENDING_SCAN', $2, $2) returning id`,
          [grant.companyId, grant.userId, grant.linkedEmployeeId, stored.reference, mediaType, stored.checksum, body.fileName.trim(), stored.byteSize],
        )
      ).rows[0]!.id;
      // FR-106 / DF06: a receipt is quarantined until a scanner releases it. NFR-S09: nothing waits for that here: in every deployment this
      // answers PENDING_SCAN and the scan worker reaches the verdict (storage/scan.ts).
      const scanState = await scanAttachment(db, scanner, { companyId: grant.companyId, id: receiptId, bytes });
      reply.status(201);
      return { receiptId, mediaType, byteSize: stored.byteSize, scanState };
    },
  );

  // Receipt content is confidential (DF02): a separate `receipt` grant, and access to the parent claim on the same
  // assignment (FR-069): its read permission, its row scope over the claimant, and who reads a claim at all (the claimant,
  // an assigned reviewer or a payment operator). A never-submitted draft is still the claimant's own: nobody else opens
  // its receipts. Every read is audited (FR-057).
  app.get('/expense/lines/:id/receipt', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'expense', 'view_receipt', ['receipt'], { requireAll: true, recordKey: id });
    await requireAccess(db, request, 'expense', 'read', ['operational'], { requireAll: true, recordKey: id });
    const receipt = (
      await db.query<{ id: string; claim_id: string; claimant_id: string; submitted: boolean; content_reference: string; media_type: string; file_name: string | null; scan_state: string | null }>(
        `select a.id, c.id as claim_id, c.employee_id as claimant_id, r.submitted_at is not null as submitted, a.content_reference, a.media_type, a.file_name, a.scan_state
           from expense_receipt er join attachment a on a.company_id = er.company_id and a.id = er.attachment_id
           join expense_line l on l.company_id = er.company_id and l.id = er.line_id
           join expense_revision r on r.company_id = l.company_id and r.id = l.revision_id
           join expense_claim c on c.company_id = r.company_id and c.id = r.claim_id
          where er.company_id = $1 and er.line_id = $2 order by er.created_at limit 1`,
        [grant.companyId, id],
      )
    ).rows[0];
    if (!receipt) throw notFound();
    const outOfScope = !(await canAccessEmployee(db, grant, receipt.claimant_id));
    const refusal = outOfScope
      ? 'OUT_OF_SCOPE'
      : !receipt.submitted && grant.linkedEmployeeId !== receipt.claimant_id
        ? 'CLAIM_NOT_SUBMITTED'
        : !(await canReadClaim(db, grant, receipt.claim_id))
          ? 'NOT_ASSIGNED'
          : null;
    if (refusal) {
      // Recorded against the receipt like its reads (FR-098), then not found.
      await auditDenial(db, request, { resource: 'expense_receipt', action: 'read', reason: refusal, recordKey: receipt.id });
      throw notFound();
    }
    // FR-106 / DF06 (v8.2): only a released receipt is served, to the claimant (H1) or an eligible reviewer.
    if (receipt.scan_state !== 'CLEAN') throw new HttpError(409, 'FILE_NOT_RELEASED', 'This receipt has not been released by the malware scan', { scanState: receipt.scan_state });
    const headers = downloadHeaders({ mediaType: receipt.media_type, fileName: receipt.file_name }, 'receipt');
    const bytes = await files.get(receipt.content_reference);
    // Recorded once the bytes are in hand, so a read that fails leaves no record of content never returned.
    await writeAudit(db, {
      companyId: grant.companyId,
      resource: 'expense_receipt',
      recordKey: receipt.id,
      actorUserId: grant.userId,
      actingAssignmentId: grant.assignmentId,
      action: 'READ_CONTENT',
      after: { receipt: { lineId: id } },
    });
    reply.headers(headers);
    return bytes;
  });

  // DF03: a new claim may name the rejected one it raises again; a later revision of a claim (PUT) cannot.
  app.post('/expense/claims', { schema: { body: { ...draftBody, properties: { ...draftBody.properties, predecessorRequestId: uuid } } } }, async (request, reply) => {
    const grant = await requireAccess(db, request, 'expense', 'draft', ['operational'], { requireAll: true });
    const result = await withTransaction(db, (tx) => createDraft(tx, grant, request.body as DraftInput & { predecessorRequestId?: string }));
    reply.status(201);
    return result;
  });

  app.put(
    '/expense/claims/:id',
    { schema: { params: idParams, body: { ...draftBody, required: [...draftBody.required, 'expectedVersion'], properties: { ...draftBody.properties, expectedVersion: { type: 'integer', minimum: 1 } } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'expense', 'draft', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => reviseDraft(tx, grant, id, request.body as DraftInput & { expectedVersion: number }));
    },
  );

  app.post('/expense/claims/:id/submit', { schema: { params: idParams, body: version } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'expense', 'submit', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => submitClaim(tx, grant, id, (request.body as { expectedVersion: number }).expectedVersion));
  });

  app.post('/expense/claims/:id/withdraw', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'expense', 'withdraw', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => withdrawClaim(tx, grant, id));
  });

  app.get('/expense/claims/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'expense', 'read', ['operational'], { recordKey: id });
    // A reviewer granted the expense reason group in the same assignment also reads the claimant's justifications and
    // the clearance reasons (DF02, DF06).
    const reasons = await resolveAccess(db, { userId: grant.userId, companyId: grant.companyId, assignmentId: grant.assignmentId, resource: 'expense', action: 'read', fieldGroups: ['reason'] });
    return getClaim(db, grant, id, reasons.allowed && reasons.allowedFieldGroups.includes('reason'));
  });

  app.get('/employees/:id/expense-claims', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'expense', 'read', ['operational'], { recordKey: id });
    return listClaims(db, grant, id);
  });

  app.get('/expense/tasks', async (request) => {
    const grant = await requireAccess(db, request, 'expense', 'read', ['operational']);
    const tasks = await myOpenTasks(db, grant, 'expense_claim');
    // Each task names its own claim (by transaction), so a reviewer always sees the claim the task is about.
    const claims = (
      await db.query<{ transaction_id: string; id: string }>(`select transaction_id, id from expense_claim where company_id = $1 and transaction_id = any($2::uuid[])`, [
        grant.companyId,
        tasks.items.map((t) => (t as { transactionId: string }).transactionId),
      ])
    ).rows;
    const byTransaction = new Map(claims.map((c) => [c.transaction_id, c.id]));
    return { ...tasks, items: tasks.items.map((t) => ({ ...t, claimId: byTransaction.get((t as { transactionId: string }).transactionId) ?? null })) };
  });

  app.post(
    '/expense/tasks/:id/decision',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision', 'idempotencyKey'],
          properties: {
            decision: { type: 'string', enum: ['APPROVE', 'REJECT', 'RETURN'] },
            reason: { type: 'string', minLength: 1, maxLength: 1000 },
            idempotencyKey: key,
            lines: {
              type: 'array',
              maxItems: 50,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['lineId', 'allowedAmount'],
                // Accepts the 4-decimal form the API returns; the schema still requires a whole number of paise.
                properties: { lineId: uuid, allowedAmount: { type: 'string', pattern: '^\\d{1,13}(\\.\\d{1,4})?$' }, reason: { type: 'string', minLength: 1, maxLength: 1000 } },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = actorOf(request);
      // The task's own step decides which decision permission is required (manager / finance / high value).
      const action = await taskAction(db, actor.companyId, actor.userId, id);
      if (!action) throw notFound();
      const grant = await requireAccess(db, request, 'expense', action, ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => decideExpense(tx, grant, id, action, request.body as ExpenseDecisionInput));
    },
  );

  app.get('/expense/payables', async (request) => {
    const grant = await requireAccess(db, request, 'payment', 'read', ['operational']);
    return listPayables(db, grant);
  });

  // F2 treasury widgets: the instructions behind each count, with the same filters (state and date, no amounts).
  app.get(
    '/expense/payments',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            state: { type: 'string', enum: ['PREPARED', 'RELEASED', 'CONFIRMED', 'FAILED', 'CANCELLED'] },
            releasableByMe: { type: 'boolean' },
            paymentDateBefore: date,
            eventKind: { type: 'string', enum: ['CONFIRMED', 'REVERSED'] },
            eventFrom: date,
            ...optionalPaging,
          },
        },
      },
    },
    async (request) => {
      const grant = await requireAccess(db, request, 'payment', 'read', ['operational']);
      return listPaymentInstructions(db, grant, request.query as PaymentListQuery);
    },
  );

  app.get('/expense/claims/:id/payments', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'payment', 'read', ['operational'], { recordKey: id });
    return listInstructions(db, grant, id);
  });

  app.post(
    '/expense/payments',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['claimId', 'amount', 'paymentDate', 'idempotencyKey'],
          // CI06: a replacement names the failed or cancelled instruction it replaces.
          properties: { claimId: uuid, amount: money2, paymentDate: date, idempotencyKey: key, retryOfInstructionId: uuid },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'payment', 'prepare', ['operational'], { requireAll: true });
      const result = await withTransaction(db, (tx) => preparePayment(tx, grant, request.body as { claimId: string; amount: string; paymentDate: string; idempotencyKey: string; retryOfInstructionId?: string }));
      reply.status(result.replayed ? 200 : 201);
      return result;
    },
  );

  // C5 "payment batch DRAFT then READY": only a ready batch can be released.
  app.post('/expense/payments/:id/ready', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'payment', 'prepare', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => markPaymentReady(tx, grant, id));
  });

  // C3 "confirmation actor explicitly assigned": the release names who records the outcome.
  app.get('/expense/payments/:id/outcome-actors', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'payment', 'release', ['operational'], { recordKey: id });
    return listOutcomeActors(db, grant, id);
  });

  app.post(
    '/expense/payments/:id/release',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['outcomeActorUserId'], properties: { outcomeActorUserId: uuid } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'payment', 'release', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => releasePayment(tx, grant, id, request.body as { outcomeActorUserId: string }));
    },
  );

  app.post(
    '/expense/payments/:id/outcome-actor',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['outcomeActorUserId', 'reason'], properties: { outcomeActorUserId: uuid, reason: { type: 'string', minLength: 1, maxLength: 500 } } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'payment', 'release', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => assignOutcomeActor(tx, grant, id, request.body as { outcomeActorUserId: string; reason: string }));
    },
  );

  app.post(
    '/expense/payments/:id/outcome',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['outcome', 'evidenceKey'], properties: { outcome: { type: 'string', enum: ['CONFIRMED', 'FAILED'] }, evidenceKey: key } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'payment', 'confirm_outcome', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => recordOutcome(tx, grant, id, request.body as { outcome: 'CONFIRMED' | 'FAILED'; evidenceKey: string }));
    },
  );

  app.post(
    '/expense/payments/:id/reversal',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['amount', 'evidenceKey', 'reason'],
          // A payment covering several claims (CI05) needs the claim the reversal returns.
          properties: { amount: money2, evidenceKey: key, reason: { type: 'string', minLength: 1, maxLength: 500 }, claimId: uuid },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'payment', 'reverse', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => reversePayment(tx, grant, id, request.body as { amount: string; evidenceKey: string; reason: string; claimId?: string }));
    },
  );

  // FR-078: policy revisions, their rules and the categories (policies.ts).
  await expensePolicyRoutes(app, { db });
}
