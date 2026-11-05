// Appraisal report and export (FR-044; F1 "no forced distribution"; DF02; DF09 exports; F1 outputs). Both cover one
// cycle within the selected assignment's row scope, optionally narrowed to a department, and state the population
// they report. The operational part counts appraisals by state; the rating part (confidential rating group) counts
// completed appraisals by their exact final rating, so the counts reconcile to the completed population. There are no
// bins, targets or expected shares: the BRD defines none and selects no forced distribution. The caller's own
// appraisal is outside every report and export (its rating stays hidden from its subject). Restricted columns are left
// out of the export entirely when the assignment lacks the rating group, not blanked after retrieval.
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { contextCsvLines, fileContext } from '../report/context.js';
import { audit, loadCycle } from './common.js';

interface Population {
  where: string;
  params: SqlParams;
}

function population(grant: AccessGrant, cycleId: string, departmentId: string | undefined): Population {
  const params = new SqlParams();
  const parts = [employeeScopePredicate(grant, { company: 'a.company_id', employee: 'a.employee_id' }, params), `a.cycle_id = ${params.add(cycleId)}::uuid`];
  if (grant.linkedEmployeeId) parts.push(`a.employee_id <> ${params.add(grant.linkedEmployeeId)}::uuid`);
  if (departmentId) {
    const day = params.add(grant.businessDate);
    parts.push(
      `exists (select 1 from employment_assignment ea where ea.company_id = a.company_id and ea.employee_id = a.employee_id
                 and ea.department_id = ${params.add(departmentId)}::uuid
                 and ea.effective_from <= ${day}::date and (ea.effective_to is null or ea.effective_to > ${day}::date))`,
    );
  }
  return { where: parts.join(' and '), params };
}

const STATES = ['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'RETURNED', 'APPROVED', 'CANCELLED'] as const;

export async function cycleReport(db: Queryable, grant: AccessGrant, cycleId: string, q: { departmentId?: string | undefined }) {
  const cycle = await loadCycle(db, grant.companyId, cycleId);
  if (!cycle) throw notFound();
  const pop = population(grant, cycleId, q.departmentId);
  const counts = (await db.query<{ state: string; n: number }>(`select a.state, count(*)::int as n from appraisal a where ${pop.where} group by a.state`, pop.params.values)).rows;
  const byState = Object.fromEntries(STATES.map((s) => [s, counts.find((c) => c.state === s)?.n ?? 0])) as Record<(typeof STATES)[number], number>;
  const active = STATES.filter((s) => s !== 'CANCELLED').reduce((sum, s) => sum + byState[s], 0);
  const report: Record<string, unknown> = {
    cycle: { id: cycle.id, code: cycle.code, name: cycle.name, startDate: cycle.start_date, endDate: cycle.end_date },
    filters: { departmentId: q.departmentId ?? null },
    scope: grant.scopeKind,
    ownAppraisalExcluded: grant.linkedEmployeeId !== null,
    generatedAt: new Date().toISOString(),
    // The selected population: appraisals of the cycle in scope, cancelled ones counted apart.
    population: active,
    byState,
  };
  if (grant.allowedFieldGroups.includes('rating')) {
    const distribution = (
      await db.query<{ finalRating: string; count: number }>(
        `select a.final_rating::text as "finalRating", count(*)::int as count from appraisal a where ${pop.where} and a.state = 'APPROVED'
          group by a.final_rating order by a.final_rating`,
        pop.params.values,
      )
    ).rows;
    report.ratings = { completed: byState.APPROVED, distribution };
  }
  return report;
}

/** FR-065-style cell: a value a spreadsheet could read as a formula is written as text; every cell is quoted. */
function cell(value: unknown): string {
  let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const line = (values: unknown[]) => values.map(cell).join(',');

/**
 * Rows in one synchronous export (a technical bound, the DF09 initial batch size). A larger population is refused, to be
 * narrowed with the department filter, never cut silently: the export must reconcile to the population it states.
 */
export const EXPORT_ROW_LIMIT = 10_000;

export async function cycleExport(db: Queryable, grant: AccessGrant, cycleId: string, q: { departmentId?: string | undefined }): Promise<{ fileName: string; content: string; rows: number }> {
  const cycle = await loadCycle(db, grant.companyId, cycleId);
  if (!cycle) throw notFound();
  const withRating = grant.allowedFieldGroups.includes('rating');
  const pop = population(grant, cycleId, q.departmentId);
  const day = pop.params.add(grant.businessDate);
  const rows = (
    await db.query<Record<string, unknown>>(
      `select e.employee_code, e.display_name, dep.name as department, a.state, a.revision,
              (select count(*)::int from appraisal_item i where i.company_id = a.company_id and i.appraisal_id = a.id and i.active) as goal_count,
              (select coalesce(sum(i.weight), 0)::int from appraisal_item i where i.company_id = a.company_id and i.appraisal_id = a.id and i.active) as goal_weight_total,
              (select max(r.submitted_at) from appraisal_revision r where r.company_id = a.company_id and r.appraisal_id = a.id) as submitted_at,
              a.completed_at
              ${withRating ? `, (select r.weighted_result::text from appraisal_revision r where r.company_id = a.company_id and r.appraisal_id = a.id and r.revision = a.revision) as weighted_result, a.final_rating::text as final_rating` : ''}
         from appraisal a
         join employee e on e.company_id = a.company_id and e.id = a.employee_id
         left join lateral (select d.name from employment_assignment ea join department d on d.company_id = ea.company_id and d.id = ea.department_id
                             where ea.company_id = a.company_id and ea.employee_id = a.employee_id
                               and ea.effective_from <= ${day}::date and (ea.effective_to is null or ea.effective_to > ${day}::date) limit 1) dep on true
        where ${pop.where}
        order by e.employee_code
        limit ${EXPORT_ROW_LIMIT + 1}`,
      pop.params.values,
    )
  ).rows;
  if (rows.length > EXPORT_ROW_LIMIT) {
    throw new HttpError(422, 'EXPORT_TOO_LARGE', `An export holds at most ${EXPORT_ROW_LIMIT} rows; narrow it with the department filter`, { limit: EXPORT_ROW_LIMIT });
  }
  const columns = ['employee_code', 'display_name', 'department', 'state', 'revision', 'goal_count', 'goal_weight_total', 'submitted_at', 'completed_at', ...(withRating ? ['weighted_result', 'final_rating'] : [])];
  const headers = ['Employee code', 'Employee name', 'Department', 'State', 'Revision', 'Goals', 'Goal weight total', 'Last submitted at', 'Completed at', ...(withRating ? ['Weighted manager result', 'Final rating'] : [])];
  // DF09: the export states its filter, period, scope and generation time, as every report file does (report/context.ts).
  const context = await fileContext(db, grant, {
    title: 'Appraisal export',
    code: 'APPRAISAL_EXPORT',
    period: { from: cycle.start_date, to: cycle.end_date },
    filters: { cycle: cycle.code, department: q.departmentId ?? 'all in scope' },
    rowCount: rows.length,
  });
  const lines = [
    ...contextCsvLines(context),
    line(headers),
    ...rows.map((r) => line(columns.map((c) => r[c]))),
  ];
  // Who exported what, with which column set (never the values).
  await audit(db, grant, 'appraisal_cycle', cycle.id, 'EXPORT', null, { rows: rows.length, departmentId: q.departmentId ?? null, ratingColumns: withRating });
  return { fileName: `appraisals-${cycle.code}.csv`, content: `${lines.join('\r\n')}\r\n`, rows: rows.length };
}
