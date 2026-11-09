// FR-037 lock and controlled reopen (BRD line 815), as overridden by Appendix H: BR-047 (line 1909) "after PROCESSED_LOCKED there is no
// unlock-in-place. Earlier reopen proposals apply only before processing"; BR-011 payroll values (line 1701; DF05); BR-012 payroll period
// and release (line 1707); and the payroll half of FR-063 (line 1127). Run against the real routes and database; each database refusal is
// a direct write, so the database is saying no. Synthetic amounts only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';
import {
  APPROVE,
  calculate,
  calendar,
  CANCEL,
  CONFIG,
  createRun,
  getRun,
  grants,
  head,
  key,
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
  taskOf,
} from './payroll.fixtures.js';

describe.runIf(isModuleActive('payroll'))('payroll lock, release and values', () => {
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
  let periods: Record<string, string>;
  const team = () => ({ preparer, reviewer, approver });

  const department = async (code: string) => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
  const paid = async (dept: string, amount = '30000') => {
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: amount, components: [{ code: 'LK_BASIC', amount }] });
    return e;
  };
  const approvedRun = async (month: string, dept: string) => {
    const run = await createRun(h, preparer, periods[month]!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    await submitAndApprove(h, team(), run.id);
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
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await head(h, configA, configB, { code: 'LK_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    periods = (await calendar(h, configA, configB, months(2026).map((p) => ({ ...p, financialYear: 'FY2026' })))).periods;
  });

  afterAll(async () => {
    await h?.stop();
  });

  describe('lock and controlled reopen (FR-037, BR-047)', () => {
    it('FR-037: a lock needs its explicit confirmation of the version the processor saw, over the scope the preparer confirmed', async () => {
      const dept = await department('LOCK_CONFIRM');
      const e = await paid(dept);
      const runId = await approvedRun('2026-01', dept);
      const approved = await getRun(h, processor, runId);
      expect(approved.state).toBe('APPROVED');
      expect((await h.call(processor, 'POST', `/v1/payroll/runs/${runId}/process`, {})).statusCode).toBe(400);
      const stale = await h.call(processor, 'POST', `/v1/payroll/runs/${runId}/process`, { expectedVersion: approved.version + 1 });
      expect([stale.statusCode, stale.json().error]).toEqual([409, 'STALE_VERSION']);
      expect((await getRun(h, processor, runId)).state).toBe('APPROVED');
      expect(await processRun(h, processor, runId)).toMatchObject({ state: 'PROCESSED_LOCKED', lockVersion: 1 });
      // The lock covers exactly the members whose scope was confirmed when the run was created.
      expect((await h.db.query<{ employee_id: string }>(`select employee_id from payroll_record where run_id = $1`, [runId])).rows).toEqual([{ employee_id: e }]);
    });

    it('FR-037: a locked result cannot be amended by any business action (BR-047: no unlock, so no reopen after the lock)', async () => {
      const dept = await department('LOCK_FROZEN');
      const e = await paid(dept, '30000');
      const runId = await approvedRun('2026-02', dept);
      const locked = await processRun(h, processor, runId);
      const before = await record(h, processor, runId, e);
      const body = { reason: 'Synthetic attempt to change a locked run', expectedVersion: locked.version };
      const refused = async (a: TestActor, action: string, payload: object) => {
        // Each holds the duty, so this is the lock answering, not a missing grant (403) or a missing route (404).
        const res = await h.call(a, 'POST', `/v1/payroll/runs/${runId}/${action}`, payload);
        expect([409, 422], `${action}: ${res.statusCode} ${res.body}`).toContain(res.statusCode);
      };
      await refused(preparer, 'revise', body);
      await refused(processor, 'return', body);
      await refused(canceller, 'cancel', body);
      await refused(preparer, 'exclusions', { employeeIds: [e], reason: body.reason, expectedVersion: locked.version });
      expect((await h.call(preparer, 'POST', `/v1/payroll/runs/${runId}/calculate`, { expectedVersion: locked.version })).json().error).toBe('ALREADY_CALCULATED');
      const after = await record(h, processor, runId, e);
      expect(after).toEqual(before);
      expect(await getRun(h, processor, runId)).toMatchObject({ state: 'PROCESSED_LOCKED', lockVersion: 1, version: locked.version, successorRunId: null });
      // Whatever the path: the database refuses it too.
      await expect(h.db.query(`update payroll_record set net = net + 1, gross = gross + 1, earnings = earnings + 1 where run_id = $1`, [runId])).rejects.toMatchObject({ code: '23514' });
      await expect(h.db.query(`update payroll_run set state = 'APPROVED' where id = $1`, [runId])).rejects.toMatchObject({ code: '23514' });
    });

    it('FR-037: before the lock, an authorised return with a reason opens a new auditable revision and overwrites nothing', async () => {
      const dept = await department('LOCK_RETURN');
      const e = await paid(dept, '40000');
      const runId = await approvedRun('2026-03', dept);
      const approved = await getRun(h, processor, runId);
      const original = await record(h, processor, runId, e);
      // Separately authorised, and only with a reason.
      expect((await h.call(preparer, 'POST', `/v1/payroll/runs/${runId}/return`, { reason: 'Synthetic', expectedVersion: approved.version })).statusCode).toBe(403);
      expect((await h.call(processor, 'POST', `/v1/payroll/runs/${runId}/return`, { reason: ' ', expectedVersion: approved.version })).json().error).toBe('REASON_REQUIRED');
      const reason = 'Bank validation found a problem (synthetic)';
      const next = await ok<{ id: string; revision: number; state: string }>(await h.call(processor, 'POST', `/v1/payroll/runs/${runId}/return`, { reason, expectedVersion: approved.version }), 201);
      expect(next).toMatchObject({ revision: 2, state: 'DRAFT' });
      expect(next.id).not.toBe(runId);
      // The earlier revision stays as it was approved: its figures, and a verification of them against its own snapshot.
      expect(await getRun(h, processor, runId)).toMatchObject({ state: 'RETURNED', successorRunId: next.id });
      expect(await record(h, processor, runId, e)).toEqual(original);
      const asRead = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_run.read.amount', 'payroll_run.prepare.amount'] });
      expect(await ok(await h.call(asRead, 'POST', `/v1/payroll/runs/${runId}/verify`))).toMatchObject({ identical: true, records: 1 });
      // Linked, with the identifier and reason on record, and audited under the person who did it.
      expect(await h.one(`select revision, supersedes_run_id, lineage_id from payroll_run where id = $1`, [next.id])).toEqual({ revision: 2, supersedes_run_id: runId, lineage_id: runId });
      expect((await h.one<{ close_reason: string }>(`select close_reason from payroll_run where id = $1`, [runId])).close_reason).toBe(reason);
      expect((await h.one<{ actor_user_id: string }>(`select actor_user_id from audit_event where record_key = $1 and action = 'RETURN'`, [runId])).actor_user_id).toBe(processor.user);
      expect((await h.one<{ actor_user_id: string }>(`select actor_user_id from audit_event where record_key = $1 and action = 'CREATE_REVISION'`, [next.id])).actor_user_id).toBe(processor.user);
      // The new revision is calculated afresh beside the old one.
      expect((await calculate(h, preparer, next.id)).state).toBe('CALCULATED');
      expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_record where run_id = any($1::uuid[])`, [[runId, next.id]])).n).toBe(2);
    });
  });

  describe('period and release (BR-012)', () => {
    // A financial-year filter on the run list (owner, 6 Nov 2026): by the label each calendar gives its periods, not a fixed April-March year.
    it('BR-012: the run list filters by the financial year the calendar gave the period, in any case, and shows it on each run', async () => {
      const dept = await department('REL_YEAR');
      await paid(dept);
      const run = await createRun(h, preparer, periods['2026-05']!, { departmentIds: [dept] });
      const list = async (q: string) => (await ok<{ items: { id: string; financialYear: string }[] }>(await h.call(preparer, 'GET', `/v1/payroll/runs?${q}`))).items;
      expect((await list('financialYear=FY2026')).find((r) => r.id === run.id)).toMatchObject({ financialYear: 'FY2026' });
      expect((await list('financialYear=fy2026')).map((r) => r.id)).toContain(run.id);
      expect(await list('financialYear=FY2099')).toEqual([]);
      expect((await h.call(preparer, 'GET', '/v1/payroll/runs?financialYear=FY%202026')).statusCode).toBe(400);
    });

    it('BR-012: calculation, approval, lock, return and payment are distinct decisions: each needs its own duty and records its own person; locking pays nothing', async () => {
      const dept = await department('REL_DISTINCT');
      const e = await paid(dept, '25000');
      const run = await createRun(h, preparer, periods['2026-04']!, { departmentIds: [dept] });
      const version = () => getRun(h, preparer, run.id).then((r) => r.version);
      // Calculation is the preparer's: neither the approver nor the processor can do it.
      expect((await h.call(approver, 'POST', `/v1/payroll/runs/${run.id}/calculate`, { expectedVersion: await version() })).statusCode).toBe(403);
      expect((await h.call(processor, 'POST', `/v1/payroll/runs/${run.id}/calculate`, { expectedVersion: await version() })).statusCode).toBe(403);
      await calculate(h, preparer, run.id);
      await ok(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/submit`, { expectedVersion: await version() }));
      // Review and approval go to their own people; the processor's duty decides neither.
      const reviewTask = await taskOf(h, reviewer, run.id, 'REVIEW');
      expect((await h.call(processor, 'POST', `/v1/payroll/run-tasks/${reviewTask}/review`, { decision: 'APPROVE', idempotencyKey: key() })).statusCode).toBe(403);
      await ok(await h.call(reviewer, 'POST', `/v1/payroll/run-tasks/${reviewTask}/review`, { decision: 'APPROVE', idempotencyKey: key() }));
      const approvalTask = await taskOf(h, approver, run.id, 'APPROVAL');
      expect((await h.call(processor, 'POST', `/v1/payroll/run-tasks/${approvalTask}/approve`, { decision: 'APPROVE', idempotencyKey: key() })).statusCode).toBe(403);
      await ok(await h.call(approver, 'POST', `/v1/payroll/run-tasks/${approvalTask}/approve`, { decision: 'APPROVE', idempotencyKey: key() }));
      // Approval is not the lock: only the holder of the processing duty takes it, and a return before it is theirs too.
      expect((await h.call(approver, 'POST', `/v1/payroll/runs/${run.id}/process`, { expectedVersion: await version() })).statusCode).toBe(403);
      expect((await h.call(approver, 'POST', `/v1/payroll/runs/${run.id}/return`, { reason: 'Synthetic', expectedVersion: await version() })).statusCode).toBe(403);
      expect((await getRun(h, processor, run.id)).state).toBe('APPROVED');
      const locked = await processRun(h, processor, run.id);
      expect(locked).toMatchObject({ state: 'PROCESSED_LOCKED', paymentStatus: 'NOT_TRACKED_HERE' });
      const people = await h.one<{ calculated_by: string; reviewed_by: string; approved_by: string; processed_by: string }>(`select calculated_by, reviewed_by, approved_by, processed_by from payroll_run where id = $1`, [run.id]);
      expect(people).toEqual({ calculated_by: preparer.user, reviewed_by: reviewer.user, approved_by: approver.user, processed_by: processor.user });
      expect(new Set(Object.values(people)).size).toBe(4);
      // A lock is not a payment: nothing is paid or queued for the bank, and the salary is still owed in full.
      const rec = await record(h, processor, run.id, e);
      expect(rec.net).toBe('25000.0000');
      expect((await h.one<{ lines: number; events: number }>(
        `select (select count(*)::int from payroll_bank_line where payroll_record_id = $1) as lines,
                (select count(*)::int from payroll_payment_event ev join payroll_bank_line l on l.company_id = ev.company_id and l.id = ev.bank_line_id where l.payroll_record_id = $1) as events`,
        [rec.id],
      ))).toEqual({ lines: 0, events: 0 });
    });

    it('BR-012 (the monthly period filter, and each period’s financial year; the run list has no financial-year filter): a period filter returns that month only, and a run states its year', async () => {
      const dept = await department('REL_FILTER');
      await paid(dept);
      const may = await createRun(h, preparer, periods['2026-05']!, { departmentIds: [dept] });
      const june = await createRun(h, preparer, periods['2026-06']!, { departmentIds: [dept] });
      const listed = async (period: string) => (await ok<{ items: { id: string; periodCode: string }[] }>(await h.call(preparer, 'GET', `/v1/payroll/runs?periodId=${period}`))).items;
      const inMay = await listed(periods['2026-05']!);
      expect(inMay.map((r) => r.id)).toContain(may.id);
      expect(inMay.map((r) => r.id)).not.toContain(june.id);
      expect(new Set(inMay.map((r) => r.periodCode))).toEqual(new Set(['2026-05']));
      expect(await getRun(h, preparer, june.id)).toMatchObject({ period: { periodCode: '2026-06', financialYear: 'FY2026' } });
    });
  });

  describe('payroll values are not inferred (BR-011, DF05)', () => {
    it('BR-011: annual cost and monthly gross are kept as declared, with no gross-times-12; the in-hand figure is a labelled estimate before tax (I-80)', async () => {
      const dept = await department('VAL_DECLARED');
      const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
      // 50000 x 12 is 600000, so a derived annual cost could not read 777777.
      await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: '50000', annualCtc: '777777', components: [{ code: 'LK_BASIC', amount: '50000' }] });
      const items = (await ok<{ items: Record<string, unknown>[] }>(await h.call(preparer, 'GET', `/v1/employees/${e}/salary`))).items;
      expect(items).toEqual([expect.objectContaining({ monthlyGross: '50000.0000', annualCtc: '777777.0000' })]);
      const page = await ok<{ items: Record<string, unknown>[]; estimate: { label: string; message: string } }>(await h.call(preparer, 'GET', '/v1/salary-master?pageSize=100'));
      const master = page.items.find((r) => r.employeeId === e)!;
      expect(master).toMatchObject({ monthlyGross: '50000.0000', annualCtc: '777777.0000' });
      // I-80 (decided under owner delegation, 6 Nov 2026): the salary master shows the estimate, labelled, and never a tax figure;
      // the salary record itself carries no estimate.
      expect(master.estimatedInHand).toBe('50000.00');
      expect(page.estimate.message).toContain('before income tax and statutory deductions');
      expect(Object.keys(master).filter((k) => /hand|estimat|net|tax/i.test(k))).toEqual(['estimatedInHand']);
      expect(Object.keys(items[0]!).filter((k) => /hand|estimat|net|tax/i.test(k))).toEqual([]);
    });

    it('BR-011: tax treatment is not inferred: a taxable head deducts nothing on its own, and a rule-pack head with no pack blocks the employee instead of guessing', async () => {
      await head(h, configA, configB, { code: 'LK_PF', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'PF', sequence: 2 });
      const dept = await department('VAL_TAX');
      const plain = await paid(dept, '30000');
      const packed = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
      await salary(h, preparer, packed, { effectiveFrom: '2026-01-05', monthlyGross: '30000', components: [{ code: 'LK_BASIC', amount: '30000' }, { code: 'LK_PF', amount: '0' }] });
      const run = await createRun(h, preparer, periods['2026-07']!, { departmentIds: [dept] });
      await calculate(h, preparer, run.id);
      // LK_BASIC is declared TAXABLE (fixture), and no tax appears: net is exactly what the declared lines add up to.
      const clear = await record(h, preparer, run.id, plain);
      expect(clear).toMatchObject({ earnings: '30000.0000', deductions: '0.0000', net: '30000.0000', calculationStatus: 'CALCULATED' });
      expect(clear.lines.map((l) => l.componentCode)).toEqual(['LK_BASIC']);
      const blocked = await record(h, preparer, run.id, packed);
      expect(blocked).toMatchObject({ calculationStatus: 'FAILED', net: null });
      expect(blocked.exceptions.map((x) => x.code)).toContain('RULE_PACK_NOT_CONFIGURED');
    });
  });

  describe('retried payroll requests (FR-063)', () => {
    it('FR-063 (payroll half): a retried calculation, decision or processing returns the recorded result with no second business effect', async () => {
      const dept = await department('RETRY');
      const e = await paid(dept, '20000');
      const scope = { periodId: periods['2026-08']!, departmentIds: [dept] };
      const preview = await ok<{ scopeToken: string }>(await h.call(preparer, 'POST', '/v1/payroll/runs/preview', scope));
      const run = await ok<{ id: string }>(await h.call(preparer, 'POST', '/v1/payroll/runs', { ...scope, scopeToken: preview.scopeToken }), 201);
      // Retrying the creation answers with the run it created and leaves one run (the test below).
      expect((await h.call(preparer, 'POST', '/v1/payroll/runs', { ...scope, scopeToken: preview.scopeToken })).json()).toMatchObject({ id: run.id, replayed: true });
      expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_run where company_id = $1 and period_id = $2 and scope_department_ids = $3::uuid[]`, [A.id, scope.periodId, scope.departmentIds])).n).toBe(1);
      const calculated = await calculate(h, preparer, run.id);
      const retriedCalculation = await ok<{ replayed: boolean; version: number; state: string }>(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/calculate`, { expectedVersion: calculated.version }));
      expect(retriedCalculation).toMatchObject({ replayed: true, version: calculated.version, state: 'CALCULATED' });
      expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_record where run_id = $1`, [run.id])).n).toBe(1);
      await ok(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/submit`, { expectedVersion: calculated.version }));
      const task = await taskOf(h, reviewer, run.id, 'REVIEW');
      const decision = { decision: 'APPROVE', idempotencyKey: key('retry-') };
      expect(await ok(await h.call(reviewer, 'POST', `/v1/payroll/run-tasks/${task}/review`, decision))).toMatchObject({ replayed: false });
      expect(await ok(await h.call(reviewer, 'POST', `/v1/payroll/run-tasks/${task}/review`, decision))).toMatchObject({ replayed: true });
      expect((await h.one<{ n: number }>(`select count(*)::int as n from approval_decision where company_id = $1 and idempotency_key = $2`, [A.id, decision.idempotencyKey])).n).toBe(1);
      await ok(await h.call(approver, 'POST', `/v1/payroll/run-tasks/${await taskOf(h, approver, run.id, 'APPROVAL')}/approve`, { decision: 'APPROVE', idempotencyKey: key() }));
      const locked = await processRun(h, processor, run.id);
      const position = () =>
        h.one(
          `select (select lock_version from payroll_run where id = $1::uuid) as lock_version, (select count(*)::int from payroll_hold where run_id = $1::uuid) as holds,
                  (select count(*)::int from audit_event where record_key = $1::uuid and action = 'PROCESS') as audits, (select count(*)::int from payroll_record where run_id = $1::uuid) as records`,
          [run.id],
        );
      const before = await position();
      const retry = await ok<{ replayed: boolean; state: string; lockVersion: number }>(await h.call(processor, 'POST', `/v1/payroll/runs/${run.id}/process`, { expectedVersion: locked.version }));
      expect(retry).toMatchObject({ replayed: true, state: 'PROCESSED_LOCKED', lockVersion: 1 });
      expect(await position()).toEqual(before);
      expect(before).toMatchObject({ lock_version: 1, audits: 1, records: 1 });
      expect((await record(h, processor, run.id, e)).net).toBe('20000.0000');
    });

    // The scope token is the request's key (owner, 6 Nov 2026): the same preparer sending it again while the run lives is a retry.
    it('FR-063: a retried run creation answers with the run it created and creates nothing; another preparer, or a run since cancelled, is not a retry', async () => {
      const dept = await department('RETRY_CREATE');
      await paid(dept);
      const scope = { periodId: periods['2026-09']!, departmentIds: [dept] };
      const preview = await ok<{ scopeToken: string }>(await h.call(preparer, 'POST', '/v1/payroll/runs/preview', scope));
      const create = (a: TestActor) => h.call(a, 'POST', '/v1/payroll/runs', { ...scope, scopeToken: preview.scopeToken });
      const runs = async () => (await h.one<{ n: number }>(`select count(*)::int as n from payroll_run where company_id = $1 and period_id = $2 and scope_department_ids = $3::uuid[]`, [A.id, scope.periodId, scope.departmentIds])).n;
      const first = await ok<{ id: string; replayed: boolean }>(await create(preparer), 201);
      expect(first.replayed).toBe(false);
      const retry = await ok<{ id: string; replayed: boolean; version: number }>(await create(preparer), 200);
      expect(retry).toMatchObject({ id: first.id, replayed: true });
      expect(await runs()).toBe(1);
      // Another preparer confirming the same scope is not retrying anything: its members are already in a run.
      const other = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
      expect((await create(other)).json()).toMatchObject({ error: 'SCOPE_CHANGED' });
      expect(await runs()).toBe(1);
      // A cancelled run releases its members, so the same token then starts a new run.
      await ok(await h.call(canceller, 'POST', `/v1/payroll/runs/${first.id}/cancel`, { reason: 'Synthetic', expectedVersion: retry.version }));
      const again = await ok<{ id: string; replayed: boolean }>(await create(preparer), 201);
      expect(again.replayed).toBe(false);
      expect(again.id).not.toBe(first.id);
      expect(await runs()).toBe(2);
    });
  });
});
