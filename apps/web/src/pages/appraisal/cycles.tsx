// Appraisal cycle screens (FR-040): the cycle start month, the cycle register, a new cycle and one cycle's detail.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, formatDate, isNotFound, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Item, Notice, NotPermitted, Section, StateBadge } from '../../ui';
import { wholeIn } from './goals';
import { QueryProblem, Refusal } from './refusals';
import { CycleReport } from './reports';
import { type Cycle, CYCLE_MANAGE, CYCLE_READ, FLUSH, GROUP, levelsText, MONTH_NAME, PATHS, periodText, type RatingMode, ratingModeText, READ, REPORT, SCROLL, type SectionInfo, type Setting, shown, START_MONTHS, useKeys, UUID, type WindowKey, WINDOWS, windowText, yesNo } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Screen: cycles (setting, register, a new cycle) and a cycle's detail
// ---------------------------------------------------------------------------------------------------------

export function CyclesScreen() {
  const { can } = useSession();
  if (!can(CYCLE_READ)) {
    return (
      <Section title="Appraisal cycles">
        <NotPermitted>The selected role cannot view appraisal cycles.</NotPermitted>
      </Section>
    );
  }
  return (
    <div className="stack">
      <SettingSection />
      <CycleRegister />
      {can(CYCLE_MANAGE) && <NewCycleSection />}
    </div>
  );
}

function useSetting() {
  const keys = useKeys();
  return useQuery({ queryKey: keys.setting, queryFn: () => api<Setting>('/v1/appraisal-settings'), retry: retryTransient });
}

function SettingSection() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const setting = useSetting();
  const [month, setMonth] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: { cycleStartMonth: number; expectedVersion?: number }) => api<Setting>('/v1/appraisal-settings', { method: 'PUT', body }),
    onSuccess: (s) => {
      setMonth('');
      setNotice(`Saved: cycles start on the 1st of ${MONTH_NAME[s.cycleStartMonth ?? 0] ?? 'the chosen month'}.`);
      void qc.invalidateQueries({ queryKey: keys.setting });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'STALE_VERSION') void qc.invalidateQueries({ queryKey: keys.setting });
    },
  });
  const data = shown(setting);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!data || !month || save.isPending) return;
    setNotice(null);
    save.mutate({ cycleStartMonth: Number(month), ...(data.configured && data.version !== null ? { expectedVersion: data.version } : {}) });
  };
  return (
    <Section title="Cycle start month">
      {setting.isPending && <p className="hint loading">Loading the setting…</p>}
      <QueryProblem error={setting.error} forbidden="The selected role cannot view the appraisal setting." />
      {data &&
        (data.configured && data.cycleStartMonth !== null ? (
          <p>
            Cycles start on the 1st of <strong>{MONTH_NAME[data.cycleStartMonth] ?? data.cycleStartMonth}</strong> and run twelve months.
          </p>
        ) : (
          <p role="note">
            <Badge tone="warn">not set</Badge> No cycle start month is set, so cycles cannot be created yet. There is no default.
          </p>
        ))}
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
      {data && can(CYCLE_MANAGE) && (
        <form className="grid-form" aria-label="Set the cycle start month" onSubmit={submit} noValidate>
          <label>
            Cycle start month
            <select value={month} onChange={(e) => setMonth(e.target.value)}>
              <option value="">Choose…</option>
              {START_MONTHS.map(([m, label]) => (
                <option key={m} value={String(m)}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button type="submit" disabled={save.isPending || !month}>
              {save.isPending ? 'Saving…' : 'Save the start month'}
            </button>
          </div>
          <Refusal error={save.error} action="setting" />
        </form>
      )}
    </Section>
  );
}

function CycleRegister() {
  const keys = useKeys();
  const [state, setState] = useState('');
  const cycles = useQuery({
    queryKey: keys.cycleList(state),
    queryFn: () => api<{ items: Cycle[] }>(`/v1/appraisal-cycles${state ? `?state=${state}` : ''}`),
    retry: retryTransient,
  });
  const data = shown(cycles);
  return (
    <Section title="Cycles">
      <div className="row">
        <label>
          State
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All</option>
            <option value="OPEN">Open</option>
            <option value="CLOSED">Closed</option>
          </select>
        </label>
      </div>
      {cycles.isPending && <p className="hint loading">Loading cycles…</p>}
      <QueryProblem error={cycles.error} forbidden="The selected role cannot view appraisal cycles." />
      {data && data.items.length === 0 && <Empty>No cycles yet.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Appraisal cycles">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Period</th>
                <th>Reviewer levels</th>
                <th>Goal setting</th>
                <th>Self-entry</th>
                <th>Manager rating</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={PATHS.cycle(c.id)}>{c.code}</Link>
                  </td>
                  <td>{c.name}</td>
                  <td>{periodText(c)}</td>
                  <td>{c.approvalLevels}</td>
                  {WINDOWS.map((w) => (
                    <td key={w.key}>
                      {windowText(c.windows[w.key])}
                      {c.windows[w.key]?.openToday ? ' (open today)' : ''}
                    </td>
                  ))}
                  <td>
                    <StateBadge state={c.state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

type WindowDraft = Record<WindowKey, { opensOn: string; closesOn: string }>;
interface CycleBody {
  code?: string;
  name: string;
  startDate?: string;
  approvalLevels: 0 | 1 | 2;
  windows: Record<WindowKey, { opensOn: string; closesOn: string } | null>;
  goalReviewRequired: boolean;
  ratingMode: RatingMode;
  /** Required with reviewer levels; null without them. */
  reviewDueOn: string | null;
  /** I-86: both or neither (a new cycle without them takes the company split in force on its start date). */
  goalWeightPercent?: number;
  competencyWeightPercent?: number;
  /** FR-042 sections included (omitted: unchanged, or none on a new cycle). */
  sections?: string[];
}

/** FR-042 section catalogue (GET /v1/appraisal-sections). */
function useSectionCatalogue(enabled = true) {
  const keys = useKeys();
  return useQuery({ queryKey: keys.sections, queryFn: () => api<{ items: SectionInfo[] }>('/v1/appraisal-sections'), enabled, retry: retryTransient, staleTime: 5 * 60_000 });
}

/**
 * A new cycle (code, name, start date, levels, windows, process rules) or an open cycle's name, levels, windows and rules.
 * Process rules decided under owner delegation (I-77): goal review is on and the rating mode is the formula unless HR says
 * otherwise; reviewer levels may be none (the manager's approval completes the appraisal); with reviewer levels the review
 * due date is required.
 */
function CycleForm({
  initial,
  label,
  submitLabel,
  busy,
  startMonth,
  onSubmit,
  children,
  blockedReason = null,
}: {
  initial: Cycle | null;
  label: string;
  submitLabel: string;
  busy: boolean;
  startMonth: number | null;
  onSubmit: (body: CycleBody) => void;
  children?: ReactNode;
  /** Why the form cannot be submitted yet, said beside its button (which is then disabled). */
  blockedReason?: string | null;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState(initial?.name ?? '');
  const [startDate, setStartDate] = useState('');
  const [levels, setLevels] = useState(String(initial?.approvalLevels ?? 1));
  const [goalReview, setGoalReview] = useState(initial?.goalReviewRequired ?? true);
  const [ratingMode, setRatingMode] = useState<RatingMode>(initial?.ratingMode ?? 'FORMULA');
  const [reviewDueOn, setReviewDueOn] = useState(initial?.reviewDueOn ?? '');
  const [windows, setWindows] = useState<WindowDraft>(
    () => Object.fromEntries(WINDOWS.map((w) => [w.key, { opensOn: initial?.windows[w.key]?.opensOn ?? '', closesOn: initial?.windows[w.key]?.closesOn ?? '' }])) as WindowDraft,
  );
  // I-86: the cycle's own split (blank on a new cycle: the company split in force on its start date) and FR-042 sections.
  const [goalPercent, setGoalPercent] = useState(initial?.scoring ? String(initial.scoring.goalWeightPercent) : '');
  const [competencyPercent, setCompetencyPercent] = useState(initial?.scoring ? String(initial.scoring.competencyWeightPercent) : '');
  const [sections, setSections] = useState<string[]>(initial?.sections?.map((s) => s.code) ?? []);
  const catalogue = useSectionCatalogue();
  const [problem, setProblem] = useState<string | null>(null);
  const setWindow = (key: WindowKey, patch: Partial<{ opensOn: string; closesOn: string }>) => setWindows((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!initial && !code.trim()) return setProblem('Enter a code for the cycle.');
    if (!name.trim()) return setProblem('Enter a name for the cycle.');
    if (!initial && !startDate) return setProblem('Enter the start date.');
    const out = {} as CycleBody['windows'];
    for (const w of WINDOWS) {
      const v = windows[w.key];
      if (!v.opensOn && !v.closesOn) out[w.key] = null;
      else if (v.opensOn && v.closesOn) out[w.key] = { opensOn: v.opensOn, closesOn: v.closesOn };
      else return setProblem(`Enter both dates of the ${w.label.toLowerCase()} window, or neither to leave it unscheduled.`);
    }
    const approvalLevels = levels === '2' ? 2 : levels === '0' ? 0 : 1;
    if (approvalLevels > 0 && !reviewDueOn) return setProblem('Enter the review due date: the date reviewer confirmations are due.');
    const g = goalPercent.trim();
    const c = competencyPercent.trim();
    let split: { goalWeightPercent: number; competencyWeightPercent: number } | null = null;
    if (g !== '' || c !== '') {
      if (!wholeIn(g, 1, 100) || !wholeIn(c, 0, 99) || Number(g) + Number(c) !== 100) {
        return setProblem('The goal and competency percentages are whole numbers that add up to exactly 100 (or leave both empty for the company split).');
      }
      split = { goalWeightPercent: Number(g), competencyWeightPercent: Number(c) };
    }
    // Sent only when changed: omitted means unchanged (or, on a new cycle, the company split and no sections).
    if (split && initial?.scoring && split.goalWeightPercent === initial.scoring.goalWeightPercent && split.competencyWeightPercent === initial.scoring.competencyWeightPercent) split = null;
    const initialSections = initial?.sections?.map((s) => s.code) ?? [];
    const sectionsChanged = sections.length !== initialSections.length || sections.some((s) => !initialSections.includes(s));
    setProblem(null);
    onSubmit({
      ...(initial ? {} : { code: code.trim(), startDate }),
      name: name.trim(),
      approvalLevels,
      windows: out,
      goalReviewRequired: goalReview,
      ratingMode,
      reviewDueOn: approvalLevels > 0 ? reviewDueOn : null,
      ...(split ?? {}),
      ...(sectionsChanged ? { sections } : {}),
    });
  };
  return (
    <form className="grid-form" aria-label={label} onSubmit={submit} noValidate>
      {!initial && (
        <label>
          Code
          <input value={code} maxLength={40} onChange={(e) => setCode(e.target.value)} />
        </label>
      )}
      <label>
        Name
        <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </label>
      {!initial && (
        <div>
          <label>
            Start date
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <p className="hint" style={FLUSH}>
            {startMonth ? `The 1st of ${MONTH_NAME[startMonth] ?? 'the configured month'}; the cycle runs twelve months.` : 'Set the cycle start month first.'}
          </p>
        </div>
      )}
      <label>
        Reviewer levels
        <select value={levels} onChange={(e) => setLevels(e.target.value)}>
          <option value="1">{levelsText(1)}</option>
          <option value="2">{levelsText(2)}</option>
          <option value="0">{levelsText(0)}</option>
        </select>
      </label>
      {levels !== '0' && (
        <div>
          <label>
            Review due date
            <input type="date" value={reviewDueOn} onChange={(e) => setReviewDueOn(e.target.value)} />
          </label>
          <p className="hint" style={FLUSH}>
            Reviewer confirmations are due on this date (on or after the manager-rating window closes); later ones count as overdue.
          </p>
        </div>
      )}
      <label>
        Rating mode
        <select value={ratingMode} onChange={(e) => setRatingMode(e.target.value === 'MANUAL' ? 'MANUAL' : 'FORMULA')}>
          <option value="FORMULA">{ratingModeText('FORMULA')}</option>
          <option value="MANUAL">{ratingModeText('MANUAL')}</option>
        </select>
      </label>
      <label>
        <input type="checkbox" checked={goalReview} onChange={(e) => setGoalReview(e.target.checked)} /> Goals are reviewed before they take effect (KRA review)
      </label>
      <fieldset style={GROUP} className="wide">
        <legend>Result split</legend>
        <div className="row">
          <label>
            Goals %
            <input inputMode="numeric" value={goalPercent} maxLength={3} onChange={(e) => setGoalPercent(e.target.value)} />
          </label>
          <label>
            Competencies %
            <input inputMode="numeric" value={competencyPercent} maxLength={2} onChange={(e) => setCompetencyPercent(e.target.value)} />
          </label>
        </div>
        <p className="hint" style={FLUSH}>
          {initial
            ? 'Whole percentages that add up to 100. Competencies 0 means the cycle does not assess them. Whether it does is fixed once an appraisal is enrolled; the split is fixed once one is submitted.'
            : 'Whole percentages that add up to 100, or leave both empty to use the company split. Competencies 0 means the cycle does not assess them.'}
        </p>
      </fieldset>
      <fieldset style={GROUP} className="wide">
        <legend>Sections included</legend>
        {catalogue.isPending && <p className="hint loading">Loading the sections…</p>}
        {(shown(catalogue)?.items ?? []).map((s) => (
          <label key={s.code}>
            <input
              type="checkbox"
              checked={sections.includes(s.code)}
              onChange={(e) => setSections((prev) => (e.target.checked ? [...prev, s.code] : prev.filter((x) => x !== s.code)))}
            />{' '}
            {s.title}: {s.meaning} Filled by {s.filledBy.map((p) => (p === 'EMPLOYEE' ? 'the employee' : 'the manager')).join(' and ')}.
          </label>
        ))}
        <p className="hint" style={FLUSH}>
          None of these is scored. An included section must be filled in before its party submits; an excluded one never blocks a submission.
        </p>
      </fieldset>
      <fieldset style={GROUP} className="wide">
        <legend>Windows</legend>
        <p className="hint" style={FLUSH}>
          Both dates are included. Leave both dates of a window empty to schedule it later.
        </p>
        {WINDOWS.map((w) => (
          <div className="row" key={w.key}>
            <label>
              {w.label} opens
              <input type="date" value={windows[w.key].opensOn} onChange={(e) => setWindow(w.key, { opensOn: e.target.value })} />
            </label>
            <label>
              {w.label} closes
              <input type="date" value={windows[w.key].closesOn} onChange={(e) => setWindow(w.key, { closesOn: e.target.value })} />
            </label>
          </div>
        ))}
      </fieldset>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={busy || !!blockedReason}>
          {busy ? 'Saving…' : submitLabel}
        </button>
        {blockedReason && <span className="hint">{blockedReason}</span>}
      </div>
      {children}
    </form>
  );
}

function NewCycleSection() {
  const keys = useKeys();
  const qc = useQueryClient();
  const setting = useSetting();
  const [formKey, setFormKey] = useState(0);
  const [created, setCreated] = useState<Cycle | null>(null);
  const create = useMutation({
    mutationFn: (body: CycleBody) => api<Cycle>('/v1/appraisal-cycles', { body }),
    onSuccess: (c) => {
      setCreated(c);
      setFormKey((k) => k + 1);
      void qc.invalidateQueries({ queryKey: keys.cycles });
    },
  });
  const startMonth = shown(setting)?.cycleStartMonth ?? null;
  // Cycles are refused until the start month is set: say so beside the button rather than after a refused attempt.
  const blockedReason = shown(setting) && startMonth === null ? 'Set the cycle start month above first: cycles cannot be created until it is set.' : null;
  return (
    <Section title="New cycle">
      {created && (
        <p className="ok" role="status">
          Created cycle <Link to={PATHS.cycle(created.id)}>{created.code}</Link> for {periodText(created)}.
        </p>
      )}
      <CycleForm
        key={formKey}
        initial={null}
        label="New cycle"
        submitLabel="Create the cycle"
        busy={create.isPending}
        startMonth={startMonth}
        blockedReason={blockedReason}
        onSubmit={(body) => {
          setCreated(null);
          create.mutate(body);
        }}
      >
        <Refusal error={create.error} action="cycle-create" />
      </CycleForm>
    </Section>
  );
}

export function CycleDetailScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(CYCLE_READ)) {
    return (
      <Section title="Appraisal cycle">
        <NotPermitted>The selected role cannot view appraisal cycles.</NotPermitted>
      </Section>
    );
  }
  if (!UUID.test(id)) {
    return (
      <Section title="Appraisal cycle">
        <Empty>This cycle does not exist.</Empty>
      </Section>
    );
  }
  return <CycleDetailView id={id} />;
}

function CycleDetailView({ id }: { id: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const cycle = useQuery({ queryKey: keys.cycle(id), queryFn: () => api<Cycle>(`/v1/appraisal-cycles/${id}`), retry: retryTransient });
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.cycles });
  };
  const update = useMutation({
    mutationFn: (body: CycleBody & { expectedVersion: number }) => api<Cycle>(`/v1/appraisal-cycles/${id}`, { method: 'PUT', body }),
    onSuccess: () => {
      setNotice({ text: 'Saved the cycle.', ok: true });
      refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === 'STALE_VERSION' || e.code === 'CYCLE_CLOSED')) refresh();
    },
  });
  const close = useMutation({
    mutationFn: (expectedVersion: number) => api<Cycle>(`/v1/appraisal-cycles/${id}/close`, { body: { expectedVersion } }),
    onSuccess: () => {
      setNotice({ text: 'Closed the cycle.', ok: true });
      refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'STALE_VERSION') refresh();
    },
  });
  const c = shown(cycle);
  if (cycle.isPending) return <Section title="Appraisal cycle">{<p className="hint loading">Loading the cycle…</p>}</Section>;
  if (!c) {
    return (
      <Section title="Appraisal cycle">
        {isNotFound(cycle.error) ? <Empty>This cycle does not exist.</Empty> : <QueryProblem error={cycle.error} forbidden="The selected role cannot view appraisal cycles." />}
      </Section>
    );
  }
  const open = c.state === 'OPEN';
  const busy = update.isPending || close.isPending;
  return (
    <div className="stack">
      <Section title={`Cycle ${c.code}`} actions={<Link to={PATHS.cycles}>All cycles</Link>}>
        <Notice notice={notice} />
        <dl className="kv">
          <Item term="Name">{c.name}</Item>
          <Item term="Period">{periodText(c)}</Item>
          <Item term="Reviewer levels">{levelsText(c.approvalLevels)}</Item>
          {c.approvalLevels > 0 && <Item term="Review due date">{c.reviewDueOn ? formatDate(c.reviewDueOn) : 'Not set: reviewer tasks have no due date until it is'}</Item>}
          <Item term="Goal review">{c.goalReviewRequired ? 'Goals take effect once someone other than their setter reviews them' : 'None: goals take effect when set'}</Item>
          <Item term="Rating mode">{ratingModeText(c.ratingMode)}</Item>
          {c.scoring && (
            <Item term="Result split">
              {c.scoring.competencyWeightPercent > 0
                ? `Goals ${c.scoring.goalWeightPercent}% and competencies ${c.scoring.competencyWeightPercent}% (without mapped competencies, the goal result alone)`
                : 'Goals only: the cycle does not assess competencies'}
            </Item>
          )}
          {c.sections && (
            <Item term="Sections">{c.sections.length > 0 ? c.sections.map((s) => s.title).join(', ') : 'None (only goals and competencies)'}</Item>
          )}
          <Item term="State">
            <StateBadge state={c.state} />
          </Item>
        </dl>
        <div style={SCROLL}>
          <table aria-label="Windows">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Window</th>
                <th>Open today</th>
              </tr>
            </thead>
            <tbody>
              {WINDOWS.map((w) => (
                <tr key={w.key}>
                  <td>{w.label}</td>
                  <td>{windowText(c.windows[w.key])}</td>
                  <td>{c.windows[w.key] ? yesNo(c.windows[w.key]!.openToday) : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">Reviewer confirmation is a decision, not a windowed entry: it falls due on the review due date but is never refused for lateness. Window exceptions are recorded per appraisal.</p>
        {can(READ) && (
          <p>
            <Link to={`${PATHS.appraisals}?cycleId=${c.id}`}>Appraisals in this cycle</Link>
          </p>
        )}
        {can(CYCLE_MANAGE) && open && (
          <div className="row">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                setNotice(null);
                close.mutate(c.version);
              }}
            >
              {close.isPending ? 'Closing…' : 'Close the cycle'}
            </button>
          </div>
        )}
        <Refusal error={close.error} action="cycle-close" />
      </Section>
      {can(CYCLE_MANAGE) && open && (
        <Section title="Change the cycle">
          <p className="hint">
            The code and period never change. Reviewer levels, the goal review, the rating mode, the result split and the sections are fixed once an appraisal of the cycle has been submitted.
          </p>
          <CycleForm
            key={c.version}
            initial={c}
            label="Change the cycle"
            submitLabel="Save the cycle"
            busy={busy}
            startMonth={null}
            onSubmit={(body) => {
              setNotice(null);
              update.mutate({
                name: body.name,
                approvalLevels: body.approvalLevels,
                windows: body.windows,
                goalReviewRequired: body.goalReviewRequired,
                ratingMode: body.ratingMode,
                reviewDueOn: body.reviewDueOn,
                ...(body.goalWeightPercent !== undefined && body.competencyWeightPercent !== undefined
                  ? { goalWeightPercent: body.goalWeightPercent, competencyWeightPercent: body.competencyWeightPercent }
                  : {}),
                ...(body.sections !== undefined ? { sections: body.sections } : {}),
                expectedVersion: c.version,
              });
            }}
          >
            <Refusal error={update.error} action="cycle-update" />
          </CycleForm>
        </Section>
      )}
      {can(REPORT) && <CycleReport cycleId={c.id} />}
    </div>
  );
}
