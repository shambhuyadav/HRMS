// Scheduled work (DF09, DF12, DF03, DF11). Each due run is claimed once in scheduled_job_run, so any number of
// workers can tick concurrently without duplicating a run. Times are company-local.
//   reminders     daily from 08:00: approval and confirmation reminders, and document expiry (DF12) for the
//                 company-local date
//   celebrations  daily from 09:00 (DF12)
//   private profile changes  daily from 00:00: approved sensitive changes whose effective date has arrived (H2)
//   biometric     every 15 minutes, plus a nightly 7-day lookback from 02:00 (DF09)
//   bulk jobs     up to BULK_CHUNKS_PER_TICK chunks on every tick, before the company loop (NFR-S09), each chunk
//                 transaction under the bulk statement budget (bulkChunkBudget), not the API's interactive one
//   outbox and report queues are drained on every tick
import { newScope, positiveIntFromEnv, runInScope, type StatementBudget } from '../db/budget.js';
import type { Queryable } from '../db/queryable.js';
import type { Database } from '../db/transaction.js';
import type { ProviderRegistry } from '../modules/biometric/routes.js';
import { runSync } from '../modules/biometric/sync.js';
import { runBulkJobs } from '../modules/bulk/service.js';
import { dispatchOutbox, runCelebrations } from '../modules/notification/dispatcher.js';
import { runDocumentExpiry, runReminders } from '../modules/notification/reminders.js';
import { processReportQueue } from '../modules/report/service.js';
import { MODULE_DAILY_JOBS } from '../modules/jobs-registry.js';
import { applyDueChanges } from '../modules/sensitive-change/service.js';
import type { FileStore } from '../storage/files.js';
import { type ScanProvider, scanPendingAttachments } from '../storage/scan.js';

export interface SchedulerDeps {
  db: Database;
  providers: ProviderRegistry;
  /** Account recorded as the actor of scheduled runs (a real, active system user). */
  systemUserId: string;
  /** FR-106: with both, uploads still waiting for a scan verdict (e.g. after a scanner outage) are retried each tick. */
  files?: FileStore;
  scanner?: ScanProvider;
  /** Statement budget of bulk-job chunk transactions; bulkChunkBudget() when absent. */
  bulkBudget?: StatementBudget;
}

/**
 * Bulk chunks (docs/09 §8.2 "Worker statements": longer for bulk chunks) run with their own `set local` statement and
 * lock timeouts, longer than an interactive request's (http/deadline.ts), and no request deadline. Starting values to
 * be measured (G4); DB_BULK_STATEMENT_TIMEOUT_MS and DB_BULK_LOCK_TIMEOUT_MS override them.
 */
export function bulkChunkBudget(): StatementBudget {
  const statementTimeoutMs = positiveIntFromEnv('DB_BULK_STATEMENT_TIMEOUT_MS') ?? 60_000;
  return { statementTimeoutMs, lockTimeoutMs: Math.min(positiveIntFromEnv('DB_BULK_LOCK_TIMEOUT_MS') ?? 15_000, statementTimeoutMs) };
}

const BIOMETRIC_SLOT_MINUTES = 15;
const LOOKBACK_DAYS = 7;
/** Bulk-job chunk transactions per tick and worker (each at most BULK_CHUNK_SIZE employees); a starting value, to be measured (G4). */
export const BULK_CHUNKS_PER_TICK = 20;

async function claim(db: Queryable, runKey: string, jobCode: string, companyId: string | null): Promise<boolean> {
  const res = await db.query(`insert into scheduled_job_run (run_key, job_code, company_id) values ($1, $2, $3) on conflict (run_key) do nothing`, [runKey, jobCode, companyId]);
  return (res.rowCount ?? 0) > 0;
}

async function finish(db: Queryable, runKey: string, outcome: 'OK' | 'FAILED', detail: unknown) {
  await db.query(`update scheduled_job_run set finished_at = now(), outcome = $2, detail = $3 where run_key = $1`, [runKey, outcome, JSON.stringify(detail ?? null)]);
}

async function settle<T>(work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error };
  }
}

async function runOnce(db: Queryable, runKey: string, jobCode: string, companyId: string | null, work: () => Promise<unknown>) {
  if (!(await claim(db, runKey, jobCode, companyId))) return null;
  try {
    const detail = await work();
    await finish(db, runKey, 'OK', detail);
    return detail;
  } catch (err) {
    await finish(db, runKey, 'FAILED', { message: (err as Error).message });
    return null;
  }
}

export async function runScheduledJobs(deps: SchedulerDeps, at: Date = new Date()) {
  const { db } = deps;
  const ran: string[] = [];
  // Queued bulk jobs (attendance processing, leave accrual, increment review openings), bounded per tick. A failure here is reported at the end of
  // the tick and never holds back the company loop or the queues below.
  const bulk = await settle(() => runInScope(newScope(deps.bulkBudget ?? bulkChunkBudget()), () => runBulkJobs(db, BULK_CHUNKS_PER_TICK)));
  const companies = (
    await db.query<{ id: string; local_date: string; local_hour: number }>(
      `select id, to_char(($1::timestamptz at time zone business_timezone)::date, 'YYYY-MM-DD') as local_date,
              extract(hour from ($1::timestamptz at time zone business_timezone))::int as local_hour
         from company where active`,
      [at],
    )
  ).rows;

  for (const c of companies) {
    if (deps.files && deps.scanner) await scanPendingAttachments(db, deps.files, deps.scanner, c.id);
    const changes = () => applyDueChanges(db, c.id, c.local_date, deps.systemUserId);
    if (await runOnce(db, `PRIVATE_PROFILE_CHANGES:${c.id}:${c.local_date}`, 'PRIVATE_PROFILE_CHANGES', c.id, changes)) ran.push(`PRIVATE_PROFILE_CHANGES:${c.id}`);
    // Daily jobs of active business modules (modules/jobs-registry.ts).
    for (const job of MODULE_DAILY_JOBS) {
      if (c.local_hour < job.fromHour) continue;
      const run = () => job.run(db, c.id, c.local_date, deps.systemUserId);
      if (await runOnce(db, `${job.code}:${c.id}:${c.local_date}`, job.code, c.id, run)) ran.push(`${job.code}:${c.id}`);
    }
    // Both parts are attempted even when one fails; the run is then recorded FAILED (document expiry catches up).
    const reminders = async () => {
      const [due, expiry] = [await settle(() => runReminders(db, c.id)), await settle(() => runDocumentExpiry(db, c.id, c.local_date))];
      if (!due.ok) throw due.error;
      if (!expiry.ok) throw expiry.error;
      return { ...due.value, documentExpiry: expiry.value };
    };
    if (c.local_hour >= 8 && (await runOnce(db, `REMINDERS:${c.id}:${c.local_date}`, 'REMINDERS', c.id, reminders))) ran.push(`REMINDERS:${c.id}`);
    if (c.local_hour >= 9 && (await runOnce(db, `CELEBRATIONS:${c.id}:${c.local_date}`, 'CELEBRATIONS', c.id, () => runCelebrations(db, c.id, c.local_date)))) {
      ran.push(`CELEBRATIONS:${c.id}`);
    }

    const profiles = (
      await db.query<{ id: string; code: string; synced_until: Date | null; lookback_minutes: number }>(
        `select id, code, synced_until, lookback_minutes from biometric_profile where company_id = $1 and active`,
        [c.id],
      )
    ).rows;
    for (const p of profiles) {
      const provider = deps.providers.get(p.code);
      if (!provider) continue; // no adapter: nothing runs (DF13)
      const slot = Math.floor(at.getTime() / (BIOMETRIC_SLOT_MINUTES * 60_000));
      const windowStart = p.synced_until ?? new Date(at.getTime() - p.lookback_minutes * 60_000);
      const regular = await runOnce(db, `BIOMETRIC:${p.id}:${slot}`, 'BIOMETRIC_FETCH', c.id, () =>
        runSync(db, { companyId: c.id, profileId: p.id, actorUserId: deps.systemUserId, windowStart, windowEnd: at }, provider),
      );
      if (regular) ran.push(`BIOMETRIC:${p.code}`);
      if (c.local_hour >= 2) {
        const lookback = await runOnce(db, `BIOMETRIC_LOOKBACK:${p.id}:${c.local_date}`, 'BIOMETRIC_LOOKBACK', c.id, () =>
          runSync(db, { companyId: c.id, profileId: p.id, actorUserId: deps.systemUserId, windowStart: new Date(at.getTime() - LOOKBACK_DAYS * 86_400_000), windowEnd: at }, provider),
        );
        if (lookback) ran.push(`BIOMETRIC_LOOKBACK:${p.code}`);
      }
    }
  }

  const dispatched = await dispatchOutbox(db, 500);
  const reports = await processReportQueue(db, 50);
  if (!bulk.ok) throw bulk.error;
  return { ran, dispatched, reports, bulkChunks: bulk.value };
}
