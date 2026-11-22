// Attendance control (FR-021; E07), the attendance dashboard (CL-053) and the attendance reports (CL-047, CL-049 to CL-051); each
// lives in ./attendance-control/.
//
// Attendance control lists attendance across the role's scope, filtered by department, location, status, shift, date, employee
// and minutes, in pages with the total and a matching export; one day opens with its untouched source punches beside the derived
// result, the policy revision and why the status changed. The dashboard counts a date's attendance per department, each count
// opening the employees behind it. The reports are generated in the background with the filters each one takes. The server
// re-checks everything.
export { ATTENDANCE_CONTROL_SCREENS } from './attendance-control/routes';
export { attendanceReportFilters } from './attendance-control/reports';
