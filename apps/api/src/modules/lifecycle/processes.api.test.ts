// Process templates and employee processes over HTTP (FR-015, FR-016, FR-018 restricted remarks; DB075; DB076; F1
// "HR-controlled checklist templates with ordered task owners and explicit required/optional tasks"; DF02; DF08).
// Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { devTokenVerifier } from '../../auth/tokens.js';
import { withTransaction } from '../../db/transaction.js';
import { ASSIGNMENT_HEADER, COMPANY_HEADER } from '../../http/context.js';
import { memoryFileStore } from '../../storage/files.js';
import { developmentScanner, EICAR_TEST_STRING, scanPendingAttachments } from '../../storage/scan.js';
import { type Company, type Harness, startHarness, type TestActor, tokenConfig } from '../../test/harness.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { isModuleActive } from '../registry.js';
import { addDays, HR_NOTES, narrowedGrant, pdf, person, publishedTemplate, today as businessDate, trailText } from './lifecycle.fixtures.js';
import { closeProcess, completeTask } from './processes.js';

describe.runIf(isModuleActive('lifecycle'))('employee processes (FR-015, FR-016)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let hr: TestActor;
  let hrNotes: TestActor;
  let hrEng: TestActor;
  let hrB: TestActor;
  let auditor: TestActor;
  let manager: TestActor;
  let employee: TestActor;
  let hrSelf: TestActor;
  let managerEmp: string;
  let employeeEmp: string;
  let financeEmp: string;
  let hrSelfEmp: string;
  let today: string;

  const tasksOf = async (a: TestActor, processId: string) => (await h.call(a, 'GET', `/v1/employee-processes/${processId}`)).json();
  const start = (a: TestActor, employeeId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/employees/${employeeId}/processes`, body);
  const complete = (a: TestActor, taskId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/employee-process-tasks/${taskId}/complete`, body);

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    hrNotes = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_NOTES });
    hrB = await h.actor(B, 'HR_ADMINISTRATOR');
    auditor = await h.actor(A, 'AUDITOR');
    managerEmp = await person(h, A, hr, { name: 'Maya Manager (synthetic)' });
    employeeEmp = await person(h, A, hr, { managerId: managerEmp, name: 'Eli Employee (synthetic)' });
    hrSelfEmp = await person(h, A, hr, { name: 'Hana HR (synthetic)' });
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
    // An HR Administrator who is also an employee of the company (C4 self checks).
    hrSelf = await h.actor(A, 'HR_ADMINISTRATOR', { employeeId: hrSelfEmp });
    // HR limited to the finance department (row scope).
    hrEng = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    const fin = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { departmentId: A.financeDept, displayName: 'Finn Finance (synthetic)' }));
    financeEmp = fin.json().id;
    await h.setStatus(A, financeEmp, 'ACTIVE_CONFIRMED');
    today = await businessDate(h, A);
  });

  afterAll(async () => {
    await h?.stop();
  });

  describe('templates (FR-015)', () => {
    it('validates owners and codes, publishes revisions and freezes what is published', async () => {
      const base = { code: 'ONB_BASIC', name: 'Onboarding (synthetic)', processType: 'ONBOARDING' };
      // A role that cannot complete process tasks is not an owner; an unknown type is refused.
      const bad = await h.call(hr, 'POST', '/v1/lifecycle-processes', { ...base, tasks: [{ code: 'T1', title: 'Check', ownerRoleCode: 'AUDITOR', required: true, dueOffsetDays: 1, evidenceRequired: false }] });
      expect(bad.json().error).toBe('INVALID_OWNER');
      expect((await h.call(hr, 'POST', '/v1/lifecycle-processes', { ...base, processType: 'NOT_A_TYPE' })).json().error).toBe('INVALID_REFERENCE');
      const noOwner = await h.call(hr, 'POST', '/v1/lifecycle-processes', { ...base, tasks: [{ code: 'T1', title: 'Check', required: true, dueOffsetDays: 1, evidenceRequired: false }] });
      expect(noOwner.json().error).toBe('OWNER_REQUIRED');
      const twoOwners = await h.call(hr, 'POST', '/v1/lifecycle-processes', {
        ...base,
        tasks: [{ code: 'T1', title: 'Check', ownerRoleCode: 'HR_ADMINISTRATOR', ownerUserId: hr.user, required: true, dueOffsetDays: 1, evidenceRequired: false }],
      });
      expect(twoOwners.json().error).toBe('OWNER_REQUIRED');

      const created = await h.call(hr, 'POST', '/v1/lifecycle-processes', {
        ...base,
        tasks: [
          { code: 'LAPTOP', title: 'Issue laptop', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 2, evidenceRequired: false },
          { code: 'WELCOME', title: 'Welcome call', ownerRoleCode: 'REPORTING_MANAGER', required: false, dueOffsetDays: 5, evidenceRequired: false },
        ],
      });
      expect(created.statusCode).toBe(201);
      const t = created.json();
      expect(t.revisions).toEqual([expect.objectContaining({ revision: 1, state: 'DRAFT', tasks: [expect.objectContaining({ sequence: 1, code: 'LAPTOP' }), expect.objectContaining({ sequence: 2, code: 'WELCOME' })] })]);
      expect((await h.call(hr, 'POST', '/v1/lifecycle-processes', base)).json().error).toBe('TEMPLATE_CODE_EXISTS');
      // An employee process cannot start from a template that was never published.
      expect((await start(hr, employeeEmp, { processCode: 'ONB_BASIC' })).json().error).toBe('TEMPLATE_NOT_PUBLISHED');

      const rev1 = t.revisions[0];
      // Saving the draft needs its current version.
      expect((await h.call(hr, 'PUT', `/v1/lifecycle-processes/${t.id}/draft`, { tasks: [] })).json().error).toBe('STALE_VERSION');
      const pub = await h.call(hr, 'POST', `/v1/lifecycle-processes/${t.id}/publish`, { revision: 1, expectedVersion: rev1.version });
      expect(pub.json().revisions[0]).toMatchObject({ revision: 1, state: 'PUBLISHED' });
      // A published revision and its tasks are frozen at the database.
      await expect(h.db.query(`update lifecycle_process_task set title = 'Changed' where revision_id = (select id from lifecycle_process_revision where process_id = $1 and revision = 1)`, [t.id])).rejects.toThrow(/frozen/);
      await expect(h.db.query(`delete from lifecycle_process_task where revision_id = (select id from lifecycle_process_revision where process_id = $1 and revision = 1)`, [t.id])).rejects.toThrow(/frozen/);

      // A second revision opens as a new draft; publishing it retires revision 1.
      const draft2 = await h.call(hr, 'PUT', `/v1/lifecycle-processes/${t.id}/draft`, {
        tasks: [{ code: 'LAPTOP', title: 'Issue laptop and badge', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 3, evidenceRequired: true }],
      });
      expect(draft2.statusCode).toBe(200);
      const r2 = draft2.json().revisions.find((r: { revision: number }) => r.revision === 2);
      expect(r2).toMatchObject({ state: 'DRAFT', tasks: [expect.objectContaining({ title: 'Issue laptop and badge', evidenceRequired: true })] });
      const pub2 = await h.call(hr, 'POST', `/v1/lifecycle-processes/${t.id}/publish`, { revision: 2, expectedVersion: r2.version });
      expect(pub2.json().revisions.map((r: { state: string }) => r.state)).toEqual(['RETIRED', 'PUBLISHED']);
      // An inactive template starts nothing; task codes are unique per revision; a revision without tasks is not published.
      expect((await h.call(hr, 'PATCH', `/v1/lifecycle-processes/${t.id}`, { active: false, expectedVersion: pub2.json().version })).json().active).toBe(false);
      expect((await start(hr, employeeEmp, { processCode: 'ONB_BASIC' })).json().error).toBe('TEMPLATE_INACTIVE');
      const dupTask = { title: 'Check', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 0, evidenceRequired: false };
      expect((await h.call(hr, 'POST', '/v1/lifecycle-processes', { ...base, code: 'DUP', tasks: [{ code: 'T1', ...dupTask }, { code: 'T1', ...dupTask }] })).json().error).toBe('DUPLICATE_TASK_CODE');
      const empty = (await h.call(hr, 'POST', '/v1/lifecycle-processes', { ...base, code: 'EMPTY' })).json();
      expect((await h.call(hr, 'POST', `/v1/lifecycle-processes/${empty.id}/publish`, { revision: 1, expectedVersion: empty.revisions[0].version })).json().error).toBe('NO_TASKS');

      // Only HR administration manages templates.
      expect((await h.call(employee, 'GET', '/v1/lifecycle-processes')).statusCode).toBe(403);
      expect((await h.call(manager, 'POST', '/v1/lifecycle-processes', { ...base, code: 'MGR_TRY' })).statusCode).toBe(403);
      // Another company never sees the template.
      expect((await h.call(hrB, 'GET', `/v1/lifecycle-processes/${t.id}`)).statusCode).toBe(404);
    });
  });

  describe('instances (FR-016)', () => {
    let processId: string;
    let templateId: string;

    beforeAll(async () => {
      templateId = await publishedTemplate(h, hr, 'ONB_FULL', 'ONBOARDING', [
        { code: 'DOCS', title: 'Collect joining documents', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 3, evidenceRequired: true },
        { code: 'INTRO', title: 'Team introduction', ownerRoleCode: 'REPORTING_MANAGER', required: true, dueOffsetDays: 5, evidenceRequired: false },
        { code: 'ACK', title: 'Acknowledge the handbook', ownerRoleCode: 'EMPLOYEE', required: true, dueOffsetDays: 1, evidenceRequired: false },
        { code: 'LUNCH', title: 'Team lunch', ownerRoleCode: 'REPORTING_MANAGER', required: false, dueOffsetDays: 30, evidenceRequired: false },
        { code: 'BUDDY', title: 'Buddy check-in', ownerUserId: hrNotes.user, required: false, dueOffsetDays: 10, evidenceRequired: false },
      ]);
    });

    it('copies the published tasks with due dates and keeps them when the template changes', async () => {
      const effective = addDays(today, -4);
      const res = await start(hr, employeeEmp, { processCode: 'ONB_FULL', effectiveDate: effective });
      expect(res.statusCode, res.body).toBe(201);
      const p = res.json();
      processId = p.id;
      expect(p).toMatchObject({ state: 'OPEN', processType: 'ONBOARDING', revision: 1, effectiveDate: effective, ownerUserId: hr.user });
      expect(p.tasks.map((t: { code: string; dueDate: string; overdue: boolean }) => [t.code, t.dueDate, t.overdue])).toEqual([
        ['DOCS', addDays(effective, 3), true],
        ['INTRO', addDays(effective, 5), false],
        ['ACK', addDays(effective, 1), true],
        ['LUNCH', addDays(effective, 30), false],
        ['BUDDY', addDays(effective, 10), false],
      ]);
      expect(p.counts).toEqual({ total: 5, open: 5, requiredOpen: 3, overdue: 2 });

      // A later template revision never rewrites the running instance.
      const tpl = (await h.call(hr, 'GET', `/v1/lifecycle-processes/${templateId}`)).json();
      const d = await h.call(hr, 'PUT', `/v1/lifecycle-processes/${templateId}/draft`, {
        tasks: [{ code: 'ONLY', title: 'Only task', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 0, evidenceRequired: false }],
      });
      const r2 = d.json().revisions.find((r: { state: string }) => r.state === 'DRAFT');
      expect((await h.call(hr, 'POST', `/v1/lifecycle-processes/${templateId}/publish`, { revision: r2.revision, expectedVersion: r2.version })).statusCode).toBe(200);
      expect(tpl.revisions).toHaveLength(1);
      const again = await tasksOf(hr, processId);
      expect(again.revision).toBe(1);
      expect(again.tasks.map((t: { code: string }) => t.code)).toEqual(['DOCS', 'INTRO', 'ACK', 'LUNCH', 'BUDDY']);
      // Copied task facts are immutable at the database.
      await expect(h.db.query(`update employee_process_task set due_date = due_date + 1 where employee_process_id = $1`, [processId])).rejects.toThrow(/immutable/);
      await expect(h.db.query(`delete from employee_process_task where employee_process_id = $1`, [processId])).rejects.toThrow(/cannot be deleted/);
    });

    it('enforces scope, roles and self-handling on starting and reading processes', async () => {
      // Out of the HR assignment's department scope, another company, or not an HR duty: hidden or refused.
      expect((await start(hrEng, employeeEmp, { processCode: 'ONB_FULL' })).statusCode).toBe(404);
      expect((await start(hrB, employeeEmp, { processCode: 'ONB_FULL' })).statusCode).toBe(404);
      expect((await h.call(hrEng, 'GET', `/v1/employee-processes/${processId}`)).statusCode).toBe(404);
      expect((await h.call(hrB, 'GET', `/v1/employee-processes/${processId}`)).statusCode).toBe(404);
      expect((await start(manager, employeeEmp, { processCode: 'ONB_FULL' })).statusCode).toBe(403);
      expect((await start(employee, employeeEmp, { processCode: 'ONB_FULL' })).statusCode).toBe(403);
      expect((await h.call(auditor, 'GET', `/v1/employee-processes/${processId}`)).statusCode).toBe(403);
      // An HR Administrator never starts a process about themselves.
      expect((await start(hrSelf, hrSelfEmp, { processCode: 'ONB_FULL' })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
      // The employee and the direct manager read the process (operational fields only).
      expect((await h.call(employee, 'GET', `/v1/employee-processes/${processId}`)).statusCode).toBe(200);
      expect((await h.call(manager, 'GET', `/v1/employee-processes/${processId}`)).statusCode).toBe(200);
      expect((await h.call(employee, 'GET', '/v1/me/processes')).json().items).toEqual([expect.objectContaining({ id: processId, processCode: 'ONB_FULL', overdueTasks: 2 })]);
      // A colleague's process is invisible to the employee and to a manager of another team.
      const otherProcess = (await start(hr, financeEmp, { processCode: 'ONB_FULL' })).json().id;
      expect((await h.call(employee, 'GET', `/v1/employee-processes/${otherProcess}`)).statusCode).toBe(404);
      expect((await h.call(manager, 'GET', `/v1/employee-processes/${otherProcess}`)).statusCode).toBe(404);
      expect((await h.call(hrEng, 'GET', `/v1/employee-processes/${otherProcess}`)).statusCode).toBe(200);
      // I-25: a template naming a user who has no scope over the employee cannot start there (the task could never be
      // opened by its owner); for an employee inside that user's scope it can.
      await publishedTemplate(h, hr, 'FIN_DESK', 'TRANSFER', [{ code: 'DESK', title: 'Assign a desk', ownerUserId: hrEng.user, required: true, dueOffsetDays: 0, evidenceRequired: false }]);
      expect((await start(hr, employeeEmp, { processCode: 'FIN_DESK' })).json()).toMatchObject({ error: 'INVALID_OWNER', details: { tasks: ['DESK'] } });
      expect((await start(hr, financeEmp, { processCode: 'FIN_DESK' })).statusCode).toBe(201);
    });

    it('lets only the owner complete a task, records actor and date, requires evidence and rejects double completion', async () => {
      const p = await tasksOf(hr, processId);
      const task = (code: string) => p.tasks.find((t: { code: string }) => t.code === code);
      // Someone else's task.
      expect((await complete(hr, task('INTRO').id, { expectedVersion: 1 })).json().error).toBe('NOT_TASK_OWNER');
      expect((await complete(manager, task('DOCS').id, { expectedVersion: 1 })).json().error).toBe('NOT_TASK_OWNER');
      expect((await complete(employee, task('DOCS').id, { expectedVersion: 1 })).json().error).toBe('NOT_TASK_OWNER');
      // Evidence is required for DOCS.
      expect((await complete(hr, task('DOCS').id, { expectedVersion: 1 })).json().error).toBe('EVIDENCE_REQUIRED');
      expect((await complete(hr, task('DOCS').id, { expectedVersion: 7, evidence: { fileName: 'joining.pdf', contentBase64: pdf } })).json().error).toBe('STALE_VERSION');

      // Two completions at the same moment: exactly one applies.
      const [a, b] = await Promise.all([
        complete(hr, task('DOCS').id, { expectedVersion: 1, remark: 'Synthetic remark: originals sighted', evidence: { fileName: 'joining.pdf', contentBase64: pdf } }),
        complete(hr, task('DOCS').id, { expectedVersion: 1, remark: 'Synthetic duplicate', evidence: { fileName: 'joining.pdf', contentBase64: pdf } }),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      const done = (a.statusCode === 200 ? a : b).json();
      expect(done).toMatchObject({ state: 'COMPLETED', doneBy: hr.user, doneOn: today, hasEvidence: true, overdue: false });
      expect(await h.one<{ n: number }>(`select count(*)::int as n from employee_process_event where task_id = $1 and action = 'COMPLETE'`, [task('DOCS').id])).toEqual({ n: 1 });

      // The manager completes the manager's task; the employee their own.
      expect((await complete(manager, task('INTRO').id, { expectedVersion: 1 })).json()).toMatchObject({ state: 'COMPLETED', doneBy: manager.user });
      expect((await complete(employee, task('ACK').id, { expectedVersion: 1, remark: 'Read it (synthetic)' })).json()).toMatchObject({ state: 'COMPLETED', doneBy: employee.user });

      // Remarks are restricted to HR holding the notes grant (FR-018); the employee and manager see that one exists.
      const forEmployee = await tasksOf(employee, processId);
      expect(JSON.stringify(forEmployee)).not.toContain('Synthetic remark');
      expect(forEmployee.history.find((e: { action: string; taskCode: string }) => e.action === 'COMPLETE' && e.taskCode === 'DOCS')).toMatchObject({ noteRecorded: true, hasEvidence: true });
      expect(JSON.stringify(await tasksOf(hr, processId))).not.toContain('Synthetic remark');
      expect((await tasksOf(hrNotes, processId)).history.find((e: { action: string; taskCode: string }) => e.action === 'COMPLETE' && e.taskCode === 'DOCS').note).toBe('Synthetic remark: originals sighted');

      // FR-106: the upload is scanned right after storing; the clean file is released and the verdict audited (once).
      expect(done.evidenceScanState).toBe('CLEAN');
      expect(await h.one<{ n: number }>(`select count(*)::int as n from audit_event where record_key = $1 and action = 'SCAN_RELEASED'`, [task('DOCS').id])).toEqual({ n: 1 });
      // Evidence content needs the evidence grant; reading it is audited.
      expect((await h.call(hr, 'GET', `/v1/employee-process-tasks/${task('DOCS').id}/evidence`)).statusCode).toBe(403);
      const ev = await h.call(hrNotes, 'GET', `/v1/employee-process-tasks/${task('DOCS').id}/evidence`);
      expect(ev.statusCode).toBe(200);
      expect(ev.headers['content-type']).toBe('application/pdf');
      expect(await h.one<{ n: number }>(`select count(*)::int as n from audit_event where record_key = $1 and action = 'READ_CONTENT'`, [task('DOCS').id])).toEqual({ n: 1 });

      // Audit and outbox carry no remark text.
      const trail = await trailText(h, A.id, p.tasks.map((t: { id: string }) => t.id));
      expect(trail).toContain('remarkRecorded');
      expect(trail).not.toContain('Synthetic remark');
    });

    it('skips only optional tasks, reassigns with history and lists each owner its tasks', async () => {
      const p = await tasksOf(hr, processId);
      const task = (code: string) => p.tasks.find((t: { code: string }) => t.code === code);
      expect((await h.call(manager, 'POST', `/v1/employee-process-tasks/${task('LUNCH').id}/skip`, { expectedVersion: 1, reason: 'Synthetic: remote team' })).json()).toMatchObject({
        state: 'SKIPPED',
        doneBy: manager.user,
      });
      // A required task can never be skipped (also at the database).
      const reopenedIntro = await h.call(hr, 'POST', `/v1/employee-process-tasks/${task('INTRO').id}/reopen`, { expectedVersion: task('INTRO').version, reason: 'Synthetic: done too early' });
      expect(reopenedIntro.json()).toMatchObject({ state: 'OPEN', doneBy: null });
      expect((await h.call(manager, 'POST', `/v1/employee-process-tasks/${task('INTRO').id}/skip`, { expectedVersion: reopenedIntro.json().version, reason: 'x' })).json().error).toBe('REQUIRED_TASK');
      await expect(h.db.query(`update employee_process_task set state = 'SKIPPED', done_at = now(), done_on = current_date, done_by = $2, done_assignment_id = $3 where id = $1`, [task('INTRO').id, manager.user, manager.assignment])).rejects.toThrow(/employee_process_task_check/);

      // The user-owned BUDDY task appears in its owner's list and notifies them.
      const mine = (await h.call(hrNotes, 'GET', '/v1/employee-process-tasks/mine')).json();
      expect(mine.items.map((t: { code: string }) => t.code)).toContain('BUDDY');
      await dispatchOutbox(h.pool);
      const inbox = (await h.call(hrNotes, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[];
      expect(inbox.find((n) => n.category === 'PROCESS_TASK_ASSIGNED')!.body).toContain('Buddy check-in');

      // Reassignment keeps the prior owner in the history and the new owner is the one who can complete.
      const buddy = task('BUDDY');
      expect((await h.call(hr, 'POST', `/v1/employee-process-tasks/${buddy.id}/reassign`, { expectedVersion: buddy.version, ownerUserId: employee.user })).json().error).toBe('INVALID_OWNER');
      // I-25: never to a user who could not open the task (the finance-only HR assignment has no scope over this employee).
      expect((await h.call(hr, 'POST', `/v1/employee-process-tasks/${buddy.id}/reassign`, { expectedVersion: buddy.version, ownerUserId: hrEng.user })).json().error).toBe('INVALID_OWNER');
      const moved = await h.call(hr, 'POST', `/v1/employee-process-tasks/${buddy.id}/reassign`, { expectedVersion: buddy.version, ownerRoleCode: 'REPORTING_MANAGER', reason: 'Synthetic: manager takes it' });
      expect(moved.json()).toMatchObject({ ownerRoleCode: 'REPORTING_MANAGER', ownerUserId: null });
      const history = (await tasksOf(hr, processId)).history.find((e: { action: string }) => e.action === 'REASSIGN');
      expect(history).toMatchObject({ taskCode: 'BUDDY', priorOwner: { roleCode: null, userId: hrNotes.user }, newOwner: { roleCode: 'REPORTING_MANAGER', userId: null }, actorUserId: hr.user });
      expect((await h.call(hrNotes, 'GET', '/v1/employee-process-tasks/mine')).json().items.map((t: { code: string }) => t.code)).not.toContain('BUDDY');
      const managerTasks = (await h.call(manager, 'GET', '/v1/employee-process-tasks/mine')).json();
      expect(managerTasks.items.map((t: { code: string }) => t.code).sort()).toEqual(['BUDDY', 'INTRO']);
      // Reassigning is an HR management duty.
      expect((await h.call(manager, 'POST', `/v1/employee-process-tasks/${buddy.id}/reassign`, { expectedVersion: 2, ownerRoleCode: 'HR_ADMINISTRATOR' })).statusCode).toBe(403);
    });

    it('cannot close while a required task is open; reopening needs a reason and the reopen duty', async () => {
      let p = await tasksOf(hr, processId);
      const close = (version: number) => h.call(hr, 'POST', `/v1/employee-processes/${processId}/close`, { expectedVersion: version });
      const blocked = await close(p.version);
      expect(blocked.json()).toMatchObject({ error: 'REQUIRED_TASKS_INCOMPLETE', details: { tasks: ['INTRO'] } });
      const intro = p.tasks.find((t: { code: string }) => t.code === 'INTRO');
      expect((await complete(manager, intro.id, { expectedVersion: intro.version })).statusCode).toBe(200);
      // The optional BUDDY task is still open: it does not block closing.
      p = await tasksOf(hr, processId);
      const closed = await close(p.version);
      expect(closed.json()).toMatchObject({ state: 'CLOSED', counts: { requiredOpen: 0 } });
      // Tasks of a closed process are fixed; nothing is overdue in a closed process.
      const buddy = closed.json().tasks.find((t: { code: string }) => t.code === 'BUDDY');
      expect((await complete(manager, buddy.id, { expectedVersion: buddy.version })).json().error).toBe('PROCESS_NOT_OPEN');
      expect(closed.json().counts.overdue).toBe(0);
      // The reopen duty is HR's; a reason is required.
      expect((await h.call(manager, 'POST', `/v1/employee-processes/${processId}/reopen`, { expectedVersion: closed.json().version, reason: 'x' })).statusCode).toBe(403);
      expect((await h.call(hr, 'POST', `/v1/employee-processes/${processId}/reopen`, { expectedVersion: closed.json().version })).statusCode).toBe(400);
      const reopened = await h.call(hr, 'POST', `/v1/employee-processes/${processId}/reopen`, { expectedVersion: closed.json().version, reason: 'Synthetic: audit finding' });
      expect(reopened.json()).toMatchObject({ state: 'OPEN', reopenCount: 1 });
      expect(reopened.json().history.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['START', 'COMPLETE', 'SKIP', 'REOPEN_TASK', 'REASSIGN', 'CLOSE', 'REOPEN']));
      // Processes are never deleted; their transaction mirrors their state.
      await expect(h.db.query(`delete from employee_process where id = $1`, [processId])).rejects.toThrow(/cannot be deleted/);
      expect(await h.one<{ s: string }>(`select bt.state as s from employee_process p join business_transaction bt on bt.id = p.transaction_id where p.id = $1`, [processId])).toEqual({ s: 'OPEN' });
      // Cancelling needs a reason and the management duty.
      const cancelled = await h.call(hr, 'POST', `/v1/employee-processes/${processId}/cancel`, { expectedVersion: reopened.json().version, reason: 'Synthetic: replaced' });
      expect(cancelled.json().state).toBe('CANCELLED');
    });
  });

  describe('evidence quarantine and altered identifiers', () => {
    it('treats quarantined evidence as no evidence, and hides other employees’ tasks', async () => {
      await publishedTemplate(h, hr, 'ID_CHECK', 'ONBOARDING', [
        { code: 'ID', title: 'Verify identity document', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 0, evidenceRequired: true },
      ]);
      const p = (await start(hr, employeeEmp, { processCode: 'ID_CHECK' })).json();
      const t = p.tasks[0];
      // The employee sees their own process but does not own HR's task; another employee's task id is not found.
      expect((await complete(employee, t.id, { expectedVersion: 1 })).json().error).toBe('NOT_TASK_OWNER');
      const finance = await h.actor(A, 'EMPLOYEE', { employeeId: financeEmp });
      expect((await complete(finance, t.id, { expectedVersion: 1 })).statusCode).toBe(404);
      expect((await h.call(finance, 'GET', `/v1/employee-processes/${p.id}`)).statusCode).toBe(404);
      expect((await complete(hrEng, t.id, { expectedVersion: 1, evidence: { fileName: 'id.pdf', contentBase64: pdf } })).statusCode).toBe(404);
      expect((await h.call(hrB, 'POST', `/v1/employee-process-tasks/${t.id}/reopen`, { expectedVersion: 1, reason: 'x' })).statusCode).toBe(404);
      const infected = Buffer.from(`%PDF-1.4\n${EICAR_TEST_STRING}\n%%EOF\n`, 'latin1');
      const done = await complete(hr, t.id, { expectedVersion: 1, evidence: { fileName: 'id.pdf', contentBase64: infected.toString('base64') } });
      // Scanned right after storing: the finding quarantines the file for good and the verdict is audited.
      expect(done.json()).toMatchObject({ state: 'COMPLETED', evidenceScanState: 'QUARANTINED' });
      expect(await h.one<{ n: number }>(`select count(*)::int as n from audit_event where record_key = $1 and action = 'SCAN_QUARANTINED'`, [t.id])).toEqual({ n: 1 });
      const current = await tasksOf(hr, p.id);
      expect((await h.call(hr, 'POST', `/v1/employee-processes/${p.id}/close`, { expectedVersion: current.version })).json()).toMatchObject({
        error: 'REQUIRED_TASKS_INCOMPLETE',
        details: { tasks: ['ID'] },
      });
      expect((await h.call(hrNotes, 'GET', `/v1/employee-process-tasks/${t.id}/evidence`)).json().error).toBe('FILE_NOT_RELEASED');
      // Reopen and complete with a clean file: the process can close.
      const reopened = await h.call(hr, 'POST', `/v1/employee-process-tasks/${t.id}/reopen`, { expectedVersion: done.json().version, reason: 'Synthetic: file failed the scan' });
      const clean = await complete(hr, t.id, { expectedVersion: reopened.json().version, evidence: { fileName: 'id.pdf', contentBase64: pdf } });
      expect(clean.json()).toMatchObject({ state: 'COMPLETED', evidenceScanState: 'CLEAN' });
      const ready = await tasksOf(hr, p.id);
      expect((await h.call(hr, 'POST', `/v1/employee-processes/${p.id}/close`, { expectedVersion: ready.version })).json().state).toBe('CLOSED');
      // Both completions and the reopening stay in the history.
      expect((await tasksOf(hr, p.id)).history.filter((e: { action: string }) => ['COMPLETE', 'REOPEN_TASK'].includes(e.action)).map((e: { action: string }) => e.action)).toEqual([
        'COMPLETE',
        'REOPEN_TASK',
        'COMPLETE',
      ]);
    });

    it('keeps evidence pending while the scanner is unavailable: neither served nor counted until released (FR-106)', async () => {
      await publishedTemplate(h, hr, 'FORM_PROOF', 'ONBOARDING', [
        { code: 'PROOF', title: 'Collect the signed form', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 0, evidenceRequired: true },
      ]);
      const p = (await start(hr, employeeEmp, { processCode: 'FORM_PROOF' })).json();
      const taskId = p.tasks[0].id as string;
      // A second app on the same database whose scanner always errors (an outage).
      const files = memoryFileStore();
      const outage = buildApp({ db: h.pool, verifier: devTokenVerifier(tokenConfig), files, scanner: { scan: async () => ({ verdict: 'ERROR' }) } });
      const headers = (a: TestActor) => ({ authorization: `Bearer ${a.token}`, [COMPANY_HEADER]: A.id, [ASSIGNMENT_HEADER]: a.assignment });
      try {
        const done = await outage.inject({
          method: 'POST',
          url: `/v1/employee-process-tasks/${taskId}/complete`,
          headers: headers(hr),
          payload: { expectedVersion: 1, evidence: { fileName: 'form.pdf', contentBase64: pdf } },
        });
        expect(done.json()).toMatchObject({ state: 'COMPLETED', evidenceScanState: 'PENDING_SCAN' });
        expect((await outage.inject({ method: 'GET', url: `/v1/employee-process-tasks/${taskId}/evidence`, headers: headers(hrNotes) })).json()).toMatchObject({
          error: 'FILE_NOT_RELEASED',
          details: { scanState: 'PENDING_SCAN' },
        });
        // A file still waiting for its verdict is not evidence yet: the process cannot close on it.
        const current = await tasksOf(hr, p.id);
        expect((await h.call(hr, 'POST', `/v1/employee-processes/${p.id}/close`, { expectedVersion: current.version })).json()).toMatchObject({
          error: 'REQUIRED_TASKS_INCOMPLETE',
          details: { tasks: ['PROOF'] },
        });
        // The worker's pending-scan run releases it once the scanner answers again.
        expect(await scanPendingAttachments(h.pool, files, developmentScanner(), A.id)).toMatchObject({ clean: 1, stillPending: 0 });
        expect((await outage.inject({ method: 'GET', url: `/v1/employee-process-tasks/${taskId}/evidence`, headers: headers(hrNotes) })).statusCode).toBe(200);
        expect((await h.call(hr, 'POST', `/v1/employee-processes/${p.id}/close`, { expectedVersion: current.version })).json().state).toBe('CLOSED');
      } finally {
        await outage.close();
      }
    });
  });

  describe('authority re-checked inside the transaction (docs/09 §6.5)', () => {
    it('refuses to close a process when the closing duty was withdrawn after the route guard, recording nothing', async () => {
      await publishedTemplate(h, hr, 'RECHECK', 'ONBOARDING', [{ code: 'NOTE', title: 'Optional note', ownerRoleCode: 'HR_ADMINISTRATOR', required: false, dueOffsetDays: 0, evidenceRequired: false }]);
      const p = (await start(hr, employeeEmp, { processCode: 'RECHECK' })).json();
      const closer = await h.actor(A, 'HR_ADMINISTRATOR');
      const grant = await narrowedGrant(h, A, closer, 'employee_process.manage.operational');
      await expect(withTransaction(h.pool, (tx) => closeProcess(tx, grant, p.id, { expectedVersion: p.version }))).rejects.toMatchObject({ statusCode: 403 });
      const after = await tasksOf(hr, p.id);
      expect(after.state).toBe('OPEN');
      expect(after.history.map((e: { action: string }) => e.action)).toEqual(['START']);
      // Positive control: an unnarrowed HR Administrator closes the same process.
      expect((await h.call(hr, 'POST', `/v1/employee-processes/${p.id}/close`, { expectedVersion: p.version })).json().state).toBe('CLOSED');
    });

    it('refuses to complete a task when the completion duty was withdrawn after the route guard', async () => {
      await publishedTemplate(h, hr, 'RECHECK_DONE', 'ONBOARDING', [{ code: 'CHECK', title: 'Check', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 0, evidenceRequired: false }]);
      const p = (await start(hr, employeeEmp, { processCode: 'RECHECK_DONE' })).json();
      const task = p.tasks[0];
      const owner = await h.actor(A, 'HR_ADMINISTRATOR');
      const grant = await narrowedGrant(h, A, owner, 'employee_process.complete_task.operational');
      await expect(withTransaction(h.pool, (tx) => completeTask(tx, grant, memoryFileStore(), task.id, { expectedVersion: task.version }))).rejects.toMatchObject({ statusCode: 403 });
      expect((await tasksOf(hr, p.id)).tasks[0].state).toBe('OPEN');
      expect((await complete(hr, task.id, { expectedVersion: task.version })).json().state).toBe('COMPLETED');
    });
  });

  describe('form choices and tracking across employees (FR-015, FR-016)', () => {
    it('lists the configured reference values and owner roles under the form permissions', async () => {
      const types = await h.call(hr, 'GET', '/v1/lifecycle/reference-values?category=LIFECYCLE_PROCESS_TYPE');
      expect(types.statusCode, types.body).toBe(200);
      expect(types.json().items.map((v: { code: string }) => v.code)).toEqual(expect.arrayContaining(['ONBOARDING', 'EXIT']));
      expect((await h.call(hr, 'GET', '/v1/lifecycle/reference-values?category=LETTER_TYPE')).json().items.map((v: { code: string }) => v.code)).toContain('RELIEVING');
      // The employee's resignation form: no exit reason is seeded (none is defined by the BRD).
      expect((await h.call(employee, 'GET', '/v1/lifecycle/reference-values?category=EXIT_REASON')).json()).toEqual({ category: 'EXIT_REASON', items: [] });
      expect((await h.call(employee, 'GET', '/v1/lifecycle/reference-values?category=LETTER_TYPE')).statusCode).toBe(403);
      expect((await h.call(hr, 'GET', '/v1/lifecycle/reference-values?category=EMPLOYEE_STATUS')).statusCode).toBe(400);
      const roles = (await h.call(hr, 'GET', '/v1/lifecycle-processes/owner-roles')).json().items.map((r: { code: string }) => r.code);
      expect(roles).toEqual(expect.arrayContaining(['HR_ADMINISTRATOR', 'REPORTING_MANAGER', 'EMPLOYEE']));
      expect(roles).not.toContain('AUDITOR');
      expect((await h.call(employee, 'GET', '/v1/lifecycle-processes/owner-roles')).statusCode).toBe(403);
    });

    it('lists processes across employees within row scope, filtered by state, type and overdue tasks', async () => {
      await publishedTemplate(h, hr, 'LIST_LATE', 'TRANSFER', [{ code: 'LATE', title: 'Late task', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 0, evidenceRequired: false }]);
      const late = (await start(hr, employeeEmp, { processCode: 'LIST_LATE', effectiveDate: addDays(today, -2) })).json();
      const fin = (await start(hr, financeEmp, { processCode: 'LIST_LATE' })).json();
      const ids = async (a: TestActor, query: string) => (await h.call(a, 'GET', `/v1/employee-processes${query}`)).json().items.map((p: { id: string }) => p.id);
      expect(await ids(hr, '?processType=TRANSFER')).toEqual(expect.arrayContaining([late.id, fin.id]));
      const overdue = await ids(hr, '?processType=TRANSFER&overdue=true');
      expect(overdue).toContain(late.id);
      expect(overdue).not.toContain(fin.id);
      expect(await ids(hr, '?state=CLOSED&processType=TRANSFER')).toEqual([]);
      // Row scope: finance-only HR sees the finance employee only; another company sees nothing; the employee only their own.
      const scoped = await ids(hrEng, '?processType=TRANSFER');
      expect(scoped).toContain(fin.id);
      expect(scoped).not.toContain(late.id);
      expect(await ids(hrB, '')).toEqual([]);
      const own = (await h.call(employee, 'GET', '/v1/employee-processes')).json().items;
      expect(own.length).toBeGreaterThan(0);
      expect(own.every((p: { employeeId: string }) => p.employeeId === employeeEmp)).toBe(true);
      expect((await h.call(auditor, 'GET', '/v1/employee-processes')).statusCode).toBe(403);
    });
  });

  describe('restricted HR notes and warnings (FR-018)', () => {
    it('are visible and writable only with the restricted grant, in scope and never about oneself', async () => {
      const body = { kind: 'WARNING', body: 'Synthetic warning about late reporting' };
      expect((await h.call(hr, 'POST', `/v1/employees/${employeeEmp}/notes`, body)).statusCode).toBe(403);
      expect((await h.call(manager, 'GET', `/v1/employees/${employeeEmp}/notes`)).statusCode).toBe(403);
      expect((await h.call(employee, 'GET', `/v1/employees/${employeeEmp}/notes`)).statusCode).toBe(403);
      const created = await h.call(hrNotes, 'POST', `/v1/employees/${employeeEmp}/notes`, body);
      expect(created.statusCode).toBe(201);
      const corrected = await h.call(hrNotes, 'POST', `/v1/employees/${employeeEmp}/notes`, { ...body, body: 'Synthetic corrected warning', supersedesNoteId: created.json().id });
      expect(corrected.statusCode).toBe(201);
      expect((await h.call(hrNotes, 'POST', `/v1/employees/${employeeEmp}/notes`, { ...body, supersedesNoteId: created.json().id })).json().error).toBe('ALREADY_SUPERSEDED');
      const listed = (await h.call(hrNotes, 'GET', `/v1/employees/${employeeEmp}/notes`)).json().items;
      expect(listed).toEqual([
        expect.objectContaining({ kind: 'WARNING', body: 'Synthetic corrected warning', supersedesNoteId: created.json().id }),
        expect.objectContaining({ body: 'Synthetic warning about late reporting', supersededByNoteId: corrected.json().id }),
      ]);
      // Notes are append-only; the audit holds the kind, never the text.
      await expect(h.db.query(`update employee_note set body = 'changed' where id = $1`, [created.json().id])).rejects.toThrow(/append-only/);
      expect(await trailText(h, A.id, [created.json().id])).not.toContain('late reporting');
      // A note linked to another employee's process is refused.
      const otherProcess = (await h.db.query<{ id: string }>(`select id from employee_process where employee_id = $1 limit 1`, [financeEmp])).rows[0]!.id;
      expect((await h.call(hrNotes, 'POST', `/v1/employees/${employeeEmp}/notes`, { ...body, employeeProcessId: otherProcess })).json().error).toBe('INVALID_REFERENCE');
      const hrSelfNotes = await h.actor(A, 'HR_ADMINISTRATOR', { user: hrSelf.user, extra: HR_NOTES });
      expect((await h.call(hrSelfNotes, 'GET', `/v1/employees/${hrSelfEmp}/notes`)).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
      // Remarks about one's own process stay hidden even with the notes grant; they cannot act on it either.
      const own = (await h.call(hr, 'POST', `/v1/employees/${hrSelfEmp}/processes`, { processCode: 'ONB_FULL' })).json();
      const ownTask = own.tasks[0];
      expect((await h.call(hrSelfNotes, 'POST', `/v1/employee-process-tasks/${ownTask.id}/complete`, { expectedVersion: 1 })).json().error).toBe('NOT_TASK_OWNER');
      expect((await h.call(hr, 'POST', `/v1/employee-process-tasks/${ownTask.id}/complete`, { expectedVersion: 1, remark: 'Synthetic remark about Hana' })).statusCode).toBe(200);
      const selfView = (await h.call(hrSelfNotes, 'GET', `/v1/employee-processes/${own.id}`)).json();
      expect(JSON.stringify(selfView)).not.toContain('Synthetic remark about Hana');
      expect(selfView.history.find((e: { action: string }) => e.action === 'COMPLETE')).toMatchObject({ noteRecorded: true });
      expect(JSON.stringify((await h.call(hrNotes, 'GET', `/v1/employee-processes/${own.id}`)).json())).toContain('Synthetic remark about Hana');
      expect((await h.call(hrSelfNotes, 'POST', `/v1/employee-processes/${own.id}/close`, { expectedVersion: selfView.version })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    });
  });

  describe('paging and totals (FR-056)', () => {
    type Page<T> = { items: T[]; total: number; page?: number; pageSize?: number; truncated?: boolean; overdue?: number };
    const read = async <T>(a: TestActor, url: string) => {
      const res = await h.call(a, 'GET', url);
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as Page<T>;
    };
    const ids = (p: Page<{ id: string }>) => p.items.map((x) => x.id);

    it('pages processes, an employee’s processes and the task queue; totals and overdue count every match in scope', async () => {
      const all = await read<{ id: string; employeeId: string }>(hr, '/v1/employee-processes');
      expect(all.total).toBe(all.items.length);
      expect(all).toMatchObject({ truncated: false });
      expect(all).not.toHaveProperty('page');
      const first = await read<{ id: string }>(hr, '/v1/employee-processes?page=1&pageSize=25');
      expect(first).toMatchObject({ total: all.total, page: 1, pageSize: 25, truncated: all.total > 25 });
      expect(ids(first)).toEqual(ids(all).slice(0, 25));
      const past = Math.ceil(all.total / 25) + 1;
      expect(await read(hr, `/v1/employee-processes?page=${past}&pageSize=25`)).toEqual({ items: [], total: all.total, page: past, pageSize: 25, truncated: false });
      // Row scope applies to the total.
      expect((await read(hrEng, '/v1/employee-processes?page=1&pageSize=25')).total).toBe(all.items.filter((p) => p.employeeId === financeEmp).length);
      const oneAll = await read<{ id: string }>(hr, `/v1/employees/${employeeEmp}/processes`);
      expect(oneAll.total).toBe(all.items.filter((p) => p.employeeId === employeeEmp).length);
      expect(await read(hr, `/v1/employees/${employeeEmp}/processes?page=1&pageSize=25`)).toMatchObject({ total: oneAll.total, page: 1, pageSize: 25, items: oneAll.items.slice(0, 25) });
      expect((await h.call(hrEng, 'GET', `/v1/employees/${employeeEmp}/processes?page=1&pageSize=25`)).statusCode).toBe(404);

      // The task queue: `total` and `overdue` count every task, also on a page past the last one.
      await publishedTemplate(h, hr, 'PAGE_LATE', 'TRANSFER', [{ code: 'OVERDUE', title: 'Overdue task', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: -3, evidenceRequired: false }]);
      for (const e of [employeeEmp, financeEmp]) expect((await start(hr, e, { processCode: 'PAGE_LATE' })).statusCode).toBe(201);
      const queue = await read<{ id: string; employeeId: string; overdue: boolean }>(hr, '/v1/employee-process-tasks/mine');
      expect(queue.total).toBe(queue.items.length);
      expect(queue.overdue).toBe(queue.items.filter((t) => t.overdue).length);
      expect(queue.overdue).toBeGreaterThanOrEqual(2);
      const queuePast = Math.ceil(queue.total / 25) + 1;
      expect(await read(hr, `/v1/employee-process-tasks/mine?page=${queuePast}&pageSize=25`)).toEqual({ items: [], total: queue.total, page: queuePast, pageSize: 25, overdue: queue.overdue });
      // Row scope: the finance-only assignment's queue holds finance tasks only, and its totals count only those.
      const scopedAll = await read<{ employeeId: string; overdue: boolean }>(hrEng, '/v1/employee-process-tasks/mine');
      expect(scopedAll.items.length).toBeGreaterThan(0);
      expect(scopedAll.items.every((t) => t.employeeId === financeEmp)).toBe(true);
      const scopedQueue = await read<{ employeeId: string; overdue: boolean }>(hrEng, '/v1/employee-process-tasks/mine?page=1&pageSize=25');
      expect(scopedQueue).toMatchObject({ total: scopedAll.items.length, overdue: scopedAll.items.filter((t) => t.overdue).length, items: scopedAll.items });
    });

    it('pages an employee’s restricted notes, newest first, with the total of every note', async () => {
      const before = (await read<{ id: string }>(hrNotes, `/v1/employees/${financeEmp}/notes`)).total;
      for (let i = 0; i < 27; i++) {
        expect((await h.call(hrNotes, 'POST', `/v1/employees/${financeEmp}/notes`, { kind: 'NOTE', body: `Synthetic paging note ${i}` })).statusCode).toBe(201);
      }
      const all = await read<{ id: string }>(hrNotes, `/v1/employees/${financeEmp}/notes`);
      expect(all.total).toBe(before + 27);
      expect(all.items).toHaveLength(all.total);
      const p1 = await read<{ id: string }>(hrNotes, `/v1/employees/${financeEmp}/notes?page=1&pageSize=25`);
      const p2 = await read<{ id: string }>(hrNotes, `/v1/employees/${financeEmp}/notes?page=2&pageSize=25`);
      expect(p1).toMatchObject({ total: all.total, page: 1, pageSize: 25 });
      expect(p1.items).toHaveLength(25);
      expect([...ids(p1), ...ids(p2)]).toEqual(ids(all));
      expect((await read(hrNotes, `/v1/employees/${financeEmp}/notes?page=3&pageSize=25`)).items).toEqual([]);
      // Row scope still applies: notes of an employee outside the assignment's scope read as missing.
      const notesElsewhere = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_NOTES, departmentFilter: A.dept });
      expect((await h.call(notesElsewhere, 'GET', `/v1/employees/${financeEmp}/notes?page=1&pageSize=25`)).statusCode).toBe(404);
    });
  });
});
