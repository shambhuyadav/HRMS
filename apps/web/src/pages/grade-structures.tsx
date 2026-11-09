// Grade salary structures and CTC categories (FR-028, FR-029; E08; I-80, decided under owner delegation, 6 Nov 2026). A structure turns
// an annual CTC into monthly components for a grade, from a start date: one person drafts it and another activates it. The server
// derives and checks every amount; this screen shows the rules as returned and never calculates.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, formatDate } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Empty, ErrorNote, Section, StateBadge } from '../ui';

const CONFIG_READ = 'payroll_config.read.operational';
const CONFIG_MANAGE = 'payroll_config.manage.operational';
const CONFIG_ACTIVATE = 'payroll_config.activate.operational';

interface Line {
  sequence: number;
  componentCode: string;
  method: string;
  percent: string | null;
  baseComponentCode: string | null;
  amount: string | null;
}
interface Structure {
  id: string;
  revision: number;
  gradeCode: string;
  gradeName: string;
  effectiveFrom: string;
  currencyCode: string;
  state: string;
  createdBy: string;
  version: number;
  lines: Line[];
}
interface Category {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

/** How one line reads: "GS_HRA: 50% of GS_BASIC". */
export const describeLine = (l: Line) =>
  l.method === 'PERCENT_OF_CTC'
    ? `${l.componentCode}: ${Number(l.percent)}% of monthly CTC`
    : l.method === 'PERCENT_OF_COMPONENT'
      ? `${l.componentCode}: ${Number(l.percent)}% of ${l.baseComponentCode}`
      : l.method === 'FIXED_MONTHLY'
        ? `${l.componentCode}: fixed ${l.amount} a month`
        : `${l.componentCode}: the balance of the monthly CTC`;

/** One line per component, as typed: "CODE PCT 40", "CODE PCT_OF BASE 50", "CODE FIXED 1600" or "CODE BALANCE". */
export function parseLines(text: string) {
  return text
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p[0])
    .map(([componentCode = '', kind = '', a, b]) =>
      kind === 'PCT'
        ? { componentCode, method: 'PERCENT_OF_CTC', percent: a ?? '' }
        : kind === 'PCT_OF'
          ? { componentCode, method: 'PERCENT_OF_COMPONENT', baseComponentCode: a ?? '', percent: b ?? '' }
          : kind === 'FIXED'
            ? { componentCode, method: 'FIXED_MONTHLY', amount: a ?? '' }
            : { componentCode, method: 'BALANCE' },
    );
}

function StructureForm({ onDone }: { onDone: () => void }) {
  const [gradeCode, setGradeCode] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [currencyCode, setCurrencyCode] = useState('INR');
  const [lines, setLines] = useState('');
  const create = useMutation({
    mutationFn: () => api<Structure>('/v1/payroll/grade-structures', { body: { gradeCode: gradeCode.trim(), effectiveFrom, currencyCode: currencyCode.trim(), lines: parseLines(lines) } }),
    onSuccess: () => onDone(),
  });
  const ready = gradeCode.trim() && effectiveFrom && currencyCode.trim() && lines.trim();
  return (
    <form
      className="stack"
      aria-label="New grade salary structure"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !create.isPending) create.mutate();
      }}
    >
      <p className="hint">
        One line per component, in order: CODE PCT 40 (percent of the monthly CTC), CODE PCT_OF BASE 50 (percent of an earlier line), CODE FIXED 1600 (a fixed monthly amount) or CODE BALANCE (exactly one earning that
        takes what is left). Lines are earnings, reimbursements or employer contributions on fixed heads.
      </p>
      <label>
        Grade code
        <input value={gradeCode} onChange={(e) => setGradeCode(e.target.value)} />
      </label>
      <label>
        Effective from
        <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
      </label>
      <label>
        Currency
        <input value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value.toUpperCase())} />
      </label>
      <label>
        Lines
        <textarea rows={6} value={lines} onChange={(e) => setLines(e.target.value)} />
      </label>
      <ErrorNote error={create.error} />
      <button type="submit" disabled={!ready || create.isPending}>
        Save as draft
      </button>
    </form>
  );
}

function CategoryForm({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const create = useMutation({ mutationFn: () => api<Category>('/v1/payroll/ctc-categories', { body: { code: code.trim(), name: name.trim() } }), onSuccess: () => onDone() });
  return (
    <form
      className="row"
      aria-label="New CTC category"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim() && name.trim() && !create.isPending) create.mutate();
      }}
    >
      <label>
        Code
        <input value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <ErrorNote error={create.error} />
      <button type="submit" disabled={!code.trim() || !name.trim() || create.isPending}>
        Add category
      </button>
    </form>
  );
}

function GradeStructuresScreen() {
  const { can, me } = useSession();
  const qc = useQueryClient();
  const structures = useQuery({ queryKey: ['grade-structures'], queryFn: () => api<{ items: Structure[] }>('/v1/payroll/grade-structures') });
  const categories = useQuery({ queryKey: ['ctc-categories'], queryFn: () => api<{ items: Category[] }>('/v1/payroll/ctc-categories') });
  const activate = useMutation({
    mutationFn: (s: Structure) => api<Structure>(`/v1/payroll/grade-structures/${encodeURIComponent(s.id)}/activate`, { body: { expectedVersion: s.version } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['grade-structures'] }),
  });
  return (
    <div className="stack">
      <Section title="Grade salary structures">
        <p className="hint">
          The active structure in force for an employee's grade on a salary's start date sets that salary's components from its annual CTC; the salary is refused if its components or monthly gross differ.
          Monthly gross is the earnings and reimbursements; employer contributions are part of CTC but not of gross.
        </p>
        <ErrorNote error={structures.error ?? activate.error} />
        {structures.data?.items.length === 0 && <Empty>No grade salary structure yet: salary components are entered as they are.</Empty>}
        {structures.data?.items.map((s) => (
          <div className="card" key={s.id} aria-label={`Structure ${s.gradeCode} revision ${s.revision}`}>
            <strong>{`${s.gradeName} (${s.gradeCode}), revision ${s.revision}, from ${formatDate(s.effectiveFrom)}, ${s.currencyCode} `}</strong>
            <StateBadge state={s.state} />
            <ol>
              {s.lines.map((l) => (
                <li key={l.sequence}>{describeLine(l)}</li>
              ))}
            </ol>
            {s.state === 'DRAFT' && can(CONFIG_ACTIVATE) && s.createdBy !== me?.userId && (
              <button type="button" className="secondary" onClick={() => activate.mutate(s)} disabled={activate.isPending}>
                Activate
              </button>
            )}
          </div>
        ))}
      </Section>
      {can(CONFIG_MANAGE) && (
        <Section title="Draft a grade salary structure">
          <StructureForm onDone={() => void qc.invalidateQueries({ queryKey: ['grade-structures'] })} />
        </Section>
      )}
      <Section title="CTC categories">
        <p className="hint">A name for a kind of CTC, recorded on a salary when it is made and used to filter the salary master. It changes no amount.</p>
        <ErrorNote error={categories.error} />
        {categories.data?.items.length === 0 && <Empty>No CTC category yet.</Empty>}
        {categories.data && categories.data.items.length > 0 && (
          <ul aria-label="CTC categories">
            {categories.data.items.map((c) => (
              <li key={c.id}>{`${c.code}: ${c.name}${c.active ? '' : ' (inactive)'}`}</li>
            ))}
          </ul>
        )}
        {can(CONFIG_MANAGE) && <CategoryForm onDone={() => void qc.invalidateQueries({ queryKey: ['ctc-categories'] })} />}
      </Section>
      <ExternalDeductionsSection />
    </div>
  );
}

interface ExternalDeduction {
  id: string;
  externalCode: string;
  name: string;
  componentCode: string;
  effectiveFrom: string;
  reason: string;
  state: string;
  createdBy: string;
  version: number;
}

/** FR-028 (I-91): outside deduction codes mapped, from a date, to a DEDUCTION input head; drafted by one person, activated by another. */
function ExternalDeductionsSection() {
  const { can, me } = useSession();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['external-deductions'], queryFn: () => api<{ items: ExternalDeduction[] }>('/v1/payroll/external-deductions') });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['external-deductions'] });
  const decide = useMutation({
    mutationFn: (v: { m: ExternalDeduction; action: 'ACTIVATE' | 'RETIRE' | 'CANCEL' }) =>
      api(`/v1/payroll/external-deductions/${encodeURIComponent(v.m.id)}/decision`, { body: { action: v.action, expectedVersion: v.m.version } }),
    onSuccess: refresh,
  });
  const [form, setForm] = useState({ externalCode: '', name: '', componentCode: '', effectiveFrom: '', reason: '' });
  const add = useMutation({ mutationFn: () => api('/v1/payroll/external-deductions', { body: form }), onSuccess: refresh });
  const ready = Object.values(form).every((v) => v.trim() !== '');
  const field = (key: keyof typeof form, label: string, type = 'text') => (
    <label>
      {label}
      <input type={type} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </label>
  );
  return (
    <Section title="External deduction codes">
      <p className="hint">
        An outside party's code (canteen, society, insurance) maps to a deduction from a date. Payroll inputs may name the code instead of the component; an unknown, unmapped or retired code is refused, never
        defaulted.
      </p>
      <ErrorNote error={list.error ?? decide.error ?? add.error} />
      {list.data?.items.length === 0 && <Empty>No external deduction code yet.</Empty>}
      {list.data && list.data.items.length > 0 && (
        <ul aria-label="External deduction codes">
          {list.data.items.map((m) => (
            <li key={m.id}>
              {`${m.externalCode} (${m.name}) → ${m.componentCode} from ${formatDate(m.effectiveFrom)} `}
              <StateBadge state={m.state} />
              {can(CONFIG_ACTIVATE) && m.state === 'DRAFT' && m.createdBy !== me?.userId && (
                <button type="button" className="secondary" onClick={() => decide.mutate({ m, action: 'ACTIVATE' })} disabled={decide.isPending}>
                  Activate
                </button>
              )}
              {can(CONFIG_ACTIVATE) && m.state === 'ACTIVE' && (
                <button type="button" className="secondary" onClick={() => decide.mutate({ m, action: 'RETIRE' })} disabled={decide.isPending}>
                  Retire
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {can(CONFIG_MANAGE) && (
        <form
          className="stack"
          aria-label="Map an external deduction code"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !add.isPending) add.mutate();
          }}
        >
          {field('externalCode', 'External code')}
          {field('name', 'Name')}
          {field('componentCode', 'Deduction component code')}
          {field('effectiveFrom', 'Effective from', 'date')}
          {field('reason', 'Reason')}
          <button type="submit" disabled={!ready || add.isPending}>
            Save as draft
          </button>
        </form>
      )}
    </Section>
  );
}

export const GRADE_STRUCTURE_SCREENS: ScreenRoute[] = [
  { path: '/payroll/grade-structures', title: 'Grade salary structures', permission: CONFIG_READ, nav: true, component: GradeStructuresScreen },
];
