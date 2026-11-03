// Outbox failure isolation and DF12 retries ("retries 1/5/15 minutes then FAILED. Retry attempts are auditable").
// A test-only describer stands in for any module describer that throws. Synthetic data only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queryable } from '../../db/queryable.js';
import { type Company, type Harness, startHarness } from '../../test/harness.js';
import { type EventDescriber, MODULE_EVENT_DESCRIBERS } from '../events-registry.js';
import { dispatchOutbox } from './dispatcher.js';

let h: Harness;
let A: Company;
let failing = true;
const describers = MODULE_EVENT_DESCRIBERS as Record<string, EventDescriber>;

const enqueue = async (topic: string) =>
  (
    await h.one<{ id: string }>(`insert into outbox_event (company_id, topic, aggregate_id, dedupe_key, payload) values ($1, $2, $3, $4, '{}'::jsonb) returning id::text`, [
      A.id,
      topic,
      randomUUID(),
      `${topic}:${randomUUID()}`,
    ])
  ).id;
const row = (id: string) =>
  h.one<{ attempts: number; published: boolean; failed: boolean; last_error: string | null; waits: boolean }>(
    `select attempts, published_at is not null as published, failed_at is not null as failed, last_error, next_attempt_at > now() as waits from outbox_event where id = $1`,
    [id],
  );
const due = (id: string) => h.db.query(`update outbox_event set next_attempt_at = now() - interval '1 second' where id = $1`, [id]);

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  describers['test.poison'] = async () => {
    if (failing) throw new TypeError('synthetic describer failure');
    return null;
  };
  describers['test.ok'] = async () => null;
});

afterAll(async () => {
  delete describers['test.poison'];
  delete describers['test.ok'];
  await h?.stop();
});

describe('outbox retries (DF12)', () => {
  it('a failing event no longer holds back the events behind it', async () => {
    const poison = await enqueue('test.poison');
    const ok = await enqueue('test.ok');
    expect(await dispatchOutbox(h.pool)).toBeGreaterThanOrEqual(2);
    expect(await row(poison)).toEqual({ attempts: 1, published: false, failed: false, last_error: 'TypeError', waits: true });
    expect((await row(ok)).published).toBe(true);
    // Not retried before its time.
    await dispatchOutbox(h.pool);
    expect((await row(poison)).attempts).toBe(1);
  });

  it('retries after 1, 5 and 15 minutes, then FAILED, with every attempt recorded', async () => {
    const poison = await enqueue('test.poison');
    await dispatchOutbox(h.pool);
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      const wait = await h.one<{ m: number }>(`select round(extract(epoch from (next_attempt_at - now())) / 60)::int as m from outbox_event where id = $1`, [poison]);
      delays.push(wait.m);
      await due(poison);
      await dispatchOutbox(h.pool);
    }
    expect(delays).toEqual([1, 5, 15]);
    expect(await row(poison)).toMatchObject({ attempts: 4, published: false, failed: true, last_error: 'TypeError' });
    const attempts = await h.db.query<{ attempt: number; error_code: string }>(`select attempt, error_code from outbox_event_attempt where event_id = $1 order by attempt`, [poison]);
    expect(attempts.rows).toEqual([1, 2, 3, 4].map((attempt) => ({ attempt, error_code: 'TypeError' })));
    // A FAILED event is not picked up again.
    await due(poison);
    await dispatchOutbox(h.pool);
    expect((await row(poison)).attempts).toBe(4);
  });

  it('publishes on a later attempt once the cause is repaired', async () => {
    const poison = await enqueue('test.poison');
    await dispatchOutbox(h.pool);
    failing = false;
    await due(poison);
    await dispatchOutbox(h.pool);
    expect(await row(poison)).toMatchObject({ attempts: 2, published: true, failed: false });
  });
});

describe('UUID outbox keys (0071, docs/09 §3.4)', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const seen: string[] = [];
  beforeAll(() => {
    describers['test.order'] = async (_tx, ev) => {
      seen.push(String(ev.payload.n));
      return null;
    };
  });
  afterAll(() => {
    delete describers['test.order'];
  });
  const insert = (db: Queryable, n: string, id: string, createdAt = 'now()') =>
    db.query(`insert into outbox_event (id, company_id, topic, aggregate_id, dedupe_key, payload, created_at) values ($1, $2, 'test.order', $3, $4, $5, ${createdAt})`, [
      id,
      A.id,
      randomUUID(),
      `test.order:${n}:${randomUUID()}`,
      { n },
    ]);

  it('claims oldest first and keeps the order one transaction wrote its events in, whatever their random ids', async () => {
    const client = await h.pool.connect();
    try {
      // One transaction (one created_at) writes 1, 2, 3 with ids in the opposite order.
      await client.query('begin');
      await insert(client, '1', 'ffffffff-ffff-4fff-bfff-ffffffffffff');
      await insert(client, '2', '88888888-8888-4888-8888-888888888888');
      await insert(client, '3', '00000000-0000-4000-8000-000000000001');
      await client.query('commit');
    } finally {
      client.release();
    }
    // A later transaction writes 4, and an event of a transaction that started earlier (its time is older) comes first.
    await insert(h.db, '4', '00000000-0000-4000-8000-000000000002');
    await insert(h.db, '0', 'ffffffff-ffff-4fff-bfff-fffffffffffe', `now() - interval '1 hour'`);
    seen.length = 0;
    await dispatchOutbox(h.pool);
    expect(seen).toEqual(['0', '1', '2', '3', '4']);
  });

  it('keeps dedupe-key idempotency: a repeated key adds no event and nothing is delivered twice', async () => {
    const dedupeKey = `test.order:dup:${randomUUID()}`;
    const enqueueOnce = () =>
      h.db.query(`insert into outbox_event (company_id, topic, aggregate_id, dedupe_key, payload) values ($1, 'test.order', $2, $3, $4) on conflict (company_id, dedupe_key) do nothing`, [
        A.id,
        randomUUID(),
        dedupeKey,
        { n: 'dup' },
      ]);
    await enqueueOnce();
    await enqueueOnce();
    seen.length = 0;
    await dispatchOutbox(h.pool);
    await enqueueOnce();
    await dispatchOutbox(h.pool);
    expect(seen).toEqual(['dup']);
    const rows = await h.db.query<{ id: string }>(`select id::text from outbox_event where company_id = $1 and dedupe_key = $2`, [A.id, dedupeKey]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.id).toMatch(UUID);
  });

  it('records attempts under UUID keys, tied to their event within the same company', async () => {
    failing = true;
    const poison = await enqueue('test.poison');
    expect(poison).toMatch(UUID);
    await dispatchOutbox(h.pool);
    failing = false;
    const attempt = await h.one<{ id: string; event_id: string; company_id: string }>(`select id::text, event_id::text, company_id from outbox_event_attempt where event_id = $1`, [poison]);
    expect(attempt).toMatchObject({ event_id: poison, company_id: A.id });
    expect(attempt.id).toMatch(UUID);
    // The attempt's event reference includes the company (a composite key, like every same-company reference).
    const B = await h.makeCompany();
    await expect(h.db.query(`insert into outbox_event_attempt (event_id, company_id, attempt, error_code) values ($1, $2, 9, 'TypeError')`, [poison, B.id])).rejects.toMatchObject({ code: '23503' });
  });
});
