// What the user account and reference value screens share: the duty keys, the API's shapes of an account and its links, and the
// class list their dates and codes draw with.

export const READ_USERS = 'access.read_users.operational';
export const LINK_USER = 'access.link_user.operational';
export const DEACTIVATE_USER = 'access.deactivate_user.operational';
/** Create, edit, delete and reset the password of an account. */
export const MANAGE_ACCOUNTS = 'access.manage_accounts.operational';
export const READ_REFERENCE = 'reference_value.read.operational';
export const MANAGE_REFERENCE = 'reference_value.manage.operational';

/** GET /v1/access/users: one account of the company, with its employee link in force. */
export interface CompanyUser {
  userId: string;
  accountKey: string;
  active: boolean;
  version: number;
  employee: { id: string; employeeCode: string; displayName: string } | null;
  assignments: { active: number; pending: number };
}

/** GET /v1/access/user-links. */
export interface UserLink {
  id: string;
  userId: string;
  accountKey: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  inForce: boolean;
  version: number;
}

/** A date or a code stays on one line ("5 Jan 2026", not "5 Jan" over "2026"). */
export const ONE_LINE = 'whitespace-nowrap';
