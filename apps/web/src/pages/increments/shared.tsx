// Shared parts of the increment screens: permission keys, API shapes, labels, query keys and small helpers.

import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Hint } from '@/components/hint';
import { formatAmount, isForbidden, isNotFound, readable } from '../../api';
import { useSession } from '../../session';
import { ErrorNote, NotPermitted } from '../../ui';

export const CYCLE_MANAGE = 'increment_cycle.manage.operational';
export const READ_OPERATIONAL = 'increment.read.operational';
export const READ_SALARY = 'increment.read.salary';
export const READ_HISTORY = 'increment.history_read.salary';
export const PROPOSE = 'increment.propose.salary';
const APPROVE = 'increment.approve.salary';
export const SALARY_READ = 'salary.read.salary';
export const SALARY_MANAGE = 'salary.manage.salary';
export const LIST_EMPLOYEES = 'employee.list.operational';

/** The money format the API accepts (up to 15 digits and 4 decimals). Only the format is checked here. */
const MONEY = /^\d{1,15}(\.\d{1,4})?$/;
export const CURRENCY = /^[A-Z]{3}$/;
export const YEAR = /^\d{4}$/;
/** GET /v1/employees accepts page sizes of 25, 50 or 100 only. */
export const EMPLOYEE_PAGE_SIZE = 25;

export type Basis = 'MONTHLY_GROSS' | 'ANNUAL_CTC';
export type Outcome = 'INCREASE' | 'NO_CHANGE' | 'DEFER';

export interface Cycle {
  id: string;
  code: string;
  revision: number;
  recurrenceBasis: string;
  compensationBasis: Basis;
  active: boolean;
  version: number;
}

/** POST /v1/increment-cycles/:id/reviews answers 202 with the queued bulk job (NFR-S09). */
export interface QueuedJob {
  jobId: string;
  state: string;
}

/** A page of GET /v1/increment-review-openings/:id/cases or /exclusions (keyset: pass `nextAfter` as `after`). */
export interface OpeningPage<T> {
  jobId: string;
  state: string;
  run: number | null;
  items: T[];
  nextAfter: string | null;
}

/** A draft case the opening created (operational fields only). */
export interface OpenedCase {
  caseId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  occurrence: string;
  effectiveDate: string;
  decisionDueOn: string;
  state: string;
}

/** An employee of the cycle the opening excluded, with the reason and what repairs it. */
export interface OpeningExclusion {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  occurrence: string;
  reason: string;
  repairPath: string | null;
}

/** Rows per page of an opening's cases or exclusions (the API serves up to 200). */
export const OPENING_PAGE_SIZE = 50;

export interface IncrementCase {
  id: string;
  employeeId: string;
  employeeCode: string;
  occurrence: string;
  offCycle: boolean;
  state: string;
  proposedOutcome: Outcome | null;
  effectiveDate: string;
  version: number;
  /** Set when this case corrects an applied change (BR-038). */
  correctsHistoryId?: string | null;
  /** Confidential (salary field group): present only when the server returned amounts. */
  baselineAmount?: string;
  proposedAmount?: string | null;
  currency?: string;
}

export type ProposalBody =
  | { expectedVersion: number; outcome: 'INCREASE'; proposedAmount: string; proposedCounterpart: string; reason: string }
  | { expectedVersion: number; outcome: 'NO_CHANGE' | 'DEFER'; reason: string };

export interface OffCycleBody {
  employeeId: string;
  effectiveDate: string;
  basis: Basis;
  proposedAmount: string;
  proposedCounterpart: string;
  reason: string;
}

export interface ProposalResult {
  caseId: string;
  taskId: string;
  state: string;
}

export interface SalaryArrangement {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  annualCtc: string;
  monthlyGross: string;
  currency: string;
}

export interface InitialSalaryBody {
  effectiveFrom: string;
  monthlyGross: string;
  annualCtc: string;
  currency: string;
}

export interface HistoryItem {
  id?: string;
  effectiveDate: string;
  basis: Basis;
  currency: string;
  beforeAmount: string;
  afterAmount: string;
  changeAmount: string;
  changePercent: string | null;
  percentNaReason: string | null;
  /** The decision reason; shown only when the server returned it. */
  reason?: string;
  /** BR-038: the record this one corrects, and the record that corrected this one. */
  correctsHistoryId?: string | null;
  supersededByHistoryId?: string | null;
  correctable?: boolean;
}

export interface AnnualGrowth {
  employeeId: string;
  financialYear: number;
  basis: Basis;
  periodStart: string;
  periodEnd: string;
  opening: string | null;
  closing: string | null;
  currency: string | null;
  annualGrowthPercent: string | null;
  percentNaReason: string | null;
  changes: { effectiveDate: string; beforeAmount: string; afterAmount: string; changePercent: string | null; percentNaReason: string | null }[];
}

/** The employee a form or the salary panel works on; the name is unknown when picked from a case row. */
export interface PickedEmployee {
  id: string;
  employeeCode: string;
  displayName?: string;
}

export const STATE_FILTERS: readonly { value: string; label: string }[] = [
  { value: '', label: 'All states' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'RETURNED', label: 'Returned' },
  { value: 'APPLIED', label: 'Applied' },
  { value: 'NO_CHANGE', label: 'No change' },
  { value: 'DEFERRED', label: 'Deferred' },
  { value: 'REJECTED', label: 'Rejected' },
];

export const OUTCOMES: readonly { value: Outcome; label: string }[] = [
  { value: 'INCREASE', label: 'Increase' },
  { value: 'NO_CHANGE', label: 'No change' },
  { value: 'DEFER', label: 'Defer' },
];

export const BASES: readonly { value: Basis; label: string; inSentence: string }[] = [
  { value: 'MONTHLY_GROSS', label: 'Monthly gross', inSentence: 'monthly gross' },
  { value: 'ANNUAL_CTC', label: 'Annual CTC', inSentence: 'annual CTC' },
];

export const RECURRENCE_LABEL: Record<string, string> = { COMMON_DATE: 'Common date', SERVICE_ANNIVERSARY: 'Service anniversary' };

const NA_LABEL: Record<string, string> = {
  ZERO_BASELINE: 'the earlier amount was zero',
  BASIS_CHANGED: 'the basis changed',
  CURRENCY_CHANGED: 'the currency changed',
  MISSING_OPENING_OR_CLOSING: 'no salary in force at the start or the end of the year',
};

/**
 * Query keys carry the selected company and assignment: the app keeps one query cache across role switches and
 * sign-ins, so without them an answer given to one assignment (amounts, salaries) could be shown under another.
 */
export function useKeys() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(() => {
    const base = ['increments', context] as const;
    return {
      cycles: [...base, 'cycles'] as const,
      allCases: [...base, 'cases'] as const,
      cases: (state: string) => [...base, 'cases', state] as const,
      employeeSearch: (term: string) => [...base, 'employee-search', term] as const,
      opening: (jobId: string, list: 'cases' | 'exclusions') => [...base, 'opening', jobId, list] as const,
      salary: (id: string) => [...base, 'salary', id] as const,
      history: (id: string) => [...base, 'increment-history', id] as const,
      growth: (id: string, year: number, basis: Basis) => [...base, 'annual-increment', id, year, basis] as const,
    };
  }, [context]);
}

/** Reloads every case list of the selected assignment (all state filters). */
export function useReloadCases() {
  const qc = useQueryClient();
  const keys = useKeys();
  return () => void qc.invalidateQueries({ queryKey: keys.allCases });
}

/**
 * The data of the latest successful answer only. When a refetch is refused or fails, TanStack Query keeps the earlier
 * data next to the error; figures the server now refuses (a revoked grant, a record out of scope) must not stay shown.
 */
export function answered<T>(query: { isSuccess: boolean; data: T | undefined }): T | undefined {
  return query.isSuccess ? query.data : undefined;
}

// The module's own layout pieces, as utility classes (shadcn/ui move, 20 Nov 2026). The shared helpers (FormField, Hint, Table …)
// cover fields, hints and tables; these cover what this module has and they do not.
/** A block set apart below what it follows, its parts stacked: an opening's progress, an employee's salary, a year's growth. */
export const PANEL = 'mt-3 flex flex-col gap-3';
/** A short form on one line (a review year, a growth year and basis): its fields and button side by side, bottoms aligned. */
export const FIELD_ROW = 'flex flex-wrap items-end gap-2';
/** A four-digit year field, no wider than its digits need. */
export const YEAR_INPUT = 'w-[6.5rem]';

/** A cycle occurrence ("ANNUAL:2027") as a person reads it ("Annual 2027"). */
export function occurrenceText(occurrence: string): string {
  const [code = '', year] = occurrence.split(':');
  return year ? `${readable(code)} ${year}` : readable(occurrence);
}

export const basisLabel = (basis: string) => BASES.find((b) => b.value === basis)?.label ?? readable(basis);
export const outcomeLabel = (outcome: string) => OUTCOMES.find((o) => o.value === outcome)?.label ?? readable(outcome);
export const employeeLabel = (e: PickedEmployee) => (e.displayName ? `${e.displayName} (${e.employeeCode})` : e.employeeCode);

/** Shows a decimal string the server returned, with its currency when one came with it. Never computes amounts. */
export function money(value: string | null | undefined, currency: string | null | undefined): string {
  return currency ? formatAmount(value, currency) : formatAmount(value, '').trim();
}

/** A server-computed percentage, or N/A with the server's reason (DF14). */
export function percent(value: string | null, naReason: string | null): string {
  if (value !== null) return `${value}%`;
  if (naReason) return `N/A: ${NA_LABEL[naReason] ?? readable(naReason)}`;
  return '—';
}

/** Format check only: the amount is sent exactly as typed, so a value with commas or spaces is refused here. */
export function moneyProblem(value: string, what: string): string | null {
  if (value === '') return `Enter ${what}.`;
  if (!MONEY.test(value)) return `Write ${what} as digits with up to four decimal places and no commas or spaces, for example 110000 or 110000.50.`;
  return null;
}

/** The starting year of the financial year (April to March, DF14) that contains today. */
export function currentFinancialYear(): number {
  const today = new Date();
  return today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
}

/** A failed load: a refusal reads as "not permitted", an out-of-scope record as unavailable, anything else as an error. */
export function LoadProblem({ error, forbidden, notFound }: { error: unknown; forbidden: string; notFound?: string }) {
  if (!error) return null;
  if (isForbidden(error)) return <NotPermitted>{forbidden}</NotPermitted>;
  if (notFound && isNotFound(error)) return <Hint role="note">{notFound}</Hint>;
  return <ErrorNote error={error} />;
}

/** Decisions happen only on the Decisions page (the menu's name for /tasks); the link is offered to roles that decide increments. */
export function DecisionInboxLink() {
  const { can } = useSession();
  return can(APPROVE) ? <Link to="/tasks">Decisions</Link> : <>Decisions</>;
}
