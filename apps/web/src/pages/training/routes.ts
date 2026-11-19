// Navigation exports of the training module: its screens, its My ESS panel and its (empty) decision queues.

import type { ComponentType } from 'react';
import type { EssPanel, ScreenRoute } from '../../screens';
import { MyTrainingPanel } from './ess';
import { FeedbackScreen } from './feedback';
import { EmployeeTrainingScreen, ParticipantScreen } from './participants';
import { PlanScreen } from './plan';
import { PlansScreen } from './plans';
import { FEEDBACK_READ, PART_READ, PATHS, PLAN_READ } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Exports for the navigation step (App.tsx wires them later)
// ---------------------------------------------------------------------------------------------------------

/**
 * Screens of the training module; detail screens are reached through links (nav: false). The participation and
 * employee screens use the row scope (a reporting manager reads the direct team's training there).
 */
export const TRAINING_SCREENS: ScreenRoute[] = [
  { path: PATHS.plans, title: 'Training plans', permission: PLAN_READ, nav: true, component: PlansScreen },
  { path: '/training/plans/:id', title: 'Training plan', permission: PLAN_READ, nav: false, component: PlanScreen },
  { path: '/training/plans/:id/feedback', title: 'Training feedback', permission: FEEDBACK_READ, nav: false, component: FeedbackScreen },
  { path: '/training/participants/:id', title: 'Training participation', permission: PART_READ, nav: false, component: ParticipantScreen },
  { path: '/training/employees/:id', title: 'Employee’s training', permission: PART_READ, nav: false, component: EmployeeTrainingScreen },
];

/** H3 TN17 in the Employee OWN context (registration essTabs: participations, openPlans, enrol, feedback, submitFeedback). */
export const TRAINING_ESS_PANELS: EssPanel[] = [{ tabId: 'TN17', component: MyTrainingPanel }];

/**
 * The training module routes no decision to a reviewer (I-26: no approval workflow; the coordinator confirms
 * nominations on the plan's participants screen), so it has no task route and no decision queue.
 */
export const TRAINING_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [];
