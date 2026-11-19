// One timesheet: its revisions, the lines of the revision shown, decisions and reopen requests; the timesheet list.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, LIST_PAGE_SIZE, Notice, NotPermitted, pageParams, Pager, Section, StateBadge, When } from '../../ui';
import { ReadProblem, Refusal } from './refusals';
import { DECISION_LABEL, H3, hm, lateText, ORIGIN_LABEL, PATHS, Problem, SCROLL, SHEET_STATES, shown, SPACED, TEXTAREA, TS_READ, TS_REQUEST_REOPEN, TS_SUBMIT, useKeys, weekText } from './shared';
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
        {s.pendingWith && <div className="hint">with {s.pendingWith}</div>}
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
    <div style={SCROLL}>
      <table aria-label="Revisions">
        <thead>
          <tr>
            <th>Revision</th>
            <th>Origin</th>
            <th>Status</th>
            <th>Submitted</th>
            <th>Decided</th>
            <th>Lines and time</th>
            <th>Show</th>
          </tr>
        </thead>
        <tbody>
          {s.revisions.map((r) => (
            <tr key={r.revision}>
              <td>
                {r.revision}
                {r.revision === s.approvedRevision && <div className="hint">approved revision in force</div>}
              </td>
              <td>
                {ORIGIN_LABEL[r.origin] ?? readable(r.origin)}
                {r.previousRevision !== null && <div className="hint">follows revision {r.previousRevision}</div>}
              </td>
              <td>
                <StateBadge state={r.state} />
                {r.supersededByRevision !== null && <div className="hint">superseded by revision {r.supersededByRevision}</div>}
              </td>
              <td>{r.submittedOn ? `${formatDate(r.submittedOn)} · ${lateText(r.late)}` : '—'}</td>
              <td>
                <When at={r.decidedAt} />
                {r.decisionReason && <div className="hint">Reason: {r.decisionReason}</div>}
              </td>
              <td>
                {r.lineCount} lines · {hm(r.totalMinutes)}
              </td>
              <td>
                {r.revision === s.shownRevision ? (
                  'Shown'
                ) : (
                  <button type="button" className="secondary" onClick={() => onShow(r.revision)}>
                    Show revision {r.revision}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LinesTable({ s, actions }: { s: SheetDetail; actions?: (l: Line) => ReactNode }) {
  if (s.lines.length === 0) return <Empty>No lines in revision {s.shownRevision}.</Empty>;
  return (
    <>
      <div style={SCROLL}>
        <table aria-label={`Lines of revision ${s.shownRevision}`}>
          <thead>
            <tr>
              <th>Work date</th>
              <th>Project and job</th>
              <th>Activity</th>
              <th>Time</th>
              <th>Note</th>
              {actions && <th>Change</th>}
            </tr>
          </thead>
          <tbody>
            {s.lines.map((l) => (
              <tr key={l.id}>
                <td>{formatDate(l.workDate)}</td>
                <td>
                  {l.projectCode} / {l.jobCode}: {l.jobName}
                </td>
                <td>
                  {l.activityCode}: {l.activityName}
                  <div className="hint">{l.productive ? 'productive' : 'not productive'}</div>
                </td>
                <td>{hm(l.minutes)}</td>
                <td>{l.note ?? '—'}</td>
                {actions && <td>{actions(l)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        Daily totals: {s.dailyTotals.map((d) => `${formatDate(d.workDate)} ${d.hours} h`).join(' · ')} · Revision total {hm(s.totalMinutes)}
      </p>
    </>
  );
}

export function SheetHistory({ s }: { s: SheetDetail }) {
  return (
    <>
      <h3 style={H3}>Decisions</h3>
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
      <h3 style={H3}>Reopen requests</h3>
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
              <div className="hint">Reason: {r.reason}</div>
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
        <p className="hint">A reopen request is waiting for an independent HR reviewer.</p>
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
    <form aria-label="Request a reopen" onSubmit={submit} noValidate className="stack" style={SPACED}>
      <label>
        Reason for reopening the approved timesheet
        <textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
      </label>
      <Problem text={problem} />
      <Refusal error={send.error} act="reopen-request" />
      <Notice notice={notice} />
      <div>
        <button type="submit" disabled={send.isPending}>
          Request reopen
        </button>
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
        {detail.isPending && <p className="hint loading">Loading the timesheet…</p>}
        <ReadProblem error={detail.error} what="this timesheet" />
        {s && (
          <>
            <SheetFacts s={s} />
            <h3 style={H3}>Revisions</h3>
            <RevisionTable s={s} onShow={(r) => setParams(r === s.currentRevision ? {} : { revision: String(r) })} />
            <h3 style={H3}>Lines of revision {s.shownRevision}</h3>
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
    // filling in is the card's main action (styles.css: .card-header > a.primary).
    <Section
      title={own ? 'My timesheets' : 'Timesheets'}
      actions={
        fillOwn ? (
          <Link className="primary" to="/me?tab=TN13">
            Fill in my timesheet
          </Link>
        ) : undefined
      }
    >
      <div className="row">
        <label>
          Status
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All</option>
            {SHEET_STATES.map((st) => (
              <option key={st} value={st}>
                {readable(st)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Weeks from
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Weeks to
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <ReadProblem error={list.error} what="timesheets" />
      {list.isPending && <p className="hint loading">Loading timesheets…</p>}
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
    <div style={SCROLL}>
      <table aria-label="Timesheet weeks">
        <thead>
          <tr>
            {link && <th>Employee</th>}
            <th>Week</th>
            <th>Due</th>
            <th>Status</th>
            <th>Revision</th>
            <th>Submission</th>
            <th>Time (current revision)</th>
            <th>Approved time</th>
            <th>Open</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.id}>
              {link && (
                <td>
                  {s.employeeName} ({s.employeeCode})
                </td>
              )}
              <td>{weekText(s)}</td>
              <td>{formatDate(s.dueDate)}</td>
              <td>
                <StateBadge state={s.state} />
              </td>
              <td>
                {s.currentRevision}
                {s.approvedRevision !== null && s.approvedRevision !== s.currentRevision && <div className="hint">approved: {s.approvedRevision}</div>}
              </td>
              <td>{s.firstSubmittedAt ? lateText(s.late) : 'Not yet submitted'}</td>
              <td>{hm(s.totalMinutes)}</td>
              <td>{s.approvedRevision !== null ? hm(s.approvedMinutes) : '—'}</td>
              <td>
                {link ? (
                  <Link to={PATHS.timesheet(s.id)}>Open week {formatDate(s.periodStart)}</Link>
                ) : (
                  <button type="button" className="secondary" onClick={() => onOpen?.(s.id)}>
                    Open week {formatDate(s.periodStart)}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
