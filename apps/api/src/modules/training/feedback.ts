// Training feedback (FR-050; F1 "Feedback score 1..5 after completion, comments restricted"; DB074; CI14; DF02; DF09;
// H3 TN17 "feedback entry").
// The participant gives feedback once, after their completion is recorded: for each question of the plan a score 1..5
// (F1 "feedback score 1..5"; DF04 "feedback score 1..5 and optional restricted comment", requiredness following that
// contract) and an optional comment. Scores are operational; the comment is a confidential group: the employee's own
// comment through the own-ESS exception (H1/BR-053), anyone else only through an eligible Admin assignment with an
// approved grant (the coordinator sees scores and response status, never comments). The register and summary cover the
// caller's row scope and reconcile to its participants: every completed participation is RESPONDED or MISSING (shown
// distinctly), every other one is NOT_APPLICABLE, and per question the answers plus the missing responses equal the
// completed count.
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { audit, isCompanyWide, lockPlan, ownEmployee, PARTICIPATION_STATES, type ParticipationState, ROW_LIMIT, viewSql } from './common.js';
import { FEEDBACK_STATUS } from './participants.js';
import { csvLine } from './plans.js';

export interface AnswerInput {
  questionCode: string;
  score?: number | null | undefined;
  comment?: string | null | undefined;
}

export interface FeedbackInput {
  participantId: string;
  answers: AnswerInput[];
}

const withComments = (grant: AccessGrant) => grant.allowedFieldGroups.includes('comment');

interface Question {
  id: string;
  code: string;
  label: string;
  position: number;
}

async function planQuestions(db: Queryable, companyId: string, planId: string): Promise<Question[]> {
  return (
    await db.query<Question>(
      `select q.id, q.code, q.label, pq.position from training_plan_question pq join reference_value q on q.company_id = pq.company_id and q.id = pq.question_id
        where pq.company_id = $1 and pq.plan_id = $2 and pq.active order by pq.position`,
      [companyId, planId],
    )
  ).rows;
}

/** Answer rows of participations (alias t), with the comment only when the caller holds the comment group. */
const answersJson = (comments: boolean) => `coalesce((select json_agg(json_build_object('questionCode', q.code, 'score', f.score
                 ${comments ? `, 'comment', f.response` : ''}) order by pq.position)
            from training_feedback f
            join training_plan_question pq on pq.company_id = f.company_id and pq.plan_id = f.plan_id and pq.question_id = f.question_id
            join reference_value q on q.company_id = f.company_id and q.id = f.question_id
           where f.company_id = t.company_id and f.participant_id = t.id), '[]'::json)`;

const submittedAt = `(select min(f.submitted_at) from training_feedback f where f.company_id = t.company_id and f.participant_id = t.id)`;

/** The caller's own completed participations with their feedback status, questions and own answers (H3 TN17). */
export async function ownFeedback(db: Queryable, grant: AccessGrant) {
  const employeeId = ownEmployee(grant);
  const rows = await db.query(
    `select t.id as "participantId", t.completed_at as "completedAt", ${FEEDBACK_STATUS} as status, ${submittedAt} as "submittedAt",
            json_build_object('id', p.id, 'code', p.code, 'title', p.title, 'startDate', to_char(p.start_date, 'YYYY-MM-DD'),
                              'endDate', to_char(p.end_date, 'YYYY-MM-DD'), 'view', ${viewSql('p', '$3')}) as plan,
            coalesce((select json_agg(json_build_object('code', q.code, 'label', q.label, 'position', pq.position) order by pq.position)
                        from training_plan_question pq join reference_value q on q.company_id = pq.company_id and q.id = pq.question_id
                       where pq.company_id = p.company_id and pq.plan_id = p.id and pq.active), '[]'::json) as questions,
            ${answersJson(withComments(grant))} as answers
       from training_participant t
       join training_plan p on p.company_id = t.company_id and p.id = t.plan_id
      where t.company_id = $1 and t.employee_id = $2 and t.participation_state = 'COMPLETED'
      order by t.completed_at desc, p.code
      limit 200`,
    [grant.companyId, employeeId, grant.businessDate],
  );
  return { items: rows.rows };
}

interface NormalisedAnswer {
  questionId: string;
  questionCode: string;
  score: number;
  comment: string | null;
}

/**
 * The participant's feedback (all questions of the plan, once). Only the participant gives it, only after completion;
 * once given it is immutable. Repeating the same submission returns it without a second effect; a different one is
 * refused. Concurrent submissions serialise on the participation row.
 */
export async function submitFeedback(tx: Queryable, grant: AccessGrant, input: FeedbackInput) {
  const employeeId = ownEmployee(grant);
  const own = (
    await tx.query<{ plan_id: string }>(`select plan_id from training_participant where company_id = $1 and id = $2 and employee_id = $3`, [
      grant.companyId,
      input.participantId,
      employeeId,
    ])
  ).rows[0];
  if (!own) throw notFound();
  // Plan shared (its questions cannot change meanwhile), then the participation exclusively.
  await lockPlan(tx, grant.companyId, own.plan_id, 'share');
  const t = (
    await tx.query<{ participation_state: ParticipationState }>(`select participation_state from training_participant where company_id = $1 and id = $2 for update`, [
      grant.companyId,
      input.participantId,
    ])
  ).rows[0]!;
  if (t.participation_state !== 'COMPLETED') throw new HttpError(409, 'FEEDBACK_NOT_OPEN', 'Feedback opens once your completion of the training is recorded');

  const questions = await planQuestions(tx, grant.companyId, own.plan_id);
  const byCode = new Map(questions.map((q) => [q.code, q]));
  const seen = new Set<string>();
  const answers: NormalisedAnswer[] = [];
  for (const a of input.answers) {
    const q = byCode.get(a.questionCode);
    if (!q || seen.has(a.questionCode)) {
      throw new HttpError(422, 'ANSWERS_MISMATCH', 'Answer each question of the training once', { expected: questions.map((x) => x.code) });
    }
    seen.add(a.questionCode);
    const score = a.score ?? null;
    // F1 / DF04: every answer carries a score 1..5; only the comment is optional.
    if (score === null) throw new HttpError(422, 'SCORE_REQUIRED', 'Give a score from 1 to 5 for each question', { questionCode: a.questionCode });
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new HttpError(422, 'INVALID_SCORE', 'A score is a whole number from 1 to 5', { questionCode: a.questionCode });
    }
    const comment = a.comment === undefined || a.comment === null || a.comment.trim() === '' ? null : a.comment.trim();
    answers.push({ questionId: q.id, questionCode: q.code, score, comment });
  }
  if (seen.size !== questions.length) throw new HttpError(422, 'ANSWERS_MISMATCH', 'Answer each question of the training once', { expected: questions.map((x) => x.code) });
  // The comment is a confidential group: without it in this assignment, no comment is accepted.
  if (answers.some((a) => a.comment !== null) && !withComments(grant)) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');

  const existing = (
    await tx.query<{ question_id: string; score: number; response: string | null }>(
      `select question_id, score, response from training_feedback where company_id = $1 and participant_id = $2`,
      [grant.companyId, input.participantId],
    )
  ).rows;
  if (existing.length > 0) {
    const same =
      existing.length === answers.length &&
      answers.every((a) => existing.some((e) => e.question_id === a.questionId && e.score === a.score && e.response === a.comment));
    if (!same) throw new HttpError(409, 'FEEDBACK_ALREADY_SUBMITTED', 'Your feedback for this training was already recorded and cannot be changed');
    return { ...(await ownFeedbackItem(tx, grant, input.participantId)), replayed: true };
  }
  for (const a of answers) {
    await tx.query(
      `insert into training_feedback (company_id, participant_id, plan_id, employee_id, question_id, score, response, submitted_by, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [grant.companyId, input.participantId, own.plan_id, employeeId, a.questionId, a.score, a.comment, grant.userId],
    );
  }
  // Scores are operational; the trail records which answers carry a comment, never the comment.
  await audit(tx, grant, {
    resource: 'training_feedback',
    recordKey: input.participantId,
    action: 'SUBMIT',
    after: {
      operational: {
        planId: own.plan_id,
        scores: Object.fromEntries(answers.map((a) => [a.questionCode, a.score])),
        commented: answers.filter((a) => a.comment !== null).map((a) => a.questionCode),
      },
    },
  });
  return { ...(await ownFeedbackItem(tx, grant, input.participantId)), replayed: false };
}

async function ownFeedbackItem(db: Queryable, grant: AccessGrant, participantId: string) {
  return (
    await db.query(
      `select t.id as "participantId", ${FEEDBACK_STATUS} as status, ${submittedAt} as "submittedAt", ${answersJson(withComments(grant))} as answers
         from training_participant t where t.company_id = $1 and t.id = $2`,
      [grant.companyId, participantId],
    )
  ).rows[0] as Record<string, unknown>;
}

interface PlanHead {
  id: string;
  code: string;
  title: string;
  startDate: string;
  endDate: string;
  view: string;
}

async function planHead(db: Queryable, grant: AccessGrant, planId: string): Promise<PlanHead> {
  const plan = (
    await db.query<PlanHead>(
      `select p.id, p.code, p.title, to_char(p.start_date, 'YYYY-MM-DD') as "startDate", to_char(p.end_date, 'YYYY-MM-DD') as "endDate", ${viewSql('p', '$3')} as view
         from training_plan p where p.company_id = $1 and p.id = $2`,
      [grant.companyId, planId, grant.businessDate],
    )
  ).rows[0];
  if (!plan) throw notFound();
  return plan;
}

export const FEEDBACK_STATUSES = ['RESPONDED', 'MISSING', 'NOT_APPLICABLE'] as const;

/**
 * The feedback register of a plan within the caller's row scope: per participation, its status and answers. More than
 * ROW_LIMIT participations are refused (narrow it by status), never cut silently, so it reconciles to the summary.
 */
export async function feedbackRegister(db: Queryable, grant: AccessGrant, planId: string, q: { status?: (typeof FEEDBACK_STATUSES)[number] | undefined }) {
  const plan = await planHead(db, grant, planId);
  const params = new SqlParams([grant.companyId, planId]);
  const where = [`t.company_id = $1`, `t.plan_id = $2`, employeeScopePredicate(grant, { company: 't.company_id', employee: 't.employee_id' }, params)];
  if (q.status) where.push(`${FEEDBACK_STATUS} = ${params.add(q.status)}`);
  const comments = withComments(grant);
  const rows = await db.query(
    `select t.id as "participantId", t.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",
            t.participation_state as state, t.completed_at as "completedAt", ${FEEDBACK_STATUS} as "feedbackStatus", ${submittedAt} as "submittedAt",
            ${answersJson(comments)} as answers
       from training_participant t join employee e on e.company_id = t.company_id and e.id = t.employee_id
      where ${where.join(' and ')}
      order by e.employee_code, t.id
      limit ${ROW_LIMIT + 1}`,
    params.values,
  );
  if (rows.rows.length > ROW_LIMIT) {
    throw new HttpError(422, 'TOO_MANY_ROWS', `A feedback register holds at most ${ROW_LIMIT} participations; filter it by feedback status`, { limit: ROW_LIMIT });
  }
  return {
    plan,
    questions: (await planQuestions(db, grant.companyId, planId)).map(({ code, label, position }) => ({ code, label, position })),
    scope: { kind: grant.scopeKind, companyWide: isCompanyWide(grant) },
    commentsIncluded: comments,
    items: rows.rows,
  };
}

/**
 * FR-050 feedback summary of a plan within the caller's row scope, counted directly from the records so that it
 * reconciles to the participants: participations by state; completed ones responded or missing; per question the score
 * distribution 1..5 and the missing responses. No average or other derived score is computed (the BRD defines none).
 * Never contains comments.
 */
export async function feedbackSummary(db: Queryable, grant: AccessGrant, planId: string) {
  const plan = await planHead(db, grant, planId);
  const params = new SqlParams([grant.companyId, planId]);
  const scope = employeeScopePredicate(grant, { company: 't.company_id', employee: 't.employee_id' }, params);
  const population = `from training_participant t where t.company_id = $1 and t.plan_id = $2 and ${scope}`;

  const states = (await db.query<{ state: ParticipationState; n: number }>(`select t.participation_state as state, count(*)::int as n ${population} group by 1`, params.values)).rows;
  const byState = Object.fromEntries(PARTICIPATION_STATES.map((s) => [s, states.find((r) => r.state === s)?.n ?? 0])) as Record<ParticipationState, number>;
  const total = (await db.query<{ n: number }>(`select count(*)::int as n ${population}`, params.values)).rows[0]!.n;
  const responses = (
    await db.query<{ responded: number; missing: number }>(
      `select (count(*) filter (where exists (select 1 from training_feedback f where f.company_id = t.company_id and f.participant_id = t.id)))::int as responded,
              (count(*) filter (where not exists (select 1 from training_feedback f where f.company_id = t.company_id and f.participant_id = t.id)))::int as missing
         ${population} and t.participation_state = 'COMPLETED'`,
      params.values,
    )
  ).rows[0]!;
  const perQuestion = (
    await db.query<{ question_id: string; answered: number; s1: number; s2: number; s3: number; s4: number; s5: number; missing: number }>(
      `select pq.question_id,
              (select count(*)::int from training_feedback f join training_participant t on t.company_id = f.company_id and t.id = f.participant_id
                where f.company_id = pq.company_id and f.plan_id = pq.plan_id and f.question_id = pq.question_id and ${scope}) as answered,
              ${[1, 2, 3, 4, 5]
                .map(
                  (s) => `(select count(*)::int from training_feedback f join training_participant t on t.company_id = f.company_id and t.id = f.participant_id
                            where f.company_id = pq.company_id and f.plan_id = pq.plan_id and f.question_id = pq.question_id and f.score = ${s} and ${scope}) as s${s}`,
                )
                .join(',\n              ')},
              (select count(*)::int ${population} and t.participation_state = 'COMPLETED'
                  and not exists (select 1 from training_feedback f where f.company_id = t.company_id and f.participant_id = t.id and f.question_id = pq.question_id)) as missing
         from training_plan_question pq
        where pq.company_id = $1 and pq.plan_id = $2 and pq.active`,
      params.values,
    )
  ).rows;
  const questions = (await planQuestions(db, grant.companyId, planId)).map((q) => {
    const r = perQuestion.find((x) => x.question_id === q.id)!;
    return {
      code: q.code,
      label: q.label,
      position: q.position,
      answered: r.answered,
      scores: { '1': r.s1, '2': r.s2, '3': r.s3, '4': r.s4, '5': r.s5 },
      missing: r.missing,
    };
  });
  const completed = byState.COMPLETED;
  return {
    plan,
    scope: { kind: grant.scopeKind, companyWide: isCompanyWide(grant) },
    generatedAt: new Date().toISOString(),
    participants: { total, byState },
    feedback: { eligible: completed, responded: responses.responded, missing: responses.missing, notApplicable: total - completed },
    questions,
    reconciles: {
      participants: PARTICIPATION_STATES.reduce((sum, s) => sum + byState[s], 0) === total,
      responses: responses.responded + responses.missing === completed,
      questions: questions.every(
        (q) => q.answered + q.missing === completed && q.scores['1'] + q.scores['2'] + q.scores['3'] + q.scores['4'] + q.scores['5'] === q.answered,
      ),
    },
  };
}

/**
 * DF09 export of the feedback register (scores and response status; comments are never exported, so no restricted
 * column exists in the file). It states the plan, the scope and the generation time.
 */
export async function exportFeedback(db: Queryable, grant: AccessGrant, planId: string): Promise<{ fileName: string; content: string; rows: number }> {
  const register = await feedbackRegister(db, { ...grant, allowedFieldGroups: grant.allowedFieldGroups.filter((g) => g !== 'comment') }, planId, {});
  const items = register.items as { employeeCode: string; employeeName: string; state: string; feedbackStatus: string; submittedAt: Date | null; answers: { questionCode: string; score: number }[] }[];
  const lines = [
    csvLine(['Training feedback export']),
    csvLine(['Plan', register.plan.code, register.plan.title, register.plan.startDate, register.plan.endDate]),
    csvLine(['Scope', register.scope.kind, register.scope.companyWide ? 'company-wide' : 'filtered']),
    csvLine(['Generated at', new Date().toISOString()]),
    csvLine(['Rows', items.length]),
    '',
    csvLine(['Employee code', 'Employee name', 'Participation state', 'Feedback status', 'Submitted at', ...register.questions.map((q) => `Score: ${q.label}`)]),
    ...items.map((r) =>
      csvLine([
        r.employeeCode,
        r.employeeName,
        r.state,
        r.feedbackStatus,
        r.submittedAt,
        ...register.questions.map((q) => {
          const a = r.answers.find((x) => x.questionCode === q.code);
          return a ? a.score : '';
        }),
      ]),
    ),
  ];
  await audit(db, grant, { resource: 'training_feedback', recordKey: planId, action: 'EXPORT', after: { operational: { rows: items.length, commentColumns: false } } });
  // Plan codes may contain "/" (DB072 code format), which a file name must not.
  return { fileName: `training-feedback-${register.plan.code.replace(/[^A-Za-z0-9._-]/g, '_')}.csv`, content: `${lines.join('\r\n')}\r\n`, rows: items.length };
}
