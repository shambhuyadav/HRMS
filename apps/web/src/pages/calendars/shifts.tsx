// The shift master (FR-005; DF05; I-78 item 1): every shift with its times in force and its revisions; times change by a dated
// revision with a reason, a shift is renamed, deactivated or activated, and a new shift states its buffer.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions, RowActionsCell, RowPanel } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, Section } from '../../ui';
import { ONE_LINE, Refusal, type ReprocessList, SHIFT_CREATE, SHIFT_UPDATE, useReprocessNotice } from './shared';
import { BUFFER_HINT, BufferField, type BreakRow, breaksBody, clockAt, type ShiftBreak, TimesFields, timesText } from './shift-times';

interface ShiftRevision {
  revision: number;
  effectiveFrom: string | null;
  inTime: string;
  outTime: string;
  spansMidnight: boolean;
  netScheduledMinutes: number;
  bufferMinutes?: number;
  breaks: ShiftBreak[];
  reason: string | null;
}
export interface Shift {
  id: string;
  code: string;
  name: string;
  inTime: string;
  outTime: string;
  spansMidnight: boolean;
  netScheduledMinutes: number;
  bufferMinutes?: number;
  active: boolean;
  version: number;
  revision: number;
  effectiveFrom: string | null;
  breaks: ShiftBreak[];
  revisions: ShiftRevision[];
}

/** The link that folds a shift's revisions open, in the accent colour, a 44px target on a phone; spaced from the list once open. */
const REVISIONS_SUMMARY = 'w-max cursor-pointer text-[0.86rem] font-semibold text-[var(--accent)] group-open:mb-[0.6rem] phone:py-3';

function NewShift({ onChanged }: { onChanged: () => void }) {
  const blank = { code: '', name: '', inTime: '', outTime: '', bufferMinutes: '' };
  const [form, setForm] = useState(blank);
  const [breaks, setBreaks] = useState<BreakRow[]>([]);
  const create = useMutation({
    mutationFn: () =>
      api('/v1/shifts', {
        body: { code: form.code.trim(), name: form.name.trim(), inTime: form.inTime, outTime: form.outTime, breaks: breaksBody(form.inTime, breaks), bufferMinutes: Number(form.bufferMinutes) },
      }),
    onSuccess: () => {
      setForm(blank);
      setBreaks([]);
      onChanged();
    },
  });
  return (
    <Section title="New shift">
      <FormGrid
        aria-label="New shift"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <FormField>
          Code
          <Input required maxLength={40} pattern="[A-Za-z0-9][A-Za-z0-9_\-]*" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </FormField>
        <FormField>
          Name
          <Input required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </FormField>
        <TimesFields inTime={form.inTime} outTime={form.outTime} breaks={breaks} onTimes={(t) => setForm({ ...form, ...t })} onBreaks={setBreaks} />
        <BufferField required value={form.bufferMinutes} onChange={(bufferMinutes) => setForm({ ...form, bufferMinutes })} />
        <Hint>{BUFFER_HINT}</Hint>
        <Button type="submit" disabled={create.isPending}>
          Create shift
        </Button>
        <Refusal error={create.error} />
      </FormGrid>
    </Section>
  );
}

function ShiftActions({ shift, onChanged, onSaved }: { shift: Shift; onChanged: () => void; onSaved: (r: ReprocessList) => void }) {
  const [open, setOpen] = useState<'times' | 'name' | null>(null);
  const [times, setTimes] = useState({ effectiveFrom: '', inTime: shift.inTime, outTime: shift.outTime, reason: '', bufferMinutes: '' });
  const [breaks, setBreaks] = useState<BreakRow[]>(shift.breaks.map((b, i) => ({ key: i + 1, from: clockAt(shift.inTime, b.startOffsetMinutes), to: clockAt(shift.inTime, b.endOffsetMinutes) })));
  const [name, setName] = useState(shift.name);
  const refreshOnError = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'STALE_VERSION') onChanged();
  };
  const revise = useMutation({
    mutationFn: () =>
      api<{ reprocess: ReprocessList }>(`/v1/shifts/${shift.id}/revisions`, {
        body: {
          expectedVersion: shift.version,
          effectiveFrom: times.effectiveFrom,
          inTime: times.inTime,
          outTime: times.outTime,
          breaks: breaksBody(times.inTime, breaks),
          reason: times.reason.trim(),
          ...(times.bufferMinutes !== '' ? { bufferMinutes: Number(times.bufferMinutes) } : {}),
        },
      }),
    onSuccess: (res) => {
      setOpen(null);
      onSaved(res.reprocess);
      onChanged();
    },
    onError: refreshOnError,
  });
  const patch = useMutation({
    mutationFn: (body: { name?: string; active?: boolean }) => api(`/v1/shifts/${shift.id}`, { method: 'PATCH', body: { expectedVersion: shift.version, ...body } }),
    onSuccess: () => {
      setOpen(null);
      onChanged();
    },
    onError: refreshOnError,
  });
  // A refusal of activation shows under the buttons; one of a rename shows in its form.
  const activationError = open === null ? patch.error : null;
  return (
    <>
      <RowActions>
        <Button type="button" variant="outline" size="sm" aria-label={`Change times of ${shift.code}`} aria-expanded={open === 'times'} onClick={() => setOpen(open === 'times' ? null : 'times')}>
          Change times
        </Button>{' '}
        <Button type="button" variant="outline" size="sm" aria-label={`Rename ${shift.code}`} aria-expanded={open === 'name'} onClick={() => setOpen(open === 'name' ? null : 'name')}>
          Rename
        </Button>{' '}
        <Button
          type="button"
          variant={shift.active ? 'danger' : 'outline'}
          size="sm"
          aria-label={`${shift.active ? 'Deactivate' : 'Activate'} ${shift.code}`}
          disabled={patch.isPending}
          onClick={() => patch.mutate({ active: !shift.active })}
        >
          {shift.active ? 'Deactivate' : 'Activate'}
        </Button>
      </RowActions>
      {activationError && (
        <RowPanel>
          <Refusal error={activationError} />
        </RowPanel>
      )}
      {open === 'times' && (
        <RowPanel asChild>
          <FormGrid
            aria-label={`Change times of ${shift.code}`}
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              revise.mutate();
            }}
          >
            <FormField>
              Applies from
              <Input type="date" required value={times.effectiveFrom} onChange={(e) => setTimes({ ...times, effectiveFrom: e.target.value })} />
            </FormField>
            <TimesFields inTime={times.inTime} outTime={times.outTime} breaks={breaks} onTimes={(t) => setTimes({ ...times, ...t })} onBreaks={setBreaks} />
            <BufferField required={false} value={times.bufferMinutes} onChange={(bufferMinutes) => setTimes({ ...times, bufferMinutes })} />
            <FormField className="col-span-full">
              Reason
              <Input required maxLength={500} value={times.reason} onChange={(e) => setTimes({ ...times, reason: e.target.value })} />
            </FormField>
            <Button type="submit" disabled={revise.isPending}>
              Save revision
            </Button>
            <Hint>The earlier times stay in force before this date. A later revision on the same date corrects this one.</Hint>
            <Refusal error={revise.error} />
          </FormGrid>
        </RowPanel>
      )}
      {open === 'name' && (
        <RowPanel asChild>
          <FormGrid
            aria-label={`Rename ${shift.code}`}
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              patch.mutate({ name: name.trim() });
            }}
          >
            <FormField>
              Name
              <Input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
            </FormField>
            <Button type="submit" disabled={patch.isPending}>
              Save name
            </Button>
            <Refusal error={patch.error} />
          </FormGrid>
        </RowPanel>
      )}
    </>
  );
}

function RevisionHistory({ shift }: { shift: Shift }) {
  if (shift.revisions.length < 2) return null;
  return (
    <details className="group">
      <summary className={REVISIONS_SUMMARY}>Revisions of {shift.code}</summary>
      <ul className="m-0 pl-5">
        {shift.revisions.map((r) => (
          <li key={r.revision}>
            Revision {r.revision}, {r.effectiveFrom ? `from ${r.effectiveFrom}` : 'from the start'}: {timesText(r)}
            {r.reason ? `. ${r.reason}` : ''}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ShiftMasterPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const canUpdate = can(SHIFT_UPDATE);
  const shifts = useQuery({ queryKey: ['shifts'], queryFn: () => api<{ items: Shift[] }>('/v1/shifts') });
  const { notice, show } = useReprocessNotice();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['shifts'] });
  const items = shifts.data?.items ?? [];
  return (
    <>
      <Section title="Shift master">
        <ErrorNote error={shifts.error} />
        {notice}
        {shifts.isSuccess && items.length === 0 && <Empty>No shifts yet.</Empty>}
        {items.length > 0 && (
          <Table aria-label="Shifts">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Code</TableHead>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">In force today</TableHead>
                <TableHead scope="col">Active</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className={ONE_LINE}>{s.code}</TableCell>
                  <TableCell>{s.name}</TableCell>
                  <TableCell>
                    {timesText(s)}
                    <Hint as="span" className="block">
                      {s.effectiveFrom ? `Revision ${s.revision}, from ${s.effectiveFrom}` : 'From the start'}
                    </Hint>
                    <RevisionHistory shift={s} />
                  </TableCell>
                  <TableCell>{s.active ? <Badge tone="good">active</Badge> : <Badge>inactive</Badge>}</TableCell>
                  <RowActionsCell>{canUpdate && <ShiftActions key={s.version} shift={s} onChanged={refresh} onSaved={show} />}</RowActionsCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Hint>
          {BUFFER_HINT} A shift whose out time is before its in time runs into the next day (the 24-hour cycle) and still belongs to the date it starts; a shift of exactly 24 hours is not accepted.
        </Hint>
      </Section>
      {can(SHIFT_CREATE) && <NewShift onChanged={refresh} />}
    </>
  );
}
