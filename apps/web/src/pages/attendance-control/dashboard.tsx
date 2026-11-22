// Attendance dashboard (BRD coverage CL-053): a date (today unless chosen) and any departments, with the counts per department
// and in total; every count opens the employees behind it, read by the server with the same rule, so a list's total is the
// count clicked. A processed day is read from its results; a day not processed yet shows what is known (punched, not punched,
// on approved leave, off days), and the page says which it is.

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FilterBar, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, LIST_PAGE_SIZE, Pager, pageParams, Section } from '../../ui';
import { keepOnPage } from '../leave-admin';
import { type MasterOption, optionName, statusText } from './shared';

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

/** The count table has a column per category, so its headings wrap rather than run past the card (the old `table.wrap-head`). */
const WRAPPING_HEAD = 'whitespace-normal align-bottom';

function processingNote(p: DashboardView['processing']): string {
  if (p.employees === 0) return 'Nobody in your scope is employed on this date.';
  if (p.state === 'PROCESSED') return `Processed for all ${p.employees} ${p.employees === 1 ? 'employee' : 'employees'}: the counts are the processed results.`;
  if (p.state === 'PARTLY_PROCESSED')
    return `Processed for ${p.processed} of ${p.employees} employees. The others are not processed yet, so they show what is known: punched, not punched, on approved leave or an off day.`;
  return 'This date has not been processed yet, so the counts show what is known: punched, not punched, on approved leave or an off day. Absence and lateness are known once it is processed.';
}

const departmentsQuery = (ids: string[]) => ids.map((id) => `departmentId=${encodeURIComponent(id)}`).join('&');
/** A department row by its name ("Engineering"), not its code. */
const departmentLabel = (d: Pick<DashboardCounts, 'departmentCode' | 'departmentName'>) => d.departmentName ?? d.departmentCode ?? 'no department';

/** The department row a count was opened from, as the list's query: none for the total, the row without a department by itself. */
function departmentRowQuery(department: DashboardCounts | null): string {
  if (!department) return '';
  return department.departmentId ? `&inDepartment=${department.departmentId}` : '&withoutDepartment=true';
}

/** An employee's punches of the day: how many, the first and, with more than one, the last. */
function punchesText(row: Pick<DashboardRow, 'punchCount' | 'firstPunch' | 'lastPunch'>): string {
  if (row.punchCount === 0) return 'None';
  const last = row.punchCount > 1 ? ` – ${row.lastPunch ?? ''}` : '';
  return `${row.punchCount}: ${row.firstPunch ?? ''}${last}`;
}

function DashboardList({ date, departments, opened }: { date: string; departments: string[]; opened: OpenedCount }) {
  const [page, setPage] = useState(1);
  const where = departmentRowQuery(opened.department);
  const choice = departmentsQuery(departments);
  const list = useQuery({
    queryKey: ['attendance-dashboard-list', date, choice, opened.list, opened.department?.departmentId ?? null, page],
    queryFn: () =>
      api<{ items: DashboardRow[]; total: number; page: number }>(`/v1/attendance/dashboard/employees?date=${date}&list=${opened.list}${choice ? `&${choice}` : ''}${where}&${pageParams(page)}`),
  });
  const scope = opened.department ? ` in ${departmentLabel(opened.department)}` : '';
  return (
    <Section title={`${dashboardText(opened.list)}${scope} on ${formatDate(date)}`}>
      <ErrorNote error={list.error} />
      {list.isSuccess && list.data.total === 0 && <Empty>Nobody is in this count.</Empty>}
      {list.isSuccess && list.data.items.length > 0 && (
        <>
          <StatusNote tone="info" role="status">{`${list.data.total} ${list.data.total === 1 ? 'employee' : 'employees'}`}</StatusNote>
          <Table aria-label="Employees in this count">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Code</TableHead>
                <TableHead scope="col">Employee</TableHead>
                <TableHead scope="col">Department</TableHead>
                <TableHead scope="col">Shift</TableHead>
                <TableHead scope="col">Day</TableHead>
                <TableHead scope="col">Punches</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.items.map((r) => (
                <TableRow key={r.employeeId}>
                  <TableCell>{r.employeeCode}</TableCell>
                  <TableCell>{r.employeeName}</TableCell>
                  <TableCell>{r.departmentCode ?? '—'}</TableCell>
                  <TableCell>{r.shiftCode ?? 'No shift'}</TableCell>
                  <TableCell>
                    {r.processed && r.processedStatus ? statusText(r.processedStatus) : dashboardText(r.category)} {!r.processed && <Badge>not processed</Badge>}{' '}
                    {r.late && <Badge tone="warn">{r.lateMinutes ? `late ${r.lateMinutes} min` : 'late'}</Badge>} {r.punchSourceUnavailable && <Badge tone="warn">punch source failed</Badge>}
                  </TableCell>
                  <TableCell>{punchesText(r)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager page={list.data.page} pageSize={LIST_PAGE_SIZE} total={list.data.total} onPage={setPage} label="Employees in this count pages" noun="employee" />
        </>
      )}
    </Section>
  );
}

export function AttendanceDashboardPage() {
  const { can } = useSession();
  const [date, setDate] = useState('');
  const [departments, setDepartments] = useState<string[]>([]);
  const [opened, setOpened] = useState<OpenedCount | null>(null);
  const choice = departmentsQuery(departments);
  const query = [date ? `date=${date}` : '', choice].filter(Boolean).join('&');
  const dashboard = useQuery({ queryKey: ['attendance-dashboard', query], queryFn: () => api<DashboardView>(`/v1/attendance/dashboard${query ? `?${query}` : ''}`) });
  const options = useQuery({ queryKey: ['control-departments'], queryFn: () => api<{ items: MasterOption[] }>('/v1/org/departments'), enabled: can('org_master.read.operational') });
  const view = dashboard.data;
  const columns = view ? [...view.categories, 'LATE'] : [];
  const cell = (row: DashboardCounts, column: string, isTotal: boolean) => {
    const n = row.counts[column] ?? 0;
    if (n === 0) return '0';
    // The number is what shows; what it counts is read out with it, the column heading and row already say it on screen.
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpened({ list: column, department: isTotal ? null : row })}>
        {String(n)}
        <span className="sr-only">{` ${dashboardText(column)}${isTotal ? '' : ` in ${departmentLabel(row)}`}`}</span>
      </Button>
    );
  };
  return (
    <>
      <Section title="Attendance dashboard">
        <FilterBar asChild>
          <form onSubmit={keepOnPage}>
            <FormField>
              Date
              <Input
                type="date"
                value={date || view?.date || ''}
                onChange={(e) => {
                  setDate(e.target.value);
                  setOpened(null);
                }}
              />
            </FormField>
            {options.data && (
              <FormField>
                Departments
                <NativeSelect
                  multiple
                  // Every department, up to 8 rows, so none is hidden behind the list box's scrollbar.
                  rows={Math.min(Math.max(options.data.items.length, 2), 8)}
                  value={departments}
                  onChange={(e) => {
                    setDepartments(Array.from(e.target.selectedOptions, (o) => o.value));
                    setOpened(null);
                  }}
                >
                  {options.data.items.map((d) => (
                    <option key={d.id} value={d.id}>
                      {optionName(d)}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
            )}
          </form>
        </FilterBar>
        <Hint>Today unless you choose a date; every department of your scope unless you choose some. Each count opens the employees behind it.</Hint>
        <ErrorNote error={dashboard.error ?? options.error} />
        {view && (
          <>
            <Hint role="status">
              {`${formatDate(view.date)}: `}
              {view.processing.state !== 'PROCESSED' && <Badge tone="warn">{view.processing.state === 'NOT_PROCESSED' ? 'not processed' : 'partly processed'}</Badge>} {processingNote(view.processing)}
            </Hint>
            {view.total.total > 0 && (
              <Table aria-label="Attendance by department">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col" className={WRAPPING_HEAD}>
                      Department
                    </TableHead>
                    <TableHead scope="col" className={WRAPPING_HEAD}>
                      Employees
                    </TableHead>
                    {columns.map((c) => (
                      <TableHead key={c} scope="col" className={WRAPPING_HEAD}>
                        {dashboardText(c)}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.departments.map((d) => (
                    <TableRow key={d.departmentId ?? 'none'}>
                      <TableCell>{d.departmentName ?? d.departmentCode ?? 'No department'}</TableCell>
                      <TableCell>{d.total}</TableCell>
                      {columns.map((c) => (
                        <TableCell key={c}>{cell(d, c, false)}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell>
                      <strong>Total</strong>
                    </TableCell>
                    <TableCell>{view.total.total}</TableCell>
                    {columns.map((c) => (
                      <TableCell key={c}>{cell(view.total, c, true)}</TableCell>
                    ))}
                  </TableRow>
                </TableBody>
              </Table>
            )}
            <Hint>Each employee is counted once; late is counted beside present, from processed results only.</Hint>
          </>
        )}
      </Section>
      {view && opened && <DashboardList key={`${opened.list}:${opened.department?.departmentId ?? 'all'}`} date={view.date} departments={departments} opened={opened} />}
    </>
  );
}
