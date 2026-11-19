// The requisition and budget screens and decision queues, as the navigation registry takes them.
import type { ComponentType } from 'react';
import type { EssPanel, ScreenRoute } from '../../screens';
import { BudgetDetailScreen } from './budget';
import { BudgetDecisionQueue } from './budget-queue';
import { BudgetsScreen } from './budgets';
import { RequisitionDetailScreen } from './requisition';
import { RequisitionApprovalQueue, RequisitionValidationQueue } from './requisition-queues';
import { NewRequisitionScreen, RequisitionsScreen } from './requisitions';
import { BUDGET_APPROVE, BUDGET_READ, PATHS, REQ_APPROVE, REQ_CREATE, REQ_READ, REQ_VALIDATE } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Exports for the navigation step (App.tsx wires these)
// ---------------------------------------------------------------------------------------------------------

/** Screens of hiring part 1; detail screens are reached through links (nav: false). */
export const HIRING_REQUISITIONS_SCREENS: ScreenRoute[] = [
  { path: PATHS.requisitions, title: 'Requisitions', permission: REQ_READ, nav: true, component: RequisitionsScreen },
  { path: PATHS.newRequisition, title: 'New requisition', permission: REQ_CREATE, nav: false, component: NewRequisitionScreen },
  { path: '/hiring/requisitions/:id', title: 'Requisition', permission: REQ_READ, nav: false, component: RequisitionDetailScreen },
  { path: PATHS.budgets, title: 'Manpower budgets', permission: BUDGET_READ, nav: true, component: BudgetsScreen },
  { path: '/hiring/budgets/:id', title: 'Manpower budget', permission: BUDGET_READ, nav: false, component: BudgetDetailScreen },
];

/** Hiring serves no H3 My ESS tab (TN01-TN18), and its registration declares no essTabs. */
export const HIRING_REQUISITIONS_ESS_PANELS: EssPanel[] = [];

/**
 * The decision queues, also shown on the budget and requisition screens. Requisition tasks are listed by
 * GET /v1/hiring/requisition-tasks (requisition.read) and decided with their F1 step's own duty, so each step has its
 * own queue gated by that duty: validation (requisition.validate) and budget and headcount approval
 * (requisition.approve). A role holding neither (a Recruiter) is offered no requisition queue.
 */
export const HIRING_REQUISITIONS_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [
  { permission: BUDGET_APPROVE, title: 'Manpower budget approvals', component: BudgetDecisionQueue },
  { permission: REQ_VALIDATE, title: 'Requisition validations', component: RequisitionValidationQueue },
  { permission: REQ_APPROVE, title: 'Requisition budget and headcount approvals', component: RequisitionApprovalQueue },
];
