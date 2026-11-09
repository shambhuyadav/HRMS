// OQ-17 currencies (I-80, A6; decided under owner delegation, 6 Nov 2026; migration 0208): the approved reference lists the ISO codes
// Finance would use, a payroll calendar's currency and minor unit must be the reference's, and a currency is usable on an expense claim
// only once one person asks for it and another enables it. Conversion needs a dated rate (I-87): until then an enabled foreign
// currency is refused at submission by name (EXCHANGE_RATE_NOT_CONFIGURED), one not enabled as before (UNSUPPORTED_CURRENCY).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { CONFIG } from '../payroll/payroll.fixtures.js';

let h: Harness;
let A: Company;
let hrA: TestActor;
let hrB: TestActor;
let owner: TestActor;
let manager: TestActor;
let finance: TestActor;

const taskOf = async (a: TestActor, claimId: string) => {
  const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [claimId])).transaction_id;
  return ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)!.taskId;
};
const decide = async (a: TestActor, claimId: string, body: object) =>
  h.call(a, 'POST', `/v1/expense/tasks/${await taskOf(a, claimId)}/decision`, { idempotencyKey: uniq('cur-key-'), ...body });

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const line = async (a: TestActor, amount: string) => {
  const res = await h.call(a, 'POST', '/v1/expense/receipts', { fileName: 'receipt.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic receipt ${uniq('r')}\n%%EOF\n`).toString('base64') });
  expect(res.statusCode, res.body).toBe(201);
  return { category: 'OTHER', expenseDate: daysAgo(3), merchant: 'Synthetic Merchant', grossAmount: amount, claimedAmount: amount, description: 'Synthetic', receipt: { receiptId: res.json().receiptId } };
};
/** A claim in INR with lines in other currencies (I-87); `lines` are [currency, amount] pairs, an INR pair being a home line. */
const foreignClaim = async (lines: [string, string][], expenseDate = daysAgo(3)) => {
  const body = [];
  for (const [currency, amount] of lines) {
    body.push({ ...(await line(owner, amount)), expenseDate, exceptionReason: 'Synthetic conference cost', ...(currency === 'INR' ? {} : { currency }) });
  }
  const created = await h.call(owner, 'POST', '/v1/expense/claims', { purpose: 'Conference abroad (synthetic)', currency: 'INR', lines: body });
  expect(created.statusCode, created.body).toBe(201);
  return created.json().claimId as string;
};
const submit = async (id: string) => h.call(owner, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await h.call(owner, 'GET', `/v1/expense/claims/${id}`)).json().version as number });
const submitUsd = async () => submit(await foreignClaim([['USD', '100']]));

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hrA = await h.actor(A, 'HR_ADMINISTRATOR');
  hrB = await h.actor(A, 'HR_ADMINISTRATOR');
  const person = async (managerId?: string) => {
    const e = (await h.call(hrA, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    if (managerId) expect((await h.call(hrA, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerId, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
    return e.id as string;
  };
  const managerEmp = await person();
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  finance = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['expense.read.operational', 'expense.finance_decide.operational', 'expense.high_value_decide.operational'] });
  // The finance step routes to a configured reviewer (as in payment-ledger.api.test.ts).
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true)`, [A.id, finance.user]);
  owner = await h.actor(A, 'EMPLOYEE', { employeeId: await person(managerEmp) });
  const policy = (await h.call(hrA, 'GET', '/v1/expense/policies')).json().items[0];
  expect((await h.call(hrA, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('approved and enabled currencies (OQ-17, I-80)', () => {
  it('lists the approved reference with ISO minor units; INR is the company currency', async () => {
    const list = (await h.call(hrA, 'GET', '/v1/expense/currencies')).json();
    expect(list.companyCurrency).toBe('INR');
    expect(list.reference).toEqual(expect.arrayContaining(['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'].map((code) => ({ code, minorUnit: 2 }))));
    expect(list.items).toEqual([]);
  });

  it('enables a currency for claims only by a second person; until a rate converts it, submission is refused by name', async () => {
    // A claim itself is in the policy currency (it is reimbursed in INR, DF07); spending abroad goes on lines in its currency.
    const whole = await h.call(owner, 'POST', '/v1/expense/claims', { purpose: 'Synthetic', currency: 'USD', lines: [await line(owner, '100')] });
    expect((await submit(whole.json().claimId)).json().error).toBe('UNSUPPORTED_CURRENCY');
    // Not enabled.
    const notEnabled = await submitUsd();
    expect([notEnabled.json().error, notEnabled.json().details?.lines]).toEqual(['UNSUPPORTED_CURRENCY', [1]]);
    expect((await h.call(hrA, 'POST', '/v1/expense/currencies', { currencyCode: 'INR', reason: 'Synthetic' })).json().error).toBe('COMPANY_CURRENCY');
    expect((await h.call(hrA, 'POST', '/v1/expense/currencies', { currencyCode: 'XYZ', reason: 'Synthetic' })).json().error).toBe('UNSUPPORTED_CURRENCY');
    const asked = await h.call(hrA, 'POST', '/v1/expense/currencies', { currencyCode: 'usd', reason: 'Overseas conference travel (synthetic)' });
    expect(asked.statusCode, asked.body).toBe(201);
    const draft = asked.json() as { id: string; state: string; currencyCode: string; version: number };
    expect(draft).toMatchObject({ currencyCode: 'USD', state: 'DRAFT' });
    expect((await h.call(hrB, 'POST', '/v1/expense/currencies', { currencyCode: 'USD', reason: 'Again' })).json().error).toBe('CURRENCY_ALREADY_REQUESTED');
    // Requested is not enabled.
    expect((await submitUsd()).json().error).toBe('UNSUPPORTED_CURRENCY');
    const self = await h.call(hrA, 'POST', `/v1/expense/currencies/${draft.id}/decision`, { action: 'ACTIVATE', expectedVersion: draft.version });
    expect([self.statusCode, self.json().error]).toEqual([403, 'SELF_APPROVAL']);
    await expect(h.db.query(`update company_currency set state = 'ACTIVE', activated_by = created_by, activated_at = now() where id = $1`, [draft.id])).rejects.toThrow(/company_currency_check/);
    const enabled = await h.call(hrB, 'POST', `/v1/expense/currencies/${draft.id}/decision`, { action: 'ACTIVATE', expectedVersion: draft.version });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json().state).toBe('ACTIVE');
    const refused = await submitUsd();
    expect([refused.statusCode, refused.json().error, refused.json().details?.currencies]).toEqual([422, 'EXCHANGE_RATE_NOT_CONFIGURED', ['USD']]);
    // Retired, it is refused as not enabled again.
    expect((await h.call(hrA, 'POST', `/v1/expense/currencies/${draft.id}/decision`, { action: 'RETIRE', expectedVersion: enabled.json().version })).json().state).toBe('RETIRED');
    expect((await submitUsd()).json().error).toBe('UNSUPPORTED_CURRENCY');
  });

  it('I-87: converts each foreign line once at submission at the rate in force on its expense date, half-up, and freezes it', async () => {
    // EUR enabled by a second person; a rate needs that first.
    const asked = (await h.call(hrA, 'POST', '/v1/expense/currencies', { currencyCode: 'EUR', reason: 'European client visits (synthetic)' })).json() as { id: string; version: number };
    const rateBody = { currencyCode: 'EUR', effectiveFrom: daysAgo(30), rate: '90.12345678', reason: 'Synthetic reference rate' };
    expect((await h.call(hrA, 'POST', '/v1/expense/exchange-rates', rateBody)).json().error).toBe('CURRENCY_NOT_ENABLED');
    expect((await h.call(hrB, 'POST', `/v1/expense/currencies/${asked.id}/decision`, { action: 'ACTIVATE', expectedVersion: asked.version })).statusCode).toBe(200);
    // A draft with a foreign line saves without a rate (FR-070), with no INR amount yet; submission names the missing rate.
    const early = await foreignClaim([['EUR', '100'], ['INR', '50']]);
    const draft = (await h.call(owner, 'GET', `/v1/expense/claims/${early}`)).json();
    expect(draft.lines.map((l: Record<string, unknown>) => [l.currency, l.sourceClaimedAmount, l.claimedAmount, l.exchangeRate])).toEqual([
      ['EUR', '100.0000', null, null],
      [null, null, '50.0000', null],
    ]);
    expect((await submit(early)).json()).toMatchObject({ error: 'EXCHANGE_RATE_NOT_CONFIGURED', details: { lines: [1], currencies: ['EUR'] } });
    // The rate: entered by one person, activated by another; invalid input is refused by name.
    expect((await h.call(hrA, 'POST', '/v1/expense/exchange-rates', { ...rateBody, rate: '0' })).json().error).toBe('INVALID_RATE');
    expect((await h.call(hrA, 'POST', '/v1/expense/exchange-rates', { ...rateBody, rate: '1.123456789' })).json().error).toBe('INVALID_RATE');
    const rate = (await h.call(hrA, 'POST', '/v1/expense/exchange-rates', rateBody)).json() as { id: string; version: number; state: string };
    expect(rate.state).toBe('DRAFT');
    expect((await h.call(hrA, 'POST', `/v1/expense/exchange-rates/${rate.id}/decision`, { action: 'ACTIVATE', expectedVersion: rate.version })).json().error).toBe('SELF_APPROVAL');
    await expect(h.db.query(`update expense_exchange_rate set state = 'ACTIVE', activated_by = created_by, activated_at = now() where id = $1`, [rate.id])).rejects.toThrow(/expense_exchange_rate_check/);
    expect((await h.call(hrB, 'POST', `/v1/expense/exchange-rates/${rate.id}/decision`, { action: 'ACTIVATE', expectedVersion: rate.version })).json().state).toBe('ACTIVE');
    // 100.00 EUR x 90.12345678 = 9012.345678 -> 9012.35 (half-up to 2 places); the claim total is the converted line plus the INR one.
    const ok = await submit(early);
    expect(ok.statusCode, ok.body).toBe(200);
    const submitted = (await h.call(owner, 'GET', `/v1/expense/claims/${early}`)).json();
    expect(submitted.lines.map((l: Record<string, unknown>) => [l.currency, l.sourceClaimedAmount, l.claimedAmount, l.grossAmount, l.exchangeRate])).toEqual([
      ['EUR', '100.0000', '9012.3500', '9012.3500', '90.12345678'],
      [null, null, '50.0000', '50.0000', null],
    ]);
    expect(submitted.revisions.map((r: { claimedTotal: string }) => r.claimedTotal)).toEqual(['9062.35']);
    // Policy limits judge the INR amount: the converted 9,012.35 is over the category limit, the 50.00 line is not.
    expect(submitted.lines.map((l: { exceptionFlags: string[] | null }) => (l.exceptionFlags ?? []).includes('OVER_LIMIT'))).toEqual([true, false]);
    // A later rate for the same date never revalues a submitted claim; the line keeps the rate it was converted at, for any writer.
    const newer = (await h.call(hrA, 'POST', '/v1/expense/exchange-rates', { ...rateBody, rate: '95' })).json() as { id: string; version: number };
    expect((await h.call(hrB, 'POST', `/v1/expense/exchange-rates/${newer.id}/decision`, { action: 'ACTIVATE', expectedVersion: newer.version })).json().state).toBe('ACTIVE');
    expect((await h.one<{ state: string }>(`select state from expense_exchange_rate where id = $1`, [rate.id])).state).toBe('SUPERSEDED');
    expect((await h.call(owner, 'GET', `/v1/expense/claims/${early}`)).json().lines[0].claimedAmount).toBe('9012.3500');
    await expect(h.db.query(`update expense_line set exchange_rate = 95 where exchange_rate_id = $1`, [rate.id])).rejects.toThrow(/immutable/);
    // The next claim converts at the rate now in force: 100.00 x 95 = 9500.00.
    const later = await foreignClaim([['EUR', '100']]);
    expect((await submit(later)).statusCode).toBe(200);
    expect((await h.call(owner, 'GET', `/v1/expense/claims/${later}`)).json().lines[0]).toMatchObject({ claimedAmount: '9500.0000', exchangeRate: '95.00000000' });
    // DF07: decided and reimbursed in INR, at the converted amount (a reversal pays back this obligation amount, unchanged).
    const byManager = await decide(manager, later, { decision: 'APPROVE' });
    expect(byManager.json().state, byManager.body).toBe('FINANCE_PENDING');
    const toDecide = (await h.call(finance, 'GET', `/v1/expense/claims/${later}`)).json().lines as { id: string; claimedAmount: string }[];
    const approved = await decide(finance, later, {
      decision: 'APPROVE',
      lines: toDecide.map((l) => ({ lineId: l.id, allowedAmount: l.claimedAmount, reason: 'Synthetic: conference fee confirmed with the organiser' })),
    });
    expect(approved.json().state, approved.body).toBe('APPROVED');
    expect(await h.one(`select approved_amount::text as amount, currency_code from expense_obligation where claim_id = $1`, [later])).toEqual({ amount: '9500.0000', currency_code: 'INR' });
    // A rate starts on its date: an expense before it has no rate in force.
    const before = await foreignClaim([['EUR', '10']], daysAgo(40));
    const none = await submit(before);
    expect([none.json().error, none.json().details?.lines]).toEqual(['EXCHANGE_RATE_NOT_CONFIGURED', [1]]);
    // A revision is never submitted with a line left unconverted, whatever writes it.
    await expect(
      h.db.query(`update expense_revision set submitted_at = now() where claim_id = $1 and submitted_at is null`, [before]),
    ).rejects.toThrow(/every line converted/);
  });

  it('a payroll calendar pays in an approved currency at the reference minor unit, for any writer', async () => {
    const config = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const create = (currencyCode: string, currencyMinorUnit: number) =>
      h.call(config, 'POST', '/v1/payroll/calendars', { code: uniq('CUR'), name: 'Synthetic calendar', currencyCode, currencyMinorUnit });
    expect((await create('XYZ', 2)).json().error).toBe('UNSUPPORTED_CURRENCY');
    const odd = await create('USD', 3);
    expect([odd.json().error, odd.json().details?.minorUnit]).toEqual(['CURRENCY_MINOR_UNIT_MISMATCH', 2]);
    expect((await create('USD', 2)).statusCode).toBe(201);
    await expect(
      h.db.query(`insert into payroll_calendar (company_id, code, name, currency_code, currency_minor_unit, state, created_by, updated_by) values ($1, $2, 'Synthetic', 'INR', 3, 'DRAFT', $3, $3)`, [
        A.id,
        uniq('CURDB'),
        config.user,
      ]),
    ).rejects.toThrow(/payroll_calendar_currency_fk/);
  });
});
