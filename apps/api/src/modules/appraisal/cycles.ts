// Appraisal settings and cycles (FR-040; F1 "financial-year cycle"; E11 "Appraisal Config"; DB063).
// The company sets the first month of its financial-year cycle (an explained quarter-start month: 1, 4, 7 or 10;
// no default). A cycle runs twelve months from the first day of that month and carries its inclusive goal-setting,
// self-entry and manager-rating windows, in process order, and its reviewer confirmation levels (one by default, a
// second only when set explicitly, F1). Code and period never change; levels are fixed once an appraisal of the cycle
// has been submitted; a cycle closes only when every appraisal in it is finished.
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import type { AccessGrant } from '../access/authorize.js';
import { audit, CYCLE_COLUMNS, type CycleRow, loadCycle, requireDate, requireUnrestricted, STAGES, type Stage, windowOf, windowStatus } from './common.js';

export const CYCLE_START_MONTHS = [1, 4, 7, 10] as const;

export async function getSetting(db: Queryable, grant: AccessGrant) {
  const row = (await db.query<{ cycle_start_month: number; version: number }>(`select cycle_start_month, version from appraisal_setting where company_id = $1`, [grant.companyId])).rows[0];
  return row
    ? { configured: true, cycleStartMonth: row.cycle_start_month, version: row.version }
    : { configured: false, cycleStartMonth: null, version: null, missing: ['cycleStartMonth'] };
}

export async function putSetting(tx: Queryable, grant: AccessGrant, input: { cycleStartMonth: number; expectedVersion?: number | undefined }) {
  requireUnrestricted(grant);
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('appraisal_setting:' || $1, 0))`, [grant.companyId]);
  const before = (await tx.query<{ id: string; cycle_start_month: number; version: number }>(`select id, cycle_start_month, version from appraisal_setting where company_id = $1`, [grant.companyId])).rows[0];
  if (before) {
    if (input.expectedVersion === undefined || input.expectedVersion !== before.version) throw new HttpError(409, 'STALE_VERSION', 'The setting changed; reload and retry');
    if (before.cycle_start_month !== input.cycleStartMonth) {
      await tx.query(`update appraisal_setting set cycle_start_month = $2, updated_by = $3 where company_id = $1`, [grant.companyId, input.cycleStartMonth, grant.userId]);
      await audit(tx, grant, 'appraisal_setting', before.id, 'UPDATE', { cycleStartMonth: before.cycle_start_month }, { cycleStartMonth: input.cycleStartMonth });
    }
  } else {
    if (input.expectedVersion !== undefined) throw new HttpError(409, 'STALE_VERSION', 'The setting changed; reload and retry');
    const id = (
      await tx.query<{ id: string }>(`insert into appraisal_setting (company_id, cycle_start_month, created_by, updated_by) values ($1, $2, $3, $3) returning id`, [
        grant.companyId,
        input.cycleStartMonth,
        grant.userId,
      ])
    ).rows[0]!.id;
    await audit(tx, grant, 'appraisal_setting', id, 'CREATE', null, { cycleStartMonth: input.cycleStartMonth });
  }
  return getSetting(tx, grant);
}

export interface WindowInput {
  opensOn: string;
  closesOn: string;
}

export interface WindowsInput {
  goalSetting?: WindowInput | null | undefined;
  selfEntry?: WindowInput | null | undefined;
  managerRating?: WindowInput | null | undefined;
}

const WINDOW_KEYS: Record<Stage, keyof WindowsInput> = { GOAL_SETTING: 'goalSetting', SELF_ENTRY: 'selfEntry', MANAGER_RATING: 'managerRating' };

/** Validates the windows: real dates, opens on or before closes, and process order (goals, self-entry, rating). */
function checkWindows(input: WindowsInput): Record<Stage, WindowInput | null> {
  const out = {} as Record<Stage, WindowInput | null>;
  for (const stage of STAGES) {
    const w = input[WINDOW_KEYS[stage]] ?? null;
    if (w) {
      requireDate(w.opensOn, `${WINDOW_KEYS[stage]}.opensOn`);
      requireDate(w.closesOn, `${WINDOW_KEYS[stage]}.closesOn`);
      if (w.closesOn < w.opensOn) throw new HttpError(422, 'INVALID_WINDOW', 'A window cannot close before it opens', { stage });
    }
    out[stage] = w ? { opensOn: w.opensOn, closesOn: w.closesOn } : null;
  }
  // FR-040 "align KRA and appraisal windows": a later stage neither opens nor closes before an earlier one.
  for (let i = 0; i < STAGES.length; i++) {
    for (let j = i + 1; j < STAGES.length; j++) {
      const earlier = out[STAGES[i]!];
      const later = out[STAGES[j]!];
      if (earlier && later && (later.opensOn < earlier.opensOn || later.closesOn < earlier.closesOn)) {
        throw new HttpError(422, 'WINDOW_ORDER', 'Windows follow the process order: goal setting, then self-entry, then manager rating', { earlier: STAGES[i], later: STAGES[j] });
      }
    }
  }
  return out;
}

const plusYearMinusDay = async (db: Queryable, start: string) =>
  (await db.query<{ d: string }>(`select to_char(($1::date + interval '1 year' - interval '1 day')::date, 'YYYY-MM-DD') as d`, [start])).rows[0]!.d;

export interface CycleInput {
  code: string;
  name: string;
  startDate: string;
  approvalLevels?: 1 | 2 | undefined;
  windows?: WindowsInput | undefined;
}

export async function createCycle(tx: Queryable, grant: AccessGrant, input: CycleInput): Promise<string> {
  requireUnrestricted(grant);
  const setting = (await tx.query<{ m: number }>(`select cycle_start_month as m from appraisal_setting where company_id = $1`, [grant.companyId])).rows[0];
  if (!setting) throw new HttpError(422, 'APPRAISAL_NOT_CONFIGURED', 'Set the appraisal cycle start month before creating a cycle', { missing: ['cycleStartMonth'] });
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(code)) throw new HttpError(422, 'INVALID_CODE', 'Use 1 to 40 letters, digits, hyphens or underscores', { field: 'code' });
  const name = input.name.trim();
  if (!name) throw new HttpError(422, 'FIELD_REQUIRED', 'name is required', { field: 'name' });
  const start = requireDate(input.startDate, 'startDate');
  // F1 financial-year cycle starting on the first day of the configured month.
  if (start.slice(8) !== '01' || Number(start.slice(5, 7)) !== setting.m) {
    throw new HttpError(422, 'CYCLE_START_NOT_ALIGNED', 'A cycle starts on the first day of the configured cycle start month', { cycleStartMonth: setting.m });
  }
  const end = await plusYearMinusDay(tx, start);
  const w = checkWindows(input.windows ?? {});
  const exists = await tx.query(`select 1 from appraisal_cycle where company_id = $1 and code = $2`, [grant.companyId, code]);
  if (exists.rowCount) throw new HttpError(409, 'CYCLE_CODE_EXISTS', 'A cycle with this code already exists');
  const id = (
    await tx.query<{ id: string }>(
      `insert into appraisal_cycle (company_id, code, name, start_date, end_date, approval_levels, goal_opens_on, goal_closes_on, self_opens_on, self_closes_on,
                                    rating_opens_on, rating_closes_on, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13) returning id`,
      [
        grant.companyId,
        code,
        name,
        start,
        end,
        input.approvalLevels ?? 1,
        w.GOAL_SETTING?.opensOn ?? null,
        w.GOAL_SETTING?.closesOn ?? null,
        w.SELF_ENTRY?.opensOn ?? null,
        w.SELF_ENTRY?.closesOn ?? null,
        w.MANAGER_RATING?.opensOn ?? null,
        w.MANAGER_RATING?.closesOn ?? null,
        grant.userId,
      ],
    )
  ).rows[0]!.id;
  await audit(tx, grant, 'appraisal_cycle', id, 'CREATE', null, { code, name, startDate: start, endDate: end, approvalLevels: input.approvalLevels ?? 1, windows: w });
  return id;
}

const windowsOf = (c: CycleRow) => Object.fromEntries(STAGES.map((s) => [s, windowOf(c, s).opensOn ? windowOf(c, s) : null])) as Record<Stage, { opensOn: string | null; closesOn: string | null } | null>;

export async function updateCycle(
  tx: Queryable,
  grant: AccessGrant,
  id: string,
  input: { name: string; approvalLevels: 1 | 2; windows: WindowsInput; expectedVersion: number },
): Promise<void> {
  requireUnrestricted(grant);
  const c = await loadCycle(tx, grant.companyId, id, 'for update');
  if (!c) throw notFound();
  if (c.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The cycle changed; reload and retry');
  if (c.state !== 'OPEN') throw new HttpError(409, 'CYCLE_CLOSED', 'A closed cycle cannot change');
  const name = input.name.trim();
  if (!name) throw new HttpError(422, 'FIELD_REQUIRED', 'name is required', { field: 'name' });
  const w = checkWindows(input.windows);
  if (input.approvalLevels !== c.approval_levels) {
    const submitted = await tx.query(
      `select 1 from appraisal_revision r join appraisal a on a.company_id = r.company_id and a.id = r.appraisal_id
        where a.company_id = $1 and a.cycle_id = $2 and r.submitted_at is not null limit 1`,
      [grant.companyId, id],
    );
    if (submitted.rowCount) throw new HttpError(409, 'LEVELS_FIXED', 'Reviewer levels cannot change once an appraisal of the cycle has been submitted');
  }
  await tx.query(
    `update appraisal_cycle set name = $3, approval_levels = $4, goal_opens_on = $5, goal_closes_on = $6, self_opens_on = $7, self_closes_on = $8,
            rating_opens_on = $9, rating_closes_on = $10, updated_by = $11
      where company_id = $1 and id = $2`,
    [
      grant.companyId,
      id,
      name,
      input.approvalLevels,
      w.GOAL_SETTING?.opensOn ?? null,
      w.GOAL_SETTING?.closesOn ?? null,
      w.SELF_ENTRY?.opensOn ?? null,
      w.SELF_ENTRY?.closesOn ?? null,
      w.MANAGER_RATING?.opensOn ?? null,
      w.MANAGER_RATING?.closesOn ?? null,
      grant.userId,
    ],
  );
  await audit(tx, grant, 'appraisal_cycle', id, 'UPDATE', { name: c.name, approvalLevels: c.approval_levels, windows: windowsOf(c) }, { name, approvalLevels: input.approvalLevels, windows: w });
}

export async function closeCycle(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }): Promise<void> {
  requireUnrestricted(grant);
  // The row lock serialises closing with appraisal creation (which takes it in share mode).
  const c = await loadCycle(tx, grant.companyId, id, 'for update');
  if (!c) throw notFound();
  if (c.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The cycle changed; reload and retry');
  if (c.state !== 'OPEN') throw new HttpError(409, 'CYCLE_CLOSED', 'The cycle is already closed');
  const open = (await tx.query<{ n: number }>(`select count(*)::int as n from appraisal where company_id = $1 and cycle_id = $2 and state not in ('APPROVED', 'CANCELLED')`, [grant.companyId, id]))
    .rows[0]!.n;
  if (open > 0) throw new HttpError(409, 'OPEN_APPRAISALS', 'Complete or cancel every appraisal of the cycle before closing it', { open });
  await tx.query(`update appraisal_cycle set state = 'CLOSED', closed_by = $3, closed_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
  await audit(tx, grant, 'appraisal_cycle', id, 'CLOSE', { state: 'OPEN' }, { state: 'CLOSED' });
}

/** The cycle as shown (operational): period, levels, windows with today's status. */
export function presentCycle(c: CycleRow, today: string) {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    startDate: c.start_date,
    endDate: c.end_date,
    approvalLevels: c.approval_levels,
    state: c.state,
    windows: Object.fromEntries(
      STAGES.map((s) => {
        const st = windowStatus(c, s, today, {});
        return [WINDOW_KEYS[s], st.opensOn ? { opensOn: st.opensOn, closesOn: st.closesOn, openToday: st.openToday } : null];
      }),
    ),
    version: c.version,
  };
}

export async function getCycle(db: Queryable, grant: AccessGrant, id: string) {
  const c = await loadCycle(db, grant.companyId, id);
  if (!c) throw notFound();
  return presentCycle(c, grant.businessDate);
}

export async function listCycles(db: Queryable, grant: AccessGrant, q: { state?: 'OPEN' | 'CLOSED' | undefined }) {
  const rows = (
    await db.query<CycleRow>(`select ${CYCLE_COLUMNS} from appraisal_cycle c where c.company_id = $1 and ($2::text is null or c.state = $2) order by c.start_date desc, c.code limit 200`, [
      grant.companyId,
      q.state ?? null,
    ])
  ).rows;
  return { items: rows.map((c) => presentCycle(c, grant.businessDate)) };
}

export { WINDOW_KEYS };
