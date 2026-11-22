// Missed submissions (BR-049): a reminder and a pending follow-up, never a penalty.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { CardSubheading } from '@/components/card-subheading';
import { FilterBar, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { api, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, LIST_PAGE_SIZE, NotPermitted, pageParams, Pager, Section, When } from '../../ui';
import { ReadProblem, Refusal } from './refusals';
import { PATHS, Problem, shown, TS_READ, TS_RESOLVE, useKeys, weekText } from './shared';
import type { MissedWeek } from './types';

// ---------------------------------------------------------------------------------------------------------
// Screen: missed submissions (BR-049: a reminder and a pending follow-up, never a penalty)
// ---------------------------------------------------------------------------------------------------------
export function missedText(x: MissedWeek): string {
  if (x.state === 'OPEN') return 'Open: not submitted yet';
  if (x.resolution === 'SUBMITTED') return 'Resolved: submitted late';
  if (x.resolution === 'DOCUMENTED') return 'Resolved with a documented reason';
  return readable(x.state);
}

export function MissedScreen() {
  const { can } = useSession();
  const keys = useKeys();
  const [state, setState] = useState('OPEN');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const query = new URLSearchParams(Object.entries({ state, from, to }).filter(([, v]) => v !== '')).toString();
  // FR-056: one page at a time (back to the first page when a filter changes); `total` counts every match in scope.
  const [paging, setPaging] = useState({ query, page: 1 });
  const page = paging.query === query ? paging.page : 1;
  const list = useQuery({
    queryKey: keys.missedList(`${query}#${page}`),
    queryFn: () => api<{ items: MissedWeek[]; total?: number }>(`/v1/timesheet-exceptions?${query ? `${query}&` : ''}${pageParams(page)}`),
    enabled: can(TS_READ),
    retry: retryTransient,
  });
  if (!can(TS_READ)) return <NotPermitted>The selected role cannot see missed timesheets.</NotPermitted>;
  const data = shown(list);
  return (
    <Section title="Missed timesheets">
      <Hint>A week that was due and not submitted raises one reminder to the employee and a follow-up here. It is never a deduction or a penalty; a late submission resolves it.</Hint>
      <FilterBar>
        <FormField>
          Status
          <NativeSelect value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All</option>
            <option value="OPEN">Open</option>
            <option value="RESOLVED">Resolved</option>
          </NativeSelect>
        </FormField>
        <FormField>
          Weeks from
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </FormField>
        <FormField>
          Weeks to
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </FormField>
      </FilterBar>
      <ReadProblem error={list.error} what="missed timesheets" />
      {list.isPending && <LoadingLine>Loading missed timesheets…</LoadingLine>}
      {data && data.items.length === 0 && <Empty>No missed timesheets match.</Empty>}
      {data && data.items.length > 0 && (
        <ul className="tasks" aria-label="Missed timesheets">
          {data.items.map((x) => (
            <MissedItem key={x.id} x={x} />
          ))}
        </ul>
      )}
      {data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={data.total ?? data.items.length} onPage={(p) => setPaging({ query, page: p })} label="Missed timesheet pages" noun="missed timesheet" />}
    </Section>
  );
}

function MissedItem({ x }: { x: MissedWeek }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const id = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const resolve = useMutation({
    mutationFn: (body: { reason: string }) => api<MissedWeek>(`/v1/timesheet-exceptions/${encodeURIComponent(x.id)}/resolve`, { body }),
    onSuccess: () => {
      setReason('');
      void qc.invalidateQueries({ queryKey: keys.missed });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (resolve.isPending) return;
    if (!reason.trim()) {
      setProblem('Enter the documented reason for resolving the reminder.');
      return;
    }
    setProblem(null);
    resolve.mutate({ reason: reason.trim() });
  };
  return (
    <li aria-labelledby={`${id}-title`}>
      <CardSubheading id={`${id}-title`}>
        {x.employeeName} ({x.employeeCode}): {weekText(x)}
      </CardSubheading>
      <p className="m-0">
        Due {formatDate(x.dueDate)} · reminder raised {formatDate(x.raisedOn)} · {missedText(x)}
        {x.resolvedAt && (
          <>
            {' '}
            on <When at={x.resolvedAt} />
          </>
        )}
      </p>
      {x.resolutionReason && <Hint className="m-0">Reason: {x.resolutionReason}</Hint>}
      {x.timesheetId && <Link to={PATHS.timesheet(x.timesheetId)}>Open the submitted timesheet</Link>}
      {x.state === 'OPEN' && can(TS_RESOLVE) && (
        <form aria-label={`Resolve the reminder of ${x.employeeCode} for ${formatDate(x.periodStart)}`} onSubmit={submit} noValidate className="stack">
          <FormField>
            Documented resolution reason
            <Textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <Problem text={problem} />
          <Refusal error={resolve.error} act="resolve" />
          <div>
            <Button type="submit" disabled={resolve.isPending}>
              Resolve reminder
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}
