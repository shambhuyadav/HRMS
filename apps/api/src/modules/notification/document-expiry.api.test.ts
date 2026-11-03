// DF12 "document expiry" (brd-7): a daily job raises one DOCUMENT_EXPIRING notice per document on its expiry
// date (no lead time unless one is passed), sent only to users who can currently read that employee's
// documents (DF02 confidential grant, role ceiling, DB109 allowlist and row scope), naming the employee and the
// date but never the document type or file name. Synthetic data and synthetic PDF bytes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { runScheduledJobs } from '../../worker/scheduler.js';
import { runDocumentExpiry } from './reminders.js';

let h: Harness;
let A: Company;
let B: Company;
let hrDocs: TestActor; // HR with the confidential document read grant, company scope
let hrPlain: TestActor; // HR with the default duties only (no document grant)
let hrDocsFinance: TestActor; // document grant, but scope limited to the FIN department
let manager: TestActor; // the employee's manager: document reading is not in the role ceiling
let employee: TestActor; // the employee the document belongs to (no own-record exception)
let hrDocsB: TestActor; // another company's document reader
let employeeEmp: string;
let employeeCode: string;
let employeeB: string;

const DOCS = ['document.upload.document', 'document.read.document'] as const;
const pdf = Buffer.from('%PDF-1.4\n% synthetic test document\n%%EOF\n').toString('base64');
const upload = async (by: TestActor, employeeId: string, expiresOn: string | null, fileName: string) => {
  const res = await h.call(by, 'POST', `/v1/employees/${employeeId}/documents`, { documentType: 'GENERAL', fileName, contentBase64: pdf, ...(expiresOn ? { expiresOn } : {}) });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
};
const notices = async (a: TestActor) =>
  ((await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; title: string | null; body: string }[]).filter((n) => n.category === 'DOCUMENT_EXPIRING');
const noticeFor = (day: string) => `A document on the record of Synthetic Person (${employeeCode}) expires on ${day}.`;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  hrPlain = await h.actor(A, 'HR_ADMINISTRATOR');
  const person = async () => {
    const e = (await h.call(hrPlain, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return e as { id: string; employeeCode: string };
  };
  const managerEmp = (await person()).id;
  const emp = await person(); // in ENG
  employeeEmp = emp.id;
  employeeCode = emp.employeeCode;
  await h.call(hrPlain, 'POST', `/v1/employees/${employeeEmp}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
  hrDocs = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...DOCS] });
  hrDocsFinance = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...DOCS], departmentFilter: A.financeDept });
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
  hrDocsB = await h.actor(B, 'HR_ADMINISTRATOR', { extra: [...DOCS] });
  employeeB = (await h.call(hrDocsB, 'POST', '/v1/employees', h.newEmployeeBody(B))).json().id;
});

afterAll(async () => {
  await h?.stop();
});

describe('document expiry notices (brd-7, DF12, DF02)', () => {
  it('on the expiry date, once per document, to current readers of that employee’s documents only, without type or file name', async () => {
    const day = '2027-03-15';
    await upload(hrDocs, employeeEmp, day, 'passport-scan.pdf');
    await upload(hrDocs, employeeEmp, '2027-03-16', 'visa-copy.pdf');
    await upload(hrDocs, employeeEmp, null, 'offer-letter.pdf');
    await upload(hrDocsB, employeeB, day, 'other-company.pdf');

    expect((await runDocumentExpiry(h.pool, A.id, '2027-03-14')).events).toBe(0); // no lead time unless configured
    expect((await runDocumentExpiry(h.pool, A.id, day)).events).toBe(1);
    expect((await runDocumentExpiry(h.pool, A.id, day)).events).toBe(0); // a rerun raises nothing new

    const received = await notices(hrDocs);
    expect(received).toEqual([expect.objectContaining({ title: 'Document expiring', body: noticeFor(day) })]);
    expect(JSON.stringify(received)).not.toMatch(/passport|visa|offer|\.pdf|GENERAL|General document/i);
    const event = await h.one<{ data: Record<string, string>; subject_employee_id: string }>(
      `select data, subject_employee_id from notification_event where company_id = $1 and event_type = 'DOCUMENT_EXPIRING'`,
      [A.id],
    );
    expect(event).toEqual({ subject_employee_id: employeeEmp, data: { employeeName: 'Synthetic Person', employeeCode, expiresOn: day } });

    // No document grant, out of scope, not in the role ceiling, other company: nothing.
    for (const a of [hrPlain, hrDocsFinance, manager, hrDocsB]) expect(await notices(a)).toEqual([]);
    // Recipients are exactly the users who can list this employee's documents now; for the employee's own record
    // that is for the access model to say (DF02), not for the notice.
    for (const a of [hrDocs, hrPlain, hrDocsFinance, manager, employee]) {
      const canRead = (await h.call(a, 'GET', `/v1/employees/${employeeEmp}/documents`)).statusCode === 200;
      expect((await notices(a)).length).toBe(canRead ? 1 : 0);
    }
    // The other company's document is its own company's event.
    expect((await runDocumentExpiry(h.pool, B.id, day)).events).toBe(1);
    expect(await notices(hrDocsB)).toHaveLength(1);
    expect(await notices(hrDocs)).toHaveLength(1);
  });

  it('catches up a notice whose day was missed (worker outage or a later upload), once, within the catch-up window', async () => {
    const expired = '2027-08-10';
    await upload(hrDocs, employeeEmp, expired, 'missed-day.pdf');
    // The job did not run on 10 August; the run on 13 August still raises the notice, and only once.
    expect((await runDocumentExpiry(h.pool, A.id, '2027-08-13')).events).toBe(1);
    expect((await runDocumentExpiry(h.pool, A.id, '2027-08-14')).events).toBe(0);
    expect((await notices(hrDocs)).filter((n) => n.body === noticeFor(expired))).toHaveLength(1);
    // Beyond the catch-up window a long-expired document raises nothing.
    await upload(hrDocs, employeeEmp, '2027-07-01', 'long-expired.pdf');
    expect((await runDocumentExpiry(h.pool, A.id, '2027-08-15')).events).toBe(0);
  });

  it('a lead time is a parameter (none by default); each lead is its own occurrence', async () => {
    const day = '2027-05-10';
    await upload(hrDocs, employeeEmp, day, 'permit.pdf');
    expect((await runDocumentExpiry(h.pool, A.id, '2027-05-03')).events).toBe(0);
    expect((await runDocumentExpiry(h.pool, A.id, '2027-05-03', 7)).events).toBe(1);
    expect((await runDocumentExpiry(h.pool, A.id, '2027-05-03', 7)).events).toBe(0);
    expect((await notices(hrDocs)).filter((n) => n.body === noticeFor(day))).toHaveLength(1);
    await expect(runDocumentExpiry(h.pool, A.id, '2027-05-03', -1)).rejects.toThrow();
  });

  it('runs with the daily reminders job from 08:00 company time on the company-local date', async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const atLocal = (hour: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0) - 330 * 60_000); // Asia/Kolkata
    await upload(hrDocs, employeeEmp, today, 'licence.pdf');
    const deps = { db: h.pool, providers: new Map(), systemUserId: hrPlain.user };

    await runScheduledJobs(deps, atLocal(7));
    expect((await notices(hrDocs)).filter((n) => n.body === noticeFor(today))).toEqual([]);
    await runScheduledJobs(deps, atLocal(10));
    await runScheduledJobs(deps, atLocal(11));
    expect((await notices(hrDocs)).filter((n) => n.body === noticeFor(today))).toHaveLength(1);
  });

  it('an own-scope (OWN) document grant covers its holder’s own record only', async () => {
    // Give the Employee role and two employees' OWN assignments the document read grant. Whether an OWN Employee
    // context may read its own documents is the access model's decision (DF02); the notice must follow it.
    const other = await h.actor(A, 'EMPLOYEE', { employeeId: (await h.call(hrPlain, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id });
    await h.db.query(
      `insert into role_permission (company_id, role_id, permission_id, effect)
       select $1, r.id, p.id, 'ALLOW' from role r, permission p
        where r.company_id = $1 and r.code = 'EMPLOYEE' and p.resource = 'document' and p.action = 'read' and p.field_group = 'document'
       on conflict (company_id, role_id, permission_id) do update set effect = 'ALLOW'`,
      [A.id],
    );
    for (const a of [employee, other]) {
      await h.db.query(
        `insert into role_assignment_permission (company_id, role_assignment_id, permission_id, active, effective_from)
         select $1, $2, p.id, true, '2026-01-01T00:00:00Z' from permission p where p.resource = 'document' and p.action = 'read' and p.field_group = 'document'
         on conflict (company_id, role_assignment_id, permission_id) do update set active = true`,
        [A.id, a.assignment],
      );
    }
    const day = '2027-06-01';
    await upload(hrDocs, employeeEmp, day, 'own-record.pdf');
    expect((await runDocumentExpiry(h.pool, A.id, day)).events).toBe(1);
    expect((await notices(hrDocs)).filter((n) => n.body === noticeFor(day))).toHaveLength(1);
    expect((await notices(other)).filter((n) => n.body === noticeFor(day))).toEqual([]); // someone else's record
    expect((await h.call(other, 'GET', `/v1/employees/${employeeEmp}/documents`)).statusCode).not.toBe(200);
    const ownRead = (await h.call(employee, 'GET', `/v1/employees/${employeeEmp}/documents`)).statusCode === 200;
    expect((await notices(employee)).filter((n) => n.body === noticeFor(day))).toHaveLength(ownRead ? 1 : 0);
  });

  it('recipients are re-evaluated each time: a lost allowlist entry or role ceiling stops the notices', async () => {
    const readPermission = `(select id from permission where resource = 'document' and action = 'read' and field_group = 'document')`;
    const hrDocsEng = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...DOCS], departmentFilter: A.dept });
    // hrDocs's DB109 allowlist entry for reading documents is switched off.
    await h.db.query(`update role_assignment_permission set active = false where role_assignment_id = $1 and permission_id = ${readPermission}`, [hrDocs.assignment]);
    const day = '2027-06-21';
    await upload(hrDocsEng, employeeEmp, day, 'certificate.pdf');
    expect((await runDocumentExpiry(h.pool, A.id, day)).events).toBe(1);
    expect((await notices(hrDocsEng)).map((n) => n.body)).toEqual([noticeFor(day)]);
    expect((await notices(hrDocs)).filter((n) => n.body === noticeFor(day))).toEqual([]);

    // The role ceiling no longer allows reading documents: nobody is told, although allowlists still list it.
    await h.db.query(`update role_permission set effect = 'DENY' where company_id = $1 and permission_id = ${readPermission}`, [A.id]);
    const later = '2027-06-22';
    await upload(hrDocsEng, employeeEmp, later, 'second-certificate.pdf');
    expect((await runDocumentExpiry(h.pool, A.id, later)).notifications).toBe(0);
    expect((await notices(hrDocsEng)).filter((n) => n.body === noticeFor(later))).toEqual([]);
  });
});
