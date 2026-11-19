// API shapes of the timesheet routes (masters, allocations, sheets, reopen requests, exceptions, reports).

import type { Dimension } from './shared';

// ---------------------------------------------------------------------------------------------------------
// API shapes (modules/timesheet/masters.ts, allocations.ts, sheets.ts, reopen.ts, exceptions.ts, reports.ts)
// ---------------------------------------------------------------------------------------------------------
export interface Master {
  id: string;
  code: string;
  name: string;
  ownerEmployeeId: string;
  ownerEmployeeCode: string;
  ownerName: string;
  startDate: string;
  endDate: string | null;
  active: boolean;
  version: number;
}
export interface Project extends Master {
  jobCount?: number;
}
interface JobActivityLink {
  activityId: string;
  code: string;
  name: string;
  productive: boolean;
  activityActive: boolean;
  linkActive: boolean;
}
export interface Job extends Master {
  projectId: string;
  projectCode?: string;
  projectName?: string;
  activities: JobActivityLink[];
}
export interface ProjectDetail extends Master {
  jobs: Job[];
}
export interface Activity extends Master {
  productive: boolean;
}
export type MasterKind = 'project' | 'job' | 'activity';

export interface Allocation {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  jobId: string;
  jobCode: string;
  jobName: string;
  startDate: string;
  endDate: string;
  allocationPercent: string;
  state: string;
  source: string;
  overAllocation: { reason: string; peakPercent: string; managerEmployeeId: string; recordedAt: string } | null;
  cancelReason: string | null;
  cancelledAt: string | null;
  version: number;
}
/** GET /v1/me/timesheet-allocations: the own active allocations with the activities each job permits now. */
export interface OwnAllocation {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  jobId: string;
  jobCode: string;
  jobName: string;
  startDate: string;
  endDate: string;
  allocationPercent: string;
  activities: { activityId: string; code: string; name: string }[];
}

export interface SheetSummary {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  state: string;
  currentRevision: number;
  approvedRevision: number | null;
  firstSubmittedAt: string | null;
  late: boolean | null;
  version: number;
  totalMinutes: number;
  approvedMinutes: number;
}
interface Revision {
  revision: number;
  origin: string;
  previousRevision: number | null;
  reopenRequestId: string | null;
  state: string;
  submittedAt: string | null;
  submittedOn: string | null;
  late: boolean | null;
  decidedAt: string | null;
  decisionReason: string | null;
  supersededAt: string | null;
  supersededByRevision: number | null;
  lineCount: number;
  totalMinutes: number;
}
export interface Line {
  id: string;
  workDate: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  jobId: string;
  jobCode: string;
  jobName: string;
  activityId: string;
  activityCode: string;
  activityName: string;
  minutes: number;
  productive: boolean;
  note: string | null;
  source: string;
  version: number;
}
interface ReopenRequest {
  id: string;
  approvedRevision: number;
  reason: string;
  state: string;
  newRevision: number | null;
  requestedAt: string;
  decidedAt: string | null;
}
export interface SheetDetail extends Omit<SheetSummary, 'totalMinutes' | 'approvedMinutes'> {
  shownRevision: number;
  revisions: Revision[];
  lines: Line[];
  dailyTotals: { workDate: string; minutes: number; hours: string }[];
  totalMinutes: number;
  pendingWith: string | null;
  decisions: { revision: number; decision: string; decidedAt: string }[];
  reopenRequests: ReopenRequest[];
}
export interface TimesheetTask {
  taskId: string;
  assignedAt: string;
  timesheet: (SheetSummary & { revisionLate: boolean | null }) | null;
}
export interface TimesheetDecided {
  timesheetId: string;
  revision: number;
  state: string;
  replayed: boolean;
}
export interface ReopenTask {
  taskId: string;
  assignedAt: string;
  request: {
    id: string;
    timesheetId: string;
    employeeCode: string;
    employeeName: string;
    periodStart: string;
    periodEnd: string;
    approvedRevision: number;
    reason: string;
    requestedAt: string;
  } | null;
}
export interface ReopenDecided {
  reopenRequestId: string;
  state: string;
  newRevision?: number | null;
  replayed: boolean;
}
export interface MissedWeek {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  raisedOn: string;
  state: string;
  resolution: string | null;
  resolutionReason: string | null;
  timesheetId: string | null;
  resolvedAt: string | null;
  version: number;
}
export interface OwnRequest {
  transactionId: string;
  state: string;
  pendingWith: string | null;
  createdAt: string;
  decisions: { step: number; decision: string; decidedAt: string }[];
}
interface Measures {
  minutes: number;
  hours: string;
  productiveMinutes: number;
  lineCount: number;
}
export type HoursGroup = Measures & Partial<Record<string, string | number | null>>;
export interface HoursReport {
  from: string;
  to: string;
  basis: string;
  groupBy: Dimension[];
  groups: HoursGroup[];
  /** FR-056: every group of the report, whatever page is shown. */
  totalGroups?: number;
  totals: Measures;
}
export interface ReportLine {
  id: string;
  timesheetId: string;
  revision: number;
  employeeCode: string;
  workDate: string;
  periodStart: string;
  projectCode: string;
  jobCode: string;
  activityCode: string;
  minutes: number;
  productive: boolean;
}
export interface UtilisationItem {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  approvedMinutes: number;
  productiveMinutes: number;
  status: 'OK' | 'NOT_APPLICABLE' | 'NOT_CONFIGURED';
  scheduledMinutes: number | null;
  utilisationPercent: string | null;
  display?: string;
  message?: string;
  unscheduledDays?: number;
}
export interface UtilisationReport {
  from: string;
  to: string;
  formula: string;
  scheduleBasis: string;
  items: UtilisationItem[];
  /** FR-056: every employee in scope, and totals over all of them (not only this page). */
  total?: number;
  totals?: { employees: number; byStatus: Record<string, number>; approvedMinutes: number; productiveMinutes: number; scheduledMinutes: number | null };
}
