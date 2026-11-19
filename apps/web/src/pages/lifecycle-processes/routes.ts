// Navigation exports of the lifecycle process module: its screens, its own-record panels and its decision queues.

import type { ComponentType } from 'react';
import type { EssPanel, ScreenRoute } from '../../screens';
import { ABSCONDING_AUDIT_PATH, AbscondingAuditScreen, NOTE_EXPORT } from './absconding-audit';
import { MyProcessesPanel, MyProcessesScreen, MyResignationPanel, MyResignationScreen } from './ess';
import { ExitDetailScreen, ExitsScreen } from './exits';
import { NOTE_IMPORT, NotesRegisterScreen, NotesUploadScreen } from './notes-register';
import { ProcessDetailScreen } from './process-view';
import { EmployeeLifecycleScreen, ProcessesScreen } from './processes';
import { ExitApprovalQueue, ExitRecommendationQueue, ExitWithdrawalQueue, ProcessTaskQueue } from './queues';
import { EXIT_APPROVE, EXIT_READ, EXIT_RECOMMEND, EXIT_SUBMIT, NOTE_READ, PATHS, PROCESS_READ, TASK_COMPLETE, TEMPLATE_READ } from './shared';
import { TemplateDetailScreen, TemplatesScreen } from './templates';

// ---------------------------------------------------------------------------------------------------------
// Exports for the navigation step (App.tsx wires them): screens, own-record panels and decision queues
// ---------------------------------------------------------------------------------------------------------

/** The module's screens; detail screens are reached through links (`nav: false`). */
export const LIFECYCLE_PROCESSES_SCREENS: ScreenRoute[] = [
  { path: PATHS.templates, title: 'Process templates', permission: TEMPLATE_READ, nav: true, component: TemplatesScreen },
  { path: '/lifecycle/process-templates/:id', title: 'Process template', permission: TEMPLATE_READ, nav: false, component: TemplateDetailScreen },
  { path: PATHS.processes, title: 'Employee processes', permission: PROCESS_READ, nav: true, staffOnly: true, component: ProcessesScreen },
  { path: '/lifecycle/processes/:id', title: 'Employee process', permission: PROCESS_READ, nav: false, component: ProcessDetailScreen },
  { path: '/lifecycle/employees/:id', title: 'Employee processes and exit', permission: PROCESS_READ, nav: false, component: EmployeeLifecycleScreen },
  { path: PATHS.exits, title: 'Exit cases', permission: EXIT_READ, nav: true, staffOnly: true, component: ExitsScreen },
  { path: '/lifecycle/exits/:id', title: 'Exit case', permission: EXIT_READ, nav: false, component: ExitDetailScreen },
  // CL-040 (0260): the restricted notes register and its bulk upload.
  { path: PATHS.notes, title: 'Exit notes, remarks and warnings', permission: NOTE_READ, nav: true, component: NotesRegisterScreen },
  { path: PATHS.notesUpload, title: 'Notes bulk upload', permission: NOTE_IMPORT, nav: true, component: NotesUploadScreen },
  // CL-052 (0283): the absconding warnings issued, a report under its own confidential export right.
  { path: ABSCONDING_AUDIT_PATH, title: 'Absconding audit', permission: NOTE_EXPORT, nav: true, component: AbscondingAuditScreen },
  { path: PATHS.myResignation, title: 'My resignation', permission: EXIT_SUBMIT, nav: true, component: MyResignationScreen },
  { path: PATHS.myProcesses, title: 'My processes', permission: PROCESS_READ, nav: false, component: MyProcessesScreen },
];

/**
 * The employee's own resignation and processes for the ESS hub (Employee OWN context). The lifecycle module serves no
 * H3 tab (TN01–TN18) and declares no essTabs: the panels use the module's own /v1/me routes, and their ids are not H3
 * ids, so the hub shows them beside its index-driven tabs (the /me/resignation and /me/processes screens show them too).
 */
export const LIFECYCLE_PROCESSES_ESS_PANELS: EssPanel[] = [
  { tabId: 'RESIGNATION', component: MyResignationPanel },
  { tabId: 'MY_PROCESSES', component: MyProcessesPanel },
];

/**
 * The decision queues, also shown on the exit and process screens. The three exit queues list
 * GET /v1/exit-cases/tasks/mine (exit.read) and decide with their step's own duty; the process task queue lists
 * GET /v1/employee-process-tasks/mine and completes or skips tasks.
 */
export const LIFECYCLE_PROCESSES_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [
  { permission: EXIT_RECOMMEND, title: 'Resignation recommendations', component: ExitRecommendationQueue },
  { permission: EXIT_APPROVE, title: 'Resignation approvals', component: ExitApprovalQueue },
  { permission: EXIT_APPROVE, title: 'Resignation withdrawal requests', component: ExitWithdrawalQueue },
  { permission: TASK_COMPLETE, title: 'My process tasks', component: ProcessTaskQueue },
];
