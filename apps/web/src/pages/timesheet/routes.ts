// Navigation exports of the timesheet module: its screens, its My ESS panel and its decision queues.

import type { ComponentType } from 'react';
import type { EssPanel, ScreenRoute } from '../../screens';
import { AllocationsScreen } from './allocations';
import { MyTimesheetsPanel } from './ess';
import { AllocationImportScreen, LineImportScreen } from './imports';
import { ActivityScreen, JobScreen, MastersScreen, ProjectScreen } from './masters';
import { MissedScreen } from './missed';
import { ApprovalsScreen, ReopenDecisionQueue, ReopenScreen, TimesheetDecisionQueue } from './queues';
import { ReportsScreen } from './reports';
import { ALLOC_IMPORT, ALLOC_READ, MASTER_READ, PATHS, TS_APPROVE, TS_IMPORT, TS_READ, TS_REOPEN, TS_REPORT } from './shared';
import { TimesheetScreen, TimesheetsScreen } from './sheet';

// ---------------------------------------------------------------------------------------------------------
// Exports for the navigation step (App.tsx wires these)
// ---------------------------------------------------------------------------------------------------------

/** Screens of the timesheet module; detail screens are reached through links (nav: false). */
export const TIMESHEET_SCREENS: ScreenRoute[] = [
  { path: PATHS.masters, title: 'Projects and activities', permission: MASTER_READ, nav: true, component: MastersScreen },
  { path: '/timesheet/projects/:id', title: 'Timesheet project', permission: MASTER_READ, nav: false, component: ProjectScreen },
  { path: '/timesheet/jobs/:id', title: 'Timesheet job', permission: MASTER_READ, nav: false, component: JobScreen },
  { path: '/timesheet/activities/:id', title: 'Timesheet activity', permission: MASTER_READ, nav: false, component: ActivityScreen },
  { path: PATHS.allocations, title: 'Resource allocations', permission: ALLOC_READ, nav: true, component: AllocationsScreen },
  // The menu checks one key; the screen also needs the manage key the upload and commit require.
  { path: PATHS.allocationImports, title: 'Allocation import', permission: ALLOC_IMPORT, nav: true, component: AllocationImportScreen },
  { path: PATHS.timesheets, title: 'Timesheets', permission: TS_READ, nav: true, component: TimesheetsScreen },
  { path: '/timesheets/:id', title: 'Timesheet', permission: TS_READ, nav: false, component: TimesheetScreen },
  { path: PATHS.lineImports, title: 'Timesheet entry import', permission: TS_IMPORT, nav: true, component: LineImportScreen },
  { path: PATHS.approvals, title: 'Timesheet approvals', permission: TS_APPROVE, nav: true, component: ApprovalsScreen },
  { path: PATHS.reopens, title: 'Timesheet reopen requests', permission: TS_REOPEN, nav: true, component: ReopenScreen },
  { path: PATHS.missed, title: 'Missed timesheets', permission: TS_READ, nav: true, component: MissedScreen },
  { path: PATHS.reports, title: 'Timesheet reports', permission: TS_REPORT, nav: true, component: ReportsScreen },
];

/** H3 TN13 in the Employee OWN context (registration essTabs: /v1/me/timesheets and the own lists). */
export const TIMESHEET_ESS_PANELS: EssPanel[] = [{ tabId: 'TN13', component: MyTimesheetsPanel }];

/** The decision queues, also shown on the approvals and reopen screens. */
export const TIMESHEET_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [
  { permission: TS_APPROVE, title: 'Timesheet approvals', component: TimesheetDecisionQueue },
  { permission: TS_REOPEN, title: 'Timesheet reopen requests', component: ReopenDecisionQueue },
];
