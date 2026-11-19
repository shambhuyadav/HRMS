// FR-029 / FR-089 / FR-090 / DF14: one employee's salary arrangements, increment history and annual growth.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { api, ApiError, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, Item, Section } from '../../ui';
import { EmployeePicker } from './off-cycle';
import { type AnnualGrowth, answered, BASES, type Basis, basisLabel, CURRENCY, currentFinancialYear, DecisionInboxLink, FLUSH, H3, H4, type HistoryItem, type InitialSalaryBody, LoadProblem, money, moneyProblem, PANEL, percent, type PickedEmployee, type ProposalResult, PROPOSE, READ_HISTORY, SALARY_MANAGE, SALARY_READ, type SalaryArrangement, SCROLL, TEXTAREA, useKeys, useReloadCases, YEAR, YEAR_INPUT } from './shared';

// ---------------------------------------------------------------------------------------------------------
// FR-029 / FR-089 / FR-090 / DF14: one employee's salary arrangements, increment history and annual growth.
// Each part needs its own confidential grant; the server re-checks every request.
// ---------------------------------------------------------------------------------------------------------

export function SalaryPanel({ employee, onEmployee, focusRequest }: { employee: PickedEmployee | null; onEmployee: (employee: PickedEmployee | null) => void; focusRequest: number }) {
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusRequest > 0) region.current?.focus();
  }, [focusRequest]);
  return (
    <div ref={region} role="region" aria-label="Employee salary panel" tabIndex={-1}>
      <Section title="Employee salary">
        <p className="hint">Salary figures are confidential: each part below appears only with its own salary grant in the selected role.</p>
        <EmployeePicker label="Find employee to view salary" selected={employee} onSelect={onEmployee} />
        {employee && <EmployeeSalary key={employee.id} employee={employee} />}
      </Section>
    </div>
  );
}

/** Refusals of a correction in plain words; any other is shown as the server sent it. */
const CORRECTION_REFUSALS: Readonly<Record<string, string>> = {
  PAYROLL_PROCESSED: 'Payroll has been processed for this period, and processed payroll never changes. Correcting it needs an arrears case, which is not available yet. A change from a later date is an off-cycle case.',
  PAYROLL_IN_PROGRESS: 'A payroll run has already calculated this period. Revise or cancel that run first.',
  NOT_LATEST_CHANGE: 'Only the latest salary change can be corrected, and a later one exists.',
  ALREADY_CORRECTED: 'This change has already been corrected. Correct the correction instead.',
  CORRECTION_PENDING: 'A correction of this change is already waiting for a decision.',
  NO_CHANGE: 'The correction changes nothing.',
  INVALID_EFFECTIVE_DATE: 'The correction must take effect after the salary it replaces began.',
  NO_ELIGIBLE_REVIEWER: 'No independent reviewer is available, so this cannot be sent. Someone other than you must decide it.',
};

/** BR-038, DF14: a correction is its own case, decided independently; the record it corrects stays on file. */
function CorrectionForm({ item, onSent, onCancel }: { item: HistoryItem; onSent: () => void; onCancel: () => void }) {
  const [form, setForm] = useState({ effectiveDate: '', monthlyGross: '', annualCtc: '', reason: '' });
  const [problem, setProblem] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: (body: { effectiveDate: string; proposedAmount: string; proposedCounterpart: string; reason: string }) =>
      api<ProposalResult>(`/v1/increment-history/${encodeURIComponent(item.id ?? '')}/corrections`, { body }),
    onSuccess: onSent,
  });
  const refusal = send.error instanceof ApiError ? CORRECTION_REFUSALS[send.error.code] : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = form.reason.trim();
    const missing = (form.effectiveDate === '' ? 'Enter the effective date.' : null) ?? moneyProblem(form.monthlyGross, 'the corrected monthly gross') ?? moneyProblem(form.annualCtc, 'the corrected annual CTC') ?? (text === '' ? 'Enter a reason.' : null);
    setProblem(missing);
    if (missing !== null) {
      send.reset();
      return;
    }
    const monthly = item.basis === 'MONTHLY_GROSS';
    send.mutate({ effectiveDate: form.effectiveDate, proposedAmount: monthly ? form.monthlyGross : form.annualCtc, proposedCounterpart: monthly ? form.annualCtc : form.monthlyGross, reason: text });
  };
  return (
    <form className="grid-form" aria-label={`Correct the change effective ${formatDate(item.effectiveDate)}`} style={PANEL} onSubmit={submit}>
      <p className="hint wide">
        A different financial Admin decides this in the <DecisionInboxLink />, and the salary changes only once it is approved. The change you are correcting stays on record. To undo it, enter the earlier amounts.
      </p>
      <label>
        Effective date
        <input type="date" required value={form.effectiveDate} onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })} />
      </label>
      <label>
        Corrected monthly gross
        <input inputMode="decimal" autoComplete="off" required value={form.monthlyGross} onChange={(e) => setForm({ ...form, monthlyGross: e.target.value })} />
      </label>
      <label>
        Corrected annual CTC
        <input inputMode="decimal" autoComplete="off" required value={form.annualCtc} onChange={(e) => setForm({ ...form, annualCtc: e.target.value })} />
      </label>
      <label className="wide">
        Reason (required)
        <textarea required maxLength={1000} rows={3} style={TEXTAREA} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
      </label>
      {(problem ?? refusal) && (
        <p role="alert" className="error wide">
          {problem ?? refusal}
        </p>
      )}
      {!refusal && <ErrorNote error={send.error} />}
      <div className="wide row">
        <button type="submit" disabled={send.isPending}>
          Send correction
        </button>{' '}
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function EmployeeSalary({ employee }: { employee: PickedEmployee }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const ids = useId();
  const reloadCases = useReloadCases();
  const canReadSalary = can(SALARY_READ);
  // C4, C6: applied changes and annual growth are the financial past, a grant of their own.
  const canReadIncrements = can(READ_HISTORY);
  const canManage = can(SALARY_MANAGE);
  // Like an off-cycle change, a correction needs a company-wide assignment (the server refuses others).
  const canCorrect = can(PROPOSE) && me?.scopeKind === 'COMPANY';
  const [recorded, setRecorded] = useState(false);
  const [correcting, setCorrecting] = useState<HistoryItem | null>(null);
  const [correctionSent, setCorrectionSent] = useState(false);
  const path = `/v1/employees/${encodeURIComponent(employee.id)}`;
  const salary = useQuery({ queryKey: keys.salary(employee.id), enabled: canReadSalary, queryFn: () => api<{ items: SalaryArrangement[]; historyIncluded?: boolean }>(`${path}/salary`), retry: retryTransient });
  const history = useQuery({
    queryKey: keys.history(employee.id),
    enabled: canReadIncrements,
    queryFn: () => api<{ items: HistoryItem[] }>(`${path}/increment-history`),
    retry: retryTransient,
  });
  const salaryData = answered(salary);
  const historyData = answered(history);
  // Only the first arrangement is recorded directly; once one exists, changes go through an increment case.
  const offerInitial = canManage && !recorded && (!canReadSalary || salaryData?.items.length === 0);
  const arrangements = salaryData?.items ?? [];
  const historyItems = historyData?.items ?? [];
  const withReasons = historyItems.some((h) => typeof h.reason === 'string');
  const withStatus = historyItems.some((h) => h.correctsHistoryId || h.supersededByHistoryId);
  const withAction = canCorrect && historyItems.some((h) => h.correctable);
  const scopeNote = 'This employee is not in the selected role’s scope.';

  return (
    <div className="stack" style={PANEL}>
      {canReadSalary && (
        <div>
          <h3 id={`${ids}-salary`} style={H3}>
            Salary arrangements
          </h3>
          {salary.isPending && <p className="hint loading">Loading salary…</p>}
          <LoadProblem error={salary.error} forbidden="The selected role cannot read this employee’s salary." notFound={scopeNote} />
          {salaryData && arrangements.length === 0 && <Empty>No salary arrangement is recorded for this employee.</Empty>}
          {arrangements.length > 0 && (
            <>
              <div style={SCROLL}>
                <table aria-labelledby={`${ids}-salary`}>
                  <thead>
                    <tr>
                      <th scope="col">Effective from</th>
                      <th scope="col">Effective to</th>
                      <th scope="col">Monthly gross</th>
                      <th scope="col">Annual CTC</th>
                    </tr>
                  </thead>
                  <tbody>
                    {arrangements.map((s) => (
                      <tr key={s.id}>
                        <td>{formatDate(s.effectiveFrom)}</td>
                        <td>{s.effectiveTo ? formatDate(s.effectiveTo) : 'No end date'}</td>
                        <td>{money(s.monthlyGross, s.currency)}</td>
                        <td>{money(s.annualCtc, s.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="hint">An arrangement stays in force until the day the next one starts.</p>
              {salaryData?.historyIncluded === false && <p className="hint">Earlier arrangements are not shown: the selected role has no salary history grant.</p>}
            </>
          )}
        </div>
      )}
      {recorded && (
        <p className="ok" role="status">
          Initial salary recorded.
        </p>
      )}
      {offerInitial && <InitialSalaryForm employeeId={employee.id} onRecorded={() => setRecorded(true)} />}
      {canReadIncrements && (
        <div>
          <h3 id={`${ids}-history`} style={H3}>
            Increment history
          </h3>
          {history.isPending && <p className="hint loading">Loading increment history…</p>}
          <LoadProblem error={history.error} forbidden="The selected role cannot read this employee’s increment history." notFound={scopeNote} />
          {historyData && historyItems.length === 0 && <Empty>No increments have been applied for this employee.</Empty>}
          {historyItems.length > 0 && (
            <div style={SCROLL}>
              <table aria-labelledby={`${ids}-history`}>
                <thead>
                  <tr>
                    <th scope="col">Effective date</th>
                    <th scope="col">Basis</th>
                    <th scope="col">Before</th>
                    <th scope="col">After</th>
                    <th scope="col">Change</th>
                    <th scope="col">Change %</th>
                    {withReasons && <th scope="col">Reason</th>}
                    {withStatus && <th scope="col">Status</th>}
                    {withAction && <th scope="col">Action</th>}
                  </tr>
                </thead>
                <tbody>
                  {historyItems.map((h, index) => (
                    <tr key={`${h.effectiveDate}-${index}`}>
                      <td>{formatDate(h.effectiveDate)}</td>
                      <td>{basisLabel(h.basis)}</td>
                      <td>{money(h.beforeAmount, h.currency)}</td>
                      <td>{money(h.afterAmount, h.currency)}</td>
                      <td>{money(h.changeAmount, h.currency)}</td>
                      <td>{percent(h.changePercent, h.percentNaReason)}</td>
                      {withReasons && <td>{h.reason ?? '—'}</td>}
                      {withStatus && <td>{h.supersededByHistoryId ? <Badge tone="warn">Superseded by a correction</Badge> : h.correctsHistoryId ? <Badge>Correction</Badge> : '—'}</td>}
                      {withAction && (
                        <td>
                          {h.correctable && (
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => {
                                setCorrecting(h);
                                setCorrectionSent(false);
                              }}
                            >
                              Correct
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {withStatus && <p className="hint">A superseded change stays on record; reports and annual growth use the correction.</p>}
          {correctionSent && (
            <p className="ok" role="status">
              Correction sent for an independent decision.
            </p>
          )}
          {correcting && (
            <CorrectionForm
              key={correcting.id}
              item={correcting}
              onCancel={() => setCorrecting(null)}
              onSent={() => {
                setCorrecting(null);
                setCorrectionSent(true);
                reloadCases();
              }}
            />
          )}
        </div>
      )}
      {canReadIncrements && <AnnualGrowthPanel employeeId={employee.id} />}
    </div>
  );
}

/** FR-029 base: the first arrangement, with both figures stated as agreed (DF05). */
function InitialSalaryForm({ employeeId, onRecorded }: { employeeId: string; onRecorded: () => void }) {
  const qc = useQueryClient();
  const keys = useKeys();
  const ids = useId();
  const [form, setForm] = useState<InitialSalaryBody>({ effectiveFrom: '', monthlyGross: '', annualCtc: '', currency: 'INR' });
  const [problem, setProblem] = useState<string | null>(null);
  const record = useMutation({
    mutationFn: (body: InitialSalaryBody) => api<{ id: string }>(`/v1/employees/${encodeURIComponent(employeeId)}/salary`, { body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.salary(employeeId) });
      onRecorded();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const missing =
      (form.effectiveFrom === '' ? 'Enter the date the salary takes effect.' : null) ??
      moneyProblem(form.monthlyGross, 'the monthly gross') ??
      moneyProblem(form.annualCtc, 'the annual CTC') ??
      (CURRENCY.test(form.currency) ? null : 'Enter the currency as a three-letter code, for example INR.');
    setProblem(missing);
    if (missing === null) record.mutate({ effectiveFrom: form.effectiveFrom, monthlyGross: form.monthlyGross, annualCtc: form.annualCtc, currency: form.currency });
    else record.reset();
  };

  return (
    <div>
      <h3 id={`${ids}-title`} style={H3}>
        Initial salary
      </h3>
      <p className="hint">Records the employee’s first salary arrangement. Enter both figures as agreed; annual CTC is never worked out from monthly gross. Later changes go through an increment case.</p>
      <form className="grid-form" aria-labelledby={`${ids}-title`} onSubmit={submit}>
        <label>
          Effective from
          <input type="date" required value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
        </label>
        <label>
          Monthly gross
          <input inputMode="decimal" autoComplete="off" required value={form.monthlyGross} onChange={(e) => setForm({ ...form, monthlyGross: e.target.value })} />
        </label>
        <label>
          Annual CTC
          <input inputMode="decimal" autoComplete="off" required value={form.annualCtc} onChange={(e) => setForm({ ...form, annualCtc: e.target.value })} />
        </label>
        <label>
          Currency
          <input required maxLength={3} autoComplete="off" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
        </label>
        {problem && (
          <p role="alert" className="error wide">
            {problem}
          </p>
        )}
        <div className="wide row">
          <button type="submit" disabled={record.isPending}>
            Record initial salary
          </button>
        </div>
      </form>
      <ErrorNote error={record.error} />
    </div>
  );
}

/** DF14 annual growth for a chosen financial year: opening and closing salary and each change, never a sum. */
function AnnualGrowthPanel({ employeeId }: { employeeId: string }) {
  const keys = useKeys();
  const ids = useId();
  const [year, setYear] = useState(() => String(currentFinancialYear()));
  const [basis, setBasis] = useState<Basis>('MONTHLY_GROSS');
  const [requested, setRequested] = useState<{ year: number; basis: Basis } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const query = requested ? new URLSearchParams({ financialYear: String(requested.year), basis: requested.basis }).toString() : '';
  const growth = useQuery({
    queryKey: keys.growth(employeeId, requested?.year ?? 0, requested?.basis ?? 'MONTHLY_GROSS'),
    enabled: requested !== null,
    queryFn: () => api<AnnualGrowth>(`/v1/employees/${encodeURIComponent(employeeId)}/annual-increment?${query}`),
    retry: retryTransient,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = year.trim();
    if (!YEAR.test(text)) {
      setProblem('Enter the four-digit year the financial year starts in, for example 2027.');
      return;
    }
    setProblem(null);
    setRequested({ year: Number(text), basis });
  };

  const g = answered(growth);
  // The answer carries one currency (the closing one, else the opening one). When the currency changed in the year,
  // the opening amount and the changes may be in another currency, so they are shown without a currency code.
  const currencyChanged = g?.percentNaReason === 'CURRENCY_CHANGED';
  const yearCurrency = currencyChanged ? null : (g?.currency ?? null);
  return (
    <div>
      <h3 id={`${ids}-title`} style={H3}>
        Annual growth
      </h3>
      <form className="row" aria-labelledby={`${ids}-title`} onSubmit={submit}>
        <label className="inline" style={FLUSH}>
          Financial year from April
          <input type="number" inputMode="numeric" min={2000} max={2100} step={1} required style={YEAR_INPUT} value={year} onChange={(e) => setYear(e.target.value)} />
        </label>
        <label className="inline" style={FLUSH}>
          Basis
          <select value={basis} onChange={(e) => setBasis(e.target.value as Basis)}>
            {BASES.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Show growth</button>
      </form>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      {requested && growth.isPending && <p className="hint loading">Loading annual growth…</p>}
      <LoadProblem error={growth.error} forbidden="The selected role cannot read this employee’s annual growth." notFound="This employee is not in the selected role’s scope." />
      {g && (
        <div className="stack" style={PANEL}>
          <dl className="kv">
            <Item term="Financial year">
              {formatDate(g.periodStart)} to {formatDate(g.periodEnd)}
            </Item>
            <Item term="Basis">{basisLabel(g.basis)}</Item>
            <Item term="Opening (in force the day before the year starts)">{money(g.opening, yearCurrency)}</Item>
            <Item term="Closing (in force on the last day of the year)">{money(g.closing, g.currency)}</Item>
            <Item term="Annual growth">{percent(g.annualGrowthPercent, g.percentNaReason)}</Item>
          </dl>
          {currencyChanged && <p className="hint">The currency changed during the year, so the opening amount and the changes are shown without a currency code.</p>}
          <h4 id={`${ids}-changes`} style={H4}>
            Changes in the year
          </h4>
          {g.changes.length === 0 ? (
            <Empty>No increments took effect in this financial year.</Empty>
          ) : (
            <div style={SCROLL}>
              <table aria-labelledby={`${ids}-changes`}>
                <thead>
                  <tr>
                    <th scope="col">Effective date</th>
                    <th scope="col">Before</th>
                    <th scope="col">After</th>
                    <th scope="col">Change %</th>
                  </tr>
                </thead>
                <tbody>
                  {g.changes.map((c, index) => (
                    <tr key={`${c.effectiveDate}-${index}`}>
                      <td>{formatDate(c.effectiveDate)}</td>
                      <td>{money(c.beforeAmount, yearCurrency)}</td>
                      <td>{money(c.afterAmount, yearCurrency)}</td>
                      <td>{percent(c.changePercent, c.percentNaReason)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="hint">Each change has its own percentage. Annual growth compares the closing salary with the opening one, so the change percentages are never added up.</p>
        </div>
      )}
    </div>
  );
}
