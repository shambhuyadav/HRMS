// Administration screens: the audit trail, retention, reviewer routing, mobile-app link review, and notification rules with
// their approvals. The code is in ./admin/, one module per screen, with routes.ts (the registry's screens); this entry module
// re-exports what other modules import from it.
export { AuditTrailPage } from './admin/audit-trail';
export { MobileLinkReviewPage } from './admin/mobile-links';
export { NotificationRulesPage } from './admin/notification-rules';
export { RetentionPage } from './admin/retention';
export { ADMIN_SCREENS } from './admin/routes';
export { RoutingPage } from './admin/routing';
export { NotificationRuleApprovalsPage } from './admin/rule-approvals';
