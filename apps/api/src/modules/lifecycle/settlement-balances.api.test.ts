// The remaining balances on a full-and-final settlement (FR-034 acceptance "settlement shows remaining balance"; FR-052;
// DF02; DF04; F1 "no automatic gratuity/encashment assumption"): read-only, under the settlement amount group only, the
// outstanding loan balances (only while the loans module is active) and each paid leave type's balance as at the
// approved last working date. Settlement amounts are untouched. Synthetic employees, amounts and evidence only.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { approvedExit, calendar, CONFIG, DOCUMENTS, evidenceDocument, head, key, months, ok, VERIFY_DOCUMENTS } from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';
import { HR_SETTLEMENT, person, today as businessDate } from './lifecycle.fixtures.js';

// The loans module (payroll-outputs) can be made inactive for one request, as registry.ts reports a module that is not active.
const flags = vi.hoisted(() => ({ loansInactive: false }));
vi.mock('../registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../registry.js')>();
  return { ...actual, isModuleActive: (k: string) => !(flags.loansInactive && k === 'payroll-outputs') && actual.isModuleActive(k) };
});

const L = (a: string) => `payroll_loan.${a}.loan` as PermissionKey;

describe.runIf(isModuleActive('lifecycle') && isModuleActive('payroll-outputs'))('remaining balances on a settlement (FR-034, FR-052)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let prep: TestActor;
  let payroll: TestActor;
  let employeeId: string;
  let loanId: string;
  let settlementId: string;
  let today: string;
  const lastWorkingDate = '2026-09-30';

  const detail = async (a: TestActor) => ok<Record<string, unknown>>(await h.call(a, 'GET', `/v1/settlements/${settlementId}`));
  const adjust = async (leaveType: string, kind: 'OPENING' | 'ADJUSTMENT', units: string, effectiveDate: string) =>
    ok(await h.call(hr, 'POST', '/v1/leave/adjustments', { employeeId, leaveType, kind, units, effectiveDate, reason: 'Synthetic balance', idempotencyKey: uniq('adj-key-') }), 201);

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    prep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    // An operational settlement reader (no amount group).
    payroll = await h.actor(A, 'PAYROLL_OPERATOR', { extra: ['settlement.read.operational'] });
    const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const maker = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [L('read'), L('request')] });
    const decider = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [L('read'), L('decide')] });
    const disburser = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [L('read'), L('disburse')] });
    const uploader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCUMENTS });
    const verifier = await h.actor(A, 'HR_ADMINISTRATOR', { extra: VERIFY_DOCUMENTS });
    today = await businessDate(h, A);

    // Leave: activated seed policies; an opening balance before the last working date and an adjustment after it.
    for (const p of (await h.call(hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number }[]) {
      await ok(await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version }));
    }
    employeeId = await person(h, A, hr, { name: 'Lia Leaver (synthetic)' });
    await adjust('ANNUAL', 'OPENING', '10', '2026-01-05');
    await adjust('CASUAL', 'OPENING', '2.5', '2026-01-05');
    await adjust('ANNUAL', 'ADJUSTMENT', '3', '2026-10-15');
    await adjust('UNPAID', 'OPENING', '1', '2026-01-05');

    // A disbursed loan through the loan journey (payroll configuration for its currency and recovery head), and an
    // undecided request, which owes nothing.
    await head(h, configA, configB, { code: 'LN_RECOVERY', headType: 'DEDUCTION', basis: 'INPUT', sequence: 2 });
    await calendar(h, configA, configB, months(2026));
    const loan = await ok<{ id: string }>(
      await h.call(maker, 'POST', `/v1/payroll-outputs/employees/${employeeId}/loans`, { loanKind: 'LOAN', currencyCode: 'INR', principal: '6000.00', purpose: 'Synthetic household purchase' }),
      201,
    );
    loanId = loan.id;
    const [y, m] = today.split('-').map(Number) as [number, number];
    const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    const v1 = await ok<{ version: number }>(await h.call(decider, 'GET', `/v1/payroll-outputs/loans/${loanId}`));
    await ok(
      await h.call(decider, 'POST', `/v1/payroll-outputs/loans/${loanId}/decision`, {
        decision: 'APPROVE',
        recoveryComponentCode: 'LN_RECOVERY',
        installments: [{ dueMonth: nextMonth, amount: '6000.00' }],
        expectedVersion: v1.version,
      }),
    );
    const doc = await evidenceDocument(h, uploader, verifier, employeeId);
    const v2 = await ok<{ version: number }>(await h.call(decider, 'GET', `/v1/payroll-outputs/loans/${loanId}`));
    await ok(
      await h.call(disburser, 'POST', `/v1/payroll-outputs/loans/${loanId}/disbursement`, {
        disbursementDate: today,
        evidenceKey: key('disb-'),
        evidenceReference: 'SYNTH-TRANSFER-1',
        evidenceDocumentIds: [doc],
        expectedVersion: v2.version,
      }),
    );
    await ok(await h.call(maker, 'POST', `/v1/payroll-outputs/employees/${employeeId}/loans`, { loanKind: 'ADVANCE', currencyCode: 'INR', principal: '500.00', purpose: 'Synthetic advance' }), 201);

    // The approved exit and its settlement draft.
    await approvedExit(h, A, employeeId, '2026-09-01', lastWorkingDate);
    const exitId = (await h.one<{ id: string }>(`select id from exit_case where employee_id = $1`, [employeeId])).id;
    settlementId = (await ok<{ id: string }>(await h.call(prep, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' }), 201)).id;
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('shows outstanding loans and paid leave as at the last working date under the amount group, changing no amount', async () => {
    const s = await detail(prep);
    expect(s).toMatchObject({ netAmount: '0.0000', lines: [], calculationStatus: 'NOT_CONFIGURED', lastWorkingDate });
    expect(s.balances).toEqual({
      asOf: lastWorkingDate,
      // Paid types only; the adjustment dated after the last working date does not count.
      leave: [
        { leaveType: 'ANNUAL', available: '10.0000', pending: '0.0000', taken: '0.0000' },
        { leaveType: 'CASUAL', available: '2.5000', pending: '0.0000', taken: '0.0000' },
        { leaveType: 'SICK', available: '0.0000', pending: '0.0000', taken: '0.0000' },
      ],
      // The disbursed loan only (the undecided advance owes nothing), with the loan module's balance.
      loans: [{ id: loanId, loanKind: 'LOAN', currencyCode: 'INR', principal: '6000.0000', recovered: '0.0000', awaitingRecognition: '0.0000', outstanding: '6000.0000', disbursementDate: today }],
      // FR-052 (I-81 item 5): no payroll run covers the last working date here.
      finalPeriodPayroll: [],
    });
    // The same ledger as the leave balance read, which counts every movement to date.
    const current = (await h.call(hr, 'GET', `/v1/employees/${employeeId}/leave-balances`)).json().items as { leaveType: string; available: string }[];
    expect(current.find((b) => b.leaveType === 'ANNUAL')?.available).toBe('13.0000');
    // Reading changes nothing: no settlement line was added and the net amount stays.
    expect(await h.one<{ n: number }>(`select count(*)::int as n from settlement_line where settlement_id = $1`, [settlementId])).toEqual({ n: 0 });
  });

  it('omits the balances without the settlement amount group', async () => {
    for (const reader of [hr, payroll]) {
      const s = await detail(reader);
      expect(s).toMatchObject({ id: settlementId, state: 'DRAFT' });
      expect(s).not.toHaveProperty('balances');
      expect(s).not.toHaveProperty('netAmount');
      expect(JSON.stringify(s)).not.toContain('6000');
    }
  });

  it('omits the loans while the loan module is not active', async () => {
    flags.loansInactive = true;
    try {
      const s = await detail(prep);
      const balances = s.balances as Record<string, unknown>;
      expect(balances).toMatchObject({ asOf: lastWorkingDate });
      expect((balances.leave as unknown[]).length).toBe(3);
      expect(balances).not.toHaveProperty('loans');
      expect(JSON.stringify(s)).not.toContain('6000');
    } finally {
      flags.loansInactive = false;
    }
  });
});
