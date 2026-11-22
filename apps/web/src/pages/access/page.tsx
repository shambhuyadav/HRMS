// The access administration page: finding a user and showing their assignments, pending approvals and a proposal.

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FilterBar, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { PagerButton, PagerCount, PagerRow } from '@/components/pager';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, isForbidden, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, NotPermitted, Section } from '../../ui';
import { PendingApprovals, UserAssignments } from './grants';
import { ProposeGrant } from './proposal';
import {
  type AccessUser,
  APPROVE_GRANT,
  ASSIGN_ROLE,
  byId,
  type CatalogueRole,
  DIMENSION_NOUN,
  type GrantView,
  type OrgItem,
  type OrgKind,
  PAGE_SIZE,
  READ_USERS,
  type SelectedUser,
  shown,
  useAccessKeys,
  useOrgMaster,
} from './shared';

/** The selected user's assignments and the proposal form, one card under another. */
const SELECTED_USER = 'flex flex-col gap-4';

// ---------------------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------------------

export function AccessAdminPage() {
  const { me, can } = useSession();
  if (!me) return <LoadingLine>Loading…</LoadingLine>;
  if (!can(READ_USERS)) {
    return (
      <Section title="User access">
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
      <h1>User access</h1>
      <Hint>
        A role grant starts as a proposal and gives no access until an independent approver approves it; neither its requester nor its beneficiary can approve it. Rejected and
        revoked grants stay on record.
      </Hint>

      {can(APPROVE_GRANT) && <PendingApprovals view={view} onSelectUser={select} />}

      <Section title={`Users${usersData ? ` (${usersData.total})` : ''}`}>
        <FilterBar>
          <FormField>
            Search users
            <Input type="search" value={search} maxLength={100} placeholder="Account or employee" onChange={(e) => setSearch(e.target.value)} />
          </FormField>
        </FilterBar>
        {users.isPending && <LoadingLine>Loading users…</LoadingLine>}
        {isForbidden(users.error) ? <NotPermitted>The selected role cannot list users for access administration.</NotPermitted> : <ErrorNote error={users.error} />}
        {usersData && !users.isPlaceholderData && usersData.total === 0 && (
          <Empty>{query ? `No users match “${query}”.` : 'No users in your administrative scope.'}</Empty>
        )}
        {usersData && usersData.items.length > 0 && (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Account</TableHead>
                  <TableHead scope="col">Employee code</TableHead>
                  <TableHead scope="col">Name</TableHead>
                  <TableHead scope="col">Active assignments</TableHead>
                  <TableHead scope="col">Pending assignments</TableHead>
                  <TableHead scope="col">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usersData.items.map((u) => {
                  const isSelected = u.userId === selectedId;
                  return (
                    <TableRow key={u.userId}>
                      <TableCell>
                        {u.accountKey} {!u.active && <Badge tone="bad">inactive</Badge>} {isSelected && <Badge tone="good">selected</Badge>}
                      </TableCell>
                      <TableCell>{u.employee?.employeeCode ?? '—'}</TableCell>
                      <TableCell>{u.employee ? u.employee.displayName : <Hint as="span">No employee link</Hint>}</TableCell>
                      <TableCell>{u.assignments.active}</TableCell>
                      <TableCell>{u.assignments.pending}</TableCell>
                      <RowActionsCell>
                        <RowActions>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-pressed={isSelected}
                            aria-label={`Show assignments for ${u.accountKey}`}
                            onClick={() => select(u.userId, u.accountKey)}
                          >
                            Show assignments
                          </Button>
                        </RowActions>
                      </RowActionsCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <PagerRow>
              <PagerButton disabled={page <= 1 || users.isPlaceholderData} onClick={() => setPage(page - 1)}>
                Previous
              </PagerButton>
              <PagerCount>
                Page {page} of {pages}
              </PagerCount>
              <PagerButton disabled={page >= pages || users.isPlaceholderData} onClick={() => setPage(page + 1)}>
                Next
              </PagerButton>
            </PagerRow>
          </>
        )}
      </Section>

      {selected && (
        <div ref={panel} className={SELECTED_USER}>
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
