// Role permissions (C3 maintain_role_permissions; FR-066; FR-067; C1 scoped DENY; 0132): a change to what a role allows is proposed
// here and decided by someone independent, with who asked, who decided, why, when and what resulted kept. The server decides every
// rule (no own approval, nobody holding the role, the role's ceiling, C7 eligibility); this screen shows what it answered.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, formatDate } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Empty, ErrorNote, Section, StateBadge } from '../ui';

const READ_USERS = 'access.read_users.operational';
const MAINTAIN = 'access.maintain_role_permissions.operational';
const APPROVE = 'access.approve_role_grant.operational';

type ChangeKind = 'ALLOW' | 'DENY' | 'REMOVE';

interface CatalogueRole {
  code: string;
  name: string;
  active: boolean;
  permissions: { key: string }[];
  restorable: string[];
}

interface RoleChange {
  id: string;
  roleCode: string;
  permission: string;
  change: ChangeKind;
  effectBefore: 'ALLOW' | 'DENY' | null;
  state: 'PROPOSED' | 'APPROVED' | 'REJECTED';
  reason: string;
  requestedByAccountKey: string;
  requestedAt: string;
  decidedByAccountKey: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  resultingAccess: { effectAfter: 'ALLOW' | 'DENY' | null; allowlistEntriesEnded: number } | null;
  version: number;
}

const CHANGE_LABEL: Record<ChangeKind, string> = {
  ALLOW: 'Allow: put it in the role’s ceiling',
  REMOVE: 'Remove: take it out of the role’s ceiling',
  DENY: 'Deny: also refuse it to the same person’s other roles, within this role’s scope',
};
const CHANGE_SHORT: Record<ChangeKind, string> = { ALLOW: 'Allow', REMOVE: 'Remove', DENY: 'Deny' };
const effectText = (effect: 'ALLOW' | 'DENY' | null) => (effect === null ? 'not in the role' : effect === 'ALLOW' ? 'allowed' : 'denied');

function ProposeForm({ roles, onDone }: { roles: CatalogueRole[]; onDone: () => void }) {
  const [roleCode, setRoleCode] = useState('');
  const [change, setChange] = useState<ChangeKind | ''>('');
  const [permission, setPermission] = useState('');
  const [reason, setReason] = useState('');
  const role = roles.find((r) => r.code === roleCode);
  const suggestions = role ? (change === 'ALLOW' ? role.restorable : role.permissions.map((p) => p.key)) : [];
  const propose = useMutation({
    mutationFn: () => api('/v1/access/role-permission-changes', { body: { roleCode, permission: permission.trim(), change, reason: reason.trim() } }),
    onSuccess: () => {
      setPermission('');
      setReason('');
      onDone();
    },
  });
  return (
    <form
      className="grid-form"
      onSubmit={(e) => {
        e.preventDefault();
        propose.mutate();
      }}
    >
      <label>
        Role
        <select value={roleCode} onChange={(e) => setRoleCode(e.target.value)} required>
          <option value="">Choose a role</option>
          {roles
            .filter((r) => r.active)
            .map((r) => (
              <option key={r.code} value={r.code}>
                {r.name}
              </option>
            ))}
        </select>
      </label>
      {/* No change is chosen for the proposer (it used to start on Remove); the options are short, the chosen one explained below. */}
      <label>
        Change
        <select value={change} onChange={(e) => setChange(e.target.value as ChangeKind | '')}>
          <option value="">Choose…</option>
          {(['ALLOW', 'REMOVE', 'DENY'] as const).map((k) => (
            <option key={k} value={k}>
              {CHANGE_SHORT[k]}
            </option>
          ))}
        </select>
      </label>
      {change && <p className="hint wide">{CHANGE_LABEL[change]}</p>}
      <label>
        Permission
        <input list="role-permission-keys" placeholder="resource.action.group" value={permission} onChange={(e) => setPermission(e.target.value)} required />
        <datalist id="role-permission-keys">
          {suggestions.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
      </label>
      <label>
        Reason
        <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} required />
      </label>
      <button type="submit" disabled={propose.isPending || !roleCode || !change || !permission.trim() || !reason.trim()}>
        Propose change
      </button>
      <ErrorNote error={propose.error} />
    </form>
  );
}

function DecisionControls({ change, onDone }: { change: RoleChange; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: (path: 'approve' | 'reject') =>
      api(`/v1/access/role-permission-changes/${change.id}/${path}`, { body: path === 'approve' ? { expectedVersion: change.version } : { expectedVersion: change.version, reason: reason.trim() } }),
    onSuccess: onDone,
  });
  return (
    <div className="row">
      <button disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
        Approve
      </button>
      <input aria-label={`Reason for rejecting ${change.permission}`} placeholder="Reason to reject" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="danger" disabled={decide.isPending || !reason.trim()} onClick={() => decide.mutate('reject')}>
        Reject
      </button>
      <ErrorNote error={decide.error} />
    </div>
  );
}

export function RolePermissionsPage() {
  const { can, stored } = useSession();
  const qc = useQueryClient();
  // The selected company and assignment are part of the key, so one role's answer is never shown under another.
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  const changes = useQuery({
    queryKey: ['role-permission-changes', context],
    queryFn: () => api<{ items: RoleChange[]; total: number }>('/v1/access/role-permission-changes'),
    enabled: can(READ_USERS),
  });
  const roles = useQuery({ queryKey: ['role-permission-roles', context], queryFn: () => api<{ items: CatalogueRole[] }>('/v1/access/roles'), enabled: can(READ_USERS) });
  if (!can(READ_USERS)) return <Section title="Role permissions">The selected role cannot see role permission changes.</Section>;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['role-permission-changes', context] });
    void qc.invalidateQueries({ queryKey: ['role-permission-roles', context] });
  };
  const items = changes.data?.items ?? [];
  const open = items.filter((c) => c.state === 'PROPOSED');
  const decided = items.filter((c) => c.state !== 'PROPOSED');
  return (
    <>
      {can(MAINTAIN) && (
        <Section title="Propose a role permission change">
          <p className="hint">Nothing changes until someone else approves it. A role’s ceiling gives nobody the permission by itself; existing assignments do not gain it. Removing or denying a permission ends it on the role’s assignments, and bringing it back later needs a new grant.</p>
          <ProposeForm roles={roles.data?.items ?? []} onDone={refresh} />
          <ErrorNote error={roles.error} />
        </Section>
      )}
      <Section title="Waiting for a decision">
        <p className="hint">The person who asked and anyone holding the role cannot decide. A change to a role that every approver holds cannot be approved by any of them.</p>
        <table>
          <thead>
            <tr>
              <th>Role</th>
              <th>Permission</th>
              <th>Change</th>
              <th>Current setting</th>
              <th>Reason</th>
              <th>Asked by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {open.map((c) => (
              <tr key={c.id}>
                <td>{c.roleCode}</td>
                <td>{c.permission}</td>
                <td>{CHANGE_SHORT[c.change]}</td>
                <td>{effectText(c.effectBefore)}</td>
                <td>{c.reason}</td>
                <td>
                  {c.requestedByAccountKey} <span className="hint">{formatDate(c.requestedAt)}</span>
                </td>
                <td>{can(APPROVE) && <DecisionControls change={c} onDone={refresh} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {changes.data && open.length === 0 && <Empty>No change is waiting for a decision.</Empty>}
        <ErrorNote error={changes.error} />
      </Section>
      <Section title="Decided changes">
        <table>
          <thead>
            <tr>
              <th>Role</th>
              <th>Permission</th>
              <th>Change</th>
              <th>Outcome</th>
              <th>Reason</th>
              <th>Asked by</th>
              <th>Decided by</th>
            </tr>
          </thead>
          <tbody>
            {decided.map((c) => (
              <tr key={c.id}>
                <td>{c.roleCode}</td>
                <td>{c.permission}</td>
                <td>{CHANGE_SHORT[c.change]}</td>
                <td>
                  {/* The decision and what it left in force, in one place (a separate Result column repeated it). */}
                  <StateBadge state={c.state} />
                  {c.resultingAccess && <div className="hint">{`Now ${effectText(c.resultingAccess.effectAfter)}; ${c.resultingAccess.allowlistEntriesEnded} assignment entries ended`}</div>}
                </td>
                <td>
                  {c.reason}
                  {c.decisionReason ? <div className="hint">Rejected because: {c.decisionReason}</div> : null}
                </td>
                <td>{c.requestedByAccountKey}</td>
                <td>
                  {c.decidedByAccountKey} <span className="hint">{formatDate(c.decidedAt)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {changes.data && decided.length === 0 && <Empty>No change has been decided yet.</Empty>}
      </Section>
    </>
  );
}

export const ROLE_PERMISSION_SCREENS: ScreenRoute[] = [{ path: '/access/role-permissions', title: 'Role permissions', permission: READ_USERS, nav: true, component: RolePermissionsPage }];
