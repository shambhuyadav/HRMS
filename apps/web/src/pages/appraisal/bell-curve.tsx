// The bell curve (CL-132): the rating distribution chart and table, and HR's rating bands and target shares.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { ButtonRow, FilterBar, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Notice, NotPermitted, Section, When } from '../../ui';
import { CycleSelect, DepartmentSelect } from './lookups';
import { QueryProblem } from './refusals';
import { CYCLE_READ, type MasterItem, ORG_READ, periodText, REPORT_RATING, shown, useKeys } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Screen: the bell curve (CL-132; FR-044 "proposed distribution charts must report selected population and period"; migration
// 0262; modules/appraisal/bell-curve.ts). Read-only: the completed appraisals' final ratings of one cycle in the role's scope (the
// user's own appraisal never included), narrowed by department and grade, as a bar chart in plain SVG and as a table. Where HR set
// rating bands with target shares (for the cycle, or the company default), each band's actual share is drawn against its target;
// otherwise the exact ratings are shown. A target is a reference only (F1 "no forced distribution"): nothing here changes or limits
// a rating. Ratings are confidential, so the screen needs the rating report right; HR keeps the bands and targets below it.
// ---------------------------------------------------------------------------------------------------------
export const BELL_CURVE_PATH = '/appraisal/bell-curve';
const DISTRIBUTION_MANAGE = 'appraisal_distribution.manage.operational';

interface CurveBand {
  sequence: number;
  code: string;
  label: string;
  minRating: string;
  maxRating: string;
  targetPercent: string;
  targetCount: string;
  actualCount: number;
  actualPercent: string | null;
  differencePercent: string | null;
}
interface BellCurve {
  cycle: { id: string; code: string; name: string; startDate: string; endDate: string; state: string };
  period: { from: string; to: string };
  filters: { departmentId: string | null; gradeId: string | null };
  scope: string;
  ownAppraisalExcluded: boolean;
  generatedAt: string;
  population: number;
  distribution: { rating: string; count: number; percent: string | null }[];
  target: { source: 'CYCLE' | 'COMPANY'; settingId: string; revision: number; reason: string; setAt: string } | null;
  bands: CurveBand[] | null;
  targetEnforced: boolean;
}
/** One bar of the chart: a band (with its target) or one exact rating. */
interface CurveBar {
  key: string;
  label: string;
  range: string;
  count: number;
  percent: number;
  target: number | null;
  tooltip: string;
}

const pct = (v: string | null | undefined) => (v === null || v === undefined ? 0 : Number(v));
const pctText = (v: string | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`);
/** A band's actual share against its target, in points, signed when above it. */
function differenceText(points: string | null): string {
  if (points === null) return '—';
  const sign = pct(points) > 0 ? '+' : '';
  return `${sign}${points} points`;
}

function curveBars(c: BellCurve): CurveBar[] {
  if (c.bands) {
    return c.bands.map((b) => ({
      key: b.code,
      label: b.label,
      range: b.minRating === b.maxRating ? b.minRating : `${b.minRating}–${b.maxRating}`,
      count: b.actualCount,
      percent: pct(b.actualPercent),
      target: pct(b.targetPercent),
      tooltip: `${b.label} (${b.minRating} to ${b.maxRating}): ${b.actualCount} of ${c.population} (${pctText(b.actualPercent)}); target ${b.targetPercent}% (${b.targetCount})`,
    }));
  }
  return c.distribution.map((d) => ({ key: d.rating, label: d.rating, range: '', count: d.count, percent: pct(d.percent), target: null, tooltip: `Rating ${d.rating}: ${d.count} of ${c.population} (${pctText(d.percent)})` }));
}

/** A bar with 4px rounded top corners, square on the baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Share of the population per bar (0 to the highest share or target, in steps of 10%), with each band's target as a dashed tick. */
function BellCurveChart({ curve }: { curve: BellCurve }) {
  const bars = curveBars(curve);
  const titleId = useId();
  const width = 640;
  const height = 280;
  const m = { top: 16, right: 12, bottom: 56, left: 48 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const highest = Math.max(10, ...bars.map((b) => Math.max(b.percent, b.target ?? 0)));
  const top = Math.min(100, Math.ceil(highest / 10) * 10);
  const ticks = [0, top / 4, top / 2, (top * 3) / 4, top];
  const y = (v: number) => m.top + plotH - (v / top) * plotH;
  const slot = plotW / Math.max(1, bars.length);
  const barW = Math.max(8, Math.min(56, slot * 0.6));
  const short = (s: string) => (s.length > 18 ? `${s.slice(0, 17)}…` : s);
  const withTargets = bars.some((b) => b.target !== null);
  const summary = bars.map((b) => `${b.label}${b.range ? ` (${b.range})` : ''} ${b.percent}%${b.target !== null ? ` against ${b.target}%` : ''}`).join('; ');
  return (
    <figure className="m-0">
      {withTargets && (
        <div className="flex flex-wrap items-center gap-4 text-[0.85rem] text-[var(--body)]" aria-hidden="true">
          <span>
            <svg width="14" height="10" className="align-middle">
              <rect width="14" height="10" rx="2" fill="var(--info)" />
            </svg>{' '}
            Actual share
          </span>
          <span>
            <svg width="18" height="10" className="align-middle">
              <line x1="0" y1="5" x2="18" y2="5" stroke="var(--text)" strokeWidth="2" strokeDasharray="4 3" />
            </svg>{' '}
            Target share
          </span>
        </div>
      )}
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" className="block max-w-[640px] min-w-[320px]" role="img" aria-labelledby={titleId}>
          <title id={titleId}>{`Share of the ${curve.population} completed appraisals by ${curve.bands ? 'rating band' : 'final rating'}: ${summary}`}</title>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" />
              <text x={m.left - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
                {`${Number.isInteger(t) ? t : t.toFixed(1)}%`}
              </text>
            </g>
          ))}
          {bars.map((b, i) => {
            const cx = m.left + slot * i + slot / 2;
            const x = cx - barW / 2;
            const h = y(0) - y(b.percent);
            return (
              <g key={b.key}>
                <title>{b.tooltip}</title>
                {/* The hit area is the whole column, larger than the bar. */}
                <rect x={m.left + slot * i} y={m.top} width={slot} height={plotH} fill="transparent" />
                <path d={barPath(x, y(b.percent), barW, h)} fill="var(--info)" />
                {b.target !== null && <line x1={x - 6} x2={x + barW + 6} y1={y(b.target)} y2={y(b.target)} stroke="var(--text)" strokeWidth="2" strokeDasharray="4 3" />}
                <text x={cx} y={height - m.bottom + 16} textAnchor="middle" fontSize="11" fill="var(--body)">
                  {short(b.label)}
                </text>
                {b.range && (
                  <text x={cx} y={height - m.bottom + 30} textAnchor="middle" fontSize="10" fill="var(--muted)">
                    {b.range}
                  </text>
                )}
              </g>
            );
          })}
          <line x1={m.left} x2={width - m.right} y1={y(0)} y2={y(0)} stroke="var(--line-strong)" strokeWidth="1" />
        </svg>
      </div>
      <figcaption className="text-[0.84rem] text-muted-foreground">{curve.bands ? 'Share of the population per rating band; the dashed line is the band’s target share.' : 'Share of the population per final rating.'} Hover a bar for its numbers; the table below has them all.</figcaption>
    </figure>
  );
}

function GradeSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const grades = useQuery({ queryKey: keys.grades, queryFn: () => api<{ items: MasterItem[] }>('/v1/org/grades'), enabled: can(ORG_READ), retry: retryTransient, staleTime: 5 * 60_000 });
  if (!can(ORG_READ)) return null;
  return (
    <FormField>
      Grade
      <NativeSelect value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All grades</option>
        {(shown(grades)?.items ?? []).map((g) => (
          <option key={g.id} value={g.id}>
            {g.name} ({g.code})
          </option>
        ))}
      </NativeSelect>
    </FormField>
  );
}

export function BellCurveScreen() {
  const { can } = useSession();
  const [cycleId, setCycleId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [gradeId, setGradeId] = useState('');
  if (!can(REPORT_RATING)) {
    return (
      <Section title="Bell curve">
        <NotPermitted>The bell curve shows confidential ratings: the selected role needs the appraisal rating report right.</NotPermitted>
      </Section>
    );
  }
  return (
    <div className="stack">
      <Section title="Bell curve">
        {can(CYCLE_READ) ? (
          <FilterBar>
            <CycleSelect label="Cycle" value={cycleId} onChange={setCycleId} />
            <DepartmentSelect value={departmentId} onChange={setDepartmentId} />
            <GradeSelect value={gradeId} onChange={setGradeId} />
          </FilterBar>
        ) : (
          <NotPermitted>The selected role cannot list appraisal cycles, so it cannot choose one.</NotPermitted>
        )}
        {!cycleId && can(CYCLE_READ) && <Hint>Choose a cycle to see the distribution of its final ratings.</Hint>}
      </Section>
      {cycleId && <BellCurveView key={cycleId} cycleId={cycleId} departmentId={departmentId} gradeId={gradeId} />}
    </div>
  );
}

function BellCurveView({ cycleId, departmentId, gradeId }: { cycleId: string; departmentId: string; gradeId: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const query = new URLSearchParams({ ...(departmentId ? { departmentId } : {}), ...(gradeId ? { gradeId } : {}) }).toString();
  const curve = useQuery({
    queryKey: [...keys.reports, 'bell-curve', cycleId, query],
    queryFn: () => api<BellCurve>(`/v1/appraisal-cycles/${cycleId}/bell-curve${query ? `?${query}` : ''}`),
    retry: retryTransient,
  });
  const data = shown(curve);
  const narrowed = [departmentId ? 'one department' : 'all departments in scope', gradeId ? 'one grade' : 'all grades'].join(', ');
  return (
    <>
      <Section title="Rating distribution">
        {curve.isPending && <LoadingLine>Loading the distribution…</LoadingLine>}
        <QueryProblem error={curve.error} forbidden="The selected role cannot view appraisal ratings." />
        {data && (
          <>
            <p>
              {data.cycle.code}: {data.cycle.name} ({periodText(data.period.from ? { startDate: data.period.from, endDate: data.period.to } : data.cycle)}). Population: <strong>{data.population}</strong>{' '}
              completed appraisal{data.population === 1 ? '' : 's'} in the selected role’s scope ({readable(data.scope).toLowerCase()}; {narrowed}). Generated <When at={data.generatedAt} />.
            </p>
            {data.ownAppraisalExcluded && <Hint>Your own appraisal is never included.</Hint>}
            {data.target ? (
              <Hint>
                {`Bands and targets: ${data.target.source === 'CYCLE' ? 'this cycle’s own' : 'the company default'}, revision ${data.target.revision} (${data.target.reason}). `}
                The target is a reference to compare against: no rating is changed or limited by it.
              </Hint>
            ) : (
              <Hint>No rating bands or target shares are set for this cycle or the company, so the exact final ratings are shown.</Hint>
            )}
            {data.population === 0 ? (
              <Empty>No completed appraisals in this population yet.</Empty>
            ) : (
              <>
                <BellCurveChart curve={data} />
                <BellCurveTable curve={data} />
              </>
            )}
          </>
        )}
      </Section>
      {data && can(DISTRIBUTION_MANAGE) && <DistributionForm key={`${data.target?.settingId ?? 'none'}`} cycleId={cycleId} curve={data} />}
    </>
  );
}

function BellCurveTable({ curve }: { curve: BellCurve }) {
  if (!curve.bands) {
    return (
      <Table aria-label="Final rating distribution">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Final rating</TableHead>
            <TableHead scope="col">Appraisals</TableHead>
            <TableHead scope="col">Share</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {curve.distribution.map((d) => (
            <TableRow key={d.rating}>
              <TableCell>{d.rating}</TableCell>
              <TableCell>{d.count}</TableCell>
              <TableCell>{pctText(d.percent)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableHead scope="row">Total</TableHead>
            <TableCell>{curve.population}</TableCell>
            <TableCell>{curve.population > 0 ? '100%' : '—'}</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    );
  }
  return (
    <Table aria-label="Rating bands against targets">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Band</TableHead>
          <TableHead scope="col">Ratings</TableHead>
          <TableHead scope="col">Appraisals</TableHead>
          <TableHead scope="col">Actual share</TableHead>
          <TableHead scope="col">Target share</TableHead>
          <TableHead scope="col">Target count</TableHead>
          <TableHead scope="col">Difference</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {curve.bands.map((b) => (
          <TableRow key={b.code}>
            <TableCell>{b.label}</TableCell>
            <TableCell>{`${b.minRating} to ${b.maxRating}`}</TableCell>
            <TableCell>{b.actualCount}</TableCell>
            <TableCell>{pctText(b.actualPercent)}</TableCell>
            <TableCell>{pctText(b.targetPercent)}</TableCell>
            <TableCell>{b.targetCount}</TableCell>
            <TableCell>{differenceText(b.differencePercent)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableHead scope="row" colSpan={2}>
            Total
          </TableHead>
          <TableCell>{curve.bands.reduce((s, b) => s + b.actualCount, 0)}</TableCell>
          <TableCell>{curve.population > 0 ? '100%' : '—'}</TableCell>
          <TableCell>100%</TableCell>
          <TableCell>{curve.population}</TableCell>
          <TableCell />
        </TableRow>
      </TableFooter>
    </Table>
  );
}

interface BandRow {
  code: string;
  label: string;
  minRating: string;
  maxRating: string;
  targetPercent: string;
}
/** Hundredths of a value with at most two decimals (no floating-point sums), or null. */
const hundredths = (v: string) => {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(v.trim());
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
};

/** The same rules the server applies (bell-curve.ts checkBands), said before anything is sent. */
function bandProblem(rows: BandRow[]): string | null {
  if (rows.length === 0) return 'Add at least one band.';
  for (const [i, r] of rows.entries()) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(r.code.trim())) return `Band ${i + 1}: the code is 1 to 20 letters, digits or underscores, starting with a letter.`;
    if (!r.label.trim()) return `Band ${i + 1}: give it a label.`;
    const min = hundredths(r.minRating);
    const max = hundredths(r.maxRating);
    if (min === null || max === null || min < 100 || max > 500 || max < min) return `Band ${i + 1}: its ratings run from 1.00 to 5.00, the lowest not above the highest.`;
    if (i === 0 && min !== 100) return 'The first band starts at 1.00.';
    if (i > 0 && min !== (hundredths(rows[i - 1]!.maxRating) ?? -1) + 1) return `Band ${i + 1} starts 0.01 above where band ${i} ends.`;
    if (hundredths(r.targetPercent) === null) return `Band ${i + 1}: the target share is a number from 0 to 100 with at most two decimals.`;
  }
  if (hundredths(rows[rows.length - 1]!.maxRating) !== 500) return 'The last band ends at 5.00.';
  const total = rows.reduce((s, r) => s + (hundredths(r.targetPercent) ?? 0), 0);
  if (total !== 10_000) return `The target shares add up to ${(total / 100).toFixed(2)}; they must add up to exactly 100.`;
  return null;
}

const DISTRIBUTION_WORDS: Record<string, string> = {
  TARGET_TOTAL_NOT_100: 'The target shares must add up to exactly 100.',
  BANDS_NOT_CONTIGUOUS: 'List the bands from the lowest ratings up, from 1.00 to 5.00, each starting 0.01 above the previous one.',
  DUPLICATE_BAND_CODE: 'Each band needs its own code.',
  FORBIDDEN: 'Bands and targets are kept from an unrestricted company-scope assignment holding the duty.',
};

function DistributionForm({ cycleId, curve }: { cycleId: string; curve: BellCurve }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const initial: BandRow[] = curve.bands
    ? curve.bands.map((b) => ({ code: b.code, label: b.label, minRating: b.minRating, maxRating: b.maxRating, targetPercent: b.targetPercent }))
    : [{ code: 'ALL', label: 'All ratings', minRating: '1.00', maxRating: '5.00', targetPercent: '100' }];
  const [rows, setRows] = useState<BandRow[]>(initial);
  const [scope, setScope] = useState<'CYCLE' | 'COMPANY'>(curve.target?.source ?? 'CYCLE');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api<{ revision: number }>('/v1/appraisal-rating-distributions', {
        body: {
          ...(scope === 'CYCLE' ? { cycleId } : { cycleId: null }),
          reason: reason.trim(),
          bands: rows.map((r) => ({ code: r.code.trim().toUpperCase(), label: r.label.trim(), minRating: r.minRating.trim(), maxRating: r.maxRating.trim(), targetPercent: r.targetPercent.trim() })),
        },
      }),
    onSuccess: (saved) => {
      setNotice({ text: `Saved revision ${saved.revision} of the ${scope === 'CYCLE' ? 'cycle’s' : 'company default'} bands and targets. No rating was changed.`, ok: true });
      setReason('');
      void qc.invalidateQueries({ queryKey: [...keys.reports, 'bell-curve', cycleId] });
    },
  });
  const edit = (i: number, k: keyof BandRow, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    const p = bandProblem(rows) ?? (reason.trim() ? null : 'Say why the bands or targets are set.');
    setProblem(p);
    setNotice(null);
    if (!p) save.mutate();
  };
  const refusal = save.error instanceof ApiError ? (DISTRIBUTION_WORDS[save.error.code] ?? null) : null;
  const problemText = problem ?? refusal;
  return (
    <Section title="Rating bands and target shares">
      <Hint>
        Bands group final ratings from 1.00 to 5.00, from the lowest up; each target share is what HR expects for comparison, and the shares add up to 100. Saving records a new revision (earlier
        ones stay); it never changes, limits or normalises any rating.
      </Hint>
      {/* Its fields keep a readable width, as the old `.stack` form gave them: a 560px select of two choices is wide enough. */}
      <form aria-label="Rating bands and targets" className="flex flex-col gap-3" onSubmit={submit} noValidate>
        <FormField className="max-w-[560px]">
          Applies to
          <NativeSelect value={scope} onChange={(e) => setScope(e.target.value === 'COMPANY' ? 'COMPANY' : 'CYCLE')}>
            <option value="CYCLE">This cycle only</option>
            <option value="COMPANY">The company default (cycles without their own)</option>
          </NativeSelect>
        </FormField>
        <Table aria-label="Bands">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Code</TableHead>
              <TableHead scope="col">Label</TableHead>
              <TableHead scope="col">From rating</TableHead>
              <TableHead scope="col">To rating</TableHead>
              <TableHead scope="col">Target %</TableHead>
              <TableHead scope="col">
                <Hint as="span">Remove</Hint>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>
                <TableCell>
                  <Input aria-label={`Band ${i + 1} code`} value={r.code} maxLength={20} onChange={(e) => edit(i, 'code', e.target.value)} />
                </TableCell>
                <TableCell>
                  <Input aria-label={`Band ${i + 1} label`} value={r.label} maxLength={100} onChange={(e) => edit(i, 'label', e.target.value)} />
                </TableCell>
                <TableCell>
                  <Input aria-label={`Band ${i + 1} from rating`} value={r.minRating} inputMode="decimal" size={5} className="w-auto" onChange={(e) => edit(i, 'minRating', e.target.value)} />
                </TableCell>
                <TableCell>
                  <Input aria-label={`Band ${i + 1} to rating`} value={r.maxRating} inputMode="decimal" size={5} className="w-auto" onChange={(e) => edit(i, 'maxRating', e.target.value)} />
                </TableCell>
                <TableCell>
                  <Input aria-label={`Band ${i + 1} target share`} value={r.targetPercent} inputMode="decimal" size={6} className="w-auto" onChange={(e) => edit(i, 'targetPercent', e.target.value)} />
                </TableCell>
                <RowActionsCell>
                  <RowActions>
                    <Button type="button" variant="danger" size="sm" aria-label={`Remove band ${i + 1}`} disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  </RowActions>
                </RowActionsCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <ButtonRow>
          <Button type="button" variant="outline" disabled={rows.length >= 20} onClick={() => setRows((rs) => [...rs, { code: '', label: '', minRating: '', maxRating: '', targetPercent: '' }])}>
            Add a band
          </Button>
        </ButtonRow>
        <FormField className="max-w-[560px]">
          Reason
          <Input value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
        </FormField>
        {problemText && <Notice notice={{ text: problemText, ok: false }} />}
        {!refusal && save.error ? <ErrorNote error={save.error} /> : null}
        <ButtonRow>
          <Button type="submit" disabled={save.isPending}>
            Save the bands and targets
          </Button>
        </ButtonRow>
        <Notice notice={notice} />
      </form>
    </Section>
  );
}
