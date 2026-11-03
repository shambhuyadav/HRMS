import type { FastifyInstance } from 'fastify';
import { optionalPaging, type Paging, pageOf } from '../../db/paging.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { actorOf } from '../../http/context.js';
import { notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import { listRules, type RuleRevisionInput, reviseRule } from './rules.js';

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
  },
} as const;

const deliveryQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: { type: 'string', enum: ['QUEUED', 'DELIVERED', 'RETRY_PENDING', 'FAILED', 'SUPPRESSED'] },
    category: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' },
    ...optionalPaging,
  },
} as const;

const failedEventsQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: { type: 'string', enum: ['FAILED', 'RETRYING'] },
    ...optionalPaging,
  },
} as const;

export async function notificationRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  // The inbox belongs to the user; it needs no selected role but stays company-scoped.
  app.get('/me/notifications', { config: { assignmentOptional: true } }, async (request) => {
    const actor = actorOf(request);
    const rows = await db.query<{ id: string; category: string; title: string | null; body: string; occurredAt: string; readAt: string | null }>(
      `select id, category, title, body, occurred_at as "occurredAt", read_at as "readAt"
         from notification where company_id = $1 and recipient_user_id = $2 and state = 'DELIVERED'
        order by occurred_at desc limit 100`,
      [actor.companyId, actor.userId],
    );
    return { items: rows.rows, unread: rows.rows.filter((r) => r.readAt === null).length };
  });

  app.post('/me/notifications/:id/read', { config: { assignmentOptional: true }, schema: { params: idParams } }, async (request) => {
    const actor = actorOf(request);
    const { id } = request.params as { id: string };
    const res = await db.query(
      `update notification set read_at = coalesce(read_at, now()) where company_id = $1 and id = $2 and recipient_user_id = $3 and state = 'DELIVERED'`,
      [actor.companyId, id, actor.userId],
    );
    if (!res.rowCount) throw notFound();
    return { id, read: true };
  });

  // FR-085: the user's own preferences, with DF12's defaults for an event never saved (publication off, receipt on).
  app.get('/me/notification-preferences', { config: { assignmentOptional: true } }, async (request) => {
    const actor = actorOf(request);
    const rows = await db.query<{ eventType: string; publishCelebration: boolean; receiveOptional: boolean }>(
      `select e.event_type as "eventType", coalesce(p.publish_celebration, false) as "publishCelebration", coalesce(p.receive_optional, true) as "receiveOptional"
         from unnest($3::text[]) with ordinality as e (event_type, position)
         left join notification_preference p on p.company_id = $1 and p.user_id = $2 and p.event_type = e.event_type and p.channel = 'IN_APP'
        order by e.position`,
      [actor.companyId, actor.userId, PREFERENCE_EVENTS],
    );
    return { items: rows.rows };
  });

  // DF12: celebration publication is opt-in; optional receipt can be switched off. Mandatory notices cannot.
  app.put('/me/notification-preferences', { config: { assignmentOptional: true }, schema: { body: preferenceSchema } }, async (request) => {
    const actor = actorOf(request);
    const body = request.body as { eventType: string; publishCelebration?: boolean; receiveOptional?: boolean };
    const row = (
      await db.query(
        `insert into notification_preference (company_id, user_id, event_type, channel, publish_celebration, receive_optional, created_by, updated_by)
         values ($1, $2, $3, 'IN_APP', coalesce($4, false), coalesce($5, true), $2, $2)
         on conflict (company_id, user_id, event_type, channel) do update
           set publish_celebration = coalesce($4, notification_preference.publish_celebration),
               receive_optional = coalesce($5, notification_preference.receive_optional), updated_by = $2
         returning event_type as "eventType", publish_celebration as "publishCelebration", receive_optional as "receiveOptional"`,
        [actor.companyId, actor.userId, body.eventType, body.publishCelebration ?? null, body.receiveOptional ?? null],
      )
    ).rows[0];
    return row;
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

  // Delivery log for support: states and attempts only, no message content (FR-085, §11.2). Without a page it answers the
  // capped first slice it always did, and `total` says how many match.
  app.get('/notifications/delivery', { schema: { querystring: deliveryQuery } }, async (request) => {
    const grant = await requireAccess(db, request, 'notification', 'read_delivery', ['operational']);
    const q = request.query as { state?: string; category?: string } & Paging;
    return pageOf(
      db,
      `select n.id, n.category, n.channel, n.state, n.recipient_user_id as "recipientUserId", u.account_key as "recipientAccount", n.occurred_at as "occurredAt",
              (select count(*)::int from notification_delivery_attempt a where a.company_id = n.company_id and a.notification_id = n.id) as attempts,
              (select a.failure_code from notification_delivery_attempt a where a.company_id = n.company_id and a.notification_id = n.id
                order by a.attempt_number desc limit 1) as "lastFailureCode"
         from notification n join user_account u on u.id = n.recipient_user_id
        where n.company_id = $1 and ($2::text is null or n.state = $2) and ($3::text is null or n.category = $3)`,
      [grant.companyId, q.state ?? null, q.category ?? null],
      `"occurredAt" desc, id`,
      q,
      200,
    );
  });

  // FR-061, BR-034: an event that failed to dispatch has no notification to show in the log above, so it is listed here:
  // retrying, or given up on after its last retry. Topic, attempts and the error class only, never the payload.
  app.get('/notifications/delivery/failed-events', { schema: { querystring: failedEventsQuery } }, async (request) => {
    const grant = await requireAccess(db, request, 'notification', 'read_delivery', ['operational']);
    const q = request.query as { state?: 'FAILED' | 'RETRYING' } & Paging;
    return pageOf(
      db,
      `select e.id::text as id, e.topic, case when e.failed_at is not null then 'FAILED' else 'RETRYING' end as state, e.created_at as "occurredAt",
              e.attempts, e.last_error as "failureCode", e.next_attempt_at as "nextAttemptAt", e.failed_at as "failedAt"
         from outbox_event e
        where e.company_id = $1 and e.published_at is null and e.attempts > 0
          and ($2::text is null or ($2 = 'FAILED') = (e.failed_at is not null))`,
      [grant.companyId, q.state ?? null],
      `"occurredAt" desc, id`,
      q,
      200,
    );
  });
}
