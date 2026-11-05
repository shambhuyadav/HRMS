// The worker's queues on the real database (docs/09 §7.2, §7.4, §13.2 item 5): the outbox relays outside the company loop, outbox and
// report claims take turns by company, and a run is claimed once with no insert per tick. A test-only daily job stands in for a slow
// company's job; it sits in a real transaction on a real lock while the tick runs on. Synthetic data only.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_ACTOR_ID } from '../audit/actors.js';
import { FIRST_COMPANY } from '../db/company-turns.js';
import { type Database, withTransaction } from '../db/transaction.js';
import { type EventDescriber, MODULE_EVENT_DESCRIBERS } from '../modules/events-registry.js';
import { MODULE_DAILY_JOBS, type ModuleDailyJob } from '../modules/jobs-registry.js';
import { celebrationPageSize, celebrationRecipientBatch, dispatchOutbox, OUTBOX_CLAIM_SQL } from '../modules/notification/dispatcher.js';
import { reminderChunkSize } from '../modules/notification/reminders.js';
import { processReportQueue, REPORT_CLAIM_SQL, RUNNING_LEASE_MINUTES } from '../modules/report/service.js';
import { type Company, type Harness, startHarness, type TestActor } from '../test/harness.js';
import { runScheduledJobs, type WorkerSettings, workerSettings } from './scheduler.js';

let h: Harness;
let A: Company;
let B: Company;
let C: Company;
let hrA: TestActor;
let hrB: TestActor;

const describers = MODULE_EVENT_DESCRIBERS as Record<string, EventDescriber>;
const dailyJobs = MODULE_DAILY_JOBS as ModuleDailyJob[];
const HOLD = 7_160_001;
/** The test job's behaviour for the current test. */
let slowJob: (db: Database, companyId: string) => Promise<unknown> = async () => ({ done: true });
const testJob: ModuleDailyJob = { key: 'test', code: 'TEST_SLOW_JOB', fromHour: 0, run: (db, companyId) => slowJob(db, companyId) };

const settings = (overrides: Partial<WorkerSettings> = {}): WorkerSettings => ({ ...workerSettings(), relayIntervalMs: 25, ...overrides });
const deps = (overrides: Partial<Parameters<typeof runScheduledJobs>[0]> = {}) => ({ db: h.pool as Database, providers: new Map(), systemUserId: SYSTEM_ACTOR_ID, settings: settings(), ...overrides });
/** 11:00 in the companies' timezone (Asia/Kolkata) on a day of its own, so every run is due anew. */
let days = 0;
const nextDay = () => new Date(Date.UTC(2031, 0, ++days, 5, 30));

const enqueue = async (companyId: string, createdAt: string | null = null, nextAttemptAt: string | null = null) =>
  (
    await h.one<{ id: string }>(
      `insert into outbox_event (company_id, topic, aggregate_id, dedupe_key, payload, created_at, next_attempt_at) values ($1, 'test.relay', $2, $3, '{}'::jsonb, coalesce($4::timestamptz, now()), $5) returning id::text`,
      [companyId, randomUUID(), `test.relay:${randomUUID()}`, createdAt, nextAttemptAt],
    )
  ).id;
const backlog = (companyId: string, size: number) =>
  h.db.query(
    `insert into outbox_event (company_id, topic, aggregate_id, dedupe_key, payload, created_at)
     select $1, 'test.relay', gen_random_uuid(), 'test.relay:' || gen_random_uuid(), jsonb_build_object('n', g), now() - interval '1 hour' + g * interval '1 millisecond'
       from generate_series(1, $2::int) g`,
    [companyId, size],
  );
const isPublished = async (id: string) => (await h.one<{ p: boolean }>(`select published_at is not null as p from outbox_event where id = $1`, [id])).p;
const publishedOf = async (companyId: string) => (await h.one<{ n: number }>(`select count(*)::int as n from outbox_event where company_id = $1 and published_at is not null and topic = 'test.relay'`, [companyId])).n;
const eventually = (check: () => Promise<boolean>) => vi.waitFor(async () => expect(await check()).toBe(true), { timeout: 30_000, interval: 25 });
const lockWaiters = async () => Number((await h.pool.query<{ n: string }>(`select count(*) as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`)).rows[0]!.n);

/** Holds the test job in a real transaction on a real lock until `release` is called. */
const holdUp = async (companyId: string) => {
  await h.db.query(`select pg_advisory_lock($1)`, [HOLD]);
  slowJob = async (db, id) => {
    if (id === companyId) await withTransaction(db, (tx) => tx.query(`select pg_advisory_xact_lock($1)`, [HOLD]));
    return { done: true };
  };
  return () => h.db.query(`select pg_advisory_unlock($1)`, [HOLD]);
};

/** The pool, recording every statement it is sent. */
function recording(): { db: Database; statements: string[] } {
  const statements: string[] = [];
  const db: Database = {
    query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]) {
      statements.push(text);
      return h.pool.query<R>(text, values);
    },
    async connect() {
      const client = await h.pool.connect();
      const query = (text: string, values?: unknown[]) => {
        statements.push(text);
        return client.query(text, values);
      };
      return new Proxy(client, { get: (target, property) => (property === 'query' ? query : Reflect.get(target, property, target)) });
    },
  };
  return { db, statements };
}

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Rows Removed by Filter'?: number;
  'Actual Rows'?: number;
  Plans?: PlanNode[];
}
const nodesOf = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodesOf)];
/** The claim's plan with its row locks taken and rolled back, on a table too small for the planner to choose an index unprompted. */
const planOf = async (sql: string, params: unknown[]) => {
  const client = await h.pool.connect();
  try {
    await client.query('begin');
    await client.query('set local enable_seqscan = off');
    await client.query('set local enable_bitmapscan = off');
    const plan = (await client.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(`explain (analyze, format json) ${sql}`, params)).rows[0]!['QUERY PLAN'][0]!.Plan;
    return nodesOf(plan);
  } finally {
    await client.query('rollback');
    client.release();
  }
};

beforeAll(async () => {
  h = await startHarness();
  // In id order, so a burst in A is always in the company a walk from the start reaches first: the worst case for B and C.
  [A, B, C] = [await h.makeCompany(), await h.makeCompany(), await h.makeCompany()].sort((x, y) => (x.id < y.id ? -1 : 1)) as [Company, Company, Company];
  hrA = await h.actor(A, 'HR_ADMINISTRATOR');
  hrB = await h.actor(B, 'HR_ADMINISTRATOR');
  describers['test.relay'] = async () => null;
  dailyJobs.push(testJob);
});

afterAll(async () => {
  delete describers['test.relay'];
  dailyJobs.splice(dailyJobs.indexOf(testJob), 1);
  await h?.stop();
});

beforeEach(async () => {
  slowJob = async () => ({ done: true });
  await h.db.query(`update outbox_event set published_at = now(), next_attempt_at = null where published_at is null and failed_at is null`);
});

describe('the outbox relays outside the company loop (docs/09 §7.2)', () => {
  it('drains before the loop and goes on draining while one company’s daily job is held up', async () => {
    const before = await enqueue(B.id);
    const release = await holdUp(A.id);
    let tickEnded = false;
    const tick = runScheduledJobs(deps(), nextDay()).finally(() => {
      tickEnded = true;
    });
    try {
      await eventually(async () => (await lockWaiters()) >= 1); // the job has reached the lock, inside its own transaction
      expect(await isPublished(before)).toBe(true); // drained before the loop reached the job
      // Raised after the job was held up: only a relay running beside the job can reach these. Its own company's too.
      const other = await enqueue(B.id);
      const same = await enqueue(A.id);
      await eventually(() => isPublished(other));
      await eventually(() => isPublished(same));
      expect(tickEnded).toBe(false);
      expect(await lockWaiters()).toBeGreaterThanOrEqual(1);
    } finally {
      await release();
    }
    const result = await tick;
    expect(result.ran).toContain(`TEST_SLOW_JOB:${A.id}`);
    expect(result.dispatched).toBeGreaterThanOrEqual(3);
  });

  it('drains first, before any company’s job, with the next pass far off', async () => {
    const before = await enqueue(C.id);
    const seen: boolean[] = [];
    slowJob = async () => {
      seen.push(await isPublished(before));
      return { done: true };
    };
    await runScheduledJobs(deps({ settings: settings({ relayIntervalMs: 3_600_000 }) }), nextDay());
    expect(seen).toEqual([true, true, true]);
  });

  it('relays what the tick itself raised, in a last pass at its end', async () => {
    let raised = '';
    slowJob = async (_db, id) => {
      if (id === B.id) raised = await enqueue(B.id);
      return { done: true };
    };
    await runScheduledJobs(deps({ settings: settings({ relayIntervalMs: 3_600_000 }) }), nextDay());
    expect(await isPublished(raised)).toBe(true);
  });

  it('a company whose claim fails holds back neither the other companies nor the relay, and the tick still reports it', async () => {
    const at = nextDay();
    const ran: string[] = [];
    slowJob = async (_db, id) => {
      ran.push(id);
      return { done: true };
    };
    const event = await enqueue(C.id);
    const failing: Database = {
      query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]) {
        if (text.includes('insert into scheduled_job_run') && values?.includes(A.id)) return Promise.reject(new Error('synthetic failure')) as never;
        return h.pool.query<R>(text, values);
      },
      connect: () => h.pool.connect(),
    };
    await expect(runScheduledJobs(deps({ db: failing }), at)).rejects.toThrow('synthetic failure');
    expect(ran).toEqual(expect.arrayContaining([B.id, C.id]));
    expect(ran).not.toContain(A.id);
    expect(await isPublished(event)).toBe(true);
  });
});

describe('outbox claims take turns by company (G3; docs/09 §7.2)', () => {
  it('a burst from one company leaves another’s single event within two claims, oldest first within the company', async () => {
    await backlog(A.id, 500);
    const lone = await enqueue(B.id);
    expect(await dispatchOutbox(h.pool, 2)).toBe(2);
    expect(await isPublished(lone)).toBe(true);
    const claimed = await h.db.query<{ n: number }>(`select (payload->>'n')::int as n from outbox_event where company_id = $1 and topic = 'test.relay' and published_at is not null and payload ? 'n' and created_at > now() - interval '2 hours' and attempts = 1`, [A.id]);
    expect(claimed.rows).toEqual([{ n: 1 }]);
  });

  it('holds whichever company the walk starts from, and across calls of one claim each', async () => {
    await backlog(A.id, 50);
    const lone = await enqueue(B.id);
    await dispatchOutbox(h.pool, 1);
    await dispatchOutbox(h.pool, 1);
    expect(await isPublished(lone)).toBe(true);
    // Round again: the backlog goes on, and the next event of the other company is not behind what remains of it.
    const next = await enqueue(B.id);
    const before = await publishedOf(A.id);
    await dispatchOutbox(h.pool, 1);
    await dispatchOutbox(h.pool, 1);
    expect(await isPublished(next)).toBe(true);
    expect((await publishedOf(A.id)) - before).toBe(1);
  });

  it('with K companies waiting, each is reached within K claims', async () => {
    await backlog(A.id, 100);
    const ofB = await enqueue(B.id);
    const ofC = await enqueue(C.id);
    expect(await dispatchOutbox(h.pool, 3)).toBe(3);
    expect([await isPublished(ofB), await isPublished(ofC)]).toEqual([true, true]);
  });

  it('two workers at once consume every event once (for update skip locked)', async () => {
    await backlog(A.id, 20);
    await backlog(B.id, 20);
    const [one, two] = await Promise.all([dispatchOutbox(h.pool, 40), dispatchOutbox(h.pool, 40)]);
    expect(one! + two!).toBe(40);
    const rows = await h.one<{ more: number; waiting: number }>(`select count(*) filter (where attempts > 1)::int as more, count(*) filter (where published_at is null and failed_at is null)::int as waiting from outbox_event where topic = 'test.relay'`);
    expect(rows).toEqual({ more: 0, waiting: 0 });
  });

  it('reads past no delayed retry: a waiting event is out of the claim’s index, and rejoins its place when due (docs/09 §7.4)', async () => {
    const waiting: string[] = [];
    for (let i = 0; i < 25; i++) waiting.push(await enqueue(A.id, new Date(Date.now() - 3_600_000 + i).toISOString(), new Date(Date.now() + 3_600_000).toISOString()));
    const ready = await enqueue(A.id);
    const nodes = await planOf(OUTBOX_CLAIM_SQL, [FIRST_COMPANY]);
    const scan = nodes.find((n) => n['Index Name'] !== undefined)!;
    expect(scan['Index Name']).toBe('outbox_event_ready_idx');
    expect(scan['Rows Removed by Filter'] ?? 0).toBe(0);
    expect(scan['Actual Rows']).toBe(1);
    expect(nodes.map((n) => n['Node Type'])).not.toContain('Sort');

    await dispatchOutbox(h.pool, 100);
    expect(await isPublished(ready)).toBe(true);
    expect(await isPublished(waiting[0]!)).toBe(false);
    // Due now: back among the ready events, oldest first.
    await h.db.query(`update outbox_event set next_attempt_at = now() - interval '1 second' where id = any($1::uuid[])`, [waiting]);
    expect(await dispatchOutbox(h.pool, 100)).toBe(25);
    expect(await isPublished(waiting[24]!)).toBe(true);
    const flags = await h.one<{ n: number }>(`select count(*)::int as n from outbox_event where id = any($1::uuid[]) and attempts <> 1`, [waiting]);
    expect(flags.n).toBe(0);
  });
});

describe('report claims take turns by company (G3; docs/09 §7.2)', () => {
  const request = async (a: TestActor) => {
    const res = await h.call(a, 'POST', '/v1/reports', { reportCode: 'EMPLOYEE_REGISTER', filters: {} });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res.json().id as string;
  };
  const stateOf = async (id: string) => (await h.one<{ state: string }>(`select state from report_execution where id = $1`, [id])).state;

  it('a burst from one company leaves another’s report within two claims', async () => {
    const burst: string[] = [];
    for (let i = 0; i < 6; i++) burst.push(await request(hrA));
    const lone = await request(hrB);
    expect(await processReportQueue(h.pool, 2)).toBe(2);
    expect(await stateOf(lone)).toBe('COMPLETED');
    const states = await Promise.all(burst.map(stateOf));
    expect(states).toEqual(['COMPLETED', 'QUEUED', 'QUEUED', 'QUEUED', 'QUEUED', 'QUEUED']); // oldest first within the company

    const nodes = await planOf(REPORT_CLAIM_SQL, [RUNNING_LEASE_MINUTES, FIRST_COMPANY]);
    expect(nodes.find((n) => n['Index Name'] !== undefined)!['Index Name']).toBe('report_execution_queue_idx');
    expect(nodes.map((n) => n['Node Type'])).not.toContain('Sort');
    expect(await processReportQueue(h.pool, 10)).toBe(5);
  });

  it('keeps the retry: a report waiting for its next attempt is not claimed, and is once due', async () => {
    const waiting = await request(hrA);
    await h.db.query(`update report_execution set next_attempt_at = now() + interval '1 hour', attempts = 1 where id = $1`, [waiting]);
    expect(await processReportQueue(h.pool, 10)).toBe(0);
    await h.db.query(`update report_execution set next_attempt_at = now() - interval '1 second' where id = $1`, [waiting]);
    expect(await processReportQueue(h.pool, 10)).toBe(1);
    expect(await stateOf(waiting)).toBe('COMPLETED');
  });
});

describe('settings', () => {
  it('have named starting values and read a positive whole number from the environment', () => {
    const names = ['OUTBOX_RELAY_BATCH', 'OUTBOX_RELAY_INTERVAL_MS', 'SCHEDULED_RUN_LEASE_MS', 'REMINDER_CHUNK_SIZE', 'CELEBRATION_PAGE_SIZE', 'CELEBRATION_RECIPIENT_BATCH'];
    const saved = names.map((n) => [n, process.env[n]] as const);
    try {
      for (const n of names) delete process.env[n];
      expect(workerSettings()).toEqual({ relayBatch: 500, relayIntervalMs: 5_000, runLeaseMs: 300_000 });
      expect([reminderChunkSize(), celebrationPageSize(), celebrationRecipientBatch()]).toEqual([100, 100, 200]);
      process.env.OUTBOX_RELAY_INTERVAL_MS = '1000';
      process.env.OUTBOX_RELAY_BATCH = '0'; // not positive: the default stays
      process.env.REMINDER_CHUNK_SIZE = '7';
      process.env.CELEBRATION_RECIPIENT_BATCH = 'many';
      expect(workerSettings()).toEqual({ relayBatch: 500, relayIntervalMs: 1_000, runLeaseMs: 300_000 });
      expect([reminderChunkSize(), celebrationRecipientBatch()]).toEqual([7, 200]);
    } finally {
      for (const [n, v] of saved) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
    }
  });
});

describe('each due run is claimed once, without an insert per tick (docs/09 §7.2)', () => {
  const claimInserts = (statements: string[]) => statements.filter((s) => s.includes('insert into scheduled_job_run'));

  it('a tick with nothing newly due sends no claim insert', async () => {
    const at = nextDay();
    const first = recording();
    await runScheduledJobs(deps({ db: first.db }), at);
    expect(claimInserts(first.statements).length).toBeGreaterThan(0);
    const second = recording();
    const again = await runScheduledJobs(deps({ db: second.db }), at);
    expect(claimInserts(second.statements)).toEqual([]);
    expect(again.ran).toEqual([]);
  });

  it('any number of workers at once: each company’s run happens once, and the ledger has one row', async () => {
    const at = nextDay();
    const runs: string[] = [];
    slowJob = async (_db, id) => {
      runs.push(id);
      return { done: true };
    };
    const results = await Promise.all([runScheduledJobs(deps(), at), runScheduledJobs(deps(), at), runScheduledJobs(deps(), at)]);
    expect(runs.sort()).toEqual([A.id, B.id, C.id].sort());
    expect(results.flatMap((r) => r.ran).filter((r) => r.startsWith('TEST_SLOW_JOB:')).sort()).toEqual([A.id, B.id, C.id].map((id) => `TEST_SLOW_JOB:${id}`).sort());
    const ledger = await h.one<{ n: number; open: number }>(`select count(*)::int as n, count(*) filter (where finished_at is null)::int as open from scheduled_job_run where job_code = 'TEST_SLOW_JOB' and run_key like $1`, [`%:${at.toISOString().slice(0, 10)}`]);
    expect(ledger).toEqual({ n: 3, open: 0 });
  });

  it('a run whose claim was already taken is not run again even if the tick’s read missed it', async () => {
    const at = nextDay();
    const key = `TEST_SLOW_JOB:${A.id}:${at.toISOString().slice(0, 10)}`;
    let runs = 0;
    slowJob = async (_db, id) => {
      if (id === A.id) runs++;
      return { done: true };
    };
    // The read of settled runs answers nothing, as if another worker claimed just after it: the claim's insert still decides.
    await h.db.query(`insert into scheduled_job_run (run_key, job_code, company_id) values ($1, 'TEST_SLOW_JOB', $2)`, [key, A.id]);
    const blind: Database = {
      query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]) {
        if (text.startsWith('select run_key from scheduled_job_run')) return Promise.resolve({ rows: [], rowCount: 0 }) as never;
        return h.pool.query<R>(text, values);
      },
      connect: () => h.pool.connect(),
    };
    await runScheduledJobs(deps({ db: blind }), at);
    expect(runs).toBe(0);
  });
});
