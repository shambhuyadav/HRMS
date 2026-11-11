// Company events and ticker messages (CL-021 "Event planner", CL-022 "Ticker message"; migration 0290). HR keeps them; everyone is
// shown what is for them: the ticker messages running today, and the upcoming events for the whole company or for the department
// or location of their own current assignment. Kept, never deleted: switching off ends one. Every change is audited.
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { writeAudit } from '../../audit/audit.js';
import { reassertAccess } from '../../http/guard.js';
import type { AccessGrant } from '../access/authorize.js';

export const AUDIENCES = ['ALL', 'DEPARTMENT', 'LOCATION'] as const;
export type Audience = (typeof AUDIENCES)[number];
/** How far ahead the dashboard looks for events, and how many it shows. */
export const EVENT_HORIZON_DAYS = 60;
export const FEED_EVENTS = 20;
export const FEED_MESSAGES = 10;

export interface CompanyEvent {
  id: string;
  name: string;
  description: string | null;
  eventDate: string;
  audience: Audience;
  departmentId: string | null;
  departmentName: string | null;
  locationId: string | null;
  locationName: string | null;
  active: boolean;
  version: number;
}

export interface TickerMessage {
  id: string;
  message: string;
  startsOn: string;
  endsOn: string;
  active: boolean;
  version: number;
}

export interface EventInput {
  name: string;
  description?: string | null | undefined;
  eventDate: string;
  audience: Audience;
  departmentId?: string | null | undefined;
  locationId?: string | null | undefined;
}

export interface EventChange extends Partial<EventInput> {
  expectedVersion: number;
  active?: boolean | undefined;
}

export interface TickerInput {
  message: string;
  startsOn: string;
  endsOn: string;
}

export interface TickerChange extends Partial<TickerInput> {
  expectedVersion: number;
  active?: boolean | undefined;
}

const EVENT_COLUMNS = `ev.id, ev.name, ev.description, to_char(ev.event_date, 'YYYY-MM-DD') as "eventDate", ev.audience,
  ev.department_id as "departmentId", d.name as "departmentName", ev.location_id as "locationId", l.name as "locationName", ev.active, ev.version`;
const EVENT_FROM = `company_event ev
  left join department d on d.company_id = ev.company_id and d.id = ev.department_id
  left join location l on l.company_id = ev.company_id and l.id = ev.location_id`;
const TICKER_COLUMNS = `t.id, t.message, to_char(t.starts_on, 'YYYY-MM-DD') as "startsOn", to_char(t.ends_on, 'YYYY-MM-DD') as "endsOn", t.active, t.version`;

/** Keeping events and messages needs unrestricted company scope: no department, location or employee filter, nothing denied. */
export function assertCompanyWide(grant: AccessGrant): AccessGrant {
  const { departments, locations, employees } = grant.filters;
  if (grant.scopeKind !== 'COMPANY' || departments.length + locations.length + employees.length > 0 || grant.deniedScopes.length > 0) {
    throw new HttpError(403, 'FORBIDDEN', 'Events and messages reach the whole company: keeping them needs company-wide scope');
  }
  return grant;
}

/** At write time, inside the transaction: the right is still held (a grant ended after the request began stops the write). */
const recheck = (tx: Queryable, grant: AccessGrant) => reassertAccess(tx, grant, 'announcement', 'manage', ['operational']);

const trimmed = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : v.trim() === '' ? null : v.trim());

/** The audience and its one target, checked against this company's masters; the database refuses any other combination. */
async function audienceOf(db: Queryable, companyId: string, e: { audience: Audience; departmentId?: string | null | undefined; locationId?: string | null | undefined }) {
  const departmentId = e.audience === 'DEPARTMENT' ? (e.departmentId ?? null) : null;
  const locationId = e.audience === 'LOCATION' ? (e.locationId ?? null) : null;
  if (e.audience === 'DEPARTMENT' && !departmentId) throw new HttpError(422, 'VALIDATION_FAILED', 'Choose the department the event is for');
  if (e.audience === 'LOCATION' && !locationId) throw new HttpError(422, 'VALIDATION_FAILED', 'Choose the location the event is for');
  if (e.audience === 'ALL' && (e.departmentId || e.locationId)) throw new HttpError(422, 'VALIDATION_FAILED', 'An event for everyone names no department or location');
  if (e.audience === 'DEPARTMENT' && e.locationId) throw new HttpError(422, 'VALIDATION_FAILED', 'An event for a department names no location');
  if (e.audience === 'LOCATION' && e.departmentId) throw new HttpError(422, 'VALIDATION_FAILED', 'An event for a location names no department');
  if (departmentId && (await db.query(`select 1 from department where company_id = $1 and id = $2`, [companyId, departmentId])).rowCount === 0) {
    throw new HttpError(422, 'INVALID_REFERENCE', 'Department not found');
  }
  if (locationId && (await db.query(`select 1 from location where company_id = $1 and id = $2`, [companyId, locationId])).rowCount === 0) {
    throw new HttpError(422, 'INVALID_REFERENCE', 'Location not found');
  }
  return { departmentId, locationId };
}

function checkEvent(e: { name: string; description: string | null }) {
  if (!e.name.trim() || e.name.trim().length > 120) throw new HttpError(422, 'VALIDATION_FAILED', 'The event name is required, up to 120 characters');
  if (e.description !== null && e.description.length > 1000) throw new HttpError(422, 'VALIDATION_FAILED', 'The description is up to 1000 characters');
}

function checkTicker(t: TickerInput) {
  if (!t.message.trim() || t.message.trim().length > 280) throw new HttpError(422, 'VALIDATION_FAILED', 'The message is required, up to 280 characters');
  if (t.endsOn < t.startsOn) throw new HttpError(422, 'INVALID_PERIOD', 'The last day is before the first day');
}

const eventAudit = (e: Omit<CompanyEvent, 'id' | 'version' | 'departmentName' | 'locationName'>) => ({
  operational: { name: e.name, description: e.description, eventDate: e.eventDate, audience: e.audience, departmentId: e.departmentId, locationId: e.locationId, active: e.active },
});

export async function listEvents(db: Queryable, grant: AccessGrant, includeInactive: boolean): Promise<CompanyEvent[]> {
  return (
    await db.query<CompanyEvent>(
      `select ${EVENT_COLUMNS} from ${EVENT_FROM} where ev.company_id = $1 and ($2 or ev.active) order by ev.event_date desc, ev.name limit 500`,
      [grant.companyId, includeInactive],
    )
  ).rows;
}

async function eventById(db: Queryable, companyId: string, id: string, lock = false): Promise<CompanyEvent> {
  const row = (await db.query<CompanyEvent>(`select ${EVENT_COLUMNS} from ${EVENT_FROM} where ev.company_id = $1 and ev.id = $2${lock ? ' for update of ev' : ''}`, [companyId, id])).rows[0];
  if (!row) throw notFound();
  return row;
}

export async function createEvent(tx: Queryable, grant: AccessGrant, input: EventInput): Promise<CompanyEvent> {
  await recheck(tx, grant);
  const description = trimmed(input.description) ?? null;
  checkEvent({ name: input.name, description });
  const { departmentId, locationId } = await audienceOf(tx, grant.companyId, input);
  const id = (
    await tx.query<{ id: string }>(
      `insert into company_event (company_id, name, description, event_date, audience, department_id, location_id, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $8) returning id`,
      [grant.companyId, input.name.trim(), description, input.eventDate, input.audience, departmentId, locationId, grant.userId],
    )
  ).rows[0]!.id;
  const created = await eventById(tx, grant.companyId, id);
  await writeAudit(tx, { companyId: grant.companyId, resource: 'company_event', recordKey: id, actorUserId: grant.userId, actingAssignmentId: grant.assignmentId, action: 'CREATE', newVersion: 1, after: eventAudit(created) });
  return created;
}

export async function updateEvent(tx: Queryable, grant: AccessGrant, id: string, change: EventChange): Promise<CompanyEvent> {
  await recheck(tx, grant);
  const current = await eventById(tx, grant.companyId, id, true);
  if (current.version !== change.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  const audience = change.audience ?? current.audience;
  const next = {
    name: change.name !== undefined ? change.name.trim() : current.name,
    description: change.description !== undefined ? (trimmed(change.description) ?? null) : current.description,
    eventDate: change.eventDate ?? current.eventDate,
    audience,
    active: change.active ?? current.active,
  };
  checkEvent(next);
  // A changed audience takes its own target; an unchanged one keeps the current target unless a new one is given.
  const target = await audienceOf(tx, grant.companyId, {
    audience,
    departmentId: change.departmentId !== undefined ? change.departmentId : change.audience === undefined ? current.departmentId : null,
    locationId: change.locationId !== undefined ? change.locationId : change.audience === undefined ? current.locationId : null,
  });
  await tx.query(
    `update company_event set name = $3, description = $4, event_date = $5, audience = $6, department_id = $7, location_id = $8, active = $9,
            updated_at = now(), updated_by = $10, version = version + 1
      where company_id = $1 and id = $2`,
    [grant.companyId, id, next.name, next.description, next.eventDate, audience, target.departmentId, target.locationId, next.active, grant.userId],
  );
  const updated = await eventById(tx, grant.companyId, id);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'company_event',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'UPDATE',
    priorVersion: current.version,
    newVersion: updated.version,
    before: eventAudit(current),
    after: eventAudit(updated),
  });
  return updated;
}

export async function listTicker(db: Queryable, grant: AccessGrant, includeInactive: boolean): Promise<TickerMessage[]> {
  return (
    await db.query<TickerMessage>(`select ${TICKER_COLUMNS} from ticker_message t where t.company_id = $1 and ($2 or t.active) order by t.starts_on desc, t.created_at desc limit 500`, [
      grant.companyId,
      includeInactive,
    ])
  ).rows;
}

async function tickerById(db: Queryable, companyId: string, id: string, lock = false): Promise<TickerMessage> {
  const row = (await db.query<TickerMessage>(`select ${TICKER_COLUMNS} from ticker_message t where t.company_id = $1 and t.id = $2${lock ? ' for update' : ''}`, [companyId, id])).rows[0];
  if (!row) throw notFound();
  return row;
}

const tickerAudit = (t: Omit<TickerMessage, 'id' | 'version'>) => ({ operational: { message: t.message, startsOn: t.startsOn, endsOn: t.endsOn, active: t.active } });

export async function createTicker(tx: Queryable, grant: AccessGrant, input: TickerInput): Promise<TickerMessage> {
  await recheck(tx, grant);
  checkTicker(input);
  const id = (
    await tx.query<{ id: string }>(
      `insert into ticker_message (company_id, message, starts_on, ends_on, created_by, updated_by) values ($1, $2, $3, $4, $5, $5) returning id`,
      [grant.companyId, input.message.trim(), input.startsOn, input.endsOn, grant.userId],
    )
  ).rows[0]!.id;
  const created = await tickerById(tx, grant.companyId, id);
  await writeAudit(tx, { companyId: grant.companyId, resource: 'ticker_message', recordKey: id, actorUserId: grant.userId, actingAssignmentId: grant.assignmentId, action: 'CREATE', newVersion: 1, after: tickerAudit(created) });
  return created;
}

export async function updateTicker(tx: Queryable, grant: AccessGrant, id: string, change: TickerChange): Promise<TickerMessage> {
  await recheck(tx, grant);
  const current = await tickerById(tx, grant.companyId, id, true);
  if (current.version !== change.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  const next = {
    message: change.message !== undefined ? change.message.trim() : current.message,
    startsOn: change.startsOn ?? current.startsOn,
    endsOn: change.endsOn ?? current.endsOn,
    active: change.active ?? current.active,
  };
  checkTicker(next);
  await tx.query(
    `update ticker_message set message = $3, starts_on = $4, ends_on = $5, active = $6, updated_at = now(), updated_by = $7, version = version + 1
      where company_id = $1 and id = $2`,
    [grant.companyId, id, next.message, next.startsOn, next.endsOn, next.active, grant.userId],
  );
  const updated = await tickerById(tx, grant.companyId, id);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'ticker_message',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'UPDATE',
    priorVersion: current.version,
    newVersion: updated.version,
    before: tickerAudit(current),
    after: tickerAudit(updated),
  });
  return updated;
}

export interface Feed {
  asOf: string;
  messages: { id: string; message: string; startsOn: string; endsOn: string }[];
  events: { id: string; name: string; description: string | null; eventDate: string; audience: Audience; for: string | null }[];
}

/**
 * What this person is shown: the active messages running today, and the active events from today on (EVENT_HORIZON_DAYS ahead)
 * for everyone, or for the department or location of their own assignment today. Someone with no linked employee sees the
 * company-wide events only. No other person's record is read.
 */
export async function feedFor(db: Queryable, grant: AccessGrant): Promise<Feed> {
  const day = grant.businessDate;
  const own = grant.linkedEmployeeId
    ? (
        await db.query<{ department_id: string | null; location_id: string | null }>(
          `select department_id, location_id from employment_assignment
            where company_id = $1 and employee_id = $2 and effective_from <= $3::date and (effective_to is null or effective_to > $3::date)
            order by effective_from desc limit 1`,
          [grant.companyId, grant.linkedEmployeeId, day],
        )
      ).rows[0]
    : undefined;
  const messages = (
    await db.query<Feed['messages'][number]>(
      `select t.id, t.message, to_char(t.starts_on, 'YYYY-MM-DD') as "startsOn", to_char(t.ends_on, 'YYYY-MM-DD') as "endsOn"
         from ticker_message t
        where t.company_id = $1 and t.active and t.starts_on <= $2::date and t.ends_on >= $2::date
        order by t.starts_on desc, t.created_at desc limit ${FEED_MESSAGES}`,
      [grant.companyId, day],
    )
  ).rows;
  const events = (
    await db.query<Feed['events'][number]>(
      `select ev.id, ev.name, ev.description, to_char(ev.event_date, 'YYYY-MM-DD') as "eventDate", ev.audience,
              coalesce(d.name, l.name) as "for"
         from ${EVENT_FROM}
        where ev.company_id = $1 and ev.active and ev.event_date >= $2::date and ev.event_date < $2::date + ${EVENT_HORIZON_DAYS}
          and (ev.audience = 'ALL'
               or (ev.audience = 'DEPARTMENT' and ev.department_id = $3::uuid)
               or (ev.audience = 'LOCATION' and ev.location_id = $4::uuid))
        order by ev.event_date, ev.name limit ${FEED_EVENTS}`,
      [grant.companyId, day, own?.department_id ?? null, own?.location_id ?? null],
    )
  ).rows;
  return { asOf: day, messages, events };
}
