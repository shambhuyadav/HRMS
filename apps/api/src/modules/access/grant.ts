// Questions about an access grant that many modules ask in the same way.
import { HttpError } from '../../http/errors.js';
import type { AccessGrant } from './authorize.js';

/** The grant covers the whole company: company scope with no department, location or employee filter. */
export function isCompanyWide(grant: AccessGrant): boolean {
  const { departments, locations, employees } = grant.filters;
  return grant.scopeKind === 'COMPANY' && departments.length + locations.length + employees.length === 0;
}

/** The employee record the signed-in user is linked to; refused (403) when there is none. */
export function ownEmployee(grant: AccessGrant): string {
  if (!grant.linkedEmployeeId) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  return grant.linkedEmployeeId;
}
