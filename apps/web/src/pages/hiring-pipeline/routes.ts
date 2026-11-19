// The hiring pipeline screens and decision queue, as the navigation registry takes them.
import type { ComponentType } from 'react';
import type { EssPanel, ScreenRoute } from '../../screens';
import { ApplicationScreen } from './application';
import { CandidateScreen } from './candidate';
import { CandidatesScreen } from './candidates';
import { CvSearchScreen } from './cv-search';
import { DuplicateReviewScreen } from './duplicates';
import { EmployeeOriginScreen } from './handover';
import { OfferApprovalQueue } from './offer-approvals';
import { OfferScreen, OffersScreen } from './offers';
import { RequisitionApplicationsScreen } from './requisition-applications';
import { APPLICATION_READ, CANDIDATE_READ, COMPENSATION_APPROVE, DOCUMENT_READ, OFFER_READ, PATHS } from './shared';
import { HiringTrackerScreen } from './tracker';
import { VendorsScreen } from './vendors';

// ---------------------------------------------------------------------------------------------------------
// Exports for the navigation step (App.tsx wires them): screens, decision queues. Hiring serves no H3 My ESS tab.
// ---------------------------------------------------------------------------------------------------------

/** The pipeline's screens; detail screens are reached through links (`nav: false`). */
export const HIRING_PIPELINE_SCREENS: ScreenRoute[] = [
  { path: PATHS.tracker, title: 'Hiring tracker', permission: APPLICATION_READ, nav: true, component: HiringTrackerScreen },
  { path: PATHS.candidates, title: 'Candidates', permission: CANDIDATE_READ, nav: true, component: CandidatesScreen },
  { path: '/hiring/candidates/:id', title: 'Candidate', permission: CANDIDATE_READ, nav: false, component: CandidateScreen },
  { path: PATHS.duplicates, title: 'Duplicate review', permission: CANDIDATE_READ, nav: true, component: DuplicateReviewScreen },
  { path: PATHS.cvSearch, title: 'CV search', permission: DOCUMENT_READ, nav: true, component: CvSearchScreen },
  { path: PATHS.vendors, title: 'Recruitment vendors', permission: CANDIDATE_READ, nav: true, component: VendorsScreen },
  { path: '/hiring/requisitions/:id/applications', title: 'Requisition applications', permission: APPLICATION_READ, nav: false, component: RequisitionApplicationsScreen },
  { path: '/hiring/applications/:id', title: 'Application', permission: APPLICATION_READ, nav: false, component: ApplicationScreen },
  { path: PATHS.offers, title: 'Offers', permission: OFFER_READ, nav: true, component: OffersScreen },
  { path: '/hiring/offers/:id', title: 'Offer', permission: OFFER_READ, nav: false, component: OfferScreen },
  { path: '/hiring/employees/:id/origin', title: 'Hiring origin', permission: APPLICATION_READ, nav: false, component: EmployeeOriginScreen },
];

/** Hiring serves no H3 My ESS tab (TN01 to TN18), and its registration declares no ESS tabs. */
export const HIRING_PIPELINE_ESS_PANELS: EssPanel[] = [];

/** The module's decision queue for the Decision inbox: offers waiting for the independent eligible approver. */
export const HIRING_PIPELINE_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [
  { permission: COMPENSATION_APPROVE, title: 'Offer approvals', component: OfferApprovalQueue },
];
