// Self-service preferences and the delivery log (FR-061, FR-083, FR-085, BR-034, DF12): a user reads and changes only their
// own optional choices, with DF12's defaults; support filters and pages notification outcomes and sees events that failed
// to dispatch, under one permission and one company, never message content or a payload. Synthetic data only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type EventDescriber, MODULE_EVENT_DESCRIBERS } from '../events-registry.js';
import { dispatchOutbox } from './dispatcher.js';

let h: Harness;
let A: Company;
let B: Company;
let support: TestActor;
let supportB: TestActor;
let employee: TestActor;
let other: TestActor;

const DELIVERY = '/v1/notifications/delivery';
const FAILED_EVENTS = '/v1/notifications/delivery/failed-events';
const describers = MODULE_EVENT_DESCRIBERS as Record<string, EventDescriber>;

type Row = { id: string; category: string; state: string; recipientUserId: string; recipientAccount: string; attempts: number; lastFailureCode: string | null };
const log = async (a: TestActor, query = '') => {
  const res = await h.call(a, 'GET', `${DELIVERY}${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { items: Row[]; total: number; page?: number; pageSize?: number };
};

/** One event per state a notification can end in: delivered, suppressed (no live assignment) and failed (a missing value). */
async function notify(company: Company, category: string, recipient: string, state: 'DELIVERED' | 'SUPPRESSED' | 'FAILED', failure: string | null) {
  const id = (
    await h.one<{ id: string }>(
      `insert into notification (company_id, recipient_user_id, category, state, channel, idempotency_key, body, title)
       values ($1, $2, $3, $4, 'IN_APP', $5, 'SECRET-MESSAGE body', 'SECRET-MESSAGE title') returning id`,
      [company.id, recipient, category, state, uniq('log-key:')],
    )
  ).id;
  await h.db.query(`insert into notification_delivery_attempt (company_id, notification_id, attempt_number, outcome, outcome_at, failure_code) values ($1, $2, 1, $3, now(), $4)`, [company.id, id, state, failure]);
  return id;
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  support = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  supportB = await h.actor(B, 'SYSTEM_ADMINISTRATOR');
  const hr = await h.actor(A, 'HR_ADMINISTRATOR');
  const person = async () => (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id as string;
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: await person() });
  other = await h.actor(A, 'EMPLOYEE', { employeeId: await person() });
  describers['test.failing'] = async () => {
    throw new TypeError('synthetic describer failure, SECRET-ERROR-MESSAGE');
  };
});

afterAll(async () => {
  delete describers['test.failing'];
  await h?.stop();
});

describe('own notification preferences (FR-083, FR-085, DF12)', () => {
  const read = async (a: TestActor) => {
    const res = await h.call(a, 'GET', '/v1/me/notification-preferences');
    expect(res.statusCode, res.body).toBe(200);
    return res.json().items as { eventType: string; publishCelebration: boolean; receiveOptional: boolean }[];
  };

  it('never saved reads as DF12’s defaults: publication off, receipt on', async () => {
    expect(await read(employee)).toEqual([
      { eventType: 'BIRTHDAY', publishCelebration: false, receiveOptional: true },
      { eventType: 'WORK_ANNIVERSARY', publishCelebration: false, receiveOptional: true },
    ]);
  });

  it('a saved choice reads back for its owner alone, one event at a time', async () => {
    expect((await h.call(employee, 'PUT', '/v1/me/notification-preferences', { eventType: 'BIRTHDAY', publishCelebration: true })).statusCode).toBe(200);
    expect((await h.call(employee, 'PUT', '/v1/me/notification-preferences', { eventType: 'WORK_ANNIVERSARY', receiveOptional: false })).statusCode).toBe(200);
    expect(await read(employee)).toEqual([
      { eventType: 'BIRTHDAY', publishCelebration: true, receiveOptional: true },
      { eventType: 'WORK_ANNIVERSARY', publishCelebration: false, receiveOptional: false },
    ]);
    expect(await read(other)).toEqual([
      { eventType: 'BIRTHDAY', publishCelebration: false, receiveOptional: true },
      { eventType: 'WORK_ANNIVERSARY', publishCelebration: false, receiveOptional: true },
    ]);
  });

  it('a preference held in another company is not this company’s (one user, two companies)', async () => {
    const elsewhere = await h.actor(B, 'SYSTEM_ADMINISTRATOR', { user: employee.user });
    expect((await read(elsewhere)).find((p) => p.eventType === 'BIRTHDAY')?.publishCelebration).toBe(false);
    expect((await h.call(elsewhere, 'PUT', '/v1/me/notification-preferences', { eventType: 'BIRTHDAY', publishCelebration: true })).statusCode).toBe(200);
    expect((await h.call(elsewhere, 'PUT', '/v1/me/notification-preferences', { eventType: 'BIRTHDAY', publishCelebration: false })).statusCode).toBe(200);
    expect((await read(employee)).find((p) => p.eventType === 'BIRTHDAY')?.publishCelebration).toBe(true);
  });

  it('a mandatory notice has no preference to set (FR-085)', async () => {
    expect((await h.call(employee, 'PUT', '/v1/me/notification-preferences', { eventType: 'EXPENSE_DECIDED', receiveOptional: false })).statusCode).toBe(400);
  });
});

describe('delivery log filters and paging (FR-085)', () => {
  it('filters by state and by event, shows attempts and the failure code, and never the message', async () => {
    const delivered = await notify(A, 'LOG_ALPHA', employee.user, 'DELIVERED', null);
    const suppressed = await notify(A, 'LOG_ALPHA', other.user, 'SUPPRESSED', 'RECIPIENT_NOT_ELIGIBLE');
    const failed = await notify(A, 'LOG_BETA', employee.user, 'FAILED', 'MISSING_PLACEHOLDER');

    const alpha = await log(support, '?category=LOG_ALPHA');
    expect(alpha.items.map((r) => r.id).sort()).toEqual([delivered, suppressed].sort());
    expect(alpha.total).toBe(2);

    const onlyFailed = await log(support, '?state=FAILED&category=LOG_BETA');
    expect(onlyFailed.items).toHaveLength(1);
    expect(onlyFailed.items[0]).toMatchObject({ id: failed, state: 'FAILED', attempts: 1, lastFailureCode: 'MISSING_PLACEHOLDER', recipientUserId: employee.user });
    expect(onlyFailed.items[0]!.recipientAccount).toMatch(/^user\./);

    const notEligible = await log(support, '?state=SUPPRESSED&category=LOG_ALPHA');
    expect(notEligible.items.map((r) => [r.id, r.lastFailureCode])).toEqual([[suppressed, 'RECIPIENT_NOT_ELIGIBLE']]);

    expect(JSON.stringify(alpha)).not.toContain('SECRET-MESSAGE');
    expect(JSON.stringify(onlyFailed)).not.toContain('SECRET-MESSAGE');
  });

  it('refuses a state or event outside the lists, rather than ignoring the filter', async () => {
    expect((await h.call(support, 'GET', `${DELIVERY}?state=LOST`)).statusCode).toBe(400);
    expect((await h.call(support, 'GET', `${DELIVERY}?category=not-a-code`)).statusCode).toBe(400);
    expect((await h.call(support, 'GET', `${DELIVERY}?pageSize=7`)).statusCode).toBe(400);
  });

  it('pages through every match with its total; without a page it answers the capped list with the total', async () => {
    for (let i = 0; i < 27; i++) await notify(A, 'LOG_PAGED', employee.user, 'DELIVERED', null);
    const first = await log(support, '?category=LOG_PAGED&page=1&pageSize=25');
    const second = await log(support, '?category=LOG_PAGED&page=2&pageSize=25');
    expect(first).toMatchObject({ total: 27, page: 1, pageSize: 25 });
    expect(first.items).toHaveLength(25);
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map((r) => r.id)).size).toBe(27);
    const past = await log(support, '?category=LOG_PAGED&page=3&pageSize=25');
    expect(past).toMatchObject({ items: [], total: 27 });
    const capped = await log(support, '?category=LOG_PAGED');
    expect(capped.items).toHaveLength(27);
    expect(capped.total).toBe(27);
    expect(capped).not.toHaveProperty('page');
  });

  it('stays in its permission and its company', async () => {
    expect((await h.call(employee, 'GET', DELIVERY)).statusCode).toBe(403);
    const elsewhere = await notify(B, 'LOG_GAMMA', supportB.user, 'DELIVERED', null);
    expect((await log(support, '?category=LOG_GAMMA')).items).toEqual([]);
    expect((await log(supportB, '?category=LOG_GAMMA')).items.map((r) => r.id)).toEqual([elsewhere]);
  });
});

describe('events that failed to dispatch (notify-14; FR-061, BR-034)', () => {
  type FailedEvent = { id: string; topic: string; state: string; attempts: number; failureCode: string | null; nextAttemptAt: string | null; failedAt: string | null };
  const failed = async (a: TestActor, query = '') => {
    const res = await h.call(a, 'GET', `${FAILED_EVENTS}${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { items: FailedEvent[]; total: number };
  };
  const queue = async (company: Company, topic: string, payload: object) =>
    (await h.one<{ id: string }>(`insert into outbox_event (company_id, topic, aggregate_id, dedupe_key, payload) values ($1, $2, $3, $4, $5) returning id::text as id`, [company.id, topic, randomUUID(), uniq(`${topic}:`), payload])).id;

  it('shows an event still retrying and one given up on, with its attempts and error class, never its payload', async () => {
    const retrying = await queue(A, 'test.failing', { secret: 'SECRET-PAYLOAD' });
    await dispatchOutbox(h.pool, 50);
    let listed = await failed(support);
    expect(listed.items.find((e) => e.id === retrying)).toMatchObject({ topic: 'test.failing', state: 'RETRYING', attempts: 1, failureCode: 'TypeError', failedAt: null });
    expect(listed.items.find((e) => e.id === retrying)!.nextAttemptAt).not.toBeNull();

    // Its retries come due and run out (1, 5 and 15 minutes), then it is FAILED.
    for (let i = 0; i < 3; i++) {
      await h.db.query(`update outbox_event set next_attempt_at = now() - interval '1 second' where id = $1`, [retrying]);
      await dispatchOutbox(h.pool, 50);
    }
    listed = await failed(support);
    const gaveUp = listed.items.find((e) => e.id === retrying)!;
    expect(gaveUp).toMatchObject({ state: 'FAILED', attempts: 4, failureCode: 'TypeError', nextAttemptAt: null });
    expect(gaveUp.failedAt).not.toBeNull();
    expect(gaveUp).not.toHaveProperty('payload');
    expect(JSON.stringify(listed)).not.toContain('SECRET-PAYLOAD');
    expect(JSON.stringify(listed)).not.toContain('SECRET-ERROR-MESSAGE');
  });

  it('filters by state, leaves out delivered and not yet attempted events, and pages', async () => {
    const stillRetrying = await queue(A, 'test.failing', {});
    await dispatchOutbox(h.pool, 50);
    const notYetTried = await queue(A, 'test.failing', {});
    await h.db.query(`update outbox_event set next_attempt_at = now() + interval '1 hour' where id = $1`, [notYetTried]);

    const onlyRetrying = await failed(support, '?state=RETRYING');
    expect(onlyRetrying.items.map((e) => e.id)).toContain(stillRetrying);
    expect(onlyRetrying.items.every((e) => e.state === 'RETRYING')).toBe(true);
    expect(onlyRetrying.items.map((e) => e.id)).not.toContain(notYetTried);

    const onlyFailed = await failed(support, '?state=FAILED');
    expect(onlyFailed.items.length).toBeGreaterThan(0);
    expect(onlyFailed.items.every((e) => e.state === 'FAILED')).toBe(true);
    expect(onlyFailed.items.map((e) => e.id)).not.toContain(stillRetrying);

    const published = await queue(A, 'test.nobody.describes', {});
    await dispatchOutbox(h.pool, 50);
    expect((await failed(support)).items.map((e) => e.id)).not.toContain(published);

    const page = (await h.call(support, 'GET', `${FAILED_EVENTS}?page=1&pageSize=25`)).json();
    expect(page).toMatchObject({ page: 1, pageSize: 25 });
    expect(page.total).toBeGreaterThanOrEqual(2);
    expect((await h.call(support, 'GET', `${FAILED_EVENTS}?state=DELIVERED`)).statusCode).toBe(400);
  });

  it('stays in its permission and its company', async () => {
    expect((await h.call(employee, 'GET', FAILED_EVENTS)).statusCode).toBe(403);
    expect((await failed(supportB)).items).toEqual([]);
  });
});
