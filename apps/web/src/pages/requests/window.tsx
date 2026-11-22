// The time a request covers: its days, or part of one day (outdoor duty may run overnight, DF05), as written in the lists and as
// entered in the new-request form and the correction of a returned request.
import { CheckField, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Input } from '@/components/ui/input';
import { formatDate } from '../../api';
import type { Kind } from './shared';

/** A timed outdoor-duty window whose end is before its start ends on the next day (night duty, DF05). */
const overnight = (startTime: string | null | undefined, endTime: string | null | undefined) => !!startTime && !!endTime && endTime < startTime;

/** "2026-11-04 – 2026-11-06" or "2026-11-04 22:00–06:00 (ends the next day)". */
export function describeWindow(r: { startDate: string; endDate: string; startTime: string | null; endTime: string | null }): string {
  const range = `${formatDate(r.startDate)}${r.endDate.slice(0, 10) !== r.startDate.slice(0, 10) ? ` – ${formatDate(r.endDate)}` : ''}`;
  if (!r.startTime) return range;
  return `${range} ${r.startTime}–${r.endTime}${overnight(r.startTime, r.endTime) ? ' (ends the next day)' : ''}`;
}

export interface Draft {
  startDate: string;
  endDate: string;
  timed: boolean;
  startTime: string;
  endTime: string;
  purpose: string;
}
export const blankDraft = (): Draft => ({ startDate: '', endDate: '', timed: false, startTime: '09:00', endTime: '13:00', purpose: '' });

/** What the API needs: a timed request (and all holiday work) covers its start date only. */
export function requestBody(kind: Kind, d: Draft) {
  const singleDay = kind === 'holiday_work' || d.timed;
  return {
    startDate: d.startDate,
    endDate: singleDay ? d.startDate : d.endDate,
    ...(d.timed ? { startTime: d.startTime, endTime: d.endTime } : {}),
    purpose: d.purpose,
  };
}

type WindowProblem = 'EMPTY_WINDOW' | 'HOLIDAY_WORK_ENDS_BEFORE_START';

/** The window rules the server applies (work-request service `check`), caught before sending. */
export function windowProblem(kind: Kind, d: Draft): WindowProblem | null {
  if (!d.timed) return null;
  if (d.startTime === d.endTime) return 'EMPTY_WINDOW';
  if (kind === 'holiday_work' && d.endTime < d.startTime) return 'HOLIDAY_WORK_ENDS_BEFORE_START';
  return null;
}

/** States the timed-window rule for the kind; an empty window is called out as well. */
export function WindowHint({ kind, draft }: { kind: Kind; draft: Draft }) {
  if (!draft.timed) return null;
  return (
    <Hint>
      {kind === 'outdoor_duty' ? 'An end time earlier than the start time ends on the next day (overnight duty).' : 'Holiday work stays within its day: the end must be after the start.'}
      {windowProblem(kind, draft) === 'EMPTY_WINDOW' && ' The start and end times must differ.'}
    </Hint>
  );
}

/** Date, time and purpose inputs shared by the new-request form and the correction of a returned request. */
export function WindowFields({ kind, draft, onChange }: { kind: Kind; draft: Draft; onChange: (d: Draft) => void }) {
  const singleDay = kind === 'holiday_work' || draft.timed;
  return (
    <>
      <FormField>
        {singleDay ? 'Date' : 'From'}
        <Input type="date" required value={draft.startDate} onChange={(e) => onChange({ ...draft, startDate: e.target.value })} />
      </FormField>
      {!singleDay && (
        <FormField>
          To
          <Input type="date" required value={draft.endDate} onChange={(e) => onChange({ ...draft, endDate: e.target.value })} />
        </FormField>
      )}
      {/* Its own row under the dates, as "Half day" is on the leave form. */}
      <CheckField className="col-span-full">
        <input type="checkbox" checked={draft.timed} onChange={(e) => onChange({ ...draft, timed: e.target.checked })} /> Part of the day
      </CheckField>
      {draft.timed && (
        <>
          <FormField>
            Start
            <Input type="time" required value={draft.startTime} onChange={(e) => onChange({ ...draft, startTime: e.target.value })} />
          </FormField>
          <FormField>
            End
            <Input type="time" required value={draft.endTime} onChange={(e) => onChange({ ...draft, endTime: e.target.value })} />
          </FormField>
        </>
      )}
      <FormField className="col-span-full">
        Purpose
        <Input required maxLength={1000} value={draft.purpose} onChange={(e) => onChange({ ...draft, purpose: e.target.value })} />
      </FormField>
    </>
  );
}
