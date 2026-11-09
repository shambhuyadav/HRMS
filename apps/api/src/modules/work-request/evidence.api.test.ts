// Supporting evidence of work requests (FR-027; FR-106: owner and assigned reviewers read released files; CI08).
// Synthetic data only; the "infected" file carries the EICAR test string assembled at run time.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { EICAR_TEST_STRING } from '../../storage/scan.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let manager: TestActor;
let otherManager: TestActor;
let employee: TestActor;
let colleague: TestActor;
let employeeEmp: string;

const ahead = (weeks: number, isoDow: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7 * weeks);
  // In the week starting on the first Monday at least `weeks` weeks ahead, so weekdays asked for together keep their
  // order whatever day the tests run (a Tuesday run once put "Tuesday" before "Monday").
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + isoDow - 1);
  return d.toISOString().slice(0, 10);
};
const pdf = (s: string) => Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`, 'latin1').toString('base64');
const upload = async (a: TestActor, employeeId: string, content = pdf(`synthetic ${uniq('e')}`)) =>
  (await h.call(a, 'POST', `/v1/employees/${employeeId}/documents`, { documentType: 'GENERAL', fileName: 'travel-order.pdf', contentBase64: content })).json().id as string;
const submit = (body: Record<string, unknown>) => h.call(employee, 'POST', '/v1/work-requests/outdoor_duty', { purpose: 'Client site visit (synthetic)', ...body });
const taskOf = async (a: TestActor, requestId: string) => {
  const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from outdoor_duty_request where id = $1`, [requestId])).transaction_id;
  return ((await h.call(a, 'GET', '/v1/work-requests/tasks/mine')).json().items as { taskId: string; transactionId: string; summary: { requestId: string; evidence: { documentId: string }[] } }[]).find(
    (t) => t.transactionId === tx,
  );
};
const evidenceUrl = (requestId: string, documentId: string) => `/v1/work-requests/outdoor_duty/${requestId}/evidence/${documentId}/content`;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'leave_request', $2, 1, true)`, [A.id, hr.user]);
  const shiftId = (await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', bufferMinutes: 240, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] })).json().id;
  const person = async (managerId?: string) => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' });
    if (managerId) await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerId, effectiveFrom: '2026-01-05' });
    return e.id as string;
  };
  const managerEmp = await person();
  const otherManagerEmp = await person();
  employeeEmp = await person(managerEmp);
  const colleagueEmp = await person(managerEmp);
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  otherManager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: otherManagerEmp });
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
  colleague = await h.actor(A, 'EMPLOYEE', { employeeId: colleagueEmp });
});

afterAll(async () => {
  await h?.stop();
});

describe('work-request evidence (FR-027, FR-106)', () => {
  it('links the requester’s own released documents; the assigned reviewer reads them without a document grant', async () => {
    const doc = await upload(employee, employeeEmp);
    const day = ahead(2, 2);
    const res = await submit({ startDate: day, endDate: day, evidenceDocumentIds: [doc] });
    expect(res.statusCode).toBe(201);
    const requestId = res.json().requestId as string;

    const task = await taskOf(manager, requestId);
    // The task names the request it decides, so the reviewer can open its evidence route directly.
    expect(task!.summary.requestId).toBe(requestId);
    expect(task!.summary.evidence).toEqual([{ documentId: doc, documentType: 'GENERAL', scanState: 'CLEAN', verificationState: 'UNVERIFIED' }]);
    // The manager holds no document grant: the general document route refuses, the evidence route serves.
    expect((await h.call(manager, 'GET', `/v1/documents/${doc}/content`)).statusCode).toBe(403);
    const read = await h.call(manager, 'GET', evidenceUrl(requestId, doc));
    expect(read.statusCode).toBe(200);
    expect(read.headers['content-type']).toBe('application/pdf');
    expect((await h.call(employee, 'GET', evidenceUrl(requestId, doc))).statusCode).toBe(200);
    // Nobody else: a colleague, a manager not assigned, or a document that is not this request's evidence.
    expect((await h.call(colleague, 'GET', evidenceUrl(requestId, doc))).statusCode).toBe(404);
    expect((await h.call(otherManager, 'GET', evidenceUrl(requestId, doc))).statusCode).toBe(404);
    expect((await h.call(manager, 'GET', evidenceUrl(requestId, await upload(employee, employeeEmp)))).statusCode).toBe(404);
    const audit = await h.one<{ n: number }>(`select count(*)::int as n from audit_event where record_key = $1 and action = 'READ_CONTENT' and actor_user_id = $2`, [doc, manager.user]);
    expect(audit.n).toBe(1);
  });

  it('refuses another person’s document and a file the scan quarantined', async () => {
    const day = ahead(3, 3);
    const foreign = await upload(colleague, (await h.one<{ employee_id: string }>(`select l.employee_id from user_employee_link l where l.user_id = $1`, [colleague.user])).employee_id);
    expect((await submit({ startDate: day, endDate: day, evidenceDocumentIds: [foreign] })).json().error).toBe('INVALID_EVIDENCE');
    const infected = await upload(employee, employeeEmp, pdf(EICAR_TEST_STRING));
    expect((await submit({ startDate: day, endDate: day, evidenceDocumentIds: [infected] })).json().error).toBe('EVIDENCE_UNUSABLE');
  });

  it('a resubmission carries the earlier evidence forward unless new documents are given', async () => {
    const first = await upload(employee, employeeEmp);
    const day = ahead(4, 4);
    const requestId = (await submit({ startDate: day, endDate: day, evidenceDocumentIds: [first] })).json().requestId as string;
    const task = await taskOf(manager, requestId);
    await h.call(manager, 'POST', `/v1/work-requests/tasks/${task!.taskId}/decision`, { decision: 'RETURN', reason: 'Synthetic: add the visit order', idempotencyKey: uniq('wr-ev-') });
    const version = (await h.one<{ version: number }>(`select version from outdoor_duty_request where id = $1`, [requestId])).version;
    const resubmitted = await h.call(employee, 'PUT', `/v1/work-requests/outdoor_duty/${requestId}`, { startDate: day, endDate: day, purpose: 'Client site visit (synthetic)', expectedVersion: version });
    expect(resubmitted.json()).toMatchObject({ revision: 2, state: 'SUBMITTED' });
    expect((await taskOf(manager, requestId))!.summary.evidence.map((e) => e.documentId)).toEqual([first]);
    const links = await h.db.query<{ r: number }>(`select transaction_revision as r from transaction_evidence where document_id = $1 order by r`, [first]);
    expect(links.rows.map((x) => x.r)).toEqual([1, 2]);
  });
});
