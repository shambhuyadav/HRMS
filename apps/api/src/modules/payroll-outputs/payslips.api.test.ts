// Issued payslips, the Employee OWN payslip tab, payroll reports and statutory outputs over HTTP (FR-107; DB117; H3
// TN06/TN07; CI30; ZT39 issued-output cases; FR-038; FR-039). Synthetic employees and amounts only.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import {
  APPROVE,
  calculate,
  calendar,
  CONFIG,
  createRun,
  head,
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
  trailText,
  verifiedBank,
} from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';

const BANK_REVIEW = ['sensitive_change.review.private', 'sensitive_change.read.private', 'employee.read.private', 'employee.read.bank', 'document.read.document', 'document.verify.document'] as const;
const OUT_READ: PermissionKey[] = ['payroll_output.read.amount'];
const OUT_PUBLISH: PermissionKey[] = ['payroll_output.read.amount', 'payroll_output.publish.amount'];
const REPORT: PermissionKey[] = ['payroll_report.read.amount'];

interface Own {
  items: { id: string; periodCode: string; version: number; publicationState: string; label: string; payment: { earned: string; held: string; reserved: string; paid: string } | null }[];
  form16: { status: string };
}

describe.runIf(isModuleActive('payroll-outputs'))('issued payslips, reports and statutory outputs (FR-107, FR-038, FR-039)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let bankReviewer: TestActor;
  let publisher: TestActor;
  let reader: TestActor;
  let periods: Record<string, string>;
  const people: Record<string, TestActor> = {};

  const department = async (code: string) => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
  const paid = async (dept: string, amount: string, joiningDate = '2025-12-01') => {
    const e = await person(h, A, hr, { departmentId: dept, joiningDate });
    await salary(h, preparer, e, { effectiveFrom: joiningDate, monthlyGross: amount, components: [{ code: 'PS_BASIC', amount }] });
    people[e] = await h.actor(A, 'EMPLOYEE', { employeeId: e });
    await verifiedBank(h, A, bankReviewer, e, people[e]);
    return e;
  };
  const processed = async (month: string, dept: string, employees: string[], opts: { process?: boolean } = {}) => {
    const run = await createRun(h, preparer, periods[month]!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    const ids: Record<string, string> = {};
    for (const e of employees) ids[e] = (await record(h, preparer, run.id, e)).id;
    if (opts.process !== false) {
      await submitAndApprove(h, { preparer, reviewer, approver }, run.id);
      await processRun(h, processor, run.id);
    }
    return { runId: run.id, records: ids };
  };
  const publishAll = async (a: TestActor, runId: string) => {
    for (let i = 0; i < 20; i++) {
      const res = await h.call(a, 'POST', `/v1/payroll-outputs/runs/${runId}/payslips/publish`);
      if (res.statusCode !== 202) return ok<{ published: number; remaining: number; ownRecordLeftForAnotherPublisher: number; done: boolean }>(res);
    }
    throw new Error('publication did not complete');
  };
  const runPayslips = async (a: TestActor, runId: string) =>
    (await ok<{ items: { id: string; employeeId: string; version: number; publicationState: string; contentHash: string; rowVersion: number }[] }>(await h.call(a, 'GET', `/v1/payroll-outputs/runs/${runId}/payslips`))).items;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...PREPARE, ...SALARY] });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    bankReviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...BANK_REVIEW] });
    publisher = await h.actor(A, 'HR_ADMINISTRATOR', { extra: OUT_PUBLISH });
    reader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...OUT_READ, ...REPORT] });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await reviewers(h, hr, 'sensitive_change', [bankReviewer]);
    await head(h, configA, configB, { code: 'PS_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('publishes versioned payslips of processed records only; the employee downloads only their own issued versions (FR-107, CI30)', async () => {
    const dept = await department('PS_MAIN');
    const e1 = await paid(dept, '31000');
    // DF05 mid-month joining: 20000 x 17/31 = 10967.741... -> 10967.74 (half-up per component).
    const e2 = await paid(dept, '20000', '2026-01-15');
    const e3 = await paid(dept, '25000');
    const draft = await processed('2026-01', dept, [e1, e2, e3], { process: false });
    // Calculation previews: HR only, labelled not issued; never the employee; nothing before processing is published.
    const preview = await ok<{ label: string; issued: boolean; content: { totals: { net: string } } }>(await h.call(reader, 'GET', `/v1/payroll-outputs/records/${draft.records[e1]}/payslip-preview`));
    expect(preview).toMatchObject({ label: 'PREVIEW_NOT_ISSUED', issued: false, content: { totals: { net: '31000.0000' } } });
    expect((await h.call(people[e1]!, 'GET', `/v1/payroll-outputs/records/${draft.records[e1]}/payslip-preview`)).statusCode).toBe(403);
    expect((await h.call(publisher, 'POST', `/v1/payroll-outputs/runs/${draft.runId}/payslips/publish`)).json().error).toBe('RUN_NOT_PROCESSED');
    await submitAndApprove(h, { preparer, reviewer, approver }, draft.runId);
    await processRun(h, processor, draft.runId);
    const runId = draft.runId;

    // Access: no grant, a reader without publish, the Employee context.
    expect((await h.call(hr, 'POST', `/v1/payroll-outputs/runs/${runId}/payslips/publish`)).statusCode).toBe(403);
    expect((await h.call(reader, 'POST', `/v1/payroll-outputs/runs/${runId}/payslips/publish`)).statusCode).toBe(403);
    expect((await h.call(people[e1]!, 'POST', `/v1/payroll-outputs/runs/${runId}/payslips/publish`)).statusCode).toBe(403);
    // A publisher whose own salary is in the run publishes everyone else's and leaves their own for another publisher.
    const own = await h.actor(A, 'HR_ADMINISTRATOR', { extra: OUT_PUBLISH, user: people[e3]!.user });
    expect(await publishAll(own, runId)).toMatchObject({ published: 2, remaining: 0, ownRecordLeftForAnotherPublisher: 1, done: true });
    expect(await publishAll(publisher, runId)).toMatchObject({ published: 1, remaining: 0, done: true });
    // Idempotent: a second publication finds nothing to publish.
    expect(await publishAll(publisher, runId)).toMatchObject({ published: 0, done: true });
    const issued = await runPayslips(reader, runId);
    expect(issued.map((o) => [o.employeeId, o.version, o.publicationState]).sort()).toEqual(
      [
        [e1, 1, 'ISSUED'],
        [e2, 1, 'ISSUED'],
        [e3, 1, 'ISSUED'],
      ].sort(),
    );
    const o1 = issued.find((o) => o.employeeId === e1)!;
    const o2 = issued.find((o) => o.employeeId === e2)!;

    // TN06: own issued payslips; earned, held and paid distinct (nothing paid: no confirmed payment evidence).
    const mine = await ok<Own>(await h.call(people[e2]!, 'GET', '/v1/me/payslips'));
    expect(mine.items).toEqual([expect.objectContaining({ id: o2.id, periodCode: '2026-01', version: 1, label: 'CURRENT', payment: { earned: '10967.7400', held: '0.0000', reserved: '0.0000', paid: '0.0000' } })]);
    expect(mine.form16).toMatchObject({ status: 'NOT_CONFIGURED' });
    const file = await h.call(people[e2]!, 'GET', `/v1/me/payslips/${o2.id}/file`);
    expect(file.statusCode).toBe(200);
    expect(createHash('sha256').update(file.rawPayload).digest('hex')).toBe(o2.contentHash);
    const doc = JSON.parse(file.body) as { document: string; totals: { net: string }; paidDays: string; daysInMonth: number; lines: { componentCode: string; amount: string }[]; notices: string[] };
    expect(doc).toMatchObject({ document: 'PAYSLIP', paidDays: '17.0000', daysInMonth: 31, totals: { net: '10967.7400' }, lines: [{ componentCode: 'PS_BASIC', amount: '10967.7400' }] });
    expect(doc.notices.join(' ')).toMatch(/does not imply payment/);
    // Another employee's output, a crafted id or another company's context reads as missing.
    expect((await h.call(people[e2]!, 'GET', `/v1/me/payslips/${o1.id}/file`)).statusCode).toBe(404);
    expect((await h.call(people[e2]!, 'GET', '/v1/me/payslips/00000000-0000-4000-8000-000000000009/file')).statusCode).toBe(404);
    const strangerEmployee = await person(h, B, await h.actor(B, 'HR_ADMINISTRATOR'));
    const stranger = await h.actor(B, 'EMPLOYEE', { employeeId: strangerEmployee });
    expect((await h.call(stranger, 'GET', `/v1/me/payslips/${o2.id}/file`)).statusCode).toBe(404);
    expect((await ok<Own>(await h.call(stranger, 'GET', '/v1/me/payslips'))).items).toEqual([]);
    // Own outputs only in the Employee OWN context: an administrator linked to e2 gets nothing through the HR routes.
    const linkedAdmin = await h.actor(A, 'HR_ADMINISTRATOR', { extra: OUT_READ, user: people[e2]!.user });
    expect((await h.call(linkedAdmin, 'GET', '/v1/me/payslips')).statusCode).toBe(403);
    expect((await h.call(linkedAdmin, 'GET', `/v1/payroll-outputs/payslips/${o2.id}/file`)).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    // HR download within row scope: a department-filtered reader outside the department reads it as missing.
    expect((await h.call(reader, 'GET', `/v1/payroll-outputs/payslips/${o1.id}/file`)).statusCode).toBe(200);
    const narrow = await h.actor(A, 'HR_ADMINISTRATOR', { extra: OUT_READ, departmentFilter: A.dept });
    expect((await h.call(narrow, 'GET', `/v1/payroll-outputs/payslips/${o1.id}/file`)).statusCode).toBe(404);

    // A replacement version keeps the earlier issue, labelled SUPERSEDED; nobody reissues their own payslip.
    expect((await h.call(publisher, 'POST', `/v1/payroll-outputs/payslips/${o2.id}/reissue`, { reason: 'x', expectedVersion: o2.rowVersion + 5 })).json().error).toBe('STALE_VERSION');
    const ownE3 = issued.find((o) => o.employeeId === e3)!;
    expect((await h.call(own, 'POST', `/v1/payroll-outputs/payslips/${ownE3.id}/reissue`, { reason: 'Synthetic', expectedVersion: ownE3.rowVersion })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    const v2 = await ok<{ id: string; version: number; publicationState: string; supersedesOutputId: string }>(
      await h.call(publisher, 'POST', `/v1/payroll-outputs/payslips/${o2.id}/reissue`, { reason: 'Synthetic layout correction', expectedVersion: o2.rowVersion }),
      201,
    );
    expect(v2).toMatchObject({ version: 2, publicationState: 'ISSUED', supersedesOutputId: o2.id });
    const after = await ok<Own>(await h.call(people[e2]!, 'GET', '/v1/me/payslips'));
    expect(after.items.map((i) => [i.version, i.publicationState, i.label])).toEqual([
      [2, 'ISSUED', 'CURRENT'],
      [1, 'SUPERSEDED', 'REPLACED'],
    ]);
    expect((await h.call(people[e2]!, 'GET', `/v1/me/payslips/${o2.id}/file`)).statusCode).toBe(200);
    expect((await h.call(publisher, 'POST', `/v1/payroll-outputs/payslips/${o2.id}/reissue`, { reason: 'x', expectedVersion: o2.rowVersion + 1 })).json().error).toBe('INVALID_STATE');

    // Database guards: issued content never changes, nothing is deleted, no tax certificate without its template.
    await expect(h.db.query(`update employee_issued_output set content_hash = $2 where id = $1`, [o1.id, 'c'.repeat(64)])).rejects.toThrow(/never changes/);
    await expect(h.db.query(`delete from employee_issued_output where id = $1`, [o1.id])).rejects.toThrow();
    await expect(
      h.db.query(
        `insert into employee_issued_output (company_id, employee_id, kind, period_id, period_code, output_version, publication_state, attachment_id, content_hash, file_name, issued_at, issued_by)
         select company_id, employee_id, 'FORM16', period_id, period_code, 1, 'ISSUED', attachment_id, content_hash, 'form16.json', now(), issued_by from employee_issued_output where id = $1`,
        [o1.id],
      ),
    ).rejects.toThrow(/statutory template/);
    // The stored file is checked against its hash on every read.
    await h.db.query(
      `update attachment set content_reference = (select a2.content_reference from attachment a2 join employee_issued_output o on o.attachment_id = a2.id where o.id = $2)
        where id = (select attachment_id from employee_issued_output where id = $1)`,
      [v2.id, o2.id],
    );
    expect((await h.call(people[e2]!, 'GET', `/v1/me/payslips/${v2.id}/file`)).json().error).toBe('FILE_INTEGRITY_FAILED');

    // The publication notice names the period and version only; no amounts anywhere in the trail.
    await dispatchOutbox(h.pool);
    const n = await h.db.query<{ body: string }>(
      `select n.body from notification n join user_employee_link l on l.user_id = n.recipient_user_id and l.company_id = n.company_id where n.company_id = $1 and l.employee_id = $2`,
      [A.id, e2],
    );
    expect(n.rows.length).toBeGreaterThanOrEqual(1);
    expect(n.rows.map((r) => r.body).join(' ')).toMatch(/2026-01/);
    const trail = await trailText(h, A.id);
    for (const t of [trail.operational, trail.outbox, trail.notifications]) {
      expect(t).not.toContain('10967.74');
      expect(t).not.toContain('31000');
    }
    // H3 TN06 is available in the Employee OWN context; TN07 stays unavailable.
    const ess = await ok<{ tabs: { id: string; status: string }[] }>(await h.call(people[e1]!, 'GET', '/v1/me/ess'));
    expect(ess.tabs.find((t) => t.id === 'TN06')?.status).toBe('AVAILABLE');
    expect(ess.tabs.find((t) => t.id === 'TN07')?.status).toBe('UNAVAILABLE');
  });

  it('reports within row scope; disbursement reconciles; JV and statutory outputs are NOT_CONFIGURED (FR-038, FR-039)', async () => {
    const d1 = await department('PS_REP1');
    const f1 = await paid(d1, '40000');
    const f2 = await paid(d1, '15000.25');
    const { runId } = await processed('2026-02', d1, [f1, f2]);
    const reg = await ok<{ scope: string; totals: { records: number; net: string; held: string; reserved: string; paid: string }; items: { employeeId: string; net: string }[] }>(
      await h.call(reader, 'GET', `/v1/payroll-outputs/runs/${runId}/register`),
    );
    expect(reg).toMatchObject({ scope: 'COMPANY', totals: { records: 2, net: '55000.2500', held: '0.0000', reserved: '0.0000', paid: '0.0000' } });
    // A department-filtered reader sees and totals only its own department (nobody of this run).
    const narrow = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REPORT, departmentFilter: A.dept });
    const nreg = await ok<{ scope: string; totals: { records: number }; items: unknown[] }>(await h.call(narrow, 'GET', `/v1/payroll-outputs/runs/${runId}/register`));
    expect(nreg).toMatchObject({ scope: 'ROW_SCOPE', totals: { records: 0 }, items: [] });
    // Company figures need the whole run in scope.
    expect((await h.call(narrow, 'GET', `/v1/payroll-outputs/runs/${runId}/disbursement`)).json().error).toBe('SCOPE_INCOMPLETE');
    const disb = await ok<{ totals: { payable: string; ready: string; reconciles: boolean }; paymentStatusSource: string }>(await h.call(reader, 'GET', `/v1/payroll-outputs/runs/${runId}/disbursement`));
    expect(disb).toMatchObject({ totals: { payable: '55000.2500', ready: '55000.2500', reconciles: true }, paymentStatusSource: 'RECORDED_OUTCOME_EVIDENCE_ONLY' });
    expect((await h.call(reader, 'GET', `/v1/payroll-outputs/runs/${runId}/comparison`)).statusCode).toBe(200);
    expect((await h.call(reader, 'GET', `/v1/payroll-outputs/runs/${runId}/journal`)).json()).toMatchObject({ error: 'NOT_CONFIGURED' });
    // Without the report grant nothing is read.
    expect((await h.call(hr, 'GET', `/v1/payroll-outputs/runs/${runId}/register`)).statusCode).toBe(403);
    expect((await h.call(people[f1]!, 'GET', `/v1/payroll-outputs/runs/${runId}/register`)).statusCode).toBe(403);
    // FR-039: every statutory output is NOT_CONFIGURED with its preserved source label.
    const treasury = await h.actor(A, 'PAYROLL_OPERATOR');
    const list = await ok<{ items: { code: string; sourceLabel: string; status: string }[] }>(await h.call(treasury, 'GET', '/v1/payroll-outputs/statutory-outputs'));
    expect(list.items.every((i) => i.status === 'NOT_CONFIGURED')).toBe(true);
    expect(list.items.map((i) => i.sourceLabel)).toEqual(expect.arrayContaining(['Form 16 / Form 130', 'Form 24Q / Form 138', 'PF register', 'ESIC register']));
    expect((await h.call(treasury, 'GET', '/v1/payroll-outputs/statutory-outputs/PF_REGISTER')).json()).toMatchObject({ error: 'NOT_CONFIGURED' });
    expect((await h.call(treasury, 'GET', '/v1/payroll-outputs/statutory-outputs/NO_SUCH_FORM')).statusCode).toBe(404);
  });
});
