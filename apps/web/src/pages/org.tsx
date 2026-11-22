// Organisation masters (FR-004; BR-004; DF04; I-55; 0102): departments, locations, designations and grades, each with a code, a
// name, an active state and a validity period [from, until). A master is never deleted: it is deactivated or its period is
// closed, and history keeps it. The page holds no rule of its own: the server checks the period, the code and whether a live
// assignment would be stranded (MASTER_IN_USE), and this page says what it answered. A refusal keeps what was typed.
// The company itself (FR-004; DB001; DF05) has its own screen: GET and PATCH /v1/org/company keep a fixed code, a name, the
// business timezone and a controlled deactivation.
// Cities (CL-006; 0280) have their own screen: each belongs to a state of the state master and is kept like the masters above, one at a
// time or from a CSV file (CITY_MASTER_V1) through the shared import steps. The state, bank and qualification masters (CL-005, CL-010,
// CL-007) are company lists kept on the Reference values screen (STATE_IN, BANK, QUALIFICATION); the cities screen says so.
//
// The code is in ./org/: the four masters (masters), the company (company), the cities (cities) and their upload (city-upload),
// shared.tsx (duty keys, the master kinds, refusals and small shared pieces), and routes.ts. The organisation chart is its own
// module, ./org-chart. This entry module re-exports what other modules import from it.
export { CitiesPage, type City } from './org/cities';
export { type Company, CompanyPage } from './org/company';
export { DepartmentsPage, DesignationsPage, GradesPage, LocationsPage } from './org/masters';
export { ORG_SCREENS } from './org/routes';
export type { Master, MasterKind } from './org/shared';
