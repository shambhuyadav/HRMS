// What the organisation screens share: the duty keys, the four master kinds, a master's refusals in plain words, and the small
// pieces every list of masters, the company and the cities draw the same way.
import { ApiError } from '../../api';
import { Badge, ErrorNote, Notice } from '../../ui';

export const MASTER_READ = 'org_master.read.operational';
export const MASTER_CREATE = 'org_master.create.operational';
export const MASTER_UPDATE = 'org_master.update.operational';
export const REFERENCE_READ = 'reference_value.read.operational';

export type MasterKind = 'departments' | 'locations' | 'designations' | 'grades';

export const KINDS: Readonly<Record<MasterKind, { title: string; noun: string }>> = {
  departments: { title: 'Departments', noun: 'department' },
  locations: { title: 'Locations', noun: 'location' },
  designations: { title: 'Designations', noun: 'designation' },
  grades: { title: 'Grades', noun: 'grade' },
};

/** GET /v1/org/:kind. */
export interface Master {
  id: string;
  code: string;
  name: string;
  active: boolean;
  validFrom: string | null;
  validTo: string | null;
  version: number;
}

/** Refusals in plain words, by code; any other is shown as the server sent it. */
function refusalText(error: unknown, noun: string): string | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    case 'MASTER_IN_USE': {
      const assignments = (error.details as { assignments?: unknown } | undefined)?.assignments;
      const who = typeof assignments === 'number' ? `${assignments} employee ${assignments === 1 ? 'assignment' : 'assignments'}` : 'Employee assignments';
      return `This ${noun} is still in use: ${who} would fall outside it. Move them to another ${noun} first. Nothing was changed.`;
    }
    case 'STALE_VERSION':
      return `This ${noun} changed since you opened it. It has been reloaded; check the values shown and save again.`;
    case 'DUPLICATE':
      return `Another ${noun}, active or inactive, already has this code.`;
    case 'INVALID_PERIOD':
      return 'The end of the period must be after its start.';
    case 'INVALID_REQUEST':
      return 'Check the values. A code starts with a letter or digit and uses only letters, digits, hyphens and underscores, up to 40 characters; a name cannot be blank.';
    case 'FORBIDDEN':
      return 'Your role cannot change this. Masters are changed under this duty with company-wide scope and no department, location or employee filter.';
    default:
      return null;
  }
}

export function Refusal({ error, noun }: { error: unknown; noun: string }) {
  const words = refusalText(error, noun);
  if (!words) return <ErrorNote error={error} />;
  return <Notice notice={{ text: words, ok: false }} />;
}

/** A master's, the company's or a city's state, in words. */
export function ActiveBadge({ active }: { active: boolean }) {
  return active ? <Badge tone="good">active</Badge> : <Badge>inactive</Badge>;
}

/** A date or a code stays on one line ("1 Jan 2026", not "1 Jan" over "2026"). */
export const ONE_LINE = 'whitespace-nowrap';
