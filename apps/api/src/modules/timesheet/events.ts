// Timesheets (FR-045 to FR-048; F1 timesheets): notification events (DF12). Employee identity, week, revision, hours and
// outcome only. Payload ids are validated before any query; an event whose record is gone, or that no longer applies
// (a missed-submission reminder for a week submitted meanwhile), produces nothing. Describers never throw on bad data.
import type { Queryable } from '../../db/queryable.js';
import type { EventDescriber } from '../events-registry.js';
import type { EventSpec } from '../notification/dispatcher.js';
import { hoursOf } from './common.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);
const revisionOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1_000_000 ? v : null);

const spec = (s: Partial<EventSpec> & Pick<EventSpec, 'eventType' | 'data'>): EventSpec => ({
  subjectEmployeeId: null,
  transactionId: null,
  transactionRevision: null,
  taskId: null,
  beneficiaryUserId: null,
  ...s,
});

const DECISION_LABELS: Record<string, string> = { APPROVED: 'approved', RETURNED: 'returned for correction', REJECTED: 'rejected' };
const REOPEN_LABELS: Record<string, string> = { APPROVED: 'approved', REJECTED: 'rejected' };

interface SheetFacts {
  employee_id: string;
  transaction_id: string;
  employee_code: string;
  employee_name: string;
  period_start: string;
  period_end: string;
  revision_exists: boolean;
  minutes: number;
}

async function sheetFacts(tx: Queryable, companyId: string, timesheetId: string, revision: number): Promise<SheetFacts | undefined> {
  return (
    await tx.query<SheetFacts>(
      `select t.employee_id, t.transaction_id, e.employee_code, e.display_name as employee_name,
              to_char(t.period_start, 'YYYY-MM-DD') as period_start, to_char(t.period_end, 'YYYY-MM-DD') as period_end,
              exists (select 1 from timesheet_revision r where r.company_id = t.company_id and r.timesheet_id = t.id and r.revision = $3) as revision_exists,
              (select coalesce(sum(l.minutes), 0)::int from timesheet_line l where l.company_id = t.company_id and l.timesheet_id = t.id and l.revision = $3 and l.removed_at is null) as minutes
         from timesheet t join employee e on e.company_id = t.company_id and e.id = t.employee_id
        where t.company_id = $1 and t.id = $2`,
      [companyId, timesheetId, revision],
    )
  ).rows[0];
}

const submitted: EventDescriber = async (tx, ev) => {
  const timesheetId = id(ev.payload.timesheetId);
  const taskId = id(ev.payload.taskId);
  const revision = revisionOf(ev.payload.revision);
  if (!timesheetId || !taskId || !revision) return null;
  const s = await sheetFacts(tx, ev.companyId, timesheetId, revision);
  if (!s?.revision_exists) return null;
  return spec({
    eventType: 'TIMESHEET_SUBMITTED',
    subjectEmployeeId: s.employee_id,
    transactionId: s.transaction_id,
    transactionRevision: revision,
    taskId,
    data: { employeeName: s.employee_name, employeeCode: s.employee_code, periodStart: s.period_start, periodEnd: s.period_end, revision: String(revision), hours: hoursOf(s.minutes) },
  });
};

const decided: EventDescriber = async (tx, ev) => {
  const timesheetId = id(ev.payload.timesheetId);
  const revision = revisionOf(ev.payload.revision);
  const outcome = typeof ev.payload.outcome === 'string' ? DECISION_LABELS[ev.payload.outcome] : undefined;
  if (!timesheetId || !revision || !outcome) return null;
  const s = await sheetFacts(tx, ev.companyId, timesheetId, revision);
  if (!s?.revision_exists) return null;
  return spec({
    eventType: 'TIMESHEET_DECIDED',
    subjectEmployeeId: s.employee_id,
    transactionId: s.transaction_id,
    transactionRevision: revision,
    data: { periodStart: s.period_start, periodEnd: s.period_end, revision: String(revision), outcome },
  });
};

interface ReopenFacts {
  employee_id: string;
  transaction_id: string;
  revision: number;
  employee_code: string;
  employee_name: string;
  period_start: string;
  period_end: string;
  requested_by: string;
  requester_is_employee: boolean;
}

async function reopenFacts(tx: Queryable, companyId: string, reopenRequestId: string): Promise<ReopenFacts | undefined> {
  return (
    await tx.query<ReopenFacts>(
      `select r.employee_id, r.transaction_id, bt.revision, e.employee_code, e.display_name as employee_name,
              to_char(t.period_start, 'YYYY-MM-DD') as period_start, to_char(t.period_end, 'YYYY-MM-DD') as period_end, r.requested_by,
              exists (select 1 from user_employee_link l where l.company_id = r.company_id and l.user_id = r.requested_by and l.employee_id = r.employee_id) as requester_is_employee
         from timesheet_reopen_request r
         join business_transaction bt on bt.company_id = r.company_id and bt.id = r.transaction_id
         join timesheet t on t.company_id = r.company_id and t.id = r.timesheet_id
         join employee e on e.company_id = r.company_id and e.id = r.employee_id
        where r.company_id = $1 and r.id = $2`,
      [companyId, reopenRequestId],
    )
  ).rows[0];
}

const reopenSubmitted: EventDescriber = async (tx, ev) => {
  const reopenRequestId = id(ev.payload.reopenRequestId);
  const taskId = id(ev.payload.taskId);
  if (!reopenRequestId || !taskId) return null;
  const r = await reopenFacts(tx, ev.companyId, reopenRequestId);
  if (!r) return null;
  return spec({
    eventType: 'TIMESHEET_REOPEN_SUBMITTED',
    subjectEmployeeId: r.employee_id,
    transactionId: r.transaction_id,
    transactionRevision: r.revision,
    taskId,
    data: { employeeName: r.employee_name, employeeCode: r.employee_code, periodStart: r.period_start, periodEnd: r.period_end },
  });
};

const reopenDecided: EventDescriber = async (tx, ev) => {
  const reopenRequestId = id(ev.payload.reopenRequestId);
  const outcome = typeof ev.payload.outcome === 'string' ? REOPEN_LABELS[ev.payload.outcome] : undefined;
  if (!reopenRequestId || !outcome) return null;
  const r = await reopenFacts(tx, ev.companyId, reopenRequestId);
  if (!r) return null;
  return spec({
    eventType: 'TIMESHEET_REOPEN_DECIDED',
    subjectEmployeeId: r.employee_id,
    transactionId: r.transaction_id,
    transactionRevision: r.revision,
    // The requester hears the outcome too, unless the requester is the employee (told as the subject).
    beneficiaryUserId: r.requester_is_employee ? null : r.requested_by,
    data: { employeeName: r.employee_name, employeeCode: r.employee_code, periodStart: r.period_start, periodEnd: r.period_end, outcome },
  });
};

const missing: EventDescriber = async (tx, ev) => {
  const exceptionId = id(ev.payload.exceptionId);
  if (!exceptionId) return null;
  const x = (
    await tx.query<{ employee_id: string; state: string; period_start: string; period_end: string; due_date: string }>(
      `select employee_id, state, to_char(period_start, 'YYYY-MM-DD') as period_start, to_char(period_end, 'YYYY-MM-DD') as period_end,
              to_char(due_date, 'YYYY-MM-DD') as due_date
         from timesheet_missing_exception where company_id = $1 and id = $2`,
      [ev.companyId, exceptionId],
    )
  ).rows[0];
  // DF12: no reminder once the week was submitted or the exception resolved.
  if (!x || x.state !== 'OPEN') return null;
  return spec({ eventType: 'TIMESHEET_MISSING', subjectEmployeeId: x.employee_id, data: { periodStart: x.period_start, periodEnd: x.period_end, dueDate: x.due_date } });
};

export const TIMESHEET_EVENTS: Readonly<Record<string, EventDescriber>> = {
  'timesheet.submitted': submitted,
  'timesheet.decided': decided,
  'timesheet_reopen.submitted': reopenSubmitted,
  'timesheet_reopen.decided': reopenDecided,
  'timesheet.missing': missing,
};
