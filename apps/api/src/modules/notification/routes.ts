import type { FastifyInstance } from 'fastify';
import { optionalPaging, type Paging, pageOf } from '../../db/paging.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { actorOf } from '../../http/context.js';
import { HttpError, notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import { SqlParams } from '../access/authorize.js';
import { DELIVERY_LIST_SELECT, deliveryCondition, type DeliveryFilters, FAILED_EVENT_LIST_SELECT, FAILED_EVENT_STATES, failedEventCondition, type FailedEventFilters, NOTIFICATION_STATES } from './delivery-log.js';
import { type EmailRuleInput, listRuleProposals, listRules, proposeEmailRule, publishRuleRevision, rejectRuleRevision, type RuleRevisionInput, reviseRule } from './rules.js';

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

/** DF12: the events a user has a say in. Every other notice is mandatory (FR-085). */
const PREFERENCE_EVENTS = ['BIRTHDAY', 'WORK_ANNIVERSARY'] as const;

const preferenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['eventType'],
  properties: {
    eventType: { type: 'string', enum: PREFERENCE_EVENTS },
    publishCelebration: { type: 'boolean' },
    receiveOptional: { type: 'boolean' },
    receiveEmail: { type: 'boolean' },
  },
} as const;

const date = { type: 'string', format: 'date' } as const;

const deliveryQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: { type: 'string', enum: NOTIFICATION_STATES },
    category: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' },
    from: date,
    to: date,
    ...optionalPaging,
  },
} as const;

const failedEventsQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: { type: 'string', enum: FAILED_EVENT_STATES },
    from: date,
    to: date,
    ...optionalPaging,
  },
} as const;

export async function notificationRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  // The inbox belongs to the user; it needs no selected role but stays company-scoped. In-app notices only: an email's copy is not a second notice.
  app.get('/me/notifications', { config: { assignmentOptional: true } }, async (request) => {
    const actor = actorOf(request);
    const rows = await db.query<{ id: string; category: string; title: string | null; body: string; occurredAt: string; readAt: string | null }>(
      `select id, category, title, body, occurred_at as "occurredAt", read_at as "readAt"
         from notification where company_id = $1 and recipient_user_id = $2 and state = 'DELIVERED' and channel = 'IN_APP'
        order by occurred_at desc limit 100`,
      [actor.companyId, actor.userId],
    );
    return { items: rows.rows, unread: rows.rows.filter((r) => r.readAt === null).length };
  });

  app.post('/me/notifications/:id/read', { config: { assignmentOptional: true }, schema: { params: idParams } }, async (request) => {
    const actor = actorOf(request);
    const { id } = request.params as { id: string };
    const res = await db.query(
      `update notification set read_at = coalesce(read_at, now()), updated_by = $3 where company_id = $1 and id = $2 and recipient_user_id = $3 and state = 'DELIVERED' and channel = 'IN_APP'`,
      [actor.companyId, id, actor.userId],
    );
    if (!res.rowCount) throw notFound();
    return { id, read: true };
  });

  // FR-085: the user's own preferences, with DF12's defaults for an event never saved (publication off, receipt on). `receiveEmail` is
  // receipt by email (0247), which only matters once the company has an email rule in force for the event.
  app.get('/me/notification-preferences', { config: { assignmentOptional: true } }, async (request) => {
    const actor = actorOf(request);
    const rows = await db.query<{ eventType: string; publishCelebration: boolean; receiveOptional: boolean; receiveEmail: boolean }>(
      `select e.event_type as "eventType", coalesce(p.publish_celebration, false) as "publishCelebration", coalesce(p.receive_optional, true) as "receiveOptional",
              coalesce(m.receive_optional, true) as "receiveEmail"
         from unnest($3::text[]) with ordinality as e (event_type, position)
         left join notification_preference p on p.company_id = $1 and p.user_id = $2 and p.event_type = e.event_type and p.channel = 'IN_APP'
         left join notification_preference m on m.company_id = $1 and m.user_id = $2 and m.event_type = e.event_type and m.channel = 'EMAIL'
        order by e.position`,
      [actor.companyId, actor.userId, PREFERENCE_EVENTS],
    );
    return { items: rows.rows };
  });

  // DF12: celebration publication is opt-in; optional receipt, in-app or by email, can be switched off. Mandatory notices cannot, on either
  // channel: the dispatcher and the email worker read a preference for optional events only.
  app.put('/me/notification-preferences', { config: { assignmentOptional: true }, schema: { body: preferenceSchema } }, async (request) => {
    const actor = actorOf(request);
    const body = request.body as { eventType: string; publishCelebration?: boolean; receiveOptional?: boolean; receiveEmail?: boolean };
    return withTransaction(db, async (tx) => {
      const row = (
        await tx.query<{ eventType: string; publishCelebration: boolean; receiveOptional: boolean }>(
          `insert into notification_preference (company_id, user_id, event_type, channel, publish_celebration, receive_optional, created_by, updated_by)
           values ($1, $2, $3, 'IN_APP', coalesce($4, false), coalesce($5, true), $2, $2)
           on conflict (company_id, user_id, event_type, channel) do update
             set publish_celebration = coalesce($4, notification_preference.publish_celebration),
                 receive_optional = coalesce($5, notification_preference.receive_optional), updated_by = $2
           returning event_type as "eventType", publish_celebration as "publishCelebration", receive_optional as "receiveOptional"`,
          [actor.companyId, actor.userId, body.eventType, body.publishCelebration ?? null, body.receiveOptional ?? null],
        )
      ).rows[0]!;
      const email = (
        await tx.query<{ receiveEmail: boolean }>(
          body.receiveEmail === undefined
            ? `select coalesce((select receive_optional from notification_preference where company_id = $1 and user_id = $2 and event_type = $3 and channel = 'EMAIL'), true) as "receiveEmail"`
            : `insert into notification_preference (company_id, user_id, event_type, channel, publish_celebration, receive_optional, created_by, updated_by)
               values ($1, $2, $3, 'EMAIL', false, $4, $2, $2)
               on conflict (company_id, user_id, event_type, channel) do update set receive_optional = $4, updated_by = $2
               returning receive_optional as "receiveEmail"`,
          body.receiveEmail === undefined ? [actor.companyId, actor.userId, body.eventType] : [actor.companyId, actor.userId, body.eventType, body.receiveEmail],
        )
      ).rows[0]!;
      return { ...row, receiveEmail: email.receiveEmail };
    });
  });

  // FR-085 / FR-061 rule configuration: every revision with its wording and whether it is in force.
  app.get(
    '/notifications/rules',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' } } } } },
    async (request) => {
      const grant = await requireAccess(db, request, 'notification', 'manage_rules', ['operational']);
      return listRules(db, grant, (request.query as { code?: string }).code);
    },
  );

  // C6 "publication ... require business owner approval": what waits for a decision, and the decision, by someone other than the author.
  app.get('/notifications/rules/proposals', async (request) => {
    const grant = await requireAccess(db, request, 'notification', 'approve_rules', ['operational']);
    return listRuleProposals(db, grant);
  });

  app.post(
    '/notifications/rules/proposals/:id/publish',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion: { type: 'integer', minimum: 1 } } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const { expectedVersion } = request.body as { expectedVersion: number };
      const grant = await requireAccess(db, request, 'notification', 'approve_rules', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => publishRuleRevision(tx, grant, id, expectedVersion));
    },
  );

  app.post(
    '/notifications/rules/proposals/:id/reject',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion', 'reason'],
          properties: { expectedVersion: { type: 'integer', minimum: 1 }, reason: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const { expectedVersion, reason } = request.body as { expectedVersion: number; reason: string };
      const grant = await requireAccess(db, request, 'notification', 'approve_rules', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => rejectRuleRevision(tx, grant, id, expectedVersion, reason));
    },
  );

  // A rule change is a new revision effective from a future date, audited with its reason (FR-085 acceptance).
  app.post(
    '/notifications/rules/:code/revisions',
    {
      schema: {
        params: { type: 'object', required: ['code'], properties: { code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' } } },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedRevision', 'effectiveFrom', 'reason'],
          properties: {
            expectedRevision: { type: 'integer', minimum: 1 },
            effectiveFrom: { type: 'string', format: 'date-time' },
            active: { type: 'boolean' },
            subjectTemplate: { type: ['string', 'null'], maxLength: 200 },
            bodyTemplate: { type: 'string', minLength: 1, maxLength: 1000 },
            reason: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const { code } = request.params as { code: string };
      const grant = await requireAccess(db, request, 'notification', 'manage_rules', ['operational'], { requireAll: true });
      const result = await withTransaction(db, (tx) => reviseRule(tx, grant, code, request.body as RuleRevisionInput));
      reply.status(201);
      return result;
    },
  );

  // FR-085 "configurable supported channels"; DF12: email for one event, proposed from its in-app rule and in force only once someone
  // else publishes it (the proposals routes above). Nothing is sent until the worker also has SMTP settings (mail/config.ts).
  app.post(
    '/notifications/rules/:code/email',
    {
      schema: {
        params: { type: 'object', required: ['code'], properties: { code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' } } },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['effectiveFrom', 'reason'],
          properties: {
            effectiveFrom: { type: 'string', format: 'date-time' },
            subjectTemplate: { type: 'string', minLength: 1, maxLength: 150 },
            bodyTemplate: { type: 'string', minLength: 1, maxLength: 1000 },
            reason: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' },
          },
        },
      },
    },
    async (request, reply) => {
      const { code } = request.params as { code: string };
      const grant = await requireAccess(db, request, 'notification', 'manage_rules', ['operational'], { requireAll: true });
      const result = await withTransaction(db, (tx) => proposeEmailRule(tx, grant, code, request.body as EmailRuleInput));
      reply.status(201);
      return result;
    },
  );

  // Delivery log for support: states and attempts only, no message content (FR-085, §11.2). Without a page it answers the
  // capped first slice it always did, and `total` says how many match.
  app.get('/notifications/delivery', { schema: { querystring: deliveryQuery } }, async (request) => {
    const grant = await requireAccess(db, request, 'notification', 'read_delivery', ['operational']);
    const q = request.query as DeliveryFilters & Paging;
    if (q.from && q.to && q.to < q.from) throw new HttpError(422, 'INVALID_PERIOD', 'The period end is before its start');
    const p = new SqlParams([grant.companyId]);
    return pageOf(db, `${DELIVERY_LIST_SELECT} where ${deliveryCondition('$1', p, q, grant)}`, p.values, `"occurredAt" desc, id`, q, 200);
  });

  // FR-061, BR-034: an event that failed to dispatch has no notification to show in the log above, so it is listed here:
  // retrying, or given up on after its last retry. Topic, attempts and the error class only, never the payload.
  app.get('/notifications/delivery/failed-events', { schema: { querystring: failedEventsQuery } }, async (request) => {
    const grant = await requireAccess(db, request, 'notification', 'read_delivery', ['operational']);
    const q = request.query as FailedEventFilters & Paging;
    if (q.from && q.to && q.to < q.from) throw new HttpError(422, 'INVALID_PERIOD', 'The period end is before its start');
    const p = new SqlParams([grant.companyId]);
    return pageOf(db, `${FAILED_EVENT_LIST_SELECT} where ${failedEventCondition('$1', p, q)}`, p.values, `"occurredAt" desc, id`, q, 200);
  });
}
