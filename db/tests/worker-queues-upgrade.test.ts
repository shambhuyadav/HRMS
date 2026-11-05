// Upgrade behaviour of 0160 (docs/09 §7.4, §8.3) on a database that already holds companies and queued work: nothing stops the
// migration and no stored row is rewritten. Events, retries, pending files and claimed runs keep their meaning, and the worker's claims
// find them through the new indexes. Synthetic data only.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../../apps/api/src/db/pool.js';
import { dispatchOutbox } from '../../apps/api/src/modules/notification/dispatcher.js';
import { memoryFileStore } from '../../apps/api/src/storage/files.js';
import { developmentScanner, scanPendingAttachments } from '../../apps/api/src/storage/scan.js';
import { migrate } from '../migrate.js';
import { type CompanyFixture, fixtures } from './fixtures.js';
import { startEmptyTestDatabase, type TestDatabase } from './test-database.js';

describe('0160 on a database with stored work', () => {
  let old: TestDatabase;
  let db: pg.Client;
  let pool: pg.Pool;
  let company: CompanyFixture;
  const files = memoryFileStore();
  const events = { ready: '', waiting: '', due: '', failed: '', published: '' };
  let pendingFile = '';
  let cleanFile = '';
  let unscannedFile = '';
  const outboxRows = () => db.query<{ id: string; attempts: number; next: boolean; published: boolean; failed: boolean }>(`select id::text, attempts, next_attempt_at is not null as next, published_at is not null as published, failed_at is not null as failed from outbox_event order by seq`);

  beforeAll(async () => {
    const empty = await startEmptyTestDatabase();
    if (!empty) throw new Error('An upgrade test needs TEST_PG_ADMIN_URL');
    old = empty;
    db = old.client;
    await migrate(db, { before: '0160' });
    const f = fixtures(db);
    company = await f.makeCompany();
    const owner = await f.makeUser();
    const event = async (extra: { nextAttempt?: string; published?: boolean; failed?: boolean; attempts?: number }) =>
      (
        await f.one<{ id: string }>(
          `insert into outbox_event (company_id, topic, aggregate_id, dedupe_key, payload, attempts, next_attempt_at, published_at, failed_at)
           values ($1, 'upgrade.probe', $2, $3, '{}'::jsonb, $4, $5::timestamptz, case when $6::boolean then now() end, case when $7::boolean then now() end) returning id::text`,
          [company.company, randomUUID(), `upgrade:${randomUUID()}`, extra.attempts ?? 0, extra.nextAttempt ?? null, extra.published === true, extra.failed === true],
        )
      ).id;
    events.ready = await event({});
    events.waiting = await event({ attempts: 1, nextAttempt: new Date(Date.now() + 3_600_000).toISOString() });
    events.due = await event({ attempts: 1, nextAttempt: new Date(Date.now() - 1_000).toISOString() });
    events.failed = await event({ attempts: 4, failed: true });
    events.published = await event({ attempts: 1, published: true });
    const stored = await files.put(company.company, Buffer.from('%PDF-1.4 synthetic upgrade file'));
    const file = async (state: 'PENDING_SCAN' | 'CLEAN' | null) =>
      (
        await f.one<{ id: string }>(
          `insert into attachment (company_id, owner_user_id, content_reference, media_type, checksum, classification, scan_state, scan_checked_at, created_by, updated_by)
           values ($1, $2, $3, 'application/pdf', $4, 'CONFIDENTIAL', $5::text, case when $5::text = 'CLEAN' then now() end, $2, $2) returning id`,
          [company.company, owner, stored.reference, stored.checksum, state],
        )
      ).id;
    pendingFile = await file('PENDING_SCAN');
    cleanFile = await file('CLEAN');
    unscannedFile = await file(null);
    await db.query(`insert into scheduled_job_run (run_key, job_code, company_id) values ('REMINDERS:upgrade', 'REMINDERS', $1), ('CELEBRATIONS:upgrade', 'CELEBRATIONS', $1)`, [company.company]);
    await db.query(`update scheduled_job_run set finished_at = now(), outcome = 'OK' where run_key = 'CELEBRATIONS:upgrade'`);

    expect((await migrate(db)).some((m) => m.startsWith('0160_worker_queues'))).toBe(true);
    pool = createPool(old.connectionString, 2);
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await old?.stop();
  });

  it('rewrites no stored row, and every new column reads as before', async () => {
    const rows = (await outboxRows()).rows;
    expect(rows).toEqual([
      { id: events.ready, attempts: 0, next: false, published: false, failed: false },
      { id: events.waiting, attempts: 1, next: true, published: false, failed: false },
      { id: events.due, attempts: 1, next: true, published: false, failed: false },
      { id: events.failed, attempts: 4, next: false, published: false, failed: true },
      { id: events.published, attempts: 1, next: false, published: true, failed: false },
    ]);
    const attachments = await db.query<{ id: string; scan_state: string | null; scan_attempts: number; scan_next_attempt_at: Date | null; scan_failed_at: Date | null; scan_last_error: string | null }>(
      `select id, scan_state, scan_attempts, scan_next_attempt_at, scan_failed_at, scan_last_error from attachment where id = any($1::uuid[])`,
      [[pendingFile, cleanFile, unscannedFile]],
    );
    for (const a of attachments.rows) expect(a).toMatchObject({ scan_attempts: 0, scan_next_attempt_at: null, scan_failed_at: null, scan_last_error: null });
    const runs = await db.query<{ run_key: string; lease_until: Date | null; attempts: number; outcome: string | null }>(`select run_key, lease_until, attempts, outcome from scheduled_job_run order by run_key`);
    expect(runs.rows).toEqual([
      { run_key: 'CELEBRATIONS:upgrade', lease_until: null, attempts: 0, outcome: 'OK' },
      { run_key: 'REMINDERS:upgrade', lease_until: null, attempts: 0, outcome: null },
    ]);
  });

  it('the worker’s claims find the stored work: the ready and the due event, the waiting one left, the pending file scanned', async () => {
    expect(await dispatchOutbox(pool, 10)).toBe(2);
    const rows = new Map((await outboxRows()).rows.map((r) => [r.id, r]));
    expect(rows.get(events.ready)).toMatchObject({ attempts: 1, published: true });
    expect(rows.get(events.due)).toMatchObject({ attempts: 2, published: true, next: false });
    expect(rows.get(events.waiting)).toMatchObject({ attempts: 1, published: false, next: true });
    expect(rows.get(events.failed)).toMatchObject({ attempts: 4, published: false, failed: true });

    expect(await scanPendingAttachments(pool, files, developmentScanner(), company.company)).toMatchObject({ scanned: 1, clean: 1 });
    const states = new Map((await db.query<{ id: string; scan_state: string | null }>(`select id, scan_state from attachment`)).rows.map((r) => [r.id, r.scan_state]));
    expect([states.get(pendingFile), states.get(cleanFile), states.get(unscannedFile)]).toEqual(['CLEAN', 'CLEAN', null]);
  });
});
