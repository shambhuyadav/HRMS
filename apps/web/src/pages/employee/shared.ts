// Shared parts of the employee screens: permission keys, words, the record and section shapes and the query keys.

export const EMPLOYEE_LIST = 'employee.list.operational';
export const EMPLOYEE_READ = 'employee.read.operational';
export const EMPLOYEE_CREATE = 'employee.create.operational';
export const EMPLOYEE_CREATE_PERSONAL = 'employee.create.personal';
export const EMPLOYEE_UPDATE = 'employee.update.operational';
export const EMPLOYEE_UPDATE_PERSONAL = 'employee.update.personal';
export const EMPLOYEE_ACTIVATE = 'employee.activate.operational';
export const EMPLOYEE_DEACTIVATE = 'employee.deactivate.operational';
export const EMPLOYEE_HISTORY = 'employee.read_history.operational';
export const EMPLOYEE_PRIVATE = 'employee.read.private';
export const EMPLOYEE_BANK = 'employee.read.bank';
export const EMPLOYEE_PAYROLL_ID = 'employee.read.payroll_id';
export const EMPLOYEE_MANAGE_PRIVATE = 'employee.manage.private';
export const EMPLOYEE_MANAGE_PAYROLL_ID = 'employee.manage.payroll_id';
export const SHIFT_READ = 'shift.read.operational';
export const SHIFT_ASSIGN = 'shift.assign.operational';

export const enc = encodeURIComponent;
export const words = (code: string) => code.replace(/_/g, ' ').toLowerCase();
/** A private field's key in words: personalEmail reads "Personal email". */
export const fieldWords = (key: string) => {
  const spaced = key.replace(/([a-z])([A-Z0-9])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** The types POST /v1/employees accepts (its schema's enum). */
export const EMPLOYMENT_TYPES = [
  { code: 'PERMANENT', label: 'Permanent' },
  { code: 'FIXED_TERM', label: 'Fixed term' },
  { code: 'INTERN', label: 'Intern' },
  { code: 'CONTRACTOR', label: 'Contractor' },
] as const;
export const employmentTypeLabel = (code: string) => EMPLOYMENT_TYPES.find((t) => t.code === code)?.label ?? words(code);

/**
 * GET /v1/employees/:id. A key the role's assignment does not reach is absent: the personal fields without the personal group,
 * the grade's words without the grade master's read duty, and the no-manager reason without the history duty.
 */
export interface EmployeeRecord {
  id: string;
  employeeCode: string;
  displayName: string;
  workEmail: string | null;
  /** DF16 work phone extension (I-89 item 5): digits only; absent from an older answer. */
  workPhoneExtension?: string | null;
  joiningDate: string;
  confirmationDate: string | null;
  employmentType: string;
  status: string;
  assignment: {
    departmentId: string;
    departmentName: string;
    locationId: string;
    locationName: string;
    designationId: string;
    designationName: string;
    gradeId: string | null;
    gradeCode?: string | null;
    gradeName?: string | null;
  } | null;
  manager: { id: string; employeeCode: string; displayName: string } | null;
  shift?: { id: string; code: string; name: string } | null;
  noManagerReason?: string | null;
  version: number;
  dateOfBirth?: string | null;
  serviceAnniversaryDate?: string | null;
}

export interface MasterOption {
  id: string;
  code: string;
  name: string;
}

export interface ShiftOption {
  id: string;
  code: string;
  name: string;
  inTime: string;
  outTime: string;
  active: boolean;
}

/** The part of GET /v1/employees/:id/history the employee history screen does not carry. */
export interface EmploymentHistory {
  leavingDate: string | null;
  priorEmployment: { employeeId: string; employeeCode: string | null } | null;
  nextEmployment: { employeeId: string; employeeCode: string | null } | null;
  shifts: { effectiveFrom: string; effectiveTo: string | null; shiftCode: string; shiftName: string }[];
}

export interface PrivateCategory {
  revision: number;
  effectiveFrom: string | null;
  values: Record<string, string | null> | null;
  masked?: boolean;
}
/** GET /v1/employees/:id/private-profile: only the categories the grant reaches. */
export interface PrivateProfile {
  personal?: PrivateCategory;
  address?: PrivateCategory;
  bank?: PrivateCategory;
}

export type ListSectionKey = 'family-members' | 'qualifications' | 'prior-employments';

/**
 * One entry of a list section: its keeping (DF08: an entry recorded in error is removed with a reason and stays on record, read
 * only) and its fields, by the names LIST_SECTIONS gives.
 */
export interface SectionEntry {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  removedAt: string | null;
  removalReason: string | null;
  [field: string]: string | number | boolean | null;
}

export interface PayrollIdentifiers {
  values: { pan: string | null; uan: string | null; esicIpNumber: string | null };
  /** Without employee.read.payroll_id each value is masked to its last four characters. */
  masked: boolean;
  /** The version to name on a change; null while nothing is recorded. */
  version: number | null;
}

/** GET /v1/employees/:id/record-sections: only the parts the grant reads. A part it does not reach is absent. */
export type RecordSectionsAnswer = { employeeId: string; 'payroll-identifiers'?: PayrollIdentifiers } & Partial<Record<ListSectionKey, SectionEntry[]>>;

export const keys = {
  record: (id: string) => ['employee-record', id],
  history: (id: string) => ['employee-history', id],
  privateProfile: (id: string) => ['employee-private-profile', id],
  recordSections: (id: string) => ['employee-record-sections', id],
};
