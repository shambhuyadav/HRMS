// Applications and the hiring tracker (DB062; FR-013, FR-014; F1 candidate stages).
//
// One application per candidate and requisition. Stages move forward one at a time (APPLIED -> SCREENING ->
// INTERVIEW -> OFFER); any open stage can end REJECTED or WITHDRAWN with a note; HIRED is reached only through a
// handover. Each application is decided on its own: rejecting one never touches the candidate's other applications.
// New applications and forward moves need an approved requisition and an active candidate. The tracker shows
// vacancies, candidates, stage, owner, the pending action and ageing (calendar days in the current stage).
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, SqlParams } from '../access/authorize.js';
import { audit, checkVersion, holdsPermission, holdsPermissionSql, type Paging, pageOf, personSql } from './common.js';
import { canAccessCandidate, canAccessRequisition, requisitionScope } from './scope.js';

export type Stage = 'APPLIED' | 'SCREENING' | 'INTERVIEW' | 'OFFER' | 'HIRED' | 'REJECTED' | 'WITHDRAWN';
export const OPEN_STAGES: readonly Stage[] = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'];
const NEXT: Partial<Record<Stage, Stage>> = { APPLIED: 'SCREENING', SCREENING: 'INTERVIEW', INTERVIEW: 'OFFER' };

const MANAGE = { resource: 'application', action: 'manage', fieldGroup: 'operational' } as const;

async function requireOwner(tx: Queryable, companyId: string, userId: string): Promise<void> {
  if (!(await holdsPermission(tx, companyId, userId, MANAGE))) {
    throw new HttpError(422, 'INVALID_OWNER', 'The owner must hold the application management duty in an active assignment of this company', { field: 'ownerUserId' });
  }
}

async function stageEvent(tx: Queryable, grant: AccessGrant, applicationId: string, from: Stage | null, to: Stage, note: string | null): Promise<void> {
  await tx.query(
    `insert into application_stage_event (company_id, application_id, from_stage, to_stage, note, actor_user_id, acting_assignment_id, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $6)`,
    [grant.companyId, applicationId, from, to, note, grant.userId, grant.assignmentId],
  );
}

export async function createApplication(tx: Queryable, grant: AccessGrant, requisitionId: string, input: { candidateId: string; ownerUserId?: string | undefined }) {
  if (!(await canAccessRequisition(tx, grant, requisitionId))) throw notFound();
  if (!(await canAccessCandidate(tx, grant, input.candidateId))) throw notFound();
  const requisition = (await tx.query<{ state: string }>(`select state from requisition where company_id = $1 and id = $2 for share`, [grant.companyId, requisitionId])).rows[0]!;
  if (requisition.state !== 'APPROVED') throw new HttpError(409, 'REQUISITION_NOT_APPROVED', 'Candidates apply only to an approved requisition');
  const candidate = (await tx.query<{ state: string }>(`select state from candidate where company_id = $1 and id = $2 for share`, [grant.companyId, input.candidateId])).rows[0]!;
  if (candidate.state !== 'ACTIVE') throw new HttpError(409, 'CANDIDATE_NOT_ACTIVE', 'Only an active candidate record can apply');
  const owner = input.ownerUserId ?? grant.userId;
  if (owner !== grant.userId) await requireOwner(tx, grant.companyId, owner);
  const created = (
    await tx.query<{ id: string }>(
      `insert into application (company_id, candidate_id, requisition_id, stage, owner_user_id, created_by, updated_by)
       values ($1, $2, $3, 'APPLIED', $4, $5, $5) on conflict (company_id, candidate_id, requisition_id) do nothing returning id`,
      [grant.companyId, input.candidateId, requisitionId, owner, grant.userId],
    )
  ).rows[0];
  if (!created) throw new HttpError(409, 'ALREADY_APPLIED', 'This candidate already has an application for this requisition');
  await stageEvent(tx, grant, created.id, null, 'APPLIED', null);
  await audit(tx, grant, 'application', created.id, 'CREATE', null, { candidateId: input.candidateId, requisitionId, stage: 'APPLIED', ownerUserId: owner });
  return created.id;
}

interface ApplicationRow {
  id: string;
  candidate_id: string;
  requisition_id: string;
  stage: Stage;
  owner_user_id: string;
  version: number;
  requisition_state: string;
  candidate_state: string;
}

/** An application in scope (through its requisition), row-locked; outside scope it reads as missing. */
export async function lockApplication(tx: Queryable, grant: AccessGrant, applicationId: string): Promise<ApplicationRow> {
  const target = (await tx.query<{ requisition_id: string }>(`select requisition_id from application where company_id = $1 and id = $2`, [grant.companyId, applicationId])).rows[0];
  if (!target || !(await canAccessRequisition(tx, grant, target.requisition_id))) throw notFound();
  return (
    await tx.query<ApplicationRow>(
      `select a.id, a.candidate_id, a.requisition_id, a.stage, a.owner_user_id, a.version, r.state as requisition_state, c.state as candidate_state
         from application a join requisition r on r.company_id = a.company_id and r.id = a.requisition_id
         join candidate c on c.company_id = a.company_id and c.id = a.candidate_id
        where a.company_id = $1 and a.id = $2 for update of a`,
      [grant.companyId, applicationId],
    )
  ).rows[0]!;
}

export async function moveStage(tx: Queryable, grant: AccessGrant, applicationId: string, input: { toStage: Stage; note?: string | undefined; expectedVersion: number }) {
  const a = await lockApplication(tx, grant, applicationId);
  checkVersion(a.version, input.expectedVersion);
  if (!OPEN_STAGES.includes(a.stage)) throw new HttpError(409, 'INVALID_STATE', `The application is already ${a.stage}`);
  const note = input.note?.trim() || null;
  if (input.toStage === 'HIRED') throw new HttpError(409, 'HANDOVER_REQUIRED', 'An application becomes HIRED through the handover of its accepted offer');
  if (input.toStage === 'REJECTED' || input.toStage === 'WITHDRAWN') {
    if (!note) throw new HttpError(422, 'NOTE_REQUIRED', 'Record why the application ends', { field: 'note' });
    const live = await tx.query(`select 1 from hiring_offer where company_id = $1 and application_id = $2 and state in ('DRAFT', 'SUBMITTED', 'APPROVED', 'ACCEPTED')`, [
      grant.companyId,
      a.id,
    ]);
    if (live.rowCount) throw new HttpError(409, 'OFFER_OPEN', 'Withdraw the open offer before ending the application');
  } else {
    if (NEXT[a.stage] !== input.toStage) throw new HttpError(409, 'INVALID_TRANSITION', `An application moves from ${a.stage} to ${NEXT[a.stage] ?? 'no further stage'} only`);
    if (a.requisition_state !== 'APPROVED') throw new HttpError(409, 'REQUISITION_NOT_APPROVED', 'The requisition is no longer approved');
    if (a.candidate_state !== 'ACTIVE') throw new HttpError(409, 'CANDIDATE_NOT_ACTIVE', 'The candidate record is not active');
  }
  const version = (
    await tx.query<{ version: number }>(`update application set stage = $3, updated_by = $4 where company_id = $1 and id = $2 returning version`, [grant.companyId, a.id, input.toStage, grant.userId])
  ).rows[0]!.version;
  await stageEvent(tx, grant, a.id, a.stage, input.toStage, note);
  await audit(tx, grant, 'application', a.id, 'STAGE', { stage: a.stage }, { stage: input.toStage }, note);
  return { applicationId: a.id, stage: input.toStage, version };
}

export async function setApplicationOwner(tx: Queryable, grant: AccessGrant, applicationId: string, input: { ownerUserId: string; expectedVersion: number }) {
  const a = await lockApplication(tx, grant, applicationId);
  checkVersion(a.version, input.expectedVersion);
  if (!OPEN_STAGES.includes(a.stage)) throw new HttpError(409, 'INVALID_STATE', `The application is already ${a.stage}`);
  await requireOwner(tx, grant.companyId, input.ownerUserId);
  const version = (
    await tx.query<{ version: number }>(`update application set owner_user_id = $3, updated_by = $4 where company_id = $1 and id = $2 returning version`, [grant.companyId, a.id, input.ownerUserId, grant.userId])
  ).rows[0]!.version;
  await audit(tx, grant, 'application', a.id, 'OWNER', { ownerUserId: a.owner_user_id }, { ownerUserId: input.ownerUserId });
  return { applicationId: a.id, ownerUserId: input.ownerUserId, version };
}

// ---------------------------------------------------------------------------------------------------------
// Reading and the tracker
// ---------------------------------------------------------------------------------------------------------

/** The next thing an open application waits for, from its stage and its latest offer. */
const PENDING_ACTION_SQL = `case
    when a.stage = 'APPLIED' then 'START_SCREENING'
    when a.stage = 'SCREENING' then 'COMPLETE_SCREENING'
    when a.stage = 'INTERVIEW' then 'COMPLETE_INTERVIEW'
    when a.stage = 'OFFER' then case
      when lo.state is null then 'PREPARE_OFFER'
      when lo.state = 'DRAFT' then 'COMPLETE_OFFER'
      when lo.state = 'SUBMITTED' then 'OFFER_APPROVAL'
      when lo.state = 'APPROVED' then 'CANDIDATE_RESPONSE'
      when lo.state = 'ACCEPTED' then 'HANDOVER'
      -- the latest offer was declined, rejected or withdrawn: prepare a new offer or end the application
      else 'DECIDE_APPLICATION' end
    else null end`;

const OWNER_JSON = `json_build_object('userId', a.owner_user_id, 'employeeCode', oe.employee_code, 'displayName', oe.display_name)`;

const APPLICATION_SELECT = `select a.id, a.stage, a.stage_entered_at as "stageEnteredAt",
       (hrms_business_date(a.company_id, now()) - hrms_business_date(a.company_id, a.stage_entered_at)) as "ageingDays",
       ${PENDING_ACTION_SQL} as "pendingAction", ${OWNER_JSON} as owner,
       json_build_object('id', c.id, 'candidateCode', c.candidate_code, 'fullName', c.full_name, 'state', c.state) as candidate,
       json_build_object('id', r.id, 'code', r.code, 'title', r.title, 'state', r.state) as requisition,
       case when lo.id is null then null else json_build_object('id', lo.id, 'state', lo.state) end as "latestOffer",
       a.created_at as "createdAt", a.version
  from application a
  join requisition r on r.company_id = a.company_id and r.id = a.requisition_id
  join candidate c on c.company_id = a.company_id and c.id = a.candidate_id
  left join lateral (select o.id, o.state from hiring_offer o where o.company_id = a.company_id and o.application_id = a.id order by o.created_at desc limit 1) lo on true
  left join user_employee_link ol on ol.company_id = a.company_id and ol.user_id = a.owner_user_id
       and ol.effective_from <= hrms_business_date(a.company_id, now()) and (ol.effective_to is null or ol.effective_to > hrms_business_date(a.company_id, now()))
  left join employee oe on oe.company_id = ol.company_id and oe.id = ol.employee_id`;

export interface ApplicationQuery extends Paging {
  requisitionId?: string | undefined;
  candidateId?: string | undefined;
  stage?: string | undefined;
  /** Only OPEN_STAGES: the Recruiter dashboard's "Applications in the pipeline". */
  open?: boolean | undefined;
  ownerUserId?: string | undefined;
}

/** Without page or pageSize the application list answers its first 1,000 rows, as before paging; `total` counts all. */
export const APPLICATION_LIST_CAP = 1000;

export async function listApplications(db: Queryable, grant: AccessGrant, q: ApplicationQuery) {
  const p = new SqlParams();
  const where = [requisitionScope(grant, 'r', p)];
  if (q.requisitionId) where.push(`a.requisition_id = ${p.add(q.requisitionId)}::uuid`);
  if (q.candidateId) where.push(`a.candidate_id = ${p.add(q.candidateId)}::uuid`);
  if (q.stage) where.push(`a.stage = ${p.add(q.stage)}`);
  if (q.open) where.push(`a.stage = any(${p.add(OPEN_STAGES)}::text[])`);
  if (q.ownerUserId) where.push(`a.owner_user_id = ${p.add(q.ownerUserId)}::uuid`);
  return pageOf(db, `${APPLICATION_SELECT} where ${where.join(' and ')}`, p.values, `"stageEnteredAt", id`, q, APPLICATION_LIST_CAP);
}

/**
 * Users who may own an application: active users holding the application management duty in an active assignment of
 * this company, exactly as an owner is checked (setApplicationOwner, createApplication), with their operational
 * identity (employee code and name, DF02). Searchable by code or name.
 */
export async function listApplicationOwners(db: Queryable, grant: AccessGrant, q: { search?: string | undefined; page: number; pageSize: number }) {
  const p = new SqlParams([grant.companyId, grant.businessDate]);
  const where = [`ou.active`, holdsPermissionSql('$1::uuid', 'ou.id', `'application'`, `'manage'`, `'operational'`)];
  if (q.search?.trim()) {
    const pattern = p.add(`%${q.search.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    where.push(`(oe.employee_code ilike ${pattern} or oe.display_name ilike ${pattern})`);
  }
  const sql = `select ou.id as "userId", oe.employee_code as "employeeCode", oe.display_name as "displayName"
     from user_account ou
     left join user_employee_link ol on ol.company_id = $1::uuid and ol.user_id = ou.id
          and ol.effective_from <= $2::date and (ol.effective_to is null or ol.effective_to > $2::date)
     left join employee oe on oe.company_id = ol.company_id and oe.id = ol.employee_id
    where ${where.join(' and ')}`;
  return pageOf(db, sql, p.values, `"displayName" nulls last, "employeeCode" nulls last, "userId"`, { page: q.page, pageSize: q.pageSize }, q.pageSize);
}

export async function getApplication(db: Queryable, grant: AccessGrant, applicationId: string) {
  const p = new SqlParams([applicationId]);
  const row = (await db.query(`${APPLICATION_SELECT} where a.id = $1 and ${requisitionScope(grant, 'r', p)}`, p.values)).rows[0];
  if (!row) return null;
  const history = (
    await db.query(
      `select ev.from_stage as "fromStage", ev.to_stage as "toStage", ev.note, ev.actor_user_id as "actorUserId",
              ${personSql('ev.company_id', 'ev.actor_user_id', 'ev.occurred_at')} as "actorPerson", ev.occurred_at as "occurredAt"
         from application_stage_event ev where ev.company_id = $1 and ev.application_id = $2 order by ev.occurred_at, ev.id`,
      [grant.companyId, applicationId],
    )
  ).rows;
  const offers = (
    await db.query(
      `select id, state, to_char(proposed_joining_date, 'YYYY-MM-DD') as "proposedJoiningDate", current_revision as "currentRevision", created_at as "createdAt"
         from hiring_offer where company_id = $1 and application_id = $2 order by created_at`,
      [grant.companyId, applicationId],
    )
  ).rows;
  return { ...row, history, offers };
}

/** Without page or pageSize the tracker answers its first 500 vacancies, as before paging. */
export const TRACKER_VACANCY_CAP = 500;
/** Open applications answered for the vacancies shown (a technical bound; `applicationsTotal` counts them all). */
export const TRACKER_APPLICATION_CAP = 2000;

/**
 * FR-014 tracker: per requisition its vacancies, accepted (filled) and open places and the candidates by stage; per
 * open application of those requisitions its stage, owner, pending action and ageing. Same scope as the requisition
 * and application lists. page/pageSize page the vacancies (the applications follow the vacancies shown);
 * `vacanciesTotal` and `applicationsTotal` count every matching row.
 */
export async function tracker(
  db: Queryable,
  grant: AccessGrant,
  q: { requisitionId?: string | undefined; ownerUserId?: string | undefined; includeClosed?: boolean | undefined } & Paging,
) {
  const p = new SqlParams();
  const where = [requisitionScope(grant, 'r', p)];
  if (q.requisitionId) where.push(`r.id = ${p.add(q.requisitionId)}::uuid`);
  where.push(q.includeClosed ? `r.state in ('APPROVED', 'CLOSED')` : `r.state = 'APPROVED'`);
  const vacancyPage = await pageOf(
    db,
    `select r.id, r.code, r.title, r.state, r.vacancies, to_char(r.target_date, 'YYYY-MM-DD') as "targetDate",
            (select count(*)::int from hiring_offer o where o.company_id = r.company_id and o.requisition_id = r.id and o.state = 'ACCEPTED') as filled,
            greatest(r.vacancies - (select count(*)::int from hiring_offer o where o.company_id = r.company_id and o.requisition_id = r.id and o.state = 'ACCEPTED'), 0) as "openPlaces",
            (select coalesce(json_object_agg(s.stage, s.n), '{}'::json) from (select a.stage, count(*)::int as n from application a
                where a.company_id = r.company_id and a.requisition_id = r.id group by a.stage) s) as "byStage"
       from requisition r where ${where.join(' and ')}`,
    p.values,
    `"targetDate", code, id`,
    q,
    TRACKER_VACANCY_CAP,
  );
  const { items: vacancies, total: vacanciesTotal, ...paging } = vacancyPage;
  if (vacancies.length === 0) return { vacancies: [], applications: [], vacanciesTotal, applicationsTotal: 0, ...paging };
  const ap = new SqlParams();
  const aWhere = [requisitionScope(grant, 'r', ap), `a.requisition_id = any(${ap.add(vacancies.map((v) => v.id))}::uuid[])`, `a.stage = any(${ap.add(OPEN_STAGES)}::text[])`];
  if (q.ownerUserId) aWhere.push(`a.owner_user_id = ${ap.add(q.ownerUserId)}::uuid`);
  const applications = await pageOf(db, `${APPLICATION_SELECT} where ${aWhere.join(' and ')}`, ap.values, `"ageingDays" desc, id`, {}, TRACKER_APPLICATION_CAP);
  return { vacancies, applications: applications.items, vacanciesTotal, applicationsTotal: applications.total, ...paging };
}
