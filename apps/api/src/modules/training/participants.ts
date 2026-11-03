// Training participation (FR-050; F1 "Training"; DB073; H3 TN17; DF02; DF08; C4).
// A coordinator or HR Administrator nominates employees in their row scope, confirms nominations (capacity is enforced
// here, under the plan's row lock, F1), records attendance (ATTENDED or NO_SHOW, from the start date), completion (from
// the end date) and cancellation with a reason. Where a plan allows it, an employee nominates themselves and may
// withdraw that nomination until it is confirmed; the employee never records attendance or completion (TN17 "no
// falsified completion"), and nobody records their own participation in a coordinator context. One participation per
// employee and plan: a cancelled participation is nominated again on the same row, and every change is kept in the
// participation's history. The reasons recorded on a participation are the confidential `reason` group: views show them
// only to an eligible assignment holding the approved grant (DF02 private reasons; I-16 reviewer notes), otherwise
// whether a reason was recorded.
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, canAccessEmployee, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import {
  assertNotSelf,
  blankToNull,
  isActiveEmployee,
  isCompanyWide,
  lockPlan,
  ownEmployee,
  type ParticipantAction,
  type ParticipationState,
  recordChange,
  seatsTaken,
  viewSql,
  withReasons,
} from './common.js';
import { FEEDBACK_PENDING, ownTrainingDue, participationsInScope } from './metrics.js';

export type TransitionAction = 'CONFIRM' | 'MARK_ATTENDED' | 'MARK_NO_SHOW' | 'COMPLETE' | 'CANCEL';

interface Rule {
  to: ParticipationState;
  from: readonly ParticipationState[];
  /** Corrections of a recorded attendance, which need a reason. */
  correctionFrom?: readonly ParticipationState[];
}

const RULES: Record<TransitionAction, Rule> = {
  CONFIRM: { to: 'CONFIRMED', from: ['NOMINATED'] },
  MARK_ATTENDED: { to: 'ATTENDED', from: ['CONFIRMED'], correctionFrom: ['NO_SHOW'] },
  MARK_NO_SHOW: { to: 'NO_SHOW', from: ['CONFIRMED'], correctionFrom: ['ATTENDED'] },
  COMPLETE: { to: 'COMPLETED', from: ['ATTENDED'] },
  CANCEL: { to: 'CANCELLED', from: ['NOMINATED', 'CONFIRMED'] },
};

/** RESPONDED / MISSING for a completed participation (FR-050: missing responses shown distinctly), else NOT_APPLICABLE. */
export const FEEDBACK_STATUS = `case when t.participation_state <> 'COMPLETED' then 'NOT_APPLICABLE'
       when exists (select 1 from training_feedback f where f.company_id = t.company_id and f.participant_id = t.id) then 'RESPONDED'
       else 'MISSING' end`;

/** The cancellation reason column (alias t), present only for a caller holding the confidential `reason` group. */
const cancellationReason = (grant: AccessGrant) => (withReasons(grant) ? `t.cancellation_reason as "cancellationReason", ` : '');

/** Participation columns (alias t; employee alias e): operational values, plus the reason with its group. */
const participantColumns = (grant: AccessGrant) => `t.id, t.plan_id as "planId", t.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",
       t.participation_state as state, t.self_nominated as "selfNominated", t.nominated_at as "nominatedAt", t.confirmed_at as "confirmedAt",
       t.attendance_at as "attendanceRecordedAt", t.completed_at as "completedAt", t.cancelled_at as "cancelledAt",
       ${cancellationReason(grant)}${FEEDBACK_STATUS} as "feedbackStatus", t.version`;

async function participantsByIds(db: Queryable, grant: AccessGrant, ids: string[]) {
  return (
    await db.query(
      `select ${participantColumns(grant)} from training_participant t join employee e on e.company_id = t.company_id and e.id = t.employee_id
        where t.company_id = $1 and t.id = any($2::uuid[]) order by e.employee_code, t.id`,
      [grant.companyId, ids],
    )
  ).rows as Record<string, unknown>[];
}

interface LockedParticipant {
  id: string;
  employee_id: string;
  participation_state: ParticipationState;
  self_nominated: boolean;
}

/** Nominated again on the participation's own row (one participation per employee and plan). */
async function renominate(tx: Queryable, grant: AccessGrant, participantId: string, self: boolean): Promise<void> {
  await tx.query(
    `update training_participant
        set participation_state = 'NOMINATED', self_nominated = $3, nominated_at = now(), nominated_by = $4,
            confirmed_at = null, confirmed_by = null, attendance_at = null, attendance_by = null, completed_at = null, completed_by = null,
            cancelled_at = null, cancelled_by = null, cancellation_reason = null, updated_by = $4
      where company_id = $1 and id = $2`,
    [grant.companyId, participantId, self, grant.userId],
  );
}

async function insertNomination(tx: Queryable, grant: AccessGrant, planId: string, employeeId: string, self: boolean): Promise<string> {
  return (
    await tx.query<{ id: string }>(
      `insert into training_participant (company_id, plan_id, employee_id, participation_state, self_nominated, nominated_by, created_by, updated_by)
       values ($1, $2, $3, 'NOMINATED', $4, $5, $5, $5) returning id`,
      [grant.companyId, planId, employeeId, self, grant.userId],
    )
  ).rows[0]!.id;
}

/**
 * Nominates employees (all or none). Each must be in the caller's row scope (otherwise not found), active, not the
 * caller, and without a live participation in the plan (FR-050: never duplicated); a cancelled participation is
 * nominated again. Concurrent nominations of one employee serialise on the plan and its unique key.
 */
export async function nominate(tx: Queryable, grant: AccessGrant, planId: string, employeeIds: string[]) {
  const plan = await lockPlan(tx, grant.companyId, planId);
  if (plan.state === 'CANCELLED') throw new HttpError(409, 'PLAN_CANCELLED', 'A cancelled plan takes no nominations');
  for (const employeeId of employeeIds) if (!(await canAccessEmployee(tx, grant, employeeId))) throw notFound();
  for (const employeeId of employeeIds) await assertNotSelf(tx, grant, employeeId);
  for (const employeeId of employeeIds) {
    if (!(await isActiveEmployee(tx, grant.companyId, employeeId))) throw new HttpError(422, 'EMPLOYEE_NOT_ACTIVE', 'Only active employees are nominated', { employeeId });
  }
  const existing = (
    await tx.query<LockedParticipant>(
      `select id, employee_id, participation_state, self_nominated from training_participant
        where company_id = $1 and plan_id = $2 and employee_id = any($3::uuid[]) order by id for update`,
      [grant.companyId, planId, employeeIds],
    )
  ).rows;
  const live = existing.find((t) => t.participation_state !== 'CANCELLED');
  if (live) {
    throw new HttpError(409, 'PARTICIPANT_EXISTS', 'The employee already takes part in this training session', {
      employeeId: live.employee_id,
      participantId: live.id,
      state: live.participation_state,
    });
  }
  const ids: string[] = [];
  for (const employeeId of employeeIds) {
    const cancelled = existing.find((t) => t.employee_id === employeeId);
    let id: string;
    if (cancelled) {
      await renominate(tx, grant, cancelled.id, false);
      id = cancelled.id;
    } else {
      id = await insertNomination(tx, grant, planId, employeeId, false);
    }
    await recordChange(tx, grant, { participantId: id, planId, employeeId, action: 'NOMINATE', from: cancelled ? 'CANCELLED' : null, to: 'NOMINATED', reason: null });
    ids.push(id);
  }
  return { items: await participantsByIds(tx, grant, ids), nominated: ids.length };
}

export interface TransitionInput {
  action: TransitionAction;
  participantIds: string[];
  reason?: string | null | undefined;
}

/**
 * Applies one action to participations of a plan (all or none), under the plan's row lock. A participation already in
 * the target state is a replay (no second effect). Confirmation checks capacity against every seat taken (F1) and
 * needs active employees; attendance needs the session to have started and completion to have reached its end date;
 * cancellation and corrections of recorded attendance need a reason.
 */
export async function applyTransition(tx: Queryable, grant: AccessGrant, planId: string, input: TransitionInput) {
  const plan = await lockPlan(tx, grant.companyId, planId);
  const rows = (
    await tx.query<LockedParticipant>(
      `select id, employee_id, participation_state, self_nominated from training_participant
        where company_id = $1 and plan_id = $2 and id = any($3::uuid[]) order by id for update`,
      [grant.companyId, planId, input.participantIds],
    )
  ).rows;
  if (rows.length !== new Set(input.participantIds).size) throw notFound();
  for (const t of rows) if (!(await canAccessEmployee(tx, grant, t.employee_id))) throw notFound();
  if (plan.state === 'CANCELLED') throw new HttpError(409, 'PLAN_CANCELLED', 'The participations of a cancelled plan are final');
  for (const t of rows) await assertNotSelf(tx, grant, t.employee_id);

  const rule = RULES[input.action];
  const reason = blankToNull(input.reason);
  const changing: LockedParticipant[] = [];
  let replayed = 0;
  for (const t of rows) {
    if (t.participation_state === rule.to) {
      replayed++;
    } else if (rule.from.includes(t.participation_state)) {
      changing.push(t);
    } else if (rule.correctionFrom?.includes(t.participation_state)) {
      if (!reason) throw new HttpError(422, 'REASON_REQUIRED', 'Correcting recorded attendance needs a reason', { participantId: t.id });
      changing.push(t);
    } else {
      throw new HttpError(409, 'INVALID_TRANSITION', `A ${t.participation_state} participation cannot take the action ${input.action}`, {
        participantId: t.id,
        state: t.participation_state,
      });
    }
  }
  if (changing.length > 0) {
    if (input.action === 'CANCEL' && !reason) throw new HttpError(422, 'REASON_REQUIRED', 'Record why the participation is cancelled', { field: 'reason' });
    if ((input.action === 'MARK_ATTENDED' || input.action === 'MARK_NO_SHOW') && grant.businessDate < plan.start_date) {
      throw new HttpError(409, 'SESSION_NOT_STARTED', `Attendance is recorded from the start date ${plan.start_date}`);
    }
    if (input.action === 'COMPLETE' && grant.businessDate < plan.end_date) {
      throw new HttpError(409, 'SESSION_NOT_ENDED', `Completion is recorded from the end date ${plan.end_date}`);
    }
    if (input.action === 'CONFIRM') {
      for (const t of changing) {
        if (!(await isActiveEmployee(tx, grant.companyId, t.employee_id))) {
          throw new HttpError(422, 'EMPLOYEE_NOT_ACTIVE', 'Only active employees are confirmed', { employeeId: t.employee_id });
        }
      }
      // F1: capacity is enforced at confirmation, against every seat taken (the plan row lock serialises this check).
      const seats = await seatsTaken(tx, grant.companyId, planId);
      if (seats + changing.length > plan.capacity) {
        throw new HttpError(409, 'PLAN_FULL', 'The confirmations would exceed the plan capacity', { capacity: plan.capacity, seatsTaken: seats, requested: changing.length });
      }
    }
  }
  const set: Record<TransitionAction, string> = {
    CONFIRM: `participation_state = 'CONFIRMED', confirmed_at = now(), confirmed_by = $3`,
    MARK_ATTENDED: `participation_state = 'ATTENDED', attendance_at = now(), attendance_by = $3`,
    MARK_NO_SHOW: `participation_state = 'NO_SHOW', attendance_at = now(), attendance_by = $3`,
    COMPLETE: `participation_state = 'COMPLETED', completed_at = now(), completed_by = $3`,
    CANCEL: `participation_state = 'CANCELLED', cancelled_at = now(), cancelled_by = $3, cancellation_reason = $4`,
  };
  for (const t of changing) {
    await tx.query(`update training_participant set ${set[input.action]}, updated_by = $3 where company_id = $1 and id = $2`, [
      grant.companyId,
      t.id,
      grant.userId,
      ...(input.action === 'CANCEL' ? [reason] : []),
    ]);
    await recordChange(tx, grant, {
      participantId: t.id,
      planId,
      employeeId: t.employee_id,
      action: input.action as ParticipantAction,
      from: t.participation_state,
      to: rule.to,
      reason,
    });
  }
  return { action: input.action, items: await participantsByIds(tx, grant, rows.map((t) => t.id)), changed: changing.length, replayed };
}

export interface ParticipantListQuery {
  state?: ParticipationState | undefined;
  page: number;
  pageSize: number;
}

/** A plan's participations within the caller's row scope (a filtered assignment sees its own population only). */
export async function listPlanParticipants(db: Queryable, grant: AccessGrant, planId: string, q: ParticipantListQuery) {
  const exists = await db.query(`select 1 from training_plan where company_id = $1 and id = $2`, [grant.companyId, planId]);
  if (!exists.rowCount) throw notFound();
  const params = new SqlParams([grant.companyId, planId]);
  const where = [`t.company_id = $1`, `t.plan_id = $2`, employeeScopePredicate(grant, { company: 't.company_id', employee: 't.employee_id' }, params)];
  if (q.state) where.push(`t.participation_state = ${params.add(q.state)}`);
  const filter = where.join(' and ');
  const total = Number((await db.query<{ n: string }>(`select count(*) as n from training_participant t where ${filter}`, params.values)).rows[0]?.n ?? 0);
  const limit = params.add(q.pageSize);
  const offset = params.add((q.page - 1) * q.pageSize);
  const rows = await db.query(
    `select ${participantColumns(grant)} from training_participant t join employee e on e.company_id = t.company_id and e.id = t.employee_id
      where ${filter} order by e.employee_code, t.id limit ${limit} offset ${offset}`,
    params.values,
  );
  return { items: rows.rows, total, page: q.page, pageSize: q.pageSize, scope: { kind: grant.scopeKind, companyWide: isCompanyWide(grant) } };
}

/** Plan summary columns (alias p, mode m, owner o) for the employee-facing views: no cost, no seat counts. */
const planSummary = (day: string) => `json_build_object('id', p.id, 'code', p.code, 'title', p.title, 'startDate', to_char(p.start_date, 'YYYY-MM-DD'),
       'endDate', to_char(p.end_date, 'YYYY-MM-DD'), 'view', ${viewSql('p', day)}, 'mode', json_build_object('code', m.code, 'label', m.label),
       'venue', p.venue, 'trainer', p.trainer, 'ownerName', o.display_name)`;

const PLAN_JOINS = `join training_plan p on p.company_id = t.company_id and p.id = t.plan_id
  join reference_value m on m.company_id = p.company_id and m.id = p.mode_id
  join employee o on o.company_id = p.company_id and o.id = p.owner_employee_id`;

/**
 * One participation with its plan and history; out of the caller's row scope it reads as missing. Each history entry
 * says whether a reason was recorded; the reason itself needs the confidential `reason` group.
 */
export async function participantDetail(db: Queryable, grant: AccessGrant, participantId: string) {
  const row = (
    await db.query<Record<string, unknown> & { employeeId: string }>(
      `select ${participantColumns(grant)}, ${planSummary('$3')} as plan
         from training_participant t join employee e on e.company_id = t.company_id and e.id = t.employee_id ${PLAN_JOINS}
        where t.company_id = $1 and t.id = $2`,
      [grant.companyId, participantId, grant.businessDate],
    )
  ).rows[0];
  if (!row || !(await canAccessEmployee(db, grant, row.employeeId))) throw notFound();
  const history = await db.query(
    `select ev.action, ev.from_state as "fromState", ev.to_state as "toState", ${withReasons(grant) ? 'ev.reason, ' : ''}(ev.reason is not null) as "reasonRecorded",
            ev.occurred_at as "occurredAt",
            (select ae.display_name from user_employee_link l join employee ae on ae.company_id = l.company_id and ae.id = l.employee_id
              where l.company_id = ev.company_id and l.user_id = ev.actor_user_id order by l.effective_from desc limit 1) as "actorName"
       from training_participant_event ev
      where ev.company_id = $1 and ev.participant_id = $2
      order by ev.occurred_at, ev.id`,
    [grant.companyId, participantId],
  );
  return { ...row, history: history.rows };
}

/**
 * An employee's participations with their plans (newest first), within the caller's row scope: the Employee OWN
 * context sees its own record (H3 TN17), a manager the direct team (DF16), a coordinator or HR their scope. The route
 * checks the scope first.
 */
export async function listEmployeeParticipations(db: Queryable, grant: AccessGrant, employeeId: string, due = false) {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  const rows = await db.query(
    `select t.id, t.participation_state as state, t.self_nominated as "selfNominated", t.nominated_at as "nominatedAt", t.confirmed_at as "confirmedAt",
            t.attendance_at as "attendanceRecordedAt", t.completed_at as "completedAt", t.cancelled_at as "cancelledAt",
            ${cancellationReason(grant)}${FEEDBACK_STATUS} as "feedbackStatus", ${planSummary('$3')} as plan
       from training_participant t ${PLAN_JOINS}
      where t.company_id = $1 and t.employee_id = $2 ${due ? `and ${ownTrainingDue('$3')}` : ''}
      order by p.start_date desc, p.code
      limit 500`,
    [grant.companyId, employeeId, grant.businessDate],
  );
  return { items: rows.rows, businessDate: grant.businessDate };
}

/** Participations across plans within the caller's row scope, for the coordinator's counts (training/metrics.ts uses the same conditions). */
export async function listParticipationsInScope(db: Queryable, grant: AccessGrant, q: { state?: ParticipationState | undefined; feedbackPending?: boolean | undefined; page: number; pageSize: number }) {
  const params = new SqlParams();
  const where = [participationsInScope(grant, params)];
  if (q.state) where.push(`t.participation_state = ${params.add(q.state)}`);
  if (q.feedbackPending) where.push(FEEDBACK_PENDING);
  const filter = where.join(' and ');
  const from = `from training_participant t join training_plan p on p.company_id = t.company_id and p.id = t.plan_id join employee e on e.company_id = t.company_id and e.id = t.employee_id`;
  const total = Number((await db.query<{ n: string }>(`select count(*) as n ${from} where ${filter}`, params.values)).rows[0]?.n ?? 0);
  const limit = params.add(q.pageSize);
  const offset = params.add((q.page - 1) * q.pageSize);
  const rows = await db.query(
    `select p.code as "planCode", p.title as "planTitle", ${participantColumns(grant)} ${from} where ${filter} order by p.start_date desc, p.code, e.employee_code, t.id limit ${limit} offset ${offset}`,
    params.values,
  );
  return { items: rows.rows, total, page: q.page, pageSize: q.pageSize };
}

/** H3 TN17 enrolment: the plans open for self-nomination that have not ended, with the caller's own participation. */
export async function listOpenPlans(db: Queryable, grant: AccessGrant) {
  const employeeId = ownEmployee(grant);
  const rows = await db.query(
    `select p.id, p.code, p.title, to_char(p.start_date, 'YYYY-MM-DD') as "startDate", to_char(p.end_date, 'YYYY-MM-DD') as "endDate",
            ${viewSql('p', '$2')} as view, json_build_object('code', m.code, 'label', m.label) as mode, p.venue, p.trainer, o.display_name as "ownerName",
            (select json_build_object('participantId', t.id, 'state', t.participation_state, 'selfNominated', t.self_nominated)
               from training_participant t where t.company_id = p.company_id and t.plan_id = p.id and t.employee_id = $3) as "myParticipation"
       from training_plan p
       join reference_value m on m.company_id = p.company_id and m.id = p.mode_id
       join employee o on o.company_id = p.company_id and o.id = p.owner_employee_id
      where p.company_id = $1 and p.state = 'ACTIVE' and p.self_nomination and p.end_date >= $2::date
      order by p.start_date, p.code
      limit 200`,
    [grant.companyId, grant.businessDate, employeeId],
  );
  return { items: rows.rows, businessDate: grant.businessDate };
}

/**
 * H3 TN17 own enrolment: the employee nominates themselves for a plan that allows it and has not ended. A plan that is
 * not open for self-nomination reads as missing; the coordinator still confirms the nomination.
 */
export async function selfNominate(tx: Queryable, grant: AccessGrant, planId: string) {
  const employeeId = ownEmployee(grant);
  const plan = await lockPlan(tx, grant.companyId, planId);
  if (plan.state !== 'ACTIVE' || !plan.self_nomination) throw notFound();
  if (grant.businessDate > plan.end_date) throw new HttpError(409, 'PLAN_ENDED', 'The training session has ended');
  if (!(await isActiveEmployee(tx, grant.companyId, employeeId))) throw new HttpError(422, 'EMPLOYEE_NOT_ACTIVE', 'Only active employees are nominated');
  const existing = (
    await tx.query<LockedParticipant & { cancelled_by: string | null }>(
      `select id, employee_id, participation_state, self_nominated, cancelled_by from training_participant
        where company_id = $1 and plan_id = $2 and employee_id = $3 for update`,
      [grant.companyId, planId, employeeId],
    )
  ).rows[0];
  if (existing && existing.participation_state !== 'CANCELLED') {
    throw new HttpError(409, 'PARTICIPANT_EXISTS', 'You already take part in this training session', { participantId: existing.id, state: existing.participation_state });
  }
  // Only the employee's own withdrawal is undone by enrolling again; a coordinator's cancellation stands.
  if (existing && existing.cancelled_by !== grant.userId) {
    throw new HttpError(409, 'CANCELLED_BY_COORDINATOR', 'Your participation was cancelled by the training coordinator; ask them to nominate you again', {
      participantId: existing.id,
    });
  }
  let id: string;
  if (existing) {
    await renominate(tx, grant, existing.id, true);
    id = existing.id;
  } else {
    id = await insertNomination(tx, grant, planId, employeeId, true);
  }
  await recordChange(tx, grant, { participantId: id, planId, employeeId, action: 'SELF_NOMINATE', from: existing ? 'CANCELLED' : null, to: 'NOMINATED', reason: null });
  return (await participantsByIds(tx, grant, [id]))[0]!;
}

/**
 * The employee withdraws their own self-nomination before it is confirmed (DF03: withdraw only before the decision).
 * A coordinator's nomination or a confirmed place is cancelled by the coordinator. A repeated withdrawal is a replay.
 */
export async function withdrawNomination(tx: Queryable, grant: AccessGrant, participantId: string, input: { reason: string }) {
  const employeeId = ownEmployee(grant);
  const own = (
    await tx.query<{ plan_id: string }>(`select plan_id from training_participant where company_id = $1 and id = $2 and employee_id = $3`, [grant.companyId, participantId, employeeId])
  ).rows[0];
  if (!own) throw notFound();
  await lockPlan(tx, grant.companyId, own.plan_id);
  const t = (
    await tx.query<LockedParticipant>(`select id, employee_id, participation_state, self_nominated from training_participant where company_id = $1 and id = $2 for update`, [
      grant.companyId,
      participantId,
    ])
  ).rows[0]!;
  if (t.participation_state === 'CANCELLED') return { ...(await participantsByIds(tx, grant, [t.id]))[0]!, replayed: true };
  if (t.participation_state !== 'NOMINATED') {
    throw new HttpError(409, 'NOT_WITHDRAWABLE', 'Only a nomination waiting for confirmation can be withdrawn; ask the training coordinator');
  }
  if (!t.self_nominated) throw new HttpError(409, 'NOT_SELF_NOMINATED', 'You were nominated by the training coordinator; ask them to cancel it');
  const reason = input.reason.trim();
  if (reason === '') throw new HttpError(422, 'REASON_REQUIRED', 'Record why you withdraw', { field: 'reason' });
  await tx.query(
    `update training_participant set participation_state = 'CANCELLED', cancelled_at = now(), cancelled_by = $3, cancellation_reason = $4, updated_by = $3
      where company_id = $1 and id = $2`,
    [grant.companyId, t.id, grant.userId, reason],
  );
  await recordChange(tx, grant, { participantId: t.id, planId: own.plan_id, employeeId, action: 'WITHDRAW', from: 'NOMINATED', to: 'CANCELLED', reason });
  return { ...(await participantsByIds(tx, grant, [t.id]))[0]!, replayed: false };
}
