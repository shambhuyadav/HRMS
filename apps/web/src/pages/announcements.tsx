// Company events and ticker messages (coverage CL-021 "Event planner", CL-022 "Ticker message"; API modules/announcements). The
// dashboard shows each person the messages running today and the upcoming events meant for them (the server chooses); HR keeps
// both lists here. Nothing is deleted: switching off ends an event or a message, and the server audits every change.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlertIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { CheckField, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, formatDate } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Notice, Section } from '../ui';

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

/** A refusal in words, in the alert look but not announced: the line it replaces had no role. */
function Refusal({ error }: { error: unknown }) {
  const text = refusal(error);
  if (!text) return <ErrorNote error={error} />;
  return (
    <Alert asChild variant="destructive" role={undefined}>
      <p className="error">
        <CircleAlertIcon aria-hidden="true" />
        {text}
      </p>
    </Alert>
  );
}

// ---------------------------------------------------------------------------------------------------------
// The dashboard panel
// ---------------------------------------------------------------------------------------------------------

/** Today's messages: a strip edged in the brand colour on its left, its label beside the messages (the old `.ticker`). */
const TICKER = 'mb-5 flex items-start gap-[0.9rem] rounded-md border border-l-[3px] border-border border-l-[color:var(--accent)] bg-card px-4 py-[0.7rem] shadow-[var(--shadow-sm)]';
/** The strip's label ("Announcements"): small capitals in the brand colour. */
const TICKER_LABEL = 'flex-none pt-[0.1rem] text-[0.72rem] font-bold tracking-[0.05em] text-[var(--accent)] uppercase';
/** The messages, one under another. */
const TICKER_ITEMS = 'm-0 flex list-none flex-col gap-1 p-0 text-[0.92rem] text-foreground';
/** The upcoming events, one under another, each a date leaf beside its words. */
const EVENTS = 'm-0 grid list-none gap-[0.6rem] p-0';
const EVENT = 'flex items-start gap-[0.9rem]';
/** An event's day and month in a small framed box, like a calendar leaf. */
const EVENT_DATE = 'w-[52px] flex-none rounded-md border border-border bg-accent py-[0.3rem] text-center';
const EVENT_DAY = 'block text-[1.15rem] leading-[1.15] text-foreground';
const EVENT_MONTH = 'text-[0.72rem] font-semibold text-muted-foreground uppercase';
/** An event's name, its date and audience, and its description, one under another. */
const EVENT_BODY = 'flex min-w-0 flex-col gap-[0.1rem]';

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
        <div className={TICKER} role="region" aria-label="Announcements">
          <span className={TICKER_LABEL}>Announcements</span>
          <ul className={TICKER_ITEMS}>
            {messages.map((m) => (
              <li key={m.id}>{m.message}</li>
            ))}
          </ul>
        </div>
      )}
      {events.length > 0 && (
        <Section title="Upcoming events">
          <ul className={EVENTS} aria-label="Upcoming events">
            {events.map((e) => {
              const [, month, day] = e.eventDate.split('-');
              return (
                <li key={e.id} className={EVENT}>
                  <span className={EVENT_DATE} aria-hidden="true">
                    <strong className={EVENT_DAY}>{Number(day)}</strong>
                    <span className={EVENT_MONTH}>{MONTHS[Number(month) - 1]}</span>
                  </span>
                  <span className={EVENT_BODY}>
                    <span className="font-semibold text-foreground">{e.name}</span>
                    <span className="text-[0.8rem] text-muted-foreground">
                      {formatDate(e.eventDate)}
                      {e.for ? ` · ${e.for}` : ''}
                    </span>
                    {e.description && <span className="text-[0.86rem] text-foreground">{e.description}</span>}
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
    <FormGrid onSubmit={submit} aria-label={label}>
      <FormField>
        Event name
        <Input value={v.name} onChange={set('name')} maxLength={120} required />
      </FormField>
      <FormField>
        Event date
        <Input type="date" value={v.eventDate} onChange={set('eventDate')} required />
      </FormField>
      <FormField>
        For
        <NativeSelect value={v.audience} onChange={set('audience')}>
          <option value="ALL">Everyone</option>
          <option value="DEPARTMENT">One department</option>
          <option value="LOCATION">One location</option>
        </NativeSelect>
      </FormField>
      {v.audience === 'DEPARTMENT' && (
        <FormField>
          Department
          <NativeSelect value={v.departmentId} onChange={set('departmentId')} required>
            <option value="">Choose…</option>
            {(departments.data?.items ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.code})
              </option>
            ))}
          </NativeSelect>
        </FormField>
      )}
      {v.audience === 'LOCATION' && (
        <FormField>
          Location
          <NativeSelect value={v.locationId} onChange={set('locationId')} required>
            <option value="">Choose…</option>
            {(locations.data?.items ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.code})
              </option>
            ))}
          </NativeSelect>
        </FormField>
      )}
      <FormField className="col-span-full">
        Description
        <Textarea rows={3} value={v.description} onChange={set('description')} maxLength={1000} />
      </FormField>
      <Button type="submit" disabled={pending || !complete}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
    </FormGrid>
  );
}

function EventRow({ event, onDone }: { event: CompanyEvent; onDone: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const change = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<CompanyEvent>(`/v1/company-events/${event.id}`, { method: 'PATCH', body: { expectedVersion: event.version, ...body } }),
    onSuccess: (e, body) => {
      setEditing(false);
      const switched = e.active ? 'on' : 'off';
      onDone('active' in body ? `${e.name} switched ${switched}.` : `${e.name} saved.`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') onDone('');
    },
  });
  const target = event.audience === 'ALL' ? 'Everyone' : (event.departmentName ?? event.locationName ?? '—');
  return (
    <>
      <TableRow>
        <TableCell>{formatDate(event.eventDate)}</TableCell>
        <TableCell>{event.name}</TableCell>
        <TableCell>{target}</TableCell>
        <TableCell>{event.description ?? '—'}</TableCell>
        <TableCell>{event.active ? <Badge tone="good">Active</Badge> : <Badge>Off</Badge>}</TableCell>
        <RowActionsCell>
          <RowActions>
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing((x) => !x)} aria-label={`Edit ${event.name}`} aria-expanded={editing}>
              Edit
            </Button>{' '}
            <Button
              type="button"
              variant={event.active ? 'danger' : 'outline'}
              size="sm"
              disabled={change.isPending}
              onClick={() => change.mutate({ active: !event.active })}
              aria-label={`${event.active ? 'Switch off' : 'Switch on'} ${event.name}`}
            >
              {event.active ? 'Switch off' : 'Switch on'}
            </Button>
          </RowActions>
        </RowActionsCell>
      </TableRow>
      {(editing || change.error) && (
        <TableRow>
          <TableCell colSpan={6}>
            {editing && <EventForm initial={valuesOf(event)} label={`Edit ${event.name}`} pending={change.isPending} onSubmit={(v) => change.mutate(bodyOf(v))} />}
            {change.error && <Refusal error={change.error} />}
          </TableCell>
        </TableRow>
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
        <CheckField className="mb-3">
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Show switched-off events
        </CheckField>
        {notice && <Notice notice={{ text: notice, ok: true }} />}
        <ErrorNote error={list.error} />
        {list.isSuccess && items.length === 0 && <Empty>No events yet.</Empty>}
        {items.length > 0 && (
          <Table aria-label="Events">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Date</TableHead>
                <TableHead scope="col">Event</TableHead>
                <TableHead scope="col">For</TableHead>
                <TableHead scope="col">Description</TableHead>
                <TableHead scope="col">State</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((e) => (
                <EventRow key={`${e.id}-${e.version}`} event={e} onDone={refresh} />
              ))}
            </TableBody>
          </Table>
        )}
        <Hint>
          Events show on the dashboard of the people they are for from today until the day itself, up to 60 days ahead. An event is never
          deleted: switch it off and it stops showing.
        </Hint>
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
    <FormGrid
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ ...v, message: v.message.trim() });
      }}
    >
      <FormField className="col-span-full">
        Message
        <Textarea rows={2} value={v.message} onChange={set('message')} maxLength={280} required />
      </FormField>
      <FormField>
        First day
        <Input type="date" value={v.startsOn} onChange={set('startsOn')} required />
      </FormField>
      <FormField>
        Last day
        <Input type="date" value={v.endsOn} onChange={set('endsOn')} required />
      </FormField>
      <Button type="submit" disabled={pending || v.message.trim() === '' || v.startsOn === '' || v.endsOn === ''}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
    </FormGrid>
  );
}

function TickerRow({ item, onDone }: { item: TickerMessage; onDone: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const change = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<TickerMessage>(`/v1/ticker-messages/${item.id}`, { method: 'PATCH', body: { expectedVersion: item.version, ...body } }),
    onSuccess: (t, body) => {
      setEditing(false);
      const switched = t.active ? 'on' : 'off';
      onDone('active' in body ? `Message switched ${switched}.` : 'Message saved.');
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') onDone('');
    },
  });
  return (
    <>
      <TableRow>
        <TableCell>{item.message}</TableCell>
        <TableCell>{formatDate(item.startsOn)}</TableCell>
        <TableCell>{formatDate(item.endsOn)}</TableCell>
        <TableCell>{item.active ? <Badge tone="good">Active</Badge> : <Badge>Off</Badge>}</TableCell>
        <RowActionsCell>
          <RowActions>
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing((x) => !x)} aria-label={`Edit message: ${item.message}`} aria-expanded={editing}>
              Edit
            </Button>{' '}
            <Button
              type="button"
              variant={item.active ? 'danger' : 'outline'}
              size="sm"
              disabled={change.isPending}
              onClick={() => change.mutate({ active: !item.active })}
              aria-label={`${item.active ? 'Switch off' : 'Switch on'} message: ${item.message}`}
            >
              {item.active ? 'Switch off' : 'Switch on'}
            </Button>
          </RowActions>
        </RowActionsCell>
      </TableRow>
      {(editing || change.error) && (
        <TableRow>
          <TableCell colSpan={5}>
            {editing && <TickerForm initial={{ message: item.message, startsOn: item.startsOn, endsOn: item.endsOn }} label="Edit message" pending={change.isPending} onSubmit={(v) => change.mutate({ ...v })} />}
            {change.error && <Refusal error={change.error} />}
          </TableCell>
        </TableRow>
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
        <CheckField className="mb-3">
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Show switched-off messages
        </CheckField>
        {notice && <Notice notice={{ text: notice, ok: true }} />}
        <ErrorNote error={list.error} />
        {list.isSuccess && items.length === 0 && <Empty>No messages yet.</Empty>}
        {items.length > 0 && (
          <Table aria-label="Ticker messages">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Message</TableHead>
                <TableHead scope="col">First day</TableHead>
                <TableHead scope="col">Last day</TableHead>
                <TableHead scope="col">State</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((t) => (
                <TickerRow key={`${t.id}-${t.version}`} item={t} onDone={refresh} />
              ))}
            </TableBody>
          </Table>
        )}
        <Hint>A message shows on everyone’s dashboard from its first day to its last day. It is never deleted: switch it off and it stops showing.</Hint>
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
