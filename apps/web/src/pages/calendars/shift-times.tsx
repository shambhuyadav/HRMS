// A shift's times (FR-005; DF05; I-78 item 1): the in and out times, the scheduled breaks as clock times, and the buffer, the punch
// capture window before the start and after the end. The API takes a break as minutes from the shift's start.
import { useState } from 'react';
import { FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface ShiftBreak {
  startOffsetMinutes: number;
  endOffsetMinutes: number;
}

const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const clockAt = (inTime: string, offset: number) => {
  const m = (minutesOf(inTime) + offset) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
/** A break clock time as minutes from the shift's start (a night shift's break after midnight wraps round). */
const offsetFrom = (inTime: string, at: string) => (minutesOf(at) - minutesOf(inTime) + 1440) % 1440;
const breaksText = (inTime: string, breaks: ShiftBreak[]) =>
  breaks.length === 0 ? 'no scheduled break' : breaks.map((b) => `break ${clockAt(inTime, b.startOffsetMinutes)}-${clockAt(inTime, b.endOffsetMinutes)}`).join(', ');
export const timesText = (r: { inTime: string; outTime: string; spansMidnight: boolean; netScheduledMinutes: number; breaks: ShiftBreak[]; bufferMinutes?: number }) =>
  `${r.inTime}-${r.outTime}${r.spansMidnight ? ' (next day: 24-hour cycle)' : ''}, ${breaksText(r.inTime, r.breaks)}, ${r.netScheduledMinutes} net minutes${
    r.bufferMinutes === undefined ? '' : `, punches from ${r.bufferMinutes} minutes before to ${r.bufferMinutes} after`
  }`;

export interface BreakRow {
  key: number;
  from: string;
  to: string;
}

export const breaksBody = (inTime: string, rows: BreakRow[]) => rows.map((b) => ({ startOffsetMinutes: offsetFrom(inTime, b.from), endOffsetMinutes: offsetFrom(inTime, b.to) }));

export const BUFFER_HINT = 'Punches from the buffer before the in time to the buffer after the out time belong to the shift’s day, the date it starts. The shift and both buffers fit in 24 hours, so two days never share a punch.';

/** One break's two times and its remove button on a line of their own across the form, bottoms aligned (the old `.row.wide`). */
const BREAK_LINE = 'col-span-full flex flex-wrap items-end gap-x-[1.1rem] gap-y-[0.95rem]';
/** A time in a break's line: the width of one column of the form, not the whole line. */
const BREAK_TIME = 'w-[210px]';

/** The times of a shift, for a new shift or a dated revision: fields of the caller's form grid. */
export function TimesFields(props: {
  inTime: string;
  outTime: string;
  breaks: BreakRow[];
  onTimes: (t: { inTime?: string; outTime?: string }) => void;
  onBreaks: (b: BreakRow[]) => void;
}) {
  const { inTime, outTime, breaks, onTimes, onBreaks } = props;
  const [nextKey, setNextKey] = useState(breaks.length + 1);
  const setBreak = (key: number, patch: Partial<BreakRow>) => onBreaks(breaks.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  return (
    <>
      <FormField>
        In time
        <Input type="time" required value={inTime} onChange={(e) => onTimes({ inTime: e.target.value })} />
      </FormField>
      <FormField>
        Out time
        <Input type="time" required value={outTime} onChange={(e) => onTimes({ outTime: e.target.value })} />
      </FormField>
      {breaks.map((b, i) => (
        <span key={b.key} className={BREAK_LINE}>
          <FormField className={BREAK_TIME}>
            Break {i + 1} from
            <Input type="time" required value={b.from} onChange={(e) => setBreak(b.key, { from: e.target.value })} />
          </FormField>
          <FormField className={BREAK_TIME}>
            Break {i + 1} to
            <Input type="time" required value={b.to} onChange={(e) => setBreak(b.key, { to: e.target.value })} />
          </FormField>
          <Button type="button" variant="link" onClick={() => onBreaks(breaks.filter((x) => x.key !== b.key))}>
            Remove break {i + 1}
          </Button>
        </span>
      ))}
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          onBreaks([...breaks, { key: nextKey, from: '', to: '' }]);
          setNextKey(nextKey + 1);
        }}
      >
        Add a break
      </Button>
      <Hint>An out time before the in time is the next day. Scheduled breaks are unpaid and lie inside the shift.</Hint>
    </>
  );
}

/** I-78 item 1: the punch capture window each side of the shift. */
export function BufferField({ value, onChange, required }: { value: string; onChange: (v: string) => void; required: boolean }) {
  return (
    <FormField>
      {required ? 'Buffer before and after (minutes)' : 'Buffer before and after (minutes; blank keeps the one in force)'}
      <Input required={required} inputMode="numeric" pattern="\d{1,3}" value={value} onChange={(e) => onChange(e.target.value)} />
    </FormField>
  );
}
