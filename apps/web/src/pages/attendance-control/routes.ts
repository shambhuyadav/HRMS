// Navigation exports of the attendance control module: its screens.

import type { ScreenRoute } from '../../screens';
import { AttendanceControlPage } from './control';
import { AttendanceDashboardPage } from './dashboard';
import { AttendanceReportsPage } from './reports';

export const ATTENDANCE_CONTROL_SCREENS: readonly ScreenRoute[] = [
  { path: '/attendance/control', title: 'Attendance control', permission: 'attendance.amend.operational', nav: true, component: AttendanceControlPage },
  // CL-053: shown to the roles that review attendance (HR and managers); the server answers anyone with the attendance read duty, over their scope.
  { path: '/attendance/dashboard', title: 'Attendance dashboard', permission: 'attendance.approve_correction.operational', nav: true, component: AttendanceDashboardPage },
  // CL-047, CL-049 to CL-051: under the attendance export duty, as every attendance report.
  { path: '/attendance/reports', title: 'Attendance reports', permission: 'attendance.export.operational', nav: true, component: AttendanceReportsPage },
];
