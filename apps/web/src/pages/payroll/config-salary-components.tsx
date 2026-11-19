// Payroll configuration: the salary components of an arrangement (FR-029).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useRef, useState } from 'react';
import { api, type EmployeeHit, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Section } from '../../ui';
import { AMOUNT_BASIS, type ArrangementComponents, Choice, COMPONENT_KIND, SALARY_MANAGE, SALARY_READ, type SalaryArrangementRow, usePayComponents } from './config';
import { EmployeePicker, Missing, Note } from './pickers';
import { Problem, REFUSALS } from './problems';
import { Fact, GROUP, H3, label, MONEY, money, SCROLL, useKeys } from './shared';

// ---- Salary components of an arrangement (FR-029; salary master grants) ----

export function SalaryComponentsScreen() {
  const { can } = useSession();
  const [employee, setEmployee] = useState<EmployeeHit | null>(null);
  const [arrangementId, setArrangementId] = useState<string | null>(null);
  if (!can(SALARY_READ)) {
    return (
      <Section title="Salary components">
        <Empty>The selected role cannot see salary arrangements.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      <Section title="Salary components">
        <p className="hint">
          The pay components of an employee’s salary arrangement, exactly as recorded. They are set once, while the arrangement has none; a change is a new arrangement through
          the salary master. Nothing is added up or converted here.
        </p>
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
      {history.isPending && <p className="hint loading">Loading the salary arrangements…</p>}
      {history.error && <Problem error={history.error} act="read" />}
      {history.data && history.data.items.length === 0 && <Empty>{withheld ? 'The employee has no salary arrangement in force today or later.' : 'The employee has no salary arrangement yet.'}</Empty>}
      {history.data && history.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Salary arrangements">
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>Annual CTC</th>
                <th>Monthly gross</th>
                <th>Components</th>
              </tr>
            </thead>
            <tbody>
              {history.data.items.map((a) => (
                <tr key={a.id}>
                  <td>{formatDate(a.effectiveFrom)}</td>
                  <td>{a.effectiveTo ? formatDate(a.effectiveTo) : 'Open'}</td>
                  <td>{a.annualCtc !== undefined ? money(a.annualCtc, a.currency) : '—'}</td>
                  <td>{a.monthlyGross !== undefined ? money(a.monthlyGross, a.currency) : '—'}</td>
                  <td>
                    {chosen === a.id ? (
                      'Shown below'
                    ) : (
                      <button type="button" className="link" onClick={() => onChoose(a.id)} aria-label={`Show the components of the arrangement from ${formatDate(a.effectiveFrom)}`}>
                        Show components
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {withheld && <p className="hint">Earlier arrangements are not shown: the selected role has no salary history grant.</p>}
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
      {view.isPending && <p className="hint loading">Loading the components…</p>}
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
            <div style={SCROLL}>
              <table aria-label="Salary components">
                <thead>
                  <tr>
                    <th>Component</th>
                    <th>Kind</th>
                    <th>Basis</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {a.components.map((c) => (
                    <tr key={c.componentCode}>
                      <td>{`${c.componentCode} · ${c.componentName}`}</td>
                      <td>{label(COMPONENT_KIND, c.componentKind)}</td>
                      <td>{label(AMOUNT_BASIS, c.basis)}</td>
                      <td>{money(c.amount, a.currencyCode)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {a.totals.length > 0 && (
            <div style={SCROLL}>
              <table aria-label="Component totals as returned">
                <thead>
                  <tr>
                    <th>Basis</th>
                    <th>Kind</th>
                    <th>Total (as returned; no reconciliation rule is assumed)</th>
                  </tr>
                </thead>
                <tbody>
                  {a.totals.map((t) => (
                    <tr key={`${t.basis}-${t.componentKind}`}>
                      <td>{label(AMOUNT_BASIS, t.basis)}</td>
                      <td>{label(COMPONENT_KIND, t.componentKind)}</td>
                      <td>{money(t.total, a.currencyCode)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {a.components.length > 0 && <p className="hint">Set once: a change is a new salary arrangement through the salary master.</p>}
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
    <form onSubmit={submit} aria-label="Set the salary components" className="grid-form" style={{ marginTop: '0.75rem' }}>
      <h3 style={H3} className="wide">
        Set the salary components
      </h3>
      <p className="hint wide">{`Amounts in ${currency}, exactly as written. ${REFUSALS.COMPONENT_BASIS_NOT_MONTHLY}`}</p>
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
          <fieldset key={l.key} className="wide grid-form" style={GROUP}>
            <legend>{`Line ${i + 1}`}</legend>
            <label>
              {`Pay component code (line ${i + 1})`}
              <input value={l.componentCode} onChange={(e) => patch(l.key, { componentCode: e.target.value })} list={listId} maxLength={40} autoComplete="off" />
            </label>
            <label>
              {`Amount (line ${i + 1})`}
              <input value={l.amount} onChange={(e) => patch(l.key, { amount: e.target.value })} inputMode="decimal" maxLength={20} autoComplete="off" />
            </label>
            <Choice label={`Amount basis (line ${i + 1})`} value={l.basis} onChange={(v) => patch(l.key, { basis: v })} options={AMOUNT_BASIS} />
            {lines.length > 1 && (
              <div className="row">
                <button type="button" className="secondary" onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))} aria-label={`Remove line ${i + 1}`}>
                  Remove
                </button>
              </div>
            )}
            {annualFixed && (
              <p className="error wide" role="note">
                {`Line ${i + 1}: the head in effect for ${l.componentCode.trim().toUpperCase()} is fixed. ${REFUSALS.COMPONENT_BASIS_NOT_MONTHLY}`}
              </p>
            )}
          </fieldset>
        );
      })}
      <div className="row">
        <button type="button" className="secondary" onClick={() => setLines((prev) => [...prev, blank()])} disabled={lines.length >= 100}>
          Add a line
        </button>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Set the components'}
        </button>
      </div>
      <Missing text={problem} />
    </form>
  );
}
