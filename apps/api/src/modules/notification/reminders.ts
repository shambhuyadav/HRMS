// Reminders and escalations (DF03: reminder after 2 business days, escalation to the fallback list after 5,
// without changing approval state or granting authority; DF11 / BR-031: confirmation reminders 30/7/1 days
// before due, on the due date and weekly when overdue, only for a live case of an employee still on probation; DF12:
// document expiry). Each occurrence has its own event key, so reruns never duplicate; an extension changes the due
// date and therefore the future keys, while past occurrences stay recorded. Business days are Monday-Friday on the
// company calendar date.
// Each job walks its rows in chunks, in id order, one transaction per chunk: an event and its notices commit together, so a crash
// loses at most the chunk in progress, and a rerun walks again, skips every key already recorded and raises what is left.
import { positiveIntFromEnv } from '../../db/budget.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { taskDelegationLive } from '../access/authorize.js';
import { usersCoveringEmployee } from '../workflow/engine.js';
import { fanOut } from './dispatcher.js';

export const REMINDER_AFTER_BUSINESS_DAYS = 2;
export const ESCALATE_AFTER_BUSINESS_DAYS = 5;
export const CONFIRMATION_LEAD_DAYS = [30, 7, 1, 0];
/** The BRD sets no lead time for document expiry, so the notice is raised on the expiry date itself. */
export const DOCUMENT_EXPIRY_LEAD_DAYS = 0;
/**
 * Operational catch-up, not a business rule: a document whose notice date fell on a day the job did not run (worker
 * outage, failed run) or that was uploaded after that day's run is still noticed by a later run within this many
 * days; each notice is raised once (occurrence key).
 */
export const DOCUMENT_EXPIRY_CATCH_UP_DAYS = 7;

/** Tasks, cases or documents per transaction; a starting value, to be measured (G4). */
export const reminderChunkSize = (): number => positiveIntFromEnv('REMINDER_CHUNK_SIZE') ?? 100;

export interface ChunkOptions {
  chunkSize?: number;
}

/**
 * Walks rows in id order, one transaction per chunk. `read` answers the next rows after `after`, at most `limit`; `apply` handles
 * them in the same transaction. `add` hears a chunk's result only once that chunk is committed.
 */
async function inChunks<R extends { id: string }, T>(
  db: Database,
  limit: number,
  read: (tx: Queryable, after: string | null, limit: number) => Promise<R[]>,
  apply: (tx: Queryable, rows: R[]) => Promise<T>,
  add: (result: T) => void,
): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const position: string | null = after;
    const chunk: { rows: number; last: string | null; result: T } = await withTransaction(db, async (tx) => {
      const rows = await read(tx, position, limit);
      return { rows: rows.length, last: rows.at(-1)?.id ?? null, result: await apply(tx, rows) };
    });
    add(chunk.result);
    if (chunk.rows < limit) return;
    after = chunk.last;
  }
}

export async function runReminders(db: Database, companyId: string, options: ChunkOptions = {}) {
  const limit = options.chunkSize ?? reminderChunkSize();
  let created = 0;
  const count = (chunk: number) => {
    created += chunk;
  };
  await inChunks(
    db,
    limit,
    async (tx, after, size) =>
      (
        await tx.query<{ id: string; assignee_user_id: string; transaction_id: string; kind: string; owner_employee_id: string | null; assignee_can_act: boolean; business_days: number }>(
          `with d as (select hrms_business_date($1, now()) as today)
           select t.id, t.assignee_user_id, bt.id as transaction_id, bt.kind, bt.owner_employee_id, ${taskDelegationLive('t')} as assignee_can_act,
                  (select count(*)::int from generate_series(hrms_business_date($1, t.created_at) + 1, d.today, interval '1 day') g(day)
                    where extract(isodow from g.day) < 6) as business_days
             from d, approval_task t
             join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id and i.state = 'ACTIVE'
             join business_transaction bt on bt.company_id = i.company_id and bt.id = i.transaction_id
             left join employee owner on owner.company_id = bt.company_id and owner.id = bt.owner_employee_id
             left join reference_value owner_status on owner_status.company_id = owner.company_id and owner_status.id = owner.status_id
            where t.company_id = $1 and t.state = 'PENDING'
              -- A confirmation review waits on a decision only while the employee is on probation (it would be refused).
              and (bt.kind <> 'employee_confirmation' or owner_status.code = 'ACTIVE_PROBATION')
              and ($2::uuid is null or t.id > $2)
            order by t.id limit $3`,
          [companyId, after, size],
        )
      ).rows,
    async (tx, tasks) => {
      let raised = 0;
      for (const t of tasks) {
        const base = { subjectEmployeeId: t.owner_employee_id, transactionId: t.transaction_id, transactionRevision: null, taskId: t.id, beneficiaryUserId: null };
        const data = { requestKind: t.kind.replace(/_/g, ' '), waitingDays: String(t.business_days) };
        // An assignee whose scope no longer covers the employee, or whose delegation ended, cannot act on the task: no
        // reminder, only the escalation below, which tells the fallback list to review its routing (C4 "Changed organisation or manager").
        if (
          t.business_days >= REMINDER_AFTER_BUSINESS_DAYS &&
          t.assignee_can_act &&
          (!t.owner_employee_id || (await usersCoveringEmployee(tx, companyId, [t.assignee_user_id], t.owner_employee_id)).length > 0)
        ) {
          raised += (await fanOut(tx, companyId, `APPROVAL_REMINDER:${t.id}`, null, { ...base, eventType: 'APPROVAL_REMINDER', data })).created;
        }
        if (t.business_days >= ESCALATE_AFTER_BUSINESS_DAYS) {
          raised += (await fanOut(tx, companyId, `APPROVAL_ESCALATION:${t.id}`, null, { ...base, eventType: 'APPROVAL_ESCALATION', data })).created;
        }
      }
      return raised;
    },
    count,
  );

  await inChunks(
    db,
    limit,
    async (tx, after, size) =>
      (
        await tx.query<{ id: string; employee_id: string; name: string; due: string; days_left: number }>(
          `select c.id, c.employee_id, e.display_name as name, to_char(c.current_due_date, 'YYYY-MM-DD') as due,
                  (c.current_due_date - hrms_business_date($1, now()))::int as days_left
             from employee_confirmation c join employee e on e.company_id = c.company_id and e.id = c.employee_id
             join reference_value st on st.company_id = e.company_id and st.id = e.status_id
            where c.company_id = $1 and c.state in ('OPEN', 'REVIEW_PENDING') and st.code = 'ACTIVE_PROBATION'
              and ($2::uuid is null or c.id > $2)
            order by c.id limit $3`,
          [companyId, after, size],
        )
      ).rows,
    async (tx, cases) => {
      let raised = 0;
      for (const c of cases) {
        const overdue = c.days_left < 0 && -c.days_left % 7 === 0;
        if (!CONFIRMATION_LEAD_DAYS.includes(c.days_left) && !overdue) continue;
        const key = overdue ? `CONFIRMATION_OVERDUE:${c.id}:${c.due}:${-c.days_left}` : `CONFIRMATION_DUE:${c.id}:${c.due}:${c.days_left}`;
        raised += (
          await fanOut(tx, companyId, key, null, {
            eventType: overdue ? 'CONFIRMATION_OVERDUE' : 'CONFIRMATION_DUE',
            fallbackKind: 'employee_confirmation',
            subjectEmployeeId: c.employee_id,
            transactionId: null,
            transactionRevision: null,
            taskId: null,
            beneficiaryUserId: null,
            data: { employeeName: c.name, dueDate: c.due, days: String(Math.abs(c.days_left)) },
          })
        ).created;
      }
      return raised;
    },
    count,
  );
  return { reminders: created };
}

/**
 * DF12 document expiry for a company business date: one DOCUMENT_EXPIRING event per document whose expiry date
 * is `leadDays` after `day` (by default the expiry date itself), keyed by document, expiry date and lead, so
 * reruns raise nothing new and a changed expiry date is a new occurrence. Recipients are the users who can read
 * that employee's documents (DOCUMENT_READERS, rechecked at delivery). The notice names the employee and the
 * date only; the document type, file name and content are never part of it.
 */
export async function runDocumentExpiry(db: Database, companyId: string, day: string, leadDays: number = DOCUMENT_EXPIRY_LEAD_DAYS, options: ChunkOptions = {}) {
  if (!Number.isInteger(leadDays) || leadDays < 0) throw new Error('leadDays must be a non-negative whole number of days');
  let events = 0;
  let notifications = 0;
  await inChunks(
    db,
    options.chunkSize ?? reminderChunkSize(),
    async (tx, after, size) =>
      (
        await tx.query<{ id: string; employee_id: string; name: string; code: string; expires_on: string }>(
          `select d.id, d.employee_id, e.display_name as name, e.employee_code as code, to_char(d.expires_on, 'YYYY-MM-DD') as expires_on
             from employee_document d join employee e on e.company_id = d.company_id and e.id = d.employee_id
            where d.company_id = $1 and d.expires_on between $2::date + $3::int - $4::int and $2::date + $3::int
              and ($5::uuid is null or d.id > $5)
            order by d.id limit $6`,
          [companyId, day, leadDays, DOCUMENT_EXPIRY_CATCH_UP_DAYS, after, size],
        )
      ).rows,
    async (tx, due) => {
      const tally = { events: 0, notifications: 0 };
      for (const d of due) {
        const result = await fanOut(tx, companyId, `DOCUMENT_EXPIRING:${d.id}:${d.expires_on}:${leadDays}`, day, {
          eventType: 'DOCUMENT_EXPIRING',
          subjectEmployeeId: d.employee_id,
          transactionId: null,
          transactionRevision: null,
          taskId: null,
          beneficiaryUserId: null,
          data: { employeeName: d.name, employeeCode: d.code, expiresOn: d.expires_on },
        });
        if (result.recorded) tally.events++;
        tally.notifications += result.created;
      }
      return tally;
    },
    (tally) => {
      events += tally.events;
      notifications += tally.notifications;
    },
  );
  return { day, events, notifications };
}
