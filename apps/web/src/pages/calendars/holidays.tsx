// The holiday calendar (FR-005; DF08; I-04): the holidays of a location and year, corrected or withdrawn with a reason (the earlier
// entry stays on record), and a new holiday; every change answers with the dates it reaches.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { FilterBar, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions, RowActionsCell, RowPanel } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, formatDate } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section, StateBadge } from '../../ui';
import { HOLIDAY_MANAGE, ONE_LINE, Refusal, type ReprocessList, useReprocessNotice } from './shared';

interface LocationOption {
  id: string;
  code: string;
  name: string;
  active: boolean;
}
interface HolidayOptions {
  locations: LocationOption[];
  types: { code: string; label: string }[];
}
export interface Holiday {
  id: string;
  locationId: string;
  holidayDate: string;
  name: string;
  holidayType: string;
  state: string;
  version: number;
  supersedesId: string | null;
  supersededById: string | null;
  closedAt: string | null;
  closedReason: string | null;
}

const locationLabel = (l: LocationOption) => `${l.name}${l.active ? '' : ' (inactive)'}`;

function NewHoliday({ options, locationId, onDone }: { options: HolidayOptions; locationId: string; onDone: (r: ReprocessList) => void }) {
  const [form, setForm] = useState({ holidayDate: '', name: '', holidayType: '' });
  const add = useMutation({
    mutationFn: () => api<{ reprocess: ReprocessList }>('/v1/holidays', { body: { locationId, holidayDate: form.holidayDate, name: form.name.trim(), holidayType: form.holidayType } }),
    onSuccess: (res) => {
      setForm({ holidayDate: '', name: '', holidayType: '' });
      onDone(res.reprocess);
    },
  });
  return (
    <Section title="Add a holiday">
      <FormGrid
        aria-label="Add a holiday"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <FormField>
          Date
          <Input type="date" required value={form.holidayDate} onChange={(e) => setForm({ ...form, holidayDate: e.target.value })} />
        </FormField>
        <FormField>
          Name
          <Input required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </FormField>
        <FormField>
          Type
          <NativeSelect required value={form.holidayType} onChange={(e) => setForm({ ...form, holidayType: e.target.value })}>
            <option value="">Choose a type</option>
            {options.types.map((t) => (
              <option key={t.code} value={t.code}>
                {t.label}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <Button type="submit" disabled={add.isPending || !locationId}>
          Add holiday
        </Button>
      </FormGrid>
      <Refusal error={add.error} />
    </Section>
  );
}

/** A change opened on a holiday's row: its form under the row's buttons. */
function RowForm({ label, onSubmit, children }: { label: string; onSubmit: () => void; children: ReactNode }) {
  return (
    <RowPanel asChild>
      <FormGrid
        aria-label={label}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        {children}
      </FormGrid>
    </RowPanel>
  );
}

function HolidayActions({ holiday, options, onChanged, onSaved }: { holiday: Holiday; options: HolidayOptions; onChanged: () => void; onSaved: (r: ReprocessList) => void }) {
  const [open, setOpen] = useState<'correct' | 'withdraw' | null>(null);
  const [form, setForm] = useState({ locationId: holiday.locationId, holidayDate: holiday.holidayDate, name: holiday.name, holidayType: holiday.holidayType });
  const [reason, setReason] = useState('');
  const settled = (res: { reprocess: ReprocessList }) => {
    setOpen(null);
    onSaved(res.reprocess);
    onChanged();
  };
  // A stale version reloads the list, so the next attempt reviews the entry as it now stands.
  const refreshOnError = (err: unknown) => {
    if (err instanceof ApiError && (err.code === 'STALE_VERSION' || err.code === 'HOLIDAY_CLOSED')) onChanged();
  };
  const correct = useMutation({
    mutationFn: () => {
      const changed: Record<string, string> = {};
      if (form.locationId !== holiday.locationId) changed.locationId = form.locationId;
      if (form.holidayDate !== holiday.holidayDate) changed.holidayDate = form.holidayDate;
      if (form.name.trim() !== holiday.name) changed.name = form.name.trim();
      if (form.holidayType !== holiday.holidayType) changed.holidayType = form.holidayType;
      return api<{ reprocess: ReprocessList }>(`/v1/holidays/${holiday.id}/correct`, { body: { expectedVersion: holiday.version, reason: reason.trim(), ...changed } });
    },
    onSuccess: settled,
    onError: refreshOnError,
  });
  const withdraw = useMutation({
    mutationFn: () => api<{ reprocess: ReprocessList }>(`/v1/holidays/${holiday.id}/withdraw`, { body: { expectedVersion: holiday.version, reason: reason.trim() } }),
    onSuccess: settled,
    onError: refreshOnError,
  });
  const toggle = (which: 'correct' | 'withdraw') => setOpen(open === which ? null : which);
  const label = `${holiday.name} on ${holiday.holidayDate}`;
  const reasonField = (
    <FormField className="col-span-full">
      Reason
      <Input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
    </FormField>
  );
  return (
    <>
      <RowActions>
        <Button type="button" variant="outline" size="sm" aria-label={`Correct ${label}`} aria-expanded={open === 'correct'} onClick={() => toggle('correct')}>
          Correct
        </Button>{' '}
        <Button type="button" variant="danger" size="sm" aria-label={`Withdraw ${label}`} aria-expanded={open === 'withdraw'} onClick={() => toggle('withdraw')}>
          Withdraw
        </Button>
      </RowActions>
      {open === 'correct' && (
        <RowForm label={`Correct ${label}`} onSubmit={() => correct.mutate()}>
          <FormField>
            Location
            <NativeSelect value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })}>
              {options.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {locationLabel(l)}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField>
            Date
            <Input type="date" required value={form.holidayDate} onChange={(e) => setForm({ ...form, holidayDate: e.target.value })} />
          </FormField>
          <FormField>
            Name
            <Input required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </FormField>
          <FormField>
            Type
            <NativeSelect value={form.holidayType} onChange={(e) => setForm({ ...form, holidayType: e.target.value })}>
              {!options.types.some((t) => t.code === holiday.holidayType) && <option value={holiday.holidayType}>{holiday.holidayType}</option>}
              {options.types.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          {reasonField}
          <Button type="submit" disabled={correct.isPending}>
            Save correction
          </Button>
          <Hint>This entry stays on record as replaced, and the corrected one takes its place.</Hint>
          <Refusal error={correct.error} />
        </RowForm>
      )}
      {open === 'withdraw' && (
        <RowForm label={`Withdraw ${label}`} onSubmit={() => withdraw.mutate()}>
          {reasonField}
          <Button type="submit" disabled={withdraw.isPending}>
            Confirm withdrawal
          </Button>
          <Hint>The entry stays on record as withdrawn; the date stops being a holiday of this location.</Hint>
          <Refusal error={withdraw.error} />
        </RowForm>
      )}
    </>
  );
}

function closedNote(h: Holiday): string {
  if (h.state === 'WITHDRAWN') return `Withdrawn on ${formatDate(h.closedAt)}: ${h.closedReason ?? ''}`;
  if (h.state === 'SUPERSEDED') return `Replaced on ${formatDate(h.closedAt)}: ${h.closedReason ?? ''}`;
  return h.supersedesId ? 'A correction of an earlier entry' : '';
}

export function HolidayCalendarPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const canManage = can(HOLIDAY_MANAGE);
  const options = useQuery({ queryKey: ['holiday-options'], queryFn: () => api<HolidayOptions>('/v1/holidays/options') });
  const [chosen, setChosen] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [state, setState] = useState('ACTIVE');
  const { notice, show } = useReprocessNotice();
  const locationId = chosen || options.data?.locations[0]?.id || '';
  const list = useQuery({
    queryKey: ['holidays', locationId, year, state],
    enabled: locationId !== '' && /^\d{4}$/.test(year),
    queryFn: () => api<{ items: Holiday[] }>(`/v1/holidays?locationId=${encodeURIComponent(locationId)}&year=${encodeURIComponent(year)}&state=${state}`),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['holidays'] });
  const items = list.data?.items ?? [];
  // The years a calendar is kept for: a few back for the record, two ahead for planning.
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 6 }, (_, i) => String(thisYear - 3 + i));
  // A Note column only when some entry has something to say (in force entries usually have none).
  const notes = items.map(closedNote);
  const hasNotes = notes.some((n) => n !== '');
  return (
    <>
      <Section title="Holiday calendar">
        <FilterBar>
          <FormField>
            Location
            <NativeSelect value={locationId} onChange={(e) => setChosen(e.target.value)}>
              {options.data?.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {locationLabel(l)}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField>
            Year
            <NativeSelect value={year} onChange={(e) => setYear(e.target.value)}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField>
            Show
            <NativeSelect value={state} onChange={(e) => setState(e.target.value)}>
              <option value="ACTIVE">In force</option>
              <option value="WITHDRAWN">Withdrawn</option>
              <option value="SUPERSEDED">Replaced by a correction</option>
              <option value="ALL">All entries</option>
            </NativeSelect>
          </FormField>
        </FilterBar>
        <ErrorNote error={options.error ?? list.error} />
        {notice}
        {list.isSuccess && items.length === 0 && <Empty>{state === 'ACTIVE' ? 'No holidays in force for this location and year.' : 'No entries of this kind for this location and year.'}</Empty>}
        {items.length > 0 && (
          <Table aria-label="Holidays">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Date</TableHead>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">Type</TableHead>
                <TableHead scope="col">State</TableHead>
                {hasNotes && <TableHead scope="col">Note</TableHead>}
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((h, i) => (
                <TableRow key={h.id}>
                  <TableCell className={ONE_LINE}>{formatDate(h.holidayDate)}</TableCell>
                  <TableCell>{h.name}</TableCell>
                  <TableCell>{options.data?.types.find((t) => t.code === h.holidayType)?.label ?? h.holidayType}</TableCell>
                  <TableCell>
                    <StateBadge state={h.state === 'SUPERSEDED' ? 'REPLACED' : h.state} />
                  </TableCell>
                  {hasNotes && <TableCell>{notes[i]}</TableCell>}
                  <RowActionsCell>
                    {canManage && h.state === 'ACTIVE' && options.data && <HolidayActions key={h.version} holiday={h} options={options.data} onChanged={refresh} onSaved={show} />}
                  </RowActionsCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Hint>A holiday applies only to employees assigned to its location on that date. Corrected and withdrawn entries stay on record: choose them under Show.</Hint>
      </Section>
      {canManage && options.data && (
        <NewHoliday
          options={options.data}
          locationId={locationId}
          onDone={(r) => {
            show(r);
            refresh();
          }}
        />
      )}
    </>
  );
}
