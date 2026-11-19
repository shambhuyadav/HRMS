// Navigation exports of the leave administration module: its screens.

import type { ScreenRoute } from '../../screens';
import { BeforeAccrualPage, LeaveLedgerPage, MonthlyLeaveBalancePage } from './balances';
import { LeavePoliciesPage } from './policies';
import { MANAGE } from './shared';

export const LEAVE_ADMIN_SCREENS: readonly ScreenRoute[] = [
  { path: '/leave/policies', title: 'Leave policies', permission: MANAGE, nav: true, component: LeavePoliciesPage },
  { path: '/leave/before-accrual', title: 'Before leave accrual', permission: 'leave.accrue.operational', nav: true, component: BeforeAccrualPage },
  { path: '/leave/ledger', title: 'Leave ledger', permission: 'leave.adjust.operational', nav: true, component: LeaveLedgerPage },
  { path: '/leave/monthly-balance', title: 'Upload monthly leave balance', permission: 'leave.import.operational', nav: true, component: MonthlyLeaveBalancePage },
];
