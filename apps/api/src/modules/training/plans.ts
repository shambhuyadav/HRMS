// Training plans (FR-049; F1 "Training"; BR-015; DB072; DF02; DF04; DF08; DF09 exports).
// An authorised coordinator or HR Administrator, in an unrestricted company-scope assignment, maintains a plan: a
// permanent code, title, dates (end not before start), controlled mode, venue, trainer, capacity, optional cost, owner,
// whether employees may nominate themselves, and its feedback questions. The FUTURE / CURRENT / PAST view is derived from
// the company-local date (F1); cancelling records actor and reason and overrides the date view. Nothing is deleted.
import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, SqlParams } from '../access/authorize.js';
import { contextCsvLines, fileContext } from '../report/context.js';
import {
  assertCompanyWide,
  audit,
  blankToNull,
  isActiveEmployee,
  likePattern,
  lockPlan,
  MODE_LIST,
  OUTCOME_STATES,
  type PlanView,
  QUESTION_LIST,
  ROW_LIMIT,
  recordChange,
  referenceId,
  requireDate,
  seatsTaken,
  viewSql,
} from './common.js';

const CODE = /^[A-Z0-9][A-Z0-9._/-]{0,39}$/;
/** A non-negative amount with at most two decimals, as text (never a JavaScript float). */
const AMOUNT = /^\d{1,15}(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_QUESTIONS = 20;

export interface CostInput {
  amount: string;
  currency: string;
}

export interface PlanInput {
  code: string;
  title: string;
  startDate: string;
  endDate: string;
  modeCode: string;
  venue?: string | null | undefined;
  trainer?: string | null | undefined;
  capacity: number;
  cost?: CostInput | null | undefined;
  ownerEmployeeId: string;
  selfNomination?: boolean | undefined;
  feedbackQuestionCodes?: string[] | undefined;
}

export interface PlanUpdate {
  expectedVersion: number;
  title?: string | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  modeCode?: string | undefined;
  venue?: string | null | undefined;
  trainer?: string | null | undefined;
  capacity?: number | undefined;
  cost?: CostInput | null | undefined;
  ownerEmployeeId?: string | undefined;
  selfNomination?: boolean | undefined;
  feedbackQuestionCodes?: string[] | undefined;
}

export interface PlanListQuery {
  view?: PlanView | undefined;
  search?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  page: number;
  pageSize: number;
}

const withCost = (grant: AccessGrant) => grant.allowedFieldGroups.includes('cost');

/** Plan columns (operational, plus the cost group when the caller holds it). `day` is the business-date parameter. */
const planColumns = (day: string, cost: boolean) => `p.id, p.code, p.title, to_char(p.start_date, 'YYYY-MM-DD') as "startDate",
       to_char(p.end_date, 'YYYY-MM-DD') as "endDate", ${viewSql('p', day)} as view, p.state,
       json_build_object('code', m.code, 'label', m.label) as mode, p.venue, p.trainer, p.capacity,
       s.seats as "seatsTaken", p.capacity - s.seats as "seatsAvailable", s.pending as "nominationsPending",
       json_build_object('employeeId', o.id, 'employeeCode', o.employee_code, 'name', o.display_name) as owner,
       p.self_nomination as "selfNomination",
       case when p.state = 'CANCELLED' then json_build_object(
         'cancelledAt', p.cancelled_at, 'cancelledBy', p.cancelled_by, 'reason', p.cancellation_reason,
         'cancelledByName', (select ce.display_name from user_employee_link l join employee ce on ce.company_id = l.company_id and ce.id = l.employee_id
                              where l.company_id = p.company_id and l.user_id = p.cancelled_by order by l.effective_from desc limit 1)) end as cancellation,
       ${cost ? `case when p.cost_amount is null then null else json_build_object('amount', (p.cost_amount::numeric(19, 2))::text, 'currency', p.cost_currency) end as cost,` : ''}
       p.created_at as "createdAt", p.updated_at as "updatedAt", p.version`;

const PLAN_FROM = `from training_plan p
  join reference_value m on m.company_id = p.company_id and m.id = p.mode_id
  join employee o on o.company_id = p.company_id and o.id = p.owner_employee_id
  cross join lateral (select (count(*) filter (where t.participation_state in ('CONFIRMED', 'ATTENDED', 'COMPLETED', 'NO_SHOW')))::int as seats,
                             (count(*) filter (where t.participation_state = 'NOMINATED'))::int as pending
                        from training_participant t where t.company_id = p.company_id and t.plan_id = p.id) s`;

/** One plan with its feedback questions, or undefined. */
export async function planDetail(db: Queryable, grant: AccessGrant, id: string): Promise<Record<string, unknown> | undefined> {
  const params = new SqlParams([grant.companyId, id]);
  const day = params.add(grant.businessDate);
  return (
    await db.query(
      `select ${planColumns(day, withCost(grant))},
              coalesce((select json_agg(json_build_object('code', q.code, 'label', q.label, 'position', pq.position) order by pq.position)
                          from training_plan_question pq join reference_value q on q.company_id = pq.company_id and q.id = pq.question_id
                         where pq.company_id = p.company_id and pq.plan_id = p.id and pq.active), '[]'::json) as "feedbackQuestions",
              exists (select 1 from training_feedback f where f.company_id = p.company_id and f.plan_id = p.id) as "feedbackRecorded"
         ${PLAN_FROM}
        where p.company_id = $1 and p.id = $2`,
      params.values,
    )
  ).rows[0];
}

export async function getPlan(db: Queryable, grant: AccessGrant, id: string) {
  const plan = await planDetail(db, grant, id);
  if (!plan) throw notFound();
  return plan;
}

function requireText(value: string, field: string, code: string, message: string): string {
  const v = value.trim();
  if (v === '') throw new HttpError(422, code, message, { field });
  return v;
}

function parseCost(cost: CostInput | null | undefined): { amount: string; currency: string } | null {
  if (cost === undefined || cost === null) return null;
  const amount = cost.amount.trim();
  if (!AMOUNT.test(amount)) throw new HttpError(422, 'INVALID_COST', 'The cost is a non-negative amount with at most two decimals', { field: 'cost.amount' });
  const currency = cost.currency.trim().toUpperCase();
  if (!CURRENCY.test(currency)) throw new HttpError(422, 'INVALID_CURRENCY', 'The cost currency is a three-letter code', { field: 'cost.currency' });
  return { amount, currency };
}

async function requireOwner(db: Queryable, companyId: string, employeeId: string): Promise<void> {
  if (!(await isActiveEmployee(db, companyId, employeeId))) {
    throw new HttpError(422, 'INVALID_OWNER', 'The plan owner is an active employee of the company', { field: 'ownerEmployeeId' });
  }
}

/** The plan's question set: the given codes (active, in order) or, when omitted, every active question of the list. */
async function resolveQuestions(db: Queryable, companyId: string, codes: string[] | undefined): Promise<{ id: string; code: string }[]> {
  if (codes === undefined) {
    const all = (
      await db.query<{ id: string; code: string }>(
        `select id, code from reference_value_in_force where company_id = $1 and category = $2 order by label, code limit ${MAX_QUESTIONS}`,
        [companyId, QUESTION_LIST],
      )
    ).rows;
    if (all.length === 0) throw new HttpError(422, 'NO_FEEDBACK_QUESTIONS', 'The company has no active training feedback question; configure the TRAINING_FEEDBACK_QUESTION list first');
    return all;
  }
  if (codes.length === 0 || codes.length > MAX_QUESTIONS) throw new HttpError(422, 'INVALID_QUESTIONS', `A plan has 1 to ${MAX_QUESTIONS} feedback questions`, { field: 'feedbackQuestionCodes' });
  if (new Set(codes).size !== codes.length) throw new HttpError(422, 'INVALID_QUESTIONS', 'A feedback question is listed once', { field: 'feedbackQuestionCodes' });
  const out: { id: string; code: string }[] = [];
  for (const code of codes) {
    out.push({
      id: await referenceId(db, companyId, QUESTION_LIST, code, { code: 'INVALID_QUESTION', message: 'Unknown or inactive feedback question', field: 'feedbackQuestionCodes' }),
      code,
    });
  }
  return out;
}

async function activeQuestionCodes(db: Queryable, companyId: string, planId: string): Promise<string[]> {
  return (
    await db.query<{ code: string }>(
      `select q.code from training_plan_question pq join reference_value q on q.company_id = pq.company_id and q.id = pq.question_id
        where pq.company_id = $1 and pq.plan_id = $2 and pq.active order by pq.position`,
      [companyId, planId],
    )
  ).rows.map((r) => r.code);
}

/** Replaces the active question set (rows are deactivated, never deleted; positions follow the given order). */
async function setQuestions(tx: Queryable, grant: AccessGrant, planId: string, questions: { id: string }[]): Promise<void> {
  await tx.query(`update training_plan_question set active = false, updated_by = $3 where company_id = $1 and plan_id = $2 and active`, [grant.companyId, planId, grant.userId]);
  let position = 0;
  for (const q of questions) {
    position++;
    await tx.query(
      `insert into training_plan_question (company_id, plan_id, question_id, position, active, created_by, updated_by)
       values ($1, $2, $3, $4, true, $5, $5)
       on conflict (company_id, plan_id, question_id) do update set active = true, position = excluded.position, updated_by = excluded.updated_by`,
      [grant.companyId, planId, q.id, position, grant.userId],
    );
  }
}

async function feedbackRecorded(db: Queryable, companyId: string, planId: string): Promise<boolean> {
  return ((await db.query(`select 1 from training_feedback where company_id = $1 and plan_id = $2 limit 1`, [companyId, planId])).rowCount ?? 0) > 0;
}

async function outcomesRecorded(db: Queryable, companyId: string, planId: string): Promise<boolean> {
  return (
    ((await db.query(`select 1 from training_participant where company_id = $1 and plan_id = $2 and participation_state = any($3::text[]) limit 1`, [companyId, planId, OUTCOME_STATES]))
      .rowCount ?? 0) > 0
  );
}

export async function createPlan(tx: Queryable, grant: AccessGrant, input: PlanInput) {
  assertCompanyWide(grant);
  const code = input.code.trim().toUpperCase();
  if (!CODE.test(code)) throw new HttpError(422, 'INVALID_PLAN_CODE', 'A plan code is 1 to 40 letters, digits, dots, dashes, slashes or underscores', { field: 'code' });
  const title = requireText(input.title, 'title', 'INVALID_TITLE', 'Give the course title');
  const startDate = requireDate(input.startDate, 'start date');
  const endDate = requireDate(input.endDate, 'end date');
  // FR-049 acceptance: a plan with end before start is rejected.
  if (endDate < startDate) throw new HttpError(422, 'END_BEFORE_START', 'The end date cannot be before the start date', { field: 'endDate' });
  const modeId = await referenceId(tx, grant.companyId, MODE_LIST, input.modeCode, { code: 'INVALID_MODE', message: 'Unknown or inactive training mode', field: 'modeCode' });
  const cost = parseCost(input.cost);
  if (cost && !withCost(grant)) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  await requireOwner(tx, grant.companyId, input.ownerEmployeeId);
  const questions = await resolveQuestions(tx, grant.companyId, input.feedbackQuestionCodes);
  const venue = blankToNull(input.venue);
  const trainer = blankToNull(input.trainer);
  const selfNomination = input.selfNomination ?? false;
  const taken = await tx.query(`select 1 from training_plan where company_id = $1 and code = $2`, [grant.companyId, code]);
  if ((taken.rowCount ?? 0) > 0) throw new HttpError(409, 'PLAN_CODE_EXISTS', 'A plan with this code exists; plan codes are permanent and never reused');

  const id = (
    await tx.query<{ id: string }>(
      `insert into training_plan (company_id, code, title, start_date, end_date, mode_id, venue, trainer, capacity, cost_amount, cost_currency,
                                  owner_employee_id, self_nomination, state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11, $12, $13, 'ACTIVE', $14, $14) returning id`,
      [grant.companyId, code, title, startDate, endDate, modeId, venue, trainer, input.capacity, cost?.amount ?? null, cost?.currency ?? null, input.ownerEmployeeId, selfNomination, grant.userId],
    )
  ).rows[0]!.id;
  await setQuestions(tx, grant, id, questions);
  await audit(tx, grant, {
    resource: 'training_plan',
    recordKey: id,
    action: 'CREATE',
    newVersion: 1,
    after: {
      operational: {
        code,
        title,
        startDate,
        endDate,
        mode: input.modeCode,
        venue,
        trainer,
        capacity: input.capacity,
        ownerEmployeeId: input.ownerEmployeeId,
        selfNomination,
        feedbackQuestions: questions.map((q) => q.code),
        state: 'ACTIVE',
      },
      ...(cost ? { cost: { amount: cost.amount, currency: cost.currency } } : {}),
    },
  });
  return (await planDetail(tx, grant, id))!;
}

interface PlanRow {
  id: string;
  title: string;
  start_date: string;
  end_date: string;
  mode_code: string;
  mode_id: string;
  venue: string | null;
  trainer: string | null;
  capacity: number;
  cost_amount: string | null;
  cost_currency: string | null;
  owner_employee_id: string;
  self_nomination: boolean;
  state: 'ACTIVE' | 'CANCELLED';
  version: number;
}

async function loadPlanRow(tx: Queryable, companyId: string, id: string): Promise<PlanRow> {
  await lockPlan(tx, companyId, id);
  return (
    await tx.query<PlanRow>(
      `select p.id, p.title, to_char(p.start_date, 'YYYY-MM-DD') as start_date, to_char(p.end_date, 'YYYY-MM-DD') as end_date, m.code as mode_code, p.mode_id,
              p.venue, p.trainer, p.capacity, (p.cost_amount::numeric(19, 2))::text as cost_amount, p.cost_currency, p.owner_employee_id, p.self_nomination,
              p.state, p.version
         from training_plan p join reference_value m on m.company_id = p.company_id and m.id = p.mode_id
        where p.company_id = $1 and p.id = $2`,
      [companyId, id],
    )
  ).rows[0]!;
}

/** Canonical text of a two-decimal amount, so "1500", "01500.0" and "1500.00" compare equal (exact, no float). */
function normalise(amount: string): string {
  const [whole = '0', fraction = ''] = amount.split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(2, '0')}`;
}
const sameAmount = (a: string | null, b: string | null) => (a === null || b === null ? a === b : normalise(a) === normalise(b));

/** Corrects a plan that is not cancelled (the code is permanent). */
export async function updatePlan(tx: Queryable, grant: AccessGrant, id: string, input: PlanUpdate) {
  assertCompanyWide(grant);
  const p = await loadPlanRow(tx, grant.companyId, id);
  if (p.state === 'CANCELLED') throw new HttpError(409, 'PLAN_CANCELLED', 'A cancelled plan is final');
  if (p.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The plan changed; reload and retry');

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const costBefore: Record<string, unknown> = {};
  const costAfter: Record<string, unknown> = {};
  const change = (field: string, from: unknown, to: unknown) => {
    before[field] = from;
    after[field] = to;
  };

  let title = p.title;
  if (input.title !== undefined) {
    const t = requireText(input.title, 'title', 'INVALID_TITLE', 'Give the course title');
    if (t !== p.title) {
      change('title', p.title, t);
      title = t;
    }
  }
  const startDate = input.startDate !== undefined ? requireDate(input.startDate, 'start date') : p.start_date;
  const endDate = input.endDate !== undefined ? requireDate(input.endDate, 'end date') : p.end_date;
  if (endDate < startDate) throw new HttpError(422, 'END_BEFORE_START', 'The end date cannot be before the start date', { field: 'endDate' });
  if (startDate !== p.start_date || endDate !== p.end_date) {
    if (await outcomesRecorded(tx, grant.companyId, id)) throw new HttpError(409, 'DATES_FIXED', 'Attendance was recorded for this plan; its dates are fixed');
    if (startDate !== p.start_date) change('startDate', p.start_date, startDate);
    if (endDate !== p.end_date) change('endDate', p.end_date, endDate);
  }
  let modeId = p.mode_id;
  if (input.modeCode !== undefined && input.modeCode !== p.mode_code) {
    modeId = await referenceId(tx, grant.companyId, MODE_LIST, input.modeCode, { code: 'INVALID_MODE', message: 'Unknown or inactive training mode', field: 'modeCode' });
    change('mode', p.mode_code, input.modeCode);
  }
  let venue = p.venue;
  if (input.venue !== undefined && blankToNull(input.venue) !== p.venue) {
    venue = blankToNull(input.venue);
    change('venue', p.venue, venue);
  }
  let trainer = p.trainer;
  if (input.trainer !== undefined && blankToNull(input.trainer) !== p.trainer) {
    trainer = blankToNull(input.trainer);
    change('trainer', p.trainer, trainer);
  }
  let capacity = p.capacity;
  if (input.capacity !== undefined && input.capacity !== p.capacity) {
    const seats = await seatsTaken(tx, grant.companyId, id);
    if (input.capacity < seats) throw new HttpError(409, 'CAPACITY_BELOW_SEATS', `${seats} participations are confirmed; the capacity cannot be lower`, { seatsTaken: seats });
    change('capacity', p.capacity, input.capacity);
    capacity = input.capacity;
  }
  let costAmount = p.cost_amount;
  let costCurrency = p.cost_currency;
  if (input.cost !== undefined) {
    if (!withCost(grant)) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
    const cost = parseCost(input.cost);
    if (!sameAmount(cost?.amount ?? null, p.cost_amount) || (cost?.currency ?? null) !== p.cost_currency) {
      costBefore.cost = p.cost_amount === null ? null : { amount: p.cost_amount, currency: p.cost_currency };
      costAfter.cost = cost;
      costAmount = cost?.amount ?? null;
      costCurrency = cost?.currency ?? null;
    }
  }
  let owner = p.owner_employee_id;
  if (input.ownerEmployeeId !== undefined && input.ownerEmployeeId !== p.owner_employee_id) {
    await requireOwner(tx, grant.companyId, input.ownerEmployeeId);
    change('ownerEmployeeId', p.owner_employee_id, input.ownerEmployeeId);
    owner = input.ownerEmployeeId;
  }
  let selfNomination = p.self_nomination;
  if (input.selfNomination !== undefined && input.selfNomination !== p.self_nomination) {
    change('selfNomination', p.self_nomination, input.selfNomination);
    selfNomination = input.selfNomination;
  }
  let questions: { id: string; code: string }[] | null = null;
  if (input.feedbackQuestionCodes !== undefined) {
    const current = await activeQuestionCodes(tx, grant.companyId, id);
    const wanted = await resolveQuestions(tx, grant.companyId, input.feedbackQuestionCodes);
    if (wanted.map((q) => q.code).join(',') !== current.join(',')) {
      if (await feedbackRecorded(tx, grant.companyId, id)) throw new HttpError(409, 'QUESTIONS_FIXED', 'Feedback was recorded for this plan; its questions are fixed');
      change('feedbackQuestions', current, wanted.map((q) => q.code));
      questions = wanted;
    }
  }
  if (Object.keys(after).length === 0 && Object.keys(costAfter).length === 0) throw new HttpError(422, 'NO_CHANGE', 'Nothing differs from the plan');

  if (questions) await setQuestions(tx, grant, id, questions);
  const version = (
    await tx.query<{ version: number }>(
      `update training_plan set title = $3, start_date = $4, end_date = $5, mode_id = $6, venue = $7, trainer = $8, capacity = $9,
              cost_amount = $10::numeric, cost_currency = $11, owner_employee_id = $12, self_nomination = $13, updated_by = $14
        where company_id = $1 and id = $2 returning version`,
      [grant.companyId, id, title, startDate, endDate, modeId, venue, trainer, capacity, costAmount, costCurrency, owner, selfNomination, grant.userId],
    )
  ).rows[0]!.version;
  await audit(tx, grant, {
    resource: 'training_plan',
    recordKey: id,
    action: 'UPDATE',
    before: { operational: before, ...(Object.keys(costBefore).length ? { cost: costBefore } : {}) },
    after: { operational: after, ...(Object.keys(costAfter).length ? { cost: costAfter } : {}) },
    priorVersion: p.version,
    newVersion: version,
  });
  return (await planDetail(tx, grant, id))!;
}

/**
 * FR-049: cancels a plan with actor and reason. Live participations (nominated or confirmed) are cancelled with it and
 * each participant is told; a plan whose attendance was recorded took place and is not cancelled. A repeated
 * cancellation returns the cancelled plan without a second effect.
 */
export async function cancelPlan(tx: Queryable, grant: AccessGrant, id: string, input: { reason: string; expectedVersion: number }) {
  assertCompanyWide(grant);
  const p = await lockPlan(tx, grant.companyId, id);
  if (p.state === 'CANCELLED') return { ...(await planDetail(tx, grant, id))!, cancelledParticipations: 0, replayed: true };
  if (p.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The plan changed; reload and retry');
  const reason = requireText(input.reason, 'reason', 'REASON_REQUIRED', 'Record why the plan is cancelled');
  if (await outcomesRecorded(tx, grant.companyId, id)) {
    throw new HttpError(409, 'PLAN_HAS_ATTENDANCE', 'Attendance was recorded for this plan: the session took place and cannot be cancelled');
  }
  const live = (
    await tx.query<{ id: string; employee_id: string; participation_state: 'NOMINATED' | 'CONFIRMED' }>(
      `select id, employee_id, participation_state from training_participant
        where company_id = $1 and plan_id = $2 and participation_state in ('NOMINATED', 'CONFIRMED') order by id for update`,
      [grant.companyId, id],
    )
  ).rows;
  for (const t of live) {
    await tx.query(
      `update training_participant set participation_state = 'CANCELLED', cancelled_at = now(), cancelled_by = $3, cancellation_reason = $4, updated_by = $3
        where company_id = $1 and id = $2`,
      [grant.companyId, t.id, grant.userId, reason],
    );
    await recordChange(tx, grant, { participantId: t.id, planId: id, employeeId: t.employee_id, action: 'PLAN_CANCELLED', from: t.participation_state, to: 'CANCELLED', reason });
  }
  const version = (
    await tx.query<{ version: number }>(
      `update training_plan set state = 'CANCELLED', cancelled_at = now(), cancelled_by = $3, cancellation_reason = $4, updated_by = $3
        where company_id = $1 and id = $2 returning version`,
      [grant.companyId, id, grant.userId, reason],
    )
  ).rows[0]!.version;
  await audit(tx, grant, {
    resource: 'training_plan',
    recordKey: id,
    action: 'CANCEL',
    before: { operational: { state: 'ACTIVE' } },
    after: { operational: { state: 'CANCELLED', cancelledParticipations: live.length } },
    reason,
    priorVersion: p.version,
    newVersion: version,
  });
  return { ...(await planDetail(tx, grant, id))!, cancelledParticipations: live.length, replayed: false };
}

/** The register's filter: date view, text search and an overlapping date range (BRD E13 search/date filters). */
function planFilter(grant: AccessGrant, q: Omit<PlanListQuery, 'page' | 'pageSize'>): { where: string; params: SqlParams; day: () => string } {
  const params = new SqlParams([grant.companyId]);
  // Added on first use only: an unreferenced parameter has no inferable type.
  let dayRef: string | undefined;
  const day = () => (dayRef ??= params.add(grant.businessDate));
  const where = ['p.company_id = $1'];
  if (q.view) where.push(`${viewSql('p', day())} = ${params.add(q.view)}`);
  const search = q.search?.trim();
  if (search) {
    const pattern = params.add(likePattern(search));
    where.push(`(p.code ilike ${pattern} or p.title ilike ${pattern} or p.trainer ilike ${pattern} or p.venue ilike ${pattern})`);
  }
  const from = q.from !== undefined ? requireDate(q.from, 'from date') : undefined;
  const to = q.to !== undefined ? requireDate(q.to, 'to date') : undefined;
  if (from && to && to < from) throw new HttpError(422, 'INVALID_PERIOD', 'The period end is before its start', { field: 'to' });
  if (from) where.push(`p.end_date >= ${params.add(from)}::date`);
  if (to) where.push(`p.start_date <= ${params.add(to)}::date`);
  return { where: where.join(' and '), params, day };
}

const order = (view: PlanView | undefined) => (view === 'FUTURE' || view === 'CURRENT' ? 'p.start_date, p.code' : 'p.start_date desc, p.code');

export async function listPlans(db: Queryable, grant: AccessGrant, q: PlanListQuery) {
  const { where, params, day } = planFilter(grant, q);
  const total = Number((await db.query<{ n: string }>(`select count(*) as n from training_plan p where ${where}`, params.values)).rows[0]?.n ?? 0);
  const columns = planColumns(day(), withCost(grant));
  const limit = params.add(q.pageSize);
  const offset = params.add((q.page - 1) * q.pageSize);
  const rows = await db.query(`select ${columns} ${PLAN_FROM} where ${where} order by ${order(q.view)} limit ${limit} offset ${offset}`, params.values);
  return { items: rows.rows, total, page: q.page, pageSize: q.pageSize, businessDate: grant.businessDate };
}

/** A spreadsheet could read a value starting with = + - @ or a control character as a formula: it is written as text. */
export function cell(value: unknown): string {
  let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export const csvLine = (values: unknown[]) => values.map(cell).join(',');

/**
 * DF09 export of the register with the same filters: it states the filter, the business date and the generation time;
 * cost columns exist only when the assignment holds the cost group (omitted, not blanked). More than ROW_LIMIT plans
 * are refused (narrow the filters), never cut silently.
 */
export async function exportPlans(db: Queryable, grant: AccessGrant, q: Omit<PlanListQuery, 'page' | 'pageSize'>): Promise<{ fileName: string; content: string; rows: number }> {
  const { where, params, day } = planFilter(grant, q);
  const cost = withCost(grant);
  const rows = (
    await db.query<Record<string, unknown>>(
      `select p.code, p.title, to_char(p.start_date, 'YYYY-MM-DD') as start_date, to_char(p.end_date, 'YYYY-MM-DD') as end_date, ${viewSql('p', day())} as view,
              m.label as mode, p.venue, p.trainer, p.capacity, s.seats as seats_taken, s.pending as nominations_pending,
              o.employee_code as owner_code, o.display_name as owner_name, case when p.self_nomination then 'yes' else 'no' end as self_nomination,
              p.cancelled_at, p.cancellation_reason
              ${cost ? `, (p.cost_amount::numeric(19, 2))::text as cost_amount, p.cost_currency` : ''}
         ${PLAN_FROM}
        where ${where}
        order by ${order(q.view)}
        limit ${ROW_LIMIT + 1}`,
      params.values,
    )
  ).rows;
  if (rows.length > ROW_LIMIT) {
    throw new HttpError(422, 'EXPORT_TOO_LARGE', `An export holds at most ${ROW_LIMIT} plans; narrow it with the view, search or period filters`, { limit: ROW_LIMIT });
  }
  const columns = [
    'code',
    'title',
    'start_date',
    'end_date',
    'view',
    'mode',
    'venue',
    'trainer',
    'capacity',
    'seats_taken',
    'nominations_pending',
    'owner_code',
    'owner_name',
    'self_nomination',
    'cancelled_at',
    'cancellation_reason',
    ...(cost ? ['cost_amount', 'cost_currency'] : []),
  ];
  const headers = [
    'Plan code',
    'Title',
    'Start date',
    'End date',
    'View',
    'Mode',
    'Venue',
    'Trainer',
    'Capacity',
    'Confirmed seats',
    'Pending nominations',
    'Owner code',
    'Owner name',
    'Self-nomination',
    'Cancelled at',
    'Cancellation reason',
    ...(cost ? ['Cost', 'Cost currency'] : []),
  ];
  const context = await fileContext(db, grant, {
    title: 'Training plan export',
    code: 'TRAINING_PLAN_EXPORT',
    period: { from: q.from, to: q.to },
    filters: { view: q.view ?? 'all', search: q.search?.trim(), 'business date': grant.businessDate },
    rowCount: rows.length,
  });
  const lines = [
    ...contextCsvLines(context),
    csvLine(headers),
    ...rows.map((r) => csvLine(columns.map((c) => r[c]))),
  ];
  // Who exported which selection, with which column set (never the values).
  await audit(db, grant, {
    resource: 'training_plan',
    recordKey: randomUUID(),
    action: 'EXPORT',
    after: { operational: { rows: rows.length, view: q.view ?? null, search: q.search?.trim() || null, from: q.from ?? null, to: q.to ?? null, costColumns: cost } },
  });
  return { fileName: `training-plans-${grant.businessDate}.csv`, content: `${lines.join('\r\n')}\r\n`, rows: rows.length };
}
