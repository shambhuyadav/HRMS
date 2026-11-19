// The appraisal screens, the My ESS panel and the decision queues, as the navigation registry takes them.
import type { ComponentType } from 'react';
import type { EssPanel, ScreenRoute } from '../../screens';
import { BELL_CURVE_PATH, BellCurveScreen } from './bell-curve';
import { CompetencyConfigScreen } from './competency-config';
import { CycleDetailScreen, CyclesScreen } from './cycles';
import { AppraisalDetailScreen } from './detail';
import { GoalUploadScreen } from './goal-upload';
import { MyAppraisalsPanel } from './my-appraisal';
import { RatingQueue, RatingsScreen, ReviewQueue, ReviewsScreen } from './queues';
import { AppraisalsScreen } from './register';
import { ReportsScreen } from './reports';
import { CONFIRM, CYCLE_READ, IMPORT, PATHS, RATE, READ, REPORT, REPORT_RATING } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Exports for the navigation step (App.tsx wires these)
// ---------------------------------------------------------------------------------------------------------

/**
 * Screens of the appraisal module; detail screens are reached through links (nav: false). The register's menu entry is
 * keyed to appraisal_cycle.read (held by HR and the Reporting Manager, whose cycle filter needs it) rather than
 * appraisal.read, which the Employee role also holds for its own appraisal on My ESS TN18; the screen itself checks
 * appraisal.read, as the API does.
 */
export const APPRAISAL_SCREENS: ScreenRoute[] = [
  { path: PATHS.cycles, title: 'Appraisal cycles', permission: CYCLE_READ, nav: true, component: CyclesScreen },
  { path: '/appraisal/cycles/:id', title: 'Appraisal cycle', permission: CYCLE_READ, nav: false, component: CycleDetailScreen },
  { path: PATHS.appraisals, title: 'Appraisals', permission: CYCLE_READ, nav: true, component: AppraisalsScreen },
  { path: '/appraisal/appraisals/:id', title: 'Appraisal', permission: READ, nav: false, component: AppraisalDetailScreen },
  { path: PATHS.ratings, title: 'Appraisal ratings', permission: RATE, nav: true, component: RatingsScreen },
  { path: PATHS.reviews, title: 'Appraisal reviews', permission: CONFIRM, nav: true, component: ReviewsScreen },
  { path: PATHS.reports, title: 'Appraisal reports', permission: REPORT, nav: true, component: ReportsScreen },
  // CL-132 (0262): the bell curve, read-only for ratings (the confidential rating report right).
  { path: BELL_CURVE_PATH, title: 'Bell curve', permission: REPORT_RATING, nav: true, component: BellCurveScreen },
  { path: PATHS.goalUpload, title: 'KRA upload', permission: IMPORT, nav: true, component: GoalUploadScreen },
  // FR-041 / I-86: the result split, the competency master and the grade mapping (Appraisal Config).
  { path: PATHS.competencies, title: 'Appraisal competencies', permission: CYCLE_READ, nav: true, component: CompetencyConfigScreen },
];

/** H3 TN18 in the Employee OWN context (registration essTabs: GET /v1/me/appraisals). */
export const APPRAISAL_ESS_PANELS: EssPanel[] = [{ tabId: 'TN18', component: MyAppraisalsPanel }];

/**
 * The decision queues, also shown on the ratings and reviews screens. Tasks are listed by GET /v1/appraisal-tasks/mine
 * (appraisal.read) and decided with their step's own duty: the manager rating (appraisal.rate.rating) and the
 * independent reviewer confirmation at either level (appraisal.confirm.rating).
 */
export const APPRAISAL_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [
  { permission: RATE, title: 'Appraisal ratings', component: RatingQueue },
  { permission: CONFIRM, title: 'Appraisal reviews', component: ReviewQueue },
];
