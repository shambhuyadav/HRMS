// Appraisal cycle screens (FR-040): the cycle start month, the cycle register, a new cycle and one cycle's detail.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ButtonRow, CheckField, FilterBar, FormField, FormGrid, FramedFieldset } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, formatDate, isNotFound, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, Notice, NotPermitted, Section, StateBadge, WarningNote } from '../../ui';
import { wholeIn } from './goals';
import { QueryProblem, Refusal } from './refusals';
import { CycleReport } from './reports';
import { type Cycle, CYCLE_MANAGE, CYCLE_READ, FIELD_ROW, levelsText, MONTH_NAME, PATHS, periodText, type RatingMode, ratingModeText, READ, REPORT, type SectionInfo, type Setting, shown, START_MONTHS, useKeys, UUID, type WindowKey, WINDOWS, windowText, yesNo } from './shared';

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
      {setting.isPending && <LoadingLine>Loading the setting…</LoadingLine>}
      <QueryProblem error={setting.error} forbidden="The selected role cannot view the appraisal setting." />
      {data &&
        (data.configured && data.cycleStartMonth !== null ? (
          <p>
            Cycles start on the 1st of <strong>{MONTH_NAME[data.cycleStartMonth] ?? data.cycleStartMonth}</strong> and run twelve months.
          </p>
        ) : (
          <WarningNote badge="not set">No cycle start month is set, so cycles cannot be created yet. There is no default.</WarningNote>
        ))}
      <Notice notice={notice ? { text: notice, ok: true } : null} />
      {data && can(CYCLE_MANAGE) && (
        <FormGrid aria-label="Set the cycle start month" onSubmit={submit} noValidate>
          <FormField>
            Cycle start month
            <NativeSelect value={month} onChange={(e) => setMonth(e.target.value)}>
              <option value="">Choose…</option>
              {START_MONTHS.map(([m, label]) => (
                <option key={m} value={String(m)}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <ButtonRow>
            <Button type="submit" disabled={save.isPending || !month}>
              {save.isPending ? 'Saving…' : 'Save the start month'}
            </Button>
          </ButtonRow>
          <Refusal error={save.error} action="setting" />
        </FormGrid>
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
      <FilterBar>
        <FormField>
          State
          <NativeSelect value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All</option>
            <option value="OPEN">Open</option>
            <option value="CLOSED">Closed</option>
          </NativeSelect>
        </FormField>
      </FilterBar>
      {cycles.isPending && <LoadingLine>Loading cycles…</LoadingLine>}
      <QueryProblem error={cycles.error} forbidden="The selected role cannot view appraisal cycles." />
      {data && data.items.length === 0 && <Empty>No cycles yet.</Empty>}
      {data && data.items.length > 0 && (
        <Table aria-label="Appraisal cycles">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Code</TableHead>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Period</TableHead>
              <TableHead scope="col">Reviewer levels</TableHead>
              <TableHead scope="col">Goal setting</TableHead>
              <TableHead scope="col">Self-entry</TableHead>
              <TableHead scope="col">Manager rating</TableHead>
              <TableHead scope="col">State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <Link to={PATHS.cycle(c.id)}>{c.code}</Link>
                </TableCell>
                <TableCell>{c.name}</TableCell>
                <TableCell>{periodText(c)}</TableCell>
                <TableCell>{c.approvalLevels}</TableCell>
                {WINDOWS.map((w) => (
                  <TableCell key={w.key}>
                    {windowText(c.windows[w.key])}
                    {c.windows[w.key]?.openToday ? ' (open today)' : ''}
                  </TableCell>
                ))}
                <TableCell>
                  <StateBadge state={c.state} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
    <FormGrid aria-label={label} onSubmit={submit} noValidate>
      {!initial && (
        <FormField>
          Code
          <Input value={code} maxLength={40} onChange={(e) => setCode(e.target.value)} />
        </FormField>
      )}
      <FormField>
        Name
        <Input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </FormField>
      {!initial && (
        <FormField hint={<FieldDescription>{startMonth ? `The 1st of ${MONTH_NAME[startMonth] ?? 'the configured month'}; the cycle runs twelve months.` : 'Set the cycle start month first.'}</FieldDescription>}>
          Start date
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </FormField>
      )}
      <FormField>
        Reviewer levels
        <NativeSelect value={levels} onChange={(e) => setLevels(e.target.value)}>
          <option value="1">{levelsText(1)}</option>
          <option value="2">{levelsText(2)}</option>
          <option value="0">{levelsText(0)}</option>
        </NativeSelect>
      </FormField>
      {levels !== '0' && (
        <FormField hint={<FieldDescription>Reviewer confirmations are due on this date (on or after the manager-rating window closes); later ones count as overdue.</FieldDescription>}>
          Review due date
          <Input type="date" value={reviewDueOn} onChange={(e) => setReviewDueOn(e.target.value)} />
        </FormField>
      )}
      <FormField>
        Rating mode
        <NativeSelect value={ratingMode} onChange={(e) => setRatingMode(e.target.value === 'MANUAL' ? 'MANUAL' : 'FORMULA')}>
          <option value="FORMULA">{ratingModeText('FORMULA')}</option>
          <option value="MANUAL">{ratingModeText('MANUAL')}</option>
        </NativeSelect>
      </FormField>
      <CheckField>
        <input type="checkbox" checked={goalReview} onChange={(e) => setGoalReview(e.target.checked)} /> Goals are reviewed before they take effect (KRA review)
      </CheckField>
      <FramedFieldset legend="Result split">
        <div className={FIELD_ROW}>
          <FormField className="w-auto">
            Goals %
            <Input inputMode="numeric" value={goalPercent} maxLength={3} onChange={(e) => setGoalPercent(e.target.value)} />
          </FormField>
          <FormField className="w-auto">
            Competencies %
            <Input inputMode="numeric" value={competencyPercent} maxLength={2} onChange={(e) => setCompetencyPercent(e.target.value)} />
          </FormField>
        </div>
        <Hint className="m-0">
          {initial
            ? 'Whole percentages that add up to 100. Competencies 0 means the cycle does not assess them. Whether it does is fixed once an appraisal is enrolled; the split is fixed once one is submitted.'
            : 'Whole percentages that add up to 100, or leave both empty to use the company split. Competencies 0 means the cycle does not assess them.'}
        </Hint>
      </FramedFieldset>
      <FramedFieldset legend="Sections included">
        {catalogue.isPending && <LoadingLine>Loading the sections…</LoadingLine>}
        {(shown(catalogue)?.items ?? []).map((s) => (
          <CheckField key={s.code}>
            <input
              type="checkbox"
              checked={sections.includes(s.code)}
              onChange={(e) => setSections((prev) => (e.target.checked ? [...prev, s.code] : prev.filter((x) => x !== s.code)))}
            />{' '}
            {s.title}: {s.meaning} Filled by {s.filledBy.map((p) => (p === 'EMPLOYEE' ? 'the employee' : 'the manager')).join(' and ')}.
          </CheckField>
        ))}
        <Hint className="m-0">None of these is scored. An included section must be filled in before its party submits; an excluded one never blocks a submission.</Hint>
      </FramedFieldset>
      <FramedFieldset legend="Windows">
        <Hint className="m-0">Both dates are included. Leave both dates of a window empty to schedule it later.</Hint>
        {WINDOWS.map((w) => (
          <div className={FIELD_ROW} key={w.key}>
            <FormField className="w-auto">
              {w.label} opens
              <Input type="date" value={windows[w.key].opensOn} onChange={(e) => setWindow(w.key, { opensOn: e.target.value })} />
            </FormField>
            <FormField className="w-auto">
              {w.label} closes
              <Input type="date" value={windows[w.key].closesOn} onChange={(e) => setWindow(w.key, { closesOn: e.target.value })} />
            </FormField>
          </div>
        ))}
      </FramedFieldset>
      {problem && <Notice notice={{ text: problem, ok: false }} />}
      <ButtonRow>
        <Button type="submit" disabled={busy || !!blockedReason}>
          {busy ? 'Saving…' : submitLabel}
        </Button>
        {blockedReason && <Hint as="span">{blockedReason}</Hint>}
      </ButtonRow>
      {children}
    </FormGrid>
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
        <StatusNote tone="success" role="status">
          Created cycle <Link to={PATHS.cycle(created.id)}>{created.code}</Link> for {periodText(created)}.
        </StatusNote>
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
  if (cycle.isPending) return <Section title="Appraisal cycle">{<LoadingLine>Loading the cycle…</LoadingLine>}</Section>;
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
      <Section
        title={`Cycle ${c.code}`}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to={PATHS.cycles}>All cycles</Link>
          </Button>
        }
      >
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
        <Table aria-label="Windows">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Stage</TableHead>
              <TableHead scope="col">Window</TableHead>
              <TableHead scope="col">Open today</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {WINDOWS.map((w) => (
              <TableRow key={w.key}>
                <TableCell>{w.label}</TableCell>
                <TableCell>{windowText(c.windows[w.key])}</TableCell>
                <TableCell>{c.windows[w.key] ? yesNo(c.windows[w.key]!.openToday) : 'No'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Hint>Reviewer confirmation is a decision, not a windowed entry: it falls due on the review due date but is never refused for lateness. Window exceptions are recorded per appraisal.</Hint>
        {can(READ) && (
          <p>
            <Link to={`${PATHS.appraisals}?cycleId=${c.id}`}>Appraisals in this cycle</Link>
          </p>
        )}
        {can(CYCLE_MANAGE) && open && (
          <ButtonRow>
            <Button
              type="button"
              variant="danger"
              disabled={busy}
              onClick={() => {
                setNotice(null);
                close.mutate(c.version);
              }}
            >
              {close.isPending ? 'Closing…' : 'Close the cycle'}
            </Button>
          </ButtonRow>
        )}
        <Refusal error={close.error} action="cycle-close" />
      </Section>
      {can(CYCLE_MANAGE) && open && (
        <Section title="Change the cycle">
          <Hint>
            The code and period never change. Reviewer levels, the goal review, the rating mode, the result split and the sections are fixed once an appraisal of the cycle has been submitted.
          </Hint>
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
