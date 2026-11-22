// Grant lists: the selected user's assignments and the company's pending approvals, with their actions.

import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ButtonRow } from '@/components/form-field';
import { Hint, HintLine } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, isForbidden, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, Item, Notice, NotPermitted, Section, StateBadge, WarningNote } from '../../ui';
import {
  type AccessUser,
  APPROVE_GRANT,
  DIMENSION_LABEL,
  DIMENSIONS,
  FOLD,
  FOLD_SUMMARY,
  type Grant,
  GRANT_LIST_LIMIT,
  type GrantView,
  LIST,
  localDay,
  type Outcome,
  REVOKE_ROLE,
  SCOPE_LABEL,
  shown,
  useAccessKeys,
  useRefreshAccess,
} from './shared';

/** A grant's decision step in its cell: the reason, the buttons and any refusal, one under another, a little closer than a form. */
const DECISION = 'flex flex-col items-start gap-[0.4rem]';

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
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      }
    >
      {account && (
        <dl className="kv">
          <Item term="Account">
            {account} {user && !user.active && <Badge tone="bad">inactive</Badge>}
          </Item>
          {user && <Item term="Employee">{user.employee ? `${user.employee.employeeCode} · ${user.employee.displayName}` : 'No employee link'}</Item>}
        </dl>
      )}
      {grants.isPending && <LoadingLine>Loading assignments…</LoadingLine>}
      {isForbidden(grants.error) ? <NotPermitted>The selected role cannot read role assignments.</NotPermitted> : <ErrorNote error={grants.error} />}
      {items && items.length === 0 && <Empty>No role assignments for this user yet.</Empty>}
      {items && items.length > 0 && <GrantTable grants={items} view={view} />}
      {items && items.length >= GRANT_LIST_LIMIT && <Hint>Showing the newest {GRANT_LIST_LIMIT} assignments.</Hint>}
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
      {pending.isPending && <LoadingLine>Loading pending grants…</LoadingLine>}
      {isForbidden(pending.error) ? <NotPermitted>The selected role cannot read role assignments.</NotPermitted> : <ErrorNote error={pending.error} />}
      {outcome && <OutcomeNote outcome={outcome} />}
      {items && items.length === 0 && <Empty>No grants are waiting for approval.</Empty>}
      {items && items.length > 0 && <GrantTable grants={items} view={view} onSelectUser={onSelectUser} onOutcome={setOutcome} />}
      {items && items.length >= GRANT_LIST_LIMIT && <Hint>Showing the newest {GRANT_LIST_LIMIT} pending grants.</Hint>}
      {items && items.length > 0 && <CatalogueNote state={view.catalogue} />}
    </Section>
  );
}

/** What became of a decision taken in the pending list: done, or overtaken by someone else's change (in the warning tint). */
function OutcomeNote({ outcome }: { outcome: Outcome }) {
  if (outcome.tone === 'ok') return <Notice notice={{ text: outcome.text, ok: true }} />;
  return (
    <WarningNote badge="changed" role="status">
      {outcome.text}
    </WarningNote>
  );
}

/** Without the catalogue, confidential permissions cannot be marked; say so rather than show them unmarked. */
function CatalogueNote({ state }: { state: GrantView['catalogue'] }) {
  if (state === 'loaded') return null;
  if (state === 'loading') return <Hint>Confidential permissions are marked once the role catalogue has loaded.</Hint>;
  return (
    <WarningNote badge="not marked">The role catalogue could not be loaded, so confidential permissions are not marked. Reload the page before deciding.</WarningNote>
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
    <Table>
      <TableHeader>
        <TableRow>
          {onSelectUser && <TableHead scope="col">Beneficiary</TableHead>}
          <TableHead scope="col">Role</TableHead>
          <TableHead scope="col">Scope</TableHead>
          <TableHead scope="col">State</TableHead>
          <TableHead scope="col">Effective</TableHead>
          <TableHead scope="col">Purpose</TableHead>
          <TableHead scope="col">Permissions</TableHead>
          <TableHead scope="col">Requested by</TableHead>
          {withActions && <TableHead scope="col">Actions</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {grants.map((g) => {
          const beneficiary = view.userLabel(g.userId, g.userAccountKey);
          const roleName = view.roleName(g.roleCode);
          return (
            <TableRow key={g.id}>
              {onSelectUser && (
                <TableCell>
                  <div>{beneficiary}</div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-1"
                    aria-label={`Show assignments for ${beneficiary}`}
                    onClick={() => onSelectUser(g.userId, g.userAccountKey ?? null)}
                  >
                    Show assignments
                  </Button>
                </TableCell>
              )}
              <TableCell>
                {roleName ?? g.roleCode}
                {roleName && <HintLine>{g.roleCode}</HintLine>}
              </TableCell>
              <TableCell>
                {SCOPE_LABEL[g.scopeKind] ?? g.scopeKind}
                <Restrictions filters={g.filters} view={view} />
              </TableCell>
              <TableCell>
                <StateBadge state={g.state} />
              </TableCell>
              <TableCell>
                <div>from {localDay(g.effectiveFrom)}</div>
                <HintLine>{g.effectiveTo ? `ends ${localDay(g.effectiveTo)}` : 'no end date'}</HintLine>
              </TableCell>
              <TableCell>{g.purpose ?? '—'}</TableCell>
              <TableCell>
                <PermissionList permissionKeys={g.permissions} view={view} />
              </TableCell>
              <TableCell>
                <div>{view.userLabel(g.requestedBy, g.requestedByAccountKey)}</div>
                {g.approvedBy && <HintLine>approved by {view.userLabel(g.approvedBy, g.approvedByAccountKey)}</HintLine>}
              </TableCell>
              {withActions && <GrantActions grant={g} subject={`${roleName ?? g.roleCode} for ${beneficiary}`} onOutcome={onOutcome} />}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** The grant's own department, location and employee restrictions, exactly as the server reported them. */
function Restrictions({ filters, view }: { filters: Grant['filters']; view: GrantView }) {
  if (!filters) return null; // not reported: claim nothing
  const dims = DIMENSIONS.filter((d) => (filters[d]?.length ?? 0) > 0);
  if (dims.length === 0) return <HintLine>no further restrictions</HintLine>;
  return (
    <ul className={LIST}>
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
  if (permissionKeys.length === 0) return <Hint as="span">No permissions</Hint>;
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
        <ul className={LIST}>
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
        <details className={FOLD}>
          <summary className={FOLD_SUMMARY}>{listed > 0 ? `${other.length} other permission${plural}` : `${other.length} permission${plural}`}</summary>
          <ul className={LIST}>
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
  if (!decidable && !revocable) {
    return (
      <TableCell>
        <ErrorNote error={act.error} />
      </TableCell>
    );
  }

  const open = (next: 'reject' | 'revoke') => {
    act.reset();
    setReason('');
    setMode(next);
  };

  if (mode && ((mode === 'reject' && decidable) || (mode === 'revoke' && revocable))) {
    const noun = mode === 'reject' ? 'rejection' : 'revocation';
    return (
      <RowActionsCell expanded>
        <form
          className={DECISION}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            const text = reason.trim();
            if (text && !act.isPending) act.mutate({ action: mode, version: grant.version, reason: text });
          }}
        >
          <Input aria-label={`Reason for ${noun}`} placeholder="Reason (required)" required maxLength={500} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
          {mode === 'revoke' && stored?.assignmentId === grant.id && <Hint>This is the assignment you are signed in with: revoking it ends your access in this role.</Hint>}
          <ButtonRow>
            <Button type="submit" variant="danger" size="sm" disabled={!reason.trim() || act.isPending}>
              {mode === 'reject' ? 'Confirm rejection' : 'Confirm revocation'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                act.reset();
                setMode(null);
                setReason('');
              }}
            >
              Cancel
            </Button>
          </ButtonRow>
          <ErrorNote error={act.error} />
        </form>
      </RowActionsCell>
    );
  }

  return (
    <RowActionsCell expanded={!!act.error}>
      <div className={DECISION}>
        <RowActions>
          {decidable && (
            <>
              <Button type="button" size="sm" disabled={act.isPending} onClick={() => act.mutate({ action: 'approve', version: grant.version })}>
                Approve
              </Button>
              <Button type="button" variant="danger" size="sm" disabled={act.isPending} onClick={() => open('reject')}>
                Reject
              </Button>
            </>
          )}
          {revocable && (
            <Button type="button" variant="danger" size="sm" disabled={act.isPending} onClick={() => open('revoke')}>
              Revoke
            </Button>
          )}
        </RowActions>
        <ErrorNote error={act.error} />
      </div>
    </RowActionsCell>
  );
}
