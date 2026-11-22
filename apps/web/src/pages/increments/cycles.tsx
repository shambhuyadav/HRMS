// FR-091 / DF15: increment cycles and opening a review for a year (the roster snapshot, queued as a bulk job).

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { CardSubheading } from '@/components/card-subheading';
import { FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate, plural, readable, retryTransient } from '../../api';
import { Badge, Empty, ErrorNote, Notice, Section } from '../../ui';
import { BulkJobStatus, exclusionReasonLabel, useBulkJob } from '../bulk-jobs';
import {
  answered,
  basisLabel,
  type Cycle,
  FIELD_ROW,
  LoadProblem,
  type OpenedCase,
  OPENING_PAGE_SIZE,
  type OpeningExclusion,
  type OpeningPage,
  PANEL,
  type QueuedJob,
  RECURRENCE_LABEL,
  useKeys,
  YEAR,
  YEAR_INPUT,
} from './shared';

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
    if (!c.active) return <Hint as="span">Inactive cycle</Hint>;
    if (c.recurrenceBasis !== 'COMMON_DATE') return <Hint as="span">No common review date</Hint>;
    if (!companyWide) return <Hint as="span">Reviews are opened from a company-wide role</Hint>;
    return (
      <form className={FIELD_ROW} aria-label={`Open a review of ${c.code} revision ${c.revision}`} onSubmit={(e) => submit(e, c)}>
        <FormField className="w-auto">
          Review year
          <Input
            type="number"
            inputMode="numeric"
            min={2000}
            max={2100}
            step={1}
            required
            className={YEAR_INPUT}
            value={yearOf(c.id)}
            onChange={(e) => setYears({ ...years, [c.id]: e.target.value })}
          />
        </FormField>
        <Button type="submit" disabled={open.isPending}>
          Open review
        </Button>
        {problem?.cycleId === c.id && <Notice notice={{ text: problem.text, ok: false }} />}
      </form>
    );
  };

  return (
    <Section title="Increment cycles">
      <Hint>A cycle is a review schedule, not an entitlement: opening a review creates draft cases for the eligible employees and changes no salary.</Hint>
      {companyWide && <Hint>Type the review year: the cases take effect on the cycle’s review date in that year.</Hint>}
      {cycles.isPending && <LoadingLine>Loading cycles…</LoadingLine>}
      <LoadProblem error={cycles.error} forbidden="The selected role cannot manage increment cycles." />
      {data && items.length === 0 && <Empty>No increment cycles are configured for this company.</Empty>}
      {items.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Cycle</TableHead>
              <TableHead scope="col">Revision</TableHead>
              <TableHead scope="col">Recurrence</TableHead>
              <TableHead scope="col">Basis</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Review</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((c) => (
              <TableRow key={c.id}>
                <TableCell>{readable(c.code)}</TableCell>
                <TableCell>{c.revision}</TableCell>
                <TableCell>{RECURRENCE_LABEL[c.recurrenceBasis] ?? readable(c.recurrenceBasis)}</TableCell>
                <TableCell>{basisLabel(c.compensationBasis)}</TableCell>
                <TableCell>
                  <Badge tone={c.active ? 'good' : 'neutral'}>{c.active ? 'active' : 'inactive'}</Badge>
                </TableCell>
                <TableCell>{reviewControl(c)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {queued && <OpeningJob key={queued.jobId} cycle={queued.cycle} year={queued.year} jobId={queued.jobId} />}
      <ErrorNote error={open.error} />
    </Section>
  );
}

/** Where a queued opening stands, in words: opened (with what it did), stopped, or still queued. */
function OpeningOutcome({ review, state, created, excluded }: { review: string; state: string | undefined; created: number | null; excluded: number | null }) {
  if (state === 'COMPLETED') {
    const counts = created !== null && excluded !== null ? `: ${plural(created, 'draft case', 'draft cases')} created, ${plural(excluded, 'employee', 'employees')} excluded` : '';
    return <Notice notice={{ text: `Review of ${review} opened${counts}. It changed no salary.`, ok: true }} />;
  }
  if (state === 'FAILED') return <Hint role="status">The review of {review} stopped before it finished; the reason is below.</Hint>;
  return (
    <Notice
      notice={{ text: `Review of ${review} queued. The draft cases are created in the background and appear in the case list once the opening has run.`, ok: true }}
    />
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
    <div className={PANEL}>
      <OpeningOutcome review={review} state={state} created={created} excluded={excluded} />
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
        <Hint>
          Showing {shown} of {total} {what}.
        </Hint>
      )}
      {query.hasNextPage && (
        <Button type="button" variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          Show more {what}
        </Button>
      )}
    </>
  );
}

function OpenedCases({ jobId, total }: { jobId: string; total: number | null }) {
  const ids = useId();
  const { query, items } = useOpeningList<OpenedCase>(jobId, 'cases');
  return (
    <div>
      <CardSubheading id={`${ids}-title`}>Draft cases created</CardSubheading>
      {query.isPending && <LoadingLine>Loading the cases…</LoadingLine>}
      <LoadProblem error={query.error} forbidden="The selected role cannot read this review’s cases." />
      {query.isSuccess && items.length === 0 && <Empty>The opening created no draft case.</Empty>}
      {items.length > 0 && (
        <Table aria-labelledby={`${ids}-title`}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Employee</TableHead>
              <TableHead scope="col">Review</TableHead>
              <TableHead scope="col">Effective date</TableHead>
              <TableHead scope="col">Decisions due</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((c) => (
              <TableRow key={c.caseId}>
                <TableCell>
                  {c.employeeName} ({c.employeeCode})
                </TableCell>
                <TableCell>{c.occurrence}</TableCell>
                <TableCell>{formatDate(c.effectiveDate)}</TableCell>
                <TableCell>{formatDate(c.decisionDueOn)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
      <CardSubheading id={`${ids}-title`}>Excluded employees</CardSubheading>
      <Hint>Each employee of the cycle without a new case is listed with the reason and what repairs it.</Hint>
      {query.isPending && <LoadingLine>Loading the exclusions…</LoadingLine>}
      <LoadProblem error={query.error} forbidden="The selected role cannot read this review’s exclusions." />
      {query.isSuccess && items.length === 0 && <Empty>The opening excluded no employee.</Empty>}
      {items.length > 0 && (
        <Table aria-labelledby={`${ids}-title`}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Employee</TableHead>
              <TableHead scope="col">Reason</TableHead>
              <TableHead scope="col">What repairs it</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((x) => (
              <TableRow key={`${x.employeeId}:${x.occurrence}`}>
                <TableCell>
                  {x.employeeName} ({x.employeeCode})
                </TableCell>
                <TableCell>{exclusionReasonLabel(x.reason)}</TableCell>
                <TableCell>{x.repairPath ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <MoreRows query={query} shown={items.length} total={total} what="exclusions" />
    </div>
  );
}
