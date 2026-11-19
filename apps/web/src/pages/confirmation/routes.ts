// The confirmation policies screen, as the navigation registry takes it.
import type { ScreenRoute } from '../../screens';
import { ConfirmationPoliciesPage } from './policies';
import { MANAGE_POLICIES, POLICIES_PATH } from './shared';

export const CONFIRMATION_SCREENS: ScreenRoute[] = [{ path: POLICIES_PATH, title: 'Confirmation policies', permission: MANAGE_POLICIES, nav: true, component: ConfirmationPoliciesPage }];
