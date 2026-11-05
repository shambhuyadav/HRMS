// Proves a transaction re-checks authority (http/guard.ts reassertAccess). Fires a request that passes the route guard and then, inside
// its transaction, waits for the assignment row this helper holds (reassertAccess share-locks it). The allowlist is switched off
// meanwhile, wholly or for one permission's action, so only that check can refuse the request.
import { expect } from 'vitest';
import type { Company, Harness, TestActor } from './harness.js';

export async function revokedAfterGuard<T>(h: Harness, company: Company, a: TestActor, fire: () => Promise<T>, only?: { resource: string; action: string }): Promise<T> {
  await h.db.query('begin');
  let pending: Promise<T> | undefined;
  try {
    await h.db.query(`select 1 from role_assignment where company_id = $1 and id = $2 for update`, [company.id, a.assignment]);
    pending = fire();
    let blocked = false;
    for (let i = 0; i < 400 && !blocked; i++) {
      blocked = ((await h.pool.query(`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`)).rowCount ?? 0) > 0;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(blocked).toBe(true);
    await h.db.query(
      `update role_assignment_permission rap set active = false from permission p
        where rap.company_id = $1 and rap.role_assignment_id = $2 and p.id = rap.permission_id and ($3::text is null or (p.resource = $3 and p.action = $4))`,
      [company.id, a.assignment, only?.resource ?? null, only?.action ?? null],
    );
  } finally {
    await h.db.query('commit');
  }
  return pending!;
}
