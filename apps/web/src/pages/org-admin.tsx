// User accounts (§5 System Administrator; §5.1 User to employee; DB007; DB009) and reference values (FR-004 configurable entities;
// DF04; DB006). An account is created, edited, deleted while never used, deactivated or reactivated with a reason, and its password
// reset; a temporary password the server issues is shown once and kept in no cache. A link to an employee grants no permission by
// itself; role assignments stay on the access page. Reference values are created, relabelled, deactivated or end-dated, never
// deleted; the server decides which lists can change and which codes must stay in force. Every call is re-checked by the server.
//
// The code is in ./org-admin/: the user accounts page (user-accounts), account administration (accounts), the issued temporary
// password (issued-panel), employee links and the reason step of a row action (links), reference values (reference-values),
// shared.ts (duty keys, the API's shapes of an account and its links, shared class lists), and routes.ts. This entry module
// re-exports what other modules import from it.
export { ReferenceValuesPage } from './org-admin/reference-values';
export { ORG_ADMIN_SCREENS } from './org-admin/routes';
export { UserAccountsPage } from './org-admin/user-accounts';
