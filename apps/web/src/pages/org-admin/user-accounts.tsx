// User accounts (§5 System Administrator; §5.1 User to employee; DB007; DB009): the company's accounts, paged and searched, each
// opened for a change, a password reset, deactivation or its links; a new account; and linking an account to an employee. A link
// grants no permission by itself; role assignments stay on the access page. Every call is re-checked by the server.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { FilterBar, FormField } from '@/components/form-field';
import { HintLine } from '@/components/hint';
import { PagerButton, PagerCount, PagerRow } from '@/components/pager';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, Section } from '../../ui';
import { AccountPanel, NewAccountForm, ResetPasswordForm, type SavedAccount } from './accounts';
import { type Issued, IssuedPanel } from './issued-panel';
import { AccountLinks, LinkForm, ReasonAction } from './links';
import { type CompanyUser, DEACTIVATE_USER, LINK_USER, MANAGE_ACCOUNTS } from './shared';

/** Refusals after which what the page shows is out of date: the list (and the open account) are loaded again. */
const RELOAD_ON = new Set(['STALE_VERSION', 'NOT_FOUND', 'ACCOUNT_IN_USE', 'INVALID_STATE']);
const PAGE_SIZE = 25;
/** The issued password, the last outcome and the new account form, stacked above the list with room under them. */
const ABOVE_LIST = 'mb-4 flex flex-col gap-3';

type PanelKind = 'edit' | 'reset';

/** One account in the list, its actions in the last cell, and the change opened on it in a row of its own below. */
function AccountRow(props: {
  user: CompanyUser;
  /** One's own account is changed by another administrator (the server refuses it too). */
  own: boolean;
  open: PanelKind | null;
  manage: boolean;
  canDeactivate: boolean;
  deactivating: boolean;
  onShowLinks: () => void;
  onToggle: (kind: PanelKind) => void;
  onSetActive: (reason: string) => void;
  panel: ReactNode;
}) {
  const { user: u, own, open, manage, canDeactivate, deactivating, onShowLinks, onToggle, onSetActive, panel } = props;
  return (
    <>
      <TableRow>
        <TableCell>
          {u.accountKey}
          {own && <HintLine>Your account</HintLine>}
        </TableCell>
        <TableCell>{u.employee ? `${u.employee.displayName} (${u.employee.employeeCode})` : '—'}</TableCell>
        <TableCell>
          <Badge tone={u.active ? 'good' : 'warn'}>{u.active ? 'Active' : 'Inactive'}</Badge>
        </TableCell>
        <TableCell>
          {u.assignments.active} active, {u.assignments.pending} pending
        </TableCell>
        <RowActionsCell>
          <RowActions>
            <Button type="button" variant="outline" size="sm" aria-label={`Show links of ${u.accountKey}`} onClick={onShowLinks}>
              Links
            </Button>{' '}
            {manage && !own && (
              <>
                <Button type="button" variant="outline" size="sm" aria-label={`Edit ${u.accountKey}`} aria-expanded={open === 'edit'} onClick={() => onToggle('edit')}>
                  Edit
                </Button>{' '}
                {u.active && (
                  <>
                    <Button type="button" variant="outline" size="sm" aria-label={`Reset password of ${u.accountKey}`} aria-expanded={open === 'reset'} onClick={() => onToggle('reset')}>
                      Reset password
                    </Button>{' '}
                  </>
                )}
              </>
            )}
            {canDeactivate && (
              <ReasonAction
                key={`${u.userId}-${u.version}`}
                danger={u.active}
                verb={u.active ? 'Deactivate' : 'Reactivate'}
                label={u.active ? `Deactivate ${u.accountKey}` : `Reactivate ${u.accountKey}`}
                pending={deactivating}
                onSubmit={onSetActive}
              />
            )}
          </RowActions>
        </RowActionsCell>
      </TableRow>
      {panel && (
        <TableRow>
          <TableCell colSpan={5}>{panel}</TableCell>
        </TableRow>
      )}
    </>
  );
}

export function UserAccountsPage() {
  const { can, me } = useSession();
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<CompanyUser | null>(null);
  const [creating, setCreating] = useState(false);
  /** The one row opened for a change (its panel shows under it). */
  const [panel, setPanel] = useState<{ userId: string; kind: PanelKind } | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [linkPrefill, setLinkPrefill] = useState('');
  const manage = can(MANAGE_ACCOUNTS);
  const users = useQuery({
    queryKey: ['access-users', search, page],
    queryFn: () => api<{ items: CompanyUser[]; total: number }>(`/v1/access/users?page=${page}&pageSize=${PAGE_SIZE}${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ''}`),
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['access-users'] });
    void client.invalidateQueries({ queryKey: ['user-links'] });
    void client.invalidateQueries({ queryKey: ['access-account'] });
  };
  const reloadIfStale = (error: unknown) => {
    if (error instanceof ApiError && RELOAD_ON.has(error.code)) refresh();
  };
  const issue = (next: Issued) => {
    setNotice(null);
    setPanel(null);
    setIssued(next);
    refresh();
  };
  const saved = (account: SavedAccount) => {
    setPanel(null);
    setNotice(`Saved ${account.accountKey}.`);
    if (selected?.userId === account.userId) setSelected({ ...selected, accountKey: account.accountKey });
    refresh();
  };
  const deleted = (user: CompanyUser) => {
    setPanel(null);
    // The row goes at once; the reload that follows confirms it.
    client.setQueriesData<{ items: CompanyUser[]; total: number }>({ queryKey: ['access-users'] }, (old) =>
      old ? { items: old.items.filter((x) => x.userId !== user.userId), total: Math.max(0, old.total - 1) } : old,
    );
    if (selected?.userId === user.userId) setSelected(null);
    setNotice(`Deleted ${user.accountKey}.`);
    refresh();
  };
  const setActive = useMutation({
    mutationFn: ({ user, active, reason }: { user: CompanyUser; active: boolean; reason: string }) =>
      api(`/v1/access/users/${user.userId}/${active ? 'reactivate' : 'deactivate'}`, { body: { expectedVersion: user.version, reason } }),
    onSuccess: refresh,
  });
  const pages = Math.max(1, Math.ceil((users.data?.total ?? 0) / PAGE_SIZE));
  /** The change opened on a row: its edit panel or its password reset. */
  const panelFor = (u: CompanyUser, kind: PanelKind | null) => {
    if (kind === 'edit') return <AccountPanel user={u} onSaved={saved} onDeleted={() => deleted(u)} onRefused={reloadIfStale} onClose={() => setPanel(null)} />;
    if (kind === 'reset') {
      return (
        <ResetPasswordForm
          user={u}
          onRefused={reloadIfStale}
          onCancel={() => setPanel(null)}
          onReset={(result) => issue({ kind: 'reset', accountKey: u.accountKey, temporaryPassword: result.temporaryPassword, sessionsRevoked: result.sessionsRevoked })}
        />
      );
    }
    return null;
  };
  return (
    <>
      <Section
        title={`User accounts${users.data ? ` (${users.data.total})` : ''}`}
        actions={
          manage ? (
            <Button type="button" size="sm" aria-expanded={creating} onClick={() => setCreating(!creating)}>
              New account
            </Button>
          ) : undefined
        }
      >
        {(issued || notice || (manage && creating)) && (
          <div className={ABOVE_LIST}>
            {issued && <IssuedPanel issued={issued} linkPrefilled={issued.kind === 'created' && can(LINK_USER)} onDone={() => setIssued(null)} />}
            {notice && (
              <StatusNote tone="success" role="status" className="m-0">
                {notice}
              </StatusNote>
            )}
            {manage && creating && (
              <Section title="New account">
                <NewAccountForm
                  onCancel={() => setCreating(false)}
                  onCreated={(created) => {
                    setCreating(false);
                    if (can(LINK_USER)) setLinkPrefill(created.accountKey);
                    issue({ kind: 'created', accountKey: created.accountKey, temporaryPassword: created.temporaryPassword });
                  }}
                />
              </Section>
            )}
          </div>
        )}
        <FilterBar>
          <FormField>
            Search
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </FormField>
        </FilterBar>
        {users.data?.items.length === 0 && <Empty>No accounts match.</Empty>}
        {users.data && users.data.items.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Account</TableHead>
                <TableHead scope="col">Employee</TableHead>
                <TableHead scope="col">State</TableHead>
                <TableHead scope="col">Assignments</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data.items.map((u) => {
                const own = me?.userId === u.userId;
                const open = manage && !own && panel?.userId === u.userId ? panel.kind : null;
                return (
                  <AccountRow
                    key={u.userId}
                    user={u}
                    own={own}
                    open={open}
                    manage={manage}
                    canDeactivate={can(DEACTIVATE_USER)}
                    deactivating={setActive.isPending}
                    onShowLinks={() => setSelected(u)}
                    onToggle={(kind) => {
                      setNotice(null);
                      setPanel(open === kind ? null : { userId: u.userId, kind });
                    }}
                    onSetActive={(reason) => setActive.mutate({ user: u, active: !u.active, reason })}
                    panel={panelFor(u, open)}
                  />
                );
              })}
            </TableBody>
          </Table>
        )}
        <PagerRow>
          <PagerButton disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </PagerButton>
          <PagerCount>
            Page {page} of {pages}
          </PagerCount>
          <PagerButton disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next
          </PagerButton>
        </PagerRow>
        <ErrorNote error={users.error ?? setActive.error} />
        {selected && <AccountLinks account={selected} onChanged={refresh} />}
      </Section>
      {can(LINK_USER) && (
        <Section title="Link an account to an employee">
          <LinkForm key={linkPrefill} accountKey={linkPrefill} onDone={refresh} />
        </Section>
      )}
    </>
  );
}
