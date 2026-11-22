// Attendance reports (BRD coverage CL-047 shift punch register, CL-049 shift plan register, CL-050 shift deviation register,
// CL-051 absconding report): the filters each report takes, generated in the background as CSV or XLSX with the filter
// context (FR-056, DF09). The server applies the row scope and checks every filter again.

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FilterBar, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '../../api';
import { useSession } from '../../session';
import { Section } from '../../ui';
import { keepOnPage, ReportExport } from '../leave-admin';
import { MasterFilter, type MasterOption } from './shared';

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

type SetField = (key: keyof Omit<ReportForm, 'format'>, value: string) => void;

/** The shift punch register's own filters: which days it lists and where the punches came from. */
function PunchRegisterFilters({ form, set }: { form: ReportForm; set: SetField }) {
  return (
    <>
      <FormField>
        Show
        <NativeSelect value={form.punchView} onChange={(e) => set('punchView', e.target.value)}>
          <option value="ALL">All days</option>
          <option value="PUNCHED">Punched</option>
          <option value="NOT_PUNCHED">Not punched</option>
          <option value="FIRST_LAST">Only first and last punch</option>
        </NativeSelect>
      </FormField>
      <FormField>
        Punch source
        <NativeSelect value={form.punchSource} onChange={(e) => set('punchSource', e.target.value)}>
          <option value="">Any</option>
          <option value="TERMINAL">Terminal</option>
          <option value="IMPORT">Import</option>
        </NativeSelect>
      </FormField>
    </>
  );
}

/** The shift deviation register's own filters: which deviation, and from how many minutes. */
function DeviationFilters({ form, set }: { form: ReportForm; set: SetField }) {
  return (
    <>
      <FormField>
        Deviation
        <NativeSelect value={form.deviation} onChange={(e) => set('deviation', e.target.value)}>
          <option value="">Any</option>
          <option value="LATE">Late in</option>
          <option value="EARLY_DEPARTURE">Early out</option>
          <option value="OVERTIME_CANDIDATE">Overtime only</option>
        </NativeSelect>
      </FormField>
      <FormField>
        At least (minutes)
        <Input inputMode="numeric" pattern="\d{1,5}" disabled={!form.deviation} value={form.minimumMinutes} onChange={(e) => set('minimumMinutes', e.target.value)} />
      </FormField>
    </>
  );
}

/** The absconding report's own filters: the shortest run of absent days it lists, and its order. */
function AbscondingFilters({ form, set }: { form: ReportForm; set: SetField }) {
  return (
    <>
      <FormField>
        Consecutive absent days, at least
        <Input required inputMode="numeric" pattern="\d{1,3}" value={form.minimumDays} onChange={(e) => set('minimumDays', e.target.value)} />
      </FormField>
      <FormField>
        Sort by
        <NativeSelect value={form.sort} onChange={(e) => set('sort', e.target.value)}>
          <option value="employeeCode">Employee code</option>
          <option value="fromDate">First absent day</option>
        </NativeSelect>
      </FormField>
    </>
  );
}

export function AttendanceReportsPage() {
  const { can } = useSession();
  const [code, setCode] = useState<AttendanceReportCode>('SHIFT_PUNCH_REGISTER');
  const [form, setForm] = useState(blankReport);
  const set: SetField = (key, value) => setForm({ ...form, [key]: value });
  const def = ATTENDANCE_REPORTS.find((r) => r.code === code)!;
  // The register's other layout is a report of its own, with the same filters (CL-047, CL-049 follow-up).
  const other = REPORT_LAYOUTS[code];
  const generated = other && form.layout === 'OTHER' ? other : def;
  const departments = useQuery({ queryKey: ['control-departments'], queryFn: () => api<{ items: MasterOption[] }>('/v1/org/departments'), enabled: can('org_master.read.operational') });
  const shifts = useQuery({ queryKey: ['control-shifts'], queryFn: () => api<{ items: MasterOption[] }>('/v1/shifts'), enabled: can('shift.read.operational') });
  const ready = !!form.from && !!form.to && (code !== 'ABSCONDING_REPORT' || /^\d{1,3}$/.test(form.minimumDays));
  return (
    <Section title="Attendance reports">
      <FilterBar asChild>
        <form onSubmit={keepOnPage}>
          <FormField>
            Report
            <NativeSelect
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
            </NativeSelect>
          </FormField>
          {other && (
            <FormField>
              Layout
              <NativeSelect value={form.layout} onChange={(e) => set('layout', e.target.value)}>
                <option value="DAY">One row per employee and day</option>
                <option value="OTHER">{other.label}</option>
              </NativeSelect>
            </FormField>
          )}
          <FormField>
            From
            <Input type="date" required value={form.from} onChange={(e) => set('from', e.target.value)} />
          </FormField>
          <FormField>
            To
            <Input type="date" required value={form.to} onChange={(e) => set('to', e.target.value)} />
          </FormField>
          <FormField>
            Employee or code
            <Input maxLength={100} value={form.search} onChange={(e) => set('search', e.target.value)} />
          </FormField>
          {departments.data && <MasterFilter label="Department" value={form.departmentId} items={departments.data.items} onChange={(v) => set('departmentId', v)} />}
          {shifts.data && code !== 'ABSCONDING_REPORT' && <MasterFilter label="Shift" value={form.shiftId} items={shifts.data.items} onChange={(v) => set('shiftId', v)} />}
          {code === 'SHIFT_PUNCH_REGISTER' && <PunchRegisterFilters form={form} set={set} />}
          {code === 'SHIFT_DEVIATION_REGISTER' && <DeviationFilters form={form} set={set} />}
          {code === 'ABSCONDING_REPORT' && <AbscondingFilters form={form} set={set} />}
          <FormField>
            Format
            <NativeSelect value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value === 'XLSX' ? 'XLSX' : 'CSV' })}>
              <option value="CSV">CSV</option>
              <option value="XLSX">XLSX</option>
            </NativeSelect>
          </FormField>
        </form>
      </FilterBar>
      <Hint>{`${generated.note} At most ${def.maxDays} days per request.`}</Hint>
      {!ready && <Hint>{code === 'ABSCONDING_REPORT' ? 'Choose a period and the number of consecutive absent days.' : 'Choose a period (From and To) to generate the report.'}</Hint>}
      {/* Always in view, so there is something to press; offered once the period (and run length) are filled in. */}
      <ReportExport key={generated.code} reportCode={generated.code} label={`Generate the ${generated.title.toLowerCase()}`} filters={attendanceReportFilters(code, form)} format={form.format} disabled={!ready} />
    </Section>
  );
}
