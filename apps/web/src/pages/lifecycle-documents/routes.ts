// The letter and settlement screens and decision queues, as the navigation registry takes them.
import type { ComponentType } from 'react';
import type { EssPanel, ScreenRoute } from '../../screens';
import { ExitSettlementsScreen } from './exit-settlements';
import { LetterTemplateScreen } from './letter-template';
import { LetterTemplatesScreen } from './letter-templates';
import { EmployeeLettersScreen, LettersScreen } from './letters';
import { ProcessLettersScreen } from './process-letters';
import { SettlementScreen } from './settlement';
import { SettlementApprovalQueue, SettlementReviewQueue } from './settlement-queues';
import { SettlementsScreen } from './settlements';
import { LETTER_GENERATE, LETTER_READ, PATHS, SETTLEMENT_APPROVE, SETTLEMENT_READ, SETTLEMENT_REVIEW, TEMPLATE_READ } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Exports for the navigation step (App.tsx wires them): screens, decision queues. No H3 My ESS tab is served.
// ---------------------------------------------------------------------------------------------------------

/** The module's letter and settlement screens; detail screens are reached through links (`nav: false`). */
export const LIFECYCLE_DOCUMENTS_SCREENS: ScreenRoute[] = [
  { path: PATHS.templates, title: 'Letter templates', permission: TEMPLATE_READ, nav: true, component: LetterTemplatesScreen },
  { path: '/lifecycle/letter-templates/:id', title: 'Letter template', permission: TEMPLATE_READ, nav: false, component: LetterTemplateScreen },
  { path: PATHS.letters, title: 'Letters', permission: LETTER_READ, nav: true, component: LettersScreen },
  { path: '/lifecycle/employees/:id/letters', title: 'Employee letters', permission: LETTER_READ, nav: false, component: EmployeeLettersScreen },
  { path: '/lifecycle/processes/:id/letters', title: 'Process letters', permission: LETTER_GENERATE, nav: false, component: ProcessLettersScreen },
  { path: PATHS.settlements, title: 'Full and final settlements', permission: SETTLEMENT_READ, nav: true, component: SettlementsScreen },
  { path: '/lifecycle/exits/:id/settlements', title: 'Exit settlements', permission: SETTLEMENT_READ, nav: false, component: ExitSettlementsScreen },
  { path: '/lifecycle/settlements/:id', title: 'Settlement', permission: SETTLEMENT_READ, nav: false, component: SettlementScreen },
];

/**
 * No H3 My ESS tab (TN01 to TN18) covers letters or settlements, and the lifecycle registration declares no ESS tabs:
 * the API refuses one's own letters, notes and settlement (SELF_ACTION_NOT_ALLOWED), so nothing is offered in the hub.
 */
export const LIFECYCLE_DOCUMENTS_ESS_PANELS: EssPanel[] = [];

/** The settlement decision queues (FR-053), also shown on the settlements screen. */
export const LIFECYCLE_DOCUMENTS_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [
  { permission: SETTLEMENT_REVIEW, title: 'Settlement reviews', component: SettlementReviewQueue },
  { permission: SETTLEMENT_APPROVE, title: 'Settlement approvals', component: SettlementApprovalQueue },
];
