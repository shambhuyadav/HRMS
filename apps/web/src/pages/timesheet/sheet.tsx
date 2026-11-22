// One timesheet: its revisions, the lines of the revision shown, decisions and reopen requests; the timesheet list.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { CardSubheading } from '@/components/card-subheading';
import { FilterBar, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, LIST_PAGE_SIZE, Notice, NotPermitted, pageParams, Pager, Section, StateBadge, When } from '../../ui';
import { ReadProblem, Refusal } from './refusals';
import {
  DECISION_LABEL,
  hm,
  lateText,
  ORIGIN_LABEL,
  PATHS,
  Problem,
  Remark,
  SHEET_STATES,
  shown,
  TS_READ,
  TS_REQUEST_REOPEN,
  TS_SUBMIT,
  useKeys,
  weekText,
} from './shared';
import type { Line, SheetDetail, SheetSummary } from './types';

// ---------------------------------------------------------------------------------------------------------
// One timesheet: its revisions, the lines of the revision shown, decisions and reopen requests
// ---------------------------------------------------------------------------------------------------------
export function SheetFacts({ s }: { s: SheetDetail }) {
  return (
    <dl className="kv">
      <Item term="Employee">
        {s.employeeName} ({s.employeeCode})
      </Item>
      <Item term="Week">{weekText(s)}</Item>
      <Item term="Due">{formatDate(s.dueDate)}</Item>
      <Item term="Status">
        <StateBadge state={s.state} />
        {s.pendingWith && <Remark>with {s.pendingWith}</Remark>}
      </Item>
      <Item term="Current revision">{s.currentRevision}</Item>
      <Item term="Approved revision in force">{s.approvedRevision ?? '—'}</Item>
      <Item term="First submission">
        {s.firstSubmittedAt ? (
          <>
            <When at={s.firstSubmittedAt} /> · {lateText(s.late)}
          </>
        ) : (
          'Not yet submitted'
        )}
      </Item>
    </dl>
  );
}

export function RevisionTable({ s, onShow }: { s: SheetDetail; onShow: (revision: number) => void }) {
  return (
    <Table aria-label="Revisions">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Revision</TableHead>
          <TableHead scope="col">Origin</TableHead>
          <TableHead scope="col">Status</TableHead>
          <TableHead scope="col">Submitted</TableHead>
          <TableHead scope="col">Decided</TableHead>
          <TableHead scope="col">Lines and time</TableHead>
          <TableHead scope="col">Show</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {s.revisions.map((r) => (
          <TableRow key={r.revision}>
            <TableCell>
              {r.revision}
              {r.revision === s.approvedRevision && <Remark>approved revision in force</Remark>}
            </TableCell>
            <TableCell>
              {ORIGIN_LABEL[r.origin] ?? readable(r.origin)}
              {r.previousRevision !== null && <Remark>follows revision {r.previousRevision}</Remark>}
            </TableCell>
            <TableCell>
              <StateBadge state={r.state} />
              {r.supersededByRevision !== null && <Remark>superseded by revision {r.supersededByRevision}</Remark>}
            </TableCell>
            <TableCell>{r.submittedOn ? `${formatDate(r.submittedOn)} · ${lateText(r.late)}` : '—'}</TableCell>
            <TableCell>
              <When at={r.decidedAt} />
              {r.decisionReason && <Remark>Reason: {r.decisionReason}</Remark>}
            </TableCell>
            <TableCell>
              {r.lineCount} lines · {hm(r.totalMinutes)}
            </TableCell>
            <RowActionsCell>
              {r.revision === s.shownRevision ? (
                'Shown'
              ) : (
                <RowActions>
                  <Button type="button" variant="outline" size="sm" onClick={() => onShow(r.revision)}>
                    Show revision {r.revision}
                  </Button>
                </RowActions>
              )}
            </RowActionsCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function LinesTable({ s, actions }: { s: SheetDetail; actions?: (l: Line) => ReactNode }) {
  if (s.lines.length === 0) return <Empty>No lines in revision {s.shownRevision}.</Empty>;
  return (
    <>
      <Table aria-label={`Lines of revision ${s.shownRevision}`}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Work date</TableHead>
            <TableHead scope="col">Project and job</TableHead>
            <TableHead scope="col">Activity</TableHead>
            <TableHead scope="col">Time</TableHead>
            <TableHead scope="col">Note</TableHead>
            {actions && <TableHead scope="col">Change</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {s.lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell>{formatDate(l.workDate)}</TableCell>
              <TableCell>
                {l.projectCode} / {l.jobCode}: {l.jobName}
              </TableCell>
              <TableCell>
                {l.activityCode}: {l.activityName}
                <Remark>{l.productive ? 'productive' : 'not productive'}</Remark>
              </TableCell>
              <TableCell>{hm(l.minutes)}</TableCell>
              <TableCell>{l.note ?? '—'}</TableCell>
              {actions && <RowActionsCell>{actions(l)}</RowActionsCell>}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Hint>
        Daily totals: {s.dailyTotals.map((d) => `${formatDate(d.workDate)} ${d.hours} h`).join(' · ')} · Revision total {hm(s.totalMinutes)}
      </Hint>
    </>
  );
}

export function SheetHistory({ s }: { s: SheetDetail }) {
  return (
    <>
      <CardSubheading>Decisions</CardSubheading>
      {s.decisions.length === 0 ? (
        <Empty>No decisions yet.</Empty>
      ) : (
        <ul aria-label="Decisions">
          {s.decisions.map((d, i) => (
            <li key={i}>
              Revision {d.revision}: {DECISION_LABEL[d.decision] ?? readable(d.decision)} · <When at={d.decidedAt} />
            </li>
          ))}
        </ul>
      )}
      <CardSubheading>Reopen requests</CardSubheading>
      {s.reopenRequests.length === 0 ? (
        <Empty>No reopen requests.</Empty>
      ) : (
        <ul aria-label="Reopen requests">
          {s.reopenRequests.map((r) => (
            <li key={r.id}>
              About approved revision {r.approvedRevision}: <StateBadge state={r.state} /> · requested <When at={r.requestedAt} />
              {r.decidedAt && (
                <>
                  {' '}
                  · decided <When at={r.decidedAt} />
                </>
              )}
              {r.newRevision !== null && ` · correction opened as revision ${r.newRevision}`}
              <Remark>Reason: {r.reason}</Remark>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** F1: an approved timesheet is corrected only after an independent reopen decision; the request needs a reason. */
export function ReopenRequestForm({ s }: { s: SheetDetail }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const send = useMutation({
    mutationFn: (body: { reason: string }) => api<{ reopenRequestId: string; state: string }>(`/v1/timesheets/${encodeURIComponent(s.id)}/reopen-requests`, { body }),
    onSuccess: () => {
      setReason('');
      setNotice({ text: 'Reopen request sent. An independent HR reviewer decides it; the approved revision stays in force until a correction is approved.', ok: true });
      void qc.invalidateQueries({ queryKey: keys.sheets });
      void qc.invalidateQueries({ queryKey: keys.own });
    },
  });
  if (!can(TS_REQUEST_REOPEN) || s.state !== 'APPROVED') return <Notice notice={notice} />;
  if (s.reopenRequests.some((r) => r.state === 'SUBMITTED'))
    return (
      <>
        <Notice notice={notice} />
        <Hint>A reopen request is waiting for an independent HR reviewer.</Hint>
      </>
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (send.isPending) return;
    setNotice(null);
    if (!reason.trim()) {
      setProblem('Enter why the approved timesheet needs a correction.');
      return;
    }
    setProblem(null);
    send.mutate({ reason: reason.trim() });
  };
  return (
    <form aria-label="Request a reopen" onSubmit={submit} noValidate className="stack mt-3">
      <FormField>
        Reason for reopening the approved timesheet
        <Textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      <Problem text={problem} />
      <Refusal error={send.error} act="reopen-request" />
      <Notice notice={notice} />
      <div>
        <Button type="submit" disabled={send.isPending}>
          Request reopen
        </Button>
      </div>
    </form>
  );
}

export function useSheet(id: string, revision: number | null, enabled = true) {
  const keys = useKeys();
  return useQuery({
    queryKey: keys.sheet(id, revision),
    queryFn: () => api<SheetDetail>(`/v1/timesheets/${encodeURIComponent(id)}${revision !== null ? `?revision=${revision}` : ''}`),
    enabled: enabled && id !== '',
    retry: retryTransient,
  });
}

export function TimesheetScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const raw = params.get('revision');
  const revision = raw && /^\d{1,6}$/.test(raw) ? Number(raw) : null;
  const detail = useSheet(id, revision, can(TS_READ));
  if (!can(TS_READ)) return <NotPermitted>The selected role cannot see timesheets.</NotPermitted>;
  const s = shown(detail);
  return (
    <div className="stack">
      <p>
        <Link to={PATHS.timesheets}>All timesheets</Link>
      </p>
      <Section title={s ? `Timesheet of ${s.employeeName} for ${weekText(s)}` : 'Timesheet'}>
        {detail.isPending && <LoadingLine>Loading the timesheet…</LoadingLine>}
        <ReadProblem error={detail.error} what="this timesheet" />
        {s && (
          <>
            <SheetFacts s={s} />
            <CardSubheading>Revisions</CardSubheading>
            <RevisionTable s={s} onShow={(r) => setParams(r === s.currentRevision ? {} : { revision: String(r) })} />
            <CardSubheading>Lines of revision {s.shownRevision}</CardSubheading>
            <LinesTable s={s} />
            <SheetHistory s={s} />
            <ReopenRequestForm s={s} />
          </>
        )}
      </Section>
    </div>
  );
}

/** CL-138: timesheets whose week overlaps the range, within the role's row scope. */
export function TimesheetsScreen() {
  const { can, me } = useSession();
  const keys = useKeys();
  const [state, setState] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const query = new URLSearchParams(Object.entries({ state, from, to }).filter(([, v]) => v !== '')).toString();
  // FR-056: one page at a time (back to the first page when a filter changes); `total` counts every match in scope.
  const [paging, setPaging] = useState({ query, page: 1 });
  const page = paging.query === query ? paging.page : 1;
  const list = useQuery({
    queryKey: keys.sheetList(`${query}#${page}`),
    queryFn: () => api<{ items: SheetSummary[]; total?: number }>(`/v1/timesheets?${query ? `${query}&` : ''}${pageParams(page)}`),
    enabled: can(TS_READ),
    retry: retryTransient,
  });
  if (!can(TS_READ)) return <NotPermitted>The selected role cannot see timesheets.</NotPermitted>;
  const data = shown(list);
  // An employee's own weeks are filled in on My ESS; this list is where they are looked up, so it leads there.
  const fillOwn = me?.scopeKind === 'OWN' && can(TS_SUBMIT);
  const own = me?.scopeKind === 'OWN';
  return (
    // An own-scope list gets a heading of its own ("Timesheets" is the page's title, which a card of that name would hide), and
    // filling in is the card's main action, so its link is drawn as the filled main button.
    <Section
      title={own ? 'My timesheets' : 'Timesheets'}
      actions={
        fillOwn ? (
          <Button asChild size="sm">
            <Link to="/me?tab=TN13">Fill in my timesheet</Link>
          </Button>
        ) : undefined
      }
    >
      <FilterBar>
        <FormField>
          Status
          <NativeSelect value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All</option>
            {SHEET_STATES.map((st) => (
              <option key={st} value={st}>
                {readable(st)}
              </option>
            ))}
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
      <ReadProblem error={list.error} what="timesheets" />
      {list.isPending && <LoadingLine>Loading timesheets…</LoadingLine>}
      {data && data.items.length === 0 && (
        <Empty>{own && !state && !from && !to ? 'You haven’t filled in a timesheet yet.' : 'No timesheets match these filters.'}</Empty>
      )}
      {data && data.items.length > 0 && <SheetTable items={data.items} link />}
      {data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={data.total ?? data.items.length} onPage={(p) => setPaging({ query, page: p })} label="Timesheet pages" noun="timesheet" />}
    </Section>
  );
}

export function SheetTable({ items, link, onOpen }: { items: SheetSummary[]; link?: boolean; onOpen?: (id: string) => void }) {
  return (
    <Table aria-label="Timesheet weeks">
      <TableHeader>
        <TableRow>
          {link && <TableHead scope="col">Employee</TableHead>}
          <TableHead scope="col">Week</TableHead>
          <TableHead scope="col">Due</TableHead>
          <TableHead scope="col">Status</TableHead>
          <TableHead scope="col">Revision</TableHead>
          <TableHead scope="col">Submission</TableHead>
          <TableHead scope="col">Time (current revision)</TableHead>
          <TableHead scope="col">Approved time</TableHead>
          <TableHead scope="col">Open</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((s) => (
          <TableRow key={s.id}>
            {link && (
              <TableCell>
                {s.employeeName} ({s.employeeCode})
              </TableCell>
            )}
            <TableCell>{weekText(s)}</TableCell>
            <TableCell>{formatDate(s.dueDate)}</TableCell>
            <TableCell>
              <StateBadge state={s.state} />
            </TableCell>
            <TableCell>
              {s.currentRevision}
              {s.approvedRevision !== null && s.approvedRevision !== s.currentRevision && <Remark>approved: {s.approvedRevision}</Remark>}
            </TableCell>
            <TableCell>{s.firstSubmittedAt ? lateText(s.late) : 'Not yet submitted'}</TableCell>
            <TableCell>{hm(s.totalMinutes)}</TableCell>
            <TableCell>{s.approvedRevision !== null ? hm(s.approvedMinutes) : '—'}</TableCell>
            <RowActionsCell>
              {link ? (
                <Link to={PATHS.timesheet(s.id)}>Open week {formatDate(s.periodStart)}</Link>
              ) : (
                <RowActions>
                  <Button type="button" variant="outline" size="sm" onClick={() => onOpen?.(s.id)}>
                    Open week {formatDate(s.periodStart)}
                  </Button>
                </RowActions>
              )}
            </RowActionsCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
