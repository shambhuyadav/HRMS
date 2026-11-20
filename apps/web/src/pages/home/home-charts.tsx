// The Home dashboard's charts (owner's request of 20 Nov 2026: leave used, attendance and the team on leave today, beside the number
// tiles). Each chart reads a list the selected role can already open on its own page, with that page's request and permission:
//   My leave balances      GET /v1/employees/{own id}/leave-balances      leave.read.operational, own record in scope (as Leave)
//   My attendance          GET /v1/employees/{own id}/attendance          attendance.read.operational, own record in scope (as My attendance)
//   My team today          GET /v1/my-team                                team.list.operational (as My team)
// Every count drawn is a count of rows the reader can open, so no figure the dashboard would hide as a small count (BR-045) is
// shown. A chart whose request fails or is refused is simply not shown: Home shows no new error for a chart. Nothing here changes
// a record.

import { useQuery } from '@tanstack/react-query';
import { type KeyboardEvent, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, dayText, formatUnits, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty } from '../../ui';
import { ownRecordInScope } from '../requests';
import { ChartCard, ChartTip, type Fill, Legend, type Part, SegmentedBar, TipLine, useChartTip } from './charts';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** The calendar's columns, Monday first. */
const WEEK_COLUMNS = [
  { short: 'Mon', name: 'Monday' },
  { short: 'Tue', name: 'Tuesday' },
  { short: 'Wed', name: 'Wednesday' },
  { short: 'Thu', name: 'Thursday' },
  { short: 'Fri', name: 'Friday' },
  { short: 'Sat', name: 'Saturday' },
  { short: 'Sun', name: 'Sunday' },
];

/** A calendar day (YYYY-MM-DD, or the date part of a longer value) as a UTC date, so no time zone moves it; null if not a day. */
function utcDay(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** Every day of the month `day` falls in, as YYYY-MM-DD; none when `day` is not a day. */
export function monthDays(day: string): string[] {
  const start = utcDay(day);
  if (!start) return [];
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => isoDay(new Date(Date.UTC(y, m, i + 1))));
}

/** "Tue 3 Nov". */
function shortDay(day: string): string {
  const d = utcDay(day);
  return d ? `${WEEKDAYS_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}` : day;
}

/** "November 2026". */
function monthName(day: string): string {
  const d = utcDay(day);
  return d ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : day;
}

/** Worked time as My attendance writes it: "8h 05m". */
const workedText = (minutes: number | null | undefined) => (minutes === null || minutes === undefined ? '—' : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`);

/** The role's records, never another assignment's: each chart's query key carries the assignment, as the dashboard's does. */
function useAssignmentKey(): string {
  const { stored } = useSession();
  return stored?.assignmentId ?? '-';
}

// ---- My leave balances --------------------------------------------------------------------------------------------------------

interface Balance {
  leaveType: string;
  leaveTypeName?: string;
  paid: boolean;
  available: string;
  pending: string;
  taken: string;
}

const LEAVE_SERIES: { key: 'taken' | 'pending' | 'available'; label: string; fill: Fill }[] = [
  { key: 'taken', label: 'Taken', fill: 'series1' },
  { key: 'pending', label: 'Pending', fill: 'series1-soft' },
  { key: 'available', label: 'Available', fill: 'track' },
];

const typeName = (b: Balance) => b.leaveTypeName || b.leaveType;
const units = (value: string) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Leave per type as a meter list: each paid type's taken, pending and available days as one thin bar (taken and pending fill it,
 * what is available is the track), with the figures written beside it, as the Leave page names them. Unpaid leave has no balance
 * to fill, so it is written, not drawn.
 */
function MyLeaveChart({ employeeId }: { employeeId: string }) {
  const assignment = useAssignmentKey();
  // Under the Leave page's key, so a request submitted or withdrawn there refreshes this too.
  const balances = useQuery({
    queryKey: ['balances', employeeId, 'home', assignment],
    queryFn: () => api<{ items: Balance[] }>(`/v1/employees/${encodeURIComponent(employeeId)}/leave-balances`),
    retry: retryTransient,
  });
  const items = balances.data?.items ?? [];
  const paid = items.filter((b) => b.paid);
  const unpaid = items.filter((b) => !b.paid && (units(b.taken) > 0 || units(b.pending) > 0));
  if (paid.length + unpaid.length === 0) return null;
  const table = (
    <table>
      <thead>
        <tr>
          <th>Type</th>
          <th>Available</th>
          <th>Pending</th>
          <th>Taken</th>
        </tr>
      </thead>
      <tbody>
        {[...paid, ...unpaid].map((b) => (
          <tr key={b.leaveType}>
            <td>
              {typeName(b)} {b.paid || /unpaid/i.test(b.leaveTypeName ?? '') ? '' : '(unpaid)'}
            </td>
            <td>{b.paid ? formatUnits(b.available) : '—'}</td>
            <td>{formatUnits(b.pending)}</td>
            <td>{formatUnits(b.taken)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <ChartCard
      title="My leave balances (days)"
      table={table}
      foot={
        <Link className="dash-chart-foot" to="/leave">
          Open Leave
        </Link>
      }
    >
      {paid.length > 0 && <Legend label="Leave balance parts" items={LEAVE_SERIES.map((s) => ({ key: s.key, label: s.label, fill: s.fill }))} />}
      {paid.length > 0 && (
        <ul className="dash-meters">
          {paid.map((b) => {
            const parts: Part[] = LEAVE_SERIES.map((s) => ({ key: s.key, label: s.label, fill: s.fill, value: Math.max(0, units(b[s.key])), text: formatUnits(b[s.key]) }));
            return (
              <li key={b.leaveType} className="dash-meter">
                <div className="dash-meter-head">
                  <span className="dash-meter-name">{typeName(b)}</span>
                  <span className="dash-meter-figure">
                    <strong>{formatUnits(b.available)}</strong> available
                  </span>
                </div>
                <SegmentedBar parts={parts} label={`${typeName(b)}, in days: ${formatUnits(b.available)} available, ${formatUnits(b.taken)} taken, ${formatUnits(b.pending)} pending`} />
                <span className="dash-meter-sub">
                  {formatUnits(b.taken)} taken · {formatUnits(b.pending)} pending
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {unpaid.map((b) => (
        <p key={b.leaveType} className="dash-chart-note">
          {typeName(b)} (unpaid, no balance): {formatUnits(b.taken)} taken · {formatUnits(b.pending)} pending
        </p>
      ))}
    </ChartCard>
  );
}

// ---- My attendance this month -------------------------------------------------------------------------------------------------

interface AttendanceDay {
  id: string;
  workDate: string;
  status: string;
  workedMinutes: number | null;
  late: boolean;
}

/** Each attendance outcome: its words (as the badges write them), its short code in the calendar and its status fill. */
const DAY_STATUSES: readonly { status: string; label: string; code: string; fill: Fill }[] = [
  { status: 'PRESENT', label: 'Present', code: 'P', fill: 'good' },
  { status: 'HALF_DAY', label: 'Half day', code: 'HD', fill: 'good' },
  { status: 'ON_DUTY', label: 'On duty', code: 'OD', fill: 'good' },
  { status: 'LEAVE', label: 'Leave', code: 'L', fill: 'info' },
  { status: 'HALF_DAY_LEAVE', label: 'Half day leave', code: 'HL', fill: 'info' },
  { status: 'ABSENT', label: 'Absent', code: 'A', fill: 'bad' },
  { status: 'EXCEPTION', label: 'Exception', code: '!', fill: 'warn' },
  { status: 'HOLIDAY', label: 'Holiday', code: 'H', fill: 'off' },
  { status: 'WEEKLY_OFF', label: 'Weekly off', code: 'WO', fill: 'off' },
];
interface DayStatus {
  status: string;
  label: string;
  code: string;
  fill: Fill;
}

/** A day up to today with no attendance result yet (the words the Team page uses for it). */
const NOT_CALCULATED: DayStatus = { status: 'NOT_PROCESSED', label: 'Not yet calculated', code: '–', fill: 'none' };
/** The legend's order: the outcomes as listed, then a day not yet calculated, then any outcome this screen has no words for. */
const STATUS_ORDER = [...DAY_STATUSES.map((s) => s.status), NOT_CALCULATED.status];
const statusRank = (status: string) => (STATUS_ORDER.includes(status) ? STATUS_ORDER.indexOf(status) : STATUS_ORDER.length);

function dayStatus(status: string): DayStatus {
  return DAY_STATUSES.find((s) => s.status === status) ?? { status, label: status.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()), code: '?', fill: 'none' };
}

interface CalendarDay {
  index: number;
  date: string;
  dayNumber: number;
  /** Null for a day after today. */
  status: DayStatus | null;
  record: AttendanceDay | undefined;
  today: boolean;
}

/** What a day's tooltip and accessible name say beyond its status: the date, worked time and the late flag. */
function dayDetail(day: CalendarDay): string {
  const parts = [shortDay(day.date)];
  if (day.record && day.record.workedMinutes !== null) parts.push(`${workedText(day.record.workedMinutes)} worked`);
  if (day.record?.late) parts.push('late');
  if (day.today) parts.push('today');
  return parts.join(' · ');
}

/**
 * The month as a calendar, Monday first: each day to today tinted by its outcome and marked with its short code (so no day is told
 * by colour alone), later days left plain. The grid is one tab stop; the arrow keys move a day or a week, Home and End go to the
 * month's first and last day, and the focused or hovered day shows its status, worked time and late flag.
 */
function MonthCalendar({ days, label }: { days: CalendarDay[]; label: string }) {
  const { frame, tip, show, hide } = useChartTip();
  const todayIndex = days.findIndex((d) => d.today);
  const [active, setActive] = useState(todayIndex >= 0 ? todayIndex : 0);
  const cells = useRef<(HTMLDivElement | null)[]>([]);
  const first = utcDay(days[0]?.date ?? '');
  const lead = first ? (first.getUTCDay() + 6) % 7 : 0;
  const slots: (CalendarDay | null)[] = [...Array.from({ length: lead }, () => null), ...days];
  while (slots.length % 7 !== 0) slots.push(null);
  const weeks = Array.from({ length: slots.length / 7 }, (_, w) => slots.slice(w * 7, w * 7 + 7));
  const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number;
    if (e.key in steps) next = active + (steps[e.key] ?? 0);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = days.length - 1;
    else return;
    e.preventDefault();
    next = Math.max(0, Math.min(days.length - 1, next));
    setActive(next);
    cells.current[next]?.focus();
  };
  const tipFor = (day: CalendarDay) => <TipLine fill={day.status?.fill} value={day.status?.label ?? 'Upcoming'} label={dayDetail(day)} />;
  return (
    <div className="dash-cal-frame" ref={frame}>
      <div role="grid" aria-label={label} className="dash-cal" onKeyDown={onKey} onMouseLeave={hide}>
        <div role="row" className="dash-cal-row">
          {WEEK_COLUMNS.map((c) => (
            <div key={c.short} role="columnheader" aria-label={c.name} className="dash-cal-head">
              {c.short}
            </div>
          ))}
        </div>
        {weeks.map((week, w) => (
          <div key={w} role="row" className="dash-cal-row">
            {week.map((day, i) =>
              day ? (
                <div
                  key={day.date}
                  ref={(el) => {
                    cells.current[day.index] = el;
                  }}
                  role="gridcell"
                  tabIndex={day.index === active ? 0 : -1}
                  aria-label={`${dayText(day.date)}: ${day.status?.label ?? 'upcoming'}${day.record && day.record.workedMinutes !== null ? `, ${workedText(day.record.workedMinutes)} worked` : ''}${day.record?.late ? ', late' : ''}`}
                  aria-current={day.today ? 'date' : undefined}
                  className={`dash-day ${day.status ? `dash-day-${day.status.fill}` : 'dash-day-future'}${day.today ? ' dash-day-today' : ''}`}
                  onFocus={(e) => {
                    setActive(day.index);
                    show(e.currentTarget, tipFor(day));
                  }}
                  onBlur={hide}
                  onMouseEnter={(e) => show(e.currentTarget, tipFor(day))}
                >
                  <span className="dash-day-num" aria-hidden="true">
                    {day.dayNumber}
                  </span>
                  <span className="dash-day-code" aria-hidden="true">
                    {day.status?.code ?? ''}
                  </span>
                </div>
              ) : (
                <div key={`blank-${w}-${i}`} role="gridcell" className="dash-day dash-day-blank" />
              ),
            )}
          </div>
        ))}
      </div>
      {tip && <ChartTip tip={tip} frame={frame} />}
    </div>
  );
}

/** The own attendance of the dashboard's month, to the business date, as My attendance lists it. */
function MyAttendanceChart({ employeeId, businessDate }: { employeeId: string; businessDate: string }) {
  const assignment = useAssignmentKey();
  const month = monthDays(businessDate);
  const from = month[0] ?? businessDate;
  const attendance = useQuery({
    queryKey: ['home-attendance', assignment, employeeId, from, businessDate],
    enabled: month.length > 0,
    queryFn: () => api<{ items: AttendanceDay[] }>(`/v1/employees/${encodeURIComponent(employeeId)}/attendance?from=${from}&to=${businessDate}`),
    retry: retryTransient,
  });
  if (!attendance.data || month.length === 0) return null;
  const byDate = new Map(attendance.data.items.map((r) => [r.workDate.slice(0, 10), r]));
  const days: CalendarDay[] = month.map((date, index) => {
    const record = byDate.get(date);
    const past = date <= businessDate;
    return { index, date, dayNumber: index + 1, record, today: date === businessDate, status: !past ? null : record ? dayStatus(record.status) : NOT_CALCULATED };
  });
  const upToToday = days.filter((d) => d.status);
  // How many days of each outcome, in the legend's order; an outcome this screen has no words for still counts, under its own name.
  const tally = new Map<string, DayStatus & { count: number }>();
  for (const d of upToToday) {
    if (!d.status) continue;
    const seen = tally.get(d.status.status);
    if (seen) seen.count += 1;
    else tally.set(d.status.status, { ...d.status, count: 1 });
  }
  const counted = [...tally.values()].sort((a, b) => statusRank(a.status) - statusRank(b.status));
  const name = monthName(businessDate);
  const table = (
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Status</th>
          <th>Worked</th>
        </tr>
      </thead>
      <tbody>
        {upToToday.map((d) => (
          <tr key={d.date}>
            <td>{dayText(d.date)}</td>
            <td>
              {d.status?.label}
              {d.record?.late ? ' (late)' : ''}
            </td>
            <td>{workedText(d.record?.workedMinutes)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <ChartCard
      title="My attendance this month"
      table={table}
      foot={
        <Link className="dash-chart-foot" to="/me/attendance">
          Open My attendance
        </Link>
      }
    >
      <p className="dash-chart-caption">
        {name}, to {shortDay(businessDate)}
      </p>
      {attendance.data.items.length === 0 && <p className="dash-chart-note">No attendance has been calculated for this month yet.</p>}
      <ul className="dash-legend" aria-label={`Days by status in ${name}`}>
        {counted.map((s) => (
          <li key={s.status}>
            <span className={`dash-day-chip dash-day-${s.fill}`} aria-hidden="true">
              {s.code}
            </span>
            <span>{s.label}</span>
            <strong>{s.count}</strong>
          </li>
        ))}
      </ul>
      {/* A new month (the business date moved on) starts the keyboard position afresh. */}
      <MonthCalendar key={from} days={days} label={`My attendance in ${name}`} />
    </ChartCard>
  );
}

// ---- My team today ------------------------------------------------------------------------------------------------------------

interface TeamMember {
  id: string;
  employeeCode: string;
  displayName: string;
  todayAttendance: string | null;
}

/**
 * Today's attendance of the team, in the attendance dashboard's groups (a half day counts as present). A member whose day is not
 * calculated yet is counted as such: the team list knows a day's leave or absence only once attendance is calculated.
 */
const TEAM_GROUPS: readonly { key: string; label: string; fill: Fill; statuses: readonly string[]; named: boolean }[] = [
  { key: 'present', label: 'Present or on duty', fill: 'good', statuses: ['PRESENT', 'HALF_DAY', 'ON_DUTY'], named: false },
  { key: 'leave', label: 'On leave', fill: 'info', statuses: ['LEAVE', 'HALF_DAY_LEAVE'], named: true },
  { key: 'absent', label: 'Absent', fill: 'bad', statuses: ['ABSENT'], named: true },
  { key: 'exception', label: 'Exception to review', fill: 'warn', statuses: ['EXCEPTION'], named: true },
  { key: 'off', label: 'Weekly off or holiday', fill: 'off', statuses: ['WEEKLY_OFF', 'HOLIDAY'], named: false },
  { key: 'pending', label: 'Not yet calculated', fill: 'none', statuses: [], named: false },
];
const groupOf = (status: string | null) => TEAM_GROUPS.find((g) => status !== null && g.statuses.includes(status)) ?? TEAM_GROUPS[TEAM_GROUPS.length - 1]!;

/** The list's largest page, and how many of them Home reads at most (a team of up to 500 members is read whole). */
const TEAM_PAGE_SIZE = 100;
const TEAM_PAGES = 5;

async function wholeTeam(): Promise<{ items: TeamMember[]; total: number }> {
  const items: TeamMember[] = [];
  let total = 0;
  for (let page = 1; page <= TEAM_PAGES; page++) {
    const answer = await api<{ items: TeamMember[]; total: number }>(`/v1/my-team?page=${page}&pageSize=${TEAM_PAGE_SIZE}`);
    items.push(...answer.items);
    total = answer.total;
    if (items.length >= total || answer.items.length < TEAM_PAGE_SIZE) break;
  }
  return { items, total };
}

const memberName = (m: TeamMember) => `${m.displayName}${m.todayAttendance === 'HALF_DAY_LEAVE' ? ' (half day)' : ''}`;

/** The manager's panel: how the team stands today, and by name who is on leave, absent or has an exception to review. */
function TeamTodayPanel() {
  const assignment = useAssignmentKey();
  const team = useQuery({ queryKey: ['home-team-today', assignment], queryFn: wholeTeam, retry: retryTransient });
  if (!team.data) return null;
  const { items, total } = team.data;
  const foot = (
    <Link className="dash-chart-foot" to="/team">
      Open My team
    </Link>
  );
  if (items.length === 0) {
    return (
      <ChartCard title="My team today" foot={foot}>
        <Empty>No current team members.</Empty>
      </ChartCard>
    );
  }
  const groups = TEAM_GROUPS.map((g) => ({ ...g, members: items.filter((m) => groupOf(m.todayAttendance) === g) }));
  const parts: Part[] = groups.map((g) => ({ key: g.key, label: g.label, fill: g.fill, value: g.members.length, text: String(g.members.length) }));
  const named = groups.filter((g) => g.named && g.members.length > 0);
  const nothingCalculated = groups.every((g) => g.key === 'pending' || g.members.length === 0);
  const counted = items.length;
  const table = (
    <table>
      <thead>
        <tr>
          <th>Attendance today</th>
          <th>Team members</th>
          <th>Who</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => (
          <tr key={g.key}>
            <td>{g.label}</td>
            <td>{g.members.length}</td>
            <td>{g.members.length ? g.members.map(memberName).join(', ') : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <ChartCard title="My team today" table={table} foot={foot}>
      <p className="dash-chart-lead">
        <strong>{counted}</strong> {counted === 1 ? 'team member' : 'team members'}
      </p>
      <SegmentedBar
        parts={parts}
        label={`My team today, ${counted} ${counted === 1 ? 'member' : 'members'}: ${groups
          .filter((g) => g.members.length > 0)
          .map((g) => `${g.members.length} ${g.label.toLowerCase()}`)
          .join(', ')}`}
      />
      <Legend label="Team members by attendance today" items={groups.filter((g) => g.members.length > 0).map((g) => ({ key: g.key, label: g.label, fill: g.fill, value: g.members.length }))} />
      {nothingCalculated && <p className="dash-chart-note">Today’s attendance is not calculated yet; who is on leave or absent shows here once it is.</p>}
      {!nothingCalculated && named.length === 0 && <p className="dash-chart-note">Nobody is on leave or absent today.</p>}
      {named.length > 0 && (
        <dl className="dash-people">
          {named.map((g) => (
            <div key={g.key}>
              <dt>
                <i className={`dash-swatch dash-fill-${g.fill}`} aria-hidden="true" />
                {g.label}
              </dt>
              <dd>
                {g.members.map((m, i) => (
                  <span key={m.id}>
                    {i > 0 && ', '}
                    <Link to={`/team/${encodeURIComponent(m.id)}`}>{m.displayName}</Link>
                    {m.todayAttendance === 'HALF_DAY_LEAVE' ? ' (half day)' : ''}
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {total > counted && (
        <p className="dash-chart-note">
          Showing the first {counted} of {total} team members.
        </p>
      )}
    </ChartCard>
  );
}

// ---- The charts a role sees ---------------------------------------------------------------------------------------------------

/**
 * The charts the selected role may see, each under the permission of the page it comes from; the own-record charts only where the
 * role is linked to an employee and its scope reaches the own record (as the dashboard's own quick actions). None applying, the
 * row takes no room.
 */
export function HomeCharts({ businessDate }: { businessDate: string }) {
  const { me, can } = useSession();
  const ownId = me?.employeeId && ownRecordInScope(me.scopeKind) ? me.employeeId : null;
  return (
    <div className="dash-charts">
      {ownId && can('leave.read.operational') && <MyLeaveChart employeeId={ownId} />}
      {ownId && can('attendance.read.operational') && <MyAttendanceChart employeeId={ownId} businessDate={businessDate} />}
      {can('team.list.operational') && <TeamTodayPanel />}
    </div>
  );
}
