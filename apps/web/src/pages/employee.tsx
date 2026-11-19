// One employee (FR-006, FR-008; BR-001 to BR-004; DF04; DF08; I-55): create, edit, activation, the effective-dated manager,
// transfer and shift changes, and the record, which links to the one employee history for its status history (FR-089;
// employee-history.tsx). Every section is field-group aware: a group the server left out of its answer is not shown, not even
// as a blank, and a form is offered only with the duty its route checks.
//
// The page holds no rule of its own. The server validates every value and refuses in codes, which are said here in plain words
// beside what was typed. Master choices come from the server for the date typed (validOn); a choice a new date no longer offers
// stays chosen and marked, and the server decides on save. These routes take no idempotency key; the ones that take an expected
// version get the version on screen, and a date repeated on a dated change is refused (CHANGE_NOT_LATEST), so a retry cannot apply twice.
//
// Family, qualification, prior-employment and payroll-identifier sections are confidential (I-82 item 2): each is read and changed only under its own grant.
export { NewEmployeePage } from './employee/new-employee';
export { EmployeeRecordPage } from './employee/record-page';
export { EMPLOYEE_SCREENS } from './employee/routes';
export type { EmployeeRecord } from './employee/shared';
