// Reporting screens (I-83, decided under owner delegation, 6 Nov 2026).
//   /salary/progression         FR-038 salary progression chart: one employee, by Indian financial year, monthly gross or annual
//                               CTC. Confidential: the server answers only an assignment holding salary read and salary history
//                               with the employee in its scope; this screen shows the server's refusal in words. Amounts are shown
//                               exactly as the server sends them; the chart only places them.
//   /admin/reporting-settings   the dated reporting settings HR changes: the BR-045 small-count threshold, the DF17 recent
//                               activity window and the chart's default span. A change is a new revision from today or later.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, api, formatAmount, formatDate, localDate } from '../api';
import type { ScreenRoute } from '../screens';
import { Empty, ErrorNote, Section } from '../ui';

const HISTORY_GRANT = 'salary.history_read.salary';
const SETTINGS_GRANT = 'reporting_setting.manage.operational';

type Basis = 'MONTHLY_GROSS' | 'ANNUAL_CTC';
const BASIS_LABEL: Record<Basis, string> = { MONTHLY_GROSS: 'Monthly gross fixed pay', ANNUAL_CTC: 'Annual CTC' };
const NA_TEXT: Record<string, string> = {
  NO_SALARY: 'No salary in force',
  NO_PREVIOUS_SALARY: 'No salary the year before',
  CURRENCY_CHANGED: 'Paid in another currency the year before',
  ZERO_BASELINE: 'Previous value was zero',
};

export interface ProgressionYear {
  financialYear: number;
  label: string;
  periodStart: string;
  valueDate: string;
  amount: string | null;
  currency: string | null;
  changePercent: string | null;
  percentNaReason: string | null;
}

export interface Progression {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  basis: Basis;
  span: { years: number; firstFinancialYear: number; lastFinancialYear: number; from: string; to: string };
  years: ProgressionYear[];
  steps: { effectiveFrom: string; effectiveTo: string | null; amount: string; currency: string }[];
}

interface EmployeeRow {
  id: string;
  employeeCode: string;
  displayName: string;
}

// Chart geometry (SVG user units; the SVG scales to its container).
const W = 640;
const H = 260;
const PAD = { top: 16, right: 16, bottom: 36, left: 88 };
const day = (d: string) => Date.parse(`${d}T00:00:00Z`);

/**
 * One currency's step line: each stored arrangement holds its value until the next one starts, so the line steps at effective
 * dates; a marker on each financial year's value date carries the year's figure. One series, one axis, no legend (the heading
 * names it). Hover or focus a marker for its figure; the table below holds every value.
 */
export function ProgressionChart({ data, currency }: { data: Progression; currency: string }) {
  const [hover, setHover] = useState<ProgressionYear | null>(null);
  const steps = data.steps.filter((s) => s.currency === currency);
  const years = data.years.filter((y) => y.currency === currency && y.amount !== null);
  if (steps.length === 0) return null;
  const from = day(data.span.from);
  const to = day(data.span.to);
  const values = steps.map((s) => Number(s.amount));
  const max = Math.max(...values) * 1.1 || 1;
  const x = (t: number) => PAD.left + ((Math.min(Math.max(t, from), to) - from) / Math.max(to - from, 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => H - PAD.bottom - (v / max) * (H - PAD.top - PAD.bottom);
  const points: string[] = [];
  for (const s of steps) {
    const start = x(day(s.effectiveFrom));
    const end = x(s.effectiveTo ? day(s.effectiveTo) : to);
    const level = y(Number(s.amount));
    points.push(`${start},${level}`, `${end},${level}`);
  }
  const ticks = [0, max / 2, max].map((v) => Math.round(v));
  const label = `${BASIS_LABEL[data.basis]} of ${data.employeeName} in ${currency}, ${data.span.from} to ${data.span.to}`;
  return (
    <figure className="progression-chart" style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label} style={{ maxWidth: W, display: 'block', fontFamily: 'inherit' }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={PAD.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--muted)">
              {t.toLocaleString('en-IN')}
            </text>
          </g>
        ))}
        {data.years.map((yr) => (
          <text key={yr.financialYear} x={x(day(yr.valueDate))} y={H - PAD.bottom + 18} textAnchor="middle" fontSize={11} fill="var(--muted)">
            FY {yr.label}
          </text>
        ))}
        <polyline points={points.join(' ')} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
        {years.map((yr) => (
          <g key={yr.financialYear} onMouseEnter={() => setHover(yr)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(yr)} onBlur={() => setHover(null)} tabIndex={0} aria-label={`FY ${yr.label}: ${yr.amount}`}>
            {/* The hit target is larger than the mark. */}
            <circle cx={x(day(yr.valueDate))} cy={y(Number(yr.amount))} r={12} fill="transparent" />
            <circle cx={x(day(yr.valueDate))} cy={y(Number(yr.amount))} r={4.5} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
          </g>
        ))}
        {hover && (
          <g pointerEvents="none">
            <rect x={Math.min(x(day(hover.valueDate)) + 8, W - 190)} y={PAD.top} width={180} height={44} rx={6} fill="var(--surface)" stroke="var(--line)" />
            <text x={Math.min(x(day(hover.valueDate)) + 16, W - 182)} y={PAD.top + 18} fontSize={12} fill="var(--text)">
              FY {hover.label} · {formatAmount(hover.amount, currency)}
            </text>
            <text x={Math.min(x(day(hover.valueDate)) + 16, W - 182)} y={PAD.top + 34} fontSize={11} fill="var(--muted)">
              {hover.changePercent !== null ? `Change ${hover.changePercent}%` : (NA_TEXT[hover.percentNaReason ?? ''] ?? '')}
            </text>
          </g>
        )}
      </svg>
      <figcaption className="hint">{label}. Each step is an approved salary arrangement as stored.</figcaption>
    </figure>
  );
}

/** The chart's table view: every financial year's value, its change and why a change is not shown. */
export function ProgressionTable({ data }: { data: Progression }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Financial year</th>
          <th>Value on</th>
          <th>{BASIS_LABEL[data.basis]}</th>
          <th>Change on the year before</th>
        </tr>
      </thead>
      <tbody>
        {data.years.map((y) => (
          <tr key={y.financialYear}>
            <td>FY {y.label}</td>
            <td>{formatDate(y.valueDate)}</td>
            <td>{y.amount === null ? '—' : formatAmount(y.amount, y.currency ?? undefined)}</td>
            <td>{y.changePercent !== null ? `${y.changePercent}%` : (NA_TEXT[y.percentNaReason ?? ''] ?? '—')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function refusal(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 403) return 'The selected role cannot see salary progression: that needs the salary read and salary history grants in this one assignment.';
  if (error.status === 404) return 'This employee is not in the selected role’s scope.';
  return null;
}

function EmployeePicker({ onPick }: { onPick: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const found = useQuery({
    queryKey: ['progression-employees', query],
    queryFn: () => api<{ items: EmployeeRow[] }>(`/v1/employees?${new URLSearchParams({ search: query, page: '1', pageSize: '25' })}`),
    enabled: query.length > 0,
  });
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        setQuery(search.trim());
      }}
    >
      <label>
        Employee <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, code or email" />
      </label>{' '}
      <button type="submit" disabled={search.trim().length === 0}>
        Find
      </button>
      {found.data && found.data.items.length === 0 && <Empty>No employee found.</Empty>}
      {!!found.data?.items.length && (
        <ul aria-label="Employees found">
          {found.data.items.map((e) => (
            <li key={e.id}>
              <button type="button" className="link" onClick={() => onPick(e.id)}>
                {e.displayName} ({e.employeeCode})
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={found.error} />
    </form>
  );
}

export function SalaryProgressionScreen() {
  const [params, setParams] = useSearchParams();
  const employeeId = params.get('employeeId');
  const basis = (params.get('basis') === 'ANNUAL_CTC' ? 'ANNUAL_CTC' : 'MONTHLY_GROSS') as Basis;
  const years = params.get('years') ?? '';
  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next);
  };
  const query = new URLSearchParams({ basis, ...(years ? { years } : {}) });
  const chart = useQuery({
    queryKey: ['salary-progression', employeeId, basis, years],
    queryFn: () => api<Progression>(`/v1/employees/${encodeURIComponent(employeeId!)}/salary-progression?${query}`),
    enabled: !!employeeId,
    retry: false,
  });
  const data = chart.data;
  const currencies = data ? [...new Set(data.steps.map((s) => s.currency))] : [];
  const refused = refusal(chart.error);
  return (
    <>
      <h1>Salary progression</h1>
      <p className="hint">
        One employee’s approved salary by financial year (1 April to 31 March): the value in force at each year end, or today for the current year, and its change on the year before
        in the same currency. Confidential: shown only to a role holding the salary read and salary history grants for this employee.
      </p>
      <EmployeePicker onPick={(id) => set({ employeeId: id })} />
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', margin: '0.75rem 0' }}>
        <label>
          Measure{' '}
          <select value={basis} onChange={(e) => set({ basis: e.target.value })}>
            <option value="MONTHLY_GROSS">{BASIS_LABEL.MONTHLY_GROSS}</option>
            <option value="ANNUAL_CTC">{BASIS_LABEL.ANNUAL_CTC}</option>
          </select>
        </label>
        <label>
          Financial years{' '}
          <select value={years} onChange={(e) => set({ years: e.target.value })}>
            <option value="">Company default</option>
            {[1, 2, 3, 5, 7, 10, 15, 20].map((n) => (
              <option key={n} value={String(n)}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!employeeId && <Empty>Find an employee to see their salary progression.</Empty>}
      {refused && <Empty>{refused}</Empty>}
      {!refused && <ErrorNote error={chart.error} />}
      {data && (
        <Section title={`${data.employeeName} (${data.employeeCode}) · ${BASIS_LABEL[data.basis]} · FY ${data.years[0]?.label ?? ''} to FY ${data.years.at(-1)?.label ?? ''}`}>
          {data.steps.length === 0 ? (
            <Empty>No approved salary arrangement in this span.</Empty>
          ) : (
            currencies.map((c) => (
              <div key={c}>
                {currencies.length > 1 && <h3>In {c}</h3>}
                <ProgressionChart data={data} currency={c} />
              </div>
            ))
          )}
          {currencies.length > 1 && <p className="hint">Each currency has its own chart: amounts in different currencies are never drawn or compared on one scale.</p>}
          <ProgressionTable data={data} />
        </Section>
      )}
    </>
  );
}

interface Setting {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  smallCountThreshold: number;
  recentActivityDays: number;
  salaryProgressionYears: number;
  /** I-92: business days from a claim's arrival at its financial step to its final decision's due date. */
  expenseDecisionDueDays: number;
  reason: string;
}

export function ReportingSettingsScreen() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['reporting-settings'], queryFn: () => api<{ businessDate: string; inForce: Setting | null; items: Setting[] }>('/v1/reporting-settings'), retry: false });
  const current = settings.data?.inForce;
  const [form, setForm] = useState<{
    effectiveFrom: string;
    smallCountThreshold: string;
    recentActivityDays: string;
    salaryProgressionYears: string;
    expenseDecisionDueDays: string;
    reason: string;
  } | null>(null);
  const values = form ?? {
    effectiveFrom: settings.data?.businessDate ?? localDate(),
    smallCountThreshold: String(current?.smallCountThreshold ?? ''),
    recentActivityDays: String(current?.recentActivityDays ?? ''),
    salaryProgressionYears: String(current?.salaryProgressionYears ?? ''),
    expenseDecisionDueDays: String(current?.expenseDecisionDueDays ?? ''),
    reason: '',
  };
  const change = (k: keyof typeof values, v: string) => setForm({ ...values, [k]: v });
  const save = useMutation({
    mutationFn: () =>
      api<Setting>('/v1/reporting-settings', {
        body: {
          effectiveFrom: values.effectiveFrom,
          smallCountThreshold: Number(values.smallCountThreshold),
          recentActivityDays: Number(values.recentActivityDays),
          salaryProgressionYears: Number(values.salaryProgressionYears),
          expenseDecisionDueDays: Number(values.expenseDecisionDueDays),
          reason: values.reason,
        },
      }),
    onSuccess: () => {
      setForm(null);
      void qc.invalidateQueries({ queryKey: ['reporting-settings'] });
    },
  });
  if (settings.error instanceof ApiError && settings.error.status === 403) {
    return (
      <>
        <h1>Reporting settings</h1>
        <Empty>The selected role cannot view or change the reporting settings.</Empty>
      </>
    );
  }
  return (
    <>
      <h1>Reporting settings</h1>
      <p className="hint">
        Dated company settings. A dashboard count of people that cannot be opened record by record is shown as “fewer than N” while it is between 1 and N − 1 (1 shows every count). The
        dashboard lists the selected role’s own actions of the last days given here, and the salary progression chart spans this many financial years unless asked otherwise. An
        expense claim’s final decision falls due this many business days (Monday to Friday) after the claim reaches its finance or high-value step; a claim keeps the period in force
        on the day it arrived, and the period changes no approval or escalation. A change starts today or later and keeps every earlier revision.
      </p>
      {current && (
        <Section title="In force today">
          <ul>
            <li>Small-count threshold: {current.smallCountThreshold}</li>
            <li>Recent activity: {current.recentActivityDays} days</li>
            <li>Salary progression span: {current.salaryProgressionYears} financial years</li>
            <li>Expense final decision due: {current.expenseDecisionDueDays} business days after arrival</li>
            <li>
              From {current.effectiveFrom}
              {current.effectiveTo ? ` until ${current.effectiveTo}` : ''}
            </li>
          </ul>
        </Section>
      )}
      <Section title="Start a new revision">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <label>
            From <input type="date" value={values.effectiveFrom} onChange={(e) => change('effectiveFrom', e.target.value)} required />
          </label>{' '}
          <label>
            Small-count threshold <input type="number" min={1} max={100} value={values.smallCountThreshold} onChange={(e) => change('smallCountThreshold', e.target.value)} required />
          </label>{' '}
          <label>
            Recent activity (days) <input type="number" min={1} max={366} value={values.recentActivityDays} onChange={(e) => change('recentActivityDays', e.target.value)} required />
          </label>{' '}
          <label>
            Progression span (years) <input type="number" min={1} max={20} value={values.salaryProgressionYears} onChange={(e) => change('salaryProgressionYears', e.target.value)} required />
          </label>{' '}
          <label>
            Expense decision due (business days){' '}
            <input type="number" min={1} max={30} value={values.expenseDecisionDueDays} onChange={(e) => change('expenseDecisionDueDays', e.target.value)} required />
          </label>{' '}
          <label>
            Reason <input value={values.reason} onChange={(e) => change('reason', e.target.value)} maxLength={1000} required />
          </label>{' '}
          <button type="submit" disabled={save.isPending}>
            Save revision
          </button>
          <ErrorNote error={save.error} />
        </form>
      </Section>
      <Section title="Revisions">
        <table>
          <thead>
            <tr>
              <th>From</th>
              <th>Until</th>
              <th>Threshold</th>
              <th>Activity days</th>
              <th>Span (years)</th>
              <th>Decision due (business days)</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {settings.data?.items.map((s) => (
              <tr key={s.id}>
                <td>{s.effectiveFrom}</td>
                <td>{s.effectiveTo ?? '—'}</td>
                <td>{s.smallCountThreshold}</td>
                <td>{s.recentActivityDays}</td>
                <td>{s.salaryProgressionYears}</td>
                <td>{s.expenseDecisionDueDays}</td>
                <td>{s.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <ErrorNote error={settings.error} />
    </>
  );
}

export const REPORTING_SCREENS: readonly ScreenRoute[] = [
  { path: '/salary/progression', title: 'Salary progression', permission: HISTORY_GRANT, nav: true, component: SalaryProgressionScreen },
  { path: '/admin/reporting-settings', title: 'Reporting settings', permission: SETTINGS_GRANT, nav: true, component: ReportingSettingsScreen },
];
