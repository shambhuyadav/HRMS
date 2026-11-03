// Shifts, breaks and holiday calendars (FR-005, BR-008, DF05). Shift definitions are company-wide reference
// data maintained under unrestricted company scope; holidays and weekly-off patterns apply per location calendar.
//
// Nothing is overwritten (DF08). A change of shift times is a dated revision; a holiday correction closes the entry and
// appends its successor, a withdrawal closes it; a weekly-off pattern is a dated entry, and a mistaken one is corrected by
// a later entry on the same date. Every such change answers with the evaluated days it touches: those days keep their
// results until HR processes the dates again, and a day a processed payroll used never changes (I-04, I-54).
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess, requireAccess } from '../../http/guard.js';
import type { AccessGrant } from '../access/authorize.js';
import { DEFAULT_OFF_DAYS, evaluatedDays, evaluatedDaysSummary, lockCalendar, mergeEvaluatedDays, type ReprocessList } from './calendar.js';

const time = { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' } as const;
const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date' } as const;
const reason = { type: 'string', minLength: 1, maxLength: 500 } as const;
const expectedVersion = { type: 'integer', minimum: 1 } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const holidayTypeCode = { type: 'string', pattern: '^[A-Z0-9][A-Z0-9_]{0,59}$' } as const;

const breaksField = {
  type: 'array',
  maxItems: 10,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['startOffsetMinutes', 'endOffsetMinutes'],
    properties: { startOffsetMinutes: { type: 'integer', minimum: 0 }, endOffsetMinutes: { type: 'integer', minimum: 1 } },
  },
} as const;

const shiftBody = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'name', 'inTime', 'outTime', 'breaks'],
  properties: {
    code: { type: 'string', pattern: '^\\s*[A-Za-z0-9][A-Za-z0-9_-]{0,39}\\s*$' },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    inTime: time,
    outTime: time,
    breaks: breaksField,
  },
} as const;

const shiftPatch = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion'],
  minProperties: 2,
  properties: { expectedVersion, name: { type: 'string', minLength: 1, maxLength: 200 }, active: { type: 'boolean' } },
} as const;

const shiftRevisionBody = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion', 'effectiveFrom', 'inTime', 'outTime', 'breaks', 'reason'],
  properties: { expectedVersion, effectiveFrom: date, inTime: time, outTime: time, breaks: breaksField, reason },
} as const;

const holidayBody = {
  type: 'object',
  additionalProperties: false,
  required: ['locationId', 'holidayDate', 'name'],
  properties: {
    locationId: uuid,
    holidayDate: date,
    name: { type: 'string', minLength: 1, maxLength: 200 },
    holidayType: { ...holidayTypeCode, default: 'HOLIDAY' },
  },
} as const;

const holidayCorrection = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion', 'reason'],
  minProperties: 3,
  properties: {
    expectedVersion,
    reason,
    locationId: uuid,
    holidayDate: date,
    name: { type: 'string', minLength: 1, maxLength: 200 },
    holidayType: holidayTypeCode,
  },
} as const;

const holidayWithdrawal = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion', 'reason'],
  properties: { expectedVersion, reason },
} as const;

const holidayQuery = {
  type: 'object',
  additionalProperties: false,
  required: ['locationId', 'year'],
  properties: {
    locationId: uuid,
    year: { type: 'integer', minimum: 2000, maximum: 2100 },
    // DF08: a closed entry stays readable, and a list never implies deletion. The default is the calendar in force.
    state: { type: 'string', enum: ['ACTIVE', 'SUPERSEDED', 'WITHDRAWN', 'ALL'], default: 'ACTIVE' },
  },
} as const;

const weeklyOffBody = {
  type: 'object',
  additionalProperties: false,
  required: ['locationId', 'effectiveFrom', 'offDays', 'reason', 'expectedRevision'],
  properties: {
    locationId: uuid,
    effectiveFrom: date,
    // Whole ISO weekdays only: a half weekly-off has no agreed meaning yet (I-48 item 6).
    offDays: { type: 'array', uniqueItems: true, maxItems: 7, items: { type: 'integer', minimum: 1, maximum: 7 } },
    reason,
    // The location's latest entry the person saw (0: none), so an entry nobody has read is not silently overtaken.
    expectedRevision: { type: 'integer', minimum: 0 },
  },
} as const;

interface BreakInput {
  startOffsetMinutes: number;
  endOffsetMinutes: number;
}

interface ShiftInput {
  code: string;
  name: string;
  inTime: string;
  outTime: string;
  breaks: BreakInput[];
}

function assertCompanyWide(grant: AccessGrant): void {
  const { departments, locations, employees } = grant.filters;
  if (grant.scopeKind !== 'COMPANY' || departments.length + locations.length + employees.length > 0) {
    throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  }
}

/** A location calendar is written under company scope, narrowed at most to the locations of the grant. */
function assertLocationWritable(grant: AccessGrant, locationId: string): void {
  const { locations, departments, employees } = grant.filters;
  if (grant.scopeKind !== 'COMPANY' || departments.length + employees.length > 0 || (locations.length > 0 && !locations.includes(locationId))) {
    throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  }
}

const netOf = (minutes: number, breaks: BreakInput[]) => minutes - breaks.reduce((sum, b) => sum + (b.endOffsetMinutes - b.startOffsetMinutes), 0);

async function breaksOf(db: Queryable, companyId: string, shiftId: string, revisionId: string | null): Promise<BreakInput[]> {
  return (
    await db.query<BreakInput>(`select start_offset_minutes as "startOffsetMinutes", end_offset_minutes as "endOffsetMinutes" from hrms_shift_breaks($1, $2, $3)`, [companyId, shiftId, revisionId])
  ).rows;
}

/**
 * A shift with the times in force today (the fields it always had) and every revision: the shift row is revision 1, in
 * force from the start. A later-dated revision is listed but not yet in force.
 */
async function loadShift(db: Queryable, companyId: string, id: string) {
  const shift = (
    await db.query<{
      id: string;
      code: string;
      name: string;
      inTime: string;
      outTime: string;
      spansMidnight: boolean;
      scheduledMinutes: number;
      active: boolean;
      version: number;
      revisionId: string | null;
      revision: number;
      effectiveFrom: string | null;
    }>(
      `select s.id, s.code, s.name, to_char(f.in_time, 'HH24:MI') as "inTime", to_char(f.out_time, 'HH24:MI') as "outTime",
              f.spans_midnight as "spansMidnight", f.minutes as "scheduledMinutes", s.active, s.version,
              f.revision_id as "revisionId", f.revision, to_char(f.effective_from, 'YYYY-MM-DD') as "effectiveFrom"
         from shift s cross join lateral hrms_shift_in_force(s.company_id, s.id, hrms_business_date(s.company_id, now())) f
        where s.company_id = $1 and s.id = $2`,
      [companyId, id],
    )
  ).rows[0];
  if (!shift) return null;
  const { revisionId, ...inForce } = shift;
  const breaks = await breaksOf(db, companyId, id, revisionId);
  const dated = (
    await db.query<{ id: string; revision: number; effectiveFrom: string; inTime: string; outTime: string; spansMidnight: boolean; scheduledMinutes: number; reason: string; createdAt: string; createdBy: string | null }>(
      `select id, revision, to_char(effective_from, 'YYYY-MM-DD') as "effectiveFrom", to_char(in_time, 'HH24:MI') as "inTime", to_char(out_time, 'HH24:MI') as "outTime",
              spans_midnight as "spansMidnight", hrms_shift_minutes(in_time, out_time, spans_midnight) as "scheduledMinutes", reason, created_at as "createdAt", created_by as "createdBy"
         from shift_revision where company_id = $1 and shift_id = $2 order by revision`,
      [companyId, id],
    )
  ).rows;
  const first = (
    await db.query<{ inTime: string; outTime: string; spansMidnight: boolean; scheduledMinutes: number; createdAt: string; createdBy: string | null }>(
      `select to_char(in_time, 'HH24:MI') as "inTime", to_char(out_time, 'HH24:MI') as "outTime", spans_midnight as "spansMidnight",
              hrms_shift_minutes(in_time, out_time, spans_midnight) as "scheduledMinutes", created_at as "createdAt", created_by as "createdBy"
         from shift where company_id = $1 and id = $2`,
      [companyId, id],
    )
  ).rows[0]!;
  const firstBreaks = await breaksOf(db, companyId, id, null);
  const revisions = [
    { revision: 1, effectiveFrom: null as string | null, ...first, breaks: firstBreaks, netScheduledMinutes: netOf(first.scheduledMinutes, firstBreaks), reason: null as string | null },
    ...(await Promise.all(
      dated.map(async ({ id: rid, ...r }) => {
        const own = await breaksOf(db, companyId, id, rid);
        return { ...r, breaks: own, netScheduledMinutes: netOf(r.scheduledMinutes, own) };
      }),
    )),
  ];
  // Net scheduled minutes = elapsed minus scheduled unpaid breaks (DF05 default: 60-minute unpaid break).
  return { ...inForce, breaks, netScheduledMinutes: netOf(shift.scheduledMinutes, breaks), revisions };
}

interface HolidayRow {
  id: string;
  location_id: string;
  holiday_date: string;
  holiday_type_id: string;
  type_code: string;
  name: string;
  state: string;
  version: number;
}

/** Locks a holiday and checks it can still change, after the calendar lock and with the authority re-checked. */
async function lockOpenHoliday(tx: Queryable, grant: AccessGrant, id: string, seenVersion: number): Promise<HolidayRow> {
  await lockCalendar(tx, grant.companyId);
  const current = (
    await tx.query<HolidayRow>(
      `select h.id, h.location_id, to_char(h.holiday_date, 'YYYY-MM-DD') as holiday_date, h.holiday_type_id, t.code as type_code, h.name, h.state, h.version
         from holiday h join reference_value t on t.company_id = h.company_id and t.id = h.holiday_type_id
        where h.company_id = $1 and h.id = $2 for update of h`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!current) throw notFound();
  await reassertAccess(tx, grant, 'holiday', 'manage', ['operational']);
  assertLocationWritable(grant, current.location_id);
  if (current.state !== 'ACTIVE') throw new HttpError(409, 'HOLIDAY_CLOSED', 'This entry was already corrected or withdrawn; only the entry in force can change');
  if (current.version !== seenVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  return current;
}

async function closeHoliday(tx: Queryable, grant: AccessGrant, id: string, state: 'SUPERSEDED' | 'WITHDRAWN', why: string): Promise<void> {
  await tx.query(`update holiday set state = $3, closed_at = clock_timestamp(), closed_by = $4, closed_reason = $5, updated_by = $4 where company_id = $1 and id = $2`, [
    grant.companyId,
    id,
    state,
    grant.userId,
    why,
  ]);
}

/** A holiday type in force on the holiday's own date (DF04, 0105). */
async function holidayTypeOn(tx: Queryable, companyId: string, code: string, day: string): Promise<string> {
  const type = (
    await tx.query<{ id: string }>(
      `select id from reference_value where company_id = $1 and category = 'HOLIDAY_TYPE' and code = $2 and active
          and (valid_from is null or valid_from <= $3::date) and (valid_to is null or valid_to > $3::date)`,
      [companyId, code, day],
    )
  ).rows[0];
  if (!type) throw new HttpError(422, 'INVALID_REFERENCE', 'Unknown holiday type');
  return type.id;
}

/** Evaluated days of one holiday date: those of employees at that location on that date. */
const holidayDays = (tx: Queryable, companyId: string, locationId: string, day: string) => evaluatedDays(tx, companyId, { locationId, from: day, to: day });

export async function shiftRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  app.get('/shifts', async (request) => {
    const grant = await requireAccess(db, request, 'shift', 'read', ['operational']);
    const ids = await db.query<{ id: string }>(`select id from shift where company_id = $1 order by code`, [grant.companyId]);
    return { items: await Promise.all(ids.rows.map((r) => loadShift(db, grant.companyId, r.id))) };
  });

  app.post('/shifts', { schema: { body: shiftBody } }, async (request, reply) => {
    const input = request.body as ShiftInput;
    const grant = await requireAccess(db, request, 'shift', 'create', ['operational'], { requireAll: true });
    assertCompanyWide(grant);
    const id = await withTransaction(db, async (tx) => {
      await reassertAccess(tx, grant, 'shift', 'create', ['operational']);
      const spans = input.outTime < input.inTime; // equal times are rejected by the database
      const created = (
        await tx.query<{ id: string }>(
          `insert into shift (company_id, code, name, in_time, out_time, spans_midnight, active, created_by, updated_by)
           values ($1, $2, $3, $4, $5, $6, true, $7, $7) returning id`,
          [grant.companyId, input.code.trim().toUpperCase(), input.name.trim(), input.inTime, input.outTime, spans, grant.userId],
        )
      ).rows[0]!.id;
      let sequence = 0;
      for (const b of input.breaks) {
        await tx.query(
          `insert into shift_break (company_id, shift_id, sequence, start_offset_minutes, end_offset_minutes, created_by, updated_by)
           values ($1, $2, $3, $4, $5, $6, $6)`,
          [grant.companyId, created, ++sequence, b.startOffsetMinutes, b.endOffsetMinutes, grant.userId],
        );
      }
      await writeAudit(tx, {
        companyId: grant.companyId,
        resource: 'shift',
        recordKey: created,
        actorUserId: grant.userId,
        actingAssignmentId: grant.assignmentId,
        action: 'CREATE',
        newVersion: 1,
        after: { operational: { ...input, spansMidnight: spans } },
      });
      return created;
    });
    reply.status(201);
    return loadShift(db, grant.companyId, id);
  });

  app.patch('/shifts/:id', { schema: { params: idParams, body: shiftPatch } }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { expectedVersion: number; name?: string; active?: boolean };
    const grant = await requireAccess(db, request, 'shift', 'update', ['operational'], { requireAll: true, recordKey: id });
    assertCompanyWide(grant);
    await withTransaction(db, async (tx) => {
      const current = (
        await tx.query<{ name: string; active: boolean; version: number }>(
          `select name, active, version from shift where company_id = $1 and id = $2 for update`,
          [grant.companyId, id],
        )
      ).rows[0];
      if (!current) throw notFound();
      await reassertAccess(tx, grant, 'shift', 'update', ['operational']);
      if (current.version !== body.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
      const next = { name: body.name?.trim() ?? current.name, active: body.active ?? current.active };
      await tx.query(`update shift set name = $3, active = $4, updated_by = $5 where company_id = $1 and id = $2`, [
        grant.companyId,
        id,
        next.name,
        next.active,
        grant.userId,
      ]);
      await writeAudit(tx, {
        companyId: grant.companyId,
        resource: 'shift',
        recordKey: id,
        actorUserId: grant.userId,
        actingAssignmentId: grant.assignmentId,
        action: 'UPDATE',
        priorVersion: current.version,
        before: { operational: { name: current.name, active: current.active } },
        after: { operational: next },
      });
    });
    return loadShift(db, grant.companyId, id);
  });

  // DF05: in, out and break times change from a date. Days already evaluated keep the revision they were evaluated on
  // (attendance_record.shift_revision_id) until HR reprocesses them; the answer lists them.
  app.post('/shifts/:id/revisions', { schema: { params: idParams, body: shiftRevisionBody } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = request.body as { expectedVersion: number; effectiveFrom: string; inTime: string; outTime: string; breaks: BreakInput[]; reason: string };
    const grant = await requireAccess(db, request, 'shift', 'update', ['operational'], { requireAll: true, recordKey: id });
    assertCompanyWide(grant);
    const reprocess = await withTransaction(db, async (tx) => {
      const current = (await tx.query<{ version: number }>(`select version from shift where company_id = $1 and id = $2 for update`, [grant.companyId, id])).rows[0];
      if (!current) throw notFound();
      await reassertAccess(tx, grant, 'shift', 'update', ['operational']);
      if (current.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
      const spans = input.outTime < input.inTime; // equal times are rejected by the database
      const created = (
        await tx.query<{ id: string; revision: number }>(
          `insert into shift_revision (company_id, shift_id, revision, effective_from, in_time, out_time, spans_midnight, reason, created_by)
           select $1, $2, coalesce(max(r.revision), 1) + 1, $3::date, $4::time, $5::time, $6::boolean, $7::text, $8::uuid from shift_revision r where r.company_id = $1 and r.shift_id = $2
           returning id, revision`,
          [grant.companyId, id, input.effectiveFrom, input.inTime, input.outTime, spans, input.reason.trim(), grant.userId],
        )
      ).rows[0]!;
      let sequence = 0;
      for (const b of input.breaks) {
        await tx.query(
          `insert into shift_revision_break (company_id, shift_revision_id, sequence, start_offset_minutes, end_offset_minutes, created_by) values ($1, $2, $3, $4, $5, $6)`,
          [grant.companyId, created.id, ++sequence, b.startOffsetMinutes, b.endOffsetMinutes, grant.userId],
        );
      }
      await tx.query(`update shift set updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
      // The revision is in force until the next later one starts.
      const until = (
        await tx.query<{ last_day: string | null }>(
          `select to_char(min(effective_from) - 1, 'YYYY-MM-DD') as last_day from shift_revision where company_id = $1 and shift_id = $2 and effective_from > $3::date`,
          [grant.companyId, id, input.effectiveFrom],
        )
      ).rows[0]!.last_day;
      const days = await evaluatedDays(tx, grant.companyId, { shiftId: id, from: input.effectiveFrom, to: until });
      await writeAudit(tx, {
        companyId: grant.companyId,
        resource: 'shift',
        recordKey: id,
        actorUserId: grant.userId,
        actingAssignmentId: grant.assignmentId,
        action: 'REVISE',
        priorVersion: current.version,
        after: {
          operational: {
            revision: created.revision,
            effectiveFrom: input.effectiveFrom,
            inTime: input.inTime,
            outTime: input.outTime,
            spansMidnight: spans,
            breaks: input.breaks,
            evaluatedDays: evaluatedDaysSummary(days),
          },
        },
        reason: input.reason.trim(),
      });
      return days;
    });
    reply.status(201);
    return { ...(await loadShift(db, grant.companyId, id)), reprocess };
  });

  // The choices of the holiday form: every location calendar and the holiday types in force today.
  app.get('/holidays/options', async (request) => {
    const grant = await requireAccess(db, request, 'holiday', 'read', ['operational']);
    const locations = await db.query(`select id, code, name, active from location where company_id = $1 order by code`, [grant.companyId]);
    const types = await db.query(`select code, label from reference_value_in_force where company_id = $1 and category = 'HOLIDAY_TYPE' order by label, code`, [grant.companyId]);
    return { locations: locations.rows, types: types.rows };
  });

  app.get('/holidays', { schema: { querystring: holidayQuery } }, async (request) => {
    const { locationId, year, state } = request.query as { locationId: string; year: number; state: string };
    const grant = await requireAccess(db, request, 'holiday', 'read', ['operational']);
    const rows = await db.query(
      `select h.id, h.location_id as "locationId", h.holiday_date as "holidayDate", h.name, t.code as "holidayType", h.state, h.version,
              h.supersedes_id as "supersedesId", (select n.id from holiday n where n.company_id = h.company_id and n.supersedes_id = h.id) as "supersededById",
              h.closed_at as "closedAt", h.closed_by as "closedBy", h.closed_reason as "closedReason"
         from holiday h join reference_value t on t.company_id = h.company_id and t.id = h.holiday_type_id
        where h.company_id = $1 and h.location_id = $2 and extract(year from h.holiday_date) = $3 and ($4 = 'ALL' or h.state = $4)
        order by h.holiday_date, h.created_at`,
      [grant.companyId, locationId, year, state],
    );
    return { items: rows.rows };
  });

  app.post('/holidays', { schema: { body: holidayBody } }, async (request, reply) => {
    const input = request.body as { locationId: string; holidayDate: string; name: string; holidayType: string };
    const grant = await requireAccess(db, request, 'holiday', 'manage', ['operational'], { requireAll: true });
    assertLocationWritable(grant, input.locationId);
    const { id, reprocess } = await withTransaction(db, async (tx) => {
      await lockCalendar(tx, grant.companyId);
      await reassertAccess(tx, grant, 'holiday', 'manage', ['operational']);
      const typeId = await holidayTypeOn(tx, grant.companyId, input.holidayType, input.holidayDate);
      const created = (
        await tx.query<{ id: string }>(
          `insert into holiday (company_id, location_id, holiday_date, holiday_type_id, name, created_at, created_by, updated_by)
           values ($1, $2, $3, $4, $5, clock_timestamp(), $6, $6) returning id`,
          [grant.companyId, input.locationId, input.holidayDate, typeId, input.name.trim(), grant.userId],
        )
      ).rows[0]!.id;
      const days = await holidayDays(tx, grant.companyId, input.locationId, input.holidayDate);
      await writeAudit(tx, {
        companyId: grant.companyId,
        resource: 'holiday',
        recordKey: created,
        actorUserId: grant.userId,
        actingAssignmentId: grant.assignmentId,
        action: 'CREATE',
        newVersion: 1,
        after: { operational: { ...input, evaluatedDays: evaluatedDaysSummary(days) } },
      });
      return { id: created, reprocess: days };
    });
    reply.status(201);
    return { id, ...input, reprocess };
  });

  // DF08: the wrong entry stays, closed and attributed; the corrected one names it. Both dates' evaluated days are listed
  // when the correction moves the holiday; a change of name or type moves no day.
  app.post('/holidays/:id/correct', { schema: { params: idParams, body: holidayCorrection } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = request.body as { expectedVersion: number; reason: string; locationId?: string; holidayDate?: string; name?: string; holidayType?: string };
    const grant = await requireAccess(db, request, 'holiday', 'manage', ['operational'], { requireAll: true, recordKey: id });
    const result = await withTransaction(db, async (tx) => {
      const current = await lockOpenHoliday(tx, grant, id, input.expectedVersion);
      const next = {
        locationId: input.locationId ?? current.location_id,
        holidayDate: input.holidayDate ?? current.holiday_date,
        name: input.name?.trim() ?? current.name,
        holidayType: input.holidayType ?? current.type_code,
      };
      assertLocationWritable(grant, next.locationId);
      const moved = next.locationId !== current.location_id || next.holidayDate !== current.holiday_date;
      if (!moved && next.name === current.name && next.holidayType === current.type_code) throw new HttpError(422, 'NO_CHANGE', 'The correction changes nothing');
      // An unmoved entry of the same type keeps its type even if that type has since been retired.
      const typeId = !moved && next.holidayType === current.type_code ? current.holiday_type_id : await holidayTypeOn(tx, grant.companyId, next.holidayType, next.holidayDate);
      await closeHoliday(tx, grant, id, 'SUPERSEDED', input.reason.trim());
      const created = (
        await tx.query<{ id: string; version: number }>(
          `insert into holiday (company_id, location_id, holiday_date, holiday_type_id, name, supersedes_id, created_at, created_by, updated_by)
           values ($1, $2, $3, $4, $5, $6, clock_timestamp(), $7, $7) returning id, version`,
          [grant.companyId, next.locationId, next.holidayDate, typeId, next.name, id, grant.userId],
        )
      ).rows[0]!;
      const none: ReprocessList = { days: [], truncated: false };
      const days = moved
        ? mergeEvaluatedDays(await holidayDays(tx, grant.companyId, current.location_id, current.holiday_date), await holidayDays(tx, grant.companyId, next.locationId, next.holidayDate))
        : none;
      await writeAudit(tx, {
        companyId: grant.companyId,
        resource: 'holiday',
        recordKey: id,
        actorUserId: grant.userId,
        actingAssignmentId: grant.assignmentId,
        action: 'CORRECT',
        priorVersion: current.version,
        before: { operational: { locationId: current.location_id, holidayDate: current.holiday_date, name: current.name, holidayType: current.type_code } },
        after: { operational: { ...next, supersededBy: created.id, evaluatedDays: evaluatedDaysSummary(days) } },
        reason: input.reason.trim(),
      });
      return { id: created.id, version: created.version, supersedesId: id, ...next, reprocess: days };
    });
    reply.status(201);
    return result;
  });

  app.post('/holidays/:id/withdraw', { schema: { params: idParams, body: holidayWithdrawal } }, async (request) => {
    const { id } = request.params as { id: string };
    const input = request.body as { expectedVersion: number; reason: string };
    const grant = await requireAccess(db, request, 'holiday', 'manage', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, async (tx) => {
      const current = await lockOpenHoliday(tx, grant, id, input.expectedVersion);
      await closeHoliday(tx, grant, id, 'WITHDRAWN', input.reason.trim());
      const days = await holidayDays(tx, grant.companyId, current.location_id, current.holiday_date);
      await writeAudit(tx, {
        companyId: grant.companyId,
        resource: 'holiday',
        recordKey: id,
        actorUserId: grant.userId,
        actingAssignmentId: grant.assignmentId,
        action: 'WITHDRAW',
        priorVersion: current.version,
        before: { operational: { state: 'ACTIVE', locationId: current.location_id, holidayDate: current.holiday_date, name: current.name } },
        after: { operational: { state: 'WITHDRAWN', evaluatedDays: evaluatedDaysSummary(days) } },
        reason: input.reason.trim(),
      });
      return { id, state: 'WITHDRAWN', reprocess: days };
    });
  });

  // FR-005: the location calendars with their dated whole-day patterns; a location with no pattern in force today shows the
  // DF05 default.
  app.get('/weekly-off-patterns', async (request) => {
    const grant = await requireAccess(db, request, 'shift', 'read', ['operational']);
    const today = (await db.query<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [grant.companyId])).rows[0]!.d;
    const locations = (await db.query<{ id: string; code: string; name: string; active: boolean }>(`select id, code, name, active from location where company_id = $1 order by code`, [grant.companyId])).rows;
    const entries = (
      await db.query<{ id: string; locationId: string; revision: number; effectiveFrom: string; offDays: number[]; reason: string; createdAt: string; createdBy: string | null }>(
        `select id, location_id as "locationId", revision, to_char(effective_from, 'YYYY-MM-DD') as "effectiveFrom", off_days as "offDays", reason, created_at as "createdAt", created_by as "createdBy"
           from weekly_off_pattern where company_id = $1 order by revision`,
        [grant.companyId],
      )
    ).rows;
    return {
      defaultOffDays: DEFAULT_OFF_DAYS,
      items: locations.map((l) => {
        const own = entries.filter((e) => e.locationId === l.id).map(({ locationId: _, ...e }) => e);
        const inForce = own.filter((e) => e.effectiveFrom <= today).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.revision - a.revision)[0];
        return {
          locationId: l.id,
          locationCode: l.code,
          locationName: l.name,
          active: l.active,
          inForce: inForce
            ? { offDays: inForce.offDays, isDefault: false, revision: inForce.revision, effectiveFrom: inForce.effectiveFrom }
            : { offDays: DEFAULT_OFF_DAYS, isDefault: true, revision: null, effectiveFrom: null },
          latestRevision: own.at(-1)?.revision ?? 0,
          entries: own,
        };
      }),
    };
  });

  app.post('/weekly-off-patterns', { schema: { body: weeklyOffBody } }, async (request, reply) => {
    const input = request.body as { locationId: string; effectiveFrom: string; offDays: number[]; reason: string; expectedRevision: number };
    const grant = await requireAccess(db, request, 'shift', 'update', ['operational'], { requireAll: true });
    assertLocationWritable(grant, input.locationId);
    const offDays = [...input.offDays].sort((a, b) => a - b);
    if (offDays.length === 7) throw new HttpError(422, 'NO_WORKING_DAY', 'A pattern must leave at least one working day in the week');
    const result = await withTransaction(db, async (tx) => {
      await lockCalendar(tx, grant.companyId);
      await reassertAccess(tx, grant, 'shift', 'update', ['operational']);
      const latest = (await tx.query<{ revision: number }>(`select coalesce(max(revision), 0)::int as revision from weekly_off_pattern where company_id = $1 and location_id = $2`, [grant.companyId, input.locationId])).rows[0]!.revision;
      if (latest !== input.expectedRevision) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
      // What this entry replaces on its first day: from then until the next later entry, only the weekdays whose status
      // changes can change a result.
      const before = (
        await tx.query<{ off_days: number[] }>(
          `select off_days from weekly_off_pattern where company_id = $1 and location_id = $2 and effective_from <= $3::date order by effective_from desc, revision desc limit 1`,
          [grant.companyId, input.locationId, input.effectiveFrom],
        )
      ).rows[0]?.off_days ?? [...DEFAULT_OFF_DAYS];
      const created = (
        await tx.query<{ id: string; revision: number }>(
          `insert into weekly_off_pattern (company_id, location_id, revision, effective_from, off_days, reason, created_at, created_by)
           values ($1, $2, $3, $4, $5::smallint[], $6, clock_timestamp(), $7) returning id, revision`,
          [grant.companyId, input.locationId, latest + 1, input.effectiveFrom, offDays, input.reason.trim(), grant.userId],
        )
      ).rows[0]!;
      const until = (
        await tx.query<{ last_day: string | null }>(
          `select to_char(min(effective_from) - 1, 'YYYY-MM-DD') as last_day from weekly_off_pattern where company_id = $1 and location_id = $2 and effective_from > $3::date`,
          [grant.companyId, input.locationId, input.effectiveFrom],
        )
      ).rows[0]!.last_day;
      const weekdays = [1, 2, 3, 4, 5, 6, 7].filter((d) => before.includes(d) !== offDays.includes(d));
      const days = await evaluatedDays(tx, grant.companyId, { locationId: input.locationId, from: input.effectiveFrom, to: until, weekdays });
      await writeAudit(tx, {
        companyId: grant.companyId,
        resource: 'weekly_off_pattern',
        recordKey: created.id,
        actorUserId: grant.userId,
        actingAssignmentId: grant.assignmentId,
        action: 'CREATE',
        newVersion: 1,
        before: { operational: { offDays: before } },
        after: { operational: { locationId: input.locationId, revision: created.revision, effectiveFrom: input.effectiveFrom, offDays, evaluatedDays: evaluatedDaysSummary(days) } },
        reason: input.reason.trim(),
      });
      return { id: created.id, locationId: input.locationId, revision: created.revision, effectiveFrom: input.effectiveFrom, offDays, reprocess: days };
    });
    reply.status(201);
    return result;
  });
}
