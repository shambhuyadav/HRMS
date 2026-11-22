// Weekly-off patterns (FR-005; DF05; I-78 item 4): one dated entry per location, whole days off every week, and some weeks of the
// month off or half off (the 2nd and 4th Saturdays). A half weekly-off stays a working day for leave and payroll.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { CheckField, ChoiceRow, FormField, FormGrid, FramedFieldset } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions, RowActionsCell, RowPanel } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, formatDate } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section } from '../../ui';
import { Refusal, type ReprocessList, SHIFT_UPDATE, useReprocessNotice } from './shared';

const WEEKDAYS = [
  { day: 1, name: 'Monday' },
  { day: 2, name: 'Tuesday' },
  { day: 3, name: 'Wednesday' },
  { day: 4, name: 'Thursday' },
  { day: 5, name: 'Friday' },
  { day: 6, name: 'Saturday' },
  { day: 7, name: 'Sunday' },
];
/** Some weeks of the month of one weekday (I-78 item 4): week 1 is days 1-7, week 5 days 29-31. */
interface Occurrences {
  weekday: number;
  weeks: number[];
}
const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th'];
const dayName = (d: number) => WEEKDAYS.find((w) => w.day === d)?.name ?? String(d);
const occurrencesText = (list: Occurrences[] | undefined, what: string) =>
  (list ?? []).map((o) => `${o.weeks.length === 5 ? 'every' : o.weeks.map((n) => ORDINAL[n - 1]).join(' and ')} ${dayName(o.weekday)} ${what}`);
const offText = (p: { offDays: number[]; offOccurrences?: Occurrences[]; halfOff?: Occurrences[] }) => {
  const parts = [...(p.offDays.length > 0 ? [`${p.offDays.map(dayName).join(', ')} off`] : []), ...occurrencesText(p.offOccurrences, 'off'), ...occurrencesText(p.halfOff, 'half off')];
  return parts.length === 0 ? 'No weekly off' : parts.join('; ');
};

export interface WeeklyOffCalendar {
  locationId: string;
  locationCode: string;
  locationName: string;
  active: boolean;
  inForce: { offDays: number[]; offOccurrences?: Occurrences[]; halfOff?: Occurrences[]; isDefault: boolean; revision: number | null; effectiveFrom: string | null };
  latestRevision: number;
  entries: { id: string; revision: number; effectiveFrom: string; offDays: number[]; offOccurrences?: Occurrences[]; halfOff?: Occurrences[]; reason: string }[];
}

/** Week choices per weekday as `${weekday}:${week}` keys; the API's list from them, weekdays off every week left out. */
const keysOf = (list: Occurrences[] | undefined) => (list ?? []).flatMap((o) => o.weeks.map((n) => `${o.weekday}:${n}`));
const listOf = (keys: string[], off: number[]): Occurrences[] =>
  WEEKDAYS.filter((w) => !off.includes(w.day))
    .map((w) => ({ weekday: w.day, weeks: [1, 2, 3, 4, 5].filter((n) => keys.includes(`${w.day}:${n}`)) }))
    .filter((o) => o.weeks.length > 0);

function PatternActions({ calendar, onChanged, onSaved }: { calendar: WeeklyOffCalendar; onChanged: () => void; onSaved: (r: ReprocessList) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ effectiveFrom: '', reason: '' });
  const [off, setOff] = useState<number[]>(calendar.inForce.offDays);
  const [weeksOff, setWeeksOff] = useState<string[]>(keysOf(calendar.inForce.offOccurrences));
  const [weeksHalf, setWeeksHalf] = useState<string[]>(keysOf(calendar.inForce.halfOff));
  const toggle = (list: string[], set: (v: string[]) => void, key: string, on: boolean) => set(on ? [...list, key] : list.filter((k) => k !== key));
  const save = useMutation({
    mutationFn: () =>
      api<{ reprocess: ReprocessList }>('/v1/weekly-off-patterns', {
        body: {
          locationId: calendar.locationId,
          effectiveFrom: form.effectiveFrom,
          offDays: [...off].sort((a, b) => a - b),
          offOccurrences: listOf(weeksOff, off),
          halfOff: listOf(weeksHalf, off),
          reason: form.reason.trim(),
          expectedRevision: calendar.latestRevision,
        },
      }),
    onSuccess: (res) => {
      setOpen(false);
      onSaved(res.reprocess);
      onChanged();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'STALE_VERSION') onChanged();
    },
  });
  const name = calendar.locationCode;
  return (
    <>
      <RowActions>
        <Button type="button" variant="outline" size="sm" aria-label={`Change pattern of ${name}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          Change pattern
        </Button>
      </RowActions>
      {open && (
        <RowPanel asChild>
          <FormGrid
            aria-label={`Change pattern of ${name}`}
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <FormField>
              Applies from
              <Input type="date" required value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
            </FormField>
            <FramedFieldset legend="Weekly off days">
              {WEEKDAYS.map((w) => (
                <CheckField key={w.day}>
                  <input type="checkbox" checked={off.includes(w.day)} onChange={(e) => setOff(e.target.checked ? [...off, w.day] : off.filter((d) => d !== w.day))} /> {w.name}
                </CheckField>
              ))}
            </FramedFieldset>
            {[
              { legend: 'Off on some weeks of the month', list: weeksOff, set: setWeeksOff, other: weeksHalf, what: 'off' },
              { legend: 'Half weekly-off on some weeks of the month', list: weeksHalf, set: setWeeksHalf, other: weeksOff, what: 'half off' },
            ].map((group) => (
              <FramedFieldset key={group.legend} legend={group.legend}>
                {WEEKDAYS.filter((w) => !off.includes(w.day)).map((w) => (
                  <ChoiceRow key={w.day}>
                    {[1, 2, 3, 4, 5].map((n) => {
                      const key = `${w.day}:${n}`;
                      return (
                        <CheckField key={key}>
                          <input type="checkbox" checked={group.list.includes(key)} disabled={group.other.includes(key)} onChange={(e) => toggle(group.list, group.set, key, e.target.checked)} />{' '}
                          {`${ORDINAL[n - 1]} ${w.name} ${group.what}`}
                        </CheckField>
                      );
                    })}
                  </ChoiceRow>
                ))}
              </FramedFieldset>
            ))}
            <FormField className="col-span-full">
              Reason
              <Input required maxLength={500} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            </FormField>
            <Button type="submit" disabled={save.isPending}>
              Save pattern
            </Button>
            <Hint>
              Weeks count from the 1st of the month: days 1 to 7 are the 1st week. A half weekly-off is still a working day for leave and payroll; attendance measures it against the first half of the shift. The earlier
              pattern stays in force before this date; a later entry on the same date corrects this one.
            </Hint>
            <Refusal error={save.error} />
          </FormGrid>
        </RowPanel>
      )}
    </>
  );
}

export function WeeklyOffPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const canUpdate = can(SHIFT_UPDATE);
  const calendars = useQuery({ queryKey: ['weekly-off-patterns'], queryFn: () => api<{ defaultOffDays: number[]; items: WeeklyOffCalendar[] }>('/v1/weekly-off-patterns') });
  const { notice, show } = useReprocessNotice();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['weekly-off-patterns'] });
  const items = calendars.data?.items ?? [];
  return (
    <Section title="Weekly-off patterns">
      <ErrorNote error={calendars.error} />
      {notice}
      {calendars.isSuccess && items.length === 0 && <Empty>No locations yet.</Empty>}
      {items.length > 0 && (
        <Table aria-label="Weekly-off patterns">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Location</TableHead>
              <TableHead scope="col">In force today</TableHead>
              <TableHead scope="col">Entries</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((c) => (
              <TableRow key={c.locationId}>
                <TableCell>
                  {c.locationName}
                  {c.active ? '' : ' (inactive)'}
                </TableCell>
                <TableCell>
                  {offText(c.inForce)}
                  <Hint as="span" className="block">
                    {c.inForce.isDefault ? 'Company default (a Monday to Friday week): this location has no pattern of its own' : `Entry ${c.inForce.revision}, from ${formatDate(c.inForce.effectiveFrom)}`}
                  </Hint>
                </TableCell>
                <TableCell>
                  {c.entries.length === 0 ? (
                    'None'
                  ) : (
                    <ul className="m-0 pl-5">
                      {c.entries.map((e) => (
                        <li key={e.id}>
                          Entry {e.revision}, from {formatDate(e.effectiveFrom)}: {offText(e)}. {e.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </TableCell>
                <RowActionsCell>{canUpdate && <PatternActions key={c.latestRevision} calendar={c} onChanged={refresh} onSaved={show} />}</RowActionsCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Hint>
        Attendance, leave, outdoor duty, holiday work, payroll loss of pay and timesheet utilisation all count on this calendar; a half weekly-off counts as a working day for all of them but attendance. Reminders and
        hold escalations count business days on Monday to Friday.
      </Hint>
    </Section>
  );
}
