// Access administration (FR-066/FR-067/FR-068; C4; DF02). A role grant is proposed for a user, gives no access
// until an independent approver approves it, and is rejected or revoked with a reason; the record is kept.
// The server authorises every call and decides every rule (role ceilings, confidential eligibility, business
// purpose, administrative scope, self-approval). This screen only hides the actions the selected assignment
// cannot use, shows exactly what the server returned, and never reconstructs anything it did not return.
// Cached answers are keyed by the selected company and assignment, and a refusal hides what an earlier answer
// showed, so one role's view of who holds which access is never shown under another.
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, ApiError, formatDate } from '../api';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Section, StateBadge } from '../ui';

const READ_USERS = 'access.read_users.operational';
const ASSIGN_ROLE = 'access.assign_role.operational';
const APPROVE_GRANT = 'access.approve_role_grant.operational';
const REVOKE_ROLE = 'access.revoke_role.operational';
/** The organisation masters feed the scope filter pickers and name a grant's restrictions. */
const READ_ORG = 'org_master.read.operational';

const PAGE_SIZE = 25;
/** GET /v1/access/assignments returns at most this many rows (newest first). */
const GRANT_LIST_LIMIT = 200;

type ScopeKind = 'OWN' | 'TEAM' | 'ASSIGNED' | 'COMPANY';
type AccessClass = 'ADMIN' | 'MANAGER' | 'OTHER';
type OrgKind = 'departments' | 'locations';
type Dimension = OrgKind | 'employees';
const SCOPES: readonly ScopeKind[] = ['OWN', 'TEAM', 'ASSIGNED', 'COMPANY'];
const SCOPE_LABEL: Record<ScopeKind, string> = { OWN: 'Own', TEAM: 'Team', ASSIGNED: 'Assigned', COMPANY: 'Company' };
const CLASS_LABEL: Record<AccessClass, string> = { ADMIN: 'Admin', MANAGER: 'Manager', OTHER: 'Other' };
const DIMENSIONS: readonly Dimension[] = ['departments', 'locations', 'employees'];
const DIMENSION_LABEL: Record<Dimension, string> = { departments: 'Departments', locations: 'Locations', employees: 'Employees' };
const DIMENSION_NOUN: Record<Dimension, string> = { departments: 'department', locations: 'location', employees: 'employee' };

interface AccessUser {
  userId: string;
  accountKey: string;
  active: boolean;
  employee: { id: string; employeeCode: string; displayName: string } | null;
  assignments: { active: number; pending: number };
}

interface CataloguePermission {
  key: string;
  confidential: boolean;
  defaultDuty: boolean;
}

interface CatalogueRole {
  code: string;
  name: string;
  accessClass: AccessClass;
  defaultScope: ScopeKind | null;
  active: boolean;
  permissions: CataloguePermission[];
}

interface Grant {
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

interface OrgItem {
  id: string;
  code: string;
  name: string;
  active: boolean;
  version: number;
}

interface ProposalBody {
  userId: string;
  roleCode: string;
  scopeKind: ScopeKind;
  effectiveFrom: string;
  effectiveTo?: string;
  permissions: string[];
  filters?: { departments?: string[]; locations?: string[] };
  purpose?: string;
}

type RolesQuery = UseQueryResult<{ items: CatalogueRole[] }, Error>;
type OrgQuery = UseQueryResult<{ items: OrgItem[] }, Error>;

const SCROLL: CSSProperties = { overflowX: 'auto' };
const LIST: CSSProperties = { margin: 0, paddingLeft: '1.1rem' };
const GROUP: CSSProperties = { border: 'none', margin: 0, padding: 0, minWidth: 0 };
const TEXTAREA: CSSProperties = { font: 'inherit', padding: '0.4rem 0.5rem', border: '1px solid var(--line)', borderRadius: 6, color: 'var(--text)', resize: 'vertical' };

const isForbidden = (error: unknown) => error instanceof ApiError && error.status === 403;
/** A refusal or bad request will not change on retry; only transient failures are retried (once). */
const retryTransient = (failureCount: number, error: Error) => !(error instanceof ApiError && error.status < 500) && failureCount < 1;
const pad = (n: number) => String(n).padStart(2, '0');

/** A query's data unless the server's latest answer was a refusal: a refusal hides what an earlier answer showed. */
function shown<T>(q: UseQueryResult<T, Error>): T | undefined {
  return isForbidden(q.error) ? undefined : q.data;
}

/** Effective dates are instants; show the local calendar day (grants are proposed at local midnight). */
function localDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return formatDate(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A date input value (YYYY-MM-DD) as the ISO instant of local midnight on that day. */
function atLocalMidnight(date: string): string | null {
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Query keys carry the selected company and assignment: the app keeps one query cache across role switches and
 * sign-ins, and an answer given to one assignment must never be shown under another.
 */
function useAccessKeys() {
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

function useRefreshAccess() {
  const qc = useQueryClient();
  const keys = useAccessKeys();
  return () => {
    void qc.invalidateQueries({ queryKey: keys.allGrants });
    void qc.invalidateQueries({ queryKey: keys.allUsers });
  };
}

/** An organisation master list, requested only when the selected assignment can read it (a refusal is audited). */
function useOrgMaster(kind: OrgKind): OrgQuery {
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

function NotPermitted({ children }: { children: ReactNode }) {
  return (
    <p role="note">
      <Badge tone="warn">not permitted</Badge> {children}
    </p>
  );
}

/** How grant rows are labelled: users from loaded user pages or the row's account keys, roles and classification from the catalogue. */
interface GrantView {
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
interface Outcome {
  tone: 'ok' | 'warn';
  text: string;
}

interface SelectedUser {
  userId: string;
  accountKey: string | null;
}

const byId = (items: OrgItem[] | undefined) => new Map((items ?? []).map((i): [string, OrgItem] => [i.id, i]));

// ---------------------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------------------

export function AccessAdminPage() {
  const { me, can } = useSession();
  if (!me) return <p className="hint">Loading…</p>;
  if (!can(READ_USERS)) {
    return (
      <Section title="Access administration">
        <NotPermitted>The selected role cannot administer user access. Switch to a role that holds user administration.</NotPermitted>
      </Section>
    );
  }
  return <AccessAdministration accountKey={me.accountKey} />;
}

function AccessAdministration({ accountKey }: { accountKey: string }) {
  const { can } = useSession();
  const keys = useAccessKeys();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<SelectedUser | null>(null);
  // Users seen on any loaded page, so grant rows can name beneficiaries, requesters, approvers and employees.
  const [known, setKnown] = useState<Record<string, AccessUser>>({});
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const next = search.trim();
    if (next === query) return;
    const t = setTimeout(() => {
      setQuery(next);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search, query]);

  const users = useQuery({
    queryKey: keys.users(query, page),
    queryFn: () => api<{ items: AccessUser[]; total: number }>(`/v1/access/users?page=${page}&pageSize=${PAGE_SIZE}${query ? `&search=${encodeURIComponent(query)}` : ''}`),
    // Keep the previous page on screen while the next one loads, but never across a change of company or assignment.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === keys.context ? previous : undefined),
    retry: retryTransient,
  });
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<{ items: CatalogueRole[] }>('/v1/access/roles'), staleTime: 5 * 60_000, retry: retryTransient });
  const orgDepartments = useOrgMaster('departments');
  const orgLocations = useOrgMaster('locations');

  const usersData = shown(users);
  useEffect(() => {
    const items = usersData?.items;
    if (!items || items.length === 0) return;
    setKnown((prev) => {
      const next = { ...prev };
      for (const u of items) next[u.userId] = u;
      return next;
    });
  }, [usersData]);

  const total = usersData?.total;
  const pages = Math.max(1, Math.ceil((total ?? 0) / PAGE_SIZE));
  useEffect(() => {
    if (total !== undefined && page > pages) setPage(pages);
  }, [total, page, pages]);

  const selectedId = selected?.userId ?? null;
  useEffect(() => {
    if (selectedId) panel.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  const catalogue = shown(roles)?.items;
  const catalogueState: GrantView['catalogue'] = catalogue ? 'loaded' : roles.isPending ? 'loading' : 'failed';
  const departmentItems = orgDepartments.data?.items;
  const locationItems = orgLocations.data?.items;
  const view = useMemo<GrantView>(() => {
    const names = new Map<string, string>();
    const classification = new Map<string, boolean>();
    for (const r of catalogue ?? []) {
      names.set(r.code, r.name);
      for (const p of r.permissions) classification.set(p.key, (classification.get(p.key) ?? false) || p.confidential);
    }
    const masters: Record<OrgKind, Map<string, OrgItem>> = { departments: byId(departmentItems), locations: byId(locationItems) };
    const employees = new Map<string, string>();
    for (const u of Object.values(known)) if (u.employee) employees.set(u.employee.id, `${u.employee.displayName} (${u.employee.employeeCode})`);
    return {
      userLabel: (userId, accountKeyHint) => {
        if (!userId) return '—';
        const u = known[userId];
        const key = u?.accountKey ?? accountKeyHint ?? null;
        const name = u?.employee ? `${u.employee.displayName} (${u.employee.employeeCode})` : (key ?? `user ${userId.slice(0, 8)}`);
        return key !== null && key === accountKey ? `${name} · you` : name;
      },
      roleName: (code) => names.get(code) ?? null,
      confidential: (key) => classification.get(key),
      catalogue: catalogueState,
      restriction: (dimension, id) => {
        const short = `${DIMENSION_NOUN[dimension]} ${id.slice(0, 8)}`;
        if (dimension === 'employees') return employees.get(id) ?? short;
        const item = masters[dimension].get(id);
        return item ? `${item.name} (${item.code}${item.active ? '' : ', inactive'})` : short;
      },
    };
  }, [catalogue, catalogueState, known, accountKey, departmentItems, locationItems]);

  const select = (userId: string, key: string | null) => setSelected({ userId, accountKey: key });

  return (
    <>
      <h1>Access administration</h1>
      <p className="hint">
        A role grant starts as a proposal and gives no access until an independent approver approves it; neither its requester nor its beneficiary can approve it. Rejected and
        revoked grants stay on record.
      </p>

      {can(APPROVE_GRANT) && <PendingApprovals view={view} onSelectUser={select} />}

      <Section title={`Users${usersData ? ` (${usersData.total})` : ''}`}>
        <label className="inline">
          Search users
          <input type="search" value={search} maxLength={100} placeholder="Account, employee code or name" onChange={(e) => setSearch(e.target.value)} />
        </label>
        {users.isPending && <p className="hint">Loading users…</p>}
        {isForbidden(users.error) ? <NotPermitted>The selected role cannot list users for access administration.</NotPermitted> : <ErrorNote error={users.error} />}
        {usersData && !users.isPlaceholderData && usersData.total === 0 && (
          <Empty>{query ? `No users match “${query}”.` : 'No users in your administrative scope.'}</Empty>
        )}
        {usersData && usersData.items.length > 0 && (
          <>
            <div style={SCROLL}>
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Employee code</th>
                    <th>Name</th>
                    <th>Active assignments</th>
                    <th>Pending assignments</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {usersData.items.map((u) => {
                    const isSelected = u.userId === selectedId;
                    return (
                      <tr key={u.userId}>
                        <td>
                          {u.accountKey} {!u.active && <Badge tone="bad">inactive</Badge>} {isSelected && <Badge tone="good">selected</Badge>}
                        </td>
                        <td>{u.employee?.employeeCode ?? '—'}</td>
                        <td>{u.employee ? u.employee.displayName : <span className="hint">No employee link</span>}</td>
                        <td>{u.assignments.active}</td>
                        <td>{u.assignments.pending}</td>
                        <td>
                          <button
                            type="button"
                            className="link"
                            aria-pressed={isSelected}
                            aria-label={`Show assignments for ${u.accountKey}`}
                            onClick={() => select(u.userId, u.accountKey)}
                          >
                            Show assignments
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <button type="button" className="secondary" disabled={page <= 1 || users.isPlaceholderData} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <span>
                Page {page} of {pages}
              </span>
              <button type="button" className="secondary" disabled={page >= pages || users.isPlaceholderData} onClick={() => setPage(page + 1)}>
                Next
              </button>
            </div>
          </>
        )}
      </Section>

      {selected && (
        <div ref={panel} className="stack" style={{ gap: '1rem' }}>
          <UserAssignments
            key={selected.userId}
            userId={selected.userId}
            accountKey={selected.accountKey}
            user={known[selected.userId]}
            view={view}
            onClose={() => setSelected(null)}
          />
          {can(ASSIGN_ROLE) && (
            <ProposeGrant
              key={`propose-${selected.userId}`}
              userId={selected.userId}
              userLabel={view.userLabel(selected.userId, selected.accountKey)}
              roles={roles}
              orgDepartments={orgDepartments}
              orgLocations={orgLocations}
            />
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Grant lists: the selected user's assignments and the company's pending approvals
// ---------------------------------------------------------------------------------------------------------

function UserAssignments({
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
      {grants.isPending && <p className="hint">Loading assignments…</p>}
      {isForbidden(grants.error) ? <NotPermitted>The selected role cannot read role assignments.</NotPermitted> : <ErrorNote error={grants.error} />}
      {items && items.length === 0 && <Empty>No role assignments for this user yet.</Empty>}
      {items && items.length > 0 && <GrantTable grants={items} view={view} />}
      {items && items.length >= GRANT_LIST_LIMIT && <p className="hint">Showing the newest {GRANT_LIST_LIMIT} assignments.</p>}
      {items && items.length > 0 && <CatalogueNote state={view.catalogue} />}
    </Section>
  );
}

function PendingApprovals({ view, onSelectUser }: { view: GrantView; onSelectUser: (userId: string, accountKey: string | null) => void }) {
  const keys = useAccessKeys();
  const pending = useQuery({ queryKey: keys.pending, queryFn: () => api<{ items: Grant[] }>('/v1/access/assignments?state=PENDING'), retry: retryTransient });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const items = shown(pending)?.items;
  return (
    <Section title={`Pending approvals${items ? ` (${items.length})` : ''}`}>
      {pending.isPending && <p className="hint">Loading pending grants…</p>}
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

// ---------------------------------------------------------------------------------------------------------
// Proposal (FR-067): a pending grant for the selected user, inside the chosen role's ceiling
// ---------------------------------------------------------------------------------------------------------

function ProposeGrant({
  userId,
  userLabel,
  roles,
  orgDepartments,
  orgLocations,
}: {
  userId: string;
  userLabel: string;
  roles: RolesQuery;
  orgDepartments: OrgQuery;
  orgLocations: OrgQuery;
}) {
  const title = `Propose a grant for ${userLabel}`;
  const catalogue = shown(roles);
  if (roles.isPending) {
    return (
      <Section title={title}>
        <p className="hint">Loading roles…</p>
      </Section>
    );
  }
  if (!catalogue) {
    return (
      <Section title={title}>
        {isForbidden(roles.error) ? <NotPermitted>The selected role cannot read the role catalogue.</NotPermitted> : <ErrorNote error={roles.error} />}
      </Section>
    );
  }
  const active = catalogue.items.filter((r) => r.active);
  return (
    <Section title={title}>
      {active.length === 0 ? <Empty>No active roles can be granted.</Empty> : <ProposeForm userId={userId} roles={active} orgDepartments={orgDepartments} orgLocations={orgLocations} />}
    </Section>
  );
}

const defaultDuties = (role: CatalogueRole | undefined): ReadonlySet<string> =>
  new Set((role?.permissions ?? []).filter((p) => p.defaultDuty && !p.confidential).map((p) => p.key));

function toggled(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function groupByResource(permissions: CataloguePermission[]): [string, CataloguePermission[]][] {
  const groups = new Map<string, CataloguePermission[]>();
  for (const p of permissions) {
    const resource = p.key.split('.')[0] ?? p.key;
    const list = groups.get(resource);
    if (list) list.push(p);
    else groups.set(resource, [p]);
  }
  return [...groups.entries()];
}

/** What a scope filter picker offers: the active entries of the last list the server returned (none before one). */
const pickable = (q: OrgQuery): OrgItem[] => (q.data?.items ?? []).filter((i) => i.active);

function ProposeForm({ userId, roles, orgDepartments, orgLocations }: { userId: string; roles: CatalogueRole[]; orgDepartments: OrgQuery; orgLocations: OrgQuery }) {
  const refresh = useRefreshAccess();
  const id = useId();
  const [roleCode, setRoleCode] = useState('');
  const [scopeKind, setScopeKind] = useState<ScopeKind | ''>('');
  const [from, setFrom] = useState(todayLocal);
  const [to, setTo] = useState('');
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [purpose, setPurpose] = useState('');
  const [departments, setDepartments] = useState<ReadonlySet<string>>(() => new Set());
  const [locations, setLocations] = useState<ReadonlySet<string>>(() => new Set());

  const propose = useMutation({
    mutationFn: (body: ProposalBody) => api<{ id: string; state: string }>('/v1/access/assignments', { method: 'POST', body }),
    onSuccess: () => {
      setRoleCode('');
      setScopeKind('');
      setTo('');
      setChecked(new Set());
      setPurpose('');
      setDepartments(new Set());
      setLocations(new Set());
      refresh();
    },
  });

  const departmentOptions = pickable(orgDepartments);
  const locationOptions = pickable(orgLocations);
  const role = roles.find((r) => r.code === roleCode);
  const eligible = !!role && role.accessClass !== 'OTHER';
  const chosen = role ? role.permissions.filter((p) => checked.has(p.key) && (!p.confidential || eligible)) : [];
  const needsPurpose = chosen.some((p) => p.confidential);
  const fromIso = from ? atLocalMidnight(from) : null;
  const toIso = to ? atLocalMidnight(to) : null;

  const missing: string[] = [];
  if (!role) missing.push('a role');
  if (!scopeKind) missing.push('a scope');
  if (!fromIso) missing.push('an effective-from date');
  if (to && !toIso) missing.push('a valid effective-to date');
  if (chosen.length === 0) missing.push('at least one permission');
  if (needsPurpose && !purpose.trim()) missing.push('a business purpose for the confidential permissions');
  const missingId = `${id}-missing`;

  const chooseRole = (code: string) => {
    const next = roles.find((r) => r.code === code);
    setRoleCode(code);
    setScopeKind(next?.defaultScope ?? '');
    setChecked(defaultDuties(next));
    propose.reset();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (missing.length > 0 || !role || !scopeKind || !fromIso || propose.isPending) return;
    // Exactly the entries the pickers show as chosen, in list order.
    const pick = (ids: ReadonlySet<string>, options: OrgItem[]) => options.filter((i) => ids.has(i.id)).map((i) => i.id);
    const deps = pick(departments, departmentOptions);
    const locs = pick(locations, locationOptions);
    const text = purpose.trim();
    propose.mutate({
      userId,
      roleCode: role.code,
      scopeKind,
      effectiveFrom: fromIso,
      ...(toIso ? { effectiveTo: toIso } : {}),
      permissions: chosen.map((p) => p.key),
      ...(deps.length > 0 || locs.length > 0 ? { filters: { ...(deps.length > 0 ? { departments: deps } : {}), ...(locs.length > 0 ? { locations: locs } : {}) } } : {}),
      ...(text ? { purpose: text } : {}),
    });
  };

  const showFilters = departmentOptions.length > 0 || locationOptions.length > 0;

  return (
    <form className="grid-form" onSubmit={submit} aria-label="Propose a grant">
      <label>
        Role
        <select required value={roleCode} onChange={(e) => chooseRole(e.target.value)}>
          <option value="">Choose a role</option>
          {roles.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name} ({CLASS_LABEL[r.accessClass] ?? r.accessClass})
            </option>
          ))}
        </select>
      </label>
      <label>
        Scope
        <select required disabled={!role} value={scopeKind} onChange={(e) => setScopeKind(e.target.value as ScopeKind | '')}>
          <option value="" disabled>
            Choose a scope
          </option>
          {SCOPES.map((s) => (
            <option key={s} value={s}>
              {SCOPE_LABEL[s]}
              {role?.defaultScope === s ? ' (role default)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        Effective from
        <input type="date" required value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label>
        Effective to (optional)
        <input type="date" value={to} aria-describedby={`${id}-to`} onChange={(e) => setTo(e.target.value)} />
      </label>
      <p className="hint wide" id={`${id}-to`}>
        Access ends at the start of the effective-to day, which must be after the effective-from date.
      </p>

      {role && <PermissionPicker role={role} checked={checked} chosenCount={chosen.length} onToggle={(key) => setChecked((prev) => toggled(prev, key))} />}

      <OrgFilter legend="Restrict to departments (optional)" query={orgDepartments} options={departmentOptions} selected={departments} onToggle={(v) => setDepartments((prev) => toggled(prev, v))} />
      <OrgFilter legend="Restrict to locations (optional)" query={orgLocations} options={locationOptions} selected={locations} onToggle={(v) => setLocations((prev) => toggled(prev, v))} />
      {showFilters && (
        <p className="hint wide">
          Chosen departments and locations narrow the grant: an employee must be in one of the chosen departments (if any) and in one of the chosen locations (if any). Leave
          both empty for no restriction.
        </p>
      )}

      <label className="wide">
        {needsPurpose ? 'Business purpose (required for confidential permissions)' : 'Business purpose (optional)'}
        <textarea rows={2} maxLength={500} required={needsPurpose} value={purpose} style={TEXTAREA} onChange={(e) => setPurpose(e.target.value)} />
      </label>

      <div className="wide row">
        <button type="submit" disabled={missing.length > 0 || propose.isPending} aria-describedby={role && missing.length > 0 ? missingId : undefined}>
          Propose grant
        </button>
        {role && (
          <button type="button" className="secondary" onClick={() => setChecked(defaultDuties(role))}>
            Reset to default duties
          </button>
        )}
      </div>
      {role && missing.length > 0 && (
        <p className="hint wide" id={missingId}>
          Still needed: {missing.join(', ')}.
        </p>
      )}
      {propose.isSuccess && (
        <p className="ok wide" role="status">
          Proposed — needs independent approval
        </p>
      )}
      {propose.error && (
        <div className="wide">
          <ErrorNote error={propose.error} />
        </div>
      )}
    </form>
  );
}

/** The role's ceiling: default duties pre-checked; confidential permissions never pre-checked and clearly labelled. */
function PermissionPicker({ role, checked, chosenCount, onToggle }: { role: CatalogueRole; checked: ReadonlySet<string>; chosenCount: number; onToggle: (key: string) => void }) {
  const hintId = useId();
  const eligible = role.accessClass !== 'OTHER';
  const hasConfidential = role.permissions.some((p) => p.confidential);
  if (role.permissions.length === 0) return <p className="hint wide">This role has no permissions in its ceiling.</p>;
  return (
    <fieldset className="wide">
      <legend>
        Permissions ({chosenCount} of {role.permissions.length} selected)
      </legend>
      <p className="hint">
        The role&apos;s default duties are pre-selected.
        {hasConfidential && eligible && ' Confidential permissions are never pre-selected; choosing one needs a business purpose.'}
      </p>
      {hasConfidential && !eligible && (
        <p className="hint" id={hintId}>
          Confidential permissions are disabled: only Admin or Manager roles can hold confidential permissions.
        </p>
      )}
      {groupByResource(role.permissions).map(([resource, perms]) => (
        <fieldset key={resource} style={GROUP}>
          <legend className="hint">{resource.replace(/_/g, ' ')}</legend>
          <div className="row">
            {perms.map((p) => {
              const disabled = p.confidential && !eligible;
              return (
                <label key={p.key} className="check">
                  <input
                    type="checkbox"
                    checked={!disabled && checked.has(p.key)}
                    disabled={disabled}
                    aria-describedby={disabled ? hintId : undefined}
                    onChange={() => onToggle(p.key)}
                  />
                  <code>{p.key}</code>
                  {p.confidential && <Badge tone="warn">confidential</Badge>}
                  {p.defaultDuty && <span className="hint">default duty</span>}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
    </fieldset>
  );
}

/** A scope filter picker; shown whenever it has entries to offer, so every chosen entry that is sent is visible. */
function OrgFilter({
  legend,
  query,
  options,
  selected,
  onToggle,
}: {
  legend: string;
  query: OrgQuery;
  options: OrgItem[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  if (options.length === 0) {
    // Not readable by the selected role (never requested, or refused): no picker. Any other failure is shown.
    return query.error && !isForbidden(query.error) ? (
      <div className="wide">
        <ErrorNote error={query.error} />
      </div>
    ) : null;
  }
  return (
    <fieldset className="wide">
      <legend>{legend}</legend>
      <div className="row">
        {options.map((i) => (
          <label key={i.id} className="check">
            <input type="checkbox" checked={selected.has(i.id)} onChange={() => onToggle(i.id)} />
            {i.name} <span className="hint">{i.code}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
