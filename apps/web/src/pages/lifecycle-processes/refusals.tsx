// Refusals of the lifecycle routes in plain words: the actions, their refusal texts and the refusal line.

import { ApiError } from '../../api';
import { ErrorNote } from '../../ui';
import { roleLabel } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Refusals in plain words (the HttpError codes of templates.ts, processes.ts, exit.ts, notes.ts, workflow/engine.ts)
// ---------------------------------------------------------------------------------------------------------
export type Act =
  | 'template-create'
  | 'template-update'
  | 'draft-save'
  | 'publish'
  | 'start'
  | 'complete'
  | 'skip'
  | 'reopen-task'
  | 'reassign'
  | 'close'
  | 'reopen'
  | 'cancel'
  | 'evidence'
  | 'note'
  | 'resign'
  | 'withdraw'
  | 'withdrawal-request'
  | 'withdrawal-cancel'
  | 'recommend'
  | 'exit-decide'
  | 'withdrawal-decide'
  | 'notice-period'
  | 'release';

const DECISION_ACTS: ReadonlySet<Act> = new Set<Act>(['recommend', 'exit-decide', 'withdrawal-decide']);
const TEMPLATE_ACTS: ReadonlySet<Act> = new Set<Act>(['template-create', 'template-update', 'draft-save', 'publish']);
const OWN_ACTS: ReadonlySet<Act> = new Set<Act>(['resign', 'withdraw', 'withdrawal-request', 'withdrawal-cancel']);
const NO_ANSWER_DECISION = 'No answer came back, so your decision may or may not have been recorded. Send the same decision again: it is never applied twice.';
const NO_ANSWER_CHANGE = 'No answer came back, so the change may or may not have been saved. Reload the page to check before trying again.';

const STALE_SUBJECT: Partial<Record<Act, string>> = {
  'template-update': 'The template',
  'draft-save': 'The draft revision',
  publish: 'The draft revision',
  complete: 'The task',
  skip: 'The task',
  'reopen-task': 'The task',
  reassign: 'The task',
  close: 'The process',
  reopen: 'The process',
  cancel: 'The process',
  'notice-period': 'The exit case',
  release: 'The exit case',
};
const INVALID_STATE_TEXT: Partial<Record<Act, string>> = {
  publish: 'Only a draft revision can be published, and this one has moved on. The template has been reloaded.',
  withdraw: 'This resignation can no longer be withdrawn.',
  'withdrawal-request': 'Only an approved resignation needs a withdrawal request.',
  'withdrawal-cancel': 'This withdrawal request has already been decided.',
  recommend: 'This resignation is no longer waiting for a recommendation.',
  'exit-decide': 'This resignation is no longer waiting for an HR decision.',
  'withdrawal-decide': 'This withdrawal request is no longer waiting for a decision.',
  'notice-period': 'This exit is closed, so its notice period can no longer be recorded.',
  release: 'Only an approved exit can be finally released.',
};

const tasksIn = (details: unknown): string[] => {
  const tasks = (details as { tasks?: unknown } | undefined)?.tasks;
  return Array.isArray(tasks) ? tasks.filter((t): t is string => typeof t === 'string') : [];
};
/** A refusal about one template task names it by its position (details.task, 1-based). */
function forTask(details: unknown, text: string): string {
  const n = (details as { task?: unknown } | undefined)?.task;
  return typeof n === 'number' ? `Task ${n}: ${text}` : text.charAt(0).toUpperCase() + text.slice(1);
}

/** A refusal in plain words; null for anything else, which is shown as the API sent it. */
export function refusalText(error: unknown, action: Act): string | null {
  if (!error) return null;
  if (!(error instanceof ApiError)) {
    // A file that could not be read never reached the server; a failed fetch may have.
    if (action === 'complete' && !(error instanceof TypeError)) return 'The evidence file could not be read. Choose it again.';
    return DECISION_ACTS.has(action) ? NO_ANSWER_DECISION : NO_ANSWER_CHANGE;
  }
  const d = error.details;
  const listed = tasksIn(d);
  switch (error.code) {
    case 'FORBIDDEN':
      return 'The selected role is not permitted to do this.';
    case 'NOT_FOUND':
      if (DECISION_ACTS.has(action)) return 'This task is no longer assigned to you.';
      if (action === 'evidence') return 'No evidence file is recorded for this task now.';
      if (TEMPLATE_ACTS.has(action)) return 'This process template is not available.';
      if (OWN_ACTS.has(action)) return 'This resignation or request is not yours, or it no longer exists.';
      if (action === 'start' || action === 'note') return 'This employee is not in the selected role’s scope.';
      if (action === 'notice-period' || action === 'release') return 'This exit case is not available in the selected role’s scope.';
      return 'This process or task is not available in the selected role’s scope.';
    case 'STALE_VERSION':
      if (action === 'draft-save') return 'The draft revision was changed elsewhere since it was loaded. Your changes are kept: save again to replace that version, or discard them to load it.';
      // A decision carries no version: nothing reloads, and the same decision can simply be sent again.
      if (DECISION_ACTS.has(action)) return 'Another change reached this request at the same moment, so your decision was not recorded. Send it again.';
      return `${STALE_SUBJECT[action] ?? 'The record'} changed since it was loaded. It has been reloaded: check it and try again.`;
    case 'INVALID_REQUEST':
    case 'INVALID_VALUE':
    case 'MISSING_VALUE':
      return 'Some details are missing or not in the accepted format. Check the form and try again.';
    case 'DUPLICATE':
      return action === 'template-create' ? 'A process template with this code already exists. Choose another code.' : 'This was already recorded by another change. Reload the page to check.';
    case 'RULE_VIOLATION':
      return 'The change breaks a rule the system enforces, so nothing was saved. Reload the page to check the current state.';
    case 'UNAVAILABLE':
      return 'The service is busy right now and nothing was changed. Try again in a few seconds.';
    case 'SELF_ACTION_NOT_ALLOWED':
      return 'You cannot act on your own record in this role; another HR user does.';
    case 'INVALID_STATE':
      return INVALID_STATE_TEXT[action] ?? null;
    // Templates (FR-015)
    case 'OWNER_REQUIRED':
      return forTask(d, 'give exactly one owner: a role or a named user.');
    case 'INVALID_OWNER': {
      if (action === 'start') {
        // details.tasks: template tasks whose named owner is the employee's own user or cannot act on this employee.
        if (listed.length > 0) {
          return `These template tasks are owned by a named user who cannot act on this employee, or by the employee’s own user: ${listed.join(', ')}. Change their owner in the template first.`;
        }
        return 'The process owner must be able to manage employee processes and must not be the employee, and every named task owner of the template must be able to act on this employee.';
      }
      if (action === 'reassign') {
        return 'That owner cannot complete process tasks for this employee, or is the employee’s own user (the employee’s own tasks belong to the Employee role). Choose another owner.';
      }
      const role = (d as { ownerRoleCode?: unknown } | undefined)?.ownerRoleCode;
      return forTask(d, typeof role === 'string' ? `the ${roleLabel(role)} role cannot complete process tasks. Choose another owner.` : 'that user cannot complete process tasks in this company. Choose another owner.');
    }
    case 'DUPLICATE_TASK_CODE':
      return 'Each task code can appear only once in a revision.';
    case 'INVALID_DUE_OFFSET':
      return forTask(d, 'the due offset is a whole number of days.');
    case 'TEMPLATE_CODE_EXISTS':
      return 'A process template with this code already exists. Choose another code.';
    case 'NO_TASKS':
      return 'A revision needs at least one task before it can be published.';
    case 'INVALID_REFERENCE':
      if (action === 'template-create') return 'That process type is not an active value in this company. Check the code.';
      if (action === 'start') return 'No process template has that code, or the exit case does not belong to this employee.';
      if (action === 'resign') return 'That reason code is not one your company uses. Leave it empty, or ask HR which codes apply.';
      if (action === 'note') return 'The linked process or exit does not belong to this employee.';
      return null;
    // Employee processes (FR-016)
    case 'TEMPLATE_INACTIVE':
      return 'That process template is inactive. Activate it before starting processes from it.';
    case 'TEMPLATE_NOT_PUBLISHED':
      return 'That process template has no published revision yet. Publish a revision first.';
    case 'EXIT_CASE_MISMATCH':
      return 'An exit clearance template needs the exit case it clears, and only an exit clearance template takes one.';
    case 'EXIT_NOT_APPROVED':
      return 'A clearance checklist starts once the exit is approved, and before its final release.';
    case 'CLEARANCE_EXISTS':
      return 'This exit already has a clearance checklist.';
    case 'INVALID_DATE':
      return 'Enter a valid effective date.';
    case 'NOT_TASK_OWNER':
      return 'This task is owned by someone else.';
    case 'PROCESS_NOT_OPEN':
      if (action === 'reopen-task') return 'Reopen the process before its tasks.';
      if (action === 'close') return 'Only an open process can be closed.';
      if (action === 'cancel') return 'Only an open process can be cancelled.';
      return 'The process is not open, so its tasks cannot change.';
    case 'TASK_NOT_OPEN':
      return 'This task is no longer open.';
    case 'TASK_NOT_DONE':
      return 'This task is already open.';
    case 'EVIDENCE_REQUIRED':
      return 'This task needs evidence: attach a PDF, JPEG or PNG file.';
    case 'FILE_SIZE':
      return 'The evidence file must be between 1 byte and 10 MB.';
    case 'UNSUPPORTED_FILE':
      return 'Only PDF, JPEG and PNG files are accepted as evidence.';
    case 'PAYLOAD_TOO_LARGE':
      return 'The file is larger than the 10 MB limit.';
    case 'REQUIRED_TASK':
      return 'A required task cannot be skipped.';
    case 'SAME_OWNER':
      return 'The task already has this owner.';
    case 'REQUIRED_TASKS_INCOMPLETE':
      return `Every required task must be completed first.${listed.length > 0 ? ` Still incomplete: ${listed.join(', ')}.` : ''} Required evidence counts only once the malware scan releases it: a file still waiting for the scan counts once released, and a task whose file failed the scan is reopened and completed again with a clean file.`;
    case 'PROCESS_NOT_CLOSED':
      return 'Only a closed process can be reopened.';
    case 'EXIT_RELEASED':
      return action === 'withdrawal-request' ? 'Your exit was finally released, so it can no longer be withdrawn.' : 'The exit was finally released, so its clearance checklist is final.';
    case 'FILE_NOT_RELEASED':
      return (d as { scanState?: unknown } | undefined)?.scanState === 'QUARANTINED'
        ? 'This file failed the malware scan, so it cannot be opened.'
        : 'This file cannot be opened until the malware scan releases it.';
    case 'ALREADY_SUPERSEDED':
      return 'That note was already corrected; correct the latest note instead.';
    // Exit (FR-051)
    case 'EMPLOYEE_NOT_ACTIVE':
      return action === 'resign' ? 'Only an active employee can resign.' : 'The employee is no longer active, so the resignation cannot be approved.';
    case 'OPEN_EXIT_EXISTS':
      return 'You already have an open resignation.';
    case 'INVALID_LAST_WORKING_DATE':
      if (action === 'resign') return 'The proposed last working date must be a valid date, today or later.';
      if (action === 'recommend') return 'The recommended last working date must be a valid date, not before the resignation date or today.';
      return 'The approved last working date must be a valid date, not before the resignation date or today.';
    case 'USE_WITHDRAWAL_REQUEST':
      return 'Your resignation is approved, so it can be withdrawn only through an HR decision: request the withdrawal instead.';
    case 'LAST_WORKING_DATE_PASSED':
      return 'Your last working date has passed, so the resignation can no longer be withdrawn.';
    case 'WITHDRAWAL_PENDING':
      return action === 'release' ? 'A withdrawal request is waiting for a decision; it has to be decided first.' : 'A withdrawal request is already waiting for a decision.';
    case 'TASK_CLOSED':
      return 'This task has already been decided.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'Nothing was recorded: this attempt was matched to a different decision. Send your decision again.';
    case 'REASON_REQUIRED':
      return 'To not approve the resignation, record the private reason and the message for the employee.';
    case 'EMPLOYEE_MESSAGE_REQUIRED':
      return 'To not approve the withdrawal, explain the decision to the employee.';
    case 'SETTLEMENT_IN_PROGRESS':
      return action === 'notice-period'
        ? 'A submitted settlement relies on the recorded notice period, so it cannot change now.'
        : 'A settlement is being prepared for this exit; it has to be cancelled or finished before the withdrawal can be approved.';
    case 'BEFORE_LAST_WORKING_DATE':
      return 'The final release is recorded on or after the last working date.';
    case 'CLEARANCE_NOT_STARTED':
      return 'Start the exit clearance checklist first.';
    case 'CLEARANCE_INCOMPLETE':
      return `Every required clearance task must be completed first.${listed.length > 0 ? ` Still incomplete: ${listed.join(', ')}.` : ''} Required evidence counts only once the malware scan releases it.`;
    case 'ALREADY_RELEASED':
      return 'This exit was already finally released.';
    case 'NO_ELIGIBLE_REVIEWER':
      if (action === 'recommend') return 'No eligible HR Administrator is left to decide this resignation. Ask HR to add a reviewer to the exit reviewer list; your recommendation was not recorded.';
      return 'No eligible reviewer is set up for this request. Ask HR to repair the reviewer list; nothing was sent.';
    case 'WORKFLOW_NOT_CONFIGURED':
      return 'No approval route is set up for this yet. Ask the administrator to configure it; nothing was recorded.';
    case 'RETRY':
      return 'Your change met another change at the same moment. Try again.';
    default:
      return null;
  }
}

/** `except`: refusals already reported to the screen's notice (see reportGone), so they are not said twice. */
export function Refusal({ error, action, except }: { error: unknown; action: Act; except?: ReadonlySet<string> }) {
  if (!error) return null;
  if (except && error instanceof ApiError && except.has(error.code)) return null;
  const text = refusalText(error, action);
  return text === null ? (
    <ErrorNote error={error} />
  ) : (
    <p role="alert" className="error">
      {text}
    </p>
  );
}

/** What a finished action tells its screen: a confirmation, or (ok false) a refusal that outlives the form. */
export type Done = (text: string, ok?: boolean) => void;

/**
 * Reports a refusal to the screen's notice when it means the form has nothing left to do: once the record reloads,
 * the form is gone (the task, process or exit moved on meanwhile), so its own message would never be seen.
 */
export function reportGone(error: Error, action: Act, codes: ReadonlySet<string>, onDone: Done): void {
  if (error instanceof ApiError && codes.has(error.code)) onDone(refusalText(error, action) ?? error.message, false);
}
