// My ESS TN13 (Employee OWN context): own weeks, lines, submission, decisions, allocations and reminders.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { api, ApiError, formatDate, localDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Notice, NotPermitted, Section, StateBadge } from '../../ui';
import { OwnLaterAdjustments } from '../payroll-adjustments';
import { missedText } from './missed';
import { ReadProblem, Refusal } from './refusals';
import { dayLabel, DECISION_LABEL, FLUSH, H3, hm, mondayOf, Problem, QUARTERS, SCROLL, shown, SPACED, TS_READ, TS_SUBMIT, useKeys, weekDays, weekText } from './shared';
import { LinesTable, ReopenRequestForm, RevisionTable, SheetFacts, SheetHistory, SheetTable, useSheet } from './sheet';
import type { Line, MissedWeek, OwnAllocation, OwnRequest, SheetDetail, SheetSummary } from './types';

// ---------------------------------------------------------------------------------------------------------
// My ESS TN13 (Employee OWN context): own weeks, lines, submission, decisions, allocations and reminders
// ---------------------------------------------------------------------------------------------------------
export function MyTimesheetsPanel() {
  const { can } = useSession();
  const [openId, setOpenId] = useState<string | null>(null);
  if (!can(TS_READ) && !can(TS_SUBMIT)) return <NotPermitted>The selected role cannot use timesheets.</NotPermitted>;
  return (
    <div className="stack">
      <MyWeeks openId={openId} onOpen={setOpenId} />
      {openId && <MyWeek key={openId} id={openId} onClose={() => setOpenId(null)} />}
      {can(TS_SUBMIT) && <MyAllocations />}
      {can(TS_READ) && <MyReminders />}
      {can(TS_READ) && <MyDecisionHistory />}
      {can(TS_READ) && <OwnLaterAdjustments />}
    </div>
  );
}

function MyWeeks({ openId, onOpen }: { openId: string | null; onOpen: (id: string) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const thisMonday = mondayOf(localDate());
  const [periodStart, setPeriodStart] = useState(thisMonday);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const list = useQuery({ queryKey: keys.ownSheets, queryFn: () => api<{ items: SheetSummary[] }>('/v1/me/timesheets'), enabled: can(TS_READ), retry: retryTransient });
  const create = useMutation({
    mutationFn: (body: { periodStart: string }) => api<SheetDetail>('/v1/me/timesheets', { body }),
    onSuccess: (s) => {
      setPeriodStart(thisMonday);
      setNotice({ text: `Started your timesheet for ${weekText(s)}. Add your lines below.`, ok: true });
      void qc.invalidateQueries({ queryKey: keys.own });
      onOpen(s.id);
    },
    onError: (error) => {
      const d = error instanceof ApiError ? (error.details as { timesheetId?: string } | undefined) : undefined;
      if (error instanceof ApiError && error.code === 'TIMESHEET_EXISTS' && d?.timesheetId) onOpen(d.timesheetId);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending || !periodStart) return;
    setNotice(null);
    create.mutate({ periodStart });
  };
  const data = shown(list);
  return (
    <Section title="My timesheets">
      <p className="hint">One timesheet per Monday to Sunday week, due by the following Monday. A later submission is still accepted and flagged late.</p>
      {can(TS_SUBMIT) && (
        <form className="row" aria-label="Start a timesheet" onSubmit={submit} noValidate>
          <label>
            Week starting (Monday)
            <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          </label>
          <button type="submit" disabled={create.isPending || !periodStart}>
            Start timesheet
          </button>
        </form>
      )}
      <Refusal error={create.error} act="week" />
      <Notice notice={notice} />
      <ReadProblem error={list.error} what="your timesheets" />
      {list.isPending && can(TS_READ) && <p className="hint loading">Loading your timesheets…</p>}
      {data && data.items.length === 0 && <Empty>You have no timesheets yet.</Empty>}
      {data && data.items.length > 0 && <SheetTable items={data.items} onOpen={onOpen} />}
      {openId && data && !data.items.some((s) => s.id === openId) && <p className="hint">The week opened below is not in the list above yet.</p>}
    </Section>
  );
}

function MyWeek({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [revision, setRevision] = useState<number | null>(null);
  const [editing, setEditing] = useState<Line | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const detail = useSheet(id, revision);
  const s = shown(detail);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.sheets });
    void qc.invalidateQueries({ queryKey: keys.own });
  };
  const remove = useMutation({
    mutationFn: (lineId: string) => api<SheetDetail>(`/v1/me/timesheets/${encodeURIComponent(id)}/lines/${encodeURIComponent(lineId)}/remove`, { method: 'POST' }),
    onSuccess: () => {
      setNotice({ text: 'Removed the line; it stays on record.', ok: true });
      refresh();
    },
  });
  const submitSheet = useMutation({
    mutationFn: (body: { expectedVersion: number }) => api<{ revision: number; state: string; late: boolean }>(`/v1/me/timesheets/${encodeURIComponent(id)}/submit`, { body }),
    onSuccess: (r) => {
      setNotice({
        text: r.late
          ? `Submitted revision ${r.revision} for your manager’s decision. It was submitted after its due date, so it is flagged late; a late timesheet is still accepted.`
          : `Submitted revision ${r.revision} for your manager’s decision.`,
        ok: true,
      });
      refresh();
    },
    onError: (error) => {
      if (error instanceof ApiError && (error.code === 'STALE_VERSION' || error.code === 'INVALID_STATE')) refresh();
    },
  });
  const revise = useMutation({
    mutationFn: () => api<SheetDetail>(`/v1/me/timesheets/${encodeURIComponent(id)}/revise`, { method: 'POST' }),
    onSuccess: (d) => {
      setRevision(null);
      setNotice({ text: `Opened revision ${d.currentRevision} as a draft with the previous lines carried over.`, ok: true });
      refresh();
    },
  });
  const current = s !== undefined && s.shownRevision === s.currentRevision;
  const editable = current && s.state === 'DRAFT' && can(TS_SUBMIT);
  const busy = remove.isPending || submitSheet.isPending || revise.isPending;
  return (
    <Section
      title={s ? `My week ${weekText(s)}` : 'My week'}
      actions={
        <button type="button" className="secondary" onClick={onClose}>
          Close the week
        </button>
      }
    >
      {detail.isPending && <p className="hint loading">Loading the week…</p>}
      <ReadProblem error={detail.error} what="this timesheet" />
      <Notice notice={notice} />
      {s && (
        <>
          <SheetFacts s={s} />
          <h3 style={H3}>Lines of revision {s.shownRevision}</h3>
          {!current && <p className="hint">An earlier revision is shown; it cannot be changed.</p>}
          <LinesTable
            s={s}
            actions={
              editable
                ? (l) => (
                    <div className="row">
                      <button type="button" className="secondary" disabled={busy} onClick={() => setEditing(l)}>
                        Change line {formatDate(l.workDate)} {l.jobCode}/{l.activityCode}
                      </button>
                      <button type="button" className="danger" disabled={busy} onClick={() => remove.mutate(l.id)}>
                        Remove line {formatDate(l.workDate)} {l.jobCode}/{l.activityCode}
                      </button>
                    </div>
                  )
                : undefined
            }
          />
          <Refusal error={remove.error} act="line" />
          {editable && editing && <EditLine key={editing.id} sheetId={id} line={editing} onDone={() => setEditing(null)} />}
          {editable && <AddLine s={s} />}
          {editable && (
            <div className="stack" style={SPACED}>
              <div>
                <button type="button" disabled={busy || s.lines.length === 0} onClick={() => submitSheet.mutate({ expectedVersion: s.version })}>
                  Submit revision {s.currentRevision}
                </button>
              </div>
              {s.lines.length === 0 && <p className="hint">Add at least one line to submit.</p>}
              <Refusal error={submitSheet.error} act="submit" />
            </div>
          )}
          {current && (s.state === 'RETURNED' || s.state === 'REJECTED') && can(TS_SUBMIT) && (
            <div className="stack" style={SPACED}>
              <p style={FLUSH}>
                {s.state === 'RETURNED' ? 'Your manager returned this timesheet for changes.' : 'Your manager rejected this revision.'} Continue in a new revision; this one stays on record.
              </p>
              <div>
                <button type="button" disabled={busy} onClick={() => revise.mutate()}>
                  Start a new revision
                </button>
              </div>
              <Refusal error={revise.error} act="revise" />
            </div>
          )}
          <h3 style={H3}>Revisions</h3>
          <RevisionTable s={s} onShow={(r) => setRevision(r === s.currentRevision ? null : r)} />
          <SheetHistory s={s} />
          {current && <ReopenRequestForm s={s} />}
        </>
      )}
    </Section>
  );
}

/** Job and activity from the own active allocations covering the work date; time in quarter hours. */
function AddLine({ s }: { s: SheetDetail }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const id = useId();
  const days = weekDays(s.periodStart);
  const allocations = useQuery({ queryKey: keys.ownAllocations, queryFn: () => api<{ items: OwnAllocation[] }>('/v1/me/timesheet-allocations'), retry: retryTransient });
  const empty = { workDate: days[0] ?? '', jobId: '', activityId: '', minutes: '', note: '' };
  const [f, setF] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const covering = (shown(allocations)?.items ?? []).filter((a) => a.startDate <= f.workDate && a.endDate >= f.workDate);
  const jobs = covering.filter((a, i) => covering.findIndex((b) => b.jobId === a.jobId) === i);
  const chosen = covering.find((a) => a.jobId === f.jobId);
  const add = useMutation({
    mutationFn: (body: { workDate: string; jobId: string; activityId: string; minutes: number; note?: string }) => api<SheetDetail & { lineId: string }>(`/v1/me/timesheets/${encodeURIComponent(s.id)}/lines`, { body }),
    onSuccess: () => {
      setF(empty);
      setNotice({ text: 'Added the line.', ok: true });
      void qc.invalidateQueries({ queryKey: keys.sheets });
      void qc.invalidateQueries({ queryKey: keys.own });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (add.isPending) return;
    setNotice(null);
    if (!f.workDate || !f.jobId || !f.activityId || !f.minutes) {
      setProblem('Choose the work date, the job, the activity and the time.');
      add.reset();
      return;
    }
    setProblem(null);
    const note = f.note.trim();
    add.mutate({ workDate: f.workDate, jobId: f.jobId, activityId: f.activityId, minutes: Number(f.minutes), ...(note ? { note } : {}) });
  };
  return (
    <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate style={SPACED}>
      <h3 id={`${id}-title`} className="wide" style={H3}>
        Add a line
      </h3>
      <label>
        Work date
        <select value={f.workDate} onChange={(e) => setF({ ...f, workDate: e.target.value, jobId: '', activityId: '' })}>
          {days.map((d, i) => (
            <option key={d} value={d}>
              {dayLabel(d, i)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Job
        <select value={f.jobId} onChange={(e) => setF({ ...f, jobId: e.target.value, activityId: '' })}>
          <option value="">{jobs.length === 0 ? 'No allocation covers this day' : 'Choose…'}</option>
          {jobs.map((a) => (
            <option key={a.jobId} value={a.jobId}>
              {a.projectCode} / {a.jobCode}: {a.jobName}
            </option>
          ))}
        </select>
      </label>
      <label>
        Activity
        <select value={f.activityId} disabled={!chosen} onChange={(e) => setF({ ...f, activityId: e.target.value })}>
          <option value="">{chosen ? 'Choose…' : 'Choose a job first'}</option>
          {(chosen?.activities ?? []).map((a) => (
            <option key={a.activityId} value={a.activityId}>
              {a.code}: {a.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Time (quarter hours)
        <select value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })}>
          <option value="">Choose…</option>
          {QUARTERS.map((m) => (
            <option key={m} value={m}>
              {hm(m)}
            </option>
          ))}
        </select>
      </label>
      <label className="wide">
        Note (optional)
        <input value={f.note} maxLength={500} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </label>
      <div className="wide">
        <ReadProblem error={allocations.error} what="your allocations" />
        <Problem text={problem} />
        <Refusal error={add.error} act="line" />
        <Notice notice={notice} />
        <button type="submit" disabled={add.isPending}>
          Add line
        </button>
      </div>
    </form>
  );
}

function EditLine({ sheetId, line, onDone }: { sheetId: string; line: Line; onDone: () => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [minutes, setMinutes] = useState(String(line.minutes));
  const [note, setNote] = useState(line.note ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<SheetDetail>(`/v1/me/timesheets/${encodeURIComponent(sheetId)}/lines/${encodeURIComponent(line.id)}`, { method: 'PUT', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.sheets });
      void qc.invalidateQueries({ queryKey: keys.own });
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') void qc.invalidateQueries({ queryKey: keys.sheets });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    const body: Record<string, unknown> = { expectedVersion: line.version };
    if (Number(minutes) !== line.minutes) body.minutes = Number(minutes);
    if ((note.trim() || null) !== line.note) body.note = note.trim() || null;
    if (Object.keys(body).length < 2) {
      setProblem('Change the time or the note to save.');
      return;
    }
    setProblem(null);
    save.mutate(body);
  };
  return (
    <form className="grid-form" aria-label={`Change the line of ${formatDate(line.workDate)} ${line.jobCode}/${line.activityCode}`} onSubmit={submit} noValidate style={SPACED}>
      <label>
        New time (quarter hours)
        <select value={minutes} onChange={(e) => setMinutes(e.target.value)}>
          {QUARTERS.map((m) => (
            <option key={m} value={m}>
              {hm(m)}
            </option>
          ))}
        </select>
      </label>
      <label className="wide">
        New note
        <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="wide">
        <Problem text={problem} />
        <Refusal error={save.error} act="line" />
        <div className="row">
          <button type="submit" disabled={save.isPending}>
            Save line
          </button>
          <button type="button" className="secondary" onClick={onDone}>
            Close
          </button>
        </div>
      </div>
    </form>
  );
}

function MyAllocations() {
  const keys = useKeys();
  const list = useQuery({ queryKey: keys.ownAllocations, queryFn: () => api<{ items: OwnAllocation[] }>('/v1/me/timesheet-allocations'), retry: retryTransient });
  const data = shown(list);
  return (
    <Section title="My allocations">
      <ReadProblem error={list.error} what="your allocations" />
      {list.isPending && <p className="hint loading">Loading your allocations…</p>}
      {data && data.items.length === 0 && <Empty>You have no active allocations, so no time can be recorded yet.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="My allocations">
            <thead>
              <tr>
                <th>Project and job</th>
                <th>Interval</th>
                <th>Allocation</th>
                <th>Activities you can book</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.projectCode} / {a.jobCode}: {a.jobName}
                  </td>
                  <td>
                    {formatDate(a.startDate)} to {formatDate(a.endDate)}
                  </td>
                  <td>{a.allocationPercent}%</td>
                  <td>{a.activities.map((x) => `${x.code}: ${x.name}`).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function MyReminders() {
  const keys = useKeys();
  const list = useQuery({ queryKey: keys.ownReminders, queryFn: () => api<{ items: MissedWeek[] }>('/v1/me/timesheet-exceptions'), retry: retryTransient });
  const data = shown(list);
  return (
    <Section title="Missed-submission reminders">
      <p className="hint">A reminder only: a missed week is never a deduction or a penalty, and a late timesheet is still accepted.</p>
      <ReadProblem error={list.error} what="your reminders" />
      {list.isPending && <p className="hint loading">Loading your reminders…</p>}
      {data && data.items.length === 0 && <Empty>No reminders.</Empty>}
      {data && data.items.length > 0 && (
        <ul aria-label="My reminders">
          {data.items.map((x) => (
            <li key={x.id}>
              {x.state === 'OPEN'
                ? `Reminder: your timesheet for ${weekText(x)} was due on ${formatDate(x.dueDate)} and has not been submitted. Please submit it; it is still accepted.`
                : `${weekText(x)}: ${missedText(x)}.`}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** FR-109: own timesheet submissions with who they wait for and their decisions. */
function MyDecisionHistory() {
  const keys = useKeys();
  const history = useQuery({ queryKey: keys.ownHistory, queryFn: () => api<{ items: OwnRequest[] }>('/v1/me/requests?kind=timesheet'), retry: retryTransient });
  const data = shown(history);
  return (
    <Section title="Status and decision history">
      <ReadProblem error={history.error} what="your decision history" />
      {history.isPending && <p className="hint loading">Loading your history…</p>}
      {data && data.items.length === 0 && <Empty>No submissions yet.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="My timesheet decisions">
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
                <th>Decisions</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.transactionId}>
                  <td>{formatDate(r.createdAt)}</td>
                  <td>
                    <StateBadge state={r.state} />
                    {r.pendingWith && <div className="hint">with {r.pendingWith}</div>}
                  </td>
                  <td>{r.decisions.length === 0 ? '—' : r.decisions.map((d) => `${DECISION_LABEL[d.decision] ?? readable(d.decision)} on ${formatDate(d.decidedAt)}`).join('; ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
