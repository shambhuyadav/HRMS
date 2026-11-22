// The calendar screens, as the navigation registry takes them.
import type { ScreenRoute } from '../../screens';
import { HolidayCalendarPage } from './holidays';
import { HOLIDAY_READ, SHIFT_READ } from './shared';
import { ShiftMasterPage } from './shifts';
import { WeeklyOffPage } from './weekly-off';

export const CALENDARS_SCREENS: readonly ScreenRoute[] = [
  { path: '/calendars/holidays', title: 'Holiday calendar', permission: HOLIDAY_READ, nav: true, component: HolidayCalendarPage },
  { path: '/calendars/shifts', title: 'Shift master', permission: SHIFT_READ, nav: true, component: ShiftMasterPage },
  { path: '/calendars/weekly-off', title: 'Weekly-off patterns', permission: SHIFT_READ, nav: true, component: WeeklyOffPage },
];
