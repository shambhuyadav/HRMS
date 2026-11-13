// The System Administrator's decisions on the decision inbox (FR-096 "pending tasks"; F2 "Pending independent access grants"):
// role grants, delegations and role-permission changes waiting for an independent approver. Each queue lists what waits and
// leads to the screen that shows everything a decision needs (the grant's permissions and restrictions, the delegation's
// decisions) and takes it; the server decides who may approve, and these lists only say when the viewer cannot.
import { useQuery } from '@tanstack/react-query';
import type { ComponentType, ReactNode } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { api, formatDate } from '../api';
import { useSession } from '../session';
import { Empty, ErrorNote, scopeWords, Section } from '../ui';

const APPROVE = 'access.approve_role_grant.operational';
const READ_USERS = 'access.read_users.operational';

/** The selected company and assignment: one role's queue is never shown under another (prefix ['tasks'] still refreshes it). */
function useContextKey() {
  const { stored } = useSession();
  return `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
}

function Review({ to, children }: { to: string; children: ReactNode }) {
  // Outside a router (a test of one panel) the words stay, without the link.
  return useInRouterContext() ? <Link to={to}>{children}</Link> : <span>{children}</span>;
}

const words = (code: string) => code.replace(/_/g, ' ').toLowerCase();

interface PendingGrant {
  id: string;
  userAccountKey?: string | null;
  roleCode: string;
  scopeKind: string;
  effectiveFrom: string;
  requestedByAccountKey?: string | null;
}

function AccessGrantQueue() {
  const { me, can } = useSession();
  const context = useContextKey();
  const pending = useQuery({
    queryKey: ['tasks', 'access-grants', context],
    queryFn: () => api<{ items: PendingGrant[]; total?: number }>('/v1/access/assignments?state=PENDING'),
    enabled: can(READ_USERS),
  });
  const roles = useQuery({
    queryKey: ['tasks', 'access-roles', context],
    queryFn: () => api<{ items: { code: string; name: string }[] }>('/v1/access/roles'),
    enabled: can(READ_USERS),
    staleTime: 5 * 60_000,
  });
  const roleName = (code: string) => roles.data?.items.find((r) => r.code === code)?.name ?? words(code);
  const items = pending.data?.items;
  return (
    <Section title={`Access grants to approve${items ? ` (${pending.data?.total ?? items.length})` : ''}`}>
      {items?.length === 0 && <Empty>Nothing waiting for you.</Empty>}
      <ul className="tasks" aria-label="Access grants to approve">
        {items?.map((g) => {
          const mine = !!me && (g.userAccountKey === me.accountKey || g.requestedByAccountKey === me.accountKey);
          return (
            <li key={g.id}>
              <strong>{`${roleName(g.roleCode)} for ${g.userAccountKey ?? 'an account'}`}</strong>
              <span className="hint">{`${scopeWords(g.scopeKind)}, from ${formatDate(g.effectiveFrom)}${g.requestedByAccountKey ? `; requested by ${g.requestedByAccountKey}` : ''}`}</span>
              {mine ? (
                <span className="hint">You asked for this grant or it is yours, so another administrator approves it.</span>
              ) : (
                <Review to="/access">Review on User access</Review>
              )}
            </li>
          );
        })}
      </ul>
      <ErrorNote error={pending.error} />
    </Section>
  );
}

interface PendingDelegation {
  id: string;
  delegator: { accountKey: string; displayName: string | null };
  delegate: { accountKey: string; displayName: string | null };
  kinds: string[];
  effectiveFrom: string;
  effectiveTo: string;
  requestedBy: { accountKey: string } | null;
}

function DelegationQueue() {
  const { me } = useSession();
  const context = useContextKey();
  const pending = useQuery({
    queryKey: ['tasks', 'delegations-to-approve', context],
    queryFn: () => api<{ items: PendingDelegation[] }>('/v1/access/delegations?state=PENDING'),
  });
  const items = pending.data?.items;
  const who = (p: { accountKey: string; displayName: string | null }) => p.displayName ?? p.accountKey;
  return (
    <Section title={`Delegations to approve${items ? ` (${items.length})` : ''}`}>
      {items?.length === 0 && <Empty>Nothing waiting for you.</Empty>}
      <ul className="tasks" aria-label="Delegations to approve">
        {items?.map((d) => {
          const mine = !!me && [d.delegator.accountKey, d.delegate.accountKey, d.requestedBy?.accountKey].includes(me.accountKey);
          return (
            <li key={d.id}>
              <strong>{`${who(d.delegator)} to ${who(d.delegate)}`}</strong>
              <span className="hint">{`${d.kinds.map(words).join(', ') || 'decisions'}; ${formatDate(d.effectiveFrom)} to ${formatDate(d.effectiveTo)}`}</span>
              {mine ? (
                <span className="hint">You are part of this delegation, so another administrator approves it.</span>
              ) : (
                <Review to="/access/delegations">Review on Delegation approvals</Review>
              )}
            </li>
          );
        })}
      </ul>
      <ErrorNote error={pending.error} />
    </Section>
  );
}

interface ProposedChange {
  id: string;
  roleCode: string;
  permission: string;
  change: 'ALLOW' | 'REMOVE' | 'DENY';
  state: string;
  requestedByAccountKey: string;
}

const CHANGE_WORDS: Readonly<Record<ProposedChange['change'], string>> = { ALLOW: 'Allow', REMOVE: 'Remove', DENY: 'Deny' };

function RoleChangeQueue() {
  const { me, can } = useSession();
  const context = useContextKey();
  const changes = useQuery({
    queryKey: ['tasks', 'role-permission-changes', context],
    queryFn: () => api<{ items: ProposedChange[] }>('/v1/access/role-permission-changes'),
    enabled: can(READ_USERS),
  });
  const items = changes.data?.items.filter((c) => c.state === 'PROPOSED');
  return (
    <Section title={`Role permission changes to approve${items ? ` (${items.length})` : ''}`}>
      {items?.length === 0 && <Empty>Nothing waiting for you.</Empty>}
      <ul className="tasks" aria-label="Role permission changes to approve">
        {items?.map((c) => (
          <li key={c.id}>
            <strong>{`${CHANGE_WORDS[c.change]} ${c.permission} in ${words(c.roleCode)}`}</strong>
            <span className="hint">{`Proposed by ${c.requestedByAccountKey}`}</span>
            {me && c.requestedByAccountKey === me.accountKey ? (
              <span className="hint">You proposed this change, so another administrator approves it.</span>
            ) : (
              <Review to="/access/role-permissions">Review on Role permissions</Review>
            )}
          </li>
        ))}
      </ul>
      <ErrorNote error={changes.error} />
    </Section>
  );
}

/** The access decision queues, shown on the decision inbox to an assignment that approves grants. */
export const ACCESS_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [
  { permission: APPROVE, title: 'Access grants to approve', component: AccessGrantQueue },
  { permission: APPROVE, title: 'Delegations to approve', component: DelegationQueue },
  { permission: APPROVE, title: 'Role permission changes to approve', component: RoleChangeQueue },
];
