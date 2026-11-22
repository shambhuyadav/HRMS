// The biometric API's refusals in plain words, mapping errors included.
import { ApiError } from '../../api';
import { ErrorNote, Notice } from '../../ui';

const REFUSALS: Readonly<Record<string, string>> = {
  STALE_VERSION: 'This changed since you opened it. It has been reloaded; review it and try again.',
  INVALID_STATE: 'This has already been done. The list has been reloaded.',
  MAPPING_NOT_APPROVED: 'Activation needs an approved mapping revision that is in force.',
  SELF_APPROVAL: 'Whoever wrote a mapping revision cannot approve it; someone else must.',
  OVERLAPPING_PERIOD: 'This overlaps an existing period for the same identity, employee or profile. A revision must start after the one in force; a link needs a free period.',
  INVALID_PERIOD: 'The dates do not fit: an end must be after the start, and a move must fall inside the link’s period.',
  LINK_ENDED: 'This link has already ended. Add a new link instead.',
  NO_CHANGE: 'The link already points to this employee.',
  SELF_ACTION_NOT_ALLOWED: 'You cannot do this on your own employee record; another administrator must.',
  INVALID_REFERENCE: 'That employee is not in this company.',
  DUPLICATE: 'This code is already in use.',
  RUN_IN_PROGRESS: 'A run of this profile is already in progress. Wait for it to end; one that stopped responding ends by itself after its lease.',
  PROFILE_INACTIVE: 'This profile is disabled, so it starts no new runs. Punches already made stay on record.',
  PROVIDER_NOT_CONFIGURED: 'No provider connection is set up for this profile, so nothing can run yet. It needs the device owner’s private provider contract.',
  STILL_UNMATCHED: 'No employee link covers this identity at that time. Add the link in Employee Mapping first.',
  NOT_REPROCESSABLE: 'This event can no longer be reprocessed. The list has been reloaded.',
  NOT_CORRECTABLE: 'This event can no longer be corrected. The list has been reloaded.',
  TIME_NOT_THE_SOURCE_READING: 'The time must read as the device recorded it, in the provider’s time zone. Check the UTC offset.',
  TIME_IN_FUTURE: 'A punch cannot lie in the future.',
};

const MAPPING_ERRORS: Readonly<Record<string, string>> = {
  EMPLOYEE_KEY_REQUIRED: 'the employee identity must be mapped and required',
  PUNCH_INSTANT_REQUIRED: 'the punch time must be mapped and required',
  DIRECTION_OR_APPROVED_DEFAULT_REQUIRED: 'the direction must be required or have a default',
  DIRECTION_ENUM_INVALID: 'the direction values must map to IN or OUT',
  EVENT_KEY_REQUIRED_FOR_STRATEGY: 'duplicates by provider event key need the event key mapped and required',
};

export function Refusal({ error }: { error: unknown }) {
  if (!(error instanceof ApiError)) return <ErrorNote error={error} />;
  if (error.code === 'MAPPING_INVALID') {
    const errors = (error.details as { errors?: string[] } | undefined)?.errors ?? [];
    const words = errors.map((code) => (code.startsWith('INVALID_PATH:') ? `the source path of ${code.slice(13)} is not a plain field path` : (MAPPING_ERRORS[code] ?? code)));
    return <Notice notice={{ text: `This mapping cannot be used: ${words.join('; ')}.`, ok: false }} />;
  }
  const words = REFUSALS[error.code];
  if (!words) return <ErrorNote error={error} />;
  return <Notice notice={{ text: words, ok: false }} />;
}
