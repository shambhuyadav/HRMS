// Batch imports (FR-009, FR-023, DF09, I-13, I-20): the published versioned templates this screen offers, their row problems in
// plain words, and the job view the server answers with.

/** What an update row would change, as its preview stored it (imports/batch.ts RowChanges): field -> { from, to }. */
export type RowChanges = Record<string, { from: string | null; to: string | null } | null>;

/** A published batch template as the preview screens show it; documents.tsx reuses the job view for DOCUMENT_MAPPING_V1. */
export interface ImportTemplate {
  code: string;
  label: string;
  /** Every duty the upload and the commit require together: the import duty, and the duty each row is applied under. */
  permissions: string[];
  /** Upload endpoint; the job lives at `${base}/:id` with /commit and /cancel. */
  base: string;
  columns: string;
  keyLabel: string;
  noun: [singular: string, plural: string];
  verb: string;
  note: string;
  /** An update import: the preview lists each row's proposed changes, fields in this order (any other follows). */
  changeFields?: string[];
  /** Row problems in plain words, by error code; any other code is shown as the server sent it. */
  problems?: Record<string, string>;
}

/** EMPLOYEE_UPDATE_V1 row problems: employee/update-import.ts, imports/batch.ts and the change paths a row goes through. */
const UPDATE_PROBLEMS: Record<string, string> = {
  UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code.',
  DUPLICATE_IN_BATCH: 'This employee is already on an earlier row; each employee may appear on one row only.',
  NO_CHANGE: 'Every cell is blank or matches the current value, so there is nothing to change.',
  // update-import.ts asks for the date whenever an organisation or manager cell is filled in, changed or not.
  EFFECTIVE_DATE_REQUIRED:
    'A row with a department, location, designation, grade or manager code needs effectiveFrom as a valid date (YYYY-MM-DD), even when the code matches the current value.',
  NOTHING_TO_DATE: 'effectiveFrom is filled in, but the row has no department, location, designation, grade or manager change to date; leave effectiveFrom blank.',
  UNKNOWN_DEPARTMENT: 'No active department has this code.',
  UNKNOWN_LOCATION: 'No active location has this code.',
  UNKNOWN_DESIGNATION: 'No active designation has this code.',
  UNKNOWN_GRADE: 'No active grade has this code.',
  UNKNOWN_MANAGER: 'No employee in this company has the manager employee code given.',
  SELF_MANAGER: 'An employee cannot be their own manager.',
  OUT_OF_SCOPE: 'The employee, or the department or location the row moves them to, is outside the scope of your role.',
  COLUMN_COUNT: 'The row does not have exactly one cell for each column of the header.',
  INVALID_DISPLAY_NAME: 'The display name is longer than 200 characters.',
  INVALID_WORK_EMAIL: 'The work email is not a valid address.',
  DUPLICATE: 'Another employee already has a value on this row that must be unique, such as the work email.',
  NO_CURRENT_ASSIGNMENT: 'The employee has no current assignment to change.',
  // changes.ts closeCurrentPeriod; no history-correction screen exists yet, so these words do not point to one.
  CHANGE_NOT_LATEST:
    'The employee’s organisation or manager history already has an entry starting on or after this effectiveFrom date; an import can only add a change after the latest one, so use a later effectiveFrom.',
  RULE_VIOLATION: 'The change breaks a rule: for example it takes effect before the joining date, or the manager is not an active employee.',
  INVALID_REFERENCE: 'A code on the row cannot be used: for example the manager is outside the scope of your role.',
};

/** The published versioned templates (DF09) and the duty each needs; the server checks both again. */
export const TEMPLATES: ImportTemplate[] = [
  {
    code: 'EMPLOYEE_ONBOARDING_V1',
    label: 'Employee onboarding',
    permissions: ['employee.import.operational', 'employee.create.operational'],
    base: '/v1/employees/imports',
    columns: 'employeeCode,displayName,workEmail,joiningDate,employmentType,departmentCode,locationCode,designationCode,gradeCode',
    keyLabel: 'Employee code',
    noun: ['employee', 'employees'],
    verb: 'Create',
    note: 'Personal fields are not imported.',
  },
  {
    // FR-009 update import (I-20): rows apply under the caller's update grant, so its scope and filters hold per row.
    code: 'EMPLOYEE_UPDATE_V1',
    label: 'Employee update',
    permissions: ['employee.import.operational', 'employee.update.operational'],
    base: '/v1/employees/update-imports',
    columns: 'employeeCode,displayName,workEmail,effectiveFrom,departmentCode,locationCode,designationCode,gradeCode,managerEmployeeCode',
    keyLabel: 'Employee code',
    noun: ['employee', 'employees'],
    verb: 'Update',
    note:
      'A blank cell means no change. Organisation changes (department, location, designation, grade) and manager changes need effectiveFrom, the date they take effect (YYYY-MM-DD); leave it and the organisation and manager cells blank on a row that changes only the display name or work email. One row per employee; a manager cannot be removed by import, and personal fields are not imported.',
    changeFields: ['displayName', 'workEmail', 'department', 'location', 'designation', 'grade', 'manager', 'effectiveFrom'],
    problems: UPDATE_PROBLEMS,
  },
  {
    code: 'SHIFT_PLAN_V1',
    label: 'Shift plan',
    permissions: ['shift.import.operational', 'shift.assign.operational'],
    base: '/v1/shifts/plan-imports',
    columns: 'employeeCode,shiftCode,effectiveFrom',
    keyLabel: 'Employee @ effective from',
    noun: ['shift assignment', 'shift assignments'],
    verb: 'Apply',
    note: 'Each row changes the employee’s shift from its effective date; earlier assignments stay in the history.',
    problems: {
      AFTER_LAST_WORKING_DATE: 'The shift would start after the employee’s approved last working date.',
      EMPLOYMENT_ENDED: 'The employment has ended, so no shift can be assigned.',
      BEFORE_JOINING: 'The shift would start before the joining date.',
    },
  },
  {
    // FR-025: every row goes through the single opening-balance route's rules, under the caller's row scope.
    code: 'LEAVE_OPENING_V1',
    label: 'Opening leave balances',
    permissions: ['leave.import.operational', 'leave.adjust.operational'],
    base: '/v1/leave/opening-imports',
    columns: 'employeeCode,leaveType,units,effectiveDate,reason',
    keyLabel: 'Employee @ leave type',
    noun: ['opening balance', 'opening balances'],
    verb: 'Record',
    note: 'One row per employee and leave type. An employee already holding an opening balance of that type rejects the batch, so a batch cannot be applied twice; use an adjustment instead. Your name and the reason stay on each balance.',
    problems: {
      OPENING_EXISTS: 'This employee already has an opening balance of this leave type. Use an adjustment instead.',
      DUPLICATE_IN_BATCH: 'The file already has a row for this employee and leave type.',
      UNKNOWN_LEAVE_TYPE: 'There is no leave type with this code.',
      INVALID_UNITS: 'Units must be a positive number with at most 4 decimals.',
      INVALID_REASON: 'A reason of at most 500 characters is required.',
      OUT_OF_SCOPE: 'This employee is outside your role’s scope, or it is your own balance, which another administrator must record.',
    },
  },
  {
    // FR-031, FR-028 (I-91): payroll inputs of any active period, naming a pay component or an outside deduction code; one input batch
    // per period, submitted and approved as before. The one-period upload (PAYROLL_INPUTS_V1) stays on the payroll inputs screen.
    code: 'PAYROLL_INPUTS_V2',
    label: 'Payroll inputs',
    permissions: ['payroll_input.read.amount', 'payroll_input.prepare.amount'],
    base: '/v1/payroll/input-imports',
    columns: 'period_code,employee_code,component_code,external_code,input_kind,amount,currency_code,effective_date,reference',
    keyLabel: 'Employee / reference',
    noun: ['input', 'inputs'],
    verb: 'Record',
    note: 'Each row names its payroll period by code and either a pay component or an outside deduction code (never both). The inputs of each period become one batch in draft, which you submit for approval as usual. One row with a problem rejects the whole file.',
    problems: {
      COMPONENT_OR_EXTERNAL_CODE: 'Give either a component code or an external deduction code, not both and not neither.',
      EXTERNAL_CODE_UNKNOWN: 'No external deduction mapping has this code.',
      EXTERNAL_CODE_UNMAPPED: 'This external code has no mapping in force on the effective date.',
      EXTERNAL_CODE_RETIRED: 'The mapping of this external code was retired; ask payroll configuration to map it again.',
      UNKNOWN_PERIOD: 'No period of an active payroll calendar has this code.',
      PERIOD_AMBIGUOUS: 'More than one active payroll calendar has a period with this code.',
      INPUT_CUTOFF_PASSED: 'The input cutoff of this period has passed; enter the input for a later period.',
      INPUT_HEAD_INVALID: 'The component has no input head in effect.',
      DUPLICATE_REFERENCE: 'This reference is already used in the period, or earlier in the file.',
      UNKNOWN_EMPLOYEE: 'No employee in your scope has this employee code.',
      DATE_OUTSIDE_PERIOD: 'The effective date is outside the period.',
      CURRENCY_MISMATCH: 'The currency is not the payroll calendar’s.',
    },
  },
];

export interface ImportRow {
  rowNumber: number;
  businessKey: string;
  state: string;
  errorCode: string | null;
  /** An update import's preview: what the row would change (operational values only). */
  proposedChanges?: RowChanges | null;
}

export interface ImportJob {
  id: string;
  state: string;
  template?: string;
  fileName: string | null;
  rowCount: number | null;
  acceptedCount: number;
  rejectedCount: number;
  rows: ImportRow[];
}
