// Development worker entry point: ticks the scheduler every 30 seconds. Production deployment (process
// supervision, multiple workers, provider adapters) is a separate, authorised step.
import { SYSTEM_ACTOR_ID } from './audit/actors.js';
import { createPool } from './db/pool.js';
import { emailChannelFromEnv } from './mail/config.js';
import { localFileStore } from './storage/files.js';
import { developmentScanner } from './storage/scan.js';
import { runScheduledJobs } from './worker/scheduler.js';

if (process.env.NODE_ENV === 'production') throw new Error('worker.ts is the development entry point');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must be set');

const db = createPool(databaseUrl);
// The same development file store as the API (server.ts), and the synthetic scanner (FR-106). Uploads wait for this worker's verdict.
const files = localFileStore(process.env.FILE_STORE_DIR ?? '.dev-files');
const scanner = developmentScanner();
// FR-085 email: off unless SMTP_HOST is set (for development, a local capture server such as Mailpit with SMTP_SECURITY=none).
const email = emailChannelFromEnv();
const tick = async () => {
  try {
    const result = await runScheduledJobs({ db, providers: new Map(), systemUserId: SYSTEM_ACTOR_ID, files, scanner, email });
    if (result.ran.length || result.dispatched || result.reports || result.bulkChunks || result.scans?.scanned || result.scans?.failed) console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
  } catch (err) {
    console.error('scheduler tick failed', (err as Error).message);
  }
};
await tick();
const timer = setInterval(tick, 30_000);
// Graceful shutdown: no new tick; the current one finishes on its own transaction boundaries.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(timer);
    void db.end().finally(() => process.exit(0));
  });
}
