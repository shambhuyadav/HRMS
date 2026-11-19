// Shared parts of the access screens: permission keys, labels, API shapes, styles, dates and the query hooks.

import { type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, useMemo } from 'react';
import { api, formatDate, isForbidden } from '../../api';
import { useSession } from '../../session';

export const READ_USERS = 'access.read_users.operational';
export const ASSIGN_ROLE = 'access.assign_role.operational';
export const APPROVE_GRANT = 'access.approve_role_grant.operational';
export const REVOKE_ROLE = 'access.revoke_role.operational';
/** The organisation masters feed the scope filter pickers and name a grant's restrictions. */
const READ_ORG = 'org_master.read.operational';

export const PAGE_SIZE = 25;
/** GET /v1/access/assignments returns at most this many rows (newest first). */
export const GRANT_LIST_LIMIT = 200;

export type ScopeKind = 'OWN' | 'TEAM' | 'ASSIGNED' | 'COMPANY';
type AccessClass = 'ADMIN' | 'MANAGER' | 'OTHER';
export type OrgKind = 'departments' | 'locations';
type Dimension = OrgKind | 'employees';
export const SCOPES: readonly ScopeKind[] = ['OWN', 'TEAM', 'ASSIGNED', 'COMPANY'];
export const SCOPE_LABEL: Record<ScopeKind, string> = { OWN: 'Own', TEAM: 'Team', ASSIGNED: 'Assigned', COMPANY: 'Company' };
export const CLASS_LABEL: Record<AccessClass, string> = { ADMIN: 'Admin', MANAGER: 'Manager', OTHER: 'Other' };
export const DIMENSIONS: readonly Dimension[] = ['departments', 'locations', 'employees'];
export const DIMENSION_LABEL: Record<Dimension, string> = { departments: 'Departments', locations: 'Locations', employees: 'Employees' };
export const DIMENSION_NOUN: Record<Dimension, string> = { departments: 'department', locations: 'location', employees: 'employee' };

export interface AccessUser {
  userId: string;
  accountKey: string;
  active: boolean;
  employee: { id: string; employeeCode: string; displayName: string } | null;
  assignments: { active: number; pending: number };
}

export interface CataloguePermission {
  key: string;
  confidential: boolean;
  defaultDuty: boolean;
}

export interface CatalogueRole {
  code: string;
  name: string;
  accessClass: AccessClass;
  defaultScope: ScopeKind | null;
  active: boolean;
  permissions: CataloguePermission[];
}

export interface Grant {
  id: string;
  userId: string;
  userAccountKey?: string | null;
  roleCode: string;
  scopeKind: ScopeKind;
  state: 'PENDING' | 'ACTIVE' | 'REVOKED';
  effectiveFrom: string;
  effectiveTo: string | null;
  purpose: string | null;
  requestedBy: string | null;
  requestedByAccountKey?: string | null;
  approvedBy: string | null;
  approvedByAccountKey?: string | null;
  version: number;
  permissions: string[];
  /** The grant's own restrictions (C4): what an approver approves on top of the scope kind. */
  filters?: Partial<Record<Dimension, string[]>> | null;
}

export interface OrgItem {
  id: string;
  code: string;
  name: string;
  active: boolean;
  version: number;
}

export interface ProposalBody {
  userId: string;
  roleCode: string;
  scopeKind: ScopeKind;
  effectiveFrom: string;
  effectiveTo?: string;
  permissions: string[];
  filters?: { departments?: string[]; locations?: string[] };
  purpose?: string;
}

export type RolesQuery = UseQueryResult<{ items: CatalogueRole[] }, Error>;
export type OrgQuery = UseQueryResult<{ items: OrgItem[] }, Error>;

export const SCROLL: CSSProperties = { overflowX: 'auto' };
export const LIST: CSSProperties = { margin: 0, paddingLeft: '1.1rem' };
export const GROUP: CSSProperties = { border: 'none', margin: 0, padding: 0, minWidth: 0 };
export const TEXTAREA: CSSProperties = { font: 'inherit', padding: '0.4rem 0.5rem', border: '1px solid var(--line)', borderRadius: 6, color: 'var(--text)', resize: 'vertical' };

const pad = (n: number) => String(n).padStart(2, '0');

/** A query's data unless the server's latest answer was a refusal: a refusal hides what an earlier answer showed. */
export function shown<T>(q: UseQueryResult<T, Error>): T | undefined {
  return isForbidden(q.error) ? undefined : q.data;
}

/** Effective dates are instants; show the local calendar day (grants are proposed at local midnight). */
export function localDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return formatDate(iso);
  return formatDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
}

export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A date input value (YYYY-MM-DD) as the ISO instant of local midnight on that day. */
export function atLocalMidnight(date: string): string | null {
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Query keys carry the selected company and assignment: the app keeps one query cache across role switches and
 * sign-ins, and an answer given to one assignment must never be shown under another.
 */
export function useAccessKeys() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(() => {
    const base = ['access-admin', context] as const;
    return {
      context,
      allUsers: [...base, 'users'] as const,
      users: (search: string, page: number) => [...base, 'users', search, page] as const,
      roles: [...base, 'roles'] as const,
      allGrants: [...base, 'grants'] as const,
      userGrants: (userId: string) => [...base, 'grants', 'user', userId] as const,
      pending: [...base, 'grants', 'pending'] as const,
      org: (kind: OrgKind) => [...base, 'org', kind] as const,
    };
  }, [context]);
}

export function useRefreshAccess() {
  const qc = useQueryClient();
  const keys = useAccessKeys();
  return () => {
    void qc.invalidateQueries({ queryKey: keys.allGrants });
    void qc.invalidateQueries({ queryKey: keys.allUsers });
  };
}

/** An organisation master list, requested only when the selected assignment can read it (a refusal is audited). */
export function useOrgMaster(kind: OrgKind): OrgQuery {
  const { can } = useSession();
  const keys = useAccessKeys();
  return useQuery({
    queryKey: keys.org(kind),
    // Inactive entries too, so a restriction to a since-deactivated entry still shows its name; pickers offer active ones only.
    queryFn: () => api<{ items: OrgItem[] }>(`/v1/org/${kind}?includeInactive=true`),
    enabled: can(READ_ORG),
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/** How grant rows are labelled: users from loaded user pages or the row's account keys, roles and classification from the catalogue. */
export interface GrantView {
  /** Name and code from loaded user pages, else the account key the grant row carries, else a short id. */
  userLabel(userId: string | null, accountKey?: string | null): string;
  roleName(code: string): string | null;
  /** true/false from the role catalogue; undefined when the catalogue does not list the permission. */
  confidential(key: string): boolean | undefined;
  catalogue: 'loading' | 'loaded' | 'failed';
  /** A restriction entry named from the organisation masters or loaded users, else a short id. */
  restriction(dimension: Dimension, id: string): string;
}

/** The outcome of a decision taken in the pending list, whose row leaves the list once the grant is decided. */
export interface Outcome {
  tone: 'ok' | 'warn';
  text: string;
}

export interface SelectedUser {
  userId: string;
  accountKey: string | null;
}

export const byId = (items: OrgItem[] | undefined) => new Map((items ?? []).map((i): [string, OrgItem] => [i.id, i]));
