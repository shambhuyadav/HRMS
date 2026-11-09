// FR-052 full-and-final settlement calculation, worked examples for the owner's approval (decided under owner delegation, 6 Nov 2026;
// docs/03 I-88; migration 0235). Every value is worked by hand from the rule as written (settlement-formulas.ts) on synthetic salaries,
// leave, loans and arrears; FR-052 stays Blocked until the owner approves these examples.
//
//  A  mid-month leaver (joined 5 Jan 2026, last day 15 Oct 2026, one unpaid day): earnings due to the last working date, leave
//     encashment at the cap, a notice shortfall, a loan and a pending arrear; not eligible for gratuity. Reconciles to the October
//     payroll of the same components, and the arrear is paid once (taken by whichever comes first).
//  B  gratuity-eligible (joined 3 Jun 2019, last day 30 Oct 2026): blocked with RULE_PACK_NOT_CONFIGURED while the pack is inactive;
//     after two people validate and activate it, 15 / 26 x 36,000 x 7 = 1,45,384.62.
//  C  joiner and leaver in one month (5 to 16 Oct 2026): 12 days of 31,000, a 22-day notice shortfall, waived by an approver.
//  D  the final month already approved in monthly payroll: nothing of it is paid again.
//  E  a statutory RULE_PACK head applies: approval refused (BRD line 5120).
//  F  a company without a settlement policy: every item that needs one is blocked, never guessed.
//  G  a late-timesheet adjustment (FR-100) approved before the exit: 30,000 / 30 = 1,000.00 restored, taken by the settlement, applied
//     once by its payment, never by payroll.
//  H  TDS in the final settlement (I-90): 2,00,000 a month, April processed (TDS 24,375); last day 31 May with a 20,00,000 bonus: the
//     year's 24,00,000 is taxed 2,92,500, less 24,375: 2,68,125. Form 16 Part B then shows 2,92,500 deducted, exactly the tax.
// Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import {
  APPROVE,
  approvedExit,
  approvedLeave,
  CANCEL,
  calculate,
  calendar,
  CONFIG,
  createRun,
  DOCUMENTS,
  evidenceDocument,
  getRun,
  grants,
  head,
  key,
  laterArrangement,
  months,
  ok,
  person,
  PREPARE,
  PROCESS,
  processRun,
  record,
  REVIEW,
  reviewers,
  SALARY,
  salary,
  submitAndApprove,
  today as businessDate,
  valuationPolicy,
  VERIFY_DOCUMENTS,
} from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';
import { allocate, approvedWeek, timesheetWorld } from '../timesheet/timesheet.fixtures.js';
import { HR_SETTLEMENT, publishedTemplate } from './lifecycle.fixtures.js';

const L = (a: string) => `payroll_loan.${a}.loan` as PermissionKey;
const ARR_MAKER: PermissionKey[] = ['payroll_arrears.read.amount', 'payroll_arrears.propose.amount'];
const ARR_DECIDER: PermissionKey[] = ['payroll_arrears.read.amount', 'payroll_arrears.decide.amount'];
const WAIVE: PermissionKey = 'settlement.waive_notice.amount';

interface Item {
  position: number;
  kind: string;
  status: string;
  blocking: boolean;
  componentCode: string | null;
  leaveTypeCode: string | null;
  amount: string | null;
  basis: Record<string, unknown>;
  arrearsCaseId: string | null;
}
interface Detail {
  id: string;
  state: string;
  version: number;
  revision: number;
  calculationStatus: string;
  netAmount?: string;
  lines?: { componentCode: string; amount: string; lineKind: string; source: string; reason: string | null }[];
  calculation?: { id: string; sequence: number; blockingCount: number; items: Item[]; inputs: Record<string, unknown> } | null;
  noticeWaiver?: { reason: string } | null;
}

const shape = (items: Item[]) => items.map((i) => [i.kind, i.status, i.componentCode, i.leaveTypeCode, i.amount]);
const byCode = <T extends { componentCode: string }>(xs: T[]) => [...xs].sort((a, b) => (a.componentCode < b.componentCode ? -1 : 1));

describe.runIf(isModuleActive('lifecycle') && isModuleActive('payroll-adjustments') && isModuleActive('payroll-outputs'))('FR-052 settlement calculation: worked examples (I-88)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let canceller: TestActor;
  let arrMaker: TestActor;
  let arrDecider: TestActor;
  let lMaker: TestActor;
  let lDecider: TestActor;
  let lDisburser: TestActor;
  let uploader: TestActor;
  let verifier: TestActor;
  let prep: TestActor;
  let rev: TestActor;
  let appr: TestActor;
  let rel: TestActor;
  let payer: TestActor;
  let waiver: TestActor;
  let hrPlain: TestActor;
  let payrollOp: TestActor;
  let packV: TestActor;
  let packA: TestActor;
  let periods: Record<string, string>;
  let today: string;

  const get = async (a: TestActor, id: string) => ok<Detail>(await h.call(a, 'GET', `/v1/settlements/${id}`));
  const calc = async (id: string) => h.call(prep, 'POST', `/v1/settlements/${id}/calculate`, { expectedVersion: (await get(prep, id)).version });
  const calculated = async (id: string) => ok<Detail>(await calc(id));
  const tasks = async (a: TestActor) => (await h.call(a, 'GET', '/v1/settlements/tasks/mine')).json().items as { taskId: string; settlement: { id: string } | null }[];
  const taskFor = async (a: TestActor, id: string) => (await tasks(a)).find((t) => t.settlement?.id === id)!.taskId;
  const submit = async (id: string) => ok<Detail>(await h.call(prep, 'POST', `/v1/settlements/${id}/submit`, { expectedVersion: (await get(prep, id)).version }));
  const review = async (id: string) => ok<{ state: string }>(await h.call(rev, 'POST', `/v1/settlements/tasks/${await taskFor(rev, id)}/review`, { decision: 'APPROVE', idempotencyKey: key() }));
  const approve = async (id: string) => h.call(appr, 'POST', `/v1/settlements/tasks/${await taskFor(appr, id)}/approve`, { decision: 'APPROVE', idempotencyKey: key() });
  const newSettlement = async (exitId: string) => ok<Detail>(await h.call(prep, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' }), 201);
  const exitOf = async (employeeId: string) => (await h.one<{ id: string }>(`select id from exit_case where employee_id = $1 and state = 'APPROVED'`, [employeeId])).id;
  const notice = async (exitId: string, days: number) => {
    const x = await ok<{ version: number }>(await h.call(hr, 'GET', `/v1/exit-cases/${exitId}`));
    await ok(await h.call(hr, 'PUT', `/v1/exit-cases/${exitId}/notice-period`, { contractualNoticeDays: days, expectedVersion: x.version }));
  };
  const department = async () =>
    (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'D' || upper(substr(md5(random()::text), 1, 8)), 'Synthetic', true) returning id`, [A.id])).id;
  const opening = async (employeeId: string, leaveType: string, units: string) =>
    ok(await h.call(hr, 'POST', '/v1/leave/adjustments', { employeeId, leaveType, kind: 'OPENING', units, effectiveDate: '2026-01-05', reason: 'Synthetic opening balance', idempotencyKey: uniq('adj-key-') }), 201);
  const runOf = async (month: string, dept: string) => {
    const run = await createRun(h, preparer, periods[month]!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    return run.id;
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    canceller = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CANCEL });
    arrMaker = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ARR_MAKER });
    arrDecider = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ARR_DECIDER });
    lMaker = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [L('read'), L('request')] });
    lDecider = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [L('read'), L('decide')] });
    lDisburser = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [L('read'), L('disburse')] });
    uploader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCUMENTS });
    verifier = await h.actor(A, 'HR_ADMINISTRATOR', { extra: VERIFY_DOCUMENTS });
    // The preparer also holds the waiver right, to show that holding it never lets the preparer waive their own settlement's recovery.
    prep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...HR_SETTLEMENT, WAIVE] });
    rev = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    appr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    rel = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    payer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['settlement.read.amount', 'settlement.record_payment.amount'] });
    waiver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['settlement.read.amount', WAIVE] });
    hrPlain = await h.actor(A, 'HR_ADMINISTRATOR');
    payrollOp = await h.actor(A, 'PAYROLL_OPERATOR', { extra: ['settlement.read.operational'] });
    packV = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['statutory_pack.validate.operational'] });
    packA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['statutory_pack.activate.operational'] });
    today = await businessDate(h, A);

    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await reviewers(h, hr, 'payroll_arrears_case', [arrDecider]);
    await reviewers(h, hr, 'settlement', [rev, appr]);
    // Monthly FIXED salary heads (Basic, DA, HRA and a canteen deduction) and the INPUT heads a settlement pays or recovers on.
    await head(h, configA, configB, { code: 'FC_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    await head(h, configA, configB, { code: 'FC_DA', headType: 'EARNING', basis: 'FIXED', sequence: 2 });
    await head(h, configA, configB, { code: 'FC_HRA', headType: 'EARNING', basis: 'FIXED', sequence: 3 });
    await head(h, configA, configB, { code: 'FC_CANTEEN', headType: 'DEDUCTION', basis: 'FIXED', sequence: 4 });
    await head(h, configA, configB, { code: 'FC_ENCASH', headType: 'EARNING', basis: 'INPUT', sequence: 5 });
    await head(h, configA, configB, { code: 'FC_GRATUITY', headType: 'EARNING', basis: 'INPUT', sequence: 6 });
    await head(h, configA, configB, { code: 'FC_NOTICE', headType: 'DEDUCTION', basis: 'INPUT', sequence: 7 });
    await head(h, configA, configB, { code: 'FC_LOAN', headType: 'DEDUCTION', basis: 'INPUT', sequence: 8 });
    await ok(await h.call(configA, 'POST', '/v1/payroll/components', { code: 'FC_BONUS', name: 'Retention bonus (synthetic)', componentKind: 'EARNING' }), 201);
    periods = (await calendar(h, configA, configB, months(2026))).periods;
    await valuationPolicy(h, configA, configB, { prefix: 'FCV' });
    for (const p of (await h.call(hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number }[]) {
      await ok(await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version }));
    }
    await publishedTemplate(h, hr, 'EXIT_FC', 'EXIT', [{ code: 'ASSETS', title: 'Return assets', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 0, evidenceRequired: false }]);
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('the settlement policy is a dated setting with defaults, activated by a second person', async () => {
    const draft = await ok<Record<string, unknown> & { id: string; version: number }>(
      await h.call(configA, 'POST', '/v1/settlements/policies', {
        effectiveFrom: '2026-01-01',
        basicComponentCode: 'FC_BASIC',
        daComponentCode: 'FC_DA',
        encashmentComponentCode: 'FC_ENCASH',
        encashable: [{ leaveType: 'ANNUAL', maxUnits: '15' }],
        noticeComponentCode: 'FC_NOTICE',
        gratuityComponentCode: 'FC_GRATUITY',
      }),
      201,
    );
    // The defaults: encashment on Basic + DA / 30, notice recovery on the monthly gross / 30.
    expect(draft).toMatchObject({ state: 'DRAFT', encashmentRateBasis: 'BASIC_DA', encashmentDivisor: 30, noticeRateBasis: 'GROSS', noticeDivisor: 30, encashable: [{ leaveType: 'ANNUAL', maxUnits: '15.0000' }] });
    // A component of the wrong kind, an unknown leave type and an encashable type without a component are refused.
    expect((await h.call(configA, 'POST', '/v1/settlements/policies', { effectiveFrom: '2026-01-01', basicComponentCode: 'FC_CANTEEN' })).json().error).toBe('COMPONENT_KIND_INVALID');
    expect((await h.call(configA, 'POST', '/v1/settlements/policies', { effectiveFrom: '2026-01-01', basicComponentCode: 'FC_BASIC', encashable: [{ leaveType: 'ANNUAL' }] })).json().error).toBe('ENCASHMENT_COMPONENT_REQUIRED');
    expect((await h.call(configA, 'POST', '/v1/settlements/policies', { effectiveFrom: '2026-01-01', basicComponentCode: 'FC_BASIC', encashmentDivisor: 0 })).statusCode).toBe(400);
    // Its author never activates it; another configurator does. A reader without the configuration duty cannot write one.
    expect((await h.call(configA, 'POST', `/v1/settlements/policies/${draft.id}/activate`, { expectedVersion: draft.version })).json().error).toBe('SELF_APPROVAL');
    expect((await h.call(prep, 'POST', '/v1/settlements/policies', { effectiveFrom: '2026-01-01', basicComponentCode: 'FC_BASIC' })).statusCode).toBe(403);
    expect(await ok(await h.call(configB, 'POST', `/v1/settlements/policies/${draft.id}/activate`, { expectedVersion: draft.version }))).toMatchObject({ state: 'ACTIVE' });
  });

  it('every company starts with the gratuity pack as an inactive draft, and only valid parameters make a revision', async () => {
    const packs = await ok<{ items: { code: string; revision: number; state: string; parameters: Record<string, unknown>; effectiveFrom: string; createdBy: string }[] }>(
      await h.call(hr, 'GET', '/v1/statutory-rule-packs'),
    );
    // I-85 seeds PF, ESIC and professional tax drafts beside it (statutory-packs.api.test.ts).
    expect(packs.items.filter((p) => p.code === 'GRATUITY')).toEqual([
      expect.objectContaining({
        code: 'GRATUITY',
        revision: 1,
        state: 'DRAFT',
        effectiveFrom: '2018-03-29',
        parameters: { wageDays: 15, wageDivisor: 26, minimumServiceYears: 5, partYearMonthsOver: 6, ceilingAmount: '2000000.00', exemptSeparationTypes: ['DEATH', 'DISABLEMENT'] },
      }),
    ]);
    const bad = await h.call(packV, 'POST', '/v1/statutory-rule-packs', {
      code: 'GRATUITY',
      effectiveFrom: '2026-01-01',
      currencyCode: 'INR',
      parameters: { wageDays: 15, wageDivisor: 0, minimumServiceYears: 5, partYearMonthsOver: 6, ceilingAmount: '2000000.00', exemptSeparationTypes: [] },
      statuteReference: 'Synthetic',
    });
    expect([bad.statusCode, bad.json().error]).toEqual([422, 'INVALID_PARAMETERS']);
    // Writing or validating a revision is a right of its own; an HR Administrator without it reads only.
    expect((await h.call(hrPlain, 'POST', '/v1/statutory-rule-packs', { code: 'GRATUITY', effectiveFrom: '2026-01-01', currencyCode: 'INR', parameters: {}, statuteReference: 'Synthetic' })).statusCode).toBe(403);
  });

  let asha: { id: string; dept: string; exitId: string; settlementId: string; caseId: string; loanId: string };

  it('Example A, a mid-month leaver: earnings due, encashment at the cap, notice shortfall, loan and a pending arrear taken once', async () => {
    const dept = await department();
    const id = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05', name: 'Asha Leaver (synthetic)' });
    await salary(h, preparer, id, {
      effectiveFrom: '2026-01-05',
      monthlyGross: '33000',
      components: [
        { code: 'FC_BASIC', amount: '20000' },
        { code: 'FC_DA', amount: '5000' },
        { code: 'FC_HRA', amount: '8000' },
        { code: 'FC_CANTEEN', amount: '300' },
      ],
    });
    // August is processed on Basic 20,000; a revision from 16 August raises Basic to 22,000, so August owes 2,000 x 16 / 31 = 1,032.26.
    const august = await runOf('2026-08', dept);
    await submitAndApprove(h, { preparer, reviewer, approver }, august);
    await processRun(h, processor, august);
    const origin = (await record(h, processor, august, id)).id;
    const revision = await laterArrangement(h, A, id, '2026-08-16', '35000', [
      { code: 'FC_BASIC', amount: '22000' },
      { code: 'FC_DA', amount: '5000' },
      { code: 'FC_HRA', amount: '8000' },
      { code: 'FC_CANTEEN', amount: '300' },
    ]);
    const raised = await ok<{ id: string; lines: { componentCode: string; amount: string }[] }>(
      await h.call(arrMaker, 'POST', '/v1/payroll/arrears-cases', { sourceRevisionId: revision, originRecordId: origin, reason: 'Synthetic retroactive revision', idempotencyKey: key('fc-') }),
      201,
    );
    expect(raised.lines).toEqual([{ componentCode: 'FC_BASIC', amount: '1032.2600' }]);
    const arrearsTask = ((await h.call(arrDecider, 'GET', '/v1/payroll/arrears-cases/tasks/mine')).json().items as { taskId: string; case: { id: string } }[]).find((t) => t.case.id === raised.id)!.taskId;
    expect((await ok<{ state: string }>(await h.call(arrDecider, 'POST', `/v1/payroll/arrears-tasks/${arrearsTask}/decision`, { decision: 'APPROVE', idempotencyKey: key('fc-') }))).state).toBe('APPROVED');
    // Leave: 18.5 annual days (encashable, capped at 15) and 4 casual days (not encashable); one approved unpaid day, Wednesday 7 October.
    await opening(id, 'ANNUAL', '18.5');
    await opening(id, 'CASUAL', '4');
    await approvedLeave(h, A, id, 'UNPAID', '2026-10-07', '2026-10-07', '1');
    // A disbursed loan of 6,000 recovered on FC_LOAN.
    const loan = await ok<{ id: string; version: number }>(await h.call(lMaker, 'POST', `/v1/payroll-outputs/employees/${id}/loans`, { loanKind: 'LOAN', currencyCode: 'INR', principal: '6000.00', purpose: 'Synthetic household loan' }), 201);
    const loanView = async () => ok<{ version: number; state: string; outstanding: string }>(await h.call(lDecider, 'GET', `/v1/payroll-outputs/loans/${loan.id}`));
    await ok(await h.call(lDecider, 'POST', `/v1/payroll-outputs/loans/${loan.id}/decision`, { decision: 'APPROVE', recoveryComponentCode: 'FC_LOAN', installments: [{ dueMonth: '2026-12', amount: '6000.00' }], expectedVersion: (await loanView()).version }));
    await ok(
      await h.call(lDisburser, 'POST', `/v1/payroll-outputs/loans/${loan.id}/disbursement`, {
        disbursementDate: today,
        evidenceKey: key('disb-'),
        evidenceReference: 'SYNTH-TRANSFER-FC',
        evidenceDocumentIds: [await evidenceDocument(h, uploader, verifier, id)],
        expectedVersion: (await loanView()).version,
      }),
    );
    // Resigned 21 September, last working day Thursday 15 October; 30 days' contractual notice, 25 served.
    await approvedExit(h, A, id, '2026-09-21', '2026-10-15');
    const exitId = await exitOf(id);
    await notice(exitId, 30);

    // An October payroll calculated first takes the arrear: the settlement then leaves it out, naming the run that holds it.
    const october = await runOf('2026-10', dept);
    expect((await record(h, preparer, october, id)).lines.find((l) => l.componentCode === 'FCV_ARREARS')?.amount).toBe('1032.2600');
    const s = await newSettlement(exitId);
    const first = await calculated(s.id);
    expect(first.calculation!.items.some((i) => i.kind === 'ARREARS')).toBe(false);
    expect(first.calculation!.inputs.heldByPayroll).toEqual([{ id: raised.id, kind: 'ARREARS', run_id: october, run_state: 'CALCULATED' }]);
    // Once that run is cancelled, a recalculation (a new snapshot) takes the arrear.
    await ok(await h.call(canceller, 'POST', `/v1/payroll/runs/${october}/cancel`, { reason: 'Final settlement pays the leaver (synthetic)', expectedVersion: (await getRun(h, canceller, october)).version }));
    const d = await calculated(s.id);
    expect(d).toMatchObject({ state: 'DRAFT', calculationStatus: 'CALCULATED', calculation: { sequence: 2, blockingCount: 0 } });
    expect(shape(d.calculation!.items)).toEqual([
      // 14 paid days (15 calendar days less the unpaid Wednesday) of 31, under the revision in force since 16 August.
      ['EARNINGS_DUE', 'CALCULATED', 'FC_BASIC', null, '9935.4800'], // 22,000 x 14 / 31
      ['EARNINGS_DUE', 'CALCULATED', 'FC_CANTEEN', null, '-135.4800'], // 300 x 14 / 31, a deduction
      ['EARNINGS_DUE', 'CALCULATED', 'FC_DA', null, '2258.0600'], // 5,000 x 14 / 31
      ['EARNINGS_DUE', 'CALCULATED', 'FC_HRA', null, '3612.9000'], // 8,000 x 14 / 31
      ['LEAVE_ENCASHMENT', 'CALCULATED', 'FC_ENCASH', 'ANNUAL', '13500.0000'], // 15 (cap) x (22,000 + 5,000) / 30
      ['LEAVE_ENCASHMENT', 'NOT_APPLICABLE', null, 'CASUAL', null], // not encashable
      ['NOTICE_RECOVERY', 'CALCULATED', 'FC_NOTICE', null, '-5833.3300'], // (30 - 25) x 35,000 / 30
      ['LOAN_RECOVERY', 'CALCULATED', 'FC_LOAN', null, '-6000.0000'], // the outstanding balance
      ['ARREARS', 'CALCULATED', 'FCV_ARREARS', null, '1032.2600'], // the approved arrear, on the valuation policy's component
      ['GRATUITY', 'NOT_ELIGIBLE', null, null, null], // 0 completed years of the 5 needed
      ['STATUTORY_DEDUCTION', 'NOT_APPLICABLE', null, null, null], // no rule-pack head applies: tax is not calculated
    ]);
    expect(d.calculation!.items.find((i) => i.kind === 'NOTICE_RECOVERY')!.basis).toMatchObject({ requiredDays: 30, servedDays: 25, shortfallDays: 5, rateBasis: 'GROSS', monthlyRate: '35000.0000', divisor: 30 });
    expect(d.calculation!.items.find((i) => i.kind === 'LEAVE_ENCASHMENT')!.basis).toMatchObject({ available: '18.5000', cap: '15.0000', units: '15.0000', rateBasis: 'BASIC_DA', monthlyRate: '27000.0000', divisor: 30 });
    expect(d.calculation!.items.find((i) => i.kind === 'GRATUITY')!.basis).toMatchObject({ completedYears: 0, minimumServiceYears: 5, packState: 'DRAFT' });
    expect(byCode(d.lines!).map((l) => [l.componentCode, l.amount, l.source, l.lineKind])).toEqual(
      byCode([
        { componentCode: 'FCV_ARREARS', amount: '1032.2600', source: 'CALCULATED', lineKind: 'STANDARD' },
        { componentCode: 'FC_BASIC', amount: '9935.4800', source: 'CALCULATED', lineKind: 'STANDARD' },
        { componentCode: 'FC_CANTEEN', amount: '-135.4800', source: 'CALCULATED', lineKind: 'STANDARD' },
        { componentCode: 'FC_DA', amount: '2258.0600', source: 'CALCULATED', lineKind: 'STANDARD' },
        { componentCode: 'FC_ENCASH', amount: '13500.0000', source: 'CALCULATED', lineKind: 'STANDARD' },
        { componentCode: 'FC_HRA', amount: '3612.9000', source: 'CALCULATED', lineKind: 'STANDARD' },
        { componentCode: 'FC_LOAN', amount: '-6000.0000', source: 'CALCULATED', lineKind: 'STANDARD' },
        { componentCode: 'FC_NOTICE', amount: '-5833.3300', source: 'CALCULATED', lineKind: 'NOTICE_ADJUSTMENT' },
      ]).map((l) => [l.componentCode, l.amount, l.source, l.lineKind]),
    );
    expect(d.netAmount).toBe('18369.8900');
    // Both snapshots are kept, newest first.
    expect(((await ok<{ items: { sequence: number }[] }>(await h.call(prep, 'GET', `/v1/settlements/${s.id}/calculations`))).items).map((k) => k.sequence)).toEqual([2, 1]);
    asha = { id, dept, exitId, settlementId: s.id, caseId: raised.id, loanId: loan.id };
  });

  it('Example A reconciles to salary: a new October payroll values the same components identically and leaves the arrear to the settlement', async () => {
    const october = await runOf('2026-10', asha.dept);
    const payroll = await record(h, preparer, october, asha.id);
    expect(payroll.segments.map((g) => [g.paidDays, g.leaveLopUnits])).toEqual([['14.0000', '1.0000']]);
    expect(byCode(payroll.lines).map((l) => [l.componentCode, l.amount])).toEqual(
      byCode([
        { componentCode: 'FC_BASIC', amount: '9935.4800' },
        { componentCode: 'FC_CANTEEN', amount: '135.4800' },
        { componentCode: 'FC_DA', amount: '2258.0600' },
        { componentCode: 'FC_HRA', amount: '3612.9000' },
      ]).map((l) => [l.componentCode, l.amount]),
    );
    // The arrear the settlement took is not taken by payroll as well.
    expect(payroll.lines.some((l) => l.componentCode === 'FCV_ARREARS')).toBe(false);
    await ok(await h.call(canceller, 'POST', `/v1/payroll/runs/${october}/cancel`, { reason: 'Reconciliation only (synthetic)', expectedVersion: (await getRun(h, canceller, october)).version }));
  });

  it('entered lines are for other components only, each with a reason, shown apart and kept across a recalculation; uploads are refused', async () => {
    const id = asha.settlementId;
    const put = async (lines: Record<string, unknown>[]) => h.call(prep, 'PUT', `/v1/settlements/${id}/lines`, { lines, expectedVersion: (await get(prep, id)).version });
    expect((await put([{ componentCode: 'FC_BASIC', amount: '1.00', reason: 'Synthetic' }])).json().error).toBe('COMPONENT_CALCULATED');
    expect((await put([{ componentCode: 'FC_BONUS', amount: '1000.00' }])).json().error).toBe('REASON_REQUIRED');
    const entered = await ok<Detail>(await put([{ componentCode: 'FC_BONUS', amount: '1000.00', reason: 'Retention bonus agreed at exit (synthetic)' }]));
    expect(entered.lines!.find((l) => l.componentCode === 'FC_BONUS')).toMatchObject({ source: 'ENTERED', reason: 'Retention bonus agreed at exit (synthetic)' });
    expect(entered.lines!.filter((l) => l.source === 'CALCULATED')).toHaveLength(8);
    expect(entered.netAmount).toBe('19369.8900');
    const again = await calculated(id);
    expect(again.calculation!.sequence).toBe(3);
    expect(again.lines!.find((l) => l.componentCode === 'FC_BONUS')).toMatchObject({ source: 'ENTERED', amount: '1000.0000' });
    expect(again.netAmount).toBe('19369.8900');
    const csv = Buffer.from('employee_code,last_working_date,component_code,amount,line_kind\r\n').toString('base64');
    expect((await h.call(prep, 'POST', `/v1/settlements/${id}/upload`, { contentBase64: csv, expectedVersion: again.version })).json().error).toBe('CALCULATED_REVISION');
    expect((await ok<Detail>(await put([]))).netAmount).toBe('18369.8900');
  });

  it('the calculation, its snapshot and its items are confidential: nothing without the settlement amount group', async () => {
    for (const a of [hrPlain, payrollOp]) {
      const d = await get(a, asha.settlementId);
      expect(d).toMatchObject({ state: 'DRAFT', calculationStatus: 'CALCULATED' });
      expect(d).not.toHaveProperty('calculation');
      expect(d).not.toHaveProperty('lines');
      expect(JSON.stringify(d)).not.toContain('13500');
      expect((await h.call(a, 'GET', `/v1/settlements/${asha.settlementId}/calculations`)).statusCode).toBe(403);
    }
    expect((await h.call(hrPlain, 'POST', `/v1/settlements/${asha.settlementId}/calculate`, { expectedVersion: 1 })).statusCode).toBe(403);
    // Only the draft's preparer calculates it.
    expect((await h.call(rev, 'POST', `/v1/settlements/${asha.settlementId}/calculate`, { expectedVersion: (await get(rev, asha.settlementId)).version })).json().error).toBe('NOT_PREPARER');
  });

  it('Example A approved and paid: approval passes, the payment consumes the encashed leave once, and the loan closes through the settlement', async () => {
    const id = asha.settlementId;
    await submit(id);
    // A submitted revision is frozen: no recalculation.
    expect((await calc(id)).json().error).toBe('INVALID_STATE');
    await review(id);
    expect((await ok<{ state: string }>(await approve(id))).state).toBe('APPROVED');
    const clearance = (await h.call(hr, 'POST', `/v1/employees/${asha.id}/processes`, { processCode: 'EXIT_FC', exitCaseId: asha.exitId })).json();
    await ok(await h.call(hr, 'POST', `/v1/employee-process-tasks/${clearance.tasks[0].id}/complete`, { expectedVersion: 1 }));
    expect((await ok<Detail>(await h.call(rel, 'POST', `/v1/settlements/${id}/release-eligibility`, { expectedVersion: (await get(rel, id)).version }))).state).toBe('RELEASE_ELIGIBLE');
    // I-88 follow-up (0214): until the settlement is paid, its arrear stays APPROVED, and nothing may apply it to the settlement yet.
    expect((await h.one<{ state: string }>(`select state from payroll_arrears_case where id = $1`, [asha.caseId])).state).toBe('APPROVED');
    await expect(h.db.query(`update payroll_arrears_case set state = 'APPLIED', applied_settlement_id = $2 where id = $1`, [asha.caseId, id])).rejects.toThrow(
      /paid final settlement whose calculation took it/,
    );
    const paid = await h.call(payer, 'POST', `/v1/settlements/${id}/payment`, {
      paymentDate: today,
      evidenceKey: key('fc-pay-'),
      evidenceReference: 'SYNTH-NEFT-FC-1',
      evidenceDocumentIds: [await evidenceDocument(h, uploader, verifier, asha.id)],
      expectedVersion: (await get(rel, id)).version,
    });
    expect(paid.json(), paid.body).toMatchObject({ state: 'PAID' });
    // BRD line 4939: the 15 encashed annual days leave the balance as at the last working date, once.
    const movements = (await h.db.query<{ kind: string; units: string; day: string }>(
      `select m.movement_kind as kind, m.units::text as units, to_char(m.effective_date, 'YYYY-MM-DD') as day from leave_movement m join leave_type t on t.id = m.leave_type_id
        where m.employee_id = $1 and t.code = 'ANNUAL' order by m.created_at`,
      [asha.id],
    )).rows;
    expect(movements).toEqual([
      { kind: 'OPENING', units: '18.5000', day: '2026-01-05' },
      { kind: 'ENCASHMENT', units: '-15.0000', day: '2026-10-15' },
    ]);
    // I-81 item 1: the recovery counts once the settlement is paid: the loan closes through it, for exactly the recovered amount.
    const loan = async () => ok<{ version: number; state: string; outstanding: string; earlySettlements: { id: string; version: number; state: string }[] }>(await h.call(lDecider, 'GET', `/v1/payroll-outputs/loans/${asha.loanId}`));
    await ok(
      await h.call(lDisburser, 'POST', `/v1/payroll-outputs/loans/${asha.loanId}/early-settlement`, {
        reason: 'Recovered in the full and final settlement (synthetic)',
        repaidAmount: '6000.00',
        repaymentRoute: 'FINAL_SETTLEMENT',
        settlementId: id,
        expectedVersion: (await loan()).version,
      }),
      201,
    );
    const proposed = (await loan()).earlySettlements.find((x) => x.state === 'PROPOSED')!;
    expect(await ok(await h.call(lDecider, 'POST', `/v1/payroll-outputs/loan-settlements/${proposed.id}/decision`, { decision: 'APPROVE', expectedVersion: proposed.version }))).toMatchObject({ state: 'CLOSED', outstanding: '0.0000' });
    // The arrear stays the settlement's: a later payroll never takes it.
    expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_record_input where arrears_case_id = $1`, [asha.caseId])).n).toBe(1); // the cancelled October run only
    // I-88 follow-up (0214): the payment applied it, naming the settlement, with its transaction; the register says where it was paid.
    expect(
      await h.one(
        `select c.state, c.applied_settlement_id, c.applied_record_id, bt.state as transaction_state from payroll_arrears_case c join business_transaction bt on bt.id = c.transaction_id where c.id = $1`,
        [asha.caseId],
      ),
    ).toEqual({ state: 'APPLIED', applied_settlement_id: id, applied_record_id: null, transaction_state: 'APPLIED' });
    expect(await ok(await h.call(arrDecider, 'GET', `/v1/payroll/arrears-cases/${asha.caseId}`))).toMatchObject({ state: 'APPLIED', appliedSettlementId: id, appliedPeriodCode: null });
    // Applied once: it cannot be applied again, nor moved to a payroll record.
    await expect(h.db.query(`update payroll_arrears_case set applied_settlement_id = null where id = $1`, [asha.caseId])).rejects.toThrow();
  });

  it('I-88 follow-up (0214): a settlement cancelled before payment leaves its arrear APPROVED and free; the next payroll takes it', async () => {
    const dept = await department();
    const id = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05', name: 'Bina Leaver (synthetic)' });
    await salary(h, preparer, id, { effectiveFrom: '2026-01-05', monthlyGross: '25000', components: [{ code: 'FC_BASIC', amount: '20000' }, { code: 'FC_DA', amount: '5000' }] });
    // As Example A: August processed on Basic 20,000, then a revision from 16 August to 22,000: 2,000 x 16 / 31 = 1,032.26.
    const august = await runOf('2026-08', dept);
    await submitAndApprove(h, { preparer, reviewer, approver }, august);
    await processRun(h, processor, august);
    const origin = (await record(h, processor, august, id)).id;
    const revision = await laterArrangement(h, A, id, '2026-08-16', '27000', [
      { code: 'FC_BASIC', amount: '22000' },
      { code: 'FC_DA', amount: '5000' },
    ]);
    const raised = await ok<{ id: string }>(
      await h.call(arrMaker, 'POST', '/v1/payroll/arrears-cases', { sourceRevisionId: revision, originRecordId: origin, reason: 'Synthetic retroactive revision', idempotencyKey: key('fc-') }),
      201,
    );
    const task = ((await h.call(arrDecider, 'GET', '/v1/payroll/arrears-cases/tasks/mine')).json().items as { taskId: string; case: { id: string } }[]).find((t) => t.case.id === raised.id)!.taskId;
    await ok(await h.call(arrDecider, 'POST', `/v1/payroll/arrears-tasks/${task}/decision`, { decision: 'APPROVE', idempotencyKey: key('fc-') }));
    await approvedExit(h, A, id, '2026-09-21', '2026-10-15');
    const exitId = await exitOf(id);
    await notice(exitId, 0);
    const s = await newSettlement(exitId);
    const d = await calculated(s.id);
    expect(d.calculation!.items.find((i) => i.kind === 'ARREARS')).toMatchObject({ status: 'CALCULATED', amount: '1032.2600' });
    // Cancelled before payment: nothing paid the arrear, so it stays APPROVED, naming no settlement, and payroll may take it again.
    const cancelled = await h.call(prep, 'POST', `/v1/settlements/${s.id}/cancel`, { expectedVersion: (await get(prep, s.id)).version, reason: 'Synthetic: prepared in error' });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(await h.one(`select state, applied_settlement_id from payroll_arrears_case where id = $1`, [raised.id])).toEqual({ state: 'APPROVED', applied_settlement_id: null });
    const october = await runOf('2026-10', dept);
    expect((await record(h, preparer, october, id)).lines.find((l) => l.componentCode === 'FCV_ARREARS')?.amount).toBe('1032.2600');
  });

  it.runIf(isModuleActive('timesheet'))('Example G, a late-timesheet adjustment (FR-100) approved before the exit: the settlement takes it, the payment applies it once, payroll never takes it', async () => {
    const w = await timesheetWorld(h, A);
    const adjMaker = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_adjustment.read.amount', 'payroll_adjustment.propose.amount'] });
    const adjDecider = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_adjustment.read.amount', 'payroll_adjustment.decide.amount'] });
    await reviewers(h, hr, 'timesheet_adjustment', [adjDecider]);
    const dept = await department();
    const id = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05', name: 'Gauri Late (synthetic)' });
    await ok(await h.call(hr, 'POST', `/v1/employees/${id}/manager`, { managerEmployeeId: w.managerEmp, effectiveFrom: '2026-01-05' }));
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: id });
    await salary(h, preparer, id, { effectiveFrom: '2026-01-05', monthlyGross: '30000', components: [{ code: 'FC_BASIC', amount: '30000' }] });
    await ok(await allocate(h, w.hr, { employeeId: id, jobId: w.jobId }), 201);
    // September (30 days) is processed with Tuesday 15 September unpaid. The week from Monday 14 September, approved afterwards,
    // records a full day of work on it, which the valuation policy (DAY) restores: 30,000 / 30 = 1,000.00.
    await approvedLeave(h, A, id, 'UNPAID', '2026-09-15', '2026-09-15', '1');
    const september = await runOf('2026-09', dept);
    await submitAndApprove(h, { preparer, reviewer, approver }, september);
    await processRun(h, processor, september);
    const origin = (await record(h, processor, september, id)).id;
    const timesheetId = await approvedWeek(h, w, self, '2026-09-14', [{ workDate: '2026-09-15', jobId: w.jobId, activityId: w.devId, minutes: 480 }]);
    const opened = await ok<{ id: string; version: number; deltaAmount: string }>(
      await h.call(adjMaker, 'POST', '/v1/payroll/adjustments', { timesheetId, revision: 1, originRecordId: origin, explanation: 'Synthetic late week' }),
      201,
    );
    expect(opened.deltaAmount).toBe('1000.0000');
    await ok(await h.call(adjMaker, 'POST', `/v1/payroll/adjustments/${opened.id}/submit`, { expectedVersion: opened.version }));
    const task = ((await h.call(adjDecider, 'GET', '/v1/payroll/adjustments/tasks/mine')).json().items as { taskId: string; adjustment: { id: string } }[]).find((t) => t.adjustment.id === opened.id)!.taskId;
    expect(await ok(await h.call(adjDecider, 'POST', `/v1/payroll/adjustment-tasks/${task}/decision`, { decision: 'APPROVE', idempotencyKey: key('fc-') }))).toMatchObject({ state: 'APPROVED' });

    // Resigned 21 September, last working day Thursday 15 October, no notice owed. The settlement takes the approved adjustment.
    await approvedExit(h, A, id, '2026-09-21', '2026-10-15');
    const exitId = await exitOf(id);
    await notice(exitId, 0);
    const s = await newSettlement(exitId);
    const d = await calculated(s.id);
    expect(d.calculation!.items.filter((i) => i.kind === 'ADJUSTMENT').map((i) => [i.status, i.componentCode, i.amount])).toEqual([['CALCULATED', 'FCV_LATE', '1000.0000']]);
    expect(d.lines!.find((l) => l.componentCode === 'FCV_LATE')).toMatchObject({ amount: '1000.0000', source: 'CALCULATED' });
    expect(d.calculation!.blockingCount).toBe(0);
    // Until the settlement is paid the adjustment stays APPROVED, naming no settlement.
    expect(await h.one(`select state, applied_settlement_id from payroll_adjustment where id = $1`, [opened.id])).toEqual({ state: 'APPROVED', applied_settlement_id: null });

    await submit(s.id);
    await review(s.id);
    expect((await ok<{ state: string }>(await approve(s.id))).state).toBe('APPROVED');
    const clearance = (await h.call(hr, 'POST', `/v1/employees/${id}/processes`, { processCode: 'EXIT_FC', exitCaseId: exitId })).json();
    await ok(await h.call(hr, 'POST', `/v1/employee-process-tasks/${clearance.tasks[0].id}/complete`, { expectedVersion: 1 }));
    expect((await ok<Detail>(await h.call(rel, 'POST', `/v1/settlements/${s.id}/release-eligibility`, { expectedVersion: (await get(rel, s.id)).version }))).state).toBe('RELEASE_ELIGIBLE');
    const paid = await h.call(payer, 'POST', `/v1/settlements/${s.id}/payment`, {
      paymentDate: today,
      evidenceKey: key('fc-pay-'),
      evidenceReference: 'SYNTH-NEFT-FC-G',
      evidenceDocumentIds: [await evidenceDocument(h, uploader, verifier, id)],
      expectedVersion: (await get(rel, s.id)).version,
    });
    expect(paid.json(), paid.body).toMatchObject({ state: 'PAID' });
    // The payment applied it once, naming the settlement and no payroll line; the adjustment's own view says where it was paid.
    expect(await h.one(`select state, applied_settlement_id, applied_payroll_line_id from payroll_adjustment where id = $1`, [opened.id])).toEqual({
      state: 'APPLIED',
      applied_settlement_id: s.id,
      applied_payroll_line_id: null,
    });
    expect(await ok(await h.call(adjDecider, 'GET', `/v1/payroll/adjustments/${opened.id}`))).toMatchObject({ state: 'APPLIED', appliedSettlementId: s.id });
    // Payroll never takes it: an October run of the department holds no input for it.
    await runOf('2026-10', dept);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_record_input where adjustment_id = $1`, [opened.id])).n).toBe(0);
  });

  it('Example B, gratuity-eligible: RULE_PACK_NOT_CONFIGURED and no approval while the pack is inactive; after two people activate it, 1,45,384.62', async () => {
    const dept = await department();
    const id = await person(h, A, hr, { departmentId: dept, joiningDate: '2019-06-03', name: 'Bharat Eligible (synthetic)' });
    await salary(h, preparer, id, { effectiveFrom: '2019-06-03', monthlyGross: '36000', components: [{ code: 'FC_BASIC', amount: '30000' }, { code: 'FC_DA', amount: '6000' }] });
    // Resigned 31 August, last working day Friday 30 October: 61 days served of 60, so no shortfall.
    await approvedExit(h, A, id, '2026-08-31', '2026-10-30');
    const exitId = await exitOf(id);
    await notice(exitId, 60);
    // An eligible employee whose settlement is entered without a calculation is not approved either.
    const chitra = await person(h, A, hr, { departmentId: dept, joiningDate: '2018-01-15', name: 'Chitra Uncalculated (synthetic)' });
    await approvedExit(h, A, chitra, '2026-09-01', '2026-10-23');
    const manual = await newSettlement(await exitOf(chitra));
    await ok(await h.call(prep, 'PUT', `/v1/settlements/${manual.id}/lines`, { lines: [{ componentCode: 'FC_BASIC', amount: '1000.00' }], expectedVersion: manual.version }));
    await submit(manual.id);
    await review(manual.id);
    const refusedManual = await approve(manual.id);
    expect([refusedManual.statusCode, refusedManual.json().error]).toEqual([409, 'CALCULATION_BLOCKED']);
    expect(refusedManual.json().details.blockers).toEqual([{ source: 'GRATUITY', kind: 'GRATUITY', code: 'RULE_PACK_NOT_CONFIGURED', rulePackCode: 'GRATUITY' }]);

    const s = await newSettlement(exitId);
    const d = await calculated(s.id);
    expect(shape(d.calculation!.items)).toEqual([
      ['EARNINGS_DUE', 'CALCULATED', 'FC_BASIC', null, '29032.2600'], // 30,000 x 30 / 31
      ['EARNINGS_DUE', 'CALCULATED', 'FC_DA', null, '5806.4500'], // 6,000 x 30 / 31
      ['NOTICE_RECOVERY', 'NOT_APPLICABLE', null, null, null],
      ['GRATUITY', 'RULE_PACK_NOT_CONFIGURED', null, null, null],
      ['STATUTORY_DEDUCTION', 'NOT_APPLICABLE', null, null, null],
    ]);
    const gratuity = d.calculation!.items.find((i) => i.kind === 'GRATUITY')!;
    expect(gratuity).toMatchObject({ blocking: true, basis: { completedYears: 7, partYearCounts: false, countedYears: 7, packState: 'DRAFT' } });
    expect(d.calculation!.blockingCount).toBe(1);
    await submit(s.id);
    await review(s.id);
    const refused = await approve(s.id);
    expect([refused.statusCode, refused.json().error]).toEqual([409, 'CALCULATION_BLOCKED']);
    expect(refused.json().details.blockers).toEqual([{ source: 'CALCULATION', kind: 'GRATUITY', code: 'RULE_PACK_NOT_CONFIGURED', componentCode: null }]);
    // The database refuses it too, whatever the path.
    await expect(h.db.query(`update settlement set state = 'APPROVED', approved_at = now() where id = $1`, [s.id])).rejects.toThrow(/blocking item/);
    // The approver returns it; the task was never decided by the refused approval.
    expect((await ok<{ state: string }>(await h.call(appr, 'POST', `/v1/settlements/tasks/${await taskFor(appr, s.id)}/approve`, { decision: 'RETURN', reason: 'Gratuity pack to be activated (synthetic)', idempotencyKey: key() }))).state).toBe('RETURNED');

    // Two people: one validates the pack (recording where the values came from), another activates it.
    const pack = (await ok<{ items: { id: string; version: number; code: string }[] }>(await h.call(hr, 'GET', '/v1/statutory-rule-packs'))).items.find((p) => p.code === 'GRATUITY')!;
    expect((await h.call(packA, 'POST', `/v1/statutory-rule-packs/${pack.id}/validate`, { sourceReference: 'x', validationReference: 'y', expectedVersion: pack.version })).statusCode).toBe(403);
    const validated = await ok<{ state: string; version: number }>(
      await h.call(packV, 'POST', `/v1/statutory-rule-packs/${pack.id}/validate`, {
        sourceReference: 'Payment of Gratuity Act, 1972 (synthetic copy)',
        validationReference: 'Checked against the 2018 ceiling notification (synthetic)',
        expectedVersion: pack.version,
      }),
    );
    expect(validated.state).toBe('VALIDATED');
    expect((await h.call(packV, 'POST', `/v1/statutory-rule-packs/${pack.id}/activate`, { expectedVersion: validated.version })).statusCode).toBe(403);
    const both = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['statutory_pack.activate.operational'], user: packV.user });
    expect((await h.call(both, 'POST', `/v1/statutory-rule-packs/${pack.id}/activate`, { expectedVersion: validated.version })).json().error).toBe('SELF_APPROVAL');
    expect((await ok<{ state: string }>(await h.call(packA, 'POST', `/v1/statutory-rule-packs/${pack.id}/activate`, { expectedVersion: validated.version }))).state).toBe('ACTIVE');

    // With the pack active, an eligible employee still needs a calculation.
    const stillManual = await approve(manual.id);
    expect(stillManual.json().details.blockers).toEqual([{ source: 'GRATUITY', kind: 'GRATUITY', code: 'CALCULATION_REQUIRED', rulePackCode: 'GRATUITY' }]);

    // The corrected revision is calculated from a new snapshot: 15 / 26 x (30,000 + 6,000) x 7 = 1,45,384.62.
    const r2 = await newSettlement(exitId);
    expect(r2).toMatchObject({ revision: 2, calculationStatus: 'NOT_CONFIGURED', lines: [] });
    const d2 = await calculated(r2.id);
    expect(d2.calculation!.items.find((i) => i.kind === 'GRATUITY')).toMatchObject({
      status: 'CALCULATED',
      componentCode: 'FC_GRATUITY',
      amount: '145384.6200',
      basis: { monthlyWages: '36000.0000', countedYears: 7, wageDays: 15, wageDivisor: 26, capped: false, ceilingAmount: '2000000.00', packState: 'ACTIVE' },
    });
    expect(d2.netAmount).toBe('180223.3300'); // 29,032.26 + 5,806.45 + 1,45,384.62
    await submit(r2.id);
    await review(r2.id);
    expect((await ok<{ state: string }>(await approve(r2.id))).state).toBe('APPROVED');
  });

  it('Example C, a joiner who leaves in the same month: 12 days of 31,000; a 22-day notice shortfall, waived by an approver with a reason', async () => {
    const dept = await department();
    const id = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-10-05', name: 'Dev Joiner (synthetic)' });
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: id });
    await salary(h, preparer, id, { effectiveFrom: '2026-10-05', monthlyGross: '31000', components: [{ code: 'FC_BASIC', amount: '31000' }] });
    await approvedExit(h, A, id, '2026-10-09', '2026-10-16');
    const exitId = await exitOf(id);
    await notice(exitId, 30);
    const s = await newSettlement(exitId);
    const d = await calculated(s.id);
    expect(shape(d.calculation!.items)).toEqual([
      ['EARNINGS_DUE', 'CALCULATED', 'FC_BASIC', null, '12000.0000'], // 31,000 x 12 / 31 (5 to 16 October)
      ['NOTICE_RECOVERY', 'CALCULATED', 'FC_NOTICE', null, '-22733.3300'], // (30 - 8) x 31,000 / 30
      ['GRATUITY', 'NOT_ELIGIBLE', null, null, null],
      ['STATUTORY_DEDUCTION', 'NOT_APPLICABLE', null, null, null],
    ]);
    expect(d.netAmount).toBe('-10733.3300');
    // The waiver is its own right: not the reviewer without it, not the preparer although holding it, never the employee.
    const waive = (a: TestActor) => h.call(a, 'POST', `/v1/exit-cases/${exitId}/notice-waiver`, { reason: 'Joined on a short assignment; notice waived (synthetic)' });
    expect((await waive(rev)).statusCode).toBe(403);
    expect((await waive(prep)).json().error).toBe('NOT_INDEPENDENT');
    expect((await waive(employee)).statusCode).toBe(403);
    expect((await waive(waiver)).statusCode).toBe(201);
    expect((await waive(waiver)).json().error).toBe('ALREADY_WAIVED');
    const w = await calculated(s.id);
    expect(w.calculation!.items.find((i) => i.kind === 'NOTICE_RECOVERY')).toMatchObject({ status: 'WAIVED', amount: null, basis: { shortfallDays: 22 } });
    expect(w.lines!.map((l) => l.componentCode)).toEqual(['FC_BASIC']);
    expect(w.netAmount).toBe('12000.0000');
    expect(w.noticeWaiver).toMatchObject({ reason: 'Joined on a short assignment; notice waived (synthetic)' });
  });

  it('Example D, the final month already approved in monthly payroll: its components are ALREADY_PAID, never a line', async () => {
    const dept = await department();
    const id = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05', name: 'Esha Paid (synthetic)' });
    await salary(h, preparer, id, { effectiveFrom: '2026-01-05', monthlyGross: '31000', components: [{ code: 'FC_BASIC', amount: '31000' }] });
    await approvedExit(h, A, id, '2026-04-20', '2026-05-15');
    const exitId = await exitOf(id);
    await notice(exitId, 0);
    const may = await runOf('2026-05', dept);
    await submitAndApprove(h, { preparer, reviewer, approver }, may);
    const s = await newSettlement(exitId);
    const d = await calculated(s.id);
    expect(shape(d.calculation!.items)).toEqual([
      ['EARNINGS_DUE', 'ALREADY_PAID', 'FC_BASIC', null, null],
      ['NOTICE_RECOVERY', 'NOT_APPLICABLE', null, null, null],
      ['GRATUITY', 'NOT_ELIGIBLE', null, null, null],
      ['STATUTORY_DEDUCTION', 'NOT_APPLICABLE', null, null, null],
    ]);
    expect(d.calculation!.items[0]!.basis).toMatchObject({ runId: may, periodCode: '2026-05', runState: 'APPROVED' });
    expect(d.lines).toEqual([]);
    // Entering it by hand is refused as before (I-81 item 5).
    expect((await h.call(prep, 'PUT', `/v1/settlements/${s.id}/lines`, { lines: [{ componentCode: 'FC_BASIC', amount: '100.00', reason: 'Synthetic' }], expectedVersion: d.version })).json().error).toBe('ALREADY_PAID_IN_PAYROLL');
  });

  it('Example E, a statutory rule-pack head applies to what the settlement pays: RULE_PACK_NOT_CONFIGURED and no approval (BRD line 5120)', async () => {
    await head(h, configA, configB, { code: 'TX_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 20 });
    await head(h, configA, configB, { code: 'TX_TDS', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'TDS', base: ['TX_BASIC'], sequence: 21 });
    const dept = await department();
    const id = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05', name: 'Farah Taxed (synthetic)' });
    await salary(h, preparer, id, { effectiveFrom: '2026-01-05', monthlyGross: '31000', components: [{ code: 'TX_BASIC', amount: '31000' }] });
    await approvedExit(h, A, id, '2026-09-15', '2026-10-16');
    const exitId = await exitOf(id);
    await notice(exitId, 30);
    const s = await newSettlement(exitId);
    const d = await calculated(s.id);
    expect(shape(d.calculation!.items)).toEqual([
      ['EARNINGS_DUE', 'CALCULATED', 'TX_BASIC', null, '16000.0000'], // 31,000 x 16 / 31
      ['NOTICE_RECOVERY', 'NOT_APPLICABLE', null, null, null], // 32 days served of 30
      ['GRATUITY', 'NOT_ELIGIBLE', null, null, null],
      ['STATUTORY_DEDUCTION', 'RULE_PACK_NOT_CONFIGURED', 'TX_TDS', null, null],
    ]);
    // I-90: the TDS head is valued from the INCOME_TAX pack (Example H); while that pack is not active the head blocks and names it.
    expect(d.calculation!.items[3]!.basis).toEqual({ rulePackCode: 'TDS', baseComponentCodes: ['TX_BASIC'], packCode: 'INCOME_TAX' });
    await submit(s.id);
    await review(s.id);
    const refused = await approve(s.id);
    expect(refused.json()).toMatchObject({ error: 'CALCULATION_BLOCKED', details: { blockers: [{ source: 'CALCULATION', kind: 'STATUTORY_DEDUCTION', code: 'RULE_PACK_NOT_CONFIGURED', componentCode: 'TX_TDS' }] } });
  });

  it('Example F, a company with no settlement policy: whatever needs one is blocked, and the gratuity pack is seeded for it too', async () => {
    const B = await h.makeCompany();
    const hrB = await h.actor(B, 'HR_ADMINISTRATOR');
    const prepB = await h.actor(B, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    for (const p of (await h.call(hrB, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number }[]) {
      await ok(await h.call(hrB, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version }));
    }
    const id = await person(h, B, hrB, { joiningDate: '2026-01-05', name: 'Gita Unconfigured (synthetic)' });
    await ok(await h.call(hrB, 'POST', '/v1/leave/adjustments', { employeeId: id, leaveType: 'ANNUAL', kind: 'OPENING', units: '5', effectiveDate: '2026-01-05', reason: 'Synthetic', idempotencyKey: uniq('adj-key-') }), 201);
    await approvedExit(h, B, id, '2026-09-15', '2026-10-16');
    const exitId = (await h.one<{ id: string }>(`select id from exit_case where employee_id = $1`, [id])).id;
    const s = await ok<Detail>(await h.call(prepB, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' }), 201);
    const d = await ok<Detail>(await h.call(prepB, 'POST', `/v1/settlements/${s.id}/calculate`, { expectedVersion: s.version }));
    expect(shape(d.calculation!.items)).toEqual([
      ['EARNINGS_DUE', 'NO_SALARY_ARRANGEMENT', null, null, null],
      ['LEAVE_ENCASHMENT', 'POLICY_NOT_CONFIGURED', null, 'ANNUAL', null],
      ['NOTICE_RECOVERY', 'NOTICE_PERIOD_NOT_RECORDED', null, null, null],
      ['GRATUITY', 'NOT_ELIGIBLE', null, null, null],
      ['STATUTORY_DEDUCTION', 'NOT_APPLICABLE', null, null, null],
    ]);
    expect(d.calculation!.blockingCount).toBe(3);
    expect((await h.one<{ state: string }>(`select state from statutory_rule_pack where company_id = $1 and code = 'GRATUITY'`, [B.id])).state).toBe('DRAFT');
  });

  it('Example H, TDS in the final settlement (I-90): the year as it ends, less the TDS deducted; Form 16 Part B then reconciles to the tax', async () => {
    // The INCOME_TAX draft (FY 2026-27), validated by one authorised person and activated by another (the fixture's stand-in only).
    const pack = await h.one<{ id: string; version: number }>(`select id, version from statutory_rule_pack where company_id = $1 and code = 'INCOME_TAX' and revision = 1`, [A.id]);
    const validated = await ok<{ version: number }>(
      await h.call(packV, 'POST', `/v1/statutory-rule-packs/${pack.id}/validate`, { sourceReference: 'Synthetic source', validationReference: 'Synthetic check', expectedVersion: pack.version }),
    );
    expect((await ok<{ state: string }>(await h.call(packA, 'POST', `/v1/statutory-rule-packs/${pack.id}/activate`, { expectedVersion: validated.version }))).state).toBe('ACTIVE');
    // 2,00,000 a month of TX_BASIC (Example E's TDS head, base TX_BASIC, applies). April is processed before the exit: TDS on 24,00,000
    // projected = 2,92,500 / 12 = 24,375.
    // A 20,000 allowance on a NON_TAXABLE head rides along: never taxed, in payroll or in the settlement.
    await ok(await h.call(configA, 'POST', '/v1/payroll/components', { code: 'FC_ALLOW', name: 'Allowance (synthetic)', componentKind: 'EARNING' }), 201);
    const allow = await ok<{ id: string; version: number }>(
      await h.call(configA, 'POST', '/v1/payroll/heads', { componentCode: 'FC_ALLOW', effectiveFrom: '2020-01-01', inUse: true, headType: 'EARNING', calculationBasis: 'FIXED', taxTreatment: 'NON_TAXABLE', displaySequence: 30 }),
      201,
    );
    await ok(await h.call(configB, 'POST', `/v1/payroll/head-revisions/${allow.id}/activate`, { expectedVersion: allow.version }));
    const dept = await department();
    const id = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05', name: 'Hema Taxed (synthetic)' });
    await salary(h, preparer, id, {
      effectiveFrom: '2026-01-05',
      monthlyGross: '220000',
      components: [
        { code: 'TX_BASIC', amount: '200000' },
        { code: 'FC_ALLOW', amount: '20000' },
      ],
    });
    const april = await runOf('2026-04', dept);
    await submitAndApprove(h, { preparer, reviewer, approver }, april);
    await processRun(h, processor, april);
    expect((await record(h, processor, april, id)).lines.find((l) => l.componentCode === 'TX_TDS')?.amount).toBe('24375.0000');
    // Resigned 1 May, last working day Sunday 31 May (31 days served of 30). The settlement pays May (2,00,000) and a retention bonus of
    // 20,00,000 entered on FC_BONUS (an EARNING component without a payroll head: taxable). The year as it ends:
    // 2,00,000 + 2,00,000 + 20,00,000 = 24,00,000; less 75,000 = 23,25,000; tax 2,81,250 + cess 11,250 = 2,92,500; less 24,375 deducted
    // in April: TDS 2,68,125.
    await approvedExit(h, A, id, '2026-05-01', '2026-05-31');
    const exitId = await exitOf(id);
    await notice(exitId, 30);
    const s = await newSettlement(exitId);
    await ok(await h.call(prep, 'PUT', `/v1/settlements/${s.id}/lines`, { lines: [{ componentCode: 'FC_BONUS', amount: '2000000.00', reason: 'Retention bonus agreed at exit (synthetic)' }], expectedVersion: s.version }));
    const d = await calculated(s.id);
    expect(d.calculation!.items.filter((i) => ['TX_BASIC', 'FC_ALLOW', 'TX_TDS'].includes(i.componentCode ?? '')).map((i) => [i.kind, i.status, i.componentCode, i.amount])).toEqual([
      ['EARNINGS_DUE', 'CALCULATED', 'FC_ALLOW', '20000.0000'],
      ['EARNINGS_DUE', 'CALCULATED', 'TX_BASIC', '200000.0000'],
      ['STATUTORY_DEDUCTION', 'CALCULATED', 'TX_TDS', '-268125.0000'],
    ]);
    expect(d.calculation!.items.find((i) => i.componentCode === 'TX_TDS')!.basis).toMatchObject({
      packCode: 'INCOME_TAX',
      fiscalYear: '2026-27',
      regime: 'NEW',
      earlierTaxableSalary: '200000.00',
      settlementTaxableSalary: '2200000.00',
      annualSalary: '2400000.00',
      taxableIncome: '2325000.00',
      annualTax: '292500.00',
      tdsEarlier: '24375.00',
    });
    expect(d.calculation!.blockingCount).toBe(0);
    expect(d.netAmount).toBe('1951875.0000'); // 2,00,000 + 20,000 + 20,00,000 - 2,68,125

    // Approved (the gate values the TDS again from the frozen lines and agrees), released and paid.
    await submit(s.id);
    await review(s.id);
    expect((await ok<{ state: string }>(await approve(s.id))).state).toBe('APPROVED');
    const clearance = (await h.call(hr, 'POST', `/v1/employees/${id}/processes`, { processCode: 'EXIT_FC', exitCaseId: exitId })).json();
    await ok(await h.call(hr, 'POST', `/v1/employee-process-tasks/${clearance.tasks[0].id}/complete`, { expectedVersion: 1 }));
    await ok(await h.call(rel, 'POST', `/v1/settlements/${s.id}/release-eligibility`, { expectedVersion: (await get(rel, s.id)).version }));
    // Until it is paid, Form 16 Part B counts April's payroll only.
    const taxReader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['tax_declaration.read.tax'] });
    const partB = async () => ok<Record<string, unknown>>(await h.call(taxReader, 'GET', `/v1/payroll/form16/part-b?employeeId=${id}&fiscalYear=2026-27`));
    expect(await partB()).toMatchObject({ salary: { grossSalary: '200000.00', tdsDeducted: '24375.00', finalSettlement: null } });
    const paid = await h.call(payer, 'POST', `/v1/settlements/${s.id}/payment`, {
      paymentDate: today,
      evidenceKey: key('fc-pay-'),
      evidenceReference: 'SYNTH-NEFT-FC-H',
      evidenceDocumentIds: [await evidenceDocument(h, uploader, verifier, id)],
      expectedVersion: (await get(rel, s.id)).version,
    });
    expect(paid.json(), paid.body).toMatchObject({ state: 'PAID' });

    // Form 16 Part B counts April's payroll and the settlement: 24,00,000 of salary, 40,000 exempt (two months of the allowance) and
    // 2,92,500 deducted, exactly the year's tax.
    expect(await partB()).toMatchObject({
      status: 'CALCULATED',
      salary: {
        processedMonths: 1,
        grossSalary: '2400000.00',
        exemptAllowances: '40000.00',
        tdsDeducted: '292500.00',
        finalSettlement: { taxableSalary: '2200000.00', exemptAllowances: '20000.00', tdsDeducted: '268125.00' },
      },
      taxableIncome: '2325000.00',
      tax: { total: '292500.00' },
      balance: '0.00',
    });
    // Form 24Q working data for Q1: April's payroll and the settlement paid for 31 May, in its leaving month.
    const reports = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_report.read.amount'] });
    const q1 = await ok<{ items: { employeeId: string; tds: string; months: unknown[] }[] }>(await h.call(reports, 'GET', '/v1/payroll-outputs/tds-register?fiscalYear=2026-27&quarter=1'));
    expect(q1.items.find((i) => i.employeeId === id)).toEqual({
      employeeId: id,
      employeeCode: expect.any(String),
      employeeName: 'Hema Taxed (synthetic)',
      tds: '292500.0000',
      months: [
        { month: '2026-04', source: 'PAYROLL', taxableSalary: '200000.0000', tds: '24375.0000' },
        { month: '2026-05', source: 'FINAL_SETTLEMENT', taxableSalary: '2200000.0000', tds: '268125.0000' },
      ],
    });
  });
});
