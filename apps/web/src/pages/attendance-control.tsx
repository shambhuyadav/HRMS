// Attendance control (FR-021; E07): attendance across the role's scope, filtered by department, location, status, shift,
// date, employee and minutes, in pages with the total and a matching export. One day opens with its untouched source
// punches beside the derived result, the policy revision and why the status changed (amendments and earlier values).
// An amendment of a day needs the fact behind it on the server, and a day a processed payroll used is final. The working
// organisation and entity filters have no master yet and wait for the owner's definition. The server re-checks everything.
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
  earlyDeparture: boolean;
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
            Minutes
            <select value={filters.minuteField} onChange={(e) => set('minuteField', e.target.value)}>
              <option value="">Any</option>
              <option value="WORKED">Worked</option>
              <option value="SCHEDULED">Scheduled</option>
              <option value="SHORTFALL">Short of scheduled</option>
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
                      {statusText(r.status)} {r.late && <Badge tone="warn">late</Badge>} {r.earlyDeparture && <Badge tone="warn">left early</Badge>} {r.amended && <Badge>amended</Badge>} {r.payrollLocked && <Badge tone="warn">payroll locked</Badge>}
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

export const ATTENDANCE_CONTROL_SCREENS: readonly ScreenRoute[] = [{ path: '/attendance/control', title: 'Attendance control', permission: 'attendance.amend.operational', nav: true, component: AttendanceControlPage }];
