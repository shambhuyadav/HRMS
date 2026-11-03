// Payroll actions that do not go through decideTask re-resolve their permission inside their own transaction after
// their locks (docs/09 §6.5; I-25): processing and each of its chunks, calculation chunks, exception resolution,
// cancellation, hold release and configuration activation. A narrowing committed between the route guard and the
// transaction refuses the action with 403 and records nothing. Synthetic employees, banks and amounts only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { isModuleActive } from '../registry.js';
import { activateHeadRevision } from './config.js';
import { releaseHold } from './holds.js';
import { reverseInputs } from './inputs.js';
import { calculateRun, cancelRun, processRun as processService, resolveException } from './runs.js';
import {
  APPROVE,
  attendance,
  bankRevision,
  calculate,
  calendar,
  CANCEL,
  CONFIG,
  createRun,
  getRun,
  grantOf,
  grants,
  head,
  HOLD_RELEASE,
  months,
  ok,
  person,
  PREPARE,
  PROCESS,
  record,
  REVIEW,
  reviewers,
  SALARY,
  salary,
  submitAndApprove,
} from './payroll.fixtures.js';

describe.runIf(isModuleActive('payroll'))('authority re-checked inside payroll transactions (docs/09 §6.5)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let periods: Record<string, string>;

  const department = async (code: string) => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
  const paid = async (dept: string, amount = '30000') => {
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: amount, components: [{ code: 'RC_BASIC', amount }] });
    return e;
  };
  /** Withdraws one DB109 entry of an assignment, as an access administrator would between the guard and the action. */
  const withdraw = async (a: TestActor, key: PermissionKey) => {
    const [resource, action, fieldGroup] = key.split('.');
    await h.db.query(
      `update role_assignment_permission set active = false
        where company_id = $1 and role_assignment_id = $2 and permission_id = (select id from permission where resource = $3 and action = $4 and field_group = $5)`,
      [A.id, a.assignment, resource, action, fieldGroup],
    );
  };
  const count = async (sql: string, params: unknown[]) => (await h.one<{ n: number }>(sql, params)).n;
  const forbidden = { statusCode: 403, code: 'FORBIDDEN' };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await head(h, configA, configB, { code: 'RC_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('processing: a withdrawn duty refuses the start and a continuation; another eligible processor completes', async () => {
    const dept = await department('RC_PROCESS');
    const e1 = await paid(dept, '10000');
    await paid(dept, '20000');
    await bankRevision(h, A, e1);
    const run = await createRun(h, preparer, periods['2026-02']!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    await submitAndApprove(h, { preparer, reviewer, approver }, run.id);
    const approved = await getRun(h, preparer, run.id);

    // The route guard passed; the DB109 entry is withdrawn before the transaction: nothing starts.
    const p1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    const g1 = await grantOf(h, p1, 'payroll_run', 'process', ['amount']);
    await withdraw(p1, 'payroll_run.process.amount');
    await expect(processService(h.pool, g1, run.id, { expectedVersion: approved.version })).rejects.toMatchObject(forbidden);
    expect(await getRun(h, preparer, run.id)).toMatchObject({ state: 'APPROVED', progress: { processing: { started: false, frozen: 0 } } });
    expect(await count(`select count(*)::int as n from audit_event where record_key = $1 and action like 'PROCESS%'`, [run.id])).toBe(0);

    // A second processor starts and freezes one chunk, then loses the duty: the next chunk is refused whole.
    const p2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    const g2 = await grantOf(h, p2, 'payroll_run', 'process', ['amount']);
    expect(await processService(h.pool, g2, run.id, { expectedVersion: approved.version }, { chunkSize: 1, maxChunks: 1 })).toMatchObject({
      state: 'APPROVED',
      progress: { processing: { started: true, frozen: 1 } },
    });
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where company_id = $1 and id = $2`, [A.id, p2.assignment]);
    await expect(processService(h.pool, g2, run.id, { expectedVersion: approved.version }, { chunkSize: 1 })).rejects.toMatchObject({ statusCode: 403 });
    expect(await count(`select count(*)::int as n from payroll_record where run_id = $1 and frozen_at is not null`, [run.id])).toBe(1);
    expect(await count(`select count(*)::int as n from audit_event where record_key = $1 and action = 'PROCESS_CHUNK'`, [run.id])).toBe(1);

    // Processing that has started can only be completed: another eligible processor does it.
    const p3 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    const done = await ok<{ state: string; processedBy: string; lockVersion: number }>(await h.call(p3, 'POST', `/v1/payroll/runs/${run.id}/process`, { expectedVersion: approved.version }));
    expect(done).toMatchObject({ state: 'PROCESSED_LOCKED', processedBy: p2.user, lockVersion: 1 });
    const actors = (await h.db.query<{ actor_user_id: string; action: string }>(`select actor_user_id, action from audit_event where record_key = $1 and action like 'PROCESS%' order by occurred_at`, [run.id])).rows;
    expect(actors).toEqual([
      { actor_user_id: p2.user, action: 'PROCESSING_STARTED' },
      { actor_user_id: p2.user, action: 'PROCESS_CHUNK' },
      { actor_user_id: p3.user, action: 'PROCESS_CHUNK' },
      { actor_user_id: p3.user, action: 'PROCESS' },
    ]);

    // Hold release: the releaser's duty is withdrawn after the guard; the block stays active, then another releases it.
    const block = await h.one<{ id: string; version: number }>(`select id, version from payroll_hold where employee_id = $1 and run_id = $2`, [e1, run.id]);
    const r1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HOLD_RELEASE });
    const rg1 = await grantOf(h, r1, 'payroll_hold', 'release', ['hold']);
    await withdraw(r1, 'payroll_hold.release.hold');
    const release = { reason: 'Bank instruction verified (synthetic)', evidenceReference: 'SYNTH-BANK-CHECK', expectedVersion: block.version };
    await expect(withTransaction(h.pool, (tx) => releaseHold(tx, rg1, block.id, release))).rejects.toMatchObject(forbidden);
    expect((await h.one<{ state: string }>(`select state from payroll_hold where id = $1`, [block.id])).state).toBe('APPROVED_ACTIVE');
    const r2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HOLD_RELEASE });
    expect(await ok(await h.call(r2, 'POST', `/v1/payroll/holds/${block.id}/release`, release))).toMatchObject({ state: 'RELEASED', releaseBankCheck: 'ADMIN_VERIFIED' });
  });

  it('calculation: a continuation after the preparer lost the duty is refused and writes no record', async () => {
    const dept = await department('RC_CALC');
    await paid(dept);
    await paid(dept);
    const q = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PREPARE });
    const run = await createRun(h, q, periods['2026-03']!, { departmentIds: [dept] });
    const g = await grantOf(h, q, 'payroll_run', 'prepare', ['amount']);
    await calculateRun(h.pool, g, run.id, { expectedVersion: run.version }, { chunkSize: 1, maxChunks: 1 });
    expect(await count(`select count(*)::int as n from payroll_record where run_id = $1`, [run.id])).toBe(1);
    await withdraw(q, 'payroll_run.prepare.amount');
    await expect(calculateRun(h.pool, g, run.id, { expectedVersion: 1 }, { chunkSize: 1 })).rejects.toMatchObject(forbidden);
    expect(await count(`select count(*)::int as n from payroll_record where run_id = $1`, [run.id])).toBe(1);
    expect((await getRun(h, preparer, run.id)).state).toBe('DRAFT');
  });

  it('exception resolution and cancellation are refused under an authority narrowed after the guard', async () => {
    const dept = await department('RC_RESOLVE');
    const e = await paid(dept);
    await attendance(h, A, e, '2026-04-07', 'ABSENT');
    const run = await createRun(h, preparer, periods['2026-04']!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    const exception = (await record(h, preparer, run.id, e)).exceptions.find((x) => x.code === 'ATTENDANCE_NOT_VALUED')!;
    // The approver's assignment is revoked after the guard: nothing is resolved.
    const a1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    const ag = await grantOf(h, a1, 'payroll_run', 'approve', ['amount']);
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where company_id = $1 and id = $2`, [A.id, a1.assignment]);
    await expect(withTransaction(h.pool, (tx) => resolveException(tx, ag, run.id, exception.id, { resolution: 'Synthetic resolution' }))).rejects.toMatchObject({ statusCode: 403 });
    expect((await h.one<{ resolved_at: Date | null }>(`select resolved_at from payroll_exception where id = $1`, [exception.id])).resolved_at).toBeNull();
    // The canceller's user is deactivated after the guard: the run stays live and keeps its members.
    const c1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CANCEL });
    const cg = await grantOf(h, c1, 'payroll_run', 'cancel', ['amount']);
    await h.db.query(`update user_account set active = false where id = $1`, [c1.user]);
    const current = await getRun(h, preparer, run.id);
    await expect(cancelRun(h.pool, cg, run.id, { reason: 'Synthetic cancellation', expectedVersion: current.version })).rejects.toMatchObject({ statusCode: 403 });
    expect((await getRun(h, preparer, run.id)).state).toBe('CALCULATED');
    expect(await count(`select count(*)::int as n from payroll_run_member where lineage_id = $1 and live`, [run.id])).toBe(1);
    // Positive control: an eligible canceller with a current authority cancels it.
    const c2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CANCEL });
    expect(await ok(await h.call(c2, 'POST', `/v1/payroll/runs/${run.id}/cancel`, { reason: 'Synthetic cancellation', expectedVersion: current.version }))).toMatchObject({ state: 'CANCELLED' });
  });

  it('an input reversal is refused when the approval duty was withdrawn after the guard, and reverses nothing', async () => {
    const dept = await department('RC_REVERSE');
    const e = await paid(dept);
    const inputApprover = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_input.read.amount', 'payroll_input.approve.amount'] });
    await reviewers(h, hr, 'payroll_input_batch', [inputApprover]);
    await head(h, configA, configB, { code: 'RC_BONUS', headType: 'EARNING', basis: 'INPUT', sequence: 2 });
    const batch = await ok<{ id: string; version: number; lines: { id: string }[] }>(
      await h.call(preparer, 'POST', `/v1/payroll/periods/${periods['2026-05']}/input-batches`, {
        lines: [{ employeeId: e, componentCode: 'RC_BONUS', inputKind: 'VARIABLE_PAYMENT', amount: '100.00', currencyCode: 'INR', effectiveDate: '2026-05-10', reference: 'RC-REV-1' }],
      }),
      201,
    );
    await ok(await h.call(preparer, 'POST', `/v1/payroll/input-batches/${batch.id}/submit`, { expectedVersion: batch.version }));
    const t = ((await h.call(inputApprover, 'GET', '/v1/payroll/input-batches/tasks/mine')).json().items as { taskId: string; batch: { id: string } | null }[]).find((x) => x.batch?.id === batch.id)!;
    await ok(await h.call(inputApprover, 'POST', `/v1/payroll/input-tasks/${t.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: `rc-rev-${batch.id}` }));
    const current = await ok<{ version: number }>(await h.call(inputApprover, 'GET', `/v1/payroll/input-batches/${batch.id}`));
    const g = await grantOf(h, inputApprover, 'payroll_input', 'approve', ['amount']);
    await withdraw(inputApprover, 'payroll_input.approve.amount');
    await expect(withTransaction(h.pool, (tx) => reverseInputs(tx, g, batch.id, { inputIds: [batch.lines[0]!.id], reason: 'Synthetic reversal', expectedVersion: current.version }))).rejects.toMatchObject(forbidden);
    expect((await h.one<{ state: string }>(`select state from payroll_input where id = $1`, [batch.lines[0]!.id])).state).toBe('APPROVED');
    expect(await count(`select count(*)::int as n from audit_event where record_key = $1 and action = 'REVERSE_LINES'`, [batch.id])).toBe(0);
  });

  it('configuration activation is refused when the activation duty was withdrawn after the guard', async () => {
    const draft = await ok<{ id: string; version: number }>(
      await h.call(configA, 'POST', '/v1/payroll/heads', { componentCode: 'RC_BASIC', effectiveFrom: '2027-01-01', inUse: true, headType: 'EARNING', calculationBasis: 'FIXED', taxTreatment: 'TAXABLE', displaySequence: 1 }),
      201,
    );
    const activator = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const g = await grantOf(h, activator, 'payroll_config', 'activate', ['operational']);
    await withdraw(activator, 'payroll_config.activate.operational');
    await expect(withTransaction(h.pool, (tx) => activateHeadRevision(tx, g, draft.id, { expectedVersion: draft.version }))).rejects.toMatchObject(forbidden);
    expect((await h.one<{ state: string }>(`select state from payroll_head_revision where id = $1`, [draft.id])).state).toBe('DRAFT');
  });
});
