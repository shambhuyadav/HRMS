// FR-091 / DF15: increment cycles and opening a review for a year (the roster snapshot, queued as a bulk job).

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { api, formatDate, plural, readable, retryTransient } from '../../api';
import { Badge, Empty, ErrorNote, Section } from '../../ui';
import { BulkJobStatus, exclusionReasonLabel, useBulkJob } from '../bulk-jobs';
import { answered, basisLabel, type Cycle, FLUSH, H3, LoadProblem, type OpenedCase, OPENING_PAGE_SIZE, type OpeningExclusion, type OpeningPage, PANEL, type QueuedJob, RECURRENCE_LABEL, SCROLL, useKeys, YEAR, YEAR_INPUT } from './shared';

// ---------------------------------------------------------------------------------------------------------
// FR-091 / DF15: cycles and opening a review for a year (the roster snapshot, queued as a bulk job; it changes no
// salary).
// ---------------------------------------------------------------------------------------------------------

export function CyclesSection({ companyWide }: { companyWide: boolean }) {
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
      {cycles.isPending && <p className="hint loading">Loading cycles…</p>}
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
                  <td>{readable(c.code)}</td>
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
      {query.isPending && <p className="hint loading">Loading the cases…</p>}
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
      {query.isPending && <p className="hint loading">Loading the exclusions…</p>}
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
