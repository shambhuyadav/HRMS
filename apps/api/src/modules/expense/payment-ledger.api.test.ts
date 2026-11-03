// The payment ledger held by the database itself (0088; B5 payment conservation; C4; C5; CI02; CI03; CI05; CI06; DF07;
// ZT14; ZT15): what is written past the service, and an instruction covering several claims, which only the database
// path can build today. Synthetic INR amounts; dates relative to today.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_VIOLATION, expectSqlError, FK_VIOLATION, UNIQUE_VIOLATION, uniq } from '../../../../../db/tests/fixtures.js';
import type { Queryable } from '../../db/queryable.js';
import { withTransaction } from '../../db/transaction.js';
import type { PermissionKey } from '../access/baseline.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let fin1: TestActor;
let fin2: TestActor;
let fin3: TestActor;
let manager: TestActor;
let employee: TestActor;
let colleague: TestActor;
let employeeId: string;
let colleagueId: string;

const FINANCE: PermissionKey[] = [
  'expense.read.operational',
  'expense.manager_decide.operational',
  'expense.finance_decide.operational',
  'expense.high_value_decide.operational',
  'payment.read.operational',
  'payment.prepare.operational',
  'payment.release.operational',
  'payment.reverse.operational',
];

const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const receipt = async (a: TestActor) => {
  const res = await h.call(a, 'POST', '/v1/expense/receipts', { fileName: 'receipt.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic ledger receipt ${uniq('l')}\n%%EOF\n`).toString('base64') });
  expect(res.statusCode).toBe(201);
  return { receiptId: res.json().receiptId as string };
};
const view = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
const taskOf = async (a: TestActor, claimId: string) => {
  const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [claimId])).transaction_id;
  return ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)!.taskId;
};
const decide = (a: TestActor, taskId: string, body: object) => h.call(a, 'POST', `/v1/expense/tasks/${taskId}/decision`, { idempotencyKey: uniq('ledger-key-'), ...body });

/** A submitted one-line claim past its manager step. */
async function atFinanceStep(claimant: TestActor, amount: string) {
  const created = await h.call(claimant, 'POST', '/v1/expense/claims', {
    purpose: 'Ledger checks (synthetic)',
    currency: 'INR',
    lines: [{ category: 'OFFICE_SUPPLIES', expenseDate: daysAgo(3), merchant: 'Synthetic Merchant', grossAmount: amount, claimedAmount: amount, description: 'Ledger check (synthetic)', receipt: await receipt(claimant) }],
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().claimId as string;
  expect((await h.call(claimant, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await view(claimant, id)).version })).statusCode).toBe(200);
  expect((await decide(manager, await taskOf(manager, id), { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');
  return id;
}

/** An approved one-line claim (entitlement approved by fin1); returns the claim and its obligation. */
async function approved(amount: string, claimant: TestActor = employee) {
  const id = await atFinanceStep(claimant, amount);
  const lines = (await view(fin1, id)).lines as { id: string; claimedAmount: string }[];
  const res = await decide(fin1, await taskOf(fin1, id), { decision: 'APPROVE', lines: lines.map((l) => ({ lineId: l.id, allowedAmount: l.claimedAmount })) });
  expect(res.json().state).toBe('APPROVED');
  return { id, obligation: (await h.one<{ id: string }>(`select id from expense_obligation where claim_id = $1`, [id])).id };
}

const prepare = async (claimId: string, amount: string) => {
  const res = await h.call(fin2, 'POST', '/v1/expense/payments', { claimId, amount, paymentDate: daysAgo(0), idempotencyKey: uniq('pay-key-') });
  expect(res.statusCode).toBe(201);
  return res.json().instructionId as string;
};
const act = (a: TestActor, pi: string, path: string, body?: object) => h.call(a, 'POST', `/v1/expense/payments/${pi}/${path}`, body);
const release = async (pi: string) => expect((await act(fin3, pi, 'release')).json().state).toBe('RELEASED');
const outcome = async (pi: string, kind: 'CONFIRMED' | 'FAILED') => {
  const key = uniq('bank-ref-');
  expect((await act(fin3, pi, 'outcome', { outcome: kind, evidenceKey: key })).json().state).toBe(kind);
  return key;
};
const ledger = (claimId: string) =>
  h.one<{ net_paid: string; pending: string; payment_state: string }>(
    `select l.net_paid::numeric(19,2)::text as net_paid, l.pending::numeric(19,2)::text as pending, c.payment_state
       from expense_obligation_ledger l join expense_claim c on c.company_id = l.company_id and c.id = l.claim_id where l.claim_id = $1`,
    [claimId],
  );

interface DirectInstruction {
  payee?: string;
  amount: string;
  preparer?: string;
  retryOf?: string;
  allocations: { obligation: string; amount: string; payee?: string }[];
}

/** Writes a batch, its instruction and allocations straight to the tables, as nothing but the database stands in the way. */
async function writeInstruction(tx: Queryable, d: DirectInstruction): Promise<string> {
  const preparer = d.preparer ?? fin2.user;
  const payee = d.payee ?? employeeId;
  const bt = (await tx.query<{ id: string }>(`insert into business_transaction (company_id, kind, state) values ($1, 'payment_batch', 'READY') returning id`, [A.id])).rows[0]!.id;
  const batch = (
    await tx.query<{ id: string }>(`insert into payment_batch (company_id, transaction_id, state, prepared_by, currency_code) values ($1, $2, 'READY', $3, 'INR') returning id`, [A.id, bt, preparer])
  ).rows[0]!.id;
  const pi = (
    await tx.query<{ id: string }>(
      `insert into payment_instruction (company_id, batch_id, employee_id, amount, currency_code, state, idempotency_key, retry_of_id, payment_date)
       values ($1, $2, $3, $4::numeric, 'INR', 'PREPARED', $5, $6, $7) returning id`,
      [A.id, batch, payee, d.amount, uniq('direct-key-'), d.retryOf ?? null, daysAgo(0)],
    )
  ).rows[0]!.id;
  for (const a of d.allocations) {
    await tx.query(`insert into payment_allocation (company_id, instruction_id, obligation_id, employee_id, currency_code, amount) values ($1, $2, $3, $4, 'INR', $5::numeric)`, [
      A.id,
      pi,
      a.obligation,
      a.payee ?? payee,
      a.amount,
    ]);
  }
  return pi;
}
const direct = (d: DirectInstruction) => withTransaction(h.pool, (tx) => writeInstruction(tx, d));
const eventOf = (pi: string, kind: string, amount: string, recordedBy: string, extra: { reverses?: string; allocation?: string; reason?: string; key?: string } = {}) =>
  h.db.query(
    `insert into payment_event (company_id, instruction_id, allocation_id, event_key, event_kind, amount, reverses_event_id, recorded_by, reason)
     values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9)`,
    [A.id, pi, extra.allocation ?? null, extra.key ?? uniq('direct-event-'), kind, amount, extra.reverses ?? null, recordedBy, extra.reason ?? null],
  );
const allocationOf = async (pi: string) => (await h.one<{ id: string }>(`select id from payment_allocation where instruction_id = $1 limit 1`, [pi])).id;
const confirmationOf = async (pi: string) => (await h.one<{ id: string }>(`select id from payment_event where instruction_id = $1 and event_kind = 'CONFIRMED'`, [pi])).id;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  fin1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  fin2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  fin3 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true), ($1, 'expense_claim', $3, 2, true)`, [
    A.id,
    fin1.user,
    fin2.user,
  ]);
  const person = async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return e.id as string;
  };
  const managerEmp = await person();
  employeeId = await person();
  colleagueId = await person();
  for (const e of [employeeId, colleagueId]) await h.call(hr, 'POST', `/v1/employees/${e}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  employee = await h.actor(A, 'EMPLOYEE', { employeeId });
  colleague = await h.actor(A, 'EMPLOYEE', { employeeId: colleagueId });
  const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('instruction states follow the ledger (C5, B5)', () => {
  const setState = (pi: string, state: string, releasedBy: string | null) => h.db.query(`update payment_instruction set state = $2, released_by = $3 where id = $1`, [pi, state, releasedBy]);

  it('no jump past a state, and no way back or out once released', async () => {
    const { id } = await approved('500');
    const pi = await prepare(id, '100');
    await expectSqlError(setState(pi, 'CONFIRMED', fin3.user), CHECK_VIOLATION);
    await expectSqlError(setState(pi, 'FAILED', fin3.user), CHECK_VIOLATION);
    await release(pi);
    await expectSqlError(setState(pi, 'PREPARED', null), CHECK_VIOLATION);
    await expectSqlError(setState(pi, 'CANCELLED', fin3.user), CHECK_VIOLATION);
    await expectSqlError(setState(pi, 'CANCELLED', null), CHECK_VIOLATION);
    await outcome(pi, 'CONFIRMED');
    await expectSqlError(setState(pi, 'FAILED', fin3.user), CHECK_VIOLATION);
    await expectSqlError(setState(pi, 'RELEASED', fin3.user), CHECK_VIOLATION);
  });

  it('a state alone makes nothing paid: CONFIRMED or FAILED need their outcome event', async () => {
    const { id } = await approved('500');
    const pi = await prepare(id, '100');
    await release(pi);
    await expectSqlError(setState(pi, 'CONFIRMED', fin3.user), CHECK_VIOLATION);
    await expectSqlError(setState(pi, 'FAILED', fin3.user), CHECK_VIOLATION);
    expect(await ledger(id)).toEqual({ net_paid: '0.00', pending: '100.00', payment_state: 'UNPAID' });
  });

  it('only a release by someone independent is accepted, on the row itself', async () => {
    const { id } = await approved('500');
    const pi = await prepare(id, '100');
    for (const actor of [fin2.user /* preparer */, fin1.user /* entitlement approver */, employee.user /* claimant */, manager.user /* manager step */]) {
      await expectSqlError(setState(pi, 'RELEASED', actor), CHECK_VIOLATION);
    }
    await expect(setState(pi, 'RELEASED', null)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await setState(pi, 'RELEASED', fin3.user)).rowCount).toBe(1);
  });

  it('a released instruction keeps its reservation; a cancelled prepared one frees it once', async () => {
    const { id } = await approved('500');
    const released = await prepare(id, '100');
    await release(released);
    expect((await ledger(id)).pending).toBe('100.00');
    const prepared = await prepare(id, '50');
    expect((await ledger(id)).pending).toBe('150.00');
    expect((await setState(prepared, 'CANCELLED', null)).rowCount).toBe(1);
    expect(await ledger(id)).toMatchObject({ pending: '100.00', net_paid: '0.00' });
  });

  it('batch, payee, amount, currency, key, date, retry link and release actor are fixed; the batch keeps its preparer', async () => {
    const { id } = await approved('500');
    const pi = await prepare(id, '100');
    const change = (set: string) => h.db.query(`update payment_instruction set ${set} where id = $1`, [pi]);
    await expectSqlError(change(`amount = 99`), CHECK_VIOLATION);
    await expectSqlError(change(`payment_date = payment_date - 1`), CHECK_VIOLATION);
    await expectSqlError(change(`idempotency_key = 'another-key-00'`), CHECK_VIOLATION);
    await expectSqlError(change(`employee_id = '${colleagueId}'`), CHECK_VIOLATION);
    await release(pi);
    await expectSqlError(change(`released_by = '${fin1.user}'`), CHECK_VIOLATION);
    await expectSqlError(
      h.db.query(`update payment_batch set prepared_by = $2 where id = (select batch_id from payment_instruction where id = $1)`, [pi, fin3.user]),
      CHECK_VIOLATION,
    );
    expect((await h.one<{ released_by: string }>(`select released_by from payment_instruction where id = $1`, [pi])).released_by).toBe(fin3.user);
  });

  it('a new instruction starts prepared and unreleased, in a ready batch', async () => {
    const { obligation } = await approved('500');
    const pi = await direct({ amount: '10', allocations: [{ obligation, amount: '10' }] });
    const { batch_id: batch } = await h.one<{ batch_id: string }>(`select batch_id from payment_instruction where id = $1`, [pi]);
    await expectSqlError(
      h.db.query(
        `insert into payment_instruction (company_id, batch_id, employee_id, amount, currency_code, state, idempotency_key, payment_date, released_by)
         values ($1, $2, $3, 10, 'INR', 'RELEASED', 'direct-state-key', current_date, $4)`,
        [A.id, batch, employeeId, fin3.user],
      ),
      CHECK_VIOLATION,
    );
    await release(pi);
    // The batch has moved on: nothing more goes into it.
    await expectSqlError(
      h.db.query(`insert into payment_instruction (company_id, batch_id, employee_id, amount, currency_code, state, idempotency_key, payment_date) values ($1, $2, $3, 10, 'INR', 'PREPARED', 'direct-late-key', current_date)`, [
        A.id,
        batch,
        employeeId,
      ]),
      CHECK_VIOLATION,
    );
  });
});

describe('one outcome per instruction, for its whole amount (B5, ZT14, ZT15)', () => {
  const settled = (pi: string, kind: string, amount: string) =>
    withTransaction(h.pool, async (tx) => {
      await tx.query(`insert into payment_event (company_id, instruction_id, event_key, event_kind, amount, recorded_by) values ($1, $2, $3, $4, $5::numeric, $6)`, [A.id, pi, uniq('direct-event-'), kind, amount, fin3.user]);
      await tx.query(`update payment_instruction set state = $2 where id = $1`, [pi, kind]);
      await tx.query(
        `update expense_claim c set payment_state = hrms_expense_claim_payment_state(c.company_id, c.id)
           from payment_allocation a join expense_obligation o on o.company_id = a.company_id and o.id = a.obligation_id
          where a.instruction_id = $1 and c.company_id = o.company_id and c.id = o.claim_id`,
        [pi],
      );
    });

  it('an outcome needs a released instruction and its whole amount; a second one is refused, so a confirmation counts once', async () => {
    const { id } = await approved('500');
    const pi = await prepare(id, '100');
    await expectSqlError(eventOf(pi, 'CONFIRMED', '100', fin3.user), CHECK_VIOLATION); // not released
    await release(pi);
    await expectSqlError(eventOf(pi, 'CONFIRMED', '40', fin3.user), CHECK_VIOLATION); // part of the amount
    await expectSqlError(eventOf(pi, 'CONFIRMED', '100', fin3.user), CHECK_VIOLATION); // the state did not follow, at commit
    await settled(pi, 'CONFIRMED', '100');
    await expectSqlError(eventOf(pi, 'CONFIRMED', '100', fin3.user), CHECK_VIOLATION);
    await expectSqlError(eventOf(pi, 'FAILED', '100', fin3.user), CHECK_VIOLATION);
  });

  it('the database refuses an outcome by the preparer, the approvers or the claimant', async () => {
    const { id } = await approved('500');
    const pi = await prepare(id, '100');
    await release(pi);
    for (const actor of [fin2.user, fin1.user, manager.user, employee.user]) await expectSqlError(eventOf(pi, 'CONFIRMED', '100', actor), CHECK_VIOLATION);
  });

  it('net paid moves only with the event; a failed instruction frees its reservation once', async () => {
    const { id } = await approved('500');
    const pi = await prepare(id, '100');
    await release(pi);
    await outcome(pi, 'FAILED');
    expect(await ledger(id)).toEqual({ net_paid: '0.00', pending: '0.00', payment_state: 'UNPAID' });
    const paid = await prepare(id, '500');
    await release(paid);
    await outcome(paid, 'CONFIRMED');
    expect(await ledger(id)).toEqual({ net_paid: '500.00', pending: '0.00', payment_state: 'PAID' });
  });
});

describe('reversals return one allocation (CI06, FR-077, DF07)', () => {
  it('a reversal names an allocation of its instruction and a confirmation of it, by someone independent, up to what was paid', async () => {
    const { id } = await approved('500');
    const pi = await prepare(id, '100');
    await release(pi);
    await outcome(pi, 'CONFIRMED');
    const allocation = await allocationOf(pi);
    const confirmation = await confirmationOf(pi);
    const reason = 'Bank return (synthetic)';
    await expectSqlError(eventOf(pi, 'REVERSED', '10', fin3.user, { reverses: confirmation, reason }), CHECK_VIOLATION); // no allocation named
    await expectSqlError(eventOf(pi, 'CONFIRMED', '100', fin3.user, { allocation }), CHECK_VIOLATION); // only a reversal names one
    await expectSqlError(eventOf(pi, 'REVERSED', '10', fin2.user, { reverses: confirmation, allocation, reason }), CHECK_VIOLATION); // the preparer
    await expectSqlError(eventOf(pi, 'REVERSED', '101', fin3.user, { reverses: confirmation, allocation, reason }), CHECK_VIOLATION); // above the payment
    await expectSqlError(eventOf(pi, 'REVERSED', '10', fin3.user, { reverses: allocation, allocation, reason }), CHECK_VIOLATION); // not a confirmation

    // An allocation or a confirmation of another instruction is refused.
    const { id: otherClaim } = await approved('500');
    const other = await prepare(otherClaim, '50');
    await release(other);
    await outcome(other, 'CONFIRMED');
    await expectSqlError(eventOf(pi, 'REVERSED', '10', fin3.user, { reverses: confirmation, allocation: await allocationOf(other), reason }), CHECK_VIOLATION);
    await expectSqlError(eventOf(pi, 'REVERSED', '10', fin3.user, { reverses: await confirmationOf(other), allocation, reason }), CHECK_VIOLATION);

    // Part by part, up to the amount paid, and no further.
    const reversal = async (amount: string) =>
      withTransaction(h.pool, async (tx) => {
        await tx.query(
          `insert into payment_event (company_id, instruction_id, allocation_id, event_key, event_kind, amount, reverses_event_id, recorded_by, reason) values ($1, $2, $3, $4, 'REVERSED', $5::numeric, $6, $7, $8)`,
          [A.id, pi, allocation, uniq('direct-event-'), amount, confirmation, fin3.user, reason],
        );
        await tx.query(`update expense_claim set payment_state = hrms_expense_claim_payment_state(company_id, id) where id = $1`, [id]);
      });
    await reversal('60');
    await reversal('40');
    await expectSqlError(reversal('0.01'), CHECK_VIOLATION);
    expect(await ledger(id)).toEqual({ net_paid: '0.00', pending: '0.00', payment_state: 'UNPAID' });
  });
});

describe('one instruction may cover several obligations of one employee (CI05)', () => {
  it('its amount equals its allocations at commit; every allocation is the instruction employee’s and currency’s', async () => {
    const a = await approved('300');
    const b = await approved('200');
    const theirs = await approved('100', colleague);
    await expectSqlError(direct({ amount: '250', allocations: [{ obligation: a.obligation, amount: '100' }, { obligation: b.obligation, amount: '100' }] }), CHECK_VIOLATION);
    await expectSqlError(direct({ amount: '200', allocations: [] }), CHECK_VIOLATION);
    await expectSqlError(direct({ amount: '150', allocations: [{ obligation: a.obligation, amount: '100' }, { obligation: theirs.obligation, amount: '50' }] }), FK_VIOLATION);
    await expectSqlError(direct({ amount: '50', allocations: [{ obligation: theirs.obligation, amount: '50', payee: colleagueId }, { obligation: a.obligation, amount: '0.01', payee: colleagueId }] }), FK_VIOLATION);
    expect((await ledger(a.id)).pending).toBe('0.00');
  });

  it('neither an entitlement approver nor the claimant can prepare it; conservation holds per obligation', async () => {
    const a = await approved('300');
    await expectSqlError(direct({ preparer: fin1.user, amount: '10', allocations: [{ obligation: a.obligation, amount: '10' }] }), CHECK_VIOLATION);
    await expectSqlError(direct({ preparer: employee.user, amount: '10', allocations: [{ obligation: a.obligation, amount: '10' }] }), CHECK_VIOLATION);
    await expectSqlError(direct({ amount: '301', allocations: [{ obligation: a.obligation, amount: '301' }] }), CHECK_VIOLATION);
  });

  it('confirmed in one outcome, a reversal names its claim and only that claim’s ledger moves', async () => {
    const a = await approved('300');
    const b = await approved('200');
    const pi = await direct({ amount: '500', allocations: [{ obligation: a.obligation, amount: '300' }, { obligation: b.obligation, amount: '200' }] });
    expect((await ledger(a.id)).pending).toBe('300.00');
    expect((await ledger(b.id)).pending).toBe('200.00');
    await release(pi);
    await outcome(pi, 'CONFIRMED');
    expect(await ledger(a.id)).toEqual({ net_paid: '300.00', pending: '0.00', payment_state: 'PAID' });
    expect(await ledger(b.id)).toEqual({ net_paid: '200.00', pending: '0.00', payment_state: 'PAID' });

    const reason = 'Bank return (synthetic)';
    const reversal = (extra: object, amount = '50', key = uniq('reversal-key-')) => act(fin3, pi, 'reversal', { amount, evidenceKey: key, reason, ...extra });
    expect((await reversal({})).json().error).toBe('CLAIM_REQUIRED');
    const { id: unrelated } = await approved('10');
    expect((await reversal({ claimId: unrelated })).json().error).toBe('CLAIM_NOT_COVERED');
    expect((await reversal({ claimId: b.id }, '200.01')).statusCode).toBe(422); // above this claim's share, though within the instruction

    const key = uniq('reversal-key-');
    expect((await reversal({ claimId: b.id }, '50', key)).json().replayed).toBe(false);
    expect(await ledger(a.id)).toEqual({ net_paid: '300.00', pending: '0.00', payment_state: 'PAID' });
    expect(await ledger(b.id)).toEqual({ net_paid: '150.00', pending: '0.00', payment_state: 'PART_PAID' });
    expect((await reversal({ claimId: b.id }, '50', key)).json().replayed).toBe(true);
    expect((await reversal({ claimId: a.id }, '50', key)).json().error).toBe('EVIDENCE_KEY_REUSED');
    expect((await ledger(b.id)).net_paid).toBe('150.00');

    // Each claim's payment list shows its own share and its own reversals.
    expect((await h.call(fin3, 'GET', `/v1/expense/claims/${a.id}/payments`)).json().items).toMatchObject([{ id: pi, amount: '300.00', state: 'CONFIRMED', reversed: '0.00' }]);
    expect((await h.call(fin3, 'GET', `/v1/expense/claims/${b.id}/payments`)).json().items).toMatchObject([{ id: pi, amount: '200.00', state: 'CONFIRMED', reversed: '50.00' }]);
  });
});

describe('a retry replaces a settled instruction for the same liabilities (CI06, BR-024, BR-025, ZT14)', () => {
  it('only a failed or cancelled instruction, for the same employee and obligations, once', async () => {
    const a = await approved('300');
    const b = await approved('200');
    const live = await prepare(a.id, '100');
    await expectSqlError(direct({ retryOf: live, amount: '100', allocations: [{ obligation: a.obligation, amount: '100' }] }), CHECK_VIOLATION); // prepared: still reserved
    await release(live);
    await expectSqlError(direct({ retryOf: live, amount: '100', allocations: [{ obligation: a.obligation, amount: '100' }] }), CHECK_VIOLATION); // unknown outcome: stays pending
    await outcome(live, 'FAILED');

    await expectSqlError(direct({ retryOf: live, amount: '100', allocations: [{ obligation: b.obligation, amount: '100' }] }), CHECK_VIOLATION); // another liability
    const theirs = await approved('100', colleague);
    await expectSqlError(direct({ retryOf: live, payee: colleagueId, amount: '100', allocations: [{ obligation: theirs.obligation, amount: '100' }] }), FK_VIOLATION); // another employee

    const retry = await direct({ retryOf: live, amount: '100', allocations: [{ obligation: a.obligation, amount: '100' }] });
    expect((await ledger(a.id)).pending).toBe('100.00');
    await expectSqlError(direct({ retryOf: live, amount: '50', allocations: [{ obligation: a.obligation, amount: '50' }] }), UNIQUE_VIOLATION); // only once
    await expectSqlError(h.db.query(`update payment_instruction set retry_of_id = $2 where id = $1`, [live, retry]), CHECK_VIOLATION); // no cycle: the link never changes
    await expectSqlError(h.db.query(`update payment_instruction set retry_of_id = null where id = $1`, [retry]), CHECK_VIOLATION);
    await expectSqlError(
      withTransaction(h.pool, async (tx) => {
        const fresh = await writeInstruction(tx, { amount: '1', allocations: [{ obligation: a.obligation, amount: '1' }] });
        await tx.query(`update payment_instruction set retry_of_id = id where id = $1`, [fresh]);
      }),
      CHECK_VIOLATION,
    );
  });
});

describe('claims and obligations agree with the ledger (CI02, CI03, C5)', () => {
  it('a claim’s current revision is one of its own (CI02)', async () => {
    const { id } = await approved('300');
    await expectSqlError(h.db.query(`update expense_claim set current_revision = 99 where id = $1`, [id]), FK_VIOLATION);
    // A number another claim's revision holds is no better: no second revision exists for this claim.
    const draft = (
      await h.call(employee, 'POST', '/v1/expense/claims', {
        purpose: 'Ledger checks (synthetic)',
        currency: 'INR',
        lines: [{ category: 'OTHER', expenseDate: daysAgo(3), merchant: 'Synthetic Merchant', grossAmount: '5', claimedAmount: '5', description: 'Ledger check (synthetic)' }],
      })
    ).json().claimId as string;
    await expectSqlError(h.db.query(`update expense_claim set current_revision = 2 where id = $1`, [draft]), FK_VIOLATION);
  });

  it('an obligation keeps belonging to the approved current revision (CI03)', async () => {
    const { id } = await approved('300');
    await expectSqlError(
      withTransaction(h.pool, async (tx) => {
        await tx.query(`insert into expense_revision (company_id, claim_id, revision, currency_code) values ($1, $2, 2, 'INR')`, [A.id, id]);
        await tx.query(`update expense_claim set current_revision = 2 where id = $1`, [id]);
      }),
      CHECK_VIOLATION,
    );
  });

  it('an obligation exists only for an APPROVED claim (CI03)', async () => {
    // Above the threshold, the financial step leaves line decisions on a claim that is not approved yet.
    const created = await h.call(employee, 'POST', '/v1/expense/claims', {
      purpose: 'Ledger checks (synthetic)',
      currency: 'INR',
      lines: await Promise.all(
        Array.from({ length: 11 }, async () => ({ category: 'TRAVEL', expenseDate: daysAgo(3), merchant: 'Synthetic Merchant', grossAmount: '5000', claimedAmount: '5000', description: 'Ledger check (synthetic)', receipt: await receipt(employee) })),
      ),
    });
    const id = created.json().claimId as string;
    await h.call(employee, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await view(employee, id)).version });
    await decide(manager, await taskOf(manager, id), { decision: 'APPROVE' });
    const lines = (await view(fin1, id)).lines as { id: string; claimedAmount: string }[];
    expect((await decide(fin1, await taskOf(fin1, id), { decision: 'APPROVE', lines: lines.map((l) => ({ lineId: l.id, allowedAmount: l.claimedAmount })) })).json().state).toBe('HIGH_VALUE_PENDING');
    await expectSqlError(
      h.db.query(
        `insert into expense_obligation (company_id, claim_id, revision_id, employee_id, approved_amount, currency_code, approved_by)
         select c.company_id, c.id, r.id, c.employee_id, 55000, c.currency_code, $2 from expense_claim c join expense_revision r on r.company_id = c.company_id and r.claim_id = c.id where c.id = $1`,
        [id, fin1.user],
      ),
      CHECK_VIOLATION,
    );
  });

  it('a payment state is what its ledger derives, whoever writes it (C5)', async () => {
    const { id } = await approved('300');
    const state = (value: string) => h.db.query(`update expense_claim set payment_state = $2 where id = $1`, [id, value]);
    await expectSqlError(state('PAID'), CHECK_VIOLATION);
    await expectSqlError(state('PART_PAID'), CHECK_VIOLATION);
    await expectSqlError(state('NO_PAYABLE_AMOUNT'), CHECK_VIOLATION);
    const pi = await prepare(id, '300');
    await expectSqlError(state('PART_PAID'), CHECK_VIOLATION); // a reservation is not a payment
    await release(pi);
    await outcome(pi, 'CONFIRMED');
    await expectSqlError(state('UNPAID'), CHECK_VIOLATION);
    expect((await ledger(id)).payment_state).toBe('PAID');
  });
});
