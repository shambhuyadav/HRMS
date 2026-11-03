// Delegation of a reviewer's decisions (FR-003, FR-068; DF03; DB018; C4 "Delegated task"). A reviewer asks to pass one kind
// of decision to a colleague for at most 30 calendar days; someone else approves it; either can see it, and the reviewer
// or an administrator can end it early. The server decides every rule (who is eligible, the 30-day limit, no redelegation,
// independent approval) and re-checks the delegation at every decision. This screen hides what the selected assignment cannot
// use and says plainly what happens to tasks: they never move by themselves when a delegation starts or ends.
// Cached answers are keyed by the selected company and assignment, so one role's view is never shown under another.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { api, ApiError, formatDate } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Section } from '../ui';

const DELEGATE = 'access.delegate.operational';
const READ_USERS = 'access.read_users.operational';
const APPROVE = 'access.approve_role_grant.operational';
const REVOKE = 'access.revoke_role.operational';

interface Person {
  userId: string;
  accountKey: string;
  employeeCode: string | null;
  displayName: string | null;
}

type Status = 'PENDING' | 'SCHEDULED' | 'LIVE' | 'EXPIRED' | 'ENDED' | 'REJECTED' | 'WITHDRAWN';

/** GET /v1/me/delegations and GET /v1/access/delegations (modules/access/delegation.ts delegationView). */
interface Delegation {
  id: string;
  delegator: Person;
  delegate: Person;
  permission: string;
  confidential: boolean;
  kinds: string[];
  effectiveFrom: string;
  effectiveTo: string;
  state: string;
  status: Status;
  purpose: string | null;
  requestedBy: Person | null;
  approvedBy: Person | null;
  rejectionReason: string | null;
  endReason: string | null;
  version: number;
  /** Only for the parties; an administrator holds no row scope over the tasks. */
  openTasks: number | null;
}

/** GET .../delegations/:id/decisions: no employee and no reason, only what was decided under the delegation and by whom. */
interface DecisionTaken {
  taskId: string;
  kind: string;
  stepAction: string;
  decision: string;
  decidedAt: string;
  actor: Person;
}

interface DelegableOption {
  permission: string;
  kinds: string[];
  confidential: boolean;
}

interface EndResult {
  id: string;
  state: string;
  openTasks: number;
}

const STATUS: Record<Status, { text: string; tone: 'neutral' | 'good' | 'warn' | 'bad' }> = {
  PENDING: { text: 'Waiting for approval', tone: 'warn' },
  SCHEDULED: { text: 'Approved, not started', tone: 'neutral' },
  LIVE: { text: 'Live', tone: 'good' },
  EXPIRED: { text: 'Expired', tone: 'neutral' },
  ENDED: { text: 'Ended early', tone: 'neutral' },
  REJECTED: { text: 'Rejected', tone: 'bad' },
  WITHDRAWN: { text: 'Withdrawn', tone: 'neutral' },
};

const nameOf = (p: Person | null | undefined): string => (p ? (p.displayName ?? p.accountKey) : '—');
const kindText = (k: string) => k.replace(/_/g, ' ');
const kindsText = (kinds: string[]) => (kinds.length ? kinds.map(kindText).join(', ') : 'approval');
const pad = (n: number) => String(n).padStart(2, '0');
/** An instant as the browser's local day and time: a delegation starts and ends at a moment, not on a date. */
const when = (iso: string) => {
  const d = new Date(iso);
  return `${formatDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function useContextKey() {
  const { stored } = useSession();
  return `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
}

/** Everything cached here shares this prefix, so a change refreshes every list. */
const KEY = ['delegations'] as const;

function useRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: KEY });
    // The decision inbox shows delegated tasks.
    void qc.invalidateQueries({ queryKey: ['tasks'] });
  };
}

// ---------------------------------------------------------------------------------------------------------
// The "delegated" indication on decision tasks (FR-096: the task says in which role the user acts)
// ---------------------------------------------------------------------------------------------------------

/** GET /v1/me/delegated-tasks: the open tasks the selected assignment decides as a delegate, whichever queue lists them. */
interface DelegatedTask {
  taskId: string;
  kind: string;
  ownerName: string | null;
  ownerEmployeeCode: string | null;
  delegationId: string;
  delegatedUntil: string;
  delegator: Person;
}

function useDelegatedTasks() {
  const context = useContextKey();
  // Under ['tasks'], so a decision refreshes it with the queues.
  return useQuery({ queryKey: ['tasks', 'delegated', context], queryFn: () => api<{ items: DelegatedTask[] }>('/v1/me/delegated-tasks') });
}

/** Shown next to a decision task when the caller decides it as someone's delegate; nothing otherwise. */
export function DelegatedBadge({ taskId }: { taskId: string }) {
  const { me } = useSession();
  const task = (useDelegatedTasks().data?.items ?? []).find((t) => t.taskId === taskId);
  if (!task) return null;
  return (
    <>
      {' '}
      <Badge tone="warn">delegated</Badge>{' '}
      <span className="hint">
        from {nameOf(task.delegator)} until {when(task.delegatedUntil)}
        {me?.roleName ? `; you decide as ${me.roleName}` : ''}
      </span>
    </>
  );
}

/** Top of the decision inbox: what the caller decides for someone else now, and the role they act in. */
export function DelegatedTasksSection() {
  const { me } = useSession();
  const items = useDelegatedTasks().data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Section title={`Delegated to you (${items.length})`}>
      <p className="hint">
        You decide these as a delegate{me?.roleName ? `, acting as ${me.roleName}` : ''}. Your own permissions apply; a delegation adds none. When a delegation ends these stop being yours to read or decide. See{' '}
        <a href="/delegations">My delegations</a>.
      </p>
      <ul>
        {items.map((t) => (
          <li key={t.taskId}>
            <strong>{t.ownerName ?? 'Request'}</strong> <span className="hint">{t.ownerEmployeeCode}</span> · {kindText(t.kind)} · from {nameOf(t.delegator)} until {when(t.delegatedUntil)}
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Lists and actions
// ---------------------------------------------------------------------------------------------------------

function ReasonForm({ label, confirm, pending, error, onConfirm, onCancel }: { label: string; confirm: string; pending: boolean; error: unknown; onConfirm: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  return (
    <form
      className="stack"
      style={{ gap: '0.4rem' }}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (reason.trim() && !pending) onConfirm(reason.trim());
      }}
    >
      <input aria-label={label} placeholder="Reason (required)" required maxLength={500} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="row">
        <button type="submit" className="danger" disabled={!reason.trim() || pending}>
          {confirm}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <ErrorNote error={error} />
    </form>
  );
}

/** What each person named sees about the tasks a delegation leaves behind: the BRD moves none of them by itself. */
function openTasksNote(openTasks: number): string {
  return openTasks === 0
    ? 'No delegated task was open.'
    : `${openTasks} delegated ${openTasks === 1 ? 'task stays' : 'tasks stay'} open: nothing moves by itself, so ${openTasks === 1 ? 'it waits' : 'they wait'} for routing administration to reroute.`;
}

function Actions({ d, administering, onNote }: { d: Delegation; administering: boolean; onNote: (text: string) => void }) {
  const { can, me } = useSession();
  const refresh = useRefresh();
  const [mode, setMode] = useState<'reject' | 'end' | null>(null);
  const url = (action: string) => `/v1/access/delegations/${encodeURIComponent(d.id)}/${action}`;
  const subject = `${nameOf(d.delegator)} to ${nameOf(d.delegate)}`;
  const staleNote = (error: unknown) => {
    if (error instanceof ApiError && error.code === 'STALE_VERSION') {
      onNote(`The delegation from ${subject} changed before your action, so the list was reloaded. Check it before acting again.`);
      refresh();
    }
  };
  const approve = useMutation({
    mutationFn: () => api(url('approve'), { method: 'POST', body: { expectedVersion: d.version } }),
    onSuccess: () => {
      onNote(`Approved: ${subject}. New tasks go to the delegate from its start.`);
      refresh();
    },
    onError: staleNote,
  });
  const reject = useMutation({
    mutationFn: (reason: string) => api(url('reject'), { method: 'POST', body: { expectedVersion: d.version, reason } }),
    onSuccess: () => {
      setMode(null);
      onNote(`Rejected: ${subject}.`);
      refresh();
    },
    onError: staleNote,
  });
  const end = useMutation({
    mutationFn: (reason: string) => api<EndResult>(url('end'), { method: 'POST', body: { expectedVersion: d.version, reason } }),
    onSuccess: (r) => {
      setMode(null);
      onNote(r.state === 'WITHDRAWN' ? `Withdrawn: ${subject}.` : `Ended: ${subject}. ${openTasksNote(r.openTasks)}`);
      refresh();
    },
    onError: staleNote,
  });

  const isDelegator = d.delegator.accountKey === me?.accountKey;
  const isParty = isDelegator || d.delegate.accountKey === me?.accountKey;
  const running = d.status === 'LIVE' || d.status === 'SCHEDULED';
  const canApprove = administering && d.status === 'PENDING' && can(APPROVE) && !isParty;
  const canReject = administering && d.status === 'PENDING' && can(APPROVE);
  const canEnd = (running && (administering ? can(REVOKE) : isDelegator && can(DELEGATE))) || (!administering && d.status === 'PENDING' && isDelegator && can(DELEGATE));
  if (!canApprove && !canReject && !canEnd) return <ErrorNote error={approve.error} />;
  const ending = d.status === 'PENDING' ? 'Withdraw' : 'End early';

  if (mode === 'reject') {
    return <ReasonForm label={`Reason for rejecting ${subject}`} confirm="Confirm rejection" pending={reject.isPending} error={reject.error} onConfirm={(r) => reject.mutate(r)} onCancel={() => setMode(null)} />;
  }
  if (mode === 'end') {
    return <ReasonForm label={`Reason to ${ending.toLowerCase()} ${subject}`} confirm={`Confirm: ${ending.toLowerCase()}`} pending={end.isPending} error={end.error} onConfirm={(r) => end.mutate(r)} onCancel={() => setMode(null)} />;
  }
  return (
    <div className="stack" style={{ gap: '0.4rem' }}>
      <div className="row">
        {canApprove && (
          <button type="button" disabled={approve.isPending} onClick={() => approve.mutate()}>
            Approve
          </button>
        )}
        {canReject && (
          <button type="button" className="danger" onClick={() => setMode('reject')}>
            Reject
          </button>
        )}
        {canEnd && (
          <button type="button" className="danger" onClick={() => setMode('end')}>
            {ending}
          </button>
        )}
      </div>
      {administering && d.status === 'PENDING' && isParty && <p className="hint">You are a party to this delegation, so someone else approves it.</p>}
      <ErrorNote error={approve.error} />
    </div>
  );
}

/** C4 "Preserve delegator, delegate and actual actor in history": the decisions taken under this delegation; asked for when opened. */
function DecisionsTaken({ d, administering }: { d: Delegation; administering: boolean }) {
  const context = useContextKey();
  const [open, setOpen] = useState(false);
  const url = `/v1/${administering ? 'access' : 'me'}/delegations/${encodeURIComponent(d.id)}/decisions`;
  const decisions = useQuery({ queryKey: [...KEY, context, 'decisions', d.id], enabled: open, queryFn: () => api<{ items: DecisionTaken[] }>(url) });
  if (!d.approvedBy) return null;
  return (
    <div>
      <button type="button" className="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
        Decisions taken
      </button>
      {open && decisions.data?.items.length === 0 && <p className="hint">No decision was taken under this delegation.</p>}
      {open && !!decisions.data?.items.length && (
        <ul>
          {decisions.data.items.map((t) => (
            <li key={t.taskId}>
              {kindText(t.kind)}: {t.decision.toLowerCase()} by {nameOf(t.actor)} on {when(t.decidedAt)}, on the authority of {nameOf(d.delegator)}
            </li>
          ))}
        </ul>
      )}
      {open && <ErrorNote error={decisions.error} />}
    </div>
  );
}

function DelegationTable({ items, administering, onNote }: { items: Delegation[]; administering: boolean; onNote: (text: string) => void }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table>
        <thead>
          <tr>
            <th>From</th>
            <th>To</th>
            <th>Decisions</th>
            <th>Period</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id}>
              <td>{nameOf(d.delegator)}</td>
              <td>{nameOf(d.delegate)}</td>
              <td>
                {kindsText(d.kinds)} {d.confidential && <Badge tone="warn">confidential</Badge>}
                <div className="hint">{d.permission}</div>
                {d.purpose && <div className="hint">{d.purpose}</div>}
              </td>
              <td>
                {when(d.effectiveFrom)} – {when(d.effectiveTo)}
              </td>
              <td>
                <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].text}</Badge>
                {d.approvedBy && <div className="hint">Approved by {nameOf(d.approvedBy)}</div>}
                {d.rejectionReason && <div className="hint">{d.rejectionReason}</div>}
                {d.endReason && <div className="hint">{d.endReason}</div>}
                {!!d.openTasks && <div className="hint">{`${d.openTasks} open ${d.openTasks === 1 ? 'task' : 'tasks'}`}</div>}
              </td>
              <td>
                <Actions d={d} administering={administering} onNote={onNote} />
                <DecisionsTaken d={d} administering={administering} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="hint">
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------------------------------------

function RequestForm({ onNote }: { onNote: (text: string) => void }) {
  const context = useContextKey();
  const refresh = useRefresh();
  const options = useQuery({ queryKey: [...KEY, context, 'options'], queryFn: () => api<{ items: DelegableOption[] }>('/v1/access/delegations/options') });
  const [permission, setPermission] = useState('');
  const [delegate, setDelegate] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [purpose, setPurpose] = useState('');
  const candidates = useQuery({
    queryKey: [...KEY, context, 'candidates', permission],
    enabled: permission !== '',
    queryFn: () => api<{ items: { userId: string; accountKey: string; employeeCode: string | null; displayName: string | null }[] }>(`/v1/access/delegations/candidates?permission=${encodeURIComponent(permission)}`),
  });
  const ask = useMutation({
    mutationFn: () =>
      api<{ id: string; state: string }>('/v1/access/delegations', {
        method: 'POST',
        body: { delegateUserId: delegate, permission, effectiveFrom: new Date(from).toISOString(), effectiveTo: new Date(to).toISOString(), ...(purpose.trim() ? { purpose: purpose.trim() } : {}) },
      }),
    onSuccess: () => {
      setPermission('');
      setDelegate('');
      setFrom('');
      setTo('');
      setPurpose('');
      onNote('Your request is waiting for an independent approver. Nothing changes until it is approved.');
      refresh();
    },
  });
  const items = options.data?.items ?? [];
  if (options.error) return <ErrorNote error={options.error} />;
  if (options.data && items.length === 0) return <Empty>The selected role holds no decisions that can be delegated.</Empty>;
  const ready = permission !== '' && delegate !== '' && from !== '' && to !== '' && !ask.isPending;
  return (
    <form
      className="stack"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (ready) ask.mutate();
      }}
    >
      <label>
        Decisions to delegate
        <select
          value={permission}
          required
          onChange={(e) => {
            setPermission(e.target.value);
            setDelegate('');
          }}
        >
          <option value="">Choose…</option>
          {items.map((o) => (
            <option key={o.permission} value={o.permission}>
              {`${kindsText(o.kinds)} (${o.permission})${o.confidential ? ', confidential' : ''}`}
            </option>
          ))}
        </select>
      </label>
      <label>
        Delegate
        <select value={delegate} required disabled={permission === ''} onChange={(e) => setDelegate(e.target.value)}>
          <option value="">Choose…</option>
          {(candidates.data?.items ?? []).map((c) => (
            <option key={c.userId} value={c.userId}>
              {c.displayName ? `${c.displayName} (${c.employeeCode ?? c.accountKey})` : c.accountKey}
            </option>
          ))}
        </select>
      </label>
      {candidates.data?.items.length === 0 && (
        <p className="hint">Nobody else can take these decisions. A delegate needs their own approved assignment that holds this permission, in Assigned or Company scope, of equivalent authority.</p>
      )}
      <ErrorNote error={candidates.error} />
      <label>
        From (included)
        <input type="datetime-local" required value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label>
        Until (not included)
        <input type="datetime-local" required value={to} onChange={(e) => setTo(e.target.value)} />
      </label>
      <p className="hint">At most 30 calendar days. The delegate cannot delegate these decisions again and uses only their own permissions. Tasks already waiting for you stay with you.</p>
      <label>
        Purpose (optional)
        <input maxLength={500} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
      </label>
      <div className="row">
        <button type="submit" disabled={!ready}>
          Ask for approval
        </button>
      </div>
      <ErrorNote error={ask.error} />
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------------------------------------

function MyDelegationsScreen() {
  const { can } = useSession();
  const context = useContextKey();
  const [note, setNote] = useState<string | null>(null);
  const mine = useQuery({ queryKey: [...KEY, context, 'mine'], queryFn: () => api<{ items: Delegation[] }>('/v1/me/delegations') });
  return (
    <>
      {can(DELEGATE) && (
        <Section title="Delegate my decisions">
          <RequestForm onNote={setNote} />
        </Section>
      )}
      <Section title="My delegations">
        {note && <Note>{note}</Note>}
        {mine.data?.items.length === 0 && <Empty>You have not given or received a delegation.</Empty>}
        {!!mine.data?.items.length && <DelegationTable items={mine.data.items} administering={false} onNote={setNote} />}
        <ErrorNote error={mine.error} />
      </Section>
    </>
  );
}

const STATE_FILTERS = ['PENDING', 'ACTIVE', 'ENDED', 'REJECTED', 'WITHDRAWN'] as const;

function DelegationApprovalsScreen() {
  const { can } = useSession();
  const context = useContextKey();
  const [state, setState] = useState<string>('PENDING');
  const [note, setNote] = useState<string | null>(null);
  const allowed = can(READ_USERS);
  const list = useQuery({
    queryKey: [...KEY, context, 'admin', state],
    enabled: allowed,
    queryFn: () => api<{ items: Delegation[] }>(`/v1/access/delegations${state ? `?state=${encodeURIComponent(state)}` : ''}`),
  });
  if (!allowed) return <Empty>The selected role cannot read delegations.</Empty>;
  return (
    <Section title="Delegations">
      <label>
        Show
        <select aria-label="Show" value={state} onChange={(e) => setState(e.target.value)}>
          {STATE_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === 'ACTIVE' ? 'Approved' : s.charAt(0) + s.slice(1).toLowerCase()}
            </option>
          ))}
          <option value="">All</option>
        </select>
      </label>
      {note && <Note>{note}</Note>}
      {list.data?.items.length === 0 && <Empty>No delegations here.</Empty>}
      {!!list.data?.items.length && <DelegationTable items={list.data.items} administering onNote={setNote} />}
      <ErrorNote error={list.error} />
    </Section>
  );
}

export const DELEGATION_SCREENS: ScreenRoute[] = [
  { path: '/delegations', title: 'My delegations', permission: DELEGATE, nav: true, component: MyDelegationsScreen },
  { path: '/access/delegations', title: 'Delegation approvals', permission: APPROVE, nav: true, component: DelegationApprovalsScreen },
];
