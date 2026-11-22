// Custody requests (Admin): the decision queue and the list within row scope.

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ButtonRow, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { PagerButton, PagerCount, PagerRow } from '@/components/pager';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, Notice, NotPermitted, Section, When } from '../../ui';
import { DelegatedBadge } from '../delegations';
import { RequestHistory } from './employee-assets';
import { Problem, QueryProblem, Refusal, refusalText } from './refusals';
import {
  holderLabel,
  optional,
  PAGE_SIZE,
  PATHS,
  REQUEST_DECIDE,
  REQUEST_FILTERS,
  REQUEST_READ,
  shown,
  useAttemptKey,
  useKeys,
  useRefetchAll,
} from './shared';
import type { AssetRequest, Page, RequestTask } from './types';

// ---------------------------------------------------------------------------------------------------------
// Custody requests (Admin): the decision queue and the list within row scope
// ---------------------------------------------------------------------------------------------------------
export function RequestsScreen() {
  const { can } = useSession();
  return (
    <div className="flex flex-col gap-3">
      <h1>Custody requests</h1>
      <Hint>
        Approving a request records the decision only: it never issues an item. Issue the item from the <Link to={PATHS.register}>asset register</Link> and name the
        approved request there.
      </Hint>
      {can(REQUEST_DECIDE) && <CustodyRequestQueue />}
      {can(REQUEST_READ) && <RequestList />}
      {!can(REQUEST_DECIDE) && !can(REQUEST_READ) && <NotPermitted>The selected role cannot read or decide custody requests.</NotPermitted>}
    </div>
  );
}

function RequestList() {
  const keys = useKeys();
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const q = new URLSearchParams();
  if (filter === 'UNFULFILLED') q.set('unfulfilled', 'true');
  else if (filter) q.set('state', filter);
  q.set('page', String(page));
  q.set('pageSize', String(PAGE_SIZE));
  const query = q.toString();
  const list = useQuery({ queryKey: keys.requests(query), queryFn: () => api<Page<AssetRequest>>(`/v1/asset-requests?${query}`), retry: retryTransient });
  const data = shown(list);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <Section title="All custody requests">
      <FormField>
        Show
        <NativeSelect
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(1);
          }}
        >
          {REQUEST_FILTERS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      {list.isPending && <LoadingLine>Loading the requests…</LoadingLine>}
      <QueryProblem error={list.error} forbidden="The selected role cannot read custody requests." />
      {data && <RequestHistory requests={data.items} label="Custody requests" empty="No custody requests match." showEmployee />}
      {data && data.items.length > 0 && (
        <PagerRow>
          <PagerButton disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous page
          </PagerButton>
          <PagerCount>
            Page {data.page} of {pages} · {data.total} request{data.total === 1 ? '' : 's'}
          </PagerCount>
          <PagerButton disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next page
          </PagerButton>
        </PagerRow>
      )}
    </Section>
  );
}

/** The independent reviewer's queue (GET /v1/asset-requests/tasks/mine): approve, or reject with a note the employee never sees. */
export function CustodyRequestQueue() {
  const keys = useKeys();
  const refetchAll = useRefetchAll();
  const region = useRef<HTMLDivElement>(null);
  const tasks = useQuery({ queryKey: keys.tasks, queryFn: () => api<{ items: RequestTask[] }>('/v1/asset-requests/tasks/mine'), retry: retryTransient });
  /** Tasks decided here, or found closed: they leave the queue at once, before it has reloaded. */
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const data = shown(tasks);
  const items = (data?.items ?? []).filter((t) => !gone.has(t.taskId));
  const done = (t: RequestTask, text: string, ok: boolean) => {
    setGone((prev) => new Set(prev).add(t.taskId));
    setNotice({ text, ok });
    void refetchAll();
    const active = document.activeElement;
    if (!active || active === document.body || region.current?.contains(active)) region.current?.focus();
  };
  return (
    <div ref={region} role="region" aria-label="Custody requests to decide" tabIndex={-1}>
      <Section title={`Custody requests to decide${data ? ` (${items.length})` : ''}`}>
        <Hint>Approve a request, or reject it with a note. Approval issues nothing: the item is issued separately from the register.</Hint>
        {tasks.isPending && <LoadingLine>Loading the requests waiting for you…</LoadingLine>}
        <QueryProblem error={tasks.error} forbidden="The selected role cannot decide custody requests." action="decide" />
        <Notice notice={notice} />
        {data && items.length === 0 && <Empty>No custody requests are waiting for your decision.</Empty>}
        {items.length > 0 && (
          // `tasks`: the decision-list marker class that styles.css draws each request by, also in the decision inbox.
          <ul className="tasks" aria-label="Custody requests waiting for your decision">
            {items.map((t) => (
              <TaskItem key={t.taskId} task={t} onFinished={done} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/** Who asked: from the request when the role may see it, else from the task's owner, else "An employee". */
function requesterLabel(t: RequestTask): string {
  if (t.request) return holderLabel(t.request);
  return t.ownerName ? holderLabel({ employeeName: t.ownerName, employeeCode: t.ownerEmployeeCode ?? undefined }) : 'An employee';
}

function TaskItem({ task: t, onFinished }: { task: RequestTask; onFinished: (t: RequestTask, text: string, ok: boolean) => void }) {
  const attempt = useAttemptKey('asset-decision');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const r = t.request;
  const who = requesterLabel(t);
  const decide = useMutation({
    mutationFn: (body: { decision: 'APPROVE' | 'REJECT'; reason?: string; idempotencyKey: string }) =>
      api<{ requestId: string; state: string }>(`/v1/asset-requests/tasks/${t.taskId}/decision`, { method: 'POST', body }),
    onSuccess: (result) => {
      attempt.reset();
      onFinished(
        t,
        result.state === 'APPROVED'
          ? `The request of ${who} was approved. No item has been issued: issue one from the register.`
          : `The request of ${who} was rejected. Your note is not shown to the employee.`,
        true,
      );
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.reset();
      if (error instanceof ApiError && (error.code === 'TASK_CLOSED' || error.code === 'NOT_FOUND')) onFinished(t, refusalText(error, 'decide') ?? error.message, false);
    },
  });
  const send = (decision: 'APPROVE' | 'REJECT') => {
    const reason = note.trim();
    if (decision === 'REJECT' && !reason) return setProblem('Enter a note explaining the rejection. The employee never sees it.');
    setProblem(null);
    const content = { decision, ...(reason ? { reason } : {}) };
    decide.mutate({ ...content, idempotencyKey: attempt.keyFor(JSON.stringify(content)) });
  };
  return (
    <li aria-label={`Custody request of ${who}`}>
      <strong>{who}</strong>
      <DelegatedBadge taskId={t.taskId} />
      {r ? (
        <>
          <dl className="kv">
            <Item term="Category">{r.category.label}</Item>
            <Item term="Item asked for">{optional(r.itemDescription)}</Item>
            <Item term="Reason">{r.reason}</Item>
            <Item term="Submitted">
              <When at={r.submittedAt} />
            </Item>
          </dl>
          {r.currentlyHeld !== undefined && (
            <div>
              <p className="m-0">Items the employee holds now:</p>
              {r.currentlyHeld.length === 0 ? (
                <Empty>None.</Empty>
              ) : (
                <ul aria-label={`Items ${who} holds now`}>
                  {r.currentlyHeld.map((h) => (
                    <li key={`${h.assetCode}-${h.issuedOn}`}>
                      {h.assetCode} · {h.category} · {h.description} · issued {formatDate(h.issuedOn)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <FormField>
            Note (required to reject; the employee never sees it)
            <Textarea rows={2} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          </FormField>
          <ButtonRow>
            <Button type="button" disabled={decide.isPending} onClick={() => send('APPROVE')}>
              Approve
            </Button>
            <Button type="button" variant="danger" disabled={decide.isPending} onClick={() => send('REJECT')}>
              Reject
            </Button>
          </ButtonRow>
          <Problem text={problem} />
          <Refusal error={decide.error} action="decide" />
        </>
      ) : (
        <Hint>This request’s employee is outside the selected role’s scope, so it cannot be shown or decided here.</Hint>
      )}
    </li>
  );
}
