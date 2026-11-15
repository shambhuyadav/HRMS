// Startup check of the numeric settings (improvement plan C5). Each setting is read where it is used and falls back to its default
// when unset; a value that is set but is not a whole number (DB_POOL_MAX=abc, PORT=30OO) would otherwise be ignored without a word
// or become NaN. The API, the development server and the worker refuse to start instead, naming every bad setting at once.

/** The numeric settings read from the environment (.env.example lists them with their defaults). */
export const NUMERIC_SETTINGS: readonly string[] = [
  'PORT',
  'DB_POOL_MAX',
  'DB_STATEMENT_TIMEOUT_MS',
  'DB_IDLE_IN_TRANSACTION_TIMEOUT_MS',
  'DB_CONNECTION_TIMEOUT_MS',
  'HTTP_READ_DEADLINE_MS',
  'DB_READ_STATEMENT_TIMEOUT_MS',
  'DB_READ_LOCK_TIMEOUT_MS',
  'HTTP_WRITE_DEADLINE_MS',
  'DB_WRITE_STATEMENT_TIMEOUT_MS',
  'DB_WRITE_LOCK_TIMEOUT_MS',
  'HTTP_BATCH_DEADLINE_MS',
  'DB_BATCH_STATEMENT_TIMEOUT_MS',
  'DB_BATCH_LOCK_TIMEOUT_MS',
  'DB_BULK_STATEMENT_TIMEOUT_MS',
  'DB_BULK_LOCK_TIMEOUT_MS',
  'OUTBOX_RELAY_BATCH',
  'OUTBOX_RELAY_INTERVAL_MS',
  'SCHEDULED_RUN_LEASE_MS',
  'REMINDER_CHUNK_SIZE',
  'CELEBRATION_PAGE_SIZE',
  'CELEBRATION_RECIPIENT_BATCH',
  'SCAN_PER_TICK',
  'SCAN_MAX_ATTEMPTS',
  'SCAN_BACKOFF_BASE_MS',
  'SCAN_BACKOFF_MAX_MS',
  'SCAN_TIMEOUT_MS',
  'SCAN_PAUSE_AFTER_ERRORS',
  'SCAN_INLINE_CONCURRENCY',
  'SMTP_PORT',
  'SMTP_TIMEOUT_MS',
  'CLAMD_PORT',
  'SLOW_QUERY_MS',
];

/** The bad numeric settings, in words; empty when all are unset or whole numbers. */
export function numericSettingProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  for (const name of NUMERIC_SETTINGS) {
    const value = env[name];
    if (value === undefined || value.trim() === '') continue;
    if (!/^\d+$/.test(value.trim())) problems.push(`${name} must be a whole number of 0 or more, but is "${value}"`);
  }
  return problems;
}

/** Throws, naming every bad numeric setting, before anything starts. */
export function assertNumericSettings(env: NodeJS.ProcessEnv = process.env): void {
  const problems = numericSettingProblems(env);
  if (problems.length > 0) throw new Error(`Invalid settings:\n  - ${problems.join('\n  - ')}`);
}
