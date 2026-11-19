// Increments and salary (FR-029 base, FR-089-FR-092; BR-038-BR-041; DF14; DF15; DF02; C1).
// HR opens a cycle review for a year: the opening is queued as a bulk job (NFR-S09), and the server then creates one
// draft case per eligible employee in the background and records every other employee of the cycle with a reason.
// This screen follows the queued job's live status and, once it completes, lists the cases it created and the
// employees it excluded with each reason's repair path, a page at a time (operational fields only, never an amount).
// The employee's current direct manager proposes an outcome against the case
// version, HR proposes off-cycle changes, and an independent Admin decides every case in the Decision inbox (/tasks),
// never here.
// Salary and increment amounts are confidential (salary field group, BR-044): the server omits them without the grant,
// and this screen shows amount columns only when a response carries them. Money travels as the decimal strings typed
// or returned (only their format is checked); nothing here adds, rounds or derives an amount, and annual CTC is never
// worked out from monthly gross (DF05). Percentages come from the server (DF14) and are never summed (BR-039).
export { IncrementsPage } from './increments/page';
