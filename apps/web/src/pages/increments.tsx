// Increments and salary (FR-029 base, FR-089-FR-092; BR-038-BR-041; DF14; DF15; DF02; C1).
// HR opens a cycle review for a year: the opening is queued as a bulk job (NFR-S09), and the server then creates one
// draft case per eligible employee in the background and records every other employee of the cycle with a reason.
// This screen follows the queued job's live status and, once it completes, lists the cases it created and the
// employees it excluded with each reason's repair path, a page at a time (operational fields only, never an amount).
// The employee's current direct manager proposes an outcome against the case
// version, HR proposes off-cycle changes, and an independent Admin decides every case in the Decision inbox (/tasks),
// never here.
// Salary and increment amounts are confidential (salary field group, BR-044): the server omits them without the grant,
// and this screen shows amount columns only when a response carries them. Money travels as the decimal strings typed
// or returned (only their format is checked); nothing here adds, rounds or derives an amount, and annual CTC is never
// worked out from monthly gross (DF05). Percentages come from the server (DF14) and are never summed (BR-039).
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, type FormEvent, Fragment, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, formatAmount, formatDate } from '../api';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Section, StateBadge } from '../ui';
import { BulkJobStatus, exclusionReasonLabel, useBulkJob } from './bulk-jobs';

const CYCLE_MANAGE = 'increment_cycle.manage.operational';
const READ_OPERATIONAL = 'increment.read.operational';
const READ_SALARY = 'increment.read.salary';
const PROPOSE = 'increment.propose.salary';
const APPROVE = 'increment.approve.salary';
const SALARY_READ = 'salary.read.salary';
const SALARY_MANAGE = 'salary.manage.salary';
const LIST_EMPLOYEES = 'employee.list.operational';

/** The money format the API accepts (up to 15 digits and 4 decimals). Only the format is checked here. */
const MONEY = /^\d{1,15}(\.\d{1,4})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const YEAR = /^\d{4}$/;
/** GET /v1/employees accepts page sizes of 25, 50 or 100 only. */
const EMPLOYEE_PAGE_SIZE = 25;

type Basis = 'MONTHLY_GROSS' | 'ANNUAL_CTC';
type Outcome = 'INCREASE' | 'NO_CHANGE' | 'DEFER';

interface Cycle {
  id: string;
  code: string;
  revision: number;
  recurrenceBasis: string;
  compensationBasis: Basis;
  active: boolean;
  version: number;
}

/** POST /v1/increment-cycles/:id/reviews answers 202 with the queued bulk job (NFR-S09). */
interface QueuedJob {
  jobId: string;
  state: string;
}

/** A page of GET /v1/increment-review-openings/:id/cases or /exclusions (keyset: pass `nextAfter` as `after`). */
interface OpeningPage<T> {
  jobId: string;
  state: string;
  run: number | null;
  items: T[];
  nextAfter: string | null;
}

/** A draft case the opening created (operational fields only). */
interface OpenedCase {
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
interface OpeningExclusion {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  occurrence: string;
  reason: string;
  repairPath: string | null;
}

/** Rows per page of an opening's cases or exclusions (the API serves up to 200). */
const OPENING_PAGE_SIZE = 50;

interface IncrementCase {
  id: string;
  employeeId: string;
  employeeCode: string;
  occurrence: string;
  offCycle: boolean;
  state: string;
  proposedOutcome: Outcome | null;
  effectiveDate: string;
  version: number;
  /** Confidential (salary field group): present only when the server returned amounts. */
  baselineAmount?: string;
  proposedAmount?: string | null;
  currency?: string;
}

type ProposalBody =
  | { expectedVersion: number; outcome: 'INCREASE'; proposedAmount: string; proposedCounterpart: string; reason: string }
  | { expectedVersion: number; outcome: 'NO_CHANGE' | 'DEFER'; reason: string };

interface OffCycleBody {
  employeeId: string;
  effectiveDate: string;
  basis: Basis;
  proposedAmount: string;
  proposedCounterpart: string;
  reason: string;
}

interface ProposalResult {
  caseId: string;
  taskId: string;
  state: string;
}

interface SalaryArrangement {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  annualCtc: string;
  monthlyGross: string;
  currency: string;
}

interface InitialSalaryBody {
  effectiveFrom: string;
  monthlyGross: string;
  annualCtc: string;
  currency: string;
}

interface HistoryItem {
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
}

interface AnnualGrowth {
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

interface EmployeeHit {
  id: string;
  employeeCode: string;
  displayName: string;
  status: string;
}

/** The employee a form or the salary panel works on; the name is unknown when picked from a case row. */
interface PickedEmployee {
  id: string;
  employeeCode: string;
  displayName?: string;
}

const STATE_FILTERS: readonly { value: string; label: string }[] = [
  { value: '', label: 'All states' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'RETURNED', label: 'Returned' },
  { value: 'APPLIED', label: 'Applied' },
  { value: 'NO_CHANGE', label: 'No change' },
  { value: 'DEFERRED', label: 'Deferred' },
  { value: 'REJECTED', label: 'Rejected' },
];

const OUTCOMES: readonly { value: Outcome; label: string }[] = [
  { value: 'INCREASE', label: 'Increase' },
  { value: 'NO_CHANGE', label: 'No change' },
  { value: 'DEFER', label: 'Defer' },
];

const BASES: readonly { value: Basis; label: string; inSentence: string }[] = [
  { value: 'MONTHLY_GROSS', label: 'Monthly gross', inSentence: 'monthly gross' },
  { value: 'ANNUAL_CTC', label: 'Annual CTC', inSentence: 'annual CTC' },
];

const RECURRENCE_LABEL: Record<string, string> = { COMMON_DATE: 'Common date', SERVICE_ANNIVERSARY: 'Service anniversary' };

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
function useKeys() {
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
function useReloadCases() {
  const qc = useQueryClient();
  const keys = useKeys();
  return () => void qc.invalidateQueries({ queryKey: keys.allCases });
}

/**
 * The data of the latest successful answer only. When a refetch is refused or fails, TanStack Query keeps the earlier
 * data next to the error; figures the server now refuses (a revoked grant, a record out of scope) must not stay shown.
 */
function answered<T>(query: { isSuccess: boolean; data: T | undefined }): T | undefined {
  return query.isSuccess ? query.data : undefined;
}

const SCROLL: CSSProperties = { overflowX: 'auto' };
const PANEL: CSSProperties = { marginTop: '0.75rem' };
const FLUSH: CSSProperties = { margin: 0 };
const H3: CSSProperties = { fontSize: '1rem', margin: '0.75rem 0 0.4rem' };
const H4: CSSProperties = { fontSize: '0.95rem', margin: '0.6rem 0 0.3rem' };
const YEAR_INPUT: CSSProperties = { width: '6.5rem' };
const TEXTAREA: CSSProperties = {
  font: 'inherit',
  padding: '0.4rem 0.5rem',
  border: '1px solid var(--line)',
  borderRadius: 6,
  color: 'var(--text)',
  background: 'var(--surface)',
  resize: 'vertical',
};
const SR_ONLY: CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 };

const isForbidden = (error: unknown) => error instanceof ApiError && error.status === 403;
const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;
/** A refusal or bad request will not change on retry; only transient failures are retried (once). */
const retryTransient = (failureCount: number, error: Error) => !(error instanceof ApiError && error.status < 500) && failureCount < 1;
const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409;

function readable(code: string): string {
  const text = code.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const basisLabel = (basis: string) => BASES.find((b) => b.value === basis)?.label ?? readable(basis);
const outcomeLabel = (outcome: string) => OUTCOMES.find((o) => o.value === outcome)?.label ?? readable(outcome);
const employeeLabel = (e: PickedEmployee) => (e.displayName ? `${e.displayName} (${e.employeeCode})` : e.employeeCode);

/** Shows a decimal string the server returned, with its currency when one came with it. Never computes amounts. */
function money(value: string | null | undefined, currency: string | null | undefined): string {
  return currency ? formatAmount(value, currency) : formatAmount(value, '').trim();
}

/** A server-computed percentage, or N/A with the server's reason (DF14). */
function percent(value: string | null, naReason: string | null): string {
  if (value !== null) return `${value}%`;
  if (naReason) return `N/A: ${NA_LABEL[naReason] ?? readable(naReason)}`;
  return '—';
}

/** Format check only: the amount is sent exactly as typed, so a value with commas or spaces is refused here. */
function moneyProblem(value: string, what: string): string | null {
  if (value === '') return `Enter ${what}.`;
  if (!MONEY.test(value)) return `Write ${what} as digits with up to four decimal places and no commas or spaces, for example 110000 or 110000.50.`;
  return null;
}

/** The starting year of the financial year (April to March, DF14) that contains today. */
function currentFinancialYear(): number {
  const today = new Date();
  return today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
}

function NotPermitted({ children }: { children: ReactNode }) {
  return (
    <p role="note">
      <Badge tone="warn">not permitted</Badge> {children}
    </p>
  );
}

/** A failed load: a refusal reads as "not permitted", an out-of-scope record as unavailable, anything else as an error. */
function LoadProblem({ error, forbidden, notFound }: { error: unknown; forbidden: string; notFound?: string }) {
  if (!error) return null;
  if (isForbidden(error)) return <NotPermitted>{forbidden}</NotPermitted>;
  if (notFound && isNotFound(error)) {
    return (
      <p role="note" className="hint">
        {notFound}
      </p>
    );
  }
  return <ErrorNote error={error} />;
}

function Item({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Decisions happen only in the Decision inbox; the link is offered to roles that decide increments. */
function DecisionInboxLink() {
  const { can } = useSession();
  return can(APPROVE) ? <Link to="/tasks">Decision inbox</Link> : <>Decision inbox</>;
}

export function IncrementsPage() {
  const { me, can } = useSession();
  const [salaryEmployee, setSalaryEmployee] = useState<PickedEmployee | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  // The role context and its permissions arrive together; until then nothing is known, so nothing reads as refused.
  if (!me) {
    return (
      <>
        <h1>Increments and salary</h1>
        <p className="hint">Loading…</p>
      </>
    );
  }
  // Opening a review and proposing an off-cycle change need a company-wide assignment (the server refuses others).
  const companyWide = me.scopeKind === 'COMPANY';
  const canReadCases = can(READ_OPERATIONAL) || can(READ_SALARY);
  const salaryPanel = can(SALARY_READ) || can(READ_SALARY) || can(SALARY_MANAGE);

  const showSalary = (employee: PickedEmployee) => {
    setSalaryEmployee(employee);
    setFocusRequest((n) => n + 1);
  };

  return (
    <>
      <h1>Increments and salary</h1>
      {can(CYCLE_MANAGE) && <CyclesSection companyWide={companyWide} />}
      {canReadCases ? (
        <CasesSection onShowSalary={salaryPanel ? showSalary : undefined} />
      ) : (
        <Section title="Increment cases">
          <NotPermitted>The selected role cannot view increment cases.</NotPermitted>
        </Section>
      )}
      {can(PROPOSE) && companyWide && <OffCycleSection />}
      {salaryPanel && <SalaryPanel employee={salaryEmployee} onEmployee={setSalaryEmployee} focusRequest={focusRequest} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// FR-091 / DF15: cycles and opening a review for a year (the roster snapshot, queued as a bulk job; it changes no
// salary).
// ---------------------------------------------------------------------------------------------------------

function CyclesSection({ companyWide }: { companyWide: boolean }) {
  const keys = useKeys();
  const cycles = useQuery({ queryKey: keys.cycles, queryFn: () => api<{ items: Cycle[] }>('/v1/increment-cycles'), retry: retryTransient });
  const [years, setYears] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<{ cycleId: string; text: string } | null>(null);
  // The server checks the request and queues the opening; the cases are created later, by the worker.
  const [queued, setQueued] = useState<{ cycle: Cycle; year: number; jobId: string } | null>(null);
  const open = useMutation({
    mutationFn: ({ cycle, year }: { cycle: Cycle; year: number }) => api<QueuedJob>(`/v1/increment-cycles/${encodeURIComponent(cycle.id)}/reviews`, { body: { year } }),
    onMutate: () => setQueued(null),
    onSuccess: (job, { cycle, year }) => setQueued({ cycle, year, jobId: job.jobId }),
  });
  // Opening a review creates cases that cannot be withdrawn, so the year is always typed, never prefilled.
  const yearOf = (cycleId: string) => years[cycleId] ?? '';
  const data = answered(cycles);
  const items = data?.items ?? [];

  const submit = (event: FormEvent, cycle: Cycle) => {
    event.preventDefault();
    const year = yearOf(cycle.id).trim();
    if (!YEAR.test(year)) {
      open.reset();
      setProblem({ cycleId: cycle.id, text: 'Enter the review year as four digits, for example 2027.' });
      return;
    }
    setProblem(null);
    open.mutate({ cycle, year: Number(year) });
  };

  // Only an active common-date cycle can open a review for a year; the others say why instead of offering it.
  const reviewControl = (c: Cycle) => {
    if (!c.active) return <span className="hint">Inactive cycle</span>;
    if (c.recurrenceBasis !== 'COMMON_DATE') return <span className="hint">No common review date</span>;
    if (!companyWide) return <span className="hint">Reviews are opened from a company-wide role</span>;
    return (
      <form className="row" aria-label={`Open a review of ${c.code} revision ${c.revision}`} onSubmit={(e) => submit(e, c)}>
        <label className="inline" style={FLUSH}>
          Review year
          <input
            type="number"
            inputMode="numeric"
            min={2000}
            max={2100}
            step={1}
            required
            style={YEAR_INPUT}
            value={yearOf(c.id)}
            onChange={(e) => setYears({ ...years, [c.id]: e.target.value })}
          />
        </label>
        <button type="submit" disabled={open.isPending}>
          Open review
        </button>
        {problem?.cycleId === c.id && (
          <span role="alert" className="error">
            {problem.text}
          </span>
        )}
      </form>
    );
  };

  return (
    <Section title="Increment cycles">
      <p className="hint">A cycle is a review schedule, not an entitlement: opening a review creates draft cases for the eligible employees and changes no salary.</p>
      {companyWide && <p className="hint">Type the review year: the cases take effect on the cycle’s review date in that year.</p>}
      {cycles.isPending && <p className="hint">Loading cycles…</p>}
      <LoadProblem error={cycles.error} forbidden="The selected role cannot manage increment cycles." />
      {data && items.length === 0 && <Empty>No increment cycles are configured for this company.</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table>
            <thead>
              <tr>
                <th scope="col">Cycle</th>
                <th scope="col">Revision</th>
                <th scope="col">Recurrence</th>
                <th scope="col">Basis</th>
                <th scope="col">Status</th>
                <th scope="col">Review</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td>{c.code}</td>
                  <td>{c.revision}</td>
                  <td>{RECURRENCE_LABEL[c.recurrenceBasis] ?? readable(c.recurrenceBasis)}</td>
                  <td>{basisLabel(c.compensationBasis)}</td>
                  <td>
                    <Badge tone={c.active ? 'good' : 'neutral'}>{c.active ? 'active' : 'inactive'}</Badge>
                  </td>
                  <td>{reviewControl(c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {queued && <OpeningJob key={queued.jobId} cycle={queued.cycle} year={queued.year} jobId={queued.jobId} />}
      <ErrorNote error={open.error} />
    </Section>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * A queued opening: the job's live status (asked about again until it is done), and once it has completed, the draft
 * cases it created and the employees it excluded. The case list is reloaded when the opening completes.
 */
function OpeningJob({ cycle, year, jobId }: { cycle: Cycle; year: number; jobId: string }) {
  const qc = useQueryClient();
  const keys = useKeys();
  // BulkJobStatus below asks about the job while it runs; this reads the same answers.
  const job = answered(useBulkJob(jobId, { poll: false }));
  const state = job?.state;
  const created = typeof job?.result.created === 'number' ? job.result.created : null;
  const excluded = typeof job?.result.excluded === 'number' ? job.result.excluded : null;
  const completed = state === 'COMPLETED';
  useEffect(() => {
    if (completed) void qc.invalidateQueries({ queryKey: keys.allCases });
  }, [completed, qc, keys.allCases]);
  const review = `${cycle.code} (revision ${cycle.revision}) for ${year}`;

  return (
    <div className="stack" style={PANEL}>
      {completed ? (
        <p className="ok" role="status">
          Review of {review} opened{created !== null && excluded !== null ? `: ${plural(created, 'draft case', 'draft cases')} created, ${plural(excluded, 'employee', 'employees')} excluded` : ''}.
          It changed no salary.
        </p>
      ) : state === 'FAILED' ? (
        <p className="hint" role="status">
          The review of {review} stopped before it finished; the reason is below.
        </p>
      ) : (
        <p className="ok" role="status">
          Review of {review} queued. The draft cases are created in the background and appear in the case list once the opening has run.
        </p>
      )}
      <BulkJobStatus jobId={jobId} />
      {completed && (
        <>
          <OpenedCases jobId={jobId} total={created} />
          <OpeningExclusions jobId={jobId} total={excluded} />
        </>
      )}
    </div>
  );
}

/** One of an opening's lists, a page at a time in employee-code order. */
function useOpeningList<T>(jobId: string, list: 'cases' | 'exclusions') {
  const keys = useKeys();
  const query = useInfiniteQuery({
    queryKey: keys.opening(jobId, list),
    queryFn: ({ pageParam }) =>
      api<OpeningPage<T>>(
        `/v1/increment-review-openings/${encodeURIComponent(jobId)}/${list}?${new URLSearchParams({ limit: String(OPENING_PAGE_SIZE), ...(pageParam ? { after: pageParam } : {}) })}`,
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextAfter ?? undefined,
    retry: retryTransient,
  });
  return { query, items: query.isSuccess ? query.data.pages.flatMap((p) => p.items) : [] };
}

function MoreRows({ query, shown, total, what }: { query: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown }; shown: number; total: number | null; what: string }) {
  return (
    <>
      {total !== null && shown < total && (
        <p className="hint">
          Showing {shown} of {total} {what}.
        </p>
      )}
      {query.hasNextPage && (
        <button type="button" className="secondary" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          Show more {what}
        </button>
      )}
    </>
  );
}

function OpenedCases({ jobId, total }: { jobId: string; total: number | null }) {
  const ids = useId();
  const { query, items } = useOpeningList<OpenedCase>(jobId, 'cases');
  return (
    <div>
      <h3 id={`${ids}-title`} style={H3}>
        Draft cases created
      </h3>
      {query.isPending && <p className="hint">Loading the cases…</p>}
      <LoadProblem error={query.error} forbidden="The selected role cannot read this review’s cases." />
      {query.isSuccess && items.length === 0 && <Empty>The opening created no draft case.</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-labelledby={`${ids}-title`}>
            <thead>
              <tr>
                <th scope="col">Employee</th>
                <th scope="col">Review</th>
                <th scope="col">Effective date</th>
                <th scope="col">Decisions due</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.caseId}>
                  <td>
                    {c.employeeName} ({c.employeeCode})
                  </td>
                  <td>{c.occurrence}</td>
                  <td>{formatDate(c.effectiveDate)}</td>
                  <td>{formatDate(c.decisionDueOn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <MoreRows query={query} shown={items.length} total={total} what="cases" />
    </div>
  );
}

function OpeningExclusions({ jobId, total }: { jobId: string; total: number | null }) {
  const ids = useId();
  const { query, items } = useOpeningList<OpeningExclusion>(jobId, 'exclusions');
  return (
    <div>
      <h3 id={`${ids}-title`} style={H3}>
        Excluded employees
      </h3>
      <p className="hint">Each employee of the cycle without a new case is listed with the reason and what repairs it.</p>
      {query.isPending && <p className="hint">Loading the exclusions…</p>}
      <LoadProblem error={query.error} forbidden="The selected role cannot read this review’s exclusions." />
      {query.isSuccess && items.length === 0 && <Empty>The opening excluded no employee.</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-labelledby={`${ids}-title`}>
            <thead>
              <tr>
                <th scope="col">Employee</th>
                <th scope="col">Reason</th>
                <th scope="col">What repairs it</th>
              </tr>
            </thead>
            <tbody>
              {items.map((x) => (
                <tr key={`${x.employeeId}:${x.occurrence}`}>
                  <td>
                    {x.employeeName} ({x.employeeCode})
                  </td>
                  <td>{exclusionReasonLabel(x.reason)}</td>
                  <td>{x.repairPath ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <MoreRows query={query} shown={items.length} total={total} what="exclusions" />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// FR-092 / DF15: cases, with amounts only when the server returned them, and the direct manager's proposal.
// ---------------------------------------------------------------------------------------------------------

function CasesSection({ onShowSalary }: { onShowSalary: ((employee: PickedEmployee) => void) | undefined }) {
  const { me, can } = useSession();
  const keys = useKeys();
  const [state, setState] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [sentFor, setSentFor] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ caseId: string; employeeCode: string; error: unknown } | null>(null);
  const cases = useQuery({
    queryKey: keys.cases(state),
    queryFn: () => api<{ items: IncrementCase[] }>(`/v1/increment-cases${state ? `?${new URLSearchParams({ state })}` : ''}`),
    retry: retryTransient,
  });
  const data = answered(cases);
  const items = data?.items ?? [];
  // The server includes amounts only for a caller holding the salary field grant (BR-044). The columns follow the
  // response, never the client's own reading of the permissions.
  const withAmounts = items.some((c) => c.baselineAmount !== undefined);
  // Only the employee's current direct manager may propose a cycle outcome, so a role without a linked employee record
  // cannot use the form. Off-cycle cases and cases that are pending or decided take no proposal.
  const canPropose = can(PROPOSE) && !!me?.employeeId;
  const proposable = (c: IncrementCase) => canPropose && !c.offCycle && (c.state === 'DRAFT' || c.state === 'RETURNED');
  const hasActions = !!onShowSalary || items.some(proposable);
  const columns = 5 + (withAmounts ? 2 : 0) + (hasActions ? 1 : 0);
  const filterLabel = STATE_FILTERS.find((f) => f.value === state)?.label ?? state;
  const formId = (caseId: string) => `increment-proposal-${caseId}`;
  // A refused proposal (409) reloads the list. When the case is still open its form stays and shows the refusal; when it
  // has moved on, the form closes, so the refusal is kept here: the new state must not read as this proposal being sent.
  const conflictCase = conflict ? items.find((c) => c.id === conflict.caseId) : undefined;
  const conflictInForm = conflict !== null && openId === conflict.caseId && conflictCase !== undefined && proposable(conflictCase);
  const toggle = (caseId: string | null) => {
    setSentFor(null);
    setConflict(null);
    setOpenId(caseId);
  };

  return (
    <Section title={`Increment cases${data ? ` (${items.length})` : ''}`}>
      <p className="hint">
        Submitted cases are decided by an independent Admin in the <DecisionInboxLink />; nothing is decided on this screen. A case changes no salary until it is
        approved.
      </p>
      {can(PROPOSE) && <p className="hint">Cycle outcomes are proposed by the employee’s current direct manager.</p>}
      <label className="inline">
        State{' '}
        <select
          value={state}
          onChange={(e) => {
            setState(e.target.value);
            toggle(null);
          }}
        >
          {STATE_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      {sentFor && (
        <p className="ok" role="status">
          Proposal for {sentFor} sent for an independent decision.
        </p>
      )}
      {conflict && !conflictInForm && (
        <div className="stack">
          <p className="hint">The proposal for {conflict.employeeCode} was not accepted, and the case list was reloaded. Check the case’s current state.</p>
          <ErrorNote error={conflict.error} />
        </div>
      )}
      {cases.isPending && <p className="hint">Loading cases…</p>}
      <LoadProblem error={cases.error} forbidden="The selected role cannot view increment cases." />
      {data && items.length === 0 && (
        <Empty>{state ? `No increment cases are in the state “${filterLabel}”.` : 'No increment cases yet. Cases appear when a review is opened or an off-cycle change is proposed.'}</Empty>
      )}
      {items.length > 0 && !withAmounts && (
        <p className="hint" role="note">
          Amounts are shown only to roles holding a confidential salary grant.
        </p>
      )}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table>
            <thead>
              <tr>
                <th scope="col">Employee</th>
                <th scope="col">Review</th>
                <th scope="col">Effective date</th>
                <th scope="col">State</th>
                <th scope="col">Proposed outcome</th>
                {withAmounts && <th scope="col">Baseline</th>}
                {withAmounts && <th scope="col">Proposed amount</th>}
                {hasActions && (
                  <th scope="col">
                    <span style={SR_ONLY}>Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {items.map((c) => {
                const canOpen = proposable(c);
                const open = canOpen && openId === c.id;
                return (
                  <Fragment key={c.id}>
                    <tr aria-current={open ? 'true' : undefined}>
                      <td>{c.employeeCode}</td>
                      <td>{c.offCycle ? 'Off-cycle' : c.occurrence}</td>
                      <td>{formatDate(c.effectiveDate)}</td>
                      <td>
                        <StateBadge state={c.state} />
                      </td>
                      <td>{c.proposedOutcome ? outcomeLabel(c.proposedOutcome) : '—'}</td>
                      {withAmounts && <td>{money(c.baselineAmount, c.currency)}</td>}
                      {withAmounts && <td>{money(c.proposedAmount, c.currency)}</td>}
                      {hasActions && (
                        <td>
                          <div className="row">
                            {canOpen && (
                              <button
                                type="button"
                                className="link"
                                aria-expanded={open}
                                aria-controls={open ? formId(c.id) : undefined}
                                aria-label={`${open ? 'Close proposal' : 'Propose outcome'} for ${c.employeeCode}`}
                                onClick={() => toggle(open ? null : c.id)}
                              >
                                {open ? 'Close proposal' : 'Propose outcome'}
                              </button>
                            )}
                            {onShowSalary && (
                              <button type="button" className="link" aria-label={`Salary for ${c.employeeCode}`} onClick={() => onShowSalary({ id: c.employeeId, employeeCode: c.employeeCode })}>
                                Salary
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={columns} id={formId(c.id)}>
                          <ProposalForm
                            kase={c}
                            onSent={() => {
                              toggle(null);
                              setSentFor(c.employeeCode);
                            }}
                            onConflict={(error) => setConflict({ caseId: c.id, employeeCode: c.employeeCode, error })}
                            onCancel={() => toggle(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/**
 * The direct manager's proposal for one cycle case (DF15). It is sent against the case version shown; an increase
 * states the new amount on the cycle's basis and the counterpart figure on the other basis, both exactly as typed.
 * No change and defer send no amounts.
 */
function ProposalForm({
  kase,
  onSent,
  onConflict,
  onCancel,
}: {
  kase: IncrementCase;
  onSent: () => void;
  onConflict: (error: unknown) => void;
  onCancel: () => void;
}) {
  const reloadCases = useReloadCases();
  const id = useId();
  const [outcome, setOutcome] = useState<Outcome | ''>('');
  const [amount, setAmount] = useState('');
  const [counterpart, setCounterpart] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const propose = useMutation({
    mutationFn: (body: ProposalBody) => api<ProposalResult>(`/v1/increment-cases/${encodeURIComponent(kase.id)}/proposal`, { body }),
    onSuccess: () => {
      reloadCases();
      onSent();
    },
    // A stale version or a case that moved on: reload so that a retry uses the current version and state.
    onError: (error) => {
      if (!isConflict(error)) return;
      reloadCases();
      onConflict(error);
    },
  });

  // Required fields and the money format only; every business rule (manager, state, version) is the server's.
  const check = (text: string): string | null => {
    if (outcome === '') return 'Choose the proposed outcome.';
    if (outcome === 'INCREASE') {
      const amountProblem = moneyProblem(amount, 'the new amount') ?? moneyProblem(counterpart, 'the counterpart figure');
      if (amountProblem) return amountProblem;
    }
    return text === '' ? 'Enter a reason.' : null;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = reason.trim();
    const missing = check(text);
    setProblem(missing);
    if (missing !== null || outcome === '') {
      propose.reset();
      return;
    }
    propose.mutate(
      outcome === 'INCREASE'
        ? { expectedVersion: kase.version, outcome, proposedAmount: amount, proposedCounterpart: counterpart, reason: text }
        : { expectedVersion: kase.version, outcome, reason: text },
    );
  };

  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        Proposal for {kase.employeeCode} ({kase.occurrence})
      </h3>
      {kase.state === 'RETURNED' && <p className="hint">The decision maker returned this case; propose again with any changes.</p>}
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit}>
        <label>
          Proposed outcome
          <select required value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome | '')}>
            <option value="">Choose…</option>
            {OUTCOMES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {outcome === 'INCREASE' && (
          <>
            <label>
              New amount on the cycle basis
              <input inputMode="decimal" autoComplete="off" required value={amount} aria-describedby={`${id}-money`} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label>
              Counterpart figure
              <input inputMode="decimal" autoComplete="off" required value={counterpart} aria-describedby={`${id}-money`} onChange={(e) => setCounterpart(e.target.value)} />
            </label>
            <p className="hint wide" id={`${id}-money`}>
              {kase.baselineAmount !== undefined && <>Current baseline on the cycle basis: {money(kase.baselineAmount, kase.currency)}. </>}
              Enter the new figure on the cycle’s basis and the matching figure on the other basis (annual CTC when the basis is monthly gross, monthly gross when it
              is annual CTC). Neither figure is worked out from the other.
            </p>
          </>
        )}
        {(outcome === 'NO_CHANGE' || outcome === 'DEFER') && <p className="hint wide">No change and defer outcomes create no salary revision.</p>}
        <label className="wide">
          Reason (required)
          <textarea required maxLength={1000} rows={3} style={TEXTAREA} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        {problem && (
          <p role="alert" className="error wide">
            {problem}
          </p>
        )}
        <div className="wide row">
          <button type="submit" disabled={propose.isPending}>
            Send proposal
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
        <div className="wide">
          <ErrorNote error={propose.error} />
          {isConflict(propose.error) && <p className="hint">The case list was reloaded; check this case and send the proposal again.</p>}
        </div>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// DF15 off-cycle change: proposed by HR, decided by a different financial Admin.
// ---------------------------------------------------------------------------------------------------------

const EMPTY_OFF_CYCLE = { effectiveDate: '', basis: 'MONTHLY_GROSS' as Basis, monthlyGross: '', annualCtc: '', reason: '' };

function OffCycleSection() {
  const reloadCases = useReloadCases();
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const [form, setForm] = useState(EMPTY_OFF_CYCLE);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const propose = useMutation({
    mutationFn: ({ body }: { body: OffCycleBody; label: string }) => api<ProposalResult>('/v1/increment-cases/off-cycle', { body }),
    onMutate: () => setSent(null),
    onSuccess: (_result, { label }) => {
      setSent(label);
      setEmployee(null);
      setForm(EMPTY_OFF_CYCLE);
      reloadCases();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = form.reason.trim();
    const missing =
      (employee === null ? 'Choose the employee first.' : null) ??
      (form.effectiveDate === '' ? 'Enter the effective date.' : null) ??
      moneyProblem(form.monthlyGross, 'the new monthly gross') ??
      moneyProblem(form.annualCtc, 'the new annual CTC') ??
      (text === '' ? 'Enter a reason.' : null);
    setProblem(missing);
    if (missing !== null || employee === null) {
      propose.reset();
      return;
    }
    // The basis decides which figure the increment is measured on; the other is its stated counterpart.
    const monthly = form.basis === 'MONTHLY_GROSS';
    propose.mutate({
      label: employeeLabel(employee),
      body: {
        employeeId: employee.id,
        effectiveDate: form.effectiveDate,
        basis: form.basis,
        proposedAmount: monthly ? form.monthlyGross : form.annualCtc,
        proposedCounterpart: monthly ? form.annualCtc : form.monthlyGross,
        reason: text,
      },
    });
  };

  return (
    <Section title="Propose an off-cycle change">
      <p className="hint">
        HR proposes an off-cycle change; a different financial Admin decides it in the <DecisionInboxLink />. The salary changes only once it is approved, in the
        currency of the employee’s current salary.
      </p>
      <EmployeePicker
        label="Find employee for the off-cycle change"
        selected={employee}
        onSelect={(e) => {
          setEmployee(e);
          setSent(null);
        }}
      />
      <form className="grid-form" aria-label="Off-cycle change" style={PANEL} onSubmit={submit}>
        <label>
          Effective date
          <input type="date" required value={form.effectiveDate} onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })} />
        </label>
        <label>
          Increment basis
          <select value={form.basis} onChange={(e) => setForm({ ...form, basis: e.target.value as Basis })}>
            {BASES.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          New monthly gross
          <input inputMode="decimal" autoComplete="off" required value={form.monthlyGross} onChange={(e) => setForm({ ...form, monthlyGross: e.target.value })} />
        </label>
        <label>
          New annual CTC
          <input inputMode="decimal" autoComplete="off" required value={form.annualCtc} onChange={(e) => setForm({ ...form, annualCtc: e.target.value })} />
        </label>
        <p className="hint wide">
          The increment and its percentage are measured on the {BASES.find((b) => b.value === form.basis)?.inSentence ?? basisLabel(form.basis)}. Enter both
          figures; neither is worked out from the other.
        </p>
        <label className="wide">
          Reason (required)
          <textarea required maxLength={1000} rows={3} style={TEXTAREA} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </label>
        {problem && (
          <p role="alert" className="error wide">
            {problem}
          </p>
        )}
        <div className="wide row">
          <button type="submit" disabled={propose.isPending}>
            Send off-cycle proposal
          </button>
        </div>
      </form>
      {sent && (
        <p className="ok" role="status">
          Off-cycle proposal for {sent} sent for an independent decision.
        </p>
      )}
      <ErrorNote error={propose.error} />
    </Section>
  );
}

/** Finds an employee in the selected role's scope (the server limits the list). */
function EmployeePicker({ label, selected, onSelect }: { label: string; selected: PickedEmployee | null; onSelect: (employee: PickedEmployee | null) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const canSearch = can(LIST_EMPLOYEES);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const hits = useQuery({
    queryKey: keys.employeeSearch(term),
    enabled: canSearch && selected === null && term !== '',
    queryFn: () => api<{ items: EmployeeHit[]; total: number }>(`/v1/employees?${new URLSearchParams({ search: term, page: '1', pageSize: String(EMPLOYEE_PAGE_SIZE) })}`),
    retry: retryTransient,
  });
  const found = answered(hits);

  if (selected) {
    return (
      <p>
        Employee: <strong>{employeeLabel(selected)}</strong>{' '}
        <button type="button" className="link" onClick={() => onSelect(null)}>
          Choose another employee
        </button>
      </p>
    );
  }
  if (!canSearch) return <NotPermitted>The selected role cannot search employees, so it cannot pick one here.</NotPermitted>;
  const items = found?.items ?? [];
  return (
    <div className="stack">
      <label className="inline" style={FLUSH}>
        {label}
        <input type="search" value={search} maxLength={100} placeholder="Name, code or work email" onChange={(e) => setSearch(e.target.value)} />
      </label>
      {term === '' && <p className="hint">Type a name, employee code or work email.</p>}
      {term !== '' && hits.isPending && <p className="hint">Searching…</p>}
      <LoadProblem error={hits.error} forbidden="The selected role cannot search employees." />
      {found && items.length === 0 && <Empty>No employees match “{term}”.</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span style={SR_ONLY}>Choose</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td>{e.employeeCode}</td>
                  <td>{e.displayName}</td>
                  <td>
                    <StateBadge state={e.status} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Choose ${e.displayName} (${e.employeeCode})`}
                      onClick={() => onSelect({ id: e.id, employeeCode: e.employeeCode, displayName: e.displayName })}
                    >
                      Choose
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {found && found.total > items.length && (
            <p className="hint">
              Showing the first {items.length} of {found.total}; refine the search to narrow it down.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// FR-029 / FR-089 / FR-090 / DF14: one employee's salary arrangements, increment history and annual growth.
// Each part needs its own confidential grant; the server re-checks every request.
// ---------------------------------------------------------------------------------------------------------

function SalaryPanel({ employee, onEmployee, focusRequest }: { employee: PickedEmployee | null; onEmployee: (employee: PickedEmployee | null) => void; focusRequest: number }) {
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

function EmployeeSalary({ employee }: { employee: PickedEmployee }) {
  const { can } = useSession();
  const keys = useKeys();
  const ids = useId();
  const canReadSalary = can(SALARY_READ);
  const canReadIncrements = can(READ_SALARY);
  const canManage = can(SALARY_MANAGE);
  const [recorded, setRecorded] = useState(false);
  const path = `/v1/employees/${encodeURIComponent(employee.id)}`;
  const salary = useQuery({ queryKey: keys.salary(employee.id), enabled: canReadSalary, queryFn: () => api<{ items: SalaryArrangement[] }>(`${path}/salary`), retry: retryTransient });
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
  const scopeNote = 'This employee is not in the selected role’s scope.';

  return (
    <div className="stack" style={PANEL}>
      {canReadSalary && (
        <div>
          <h3 id={`${ids}-salary`} style={H3}>
            Salary arrangements
          </h3>
          {salary.isPending && <p className="hint">Loading salary…</p>}
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
          {history.isPending && <p className="hint">Loading increment history…</p>}
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
      {requested && growth.isPending && <p className="hint">Loading annual growth…</p>}
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
