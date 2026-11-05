// Reminders, document expiry and celebrations in bounded transactions (docs/09 §7.2, §13.2 item 5; DF12 unchanged): no whole-company
// transaction, every chunk resumable, each recipient told once across a crash and a rerun. A crash is a statement that fails inside a
// chunk's real transaction, which rolls back as a dead connection's would, so what committed before it is exactly what a dead worker
// leaves. Celebrations stay one notice per recipient (the read-time form in docs/09 §7.3 needs the DF12 owner). Synthetic data only.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import type { Database } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { runScheduledJobs } from '../../worker/scheduler.js';
import { fanOutInBatches, runCelebrations } from './dispatcher.js';
import { runDocumentExpiry, runReminders } from './reminders.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let hrDocs: TestActor;
let celebrant: { id: string; actor: TestActor };
const colleagues: { id: string; actor: TestActor }[] = [];

const NOTICE = /^\s*insert into notification \(/;
const EVENT = /^\s*insert into notification_event \(/;
const pdf = Buffer.from('%PDF-1.4\n% synthetic test document\n%%EOF\n').toString('base64');

/** The pool, recording each transaction's statements; `crash` makes a statement fail, as if the worker died there. */
function probing(crash?: (text: string) => boolean): { db: Database; transactions: string[][] } {
  const transactions: string[][] = [];
  const db: Database = {
    query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]) {
      return h.pool.query<R>(text, values);
    },
    async connect() {
      const client = await h.pool.connect();
      let current: string[] = [];
      const query = async (text: string, values?: unknown[]) => {
        if (/^\s*begin\b/i.test(text)) {
          current = [];
          transactions.push(current);
        } else if (crash?.(text)) throw new Error('synthetic crash');
        else current.push(text);
        return client.query(text, values);
      };
      return new Proxy(client, { get: (target, property) => (property === 'query' ? query : Reflect.get(target, property, target)) });
    },
  };
  return { db, transactions };
}
/** Fails on the nth statement matching. */
const onNth = (pattern: RegExp, nth: number) => {
  let seen = 0;
  return (text: string) => pattern.test(text) && ++seen === nth;
};
const inserted = (t: string[], pattern: RegExp) => t.filter((s) => pattern.test(s)).length;

/** Every active employee with an Employee assignment: the celebration audience (DF12), whichever test made them. */
const everyone: string[] = [];
const person = async () => {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  const actor = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
  everyone.push(actor.user);
  return { id: e.id as string, actor };
};
/** How many notices each recipient has of an event, whatever their state. */
const noticesOf = async (eventKey: string) =>
  (
    await h.db.query<{ recipient: string; n: number }>(
      `select n.recipient_user_id as recipient, count(*)::int as n from notification n join notification_event e on e.company_id = n.company_id and e.id = n.event_id
        where e.company_id = $1 and e.event_key = $2 group by 1`,
      [A.id, eventKey],
    )
  ).rows;
const bodiesOf = async (eventKey: string) =>
  (await h.db.query<{ body: string }>(`select n.body from notification n join notification_event e on e.company_id = n.company_id and e.id = n.event_id where e.company_id = $1 and e.event_key = $2`, [A.id, eventKey])).rows.map((r) => r.body);
const audience = () => [...everyone].sort();
const eachOnce = async (eventKey: string, users: string[]) => {
  const rows = await noticesOf(eventKey);
  expect(rows.map((r) => r.recipient).sort()).toEqual([...users].sort());
  expect(rows.every((r) => r.n === 1)).toBe(true);
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  hrDocs = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['document.upload.document', 'document.read.document'] });
  for (const kind of ['leave_request', 'employee_confirmation']) {
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, $2, $3, 1, true)`, [A.id, kind, hr.user]);
  }
  celebrant = await person();
  for (let i = 0; i < 6; i++) colleagues.push(await person());
  expect((await h.call(celebrant.actor, 'PUT', '/v1/me/notification-preferences', { eventType: 'BIRTHDAY', publishCelebration: true })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

/** The celebrant's next birthday in a year of its own, so each test has its own event. */
let year = 2030;
const birthday = async () => {
  year += 1;
  await h.db.query(`update employee set date_of_birth = '1990-06-15' where id = $1`, [celebrant.id]);
  return { day: `${year}-06-15`, key: `BIRTHDAY:${celebrant.id}:${year}` };
};

describe('celebrations: one notice per recipient, in bounded batches (DF12)', () => {
  it('writes at most the batch per transaction, and tells everyone once with the DF12 content', async () => {
    const { day, key } = await birthday();
    const probe = probing();
    expect(await runCelebrations(probe.db, A.id, day, { recipientBatch: 2 })).toEqual({ day, events: 1 });
    const batches = probe.transactions.map((t) => inserted(t, NOTICE)).filter((n) => n > 0);
    expect(Math.max(...batches)).toBe(2);
    expect(batches.length).toBeGreaterThanOrEqual(4); // seven recipients, two at a time
    await eachOnce(key, audience());
    const bodies = await bodiesOf(key);
    expect(new Set(bodies)).toEqual(new Set(['Happy birthday, Synthetic Person from ENG!']));
    // The event's own row and every notice are written by the dispatcher itself.
    const actors = await h.one<{ other: number }>(`select count(*)::int as other from notification n join notification_event e on e.id = n.event_id where e.event_key = $1 and (n.created_by <> $2 or e.created_by <> $2)`, [key, SYSTEM_ACTOR_ID]);
    expect(actors.other).toBe(0);
    const positions = await h.one<{ other: number; total: number }>(
      `select count(*)::int as total, count(*) filter (where f.created_by <> $2 or f.updated_by <> $2)::int as other from notification_fan_out f join notification_event e on e.id = f.event_id where e.event_key = $1`,
      [key, SYSTEM_ACTOR_ID],
    );
    expect(positions).toEqual({ total: 1, other: 0 });
    // A rerun raises nothing.
    expect(await runCelebrations(h.pool, A.id, day, { recipientBatch: 2 })).toEqual({ day, events: 0 });
    await eachOnce(key, audience());
  });

  it('a crash in a batch loses that batch only; the rerun writes the rest from where the last batch ended, each once', async () => {
    const { day, key } = await birthday();
    const crashed = probing(onNth(NOTICE, 4)); // the second notice of the second batch
    await expect(runCelebrations(crashed.db, A.id, day, { recipientBatch: 2 })).rejects.toThrow('synthetic crash');
    const afterCrash = await noticesOf(key);
    expect(afterCrash).toHaveLength(2); // the first batch stands; the second rolled back with its position
    const position = await h.one<{ after: string; finished: boolean }>(
      `select f.after_user_id as after, f.finished_at is not null as finished from notification_fan_out f join notification_event e on e.id = f.event_id where e.event_key = $1`,
      [key],
    );
    expect(position.finished).toBe(false);
    expect(position.after).toBe([...afterCrash.map((r) => r.recipient)].sort().at(-1));

    const rerun = probing();
    expect(await runCelebrations(rerun.db, A.id, day, { recipientBatch: 2 })).toEqual({ day, events: 1 });
    // Only the five still owed: nobody already told is even looked at again.
    expect(rerun.transactions.reduce((all, t) => all + inserted(t, NOTICE), 0)).toBe(5);
    await eachOnce(key, audience());
    const finished = await h.one<{ open: number }>(`select count(*) filter (where f.finished_at is null)::int as open from notification_fan_out f join notification_event e on e.id = f.event_id where e.event_key = $1`, [key]);
    expect(finished.open).toBe(0);
    expect((await runCelebrations(rerun.db, A.id, day, { recipientBatch: 2 })).events).toBe(0);
  });

  it('a crash between batches and a crash before any batch both finish cleanly', async () => {
    const { day, key } = await birthday();
    await expect(runCelebrations(probing(onNth(/^\s*update notification_fan_out/, 2)).db, A.id, day, { recipientBatch: 3 })).rejects.toThrow('synthetic crash');
    expect(await noticesOf(key)).toHaveLength(3);
    await runCelebrations(h.pool, A.id, day, { recipientBatch: 3 });
    await eachOnce(key, audience());

    const second = await birthday();
    await expect(runCelebrations(probing(onNth(NOTICE, 1)).db, A.id, second.day, { recipientBatch: 3 })).rejects.toThrow('synthetic crash');
    expect(await noticesOf(second.key)).toHaveLength(0);
    await runCelebrations(h.pool, A.id, second.day, { recipientBatch: 3 });
    await eachOnce(second.key, audience());
  });

  it('two workers at once tell each recipient once', async () => {
    const { day, key } = await birthday();
    const results = await Promise.all([runCelebrations(h.pool, A.id, day, { recipientBatch: 2 }), runCelebrations(h.pool, A.id, day, { recipientBatch: 2 })]);
    await eachOnce(key, audience());
    expect(results.map((r) => r.events).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
  });

  it('a rerun keeps the content first recorded, rechecks each recipient and respects a consent withdrawn since', async () => {
    const { day, key } = await birthday();
    await expect(runCelebrations(probing(onNth(NOTICE, 3)).db, A.id, day, { recipientBatch: 2 })).rejects.toThrow('synthetic crash');
    const told = (await noticesOf(key)).map((r) => r.recipient);
    const leaver = colleagues.find((c) => !told.includes(c.actor.user))!;
    // Meanwhile the celebrant is renamed and a recipient leaves. The notice still says what the event recorded, and the leaver hears nothing.
    await h.db.query(`update employee set display_name = 'Renamed Person' where id = $1`, [celebrant.id]);
    await h.setStatus(A, leaver.id, 'INACTIVE_SEPARATED');
    try {
      expect((await runCelebrations(h.pool, A.id, day, { recipientBatch: 2 })).events).toBe(1);
      await eachOnce(key, audience().filter((u) => u !== leaver.actor.user));
      const bodies = (await bodiesOf(key)).filter((b) => b !== null);
      expect(new Set(bodies)).toEqual(new Set(['Happy birthday, Synthetic Person from ENG!']));
    } finally {
      await h.db.query(`update employee set display_name = 'Synthetic Person' where id = $1`, [celebrant.id]);
      await h.setStatus(A, leaver.id, 'ACTIVE_CONFIRMED');
    }

    const withdrawn = await birthday();
    await expect(runCelebrations(probing(onNth(NOTICE, 3)).db, A.id, withdrawn.day, { recipientBatch: 2 })).rejects.toThrow('synthetic crash');
    expect((await h.call(celebrant.actor, 'PUT', '/v1/me/notification-preferences', { eventType: 'BIRTHDAY', publishCelebration: false })).statusCode).toBe(200);
    try {
      expect((await runCelebrations(h.pool, A.id, withdrawn.day, { recipientBatch: 2 })).events).toBe(0);
      expect(await noticesOf(withdrawn.key)).toHaveLength(2);
    } finally {
      await h.call(celebrant.actor, 'PUT', '/v1/me/notification-preferences', { eventType: 'BIRTHDAY', publishCelebration: true });
    }
  });

  it('walks celebrants a page at a time, without losing one at a page’s edge', async () => {
    const { day, key } = await birthday();
    await h.db.query(`update employee set date_of_birth = '1991-06-15' where id = $1`, [colleagues[0]!.id]);
    expect((await h.call(colleagues[0]!.actor, 'PUT', '/v1/me/notification-preferences', { eventType: 'BIRTHDAY', publishCelebration: true })).statusCode).toBe(200);
    try {
      expect(await runCelebrations(h.pool, A.id, day, { pageSize: 1, recipientBatch: 100 })).toEqual({ day, events: 2 });
      await eachOnce(key, audience());
      await eachOnce(`BIRTHDAY:${colleagues[0]!.id}:${year}`, audience());
    } finally {
      await h.call(colleagues[0]!.actor, 'PUT', '/v1/me/notification-preferences', { eventType: 'BIRTHDAY', publishCelebration: false });
    }
  });

  it('fanOutInBatches pages any selector, and an event written whole is never reopened', async () => {
    const key = uniq('test-batched:');
    const spec = { eventType: 'APPROVAL_ESCALATION', fallbackKind: 'employee_confirmation', subjectEmployeeId: null, transactionId: null, transactionRevision: null, taskId: null, beneficiaryUserId: null, data: { requestKind: 'x', waitingDays: '1' } };
    expect(await fanOutInBatches(h.pool, A.id, key, null, spec, 1)).toMatchObject({ recorded: true });
    await eachOnce(key, [hr.user]);
    expect(await fanOutInBatches(h.pool, A.id, key, null, spec, 1)).toEqual({ created: 0, recorded: false });
  });
});

describe('reminders in chunks (DF03, DF11, BR-031)', () => {
  it('confirmation reminders: at most the chunk per transaction; a crash loses that chunk and the rerun tells each case once', async () => {
    const cases: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
      await h.setStatus(A, e.id, 'ACTIVE_PROBATION');
      const res = await h.call(hr, 'POST', '/v1/confirmations', { employeeId: e.id });
      expect(res.statusCode, res.body).toBeLessThan(300);
      cases.push(res.json().caseId);
    }
    await h.db.query(`update employee_confirmation set current_due_date = hrms_business_date(company_id, now()) + 7 where id = any($1::uuid[])`, [cases]);
    const count = async () => (await h.one<{ n: number }>(`select count(*)::int as n from notification_event where company_id = $1 and event_type = 'CONFIRMATION_DUE'`, [A.id])).n;
    const hrNotices = async () => (await h.one<{ n: number }>(`select count(*)::int as n from notification where company_id = $1 and category = 'CONFIRMATION_DUE' and recipient_user_id = $2`, [A.id, hr.user])).n;

    const crashed = probing(onNth(EVENT, 3));
    await expect(runReminders(crashed.db, A.id, { chunkSize: 2 })).rejects.toThrow('synthetic crash');
    expect(await count()).toBe(2); // the first chunk stands

    const probe = probing();
    const first = await runReminders(probe.db, A.id, { chunkSize: 2 });
    expect(first.reminders).toBe(3);
    expect(Math.max(...probe.transactions.map((t) => inserted(t, EVENT)))).toBe(2);
    expect(await count()).toBe(5);
    expect(await hrNotices()).toBe(5);
    expect((await runReminders(h.pool, A.id, { chunkSize: 2 })).reminders).toBe(0);
    expect(await hrNotices()).toBe(5);
  });

  it('approval reminders: each task once across a crash, across a chunk’s edge, with the reviewer check unchanged', async () => {
    const managerEmployee = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id as string;
    await h.setStatus(A, managerEmployee, 'ACTIVE_CONFIRMED');
    const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmployee });
    for (const p of (await h.call(hr, 'GET', '/v1/leave/policies')).json().items) await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version });
    const monday = () => {
      const d = new Date(Date.now() + 30 * 86_400_000);
      while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    };
    const tasks: string[] = [];
    for (let i = 0; i < 3; i++) {
      const e = await person();
      await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmployee, effectiveFrom: '2026-01-05' });
      await h.call(hr, 'POST', '/v1/leave/adjustments', { employeeId: e.id, leaveType: 'CASUAL', kind: 'OPENING', units: '3', effectiveDate: '2026-01-05', reason: 'Opening (synthetic)', idempotencyKey: uniq('open-key-') });
      const { requestId } = (await h.call(e.actor, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: monday(), endDate: monday() })).json();
      const task = await h.one<{ id: string }>(`select t.id from approval_task t join approval_instance i on i.id = t.instance_id join leave_request lr on lr.transaction_id = i.transaction_id where lr.id = $1`, [requestId]);
      tasks.push(task.id);
    }
    await h.db.query('set session_replication_role = replica');
    try {
      await h.db.query(`update approval_task set created_at = now() - interval '4 days' where id = any($1::uuid[])`, [tasks]);
    } finally {
      await h.db.query('set session_replication_role = origin');
    }
    const reminded = async () => (await h.db.query<{ task: string }>(`select split_part(event_key, ':', 2) as task from notification_event where company_id = $1 and event_type = 'APPROVAL_REMINDER' and split_part(event_key, ':', 2) = any($2::text[])`, [A.id, tasks])).rows.map((r) => r.task);
    const managerNotices = async () => (await h.one<{ n: number }>(`select count(*)::int as n from notification where company_id = $1 and category = 'APPROVAL_REMINDER' and recipient_user_id = $2 and state = 'DELIVERED'`, [A.id, manager.user])).n;

    await expect(runReminders(probing(onNth(EVENT, 3)).db, A.id, { chunkSize: 2 })).rejects.toThrow('synthetic crash');
    expect(await reminded()).toHaveLength(2);
    await runReminders(h.pool, A.id, { chunkSize: 2 });
    expect((await reminded()).sort()).toEqual([...tasks].sort());
    expect(await managerNotices()).toBe(3);
    await runReminders(h.pool, A.id, { chunkSize: 2 });
    expect(await managerNotices()).toBe(3);
  });
});

describe('document expiry in chunks (DF12)', () => {
  it('at most the chunk per transaction; a crash loses that chunk and the rerun notices each document once', async () => {
    const day = '2033-03-15';
    const docs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await h.call(hrDocs, 'POST', `/v1/employees/${celebrant.id}/documents`, { documentType: 'GENERAL', fileName: `synthetic-${i}.pdf`, contentBase64: pdf, expiresOn: day });
      expect(res.statusCode, res.body).toBe(201);
      docs.push(res.json().id);
    }
    const notices = async () => (await h.one<{ n: number }>(`select count(*)::int as n from notification where company_id = $1 and category = 'DOCUMENT_EXPIRING' and recipient_user_id = $2`, [A.id, hrDocs.user])).n;
    const crashed = probing(onNth(EVENT, 3));
    await expect(runDocumentExpiry(crashed.db, A.id, day, 0, { chunkSize: 2 })).rejects.toThrow('synthetic crash');
    expect(await notices()).toBe(2);

    const probe = probing();
    expect(await runDocumentExpiry(probe.db, A.id, day, 0, { chunkSize: 2 })).toMatchObject({ day, events: 3 });
    expect(Math.max(...probe.transactions.map((t) => inserted(t, EVENT)))).toBe(2);
    expect(await notices()).toBe(5);
    expect(await runDocumentExpiry(h.pool, A.id, day, 0, { chunkSize: 2 })).toMatchObject({ day, events: 0, notifications: 0 });
    expect(await notices()).toBe(5);
  });
});

describe('the scheduled run of work in chunks', () => {
  /** A time on a company-local day, in Asia/Kolkata. */
  const atLocal = (day: string, hour: number, minute = 0) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), hour, minute) - 330 * 60_000);
  const deps = (db: Database = h.pool) => ({ db, providers: new Map(), systemUserId: SYSTEM_ACTOR_ID });
  const runOf = (code: string, day: string) => h.one<{ outcome: string | null; attempts: number; lease: boolean; detail: Record<string, unknown> | null }>(`select outcome, attempts, lease_until > now() as lease, detail from scheduled_job_run where run_key = $1`, [`${code}:${A.id}:${day}`]);

  it('keeps 08:00 and 09:00: reminders not before eight, celebrations not before nine', async () => {
    const { day, key } = await birthday();
    const early = await runScheduledJobs(deps(), atLocal(day, 7, 59));
    expect(early.ran).not.toContain(`REMINDERS:${A.id}`);
    const eight = await runScheduledJobs(deps(), atLocal(day, 8, 59));
    expect(eight.ran).toContain(`REMINDERS:${A.id}`);
    expect(eight.ran).not.toContain(`CELEBRATIONS:${A.id}`);
    expect(await noticesOf(key)).toEqual([]);
    const nine = await runScheduledJobs(deps(), atLocal(day, 9, 0));
    expect(nine.ran).toContain(`CELEBRATIONS:${A.id}`);
    await eachOnce(key, audience());
  });

  it('a run a dead worker left waits out its lease, then another worker finishes it and nobody is told twice', async () => {
    const { day, key } = await birthday();
    await expect(runCelebrations(probing(onNth(NOTICE, 3)).db, A.id, day, { recipientBatch: 2 })).rejects.toThrow('synthetic crash');
    // What a worker that died leaves in the ledger: claimed, unfinished, its lease still running.
    await h.db.query(`insert into scheduled_job_run (run_key, job_code, company_id, lease_until, attempts) values ($1, 'CELEBRATIONS', $2, now() + interval '1 hour', 1)`, [`CELEBRATIONS:${A.id}:${day}`, A.id]);
    const during = await runScheduledJobs(deps(), atLocal(day, 11));
    expect(during.ran).not.toContain(`CELEBRATIONS:${A.id}`);
    expect(await noticesOf(key)).toHaveLength(2);

    await h.db.query(`update scheduled_job_run set lease_until = now() - interval '1 second' where run_key = $1`, [`CELEBRATIONS:${A.id}:${day}`]);
    const after = await runScheduledJobs(deps(), atLocal(day, 11));
    expect(after.ran).toContain(`CELEBRATIONS:${A.id}`);
    await eachOnce(key, audience());
    expect(await runOf('CELEBRATIONS', day)).toMatchObject({ outcome: 'OK', attempts: 2 });

    expect((await runScheduledJobs(deps(), atLocal(day, 11))).ran).not.toContain(`CELEBRATIONS:${A.id}`);
    await eachOnce(key, audience());
    expect(await runOf('CELEBRATIONS', day)).toMatchObject({ outcome: 'OK', attempts: 2 });
  });

  it('a run in progress is left alone while its worker lives, however long it takes', async () => {
    const { day } = await birthday();
    await h.db.query(`insert into scheduled_job_run (run_key, job_code, company_id, lease_until, attempts) values ($1, 'CELEBRATIONS', $2, now() + interval '1 hour', 1)`, [`CELEBRATIONS:${A.id}:${day}`, A.id]);
    const results = await Promise.all([runScheduledJobs(deps(), atLocal(day, 11)), runScheduledJobs(deps(), atLocal(day, 11))]);
    expect(results.flatMap((r) => r.ran)).not.toContain(`CELEBRATIONS:${A.id}`);
    expect(await runOf('CELEBRATIONS', day)).toMatchObject({ outcome: null, attempts: 1 });
  });

  it('a run that fails waits 1, 5 and 15 minutes (ADR-13) with what it did kept, then ends FAILED; a run with no lease stays once only', async () => {
    const { day, key } = await birthday();
    const failing = probing((text) => NOTICE.test(text));
    const leaseMinutes = async () => (await h.one<{ m: number }>(`select round(extract(epoch from (lease_until - now())) / 60)::int as m from scheduled_job_run where run_key = $1`, [`CELEBRATIONS:${A.id}:${day}`])).m;
    const lapse = () => h.db.query(`update scheduled_job_run set lease_until = now() - interval '1 second' where run_key = $1`, [`CELEBRATIONS:${A.id}:${day}`]);
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const tick = await runScheduledJobs(deps(failing.db), atLocal(day, 11));
      expect(tick.ran).not.toContain(`CELEBRATIONS:${A.id}`);
      waits.push(await leaseMinutes());
      expect(await runOf('CELEBRATIONS', day)).toMatchObject({ outcome: null, attempts: attempt, detail: { attempt, errorCode: 'Error' } });
      // Not again before its time.
      await runScheduledJobs(deps(failing.db), atLocal(day, 11));
      expect((await runOf('CELEBRATIONS', day)).attempts).toBe(attempt);
      await lapse();
    }
    expect(waits).toEqual([1, 5, 15]);
    await runScheduledJobs(deps(failing.db), atLocal(day, 11));
    expect(await runOf('CELEBRATIONS', day)).toMatchObject({ outcome: 'FAILED', attempts: 4 });
    expect(await noticesOf(key)).toEqual([]);

    // Another worker that takes a lapsed run past its attempts ends it too, without working.
    const other = await birthday();
    await h.db.query(`insert into scheduled_job_run (run_key, job_code, company_id, lease_until, attempts) values ($1, 'CELEBRATIONS', $2, now() - interval '1 second', 4)`, [`CELEBRATIONS:${A.id}:${other.day}`, A.id]);
    expect((await runScheduledJobs(deps(), atLocal(other.day, 11))).ran).not.toContain(`CELEBRATIONS:${A.id}`);
    expect(await runOf('CELEBRATIONS', other.day)).toMatchObject({ outcome: 'FAILED', attempts: 5, detail: { message: 'WORKER_INTERRUPTED' } });
    expect(await noticesOf(other.key)).toEqual([]);

    // A job without a lease that a worker left unfinished stays claimed, as it always was: nothing may repeat it.
    const third = await birthday();
    await h.db.query(`insert into scheduled_job_run (run_key, job_code, company_id) values ($1, 'PRIVATE_PROFILE_CHANGES', $2)`, [`PRIVATE_PROFILE_CHANGES:${A.id}:${third.day}`, A.id]);
    expect((await runScheduledJobs(deps(), atLocal(third.day, 11))).ran).not.toContain(`PRIVATE_PROFILE_CHANGES:${A.id}`);
    expect(await runOf('PRIVATE_PROFILE_CHANGES', third.day)).toMatchObject({ outcome: null, attempts: 0 });
  });
});
