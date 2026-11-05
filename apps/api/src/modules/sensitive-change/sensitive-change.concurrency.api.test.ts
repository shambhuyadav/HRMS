// ZT11, ZT40, CI29: simultaneous decisions on one sensitive change end in one result and at most one DB116 revision, whether two
// decisions, a decision and a withdrawal, or two runs of the scheduled apply cross. A raced request must leave what a request decided
// once leaves. Synthetic data only: example addresses and made-up values.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { footprintOf, raceOnTransaction, statusesOf } from '../../test/race.fixtures.js';
import { applyDueChanges } from './service.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let today: string;

const REVIEW: `${string}.${string}.${string}`[] = ['sensitive_change.review.private', 'sensitive_change.read.private', 'employee.read.private', 'employee.read.bank'];

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const person = async () => {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  return { emp: e.id as string, actor: await h.actor(A, 'EMPLOYEE', { employeeId: e.id }) };
};
type Person = Awaited<ReturnType<typeof person>>;

/** A request under review by `hr`, its task and its transaction. */
const underReview = async (p: Person, effectiveDate?: string) => {
  const created = await h.call(p.actor, 'POST', '/v1/me/sensitive-changes', { reason: 'Synthetic update', category: 'ADDRESS', values: { line1: `${uniq('R')} Synthetic Road`, city: 'Testville', countryCode: 'IN' }, ...(effectiveDate ? { effectiveDate } : {}) });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().requestId as string;
  expect((await h.call(p.actor, 'POST', `/v1/me/sensitive-changes/${id}/submit`, { expectedVersion: 1 })).json().state).toBe('SUBMITTED');
  const tasks = (await h.call(hr, 'GET', '/v1/sensitive-changes/tasks/mine')).json().items as { taskId: string; transactionId: string; request: { id: string } }[];
  const t = tasks.find((x) => x.request?.id === id)!;
  expect((await h.call(hr, 'POST', `/v1/sensitive-changes/tasks/${t.taskId}/start-review`)).json().state).toBe('IN_REVIEW');
  return { id, taskId: t.taskId, tx: (await h.one<{ t: string }>(`select transaction_id as t from employee_sensitive_change_request where id = $1`, [id])).t };
};
const decide = (taskId: string, decision: string, key = uniq('sc-key-')) =>
  h.call(hr, 'POST', `/v1/sensitive-changes/tasks/${taskId}/decision`, { decision, reason: 'Checked (synthetic)', idempotencyKey: key, ...(decision === 'APPROVE' ? {} : { employeeMessage: 'Synthetic message to the employee' }) });
const withdraw = (p: Person, id: string) => h.call(p.actor, 'POST', `/v1/me/sensitive-changes/${id}/withdraw`);
const stateOf = async (id: string) => (await h.one<{ state: string }>(`select state from employee_sensitive_change_request where id = $1`, [id])).state;
const revisionsOfRequest = async (id: string) => (await h.one<{ n: number }>(`select count(*)::int as n from employee_private_profile_revision where source_request_id = $1`, [id])).n;
const appliedRevision = async (id: string) => (await h.one<{ applied_revision_id: string | null }>(`select applied_revision_id from employee_sensitive_change_request where id = $1`, [id])).applied_revision_id;
const footprint = (r: { id: string; tx: string }) => footprintOf(h, A.id, r.tx, r.id);

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
  expect((await h.call(hr, 'PUT', '/v1/workflows/sensitive_change/fallback-reviewers', { reviewers: [{ userId: hr.user, priority: 1 }] })).statusCode).toBe(200);
  today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
});

afterAll(async () => {
  await h?.stop();
});

describe('two decisions on one review task', () => {
  it('approval queued first: one revision, applied once, and the rejection finds the task closed', async () => {
    const p = await person();
    const alone = await underReview(p);
    expect((await decide(alone.taskId, 'APPROVE')).json().state).toBe('APPLIED');

    const r = await underReview(p);
    const [approve, reject] = await raceOnTransaction(h, r.tx, [() => decide(r.taskId, 'APPROVE'), () => decide(r.taskId, 'REJECT')]);
    expect(approve!.statusCode, approve!.body).toBe(200);
    expect(reject!.statusCode).toBe(409);
    expect(reject!.json().error).toBe('TASK_CLOSED');
    expect(await stateOf(r.id)).toBe('APPLIED');
    expect(await revisionsOfRequest(r.id)).toBe(1);
    expect(await appliedRevision(r.id)).not.toBeNull();
    const raced = await footprint(r);
    expect(raced).toEqual(await footprint(alone));
    expect(raced.audit.length).toBeGreaterThan(0);
    expect(raced.notifications.length).toBeGreaterThan(0);
  });

  it('rejection queued first: no revision and no master change', async () => {
    const p = await person();
    const alone = await underReview(p);
    expect((await decide(alone.taskId, 'REJECT')).json().state).toBe('REJECTED');

    const r = await underReview(p);
    const [reject, approve] = await raceOnTransaction(h, r.tx, [() => decide(r.taskId, 'REJECT'), () => decide(r.taskId, 'APPROVE')]);
    expect(reject!.statusCode, reject!.body).toBe(200);
    expect(approve!.statusCode).toBe(409);
    expect(await stateOf(r.id)).toBe('REJECTED');
    expect(await revisionsOfRequest(r.id)).toBe(0);
    expect(await footprint(r)).toEqual(await footprint(alone));
  });

  it('the same approval sent twice with one key: both answer, the second as a replay, one revision', async () => {
    const p = await person();
    const r = await underReview(p);
    const key = uniq('sc-key-');
    const results = await raceOnTransaction(h, r.tx, [() => decide(r.taskId, 'APPROVE', key), () => decide(r.taskId, 'APPROVE', key)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(await revisionsOfRequest(r.id)).toBe(1);
    expect((await footprint(r)).decisions).toBe(1);
  });

  it('with no lock held, however the two interleave: one result, and a revision only if the approval won', async () => {
    for (let round = 0; round < 4; round++) {
      const p = await person();
      const r = await underReview(p);
      const results = await Promise.all([decide(r.taskId, 'APPROVE'), decide(r.taskId, 'REJECT')]);
      expect(statusesOf(results), results.map((x) => x.body).join(' ')).toEqual([200, 409]);
      const won = results[0]!.statusCode === 200;
      expect(await stateOf(r.id)).toBe(won ? 'APPLIED' : 'REJECTED');
      expect(await revisionsOfRequest(r.id)).toBe(won ? 1 : 0);
      expect((await footprint(r)).decisions).toBe(1);
    }
  });
});

describe('a decision and a withdrawal', () => {
  it('approval queued first: applied, and the withdrawal is refused', async () => {
    const p = await person();
    const r = await underReview(p);
    const [approve, out] = await raceOnTransaction(h, r.tx, [() => decide(r.taskId, 'APPROVE'), () => withdraw(p, r.id)]);
    expect(approve!.statusCode, approve!.body).toBe(200);
    expect(out!.statusCode).toBe(409);
    expect(await stateOf(r.id)).toBe('APPLIED');
    expect(await revisionsOfRequest(r.id)).toBe(1);
  });

  it('withdrawal queued first: withdrawn, the task closed, no revision', async () => {
    const p = await person();
    const r = await underReview(p);
    const [out, approve] = await raceOnTransaction(h, r.tx, [() => withdraw(p, r.id), () => decide(r.taskId, 'APPROVE')]);
    expect(out!.statusCode, out!.body).toBe(200);
    expect(approve!.statusCode).toBe(409);
    expect(await stateOf(r.id)).toBe('WITHDRAWN');
    expect(await revisionsOfRequest(r.id)).toBe(0);
    expect((await footprint(r)).decisions).toBe(0);
  });
});

describe('the scheduled apply (CI29 "apply exactly once")', () => {
  const scheduled = async (p: Person, on: string) => {
    const r = await underReview(p, on);
    expect((await decide(r.taskId, 'APPROVE')).json().state).toBe('SCHEDULED');
    return r;
  };

  it('two runs of the job over one due request apply it once and tell the employee once', async () => {
    const p = await person();
    const alone = await scheduled(p, addDays(today, 3));
    expect(await applyDueChanges(h.pool, A.id, addDays(today, 3), SYSTEM_ACTOR_ID)).toEqual({ due: 1, applied: 1, conflicts: 0 });

    const on = addDays(today, 4);
    const r = await scheduled(p, on);
    const [one, two] = await raceOnTransaction(h, r.tx, [() => applyDueChanges(h.pool, A.id, on, SYSTEM_ACTOR_ID), () => applyDueChanges(h.pool, A.id, on, SYSTEM_ACTOR_ID)]);
    expect(one!.applied + two!.applied).toBe(1);
    expect(one!.conflicts + two!.conflicts).toBe(0);
    expect(await stateOf(r.id)).toBe('APPLIED');
    expect(await revisionsOfRequest(r.id)).toBe(1);
    expect(await footprint(r)).toEqual(await footprint(alone));
  });
});

describe('one open request per employee and category', () => {
  it('two drafts sent together leave one', async () => {
    for (let round = 0; round < 3; round++) {
      const p = await person();
      const body = { reason: 'Synthetic update', category: 'ADDRESS', values: { line1: `${uniq('R')} Synthetic Road`, city: 'Testville', countryCode: 'IN' } };
      const results = await Promise.all([h.call(p.actor, 'POST', '/v1/me/sensitive-changes', body), h.call(p.actor, 'POST', '/v1/me/sensitive-changes', body)]);
      expect(statusesOf(results), results.map((x) => x.body).join(' ')).toEqual([201, 409]);
      expect((await h.one<{ n: number }>(`select count(*)::int as n from employee_sensitive_change_request where employee_id = $1`, [p.emp])).n).toBe(1);
    }
  });
});
