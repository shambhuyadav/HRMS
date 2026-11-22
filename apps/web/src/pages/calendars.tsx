// Holidays, shifts and weekly-off patterns (FR-005; DF05 "Shift and holiday calendars are editable and effective-dated";
// DF08; I-04; I-54).
//
// Nothing here overwrites: a holiday is corrected or withdrawn and the earlier entry stays, shift times change by a dated
// revision, and a weekly-off pattern is a dated entry per location. Days already evaluated keep their results until they are
// processed again, so every change answers with the dates it reaches, and HR reprocesses them from here; a day a processed
// payroll used never changes. The page proposes no value. The server re-checks every duty and rule; this page only offers
// what the role can do.
//
// Decided under owner delegation, 6 Nov 2026 (I-78 items 1 and 4): a shift's buffer is its punch capture window before the
// start and after the end, stated for every new shift; the 24-hour-cycle indicator is the overnight flag the times give. A
// weekly-off pattern may add whole days off on some weeks of the month (the 2nd and 4th Saturdays) and half weekly-offs,
// which stay working days for leave and payroll and are measured against half the shift.
//
// The code is in ./calendars/: the holiday calendar (holidays), the shift master (shifts) and a shift's times (shift-times), the
// weekly-off patterns (weekly-off), shared.tsx (duty keys, the dates a change reaches and their reprocessing, refusals, shared
// class lists), and routes.ts. This entry module re-exports what other modules import from it.
export { type Holiday, HolidayCalendarPage } from './calendars/holidays';
export { CALENDARS_SCREENS } from './calendars/routes';
export type { ReprocessDay, ReprocessList } from './calendars/shared';
export { type Shift, ShiftMasterPage } from './calendars/shifts';
export { type WeeklyOffCalendar, WeeklyOffPage } from './calendars/weekly-off';
