// What the holiday, shift and weekly-off screens share: the duty keys, the dates a change reaches and their reprocessing, the
// refusals of a calendar change in plain words, and the class list of a date that stays on one line.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Hint } from '@/components/hint';
import { RowActionsCell } from '@/components/row-actions';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, idempotencyKey } from '../../api';
import { useSession } from '../../session';
import { ErrorNote, Notice } from '../../ui';

export const HOLIDAY_READ = 'holiday.read.operational';
export const HOLIDAY_MANAGE = 'holiday.manage.operational';
export const SHIFT_READ = 'shift.read.operational';
export const SHIFT_CREATE = 'shift.create.operational';
export const SHIFT_UPDATE = 'shift.update.operational';
const ATTENDANCE_PROCESS = 'attendance.process.operational';

/** A date or a code stays on one line ("10 Mar 2026", not "10 Mar" over "2026"). */
export const ONE_LINE = 'whitespace-nowrap';
/** The notice of the dates a change reaches: its line, its table and its note stacked, set apart from the list below it. */
const NOTICE_STACK = 'mb-4 flex flex-col gap-3';

// ---------------------------------------------------------------------------------------------------------
// What a change reaches
// ---------------------------------------------------------------------------------------------------------

export interface ReprocessDay {
  workDate: string;
  toReprocess: number;
  amended: number;
  locked: number;
}
export interface ReprocessList {
  days: ReprocessDay[];
  truncated: boolean;
}

function ReprocessDate({ day }: { day: ReprocessDay }) {
  const process = useMutation({ mutationFn: () => api('/v1/attendance/processing', { body: { workDate: day.workDate, idempotencyKey: idempotencyKey('calendar-reprocess') } }) });
  if (process.isSuccess) {
    return (
      <span role="status">
        Queued. Follow it in <Link to="/bulk-jobs">My background jobs</Link>.
      </span>
    );
  }
  return (
    <>
      <Button type="button" variant="outline" size="sm" disabled={process.isPending} onClick={() => process.mutate()}>
        Reprocess {day.workDate}
      </Button>
      <ErrorNote error={process.error} />
    </>
  );
}

/** The dates a calendar change reaches. Nothing has changed on them yet. */
function ReprocessNotice({ list }: { list: ReprocessList }) {
  const { can } = useSession();
  const canProcess = can(ATTENDANCE_PROCESS);
  if (list.days.length === 0) return <Notice notice={{ text: 'Saved. No evaluated attendance day is affected.', ok: true }} />;
  return (
    <div role="status" className={NOTICE_STACK}>
      {/* The whole notice is the status (the dates belong to it), so its opening line is drawn as a success without a role of its own. */}
      <StatusNote tone="success" className="m-0">
        Saved. These dates were already evaluated and keep their results until they are processed again. Processing leaves amended days as they are, and a day a processed payroll used never changes.
      </StatusNote>
      <Table aria-label="Dates to reprocess">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Date</TableHead>
            <TableHead scope="col">To reprocess</TableHead>
            <TableHead scope="col">Amended, kept</TableHead>
            <TableHead scope="col">Used by processed payroll, final</TableHead>
            <TableHead scope="col">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.days.map((d) => (
            <TableRow key={d.workDate}>
              <TableCell className={ONE_LINE}>{d.workDate}</TableCell>
              <TableCell>{d.toReprocess}</TableCell>
              <TableCell>{d.amended}</TableCell>
              <TableCell>{d.locked}</TableCell>
              <RowActionsCell>{d.toReprocess > 0 && canProcess && <ReprocessDate day={d} />}</RowActionsCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {list.truncated && <Hint className="m-0">Showing the first {list.days.length} dates; more are affected.</Hint>}
    </div>
  );
}

/** The notice of the latest change: a new change starts a new notice, so a date queued earlier can be queued again. */
export function useReprocessNotice() {
  const [saved, setSaved] = useState<{ list: ReprocessList; change: number } | null>(null);
  return {
    notice: saved && <ReprocessNotice key={saved.change} list={saved.list} />,
    show: (list: ReprocessList) => setSaved((s) => ({ list, change: (s?.change ?? 0) + 1 })),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------------------

/** Refusals of a calendar change in plain words; any other is shown as the server sent it. */
function refusalText(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'STALE_VERSION') return 'This changed since you opened it. It has been reloaded; review it and try again.';
  if (error.code === 'HOLIDAY_CLOSED') return 'This entry was already corrected or withdrawn. Only the entry in force can change.';
  if (error.code === 'NO_CHANGE') return 'The correction changes nothing.';
  if (error.code === 'DUPLICATE') return 'This location already has a holiday of that type on that date, or the code is already in use.';
  if (error.code === 'OVERLAPPING_PERIOD') return 'The breaks overlap.';
  if (error.code === 'RULE_VIOLATION') return 'Check the values: the in and out times must differ, every break must lie inside the shift, and a reason cannot be blank.';
  if (error.code === 'BUFFER_OUT_OF_RANGE') {
    const max = (error.details as { maxBufferMinutes?: number } | undefined)?.maxBufferMinutes;
    return `The buffer is too long for this shift: at most ${max ?? 'half of what the day leaves'} minutes, so the windows of two days do not overlap.`;
  }
  if (error.code === 'INVALID_PATTERN') return 'Name each weekday once, not one already off every week, and make a day either a whole or a half weekly-off.';
  return null;
}

export function Refusal({ error }: { error: unknown }) {
  const words = refusalText(error);
  if (!words) return <ErrorNote error={error} />;
  return <Notice notice={{ text: words, ok: false }} />;
}
