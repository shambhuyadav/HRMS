// Inbox (FR-061/085) and reports (FR-056/065).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, download } from '../../api';
import { isReportRefusal, reportProblem } from '../../report-failures';
import { Empty, ErrorNote, LIST_PAGE_SIZE, Pager, pageParams, Section, StateBadge } from '../../ui';
import { NotificationPreferencesPanel } from '../notifications';

// ---------------------------------------------------------------------------------------------------------
// Inbox (FR-061/085) and reports (FR-056/065).
// ---------------------------------------------------------------------------------------------------------

export function InboxPage() {
  const qc = useQueryClient();
  const inbox = useQuery({
    queryKey: ['inbox'],
    queryFn: () => api<{ items: { id: string; category: string; title: string | null; body: string; occurredAt: string; readAt: string | null }[] }>('/v1/me/notifications', { withoutAssignment: true }),
  });
  const read = useMutation({
    mutationFn: (id: string) => api(`/v1/me/notifications/${id}/read`, { method: 'POST', withoutAssignment: true }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['inbox'] }),
  });
  return (
    <>
      {/* A visible heading of its own: the page is titled "Notifications", which a card of the same name would hide. */}
      <Section title="Inbox">
        {inbox.data?.items.length === 0 && <Empty>No notifications yet.</Empty>}
        <ul className="tasks">
          {inbox.data?.items.map((n) => (
            <li key={n.id} className={n.readAt ? 'read' : 'unread'}>
              <div>
                <strong>{n.title ?? n.category}</strong> {!n.readAt && <span className="badge badge-warn">new</span>}
              </div>
              <div>{n.body}</div>
              <div className="hint">{new Date(n.occurredAt).toLocaleString()}</div>
              {!n.readAt && (
                <button className="link" onClick={() => read.mutate(n.id)}>
                  Mark as read
                </button>
              )}
            </li>
          ))}
        </ul>
        <ErrorNote error={inbox.error} />
      </Section>
      <NotificationPreferencesPanel />
    </>
  );
}

export function ReportsPage() {
  // `formats` is present only for a report that offers more than CSV (FR-046 XLSX).
  const catalogue = useQuery({
    queryKey: ['catalogue'],
    queryFn: () => api<{ items: { code: string; title: string; requiresPeriod: boolean; formats?: string[] }[] }>('/v1/reports/catalogue'),
  });
  const [code, setCode] = useState('EMPLOYEE_REGISTER');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [format, setFormat] = useState('CSV');
  const [page, setPage] = useState(1);
  const qc = useQueryClient();
  // FR-056 "recoverable download links": the requester's own reports from the server, so a reload loses nothing.
  const reports = useQuery({
    queryKey: ['reports', page],
    queryFn: () => api<{ items: OwnReport[]; total: number }>(`/v1/reports?${pageParams(page)}`),
    refetchInterval: (q) => (!isReportRefusal(q.state.error) && q.state.data?.items.some((r) => r.state === 'QUEUED' || r.state === 'RUNNING') ? 3000 : false),
  });
  // The server lists only the reports this role may ask for; the choice shown is the one sent, so a report not in the list is never asked for.
  const offered = catalogue.data?.items ?? [];
  const chosen = offered.some((r) => r.code === code) ? code : (offered[0]?.code ?? '');
  const def = offered.find((r) => r.code === chosen);
  // A format is sent only to a report that declares it; every other report is CSV.
  const chosenFormat = def?.formats?.includes(format) ? format : 'CSV';
  const request = useMutation({
    mutationFn: () =>
      api<{ id: string }>('/v1/reports', {
        // The dates chosen for an earlier report stay in the form, but only a report with a period takes them.
        body: { reportCode: chosen, filters: { ...(def?.requiresPeriod && from ? { from } : {}), ...(def?.requiresPeriod && to ? { to } : {}) }, ...(def?.formats ? { format: chosenFormat } : {}) },
      }),
    onSuccess: () => {
      setPage(1);
      void qc.invalidateQueries({ queryKey: ['reports'] });
    },
  });
  return (
    <>
      <Section title="Request a report">
        {catalogue.data && offered.length === 0 && (
          <>
            <Empty>No report can be requested in this role.</Empty>
            {/* Several reports are explicit grants, never default duties (the delivery log, audit export): say how to get one. */}
            <p className="hint">Reports come with the duties of the selected role. If you need one that is not listed, ask an administrator to grant it; another administrator approves the grant.</p>
          </>
        )}
        {offered.length > 0 && (
        <form
          className="grid-form"
          onSubmit={(e) => {
            e.preventDefault();
            request.mutate();
          }}
        >
          <label>
            Report
            <select
              value={chosen}
              onChange={(e) => {
                setCode(e.target.value);
                setFormat('CSV');
              }}
            >
              {catalogue.data?.items.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.title}
                </option>
              ))}
            </select>
          </label>
          {def?.formats && (
            <label>
              Format
              <select value={chosenFormat} onChange={(e) => setFormat(e.target.value)}>
                {def.formats.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
          )}
          {def?.requiresPeriod && (
            <>
              <label>
                From
                <input type="date" required value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label>
                To
                <input type="date" required value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
            </>
          )}
          <button type="submit">Request</button>
        </form>
        )}
        <p className="hint">Reports are generated in the background; downloads expire after 24 hours and re-check your access.</p>
        <ErrorNote error={request.error ?? catalogue.error} />
      </Section>
      <Section title={`My reports${reports.data ? ` (${reports.data.total})` : ''}`}>
        {reports.data?.total === 0 && <Empty>You have not requested any reports under this role.</Empty>}
        <ul className="tasks">
          {reports.data?.items.map((r) => (
            <ReportRow key={r.id} report={r} />
          ))}
        </ul>
        <Pager page={page} pageSize={LIST_PAGE_SIZE} total={reports.data?.total ?? 0} onPage={setPage} label="Report pages" noun="report" />
        <ErrorNote error={reports.error} />
      </Section>
    </>
  );
}

/** GET /v1/reports: one of the requester's own report executions. */
interface OwnReport {
  id: string;
  title: string;
  state: string;
  rowCount: number | null;
  failureCode: string | null;
  requestedAt: string;
  expiresAt: string | null;
  format: string;
}

function ReportRow({ report: r }: { report: OwnReport }) {
  const [error, setError] = useState<unknown>(null);
  const problem = reportProblem(r);
  return (
    <li>
      <strong>{r.title}</strong> <StateBadge state={r.state} /> {r.rowCount !== null && <span className="hint">{r.rowCount} rows</span>}
      <div className="hint">
        Requested {new Date(r.requestedAt).toLocaleString()}
        {r.state === 'COMPLETED' && r.expiresAt && `; the download expires ${new Date(r.expiresAt).toLocaleString()}`}
        {r.state === 'EXPIRED' && '; the download has expired, so request the report again'}
      </div>
      {problem && <div className="hint">{problem}</div>}
      {r.state === 'COMPLETED' && (
        <button className="link" onClick={() => download(`/v1/reports/${r.id}/download`).catch(setError)}>
          Download {r.format}
        </button>
      )}
      <ErrorNote error={error} />
    </li>
  );
}
