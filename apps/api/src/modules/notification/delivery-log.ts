// The delivery log's rows and filters (FR-085; FR-093; section 11.2 "Event, recipient/channel, attempt count, outcome and failure;
// no secrets or unneeded private message payload"; BR-034), one definition for GET /notifications/delivery,
// GET /notifications/delivery/failed-events and their export, so a filtered list and its export hold the same records (ZT17).
// States, attempts and error classes only, never a message body or an event payload.
import type { SqlParams } from '../access/authorize.js';

/** Company-local dates (inclusive) of when the record occurred. */
export interface DeliveryPeriod {
  from?: string | undefined;
  to?: string | undefined;
}

export interface DeliveryFilters extends DeliveryPeriod {
  state?: string | undefined;
  category?: string | undefined;
}

export interface FailedEventFilters extends DeliveryPeriod {
  state?: string | undefined;
}

/** The states a notification or a dispatch that failed can be in: the export's `status`. */
export const NOTIFICATION_STATES = ['QUEUED', 'DELIVERED', 'RETRY_PENDING', 'FAILED', 'SUPPRESSED'] as const;
export const FAILED_EVENT_STATES = ['FAILED', 'RETRYING'] as const;

/** The period over `alias.column`, its dates read in the record's company time. */
const inPeriod = (alias: string, column: string, p: SqlParams, f: DeliveryPeriod) => {
  const zone = `(select c.business_timezone from company c where c.id = ${alias}.company_id)`;
  return [
    ...(f.from ? [`${alias}.${column} >= (${p.add(f.from)}::date)::timestamp at time zone ${zone}`] : []),
    ...(f.to ? [`${alias}.${column} < (${p.add(f.to)}::date + 1)::timestamp at time zone ${zone}`] : []),
  ];
};

const LAST_FAILURE = `(select a.failure_code from notification_delivery_attempt a where a.company_id = n.company_id and a.notification_id = n.id order by a.attempt_number desc limit 1)`;
const ATTEMPTS = `(select count(*)::int from notification_delivery_attempt a where a.company_id = n.company_id and a.notification_id = n.id)`;

/** The notifications' condition (alias n, `company` an added parameter). */
export function deliveryCondition(company: string, p: SqlParams, f: DeliveryFilters): string {
  return [
    `n.company_id = ${company}::uuid`,
    ...(f.state ? [`n.state = ${p.add(f.state)}`] : []),
    ...(f.category ? [`n.category = ${p.add(f.category)}`] : []),
    ...inPeriod('n', 'occurred_at', p, f),
  ].join(' and ');
}

/** The rows of GET /notifications/delivery. */
export const DELIVERY_LIST_SELECT = `select n.id, n.category, n.channel, n.state, n.recipient_user_id as "recipientUserId", u.account_key as "recipientAccount", n.occurred_at as "occurredAt",
              ${ATTEMPTS} as attempts, ${LAST_FAILURE} as "lastFailureCode"
         from notification n join user_account u on u.id = n.recipient_user_id`;

/** The condition of an event that failed to dispatch: retrying, or given up on after its last retry (alias e). */
export function failedEventCondition(company: string, p: SqlParams, f: FailedEventFilters): string {
  return [
    `e.company_id = ${company}::uuid`,
    `e.published_at is null`,
    `e.attempts > 0`,
    ...(f.state === 'FAILED' ? [`e.failed_at is not null`] : f.state === 'RETRYING' ? [`e.failed_at is null`] : []),
    ...inPeriod('e', 'created_at', p, f),
  ].join(' and ');
}

/** The rows of GET /notifications/delivery/failed-events. */
export const FAILED_EVENT_LIST_SELECT = `select e.id::text as id, e.topic, case when e.failed_at is not null then 'FAILED' else 'RETRYING' end as state, e.created_at as "occurredAt",
              e.attempts, e.last_error as "failureCode", e.next_attempt_at as "nextAttemptAt", e.failed_at as "failedAt"
         from outbox_event e`;

/**
 * The export's rows: both lists in one, newest first as they sort. A notification names its event, occurrence, recipient and
 * channel; a failed dispatch has no recipient yet, so it names its topic. `status` is matched against each list's states, and
 * `category`, being an event type, leaves failed dispatches out, as the list of them takes no such filter.
 */
export function deliveryExportSql(p: SqlParams, company: string, f: DeliveryFilters): string {
  const notifications = deliveryCondition(company, p, f);
  const dispatches = f.category || (f.state && !(FAILED_EVENT_STATES as readonly string[]).includes(f.state)) ? null : failedEventCondition(company, p, f);
  const local = (column: string) => `to_char(${column} at time zone c.business_timezone, 'YYYY-MM-DD HH24:MI:SS')`;
  const rows = [
    `select n.id::text as id, n.occurred_at as sort_at, ${local('n.occurred_at')} as occurred_at, 'NOTIFICATION' as source, n.category as event, to_char(ev.occurrence_date, 'YYYY-MM-DD') as occurrence,
            u.account_key as recipient, n.channel, ${ATTEMPTS} as attempts, n.state as outcome, ${LAST_FAILURE} as failure_code
       from notification n join user_account u on u.id = n.recipient_user_id join company c on c.id = n.company_id
       left join notification_event ev on ev.company_id = n.company_id and ev.id = n.event_id
      where ${notifications}`,
    ...(dispatches
      ? [
          `select e.id::text, e.created_at, ${local('e.created_at')}, 'DISPATCH', e.topic, null, null, null, e.attempts, case when e.failed_at is not null then 'FAILED' else 'RETRYING' end, e.last_error
             from outbox_event e join company c on c.id = e.company_id
            where ${dispatches}`,
        ]
      : []),
  ];
  return `select id, occurred_at, source, event, occurrence, recipient, channel, attempts, outcome, failure_code from (${rows.join(' union all ')}) x order by sort_at desc, id`;
}
