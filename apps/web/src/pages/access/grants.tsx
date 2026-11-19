// Grant lists: the selected user's assignments and the company's pending approvals, with their actions.

import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, ApiError, isForbidden, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, NotPermitted, Section, StateBadge } from '../../ui';
import { type AccessUser, APPROVE_GRANT, DIMENSION_LABEL, DIMENSIONS, type Grant, GRANT_LIST_LIMIT, type GrantView, LIST, localDay, type Outcome, REVOKE_ROLE, SCOPE_LABEL, SCROLL, shown, useAccessKeys, useRefreshAccess } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Grant lists: the selected user's assignments and the company's pending approvals
// ---------------------------------------------------------------------------------------------------------

export function UserAssignments({
  userId,
  accountKey,
  user,
  view,
  onClose,
}: {
  userId: string;
  accountKey: string | null;
  user: AccessUser | undefined;
  view: GrantView;
  onClose: () => void;
}) {
  const keys = useAccessKeys();
  const grants = useQuery({
    queryKey: keys.userGrants(userId),
    queryFn: () => api<{ items: Grant[] }>(`/v1/access/assignments?userId=${encodeURIComponent(userId)}`),
    retry: retryTransient,
  });
  const items = shown(grants)?.items;
  const account = user?.accountKey ?? accountKey ?? items?.[0]?.userAccountKey ?? null;
  return (
    <Section
      title={`Assignments of ${view.userLabel(userId, account)}`}
      actions={
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      {account && (
        <dl className="kv">
          <div>
            <dt>Account</dt>
            <dd>
              {account} {user && !user.active && <Badge tone="bad">inactive</Badge>}
            </dd>
          </div>
          {user && (
            <div>
              <dt>Employee</dt>
              <dd>{user.employee ? `${user.employee.employeeCode} · ${user.employee.displayName}` : 'No employee link'}</dd>
            </div>
          )}
        </dl>
      )}
      {grants.isPending && <p className="hint loading">Loading assignments…</p>}
      {isForbidden(grants.error) ? <NotPermitted>The selected role cannot read role assignments.</NotPermitted> : <ErrorNote error={grants.error} />}
      {items && items.length === 0 && <Empty>No role assignments for this user yet.</Empty>}
      {items && items.length > 0 && <GrantTable grants={items} view={view} />}
      {items && items.length >= GRANT_LIST_LIMIT && <p className="hint">Showing the newest {GRANT_LIST_LIMIT} assignments.</p>}
      {items && items.length > 0 && <CatalogueNote state={view.catalogue} />}
    </Section>
  );
}

export function PendingApprovals({ view, onSelectUser }: { view: GrantView; onSelectUser: (userId: string, accountKey: string | null) => void }) {
  const keys = useAccessKeys();
  const pending = useQuery({ queryKey: keys.pending, queryFn: () => api<{ items: Grant[] }>('/v1/access/assignments?state=PENDING'), retry: retryTransient });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const items = shown(pending)?.items;
  return (
    <Section title={`Pending approvals${items ? ` (${items.length})` : ''}`}>
      {pending.isPending && <p className="hint loading">Loading pending grants…</p>}
      {isForbidden(pending.error) ? <NotPermitted>The selected role cannot read role assignments.</NotPermitted> : <ErrorNote error={pending.error} />}
      {outcome && <OutcomeNote outcome={outcome} />}
      {items && items.length === 0 && <Empty>No grants are waiting for approval.</Empty>}
      {items && items.length > 0 && <GrantTable grants={items} view={view} onSelectUser={onSelectUser} onOutcome={setOutcome} />}
      {items && items.length >= GRANT_LIST_LIMIT && <p className="hint">Showing the newest {GRANT_LIST_LIMIT} pending grants.</p>}
      {items && items.length > 0 && <CatalogueNote state={view.catalogue} />}
    </Section>
  );
}

function OutcomeNote({ outcome }: { outcome: Outcome }) {
  if (outcome.tone === 'ok') {
    return (
      <p className="ok" role="status">
        {outcome.text}
      </p>
    );
  }
  return (
    <p role="status">
      <Badge tone="warn">changed</Badge> {outcome.text}
    </p>
  );
}

/** Without the catalogue, confidential permissions cannot be marked; say so rather than show them unmarked. */
function CatalogueNote({ state }: { state: GrantView['catalogue'] }) {
  if (state === 'loaded') return null;
  if (state === 'loading') return <p className="hint">Confidential permissions are marked once the role catalogue has loaded.</p>;
  return (
    <p role="note">
      <Badge tone="warn">not marked</Badge> The role catalogue could not be loaded, so confidential permissions are not marked. Reload the page before deciding.
    </p>
  );
}

function GrantTable({
  grants,
  view,
  onSelectUser,
  onOutcome,
}: {
  grants: Grant[];
  view: GrantView;
  onSelectUser?: (userId: string, accountKey: string | null) => void;
  onOutcome?: (outcome: Outcome) => void;
}) {
  const { can } = useSession();
  const withActions = can(APPROVE_GRANT) || can(REVOKE_ROLE);
  return (
    <div style={SCROLL}>
      <table>
        <thead>
          <tr>
            {onSelectUser && <th>Beneficiary</th>}
            <th>Role</th>
            <th>Scope</th>
            <th>State</th>
            <th>Effective</th>
            <th>Purpose</th>
            <th>Permissions</th>
            <th>Requested by</th>
            {withActions && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {grants.map((g) => {
            const beneficiary = view.userLabel(g.userId, g.userAccountKey);
            const roleName = view.roleName(g.roleCode);
            return (
              <tr key={g.id}>
                {onSelectUser && (
                  <td>
                    <div>{beneficiary}</div>
                    <button type="button" className="link" aria-label={`Show assignments for ${beneficiary}`} onClick={() => onSelectUser(g.userId, g.userAccountKey ?? null)}>
                      Show assignments
                    </button>
                  </td>
                )}
                <td>
                  {roleName ?? g.roleCode}
                  {roleName && <div className="hint">{g.roleCode}</div>}
                </td>
                <td>
                  {SCOPE_LABEL[g.scopeKind] ?? g.scopeKind}
                  <Restrictions filters={g.filters} view={view} />
                </td>
                <td>
                  <StateBadge state={g.state} />
                </td>
                <td>
                  <div>from {localDay(g.effectiveFrom)}</div>
                  <div className="hint">{g.effectiveTo ? `ends ${localDay(g.effectiveTo)}` : 'no end date'}</div>
                </td>
                <td>{g.purpose ?? '—'}</td>
                <td>
                  <PermissionList permissionKeys={g.permissions} view={view} />
                </td>
                <td>
                  <div>{view.userLabel(g.requestedBy, g.requestedByAccountKey)}</div>
                  {g.approvedBy && <div className="hint">approved by {view.userLabel(g.approvedBy, g.approvedByAccountKey)}</div>}
                </td>
                {withActions && (
                  <td>
                    <GrantActions grant={g} subject={`${roleName ?? g.roleCode} for ${beneficiary}`} onOutcome={onOutcome} />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The grant's own department, location and employee restrictions, exactly as the server reported them. */
function Restrictions({ filters, view }: { filters: Grant['filters']; view: GrantView }) {
  if (!filters) return null; // not reported: claim nothing
  const dims = DIMENSIONS.filter((d) => (filters[d]?.length ?? 0) > 0);
  if (dims.length === 0) return <div className="hint">no further restrictions</div>;
  return (
    <ul style={LIST}>
      {dims.map((d) => (
        <li key={d}>
          {DIMENSION_LABEL[d]}: {(filters[d] ?? []).map((id) => view.restriction(d, id)).join(', ')}
        </li>
      ))}
    </ul>
  );
}

/** Confidential permissions (and any the catalogue cannot classify) are always listed and labelled; the rest fold away. */
function PermissionList({ permissionKeys, view }: { permissionKeys: string[]; view: GrantView }) {
  if (permissionKeys.length === 0) return <span className="hint">No permissions</span>;
  const keys = [...permissionKeys].sort();
  const marked = view.catalogue === 'loaded';
  const confidential = marked ? keys.filter((k) => view.confidential(k) === true) : [];
  const unclassified = marked ? keys.filter((k) => view.confidential(k) === undefined) : [];
  const other = marked ? keys.filter((k) => view.confidential(k) === false) : keys;
  const listed = confidential.length + unclassified.length;
  const plural = other.length === 1 ? '' : 's';
  return (
    <>
      {listed > 0 && (
        <ul style={LIST}>
          {confidential.map((k) => (
            <li key={k}>
              <code>{k}</code> <Badge tone="warn">confidential</Badge>
            </li>
          ))}
          {unclassified.map((k) => (
            <li key={k}>
              <code>{k}</code> <Badge>not in role catalogue</Badge>
            </li>
          ))}
        </ul>
      )}
      {other.length > 0 && (
        <details>
          <summary>{listed > 0 ? `${other.length} other permission${plural}` : `${other.length} permission${plural}`}</summary>
          <ul style={LIST}>
            {other.map((k) => (
              <li key={k}>
                <code>{k}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

type GrantAction = { action: 'approve'; version: number } | { action: 'reject' | 'revoke'; version: number; reason: string };
const DONE: Record<GrantAction['action'], string> = { approve: 'Approved', reject: 'Rejected', revoke: 'Revoked' };

/** Approve or reject a pending grant, revoke an active one. Every call carries the row's version (stale -> 409). */
function GrantActions({ grant, subject, onOutcome }: { grant: Grant; subject: string; onOutcome?: (outcome: Outcome) => void }) {
  const { can, stored } = useSession();
  const refresh = useRefreshAccess();
  const [mode, setMode] = useState<'reject' | 'revoke' | null>(null);
  const [reason, setReason] = useState('');
  const act = useMutation({
    mutationFn: (a: GrantAction) =>
      api<{ id: string; state: string }>(`/v1/access/assignments/${encodeURIComponent(grant.id)}/${a.action}`, {
        method: 'POST',
        body: a.action === 'approve' ? { expectedVersion: a.version } : { expectedVersion: a.version, reason: a.reason },
      }),
    onSuccess: (_result, a) => {
      setMode(null);
      setReason('');
      onOutcome?.({ tone: 'ok', text: `${DONE[a.action]}: ${subject}.` });
      refresh();
    },
    // A stale version means someone else changed the grant: reload so the row shows its current state and version.
    // The row may leave the pending list on reload, so the list also says what happened.
    onError: (error) => {
      if (!(error instanceof ApiError && error.status === 409)) return;
      onOutcome?.({ tone: 'warn', text: `${subject} changed before your decision, so the lists were reloaded. Check its current state before deciding again.` });
      refresh();
    },
  });

  const decidable = grant.state === 'PENDING' && can(APPROVE_GRANT);
  const revocable = grant.state === 'ACTIVE' && can(REVOKE_ROLE);
  if (!decidable && !revocable) return <ErrorNote error={act.error} />;

  const open = (next: 'reject' | 'revoke') => {
    act.reset();
    setReason('');
    setMode(next);
  };

  if (mode && ((mode === 'reject' && decidable) || (mode === 'revoke' && revocable))) {
    const noun = mode === 'reject' ? 'rejection' : 'revocation';
    return (
      <form
        className="stack"
        style={{ gap: '0.4rem' }}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          const text = reason.trim();
          if (text && !act.isPending) act.mutate({ action: mode, version: grant.version, reason: text });
        }}
      >
        <input aria-label={`Reason for ${noun}`} placeholder="Reason (required)" required maxLength={500} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
        {mode === 'revoke' && stored?.assignmentId === grant.id && (
          <p className="hint">This is the assignment you are signed in with: revoking it ends your access in this role.</p>
        )}
        <div className="row">
          <button type="submit" className="danger" disabled={!reason.trim() || act.isPending}>
            {mode === 'reject' ? 'Confirm rejection' : 'Confirm revocation'}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              act.reset();
              setMode(null);
              setReason('');
            }}
          >
            Cancel
          </button>
        </div>
        <ErrorNote error={act.error} />
      </form>
    );
  }

  return (
    <div className="stack" style={{ gap: '0.4rem' }}>
      <div className="row">
        {decidable && (
          <>
            <button type="button" disabled={act.isPending} onClick={() => act.mutate({ action: 'approve', version: grant.version })}>
              Approve
            </button>
            <button type="button" className="danger" disabled={act.isPending} onClick={() => open('reject')}>
              Reject
            </button>
          </>
        )}
        {revocable && (
          <button type="button" className="danger" disabled={act.isPending} onClick={() => open('revoke')}>
            Revoke
          </button>
        )}
      </div>
      <ErrorNote error={act.error} />
    </div>
  );
}
