// Attendance control (FR-021; E07): attendance across the role's scope, filtered by department, location, status, shift,
// date, employee and minutes, in pages with the total and a matching export. One day opens with its untouched source
// punches beside the derived result, the policy revision and why the status changed (amendments and earlier values).
// An amendment of a day needs the fact behind it on the server, and a day a processed payroll used is final. E07, decided
// under owner delegation, 6 Nov 2026 (I-78 item 6): the organisation and the working organisation are the company the role
// acts for, so they are shown, not chosen; the entity is what the minute comparison measures (worked, scheduled, shortfall,
// late or overtime-candidate minutes). The server re-checks everything.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, formatDate } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, LIST_PAGE_SIZE, Pager, pageParams, Section } from '../ui';
import { keepOnPage, ReportExport } from './leave-admin';

interface ControlRow {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  departmentCode: string | null;
  locationCode: string | null;
  workDate: string;
  status: string;
  workedMinutes: number;
  scheduledNetMinutes: number;
  late: boolean;
  lateMinutes?: number | null;
  earlyDeparture: boolean;
  /** 0265: minutes before the scheduled end on an early-departure day (none on a day evaluated before it). */
  earlyDepartureMinutes?: number | null;
  overtimeCandidateMinutes?: number | null;
  exceptionCode: string | null;
  amended: boolean;
  version: number;
  shiftCode: string | null;
  policyCode: string;
  policyRevision: number;
  payrollLocked: boolean;
}
interface DayView {
  derived: { status: string; workedMinutes: number; scheduledNetMinutes: number; exceptionCode: string | null; shiftCode: string | null; policyCode: string; policyRevision: number };
  punches: { occurredAt: string; direction: string; sourceKind: string }[];
}
interface ChangeLog {
  items: { occurredAt: string; oldStatus: string; newStatus: string; reason?: string; actorUserId: string }[];
  revisions: { occurredAt: string; cause: 'PROCESSING' | 'AMENDMENT'; status: string; workedMinutes: number; exceptionCode: string | null; policyCode: string; policyRevision: number }[];
}

const STATUSES = ['PRESENT', 'HALF_DAY', 'ABSENT', 'LEAVE', 'HALF_DAY_LEAVE', 'HOLIDAY', 'WEEKLY_OFF', 'ON_DUTY', 'EXCEPTION'] as const;
const STATUS_TEXT: Record<string, string> = {
  PRESENT: 'Present',
  HALF_DAY: 'Half day',
  ABSENT: 'Absent',
  LEAVE: 'Leave',
  HALF_DAY_LEAVE: 'Half-day leave',
  HOLIDAY: 'Holiday',
  WEEKLY_OFF: 'Weekly off',
  ON_DUTY: 'On duty',
  EXCEPTION: 'Exception',
};
const statusText = (code: string) => STATUS_TEXT[code] ?? code;
/** An amendment sets a reviewed outcome: every status but EXCEPTION. */
const AMENDABLE = STATUSES.filter((s) => s !== 'EXCEPTION');
const NEEDS_FACT = 'Leave and on-duty need an approved request on this date; holiday and weekly off need that calendar fact.';
const formatInstant = (value: string) => new Date(value).toLocaleString();

interface Filters {
  from: string;
  to: string;
  search: string;
  departmentId: string;
  locationId: string;
  status: string;
  shiftId: string;
  minuteField: string;
  minuteOp: string;
  minuteValue: string;
}
const noFilters: Filters = { from: '', to: '', search: '', departmentId: '', locationId: '', status: '', shiftId: '', minuteField: '', minuteOp: '', minuteValue: '' };

/** Only what is filled in, and the minute comparison only when whole. */
function activeFilters(f: Filters): Record<string, string | number> {
  const { minuteField, minuteOp, minuteValue, ...rest } = f;
  const given = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== '')) as Record<string, string | number>;
  return minuteField && minuteOp && minuteValue !== '' ? { ...given, minuteField, minuteOp, minuteValue: Number(minuteValue) } : given;
}

function DayPanel({ row, onChanged }: { row: ControlRow; onChanged: () => void }) {
  const { can } = useSession();
  const day = useQuery({ queryKey: ['attendance-day', row.id, row.version], queryFn: () => api<DayView>(`/v1/attendance/records/${row.id}/day`) });
  const log = useQuery({ queryKey: ['attendance-log', row.id, row.version], queryFn: () => api<ChangeLog>(`/v1/attendance/records/${row.id}/amendments`) });
  const [status, setStatus] = useState<string>('PRESENT');
  const [reason, setReason] = useState('');
  const amend = useMutation({
    mutationFn: () => api(`/v1/attendance/records/${row.id}/amend`, { body: { expectedVersion: row.version, status, reason: reason.trim() } }),
    onSuccess: () => {
      setReason('');
      onChanged();
    },
  });
  return (
    <Section title={`${row.employeeCode} on ${formatDate(row.workDate)}`}>
      <ErrorNote error={day.error ?? log.error} />
      {day.data && (
        <>
          <p>
            {`Result: ${statusText(day.data.derived.status)}, ${day.data.derived.workedMinutes} of ${day.data.derived.scheduledNetMinutes} minutes, policy ${day.data.derived.policyCode} revision ${day.data.derived.policyRevision}`}
            {day.data.derived.shiftCode ? `, shift ${day.data.derived.shiftCode}` : ''}
          </p>
          <h3>Source punches</h3>
          {day.data.punches.length === 0 && <Empty>No punches in this day’s capture window.</Empty>}
          {day.data.punches.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Direction</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {day.data.punches.map((p) => (
                  <tr key={`${p.occurredAt}:${p.direction}:${p.sourceKind}`}>
                    <td>{formatInstant(p.occurredAt)}</td>
                    <td>{p.direction === 'IN' ? 'In' : 'Out'}</td>
                    <td>{p.sourceKind === 'BIOMETRIC_API' ? 'Biometric device' : 'Manual import'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {log.data && (
        <>
          <h3>Why the status changed</h3>
          {log.data.items.length === 0 && log.data.revisions.length === 0 && <Empty>The result has not changed since it was first evaluated.</Empty>}
          <ul>
            {log.data.items.map((a) => (
              <li key={`amendment:${a.occurredAt}`}>
                {`${formatInstant(a.occurredAt)}: amended from ${statusText(a.oldStatus)} to ${statusText(a.newStatus)}`}
                {a.reason ? ` (${a.reason})` : ''}
              </li>
            ))}
            {log.data.revisions.map((v) => (
              <li key={`revision:${v.occurredAt}`}>
                {`${formatInstant(v.occurredAt)}: ${v.cause === 'PROCESSING' ? 'reprocessing replaced' : 'amendment replaced'} ${statusText(v.status)}, ${v.workedMinutes} minutes, policy ${v.policyCode} revision ${v.policyRevision}`}
                {v.exceptionCode ? `, exception ${v.exceptionCode}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
      {row.payrollLocked ? (
        <p role="note">
          <Badge tone="warn">payroll locked</Badge> A processed payroll used this day, so its attendance can no longer change here.
        </p>
      ) : (
        can('attendance.amend.operational') && (
          <form
            className="grid-form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              amend.mutate();
            }}
          >
            <label>
              Amend to
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                {AMENDABLE.map((s) => (
                  <option key={s} value={s}>
                    {statusText(s)}
                  </option>
                ))}
              </select>
            </label>
            <label className="wide">
              Reason for the amendment
              <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <button type="submit" disabled={amend.isPending}>
              Amend
            </button>
            <p className="hint">{NEEDS_FACT} The source punches stay as they are.</p>
            <ErrorNote error={amend.error} />
          </form>
        )
      )}
    </Section>
  );
}

function AttendanceControlPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [filters, setFilters] = useState(noFilters);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const set = (key: keyof Filters, value: string) => {
    setFilters({ ...filters, [key]: value });
    setPage(1);
  };
  const active = activeFilters(filters);
  const ready = !!filters.from && !!filters.to;
  const params = new URLSearchParams(Object.entries(active).map(([k, v]) => [k, String(v)])).toString();
  const list = useQuery({
    queryKey: ['attendance-control', params, page],
    enabled: ready,
    queryFn: () => api<{ items: ControlRow[]; total: number; page: number; pageSize: number }>(`/v1/attendance/records?${params}&${pageParams(page)}`),
  });
  const departments = useQuery({ queryKey: ['control-departments'], queryFn: () => api<{ items: { id: string; code: string }[] }>('/v1/org/departments'), enabled: can('org_master.read.operational') });
  const locations = useQuery({ queryKey: ['control-locations'], queryFn: () => api<{ items: { id: string; code: string }[] }>('/v1/org/locations'), enabled: can('org_master.read.operational') });
  const shifts = useQuery({ queryKey: ['control-shifts'], queryFn: () => api<{ items: { id: string; code: string }[] }>('/v1/shifts'), enabled: can('shift.read.operational') });
  const opened = list.data?.items.find((r) => r.id === openId);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['attendance-control'] });
  return (
    <>
      <Section title="Attendance control">
        <form className="grid-form" onSubmit={keepOnPage}>
          <label>
            From
            <input type="date" required value={filters.from} onChange={(e) => set('from', e.target.value)} />
          </label>
          <label>
            To
            <input type="date" required value={filters.to} onChange={(e) => set('to', e.target.value)} />
          </label>
          <label>
            Employee or code
            <input maxLength={100} value={filters.search} onChange={(e) => set('search', e.target.value)} />
          </label>
          <label>
            Status
            <select value={filters.status} onChange={(e) => set('status', e.target.value)}>
              <option value="">All</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {statusText(s)}
                </option>
              ))}
            </select>
          </label>
          {departments.data && (
            <label>
              Department
              <select value={filters.departmentId} onChange={(e) => set('departmentId', e.target.value)}>
                <option value="">All</option>
                {departments.data.items.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.code}
                  </option>
                ))}
              </select>
            </label>
          )}
          {locations.data && (
            <label>
              Location
              <select value={filters.locationId} onChange={(e) => set('locationId', e.target.value)}>
                <option value="">All</option>
                {locations.data.items.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code}
                  </option>
                ))}
              </select>
            </label>
          )}
          {shifts.data && (
            <label>
              Shift
              <select value={filters.shiftId} onChange={(e) => set('shiftId', e.target.value)}>
                <option value="">All</option>
                {shifts.data.items.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Entity (minutes of)
            <select value={filters.minuteField} onChange={(e) => set('minuteField', e.target.value)}>
              <option value="">Any</option>
              <option value="WORKED">Worked</option>
              <option value="SCHEDULED">Scheduled</option>
              <option value="SHORTFALL">Short of scheduled</option>
              <option value="LATE">Late</option>
              <option value="EARLY_DEPARTURE">Early departure</option>
              <option value="OVERTIME_CANDIDATE">Overtime candidate</option>
            </select>
          </label>
          <label>
            Compared
            <select value={filters.minuteOp} onChange={(e) => set('minuteOp', e.target.value)}>
              <option value="">—</option>
              <option value="LT">less than</option>
              <option value="LTE">at most</option>
              <option value="EQ">exactly</option>
              <option value="GTE">at least</option>
              <option value="GT">more than</option>
            </select>
          </label>
          <label>
            Number of minutes
            <input inputMode="numeric" pattern="\d{1,6}" value={filters.minuteValue} onChange={(e) => set('minuteValue', e.target.value)} />
          </label>
        </form>
        <p className="hint">
          Organisation and working organisation: the company you are acting for. Late minutes count from the shift start on a late day, early-departure minutes up to the shift end; overtime candidates are proposals for a manager’s decision, never pay.
        </p>
        {!ready && <p className="hint">Choose a period to list attendance.</p>}
        <ErrorNote error={list.error} />
        {list.isSuccess && list.data.total === 0 && <Empty>No attendance matches these filters.</Empty>}
        {list.isSuccess && list.data.items.length > 0 && (
          <>
            <p role="status">{`${list.data.total} ${list.data.total === 1 ? 'day' : 'days'}`}</p>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Employee</th>
                  <th>Department</th>
                  <th>Location</th>
                  <th>Shift</th>
                  <th>Status</th>
                  <th>Minutes</th>
                  <th>Policy</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((r) => (
                  <tr key={r.id}>
                    <td>{formatDate(r.workDate)}</td>
                    <td>{`${r.employeeCode} ${r.employeeName}`}</td>
                    <td>{r.departmentCode ?? '—'}</td>
                    <td>{r.locationCode ?? '—'}</td>
                    <td>{r.shiftCode ?? '—'}</td>
                    <td>
                      {statusText(r.status)} {r.late && <Badge tone="warn">{r.lateMinutes ? `late ${r.lateMinutes} min` : 'late'}</Badge>}{' '}
                      {r.earlyDeparture && <Badge tone="warn">{r.earlyDepartureMinutes ? `left ${r.earlyDepartureMinutes} min early` : 'left early'}</Badge>}{' '}
                      {!!r.overtimeCandidateMinutes && <Badge>{`overtime candidate ${r.overtimeCandidateMinutes} min`}</Badge>} {r.amended && <Badge>amended</Badge>} {r.payrollLocked && <Badge tone="warn">payroll locked</Badge>}
                      {r.exceptionCode && <span className="hint"> {r.exceptionCode}</span>}
                    </td>
                    <td>{`${r.workedMinutes} of ${r.scheduledNetMinutes}`}</td>
                    <td>{`${r.policyCode} revision ${r.policyRevision}`}</td>
                    <td>
                      <button type="button" className="link" onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                        Open {r.employeeCode}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager page={list.data.page} pageSize={LIST_PAGE_SIZE} total={list.data.total} onPage={setPage} label="Attendance pages" noun="day" />
          </>
        )}
        {ready && can('attendance.export.operational') && <ReportExport reportCode="ATTENDANCE_REGISTER" label="Export this list" filters={active} />}
      </Section>
      {opened && <DayPanel key={opened.id} row={opened} onChanged={refresh} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Attendance dashboard (BRD coverage CL-053): a date (today unless chosen) and any departments, with the counts per department
// and in total; every count opens the employees behind it, read by the server with the same rule, so a list's total is the
// count clicked. A processed day is read from its results; a day not processed yet shows what is known (punched, not punched,
// on approved leave, off days), and the page says which it is.
// ---------------------------------------------------------------------------------------------------------

const DASHBOARD_TEXT: Record<string, string> = {
  PRESENT: 'Present',
  ABSENT: 'Absent',
  ON_LEAVE: 'On leave',
  OUTDOOR_OR_HOLIDAY_WORK: 'Outdoor duty or holiday work',
  OFF_DAY: 'Weekly off or holiday',
  NEEDS_REVIEW: 'Exception to review',
  PUNCHED: 'Punched, not yet processed',
  NOT_PUNCHED: 'Not punched yet',
  LATE: 'Late',
};
const dashboardText = (code: string) => DASHBOARD_TEXT[code] ?? code;

interface DashboardCounts {
  departmentId: string | null;
  departmentCode: string | null;
  departmentName: string | null;
  total: number;
  counts: Record<string, number>;
}
interface DashboardView {
  date: string;
  processing: { state: 'PROCESSED' | 'PARTLY_PROCESSED' | 'NOT_PROCESSED'; employees: number; processed: number };
  categories: string[];
  departments: DashboardCounts[];
  total: DashboardCounts;
}
interface DashboardRow {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  departmentCode: string | null;
  shiftCode: string | null;
  category: string;
  processedStatus: string | null;
  processed: boolean;
  late: boolean;
  lateMinutes: number | null;
  punchCount: number;
  firstPunch: string | null;
  lastPunch: string | null;
  punchSourceUnavailable: boolean;
}
interface OpenedCount {
  list: string;
  department: DashboardCounts | null;
}

function processingNote(p: DashboardView['processing']): string {
  if (p.employees === 0) return 'Nobody in your scope is employed on this date.';
  if (p.state === 'PROCESSED') return `Processed for all ${p.employees} ${p.employees === 1 ? 'employee' : 'employees'}: the counts are the processed results.`;
  if (p.state === 'PARTLY_PROCESSED')
    return `Processed for ${p.processed} of ${p.employees} employees. The others are not processed yet, so they show what is known: punched, not punched, on approved leave or an off day.`;
  return 'This date has not been processed yet, so the counts show what is known: punched, not punched, on approved leave or an off day. Absence and lateness are known once it is processed.';
}

const departmentsQuery = (ids: string[]) => ids.map((id) => `departmentId=${encodeURIComponent(id)}`).join('&');

function DashboardList({ date, departments, opened }: { date: string; departments: string[]; opened: OpenedCount }) {
  const [page, setPage] = useState(1);
  const where = opened.department ? (opened.department.departmentId ? `&inDepartment=${opened.department.departmentId}` : '&withoutDepartment=true') : '';
  const choice = departmentsQuery(departments);
  const list = useQuery({
    queryKey: ['attendance-dashboard-list', date, choice, opened.list, opened.department?.departmentId ?? null, page],
    queryFn: () =>
      api<{ items: DashboardRow[]; total: number; page: number }>(`/v1/attendance/dashboard/employees?date=${date}&list=${opened.list}${choice ? `&${choice}` : ''}${where}&${pageParams(page)}`),
  });
  const scope = opened.department ? ` in ${opened.department.departmentCode ?? 'no department'}` : '';
  return (
    <Section title={`${dashboardText(opened.list)}${scope} on ${formatDate(date)}`}>
      <ErrorNote error={list.error} />
      {list.isSuccess && list.data.total === 0 && <Empty>Nobody is in this count.</Empty>}
      {list.isSuccess && list.data.items.length > 0 && (
        <>
          <p role="status">{`${list.data.total} ${list.data.total === 1 ? 'employee' : 'employees'}`}</p>
          <table aria-label="Employees in this count">
            <thead>
              <tr>
                <th>Code</th>
                <th>Employee</th>
                <th>Department</th>
                <th>Shift</th>
                <th>Day</th>
                <th>Punches</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((r) => (
                <tr key={r.employeeId}>
                  <td>{r.employeeCode}</td>
                  <td>{r.employeeName}</td>
                  <td>{r.departmentCode ?? '—'}</td>
                  <td>{r.shiftCode ?? 'No shift'}</td>
                  <td>
                    {r.processed && r.processedStatus ? statusText(r.processedStatus) : dashboardText(r.category)} {!r.processed && <Badge>not processed</Badge>}{' '}
                    {r.late && <Badge tone="warn">{r.lateMinutes ? `late ${r.lateMinutes} min` : 'late'}</Badge>} {r.punchSourceUnavailable && <Badge tone="warn">punch source failed</Badge>}
                  </td>
                  <td>{r.punchCount === 0 ? 'None' : `${r.punchCount}: ${r.firstPunch ?? ''}${r.punchCount > 1 ? ` – ${r.lastPunch ?? ''}` : ''}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={list.data.page} pageSize={LIST_PAGE_SIZE} total={list.data.total} onPage={setPage} label="Employees in this count pages" noun="employee" />
        </>
      )}
    </Section>
  );
}

function AttendanceDashboardPage() {
  const { can } = useSession();
  const [date, setDate] = useState('');
  const [departments, setDepartments] = useState<string[]>([]);
  const [opened, setOpened] = useState<OpenedCount | null>(null);
  const choice = departmentsQuery(departments);
  const query = [date ? `date=${date}` : '', choice].filter(Boolean).join('&');
  const dashboard = useQuery({ queryKey: ['attendance-dashboard', query], queryFn: () => api<DashboardView>(`/v1/attendance/dashboard${query ? `?${query}` : ''}`) });
  const options = useQuery({ queryKey: ['control-departments'], queryFn: () => api<{ items: { id: string; code: string }[] }>('/v1/org/departments'), enabled: can('org_master.read.operational') });
  const view = dashboard.data;
  const columns = view ? [...view.categories, 'LATE'] : [];
  const cell = (row: DashboardCounts, column: string, isTotal: boolean) => {
    const n = row.counts[column] ?? 0;
    if (n === 0) return '0';
    return (
      <button type="button" className="link" onClick={() => setOpened({ list: column, department: isTotal ? null : row })}>
        {String(n)}
        <span className="hint">{` ${dashboardText(column)}${isTotal ? '' : ` in ${row.departmentCode ?? 'no department'}`}`}</span>
      </button>
    );
  };
  return (
    <>
      <Section title="Attendance dashboard">
        <form className="grid-form" onSubmit={keepOnPage}>
          <label>
            Date
            <input
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setOpened(null);
              }}
            />
          </label>
          {options.data && (
            <label>
              Departments
              <select
                multiple
                value={departments}
                onChange={(e) => {
                  setDepartments(Array.from(e.target.selectedOptions, (o) => o.value));
                  setOpened(null);
                }}
              >
                {options.data.items.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.code}
                  </option>
                ))}
              </select>
            </label>
          )}
        </form>
        <p className="hint">Today unless you choose a date; every department of your scope unless you choose some. Each count opens the employees behind it.</p>
        <ErrorNote error={dashboard.error ?? options.error} />
        {view && (
          <>
            <p role="status">
              {`${formatDate(view.date)}: `}
              {view.processing.state !== 'PROCESSED' && <Badge tone="warn">{view.processing.state === 'NOT_PROCESSED' ? 'not processed' : 'partly processed'}</Badge>} {processingNote(view.processing)}
            </p>
            {view.total.total > 0 && (
              <table aria-label="Attendance by department">
                <thead>
                  <tr>
                    <th>Department</th>
                    <th>Employees</th>
                    {columns.map((c) => (
                      <th key={c}>{dashboardText(c)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.departments.map((d) => (
                    <tr key={d.departmentId ?? 'none'}>
                      <td>{d.departmentName ? `${d.departmentCode} ${d.departmentName}` : 'No department'}</td>
                      <td>{d.total}</td>
                      {columns.map((c) => (
                        <td key={c}>{cell(d, c, false)}</td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <th scope="row">Total</th>
                    <td>{view.total.total}</td>
                    {columns.map((c) => (
                      <td key={c}>{cell(view.total, c, true)}</td>
                    ))}
                  </tr>
                </tbody>
              </table>
            )}
            <p className="hint">Each employee is counted once; late is counted beside present, from processed results only.</p>
          </>
        )}
      </Section>
      {view && opened && <DashboardList key={`${opened.list}:${opened.department?.departmentId ?? 'all'}`} date={view.date} departments={departments} opened={opened} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Attendance reports (BRD coverage CL-047 shift punch register, CL-049 shift plan register, CL-050 shift deviation register,
// CL-051 absconding report): the filters each report takes, generated in the background as CSV or XLSX with the filter
// context (FR-056, DF09). The server applies the row scope and checks every filter again.
// ---------------------------------------------------------------------------------------------------------

const ATTENDANCE_REPORTS = [
  { code: 'SHIFT_PUNCH_REGISTER', title: 'Shift punch register', maxDays: 31, note: 'Each employee and day with the shift and the punches of its capture window. Terminal: a biometric device; Import: a punch file. No mobile punch is captured.' },
  { code: 'SHIFT_PLAN_REGISTER', title: 'Shift plan register', maxDays: 92, note: 'The shift planned for each employee and day, its times, and whether the day is a working day, a weekly off or a holiday.' },
  { code: 'SHIFT_DEVIATION_REGISTER', title: 'Shift deviation register', maxDays: 366, note: 'Processed days with a late arrival, an early departure or overtime-candidate minutes. A day not processed yet is not listed.' },
  {
    code: 'ABSCONDING_REPORT',
    title: 'Absconding report',
    maxDays: 92,
    note: 'Runs of consecutive absent working days before today: no punch, no approved leave or outdoor duty. A weekend or holiday in between neither counts nor ends a run; leave, outdoor duty or a punch ends it.',
  },
] as const;
type AttendanceReportCode = (typeof ATTENDANCE_REPORTS)[number]['code'];

/**
 * CL-047 and CL-049 follow-up: the other layout of a register, generated as a report of its own (its columns differ) with the same
 * filters, row scope and permission. One row per employee and day stays the default.
 */
const REPORT_LAYOUTS: Partial<Record<AttendanceReportCode, { code: string; label: string; title: string; note: string }>> = {
  SHIFT_PUNCH_REGISTER: {
    code: 'SHIFT_PUNCH_REGISTER_PUNCHES',
    label: 'One row per punch',
    title: 'Shift punch register, one row per punch',
    note: 'Each punch of the shift’s capture window on its own row: the employee, the work date, the punch time, its direction and source, and the shift of that day. With "All days", a day without a punch is one row with no punch time. Terminal: a biometric device; Import: a punch file.',
  },
  SHIFT_PLAN_REGISTER: {
    code: 'SHIFT_PLAN_MONTH_GRID',
    label: 'Month grid',
    title: 'Shift plan register, month grid',
    note: 'One row per employee and month, one column per day of the month with the planned shift code: W a weekly off, H a holiday, "No shift" when none is assigned. A blank day is outside the period or not one of the employee’s days.',
  },
};

interface ReportForm {
  from: string;
  to: string;
  departmentId: string;
  shiftId: string;
  search: string;
  punchView: string;
  punchSource: string;
  deviation: string;
  minimumMinutes: string;
  minimumDays: string;
  sort: string;
  /** DAY (one row per employee and day, the default) or OTHER (the register's other layout, REPORT_LAYOUTS). */
  layout: string;
  format: 'CSV' | 'XLSX';
}
const blankReport: ReportForm = { from: '', to: '', departmentId: '', shiftId: '', search: '', punchView: 'ALL', punchSource: '', deviation: '', minimumMinutes: '', minimumDays: '', sort: 'employeeCode', layout: 'DAY', format: 'CSV' };

/** The filters sent for a report: only what it takes, only what is filled in. */
export function attendanceReportFilters(code: AttendanceReportCode, f: ReportForm): Record<string, string | number> {
  const out: Record<string, string | number> = { from: f.from, to: f.to };
  if (f.departmentId) out.departmentId = f.departmentId;
  if (f.search.trim()) out.search = f.search.trim();
  if (f.shiftId && code !== 'ABSCONDING_REPORT') out.shiftId = f.shiftId;
  if (code === 'SHIFT_PUNCH_REGISTER') {
    if (f.punchView !== 'ALL') out.punchView = f.punchView;
    if (f.punchSource) out.punchSource = f.punchSource;
  }
  if (code === 'SHIFT_DEVIATION_REGISTER' && f.deviation) Object.assign(out, { minuteField: f.deviation, minuteOp: 'GTE', minuteValue: f.minimumMinutes === '' ? 1 : Number(f.minimumMinutes) });
  if (code === 'ABSCONDING_REPORT') {
    if (f.minimumDays !== '') out.minimumDays = Number(f.minimumDays);
    if (f.sort !== 'employeeCode') out.sort = f.sort;
  }
  return out;
}

function AttendanceReportsPage() {
  const { can } = useSession();
  const [code, setCode] = useState<AttendanceReportCode>('SHIFT_PUNCH_REGISTER');
  const [form, setForm] = useState(blankReport);
  const set = (key: keyof Omit<ReportForm, 'format'>, value: string) => setForm({ ...form, [key]: value });
  const def = ATTENDANCE_REPORTS.find((r) => r.code === code)!;
  // The register's other layout is a report of its own, with the same filters (CL-047, CL-049 follow-up).
  const other = REPORT_LAYOUTS[code];
  const generated = other && form.layout === 'OTHER' ? other : def;
  const departments = useQuery({ queryKey: ['control-departments'], queryFn: () => api<{ items: { id: string; code: string }[] }>('/v1/org/departments'), enabled: can('org_master.read.operational') });
  const shifts = useQuery({ queryKey: ['control-shifts'], queryFn: () => api<{ items: { id: string; code: string }[] }>('/v1/shifts'), enabled: can('shift.read.operational') });
  const ready = !!form.from && !!form.to && (code !== 'ABSCONDING_REPORT' || /^\d{1,3}$/.test(form.minimumDays));
  return (
    <Section title="Attendance reports">
      <form className="grid-form" onSubmit={keepOnPage}>
        <label>
          Report
          <select
            value={code}
            onChange={(e) => {
              setCode(e.target.value as AttendanceReportCode);
              setForm({ ...form, layout: 'DAY' });
            }}
          >
            {ATTENDANCE_REPORTS.map((r) => (
              <option key={r.code} value={r.code}>
                {r.title}
              </option>
            ))}
          </select>
        </label>
        {other && (
          <label>
            Layout
            <select value={form.layout} onChange={(e) => set('layout', e.target.value)}>
              <option value="DAY">One row per employee and day</option>
              <option value="OTHER">{other.label}</option>
            </select>
          </label>
        )}
        <label>
          From
          <input type="date" required value={form.from} onChange={(e) => set('from', e.target.value)} />
        </label>
        <label>
          To
          <input type="date" required value={form.to} onChange={(e) => set('to', e.target.value)} />
        </label>
        <label>
          Employee or code
          <input maxLength={100} value={form.search} onChange={(e) => set('search', e.target.value)} />
        </label>
        {departments.data && (
          <label>
            Department
            <select value={form.departmentId} onChange={(e) => set('departmentId', e.target.value)}>
              <option value="">All</option>
              {departments.data.items.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code}
                </option>
              ))}
            </select>
          </label>
        )}
        {shifts.data && code !== 'ABSCONDING_REPORT' && (
          <label>
            Shift
            <select value={form.shiftId} onChange={(e) => set('shiftId', e.target.value)}>
              <option value="">All</option>
              {shifts.data.items.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code}
                </option>
              ))}
            </select>
          </label>
        )}
        {code === 'SHIFT_PUNCH_REGISTER' && (
          <>
            <label>
              Show
              <select value={form.punchView} onChange={(e) => set('punchView', e.target.value)}>
                <option value="ALL">All days</option>
                <option value="PUNCHED">Punched</option>
                <option value="NOT_PUNCHED">Not punched</option>
                <option value="FIRST_LAST">Only first and last punch</option>
              </select>
            </label>
            <label>
              Punch source
              <select value={form.punchSource} onChange={(e) => set('punchSource', e.target.value)}>
                <option value="">Any</option>
                <option value="TERMINAL">Terminal</option>
                <option value="IMPORT">Import</option>
              </select>
            </label>
          </>
        )}
        {code === 'SHIFT_DEVIATION_REGISTER' && (
          <>
            <label>
              Deviation
              <select value={form.deviation} onChange={(e) => set('deviation', e.target.value)}>
                <option value="">Any</option>
                <option value="LATE">Late in</option>
                <option value="EARLY_DEPARTURE">Early out</option>
                <option value="OVERTIME_CANDIDATE">Overtime only</option>
              </select>
            </label>
            <label>
              At least (minutes)
              <input inputMode="numeric" pattern="\d{1,5}" disabled={!form.deviation} value={form.minimumMinutes} onChange={(e) => set('minimumMinutes', e.target.value)} />
            </label>
          </>
        )}
        {code === 'ABSCONDING_REPORT' && (
          <>
            <label>
              Consecutive absent days, at least
              <input required inputMode="numeric" pattern="\d{1,3}" value={form.minimumDays} onChange={(e) => set('minimumDays', e.target.value)} />
            </label>
            <label>
              Sort by
              <select value={form.sort} onChange={(e) => set('sort', e.target.value)}>
                <option value="employeeCode">Employee code</option>
                <option value="fromDate">First absent day</option>
              </select>
            </label>
          </>
        )}
        <label>
          Format
          <select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value === 'XLSX' ? 'XLSX' : 'CSV' })}>
            <option value="CSV">CSV</option>
            <option value="XLSX">XLSX</option>
          </select>
        </label>
      </form>
      <p className="hint">{`${generated.note} At most ${def.maxDays} days per request.`}</p>
      {!ready && <p className="hint">{code === 'ABSCONDING_REPORT' ? 'Choose a period and the number of consecutive absent days.' : 'Choose a period.'}</p>}
      {ready && <ReportExport key={generated.code} reportCode={generated.code} label={`Generate the ${generated.title.toLowerCase()}`} filters={attendanceReportFilters(code, form)} format={form.format} />}
    </Section>
  );
}

export const ATTENDANCE_CONTROL_SCREENS: readonly ScreenRoute[] = [
  { path: '/attendance/control', title: 'Attendance control', permission: 'attendance.amend.operational', nav: true, component: AttendanceControlPage },
  // CL-053: shown to the roles that review attendance (HR and managers); the server answers anyone with the attendance read duty, over their scope.
  { path: '/attendance/dashboard', title: 'Attendance dashboard', permission: 'attendance.approve_correction.operational', nav: true, component: AttendanceDashboardPage },
  // CL-047, CL-049 to CL-051: under the attendance export duty, as every attendance report.
  { path: '/attendance/reports', title: 'Attendance reports', permission: 'attendance.export.operational', nav: true, component: AttendanceReportsPage },
];
