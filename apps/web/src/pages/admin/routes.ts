// The administration screens offered through the navigation registry.
import type { ScreenRoute } from '../../screens';
import { MANAGE_RULES, NotificationRulesPage } from './notification-rules';
import { APPROVE_RULES, NotificationRuleApprovalsPage } from './rule-approvals';

/**
 * The administration screens offered through the registry (the notification rule pages). The other administration pages
 * (audit trail, retention, routing, mobile links) predate it and are routed in App.tsx directly.
 */
export const ADMIN_SCREENS: ScreenRoute[] = [
  { path: '/admin/notification-rules', title: 'Notification rules', permission: MANAGE_RULES, nav: true, component: NotificationRulesPage },
  { path: '/admin/notification-rule-approvals', title: 'Notification rule approvals', permission: APPROVE_RULES, nav: true, component: NotificationRuleApprovalsPage },
];
