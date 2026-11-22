// Tax declarations and investment proofs (FR-036 declaration checking; FR-108; H3 TN08, TN09; H4; BR-053): capture and review only.
// My ESS (Employee OWN context): the employee's own declaration and proofs. The regimes and categories shown are exactly what the
// active rule pack lists; the app holds none of its own and never calculates tax. Rule packs: the registry that lists them, with an
// independent activation. Review: the independent decision, with the employee-visible explanation apart from the private reason.
//
// The code is in ./tax-declarations/: the own panels (own), the review queue, register and Form 16 Part B (review), the rule pack
// registry (rule-packs) and shared.tsx (duties, the API's shapes and layout pieces). This entry module registers the screens, the
// My ESS panels and the decision inbox queue.
import type { EssPanel, ScreenRoute } from '../screens';
import { MyInvestmentProofsPanel, MyTaxDeclarationPanel } from './tax-declarations/own';
import { TaxReviewQueue, TaxReviewScreen } from './tax-declarations/review';
import { TaxRulePacksScreen } from './tax-declarations/rule-packs';
import { CONFIG_READ, REVIEW, REVIEW_READ } from './tax-declarations/shared';

export const TAX_SCREENS: ScreenRoute[] = [
  { path: '/payroll/tax-rule-packs', title: 'Tax rule packs', permission: CONFIG_READ, nav: true, component: TaxRulePacksScreen },
  { path: '/payroll/tax-review', title: 'Tax declaration review', permission: REVIEW_READ, nav: true, component: TaxReviewScreen },
];

/** H3 TN08 and TN09 in the Employee OWN context (the API says NOT_CONFIGURED on the tab until a rule pack is activated). */
export const TAX_ESS_PANELS: EssPanel[] = [
  { tabId: 'TN08', component: MyTaxDeclarationPanel },
  { tabId: 'TN09', component: MyInvestmentProofsPanel },
];

export const TAX_TASK_QUEUES = [{ permission: REVIEW, title: 'Tax declarations and proofs', component: TaxReviewQueue }];
