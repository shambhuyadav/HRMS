// Refusals of the employee routes in plain words, and the refusal and read-problem lines.

import { ApiError } from '../../api';
import { Empty, ErrorNote } from '../../ui';
import { words } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------------------

/** The requirements ACTIVATION_REQUIREMENTS_MISSING names, each with where to fix it. */
const MISSING_REQUIREMENTS: Readonly<Record<string, string>> = {
  WORK_EMAIL: 'A work email. Add one under Edit details.',
  JOB_ASSIGNMENT: 'A job assignment in force on that date. Add one under Transfer.',
  SHIFT_ASSIGNMENT: 'An active shift in force on that date. Add one under Change shift.',
  MANAGER_OR_NO_MANAGER_REASON: 'A manager in force on that date, or a reason for having none. Use Change manager, or type the reason here.',
};

const FIELD_WORDS: Readonly<Record<string, string>> = {
  employeeCode: 'employee code: it starts with a letter or digit and uses only letters, digits, hyphens and underscores, up to 40 characters',
  displayName: 'name',
  workEmail: 'work email',
  workPhoneExtension: 'work phone extension: 1 to 8 digits',
  joiningDate: 'joining date',
  effectiveFrom: 'date',
  dateOfBirth: 'date of birth',
  serviceAnniversaryDate: 'service anniversary base date',
};

const GENERIC_RULE = 'The change violates a business rule';

function periodWords(from: string | null, to: string | null): string {
  if (from && to) return `It applies from ${from} until ${to}, not included.`;
  if (to) return `It applies until ${to}, not included.`;
  if (from) return `It applies from ${from}.`;
  return '';
}

function chronologyWords(details: { conflict?: string; effectiveFrom?: string; lastWorkingDate?: string }): string {
  switch (details.conflict) {
    case 'BIRTH_DATE':
      return 'The joining date must be after the date of birth.';
    case 'ASSIGNMENT':
      return `A later job assignment starts on ${details.effectiveFrom}, so the joining date must be before it.`;
    case 'MANAGER':
      return `A manager period starts on ${details.effectiveFrom}, so the joining date cannot be after it.`;
    case 'SHIFT':
      return `A shift period starts on ${details.effectiveFrom}, so the joining date cannot be after it.`;
    case 'PRIOR_EMPLOYMENT':
      return `The new employment must start after the last working date of the prior one, ${details.lastWorkingDate}.`;
    default:
      return 'The date conflicts with the dates already on this record.';
  }
}

/** A refusal in plain words, by code; any other is shown as the server sent it. `rule` names the likely rule of a generic refusal. */
export function refusalText(error: unknown, rule?: string): string | null {
  if (!(error instanceof ApiError)) return null;
  const details = (error.details ?? {}) as Record<string, string | undefined>;
  const outside = /^(DEPARTMENT|LOCATION|DESIGNATION|GRADE)_OUTSIDE_VALID_PERIOD$/.exec(error.code);
  if (outside) {
    const noun = outside[1]!.toLowerCase();
    return `This ${noun} is not valid on ${details.date}. ${periodWords(details.validFrom ?? null, details.validTo ?? null)} Choose another ${noun} or another date.`.replace(/\s+/g, ' ');
  }
  switch (error.code) {
    case 'STALE_VERSION':
      return 'This employee changed since you opened this. The record has been reloaded; check it and try again. What you typed is still here.';
    case 'INVALID_STATE':
      return 'This employee is no longer a draft, so this cannot be done. The record has been reloaded.';
    case 'DUPLICATE':
      return 'Another employee already has this employee code or work email.';
    case 'INVALID_REFERENCE':
      return `That choice cannot be used. ${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}.`;
    case 'CHANGE_NOT_LATEST':
      return 'A change on or after this date is already recorded. A new change must start after the latest one, so use a later date.';
    case 'RULE_VIOLATION':
      return error.message === GENERIC_RULE ? (rule ?? 'The server refused this because it breaks a business rule. Check the dates and values.') : `${error.message}.`;
    case 'REASON_REQUIRED':
      return 'Removing a manager needs a reason. Type one and try again.';
    case 'SELF_ACTION_NOT_ALLOWED':
      return 'This change involves your own record, so another administrator must make it.';
    case 'NO_CHANGE':
      return 'That is already the joining date.';
    case 'CHRONOLOGY_CONFLICT':
      return chronologyWords(details);
    case 'PRIOR_EMPLOYMENT_NOT_ENDED':
      return 'The prior employment has not ended, so this one cannot follow it.';
    case 'EMPLOYMENT_ENDED':
      return 'The employment has ended, so no shift can be assigned.';
    case 'AFTER_LAST_WORKING_DATE':
      return `A shift cannot start after the approved last working date, ${details.lastWorkingDate}.`;
    case 'USER_LINK_OPEN':
      return 'A user account is still linked to this employee. End that link under User accounts first.';
    case 'FORBIDDEN':
      return 'Your role is not permitted to do this for this employee.';
    case 'INVALID_VALUE':
      return 'A date or value is not valid. Check it and try again.';
    case 'INVALID_WORK_PHONE_EXTENSION':
      return 'A work phone extension is 1 to 8 digits, with nothing else. Check it and try again.';
    case 'INVALID_REQUEST': {
      const field = /(?:body\/|property ')(\w+)/.exec(error.message)?.[1];
      return `The server did not accept the ${(field && FIELD_WORDS[field]) ?? 'values typed'}. Check and try again.`;
    }
    default:
      return null;
  }
}

export function Refusal({ error, rule }: { error: unknown; rule?: string }) {
  if (error instanceof ApiError && error.code === 'ACTIVATION_REQUIREMENTS_MISSING') {
    const details = (error.details ?? {}) as { missing?: string[]; checkDate?: string };
    return (
      <div role="alert" className="error">
        <p>This employee cannot be activated yet. The check date is {details.checkDate}. Still missing:</p>
        <ul>
          {details.missing?.map((code) => (
            <li key={code}>{MISSING_REQUIREMENTS[code] ?? words(code)}</li>
          ))}
        </ul>
      </div>
    );
  }
  const text = refusalText(error, rule);
  if (!text) return <ErrorNote error={error} />;
  return (
    <p role="alert" className="error">
      {text}
    </p>
  );
}

/** A record the server would not read: out of scope and nonexistent are the same answer. */
export function ReadProblem({ error }: { error: unknown }) {
  if (error instanceof ApiError && (error.status === 404 || error.status === 400)) return <Empty>This employee was not found, or is outside the scope of your role.</Empty>;
  if (error instanceof ApiError && error.status === 403) return <Empty>Your role is not permitted to read this.</Empty>;
  return <ErrorNote error={error} />;
}
