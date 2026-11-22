// FR-029 / FR-089 / FR-090 / DF14: one employee's salary arrangements, increment history and annual growth.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
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
import { api, ApiError, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, Item, Notice, Section } from '../../ui';
import { EmployeePicker } from './off-cycle';
import {
  type AnnualGrowth,
  answered,
  BASES,
  type Basis,
  basisLabel,
  CURRENCY,
  currentFinancialYear,
  DecisionInboxLink,
  FIELD_ROW,
  type HistoryItem,
  type InitialSalaryBody,
  LoadProblem,
  money,
  moneyProblem,
  PANEL,
  percent,
  type PickedEmployee,
  type ProposalResult,
  PROPOSE,
  READ_HISTORY,
  SALARY_MANAGE,
  SALARY_READ,
  type SalaryArrangement,
  useKeys,
  useReloadCases,
  YEAR,
  YEAR_INPUT,
} from './shared';

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
        <Hint>Salary figures are confidential: each part below appears only with its own salary grant in the selected role.</Hint>
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
  const shownProblem = problem ?? refusal;
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
    <FormGrid aria-label={`Correct the change effective ${formatDate(item.effectiveDate)}`} className="mt-3" onSubmit={submit}>
      <Hint>
        A different financial Admin decides this in the <DecisionInboxLink />, and the salary changes only once it is approved. The change you are correcting stays on record. To undo it, enter the earlier amounts.
      </Hint>
      <FormField>
        Effective date
        <Input type="date" required value={form.effectiveDate} onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })} />
      </FormField>
      <FormField>
        Corrected monthly gross
        <Input inputMode="decimal" autoComplete="off" required value={form.monthlyGross} onChange={(e) => setForm({ ...form, monthlyGross: e.target.value })} />
      </FormField>
      <FormField>
        Corrected annual CTC
        <Input inputMode="decimal" autoComplete="off" required value={form.annualCtc} onChange={(e) => setForm({ ...form, annualCtc: e.target.value })} />
      </FormField>
      <FormField className="col-span-full">
        Reason (required)
        <Textarea required maxLength={1000} rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
      </FormField>
      {shownProblem && <Notice notice={{ text: shownProblem, ok: false }} />}
      {!refusal && <ErrorNote error={send.error} />}
      <ButtonRow className="col-span-full">
        <Button type="submit" disabled={send.isPending}>
          Send correction
        </Button>{' '}
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </ButtonRow>
    </FormGrid>
  );
}

/** Whether an applied change was corrected, or is itself a correction; a dash for neither. */
function HistoryStatus({ item }: { item: HistoryItem }) {
  if (item.supersededByHistoryId) return <Badge tone="warn">Superseded by a correction</Badge>;
  return item.correctsHistoryId ? <Badge>Correction</Badge> : <>—</>;
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
    <div className={PANEL}>
      {canReadSalary && (
        <div>
          <CardSubheading id={`${ids}-salary`}>Salary arrangements</CardSubheading>
          {salary.isPending && <LoadingLine>Loading salary…</LoadingLine>}
          <LoadProblem error={salary.error} forbidden="The selected role cannot read this employee’s salary." notFound={scopeNote} />
          {salaryData && arrangements.length === 0 && <Empty>No salary arrangement is recorded for this employee.</Empty>}
          {arrangements.length > 0 && (
            <>
              <Table aria-labelledby={`${ids}-salary`}>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Effective from</TableHead>
                    <TableHead scope="col">Effective to</TableHead>
                    <TableHead scope="col">Monthly gross</TableHead>
                    <TableHead scope="col">Annual CTC</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {arrangements.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>{formatDate(s.effectiveFrom)}</TableCell>
                      <TableCell>{s.effectiveTo ? formatDate(s.effectiveTo) : 'No end date'}</TableCell>
                      <TableCell>{money(s.monthlyGross, s.currency)}</TableCell>
                      <TableCell>{money(s.annualCtc, s.currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Hint>An arrangement stays in force until the day the next one starts.</Hint>
              {salaryData?.historyIncluded === false && <Hint>Earlier arrangements are not shown: the selected role has no salary history grant.</Hint>}
            </>
          )}
        </div>
      )}
      {recorded && <Notice notice={{ text: 'Initial salary recorded.', ok: true }} />}
      {offerInitial && <InitialSalaryForm employeeId={employee.id} onRecorded={() => setRecorded(true)} />}
      {canReadIncrements && (
        <div>
          <CardSubheading id={`${ids}-history`}>Increment history</CardSubheading>
          {history.isPending && <LoadingLine>Loading increment history…</LoadingLine>}
          <LoadProblem error={history.error} forbidden="The selected role cannot read this employee’s increment history." notFound={scopeNote} />
          {historyData && historyItems.length === 0 && <Empty>No increments have been applied for this employee.</Empty>}
          {historyItems.length > 0 && (
            <Table aria-labelledby={`${ids}-history`}>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Effective date</TableHead>
                  <TableHead scope="col">Basis</TableHead>
                  <TableHead scope="col">Before</TableHead>
                  <TableHead scope="col">After</TableHead>
                  <TableHead scope="col">Change</TableHead>
                  <TableHead scope="col">Change %</TableHead>
                  {withReasons && <TableHead scope="col">Reason</TableHead>}
                  {withStatus && <TableHead scope="col">Status</TableHead>}
                  {withAction && <TableHead scope="col">Action</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {historyItems.map((h, index) => (
                  <TableRow key={`${h.effectiveDate}-${index}`}>
                    <TableCell>{formatDate(h.effectiveDate)}</TableCell>
                    <TableCell>{basisLabel(h.basis)}</TableCell>
                    <TableCell>{money(h.beforeAmount, h.currency)}</TableCell>
                    <TableCell>{money(h.afterAmount, h.currency)}</TableCell>
                    <TableCell>{money(h.changeAmount, h.currency)}</TableCell>
                    <TableCell>{percent(h.changePercent, h.percentNaReason)}</TableCell>
                    {withReasons && <TableCell>{h.reason ?? '—'}</TableCell>}
                    {withStatus && (
                      <TableCell>
                        <HistoryStatus item={h} />
                      </TableCell>
                    )}
                    {withAction && (
                      <RowActionsCell>
                        {h.correctable && (
                          <RowActions>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setCorrecting(h);
                                setCorrectionSent(false);
                              }}
                            >
                              Correct
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
          {withStatus && <Hint>A superseded change stays on record; reports and annual growth use the correction.</Hint>}
          {correctionSent && <Notice notice={{ text: 'Correction sent for an independent decision.', ok: true }} />}
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
      <CardSubheading id={`${ids}-title`}>Initial salary</CardSubheading>
      <Hint>Records the employee’s first salary arrangement. Enter both figures as agreed; annual CTC is never worked out from monthly gross. Later changes go through an increment case.</Hint>
      <FormGrid aria-labelledby={`${ids}-title`} onSubmit={submit}>
        <FormField>
          Effective from
          <Input type="date" required value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
        </FormField>
        <FormField>
          Monthly gross
          <Input inputMode="decimal" autoComplete="off" required value={form.monthlyGross} onChange={(e) => setForm({ ...form, monthlyGross: e.target.value })} />
        </FormField>
        <FormField>
          Annual CTC
          <Input inputMode="decimal" autoComplete="off" required value={form.annualCtc} onChange={(e) => setForm({ ...form, annualCtc: e.target.value })} />
        </FormField>
        <FormField>
          Currency
          <Input required maxLength={3} autoComplete="off" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
        </FormField>
        {problem && <Notice notice={{ text: problem, ok: false }} />}
        <ButtonRow className="col-span-full">
          <Button type="submit" disabled={record.isPending}>
            Record initial salary
          </Button>
        </ButtonRow>
      </FormGrid>
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
      <CardSubheading id={`${ids}-title`}>Annual growth</CardSubheading>
      <form className={FIELD_ROW} aria-labelledby={`${ids}-title`} onSubmit={submit}>
        <FormField className="w-auto">
          Financial year from April
          <Input type="number" inputMode="numeric" min={2000} max={2100} step={1} required className={YEAR_INPUT} value={year} onChange={(e) => setYear(e.target.value)} />
        </FormField>
        <FormField className="w-auto">
          Basis
          <NativeSelect value={basis} onChange={(e) => setBasis(e.target.value as Basis)}>
            {BASES.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <Button type="submit">Show growth</Button>
      </form>
      {problem && <Notice notice={{ text: problem, ok: false }} />}
      {requested && growth.isPending && <LoadingLine>Loading annual growth…</LoadingLine>}
      <LoadProblem error={growth.error} forbidden="The selected role cannot read this employee’s annual growth." notFound="This employee is not in the selected role’s scope." />
      {g && (
        <div className={PANEL}>
          <dl className="kv">
            <Item term="Financial year">
              {formatDate(g.periodStart)} to {formatDate(g.periodEnd)}
            </Item>
            <Item term="Basis">{basisLabel(g.basis)}</Item>
            <Item term="Opening (in force the day before the year starts)">{money(g.opening, yearCurrency)}</Item>
            <Item term="Closing (in force on the last day of the year)">{money(g.closing, g.currency)}</Item>
            <Item term="Annual growth">{percent(g.annualGrowthPercent, g.percentNaReason)}</Item>
          </dl>
          {currencyChanged && <Hint>The currency changed during the year, so the opening amount and the changes are shown without a currency code.</Hint>}
          <CardSubheading level={4} id={`${ids}-changes`}>
            Changes in the year
          </CardSubheading>
          {g.changes.length === 0 ? (
            <Empty>No increments took effect in this financial year.</Empty>
          ) : (
            <Table aria-labelledby={`${ids}-changes`}>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Effective date</TableHead>
                  <TableHead scope="col">Before</TableHead>
                  <TableHead scope="col">After</TableHead>
                  <TableHead scope="col">Change %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {g.changes.map((c, index) => (
                  <TableRow key={`${c.effectiveDate}-${index}`}>
                    <TableCell>{formatDate(c.effectiveDate)}</TableCell>
                    <TableCell>{money(c.beforeAmount, yearCurrency)}</TableCell>
                    <TableCell>{money(c.afterAmount, yearCurrency)}</TableCell>
                    <TableCell>{percent(c.changePercent, c.percentNaReason)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Hint>Each change has its own percentage. Annual growth compares the closing salary with the opening one, so the change percentages are never added up.</Hint>
        </div>
      )}
    </div>
  );
}
