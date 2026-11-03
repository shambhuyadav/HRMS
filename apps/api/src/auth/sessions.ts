// Session store (DF10): idle timeout 30 minutes, absolute lifetime 12 hours, revocation effective on the next
// request. PostgreSQL implementation; the interface lets the scale design swap in the session cache (ADR-05).
import type { Queryable } from '../db/queryable.js';

export const IDLE_TIMEOUT_MINUTES = 30;
/** last_seen is written at most once per this interval per session, bounding write load. */
export const TOUCH_INTERVAL_SECONDS = 60;

export type SessionCheck = 'OK' | 'UNKNOWN' | 'REVOKED' | 'EXPIRED' | 'IDLE' | 'WRONG_USER';

export interface SessionStore {
  create(userId: string, lifetimeSeconds: number): Promise<string>;
  check(sessionId: string, userId: string): Promise<SessionCheck>;
  revoke(sessionId: string): Promise<void>;
}

export function postgresSessionStore(db: Queryable): SessionStore {
  return {
    async create(userId, lifetimeSeconds) {
      return (
        await db.query<{ id: string }>(`insert into user_session (user_id, expires_at) values ($1, now() + make_interval(secs => $2)) returning id`, [
          userId,
          lifetimeSeconds,
        ])
      ).rows[0]!.id;
    },
    async check(sessionId, userId) {
      // One statement: classify, and refresh last_seen only for a live session whose last touch is stale.
      const row = (
        await db.query<{ result: SessionCheck }>(
          `with s as (select * from user_session where id = $1),
                touched as (
                  update user_session set last_seen_at = now()
                   where id = $1 and user_id = $2 and revoked_at is null and expires_at > now()
                     and last_seen_at > now() - make_interval(mins => $3)
                     and last_seen_at < now() - make_interval(secs => $4)
                  returning id)
           select case when not exists (select 1 from s) then 'UNKNOWN'
                       when (select user_id from s) <> $2 then 'WRONG_USER'
                       when (select revoked_at from s) is not null then 'REVOKED'
                       when (select expires_at from s) <= now() then 'EXPIRED'
                       when (select last_seen_at from s) <= now() - make_interval(mins => $3) then 'IDLE'
                       else 'OK' end as result`,
          [sessionId, userId, IDLE_TIMEOUT_MINUTES, TOUCH_INTERVAL_SECONDS],
        )
      ).rows[0]!;
      return row.result;
    },
    async revoke(sessionId) {
      await db.query(`update user_session set revoked_at = coalesce(revoked_at, now()) where id = $1`, [sessionId]);
    },
  };
}
