// Settlement policy and statutory rule packs (FR-052; decided under owner delegation, 6 Nov 2026: docs/03 I-88).
//   /lifecycle/settlement-settings
//
// The full-and-final calculation (lifecycle-documents.tsx) runs on the server under the settlement policy revision and the statutory
// rule packs in force on the employee's last working date. Both are dated configuration, never constants:
// - The settlement policy (payroll configuration duties): the pay components that stand for Basic and DA, the components an
//   encashment, a notice recovery and a gratuity are paid or recovered on, the daily-rate basis and divisor of encashment and of notice
//   recovery, and the encashable leave types with their caps. A change is a new DRAFT revision, written by one person and activated by
//   another (SELF_APPROVAL otherwise); the server's defaults prefill the form.
// - The statutory rule packs (statutory pack duties): each revision is an inactive draft until one authorised person records where
//   its values come from and how they were validated, and another activates it; until then an employee it applies to is blocked
//   with RULE_PACK_NOT_CONFIGURED.
// The server authorises every call and decides every rule; this screen hides what the selected assignment cannot use, shows what the
// server returned and says its refusals in plain words (the conventions of lifecycle-documents.tsx, whose helpers it shares).
//
// The code is in ./settlement-settings/: screen.tsx (the screen and its route), policy.tsx (the settlement policy), packs.tsx (the
// statutory rule packs) and shared.ts (permission keys, paths, the API's shapes, labels, query keys and layout classes). This entry
// module re-exports what other modules import from it.
export { SETTLEMENT_SETTINGS_SCREENS } from './settlement-settings/screen';
