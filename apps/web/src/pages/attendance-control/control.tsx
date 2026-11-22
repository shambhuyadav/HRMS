// Attendance control (FR-021; E07): attendance across the role's scope, filtered by department, location, status, shift,
// date, employee and minutes, in pages with the total and a matching export. One day opens with its untouched source
// punches beside the derived result, the policy revision and why the status changed (amendments and earlier values).
// An amendment of a day needs the fact behind it on the server, and a day a processed payroll used is final. E07, decided
// under owner delegation, 6 Nov 2026 (I-78 item 6): the organisation and the working organisation are the company the role
// acts for, so they are shown, not chosen; the entity is what the minute comparison measures (worked, scheduled, shortfall,
// late or overtime-candidate minutes). The server re-checks everything.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { FilterBar, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, LIST_PAGE_SIZE, Pager, pageParams, Section, WarningNote } from '../../ui';
import { keepOnPage, ReportExport } from '../leave-admin';
import { MasterFilter, type MasterOption, STATUSES, statusText } from './shared';

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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Time</TableHead>
                  <TableHead scope="col">Direction</TableHead>
                  <TableHead scope="col">Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {day.data.punches.map((p) => (
                  <TableRow key={`${p.occurredAt}:${p.direction}:${p.sourceKind}`}>
                    <TableCell>{formatInstant(p.occurredAt)}</TableCell>
                    <TableCell>{p.direction === 'IN' ? 'In' : 'Out'}</TableCell>
                    <TableCell>{p.sourceKind === 'BIOMETRIC_API' ? 'Biometric device' : 'Manual import'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
        <WarningNote badge="payroll locked">A processed payroll used this day, so its attendance can no longer change here.</WarningNote>
      ) : (
        can('attendance.amend.operational') && (
          <FormGrid
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              amend.mutate();
            }}
          >
            <FormField>
              Amend to
              <NativeSelect value={status} onChange={(e) => setStatus(e.target.value)}>
                {AMENDABLE.map((s) => (
                  <option key={s} value={s}>
                    {statusText(s)}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField className="col-span-full">
              Reason for the amendment
              <Input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </FormField>
            <Button type="submit" disabled={amend.isPending}>
              Amend
            </Button>
            <Hint>{NEEDS_FACT} The source punches stay as they are.</Hint>
            <ErrorNote error={amend.error} />
          </FormGrid>
        )
      )}
    </Section>
  );
}

/** A day's status with its flags: late, early departure, overtime candidate, amended, payroll locked, and any exception code. */
function StatusCell({ row: r }: { row: ControlRow }) {
  return (
    <TableCell>
      {statusText(r.status)} {r.late && <Badge tone="warn">{r.lateMinutes ? `late ${r.lateMinutes} min` : 'late'}</Badge>}{' '}
      {r.earlyDeparture && <Badge tone="warn">{r.earlyDepartureMinutes ? `left ${r.earlyDepartureMinutes} min early` : 'left early'}</Badge>}{' '}
      {!!r.overtimeCandidateMinutes && <Badge>{`overtime candidate ${r.overtimeCandidateMinutes} min`}</Badge>} {r.amended && <Badge>amended</Badge>} {r.payrollLocked && <Badge tone="warn">payroll locked</Badge>}
      {r.exceptionCode && <Hint as="span"> {r.exceptionCode}</Hint>}
    </TableCell>
  );
}

export function AttendanceControlPage() {
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
  const departments = useQuery({ queryKey: ['control-departments'], queryFn: () => api<{ items: MasterOption[] }>('/v1/org/departments'), enabled: can('org_master.read.operational') });
  const locations = useQuery({ queryKey: ['control-locations'], queryFn: () => api<{ items: MasterOption[] }>('/v1/org/locations'), enabled: can('org_master.read.operational') });
  const shifts = useQuery({ queryKey: ['control-shifts'], queryFn: () => api<{ items: MasterOption[] }>('/v1/shifts'), enabled: can('shift.read.operational') });
  const opened = list.data?.items.find((r) => r.id === openId);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['attendance-control'] });
  return (
    <>
      <Section title="Attendance control">
        <FilterBar asChild>
          <form onSubmit={keepOnPage}>
            <FormField>
              From
              <Input type="date" required value={filters.from} onChange={(e) => set('from', e.target.value)} />
            </FormField>
            <FormField>
              To
              <Input type="date" required value={filters.to} onChange={(e) => set('to', e.target.value)} />
            </FormField>
            <FormField>
              Employee or code
              <Input maxLength={100} value={filters.search} onChange={(e) => set('search', e.target.value)} />
            </FormField>
            <FormField>
              Status
              <NativeSelect value={filters.status} onChange={(e) => set('status', e.target.value)}>
                <option value="">All</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusText(s)}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            {departments.data && <MasterFilter label="Department" value={filters.departmentId} items={departments.data.items} onChange={(v) => set('departmentId', v)} />}
            {locations.data && <MasterFilter label="Location" value={filters.locationId} items={locations.data.items} onChange={(v) => set('locationId', v)} />}
            {shifts.data && <MasterFilter label="Shift" value={filters.shiftId} items={shifts.data.items} onChange={(v) => set('shiftId', v)} />}
            <FormField>
              Entity (minutes of)
              <NativeSelect value={filters.minuteField} onChange={(e) => set('minuteField', e.target.value)}>
                <option value="">Any</option>
                <option value="WORKED">Worked</option>
                <option value="SCHEDULED">Scheduled</option>
                <option value="SHORTFALL">Short of scheduled</option>
                <option value="LATE">Late</option>
                <option value="EARLY_DEPARTURE">Early departure</option>
                <option value="OVERTIME_CANDIDATE">Overtime candidate</option>
              </NativeSelect>
            </FormField>
            <FormField>
              Compared
              <NativeSelect value={filters.minuteOp} onChange={(e) => set('minuteOp', e.target.value)}>
                <option value="">—</option>
                <option value="LT">less than</option>
                <option value="LTE">at most</option>
                <option value="EQ">exactly</option>
                <option value="GTE">at least</option>
                <option value="GT">more than</option>
              </NativeSelect>
            </FormField>
            <FormField>
              Number of minutes
              <Input inputMode="numeric" pattern="\d{1,6}" value={filters.minuteValue} onChange={(e) => set('minuteValue', e.target.value)} />
            </FormField>
          </form>
        </FilterBar>
        <Hint>
          Organisation and working organisation: the company you are acting for. Late minutes count from the shift start on a late day, early-departure minutes up to the shift end; overtime candidates are proposals for a manager’s decision, never pay.
        </Hint>
        {!ready && <Hint>Choose a period to list attendance.</Hint>}
        <ErrorNote error={list.error} />
        {list.isSuccess && list.data.total === 0 && <Empty>No attendance matches these filters.</Empty>}
        {list.isSuccess && list.data.items.length > 0 && (
          <>
            <StatusNote tone="info" role="status">{`${list.data.total} ${list.data.total === 1 ? 'day' : 'days'}`}</StatusNote>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Date</TableHead>
                  <TableHead scope="col">Employee</TableHead>
                  <TableHead scope="col">Department</TableHead>
                  <TableHead scope="col">Location</TableHead>
                  <TableHead scope="col">Shift</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Minutes</TableHead>
                  <TableHead scope="col">Policy</TableHead>
                  <TableHead scope="col">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.items.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{formatDate(r.workDate)}</TableCell>
                    <TableCell>{`${r.employeeName} (${r.employeeCode})`}</TableCell>
                    <TableCell>{r.departmentCode ?? '—'}</TableCell>
                    <TableCell>{r.locationCode ?? '—'}</TableCell>
                    <TableCell>{r.shiftCode ?? '—'}</TableCell>
                    <StatusCell row={r} />
                    <TableCell>{`${r.workedMinutes} of ${r.scheduledNetMinutes}`}</TableCell>
                    <TableCell>{`${r.policyCode} revision ${r.policyRevision}`}</TableCell>
                    <RowActionsCell>
                      <RowActions>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label={`Open ${r.employeeCode}`}
                          aria-expanded={openId === r.id}
                          onClick={() => setOpenId(openId === r.id ? null : r.id)}
                        >
                          Open
                        </Button>
                      </RowActions>
                    </RowActionsCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pager page={list.data.page} pageSize={LIST_PAGE_SIZE} total={list.data.total} onPage={setPage} label="Attendance pages" noun="day" />
          </>
        )}
        {ready && can('attendance.export.operational') && <ReportExport reportCode="ATTENDANCE_REGISTER" label="Export this list" filters={active} />}
      </Section>
      {opened && <DayPanel key={opened.id} row={opened} onChanged={refresh} />}
    </>
  );
}
