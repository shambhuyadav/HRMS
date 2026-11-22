// Grade salary structures and CTC categories (FR-028, FR-029; E08; I-80, decided under owner delegation, 6 Nov 2026). A structure turns
// an annual CTC into monthly components for a grade, from a start date: one person drafts it and another activates it. The server
// derives and checks every amount; this screen shows the rules as returned and never calculates.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentPropsWithoutRef, useState } from 'react';
import { FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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

// The screen's own layout pieces, as utility classes and small components (shadcn/ui move, 20 Nov 2026).
/** A small action after the words of a list item (Activate, Retire), set apart from them and from each other. */
const ITEM_BUTTON = 'ml-2';
/** A list item that ends in actions: a little room above and below, so its buttons do not crowd the next item. */
const ITEM_WITH_ACTIONS = 'py-1';

/**
 * One structure: a card inside the list's card. It keeps the `card` marker class, so whatever it holds is drawn as a card's own, as
 * it was before the move to shadcn/ui.
 */
function StructureCard(props: ComponentPropsWithoutRef<'div'>) {
  return <div className="card rounded-xl border border-border bg-card px-5 py-4 shadow-xs not-last:mb-3" {...props} />;
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
    <FormGrid
      aria-label="New grade salary structure"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !create.isPending) create.mutate();
      }}
    >
      <Hint>
        One line per component, in order: CODE PCT 40 (percent of the monthly CTC), CODE PCT_OF BASE 50 (percent of an earlier line), CODE FIXED 1600 (a fixed monthly amount) or CODE BALANCE (exactly one earning that
        takes what is left). Lines are earnings, reimbursements or employer contributions on fixed heads.
      </Hint>
      <FormField>
        Grade code
        <Input value={gradeCode} onChange={(e) => setGradeCode(e.target.value)} />
      </FormField>
      <FormField>
        Effective from
        <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
      </FormField>
      <FormField>
        Currency
        <Input value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value.toUpperCase())} />
      </FormField>
      <FormField className="col-span-full">
        Lines
        <Textarea rows={6} value={lines} onChange={(e) => setLines(e.target.value)} />
      </FormField>
      <ErrorNote error={create.error} />
      <Button type="submit" disabled={!ready || create.isPending}>
        Save as draft
      </Button>
    </FormGrid>
  );
}

function CategoryForm({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const create = useMutation({ mutationFn: () => api<Category>('/v1/payroll/ctc-categories', { body: { code: code.trim(), name: name.trim() } }), onSuccess: () => onDone() });
  return (
    <FormGrid
      aria-label="New CTC category"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim() && name.trim() && !create.isPending) create.mutate();
      }}
    >
      <FormField>
        Code
        <Input value={code} onChange={(e) => setCode(e.target.value)} />
      </FormField>
      <FormField>
        Name
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </FormField>
      <ErrorNote error={create.error} />
      <Button type="submit" disabled={!code.trim() || !name.trim() || create.isPending}>
        Add category
      </Button>
    </FormGrid>
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
    <div className="flex flex-col gap-3">
      <Section title="Grade salary structures">
        <Hint>
          The active structure in force for an employee's grade on a salary's start date sets that salary's components from its annual CTC; the salary is refused if its components or monthly gross differ.
          Monthly gross is the earnings and reimbursements; employer contributions are part of CTC but not of gross.
        </Hint>
        <ErrorNote error={structures.error ?? activate.error} />
        {structures.data?.items.length === 0 && <Empty>No grade salary structure yet: salary components are entered as they are.</Empty>}
        {structures.data?.items.map((s) => (
          <StructureCard key={s.id} aria-label={`Structure ${s.gradeCode} revision ${s.revision}`}>
            <strong>{`${s.gradeName} (${s.gradeCode}), revision ${s.revision}, from ${formatDate(s.effectiveFrom)}, ${s.currencyCode} `}</strong>
            <StateBadge state={s.state} />
            <ol>
              {s.lines.map((l) => (
                <li key={l.sequence}>{describeLine(l)}</li>
              ))}
            </ol>
            {s.state === 'DRAFT' && can(CONFIG_ACTIVATE) && s.createdBy !== me?.userId && (
              <Button type="button" variant="outline" onClick={() => activate.mutate(s)} disabled={activate.isPending}>
                Activate
              </Button>
            )}
          </StructureCard>
        ))}
      </Section>
      {can(CONFIG_MANAGE) && (
        <Section title="Draft a grade salary structure">
          <StructureForm onDone={() => void qc.invalidateQueries({ queryKey: ['grade-structures'] })} />
        </Section>
      )}
      <Section title="CTC categories">
        <Hint>A name for a kind of CTC, recorded on a salary when it is made and used to filter the salary master. It changes no amount.</Hint>
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
    <FormField>
      {label}
      <Input type={type} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </FormField>
  );
  return (
    <Section title="External deduction codes">
      <Hint>
        An outside party's code (canteen, society, insurance) maps to a deduction from a date. Payroll inputs may name the code instead of the component; an unknown, unmapped or retired code is refused, never
        defaulted.
      </Hint>
      <ErrorNote error={list.error ?? decide.error ?? add.error} />
      {list.data?.items.length === 0 && <Empty>No external deduction code yet.</Empty>}
      {list.data && list.data.items.length > 0 && (
        <ul aria-label="External deduction codes">
          {list.data.items.map((m) => (
            <li key={m.id} className={ITEM_WITH_ACTIONS}>
              {`${m.externalCode} (${m.name}) → ${m.componentCode} from ${formatDate(m.effectiveFrom)} `}
              <StateBadge state={m.state} />
              {can(CONFIG_ACTIVATE) && m.state === 'DRAFT' && m.createdBy !== me?.userId && (
                <Button type="button" variant="outline" size="sm" className={ITEM_BUTTON} onClick={() => decide.mutate({ m, action: 'ACTIVATE' })} disabled={decide.isPending}>
                  Activate
                </Button>
              )}
              {can(CONFIG_ACTIVATE) && m.state === 'ACTIVE' && (
                <Button type="button" variant="danger" size="sm" className={ITEM_BUTTON} onClick={() => decide.mutate({ m, action: 'RETIRE' })} disabled={decide.isPending}>
                  Retire
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {can(CONFIG_MANAGE) && (
        <FormGrid
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
          <Button type="submit" disabled={!ready || add.isPending}>
            Save as draft
          </Button>
        </FormGrid>
      )}
    </Section>
  );
}

export const GRADE_STRUCTURE_SCREENS: ScreenRoute[] = [
  { path: '/payroll/grade-structures', title: 'Grade salary structures', permission: CONFIG_READ, nav: true, component: GradeStructuresScreen },
];
