// Imported timesheet entries (FR-047 acceptance "daily total limits apply equally to manual and imported entries";
// DF09). Template TIMESHEET_LINES_V1: employeeCode, workDate, projectCode, jobCode, activityCode, minutes, note.
// Each row is recorded through the same path as a manual entry (insertLine: allocation, masters, quarter hours,
// duplicates and the 24-hour day, counted together with the lines already there and the rows before it) into the
// employee's draft timesheet of that week, which is opened when it does not exist yet. The employee still reviews
// and submits it. Batches are all-or-nothing (imports/batch.ts); every row needs the employee in the importer's scope.
import { notFound } from '../../http/errors.js';
import { canAccessEmployee } from '../access/authorize.js';
import { isCalendarDate, parseTemplate, RowError, type Template } from '../imports/batch.js';
import type { BatchSpec } from '../imports/jobs.js';
import { actorOf, mondayOf } from './common.js';
import { insertLine, lockSheet, openSheet } from './sheets.js';

const COLUMNS = ['employeeCode', 'workDate', 'projectCode', 'jobCode', 'activityCode', 'minutes', 'note'] as const;
type Column = (typeof COLUMNS)[number];
export const LINE_TEMPLATE: Template<Column> = { code: 'TIMESHEET_LINES_V1', columns: COLUMNS };

export const LINE_IMPORT_SPEC: BatchSpec<Column> = {
  kind: 'timesheet_lines',
  template: LINE_TEMPLATE,
  parse: (bytes) => parseTemplate(bytes, LINE_TEMPLATE),
  keyOf: (row, n) =>
    row.employeeCode ? `${row.employeeCode.toUpperCase()}@${row.workDate}@${row.projectCode.toUpperCase()}/${row.jobCode.toUpperCase()}/${row.activityCode.toUpperCase()}` : `ROW-${n}`,
  async apply(client, grant, row) {
    if (!isCalendarDate(row.workDate)) throw new RowError('INVALID_DATE');
    if (!/^\d{1,4}$/.test(row.minutes)) throw new RowError('INVALID_MINUTES');
    const employee = (await client.query<{ id: string }>(`select id from employee where company_id = $1 and employee_code = $2`, [grant.companyId, row.employeeCode.toUpperCase()])).rows[0];
    if (!employee) throw new RowError('UNKNOWN_EMPLOYEE');
    if (!(await canAccessEmployee(client, grant, employee.id))) throw notFound();
    const job = (
      await client.query<{ id: string }>(
        `select j.id from timesheet_job j join timesheet_project p on p.company_id = j.company_id and p.id = j.project_id
          where j.company_id = $1 and p.code = $2 and j.code = $3`,
        [grant.companyId, row.projectCode.toUpperCase(), row.jobCode.toUpperCase()],
      )
    ).rows[0];
    if (!job) {
      const project = await client.query(`select 1 from timesheet_project where company_id = $1 and code = $2`, [grant.companyId, row.projectCode.toUpperCase()]);
      throw new RowError((project.rowCount ?? 0) > 0 ? 'UNKNOWN_JOB' : 'UNKNOWN_PROJECT');
    }
    const activity = (await client.query<{ id: string }>(`select id from timesheet_activity where company_id = $1 and code = $2`, [grant.companyId, row.activityCode.toUpperCase()])).rows[0];
    if (!activity) throw new RowError('UNKNOWN_ACTIVITY');
    const actor = actorOf(grant);
    const opened = await openSheet(client, actor, grant.businessDate, employee.id, mondayOf(row.workDate));
    const sheet = (await lockSheet(client, grant.companyId, 't.id = $2', [opened.id]))!;
    await insertLine(client, actor, grant.businessDate, sheet, { workDate: row.workDate, jobId: job.id, activityId: activity.id, minutes: Number(row.minutes), note: row.note || null }, 'IMPORT');
  },
};
