// I-33 end to end: an increment applied mid-month with an approved component breakdown becomes the new arrangement's
// salary components (increment module), and the payroll calculation of that month reproduces DF05 over the old and
// the new arrangement exactly as it does for components set through payroll's own component setter. Synthetic
// employees, components and amounts only; expected values are computed by hand from DF05 as written (monthly fixed
// component x eligible paid calendar days / calendar days in the month, each paid-day segment counted once, every
// component rounded half-up to the minor unit at its output, totals summed from the rounded components).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import type { PermissionKey } from '../access/baseline.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';
import { calculate, calendar, components, CONFIG, createRun, head, ok, person, PREPARE, record, reviewers, SALARY, salary } from './payroll.fixtures.js';

const INCREMENT: PermissionKey[] = ['salary.read.salary', 'increment.read.salary', 'increment.propose.salary', 'increment.approve.salary'];

describe.runIf(isModuleActive('payroll'))('increment breakdown applied mid-month feeds the DF05 calculation (I-33, FR-092, FR-032)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let preparer: TestActor;
  let proposer: TestActor;
  let incrementApprover: TestActor;
  let periodId: string;

  type Line = { componentCode: string; amount: string; basis: 'MONTHLY' | 'ANNUAL' };
  const line = (componentCode: string, amount: string): Line => ({ componentCode, amount, basis: 'MONTHLY' });
  const OLD = [
    { code: 'BASIC', amount: '30000' },
    { code: 'HRA', amount: '12000' },
    { code: 'CANTEEN', amount: '500' },
  ];
  const NEW = [line('BASIC', '33000.25'), line('HRA', '13000.25'), line('CANTEEN', '600')];

  /** Proposes an off-cycle increase from 2026-11-16 and has it approved (and so applied) by another user. */
  const applyIncrement = async (employeeId: string, breakdown: Line[] | null) => {
    const proposed = await ok<{ caseId: string }>(
      await h.call(proposer, 'POST', '/v1/increment-cases/off-cycle', {
        employeeId,
        effectiveDate: '2026-11-16',
        proposedAmount: '46000.50',
        proposedCounterpart: '552006',
        reason: 'Off-cycle adjustment (synthetic)',
        ...(breakdown ? { components: breakdown } : {}),
      }),
      201,
    );
    const tasks = (await ok<{ items: { taskId: string; ownerEmployeeId: string }[] }>(await h.call(incrementApprover, 'GET', '/v1/increment-cases/tasks/mine'))).items;
    const task = tasks.find((t) => t.ownerEmployeeId === employeeId);
    expect(task, 'increment task').toBeDefined();
    const decided = await ok<{ state: string; componentsApplied: number }>(
      await h.call(incrementApprover, 'POST', `/v1/increment-cases/tasks/${task!.taskId}/decision`, { decision: 'APPROVE', reason: 'Independent review (synthetic)', idempotencyKey: uniq('inc-key-') }),
    );
    expect(decided).toMatchObject({ state: 'APPLIED', componentsApplied: breakdown?.length ?? 0 });
    return proposed.caseId;
  };
  const arrangementsOf = async (employeeId: string) =>
    (
      await h.db.query<{ id: string; effective_from: string; effective_to: string | null }>(
        `select id, to_char(effective_from, 'YYYY-MM-DD') as effective_from, to_char(effective_to, 'YYYY-MM-DD') as effective_to
           from salary_arrangement where company_id = $1 and employee_id = $2 order by effective_from`,
        [A.id, employeeId],
      )
    ).rows;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...PREPARE, ...SALARY] });
    proposer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: INCREMENT });
    incrementApprover = await h.actor(A, 'HR_ADMINISTRATOR', { extra: INCREMENT });
    await reviewers(h, hr, 'increment_case', [incrementApprover]);
    await head(h, configA, configB, { code: 'BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    await head(h, configA, configB, { code: 'HRA', headType: 'EARNING', basis: 'FIXED', sequence: 2 });
    await head(h, configA, configB, { code: 'CANTEEN', headType: 'DEDUCTION', basis: 'FIXED', sequence: 3 });
    periodId = (await calendar(h, configA, configB, [{ code: '2026-11', start: '2026-11-01', end: '2026-11-30' }])).periods['2026-11']!;
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('prorates the old and the new arrangement over their days, exactly as for components set through payroll', async () => {
    const dept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'INCR', 'INCR', true) returning id`, [A.id])).id;
    // Through the increment breakdown (I-33) and, for the twin, through payroll's own component setter.
    const viaIncrement = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    const viaPayroll = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    for (const e of [viaIncrement, viaPayroll]) await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: '42000', components: OLD });

    await applyIncrement(viaIncrement, NEW);
    await applyIncrement(viaPayroll, null);
    const [oldA, newA] = await arrangementsOf(viaIncrement);
    const [oldB, newB] = await arrangementsOf(viaPayroll);
    expect([oldA!.effective_to, newA!.effective_from, newA!.effective_to]).toEqual(['2026-11-16', '2026-11-16', null]);
    expect([oldB!.effective_to, newB!.effective_from, newB!.effective_to]).toEqual(['2026-11-16', '2026-11-16', null]);
    // The increment breakdown is the arrangement's components: payroll's setter refuses to set them a second time.
    const again = await h.call(preparer, 'POST', `/v1/payroll/salary-arrangements/${newA!.id}/components`, {
      components: NEW.map((l) => ({ componentCode: l.componentCode, amount: l.amount, basis: l.basis })),
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error).toBe('COMPONENTS_ALREADY_SET');
    await components(h, preparer, newB!.id, NEW.map((l) => ({ code: l.componentCode, amount: l.amount })));

    const run = await createRun(h, preparer, periodId, { departmentIds: [dept] });
    expect((await calculate(h, preparer, run.id)).state).toBe('CALCULATED');
    const a = await record(h, preparer, run.id, viaIncrement);
    const b = await record(h, preparer, run.id, viaPayroll);

    // 1..15 November on the old arrangement, 16..30 November on the new one: 15 + 15 of 30 days, each counted once.
    expect(a.segments.map((s) => [s.segmentStart, s.segmentEnd, s.calendarDays, s.paidDays])).toEqual([
      ['2026-11-01', '2026-11-15', 15, '15.0000'],
      ['2026-11-16', '2026-11-30', 15, '15.0000'],
    ]);
    expect((a.segments as unknown as { salaryArrangementId: string }[]).map((s) => s.salaryArrangementId)).toEqual([oldA!.id, newA!.id]);
    // BASIC (30000 x 15 + 33000.25 x 15) / 30 = 31500.125 -> 31500.13; HRA (12000 x 15 + 13000.25 x 15) / 30 =
    // 12500.125 -> 12500.13; CANTEEN (500 x 15 + 600 x 15) / 30 = 550.00. Earnings are the sum of the rounded
    // components (44000.26), not the rounded sum (44000.25).
    expect(a.lines.map((l) => [l.componentCode, l.headType, l.amount])).toEqual([
      ['BASIC', 'EARNING', '31500.1300'],
      ['HRA', 'EARNING', '12500.1300'],
      ['CANTEEN', 'DEDUCTION', '550.0000'],
    ]);
    expect(a).toMatchObject({ calculationStatus: 'CALCULATED', paidUnits: '30.0000', earnings: '44000.2600', deductions: '550.0000', net: '43450.2600' });
    expect(a.exceptions.filter((x) => x.severity === 'BLOCKING')).toEqual([]);

    // Components applied by the increment are calculated exactly like those set through payroll.
    const shape = (r: typeof a) => ({
      lines: r.lines.map((l) => [l.componentCode, l.headType, l.amount, l.ruleVersion]),
      segments: r.segments.map((s) => [s.segmentStart, s.segmentEnd, s.calendarDays, s.paidDays]),
      totals: [r.paidUnits, r.earnings, r.reimbursements, r.deductions, r.net, r.employerContributions],
      exceptions: r.exceptions.map((x) => [x.code, x.severity]).sort(),
    });
    expect(shape(a)).toEqual(shape(b));
    // A rerun on the stored snapshot reproduces every line and total.
    expect(await ok(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/verify`))).toMatchObject({ identical: true, lineDifferences: 0, totalDifferences: 0 });
  });
});
