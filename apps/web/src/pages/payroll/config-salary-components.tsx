// Payroll configuration: the salary components of an arrangement (FR-029).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlertIcon } from 'lucide-react';
import { type FormEvent, useId, useRef, useState } from 'react';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, type EmployeeHit, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Section } from '../../ui';
import { AMOUNT_BASIS, type ArrangementComponents, Choice, COMPONENT_KIND, SALARY_MANAGE, SALARY_READ, type SalaryArrangementRow, usePayComponents } from './config';
import { EmployeePicker, Missing, Note } from './pickers';
import { Problem, REFUSALS } from './problems';
import { Fact, label, MONEY, money, useKeys } from './shared';

// ---- Salary components of an arrangement (FR-029; salary master grants) ----

export function SalaryComponentsScreen() {
  const { can } = useSession();
  const [employee, setEmployee] = useState<EmployeeHit | null>(null);
  const [arrangementId, setArrangementId] = useState<string | null>(null);
  if (!can(SALARY_READ)) {
    return (
      <Section title="Salary components">
        <Empty refusal>The selected role cannot see salary arrangements.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      <Section title="Salary components">
        <Hint>
          The pay components of an employee’s salary arrangement, exactly as recorded. They are set once, while the arrangement has none; a change is a new arrangement through
          the salary master. Nothing is added up or converted here.
        </Hint>
        <EmployeePicker
          title="Employee"
          value={employee}
          onChange={(e) => {
            setEmployee(e);
            setArrangementId(null);
          }}
        />
        {employee && <ArrangementList key={employee.id} employeeId={employee.id} chosen={arrangementId} onChoose={setArrangementId} />}
      </Section>
      {arrangementId && <ArrangementComponentsView key={arrangementId} arrangementId={arrangementId} />}
    </div>
  );
}

function ArrangementList({ employeeId, chosen, onChoose }: { employeeId: string; chosen: string | null; onChoose: (id: string) => void }) {
  const keys = useKeys();
  const history = useQuery({
    queryKey: keys.salaryHistory(employeeId),
    queryFn: () => api<{ items: SalaryArrangementRow[]; historyIncluded?: boolean }>(`/v1/employees/${encodeURIComponent(employeeId)}/salary`),
    retry: retryTransient,
  });
  // I-68: without the history grant the server sends only what is in force today and later, so an empty list does not mean none ever existed.
  const withheld = history.data?.historyIncluded === false;
  return (
    <>
      {history.isPending && <LoadingLine>Loading the salary arrangements…</LoadingLine>}
      {history.error && <Problem error={history.error} act="read" />}
      {history.data && history.data.items.length === 0 && <Empty>{withheld ? 'The employee has no salary arrangement in force today or later.' : 'The employee has no salary arrangement yet.'}</Empty>}
      {history.data && history.data.items.length > 0 && (
        <Table aria-label="Salary arrangements">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">From</TableHead>
              <TableHead scope="col">To</TableHead>
              <TableHead scope="col">Annual CTC</TableHead>
              <TableHead scope="col">Monthly gross</TableHead>
              <TableHead scope="col">Components</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.data.items.map((a) => (
              <TableRow key={a.id}>
                <TableCell>{formatDate(a.effectiveFrom)}</TableCell>
                <TableCell>{a.effectiveTo ? formatDate(a.effectiveTo) : 'Open'}</TableCell>
                <TableCell>{a.annualCtc !== undefined ? money(a.annualCtc, a.currency) : '—'}</TableCell>
                <TableCell>{a.monthlyGross !== undefined ? money(a.monthlyGross, a.currency) : '—'}</TableCell>
                <RowActionsCell>
                  {chosen === a.id ? (
                    'Shown below'
                  ) : (
                    <RowActions>
                      <Button type="button" variant="outline" size="sm" onClick={() => onChoose(a.id)} aria-label={`Show the components of the arrangement from ${formatDate(a.effectiveFrom)}`}>
                        Show components
                      </Button>
                    </RowActions>
                  )}
                </RowActionsCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {withheld && <Hint>Earlier arrangements are not shown: the selected role has no salary history grant.</Hint>}
    </>
  );
}

type ComponentLineInput = { componentCode: string; amount: string; basis: string };

function ArrangementComponentsView({ arrangementId }: { arrangementId: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const path = `/v1/payroll/salary-arrangements/${encodeURIComponent(arrangementId)}/components`;
  const view = useQuery({ queryKey: keys.salaryComponents(arrangementId), queryFn: () => api<ArrangementComponents>(path), retry: retryTransient });
  const [note, setNote] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (components: ComponentLineInput[]) => api<ArrangementComponents>(path, { body: { components } }),
    onSuccess: () => setNote('The salary components are set. They are fixed now: a change is a new salary arrangement.'),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.salaryComponents(arrangementId) }),
  });
  const a = view.data;
  return (
    <Section title="Components of the arrangement">
      {view.isPending && <LoadingLine>Loading the components…</LoadingLine>}
      {view.error && <Problem error={view.error} act="salary-components" />}
      <Note text={note} />
      {a && (
        <>
          <dl className="kv">
            <Fact term="From">{formatDate(a.effectiveFrom)}</Fact>
            <Fact term="To">{a.effectiveTo ? formatDate(a.effectiveTo) : 'Open'}</Fact>
            {a.annualCtc !== undefined && <Fact term="Annual CTC">{money(a.annualCtc, a.currencyCode)}</Fact>}
            {a.monthlyGross !== undefined && <Fact term="Monthly gross">{money(a.monthlyGross, a.currencyCode)}</Fact>}
          </dl>
          {a.components.length === 0 && <Empty>No salary components are set for this arrangement, so its payroll calculation is blocked until they are.</Empty>}
          {a.components.length > 0 && (
            <Table aria-label="Salary components">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Component</TableHead>
                  <TableHead scope="col">Kind</TableHead>
                  <TableHead scope="col">Basis</TableHead>
                  <TableHead scope="col">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {a.components.map((c) => (
                  <TableRow key={c.componentCode}>
                    <TableCell>{`${c.componentCode} · ${c.componentName}`}</TableCell>
                    <TableCell>{label(COMPONENT_KIND, c.componentKind)}</TableCell>
                    <TableCell>{label(AMOUNT_BASIS, c.basis)}</TableCell>
                    <TableCell>{money(c.amount, a.currencyCode)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {a.totals.length > 0 && (
            <Table aria-label="Component totals as returned">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Basis</TableHead>
                  <TableHead scope="col">Kind</TableHead>
                  <TableHead scope="col">Total (as returned; no reconciliation rule is assumed)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {a.totals.map((t) => (
                  <TableRow key={`${t.basis}-${t.componentKind}`}>
                    <TableCell>{label(AMOUNT_BASIS, t.basis)}</TableCell>
                    <TableCell>{label(COMPONENT_KIND, t.componentKind)}</TableCell>
                    <TableCell>{money(t.total, a.currencyCode)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {a.components.length > 0 && <Hint>Set once: a change is a new salary arrangement through the salary master.</Hint>}
          {a.components.length === 0 && can(SALARY_MANAGE) && (
            <SalaryComponentsForm
              currency={a.currencyCode}
              busy={save.isPending}
              onSend={(lines) => {
                setNote(null);
                return save.mutateAsync(lines);
              }}
            />
          )}
        </>
      )}
      <Problem error={save.error} act="salary-components" />
    </Section>
  );
}

interface ComponentLineDraft extends ComponentLineInput {
  key: number;
}

/**
 * What the server would refuse about a line, said beside it before anything is sent: in the error colours, but a note, not an alert
 * (nothing has failed yet, and the form keeps its one alert for what stops it being sent).
 */
function LineWarning({ text }: { text: string }) {
  return (
    <Alert asChild variant="destructive">
      <p className="error" role="note">
        <CircleAlertIcon aria-hidden="true" />
        {text}
      </p>
    </Alert>
  );
}

function SalaryComponentsForm({ currency, busy, onSend }: { currency: string; busy: boolean; onSend: (lines: ComponentLineInput[]) => Promise<unknown> }) {
  const components = usePayComponents();
  const listId = useId();
  const next = useRef(1);
  const blank = (): ComponentLineDraft => ({ key: next.current++, componentCode: '', amount: '', basis: '' });
  const [lines, setLines] = useState<ComponentLineDraft[]>(() => [blank()]);
  const [problem, setProblem] = useState<string | null>(null);
  const byCode = new Map((components.data?.items ?? []).map((c) => [c.code, c]));
  const patch = (key: number, p: Partial<ComponentLineInput>) => setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    for (const [i, l] of lines.entries()) {
      if (!l.componentCode.trim()) return setProblem(`Give the pay component of line ${i + 1}.`);
      if (!MONEY.test(l.amount.trim())) return setProblem(`Give the amount of line ${i + 1} as a decimal number with at most four decimals.`);
      if (!l.basis) return setProblem(`Choose whether the amount of line ${i + 1} is monthly or annual.`);
    }
    setProblem(null);
    onSend(lines.map((l) => ({ componentCode: l.componentCode.trim().toUpperCase(), amount: l.amount.trim(), basis: l.basis }))).then(
      () => setLines([blank()]),
      () => undefined,
    );
  };
  return (
    <FormGrid onSubmit={submit} aria-label="Set the salary components">
      <CardSubheading>Set the salary components</CardSubheading>
      <Hint>{`Amounts in ${currency}, exactly as written. ${REFUSALS.COMPONENT_BASIS_NOT_MONTHLY}`}</Hint>
      <datalist id={listId}>
        {(components.data?.items ?? [])
          .filter((c) => c.active)
          .map((c) => (
            <option key={c.id} value={c.code}>
              {c.name}
            </option>
          ))}
      </datalist>
      {lines.map((l, i) => {
        const head = byCode.get(l.componentCode.trim().toUpperCase())?.headInEffect;
        const annualFixed = l.basis === 'ANNUAL' && head?.inUse === true && head.calculationBasis === 'FIXED';
        return (
          // Each line is a grid of its own fields, as a form grid is (the old `fieldset.grid-form`).
          <FormGrid key={l.key} asChild>
            <FieldSet>
              <legend>{`Line ${i + 1}`}</legend>
              <FormField>
                {`Pay component code (line ${i + 1})`}
                <Input value={l.componentCode} onChange={(e) => patch(l.key, { componentCode: e.target.value })} list={listId} maxLength={40} autoComplete="off" />
              </FormField>
              <FormField>
                {`Amount (line ${i + 1})`}
                <Input value={l.amount} onChange={(e) => patch(l.key, { amount: e.target.value })} inputMode="decimal" maxLength={20} autoComplete="off" />
              </FormField>
              <Choice label={`Amount basis (line ${i + 1})`} value={l.basis} onChange={(v) => patch(l.key, { basis: v })} options={AMOUNT_BASIS} />
              {lines.length > 1 && (
                <ButtonRow>
                  <Button type="button" variant="outline" onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))} aria-label={`Remove line ${i + 1}`}>
                    Remove
                  </Button>
                </ButtonRow>
              )}
              {annualFixed && <LineWarning text={`Line ${i + 1}: the head in effect for ${l.componentCode.trim().toUpperCase()} is fixed. ${REFUSALS.COMPONENT_BASIS_NOT_MONTHLY}`} />}
            </FieldSet>
          </FormGrid>
        );
      })}
      <ButtonRow>
        <Button type="button" variant="outline" onClick={() => setLines((prev) => [...prev, blank()])} disabled={lines.length >= 100}>
          Add a line
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Set the components'}
        </Button>
      </ButtonRow>
      <Missing text={problem} />
    </FormGrid>
  );
}
