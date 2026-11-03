// Timesheet exports through the report catalogue (FR-046 "search, Export and Export XLSX"; FR-048 "TMS reports by
// employee, project, job, activity and period ... Hours reconcile from detailed lines to employee and project totals";
// FR-065; I-30): the resource allocation export holds the rows of the allocation list, the TMS hours export the groups of
// the hours report, both under the requester's row scope and export permission, with the filters each list applies and
// no other, as CSV or XLSX. Synthetic data; fixed past weeks (2026-03-02 is a Monday).
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { processReportQueue } from '../report/service.js';
import { XLSX_MEDIA_TYPE } from '../report/xlsx.js';
import { readZip, sheetCells, sheetRows } from '../report/xlsx.fixtures.js';
import { isModuleActive } from '../registry.js';
import { addLine, allocate, approvedWeek, openWeek, person, submit, type TimesheetWorld, timesheetWorld } from './timesheet.fixtures.js';

const W1 = '2026-03-02';
const W2 = '2026-03-09';
const W3 = '2026-03-16';
const PERIOD = { from: W1, to: '2026-03-22' };
const OVER_REASON = '=1+1 synthetic cover';
const CANCEL_REASON = '@Synthetic change of plan';

/** The CSV writer's formula guard (FR-065), applied to what the lists return as-is. */
const guard = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
const cells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));
const table = (csv: string) => csv.trimEnd().split('\r\n').map(cells);

describe.runIf(isModuleActive('timesheet'))('timesheet exports (FR-046, FR-048)', () => {
  let h: Harness;
  let A: Company;
  let w: TimesheetWorld;
  let bHr: TestActor;
  let hrFin: TestActor;
  let teamExporter: TestActor;
  let finEmp: string;
  let managerCode: string;

  const request = (a: TestActor, reportCode: string, filters: object = {}, format?: string) => h.call(a, 'POST', '/v1/reports', { reportCode, filters, ...(format ? { format } : {}) });

  /** Requests, generates and downloads a report. */
  async function generated(a: TestActor, reportCode: string, filters: object, format?: string) {
    const res = await request(a, reportCode, filters, format);
    expect(res.statusCode, res.body).toBe(202);
    await processReportQueue(h.pool);
    const status = (await h.call(a, 'GET', `/v1/reports/${res.json().id}`)).json();
    expect(status).toMatchObject({ state: 'COMPLETED', format: format ?? 'CSV' });
    const file = await h.call(a, 'GET', `/v1/reports/${res.json().id}/download`);
    expect(file.statusCode).toBe(200);
    return { id: res.json().id as string, file, rowCount: status.rowCount as number };
  }

  /** A CSV export's rows keyed by column header. */
  async function exported(a: TestActor, reportCode: string, filters: object): Promise<Record<string, string>[]> {
    const { file, rowCount } = await generated(a, reportCode, filters);
    const [header, ...rows] = table(file.body);
    expect(rows).toHaveLength(rowCount);
    return rows.map((l) => Object.fromEntries(header!.map((k, i) => [k, l[i]!])));
  }

  const get = async (a: TestActor, url: string) => {
    const res = await h.call(a, 'GET', url);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    const B = await h.makeCompany();
    w = await timesheetWorld(h, A);
    bHr = await h.actor(B, 'HR_ADMINISTRATOR');
    hrFin = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    managerCode = (await h.one<{ code: string }>(`select employee_code as code from employee where id = $1`, [w.managerEmp])).code;

    // A finance employee of the same manager (the department-filtered HR sees only them).
    const fin = await h.call(w.hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { departmentId: A.financeDept }));
    expect(fin.statusCode, fin.body).toBe(201);
    finEmp = fin.json().id;
    await h.setStatus(A, finEmp, 'ACTIVE_CONFIRMED');
    expect((await h.call(w.hr, 'POST', `/v1/employees/${finEmp}/manager`, { managerEmployeeId: w.managerEmp, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
    const finActor = await h.actor(A, 'EMPLOYEE', { employeeId: finEmp });

    // Test setup only: a manager assignment holding both exports (not a baseline grant), to show the TEAM scope applies.
    await h.db.query(
      `insert into role_permission (company_id, role_id, permission_id, effect)
       select $1, r.id, p.id, 'ALLOW' from role r, permission p
        where r.company_id = $1 and r.code = 'REPORTING_MANAGER' and p.action = 'export' and p.field_group = 'operational' and p.resource in ('timesheet', 'timesheet_allocation')`,
      [A.id],
    );
    teamExporter = await h.actor(A, 'REPORTING_MANAGER', { user: w.manager.user, extra: ['timesheet.export.operational', 'timesheet_allocation.export.operational'] });

    const allocated = async (a: TestActor, body: Record<string, unknown>) => {
      const res = await allocate(h, a, body);
      expect(res.statusCode, res.body).toBe(201);
      return res.json() as { id: string; version: number };
    };
    await allocated(w.hr, { employeeId: w.employeeEmp, jobId: w.jobId, allocationPercent: '60' });
    await allocated(w.hr, { employeeId: w.employeeEmp, jobId: w.job2Id, allocationPercent: '40' });
    await allocated(w.hr, { employeeId: w.peerEmp, jobId: w.jobId, allocationPercent: '100' });
    // F1: above 100% only with the direct manager's exception and reason (formula-like on purpose, FR-065).
    await allocated(w.manager, { employeeId: w.peerEmp, jobId: w.job2Id, allocationPercent: '20', overAllocationReason: OVER_REASON });
    await allocated(w.hr, { employeeId: finEmp, jobId: w.jobId, allocationPercent: '50' });
    const cancelled = await allocated(w.hr, { employeeId: finEmp, jobId: w.job2Id, allocationPercent: '50' });
    expect((await h.call(w.hr, 'POST', `/v1/timesheet/allocations/${cancelled.id}/cancel`, { reason: CANCEL_REASON, expectedVersion: cancelled.version })).statusCode).toBe(200);
    // Another manager's employee, in June only.
    await allocated(w.hr, { employeeId: w.outsiderEmp, jobId: w.job2Id, startDate: '2026-06-01', endDate: '2026-06-30', allocationPercent: '10' });

    const line = (workDate: string, jobId: string, activityId: string, minutes: number) => ({ workDate, jobId, activityId, minutes });
    await approvedWeek(h, w, w.employee, W1, [
      line(W1, w.jobId, w.devId, 480),
      line('2026-03-03', w.jobId, w.meetId, 240),
      line('2026-03-03', w.job2Id, w.devId, 240),
      line('2026-03-04', w.jobId, w.devId, 120),
    ]);
    await approvedWeek(h, w, w.employee, W2, [line(W2, w.jobId, w.devId, 480)]);
    await approvedWeek(h, w, w.peer, W1, [line(W1, w.job2Id, w.devId, 480)]);
    await approvedWeek(h, w, finActor, W1, [line(W1, w.jobId, w.devId, 240)]);
    // Submitted but not approved: never counted.
    const pending = await openWeek(h, w.employee, W3);
    expect((await addLine(h, w.employee, pending.id, line(W3, w.jobId, w.devId, 480))).statusCode).toBe(201);
    expect((await submit(h, w.employee, pending.id)).statusCode).toBe(200);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('lists both exports in the catalogue, with XLSX as their second format', async () => {
    const items = (await get(w.hr, '/v1/reports/catalogue')).items as { code: string; requiresPeriod: boolean; columns: string[]; formats?: string[] }[];
    expect(items.find((r) => r.code === 'RESOURCE_ALLOCATION')).toMatchObject({ requiresPeriod: false, formats: ['CSV', 'XLSX'], columns: expect.arrayContaining(['Employee code', 'Job code', 'Allocation %', 'State']) });
    expect(items.find((r) => r.code === 'TMS_HOURS')).toMatchObject({
      requiresPeriod: true,
      formats: ['CSV', 'XLSX'],
      columns: ['Employee code', 'Employee name', 'Project code', 'Project name', 'Job code', 'Job name', 'Activity code', 'Activity name', 'Week starting', 'Approved minutes', 'Approved hours', 'Productive minutes', 'Lines'],
    });
  });

  describe('resource allocations (FR-046)', () => {
    type Allocation = {
      employeeId: string;
      employeeCode: string;
      employeeName: string;
      projectCode: string;
      jobCode: string;
      jobName: string;
      startDate: string;
      endDate: string;
      allocationPercent: string;
      state: string;
      source: string;
      overAllocation: { reason: string; peakPercent: string } | null;
      cancelReason: string | null;
    };
    const fromList = (items: Allocation[]) =>
      items.map((i) => [
        i.employeeCode,
        i.employeeName,
        i.projectCode,
        i.jobCode,
        i.jobName,
        i.startDate,
        i.endDate,
        i.allocationPercent,
        i.state,
        i.source,
        i.overAllocation?.peakPercent ?? '',
        guard(i.overAllocation?.reason ?? ''),
        guard(i.cancelReason ?? ''),
      ]);
    const fromExport = (rows: Record<string, string>[]) =>
      rows.map((r) => [
        r['Employee code'],
        r['Employee name'],
        r['Project code'],
        r['Job code'],
        r['Job name'],
        r['Start date'],
        r['End date'],
        r['Allocation %'],
        r.State,
        r.Source,
        r['Over-allocation peak %'],
        r['Over-allocation reason'],
        r['Cancellation reason'],
      ]);
    const list = async (a: TestActor, query = '') => (await get(a, `/v1/timesheet/allocations?pageSize=100${query}`)) as { items: Allocation[]; total: number };

    it('holds every row of the allocation list, in its order, with the exception and cancellation guarded (FR-065)', async () => {
      const listed = await list(w.hr);
      expect(listed.total).toBe(7);
      const rows = await exported(w.hr, 'RESOURCE_ALLOCATION', {});
      expect(fromExport(rows)).toEqual(fromList(listed.items));
      const over = rows.find((r) => r['Over-allocation reason'] !== '')!;
      expect(over).toMatchObject({ 'Over-allocation peak %': '120.00', 'Over-allocation reason': `'${OVER_REASON}`, 'Over-allocation recorded by manager': managerCode, State: 'ACTIVE' });
      expect(over['Over-allocation recorded at (company time)']).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      const cancelled = rows.find((r) => r.State === 'CANCELLED')!;
      expect(cancelled['Cancellation reason']).toBe(`'${CANCEL_REASON}`);
      expect(cancelled['Cancelled at (company time)']).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(rows.filter((r) => r['Cancelled at (company time)'] !== '')).toHaveLength(1);
    });

    it("applies the list's filters: employee, project, job, overlapping period and state (as `status`)", async () => {
      const cases: [Record<string, string>, string, number][] = [
        [{ employeeId: w.peerEmp }, `&employeeId=${w.peerEmp}`, 2],
        [{ projectId: w.projectId, jobId: w.job2Id }, `&projectId=${w.projectId}&jobId=${w.job2Id}`, 4],
        [{ status: 'CANCELLED' }, '&state=CANCELLED', 1],
        [{ jobId: w.jobId, status: 'ACTIVE' }, `&jobId=${w.jobId}&state=ACTIVE`, 3],
        [{ from: '2026-03-01', to: '2026-03-31' }, '&from=2026-03-01&to=2026-03-31', 6],
        [{ from: '2026-06-15' }, '&from=2026-06-15', 7],
        [{ to: '2026-01-04' }, '&to=2026-01-04', 0],
      ];
      for (const [filters, query, n] of cases) {
        const listed = await list(w.hr, query);
        expect(listed.total, query).toBe(n);
        expect(fromExport(await exported(w.hr, 'RESOURCE_ALLOCATION', filters)), query).toEqual(fromList(listed.items));
      }
    });

    it("applies the requester's row scope: department filter, team and company", async () => {
      const fin = await list(hrFin);
      expect(fin.items.map((i) => i.employeeId)).toEqual([finEmp, finEmp]);
      expect(fromExport(await exported(hrFin, 'RESOURCE_ALLOCATION', {}))).toEqual(fromList(fin.items));
      // The manager's team: the other manager's employee is not exported.
      const team = await list(teamExporter);
      expect(team.total).toBe(6);
      expect(team.items.some((i) => i.employeeId === w.outsiderEmp)).toBe(false);
      expect(fromExport(await exported(teamExporter, 'RESOURCE_ALLOCATION', {}))).toEqual(fromList(team.items));
      expect(await exported(bHr, 'RESOURCE_ALLOCATION', {})).toEqual([]);
    });
  });

  describe('TMS hours (FR-048)', () => {
    type Group = { employeeCode: string; projectCode: string; jobCode: string; activityCode: string; periodStart: string; minutes: number; hours: string; productiveMinutes: number; lineCount: number };
    const hours = async (a: TestActor, groupBy: string, query = '') => get(a, `/v1/timesheet-reports/hours?from=${PERIOD.from}&to=${PERIOD.to}&groupBy=${groupBy}${query}`);
    const fromReport = (groups: Group[]) => groups.map((g) => [g.employeeCode, g.projectCode, g.jobCode, g.activityCode, g.periodStart, String(g.minutes), g.hours, String(g.productiveMinutes), String(g.lineCount)]);
    const fromExport = (rows: Record<string, string>[]) =>
      rows.map((r) => [r['Employee code'], r['Project code'], r['Job code'], r['Activity code'], r['Week starting'], r['Approved minutes'], r['Approved hours'], r['Productive minutes'], r.Lines]);
    const sum = (rows: Record<string, string>[], key: string) => rows.reduce((n, r) => n + Number(r[key]), 0);
    const ALL = 'employee,project,job,activity,period';

    it('holds the hours report grouped by employee, project, job, activity and week, from approved lines only', async () => {
      const report = await hours(w.hr, ALL);
      const rows = await exported(w.hr, 'TMS_HOURS', PERIOD);
      expect(rows).toHaveLength(report.totalGroups);
      expect(fromExport(rows)).toEqual(fromReport(report.groups));
      // W1: 600 + 240 + 240 for the employee, W2: 480; the peer and the finance employee one line each; the
      // submitted-but-unapproved W3 line is not counted.
      expect(report.totals).toEqual({ minutes: 2280, hours: '38.00', productiveMinutes: 2040, lineCount: 7 });
      expect(rows.find((r) => r['Employee code'] === w.employeeCode && r['Week starting'] === W1 && r['Job code'] === 'BUILD' && r['Activity code']!.startsWith('DEV'))).toMatchObject({
        'Approved minutes': '600',
        'Approved hours': '10.00',
        'Productive minutes': '600',
        Lines: '2',
      });
      expect(rows.some((r) => r['Week starting'] === W3)).toBe(false);
    });

    it('reconciles from the detailed lines to the totals and to the employee and project totals', async () => {
      const report = await hours(w.hr, ALL);
      const rows = await exported(w.hr, 'TMS_HOURS', PERIOD);
      expect([sum(rows, 'Approved minutes'), sum(rows, 'Productive minutes'), sum(rows, 'Lines')]).toEqual([report.totals.minutes, report.totals.productiveMinutes, report.totals.lineCount]);
      const lines = await get(w.hr, `/v1/timesheet-reports/lines?from=${PERIOD.from}&to=${PERIOD.to}`);
      expect([lines.total, (lines.items as { minutes: number }[]).reduce((n, l) => n + l.minutes, 0)]).toEqual([sum(rows, 'Lines'), sum(rows, 'Approved minutes')]);
      const by = (key: string) => rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r[key]!]: (m[r[key]!] ?? 0) + Number(r['Approved minutes']) }), {});
      const employees = (await hours(w.hr, 'employee')).groups as { employeeCode: string; minutes: number }[];
      expect(by('Employee code')).toEqual(Object.fromEntries(employees.map((g) => [g.employeeCode, g.minutes])));
      const projects = (await hours(w.hr, 'project')).groups as { projectCode: string; minutes: number }[];
      expect(by('Project code')).toEqual(Object.fromEntries(projects.map((g) => [g.projectCode, g.minutes])));
    });

    it("applies the report's filters and the requester's row scope", async () => {
      const cases: [Record<string, string>, string][] = [
        [{ activityId: w.meetId }, `&activityId=${w.meetId}`],
        [{ employeeId: w.peerEmp }, `&employeeId=${w.peerEmp}`],
        [{ projectId: w.projectId, jobId: w.job2Id }, `&projectId=${w.projectId}&jobId=${w.job2Id}`],
      ];
      for (const [filters, query] of cases) {
        const report = await hours(w.hr, ALL, query);
        expect(report.groups.length, query).toBeGreaterThan(0);
        expect(fromExport(await exported(w.hr, 'TMS_HOURS', { ...PERIOD, ...filters })), query).toEqual(fromReport(report.groups));
      }
      const fin = await hours(hrFin, ALL);
      expect(fin.totals.minutes).toBe(240);
      expect(fromExport(await exported(hrFin, 'TMS_HOURS', PERIOD))).toEqual(fromReport(fin.groups));
      expect(fromExport(await exported(teamExporter, 'TMS_HOURS', PERIOD))).toEqual(fromReport((await hours(teamExporter, ALL)).groups));
      expect(await exported(bHr, 'TMS_HOURS', PERIOD)).toEqual([]);
    });
  });

  it('is refused without the export permission, and refuses the filters its list does not apply', async () => {
    const queued = async () => (await h.one<{ n: number }>(`select count(*)::int as n from report_execution where company_id = $1`, [A.id])).n;
    const before = await queued();
    // The read and report duties are not the export: the manager and the employee hold no export grant.
    for (const a of [w.manager, w.employee]) {
      expect((await request(a, 'RESOURCE_ALLOCATION')).statusCode).toBe(403);
      expect((await request(a, 'TMS_HOURS', PERIOD)).statusCode).toBe(403);
    }
    // Each export needs its own permission: the allocation export does not open the hours export.
    const allocationOnly = await h.actor(A, 'HR_ADMINISTRATOR');
    await h.db.query(
      `update role_assignment_permission set active = false
        where role_assignment_id = $1 and permission_id = (select id from permission where resource = 'timesheet' and action = 'export' and field_group = 'operational')`,
      [allocationOnly.assignment],
    );
    expect((await request(allocationOnly, 'TMS_HOURS', PERIOD)).statusCode).toBe(403);
    expect((await request(allocationOnly, 'RESOURCE_ALLOCATION')).statusCode).toBe(202);
    const refused: [string, object, number, string][] = [
      ['RESOURCE_ALLOCATION', { activityId: w.devId }, 422, 'FILTER_NOT_SUPPORTED'],
      ['RESOURCE_ALLOCATION', { search: 'x' }, 422, 'FILTER_NOT_SUPPORTED'],
      ['RESOURCE_ALLOCATION', { departmentId: A.dept }, 422, 'FILTER_NOT_SUPPORTED'],
      ['RESOURCE_ALLOCATION', { basis: 'MONTHLY_GROSS' }, 422, 'FILTER_NOT_SUPPORTED'],
      ['RESOURCE_ALLOCATION', { status: 'DRAFT' }, 422, 'INVALID_FILTER'],
      ['RESOURCE_ALLOCATION', { from: '2026-03-31', to: '2026-03-01' }, 422, 'INVALID_PERIOD'],
      ['TMS_HOURS', { ...PERIOD, status: 'APPROVED' }, 422, 'FILTER_NOT_SUPPORTED'],
      ['TMS_HOURS', { ...PERIOD, search: 'x' }, 422, 'FILTER_NOT_SUPPORTED'],
      ['TMS_HOURS', { ...PERIOD, joinedFrom: '2026-01-01' }, 422, 'FILTER_NOT_SUPPORTED'],
      ['TMS_HOURS', {}, 422, 'PERIOD_REQUIRED'],
      ['TMS_HOURS', { from: '2026-01-01', to: '2027-01-02' }, 422, 'PERIOD_TOO_LONG'],
      ['TMS_HOURS', { ...PERIOD, employeeId: 'not-a-uuid' }, 400, 'VALIDATION'],
    ];
    for (const [code, filters, status, error] of refused) {
      const res = await request(w.hr, code, filters);
      expect(res.statusCode, `${code} ${JSON.stringify(filters)}`).toBe(status);
      if (status === 422) expect(res.json().error).toBe(error);
    }
    expect(await queued()).toBe(before + 1);
  });

  it('generates either export as an XLSX workbook holding the CSV rows, with numbers as numbers and formula-like text guarded', async () => {
    for (const [code, filters] of [
      ['RESOURCE_ALLOCATION', {}],
      ['TMS_HOURS', PERIOD],
    ] as const) {
      const csv = table((await generated(w.hr, code, filters)).file.body);
      const { id, file } = await generated(w.hr, code, filters, 'XLSX');
      expect(file.headers['content-type']).toBe(XLSX_MEDIA_TYPE);
      expect(file.headers['content-disposition']).toMatch(new RegExp(`filename="${code.toLowerCase()}-[0-9a-f]{8}\\.xlsx"$`));
      const bytes = file.rawPayload;
      const entries = readZip(bytes);
      const xml = entries.get('xl/worksheets/sheet1.xml')!.toString('utf8');
      expect(sheetRows(xml, csv[0]!.length)).toEqual(csv);
      // The attachment records the workbook's media type and checksum.
      const attachment = await h.one<{ media_type: string; checksum: string; classification: string }>(
        `select a.media_type, a.checksum, a.classification from report_execution x join attachment a on a.company_id = x.company_id and a.id = x.output_attachment_id where x.id = $1`,
        [id],
      );
      expect(attachment).toEqual({ media_type: XLSX_MEDIA_TYPE, checksum: createHash('sha256').update(bytes).digest('hex'), classification: 'OPERATIONAL' });
      const kinds = sheetCells(xml);
      const header = csv[0]!;
      if (code === 'RESOURCE_ALLOCATION') {
        const reasonColumn = header.indexOf('Over-allocation reason');
        const reason = kinds.flat().find((c) => c.value === `'${OVER_REASON}`)!;
        expect(reason).toMatchObject({ kind: 'text' });
        expect(reason.ref.replace(/\d+$/, '')).toBe(String.fromCharCode(65 + reasonColumn));
        expect(kinds[1]!.find((c) => c.ref === `${String.fromCharCode(65 + header.indexOf('Allocation %'))}2`)).toMatchObject({ kind: 'number' });
        expect(kinds[1]!.find((c) => c.ref === 'A2')).toMatchObject({ kind: 'text' });
      } else {
        const minutes = String.fromCharCode(65 + header.indexOf('Approved minutes'));
        const hoursColumn = String.fromCharCode(65 + header.indexOf('Approved hours'));
        for (const row of kinds.slice(1)) {
          expect(row.find((c) => c.ref.startsWith(minutes))).toMatchObject({ kind: 'number' });
          expect(row.find((c) => c.ref.startsWith(hoursColumn))).toMatchObject({ kind: 'number' });
        }
      }
    }
  });
});
