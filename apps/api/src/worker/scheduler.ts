// Scheduled work (DF09, DF12, DF03, DF11). One tick, in the order it starts:
//   outbox relay  the critical queue, outside the company loop: drained before anything else, again every
//                 OUTBOX_RELAY_INTERVAL_MS for as long as the tick runs, and once more at its end, so a long tick still relays and
//                 a slow company's jobs delay nobody's notifications. One event per company in turn (dispatchOutbox).
//   scans         (with a file store and a scanner) beside the company loop: up to SCAN_PER_TICK due uploads, one per company in
//                 turn, retried with backoff up to an attempt limit (storage/scan.ts). Uploads never wait for the scanner (NFR-S09).
//   reports       beside the company loop: up to REPORTS_PER_TICK, one per company in turn (processReportQueue).
//   bulk jobs     up to BULK_CHUNKS_PER_TICK chunks (NFR-S09), each chunk transaction under the bulk statement budget
//                 (bulkChunkBudget), not the API's interactive one.
//   company loop  every active company in turn, its due runs only. Times are company-local:
//     private profile changes  daily from 00:00: approved sensitive changes whose effective date has arrived (H2)
//     module daily jobs        from their own start hour (modules/jobs-registry.ts)
//     reminders                daily from 08:00: approval and confirmation reminders, and document expiry (DF12) for the
//                              company-local date, in chunks (notification/reminders.ts)
//     celebrations             daily from 09:00 (DF12), notices written in batches (runCelebrations)
//     biometric                every 15 minutes, plus a nightly 7-day lookback from 02:00 (DF09)
// Each due run is claimed once in scheduled_job_run, so any number of workers can tick concurrently without duplicating a run: the
// insert's conflict decides. The tick reads which of its due runs are already settled first, in one statement, so a run that is not
// due again costs no insert; that read only ever skips a row that exists, so it cannot let a run through twice.
// Reminders and celebrations work in several transactions, so they alone can be taken over: their claim holds a lease that the worker
// renews while it works. A worker that dies stops renewing, and after the lease another claims the run and finishes what is left; a
// run that failed waits 1, 5 then 15 minutes (ADR-13) before the same. Their event keys and positions keep every recipient to one notice.
// A failure in one company holds back neither the other companies nor the queues; it is reported at the end of the tick.
// None of the numbers here is measured: each is a starting value for G4.
import { newScope, positiveIntFromEnv, runInScope, type StatementBudget } from '../db/budget.js';
import type { Queryable } from '../db/queryable.js';
import type { Database } from '../db/transaction.js';
import type { ProviderRegistry } from '../modules/biometric/routes.js';
import { runSync } from '../modules/biometric/sync.js';
import { failureCode, RETRY_MINUTES } from '../modules/bulk/retry.js';
import { runBulkJobs } from '../modules/bulk/service.js';
import { dispatchOutbox, runCelebrations } from '../modules/notification/dispatcher.js';
import { runDocumentExpiry, runReminders } from '../modules/notification/reminders.js';
import { processReportQueue } from '../modules/report/service.js';
import { MODULE_DAILY_JOBS } from '../modules/jobs-registry.js';
import { applyDueChanges } from '../modules/sensitive-change/service.js';
import type { FileStore } from '../storage/files.js';
import { type ScanProvider, scanDueAttachments, type ScanSettings, scanSettings } from '../storage/scan.js';

export interface SchedulerDeps {
  db: Database;
  providers: ProviderRegistry;
  /** Account recorded as the actor of scheduled runs: SYSTEM_ACTOR_ID (audit/actors.ts), which is no person and can do nothing else. */
  systemUserId: string;
  /** FR-106: with both, uploads waiting for a scan verdict are scanned on each tick, with backoff and an attempt limit. */
  files?: FileStore;
  scanner?: ScanProvider;
  /** Statement budget of bulk-job chunk transactions; bulkChunkBudget() when absent. */
  bulkBudget?: StatementBudget;
  /** Scan limits; scanSettings() when absent. */
  scan?: ScanSettings;
  /** Relay and lease values; workerSettings() when absent. */
  settings?: WorkerSettings;
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

/** Starting values, none of them measured (G4). */
export interface WorkerSettings {
  /** Outbox events one relay pass may claim (OUTBOX_RELAY_BATCH). */
  relayBatch: number;
  /** The wait between relay passes during a tick (OUTBOX_RELAY_INTERVAL_MS). */
  relayIntervalMs: number;
  /** How long a takeable run's holder is presumed alive without renewing (SCHEDULED_RUN_LEASE_MS). */
  runLeaseMs: number;
}

export const workerSettings = (): WorkerSettings => ({
  relayBatch: positiveIntFromEnv('OUTBOX_RELAY_BATCH') ?? 500,
  relayIntervalMs: positiveIntFromEnv('OUTBOX_RELAY_INTERVAL_MS') ?? 5_000,
  runLeaseMs: positiveIntFromEnv('SCHEDULED_RUN_LEASE_MS') ?? 300_000,
});

const BIOMETRIC_SLOT_MINUTES = 15;
const LOOKBACK_DAYS = 7;
/** Bulk-job chunk transactions per tick and worker (each at most BULK_CHUNK_SIZE employees); a starting value, to be measured (G4). */
export const BULK_CHUNKS_PER_TICK = 20;
/** Reports generated per tick and worker; a starting value, to be measured (G4). */
export const REPORTS_PER_TICK = 50;

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

const leaseInterval = `make_interval(secs => $2::double precision / 1000)`;

/**
 * Claims a run that may be taken over: a new one, or an unfinished one whose lease has lapsed. Answers how many claims it has now had
 * (a run that keeps killing its worker is counted, as a report's is), or null when another worker holds it or it has finished.
 */
async function claimLease(db: Queryable, runKey: string, leaseMs: number, jobCode: string, companyId: string | null): Promise<number | null> {
  const res = await db.query<{ attempts: number }>(
    `insert into scheduled_job_run (run_key, job_code, company_id, lease_until, attempts) values ($1, $3, $4, now() + ${leaseInterval}, 1)
     on conflict (run_key) do update set lease_until = excluded.lease_until, attempts = scheduled_job_run.attempts + 1
       where scheduled_job_run.finished_at is null and scheduled_job_run.lease_until <= now()
     returning attempts`,
    [runKey, leaseMs, jobCode, companyId],
  );
  return res.rows[0]?.attempts ?? null;
}

/** As runOnce, for work in several transactions that a rerun finishes without repeating anything (reminders, celebrations). */
async function runResumable(db: Queryable, runKey: string, jobCode: string, companyId: string, leaseMs: number, work: () => Promise<unknown>) {
  const attempts = await claimLease(db, runKey, leaseMs, jobCode, companyId);
  if (attempts === null) return null;
  // A run takes at most one attempt more than it has retries, however its attempts ended.
  if (attempts > RETRY_MINUTES.length + 1) {
    await finish(db, runKey, 'FAILED', { message: 'WORKER_INTERRUPTED' });
    return null;
  }
  // While this worker lives the run stays its own, however long the work takes.
  const renewal = setInterval(() => {
    void db.query(`update scheduled_job_run set lease_until = now() + ${leaseInterval} where run_key = $1 and finished_at is null`, [runKey, leaseMs]).catch(() => undefined);
  }, Math.max(1, Math.floor(leaseMs / 3)));
  renewal.unref();
  try {
    const detail = await work();
    clearInterval(renewal);
    await finish(db, runKey, 'OK', detail);
    return detail;
  } catch (err) {
    clearInterval(renewal);
    const delay = RETRY_MINUTES[attempts - 1];
    if (delay === undefined) await finish(db, runKey, 'FAILED', { message: (err as Error).message });
    else {
      await db.query(`update scheduled_job_run set lease_until = now() + make_interval(mins => $2), detail = $3 where run_key = $1`, [runKey, delay, JSON.stringify({ attempt: attempts, errorCode: failureCode(err) })]);
    }
    return null;
  }
}

/** One relay for one tick: a first pass at once, then one per interval until stopped. A failed pass is kept for the end of the tick and the relay goes on. */
function startOutboxRelay(db: Database, settings: WorkerSettings) {
  let dispatched = 0;
  let failure: { error: unknown } | null = null;
  let stopping = false;
  let wake = () => {};
  const pass = async () => {
    const result = await settle(() => dispatchOutbox(db, settings.relayBatch));
    if (result.ok) dispatched += result.value;
    else failure ??= { error: result.error };
  };
  const first = pass();
  const loop = first.then(async () => {
    while (!stopping) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, settings.relayIntervalMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      if (!stopping) await pass();
    }
  });
  return {
    first,
    /** Ends the relay, with one last pass for whatever the tick itself raised. */
    async stop() {
      stopping = true;
      wake();
      await loop;
      await pass();
      return { dispatched, failure };
    },
  };
}

interface Company {
  id: string;
  local_date: string;
  local_hour: number;
}

interface BiometricProfile {
  id: string;
  company_id: string;
  code: string;
  synced_until: Date | null;
  lookback_minutes: number;
}

/** A run that is due on this tick. */
interface DueRun {
  key: string;
  code: string;
  /** What the tick's `ran` list says when the run did something. */
  label: string;
  companyId: string;
  /** Works in several transactions and can be taken over (runResumable). */
  resumable?: boolean;
  work: () => Promise<unknown>;
}

/** The runs due for a company at this time, in the order they run. */
function dueRuns(deps: SchedulerDeps, c: Company, profiles: BiometricProfile[], at: Date): DueRun[] {
  const { db } = deps;
  const run = (code: string, work: () => Promise<unknown>, resumable = false): DueRun => ({ key: `${code}:${c.id}:${c.local_date}`, code, label: `${code}:${c.id}`, companyId: c.id, resumable, work });
  const runs = [run('PRIVATE_PROFILE_CHANGES', () => applyDueChanges(db, c.id, c.local_date, deps.systemUserId))];
  // Daily jobs of active business modules (modules/jobs-registry.ts).
  for (const job of MODULE_DAILY_JOBS) {
    if (c.local_hour >= job.fromHour) runs.push(run(job.code, () => job.run(db, c.id, c.local_date, deps.systemUserId)));
  }
  if (c.local_hour >= 8) {
    // Both parts are attempted even when one fails.
    const reminders = async () => {
      const [due, expiry] = [await settle(() => runReminders(db, c.id)), await settle(() => runDocumentExpiry(db, c.id, c.local_date))];
      if (!due.ok) throw due.error;
      if (!expiry.ok) throw expiry.error;
      return { ...due.value, documentExpiry: expiry.value };
    };
    runs.push(run('REMINDERS', reminders, true));
  }
  if (c.local_hour >= 9) runs.push(run('CELEBRATIONS', () => runCelebrations(db, c.id, c.local_date), true));
  for (const p of profiles) {
    const provider = deps.providers.get(p.code);
    if (!provider) continue; // no adapter: nothing runs (DF13)
    const slot = Math.floor(at.getTime() / (BIOMETRIC_SLOT_MINUTES * 60_000));
    const windowStart = p.synced_until ?? new Date(at.getTime() - p.lookback_minutes * 60_000);
    runs.push({
      key: `BIOMETRIC:${p.id}:${slot}`,
      code: 'BIOMETRIC_FETCH',
      label: `BIOMETRIC:${p.code}`,
      companyId: c.id,
      work: () => runSync(db, { companyId: c.id, profileId: p.id, actorUserId: deps.systemUserId, windowStart, windowEnd: at }, provider),
    });
    if (c.local_hour >= 2) {
      runs.push({
        key: `BIOMETRIC_LOOKBACK:${p.id}:${c.local_date}`,
        code: 'BIOMETRIC_LOOKBACK',
        label: `BIOMETRIC_LOOKBACK:${p.code}`,
        companyId: c.id,
        work: () => runSync(db, { companyId: c.id, profileId: p.id, actorUserId: deps.systemUserId, windowStart: new Date(at.getTime() - LOOKBACK_DAYS * 86_400_000), windowEnd: at }, provider),
      });
    }
  }
  return runs;
}

/**
 * Of these runs, those that need no claim attempt: claimed before and not open to takeover. A row only ever exists once its run has
 * been claimed, so skipping one can never let a run through twice; a run claimed after this read still loses at its claim's insert.
 */
async function settledRuns(db: Queryable, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db.query<{ run_key: string }>(`select run_key from scheduled_job_run where run_key = any($1::text[]) and (lease_until is null or finished_at is not null or lease_until > now())`, [keys]);
  return new Set(rows.rows.map((r) => r.run_key));
}

export async function runScheduledJobs(deps: SchedulerDeps, at: Date = new Date()) {
  const { db } = deps;
  const settings = deps.settings ?? workerSettings();
  const ran: string[] = [];
  const companyFailures: unknown[] = [];
  const relay = startOutboxRelay(db, settings);
  await relay.first;
  // Scans and reports run beside the loop, each one step at a time: a slow scanner or a long report holds back no company, and a slow
  // company none of them. Started here, outside the bulk scope below, so they keep the pool's statement defaults.
  const scanning = settle(async () => (deps.files && deps.scanner ? scanDueAttachments(db, deps.files, deps.scanner, deps.scan ?? scanSettings()) : null));
  const reporting = settle(() => processReportQueue(db, REPORTS_PER_TICK));
  // Queued bulk jobs (attendance processing, leave accrual, increment review openings), bounded per tick. A failure here is reported at the end of
  // the tick and never holds back the company loop or the queues.
  const bulk = await settle(() => runInScope(newScope(deps.bulkBudget ?? bulkChunkBudget()), () => runBulkJobs(db, BULK_CHUNKS_PER_TICK)));
  const loop = await settle(async () => {
    const companies = (
      await db.query<Company>(
        `select id, to_char(($1::timestamptz at time zone business_timezone)::date, 'YYYY-MM-DD') as local_date,
                extract(hour from ($1::timestamptz at time zone business_timezone))::int as local_hour
           from company where active`,
        [at],
      )
    ).rows;
    const profiles = deps.providers.size === 0 ? [] : (await db.query<BiometricProfile>(`select id, company_id, code, synced_until, lookback_minutes from biometric_profile where active`)).rows;
    const profilesOf = new Map<string, BiometricProfile[]>();
    for (const p of profiles) profilesOf.set(p.company_id, [...(profilesOf.get(p.company_id) ?? []), p]);
    const runsByCompany = companies.map((c) => dueRuns(deps, c, profilesOf.get(c.id) ?? [], at));
    const settled = await settledRuns(db, runsByCompany.flat().map((r) => r.key));
    for (const runs of runsByCompany) {
      const company = await settle(async () => {
        for (const r of runs) {
          if (settled.has(r.key)) continue;
          const detail = r.resumable ? await runResumable(db, r.key, r.code, r.companyId, settings.runLeaseMs, r.work) : await runOnce(db, r.key, r.code, r.companyId, r.work);
          if (detail) ran.push(r.label);
        }
      });
      if (!company.ok) companyFailures.push(company.error);
    }
  });
  const [scanned, reported] = [await scanning, await reporting];
  const relayed = await relay.stop();
  if (!bulk.ok) throw bulk.error;
  if (!loop.ok) throw loop.error;
  if (companyFailures.length > 0) throw companyFailures[0];
  if (!scanned.ok) throw scanned.error;
  if (!reported.ok) throw reported.error;
  if (relayed.failure) throw relayed.failure.error;
  return { ran, dispatched: relayed.dispatched, reports: reported.value, bulkChunks: bulk.value, scans: scanned.value };
}
