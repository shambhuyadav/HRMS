// BR-020 expense amounts (BRD line 1755) and BR-022 expense currency (BRD line 1767; DF06 "foreign-currency claims are disabled in wave
// 1"; OQ-17). Expected values are worked by hand from the BRD. Each database refusal is reached with a direct write, so it is the
// database saying no; a refusal over HTTP may come from the service in front of it. Synthetic INR amounts only.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../../../db/migrate.js';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { startEmptyTestDatabase, type TestDatabase } from '../../../../../db/tests/test-database.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let fin1: TestActor;
let fin2: TestActor;
let manager: TestActor;
let employee: TestActor;
let employeeEmp: string;

const FINANCE: PermissionKey[] = ['expense.read.operational', 'expense.manager_decide.operational', 'expense.finance_decide.operational', 'expense.high_value_decide.operational'];

const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const receipt = async () => {
  const res = await h.call(employee, 'POST', '/v1/expense/receipts', { fileName: 'receipt.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic receipt ${uniq('r')}\n%%EOF\n`).toString('base64') });
  expect(res.statusCode, res.body).toBe(201);
  return { receiptId: res.json().receiptId as string };
};
const line = async (claimed: string, gross = claimed, category = 'OTHER') => ({
  category,
  expenseDate: daysAgo(3),
  merchant: 'Synthetic Merchant',
  grossAmount: gross,
  claimedAmount: claimed,
  description: 'Synthetic expense',
  receipt: await receipt(),
});
const draft = (lines: object[], currency = 'INR') => h.call(employee, 'POST', '/v1/expense/claims', { purpose: 'Client visit (synthetic)', currency, lines });
const claim = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
const submit = async (id: string) => h.call(employee, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await claim(employee, id)).version });
const taskOf = async (a: TestActor, claimId: string) => {
  const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [claimId])).transaction_id;
  return ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)!.taskId;
};
const decide = (a: TestActor, taskId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/expense/tasks/${taskId}/decision`, { idempotencyKey: uniq('amount-key-'), ...body });
/** A submitted claim past the manager, on the finance step; answers its id and its line ids in order. */
const atFinance = async (lines: object[]) => {
  const id = (await draft(lines)).json().claimId as string;
  expect((await submit(id)).statusCode).toBe(200);
  expect((await decide(manager, await taskOf(manager, id), { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');
  return { id, lines: ((await claim(fin1, id)).lines as { id: string }[]).map((l) => l.id) };
};
const decideLines = async (id: string, amounts: [string, string, string?][]) =>
  decide(fin1, await taskOf(fin1, id), { decision: 'APPROVE', lines: amounts.map(([lineId, allowedAmount, reason]) => ({ lineId, allowedAmount, ...(reason ? { reason } : {}) })) });

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  fin1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  fin2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true), ($1, 'expense_claim', $3, 2, true)`, [A.id, fin1.user, fin2.user]);
  const person = async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return e.id as string;
  };
  const managerEmp = await person();
  employeeEmp = await person();
  await h.call(hr, 'POST', `/v1/employees/${employeeEmp}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
  const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('expense amounts (BR-020)', () => {
  it('BR-020: the requested amount is positive and never above the invoice gross, over HTTP and at the database', async () => {
    expect((await draft([await line('0', '100')])).statusCode).toBe(422);
    expect((await draft([await line('100.01', '100')])).statusCode).toBe(422);
    // A negative amount does not reach the service.
    expect((await draft([await line('-1', '100')])).statusCode).toBe(400);
    // Exactly the gross, and less than the gross, are both accepted.
    const accepted = await draft([await line('100', '100'), await line('60', '100')]);
    expect(accepted.statusCode, accepted.body).toBe(201);
    const id = accepted.json().claimId as string;
    const rows = (await h.db.query<{ claimed: string; gross: string; id: string }>(
      `select l.id, l.claimed_amount::text as claimed, l.gross_amount::text as gross from expense_line l join expense_revision r on r.company_id = l.company_id and r.id = l.revision_id where r.claim_id = $1 order by l.sequence`,
      [id],
    )).rows;
    expect(rows.map((r) => [r.claimed, r.gross])).toEqual([['100.0000', '100.0000'], ['60.0000', '100.0000']]);
    // The draft is still editable, so only the line's own checks stand in the way of a direct write.
    await expect(h.db.query(`update expense_line set claimed_amount = 0 where id = $1`, [rows[0]!.id])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`update expense_line set claimed_amount = gross_amount + 0.01 where id = $1`, [rows[0]!.id])).rejects.toMatchObject({ code: '23514' });
    // Control: the same statement within the gross succeeds, so it is the amount being refused and not the write.
    await h.db.query('begin');
    try {
      expect((await h.db.query(`update expense_line set claimed_amount = gross_amount where id = $1`, [rows[1]!.id])).rowCount).toBe(1);
    } finally {
      await h.db.query('rollback');
    }
  });

  it('BR-020: an approved line amount lies between zero and the requested amount, both ends included', async () => {
    const { id, lines } = await atFinance([await line('600'), await line('400')]);
    const [l1, l2] = lines as [string, string];
    expect((await decideLines(id, [[l1, '600.01', 'Above the request'], [l2, '400']])).statusCode).toBe(422);
    expect((await h.one<{ state: string }>(`select state from expense_claim where id = $1`, [id])).state).toBe('FINANCE_PENDING');
    // A negative amount does not reach the service.
    expect((await decideLines(id, [[l1, '-1', 'Negative'], [l2, '400']])).statusCode).toBe(400);
    const approved = await decideLines(id, [[l1, '0', 'Personal, not eligible (synthetic)'], [l2, '400']]);
    expect(approved.json()).toMatchObject({ state: 'APPROVED', approvedAmount: '400.0000' });
    // The database refuses an amount above the request whatever the path; the trigger answers before the row's own key does.
    await expect(
      h.db.query(`insert into expense_line_decision (company_id, line_id, approval_decision_id, allowed_amount, exception_reason) select company_id, line_id, approval_decision_id, 400.01, 'x' from expense_line_decision where line_id = $1`, [l2]),
    ).rejects.toThrow(/allowed amount exceeds the claimed amount/);
    await expect(
      h.db.query(`insert into expense_line_decision (company_id, line_id, approval_decision_id, allowed_amount, exception_reason) select company_id, line_id, approval_decision_id, -0.01, 'x' from expense_line_decision where line_id = $1`, [l2]),
    ).rejects.toMatchObject({ code: '23514', constraint: expect.stringContaining('allowed_amount') });
  });

  it('BR-020: the final approved total is the sum of the line decisions: 600, 400, 250 approved at 500, 0, 250 is 750', async () => {
    const { id, lines } = await atFinance([await line('600'), await line('400'), await line('250')]);
    const approved = await decideLines(id, [[lines[0]!, '500', 'Capped (synthetic)'], [lines[1]!, '0', 'Personal (synthetic)'], [lines[2]!, '250']]);
    expect(approved.json()).toMatchObject({ state: 'APPROVED', approvedAmount: '750.0000' });
    const obligation = await h.one<{ id: string; approved_amount: string; revision_id: string; employee_id: string; approved_by: string }>(`select id, approved_amount::text, revision_id, employee_id, approved_by from expense_obligation where claim_id = $1`, [id]);
    expect(obligation.approved_amount).toBe('750.0000');
    // Whatever the path, an obligation other than that sum is refused, here one equal to the amounts requested.
    await h.db.query('begin');
    try {
      await expect(
        h.db.query(`insert into expense_obligation (company_id, claim_id, revision_id, employee_id, approved_amount, currency_code, approved_by) values ($1, $2, $3, $4, 1250, 'INR', $5)`, [A.id, id, obligation.revision_id, obligation.employee_id, obligation.approved_by]),
      ).rejects.toThrow(/does not equal final line decisions/);
    } finally {
      await h.db.query('rollback');
    }
  });

  it('BR-020: only the final decisions count: amounts decided on an earlier, returned revision are not in the total', async () => {
    // Above 50,000 the finance decision is followed by a further step, which can still send the claim back.
    const eleven = await Promise.all([...Array.from({ length: 10 }, () => line('5000', '5000', 'TRAVEL')), line('0.01')]);
    const first = await atFinance(eleven);
    // In full, so a total that took these in by mistake would be 50,000.01 above the right one.
    const decided = await decide(fin1, await taskOf(fin1, first.id), { decision: 'APPROVE', lines: first.lines.map((lineId, i) => ({ lineId, allowedAmount: i < 10 ? '5000' : '0.01' })) });
    expect(decided.json().state).toBe('HIGH_VALUE_PENDING');
    expect((await decide(fin2, await taskOf(fin2, first.id), { decision: 'RETURN', reason: 'Split the claim (synthetic)' })).json().state).toBe('RETURNED');
    const c = await claim(employee, first.id);
    const revised = await h.call(employee, 'PUT', `/v1/expense/claims/${first.id}`, { expectedVersion: c.version, purpose: 'Client visit (synthetic)', currency: 'INR', lines: [await line('300')] });
    expect(revised.statusCode, revised.body).toBe(200);
    expect((await submit(first.id)).statusCode).toBe(200);
    expect((await decide(manager, await taskOf(manager, first.id), { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');
    const current = ((await claim(fin1, first.id)).lines as { id: string }[]).map((l) => l.id);
    expect(current).toHaveLength(1);
    expect((await decideLines(first.id, [[current[0]!, '250', 'Capped (synthetic)']])).json()).toMatchObject({ state: 'APPROVED', approvedAmount: '250.0000' });
    expect((await h.one<{ approved_amount: string }>(`select approved_amount::text from expense_obligation where claim_id = $1`, [first.id])).approved_amount).toBe('250.0000');
    // The earlier decisions are kept, and are simply not part of it.
    expect((await h.one<{ n: number }>(`select count(*)::int as n from expense_line_decision where line_id = any($1::uuid[])`, [first.lines])).n).toBe(11);
  });
});

describe('expense currency (BR-022)', () => {
  it('BR-022: a claim uses one currency: a line carries none of its own, and a revision cannot change the claim’s', async () => {
    // The request schema drops what it does not name, so a currency on a line has nowhere to go.
    const withLineCurrency = await draft([{ ...(await line('100')), currency: 'USD' }]);
    expect(withLineCurrency.statusCode, withLineCurrency.body).toBe(201);
    expect((await claim(employee, withLineCurrency.json().claimId)).currency).toBe('INR');
    expect((await h.one<{ n: number }>(`select count(*)::int as n from information_schema.columns where table_name = 'expense_line' and column_name like '%currency%'`)).n).toBe(0);
    const id = (await draft([await line('100')])).json().claimId as string;
    const c = await claim(employee, id);
    const changed = await h.call(employee, 'PUT', `/v1/expense/claims/${id}`, { expectedVersion: c.version, purpose: 'Client visit (synthetic)', currency: 'USD', lines: [await line('100')] });
    expect([changed.statusCode, changed.json().error]).toEqual([422, 'RULE_VIOLATION']);
    expect((await claim(employee, id)).currency).toBe('INR');
  });

  it('BR-022: currency support needs Finance’s approval: only INR is approved (OQ-17), so any other currency stops at submission', async () => {
    expect((await h.db.query(`select code from currency`)).rows).toEqual([{ code: 'INR' }]);
    const usd = (await draft([await line('100')], 'USD')).json().claimId as string;
    const refused = await submit(usd);
    expect([refused.statusCode, refused.json().error]).toEqual([422, 'UNSUPPORTED_CURRENCY']);
    expect((await h.one<{ state: string }>(`select state from expense_claim where id = $1`, [usd])).state).toBe('DRAFT');
  });

  it('BR-022 (no conversion exists in wave 1, so no conversion basis is tested): a rate sent with a claim is stored nowhere, and a submitted revision keeps its currency and policy', async () => {
    const sent = await h.call(employee, 'POST', '/v1/expense/claims', { purpose: 'Client visit (synthetic)', currency: 'INR', exchangeRate: '83.25', lines: [{ ...(await line('100')), conversionRate: '83.25' }] });
    expect(sent.statusCode, sent.body).toBe(201);
    const id = sent.json().claimId as string;
    const stored = await h.one<{ t: string }>(
      `select (select to_jsonb(c)::text from expense_claim c where c.id = $1) || (select string_agg(to_jsonb(r)::text || to_jsonb(l)::text, ' ') from expense_revision r join expense_line l on l.company_id = r.company_id and l.revision_id = r.id where r.claim_id = $1) as t`,
      [id],
    );
    expect(stored.t).not.toContain('83.25');
    expect((await submit(id)).statusCode).toBe(200);
    const revision = await h.one<{ id: string; currency_code: string; policy_id: string | null; submitted_at: string | null }>(`select id, currency_code, policy_id, submitted_at from expense_revision where claim_id = $1`, [id]);
    expect(revision).toMatchObject({ currency_code: 'INR', policy_id: expect.any(String), submitted_at: expect.anything() });
    await expect(h.db.query(`update expense_revision set currency_code = 'USD' where id = $1`, [revision.id])).rejects.toThrow(/submitted expense revision is immutable/);
  });

  it('BR-022: a revision cannot be written in another currency than its claim, whatever the path', async () => {
    const id = (await draft([await line('100')])).json().claimId as string;
    const write = (currency: string) => h.db.query(`insert into expense_revision (company_id, claim_id, revision, currency_code, purpose) values ($1, $2, 2, $3, 'Synthetic')`, [A.id, id, currency]);
    await expect(write('USD')).rejects.toMatchObject({ code: '23503', constraint: 'expense_revision_claim_currency_fk' });
    await h.db.query('begin');
    try {
      // The claim's own currency is accepted, and the other one too once this key alone is gone: it is this key refusing.
      await h.db.query('savepoint same_currency');
      expect((await write('INR')).rowCount).toBe(1);
      await h.db.query('rollback to savepoint same_currency');
      await h.db.query(`alter table expense_revision drop constraint expense_revision_claim_currency_fk`);
      expect((await write('USD')).rowCount).toBe(1);
    } finally {
      await h.db.query('rollback');
    }
  });
});

// Upgrade: a stored revision in another currency never stops the migration and is never changed.
describe('0170 on a database that already holds claims', () => {
  let old: TestDatabase;
  let db: pg.Client;
  const company = randomUUID();
  const claimId = randomUUID();

  beforeAll(async () => {
    const empty = await startEmptyTestDatabase();
    if (!empty) throw new Error('An upgrade test needs TEST_PG_ADMIN_URL');
    old = empty;
    db = old.client;
    await migrate(db, { before: '0170' });
    await db.query(`insert into company (id, code, name, active) values ($1, 'UPGRADE0170', 'Upgrade check (synthetic)', true)`, [company]);
    await db.query(`set session_replication_role = replica`);
    await db.query(`insert into expense_claim (id, company_id, employee_id, transaction_id, purpose, currency_code, current_revision, state, payment_state) values ($1, $2, $3, $4, 'Stored before 0170 (synthetic)', 'INR', 1, 'DRAFT', 'NOT_APPLICABLE')`, [claimId, company, randomUUID(), randomUUID()]);
    await db.query(`insert into expense_revision (company_id, claim_id, revision, currency_code, purpose) values ($1, $2, 1, 'USD', 'Stored before 0170 (synthetic)')`, [company, claimId]);
    await db.query(`set session_replication_role = origin`);
    await migrate(db);
  }, 180_000);

  afterAll(async () => {
    await old?.stop();
  });

  it('applies, keeps the disagreeing stored row and leaves the key unvalidated, still holding new rows to it', async () => {
    expect((await db.query(`select 1 from schema_migration where filename like '0170%'`)).rowCount).toBe(1);
    expect((await db.query<{ currency_code: string }>(`select currency_code from expense_revision where claim_id = $1`, [claimId])).rows).toEqual([{ currency_code: 'USD' }]);
    expect((await db.query<{ convalidated: boolean }>(`select convalidated from pg_constraint where conname = 'expense_revision_claim_currency_fk'`)).rows).toEqual([{ convalidated: false }]);
    await expect(db.query(`insert into expense_revision (company_id, claim_id, revision, currency_code, purpose) values ($1, $2, 2, 'USD', 'Synthetic')`, [company, claimId])).rejects.toMatchObject({ code: '23503', constraint: 'expense_revision_claim_currency_fk' });
  });
});
