// Production worker entry point (NODE_ENV=production; worker.ts is the development one): ticks the scheduler every 30 seconds, as the
// system account, with the production file store and malware scanner (ADR-12: uploads wait for this worker's verdict). Environment as
// main.ts: DATABASE_URL, FILE_STORE_DIR, CLAMD_SOCKET or CLAMD_HOST/CLAMD_PORT, HRMS_FIELD_KEYS. One worker per server; it is supervised
// (systemd restarts it) and stops between ticks on SIGTERM.
// The email channel (FR-085) is read here once, from SMTP_HOST, SMTP_PORT, SMTP_SECURITY, SMTP_USER, SMTP_PASSWORD_FILE, SMTP_FROM and
// APP_PUBLIC_URL (mail/config.ts): none set, it is off and nothing is sent; a partial or unsafe setting stops the worker at start-up.
import { SYSTEM_ACTOR_ID } from './audit/actors.js';
import { createPool } from './db/pool.js';
import { emailChannelFromEnv } from './mail/config.js';
import { assertFieldKeysConfigured } from './security/field-crypto.js';
import { clamavScannerFromEnv } from './storage/clamav.js';
import { localFileStore } from './storage/files.js';
import { runScheduledJobs } from './worker/scheduler.js';

if (process.env.NODE_ENV !== 'production') throw new Error('worker-main.ts is the production entry point: run it with NODE_ENV=production (worker.ts is the development one)');
const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
};
// Effective-dated private profile changes are opened and sealed by the worker: fail at start-up, not at the first one.
assertFieldKeysConfigured();

const db = createPool(required('DATABASE_URL'));
const files = localFileStore(required('FILE_STORE_DIR'));
const scanner = clamavScannerFromEnv();
const email = emailChannelFromEnv();
console.log(JSON.stringify({ at: new Date().toISOString(), emailChannel: email.state === 'ON' ? `on: ${email.summary}` : 'off: SMTP_HOST is not set, nothing is sent' }));
const tick = async () => {
  try {
    const result = await runScheduledJobs({ db, providers: new Map(), systemUserId: SYSTEM_ACTOR_ID, files, scanner, email });
    const emailed = result.emails.sent + result.emails.retrying + result.emails.failed + result.emails.suppressed;
    if (result.ran.length || result.dispatched || result.reports || result.bulkChunks || result.scans?.scanned || result.scans?.failed || emailed) console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
  } catch (err) {
    console.error('scheduler tick failed', (err as Error).message);
  }
};
await tick();
const timer = setInterval(tick, 30_000);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(timer);
    void db.end().finally(() => process.exit(0));
  });
}
