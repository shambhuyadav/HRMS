// Malware scanning of user uploads (FR-106; H4 "failed scan quarantines"; NFR-S09). A file is quarantined (PENDING_SCAN) when
// stored and is served only once a scanner has released it as CLEAN; a finding quarantines it for good. The actual
// scanner is a deployment integration (its contract and credentials stay outside shared files); production refuses
// to start without one. The development scanner below is for synthetic data only: it recognises the industry-
// standard EICAR test string and treats everything else as clean, so tests can exercise both verdicts.
//
// An upload does not wait for the scanner (NFR-S09): buildApp gives the upload routes a scanner marked deferUploads (scanInWorker),
// so a route stores the file and answers PENDING_SCAN, and the scan worker reaches the verdict. Only a test harness can ask for the
// verdict in the request, and production refuses that (app.ts). The worker retries a file it could not scan with exponential backoff
// and jitter, up to an attempt limit (docs/09 §8.3). A file whose attempts run out stays PENDING_SCAN and is marked scan_failed_at,
// so it stays unusable and says why: nothing ever marks a file CLEAN except a scanner's CLEAN verdict. Its uploader is told, and a
// System Administrator may send it back to the worker (I-84 item 8; storage/scan-failures.ts).
import { SYSTEM_ACTOR_ID } from '../audit/actors.js';
import { writeAudit } from '../audit/audit.js';
import { positiveIntFromEnv } from '../db/budget.js';
import { companyTurns, FIRST_COMPANY } from '../db/company-turns.js';
import type { Queryable } from '../db/queryable.js';
import { type Database, withTransaction } from '../db/transaction.js';
import type { FileStore } from './files.js';

export type ScanVerdict = { verdict: 'CLEAN' } | { verdict: 'INFECTED'; finding: string } | { verdict: 'ERROR' };

export type ScanState = 'PENDING_SCAN' | 'CLEAN' | 'QUARANTINED';

export interface ScanProvider {
  scan(bytes: Buffer): Promise<ScanVerdict>;
  /** Set by scanInWorker: a stored upload waits for the scan worker and the upload route never asks this scanner (scanAttachment). */
  readonly deferUploads?: boolean;
}

/** The same scanner for upload routes that must not wait for it (NFR-S09): a stored upload is left to the scan worker. */
export const scanInWorker = (scanner: ScanProvider): ScanProvider => ({ scan: (bytes) => scanner.scan(bytes), deferUploads: true });

/** The EICAR test string, assembled at run time so this source file itself never looks like a test virus. */
export const EICAR_TEST_STRING = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-', 'ANTIVIRUS-TEST-FILE!$H+H*'].join('');
const EICAR = EICAR_TEST_STRING;

export function developmentScanner(): ScanProvider {
  if (process.env.NODE_ENV === 'production') throw new Error('The development scanner cannot be used in production');
  return {
    async scan(bytes) {
      return bytes.includes(Buffer.from(EICAR, 'latin1')) ? { verdict: 'INFECTED', finding: 'EICAR-Test-File' } : { verdict: 'CLEAN' };
    },
  };
}

/** Starting values, none of them measured (G4): each overrides through the environment. */
export interface ScanSettings {
  /** Files one worker asks about per tick (SCAN_PER_TICK). */
  perPass: number;
  /** Attempts on one file before it is marked failed (SCAN_MAX_ATTEMPTS). */
  maxAttempts: number;
  /** The wait after a first failed attempt, doubling per attempt up to SCAN_BACKOFF_MAX_MS (SCAN_BACKOFF_BASE_MS). */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** How long one scan may take before it counts as failed (SCAN_TIMEOUT_MS). */
  timeoutMs: number;
  /** A pass stops after this many failures in a row, so a scanner that is down is not asked about every waiting file (SCAN_PAUSE_AFTER_ERRORS). */
  pauseAfterErrors: number;
  /**
   * In-memory uploads one API process asks about at once (SCAN_INLINE_CONCURRENCY; I-84 item 9). One more is refused at once as "no
   * verdict" (503 SCAN_UNAVAILABLE, nothing read or saved), so scans never take more of the foreground capacity than this (NFR-S09).
   */
  inlineConcurrency: number;
}

export const scanSettings = (): ScanSettings => ({
  perPass: positiveIntFromEnv('SCAN_PER_TICK') ?? 200,
  maxAttempts: positiveIntFromEnv('SCAN_MAX_ATTEMPTS') ?? 10,
  backoffBaseMs: positiveIntFromEnv('SCAN_BACKOFF_BASE_MS') ?? 60_000,
  backoffMaxMs: positiveIntFromEnv('SCAN_BACKOFF_MAX_MS') ?? 3_600_000,
  timeoutMs: positiveIntFromEnv('SCAN_TIMEOUT_MS') ?? 30_000,
  pauseAfterErrors: positiveIntFromEnv('SCAN_PAUSE_AFTER_ERRORS') ?? 5,
  inlineConcurrency: positiveIntFromEnv('SCAN_INLINE_CONCURRENCY') ?? 4,
});

/**
 * How long a file waits after failed attempt number `attempt` (docs/09 §8.3): exponential up to the maximum, with the upper half
 * of that wait chosen at random, so files that failed together during an outage do not all come back at the same moment.
 */
export function scanBackoffMs(attempt: number, settings: Pick<ScanSettings, 'backoffBaseMs' | 'backoffMaxMs'>, random: () => number = Math.random): number {
  const wait = Math.min(settings.backoffMaxMs, settings.backoffBaseMs * 2 ** (attempt - 1));
  return Math.ceil(wait / 2 + (random() * wait) / 2);
}

/** The scanner's answer within the time allowed; a thrown error or a timeout is no verdict. */
async function ask(scanner: ScanProvider, bytes: Buffer, timeoutMs: number): Promise<ScanVerdict | { verdict: 'TIMEOUT' }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      scanner.scan(bytes),
      new Promise<{ verdict: 'TIMEOUT' }>((resolve) => {
        timer = setTimeout(() => resolve({ verdict: 'TIMEOUT' }), timeoutMs);
      }),
    ]);
  } catch {
    return { verdict: 'ERROR' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Applies a verdict while the file is still pending, so concurrent scans cannot disagree. With `notifyOwner` a quarantine also queues
 * the uploader's notice in the same statement (H7). `recorded` is false when another scan had already reached a verdict.
 */
async function recordVerdict(
  db: Queryable,
  attachment: { companyId: string; id: string },
  result: { verdict: 'CLEAN' } | { verdict: 'INFECTED'; finding: string },
  options: { notifyOwner?: boolean; actorUserId?: string },
): Promise<{ state: ScanState; recorded: boolean }> {
  const state = result.verdict === 'CLEAN' ? 'CLEAN' : 'QUARANTINED';
  const finding = result.verdict === 'INFECTED' ? result.finding.replace(/[^A-Za-z0-9._:/ -]/g, '').slice(0, 200) || 'FINDING' : null;
  const updated = await db.query<{ scan_state: 'CLEAN' | 'QUARANTINED' }>(
    `with verdict as (
       update attachment set scan_state = $3, scan_checked_at = now(), scan_finding = $4, scan_next_attempt_at = null, scan_last_error = null, scan_failed_at = null,
              updated_by = coalesce($6::uuid, updated_by)
        where company_id = $1 and id = $2 and scan_state = 'PENDING_SCAN' returning id, scan_state
     ), notice as (
       insert into outbox_event (company_id, topic, aggregate_id, dedupe_key, payload)
       select $1, 'storage.scan_quarantined', v.id, 'storage.scan_quarantined:' || v.id::text, jsonb_build_object('attachmentId', v.id)
         from verdict v where $5::boolean and v.scan_state = 'QUARANTINED'
       on conflict (company_id, dedupe_key) do nothing
     )
     select scan_state from verdict`,
    [attachment.companyId, attachment.id, state, finding, options.notifyOwner === true, options.actorUserId ?? null],
  );
  if (updated.rows[0]) return { state: updated.rows[0].scan_state, recorded: true };
  const current = (await db.query<{ scan_state: ScanState }>(`select scan_state from attachment where company_id = $1 and id = $2`, [attachment.companyId, attachment.id])).rows[0];
  return { state: current?.scan_state ?? 'PENDING_SCAN', recorded: false };
}

/**
 * What an upload route does with a file it has just stored: leaves it PENDING_SCAN for the scan worker, without asking any scanner
 * (scanInWorker), which is what every deployment does. Given a plain scanner (a test harness only; production refuses it) it asks in
 * the request: a scanner error leaves the file PENDING_SCAN for the worker, and `notifyOwner` queues the uploader's quarantine notice.
 * An upload route answers its uploader itself, so it does not ask for a notice.
 */
export async function scanAttachment(
  db: Queryable,
  scanner: ScanProvider,
  attachment: { companyId: string; id: string; bytes: Buffer },
  options: { notifyOwner?: boolean } = {},
): Promise<ScanState> {
  if (scanner.deferUploads) return 'PENDING_SCAN';
  const result = await ask(scanner, attachment.bytes, scanSettings().timeoutMs);
  if (result.verdict === 'ERROR' || result.verdict === 'TIMEOUT') return 'PENDING_SCAN';
  return (await recordVerdict(db, attachment, result, options)).state;
}

/** In-memory scans running in this process now (scanInMemory). */
let inlineScans = 0;

/**
 * An upload that is read and answered in the request and never stored, so there is no file for the worker to scan (payroll inputs,
 * settlement lines and the settlement selection list; I-21). I-84 item 9 (I-73 item 2; decided under owner delegation, 6 Nov 2026):
 * they stay in the request, never stored, because their answer is the preparer's preview of one small file (up to 1 MB) against
 * the period or settlement as it stands; storing them would keep confidential amounts as files and change every route's answer. They
 * meet NFR-S09 by bounds instead: the wait is bounded by SCAN_TIMEOUT_MS (a timeout reads as no verdict), at most SCAN_INLINE_CONCURRENCY
 * run at once in a process (one more is refused at once, without asking the scanner), and the caller holds no transaction while it
 * asks. No verdict means 503 SCAN_UNAVAILABLE with nothing read or saved. The bulk settlement import is stored and held for the worker.
 */
export async function scanInMemory(scanner: ScanProvider, bytes: Buffer, settings: Pick<ScanSettings, 'timeoutMs' | 'inlineConcurrency'> = scanSettings()): Promise<ScanVerdict> {
  if (inlineScans >= settings.inlineConcurrency) return { verdict: 'ERROR' };
  inlineScans++;
  try {
    const result = await ask(scanner, bytes, settings.timeoutMs);
    return result.verdict === 'TIMEOUT' ? { verdict: 'ERROR' } : result;
  } finally {
    inlineScans--;
  }
}

export interface ScanPassOutcome {
  /** Files the scanner was asked about. */
  scanned: number;
  clean: number;
  quarantined: number;
  /** Files with no verdict that will be tried again after their backoff. */
  stillPending: number;
  /** Files whose attempts ran out in this pass: unusable, and marked so. */
  failed: number;
  /** The pass stopped early because the scanner or the file store kept failing. */
  paused: boolean;
}

/**
 * Marks a file whose attempts ran out (I-84 item 8, decided under owner delegation, 6 Nov 2026): it stays PENDING_SCAN, never served
 * and never called a finding, until a holder of attachment.requeue_scan sends it back to the worker (scan-failures.ts) or its uploader
 * replaces it. The uploader is told once per failure (H7 "scan"), in the same statement. The audit names the failure class, never
 * the file's content.
 */
async function markScanFailed(tx: Queryable, companyId: string, id: string, attempts: number, code: string): Promise<void> {
  await tx.query(
    `with failed as (
       update attachment set scan_failed_at = now(), scan_next_attempt_at = null, scan_last_error = $3, updated_by = $4
        where company_id = $1 and id = $2 and scan_state = 'PENDING_SCAN' returning id, scan_failed_at
     )
     insert into outbox_event (company_id, topic, aggregate_id, dedupe_key, payload)
     select $1, 'storage.scan_failed', f.id, 'storage.scan_failed:' || f.id::text || ':' || to_char(f.scan_failed_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'), jsonb_build_object('attachmentId', f.id)
       from failed f
     on conflict (company_id, dedupe_key) do nothing`,
    [companyId, id, code, SYSTEM_ACTOR_ID],
  );
  await writeAudit(tx, {
    companyId,
    resource: 'attachment',
    recordKey: id,
    actorUserId: SYSTEM_ACTOR_ID,
    actingAssignmentId: null,
    action: 'SCAN_FAILED',
    after: { operational: { scanState: 'PENDING_SCAN', attempts, errorCode: code } },
  });
}

interface ClaimedScan {
  companyId: string;
  /** Absent when the file had already used its attempts and has just been marked failed. */
  file?: { id: string; contentReference: string; attempt: number };
}

/**
 * Claims the next ready file and books the attempt with its next retry already set, then commits: no transaction stays open while the
 * scanner works, a second worker cannot take the file meanwhile, and a worker that dies leaves the file to come back at that retry.
 * A file that comes back having used its attempts was never reported on (its worker died), so it is marked failed.
 */
async function claimScan(tx: Queryable, settings: ScanSettings, after: string, companyId: string | null): Promise<ClaimedScan | null> {
  const row = (
    await tx.query<{ id: string; company_id: string; content_reference: string; scan_attempts: number }>(
      `select a.id, a.company_id, a.content_reference, a.scan_attempts from attachment a
        where a.scan_state = 'PENDING_SCAN' and a.scan_failed_at is null and a.scan_next_attempt_at is null and a.company_id > $1
          and ($2::uuid is null or a.company_id = $2)
          and exists (select 1 from company c where c.id = a.company_id and c.active)
        order by a.company_id, a.created_at limit 1 for update of a skip locked`,
      [after, companyId],
    )
  ).rows[0];
  if (!row) return null;
  if (row.scan_attempts >= settings.maxAttempts) {
    await markScanFailed(tx, row.company_id, row.id, row.scan_attempts, 'WORKER_INTERRUPTED');
    return { companyId: row.company_id };
  }
  const attempt = row.scan_attempts + 1;
  await tx.query(`update attachment set scan_attempts = $2, scan_next_attempt_at = now() + make_interval(secs => $3::double precision / 1000), updated_by = $4 where id = $1`, [
    row.id,
    attempt,
    scanBackoffMs(attempt, settings),
    SYSTEM_ACTOR_ID,
  ]);
  return { companyId: row.company_id, file: { id: row.id, contentReference: row.content_reference, attempt } };
}

/** The scanner gave no verdict on a claimed file: keep the failure class, and mark the file failed if that was its last attempt. */
async function recordNoVerdict(db: Database, settings: ScanSettings, companyId: string, file: { id: string; attempt: number }, code: string): Promise<'PENDING' | 'FAILED'> {
  return withTransaction(db, async (tx) => {
    if (file.attempt >= settings.maxAttempts) {
      await markScanFailed(tx, companyId, file.id, file.attempt, code);
      return 'FAILED';
    }
    await tx.query(`update attachment set scan_last_error = $3, updated_by = $4 where company_id = $1 and id = $2 and scan_state = 'PENDING_SCAN'`, [companyId, file.id, code, SYSTEM_ACTOR_ID]);
    return 'PENDING';
  });
}

/** A file's verdict and its audit together. The worker's audit is on the attachment and names the state only: nobody's request is behind it. */
async function recordWorkerVerdict(db: Database, companyId: string, id: string, result: { verdict: 'CLEAN' } | { verdict: 'INFECTED'; finding: string }): Promise<ScanState> {
  return withTransaction(db, async (tx) => {
    const { state, recorded } = await recordVerdict(tx, { companyId, id }, result, { notifyOwner: true, actorUserId: SYSTEM_ACTOR_ID });
    if (recorded) {
      await writeAudit(tx, {
        companyId,
        resource: 'attachment',
        recordKey: id,
        actorUserId: SYSTEM_ACTOR_ID,
        actingAssignmentId: null,
        action: state === 'CLEAN' ? 'SCAN_RELEASED' : 'SCAN_QUARANTINED',
        after: { operational: { scanState: state } },
      });
    }
    return state;
  });
}

/** Up to `limit` files, one transaction per step and none held while the scanner works. */
async function scanPass(db: Database, files: FileStore, scanner: ScanProvider, settings: ScanSettings, limit: number, companyId: string | null, next: () => Promise<ClaimedScan | null>): Promise<ScanPassOutcome> {
  // A retry that has fallen due rejoins the ready files; one still waiting is not in the claim's index at all (0160).
  await db.query(
    `with due as (select id from attachment
                   where scan_state = 'PENDING_SCAN' and scan_failed_at is null and scan_next_attempt_at <= now() and ($2::uuid is null or company_id = $2)
                   order by scan_next_attempt_at limit $1 for update skip locked)
     update attachment a set scan_next_attempt_at = null from due where a.id = due.id`,
    [limit, companyId],
  );
  const outcome: ScanPassOutcome = { scanned: 0, clean: 0, quarantined: 0, stillPending: 0, failed: 0, paused: false };
  let failuresInARow = 0;
  for (let i = 0; i < limit && !outcome.paused; i++) {
    const claimed = await next();
    if (!claimed) break;
    if (!claimed.file) {
      outcome.failed++;
      continue;
    }
    const { file } = claimed;
    let bytes: Buffer | null = null;
    try {
      bytes = await files.get(file.contentReference);
    } catch {
      bytes = null;
    }
    const result = bytes ? await ask(scanner, bytes, settings.timeoutMs) : ({ verdict: 'UNREADABLE' } as const);
    if (bytes) outcome.scanned++;
    if (result.verdict === 'CLEAN' || result.verdict === 'INFECTED') {
      failuresInARow = 0;
      const state = await recordWorkerVerdict(db, claimed.companyId, file.id, result);
      if (state === 'CLEAN') outcome.clean++;
      else if (state === 'QUARANTINED') outcome.quarantined++;
      continue;
    }
    const code = result.verdict === 'UNREADABLE' ? 'FILE_UNREADABLE' : result.verdict === 'TIMEOUT' ? 'SCANNER_TIMEOUT' : 'SCANNER_ERROR';
    if ((await recordNoVerdict(db, settings, claimed.companyId, file, code)) === 'FAILED') outcome.failed++;
    else outcome.stillPending++;
    failuresInARow++;
    if (failuresInARow >= settings.pauseAfterErrors) outcome.paused = true;
  }
  return outcome;
}

const scanTurns = companyTurns();

/** The worker's scan of every company's due files: one per company in turn, so one company's uploads never hold back another's. */
export function scanDueAttachments(db: Database, files: FileStore, scanner: ScanProvider, settings: ScanSettings = scanSettings()): Promise<ScanPassOutcome> {
  return scanPass(db, files, scanner, settings, settings.perPass, null, () => withTransaction(db, (tx) => scanTurns.next((after) => claimScan(tx, settings, after, null))));
}

/** The same scan for one company's due files, oldest first, bounded per run. */
export function scanPendingAttachments(db: Database, files: FileStore, scanner: ScanProvider, companyId: string, limit = 200, settings: ScanSettings = scanSettings()): Promise<ScanPassOutcome> {
  return scanPass(db, files, scanner, settings, limit, companyId, () => withTransaction(db, (tx) => claimScan(tx, settings, FIRST_COMPANY, companyId)));
}
