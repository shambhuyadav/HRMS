// Audit and outbox writers (FR-057, DB082; BR-033). Both run inside the business transaction.
import type { Queryable } from '../db/queryable.js';

export interface AuditEntry {
  companyId: string;
  resource: string;
  recordKey: string;
  actorUserId: string;
  actingAssignmentId: string | null;
  action: string;
  priorVersion?: number | null;
  newVersion?: number | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
}

export async function writeAudit(db: Queryable, e: AuditEntry): Promise<void> {
  await db.query(
    `insert into audit_event (company_id, resource_code, record_key, actor_user_id, acting_assignment_id, action,
                              prior_version, new_version, before_values, after_values, reason, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $4)`,
    [
      e.companyId,
      e.resource,
      e.recordKey,
      e.actorUserId,
      e.actingAssignmentId,
      e.action,
      e.priorVersion ?? null,
      e.newVersion ?? null,
      e.before ?? null,
      e.after ?? null,
      e.reason ?? null,
    ],
  );
}

/**
 * Outbox payloads carry identifiers and, where an event must describe the state it was raised for (e.g. the
 * revision and dates of a decided request), operational values — never confidential values.
 */
export async function enqueueEvent(
  db: Queryable,
  e: { companyId: string; topic: string; aggregateId: string; dedupeKey: string; payload: Record<string, string | number | null> },
): Promise<void> {
  await db.query(
    `insert into outbox_event (company_id, topic, aggregate_id, dedupe_key, payload)
     values ($1, $2, $3, $4, $5) on conflict (company_id, dedupe_key) do nothing`,
    [e.companyId, e.topic, e.aggregateId, e.dedupeKey, e.payload],
  );
}
