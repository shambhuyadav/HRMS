// Shared parts of the asset screens: permission keys, paths, labels, query keys and small helpers.

import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef } from 'react';
import { idempotencyKey, isForbidden, isNotFound, readable } from '../../api';
import { type MeContext, useSession } from '../../session';
import { Badge } from '../../ui';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (modules/assets/registration.ts, routes.ts; migration 0049_assets.sql) and screen paths
// ---------------------------------------------------------------------------------------------------------
/** GET /v1/assets, /v1/assets/:id, /v1/asset-categories (company-wide) and /v1/employees/:id/assets (row scope). */
export const ASSET_READ = 'asset.read.operational';
/** POST /v1/assets, PATCH /v1/assets/:id, POST /v1/assets/:id/retire. */
export const ASSET_MANAGE = 'asset.manage.operational';
/** POST /v1/assets/:id/issue and /return. */
export const ASSET_CUSTODY = 'asset.custody.operational';
/** POST /v1/me/asset-acknowledgments (Employee OWN context). */
export const ASSET_ACKNOWLEDGE = 'asset.acknowledge.operational';
/** GET /v1/me/asset-categories, POST /v1/me/asset-requests and its withdrawal (Employee OWN context). */
export const REQUEST_SUBMIT = 'asset_request.submit.operational';
/** GET /v1/asset-requests (row scope) and /v1/employees/:id/asset-requests. */
export const REQUEST_READ = 'asset_request.read.operational';
/** GET /v1/asset-requests/tasks/mine and the decision. */
export const REQUEST_DECIDE = 'asset_request.decide.operational';
/** GET /v1/employees: whom to issue an item to. */
export const EMPLOYEE_LIST = 'employee.list.operational';
/** The own-ESS role: own items, acknowledgments and requests are served only in the Employee OWN context (BR-055). */
const OWN_ESS_ROLE = 'EMPLOYEE';

export const PATHS = {
  register: '/assets',
  asset: (id: string) => `/assets/items/${id}`,
  employee: (id: string) => `/assets/employees/${id}`,
  requests: '/assets/requests',
} as const;

export const PAGE_SIZE = 25;
export const ASSET_STATES = ['IN_STOCK', 'ISSUED', 'RETURNED_TO_STOCK', 'RETIRED'] as const;
export const STATE_LABEL: Record<string, string> = { IN_STOCK: 'In stock', ISSUED: 'Issued', RETURNED_TO_STOCK: 'Returned to stock', RETIRED: 'Retired (final)' };
const STATE_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = { IN_STOCK: 'good', ISSUED: 'warn', RETURNED_TO_STOCK: 'good', RETIRED: 'neutral' };
const REQUEST_LABEL: Record<string, string> = { SUBMITTED: 'Waiting for a decision', APPROVED: 'Approved', REJECTED: 'Rejected', WITHDRAWN: 'Withdrawn' };
const REQUEST_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = { SUBMITTED: 'warn', APPROVED: 'good', REJECTED: 'bad', WITHDRAWN: 'neutral' };
export const DECISION_LABEL: Record<string, string> = { APPROVE: 'Approved', REJECT: 'Rejected' };
/** GET /v1/asset-requests filters: a state, or approved requests no item has been issued for yet. */
export const REQUEST_FILTERS: readonly (readonly [value: string, label: string])[] = [
  ['', 'All requests'],
  ['SUBMITTED', 'Waiting for a decision'],
  ['UNFULFILLED', 'Approved, waiting for an item'],
  ['APPROVED', 'Approved'],
  ['REJECTED', 'Rejected'],
  ['WITHDRAWN', 'Withdrawn'],
];

// ---------------------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------------------

/**
 * Query keys carry the selected company and assignment: the app keeps one query cache across role switches, and an
 * answer given to one assignment (the register, a reviewer's queue) must never be shown under another.
 */
export function useKeys() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(() => {
    const base = ['assets', context] as const;
    return {
      all: base,
      categories: [...base, 'categories'] as const,
      register: (query: string) => [...base, 'register', query] as const,
      asset: (id: string) => [...base, 'asset', id] as const,
      employeeAssets: (id: string, status: string) => [...base, 'employee-assets', id, status] as const,
      employeeRequests: (id: string) => [...base, 'employee-requests', id] as const,
      requests: (query: string) => [...base, 'requests', query] as const,
      tasks: [...base, 'tasks'] as const,
      ownCategories: [...base, 'own-categories'] as const,
      employeeSearch: (term: string) => [...base, 'employee-search', term] as const,
    };
  }, [context]);
}

/** After any change everything this module shows in the selected context is fetched again (never optimistic). */
export function useRefetchAll() {
  const qc = useQueryClient();
  const keys = useKeys();
  return () => qc.invalidateQueries({ queryKey: keys.all });
}

/**
 * One idempotency key per user action: sending the same action again (same content) after a lost answer or a refusal
 * reuses its key, so it is never applied twice; a different action, or the next one after a success, gets a new key.
 */
export function useAttemptKey(prefix: string) {
  const last = useRef<{ signature: string; key: string } | null>(null);
  return useMemo(
    () => ({
      keyFor(signature: string): string {
        if (last.current?.signature !== signature) last.current = { signature, key: idempotencyKey(prefix) };
        return last.current.key;
      },
      reset() {
        last.current = null;
      },
    }),
    [prefix],
  );
}

/** The latest answer, unless the server has since refused it (403/404): what the role may no longer see is not kept. */
export function shown<T>(query: { data: T | undefined; error: unknown }): T | undefined {
  return isForbidden(query.error) || isNotFound(query.error) ? undefined : query.data;
}

export const inOwnContext = (me: MeContext | null) => me !== null && me.roleCode === OWN_ESS_ROLE && me.scopeKind === 'OWN' && me.employeeId !== null;
export const holderLabel = (p: { employeeName?: string | undefined; employeeCode?: string | undefined }) =>
  p.employeeName ? (p.employeeCode ? `${p.employeeName} (${p.employeeCode})` : p.employeeName) : (p.employeeCode ?? '—');
export const optional = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? '—' : v);
export const dateIn = (text: string | undefined) => /\d{4}-\d{2}-\d{2}/.exec(text ?? '')?.[0];

export function AssetState({ state }: { state: string }) {
  return <Badge tone={STATE_TONE[state] ?? 'neutral'}>{STATE_LABEL[state] ?? readable(state)}</Badge>;
}
export function RequestState({ state }: { state: string }) {
  return <Badge tone={REQUEST_TONE[state] ?? 'neutral'}>{REQUEST_LABEL[state] ?? readable(state)}</Badge>;
}
