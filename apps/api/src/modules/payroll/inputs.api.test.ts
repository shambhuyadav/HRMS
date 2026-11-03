// Payroll inputs and salary stops over HTTP (FR-031; DB039; DF05 stop modes; H2; BR-050; I-13 upload semantics;
// FR-106 scanning). Synthetic employees, components, references and amounts only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { EICAR_TEST_STRING } from '../../storage/scan.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';
import { PAYROLL_EVENTS } from './events.js';
import {
  APPROVE,
  calculate,
  calendar,
  CONFIG,
  CRITERIA,
  createRun,
  criterion,
  DOCUMENTS,
  evidenceDocument,
  getRun,
  grants,
  head,
  INPUT_APPROVE,
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
  STOP_DECIDE,
  STOP_PROPOSE,
  submitAndApprove,
  taskOf,
  trailText,
  VERIFY_DOCUMENTS,
} from './payroll.fixtures.js';

describe.runIf(isModuleActive('payroll'))('payroll inputs and salary stops (FR-031)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let inputApprover: TestActor;
  let inputApprover2: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let stopMaker: TestActor;
  let stopDecider: TestActor;
  let uploader: TestActor;
  let verifier: TestActor;
  let periods: Record<string, string>;
  let closed: string;

  const department = async (code: string) => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
  const paid = async (dept: string, amount = '30000') => {
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: amount, components: [{ code: 'IN_BASIC', amount }] });
    return e;
  };
  const line = (employeeId: string, over: Record<string, string> = {}) => ({
    employeeId,
    componentCode: 'IN_BONUS',
    inputKind: 'VARIABLE_PAYMENT',
    amount: '1000.00',
    currencyCode: 'INR',
    effectiveDate: '2026-03-10',
    reference: uniq('REF-'),
    ...over,
  });
  const enter = (period: string, lines: unknown[], idempotencyKey?: string) => h.call(preparer, 'POST', `/v1/payroll/periods/${period}/input-batches`, { lines, ...(idempotencyKey ? { idempotencyKey } : {}) });
  const taskOn = async (a: TestActor, batchId: string) =>
    ((await h.call(a, 'GET', '/v1/payroll/input-batches/tasks/mine')).json().items as { taskId: string; batch: { id: string } | null }[]).find((x) => x.batch?.id === batchId)?.taskId;
  /** Decides a batch as whichever independent approver the engine routed it to. */
  const decideBatch = async (batchId: string, decision: 'APPROVE' | 'REJECT', reason?: string) => {
    for (const a of [inputApprover, inputApprover2]) {
      const t = await taskOn(a, batchId);
      if (t) return h.call(a, 'POST', `/v1/payroll/input-tasks/${t}/decision`, { decision, idempotencyKey: key(), ...(reason ? { reason } : {}) });
    }
    throw new Error(`no approver holds the task of batch ${batchId}`);
  };
  const submit = async (batchId: string) => {
    const b = await ok<{ version: number }>(await h.call(preparer, 'GET', `/v1/payroll/input-batches/${batchId}`));
    return ok(await h.call(preparer, 'POST', `/v1/payroll/input-batches/${batchId}/submit`, { expectedVersion: b.version }));
  };
  const stopTask = async (a: TestActor, stopId: string) =>
    ((await h.call(a, 'GET', '/v1/payroll/salary-stops/tasks/mine')).json().items as { taskId: string; stop: { id: string } | null }[]).find((x) => x.stop?.id === stopId)?.taskId;
  const csv = (rows: string[][]) => Buffer.from([['employee_code', 'component_code', 'input_kind', 'amount', 'currency_code', 'effective_date', 'reference'], ...rows].map((r) => r.join(',')).join('\n')).toString('base64');
  const codeOf = async (employeeId: string) => (await h.one<{ code: string }>(`select employee_code as code from employee where id = $1`, [employeeId])).code;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(CONFIG, CRITERIA) });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(CONFIG, CRITERIA) });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY, INPUT_APPROVE) });
    inputApprover = await h.actor(A, 'HR_ADMINISTRATOR', { extra: INPUT_APPROVE });
    inputApprover2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: INPUT_APPROVE });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    stopMaker = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(STOP_PROPOSE, STOP_DECIDE) });
    stopDecider = await h.actor(A, 'HR_ADMINISTRATOR', { extra: STOP_DECIDE });
    uploader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCUMENTS });
    verifier = await h.actor(A, 'HR_ADMINISTRATOR', { extra: VERIFY_DOCUMENTS });
    await reviewers(h, hr, 'payroll_input_batch', [preparer, inputApprover2, inputApprover]);
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await reviewers(h, hr, 'payroll_salary_stop', [stopMaker, stopDecider]);
    await head(h, configA, configB, { code: 'IN_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    await head(h, configA, configB, { code: 'IN_BONUS', headType: 'EARNING', basis: 'INPUT', sequence: 2 });
    await head(h, configA, configB, { code: 'IN_TRAVEL', headType: 'REIMBURSEMENT', basis: 'INPUT', sequence: 3 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
    // A period whose input cutoff has passed (company configuration: no date is hard-coded).
    closed = (await calendar(h, configA, configB, [{ code: 'CLOSED-01', start: '2025-01-01', end: '2025-01-31', cutoff: '2025-01-25', payment: '2025-01-31' }])).periods['CLOSED-01']!;
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('validates every line and saves nothing when one is wrong', async () => {
    const dept = await department('IN_VALID');
    const e = await paid(dept);
    const late = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-05-01' });
    const foreign = await person(h, B, await h.actor(B, 'HR_ADMINISTRATOR'), { joiningDate: '2026-01-05' });
    const selfEmp = await paid(dept);
    const self = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PREPARE, employeeId: selfEmp });
    const res = await enter(periods['2026-03']!, [
      line(e),
      line(foreign),
      line(e, { componentCode: 'IN_BASIC' }),
      line(e, { inputKind: 'NOT_A_KIND' }),
      line(e, { currencyCode: 'USD' }),
      line(e, { effectiveDate: '2026-04-01' }),
      line(e, { reference: '-bad ref' }),
      line(late),
      line(e, { amount: '0' }),
      line(e, { amount: '1.001' }),
    ]);
    expect(res.json()).toMatchObject({ error: 'INVALID_LINES' });
    expect((res.json().details.errors as { row: number; code: string }[]).map((x) => [x.row, x.code])).toEqual([
      [2, 'UNKNOWN_EMPLOYEE'],
      [3, 'INPUT_HEAD_INVALID'],
      [4, 'UNKNOWN_INPUT_KIND'],
      [5, 'CURRENCY_MISMATCH'],
      [6, 'DATE_OUTSIDE_PERIOD'],
      [7, 'INVALID_REFERENCE'],
      [8, 'NOT_EMPLOYED_IN_PERIOD'],
      [9, 'INVALID_AMOUNT'],
      [10, 'INVALID_AMOUNT'],
    ]);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_input where employee_id = $1`, [e])).n).toBe(0);
    // Nobody enters an input about themselves.
    const own = await h.call(self, 'POST', `/v1/payroll/periods/${periods['2026-03']}/input-batches`, { lines: [line(selfEmp)] });
    expect(own.json().details.errors).toEqual([{ row: 1, code: 'SELF_NOT_ALLOWED' }]);
    // The cutoff of the period is the company's; after it inputs go to a later period.
    expect((await enter(closed, [line(e, { effectiveDate: '2025-01-10' })])).json().error).toBe('INPUT_CUTOFF_PASSED');
  });

  it('never duplicates an entry: a reused reference is refused and a replayed request returns its batch', async () => {
    const dept = await department('IN_IDEM');
    const e = await paid(dept);
    const l = line(e);
    const k = key('entry-');
    const first = await ok<{ id: string; replayed: boolean; lineCount: number }>(await enter(periods['2026-03']!, [l], k), 201);
    expect(first).toMatchObject({ replayed: false, lineCount: 1 });
    // The same request again (a retry): the same batch, no second line.
    expect(await ok(await enter(periods['2026-03']!, [l], k))).toMatchObject({ id: first.id, replayed: true });
    // The same key for other content is a conflict; the same reference without a key is a duplicate.
    expect((await enter(periods['2026-03']!, [line(e)], k)).json().error).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await enter(periods['2026-03']!, [{ ...l }])).json().details.errors).toEqual([{ row: 1, code: 'DUPLICATE_REFERENCE' }]);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_input where employee_id = $1`, [e])).n).toBe(1);
  });

  it('uploads all-or-nothing after the scan, and the same file again returns the batch it created', async () => {
    const dept = await department('IN_UPLOAD');
    const e1 = await paid(dept);
    const e2 = await paid(dept);
    const [c1, c2] = [await codeOf(e1), await codeOf(e2)];
    const upload = (contentBase64: string, extra: Record<string, unknown> = {}) =>
      h.call(preparer, 'POST', `/v1/payroll/periods/${periods['2026-03']}/input-batches/upload`, { contentBase64, ...extra });
    expect((await upload(Buffer.from('a,b\n1,2').toString('base64'))).json().error).toBe('INVALID_TEMPLATE');
    // A flagged file is never read.
    expect((await upload(Buffer.from(EICAR_TEST_STRING).toString('base64'))).json().error).toBe('UPLOAD_QUARANTINED');
    const bad = csv([
      [c1, 'IN_BONUS', 'VARIABLE_PAYMENT', '100.00', 'INR', '2026-03-05', uniq('UP-')],
      [c2, 'IN_BONUS', 'VARIABLE_PAYMENT', '100.00', 'INR', '2026-02-05', uniq('UP-')],
      [c2, 'IN_BONUS'],
    ]);
    const refused = await ok<{ applied: boolean; accepted: number; rejected: number; errors: { row: number; code: string }[] }>(await upload(bad));
    expect(refused).toMatchObject({ applied: false, accepted: 0, rejected: 3 });
    expect(refused.errors).toEqual([
      { row: 2, code: 'BATCH_REJECTED' },
      { row: 3, code: 'DATE_OUTSIDE_PERIOD' },
      { row: 4, code: 'WRONG_CELL_COUNT' },
    ]);
    const good = csv([
      [c1, 'IN_BONUS', 'VARIABLE_PAYMENT', '100.00', 'INR', '2026-03-05', uniq('UP-')],
      [c2, 'IN_TRAVEL', 'OTHER_INPUT', '250.50', 'INR', '2026-03-06', uniq('UP-')],
    ]);
    expect(await ok(await upload(good, { dryRun: true }))).toMatchObject({ dryRun: true, applied: false, accepted: 2, batchId: null });
    const applied = await ok<{ applied: boolean; batchId: string }>(await upload(good));
    expect(applied.applied).toBe(true);
    // The same file again: the batch it created, nothing new.
    expect(await ok(await upload(good))).toMatchObject({ replayed: true, applied: false, batchId: applied.batchId });
    expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_input where batch_id = $1`, [applied.batchId])).n).toBe(2);
    // Once that batch is cancelled the file may be uploaded again (its references are free again).
    const b = await ok<{ version: number }>(await h.call(preparer, 'GET', `/v1/payroll/input-batches/${applied.batchId}`));
    await ok(await h.call(preparer, 'POST', `/v1/payroll/input-batches/${applied.batchId}/cancel`, { reason: 'Uploaded to the wrong period (synthetic)', expectedVersion: b.version }));
    const again = await ok<{ applied: boolean; batchId: string }>(await upload(good));
    expect(again.applied).toBe(true);
    expect(again.batchId).not.toBe(applied.batchId);
  });

  it('serves the published PAYROLL_INPUTS_V1 template: exactly the header the upload accepts and no rows, under the upload grant (DF09)', async () => {
    const res = await h.call(preparer, 'GET', '/v1/payroll/input-batches/template');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="PAYROLL_INPUTS_V1.csv"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toBe('employee_code,component_code,input_kind,amount,currency_code,effective_date,reference\r\n');
    // Round trip: the template with one valid synthetic row passes the upload's validation (a dry run saves nothing).
    const e = await paid(await department('IN_TEMPLATE'));
    const filled = `${res.body}${await codeOf(e)},IN_BONUS,VARIABLE_PAYMENT,100.00,INR,2026-03-05,${uniq('TPL-')}`;
    const checked = await h.call(preparer, 'POST', `/v1/payroll/periods/${periods['2026-03']}/input-batches/upload`, { contentBase64: Buffer.from(filled).toString('base64'), dryRun: true });
    expect(await ok(checked)).toMatchObject({ template: 'PAYROLL_INPUTS_V1', dryRun: true, total: 1, accepted: 1, rejected: 0, errors: [] });
    // Without the input preparation grant the template is refused like the upload.
    for (const a of [hr, inputApprover]) expect((await h.call(a, 'GET', '/v1/payroll/input-batches/template')).statusCode).toBe(403);
  });

  it('is decided independently: never the preparer, never someone whose own input is in the batch', async () => {
    const dept = await department('IN_DECIDE');
    const e = await paid(dept);
    // inputApprover2 is the employee of a line in the batch: the engine passes over them.
    const own = await paid(dept);
    await h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from) values ($1, $2, $3, '2026-01-01')`, [A.id, inputApprover2.user, own]);
    const batch = await ok<{ id: string }>(await enter(periods['2026-04']!, [line(e, { effectiveDate: '2026-04-10' }), line(own, { effectiveDate: '2026-04-11' })]), 201);
    await submit(batch.id);
    const pending = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/payroll/input-batches/tasks/mine')).json().items as { batch: { id: string } | null }[]).some((x) => x.batch?.id === batch.id);
    expect(await pending(preparer)).toBe(false);
    expect(await pending(inputApprover2)).toBe(false);
    expect(await pending(inputApprover)).toBe(true);
    expect((await decideBatch(batch.id, 'REJECT')).json().error).toBe('REASON_REQUIRED');
    const t = ((await h.call(inputApprover, 'GET', '/v1/payroll/input-batches/tasks/mine')).json().items as { taskId: string; batch: { id: string } }[]).find((x) => x.batch.id === batch.id)!;
    const k = key('dec-');
    expect(await ok(await h.call(inputApprover, 'POST', `/v1/payroll/input-tasks/${t.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: k }))).toMatchObject({ state: 'APPROVED', replayed: false });
    expect(await ok(await h.call(inputApprover, 'POST', `/v1/payroll/input-tasks/${t.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: k }))).toMatchObject({ replayed: true });
    expect(await ok(await h.call(preparer, 'GET', `/v1/payroll/input-batches/${batch.id}`))).toMatchObject({ state: 'APPROVED', decidedBy: inputApprover.user });
    // A reader linked to an employee of the batch never sees that own line in this context (H1), and is told the view is partial.
    const ownView = await ok<{ lines: { employeeId: string }[]; scopeComplete: boolean }>(await h.call(inputApprover2, 'GET', `/v1/payroll/input-batches/${batch.id}`));
    expect(ownView.lines.map((l) => l.employeeId)).toEqual([e]);
    expect(ownView.scopeComplete).toBe(false);
    // Linked to the employee of a batch after it was routed to them, an approver still never decides it.
    const lateApprover = await h.actor(A, 'HR_ADMINISTRATOR', { extra: INPUT_APPROVE });
    const lateEmp = await paid(dept);
    try {
      await reviewers(h, hr, 'payroll_input_batch', [lateApprover]);
      const second = await ok<{ id: string }>(await enter(periods['2026-04']!, [line(lateEmp, { effectiveDate: '2026-04-12' })]), 201);
      await submit(second.id);
      const t2 = (await taskOn(lateApprover, second.id))!;
      await h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from) values ($1, $2, $3, '2026-01-01')`, [A.id, lateApprover.user, lateEmp]);
      expect((await h.call(lateApprover, 'POST', `/v1/payroll/input-tasks/${t2}/decision`, { decision: 'APPROVE', idempotencyKey: key() })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
      expect((await ok<{ state: string }>(await h.call(preparer, 'GET', `/v1/payroll/input-batches/${second.id}`))).state).toBe('SUBMITTED');
    } finally {
      await reviewers(h, hr, 'payroll_input_batch', [preparer, inputApprover2, inputApprover]);
    }
  });

  it('serialises input decisions of every calendar with the month’s calculation start (two connections)', async () => {
    const dept = await department('IN_MONTH_LOCK');
    const e = await paid(dept);
    // A batch under another calendar's October period; the main calendar's October run would take the month's snapshot.
    const alt = (await calendar(h, configA, configB, [{ code: 'ALT-2026-10', start: '2026-10-01', end: '2026-10-31' }])).periods['ALT-2026-10']!;
    const batch = await ok<{ id: string }>(await enter(alt, [line(e, { effectiveDate: '2026-10-05' })]), 201);
    await submit(batch.id);
    const monthKey = `payroll_inputs:${A.id}:2026-10-01`;
    // Another connection holds the service month's lock, as a calculation start under any calendar's October period does.
    const holder = await h.pool.connect();
    try {
      await holder.query(`select pg_advisory_lock(hashtextextended($1, 0))`, [monthKey]);
      const decision = decideBatch(batch.id, 'APPROVE');
      let waiting = 0;
      for (let i = 0; i < 100 && waiting === 0; i++) {
        waiting = (
          await h.one<{ n: number }>(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`, [])
        ).n;
        if (waiting === 0) await new Promise((r) => setTimeout(r, 50));
      }
      // The decision waits for the month, whatever calendar its batch belongs to; then it proceeds.
      expect(waiting).toBeGreaterThanOrEqual(1);
      await holder.query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [monthKey]);
      expect(await ok(await decision)).toMatchObject({ state: 'APPROVED' });
    } finally {
      await holder.query(`select pg_advisory_unlock_all()`).catch(() => undefined);
      holder.release();
    }
  });

  it('never ignores an approved salary stop entered under another calendar’s period of the same month', async () => {
    const dept = await department('IN_STOP_ELSEWHERE');
    const stopped = await paid(dept);
    await paid(dept, '25000');
    // Excluded by an approved stop of the main calendar too: nothing is paid to them here, so nothing is flagged.
    const doubleStopped = await paid(dept, '26000');
    const alt = (await calendar(h, configA, configB, [{ code: 'ALT-2026-09', start: '2026-09-01', end: '2026-09-30' }])).periods['ALT-2026-09']!;
    const exclusion = async (periodId: string, employeeId: string) => {
      const doc = await evidenceDocument(h, uploader, verifier, employeeId);
      const stop = await ok<{ id: string }>(
        await h.call(stopMaker, 'POST', `/v1/payroll/periods/${periodId}/salary-stops`, {
          employeeId,
          mode: 'EXCLUDE_CALCULATION',
          reason: 'Synthetic exclusion reason',
          evidenceReference: 'SYNTH-CASE-3',
          evidenceDocumentIds: [doc],
        }),
        201,
      );
      await ok(await h.call(stopDecider, 'POST', `/v1/payroll/stop-tasks/${(await stopTask(stopDecider, stop.id))!}/decision`, { decision: 'APPROVE', confirmMode: 'EXCLUDE_CALCULATION', idempotencyKey: key() }));
      return stop.id;
    };
    await exclusion(alt, stopped);
    const ownStop = await exclusion(periods['2026-09']!, doubleStopped);
    const altStop = await exclusion(alt, doubleStopped);
    // The month is run under the main calendar: the stop is not silently dropped, and the employee is not paid here.
    const run = await createRun(h, preparer, periods['2026-09']!, { departmentIds: [dept] });
    const calculated = await calculate(h, preparer, run.id);
    expect(calculated.records).toEqual({ CALCULATED: 1, FAILED: 1, EXCLUDED: 1 });
    const r = await record(h, preparer, run.id, stopped);
    expect(r).toMatchObject({ calculationStatus: 'FAILED', net: null, lines: [] });
    const x = r.exceptions.find((e) => e.code === 'SALARY_STOP_OTHER_PERIOD')!;
    expect(x).toMatchObject({ severity: 'BLOCKING', resolvable: false, detail: { stops: 1, periodCodes: ['ALT-2026-09'] } });
    expect((await record(h, preparer, run.id, doubleStopped)).exceptions.map((e) => e.code)).toEqual(['SALARY_STOP_EXCLUDED']);
    // A note cannot set an independent stop decision aside; approval waits.
    expect((await h.call(approver, 'POST', `/v1/payroll/runs/${run.id}/exceptions/${x.id}/resolve`, { resolution: 'Pay anyway (synthetic)' })).json().error).toBe('NOT_RESOLVABLE');
    await ok(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/submit`, { expectedVersion: calculated.version }));
    await ok(await h.call(reviewer, 'POST', `/v1/payroll/run-tasks/${await taskOf(h, reviewer, run.id, 'REVIEW')}/review`, { decision: 'APPROVE', idempotencyKey: key() }));
    const approvalTask = await taskOf(h, approver, run.id, 'APPROVAL');
    expect((await h.call(approver, 'POST', `/v1/payroll/run-tasks/${approvalTask}/approve`, { decision: 'APPROVE', idempotencyKey: key() })).json().error).toBe('EXCEPTIONS_UNRESOLVED');
    // Returned without the stopped employee, the month proceeds; the stopped employee is then run under the stop's calendar, where it applies.
    const returned = await ok<{ nextRunId: string }>(
      await h.call(approver, 'POST', `/v1/payroll/run-tasks/${approvalTask}/approve`, {
        decision: 'RETURN',
        reason: 'Run the stopped employee under the stop calendar (synthetic)',
        excludeEmployeeIds: [stopped],
        idempotencyKey: key(),
      }),
    );
    expect(await calculate(h, preparer, returned.nextRunId)).toMatchObject({ records: { CALCULATED: 1, EXCLUDED: 1 }, exceptions: { blocking: 0 } });
    // Processed: the own stop is applied, and the other calendar's stop of an employee excluded here never holds processing up.
    await submitAndApprove(h, { preparer, reviewer, approver }, returned.nextRunId);
    expect(await processRun(h, processor, returned.nextRunId)).toMatchObject({ state: 'PROCESSED_LOCKED' });
    const stopStates = (await h.db.query<{ id: string; state: string }>(`select id, state from payroll_salary_stop where id = any($1::uuid[])`, [[ownStop, altStop]])).rows;
    expect(Object.fromEntries(stopStates.map((s) => [s.id, s.state]))).toEqual({ [ownStop]: 'APPLIED', [altStop]: 'APPROVED' });
    const altRun = await createRun(h, preparer, alt, { departmentIds: [dept] });
    await calculate(h, preparer, altRun.id);
    const ra = await record(h, preparer, altRun.id, stopped);
    expect(ra).toMatchObject({ calculationStatus: 'EXCLUDED', net: null });
    expect(ra.exceptions.map((e) => e.code)).toEqual(['SALARY_STOP_EXCLUDED']);
  });

  it('approves a withholding stop only under a criterion that is still active at the decision', async () => {
    const dept = await department('IN_STOP_RETIRED');
    const e = await paid(dept);
    const doc = await evidenceDocument(h, uploader, verifier, e);
    const crit = await criterion(h, configA, configB, { scopeMode: 'FULL_ONLY' });
    const stop = await ok<{ id: string }>(
      await h.call(stopMaker, 'POST', `/v1/payroll/periods/${periods['2026-10']}/salary-stops`, {
        employeeId: e,
        criterionId: crit,
        releaseCriterion: 'Clearance done',
        reason: 'Synthetic stop reason',
        evidenceReference: 'SYNTH-CASE-4',
        evidenceDocumentIds: [doc],
      }),
      201,
    );
    // The company retires the criterion before the decision: nothing new is withheld under it.
    const c = (await ok<{ items: { id: string; version: number }[] }>(await h.call(configA, 'GET', '/v1/payroll/hold-criteria'))).items.find((x) => x.id === crit)!;
    await ok(await h.call(configB, 'POST', `/v1/payroll/hold-criteria/${crit}/retire`, { reason: 'Policy withdrawn (synthetic)', expectedVersion: c.version }));
    const t = (await stopTask(stopDecider, stop.id))!;
    expect((await h.call(stopDecider, 'POST', `/v1/payroll/stop-tasks/${t}/decision`, { decision: 'APPROVE', confirmMode: 'HOLD_DISBURSEMENT', idempotencyKey: key() })).json().error).toBe(
      'HOLD_CRITERION_NOT_ACTIVE',
    );
    // A rejection stays possible.
    expect(await ok(await h.call(stopDecider, 'POST', `/v1/payroll/stop-tasks/${t}/decision`, { decision: 'REJECT', reason: 'Criterion retired (synthetic)', idempotencyKey: key() }))).toMatchObject({
      state: 'REJECTED',
    });
  });

  it('routes a batch only to a listed approver whose row scope covers every employee in it (I-25)', async () => {
    const eng = await department('IN_ROUTE_ENG');
    const fin = await department('IN_ROUTE_FIN');
    const e1 = await paid(eng);
    const f1 = await paid(fin);
    const engApprover = await h.actor(A, 'HR_ADMINISTRATOR', { extra: INPUT_APPROVE, departmentFilter: eng });
    try {
      await reviewers(h, hr, 'payroll_input_batch', [engApprover]);
      const mixed = await ok<{ id: string; version: number }>(await enter(periods['2026-07']!, [line(e1, { effectiveDate: '2026-07-10' }), line(f1, { effectiveDate: '2026-07-11' })]), 201);
      // The only listed approver could not open every line: nobody to route to, and the batch stays a draft.
      expect((await h.call(preparer, 'POST', `/v1/payroll/input-batches/${mixed.id}/submit`, { expectedVersion: mixed.version })).json().error).toBe('NO_ELIGIBLE_REVIEWER');
      expect((await ok<{ state: string }>(await h.call(preparer, 'GET', `/v1/payroll/input-batches/${mixed.id}`))).state).toBe('DRAFT');
      await reviewers(h, hr, 'payroll_input_batch', [engApprover, inputApprover]);
      await submit(mixed.id);
      expect(await taskOn(engApprover, mixed.id)).toBeUndefined();
      expect(await taskOn(inputApprover, mixed.id)).toBeDefined();
      // A batch of the approver's own department is theirs.
      const own = await ok<{ id: string }>(await enter(periods['2026-07']!, [line(e1, { effectiveDate: '2026-07-12' })]), 201);
      await submit(own.id);
      expect(await taskOn(engApprover, own.id)).toBeDefined();
    } finally {
      await reviewers(h, hr, 'payroll_input_batch', [preparer, inputApprover2, inputApprover]);
    }
  });

  it('never drops an approved input silently: inputs a record does not take wait for an approver’s documented resolution (H2)', async () => {
    const dept = await department('IN_DISCREPANCY');
    const e = await paid(dept);
    const excluded = await paid(dept, '25000');
    const period = periods['2026-08']!;
    // An input entered under another calendar's period of the same month.
    const other = (await calendar(h, configA, configB, [{ code: 'ALT-2026-08', start: '2026-08-01', end: '2026-08-31' }])).periods['ALT-2026-08']!;
    const elsewhere = await ok<{ id: string }>(await enter(other, [line(e, { effectiveDate: '2026-08-10' })]), 201);
    await submit(elsewhere.id);
    await ok(await decideBatch(elsewhere.id, 'APPROVE'));
    // An approved input for an employee whose calculation an approved stop excludes.
    const doc = await evidenceDocument(h, uploader, verifier, excluded);
    const stop = await ok<{ id: string }>(
      await h.call(stopMaker, 'POST', `/v1/payroll/periods/${period}/salary-stops`, {
        employeeId: excluded,
        mode: 'EXCLUDE_CALCULATION',
        reason: 'Synthetic exclusion reason',
        evidenceReference: 'SYNTH-CASE-2',
        evidenceDocumentIds: [doc],
      }),
      201,
    );
    await ok(await h.call(stopDecider, 'POST', `/v1/payroll/stop-tasks/${(await stopTask(stopDecider, stop.id))!}/decision`, { decision: 'APPROVE', confirmMode: 'EXCLUDE_CALCULATION', idempotencyKey: key() }));
    const forExcluded = await ok<{ id: string }>(await enter(period, [line(excluded, { effectiveDate: '2026-08-12' })]), 201);
    await submit(forExcluded.id);
    await ok(await decideBatch(forExcluded.id, 'APPROVE'));

    const run = await createRun(h, preparer, period, { departmentIds: [dept] });
    const calculated = await calculate(h, preparer, run.id);
    expect(calculated).toMatchObject({ records: { CALCULATED: 1, EXCLUDED: 1 }, exceptions: { unresolved: 2 } });
    const re = await record(h, preparer, run.id, e);
    expect(re).toMatchObject({ calculationStatus: 'CALCULATED', net: '30000.0000', inputs: [] });
    const other1 = re.exceptions.find((x) => x.code === 'INPUTS_OTHER_PERIOD')!;
    expect(other1).toMatchObject({ severity: 'BLOCKING', resolvable: true, detail: { inputs: 1, periodCodes: ['ALT-2026-08'] } });
    const rx = await record(h, preparer, run.id, excluded);
    const notIncluded = rx.exceptions.find((x) => x.code === 'INPUTS_NOT_INCLUDED')!;
    expect(notIncluded).toMatchObject({ severity: 'BLOCKING', resolvable: true, detail: { inputs: 1 } });
    // Approval waits for the payroll approver's documented resolution of each discrepancy (H2), never for a hold.
    await ok(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/submit`, { expectedVersion: calculated.version }));
    await ok(await h.call(reviewer, 'POST', `/v1/payroll/run-tasks/${await taskOf(h, reviewer, run.id, 'REVIEW')}/review`, { decision: 'APPROVE', idempotencyKey: key() }));
    const approvalTask = await taskOf(h, approver, run.id, 'APPROVAL');
    expect((await h.call(approver, 'POST', `/v1/payroll/run-tasks/${approvalTask}/approve`, { decision: 'APPROVE', idempotencyKey: key() })).json()).toMatchObject({
      error: 'EXCEPTIONS_UNRESOLVED',
      details: { exceptions: [{ code: 'INPUTS_NOT_INCLUDED', n: 1 }, { code: 'INPUTS_OTHER_PERIOD', n: 1 }] },
    });
    for (const x of [other1, notIncluded]) {
      await ok(await h.call(approver, 'POST', `/v1/payroll/runs/${run.id}/exceptions/${x.id}/resolve`, { resolution: 'Confirmed with the input owner (synthetic)' }));
    }
    expect(await ok(await h.call(approver, 'POST', `/v1/payroll/run-tasks/${approvalTask}/approve`, { decision: 'APPROVE', idempotencyKey: key() }))).toMatchObject({ state: 'APPROVED' });
    await processRun(h, processor, run.id);
    // The inputs stay approved and unconsumed (no payment from them here) and no hold was created for them.
    const inputs = (await h.db.query<{ state: string; consumed_record_id: string | null }>(`select state, consumed_record_id from payroll_input where employee_id = any($1::uuid[])`, [[e, excluded]])).rows;
    expect(inputs).toEqual([
      { state: 'APPROVED', consumed_record_id: null },
      { state: 'APPROVED', consumed_record_id: null },
    ]);
    expect((await h.db.query(`select 1 from payroll_hold where employee_id = $1 and hold_kind = 'POLICY_HOLD'`, [e])).rowCount).toBe(0);
  });

  it('feeds only approved inputs, holds approvals once the snapshot is taken, and consumes them on processing', async () => {
    const dept = await department('IN_FEED');
    const e = await paid(dept);
    const period = periods['2026-05']!;
    const approvedBatch = await ok<{ id: string }>(await enter(period, [line(e, { effectiveDate: '2026-05-10', amount: '1500.00' })]), 201);
    await submit(approvedBatch.id);
    await ok(await decideBatch(approvedBatch.id, 'APPROVE'));
    // Submitted, not yet approved: not part of the calculation.
    const waiting = await ok<{ id: string }>(await enter(period, [line(e, { effectiveDate: '2026-05-11', amount: '700.00', componentCode: 'IN_TRAVEL', inputKind: 'OTHER_INPUT' })]), 201);
    await submit(waiting.id);
    const run = await createRun(h, preparer, period, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    expect(await record(h, preparer, run.id, e)).toMatchObject({ earnings: '31500.0000', reimbursements: '0.0000', net: '31500.0000' });
    // The snapshot is taken: approving the waiting batch now would silently miss this run.
    expect((await decideBatch(waiting.id, 'APPROVE')).json().error).toBe('RUN_IN_PROGRESS');
    // Return the run to a new draft, approve, recalculate: the input is in.
    const r1 = await getRun(h, preparer, run.id);
    const next = await ok<{ id: string }>(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/revise`, { reason: 'Late approved input (synthetic)', expectedVersion: r1.version }), 201);
    await ok(await decideBatch(waiting.id, 'APPROVE'));
    await calculate(h, preparer, next.id);
    const rec = await record(h, preparer, next.id, e);
    expect(rec).toMatchObject({ earnings: '31500.0000', reimbursements: '700.0000', net: '32200.0000' });
    expect(rec.inputs.map((i) => i.componentCode).sort()).toEqual(['IN_BONUS', 'IN_TRAVEL']);
    await submitAndApprove(h, { preparer, reviewer, approver }, next.id);
    await processRun(h, processor, next.id);
    const consumed = (await h.db.query<{ consumed_record_id: string | null }>(`select consumed_record_id from payroll_input where employee_id = $1 order by amount`, [e])).rows;
    expect(consumed.every((c) => c.consumed_record_id === rec.id)).toBe(true);
    // Consumed inputs stay as the frozen record took them (CI25).
    await expect(h.db.query(`update payroll_input set amount = amount + 1 where employee_id = $1`, [e])).rejects.toThrow(/immutable/);
    await expect(h.db.query(`update payroll_input set consumed_record_id = null where employee_id = $1`, [e])).rejects.toThrow(/stays consumed/);
    // A processed month takes no more inputs.
    expect((await enter(period, [line(e, { effectiveDate: '2026-05-20' })])).json().details.errors).toEqual([{ row: 1, code: 'PERIOD_PROCESSED' }]);
    // Amounts stay out of operational audit values and outbox payloads.
    const trail = await trailText(h, A.id);
    expect(trail.operational).not.toContain('1500.00');
    expect(trail.outbox).not.toContain('1500.00');
  });

  describe('controlled reversal of an approved input (DF03)', () => {
    const reverse = async (a: TestActor, batchId: string, inputIds: string[], reason = 'Approved in error (synthetic)', expectedVersion?: number) =>
      h.call(a, 'POST', `/v1/payroll/input-batches/${batchId}/reverse`, {
        inputIds,
        reason,
        expectedVersion: expectedVersion ?? (await ok<{ version: number }>(await h.call(preparer, 'GET', `/v1/payroll/input-batches/${batchId}`))).version,
      });
    const approvedBatch = async (period: string, lines: unknown[]) => {
      const b = await ok<{ id: string }>(await enter(period, lines), 201);
      await submit(b.id);
      await ok(await decideBatch(b.id, 'APPROVE'));
      return b.id;
    };
    const linesOf = async (batchId: string) => (await h.db.query<{ id: string; employee_id: string; state: string; reference: string }>(`select id, employee_id, state, reference from payroll_input where batch_id = $1 order by reference`, [batchId])).rows;

    it('reverses chosen lines with a reason; the next calculation leaves them out, their references are free and the batch stays approved', async () => {
      const dept = await department('IN_REVERSE');
      const wrong = await paid(dept);
      const right = await paid(dept);
      const period = periods['2026-06']!;
      const wrongLine = line(wrong, { effectiveDate: '2026-06-10', amount: '900.00' });
      const batchId = await approvedBatch(period, [wrongLine, line(right, { effectiveDate: '2026-06-10', amount: '250.00' })]);
      const lines = await linesOf(batchId);
      const a = lines.find((l) => l.employee_id === wrong)!;
      const c = lines.find((l) => l.employee_id === right)!;

      // A reason is required: the service trims what the schema lets through.
      expect((await reverse(inputApprover, batchId, [a.id], '   ')).json().error).toBe('REASON_REQUIRED');
      const view = await ok<{ state: string; reversedLines: number; version: number; lines: { id: string; state: string; reversalReason: string | null; reversedBy: string | null; reversedAt: string | null }[] }>(
        await reverse(inputApprover, batchId, [a.id]),
      );
      expect(view).toMatchObject({ state: 'APPROVED', reversedLines: 1 });
      expect(view.lines.find((l) => l.id === a.id)).toMatchObject({ state: 'REVERSED', reversalReason: 'Approved in error (synthetic)', reversedBy: inputApprover.user });
      expect(view.lines.find((l) => l.id === c.id)).toMatchObject({ state: 'APPROVED', reversalReason: null });

      // Once only, and an older view of the batch is stale.
      expect((await reverse(inputApprover, batchId, [a.id])).json().error).toBe('INVALID_STATE');
      expect((await reverse(inputApprover, batchId, [c.id], 'x', view.version - 1)).json().error).toBe('STALE_VERSION');

      // Audited with the reason and the amount in its confidential group; the outbox and operational values carry no amount.
      const entry = await h.one<{ reason: string; operational: { reversedLines: number; inputIds: string[] }; amount: { total: string } }>(
        `select reason, after_values -> 'operational' as operational, after_values -> 'amount' as amount from audit_event where record_key = $1 and action = 'REVERSE_LINES'`,
        [batchId],
      );
      expect(entry).toMatchObject({ reason: 'Approved in error (synthetic)', operational: { reversedLines: 1, inputIds: [a.id] } });
      expect(Number(entry.amount.total)).toBe(900);
      const event = await h.one<{ payload: Record<string, unknown> }>(`select payload from outbox_event where topic = 'payroll_inputs.reversed' and aggregate_id = $1`, [batchId]);
      expect(event.payload).toEqual({ batchId, lines: 1 });
      // The preparer is told through the batch decision's template: counts and the period, nothing confidential.
      expect(await PAYROLL_EVENTS['payroll_inputs.reversed']!(h.pool, { companyId: A.id, topic: 'payroll_inputs.reversed', aggregateId: batchId, payload: event.payload })).toMatchObject({
        eventType: 'PAYROLL_INPUTS_DECIDED',
        beneficiaryUserId: preparer.user,
        data: { lineCount: '2', periodCode: '2026-06', outcome: 'changed: 1 approved line was reversed' },
      });

      // A corrected line takes the same reference through entry and approval again.
      const corrected = await approvedBatch(period, [{ ...wrongLine, amount: '90.00' }]);
      const run = await createRun(h, preparer, period, { departmentIds: [dept] });
      await calculate(h, preparer, run.id);
      const rec = await record(h, preparer, run.id, wrong);
      expect(rec.inputs.map((i) => [i.reference, i.amount])).toEqual([[wrongLine.reference, '90.0000']]);
      expect(rec).toMatchObject({ earnings: '30090.0000' });
      expect((await record(h, preparer, run.id, right)).earnings).toBe('30250.0000');
      expect((await linesOf(corrected))[0]!.state).toBe('APPROVED');
      // The processing check of the snapshot agrees: the reversed line is neither a new nor a dropped input.
      await submitAndApprove(h, { preparer, reviewer, approver }, run.id);
      await processRun(h, processor, run.id);
      expect((await h.one<{ consumed_record_id: string | null }>(`select consumed_record_id from payroll_input where id = $1`, [a.id])).consumed_record_id).toBeNull();
    });

    it('is decided by someone independent with the approval duty: never the preparer or the employee, always within scope', async () => {
      const dept = await department('IN_REV_WHO');
      const other = await department('IN_REV_WHO2');
      const e = await paid(dept);
      const out = await paid(other);
      const period = periods['2026-07']!;
      const batchId = await approvedBatch(period, [line(e, { effectiveDate: '2026-07-10' }), line(out, { effectiveDate: '2026-07-10' })]);
      const lines = await linesOf(batchId);
      const mine = lines.find((l) => l.employee_id === e)!;
      const theirs = lines.find((l) => l.employee_id === out)!;

      // The preparer holds the approval duty too, so independence refuses it; without the duty the route refuses.
      expect((await reverse(preparer, batchId, [mine.id])).json().error).toBe('NOT_INDEPENDENT');
      expect((await reverse(hr, batchId, [mine.id])).statusCode).toBe(403);
      // Outside the approver's row scope, as a whole: nothing is reversed.
      const narrow = await h.actor(A, 'HR_ADMINISTRATOR', { extra: INPUT_APPROVE, departmentFilter: dept });
      expect((await reverse(narrow, batchId, [mine.id, theirs.id])).json().error).toBe('SCOPE_INCOMPLETE');
      // The approver is the employee of a chosen line.
      const self = await h.actor(A, 'HR_ADMINISTRATOR', { extra: INPUT_APPROVE, employeeId: e });
      expect((await reverse(self, batchId, [mine.id])).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
      // A line of another batch; another company.
      const elsewhere = await ok<{ id: string }>(await enter(period, [line(e, { effectiveDate: '2026-07-11' })]), 201);
      expect((await reverse(inputApprover, elsewhere.id, [mine.id])).json().error).toBe('INVALID_STATE');
      const otherBatch = await approvedBatch(period, [line(e, { effectiveDate: '2026-07-12' })]);
      expect((await reverse(inputApprover, otherBatch, [mine.id])).json().error).toBe('NOT_A_LINE');
      const foreign = await h.actor(B, 'HR_ADMINISTRATOR', { extra: INPUT_APPROVE });
      const res = await h.call(foreign, 'POST', `/v1/payroll/input-batches/${batchId}/reverse`, { inputIds: [mine.id], reason: 'x', expectedVersion: 1 });
      expect(res.statusCode).toBe(404);
      expect((await linesOf(batchId)).map((l) => l.state)).toEqual(['APPROVED', 'APPROVED']);
      // Only a scoped, independent approver reverses, and only the chosen line.
      expect((await ok<{ reversedLines: number }>(await reverse(narrow, batchId, [mine.id]))).reversedLines).toBe(1);
      // The database holds the same rules: never a preparer, never the employee, and a reversal is final.
      const batch = await h.one<{ prepared_by: string }>(`select prepared_by from payroll_input_batch where id = $1`, [batchId]);
      const write = (id: string, by: string) => h.db.query(`update payroll_input set state = 'REVERSED', reversed_at = now(), reversed_by = $2, reversal_reason = 'x' where id = $1`, [id, by]);
      await expect(write(theirs.id, batch.prepared_by)).rejects.toThrow(/independent/);
      await expect(h.db.query(`update payroll_input set state = 'APPROVED', reversed_at = null, reversed_by = null, reversal_reason = null where id = $1`, [mine.id])).rejects.toThrow(/final/);
      // A reversal is recorded complete, never half.
      await expect(h.db.query(`update payroll_input set state = 'REVERSED' where id = $1`, [theirs.id])).rejects.toThrow(/payroll_input_reversal_recorded/);
    });

    it('applies only before a run has used the input: a revision holding it is returned first, a consumed input is refused', async () => {
      const dept = await department('IN_REV_RUN');
      const e = await paid(dept);
      const period = periods['2026-08']!;
      const batchId = await approvedBatch(period, [line(e, { effectiveDate: '2026-08-10', amount: '800.00' })]);
      const [held] = await linesOf(batchId);
      const run = await createRun(h, preparer, period, { departmentIds: [dept] });
      // A draft revision whose calculation has not started holds nothing yet, so it is only the snapshot that refuses.
      await calculate(h, preparer, run.id);
      expect((await reverse(inputApprover, batchId, [held!.id])).json()).toMatchObject({ error: 'RUN_IN_PROGRESS', details: { employees: 1 } });
      // The database refuses too: a snapshot never holds an input that is no longer approved.
      await expect(
        h.db.query(`update payroll_input set state = 'REVERSED', reversed_at = now(), reversed_by = $2, reversal_reason = 'x' where id = $1`, [held!.id, inputApprover.user]),
      ).rejects.toThrow(/live run revision/);
      const r1 = await getRun(h, preparer, run.id);
      const next = await ok<{ id: string }>(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/revise`, { reason: 'Wrong input (synthetic)', expectedVersion: r1.version }), 201);
      expect((await ok<{ reversedLines: number }>(await reverse(inputApprover, batchId, [held!.id]))).reversedLines).toBe(1);
      await calculate(h, preparer, next.id);
      const rec = await record(h, preparer, next.id, e);
      expect(rec).toMatchObject({ earnings: '30000.0000', inputs: [] });
      await submitAndApprove(h, { preparer, reviewer, approver }, next.id);
      await processRun(h, processor, next.id);

      // Used by a processed run: refused here and in the database; corrections are later adjustments.
      const dept2 = await department('IN_REV_DONE');
      const f = await paid(dept2);
      const used = await approvedBatch(periods['2026-09']!, [line(f, { effectiveDate: '2026-09-10' })]);
      const [consumed] = await linesOf(used);
      const paidRun = await createRun(h, preparer, periods['2026-09']!, { departmentIds: [dept2] });
      await calculate(h, preparer, paidRun.id);
      await submitAndApprove(h, { preparer, reviewer, approver }, paidRun.id);
      await processRun(h, processor, paidRun.id);
      expect((await reverse(inputApprover, used, [consumed!.id])).json().error).toBe('INPUT_CONSUMED');
      await expect(
        h.db.query(`update payroll_input set state = 'REVERSED', reversed_at = now(), reversed_by = $2, reversal_reason = 'x' where id = $1`, [consumed!.id, inputApprover.user]),
      ).rejects.toThrow(/never reversed/);
    });

    it('refuses a draft or submitted batch, which its preparer cancels instead', async () => {
      const e = await paid(await department('IN_REV_OPEN'));
      const b = await ok<{ id: string }>(await enter(periods['2026-10']!, [line(e, { effectiveDate: '2026-10-10' })]), 201);
      const [l] = await linesOf(b.id);
      expect((await reverse(inputApprover, b.id, [l!.id])).json().error).toBe('INVALID_STATE');
      await submit(b.id);
      expect((await reverse(inputApprover, b.id, [l!.id])).json().error).toBe('INVALID_STATE');
    });
  });

  it('stops a salary only as the approver explicitly approves it: withholding needs an active criterion, exclusion is exceptional', async () => {
    const dept = await department('IN_STOP');
    const held = await paid(dept, '20000');
    const excluded = await paid(dept, '25000');
    const period = periods['2026-06']!;
    const docHeld = await evidenceDocument(h, uploader, verifier, held);
    const docExcluded = await evidenceDocument(h, uploader, verifier, excluded);
    const unverified = await evidenceDocument(h, uploader, verifier, held, { verify: false });
    const propose = (a: TestActor, body: Record<string, unknown>) =>
      h.call(a, 'POST', `/v1/payroll/periods/${period}/salary-stops`, { reason: 'Synthetic stop reason', evidenceReference: 'SYNTH-CASE-1', ...body });
    // DF05: the default mode withholds disbursement, which under H2 needs an active criterion; none is active.
    expect((await propose(stopMaker, { employeeId: held, evidenceDocumentIds: [docHeld] })).json().error).toBe('HOLD_CRITERION_NOT_ACTIVE');
    const crit = await criterion(h, configA, configB, { scopeMode: 'FULL_ONLY' });
    expect((await propose(stopMaker, { employeeId: held, criterionId: crit, evidenceDocumentIds: [docHeld] })).json().error).toBe('RELEASE_CRITERION_REQUIRED');
    // Evidence is released, verified documents of the employee concerned.
    expect((await propose(stopMaker, { employeeId: held, criterionId: crit, releaseCriterion: 'Clearance done', evidenceDocumentIds: [] })).json().error).toBe('EVIDENCE_REQUIRED');
    expect((await propose(stopMaker, { employeeId: held, criterionId: crit, releaseCriterion: 'Clearance done', evidenceDocumentIds: [unverified] })).json().error).toBe('EVIDENCE_NOT_VERIFIED');
    expect((await propose(stopMaker, { employeeId: held, criterionId: crit, releaseCriterion: 'Clearance done', evidenceDocumentIds: [docExcluded] })).json().error).toBe('INVALID_EVIDENCE');
    const k = key('stop-');
    const stop = await ok<{ id: string; mode: string; state: string; evidence: unknown[] }>(
      await propose(stopMaker, { employeeId: held, criterionId: crit, releaseCriterion: 'Clearance done', evidenceDocumentIds: [docHeld], idempotencyKey: k }),
      201,
    );
    expect(stop).toMatchObject({ mode: 'HOLD_DISBURSEMENT', state: 'SUBMITTED' });
    expect(stop.evidence).toHaveLength(1);
    // A replayed proposal returns the same stop.
    expect(await ok(await propose(stopMaker, { employeeId: held, criterionId: crit, releaseCriterion: 'Clearance done', evidenceDocumentIds: [docHeld], idempotencyKey: k }))).toMatchObject({
      id: stop.id,
      replayed: true,
    });
    // The maker is first on the list but never gets their own proposal; the decider confirms the mode explicitly.
    expect(await stopTask(stopMaker, stop.id)).toBeUndefined();
    const t1 = (await stopTask(stopDecider, stop.id))!;
    expect((await h.call(stopDecider, 'POST', `/v1/payroll/stop-tasks/${t1}/decision`, { decision: 'APPROVE', idempotencyKey: key() })).json().error).toBe('MODE_NOT_CONFIRMED');
    expect(await ok(await h.call(stopDecider, 'POST', `/v1/payroll/stop-tasks/${t1}/decision`, { decision: 'APPROVE', confirmMode: 'HOLD_DISBURSEMENT', idempotencyKey: key() }))).toMatchObject({
      state: 'APPROVED',
    });
    const exclusion = await ok<{ id: string }>(await propose(stopMaker, { employeeId: excluded, mode: 'EXCLUDE_CALCULATION', evidenceDocumentIds: [docExcluded] }), 201);
    const t2 = (await stopTask(stopDecider, exclusion.id))!;
    expect((await h.call(stopDecider, 'POST', `/v1/payroll/stop-tasks/${t2}/decision`, { decision: 'APPROVE', confirmMode: 'HOLD_DISBURSEMENT', idempotencyKey: key() })).json().error).toBe(
      'MODE_NOT_CONFIRMED',
    );
    await ok(await h.call(stopDecider, 'POST', `/v1/payroll/stop-tasks/${t2}/decision`, { decision: 'APPROVE', confirmMode: 'EXCLUDE_CALCULATION', idempotencyKey: key() }));
    expect((await h.one<{ approved_mode: string }>(`select approved_mode from payroll_salary_stop where id = $1`, [exclusion.id])).approved_mode).toBe('EXCLUDE_CALCULATION');

    const run = await createRun(h, preparer, period, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    // The interpretation of each stop is explicit in the result.
    const rh = await record(h, preparer, run.id, held);
    expect(rh).toMatchObject({ calculationStatus: 'CALCULATED', net: '20000.0000' });
    expect(rh.exceptions.map((x) => x.code)).toContain('SALARY_STOP_HOLD');
    const rx = await record(h, preparer, run.id, excluded);
    expect(rx).toMatchObject({ calculationStatus: 'EXCLUDED', net: null, lines: [] });
    expect(rx.exceptions.map((x) => x.code)).toContain('SALARY_STOP_EXCLUDED');
    // Once the snapshot is taken an approved stop is not revoked under the run's feet.
    const s = await ok<{ version: number }>(await h.call(stopDecider, 'GET', `/v1/payroll/salary-stops/${stop.id}`));
    expect((await h.call(stopDecider, 'POST', `/v1/payroll/salary-stops/${stop.id}/revoke`, { reason: 'x', expectedVersion: s.version })).json().error).toBe('RUN_IN_PROGRESS');

    await submitAndApprove(h, { preparer, reviewer, approver }, run.id);
    await processRun(h, processor, run.id);
    expect((await h.db.query<{ state: string }>(`select state from payroll_salary_stop where id = any($1::uuid[]) order by state`, [[stop.id, exclusion.id]])).rows.map((x) => x.state)).toEqual([
      'APPLIED',
      'APPLIED',
    ]);
    // The withholding stop became a full active hold of the processed record; the exclusion created none.
    const holdsOf = async (e: string) =>
      (await h.db.query<{ hold_kind: string; state: string; hold_amount: string }>(`select hold_kind, state, hold_amount from payroll_hold where employee_id = $1 order by hold_kind`, [e])).rows;
    expect(await holdsOf(held)).toEqual([{ hold_kind: 'SALARY_STOP', state: 'APPROVED_ACTIVE', hold_amount: '20000.0000' }]);
    expect(await holdsOf(excluded)).toEqual([]);
    // The stop's private reason is not in operational audit values, outbox payloads or notifications.
    const trail = await trailText(h, A.id);
    expect(trail.operational).not.toContain('Synthetic stop reason');
    expect(trail.outbox).not.toContain('Synthetic stop reason');
  });
});
