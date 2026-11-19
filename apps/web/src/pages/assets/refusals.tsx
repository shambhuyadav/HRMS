// Refusals of the asset routes in plain words, and the refusal and problem lines.

import { ApiError, isForbidden, isNotFound, readable } from '../../api';
import { Empty, ErrorNote, NotPermitted } from '../../ui';
import { dateIn } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Refusals in plain words
// ---------------------------------------------------------------------------------------------------------
type Act = 'read' | 'create' | 'update' | 'retire' | 'issue' | 'return' | 'decide' | 'acknowledge' | 'submit' | 'withdraw';

const REGISTER_ACTS: readonly Act[] = ['read', 'create', 'update', 'retire', 'issue', 'return'];
/** Actions the server matches by idempotency key (or by nature), so sending them again never applies them twice. */
const REPEATABLE_ACTS: readonly Act[] = ['issue', 'return', 'decide', 'acknowledge', 'submit'];

/** A refusal in plain words; null for anything else, which is shown as the API sent it. */
export function refusalText(error: unknown, action: Act): string | null {
  if (!error) return null;
  if (!(error instanceof ApiError)) {
    return REPEATABLE_ACTS.includes(action)
      ? 'No answer came back, so this may or may not have been recorded. Send it again unchanged: it is never applied twice.'
      : 'No answer came back, so the change may or may not have been saved. Reload the page to check before trying again.';
  }
  const field = (error.details as { field?: string } | undefined)?.field;
  switch (error.code) {
    case 'FORBIDDEN':
      return REGISTER_ACTS.includes(action)
        ? 'The selected role is not permitted to do this. The asset register and custody actions need an unrestricted company-scope Admin assignment.'
        : 'The selected role is not permitted to do this.';
    case 'NOT_FOUND':
      if (action === 'decide') return 'This request is no longer assigned to you, or its employee is outside the selected role’s scope.';
      if (action === 'issue') return 'The item or the employee is not available in the selected role’s scope.';
      if (action === 'acknowledge') return 'This item record is not available.';
      if (action === 'submit' || action === 'withdraw') return 'This request is not available.';
      return 'This item is not available.';
    case 'EMPLOYEE_CONTEXT_REQUIRED':
      return 'Select your Employee role to work on your own items and requests.';
    case 'INVALID_ASSET_CODE':
      return 'Use 1 to 40 letters, digits, dots, dashes, slashes or underscores for the asset code.';
    case 'ASSET_CODE_EXISTS':
      return 'An item with this asset code already exists. Asset codes are permanent and never reused.';
    case 'INVALID_CATEGORY':
      return 'Choose an active category from the list.';
    case 'INVALID_DESCRIPTION':
      return 'Describe the item.';
    case 'STALE_VERSION':
      return 'The item changed since it was loaded. It has been reloaded: check it and try again.';
    case 'NO_CHANGE':
      return 'Nothing differs from the register entry.';
    case 'ASSET_RETIRED':
      return 'The item is retired. A retired item is final: it is never issued or changed again.';
    case 'ASSET_ISSUED':
      return 'The item is held by an employee. Record its return before retiring it.';
    case 'ASSET_NOT_AVAILABLE':
      return 'The item is held by an employee. Record its return before issuing it again.';
    case 'ASSET_NOT_ISSUED':
      return 'The item is not held by anyone, so there is no return to record.';
    case 'DATE_IN_FUTURE':
      return 'The date cannot be later than today: record it on or after the day it happens.';
    case 'DATE_BEFORE_LAST_RETURN': {
      const on = dateIn(error.message);
      return `The date cannot be before the item’s last return${on ? ` on ${on}` : ''}.`;
    }
    case 'DATE_BEFORE_ISSUE': {
      const on = dateIn(error.message);
      return `The return cannot be dated before the issue${on ? ` on ${on}` : ''}.`;
    }
    case 'INVALID_DATE':
      return 'Enter a valid calendar date.';
    case 'CONDITION_REQUIRED':
      return 'Record the condition of the item.';
    case 'NOTE_REQUIRED':
      return 'Record why the item is retired.';
    case 'EMPLOYEE_NOT_ACTIVE':
      return action === 'submit'
        ? 'Only active employees can ask for an item.'
        : 'Items are issued only to active employees (on probation, confirmed or serving notice).';
    case 'SELF_ACTION_NOT_ALLOWED':
      return 'You cannot record custody of your own items: another administrator does that.';
    case 'REQUEST_NOT_APPLICABLE':
      return 'The chosen custody request is not a request of this employee.';
    case 'REQUEST_NOT_APPROVED':
      return 'Only an approved custody request can be fulfilled.';
    case 'REQUEST_ALREADY_FULFILLED':
      return 'An item was already issued for this custody request.';
    case 'CUSTODY_CLOSED':
      return 'The item has been returned, so there is nothing to acknowledge.';
    case 'REASON_REQUIRED':
      return action === 'decide' ? 'Enter a note explaining the rejection. The employee never sees it.' : 'Explain why you need the item.';
    case 'RETURN_NOT_ALLOWED':
      return 'A custody request is approved or rejected; the employee can submit a new one.';
    case 'TASK_CLOSED':
      return 'This request has already been decided or withdrawn.';
    case 'INVALID_STATE':
      return action === 'withdraw' ? 'Only a request waiting for a decision can be withdrawn.' : null;
    case 'NO_ELIGIBLE_REVIEWER':
      return action === 'submit'
        ? 'No eligible reviewer is set up for custody requests. Ask HR to repair the reviewer list; nothing was submitted.'
        : 'No eligible reviewer is left for this request. Ask HR to repair the reviewer list; your decision was not recorded.';
    case 'WORKFLOW_NOT_CONFIGURED':
      return 'No approval route is set up for custody requests yet. Ask HR to configure it; nothing was submitted.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'Nothing was recorded: this attempt was matched to a different action. Send it again.';
    case 'RETRY':
      return 'Your change met another change at the same moment. Try again.';
    default:
      return field ? `Check the ${readable(field).toLowerCase()} field. ${error.message}` : null;
  }
}

export function Refusal({ error, action }: { error: unknown; action: Act }) {
  if (!error) return null;
  const text = refusalText(error, action);
  return text === null ? (
    <ErrorNote error={error} />
  ) : (
    <p role="alert" className="error">
      {text}
    </p>
  );
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
  return (
    <p role="alert" className="error">
      {text}
    </p>
  );
}
