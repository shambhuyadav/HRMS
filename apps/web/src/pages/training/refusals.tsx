// Refusals of the training routes in plain words, the problem line and the pager.

import { PagerButton, PagerCount, PagerRow } from '@/components/pager';
import { ApiError, isForbidden, isNotFound, readable } from '../../api';
import { Empty, ErrorNote, Notice, NotPermitted } from '../../ui';
import { STATE_LABEL } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Refusals in plain words
// ---------------------------------------------------------------------------------------------------------
type Act = 'read' | 'create' | 'update' | 'cancel' | 'nominate' | 'transition' | 'enrol' | 'withdraw' | 'feedback' | 'export';

/** Actions the server recognises when sent again (same state, same answers, plan codes never reused): never applied twice. */
const REPEATABLE_ACTS: readonly Act[] = ['cancel', 'nominate', 'transition', 'enrol', 'withdraw', 'feedback', 'create'];

/** A refusal in plain words; null for anything else, which is shown as the API sent it. */
function refusalText(error: unknown, action: Act, nameOf?: (employeeId: string) => string | undefined): string | null {
  if (!error) return null;
  if (!(error instanceof ApiError)) {
    return REPEATABLE_ACTS.includes(action)
      ? 'No answer came back, so this may or may not have been recorded. Send it again unchanged: the server never applies it twice.'
      : 'No answer came back, so the change may or may not have been saved. Reload the page to check before trying again.';
  }
  const details = (error.details ?? {}) as { field?: string; employeeId?: string; state?: string; capacity?: number; seatsTaken?: number; requested?: number; limit?: number };
  const who = details.employeeId ? (nameOf?.(details.employeeId) ?? 'One of the chosen employees') : 'The employee';
  const stateWord = details.state ? (STATE_LABEL[details.state] ?? readable(details.state)).toLowerCase() : null;
  switch (error.code) {
    case 'FORBIDDEN':
      if (action === 'create' || action === 'update' || action === 'cancel') {
        return 'The selected role is not permitted to do this. Training plans are maintained only in an unrestricted company-scope assignment, and a cost needs the cost permission as well.';
      }
      if (action === 'feedback') return 'The selected role is not permitted to do this. A comment needs the comment permission; you can send the scores without one.';
      return 'The selected role is not permitted to do this.';
    case 'NOT_FOUND':
      if (action === 'enrol') return 'This training is no longer open for self-nomination.';
      if (action === 'nominate' || action === 'transition') return 'A chosen employee or participation is not available in the selected role’s scope.';
      if (action === 'withdraw' || action === 'feedback') return 'This participation is not available.';
      return 'This training record is not available in the selected role’s scope.';
    case 'EMPLOYEE_CONTEXT_REQUIRED':
      return 'Select your Employee role to work on your own training.';
    case 'INVALID_PLAN_CODE':
      return 'Use 1 to 40 letters, digits, dots, dashes, slashes or underscores for the plan code.';
    case 'PLAN_CODE_EXISTS':
      return 'A plan with this code already exists. Plan codes are permanent and never reused.';
    case 'INVALID_TITLE':
      return 'Give the course title.';
    case 'END_BEFORE_START':
      return 'The end date cannot be before the start date.';
    case 'INVALID_DATE':
      return 'Enter a valid calendar date.';
    case 'INVALID_PERIOD':
      return 'The period end is before its start.';
    case 'INVALID_MODE':
      return 'Choose an active training mode from the list.';
    case 'INVALID_COST':
      return 'The cost is a non-negative amount with at most two decimals.';
    case 'INVALID_CURRENCY':
      return 'The cost currency is a three-letter code, such as INR.';
    case 'INVALID_OWNER':
      return 'The plan owner must be an active employee of the company.';
    case 'NO_FEEDBACK_QUESTIONS':
      return 'The company has no active training feedback question yet. Ask for the feedback question list to be configured first.';
    case 'INVALID_QUESTIONS':
    case 'INVALID_QUESTION':
      return 'Choose 1 to 20 active feedback questions, each once.';
    case 'PLAN_CANCELLED':
      return 'The plan is cancelled. A cancelled plan and its participations are final.';
    case 'STALE_VERSION':
      return 'The plan changed since it was loaded. Reload the page, check it and try again.';
    case 'DATES_FIXED':
      return 'Attendance was recorded for this plan, so its dates are fixed.';
    case 'CAPACITY_BELOW_SEATS':
      return `The capacity cannot be lower than the ${details.seatsTaken ?? 'confirmed'} places already taken.`;
    case 'QUESTIONS_FIXED':
      return 'Feedback was recorded for this plan, so its questions are fixed.';
    case 'NO_CHANGE':
      return 'Nothing differs from the plan.';
    case 'PLAN_HAS_ATTENDANCE':
      return 'Attendance was recorded for this plan: the session took place, so it cannot be cancelled.';
    case 'REASON_REQUIRED':
      if (action === 'cancel') return 'Record why the plan is cancelled.';
      if (action === 'withdraw') return 'Record why you withdraw.';
      return 'Record a reason: cancelling a participation, or correcting recorded attendance, needs one.';
    case 'PARTICIPANT_EXISTS':
      return action === 'enrol'
        ? `You already take part in this training${stateWord ? ` (${stateWord})` : ''}.`
        : `${who} already takes part in this training${stateWord ? ` (${stateWord})` : ''}. An employee is never added twice to one session.`;
    case 'EMPLOYEE_NOT_ACTIVE':
      return action === 'enrol' ? 'Only active employees can nominate themselves.' : `${who} is not active. Only active employees are nominated and confirmed.`;
    case 'SELF_ACTION_NOT_ALLOWED':
      return 'You cannot nominate, confirm or record your own participation: another coordinator does that.';
    case 'INVALID_TRANSITION':
      return `A participation that is ${stateWord ?? 'in its current state'} cannot take this action.`;
    case 'SESSION_NOT_STARTED':
      return 'Attendance is recorded from the start date of the session.';
    case 'SESSION_NOT_ENDED':
      return 'Completion is recorded from the end date of the session.';
    case 'PLAN_FULL':
      return `The plan is full: ${details.seatsTaken ?? '?'} of ${details.capacity ?? '?'} places are taken and ${details.requested ?? 'more'} confirmation${details.requested === 1 ? ' was' : 's were'} asked for. Confirm fewer or raise the capacity.`;
    case 'PLAN_ENDED':
      return 'The training session has ended.';
    case 'CANCELLED_BY_COORDINATOR':
      return 'Your participation was cancelled by the training coordinator. Ask them to nominate you again.';
    case 'NOT_WITHDRAWABLE':
      return 'Only a nomination waiting for confirmation can be withdrawn. Ask the training coordinator.';
    case 'NOT_SELF_NOMINATED':
      return 'You were nominated by the training coordinator. Ask them to cancel it.';
    case 'FEEDBACK_NOT_OPEN':
      return 'Feedback opens once your completion of the training is recorded.';
    case 'ANSWERS_MISMATCH':
      return 'Answer each question of the training once.';
    case 'SCORE_REQUIRED':
      return 'Give a score from 1 to 5 for each question.';
    case 'INVALID_SCORE':
      return 'A score is a whole number from 1 to 5.';
    case 'FEEDBACK_ALREADY_SUBMITTED':
      return 'Your feedback for this training was already recorded and cannot be changed.';
    case 'EXPORT_TOO_LARGE':
    case 'TOO_MANY_ROWS':
      return `At most ${details.limit ?? 10000} rows are produced at once. Narrow the selection with the filters.`;
    case 'RULE_VIOLATION':
      return action === 'transition' ? 'The change breaks a training rule (for example the plan capacity). Reload and check the participants.' : null;
    case 'RETRY':
      return 'Your change met another change at the same moment. Try again.';
    default:
      return details.field ? `Check the ${readable(details.field).toLowerCase()} field. ${error.message}` : null;
  }
}

export function Refusal({ error, action, nameOf }: { error: unknown; action: Act; nameOf?: (employeeId: string) => string | undefined }) {
  if (!error) return null;
  const text = refusalText(error, action, nameOf);
  if (text === null) return <ErrorNote error={error} />;
  return <Notice notice={{ text, ok: false }} />;
}

export function QueryProblem({ error, forbidden, action = 'read' }: { error: unknown; forbidden: string; action?: Act }) {
  if (!error) return null;
  if (isForbidden(error) && !(error instanceof ApiError && error.code === 'EMPLOYEE_CONTEXT_REQUIRED')) return <NotPermitted>{forbidden}</NotPermitted>;
  if (isNotFound(error)) return <Empty>{refusalText(error, action)}</Empty>;
  return <Refusal error={error} action={action} />;
}

/** A local check before anything is sent (the server applies the same rule). */
export function Problem({ text }: { text: string | null }) {
  if (!text) return null;
  return <Notice notice={{ text, ok: false }} />;
}

/** The pager's line: outline buttons at the end of the list, the page count between them (as the shared Pager of ui.tsx draws it). */
export function Pager({ page, pageSize, total, onPage, label }: { page: number; pageSize: number; total: number; onPage: (page: number) => void; label: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <PagerRow className="pager" role="navigation" aria-label={label}>
      <PagerButton disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous page
      </PagerButton>
      <PagerCount>
        Page {page} of {pages}
      </PagerCount>
      <PagerButton disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next page
      </PagerButton>
    </PagerRow>
  );
}
