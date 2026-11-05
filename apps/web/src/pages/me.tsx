import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, formatDate } from '../api';
import { useSession } from '../session';
import { Empty, ErrorNote, Section, StateBadge } from '../ui';
import { canRaiseAgain, followedRequests, RaiseAgainNote, RaisedAgainHint } from './requests';

// ---------------------------------------------------------------------------------------------------------
// Employee portal (FR-059): own record, reviewed change requests, attendance corrections and app links.
// Nothing here changes a record directly; every change waits for an authorised reviewer.
// ---------------------------------------------------------------------------------------------------------

interface OwnRecord {
  employeeCode: string;
  displayName: string;
  workEmail: string | null;
  joiningDate: string;
  status: string;
  assignment?: { departmentName?: string; locationName?: string; designationName?: string } | null;
}
interface ProfileChange {
  id: string;
  requested: { displayName?: string; workEmail?: string };
  state: string;
  submittedAt: string;
  predecessorRequestId?: string | null;
}
interface Link {
  id: string;
  appAccountRef: string;
  state: string;
  requestedAt: string;
}

const LABEL: Record<string, string> = { displayName: 'Display name', workEmail: 'Work email' };

export function MyProfilePage() {
  const { me, can } = useSession();
  const qc = useQueryClient();
  const employeeId = me?.employeeId;
  const record = useQuery({ queryKey: ['me-record', employeeId], enabled: !!employeeId, queryFn: () => api<OwnRecord>(`/v1/employees/${employeeId}`) });
  const changes = useQuery({
    queryKey: ['me-profile-changes', employeeId],
    enabled: !!employeeId && can('profile_change.read.operational'),
    queryFn: () => api<{ items: ProfileChange[] }>(`/v1/employees/${employeeId}/profile-changes`),
  });
  const links = useQuery({
    queryKey: ['me-links', employeeId],
    enabled: !!employeeId && can('mobile_link.read.operational'),
    queryFn: () => api<{ items: Link[] }>(`/v1/employees/${employeeId}/mobile-links`),
  });
  const [form, setForm] = useState({ displayName: '', workEmail: '' });
  const [raisingAgain, setRaisingAgain] = useState<string | null>(null);
  const [appRef, setAppRef] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['me-profile-changes'] });
    void qc.invalidateQueries({ queryKey: ['me-links'] });
  };
  const request = useMutation({
    mutationFn: () =>
      api('/v1/me/profile-changes', {
        body: {
          ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
          ...(form.workEmail.trim() ? { workEmail: form.workEmail.trim() } : {}),
          ...(raisingAgain ? { predecessorRequestId: raisingAgain } : {}),
        },
      }),
    onSuccess: () => {
      setForm({ displayName: '', workEmail: '' });
      setRaisingAgain(null);
      refresh();
    },
  });
  const withdraw = useMutation({ mutationFn: (id: string) => api(`/v1/profile-changes/${id}/withdraw`, { method: 'POST' }), onSuccess: refresh });
  const link = useMutation({
    mutationFn: () => api('/v1/mobile-links', { body: { appAccountRef: appRef.trim() } }),
    onSuccess: () => {
      setAppRef('');
      refresh();
    },
  });

  if (!employeeId) return <Empty>No employee record is linked to this account.</Empty>;
  const r = record.data;
  return (
    <>
      <Section title="My record">
        {r && (
          <dl className="kv">
            <div>
              <dt>Employee code</dt>
              <dd>{r.employeeCode}</dd>
            </div>
            <div>
              <dt>Name</dt>
              <dd>{r.displayName}</dd>
            </div>
            <div>
              <dt>Work email</dt>
              <dd>{r.workEmail ?? '—'}</dd>
            </div>
            <div>
              <dt>Joined</dt>
              <dd>{formatDate(r.joiningDate)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <StateBadge state={r.status} />
              </dd>
            </div>
            <div>
              <dt>Department</dt>
              <dd>{r.assignment?.departmentName ?? '—'}</dd>
            </div>
          </dl>
        )}
        <ErrorNote error={record.error} />
      </Section>

      {can('profile_change.submit.operational') && (
        <Section title="Ask for a change">
          {raisingAgain && <RaiseAgainNote onCancel={() => setRaisingAgain(null)} />}
          <form
            className="grid-form"
            onSubmit={(e) => {
              e.preventDefault();
              request.mutate();
            }}
          >
            <label>
              New display name
              <input maxLength={200} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
            </label>
            <label>
              New work email
              <input type="email" maxLength={254} value={form.workEmail} onChange={(e) => setForm({ ...form, workEmail: e.target.value })} />
            </label>
            <button type="submit" disabled={request.isPending || (!form.displayName.trim() && !form.workEmail.trim())}>
              Send for review
            </button>
          </form>
          <p className="hint">HR reviews every change before it is applied. Other details are maintained by HR.</p>
          {request.isSuccess && <p className="ok">Sent for review.</p>}
          <ErrorNote error={request.error} />
        </Section>
      )}

      {changes.data && (
        <Section title="My change requests">
          {changes.data.items.length === 0 && <Empty>No change requests yet.</Empty>}
          <ul className="tasks">
            {changes.data.items.map((c) => (
              <li key={c.id}>
                <div>
                  {Object.entries(c.requested)
                    .map(([k, v]) => `${LABEL[k] ?? k}: ${v}`)
                    .join(' · ')}{' '}
                  <StateBadge state={c.state} /> <span className="hint">{formatDate(c.submittedAt)}</span>
                  <RaisedAgainHint predecessorRequestId={c.predecessorRequestId} />
                </div>
                {c.state === 'SUBMITTED' && (
                  <div className="row">
                    <button type="button" className="link" onClick={() => withdraw.mutate(c.id)}>
                      Withdraw
                    </button>
                  </div>
                )}
                {canRaiseAgain(c, followedRequests(changes.data?.items ?? [])) && can('profile_change.submit.operational') && (
                  <div className="row">
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        request.reset();
                        setForm({ displayName: c.requested.displayName ?? '', workEmail: c.requested.workEmail ?? '' });
                        setRaisingAgain(c.id);
                      }}
                    >
                      Raise again
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <ErrorNote error={withdraw.error ?? changes.error} />
        </Section>
      )}

      {links.data && (
        <Section title="Mobile app">
          {links.data.items.length === 0 && <Empty>No app account linked.</Empty>}
          <ul className="tasks">
            {links.data.items.map((l) => (
              <li key={l.id}>
                <div>
                  <code>{l.appAccountRef}</code> <StateBadge state={l.state} /> <span className="hint">{formatDate(l.requestedAt)}</span>
                </div>
              </li>
            ))}
          </ul>
          {can('mobile_link.request.operational') && (
            <form
              className="inline"
              onSubmit={(e) => {
                e.preventDefault();
                link.mutate();
              }}
            >
              <label className="inline">
                App account reference <input required pattern="[A-Za-z0-9._:@\-]{3,200}" value={appRef} onChange={(e) => setAppRef(e.target.value)} />
              </label>
              <button type="submit" disabled={link.isPending}>
                Request link
              </button>
            </form>
          )}
          <p className="hint">A link is active only after HR approves it.</p>
          <ErrorNote error={link.error ?? links.error} />
        </Section>
      )}
    </>
  );
}

interface Day {
  id: string;
  workDate: string;
  status: string;
  workedMinutes: number | null;
  late: boolean;
  amended: boolean;
}
interface Correction {
  id: string;
  attendanceRecordId: string;
  workDate: string;
  currentStatus: string;
  requestedStatus: string;
  state: string;
  predecessorRequestId?: string | null;
}

const CORRECTABLE = ['PRESENT', 'HALF_DAY', 'ABSENT'];
const shiftDate = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

function CorrectionForm({ day, predecessorRequestId, initialStatus, onDone }: { day: Pick<Day, 'id' | 'status'>; predecessorRequestId?: string; initialStatus?: string; onDone: () => void }) {
  const options = CORRECTABLE.filter((s) => s !== day.status);
  const [status, setStatus] = useState(initialStatus && options.includes(initialStatus) ? initialStatus : (options[0] ?? 'PRESENT'));
  const [reason, setReason] = useState('');
  const send = useMutation({
    mutationFn: () => api('/v1/me/attendance-corrections', { body: { attendanceRecordId: day.id, status, reason: reason.trim(), ...(predecessorRequestId ? { predecessorRequestId } : {}) } }),
    onSuccess: onDone,
  });
  return (
    <form
      className="inline"
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate();
      }}
    >
      <select aria-label="Correct to" value={status} onChange={(e) => setStatus(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o.replace(/_/g, ' ').toLowerCase()}
          </option>
        ))}
      </select>
      <input aria-label="Reason (private)" placeholder="Reason (private)" required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      <button type="submit" disabled={send.isPending || !reason.trim()}>
        Send
      </button>
      <ErrorNote error={send.error} />
    </form>
  );
}

export function MyAttendancePage() {
  const { me, can } = useSession();
  const qc = useQueryClient();
  const employeeId = me?.employeeId;
  const [range, setRange] = useState({ from: shiftDate(-14), to: shiftDate(0) });
  const [open, setOpen] = useState<string | null>(null);
  const [raisingAgain, setRaisingAgain] = useState<string | null>(null);
  const days = useQuery({
    queryKey: ['me-attendance', employeeId, range],
    enabled: !!employeeId,
    queryFn: () => api<{ items: Day[] }>(`/v1/employees/${employeeId}/attendance?from=${range.from}&to=${range.to}`),
  });
  const corrections = useQuery({
    queryKey: ['me-corrections', employeeId],
    enabled: !!employeeId,
    queryFn: () => api<{ items: Correction[] }>(`/v1/employees/${employeeId}/attendance-corrections`),
  });
  const withdraw = useMutation({
    mutationFn: (id: string) => api(`/v1/attendance-corrections/${id}/withdraw`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['me-corrections'] }),
  });
  const pendingFor = new Set((corrections.data?.items ?? []).filter((c) => c.state === 'SUBMITTED').map((c) => c.workDate));

  if (!employeeId) return <Empty>No employee record is linked to this account.</Empty>;
  return (
    <>
      <Section title="My attendance">
        <div className="row">
          <label className="inline">
            From <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          </label>
          <label className="inline">
            To <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </label>
        </div>
        {days.data?.items.length === 0 && <Empty>No processed attendance in this period.</Empty>}
        {!!days.data?.items.length && (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Status</th>
                <th>Worked</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {days.data.items.map((d) => (
                <tr key={d.id}>
                  <td>{formatDate(d.workDate)}</td>
                  <td>
                    <StateBadge state={d.status} /> {d.late && <span className="hint">late</span>} {d.amended && <span className="hint">amended</span>}
                  </td>
                  <td>{d.workedMinutes === null ? '—' : `${Math.floor(d.workedMinutes / 60)}h ${String(d.workedMinutes % 60).padStart(2, '0')}m`}</td>
                  <td>
                    {can('attendance.request_correction.operational') &&
                      CORRECTABLE.includes(d.status) &&
                      (pendingFor.has(d.workDate.slice(0, 10)) ? (
                        <span className="hint">correction waiting for review</span>
                      ) : open === d.id ? (
                        <CorrectionForm
                          day={d}
                          onDone={() => {
                            setOpen(null);
                            void qc.invalidateQueries({ queryKey: ['me-corrections'] });
                          }}
                        />
                      ) : (
                        <button type="button" className="link" onClick={() => setOpen(d.id)}>
                          Request correction
                        </button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">Leave, holidays and outdoor duty are requested separately; a correction can set present, half day or absent.</p>
        <ErrorNote error={days.error} />
      </Section>

      <Section title="My correction requests">
        {corrections.data?.items.length === 0 && <Empty>No correction requests yet.</Empty>}
        <ul className="tasks">
          {corrections.data?.items.map((c) => (
            <li key={c.id}>
              <div>
                {formatDate(c.workDate)}: {c.currentStatus.replace(/_/g, ' ').toLowerCase()} → {c.requestedStatus.replace(/_/g, ' ').toLowerCase()} <StateBadge state={c.state} />
              </div>
              <RaisedAgainHint predecessorRequestId={c.predecessorRequestId} />
              {c.state === 'SUBMITTED' && (
                <div className="row">
                  <button type="button" className="link" onClick={() => withdraw.mutate(c.id)}>
                    Withdraw
                  </button>
                </div>
              )}
              {canRaiseAgain(c, followedRequests(corrections.data?.items ?? [])) &&
                can('attendance.request_correction.operational') &&
                (raisingAgain === c.id ? (
                  <>
                    <RaiseAgainNote onCancel={() => setRaisingAgain(null)} />
                    <CorrectionForm
                      day={{ id: c.attendanceRecordId, status: c.currentStatus }}
                      predecessorRequestId={c.id}
                      initialStatus={c.requestedStatus}
                      onDone={() => {
                        setRaisingAgain(null);
                        void qc.invalidateQueries({ queryKey: ['me-corrections'] });
                      }}
                    />
                  </>
                ) : (
                  <div className="row">
                    <button type="button" className="link" onClick={() => setRaisingAgain(c.id)}>
                      Raise again
                    </button>
                  </div>
                ))}
            </li>
          ))}
        </ul>
        <ErrorNote error={withdraw.error ?? corrections.error} />
      </Section>
    </>
  );
}
