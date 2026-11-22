// The user account and reference value screens, as the navigation registry takes them.
import type { ScreenRoute } from '../../screens';
import { ReferenceValuesPage } from './reference-values';
import { READ_REFERENCE, READ_USERS } from './shared';
import { UserAccountsPage } from './user-accounts';

export const ORG_ADMIN_SCREENS: ScreenRoute[] = [
  { path: '/admin/user-accounts', title: 'User accounts', permission: READ_USERS, nav: true, component: UserAccountsPage },
  { path: '/admin/reference-values', title: 'Reference values', permission: READ_REFERENCE, nav: true, component: ReferenceValuesPage },
];
