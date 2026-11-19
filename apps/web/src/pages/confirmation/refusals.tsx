// The confirmation API's refusals in plain words.
import { ApiError, formatDate } from '../../api';
import { ErrorNote } from '../../ui';
import type { ExceptionAction } from './shared';

/**
 * The API's refusals of an exception action (modules/confirmation/exceptions.ts) in plain words; null for anything
 * else, which is shown as the API sent it. `sent` is what a refused proposal asked for.
 */
export function refusalText(error: unknown, action: ExceptionAction, sent?: { kind?: string | undefined; startDate?: string | undefined }): string | null {
  // No answer (the connection dropped, or the answer could not be read): a decision is sent again under its key.
  if (!(error instanceof ApiError)) return action === 'decide' ? 'No answer came back, so your decision may or may not have been recorded. Send the same decision again: it is never applied twice.' : null;
  const propose = action === 'propose';
  switch (error.code) {
    case 'CASE_NOT_OPEN':
      // Not open: under review, or closed (a waiting proposal outlives a case that has been confirmed meanwhile).
      return `The due date can change only while the case is open, and it is not open now: a recommendation is under review, or the case has closed. ${
        propose ? 'Propose the new date once the case is open again.' : 'Approve this once the case is open again, or reject it.'
      }`;
    case 'CASE_CLOSED':
      return propose ? 'This confirmation is closed, so no exception can be proposed for it.' : 'This confirmation is closed, so the exception can no longer apply. Reject it to close the proposal.';
    case 'LIMIT_NOT_REACHED':
      return 'This case can still be extended within its policy limit, so an extra extension is not needed yet.';
    case 'OPEN_PROPOSAL_EXISTS':
      return 'An exception of this kind is already waiting for a decision on this case. It has to be decided or withdrawn before another one can be proposed.';
    case 'NO_CHANGE':
      return 'That date is already the case’s due date. Choose a different date.';
    case 'RULE_VIOLATION':
      // The rule the API names for a proposed due date; any other rule keeps the API's own words.
      return propose && sent?.kind === 'DUE_DATE_OVERRIDE'
        ? `The new due date cannot be before the employee’s start date${sent.startDate ? ` (${formatDate(sent.startDate)})` : ''}.`
        : null;
    case 'INVALID_DATE':
      return 'Enter a valid new due date.';
    case 'SELF_ACTION':
      return propose ? 'You cannot propose an exception for your own confirmation.' : 'You cannot decide an exception for your own confirmation.';
    case 'INDEPENDENT_APPROVER_REQUIRED':
      return 'You proposed this exception, so another eligible HR user has to decide it.';
    case 'INVALID_STATE':
      return action === 'withdraw' ? 'This proposal has already been decided or withdrawn, so it can no longer be withdrawn.' : 'This proposal has already been decided or withdrawn.';
    case 'NOT_FOUND':
      return propose ? null : action === 'withdraw' ? 'Only the HR user who proposed it can withdraw this proposal.' : 'This proposal is no longer available in the selected role’s scope.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'Nothing was recorded: this attempt was matched to a different decision. Send your decision again.';
    default:
      return null;
  }
}

/** A failed exception action: the API's refusals in plain words, anything else as the API sent it. */
export function Refusal({ error, action, sent }: { error: unknown; action: ExceptionAction; sent?: { kind?: string | undefined; startDate?: string | undefined } }) {
  if (!error) return null;
  const text = refusalText(error, action, sent);
  return text === null ? (
    <ErrorNote error={error} />
  ) : (
    <p role="alert" className="error">
      {text}
    </p>
  );
}
