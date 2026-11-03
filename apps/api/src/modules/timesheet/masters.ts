// FR-045 projects, jobs and activities (DB066-DB068; F1): company-wide masters with a code, a name, an owner, an
// inclusive validity period and an active flag. A job belongs to exactly one project (fixed at creation); activities
// are a reusable catalogue that jobs permit through approved job-activity links. Codes never change and nothing is
// deleted (DF08): a master is deactivated or its period ended, and entries recorded earlier keep their classification.
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import type { AccessGrant } from '../access/authorize.js';
import { actorOf, assertCompanyWide, audit, requireDate } from './common.js';

export interface MasterInput {
  code: string;
  name: string;
  ownerEmployeeId: string;
  startDate: string;
  endDate?: string | null | undefined;
}

export interface MasterPatch {
  expectedVersion: number;
  name?: string | undefined;
  ownerEmployeeId?: string | undefined;
  startDate?: string | undefined;
  endDate?: string | null | undefined;
  active?: boolean | undefined;
}

type MasterTable = 'timesheet_project' | 'timesheet_job' | 'timesheet_activity';

const normaliseCode = (code: string) => code.trim().toUpperCase();

function checkPeriod(startDate: string, endDate: string | null): void {
  requireDate(startDate, 'startDate');
  if (endDate !== null) requireDate(endDate, 'endDate');
  if (endDate !== null && endDate < startDate) throw new HttpError(422, 'INVALID_PERIOD', 'The end date is before the start date');
}

/** FR-045: every master has an owner, an employee of the same company. */
async function checkOwner(tx: Queryable, companyId: string, ownerEmployeeId: string): Promise<void> {
  const r = await tx.query(`select 1 from employee where company_id = $1 and id = $2`, [companyId, ownerEmployeeId]);
  if ((r.rowCount ?? 0) === 0) throw new HttpError(422, 'INVALID_OWNER', 'The owner must be an employee of this company', { field: 'ownerEmployeeId' });
}

const MASTER_COLUMNS = (alias: string) =>
  `${alias}.id, ${alias}.code, ${alias}.name, ${alias}.owner_employee_id as "ownerEmployeeId", oe.employee_code as "ownerEmployeeCode", oe.display_name as "ownerName",
   to_char(${alias}.start_date, 'YYYY-MM-DD') as "startDate", to_char(${alias}.end_date, 'YYYY-MM-DD') as "endDate", ${alias}.active, ${alias}.version,
   ${alias}.created_at as "createdAt", ${alias}.updated_at as "updatedAt"`;

const OWNER_JOIN = (alias: string) => `join employee oe on oe.company_id = ${alias}.company_id and oe.id = ${alias}.owner_employee_id`;

// ---------------------------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------------------------

export async function createProject(tx: Queryable, grant: AccessGrant, input: MasterInput) {
  assertCompanyWide(grant);
  const endDate = input.endDate ?? null;
  checkPeriod(input.startDate, endDate);
  await checkOwner(tx, grant.companyId, input.ownerEmployeeId);
  const code = normaliseCode(input.code);
  const exists = await tx.query(`select 1 from timesheet_project where company_id = $1 and code = $2`, [grant.companyId, code]);
  if ((exists.rowCount ?? 0) > 0) throw new HttpError(409, 'CODE_EXISTS', 'A project with this code already exists');
  const id = (
    await tx.query<{ id: string }>(
      `insert into timesheet_project (company_id, code, name, owner_employee_id, start_date, end_date, active, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, true, $7, $7) returning id`,
      [grant.companyId, code, input.name.trim(), input.ownerEmployeeId, input.startDate, endDate, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, actorOf(grant), 'timesheet_project', id, 'CREATE', null, { code, name: input.name.trim(), ownerEmployeeId: input.ownerEmployeeId, startDate: input.startDate, endDate, active: true }, { newVersion: 1 });
  return projectDetail(tx, grant, id);
}

/** Applies a master patch to any of the three master tables (same columns, same rules). */
async function patchMaster(tx: Queryable, grant: AccessGrant, table: MasterTable, id: string, patch: MasterPatch, extra: { productive?: boolean | undefined } = {}) {
  assertCompanyWide(grant);
  const current = (
    await tx.query<{ name: string; owner_employee_id: string; start_date: string; end_date: string | null; active: boolean; version: number; productive: boolean | null }>(
      `select name, owner_employee_id, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date, active, version,
              ${table === 'timesheet_activity' ? 'productive' : 'null::boolean as productive'}
         from ${table} where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!current) throw notFound();
  if (current.version !== patch.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  const next = {
    name: patch.name?.trim() ?? current.name,
    ownerEmployeeId: patch.ownerEmployeeId ?? current.owner_employee_id,
    startDate: patch.startDate ?? current.start_date,
    endDate: patch.endDate === undefined ? current.end_date : patch.endDate,
    active: patch.active ?? current.active,
    ...(table === 'timesheet_activity' ? { productive: extra.productive ?? current.productive } : {}),
  };
  checkPeriod(next.startDate, next.endDate);
  if (next.ownerEmployeeId !== current.owner_employee_id) await checkOwner(tx, grant.companyId, next.ownerEmployeeId);
  const version = (
    await tx.query<{ version: number }>(
      `update ${table} set name = $3, owner_employee_id = $4, start_date = $5, end_date = $6, active = $7, updated_by = $8
              ${table === 'timesheet_activity' ? ', productive = $9' : ''}
        where company_id = $1 and id = $2 returning version`,
      [grant.companyId, id, next.name, next.ownerEmployeeId, next.startDate, next.endDate, next.active, grant.userId, ...(table === 'timesheet_activity' ? [next.productive] : [])],
    )
  ).rows[0]!.version;
  const before = {
    name: current.name,
    ownerEmployeeId: current.owner_employee_id,
    startDate: current.start_date,
    endDate: current.end_date,
    active: current.active,
    ...(table === 'timesheet_activity' ? { productive: current.productive } : {}),
  };
  const action = current.active && !next.active ? 'DEACTIVATE' : !current.active && next.active ? 'ACTIVATE' : 'UPDATE';
  await audit(tx, actorOf(grant), table, id, action, before, next, { priorVersion: current.version, newVersion: version });
}

export async function updateProject(tx: Queryable, grant: AccessGrant, id: string, patch: MasterPatch) {
  await patchMaster(tx, grant, 'timesheet_project', id, patch);
  return projectDetail(tx, grant, id);
}

/** Masters answered without page/pageSize (each list's first answer before it could page). */
export const MASTER_LIST_CAP = 1000;

/** Projects by code: one page (FR-056), or the first 1,000 without page/pageSize; `total` counts all. */
export async function listProjects(db: Queryable, grant: AccessGrant, q: { active?: boolean | undefined } & Paging) {
  return pageOf(
    db,
    `select ${MASTER_COLUMNS('p')},
            (select count(*)::int from timesheet_job j where j.company_id = p.company_id and j.project_id = p.id) as "jobCount"
       from timesheet_project p ${OWNER_JOIN('p')}
      where p.company_id = $1 and ($2::boolean is null or p.active = $2)`,
    [grant.companyId, q.active ?? null],
    'code, id',
    q,
    MASTER_LIST_CAP,
  );
}

/** A project with its jobs and each job's permitted activities. */
export async function projectDetail(db: Queryable, grant: AccessGrant, id: string) {
  const project = (await db.query(`select ${MASTER_COLUMNS('p')} from timesheet_project p ${OWNER_JOIN('p')} where p.company_id = $1 and p.id = $2`, [grant.companyId, id])).rows[0];
  if (!project) throw notFound();
  const jobs = (
    await db.query(
      `select ${MASTER_COLUMNS('j')}, j.project_id as "projectId",
              coalesce((select json_agg(json_build_object('activityId', a.id, 'code', a.code, 'name', a.name, 'productive', a.productive,
                                                          'activityActive', a.active, 'linkActive', ja.active) order by a.code)
                          from timesheet_job_activity ja join timesheet_activity a on a.company_id = ja.company_id and a.id = ja.activity_id
                         where ja.company_id = j.company_id and ja.job_id = j.id), '[]'::json) as activities
         from timesheet_job j ${OWNER_JOIN('j')}
        where j.company_id = $1 and j.project_id = $2 order by j.code`,
      [grant.companyId, id],
    )
  ).rows;
  return { ...project, jobs };
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------------------------

export async function createJob(tx: Queryable, grant: AccessGrant, projectId: string, input: MasterInput) {
  assertCompanyWide(grant);
  const project = (await tx.query<{ id: string }>(`select id from timesheet_project where company_id = $1 and id = $2 for share`, [grant.companyId, projectId])).rows[0];
  if (!project) throw notFound();
  const endDate = input.endDate ?? null;
  checkPeriod(input.startDate, endDate);
  await checkOwner(tx, grant.companyId, input.ownerEmployeeId);
  const code = normaliseCode(input.code);
  const exists = await tx.query(`select 1 from timesheet_job where company_id = $1 and project_id = $2 and code = $3`, [grant.companyId, projectId, code]);
  if ((exists.rowCount ?? 0) > 0) throw new HttpError(409, 'CODE_EXISTS', 'The project already has a job with this code');
  const id = (
    await tx.query<{ id: string }>(
      `insert into timesheet_job (company_id, project_id, code, name, owner_employee_id, start_date, end_date, active, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, true, $8, $8) returning id`,
      [grant.companyId, projectId, code, input.name.trim(), input.ownerEmployeeId, input.startDate, endDate, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, actorOf(grant), 'timesheet_job', id, 'CREATE', null, { projectId, code, name: input.name.trim(), ownerEmployeeId: input.ownerEmployeeId, startDate: input.startDate, endDate, active: true }, { newVersion: 1 });
  return jobDetail(tx, grant, id);
}

export async function updateJob(tx: Queryable, grant: AccessGrant, id: string, patch: MasterPatch) {
  await patchMaster(tx, grant, 'timesheet_job', id, patch);
  return jobDetail(tx, grant, id);
}

export async function jobDetail(db: Queryable, grant: AccessGrant, id: string) {
  const job = (
    await db.query(
      `select ${MASTER_COLUMNS('j')}, j.project_id as "projectId", p.code as "projectCode", p.name as "projectName",
              coalesce((select json_agg(json_build_object('activityId', a.id, 'code', a.code, 'name', a.name, 'productive', a.productive,
                                                          'activityActive', a.active, 'linkActive', ja.active) order by a.code)
                          from timesheet_job_activity ja join timesheet_activity a on a.company_id = ja.company_id and a.id = ja.activity_id
                         where ja.company_id = j.company_id and ja.job_id = j.id), '[]'::json) as activities
         from timesheet_job j ${OWNER_JOIN('j')}
         join timesheet_project p on p.company_id = j.company_id and p.id = j.project_id
        where j.company_id = $1 and j.id = $2`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!job) throw notFound();
  return job;
}

/** F1 approved job activities: links an activity to a job, or deactivates/reactivates the link (kept on record). */
export async function setJobActivity(tx: Queryable, grant: AccessGrant, jobId: string, activityId: string, active: boolean) {
  assertCompanyWide(grant);
  const job = (await tx.query(`select 1 from timesheet_job where company_id = $1 and id = $2`, [grant.companyId, jobId])).rowCount;
  const activity = (await tx.query(`select 1 from timesheet_activity where company_id = $1 and id = $2`, [grant.companyId, activityId])).rowCount;
  if (!job || !activity) throw notFound();
  const current = (
    await tx.query<{ id: string; active: boolean; version: number }>(`select id, active, version from timesheet_job_activity where company_id = $1 and job_id = $2 and activity_id = $3 for update`, [
      grant.companyId,
      jobId,
      activityId,
    ])
  ).rows[0];
  if (!current) {
    if (!active) throw notFound();
    const id = (
      await tx.query<{ id: string }>(
        `insert into timesheet_job_activity (company_id, job_id, activity_id, active, created_by, updated_by) values ($1, $2, $3, true, $4, $4) returning id`,
        [grant.companyId, jobId, activityId, grant.userId],
      )
    ).rows[0]!.id;
    await audit(tx, actorOf(grant), 'timesheet_job_activity', id, 'CREATE', null, { jobId, activityId, active: true }, { newVersion: 1 });
  } else if (current.active !== active) {
    const version = (
      await tx.query<{ version: number }>(`update timesheet_job_activity set active = $3, updated_by = $4 where company_id = $1 and id = $2 returning version`, [
        grant.companyId,
        current.id,
        active,
        grant.userId,
      ])
    ).rows[0]!.version;
    await audit(tx, actorOf(grant), 'timesheet_job_activity', current.id, active ? 'ACTIVATE' : 'DEACTIVATE', { jobId, activityId, active: current.active }, { jobId, activityId, active }, {
      priorVersion: current.version,
      newVersion: version,
    });
  }
  return jobDetail(tx, grant, jobId);
}

// ---------------------------------------------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------------------------------------------

export async function createActivity(tx: Queryable, grant: AccessGrant, input: MasterInput & { productive: boolean }) {
  assertCompanyWide(grant);
  const endDate = input.endDate ?? null;
  checkPeriod(input.startDate, endDate);
  await checkOwner(tx, grant.companyId, input.ownerEmployeeId);
  const code = normaliseCode(input.code);
  const exists = await tx.query(`select 1 from timesheet_activity where company_id = $1 and code = $2`, [grant.companyId, code]);
  if ((exists.rowCount ?? 0) > 0) throw new HttpError(409, 'CODE_EXISTS', 'An activity with this code already exists');
  const id = (
    await tx.query<{ id: string }>(
      `insert into timesheet_activity (company_id, code, name, owner_employee_id, productive, start_date, end_date, active, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, true, $8, $8) returning id`,
      [grant.companyId, code, input.name.trim(), input.ownerEmployeeId, input.productive, input.startDate, endDate, grant.userId],
    )
  ).rows[0]!.id;
  await audit(
    tx,
    actorOf(grant),
    'timesheet_activity',
    id,
    'CREATE',
    null,
    { code, name: input.name.trim(), ownerEmployeeId: input.ownerEmployeeId, productive: input.productive, startDate: input.startDate, endDate, active: true },
    { newVersion: 1 },
  );
  return activityDetail(tx, grant, id);
}

export async function updateActivity(tx: Queryable, grant: AccessGrant, id: string, patch: MasterPatch & { productive?: boolean | undefined }) {
  await patchMaster(tx, grant, 'timesheet_activity', id, patch, { productive: patch.productive });
  return activityDetail(tx, grant, id);
}

export async function activityDetail(db: Queryable, grant: AccessGrant, id: string) {
  const row = (await db.query(`select ${MASTER_COLUMNS('a')}, a.productive from timesheet_activity a ${OWNER_JOIN('a')} where a.company_id = $1 and a.id = $2`, [grant.companyId, id])).rows[0];
  if (!row) throw notFound();
  return row;
}

/** Activities by code: one page (FR-056), or the first 1,000 without page/pageSize; `total` counts all. */
export async function listActivities(db: Queryable, grant: AccessGrant, q: { active?: boolean | undefined } & Paging) {
  return pageOf(
    db,
    `select ${MASTER_COLUMNS('a')}, a.productive from timesheet_activity a ${OWNER_JOIN('a')}
      where a.company_id = $1 and ($2::boolean is null or a.active = $2)`,
    [grant.companyId, q.active ?? null],
    'code, id',
    q,
    MASTER_LIST_CAP,
  );
}
