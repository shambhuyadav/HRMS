// The hiring API's refusals in plain words (requisitions and manpower budgets).
import { ApiError } from '../../api';
import { ErrorNote } from '../../ui';

// ---------------------------------------------------------------------------------------------------------
// The API's refusals in plain words
// ---------------------------------------------------------------------------------------------------------

type Act =
  | 'create'
  | 'update'
  | 'submit'
  | 'withdraw'
  | 'discard'
  | 'copy'
  | 'raiseAgain'
  | 'close'
  | 'decide'
  | 'budget-create'
  | 'revision-create'
  | 'revision-update'
  | 'revision-submit'
  | 'revision-withdraw'
  | 'budget-decide';

const INVALID_STATE_TEXT: Partial<Record<Act, string>> = {
  update: 'Only a draft can be changed, and this requisition has moved on. It has been reloaded.',
  submit: 'Only a draft can be submitted, and this requisition has moved on. It has been reloaded.',
  withdraw: 'Only a requisition waiting for a decision can be withdrawn. It has been reloaded.',
  discard: 'Only a draft can be discarded; withdraw a submitted requisition first. It has been reloaded.',
  close: 'Only an approved requisition can be closed. It has been reloaded.',
  decide: 'This requisition is no longer waiting for a decision.',
  'revision-update': 'Only a draft revision can be changed. The budget line has been reloaded.',
  'revision-submit': 'Only a draft revision can be submitted. The budget line has been reloaded.',
  'revision-withdraw': 'Only a draft or submitted revision can be withdrawn. The budget line has been reloaded.',
  'budget-decide': 'This revision is no longer waiting for a decision.',
};

const FIELD_LABEL: Record<string, string> = {
  title: 'position title',
  reason: 'reason',
  targetDate: 'target date',
  periodStart: 'period start',
  periodEnd: 'period end',
  on: 'date',
};

const MASTER_FIELD: Record<string, string> = { departmentId: 'department', locationId: 'location', designationId: 'designation' };

/** The budget figures a refusal carries (the requisition's budget check when it was refused). */
function budgetFigures(details: unknown): string {
  const d = (details ?? {}) as { budgetStatus?: unknown; approvedHeadcount?: unknown; committed?: unknown; requested?: unknown };
  if (d.budgetStatus === 'NO_BUDGET') return 'No approved manpower budget covers its department, location and designation on the target date.';
  const parts: string[] = [];
  if (typeof d.approvedHeadcount === 'number') parts.push(`approved headcount ${d.approvedHeadcount}`);
  if (typeof d.committed === 'number') parts.push(`already committed ${d.committed}`);
  if (typeof d.requested === 'number') parts.push(`requested ${d.requested}`);
  return parts.length > 0 ? `The requisition exceeds its approved budget (${parts.join(', ')}).` : 'The requisition exceeds its approved budget.';
}

const isDecision = (action: Act) => action === 'decide' || action === 'budget-decide';
const isBudget = (action: Act) => action.startsWith('budget') || action.startsWith('revision');

/** A refusal in plain words; null for anything else, which is shown as the API sent it. */
export function refusalText(error: unknown, action: Act): string | null {
  if (!error) return null;
  if (!(error instanceof ApiError)) {
    return isDecision(action)
      ? 'No answer came back, so your decision may or may not have been recorded. Send the same decision again: it is never applied twice.'
      : 'No answer came back, so the change may or may not have been saved. Reload the page to check before trying again.';
  }
  const d = (error.details ?? {}) as { field?: unknown; category?: unknown };
  const field = typeof d.field === 'string' ? d.field : '';
  switch (error.code) {
    case 'FORBIDDEN':
      return 'The selected role is not permitted to do this.';
    case 'NOT_FOUND':
      return isDecision(action)
        ? 'This task is no longer assigned to you.'
        : isBudget(action)
          ? 'This budget line is not available in the selected role’s scope.'
          : 'This requisition is not available in the selected role’s scope.';
    case 'STALE_VERSION':
      return isBudget(action)
        ? 'The revision changed since it was loaded. It has been reloaded: check it and try again.'
        : 'The requisition changed since it was loaded. It has been reloaded: check it and try again.';
    case 'INVALID_STATE':
      return INVALID_STATE_TEXT[action] ?? null;
    case 'NOT_REQUESTER':
      return 'Only the requester can change, submit, withdraw or discard this requisition.';
    case 'PREDECESSOR_ALREADY_FOLLOWED':
      return 'A later requisition already follows this rejected one.';
    case 'PREDECESSOR_NOT_FOUND':
      return 'Only the requester of a rejected requisition can raise it again.';
    case 'NOT_PREPARER':
      return 'Only the HR user who prepared this revision can change, submit or withdraw it.';
    case 'REQUESTER_NOT_LINKED':
      return 'A requisition is raised by an employee, and this account is not linked to an employee record.';
    case 'REQUESTER_NOT_ACTIVE':
      return 'Only an active employee can raise or submit a requisition.';
    case 'INVALID_HIRING_MANAGER':
      // A copy takes the source's values as they are, so there is nothing to choose on this screen.
      return action === 'copy' || action === 'raiseAgain'
        ? 'This requisition cannot be copied: its hiring manager is no longer an active employee of this company.'
        : 'The hiring manager must be an active employee of this company. Choose another hiring manager.';
    case 'INVALID_REFERENCE': {
      const master = MASTER_FIELD[field];
      if (action === 'copy' || action === 'raiseAgain') {
        const what = master ?? (d.category === 'EMPLOYMENT_TYPE' ? 'employment type' : 'department, location, designation or employment type');
        return `This requisition cannot be copied: its ${what} is no longer active in this company.`;
      }
      if (master) return `The ${master} is not active in this company. Choose another ${master}.`;
      if (d.category === 'EMPLOYMENT_TYPE') return 'That employment type is not an active value in this company. Check the code.';
      return 'A department, location, designation or employment type is no longer active. Check the choices, then try again.';
    }
    case 'FIELD_REQUIRED':
      return `Enter the ${FIELD_LABEL[field] ?? 'required details'}.`;
    case 'INVALID_DATE':
      return `Enter a valid ${FIELD_LABEL[field] ?? 'date'}.`;
    case 'TOO_MANY_SKILLS':
      return 'List at most 50 skills.';
    case 'INVALID_FIELD':
      return field === 'skills' ? 'A skill is at most 100 characters.' : null;
    case 'BUDGET_EXCEPTION_REASON_REQUIRED':
      return `${budgetFigures(error.details)} Edit the draft to record why an exception is needed, then submit it again.`;
    case 'BUDGET_EXCEPTION_REQUIRED':
      return `${budgetFigures(error.details)} It records no exception reason, so it cannot be approved: return it to the requester or reject it.`;
    case 'BUDGET_EXCEPTION_DECISION_REQUIRED':
      return `${budgetFigures(error.details)} Tick “Approve the budget exception” to approve it, or return or reject it.`;
    case 'NO_ELIGIBLE_REVIEWER':
      return action === 'decide'
        ? 'No eligible HR Administrator is left for the budget and headcount approval: neither the requester nor you may take that step. Ask HR to add a reviewer to the requisition reviewer list; your decision was not recorded.'
        : 'No eligible reviewer is set up for this approval. Ask HR to repair the reviewer list; nothing was submitted.';
    case 'WORKFLOW_NOT_CONFIGURED':
      return 'No approval route is set up for this yet. Ask HR to configure it; nothing was submitted.';
    case 'OPEN_OFFERS':
      return 'Finish, withdraw or hand over the open offers before closing the requisition.';
    case 'REASON_REQUIRED':
      return isBudget(action) ? 'Enter a reason to reject the revision.' : 'Enter a reason to return or reject the requisition.';
    case 'TASK_CLOSED':
      return 'This task has already been decided or withdrawn.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'Nothing was recorded: this attempt was matched to a different decision. Send your decision again.';
    case 'OVERLAPPING_PERIOD':
      return 'A budget line for this department, location and designation already covers part of that period. Add a revision to that line instead.';
    case 'INVALID_PERIOD':
      return 'The period ends before it starts.';
    case 'OPEN_REVISION_EXISTS':
      return 'This budget line already has a revision in progress. Finish or withdraw it first.';
    case 'RETRY':
      return 'Your change met another change at the same moment. Try again.';
    default:
      return null;
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

