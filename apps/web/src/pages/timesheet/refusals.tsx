// The timesheet API's refusals in plain words: the actions, their refusal texts and the refusal lines.

import { ApiError, formatDate, isForbidden, readable } from '../../api';
import { ErrorNote, NotPermitted } from '../../ui';
import { hm } from './shared';

// ---------------------------------------------------------------------------------------------------------
// The API's refusals in plain words
// ---------------------------------------------------------------------------------------------------------
type Act = 'master' | 'allocation' | 'week' | 'line' | 'submit' | 'revise' | 'decide' | 'reopen-request' | 'reopen-decide' | 'resolve' | 'report' | 'read';

const PLAIN: Record<string, string> = {
  EMPLOYEE_CONTEXT_REQUIRED: 'Your own timesheets are kept in your Employee role. Select your Employee role to work on them.',
  CODE_EXISTS: 'That code is already used. Codes never change, so choose another code.',
  INVALID_OWNER: 'The owner must be an employee of this company.',
  INVALID_PERCENT: 'The allocation must be more than 0% and at most 100%, with up to two decimals.',
  UNKNOWN_JOB: 'That job does not exist in this company.',
  UNKNOWN_ACTIVITY: 'That activity does not exist in this company.',
  INACTIVE_MASTER: 'The project, job or activity is not active.',
  INVALID_PROJECT_DATES: 'The allocation must lie within the job’s and the project’s validity periods.',
  EXCEPTION_NOT_NEEDED: 'The allocation stays within 100%, so no over-allocation exception is recorded. Clear the exception reason and save again.',
  MANAGER_EXCEPTION_REQUIRED: 'Only the employee’s current direct manager can record an over-allocation exception.',
  EMPLOYEE_NOT_ACTIVE: 'Only an active employee can be allocated or record time.',
  OUTSIDE_EMPLOYMENT: 'The dates are outside the employment (joining date to last working date).',
  DUPLICATE_ALLOCATION: 'The employee is already allocated to this job for an overlapping interval.',
  PERIOD_IN_FUTURE: 'Time is recorded only for a week that has already started.',
  TIMESHEET_EXISTS: 'You already have a timesheet for this week. It is opened below.',
  TIMESHEET_NOT_EDITABLE: 'Only a draft revision can be changed. An approved timesheet is corrected through a reopen request.',
  INVALID_DATE: 'The date is not a valid calendar date.',
  OUTSIDE_PERIOD: 'The work date is outside this timesheet’s week.',
  WORK_DATE_IN_FUTURE: 'Time is recorded only for days already worked.',
  INVALID_MINUTES: 'Time is recorded in quarter hours (steps of 15 minutes), at most 24 hours.',
  MASTER_OUT_OF_PERIOD: 'The project, job or activity is not valid on the work date.',
  ACTIVITY_NOT_PERMITTED: 'The job does not permit this activity.',
  NO_ACTIVE_ALLOCATION: 'You are not allocated to this job on the work date.',
  DUPLICATE_LINE: 'There is already a line for this day, job and activity. Change the time of that line instead of adding another.',
  REASON_REQUIRED: 'Enter a reason.',
  TASK_CLOSED: 'This task has already been decided.',
  IDEMPOTENCY_KEY_REUSED: 'This decision could not be matched to its earlier attempt. Nothing was recorded; decide again.',
  REOPEN_PENDING: 'A reopen request for this timesheet is already waiting for a decision.',
  TIMESHEET_CHANGED: 'The timesheet is no longer at the approved revision this request names, so nothing was reopened.',
  SELF_ACTION_NOT_ALLOWED: 'You cannot resolve your own missed-timesheet reminder.',
  RANGE_TOO_LONG: 'A report covers at most 366 days. Split the range.',
  GROUP_BY_REQUIRED: 'Group the report by at least one of employee, project, job, activity or week.',
  NO_ELIGIBLE_REVIEWER: 'No eligible reviewer is configured for this timesheet. Contact HR to repair the approval routing.',
  WORKFLOW_NOT_CONFIGURED: 'No approval workflow is configured for timesheets. Contact HR.',
  STALE_VERSION: 'Someone changed this record meanwhile. It has been reloaded: check it and try again.',
};

const INVALID_STATE_TEXT: Partial<Record<Act, string>> = {
  allocation: 'A cancelled allocation is final and cannot be changed.',
  submit: 'Only a draft revision can be submitted. The timesheet has been reloaded.',
  revise: 'Only a returned or rejected timesheet is revised; an approved one needs a reopen request.',
  decide: 'This timesheet is no longer waiting for a decision.',
  'reopen-request': 'Only an approved timesheet is reopened; a draft, returned or rejected one is corrected directly.',
  'reopen-decide': 'This reopen request is no longer waiting for a decision.',
  resolve: 'This reminder has already been resolved.',
};

/** A refusal in plain words; null for anything else, which is shown as the API sent it. */
export function refusalText(error: unknown, act: Act): string | null {
  if (!(error instanceof ApiError)) return null;
  const d = (error.details ?? {}) as Record<string, unknown>;
  switch (error.code) {
    case 'INVALID_PERIOD':
      if (act === 'week') return 'A timesheet covers a Monday to Sunday week: choose the Monday the week starts on.';
      if (act === 'report') return 'The report range ends before it starts.';
      return 'The end date is before the start date.';
    case 'INVALID_STATE':
      return INVALID_STATE_TEXT[act] ?? 'This record is not in a state that allows this any more.';
    case 'OVER_ALLOCATED':
      return `The employee would be allocated ${typeof d.peakPercent === 'string' ? d.peakPercent : 'more than 100'}% on ${typeof d.date === 'string' ? formatDate(d.date) : 'a day of the interval'}. Above 100% needs an over-allocation exception with a reason, recorded by the employee’s direct manager.`;
    case 'DAILY_LIMIT_EXCEEDED':
      return `The lines of ${typeof d.workDate === 'string' ? formatDate(d.workDate) : 'that day'} would total ${typeof d.totalMinutes === 'number' ? hm(d.totalMinutes) : 'more than 24 hours'}: a day holds at most 24 hours.`;
    case 'LINES_INVALID': {
      const lines = Array.isArray(d.lines) ? (d.lines as { workDate: string; code: string }[]) : [];
      const each = lines.map((l) => `${formatDate(l.workDate)}: ${PLAIN[l.code] ?? readable(l.code)}`).join(' ');
      return `Some lines no longer meet the entry rules; correct or remove them, then submit again. ${each}`.trim();
    }
    case 'FORBIDDEN':
      return 'The selected role is not permitted to do this.';
  }
  if (PLAIN[error.code]) return PLAIN[error.code]!;
  if (error.status === 404) return 'This record is not available in the selected role’s scope, or it no longer exists.';
  return null;
}

export function Refusal({ error, act }: { error: unknown; act: Act }) {
  if (!error) return null;
  const text = refusalText(error, act);
  return text === null ? (
    <ErrorNote error={error} />
  ) : (
    <p role="alert" className="error">
      {text}
    </p>
  );
}

/** A list or detail that could not be read: a scope refusal in words, anything else as the API sent it. */
export function ReadProblem({ error, what }: { error: unknown; what: string }) {
  if (!error) return null;
  if (isForbidden(error) && !(error instanceof ApiError && error.code === 'EMPLOYEE_CONTEXT_REQUIRED')) return <NotPermitted>The selected role cannot see {what}.</NotPermitted>;
  return <Refusal error={error} act="read" />;
}
