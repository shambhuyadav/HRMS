// F2 Treasury Operator "Assigned payment preparation tasks" (I-84 item 5's definition; I-83 items 3 and 4; decided under owner
// delegation, 6 Nov 2026, docs/03 I-89 item 2; 0241): the scope's approved claims awaiting preparation (an outstanding amount and
// no live reservation) plus draft payments not yet marked ready. The figure equals its two source lists, follows each payment
// step, counts a draft whoever prepared it (the preparer works in an eligible Admin assignment, so the same person's drafts are
// never "their" tasks here: DF17 "no merging"), and existing companies' widget rows are moved by 0241. Synthetic data only.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { releaseNaming } from '../expense/payment.fixtures.js';
import { businessDate, person } from '../training/training.fixtures.js';
import type { SourceList } from './sources.js';

const DECIDE: PermissionKey[] = ['expense.read.operational', 'expense.manager_decide.operational', 'expense.finance_decide.operational', 'expense.high_value_decide.operational'];
const PREPARE: PermissionKey[] = ['expense.read.operational', 'payment.read.operational', 'payment.prepare.operational'];
const SETTLE: PermissionKey[] = ['expense.read.operational', 'payment.read.operational', 'payment.release.operational', 'payment.confirm_outcome.operational'];
const TITLE = 'Claims awaiting payment preparation and draft payments not yet ready';
const AMOUNT = '843.19';

type Widget = { code: string; title: string; status: string; value?: number; source?: { combine: string; lists: SourceList[] } };

describe('Treasury Operator payment preparation figure (I-89 item 2)', () => {
  let h: Harness;
  let c: Company;
  let today: string;
  let approver: TestActor;
  let preparer: TestActor;
  let settler: TestActor;
  let manager: TestActor;
  let eng: TestActor;
  let fin: TestActor;

  const myTasks = async (a: TestActor) => {
    const res = await h.call(a, 'GET', '/v1/dashboard');
    expect(res.statusCode, res.body).toBe(200);
    return { body: res.body, widget: (res.json().widgets as Widget[]).find((w) => w.code === 'MY_TASKS')! };
  };
  const listCount = async (a: TestActor, list: SourceList) => {
    const res = await h.call(a, 'GET', list.api);
    expect(res.statusCode, `${list.api}: ${res.body}`).toBe(200);
    const body = res.json() as { items: unknown[]; total?: number };
    return body.total ?? body.items.length;
  };
  /** The figure, checked against the sum of its own source lists under the same actor. */
  const figure = async (a: TestActor) => {
    const { widget } = await myTasks(a);
    expect(widget).toMatchObject({ status: 'OK', title: TITLE });
    let sum = 0;
    for (const list of widget.source!.lists) sum += await listCount(a, list);
    expect(widget.value, 'against its source lists').toBe(sum);
    return widget.value!;
  };
  const view = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
  const taskOf = async (a: TestActor, claimId: string) => {
    const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [claimId])).transaction_id;
    return ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)!.taskId;
  };
  const decide = (a: TestActor, taskId: string, body: object) => h.call(a, 'POST', `/v1/expense/tasks/${taskId}/decision`, { idempotencyKey: uniq('prep-key-'), ...body });
  /** A claim of `who` through the real route to FINAL_APPROVED. */
  const approved = async (who: TestActor, amount = AMOUNT) => {
    const receipt = await h.call(who, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic preparation receipt ${uniq('p')}\n%%EOF\n`).toString('base64') });
    expect(receipt.statusCode, receipt.body).toBe(201);
    const created = await h.call(who, 'POST', '/v1/expense/claims', {
      purpose: 'Preparation marker purpose (synthetic)',
      currency: 'INR',
      lines: [{ category: 'OFFICE_SUPPLIES', expenseDate: today, merchant: 'Preparation Marker Merchant', grossAmount: amount, claimedAmount: amount, description: 'Synthetic', receipt: { receiptId: receipt.json().receiptId } }],
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().claimId as string;
    expect((await h.call(who, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await view(who, id)).version })).statusCode).toBe(200);
    expect((await decide(manager, await taskOf(manager, id), { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');
    const lines = (await view(approver, id)).lines as { id: string; claimedAmount: string }[];
    const res = await decide(approver, await taskOf(approver, id), { decision: 'APPROVE', lines: lines.map((l) => ({ lineId: l.id, allowedAmount: l.claimedAmount })) });
    expect(res.json().state, res.body).toBe('APPROVED');
    return id;
  };
  const prepare = async (claimId: string, amount = AMOUNT, by = preparer) => {
    const res = await h.call(by, 'POST', '/v1/expense/payments', { claimId, amount, paymentDate: today, idempotencyKey: uniq('prep-pay-') });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().instructionId as string;
  };
  const ready = async (instructionId: string) => expect((await h.call(preparer, 'POST', `/v1/expense/payments/${instructionId}/ready`)).statusCode).toBe(200);

  beforeAll(async () => {
    h = await startHarness();
    c = await h.makeCompany();
    today = await businessDate(h, c);
    const hr = await h.actor(c, 'HR_ADMINISTRATOR');
    approver = await h.actor(c, 'HR_ADMINISTRATOR', { extra: DECIDE });
    preparer = await h.actor(c, 'HR_ADMINISTRATOR', { extra: PREPARE });
    settler = await h.actor(c, 'HR_ADMINISTRATOR', { extra: SETTLE });
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true)`, [c.id, approver.user]);
    const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
    expect((await h.call(await h.actor(c, 'HR_ADMINISTRATOR'), 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
    const boss = await person(h, c, hr);
    manager = await h.actor(c, 'REPORTING_MANAGER', { employeeId: boss });
    eng = await h.actor(c, 'EMPLOYEE', { employeeId: await person(h, c, hr, { departmentId: c.dept, managerId: boss }) });
    fin = await h.actor(c, 'EMPLOYEE', { employeeId: await person(h, c, hr, { departmentId: c.financeDept, managerId: boss }) });
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('follows each payment step: an approved claim counts until a payment reserves it, its draft counts until marked ready, a failure brings the claim back', async () => {
    const operator = await h.actor(c, 'TREASURY_OPERATOR');
    const start = await figure(operator);
    const claim = await approved(eng, '1000.00');
    expect(await figure(operator)).toBe(start + 1);
    // A part payment prepared: the claim holds a live reservation (no longer awaiting preparation); the draft counts instead.
    const part = await prepare(claim, '400.00');
    expect(await figure(operator)).toBe(start + 1);
    const lists = (await myTasks(operator)).widget.source!.lists;
    expect([await listCount(operator, lists[0]!), await listCount(operator, lists[1]!)]).toEqual([start, 1]);
    // Marked ready: waiting for an independent release, not for preparation.
    await ready(part);
    expect(await figure(operator)).toBe(start);
    // Released, then a definitive failure: the reservation ends and the claim awaits preparation again.
    expect((await releaseNaming(h, settler, part)).json().state).toBe('RELEASED');
    expect(await figure(operator)).toBe(start);
    expect((await h.call(settler, 'POST', `/v1/expense/payments/${part}/outcome`, { outcome: 'FAILED', evidenceKey: uniq('bank-ref-') })).statusCode).toBe(200);
    expect(await figure(operator)).toBe(start + 1);
    // Paid in full: nothing outstanding.
    const full = await prepare(claim, '1000.00');
    await ready(full);
    expect((await releaseNaming(h, settler, full)).json().state).toBe('RELEASED');
    expect((await h.call(settler, 'POST', `/v1/expense/payments/${full}/outcome`, { outcome: 'CONFIRMED', evidenceKey: uniq('bank-ref-') })).statusCode).toBe(200);
    expect(await figure(operator)).toBe(start);
  });

  it("counts a draft whoever prepared it, so the preparer's own Treasury Operator context shows the same figure as anyone's (DF17 no merging)", async () => {
    const other = await h.actor(c, 'TREASURY_OPERATOR');
    const samePerson = await h.actor(c, 'TREASURY_OPERATOR', { user: preparer.user });
    const before = await figure(other);
    expect(await figure(samePerson)).toBe(before);
    await prepare(await approved(eng));
    expect(await figure(other)).toBe(before + 1);
    expect(await figure(samePerson)).toBe(before + 1);
    // The preparing Admin assignment's own dashboard has no such figure: its tasks widget is its approval tasks.
    const admin = (await myTasks(preparer)).widget;
    expect(admin.title).not.toBe(TITLE);
  });

  it("a department filter counts its own people's claims and drafts only, and one outside it does not move the figure", async () => {
    const financeOperator = await h.actor(c, 'TREASURY_OPERATOR', { departmentFilter: c.financeDept });
    const before = await figure(financeOperator);
    await approved(eng);
    await prepare(await approved(eng));
    expect(await figure(financeOperator)).toBe(before);
    await approved(fin);
    expect(await figure(financeOperator)).toBe(before + 1);
    await prepare(await approved(fin));
    expect(await figure(financeOperator)).toBe(before + 2);
  });

  it('shows a count only: no amount, purpose or merchant reaches the dashboard', async () => {
    const { body, widget } = await myTasks(await h.actor(c, 'TREASURY_OPERATOR'));
    expect(String(widget.value)).toMatch(/^\d+$/);
    for (const marker of [AMOUNT, 'Preparation marker', 'Preparation Marker Merchant']) expect(body, marker).not.toContain(marker);
  });

  it('0241 moves an existing company’s widget row to the figure and its read duty; a row pointed elsewhere is left alone', async () => {
    const rowOf = () =>
      h.one<{ metric_code: string; title: string; permission: string }>(
        `select w.metric_code, w.title, p.resource || '.' || p.action || '.' || p.field_group as permission
           from role_dashboard_widget w join role_dashboard_definition d on d.company_id = w.company_id and d.id = w.dashboard_id
           join role r on r.company_id = d.company_id and r.id = d.role_id join permission p on p.id = w.permission_id
          where w.company_id = $1 and r.code = 'TREASURY_OPERATOR' and w.widget_code = 'MY_TASKS'`,
        [c.id],
      );
    // A new company is provisioned with it already.
    expect(await rowOf()).toEqual({ metric_code: 'PAYMENT_PREPARATION_TASKS', title: TITLE, permission: 'payment.read.operational' });
    const setRow = (metric: string) =>
      h.db.query(
        `update role_dashboard_widget w set metric_code = $2, title = 'Assigned payment preparation tasks',
                permission_id = (select id from permission where resource = 'dashboard' and action = 'read' and field_group = 'operational')
           from role_dashboard_definition d join role r on r.company_id = d.company_id and r.id = d.role_id
          where d.company_id = w.company_id and d.id = w.dashboard_id and d.company_id = $1 and r.code = 'TREASURY_OPERATOR' and w.widget_code = 'MY_TASKS'`,
        [c.id, metric],
      );
    const migration = readFileSync(new URL('../../../../../db/migrations/0241_treasury_preparation_widget.sql', import.meta.url), 'utf8');
    await setRow('NOT_YET_AVAILABLE');
    expect((await myTasks(await h.actor(c, 'TREASURY_OPERATOR'))).widget).toMatchObject({ status: 'NOT_AVAILABLE' });
    await h.db.query(migration);
    expect(await rowOf()).toEqual({ metric_code: 'PAYMENT_PREPARATION_TASKS', title: TITLE, permission: 'payment.read.operational' });
    expect((await myTasks(await h.actor(c, 'TREASURY_OPERATOR'))).widget).toMatchObject({ status: 'OK' });
    // A company that pointed the widget elsewhere keeps its choice.
    await setRow('MY_OPEN_TASKS');
    await h.db.query(migration);
    expect(await rowOf()).toMatchObject({ metric_code: 'MY_OPEN_TASKS', permission: 'dashboard.read.operational' });
    await setRow('NOT_YET_AVAILABLE');
    await h.db.query(migration);
  });
});
