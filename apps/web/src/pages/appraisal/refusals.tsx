// Appraisal refusals in plain words, and how a failed query is shown.
import { ApiError, formatDate, isForbidden, readable } from '../../api';
import { Empty, ErrorNote, NotPermitted } from '../../ui';
import { goalList, MONTH_NAME, STAGE_LABEL, windowText } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Refusals in plain words
// ---------------------------------------------------------------------------------------------------------
type Act =
  | 'setting'
  | 'cycle-create'
  | 'cycle-update'
  | 'cycle-close'
  | 'enrol'
  | 'goals'
  | 'goal-review'
  | 'exception'
  | 'cancel'
  | 'rating'
  | 'decide'
  | 'self-entry'
  | 'submit'
  | 'export'
  | 'upload'
  | 'commit'
  | 'discard'
  | 'scoring'
  | 'competency'
  | 'competency-set';

const isCycleAct = (a: Act) => a === 'setting' || a === 'scoring' || a.startsWith('cycle') || a.startsWith('competency');
const sectionTitle = (code: unknown) =>
  typeof code === 'string' ? ({ IMPROVEMENT_AREAS: 'areas for improvement', TRAINING_NEEDS: 'training needs', ACTIVITY_PERFORMANCE: 'activity performance', STRETCHED_KPIS: 'stretched KPIs' }[code] ?? readable(code).toLowerCase()) : 'section';
/** What is still missing from a self-entry or rating (goals and competencies by number, sections by name). */
function missingText(d: Record<string, unknown>): string {
  const parts: string[] = [];
  const goals = goalList(d.goals);
  if (goals) parts.push(`goal ${goals}`);
  const competencies = goalList(d.competencies);
  if (competencies) parts.push(`competency ${competencies}`);
  if (Array.isArray(d.sections) && d.sections.length > 0) parts.push(`the ${d.sections.map(sectionTitle).join(' and ')} section${d.sections.length > 1 ? 's' : ''}`);
  return parts.length > 0 ? `: still missing ${parts.join(', ')}` : '';
}

const INVALID_STATE_TEXT: Partial<Record<Act, string>> = {
  exception: 'The appraisal is finished, so no exception can be recorded.',
  cancel: 'A completed or cancelled appraisal cannot be cancelled.',
  rating: 'The appraisal is not waiting for a rating any more.',
  decide: 'The appraisal is not waiting for this decision any more.',
  'self-entry': 'The self-entry can change only before it is submitted.',
  submit: 'Only a draft or returned appraisal can be submitted.',
};

/** A refusal in plain words; null for anything else, which is shown as the API sent it. */
export function refusalText(error: unknown, action: Act): string | null {
  if (!error) return null;
  if (!(error instanceof ApiError)) {
    return action === 'decide'
      ? 'No answer came back, so your decision may or may not have been recorded. Send the same decision again: it is never applied twice.'
      : 'No answer came back, so the change may or may not have been saved. Reload the page to check before trying again.';
  }
  const d = (error.details ?? {}) as Record<string, unknown>;
  const stageOf = (v: unknown) => (typeof v === 'string' ? (STAGE_LABEL[v] ?? readable(v)).toLowerCase() : 'entry');
  switch (error.code) {
    case 'FORBIDDEN':
      return isCycleAct(action)
        ? 'The selected role is not permitted to do this. Appraisal configuration needs an unrestricted company-scope assignment.'
        : 'The selected role is not permitted to do this.';
    case 'NOT_FOUND':
      if (action === 'decide' || action === 'rating') return 'This task is no longer assigned to you.';
      if (action === 'enrol') return 'The cycle or the employee is not available in the selected role’s scope.';
      if (isCycleAct(action)) return 'This cycle is not available.';
      if (action === 'commit' || action === 'discard') return 'This upload is not available any more.';
      return 'This appraisal is not available in the selected role’s scope.';
    case 'STALE_VERSION':
      return 'It changed since it was loaded. It has been reloaded: check it and try again.';
    case 'INVALID_STATE':
      return INVALID_STATE_TEXT[action] ?? null;
    case 'APPRAISAL_NOT_CONFIGURED':
      return 'Set the cycle start month first: cycles cannot be created until it is set.';
    case 'CYCLE_START_NOT_ALIGNED': {
      const month = MONTH_NAME[Number(d.cycleStartMonth)];
      return `A cycle starts on the 1st of ${month ?? 'the configured cycle start month'}${month ? ', the configured cycle start month' : ''}.`;
    }
    case 'INVALID_CODE':
      return 'Use 1 to 40 letters, digits, hyphens or underscores for the code.';
    case 'CYCLE_CODE_EXISTS':
      return 'A cycle with this code already exists.';
    case 'INVALID_WINDOW':
      return `The ${stageOf(d.stage)} window closes before it opens.`;
    case 'WINDOW_ORDER':
      return `Windows follow the process order: goal setting, then self-entry, then manager rating. The ${stageOf(d.later)} window opens or closes before the ${stageOf(d.earlier)} window.`;
    case 'LEVELS_FIXED':
      return 'The reviewer levels cannot change once an appraisal of this cycle has been submitted.';
    case 'RULES_FIXED':
      return 'The goal review and the rating mode cannot change once an appraisal of this cycle has been submitted.';
    // I-86: the result split, competencies and sections.
    case 'SPLIT_NOT_100':
      return 'The goal and competency percentages are whole numbers that add up to exactly 100 (goals at least 1).';
    case 'APPRAISAL_SCORING_NOT_CONFIGURED':
      return 'No goal and competency split is in force on the cycle start date. Set one in the competency settings, or give the cycle its own.';
    case 'COMPETENCY_USE_FIXED':
      return 'Whether this cycle assesses competencies cannot change: an appraisal is already enrolled in it. The split itself can still change until one is submitted.';
    case 'UNKNOWN_SECTION':
    case 'DUPLICATE_SECTION':
      return 'Choose each section once, from the section list.';
    case 'SECTION_NOT_INCLUDED':
      return `This cycle does not include the ${sectionTitle(d.section)} section.`;
    case 'SECTION_NOT_FILLED_BY_YOU':
      return `The ${sectionTitle(d.section)} section is filled by ${action === 'self-entry' ? 'the manager' : 'the employee'}.`;
    case 'UNKNOWN_COMPETENCY':
    case 'DUPLICATE_COMPETENCY':
      return action === 'competency-set' ? 'Choose each competency once, from the competency list.' : 'The competencies changed since this was loaded. Reload and try again.';
    case 'INVALID_INDICATORS':
      return 'Describe each proficiency level 1 to 5 with one behavioural indicator.';
    case 'COMPETENCY_CODE_EXISTS':
      return 'A competency with this code already exists.';
    case 'COMPETENCY_IN_USE':
      return 'This competency is used in a set that is still in force: replace or end that set first. The start of a competency in use is fixed.';
    case 'COMPETENCY_ENDED':
      return 'An ended competency stays ended; add a new competency instead.';
    case 'COMPETENCY_NOT_ACTIVE':
      return 'Each competency in a set is active from the set’s start date and has no end date.';
    case 'COMPETENCIES_REQUIRED':
      return 'A set holds 1 to 50 competencies.';
    case 'UNKNOWN_GRADE':
      return 'Choose a grade.';
    case 'UNKNOWN_DESIGNATION':
      return 'Choose a designation, or none.';
    case 'SET_ALREADY_PLANNED':
      return 'A set for this grade and designation already starts on or after that date; choose a later start date.';
    case 'SET_OVERLAP':
      return 'A set for this grade and designation is already in force past that date.';
    case 'SET_ENDED':
      return 'This set already has its end date.';
    case 'EFFECTIVE_DATE_IN_PAST':
      return 'A new revision starts today or later; earlier periods are not changed.';
    case 'REVISION_ALREADY_PLANNED':
      return 'A split already starts on or after that date; choose a later start date.';
    case 'INVALID_DATE_RANGE':
      return 'The end date is after the start date.';
    case 'REVIEW_DUE_REQUIRED':
      return 'Set the review due date: with reviewer levels, the date reviewer confirmations are due is required.';
    case 'REVIEW_DUE_NOT_USED':
      return 'A cycle without reviewer levels has no reviewer confirmations, so leave the review due date empty.';
    case 'REVIEW_DUE_BEFORE_RATING':
      return `Reviewer confirmations cannot be due before the manager-rating window closes${typeof d.ratingClosesOn === 'string' ? ` (${formatDate(d.ratingClosesOn)})` : ''}.`;
    case 'GOALS_NOT_REVIEWED':
      return 'Your goals have not been reviewed yet, so they have not taken effect. You can enter your self-entry once they are.';
    case 'GOAL_REVIEW_NOT_REQUIRED':
      return 'This cycle does not review goals: they take effect when set.';
    case 'GOAL_REVIEW_NOT_INDEPENDENT':
      return 'You set these goals, so someone else reviews them.';
    case 'GOALS_ALREADY_REVIEWED':
      return 'These goals have already been reviewed.';
    case 'GOALS_SETTER_UNKNOWN':
      return 'These goals were set before goal reviews were recorded. Save the goals again, then someone else reviews them.';
    case 'OVERALL_RATING_REQUIRED':
      return 'Choose and save the overall rating before submitting the rating: this cycle rates manually.';
    case 'OVERALL_RATING_NOT_USED':
      return 'This cycle rates by the weighted formula, so there is no overall rating to enter.';
    case 'REVIEWER_SCORE_REQUIRED':
      return 'Choose your overall score (1 to 5) to confirm the rating.';
    case 'REVIEWER_SCORE_NOT_USED':
      return 'A reviewer score is given only with a confirmation.';
    case 'CYCLE_CLOSED':
      return action === 'cycle-close' ? 'The cycle is already closed.' : 'The appraisal cycle is closed.';
    case 'OPEN_APPRAISALS': {
      const open = Number(d.open);
      return `Complete or cancel every appraisal of the cycle before closing it${Number.isFinite(open) ? `: ${open} ${open === 1 ? 'is' : 'are'} still open` : ''}.`;
    }
    case 'SELF_ACTION_NOT_ALLOWED':
      return 'You cannot manage your own appraisal: another authorised user does that.';
    case 'EMPLOYEE_NOT_ACTIVE':
      return 'Only an active employee can be appraised.';
    case 'JOINED_AFTER_CYCLE':
      return 'The employee joined after this cycle ends.';
    case 'APPRAISAL_EXISTS':
      return 'The employee already has an appraisal in this cycle.';
    case 'CYCLE_OVERLAP':
      return 'The employee already has an appraisal in an overlapping cycle.';
    case 'INVALID_SEQUENCE':
      return 'Goal sequences are whole numbers from 1 to 100.';
    case 'DUPLICATE_SEQUENCE':
      return `Each goal needs its own sequence number${d.sequence !== undefined ? `: ${String(d.sequence)} is used twice` : ''}.`;
    case 'INVALID_WEIGHT':
      return 'Goal weights are whole numbers from 1 to 100.';
    case 'FIELD_REQUIRED':
      return d.sequence !== undefined ? `Goal ${String(d.sequence)} needs a description.` : d.field === 'reason' ? 'Enter a reason.' : 'Fill in every required field.';
    case 'GOALS_FIXED':
      return action === 'goal-review' ? 'Goals are reviewed before the appraisal is first submitted.' : 'Goals are fixed once the appraisal has been submitted.';
    case 'WINDOW_CLOSED':
      return `The ${stageOf(d.stage)} window is not open today (${windowText({ opensOn: (d.opensOn as string | null) ?? null, closesOn: (d.closesOn as string | null) ?? null }).toLowerCase()}) and no exception is recorded${action === 'self-entry' || action === 'submit' ? '. Ask HR for an exception if you need more time.' : '.'}`;
    case 'INVALID_DATE':
      return d.field === 'validUntil' ? 'An exception is valid through today or a later date.' : 'Enter a valid calendar date.';
    case 'TASK_CLOSED':
      return 'This task has already been decided.';
    case 'NOT_RATING_TASK':
      return 'Only the rating step enters manager scores.';
    case 'UNKNOWN_GOAL':
    case 'DUPLICATE_GOAL':
      return 'The goals changed since this was loaded. Reload and try again.';
    case 'RATING_INCOMPLETE': {
      const goals = goalList(d.goals);
      if (goalList(d.competencies) || (Array.isArray(d.sections) && d.sections.length > 0)) {
        return `Score every goal and competency and fill every included section, and save, before submitting the rating${missingText(d)}.`;
      }
      return `Score every goal and save before submitting the rating${goals ? `: goal ${goals} ${Array.isArray(d.goals) && d.goals.length > 1 ? 'have' : 'has'} no saved score` : ''}.`;
    }
    case 'EMPLOYEE_MESSAGE_REQUIRED':
      return 'Tell the employee what to revise before returning the appraisal.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'Nothing was recorded: this attempt was matched to a different decision. Send your decision again.';
    case 'GOALS_REQUIRED':
      return 'The appraisal has no goals yet. Ask HR or your manager to set them.';
    case 'WEIGHT_TOTAL_NOT_100': {
      const total = typeof d.total === 'number' ? d.total : null;
      if (action === 'competency-set') return `The competency weights total ${total ?? 'something other than 100'}; they must total exactly 100.`;
      return `The goal weights total ${total ?? 'something other than 100'}; they must total exactly 100 before the appraisal can be submitted.${action === 'submit' ? ' Ask HR or your manager to correct the goals.' : ''}`;
    }
    case 'SELF_ENTRY_INCOMPLETE': {
      const goals = goalList(d.goals);
      if (goalList(d.competencies) || (Array.isArray(d.sections) && d.sections.length > 0)) {
        return `Score every goal and competency and fill every section this cycle asks of you, and save, before submitting${missingText(d)}.`;
      }
      return `Score every goal and save before submitting${goals ? `: goal ${goals} ${Array.isArray(d.goals) && d.goals.length > 1 ? 'have' : 'has'} no saved score` : ''}.`;
    }
    case 'NO_ELIGIBLE_REVIEWER':
      return action === 'decide'
        ? 'No eligible reviewer is left for the next step. Ask HR to add a reviewer to the appraisal reviewer list; your decision was not recorded.'
        : 'No eligible rater or reviewer is set up for this appraisal. Ask HR to repair the reviewer list; nothing was submitted.';
    case 'WORKFLOW_NOT_CONFIGURED':
      return 'No approval route is set up for appraisals yet. Ask HR to configure it; nothing was submitted.';
    case 'EMPLOYEE_CONTEXT_REQUIRED':
      return 'Select your Employee role to work on your own appraisal.';
    case 'EXPORT_TOO_LARGE':
      return `An export holds at most ${typeof d.limit === 'number' ? d.limit.toLocaleString('en-IN') : 'a limited number of'} rows; narrow it with the department filter. Nothing was cut off.`;
    case 'INVALID_HEADER':
      return 'The file’s first line is not the APPRAISAL_GOALS_V1 header: cycleCode,employeeCode,sequence,description,target,weight.';
    case 'IDEMPOTENCY_KEY_IN_USE':
      return 'This upload attempt was already used. Choose the file again and upload it.';
    // FR-106: an upload is read only once the malware scan has released it (imports/jobs.ts).
    case 'FILE_QUARANTINED':
      return 'The malware scan flagged this file, so nothing in it was read or applied. Upload a clean copy of the file.';
    case 'FILE_NOT_RELEASED':
      return 'The file is still waiting for the malware scan, so it cannot be committed yet. Check the scan again later.';
    case 'FILE_INTEGRITY':
      return 'The file stored for this upload no longer matches what was uploaded, so it was not read. Discard this upload and upload the file again.';
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

export function QueryProblem({ error, forbidden }: { error: unknown; forbidden: string }) {
  if (!error) return null;
  if (isForbidden(error)) return <NotPermitted>{forbidden}</NotPermitted>;
  if (error instanceof ApiError && error.code === 'EMPLOYEE_CONTEXT_REQUIRED') return <Empty>{refusalText(error, 'submit')}</Empty>;
  return <ErrorNote error={error} />;
}
