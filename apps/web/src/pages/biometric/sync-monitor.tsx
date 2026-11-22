// The sync monitor screen: runs, and the events they rejected or quarantined, with the actions a person may take.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckField, FilterBar, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
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
      <FormGrid
        aria-label="Fetch now"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          start.mutate();
        }}
      >
        <ProfilePicker value={profileId} onChange={setProfileId} anyLabel="Choose a profile…" />
        <FormField>
          Window from
          <Input required type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </FormField>
        <FormField>
          Window to
          <Input required type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </FormField>
        <Button type="submit" disabled={start.isPending || !profileId}>
          Start run
        </Button>
      </FormGrid>
      <Hint>Repeating a window is safe: a punch already accepted is counted as a duplicate, never added twice.</Hint>
      <Refusal error={start.error} />
      {start.data && (
        <StatusNote tone="info" role="status">
          {`Run ended ${start.data.state}: ${start.data.accepted} accepted, ${start.data.duplicates} duplicates, ${start.data.quarantined} quarantined, ${start.data.rejected} rejected.`}
        </StatusNote>
      )}
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
      <FilterBar>
        <FormField>
          State
          <NativeSelect
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
          </NativeSelect>
        </FormField>
        <FormField>
          Started from
          <Input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </FormField>
        <FormField>
          Started to
          <Input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </FormField>
      </FilterBar>
      <ErrorNote error={runs.error} />
      {runs.data?.items.length === 0 && <Empty>No runs match.</Empty>}
      {runs.data && runs.data.items.length > 0 && (
        <>
          <Table aria-label="Runs">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Profile</TableHead>
                <TableHead scope="col">Started</TableHead>
                <TableHead scope="col">Window</TableHead>
                <TableHead scope="col">State</TableHead>
                <TableHead scope="col">Mapping</TableHead>
                <TableHead scope="col">Pages</TableHead>
                <TableHead scope="col">Received</TableHead>
                <TableHead scope="col">Accepted</TableHead>
                <TableHead scope="col">Duplicates</TableHead>
                <TableHead scope="col">Quarantined</TableHead>
                <TableHead scope="col">Rejected</TableHead>
                <TableHead scope="col">Problem</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.data.items.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.profileCode}</TableCell>
                  <TableCell>{formatInstant(r.startedAt)}</TableCell>
                  <TableCell>{`${formatInstant(r.windowStart)} to ${formatInstant(r.windowEnd)}`}</TableCell>
                  <TableCell>
                    <StateBadge state={r.state} />
                  </TableCell>
                  <TableCell>Revision {r.mappingRevision}</TableCell>
                  <TableCell>{r.pagesCommitted}</TableCell>
                  <TableCell>{r.observations}</TableCell>
                  <TableCell>{r.accepted}</TableCell>
                  <TableCell>{r.duplicates}</TableCell>
                  <TableCell>{r.quarantined}</TableCell>
                  <TableCell>{r.rejected}</TableCell>
                  <TableCell>{failureText(r.failureCode)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager page={runs.data.page} pageSize={LIST_PAGE_SIZE} total={runs.data.total} onPage={setPage} label="Run pages" noun="run" />
          <Hint>A partial or failed run keeps its checkpoint at the last saved page, and missing punches never count as an absence because of it.</Hint>
        </>
      )}
    </Section>
  );
}

const evidenceText = (e: NonNullable<SyncException['evidence']>) => `${e.employeeKey} · ${e.instant ? formatInstant(e.instant) : `${e.localTime ?? 'no time'} (device time)`} · ${e.direction}`;

/** A record's next step, as its row's last cell: what has happened to it, or the action a person may take. */
function ExceptionActions({ row, onChanged }: { row: SyncException; onChanged: () => void }) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState('');
  const [reason, setReason] = useState('');
  const reprocess = useMutation({ mutationFn: () => api(`/v1/biometric/events/${row.eventId}/reprocess`, { method: 'POST' }), onSettled: onChanged });
  const correct = useMutation({ mutationFn: () => api(`/v1/biometric/events/${row.eventId}/correct`, { body: { normalisedTime: time.trim(), reason: reason.trim() } }), onSettled: onChanged });
  if (row.nextStep === 'RESOLVED') {
    return (
      <RowActionsCell>
        <Badge tone="good">Since accepted</Badge>
      </RowActionsCell>
    );
  }
  if (row.failureCode === 'CONFLICTING_PAYLOAD') {
    // A sentence, not a button: the cell takes the width its words need.
    return (
      <TableCell>
        <Hint as="span">
          The kept event was not overwritten. To change the day, use <Link to="/attendance/control">attendance control</Link>.
        </Hint>
      </TableCell>
    );
  }
  if (!can(REPROCESS)) return <RowActionsCell />;
  if (row.nextStep === 'REPROCESS') {
    return (
      <RowActionsCell expanded={!!reprocess.error}>
        <RowActions>
          <Button type="button" variant="outline" size="sm" disabled={reprocess.isPending} onClick={() => reprocess.mutate()}>
            Reprocess {row.sourceEventKey}
          </Button>
        </RowActions>
        <Refusal error={reprocess.error} />
      </RowActionsCell>
    );
  }
  if (row.nextStep !== 'CORRECT_TIME') return <RowActionsCell />;
  return (
    <RowActionsCell expanded={open}>
      <RowActions>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(!open)}>
          Correct time of {row.sourceEventKey}
        </Button>
      </RowActions>
      {open && (
        <form
          className="mt-3 flex flex-col items-start gap-3"
          aria-label={`Correct time of ${row.sourceEventKey}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            correct.mutate();
          }}
        >
          <FormField>
            Time with its UTC offset
            <Input required maxLength={40} placeholder="YYYY-MM-DDThh:mm:ss±hh:mm" value={time} onChange={(e) => setTime(e.target.value)} />
          </FormField>
          <FormField>
            Reason
            <Textarea required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <Hint>Confirm the reading on the device. The offset settles which of the two readings of a repeated hour this is. The record as received stays on file.</Hint>
          <Button type="submit" disabled={correct.isPending || !reason.trim()}>
            Confirm correction
          </Button>
          <Refusal error={correct.error} />
        </form>
      )}
    </RowActionsCell>
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
      <FilterBar>
        <FormField>
          Outcome
          <NativeSelect
            value={outcome}
            onChange={(e) => {
              setOutcome(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Any</option>
            <option value="QUARANTINED">Quarantined</option>
            <option value="REJECTED">Rejected</option>
          </NativeSelect>
        </FormField>
        <CheckField>
          <input
            type="checkbox"
            checked={openOnly}
            onChange={(e) => {
              setOpenOnly(e.target.checked);
              setPage(1);
            }}
          />{' '}
          Leave out those since accepted
        </CheckField>
      </FilterBar>
      <ErrorNote error={rows.error} />
      {rows.data?.items.length === 0 && <Empty>Nothing to show.</Empty>}
      {rows.data && rows.data.items.length > 0 && (
        <>
          <Table aria-label="Rejected and quarantined records">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Profile</TableHead>
                <TableHead scope="col">Received</TableHead>
                <TableHead scope="col">Outcome</TableHead>
                <TableHead scope="col">Why</TableHead>
                <TableHead scope="col">Event key</TableHead>
                <TableHead scope="col">Device said</TableHead>
                <TableHead scope="col">Kept on record</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.data.items.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.profileCode}</TableCell>
                  <TableCell>{formatInstant(r.observedAt)}</TableCell>
                  <TableCell>
                    <StateBadge state={r.outcome} />
                  </TableCell>
                  <TableCell>{failureText(r.failureCode)}</TableCell>
                  <TableCell>{r.sourceEventKey ?? '—'}</TableCell>
                  <TableCell>{r.evidence ? evidenceText(r.evidence) : '—'}</TableCell>
                  <TableCell>{r.kept ? `${r.kept.employeeKey} · ${formatInstant(r.kept.instant)} · ${r.kept.direction}` : '—'}</TableCell>
                  <ExceptionActions row={r} onChanged={refresh} />
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
        {/* A grid of one field, so the choice takes a column's width rather than the whole card's. */}
        <FormGrid asChild>
          <div>
            <ProfilePicker value={profileId} onChange={setProfileId} anyLabel="All profiles" />
          </div>
        </FormGrid>
      </Section>
      <RunList profileId={profileId} />
      <ExceptionList profileId={profileId} />
      {can(SYNC_RUN) && <StartRun onChanged={refresh} />}
    </>
  );
}
