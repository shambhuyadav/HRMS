// Holidays, shifts and weekly-off patterns (FR-005; DF05 "Shift and holiday calendars are editable and effective-dated";
// DF08; I-04; I-54).
//
// Nothing here overwrites: a holiday is corrected or withdrawn and the earlier entry stays, shift times change by a dated
// revision, and a weekly-off pattern is a dated entry per location. Days already evaluated keep their results until they are
// processed again, so every change answers with the dates it reaches, and HR reprocesses them from here; a day a processed
// payroll used never changes. The page proposes no value. The server re-checks every duty and rule; this page only offers
// what the role can do.
//
// Decided under owner delegation, 6 Nov 2026 (I-78 items 1 and 4): a shift's buffer is its punch capture window before the
// start and after the end, stated for every new shift; the 24-hour-cycle indicator is the overnight flag the times give. A
// weekly-off pattern may add whole days off on some weeks of the month (the 2nd and 4th Saturdays) and half weekly-offs,
// which stay working days for leave and payroll and are measured against half the shift.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, formatDate, idempotencyKey } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Section, StateBadge } from '../ui';

const HOLIDAY_READ = 'holiday.read.operational';
const HOLIDAY_MANAGE = 'holiday.manage.operational';
const SHIFT_READ = 'shift.read.operational';
const SHIFT_CREATE = 'shift.create.operational';
const SHIFT_UPDATE = 'shift.update.operational';
const ATTENDANCE_PROCESS = 'attendance.process.operational';

// ---------------------------------------------------------------------------------------------------------
// What a change reaches
// ---------------------------------------------------------------------------------------------------------

export interface ReprocessDay {
  workDate: string;
  toReprocess: number;
  amended: number;
  locked: number;
}
export interface ReprocessList {
  days: ReprocessDay[];
  truncated: boolean;
}

function ReprocessDate({ day }: { day: ReprocessDay }) {
  const process = useMutation({ mutationFn: () => api('/v1/attendance/processing', { body: { workDate: day.workDate, idempotencyKey: idempotencyKey('calendar-reprocess') } }) });
  if (process.isSuccess) {
    return (
      <span role="status">
        Queued. Follow it in <Link to="/bulk-jobs">My background jobs</Link>.
      </span>
    );
  }
  return (
    <>
      <button type="button" className="link" disabled={process.isPending} onClick={() => process.mutate()}>
        Reprocess {day.workDate}
      </button>
      <ErrorNote error={process.error} />
    </>
  );
}

/** The dates a calendar change reaches. Nothing has changed on them yet. */
function ReprocessNotice({ list }: { list: ReprocessList }) {
  const { can } = useSession();
  const canProcess = can(ATTENDANCE_PROCESS);
  if (list.days.length === 0) return <p role="status">Saved. No evaluated attendance day is affected.</p>;
  return (
    <div role="status">
      <p>
        Saved. These dates were already evaluated and keep their results until they are processed again. Processing leaves amended days as they are, and a day a processed payroll used never changes.
      </p>
      <table aria-label="Dates to reprocess">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">To reprocess</th>
            <th scope="col">Amended, kept</th>
            <th scope="col">Used by processed payroll, final</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {list.days.map((d) => (
            <tr key={d.workDate}>
              <td>{d.workDate}</td>
              <td>{d.toReprocess}</td>
              <td>{d.amended}</td>
              <td>{d.locked}</td>
              <td>{d.toReprocess > 0 && canProcess && <ReprocessDate day={d} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.truncated && <p className="hint">Showing the first {list.days.length} dates; more are affected.</p>}
    </div>
  );
}

/** The notice of the latest change: a new change starts a new notice, so a date queued earlier can be queued again. */
function useReprocessNotice() {
  const [saved, setSaved] = useState<{ list: ReprocessList; change: number } | null>(null);
  return {
    notice: saved && <ReprocessNotice key={saved.change} list={saved.list} />,
    show: (list: ReprocessList) => setSaved((s) => ({ list, change: (s?.change ?? 0) + 1 })),
  };
}

/** Refusals of a calendar change in plain words; any other is shown as the server sent it. */
function refusalText(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'STALE_VERSION') return 'This changed since you opened it. It has been reloaded; review it and try again.';
  if (error.code === 'HOLIDAY_CLOSED') return 'This entry was already corrected or withdrawn. Only the entry in force can change.';
  if (error.code === 'NO_CHANGE') return 'The correction changes nothing.';
  if (error.code === 'DUPLICATE') return 'This location already has a holiday of that type on that date, or the code is already in use.';
  if (error.code === 'OVERLAPPING_PERIOD') return 'The breaks overlap.';
  if (error.code === 'RULE_VIOLATION') return 'Check the values: the in and out times must differ, every break must lie inside the shift, and a reason cannot be blank.';
  if (error.code === 'BUFFER_OUT_OF_RANGE') {
    const max = (error.details as { maxBufferMinutes?: number } | undefined)?.maxBufferMinutes;
    return `The buffer is too long for this shift: at most ${max ?? 'half of what the day leaves'} minutes, so the windows of two days do not overlap.`;
  }
  if (error.code === 'INVALID_PATTERN') return 'Name each weekday once, not one already off every week, and make a day either a whole or a half weekly-off.';
  return null;
}

function Refusal({ error }: { error: unknown }) {
  const words = refusalText(error);
  if (!words) return <ErrorNote error={error} />;
  return (
    <p role="alert" className="error">
      {words}
    </p>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Holiday calendar
// ---------------------------------------------------------------------------------------------------------

interface LocationOption {
  id: string;
  code: string;
  name: string;
  active: boolean;
}
interface HolidayOptions {
  locations: LocationOption[];
  types: { code: string; label: string }[];
}
export interface Holiday {
  id: string;
  locationId: string;
  holidayDate: string;
  name: string;
  holidayType: string;
  state: string;
  version: number;
  supersedesId: string | null;
  supersededById: string | null;
  closedAt: string | null;
  closedReason: string | null;
}

const locationLabel = (l: LocationOption) => `${l.code} ${l.name}${l.active ? '' : ' (inactive)'}`;

function NewHoliday({ options, locationId, onDone }: { options: HolidayOptions; locationId: string; onDone: (r: ReprocessList) => void }) {
  const [form, setForm] = useState({ holidayDate: '', name: '', holidayType: '' });
  const add = useMutation({
    mutationFn: () => api<{ reprocess: ReprocessList }>('/v1/holidays', { body: { locationId, holidayDate: form.holidayDate, name: form.name.trim(), holidayType: form.holidayType } }),
    onSuccess: (res) => {
      setForm({ holidayDate: '', name: '', holidayType: '' });
      onDone(res.reprocess);
    },
  });
  return (
    <Section title="Add a holiday">
      <form
        className="grid-form"
        aria-label="Add a holiday"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <label>
          Date
          <input type="date" required value={form.holidayDate} onChange={(e) => setForm({ ...form, holidayDate: e.target.value })} />
        </label>
        <label>
          Name
          <input required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>
          Type
          <select required value={form.holidayType} onChange={(e) => setForm({ ...form, holidayType: e.target.value })}>
            <option value="">Choose a type</option>
            {options.types.map((t) => (
              <option key={t.code} value={t.code}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={add.isPending || !locationId}>
          Add holiday
        </button>
      </form>
      <Refusal error={add.error} />
    </Section>
  );
}

function HolidayActions({ holiday, options, onChanged, onSaved }: { holiday: Holiday; options: HolidayOptions; onChanged: () => void; onSaved: (r: ReprocessList) => void }) {
  const [open, setOpen] = useState<'correct' | 'withdraw' | null>(null);
  const [form, setForm] = useState({ locationId: holiday.locationId, holidayDate: holiday.holidayDate, name: holiday.name, holidayType: holiday.holidayType });
  const [reason, setReason] = useState('');
  const settled = (res: { reprocess: ReprocessList }) => {
    setOpen(null);
    onSaved(res.reprocess);
    onChanged();
  };
  // A stale version reloads the list, so the next attempt reviews the entry as it now stands.
  const refreshOnError = (err: unknown) => {
    if (err instanceof ApiError && (err.code === 'STALE_VERSION' || err.code === 'HOLIDAY_CLOSED')) onChanged();
  };
  const correct = useMutation({
    mutationFn: () => {
      const changed: Record<string, string> = {};
      if (form.locationId !== holiday.locationId) changed.locationId = form.locationId;
      if (form.holidayDate !== holiday.holidayDate) changed.holidayDate = form.holidayDate;
      if (form.name.trim() !== holiday.name) changed.name = form.name.trim();
      if (form.holidayType !== holiday.holidayType) changed.holidayType = form.holidayType;
      return api<{ reprocess: ReprocessList }>(`/v1/holidays/${holiday.id}/correct`, { body: { expectedVersion: holiday.version, reason: reason.trim(), ...changed } });
    },
    onSuccess: settled,
    onError: refreshOnError,
  });
  const withdraw = useMutation({
    mutationFn: () => api<{ reprocess: ReprocessList }>(`/v1/holidays/${holiday.id}/withdraw`, { body: { expectedVersion: holiday.version, reason: reason.trim() } }),
    onSuccess: settled,
    onError: refreshOnError,
  });
  const toggle = (which: 'correct' | 'withdraw') => setOpen(open === which ? null : which);
  const label = `${holiday.name} on ${holiday.holidayDate}`;
  const reasonField = (
    <label className="wide">
      Reason
      <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
    </label>
  );
  return (
    <>
      <button type="button" className="link" onClick={() => toggle('correct')}>
        Correct {label}
      </button>{' '}
      <button type="button" className="link" onClick={() => toggle('withdraw')}>
        Withdraw {label}
      </button>
      {open === 'correct' && (
        <form
          className="grid-form"
          aria-label={`Correct ${label}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            correct.mutate();
          }}
        >
          <label>
            Location
            <select value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })}>
              {options.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {locationLabel(l)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Date
            <input type="date" required value={form.holidayDate} onChange={(e) => setForm({ ...form, holidayDate: e.target.value })} />
          </label>
          <label>
            Name
            <input required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            Type
            <select value={form.holidayType} onChange={(e) => setForm({ ...form, holidayType: e.target.value })}>
              {!options.types.some((t) => t.code === holiday.holidayType) && <option value={holiday.holidayType}>{holiday.holidayType}</option>}
              {options.types.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          {reasonField}
          <button type="submit" disabled={correct.isPending}>
            Save correction
          </button>
          <p className="hint wide">This entry stays on record as replaced, and the corrected one takes its place.</p>
          <Refusal error={correct.error} />
        </form>
      )}
      {open === 'withdraw' && (
        <form
          className="grid-form"
          aria-label={`Withdraw ${label}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            withdraw.mutate();
          }}
        >
          {reasonField}
          <button type="submit" disabled={withdraw.isPending}>
            Confirm withdrawal
          </button>
          <p className="hint wide">The entry stays on record as withdrawn; the date stops being a holiday of this location.</p>
          <Refusal error={withdraw.error} />
        </form>
      )}
    </>
  );
}

function closedNote(h: Holiday): string {
  if (h.state === 'WITHDRAWN') return `Withdrawn on ${formatDate(h.closedAt)}: ${h.closedReason ?? ''}`;
  if (h.state === 'SUPERSEDED') return `Replaced on ${formatDate(h.closedAt)}: ${h.closedReason ?? ''}`;
  return h.supersedesId ? 'A correction of an earlier entry' : '';
}

export function HolidayCalendarPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const canManage = can(HOLIDAY_MANAGE);
  const options = useQuery({ queryKey: ['holiday-options'], queryFn: () => api<HolidayOptions>('/v1/holidays/options') });
  const [chosen, setChosen] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [state, setState] = useState('ACTIVE');
  const { notice, show } = useReprocessNotice();
  const locationId = chosen || options.data?.locations[0]?.id || '';
  const list = useQuery({
    queryKey: ['holidays', locationId, year, state],
    enabled: locationId !== '' && /^\d{4}$/.test(year),
    queryFn: () => api<{ items: Holiday[] }>(`/v1/holidays?locationId=${encodeURIComponent(locationId)}&year=${encodeURIComponent(year)}&state=${state}`),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['holidays'] });
  const items = list.data?.items ?? [];
  return (
    <>
      <Section title="Holiday calendar">
        <div className="grid-form">
          <label>
            Location
            <select value={locationId} onChange={(e) => setChosen(e.target.value)}>
              {options.data?.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {locationLabel(l)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Year
            <input inputMode="numeric" maxLength={4} value={year} onChange={(e) => setYear(e.target.value)} />
          </label>
          <label>
            Show
            <select value={state} onChange={(e) => setState(e.target.value)}>
              <option value="ACTIVE">In force</option>
              <option value="WITHDRAWN">Withdrawn</option>
              <option value="SUPERSEDED">Replaced by a correction</option>
              <option value="ALL">All entries</option>
            </select>
          </label>
        </div>
        <ErrorNote error={options.error ?? list.error} />
        {notice}
        {list.isSuccess && items.length === 0 && <Empty>{state === 'ACTIVE' ? 'No holidays in force for this location and year.' : 'No entries of this kind for this location and year.'}</Empty>}
        {items.length > 0 && (
          <table aria-label="Holidays">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">State</th>
                <th scope="col">Note</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {items.map((h) => (
                <tr key={h.id}>
                  <td>{h.holidayDate}</td>
                  <td>{h.name}</td>
                  <td>{h.holidayType}</td>
                  <td>
                    <StateBadge state={h.state === 'SUPERSEDED' ? 'REPLACED' : h.state} />
                  </td>
                  <td>{closedNote(h)}</td>
                  <td>{canManage && h.state === 'ACTIVE' && options.data && <HolidayActions key={h.version} holiday={h} options={options.data} onChanged={refresh} onSaved={show} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">A holiday applies only to employees assigned to its location on that date. Corrected and withdrawn entries stay on record: choose them under Show.</p>
      </Section>
      {canManage && options.data && (
        <NewHoliday
          options={options.data}
          locationId={locationId}
          onDone={(r) => {
            show(r);
            refresh();
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Shift master
// ---------------------------------------------------------------------------------------------------------

interface ShiftBreak {
  startOffsetMinutes: number;
  endOffsetMinutes: number;
}
interface ShiftRevision {
  revision: number;
  effectiveFrom: string | null;
  inTime: string;
  outTime: string;
  spansMidnight: boolean;
  netScheduledMinutes: number;
  bufferMinutes?: number;
  breaks: ShiftBreak[];
  reason: string | null;
}
export interface Shift {
  id: string;
  code: string;
  name: string;
  inTime: string;
  outTime: string;
  spansMidnight: boolean;
  netScheduledMinutes: number;
  bufferMinutes?: number;
  active: boolean;
  version: number;
  revision: number;
  effectiveFrom: string | null;
  breaks: ShiftBreak[];
  revisions: ShiftRevision[];
}

const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const clockAt = (inTime: string, offset: number) => {
  const m = (minutesOf(inTime) + offset) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
/** A break clock time as minutes from the shift's start (a night shift's break after midnight wraps round). */
const offsetFrom = (inTime: string, at: string) => (minutesOf(at) - minutesOf(inTime) + 1440) % 1440;
const breaksText = (inTime: string, breaks: ShiftBreak[]) =>
  breaks.length === 0 ? 'no scheduled break' : breaks.map((b) => `break ${clockAt(inTime, b.startOffsetMinutes)}-${clockAt(inTime, b.endOffsetMinutes)}`).join(', ');
const timesText = (r: { inTime: string; outTime: string; spansMidnight: boolean; netScheduledMinutes: number; breaks: ShiftBreak[]; bufferMinutes?: number }) =>
  `${r.inTime}-${r.outTime}${r.spansMidnight ? ' (next day: 24-hour cycle)' : ''}, ${breaksText(r.inTime, r.breaks)}, ${r.netScheduledMinutes} net minutes${
    r.bufferMinutes === undefined ? '' : `, punches from ${r.bufferMinutes} minutes before to ${r.bufferMinutes} after`
  }`;

interface BreakRow {
  key: number;
  from: string;
  to: string;
}

function TimesFields(props: {
  inTime: string;
  outTime: string;
  breaks: BreakRow[];
  onTimes: (t: { inTime?: string; outTime?: string }) => void;
  onBreaks: (b: BreakRow[]) => void;
}) {
  const { inTime, outTime, breaks, onTimes, onBreaks } = props;
  const [nextKey, setNextKey] = useState(breaks.length + 1);
  const setBreak = (key: number, patch: Partial<BreakRow>) => onBreaks(breaks.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  return (
    <>
      <label>
        In time
        <input type="time" required value={inTime} onChange={(e) => onTimes({ inTime: e.target.value })} />
      </label>
      <label>
        Out time
        <input type="time" required value={outTime} onChange={(e) => onTimes({ outTime: e.target.value })} />
      </label>
      {breaks.map((b, i) => (
        <span key={b.key} className="row wide">
          <label>
            Break {i + 1} from
            <input type="time" required value={b.from} onChange={(e) => setBreak(b.key, { from: e.target.value })} />
          </label>
          <label>
            Break {i + 1} to
            <input type="time" required value={b.to} onChange={(e) => setBreak(b.key, { to: e.target.value })} />
          </label>
          <button type="button" className="link" onClick={() => onBreaks(breaks.filter((x) => x.key !== b.key))}>
            Remove break {i + 1}
          </button>
        </span>
      ))}
      <button
        type="button"
        className="secondary"
        onClick={() => {
          onBreaks([...breaks, { key: nextKey, from: '', to: '' }]);
          setNextKey(nextKey + 1);
        }}
      >
        Add a break
      </button>
      <p className="hint wide">An out time before the in time is the next day. Scheduled breaks are unpaid and lie inside the shift.</p>
    </>
  );
}

const breaksBody = (inTime: string, rows: BreakRow[]) => rows.map((b) => ({ startOffsetMinutes: offsetFrom(inTime, b.from), endOffsetMinutes: offsetFrom(inTime, b.to) }));

/** I-78 item 1: the punch capture window each side of the shift. */
function BufferField({ value, onChange, required }: { value: string; onChange: (v: string) => void; required: boolean }) {
  return (
    <label>
      {required ? 'Buffer before and after (minutes)' : 'Buffer before and after (minutes; blank keeps the one in force)'}
      <input required={required} inputMode="numeric" pattern="\d{1,3}" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

const BUFFER_HINT = 'Punches from the buffer before the in time to the buffer after the out time belong to the shift’s day, the date it starts. The shift and both buffers fit in 24 hours, so two days never share a punch.';

function NewShift({ onChanged }: { onChanged: () => void }) {
  const blank = { code: '', name: '', inTime: '', outTime: '', bufferMinutes: '' };
  const [form, setForm] = useState(blank);
  const [breaks, setBreaks] = useState<BreakRow[]>([]);
  const create = useMutation({
    mutationFn: () =>
      api('/v1/shifts', {
        body: { code: form.code.trim(), name: form.name.trim(), inTime: form.inTime, outTime: form.outTime, breaks: breaksBody(form.inTime, breaks), bufferMinutes: Number(form.bufferMinutes) },
      }),
    onSuccess: () => {
      setForm(blank);
      setBreaks([]);
      onChanged();
    },
  });
  return (
    <Section title="New shift">
      <form
        className="grid-form"
        aria-label="New shift"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label>
          Code
          <input required maxLength={40} pattern="[A-Za-z0-9][A-Za-z0-9_\-]*" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </label>
        <label>
          Name
          <input required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <TimesFields inTime={form.inTime} outTime={form.outTime} breaks={breaks} onTimes={(t) => setForm({ ...form, ...t })} onBreaks={setBreaks} />
        <BufferField required value={form.bufferMinutes} onChange={(bufferMinutes) => setForm({ ...form, bufferMinutes })} />
        <p className="hint wide">{BUFFER_HINT}</p>
        <button type="submit" disabled={create.isPending}>
          Create shift
        </button>
        <Refusal error={create.error} />
      </form>
    </Section>
  );
}

function ShiftActions({ shift, onChanged, onSaved }: { shift: Shift; onChanged: () => void; onSaved: (r: ReprocessList) => void }) {
  const [open, setOpen] = useState<'times' | 'name' | null>(null);
  const [times, setTimes] = useState({ effectiveFrom: '', inTime: shift.inTime, outTime: shift.outTime, reason: '', bufferMinutes: '' });
  const [breaks, setBreaks] = useState<BreakRow[]>(shift.breaks.map((b, i) => ({ key: i + 1, from: clockAt(shift.inTime, b.startOffsetMinutes), to: clockAt(shift.inTime, b.endOffsetMinutes) })));
  const [name, setName] = useState(shift.name);
  const refreshOnError = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'STALE_VERSION') onChanged();
  };
  const revise = useMutation({
    mutationFn: () =>
      api<{ reprocess: ReprocessList }>(`/v1/shifts/${shift.id}/revisions`, {
        body: {
          expectedVersion: shift.version,
          effectiveFrom: times.effectiveFrom,
          inTime: times.inTime,
          outTime: times.outTime,
          breaks: breaksBody(times.inTime, breaks),
          reason: times.reason.trim(),
          ...(times.bufferMinutes !== '' ? { bufferMinutes: Number(times.bufferMinutes) } : {}),
        },
      }),
    onSuccess: (res) => {
      setOpen(null);
      onSaved(res.reprocess);
      onChanged();
    },
    onError: refreshOnError,
  });
  const patch = useMutation({
    mutationFn: (body: { name?: string; active?: boolean }) => api(`/v1/shifts/${shift.id}`, { method: 'PATCH', body: { expectedVersion: shift.version, ...body } }),
    onSuccess: () => {
      setOpen(null);
      onChanged();
    },
    onError: refreshOnError,
  });
  return (
    <>
      <button type="button" className="link" onClick={() => setOpen(open === 'times' ? null : 'times')}>
        Change times of {shift.code}
      </button>{' '}
      <button type="button" className="link" onClick={() => setOpen(open === 'name' ? null : 'name')}>
        Rename {shift.code}
      </button>{' '}
      <button type="button" className="link" disabled={patch.isPending} onClick={() => patch.mutate({ active: !shift.active })}>
        {shift.active ? 'Deactivate' : 'Activate'} {shift.code}
      </button>
      <Refusal error={open === null ? patch.error : null} />
      {open === 'times' && (
        <form
          className="grid-form"
          aria-label={`Change times of ${shift.code}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            revise.mutate();
          }}
        >
          <label>
            Applies from
            <input type="date" required value={times.effectiveFrom} onChange={(e) => setTimes({ ...times, effectiveFrom: e.target.value })} />
          </label>
          <TimesFields inTime={times.inTime} outTime={times.outTime} breaks={breaks} onTimes={(t) => setTimes({ ...times, ...t })} onBreaks={setBreaks} />
          <BufferField required={false} value={times.bufferMinutes} onChange={(bufferMinutes) => setTimes({ ...times, bufferMinutes })} />
          <label className="wide">
            Reason
            <input required maxLength={500} value={times.reason} onChange={(e) => setTimes({ ...times, reason: e.target.value })} />
          </label>
          <button type="submit" disabled={revise.isPending}>
            Save revision
          </button>
          <p className="hint wide">The earlier times stay in force before this date. A later revision on the same date corrects this one.</p>
          <Refusal error={revise.error} />
        </form>
      )}
      {open === 'name' && (
        <form
          className="grid-form"
          aria-label={`Rename ${shift.code}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            patch.mutate({ name: name.trim() });
          }}
        >
          <label>
            Name
            <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button type="submit" disabled={patch.isPending}>
            Save name
          </button>
          <Refusal error={patch.error} />
        </form>
      )}
    </>
  );
}

function RevisionHistory({ shift }: { shift: Shift }) {
  if (shift.revisions.length < 2) return null;
  return (
    <details>
      <summary>Revisions of {shift.code}</summary>
      <ul>
        {shift.revisions.map((r) => (
          <li key={r.revision}>
            Revision {r.revision}, {r.effectiveFrom ? `from ${r.effectiveFrom}` : 'from the start'}: {timesText(r)}
            {r.reason ? `. ${r.reason}` : ''}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ShiftMasterPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const canUpdate = can(SHIFT_UPDATE);
  const shifts = useQuery({ queryKey: ['shifts'], queryFn: () => api<{ items: Shift[] }>('/v1/shifts') });
  const { notice, show } = useReprocessNotice();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['shifts'] });
  const items = shifts.data?.items ?? [];
  return (
    <>
      <Section title="Shift master">
        <ErrorNote error={shifts.error} />
        {notice}
        {shifts.isSuccess && items.length === 0 && <Empty>No shifts yet.</Empty>}
        {items.length > 0 && (
          <table aria-label="Shifts">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">In force today</th>
                <th scope="col">Active</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td>{s.code}</td>
                  <td>{s.name}</td>
                  <td>
                    {timesText(s)}
                    <div className="hint">{s.effectiveFrom ? `Revision ${s.revision}, from ${s.effectiveFrom}` : 'From the start'}</div>
                    <RevisionHistory shift={s} />
                  </td>
                  <td>{s.active ? <Badge tone="good">active</Badge> : <Badge>inactive</Badge>}</td>
                  <td>{canUpdate && <ShiftActions key={s.version} shift={s} onChanged={refresh} onSaved={show} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">
          {BUFFER_HINT} A shift whose out time is before its in time runs into the next day (the 24-hour cycle) and still belongs to the date it starts; a shift of exactly 24 hours is not accepted.
        </p>
      </Section>
      {can(SHIFT_CREATE) && <NewShift onChanged={refresh} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Weekly-off patterns
// ---------------------------------------------------------------------------------------------------------

const WEEKDAYS = [
  { day: 1, name: 'Monday' },
  { day: 2, name: 'Tuesday' },
  { day: 3, name: 'Wednesday' },
  { day: 4, name: 'Thursday' },
  { day: 5, name: 'Friday' },
  { day: 6, name: 'Saturday' },
  { day: 7, name: 'Sunday' },
];
/** Some weeks of the month of one weekday (I-78 item 4): week 1 is days 1-7, week 5 days 29-31. */
interface Occurrences {
  weekday: number;
  weeks: number[];
}
const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th'];
const dayName = (d: number) => WEEKDAYS.find((w) => w.day === d)?.name ?? String(d);
const occurrencesText = (list: Occurrences[] | undefined, what: string) =>
  (list ?? []).map((o) => `${o.weeks.length === 5 ? 'every' : o.weeks.map((n) => ORDINAL[n - 1]).join(' and ')} ${dayName(o.weekday)} ${what}`);
const offText = (p: { offDays: number[]; offOccurrences?: Occurrences[]; halfOff?: Occurrences[] }) => {
  const parts = [...(p.offDays.length > 0 ? [`${p.offDays.map(dayName).join(', ')} off`] : []), ...occurrencesText(p.offOccurrences, 'off'), ...occurrencesText(p.halfOff, 'half off')];
  return parts.length === 0 ? 'No weekly off' : parts.join('; ');
};

export interface WeeklyOffCalendar {
  locationId: string;
  locationCode: string;
  locationName: string;
  active: boolean;
  inForce: { offDays: number[]; offOccurrences?: Occurrences[]; halfOff?: Occurrences[]; isDefault: boolean; revision: number | null; effectiveFrom: string | null };
  latestRevision: number;
  entries: { id: string; revision: number; effectiveFrom: string; offDays: number[]; offOccurrences?: Occurrences[]; halfOff?: Occurrences[]; reason: string }[];
}

/** Week choices per weekday as `${weekday}:${week}` keys; the API's list from them, weekdays off every week left out. */
const keysOf = (list: Occurrences[] | undefined) => (list ?? []).flatMap((o) => o.weeks.map((n) => `${o.weekday}:${n}`));
const listOf = (keys: string[], off: number[]): Occurrences[] =>
  WEEKDAYS.filter((w) => !off.includes(w.day))
    .map((w) => ({ weekday: w.day, weeks: [1, 2, 3, 4, 5].filter((n) => keys.includes(`${w.day}:${n}`)) }))
    .filter((o) => o.weeks.length > 0);

function PatternActions({ calendar, onChanged, onSaved }: { calendar: WeeklyOffCalendar; onChanged: () => void; onSaved: (r: ReprocessList) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ effectiveFrom: '', reason: '' });
  const [off, setOff] = useState<number[]>(calendar.inForce.offDays);
  const [weeksOff, setWeeksOff] = useState<string[]>(keysOf(calendar.inForce.offOccurrences));
  const [weeksHalf, setWeeksHalf] = useState<string[]>(keysOf(calendar.inForce.halfOff));
  const toggle = (list: string[], set: (v: string[]) => void, key: string, on: boolean) => set(on ? [...list, key] : list.filter((k) => k !== key));
  const save = useMutation({
    mutationFn: () =>
      api<{ reprocess: ReprocessList }>('/v1/weekly-off-patterns', {
        body: {
          locationId: calendar.locationId,
          effectiveFrom: form.effectiveFrom,
          offDays: [...off].sort((a, b) => a - b),
          offOccurrences: listOf(weeksOff, off),
          halfOff: listOf(weeksHalf, off),
          reason: form.reason.trim(),
          expectedRevision: calendar.latestRevision,
        },
      }),
    onSuccess: (res) => {
      setOpen(false);
      onSaved(res.reprocess);
      onChanged();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'STALE_VERSION') onChanged();
    },
  });
  const name = calendar.locationCode;
  return (
    <>
      <button type="button" className="link" onClick={() => setOpen(!open)}>
        Change pattern of {name}
      </button>
      {open && (
        <form
          className="grid-form"
          aria-label={`Change pattern of ${name}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <label>
            Applies from
            <input type="date" required value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
          </label>
          <fieldset className="wide">
            <legend>Weekly off days</legend>
            {WEEKDAYS.map((w) => (
              <label key={w.day} className="check">
                <input type="checkbox" checked={off.includes(w.day)} onChange={(e) => setOff(e.target.checked ? [...off, w.day] : off.filter((d) => d !== w.day))} /> {w.name}
              </label>
            ))}
          </fieldset>
          {[
            { legend: 'Off on some weeks of the month', list: weeksOff, set: setWeeksOff, other: weeksHalf, what: 'off' },
            { legend: 'Half weekly-off on some weeks of the month', list: weeksHalf, set: setWeeksHalf, other: weeksOff, what: 'half off' },
          ].map((group) => (
            <fieldset key={group.legend} className="wide">
              <legend>{group.legend}</legend>
              {WEEKDAYS.filter((w) => !off.includes(w.day)).map((w) => (
                <span key={w.day} className="row">
                  {[1, 2, 3, 4, 5].map((n) => {
                    const key = `${w.day}:${n}`;
                    return (
                      <label key={key} className="check">
                        <input type="checkbox" checked={group.list.includes(key)} disabled={group.other.includes(key)} onChange={(e) => toggle(group.list, group.set, key, e.target.checked)} />{' '}
                        {`${ORDINAL[n - 1]} ${w.name} ${group.what}`}
                      </label>
                    );
                  })}
                </span>
              ))}
            </fieldset>
          ))}
          <label className="wide">
            Reason
            <input required maxLength={500} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </label>
          <button type="submit" disabled={save.isPending}>
            Save pattern
          </button>
          <p className="hint wide">
            Weeks count from the 1st of the month: days 1 to 7 are the 1st week. A half weekly-off is still a working day for leave and payroll; attendance measures it against the first half of the shift. The earlier
            pattern stays in force before this date; a later entry on the same date corrects this one.
          </p>
          <Refusal error={save.error} />
        </form>
      )}
    </>
  );
}

export function WeeklyOffPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const canUpdate = can(SHIFT_UPDATE);
  const calendars = useQuery({ queryKey: ['weekly-off-patterns'], queryFn: () => api<{ defaultOffDays: number[]; items: WeeklyOffCalendar[] }>('/v1/weekly-off-patterns') });
  const { notice, show } = useReprocessNotice();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['weekly-off-patterns'] });
  const items = calendars.data?.items ?? [];
  return (
    <Section title="Weekly-off patterns">
      <ErrorNote error={calendars.error} />
      {notice}
      {calendars.isSuccess && items.length === 0 && <Empty>No locations yet.</Empty>}
      {items.length > 0 && (
        <table aria-label="Weekly-off patterns">
          <thead>
            <tr>
              <th scope="col">Location</th>
              <th scope="col">In force today</th>
              <th scope="col">Entries</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.locationId}>
                <td>
                  {c.locationCode} {c.locationName}
                  {c.active ? '' : ' (inactive)'}
                </td>
                <td>
                  {offText(c.inForce)}
                  <div className="hint">{c.inForce.isDefault ? 'The Monday to Friday default: no pattern is in force' : `Entry ${c.inForce.revision}, from ${c.inForce.effectiveFrom}`}</div>
                </td>
                <td>
                  {c.entries.length === 0 ? (
                    'None'
                  ) : (
                    <ul>
                      {c.entries.map((e) => (
                        <li key={e.id}>
                          Entry {e.revision}, from {e.effectiveFrom}: {offText(e)}. {e.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>{canUpdate && <PatternActions key={c.latestRevision} calendar={c} onChanged={refresh} onSaved={show} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="hint">
        Attendance, leave, outdoor duty, holiday work, payroll loss of pay and timesheet utilisation all count on this calendar; a half weekly-off counts as a working day for all of them but attendance. Reminders and
        hold escalations count business days on Monday to Friday.
      </p>
    </Section>
  );
}

export const CALENDARS_SCREENS: readonly ScreenRoute[] = [
  { path: '/calendars/holidays', title: 'Holiday calendar', permission: HOLIDAY_READ, nav: true, component: HolidayCalendarPage },
  { path: '/calendars/shifts', title: 'Shift master', permission: SHIFT_READ, nav: true, component: ShiftMasterPage },
  { path: '/calendars/weekly-off', title: 'Weekly-off patterns', permission: SHIFT_READ, nav: true, component: WeeklyOffPage },
];
