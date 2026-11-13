// Company events and ticker messages (coverage CL-021 "Event planner", CL-022 "Ticker message"; API modules/announcements). The
// dashboard shows each person the messages running today and the upcoming events meant for them (the server chooses); HR keeps
// both lists here. Nothing is deleted: switching off ends an event or a message, and the server audits every change.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, ApiError, formatDate } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Section } from '../ui';

const READ = 'announcement.read.operational';
const MANAGE = 'announcement.manage.operational';
const MASTER_READ = 'org_master.read.operational';

type Audience = 'ALL' | 'DEPARTMENT' | 'LOCATION';

interface Feed {
  asOf: string;
  messages: { id: string; message: string; startsOn: string; endsOn: string }[];
  events: { id: string; name: string; description: string | null; eventDate: string; audience: Audience; for: string | null }[];
}

export interface CompanyEvent {
  id: string;
  name: string;
  description: string | null;
  eventDate: string;
  audience: Audience;
  departmentId: string | null;
  departmentName: string | null;
  locationId: string | null;
  locationName: string | null;
  active: boolean;
  version: number;
}

export interface TickerMessage {
  id: string;
  message: string;
  startsOn: string;
  endsOn: string;
  active: boolean;
  version: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function refusal(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'STALE_VERSION') return 'Someone changed this since you opened it. The list has been reloaded; check it and try again.';
  if (error.code === 'FORBIDDEN') return 'Your role cannot change events or messages.';
  if (error.status === 422) return error.message;
  return null;
}

function Refusal({ error }: { error: unknown }) {
  const text = refusal(error);
  return text ? <p className="error">{text}</p> : <ErrorNote error={error} />;
}

// ---------------------------------------------------------------------------------------------------------
// The dashboard panel
// ---------------------------------------------------------------------------------------------------------

/** On the dashboard: today's messages as a banner and the upcoming events, for a session that reads them; nothing otherwise. */
export function AnnouncementsPanel() {
  const { can, stored } = useSession();
  const allowed = can(READ);
  const feed = useQuery({ queryKey: ['announcements-feed', stored?.assignmentId ?? '-'], queryFn: () => api<Feed>('/v1/announcements/feed'), enabled: allowed });
  if (!allowed || !feed.data) return null;
  const { messages, events } = feed.data;
  return (
    <>
      {messages.length > 0 && (
        <div className="ticker" role="region" aria-label="Announcements">
          <span className="ticker-label">Announcements</span>
          <ul className="ticker-items">
            {messages.map((m) => (
              <li key={m.id}>{m.message}</li>
            ))}
          </ul>
        </div>
      )}
      {events.length > 0 && (
        <Section title="Upcoming events">
          <ul className="events" aria-label="Upcoming events">
            {events.map((e) => {
              const [, month, day] = e.eventDate.split('-');
              return (
                <li key={e.id} className="event">
                  <span className="event-date" aria-hidden="true">
                    <strong>{Number(day)}</strong>
                    <span>{MONTHS[Number(month) - 1]}</span>
                  </span>
                  <span className="event-body">
                    <span className="event-name">{e.name}</span>
                    <span className="event-meta">
                      {formatDate(e.eventDate)}
                      {e.for ? ` · ${e.for}` : ''}
                    </span>
                    {e.description && <span className="event-text">{e.description}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Events (HR)
// ---------------------------------------------------------------------------------------------------------

interface Master {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

interface EventValues {
  name: string;
  eventDate: string;
  audience: Audience;
  departmentId: string;
  locationId: string;
  description: string;
}

const blankEvent: EventValues = { name: '', eventDate: '', audience: 'ALL', departmentId: '', locationId: '', description: '' };
const valuesOf = (e: CompanyEvent): EventValues => ({
  name: e.name,
  eventDate: e.eventDate,
  audience: e.audience,
  departmentId: e.departmentId ?? '',
  locationId: e.locationId ?? '',
  description: e.description ?? '',
});
const bodyOf = (v: EventValues) => ({
  name: v.name.trim(),
  eventDate: v.eventDate,
  audience: v.audience,
  description: v.description.trim() === '' ? null : v.description.trim(),
  departmentId: v.audience === 'DEPARTMENT' ? v.departmentId || null : null,
  locationId: v.audience === 'LOCATION' ? v.locationId || null : null,
});

function EventForm({ initial, label, pending, onSubmit }: { initial: EventValues; label: string; pending: boolean; onSubmit: (v: EventValues) => void }) {
  const { can } = useSession();
  const [v, setV] = useState(initial);
  const masters = can(MASTER_READ);
  const departments = useQuery({ queryKey: ['org-master', 'departments', false], queryFn: () => api<{ items: Master[] }>('/v1/org/departments'), enabled: masters && v.audience === 'DEPARTMENT' });
  const locations = useQuery({ queryKey: ['org-master', 'locations', false], queryFn: () => api<{ items: Master[] }>('/v1/org/locations'), enabled: masters && v.audience === 'LOCATION' });
  const set = (k: keyof EventValues) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  // Save is offered once what the form requires is filled in: a name, a date and, for one department or location, which one.
  const complete =
    v.name.trim() !== '' && v.eventDate !== '' && (v.audience !== 'DEPARTMENT' || v.departmentId !== '') && (v.audience !== 'LOCATION' || v.locationId !== '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(v);
  };
  return (
    <form className="grid-form" onSubmit={submit} aria-label={label}>
      <label>
        Event name
        <input value={v.name} onChange={set('name')} maxLength={120} required />
      </label>
      <label>
        Event date
        <input type="date" value={v.eventDate} onChange={set('eventDate')} required />
      </label>
      <label>
        For
        <select value={v.audience} onChange={set('audience')}>
          <option value="ALL">Everyone</option>
          <option value="DEPARTMENT">One department</option>
          <option value="LOCATION">One location</option>
        </select>
      </label>
      {v.audience === 'DEPARTMENT' && (
        <label>
          Department
          <select value={v.departmentId} onChange={set('departmentId')} required>
            <option value="">Choose…</option>
            {(departments.data?.items ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.code})
              </option>
            ))}
          </select>
        </label>
      )}
      {v.audience === 'LOCATION' && (
        <label>
          Location
          <select value={v.locationId} onChange={set('locationId')} required>
            <option value="">Choose…</option>
            {(locations.data?.items ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.code})
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="wide">
        Description
        <textarea rows={3} value={v.description} onChange={set('description')} maxLength={1000} />
      </label>
      <button type="submit" disabled={pending || !complete}>
        {pending ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}

function EventRow({ event, onDone }: { event: CompanyEvent; onDone: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const change = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<CompanyEvent>(`/v1/company-events/${event.id}`, { method: 'PATCH', body: { expectedVersion: event.version, ...body } }),
    onSuccess: (e, body) => {
      setEditing(false);
      onDone('active' in body ? `${e.name} switched ${e.active ? 'on' : 'off'}.` : `${e.name} saved.`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') onDone('');
    },
  });
  const target = event.audience === 'ALL' ? 'Everyone' : (event.departmentName ?? event.locationName ?? '—');
  return (
    <>
      <tr>
        <td>{formatDate(event.eventDate)}</td>
        <td>{event.name}</td>
        <td>{target}</td>
        <td>{event.description ?? '—'}</td>
        <td>{event.active ? <Badge tone="good">Active</Badge> : <Badge>Off</Badge>}</td>
        <td>
          <button type="button" className="link" onClick={() => setEditing((x) => !x)} aria-label={`Edit ${event.name}`} aria-expanded={editing}>
            Edit
          </button>{' '}
          <button type="button" className={event.active ? 'link danger' : 'link'} disabled={change.isPending} onClick={() => change.mutate({ active: !event.active })} aria-label={`${event.active ? 'Switch off' : 'Switch on'} ${event.name}`}>
            {event.active ? 'Switch off' : 'Switch on'}
          </button>
        </td>
      </tr>
      {(editing || change.error) && (
        <tr>
          <td colSpan={6}>
            {editing && <EventForm initial={valuesOf(event)} label={`Edit ${event.name}`} pending={change.isPending} onSubmit={(v) => change.mutate(bodyOf(v))} />}
            {change.error && <Refusal error={change.error} />}
          </td>
        </tr>
      )}
    </>
  );
}

export function EventsPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [includeInactive, setIncludeInactive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const list = useQuery({ queryKey: ['company-events', includeInactive], queryFn: () => api<{ items: CompanyEvent[] }>(`/v1/company-events${includeInactive ? '?includeInactive=true' : ''}`) });
  const refresh = (message: string) => {
    setNotice(message || null);
    void qc.invalidateQueries({ queryKey: ['company-events'] });
    void qc.invalidateQueries({ queryKey: ['announcements-feed'] });
  };
  const create = useMutation({
    mutationFn: (v: EventValues) => api<CompanyEvent>('/v1/company-events', { body: bodyOf(v) }),
    onSuccess: (e) => {
      setFormKey((k) => k + 1);
      refresh(`${e.name} added.`);
    },
  });
  const items = list.data?.items ?? [];
  return (
    <>
      <Section title="Events">
        <label className="inline">
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Show switched-off events
        </label>
        {notice && <p role="status">{notice}</p>}
        <ErrorNote error={list.error} />
        {list.isSuccess && items.length === 0 && <Empty>No events yet.</Empty>}
        {items.length > 0 && (
          <table aria-label="Events">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Event</th>
                <th scope="col">For</th>
                <th scope="col">Description</th>
                <th scope="col">State</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <EventRow key={`${e.id}-${e.version}`} event={e} onDone={refresh} />
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">
          Events show on the dashboard of the people they are for from today until the day itself, up to 60 days ahead. An event is never
          deleted: switch it off and it stops showing.
        </p>
      </Section>
      {can(MANAGE) && (
        <Section title="New event">
          <EventForm key={formKey} initial={blankEvent} label="New event" pending={create.isPending} onSubmit={(v) => create.mutate(v)} />
          {create.error && <Refusal error={create.error} />}
        </Section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Ticker messages (HR)
// ---------------------------------------------------------------------------------------------------------

interface TickerValues {
  message: string;
  startsOn: string;
  endsOn: string;
}

function TickerForm({ initial, label, pending, onSubmit }: { initial: TickerValues; label: string; pending: boolean; onSubmit: (v: TickerValues) => void }) {
  const [v, setV] = useState(initial);
  const set = (k: keyof TickerValues) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  return (
    <form
      className="grid-form"
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ ...v, message: v.message.trim() });
      }}
    >
      <label className="wide">
        Message
        <textarea rows={2} value={v.message} onChange={set('message')} maxLength={280} required />
      </label>
      <label>
        First day
        <input type="date" value={v.startsOn} onChange={set('startsOn')} required />
      </label>
      <label>
        Last day
        <input type="date" value={v.endsOn} onChange={set('endsOn')} required />
      </label>
      <button type="submit" disabled={pending || v.message.trim() === '' || v.startsOn === '' || v.endsOn === ''}>
        {pending ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}

function TickerRow({ item, onDone }: { item: TickerMessage; onDone: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const change = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<TickerMessage>(`/v1/ticker-messages/${item.id}`, { method: 'PATCH', body: { expectedVersion: item.version, ...body } }),
    onSuccess: (t, body) => {
      setEditing(false);
      onDone('active' in body ? `Message switched ${t.active ? 'on' : 'off'}.` : 'Message saved.');
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') onDone('');
    },
  });
  return (
    <>
      <tr>
        <td>{item.message}</td>
        <td>{formatDate(item.startsOn)}</td>
        <td>{formatDate(item.endsOn)}</td>
        <td>{item.active ? <Badge tone="good">Active</Badge> : <Badge>Off</Badge>}</td>
        <td>
          <button type="button" className="link" onClick={() => setEditing((x) => !x)} aria-label={`Edit message: ${item.message}`} aria-expanded={editing}>
            Edit
          </button>{' '}
          <button type="button" className={item.active ? 'link danger' : 'link'} disabled={change.isPending} onClick={() => change.mutate({ active: !item.active })} aria-label={`${item.active ? 'Switch off' : 'Switch on'} message: ${item.message}`}>
            {item.active ? 'Switch off' : 'Switch on'}
          </button>
        </td>
      </tr>
      {(editing || change.error) && (
        <tr>
          <td colSpan={5}>
            {editing && <TickerForm initial={{ message: item.message, startsOn: item.startsOn, endsOn: item.endsOn }} label="Edit message" pending={change.isPending} onSubmit={(v) => change.mutate({ ...v })} />}
            {change.error && <Refusal error={change.error} />}
          </td>
        </tr>
      )}
    </>
  );
}

export function TickerPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [includeInactive, setIncludeInactive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const list = useQuery({ queryKey: ['ticker-messages', includeInactive], queryFn: () => api<{ items: TickerMessage[] }>(`/v1/ticker-messages${includeInactive ? '?includeInactive=true' : ''}`) });
  const refresh = (message: string) => {
    setNotice(message || null);
    void qc.invalidateQueries({ queryKey: ['ticker-messages'] });
    void qc.invalidateQueries({ queryKey: ['announcements-feed'] });
  };
  const create = useMutation({
    mutationFn: (v: TickerValues) => api<TickerMessage>('/v1/ticker-messages', { body: v }),
    onSuccess: () => {
      setFormKey((k) => k + 1);
      refresh('Message added.');
    },
  });
  const items = list.data?.items ?? [];
  return (
    <>
      <Section title="Ticker messages">
        <label className="inline">
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Show switched-off messages
        </label>
        {notice && <p role="status">{notice}</p>}
        <ErrorNote error={list.error} />
        {list.isSuccess && items.length === 0 && <Empty>No messages yet.</Empty>}
        {items.length > 0 && (
          <table aria-label="Ticker messages">
            <thead>
              <tr>
                <th scope="col">Message</th>
                <th scope="col">First day</th>
                <th scope="col">Last day</th>
                <th scope="col">State</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <TickerRow key={`${t.id}-${t.version}`} item={t} onDone={refresh} />
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">A message shows on everyone’s dashboard from its first day to its last day. It is never deleted: switch it off and it stops showing.</p>
      </Section>
      {can(MANAGE) && (
        <Section title="New message">
          <TickerForm key={formKey} initial={{ message: '', startsOn: '', endsOn: '' }} label="New message" pending={create.isPending} onSubmit={(v) => create.mutate(v)} />
          {create.error && <Refusal error={create.error} />}
        </Section>
      )}
    </>
  );
}

export const ANNOUNCEMENT_SCREENS: readonly ScreenRoute[] = [
  { path: '/announcements/events', title: 'Events', permission: MANAGE, nav: true, component: EventsPage },
  { path: '/announcements/ticker', title: 'Ticker messages', permission: MANAGE, nav: true, component: TickerPage },
];
