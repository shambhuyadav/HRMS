// Appraisal competency configuration (I-86): the result split, the competency master and the competency sets by grade.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { api, ApiError, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Notice, NotPermitted, Section } from '../../ui';
import { IndicatorList } from './competency-views';
import { wholeIn } from './goals';
import { QueryProblem, Refusal } from './refusals';
import { CYCLE_MANAGE, CYCLE_READ, FIELD_ROW, type MasterItem, ORG_READ, type Scoring, shown, useKeys } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Screen: competencies and the result split (Appraisal Config: FR-041 "grade-mapped competencies"; I-86). The dated
// goals / competencies split, the competency master with its five behavioural indicators, and the dated competency sets
// mapped to a grade (optionally one designation). Operational configuration in the cycle duty; the server checks every rule.
// ---------------------------------------------------------------------------------------------------------
interface ScoringRevision {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  goalWeightPercent: number;
  competencyWeightPercent: number;
  reason: string;
  version: number;
}
interface CompetencyMaster {
  id: string;
  code: string;
  name: string;
  description: string | null;
  indicators: { level: number; text: string }[];
  activeFrom: string;
  activeTo: string | null;
  activeToday: boolean;
  usedInSets: number;
  version: number;
}
interface CompetencySet {
  id: string;
  grade: { id: string; code: string; name: string };
  designation: { id: string; code: string; name: string } | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  inForceToday: boolean;
  reason: string;
  items: { competencyId: string; code: string; name: string; sequence: number; weight: number }[];
  weightTotal: number;
  version: number;
}
const LEVELS = [1, 2, 3, 4, 5] as const;

export function CompetencyConfigScreen() {
  const { can } = useSession();
  if (!can(CYCLE_READ)) {
    return (
      <Section title="Appraisal competencies">
        <NotPermitted>The selected role cannot view the appraisal configuration.</NotPermitted>
      </Section>
    );
  }
  return (
    <div className="stack">
      <ScoringSection />
      <CompetencyMasterSection />
      <CompetencySetsSection />
    </div>
  );
}

function ScoringSection() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: keys.scoring,
    queryFn: () => api<{ businessDate: string; inForce: Scoring | null; items: ScoringRevision[] }>('/v1/appraisal-scoring-settings'),
    retry: retryTransient,
  });
  const [from, setFrom] = useState('');
  const [goal, setGoal] = useState('');
  const [competency, setCompetency] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: { effectiveFrom: string; goalWeightPercent: number; competencyWeightPercent: number; reason: string }) => api<ScoringRevision>('/v1/appraisal-scoring-settings', { body }),
    onSuccess: (r) => {
      setNotice(`Saved: from ${formatDate(r.effectiveFrom)}, goals ${r.goalWeightPercent}% and competencies ${r.competencyWeightPercent}%.`);
      setFrom('');
      setGoal('');
      setCompetency('');
      setReason('');
      void qc.invalidateQueries({ queryKey: keys.scoring });
    },
  });
  const data = shown(query);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    if (!from) return setProblem('Enter the date the new split starts.');
    if (!wholeIn(goal, 1, 100) || !wholeIn(competency, 0, 99) || Number(goal) + Number(competency) !== 100) return setProblem('The percentages are whole numbers that add up to exactly 100.');
    if (!reason.trim()) return setProblem('Enter a reason.');
    setProblem(null);
    setNotice(null);
    create.mutate({ effectiveFrom: from, goalWeightPercent: Number(goal), competencyWeightPercent: Number(competency), reason: reason.trim() });
  };
  return (
    <Section title="Result split">
      <Hint>How much goals and competencies each count towards the overall result. A new cycle uses the split in force on its start date and keeps it.</Hint>
      {query.isPending && <LoadingLine>Loading the split…</LoadingLine>}
      <QueryProblem error={query.error} forbidden="The selected role cannot view the result split." />
      {data && (
        <>
          <p>
            In force today:{' '}
            <strong>{data.inForce ? `goals ${data.inForce.goalWeightPercent}%, competencies ${data.inForce.competencyWeightPercent}%` : 'none (cycles cannot take a split until one is set)'}</strong>
          </p>
          <Table aria-label="Result split revisions">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">From</TableHead>
                <TableHead scope="col">Until</TableHead>
                <TableHead scope="col">Goals %</TableHead>
                <TableHead scope="col">Competencies %</TableHead>
                <TableHead scope="col">Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{formatDate(r.effectiveFrom)}</TableCell>
                  <TableCell>{r.effectiveTo ? formatDate(r.effectiveTo) : 'Open'}</TableCell>
                  <TableCell>{r.goalWeightPercent}</TableCell>
                  <TableCell>{r.competencyWeightPercent}</TableCell>
                  <TableCell>{r.reason}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
      <Notice notice={notice ? { text: notice, ok: true } : null} />
      {can(CYCLE_MANAGE) && (
        <FormGrid aria-label="New result split" onSubmit={submit} noValidate>
          <FormField>
            Starts on
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </FormField>
          <FormField>
            Goals %
            <Input inputMode="numeric" value={goal} maxLength={3} onChange={(e) => setGoal(e.target.value)} />
          </FormField>
          <FormField>
            Competencies %
            <Input inputMode="numeric" value={competency} maxLength={2} onChange={(e) => setCompetency(e.target.value)} />
          </FormField>
          <FormField className="col-span-full">
            Reason
            <Textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          {problem && <Notice notice={{ text: problem, ok: false }} />}
          <ButtonRow>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Saving…' : 'Save the new split'}
            </Button>
          </ButtonRow>
          <Hint className="m-0">It starts today or later and ends the split in force that day; earlier periods and cycles already created keep theirs.</Hint>
          <Refusal error={create.error} action="scoring" />
        </FormGrid>
      )}
    </Section>
  );
}

function CompetencyMasterSection() {
  const { can } = useSession();
  const keys = useKeys();
  const query = useQuery({ queryKey: keys.competencies, queryFn: () => api<{ items: CompetencyMaster[] }>('/v1/appraisal-competencies'), retry: retryTransient });
  const [editing, setEditing] = useState<string | null>(null);
  const data = shown(query);
  const current = data?.items.find((k) => k.id === editing) ?? null;
  return (
    <Section title="Competencies">
      {query.isPending && <LoadingLine>Loading competencies…</LoadingLine>}
      <QueryProblem error={query.error} forbidden="The selected role cannot view competencies." />
      {data && data.items.length === 0 && <Empty>No competencies yet.</Empty>}
      {data && data.items.length > 0 && (
        <Table aria-label="Competency master">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Code</TableHead>
              <TableHead scope="col">Competency</TableHead>
              <TableHead scope="col">Active</TableHead>
              <TableHead scope="col">Used in sets</TableHead>
              {can(CYCLE_MANAGE) && <TableHead scope="col">Change</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((k) => (
              <TableRow key={k.id}>
                <TableCell>{k.code}</TableCell>
                <TableCell>
                  {k.name}
                  <IndicatorList item={k} />
                </TableCell>
                <TableCell>
                  {formatDate(k.activeFrom)} to {k.activeTo ? formatDate(k.activeTo) : 'open'}
                  {k.activeToday ? '' : ' (not active today)'}
                </TableCell>
                <TableCell>{k.usedInSets}</TableCell>
                {can(CYCLE_MANAGE) && (
                  <RowActionsCell>
                    <RowActions>
                      <Button type="button" variant="outline" size="sm" aria-pressed={editing === k.id} onClick={() => setEditing(editing === k.id ? null : k.id)}>
                        Change {k.code}
                      </Button>
                    </RowActions>
                  </RowActionsCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {can(CYCLE_MANAGE) && current && <CompetencyForm key={`${current.id}:${current.version}`} initial={current} onDone={() => setEditing(null)} />}
      {can(CYCLE_MANAGE) && !current && <CompetencyForm key="new" initial={null} onDone={() => undefined} />}
    </Section>
  );
}

function CompetencyForm({ initial, onDone }: { initial: CompetencyMaster | null; onDone: () => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [indicators, setIndicators] = useState<string[]>(initial ? initial.indicators.map((i) => i.text) : ['', '', '', '', '']);
  const [activeFrom, setActiveFrom] = useState(initial?.activeFrom ?? '');
  const [activeTo, setActiveTo] = useState(initial?.activeTo ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      initial ? api<CompetencyMaster>(`/v1/appraisal-competencies/${initial.id}`, { method: 'PUT', body }) : api<CompetencyMaster>('/v1/appraisal-competencies', { body }),
    onSuccess: (k) => {
      setNotice(initial ? `Saved ${k.code}.` : `Added ${k.code}.`);
      if (!initial) {
        setCode('');
        setName('');
        setDescription('');
        setIndicators(['', '', '', '', '']);
        setActiveFrom('');
      }
      void qc.invalidateQueries({ queryKey: keys.competencies });
      if (initial) onDone();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'STALE_VERSION') void qc.invalidateQueries({ queryKey: keys.competencies });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    if (!initial && !code.trim()) return setProblem('Enter a code.');
    if (!name.trim()) return setProblem('Enter a name.');
    if (indicators.some((t) => !t.trim())) return setProblem('Describe each proficiency level 1 to 5.');
    if (!activeFrom) return setProblem('Enter the date the competency is active from.');
    setProblem(null);
    setNotice(null);
    const common = { name: name.trim(), description: description.trim() === '' ? null : description.trim(), indicators: indicators.map((t) => t.trim()), activeFrom };
    save.mutate(initial ? { ...common, activeTo: activeTo === '' ? null : activeTo, expectedVersion: initial.version } : { ...common, code: code.trim() });
  };
  const saveLabel = initial ? 'Save the competency' : 'Add the competency';
  return (
    <FormGrid aria-label={initial ? `Change ${initial.code}` : 'New competency'} onSubmit={submit} noValidate>
      <CardSubheading>{initial ? `Change ${initial.code}` : 'New competency'}</CardSubheading>
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
      <FormField className="col-span-full">
        Description (optional)
        <Textarea rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </FormField>
      {LEVELS.map((level, i) => (
        <FormField key={level} className="col-span-full">
          Level {level} behaviour
          <Textarea rows={2} maxLength={1000} value={indicators[i] ?? ''} onChange={(e) => setIndicators((prev) => prev.map((t, n) => (n === i ? e.target.value : t)))} />
        </FormField>
      ))}
      <FormField>
        Active from
        <Input type="date" value={activeFrom} onChange={(e) => setActiveFrom(e.target.value)} />
      </FormField>
      {initial && (
        <FormField>
          Active until (exclusive; empty: open)
          <Input type="date" value={activeTo} onChange={(e) => setActiveTo(e.target.value)} />
        </FormField>
      )}
      {problem && <Notice notice={{ text: problem, ok: false }} />}
      <Notice notice={notice ? { text: notice, ok: true } : null} />
      <ButtonRow>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : saveLabel}
        </Button>
      </ButtonRow>
      <Hint className="m-0">Appraisals keep the competencies as they were copied at enrolment; a change here applies to later enrolments only.</Hint>
      <Refusal error={save.error} action="competency" />
    </FormGrid>
  );
}

function useMasterList(kind: 'grades' | 'designations') {
  const { can } = useSession();
  const keys = useKeys();
  return useQuery({
    queryKey: kind === 'grades' ? keys.grades : keys.designations,
    queryFn: () => api<{ items: MasterItem[] }>(`/v1/org/${kind}`),
    enabled: can(ORG_READ),
    retry: retryTransient,
    staleTime: 5 * 60_000,
  });
}

function CompetencySetsSection() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: keys.competencySets, queryFn: () => api<{ items: CompetencySet[] }>('/v1/appraisal-competency-sets'), retry: retryTransient });
  const competencies = useQuery({ queryKey: keys.competencies, queryFn: () => api<{ items: CompetencyMaster[] }>('/v1/appraisal-competencies'), retry: retryTransient });
  const grades = useMasterList('grades');
  const designations = useMasterList('designations');
  const [gradeId, setGradeId] = useState('');
  const [designationId, setDesignationId] = useState('');
  const [from, setFrom] = useState('');
  const [rows, setRows] = useState<{ key: number; competencyId: string; weight: string }[]>([{ key: 1, competencyId: '', weight: '' }]);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ending, setEnding] = useState<{ id: string; date: string; reason: string } | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.config });
  };
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<CompetencySet>('/v1/appraisal-competency-sets', { body }),
    onSuccess: (s) => {
      setNotice(`Saved the set for ${s.grade.name}${s.designation ? ` (${s.designation.name})` : ''} from ${formatDate(s.effectiveFrom)}.`);
      setRows([{ key: 1, competencyId: '', weight: '' }]);
      setReason('');
      refresh();
    },
  });
  const end = useMutation({
    mutationFn: (p: { id: string; body: Record<string, unknown> }) => api<CompetencySet>(`/v1/appraisal-competency-sets/${p.id}/end`, { body: p.body }),
    onSuccess: (s) => {
      setNotice(`The set for ${s.grade.name} ends on ${s.effectiveTo ? formatDate(s.effectiveTo) : '—'}.`);
      setEnding(null);
      refresh();
    },
  });
  const data = shown(query);
  const choices = (shown(competencies)?.items ?? []).filter((k) => k.activeTo === null);
  const total = rows.reduce((t, r) => t + (wholeIn(r.weight, 1, 100) ? Number(r.weight) : 0), 0);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    if (!gradeId) return setProblem('Choose a grade.');
    if (!from) return setProblem('Enter the date the set starts.');
    if (rows.some((r) => !r.competencyId || !wholeIn(r.weight, 1, 100))) return setProblem('Choose a competency and a whole-number weight from 1 to 100 on every row.');
    if (total !== 100) return setProblem(`The weights total ${total}; they must total exactly 100.`);
    if (!reason.trim()) return setProblem('Enter a reason.');
    setProblem(null);
    setNotice(null);
    create.mutate({
      gradeId,
      ...(designationId ? { designationId } : {}),
      effectiveFrom: from,
      items: rows.map((r) => ({ competencyId: r.competencyId, weight: Number(r.weight) })),
      reason: reason.trim(),
    });
  };
  return (
    <Section title="Competency sets by grade">
      <Hint>
        Each set maps competencies, with weights totalling exactly 100, to a grade (optionally one designation, which then takes precedence). When an employee is enrolled, the set in force for their grade that day is copied
        into the appraisal and fixed.
      </Hint>
      {query.isPending && <LoadingLine>Loading the sets…</LoadingLine>}
      <QueryProblem error={query.error} forbidden="The selected role cannot view competency sets." />
      {data && data.items.length === 0 && <Empty>No competency sets yet: appraisals are scored on goals alone.</Empty>}
      {data && data.items.length > 0 && (
        <Table aria-label="Competency sets">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Grade</TableHead>
              <TableHead scope="col">Designation</TableHead>
              <TableHead scope="col">From</TableHead>
              <TableHead scope="col">Until</TableHead>
              <TableHead scope="col">Competencies (weight)</TableHead>
              {can(CYCLE_MANAGE) && <TableHead scope="col">End</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((s) => (
              <TableRow key={s.id}>
                <TableCell>{s.grade.name}</TableCell>
                <TableCell>{s.designation?.name ?? 'Any'}</TableCell>
                <TableCell>{formatDate(s.effectiveFrom)}</TableCell>
                <TableCell>{s.effectiveTo ? formatDate(s.effectiveTo) : 'Open'}</TableCell>
                <TableCell>{s.items.map((i) => `${i.name} (${i.weight})`).join(', ')}</TableCell>
                {can(CYCLE_MANAGE) && (
                  <RowActionsCell>
                    {s.effectiveTo === null && (
                      <RowActions>
                        <Button type="button" variant="danger" size="sm" onClick={() => setEnding({ id: s.id, date: '', reason: '' })}>
                          End the {s.grade.name} set
                        </Button>
                      </RowActions>
                    )}
                  </RowActionsCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Notice notice={notice ? { text: notice, ok: true } : null} />
      {can(CYCLE_MANAGE) && ending && (
        <FormGrid
          aria-label="End a competency set"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const s = data?.items.find((x) => x.id === ending.id);
            if (!s || !ending.date || !ending.reason.trim()) return;
            end.mutate({ id: s.id, body: { effectiveTo: ending.date, reason: ending.reason.trim(), expectedVersion: s.version } });
          }}
        >
          <FormField>
            Ends on
            <Input type="date" value={ending.date} onChange={(e) => setEnding({ ...ending, date: e.target.value })} />
          </FormField>
          <FormField className="col-span-full">
            Reason
            <Textarea rows={2} maxLength={1000} value={ending.reason} onChange={(e) => setEnding({ ...ending, reason: e.target.value })} />
          </FormField>
          <ButtonRow>
            <Button type="submit" disabled={end.isPending || !ending.date || !ending.reason.trim()}>
              {end.isPending ? 'Saving…' : 'End the set'}
            </Button>
            <Button type="button" variant="outline" onClick={() => setEnding(null)}>
              Keep it
            </Button>
          </ButtonRow>
          <Refusal error={end.error} action="competency-set" />
        </FormGrid>
      )}
      {can(CYCLE_MANAGE) && (
        <FormGrid aria-label="New competency set" onSubmit={submit} noValidate>
          <CardSubheading>New competency set</CardSubheading>
          {!can(ORG_READ) ? (
            <NotPermitted>The selected role cannot list grades and designations, so it cannot map a set.</NotPermitted>
          ) : (
            <>
              <FormField>
                Grade
                <NativeSelect value={gradeId} onChange={(e) => setGradeId(e.target.value)}>
                  <option value="">Choose…</option>
                  {(shown(grades)?.items ?? []).map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} ({g.code})
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField>
                Designation (optional)
                <NativeSelect value={designationId} onChange={(e) => setDesignationId(e.target.value)}>
                  <option value="">Any designation of the grade</option>
                  {(shown(designations)?.items ?? []).map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.code})
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
            </>
          )}
          <FormField>
            Starts on
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </FormField>
          {rows.map((r, i) => (
            <div className={cn(FIELD_ROW, 'col-span-full')} key={r.key}>
              <FormField className="w-auto">
                Competency {i + 1}
                <NativeSelect value={r.competencyId} onChange={(e) => setRows((prev) => prev.map((x) => (x.key === r.key ? { ...x, competencyId: e.target.value } : x)))}>
                  <option value="">Choose…</option>
                  {choices.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name} ({k.code})
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField className="w-auto">
                Weight of competency {i + 1}
                <Input inputMode="numeric" maxLength={3} value={r.weight} onChange={(e) => setRows((prev) => prev.map((x) => (x.key === r.key ? { ...x, weight: e.target.value } : x)))} />
              </FormField>
              {rows.length > 1 && (
                <Button type="button" variant="outline" onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}>
                  Remove competency {i + 1}
                </Button>
              )}
            </div>
          ))}
          <ButtonRow>
            <Button type="button" variant="outline" disabled={rows.length >= 50} onClick={() => setRows((prev) => [...prev, { key: prev.reduce((m, x) => Math.max(m, x.key), 0) + 1, competencyId: '', weight: '' }])}>
              Add a competency
            </Button>
            <Hint as="span" role="status">
              Weights entered: {total} of 100.
            </Hint>
          </ButtonRow>
          <FormField className="col-span-full">
            Reason
            <Textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          {problem && <Notice notice={{ text: problem, ok: false }} />}
          <ButtonRow>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Saving…' : 'Save the set'}
            </Button>
          </ButtonRow>
          <Hint className="m-0">It starts today or later and ends the set in force for the same grade and designation that day.</Hint>
          <Refusal error={create.error} action="competency-set" />
        </FormGrid>
      )}
    </Section>
  );
}
