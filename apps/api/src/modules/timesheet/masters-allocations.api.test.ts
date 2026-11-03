// Projects, jobs, activities and resource allocation over HTTP (FR-045, FR-046; DB066-DB069; F1 timesheets; DF02;
// DF08; DF09; ZT06/ZT07/ZT08), with the caller's own allocation-import batches and resuming one held for the malware
// scan (FR-106). Synthetic data only: example.test addresses and made-up names.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { followUpSuite } from '../imports/follow-up.fixtures.js';
import { isModuleActive } from '../registry.js';
import { allocate, csv, FAR_END, person, type TimesheetWorld, timesheetWorld } from './timesheet.fixtures.js';

describe.runIf(isModuleActive('timesheet'))('timesheet: masters and allocations', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let w: TimesheetWorld;
  let bHr: TestActor;
  let hrFin: TestActor;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    w = await timesheetWorld(h, A);
    bHr = await h.actor(B, 'HR_ADMINISTRATOR');
    hrFin = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
  });

  afterAll(async () => {
    await h?.stop();
  });

  describe('masters (FR-045)', () => {
    it('keeps projects, jobs and activities with code, name, owner, period and active flag; codes never change', async () => {
      const detail = (await h.call(w.hr, 'GET', `/v1/timesheet/projects/${w.projectId}`)).json();
      expect(detail).toMatchObject({ name: 'Synthetic platform project', ownerEmployeeId: w.managerEmp, startDate: '2026-01-01', endDate: null, active: true, version: 1 });
      expect(detail.jobs.map((j: { code: string }) => j.code)).toEqual(['BUILD', 'SUPPORT']);
      expect(detail.jobs[0].activities).toHaveLength(2);
      // Codes are unique: per company for projects and activities, per project for jobs.
      const dup = await h.call(w.hr, 'POST', '/v1/timesheet/projects', { code: detail.code.toLowerCase(), name: 'Again', ownerEmployeeId: w.managerEmp, startDate: '2026-01-01' });
      expect([dup.statusCode, dup.json().error]).toEqual([409, 'CODE_EXISTS']);
      const dupJob = await h.call(w.hr, 'POST', `/v1/timesheet/projects/${w.projectId}/jobs`, { code: 'build', name: 'Again', ownerEmployeeId: w.managerEmp, startDate: '2026-01-01' });
      expect(dupJob.json().error).toBe('CODE_EXISTS');
      // A job belongs to exactly one project: the same code under another project is a different job.
      const other = await h.call(w.hr, 'POST', '/v1/timesheet/projects', { code: uniq('OTHER'), name: 'Other project', ownerEmployeeId: w.managerEmp, startDate: '2026-01-01' });
      const otherJob = await h.call(w.hr, 'POST', `/v1/timesheet/projects/${other.json().id}/jobs`, { code: 'BUILD', name: 'Build elsewhere', ownerEmployeeId: w.managerEmp, startDate: '2026-01-01' });
      expect(otherJob.statusCode).toBe(201);
      // The period must not end before it starts; the owner must be an employee of the company.
      const badPeriod = await h.call(w.hr, 'POST', '/v1/timesheet/activities', { code: uniq('ACT'), name: 'x', ownerEmployeeId: w.managerEmp, startDate: '2026-02-01', endDate: '2026-01-31', productive: true });
      expect(badPeriod.json().error).toBe('INVALID_PERIOD');
      const foreignOwner = (await h.one<{ id: string }>(`insert into employee (company_id, employee_code, display_name, joining_date, employment_type_id, status_id)
         select $1, $2, 'Synthetic B person', '2026-01-05', (select id from reference_value where company_id = $1 and category = 'EMPLOYMENT_TYPE' and code = 'PERMANENT'),
                (select id from reference_value where company_id = $1 and category = 'EMPLOYEE_STATUS' and code = 'ACTIVE_CONFIRMED') returning id`, [B.id, uniq('BEMP')])).id;
      const badOwner = await h.call(w.hr, 'POST', '/v1/timesheet/projects', { code: uniq('PRJ'), name: 'x', ownerEmployeeId: foreignOwner, startDate: '2026-01-01' });
      expect(badOwner.json().error).toBe('INVALID_OWNER');
      // An activity needs an explicit productive classification (no default).
      const noClass = await h.call(w.hr, 'POST', '/v1/timesheet/activities', { code: uniq('ACT'), name: 'x', ownerEmployeeId: w.managerEmp, startDate: '2026-01-01' });
      expect(noClass.statusCode).toBe(400);

      // Updates are versioned and audited; a stale version is refused.
      const patched = await h.call(w.hr, 'PATCH', `/v1/timesheet/projects/${w.projectId}`, { expectedVersion: 1, name: 'Synthetic platform project (renamed)' });
      expect(patched.json()).toMatchObject({ name: 'Synthetic platform project (renamed)', version: 2 });
      expect((await h.call(w.hr, 'PATCH', `/v1/timesheet/projects/${w.projectId}`, { expectedVersion: 1, name: 'Stale' })).json().error).toBe('STALE_VERSION');
      // Codes are not part of a patch (an unknown property is dropped); the database refuses a code change anyway.
      const codeKept = await h.call(w.hr, 'PATCH', `/v1/timesheet/projects/${w.projectId}`, { expectedVersion: 2, active: true, code: 'NEW' });
      expect(codeKept.json()).toMatchObject({ code: detail.code, version: 3 });
      await expect(h.db.query(`update timesheet_project set code = 'CHANGED' where id = $1`, [w.projectId])).rejects.toMatchObject({ code: '23514' });
      await expect(h.db.query(`update timesheet_job set project_id = $2 where id = $1`, [w.jobId, other.json().id])).rejects.toMatchObject({ code: '23514' });
      // DF08: masters are never deleted.
      await expect(h.db.query(`delete from timesheet_activity where id = $1`, [w.devId])).rejects.toMatchObject({ code: '23514' });
      const audit = await h.one<{ n: string }>(`select count(*) as n from audit_event where resource_code = 'timesheet_project' and record_key = $1`, [w.projectId]);
      expect(Number(audit.n)).toBe(3);
    });

    it('is company-wide data: maintained with company scope only, read by managers, never across companies', async () => {
      expect((await h.call(w.manager, 'GET', '/v1/timesheet/projects')).statusCode).toBe(200);
      expect((await h.call(w.manager, 'POST', '/v1/timesheet/projects', { code: uniq('PRJ'), name: 'x', ownerEmployeeId: w.managerEmp, startDate: '2026-01-01' })).statusCode).toBe(403);
      // A filtered HR assignment is not company-wide.
      expect((await h.call(hrFin, 'POST', '/v1/timesheet/projects', { code: uniq('PRJ'), name: 'x', ownerEmployeeId: w.managerEmp, startDate: '2026-01-01' })).statusCode).toBe(403);
      expect((await h.call(w.employee, 'GET', '/v1/timesheet/projects')).statusCode).toBe(403);
      expect((await h.call(bHr, 'GET', `/v1/timesheet/projects/${w.projectId}`)).statusCode).toBe(404);
      expect((await h.call(bHr, 'GET', '/v1/timesheet/projects')).json().items).toEqual([]);
      expect((await h.call(bHr, 'PUT', `/v1/timesheet/jobs/${w.jobId}/activities/${w.devId}`, { active: false })).statusCode).toBe(404);
    });
  });

  describe('allocations (FR-046)', () => {
    let alloc: string;

    it('allocates an employee to a job for an interval within employment and the job and project periods', async () => {
      const res = await allocate(h, w.hr, { employeeId: w.employeeEmp, jobId: w.jobId, allocationPercent: '60' });
      expect(res.statusCode, res.body).toBe(201);
      alloc = res.json().id;
      expect(res.json()).toMatchObject({ employeeId: w.employeeEmp, projectId: w.projectId, jobId: w.jobId, startDate: '2026-01-05', endDate: FAR_END, allocationPercent: '60.00', state: 'ACTIVE', source: 'MANUAL', overAllocation: null });
      // DB069: end not before start; duplicate employee/job/interval rejected.
      expect((await allocate(h, w.hr, { employeeId: w.employeeEmp, jobId: w.jobId, startDate: '2026-03-02', endDate: '2026-03-01' })).json().error).toBe('INVALID_PERIOD');
      const dup = await allocate(h, w.hr, { employeeId: w.employeeEmp, jobId: w.jobId, startDate: '2026-06-01', endDate: '2026-06-30', allocationPercent: '10' });
      expect([dup.statusCode, dup.json().error]).toEqual([409, 'DUPLICATE_ALLOCATION']);
      // Outside the employment, the project's period, or on an inactive master.
      expect((await allocate(h, w.hr, { employeeId: w.peerEmp, jobId: w.jobId, startDate: '2025-12-01', endDate: '2026-02-01', allocationPercent: '10' })).json().error).toBe('OUTSIDE_EMPLOYMENT');
      const short = await h.call(w.hr, 'POST', `/v1/timesheet/projects/${w.projectId}/jobs`, { code: 'SHORT', name: 'Short job', ownerEmployeeId: w.managerEmp, startDate: '2026-02-01', endDate: '2026-02-28' });
      expect((await allocate(h, w.hr, { employeeId: w.peerEmp, jobId: short.json().id, startDate: '2026-02-01', endDate: '2026-03-15', allocationPercent: '10' })).json().error).toBe('INVALID_PROJECT_DATES');
      await h.call(w.hr, 'PATCH', `/v1/timesheet/jobs/${short.json().id}`, { expectedVersion: 1, active: false });
      expect((await allocate(h, w.hr, { employeeId: w.peerEmp, jobId: short.json().id, startDate: '2026-02-01', endDate: '2026-02-10', allocationPercent: '10' })).json().error).toBe('INACTIVE_MASTER');
      // Percentages are exact decimals above 0 and at most 100.
      expect((await allocate(h, w.hr, { employeeId: w.peerEmp, jobId: w.jobId, allocationPercent: '0' })).json().error).toBe('INVALID_PERCENT');
      expect((await allocate(h, w.hr, { employeeId: w.peerEmp, jobId: w.jobId, allocationPercent: '100.01' })).json().error).toBe('INVALID_PERCENT');
      expect((await allocate(h, w.hr, { employeeId: w.peerEmp, jobId: w.jobId, allocationPercent: '12.345' })).statusCode).toBe(400);
      // The database keeps the same rules (ZT08) and refuses a duplicate written directly.
      await expect(
        h.db.query(
          `insert into resource_allocation (company_id, employee_id, project_id, job_id, start_date, end_date, allocation_percent, state, source)
           values ($1, $2, $3, $4, '2026-07-01', '2026-07-31', 10, 'ACTIVE', 'MANUAL')`,
          [A.id, w.employeeEmp, w.projectId, w.jobId],
        ),
      ).rejects.toMatchObject({ code: '23P01' });
    });

    it('blocks a total above 100% unless the direct manager records an exception with a reason (F1)', async () => {
      const over = await allocate(h, w.hr, { employeeId: w.employeeEmp, jobId: w.job2Id, startDate: '2026-11-02', endDate: '2026-11-30', allocationPercent: '50' });
      expect([over.statusCode, over.json().error, over.json().details]).toEqual([409, 'OVER_ALLOCATED', { peakPercent: '110.00', date: '2026-11-02' }]);
      // HR cannot record the exception: only the employee's current direct manager can.
      const hrException = await allocate(h, w.hr, { employeeId: w.employeeEmp, jobId: w.job2Id, startDate: '2026-11-02', endDate: '2026-11-30', allocationPercent: '50', overAllocationReason: 'Synthetic peak' });
      expect([hrException.statusCode, hrException.json().error]).toEqual([403, 'MANAGER_EXCEPTION_REQUIRED']);
      const managerNoReason = await allocate(h, w.manager, { employeeId: w.employeeEmp, jobId: w.job2Id, startDate: '2026-11-02', endDate: '2026-11-30', allocationPercent: '50' });
      expect(managerNoReason.json().error).toBe('OVER_ALLOCATED');
      const recorded = await allocate(h, w.manager, {
        employeeId: w.employeeEmp,
        jobId: w.job2Id,
        startDate: '2026-11-02',
        endDate: '2026-11-30',
        allocationPercent: '50',
        overAllocationReason: 'Synthetic release peak agreed with the team',
      });
      expect(recorded.statusCode, recorded.body).toBe(201);
      expect(recorded.json().overAllocation).toMatchObject({ reason: 'Synthetic release peak agreed with the team', peakPercent: '110.00', managerEmployeeId: w.managerEmp });
      // A reason when nothing exceeds 100% is refused rather than silently recorded.
      const notNeeded = await allocate(h, w.manager, { employeeId: w.peerEmp, jobId: w.job2Id, startDate: '2026-11-02', endDate: '2026-11-30', allocationPercent: '20', overAllocationReason: 'x' });
      expect(notNeeded.json().error).toBe('EXCEPTION_NOT_NEEDED');
      // The manager's team scope: another manager's employee reads as missing.
      expect((await allocate(h, w.manager, { employeeId: w.outsiderEmp, jobId: w.jobId, allocationPercent: '10' })).statusCode).toBe(404);
      // An update that lifts the total above 100% needs the exception as well.
      const reduced = await h.call(w.hr, 'PATCH', `/v1/timesheet/allocations/${alloc}`, { expectedVersion: 1, allocationPercent: '40' });
      expect(reduced.json()).toMatchObject({ allocationPercent: '40.00', version: 2 });
      const raised = await h.call(w.hr, 'PATCH', `/v1/timesheet/allocations/${alloc}`, { expectedVersion: 2, allocationPercent: '70' });
      // The peak is found later in the interval (the November allocation), compared as numbers: 70 + 50 = 120.
      expect([raised.json().error, raised.json().details]).toEqual(['OVER_ALLOCATED', { peakPercent: '120.00', date: '2026-11-02' }]);
      const stale = await h.call(w.hr, 'PATCH', `/v1/timesheet/allocations/${alloc}`, { expectedVersion: 1, allocationPercent: '30' });
      expect(stale.json().error).toBe('STALE_VERSION');
    });

    it('serialises concurrent allocations of one employee so both cannot pass the capacity check', async () => {
      const racer = (await person(h, A, w.hr, w.managerEmp)).id;
      const [a, b] = await Promise.all([
        allocate(h, w.hr, { employeeId: racer, jobId: w.jobId, allocationPercent: '60' }),
        allocate(h, w.hr, { employeeId: racer, jobId: w.job2Id, allocationPercent: '60' }),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
      expect([a, b].find((r) => r.statusCode === 409)!.json().error).toBe('OVER_ALLOCATED');
      const total = await h.one<{ total: string }>(`select coalesce(sum(allocation_percent), 0)::text as total from resource_allocation where employee_id = $1 and state = 'ACTIVE'`, [racer]);
      expect(total.total).toBe('60.00');
    });

    it('cancels an allocation (kept on record), lists within scope and never across companies', async () => {
      const cancelled = await h.call(w.hr, 'POST', `/v1/timesheet/allocations/${alloc}/cancel`, { reason: 'Synthetic change of plan', expectedVersion: 2 });
      expect(cancelled.json()).toMatchObject({ state: 'CANCELLED', cancelReason: 'Synthetic change of plan' });
      expect((await h.call(w.hr, 'POST', `/v1/timesheet/allocations/${alloc}/cancel`, { reason: 'again', expectedVersion: 3 })).json().error).toBe('INVALID_STATE');
      await expect(h.db.query(`update resource_allocation set state = 'ACTIVE' where id = $1`, [alloc])).rejects.toMatchObject({ code: '23514' });
      await expect(h.db.query(`delete from resource_allocation where id = $1`, [alloc])).rejects.toMatchObject({ code: '23514' });
      // The manager sees the team's allocations only; the employee's own context lists what they can book.
      const teamList = (await h.call(w.manager, 'GET', '/v1/timesheet/allocations?state=ACTIVE')).json().items as { employeeId: string }[];
      expect(teamList.length).toBeGreaterThan(0);
      expect(teamList.every((a) => a.employeeId !== w.outsiderEmp)).toBe(true);
      expect((await h.call(hrFin, 'GET', `/v1/timesheet/allocations/${alloc}`)).statusCode).toBe(404);
      expect((await h.call(bHr, 'GET', `/v1/timesheet/allocations/${alloc}`)).statusCode).toBe(404);
      expect((await h.call(w.employee, 'GET', '/v1/timesheet/allocations')).statusCode).toBe(403);
      const mine = (await h.call(w.employee, 'GET', '/v1/me/timesheet-allocations')).json().items as { jobId: string; activities: { activityId: string }[] }[];
      expect(mine.map((a) => a.jobId)).toEqual([w.job2Id]);
      expect(mine[0]!.activities.map((a) => a.activityId).sort()).toEqual([w.devId, w.meetId].sort());
      // Audit trail of the allocation: creation, two updates and the cancellation with its reason.
      const audit = (await h.db.query<{ action: string; reason: string | null }>(`select action, reason from audit_event where resource_code = 'resource_allocation' and record_key = $1 order by occurred_at, id`, [alloc])).rows;
      expect(audit.map((a) => a.action)).toEqual(['CREATE', 'UPDATE', 'CANCEL']);
      expect(audit.at(-1)!.reason).toBe('Synthetic change of plan');
    });

    it('imports allocations all-or-nothing and reports unknown employees, invalid project dates and over-allocation per row', async () => {
      const newcomer = await person(h, A, w.hr, w.managerEmp);
      const projectCode = (await h.call(w.hr, 'GET', `/v1/timesheet/projects/${w.projectId}`)).json().code as string;
      const header = 'employeeCode,projectCode,jobCode,startDate,endDate,allocationPercent';
      const bad = await h.call(w.hr, 'POST', '/v1/timesheet/allocation-imports', {
        fileName: 'allocations.csv',
        idempotencyKey: uniq('alloc-import-'),
        contentBase64: csv([
          header,
          `${newcomer.code},${projectCode},BUILD,2026-03-02,2026-03-31,50`,
          `NOBODY-1,${projectCode},BUILD,2026-03-02,2026-03-31,50`,
          `${newcomer.code},${projectCode},BUILD,2025-12-01,2026-01-31,50`,
          `${newcomer.code},${projectCode},SUPPORT,2026-03-10,2026-03-20,60`,
          `${newcomer.code},NOPROJECT,BUILD,2026-03-02,2026-03-31,50`,
        ]),
      });
      expect(bad.statusCode, bad.body).toBe(201);
      expect(bad.json().state).toBe('REJECTED');
      expect(bad.json().rows.map((r: { errorCode: string }) => r.errorCode)).toEqual(['BATCH_REJECTED', 'UNKNOWN_EMPLOYEE', 'OUTSIDE_EMPLOYMENT', 'OVER_ALLOCATED', 'UNKNOWN_PROJECT']);
      const jobProjectDates = await h.call(w.hr, 'POST', `/v1/timesheet/projects/${w.projectId}/jobs`, { code: 'LATE', name: 'Starts later', ownerEmployeeId: w.managerEmp, startDate: '2026-05-01' });
      expect(jobProjectDates.statusCode).toBe(201);
      const dates = await h.call(w.hr, 'POST', '/v1/timesheet/allocation-imports', {
        fileName: 'allocations.csv',
        idempotencyKey: uniq('alloc-import-'),
        contentBase64: csv([header, `${newcomer.code},${projectCode},LATE,2026-04-01,2026-05-31,50`]),
      });
      expect(dates.json().rows[0].errorCode).toBe('INVALID_PROJECT_DATES');
      const good = await h.call(w.hr, 'POST', '/v1/timesheet/allocation-imports', {
        fileName: 'allocations.csv',
        idempotencyKey: uniq('alloc-import-'),
        contentBase64: csv([header, `${newcomer.code},${projectCode},BUILD,2026-03-02,2026-03-31,50`, `${newcomer.code},${projectCode},SUPPORT,2026-03-10,2026-03-20,50`]),
      });
      expect(good.json().state).toBe('PREVIEWED');
      // The preview changed nothing; the commit applies every row in one transaction.
      expect((await h.call(w.hr, 'GET', `/v1/timesheet/allocations?employeeId=${newcomer.id}`)).json().items).toEqual([]);
      const committed = await h.call(w.hr, 'POST', `/v1/timesheet/allocation-imports/${good.json().id}/commit`);
      expect(committed.json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 2, rejectedCount: 0 });
      const items = (await h.call(w.hr, 'GET', `/v1/timesheet/allocations?employeeId=${newcomer.id}`)).json().items as { source: string }[];
      expect(items.map((a) => a.source)).toEqual(['IMPORT', 'IMPORT']);
      // Imports need the import duty; the manager has none.
      expect((await h.call(w.manager, 'POST', '/v1/timesheet/allocation-imports', { fileName: 'a.csv', idempotencyKey: uniq('alloc-import-'), contentBase64: csv([header]) })).statusCode).toBe(403);
    });
  });

  followUpSuite({
    path: '/v1/timesheet/allocation-imports',
    template: 'RESOURCE_ALLOCATION_V1',
    harness: () => h,
    company: () => A,
    submitter: () => h.actor(A, 'HR_ADMINISTRATOR'),
    // The manager maintains the team's allocations but holds no import duty.
    denied: async () => [w.manager, w.employee],
    // A new employee each time, allocated to both jobs of the project (nothing is committed).
    validFile: async () => {
      const newcomer = await person(h, A, w.hr, w.managerEmp);
      const projectCode = (await h.call(w.hr, 'GET', `/v1/timesheet/projects/${w.projectId}`)).json().code as string;
      const header = 'employeeCode,projectCode,jobCode,startDate,endDate,allocationPercent';
      return { text: [header, `${newcomer.code},${projectCode},BUILD,2026-03-02,2026-03-31,50`, `${newcomer.code},${projectCode},SUPPORT,2026-03-10,2026-03-20,50`].join('\n'), rows: 2 };
    },
  });
});
