// A change approved for a later date, re-checked when the daily job applies it (BR-054 "Independent approved revision
// application rechecks row scope, base version, evidence and effective date"; H4 "scheduled application must still have
// valid approval"; H2 "Conflict needs rebase and renewed approval"). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { applyDueChanges } from './service.js';

const REVIEW: `${string}.${string}.${string}`[] = ['sensitive_change.review.private', 'sensitive_change.read.private', 'employee.read.private', 'employee.read.bank'];
const pdf = Buffer.from('%PDF-1.4\n% synthetic evidence\n%%EOF\n').toString('base64');
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const NOT_CONFIRMED = 'was not applied because its approval or supporting document could not be confirmed on that date; please review and submit it again.';

describe('sensitive change: re-check at deferred application (BR-054)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let verifier: TestActor;
  let system: string;
  let on: string;

  const address = { line1: '7 Future Lane', city: 'Testville', countryCode: 'IN' };

  const person = async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { dateOfBirth: '1990-04-12' }))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return { id: e.id as string, actor: await h.actor(A, 'EMPLOYEE', { employeeId: e.id }) };
  };
  const reviewer = (opts: { departmentFilter?: string } = {}) => h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW, ...opts });
  const upload = async (a: TestActor, employeeId: string) => {
    const res = await h.call(a, 'POST', `/v1/employees/${employeeId}/documents`, { documentType: 'GENERAL', fileName: 'evidence.pdf', contentBase64: pdf });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };
  const attachmentOf = `(select attachment_id from employee_document where id = $1)`;
  /** A document as if the worker has not scanned it yet (uploads are scanned at once in tests); a verdict is final otherwise (0040). */
  const markPending = async (documentId: string) => {
    await h.db.query(`set session_replication_role = replica`);
    try {
      await h.db.query(`update attachment set scan_state = 'PENDING_SCAN', scan_checked_at = null, scan_finding = null where id = ${attachmentOf}`, [documentId]);
    } finally {
      await h.db.query(`set session_replication_role = origin`);
    }
  };
  const quarantine = (documentId: string) =>
    h.db.query(`update attachment set scan_state = 'QUARANTINED', scan_checked_at = now(), scan_finding = 'EICAR-Test-File' where id = ${attachmentOf}`, [documentId]);

  /** A change submitted, reviewed and approved by `by` for a later date: SCHEDULED, waiting for the daily job. */
  const scheduled = async (by: TestActor, employee: TestActor, category: string, values: Record<string, unknown>, evidenceDocumentIds: string[] = []) => {
    expect((await h.call(hr, 'PUT', '/v1/workflows/sensitive_change/fallback-reviewers', { reviewers: [{ userId: by.user, priority: 1 }] })).statusCode).toBe(200);
    const created = await h.call(employee, 'POST', '/v1/me/sensitive-changes', { reason: 'Synthetic update', category, effectiveDate: on, values, evidenceDocumentIds });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().requestId as string;
    expect((await h.call(employee, 'POST', `/v1/me/sensitive-changes/${id}/submit`, { expectedVersion: 1 })).json().state).toBe('SUBMITTED');
    const tasks = (await h.call(by, 'GET', '/v1/sensitive-changes/tasks/mine')).json().items as { taskId: string; request: { id: string } }[];
    const { taskId } = tasks.find((t) => t.request?.id === id)!;
    expect((await h.call(by, 'POST', `/v1/sensitive-changes/tasks/${taskId}/start-review`)).json().state).toBe('IN_REVIEW');
    const approved = await h.call(by, 'POST', `/v1/sensitive-changes/tasks/${taskId}/decision`, { idempotencyKey: uniq('sc-key-'), decision: 'APPROVE', reason: 'Checked (synthetic)' });
    expect(approved.json().state, approved.body).toBe('SCHEDULED');
    return id;
  };

  const stateOf = async (id: string) => (await h.one<{ state: string }>(`select state from employee_sensitive_change_request where id = $1`, [id])).state;
  const revisions = async (employeeId: string) => (await h.one<{ n: number }>(`select count(*)::int as n from employee_private_profile_revision where employee_id = $1`, [employeeId])).n;
  const recheckOf = async (id: string) =>
    (await h.one<{ t: string }>(`select after_values::text as t from audit_event where company_id = $1 and record_key = $2 and action = 'CONFLICT'`, [A.id, id])).t;
  const outcomeBody = async (a: TestActor) => {
    await dispatchOutbox(h.pool, 500);
    const items = (await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[];
    return items.find((n) => n.category === 'SENSITIVE_CHANGE_OUTCOME')!.body;
  };

  /** The job ends the request in CONFLICT without applying anything, and says why in the audit record. */
  const expectNotApplied = async (id: string, employeeId: string, recheck: string) => {
    expect(await applyDueChanges(h.pool, A.id, on, system)).toEqual({ due: 1, applied: 0, conflicts: 1 });
    expect(await stateOf(id)).toBe('CONFLICT');
    expect(await revisions(employeeId)).toBe(0);
    expect(await recheckOf(id)).toContain(recheck);
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['employee.create.personal', 'employee.update.personal'] });
    verifier = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['document.read.document', 'document.verify.document'] });
    system = await h.makeUser();
    const today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
    on = addDays(today, 3);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('applies when the approver and the evidence still stand, including a filtered approver still covering the employee', async () => {
    const e = await person();
    const filtered = await reviewer({ departmentFilter: A.dept });
    const documentId = await upload(e.actor, e.id);
    expect((await h.call(verifier, 'POST', `/v1/documents/${documentId}/verification`, { decision: 'VERIFIED' })).statusCode).toBe(200);
    const id = await scheduled(filtered, e.actor, 'BANK', { holderName: 'Synthetic Person', accountIdentifier: '000123456789', countryCode: 'IN' }, [documentId]);
    expect(await applyDueChanges(h.pool, A.id, on, system)).toEqual({ due: 1, applied: 1, conflicts: 0 });
    expect(await stateOf(id)).toBe('APPLIED');
    expect(await revisions(e.id)).toBe(1);
  });

  it('stops when the approver’s assignment was revoked; the employee is told and can submit again', async () => {
    const e = await person();
    const by = await reviewer();
    const id = await scheduled(by, e.actor, 'ADDRESS', address);
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where id = $1`, [by.assignment]);
    await expectNotApplied(id, e.id, 'APPROVER_ACCESS');
    // The notice neither blames the employee's details nor names the approver.
    expect(await outcomeBody(e.actor)).toBe(`Your change of address effective ${on} ${NOT_CONFIRMED}`);
    expect((await h.call(e.actor, 'POST', `/v1/me/sensitive-changes/${id}/revise`)).statusCode).toBe(201);
  });

  it('stops when the approver no longer holds the review grant', async () => {
    const e = await person();
    const by = await reviewer();
    const id = await scheduled(by, e.actor, 'ADDRESS', address);
    await h.db.query(
      `update role_assignment_permission set active = false where role_assignment_id = $1
          and permission_id = (select id from permission where resource = 'sensitive_change' and action = 'review' and field_group = 'private')`,
      [by.assignment],
    );
    await expectNotApplied(id, e.id, 'APPROVER_ACCESS');
  });

  it('stops when a transfer took the employee out of the approver’s row scope', async () => {
    const e = await person();
    const filtered = await reviewer({ departmentFilter: A.dept });
    const id = await scheduled(filtered, e.actor, 'ADDRESS', address);
    const today = addDays(on, -3);
    const moved = await h.call(hr, 'POST', `/v1/employees/${e.id}/assignment`, { departmentId: A.financeDept, locationId: A.loc, designationId: A.desig, effectiveFrom: today });
    expect(moved.statusCode, moved.body).toBe(200);
    await expectNotApplied(id, e.id, 'APPROVER_ACCESS');
  });

  it('an ASSIGNED approver’s reach was the task they decided, so the closed task alone does not stop the change', async () => {
    // Only the baseline manager role can hold a confidential grant in ASSIGNED scope; its ceiling is widened here for that.
    await h.db.query(
      `insert into role_permission (company_id, role_id, permission_id, effect)
       select $1, r.id, p.id, 'ALLOW' from role r cross join permission p
        where r.company_id = $1 and r.code = 'REPORTING_MANAGER' and p.resource || '.' || p.action || '.' || p.field_group = any($2::text[])
       on conflict do nothing`,
      [A.id, REVIEW],
    );
    const assigned = await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED', duties: REVIEW });
    const e = await person();
    const id = await scheduled(assigned, e.actor, 'ADDRESS', address);
    expect(await applyDueChanges(h.pool, A.id, on, system)).toEqual({ due: 1, applied: 1, conflicts: 0 });
    expect(await stateOf(id)).toBe('APPLIED');
    // Losing the grant still stops the next one.
    const other = await person();
    const second = await scheduled(assigned, other.actor, 'ADDRESS', address);
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where id = $1`, [assigned.assignment]);
    await expectNotApplied(second, other.id, 'APPROVER_ACCESS');
  });

  it('stops when optional evidence still waiting for its scan at approval was then quarantined', async () => {
    const e = await person();
    const documentId = await upload(e.actor, e.id);
    await markPending(documentId);
    const id = await scheduled(await reviewer(), e.actor, 'ADDRESS', address, [documentId]);
    await quarantine(documentId);
    await expectNotApplied(id, e.id, 'EVIDENCE');
    expect(await outcomeBody(e.actor)).toBe(`Your change of address effective ${on} ${NOT_CONFIRMED}`);
  });

  it('stops when optional evidence was rejected after the approval', async () => {
    const e = await person();
    const documentId = await upload(e.actor, e.id);
    const id = await scheduled(await reviewer(), e.actor, 'ADDRESS', address, [documentId]);
    expect((await h.call(verifier, 'POST', `/v1/documents/${documentId}/verification`, { decision: 'REJECTED', note: 'Synthetic rejection' })).statusCode).toBe(200);
    await expectNotApplied(id, e.id, 'EVIDENCE');
  });

  it('a changed base keeps its own reason and notice', async () => {
    const e = await person();
    const documentId = await upload(e.actor, e.id);
    expect((await h.call(verifier, 'POST', `/v1/documents/${documentId}/verification`, { decision: 'VERIFIED' })).statusCode).toBe(200);
    const id = await scheduled(await reviewer(), e.actor, 'PERSONAL', { dateOfBirth: '1991-05-20' }, [documentId]);
    // An authorised correction of the master moves the value this request was based on while it waits.
    const { version } = await h.one<{ version: number }>(`select version from employee where id = $1`, [e.id]);
    expect((await h.call(hr, 'PATCH', `/v1/employees/${e.id}`, { expectedVersion: version, dateOfBirth: '1990-04-13' })).statusCode).toBe(200);
    await expectNotApplied(id, e.id, 'BASE_CHANGED');
    expect(await outcomeBody(e.actor)).toBe(`Your change of personal details effective ${on} was not applied because your details changed meanwhile; please review and submit it again.`);
  });
});
