// The sync monitor screen: runs, and the events they rejected or quarantined, with the actions a person may take.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, LIST_PAGE_SIZE, pageParams, Pager, Section, StateBadge } from '../../ui';
import { Refusal } from './refusals';
import { formatInstant, instantOf, type Paged, ProfilePicker, REPROCESS, SYNC_RUN, type SyncException, type SyncRun } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Sync Monitor
// ---------------------------------------------------------------------------------------------------------

const FAILURES: Readonly<Record<string, string>> = {
  UNKNOWN_EMPLOYEE: 'No employee is linked to this identity',
  AMBIGUOUS_LOCAL_TIME: 'The local time is ambiguous or does not exist (daylight saving)',
  CONFLICTING_PAYLOAD: 'Same event key, different content',
  MISSING_EVENT_KEY: 'No event key',
  INVALID_TIMESTAMP: 'Invalid time',
  INVALID_DIRECTION: 'Invalid direction',
  FETCH_FAILED: 'The provider could not be reached after the retries',
  PROCESSING_FAILED: 'A page could not be saved',
  LEASE_EXPIRED: 'The run stopped responding and was ended',
};
const failureText = (code: string | null) => (code ? (FAILURES[code] ?? code) : '—');

function StartRun({ onChanged }: { onChanged: () => void }) {
  const [profileId, setProfileId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const start = useMutation({
    mutationFn: () => api<SyncRun>(`/v1/biometric/profiles/${profileId}/runs`, { body: { windowStart: instantOf(from), windowEnd: instantOf(to) } }),
    onSettled: onChanged,
  });
  return (
    <Section title="Fetch now">
      <form
        className="grid-form"
        aria-label="Fetch now"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          start.mutate();
        }}
      >
        <ProfilePicker value={profileId} onChange={setProfileId} anyLabel="Choose a profile…" />
        <label>
          Window from
          <input required type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Window to
          <input required type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="submit" disabled={start.isPending || !profileId}>
          Start run
        </button>
      </form>
      <p className="hint">Repeating a window is safe: a punch already accepted is counted as a duplicate, never added twice.</p>
      <Refusal error={start.error} />
      {start.data && <p role="status">{`Run ended ${start.data.state}: ${start.data.accepted} accepted, ${start.data.duplicates} duplicates, ${start.data.quarantined} quarantined, ${start.data.rejected} rejected.`}</p>}
    </Section>
  );
}

function RunList({ profileId }: { profileId: string }) {
  const [state, setState] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const params = { ...(profileId ? { profileId } : {}), ...(state ? { state } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const query = `${pageParams(page)}&${new URLSearchParams(params).toString()}`;
  const runs = useQuery({ queryKey: ['biometric', 'runs', query], queryFn: () => api<Paged<SyncRun>>(`/v1/biometric/runs?${query}`) });
  useEffect(() => setPage(1), [profileId]);
  return (
    <Section title="Runs">
      <div className="grid-form">
        <label>
          State
          <select
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Any</option>
            <option value="RUNNING">Running</option>
            <option value="COMPLETED">Completed</option>
            <option value="PARTIAL">Partial</option>
            <option value="FAILED">Failed</option>
          </select>
        </label>
        <label>
          Started from
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          Started to
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </label>
      </div>
      <ErrorNote error={runs.error} />
      {runs.data?.items.length === 0 && <Empty>No runs match.</Empty>}
      {runs.data && runs.data.items.length > 0 && (
        <>
          <table aria-label="Runs">
            <thead>
              <tr>
                <th scope="col">Profile</th>
                <th scope="col">Started</th>
                <th scope="col">Window</th>
                <th scope="col">State</th>
                <th scope="col">Mapping</th>
                <th scope="col">Pages</th>
                <th scope="col">Received</th>
                <th scope="col">Accepted</th>
                <th scope="col">Duplicates</th>
                <th scope="col">Quarantined</th>
                <th scope="col">Rejected</th>
                <th scope="col">Problem</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.items.map((r) => (
                <tr key={r.id}>
                  <td>{r.profileCode}</td>
                  <td>{formatInstant(r.startedAt)}</td>
                  <td>{`${formatInstant(r.windowStart)} to ${formatInstant(r.windowEnd)}`}</td>
                  <td>
                    <StateBadge state={r.state} />
                  </td>
                  <td>Revision {r.mappingRevision}</td>
                  <td>{r.pagesCommitted}</td>
                  <td>{r.observations}</td>
                  <td>{r.accepted}</td>
                  <td>{r.duplicates}</td>
                  <td>{r.quarantined}</td>
                  <td>{r.rejected}</td>
                  <td>{failureText(r.failureCode)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={runs.data.page} pageSize={LIST_PAGE_SIZE} total={runs.data.total} onPage={setPage} label="Run pages" noun="run" />
          <p className="hint">A partial or failed run keeps its checkpoint at the last saved page, and missing punches never count as an absence because of it.</p>
        </>
      )}
    </Section>
  );
}

const evidenceText = (e: NonNullable<SyncException['evidence']>) => `${e.employeeKey} · ${e.instant ? formatInstant(e.instant) : `${e.localTime ?? 'no time'} (device time)`} · ${e.direction}`;

function ExceptionActions({ row, onChanged }: { row: SyncException; onChanged: () => void }) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState('');
  const [reason, setReason] = useState('');
  const reprocess = useMutation({ mutationFn: () => api(`/v1/biometric/events/${row.eventId}/reprocess`, { method: 'POST' }), onSettled: onChanged });
  const correct = useMutation({ mutationFn: () => api(`/v1/biometric/events/${row.eventId}/correct`, { body: { normalisedTime: time.trim(), reason: reason.trim() } }), onSettled: onChanged });
  if (row.nextStep === 'RESOLVED') return <Badge tone="good">Since accepted</Badge>;
  if (row.failureCode === 'CONFLICTING_PAYLOAD') {
    return (
      <span className="hint">
        The kept event was not overwritten. To change the day, use <Link to="/attendance/control">attendance control</Link>.
      </span>
    );
  }
  if (!can(REPROCESS)) return null;
  if (row.nextStep === 'REPROCESS') {
    return (
      <>
        <button type="button" className="link" disabled={reprocess.isPending} onClick={() => reprocess.mutate()}>
          Reprocess {row.sourceEventKey}
        </button>
        <Refusal error={reprocess.error} />
      </>
    );
  }
  if (row.nextStep !== 'CORRECT_TIME') return null;
  return (
    <>
      <button type="button" className="link" onClick={() => setOpen(!open)}>
        Correct time of {row.sourceEventKey}
      </button>
      {open && (
        <form
          className="stack"
          aria-label={`Correct time of ${row.sourceEventKey}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            correct.mutate();
          }}
        >
          <label>
            Time with its UTC offset
            <input required maxLength={40} placeholder="YYYY-MM-DDThh:mm:ss±hh:mm" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <label>
            Reason
            <textarea required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <p className="hint">Confirm the reading on the device. The offset settles which of the two readings of a repeated hour this is. The record as received stays on file.</p>
          <button type="submit" disabled={correct.isPending || !reason.trim()}>
            Confirm correction
          </button>
          <Refusal error={correct.error} />
        </form>
      )}
    </>
  );
}

function ExceptionList({ profileId }: { profileId: string }) {
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState('');
  const [openOnly, setOpenOnly] = useState(true);
  const [page, setPage] = useState(1);
  const params = { ...(profileId ? { profileId } : {}), ...(outcome ? { outcome } : {}), ...(openOnly ? { open: 'true' } : {}) };
  const query = `${pageParams(page)}&${new URLSearchParams(params).toString()}`;
  const rows = useQuery({ queryKey: ['biometric', 'exceptions', query], queryFn: () => api<Paged<SyncException>>(`/v1/biometric/exceptions?${query}`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['biometric', 'exceptions'] });
    void qc.invalidateQueries({ queryKey: ['biometric', 'runs'] });
  };
  useEffect(() => setPage(1), [profileId]);
  return (
    <Section title="Rejected and quarantined records">
      <div className="grid-form">
        <label>
          Outcome
          <select
            value={outcome}
            onChange={(e) => {
              setOutcome(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Any</option>
            <option value="QUARANTINED">Quarantined</option>
            <option value="REJECTED">Rejected</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={openOnly}
            onChange={(e) => {
              setOpenOnly(e.target.checked);
              setPage(1);
            }}
          />{' '}
          Leave out those since accepted
        </label>
      </div>
      <ErrorNote error={rows.error} />
      {rows.data?.items.length === 0 && <Empty>Nothing to show.</Empty>}
      {rows.data && rows.data.items.length > 0 && (
        <>
          <table aria-label="Rejected and quarantined records">
            <thead>
              <tr>
                <th scope="col">Profile</th>
                <th scope="col">Received</th>
                <th scope="col">Outcome</th>
                <th scope="col">Why</th>
                <th scope="col">Event key</th>
                <th scope="col">Device said</th>
                <th scope="col">Kept on record</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.data.items.map((r) => (
                <tr key={r.id}>
                  <td>{r.profileCode}</td>
                  <td>{formatInstant(r.observedAt)}</td>
                  <td>
                    <StateBadge state={r.outcome} />
                  </td>
                  <td>{failureText(r.failureCode)}</td>
                  <td>{r.sourceEventKey ?? '—'}</td>
                  <td>{r.evidence ? evidenceText(r.evidence) : '—'}</td>
                  <td>{r.kept ? `${r.kept.employeeKey} · ${formatInstant(r.kept.instant)} · ${r.kept.direction}` : '—'}</td>
                  <td>
                    <ExceptionActions row={r} onChanged={refresh} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={rows.data.page} pageSize={LIST_PAGE_SIZE} total={rows.data.total} onPage={setPage} label="Record pages" noun="record" />
        </>
      )}
    </Section>
  );
}

export function BiometricSyncMonitorPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [profileId, setProfileId] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['biometric', 'runs'] });
    void qc.invalidateQueries({ queryKey: ['biometric', 'exceptions'] });
  };
  return (
    <>
      <Section title="Biometric sync monitor">
        <ProfilePicker value={profileId} onChange={setProfileId} anyLabel="All profiles" />
      </Section>
      <RunList profileId={profileId} />
      <ExceptionList profileId={profileId} />
      {can(SYNC_RUN) && <StartRun onChanged={refresh} />}
    </>
  );
}
