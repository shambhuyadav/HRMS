import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, LIST_PAGE_SIZE, Pager, pageParams, Section } from '../ui';

// ---------------------------------------------------------------------------------------------------------
// Own notification preferences (FR-083, FR-085, DF12) and the delivery log (FR-061, FR-085, BR-034). The log shows states,
// attempts and failure codes, never message content or an event's payload; the server re-checks every call.
// ---------------------------------------------------------------------------------------------------------

interface Preference {
  eventType: string;
  publishCelebration: boolean;
  receiveOptional: boolean;
  /** FR-085 email channel: receipt by email, which matters only once the company has enabled email for the occasion. */
  receiveEmail?: boolean;
}

/** What each choice does, in the reader's words; each choice is its own labelled checkbox. */
const OCCASIONS: Record<string, { name: string; share: string; see: string; email: string }> = {
  BIRTHDAY: { name: 'Birthday', share: 'Share my birthday with colleagues', see: 'See colleagues’ birthdays', email: 'Also email me about colleagues’ birthdays' },
  WORK_ANNIVERSARY: {
    name: 'Work anniversary',
    share: 'Share my work anniversary with colleagues',
    see: 'See colleagues’ work anniversaries',
    email: 'Also email me about colleagues’ work anniversaries',
  },
};

const occasionOf = (eventType: string) => {
  const known = OCCASIONS[eventType];
  if (known) return known;
  const name = eventType.replace(/_/g, ' ').toLowerCase();
  return { name: name.charAt(0).toUpperCase() + name.slice(1), share: `Share my ${name} with colleagues`, see: `See colleagues’ ${name}`, email: `Also email me about colleagues’ ${name}` };
};

/** GET and PUT /v1/me/notification-preferences: the user's own choices, with or without a selected role. */
export function NotificationPreferencesPanel() {
  const { stored } = useSession();
  const qc = useQueryClient();
  // The selected company is part of the key: preferences are held per company.
  const key = ['notification-preferences', stored?.companyId ?? '-'] as const;
  const preferences = useQuery({ queryKey: key, queryFn: () => api<{ items: Preference[] }>('/v1/me/notification-preferences', { withoutAssignment: true }) });
  const save = useMutation({
    mutationFn: (change: { eventType: string; publishCelebration?: boolean; receiveOptional?: boolean; receiveEmail?: boolean }) =>
      api('/v1/me/notification-preferences', { method: 'PUT', body: change, withoutAssignment: true }),
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });
  return (
    <Section title="Notification preferences">
      <p className="hint">
        Your occasions are hidden unless you share them. Colleagues then see your name, department and the occasion, never your birth date, year or age. Notices about your tasks,
        decisions and account security always reach you and cannot be switched off.
      </p>
      <p className="hint">Email is sent only for notices your company has enabled for email. It says what happened and links here, never confidential details.</p>
      {preferences.isPending && <p className="hint loading">Loading preferences…</p>}
      {/* One block per occasion, each choice a labelled checkbox: it fits a phone screen, where a four-column table would not. */}
      {preferences.data && (
        <div className="stack">
          {preferences.data.items.map((p) => {
            const occasion = occasionOf(p.eventType);
            return (
              <fieldset key={p.eventType}>
                <legend>{occasion.name}</legend>
                <label className="check">
                  <input type="checkbox" checked={p.publishCelebration} disabled={save.isPending} onChange={(e) => save.mutate({ eventType: p.eventType, publishCelebration: e.target.checked })} />{' '}
                  {occasion.share}
                </label>
                <label className="check">
                  <input type="checkbox" checked={p.receiveOptional} disabled={save.isPending} onChange={(e) => save.mutate({ eventType: p.eventType, receiveOptional: e.target.checked })} />{' '}
                  {occasion.see}
                </label>
                <label className="check">
                  <input type="checkbox" checked={p.receiveEmail ?? true} disabled={save.isPending} onChange={(e) => save.mutate({ eventType: p.eventType, receiveEmail: e.target.checked })} />{' '}
                  {occasion.email}
                </label>
              </fieldset>
            );
          })}
        </div>
      )}
      <ErrorNote error={preferences.error} />
      <ErrorNote error={save.error} />
    </Section>
  );
}

/** GET /v1/notifications/delivery and .../failed-events, under one duty. */
const READ_DELIVERY = 'notification.read_delivery.operational';
const EXPORT_DELIVERY = 'notification.export.operational';

interface DeliveryRow {
  id: string;
  category: string;
  channel: string;
  state: string;
  recipientAccount: string;
  occurredAt: string;
  attempts: number;
  lastFailureCode: string | null;
}

interface FailedEvent {
  id: string;
  topic: string;
  state: string;
  occurredAt: string;
  attempts: number;
  failureCode: string | null;
  nextAttemptAt: string | null;
}

interface PagedList<T> {
  items: T[];
  total: number;
}

const DELIVERY_STATES = ['QUEUED', 'DELIVERED', 'RETRY_PENDING', 'FAILED', 'SUPPRESSED'];
const STATE_TONES: Record<string, 'good' | 'warn' | 'bad'> = { DELIVERED: 'good', RETRY_PENDING: 'warn', RETRYING: 'warn', SUPPRESSED: 'warn', FAILED: 'bad' };
/** A rule's event type as the server keeps it (modules/notification/routes.ts). */
const EVENT_CODE = /^[A-Z][A-Z0-9_]{0,59}$/;

const readable = (code: string) => code.replace(/_/g, ' ').toLowerCase();
const when = (iso: string) => new Date(iso).toLocaleString();
const StateText = ({ state }: { state: string }) => <Badge tone={STATE_TONES[state] ?? 'neutral'}>{readable(state)}</Badge>;

function FailedEventsSection({ scopeKey }: { scopeKey: string }) {
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const events = useQuery({
    queryKey: ['notification-failed-events', scopeKey, state, page],
    queryFn: () => api<PagedList<FailedEvent>>(`/v1/notifications/delivery/failed-events?${pageParams(page)}${state ? `&state=${state}` : ''}`),
  });
  return (
    <Section title={`Events not dispatched${events.data ? ` (${events.data.total})` : ''}`}>
      <p className="hint">An event that fails is retried after 1, 5 and 15 minutes, then stays failed. It created no notification, so it is listed here. It never undoes the business action behind it.</p>
      <label className="inline">
        State{' '}
        <select
          value={state}
          onChange={(e) => {
            setState(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All</option>
          <option value="RETRYING">Retrying</option>
          <option value="FAILED">Failed</option>
        </select>
      </label>
      {events.data?.items.length === 0 && <Empty>No events are retrying or failed.</Empty>}
      {events.data && events.data.items.length > 0 && (
        <table aria-label="Events not dispatched">
          <thead>
            <tr>
              <th scope="col">Raised</th>
              <th scope="col">Topic</th>
              <th scope="col">State</th>
              <th scope="col">Attempts</th>
              <th scope="col">Error class</th>
              <th scope="col">Next attempt</th>
            </tr>
          </thead>
          <tbody>
            {events.data.items.map((e) => (
              <tr key={e.id}>
                <td>{when(e.occurredAt)}</td>
                <td>{e.topic}</td>
                <td>
                  <StateText state={e.state} />
                </td>
                <td>{e.attempts}</td>
                <td>{e.failureCode ?? '—'}</td>
                <td>{e.nextAttemptAt ? when(e.nextAttemptAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {events.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={events.data.total} onPage={setPage} label="Pages of events not dispatched" noun="event" />}
      <ErrorNote error={events.error} />
    </Section>
  );
}

export function DeliveryLogPage() {
  const { can, stored } = useSession();
  const allowed = can(READ_DELIVERY);
  const scopeKey = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  const [state, setState] = useState('');
  const [typed, setTyped] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const category = typed.trim().toUpperCase().replace(/[\s-]+/g, '_');
  const categoryInvalid = category !== '' && !EVENT_CODE.test(category);
  const log = useQuery({
    queryKey: ['notification-delivery', scopeKey, state, category, from, to, page],
    enabled: allowed && !categoryInvalid,
    queryFn: () =>
      api<PagedList<DeliveryRow>>(
        `/v1/notifications/delivery?${pageParams(page)}${state ? `&state=${state}` : ''}${category ? `&category=${encodeURIComponent(category)}` : ''}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`,
      ),
  });
  // FR-093: the export holds what these filters show, plus the events that failed to dispatch for the same period (below).
  const exportLog = useMutation({
    mutationFn: () => api<{ id: string }>('/v1/reports', { body: { reportCode: 'NOTIFICATION_DELIVERY', filters: { from, to, ...(state ? { status: state } : {}), ...(category ? { category } : {}) } } }),
  });
  if (!allowed) {
    return (
      <Section title="Delivery log">
        <Empty>The selected role cannot read the delivery log; that needs the delivery log grant.</Empty>
      </Section>
    );
  }
  return (
    <>
      <Section title={`Delivery log${log.data ? ` (${log.data.total})` : ''}`}>
        <p className="hint">The state of each notification, its attempts and the code of its last failure. Message content is never shown here. A failed or suppressed notice does not change the decision it was about.</p>
        <div className="inline">
          <label className="inline">
            State{' '}
            <select
              value={state}
              onChange={(e) => {
                setState(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              {DELIVERY_STATES.map((s) => (
                <option key={s} value={s}>
                  {readable(s)}
                </option>
              ))}
            </select>
          </label>
          <label className="inline">
            Event{' '}
            <input
              value={typed}
              placeholder="EXPENSE_DECIDED"
              onChange={(e) => {
                setTyped(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="inline">
            From{' '}
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="inline">
            To{' '}
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
            />
          </label>
          {can(EXPORT_DELIVERY) && (
            <button type="button" className="secondary" disabled={!from || !to || categoryInvalid || exportLog.isPending} onClick={() => exportLog.mutate()}>
              Export this log
            </button>
          )}
        </div>
        {can(EXPORT_DELIVERY) && (!from || !to) && <p className="hint">An export covers a period: choose both dates.</p>}
        {exportLog.isSuccess && <p className="ok">Export requested. Download it from Reports when it is ready.</p>}
        <ErrorNote error={exportLog.error} />
        {categoryInvalid && <p className="hint">An event code has letters, digits and underscores and starts with a letter.</p>}
        {log.isFetching && !log.data && <p className="hint loading">Loading the log…</p>}
        {log.data?.items.length === 0 && <Empty>No notifications match.</Empty>}
        {log.data && log.data.items.length > 0 && (
          <table aria-label="Delivery log">
            <thead>
              <tr>
                <th scope="col">Raised</th>
                <th scope="col">Event</th>
                <th scope="col">Recipient</th>
                <th scope="col">Channel</th>
                <th scope="col">State</th>
                <th scope="col">Attempts</th>
                <th scope="col">Failure code</th>
              </tr>
            </thead>
            <tbody>
              {log.data.items.map((n) => (
                <tr key={n.id}>
                  <td>{when(n.occurredAt)}</td>
                  <td>{n.category}</td>
                  <td>{n.recipientAccount}</td>
                  <td>{readable(n.channel)}</td>
                  <td>
                    <StateText state={n.state} />
                  </td>
                  <td>{n.attempts}</td>
                  <td>{n.lastFailureCode ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {log.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={log.data.total} onPage={setPage} label="Pages of the delivery log" noun="notification" />}
        <ErrorNote error={log.error} />
      </Section>
      <FailedEventsSection scopeKey={scopeKey} />
    </>
  );
}

export const NOTIFICATION_SCREENS: readonly ScreenRoute[] = [{ path: '/notifications/delivery', title: 'Delivery log', permission: READ_DELIVERY, nav: true, component: DeliveryLogPage }];
