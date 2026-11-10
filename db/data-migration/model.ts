// Data migration toolkit: what an extract may hold and how its manifest describes it (BRD §9.4 DQ-01 to DQ-15, ZT19, OQ-19,
// DF08, DF09, DF18). An extract is a folder of CSV files saved from the old HR system's Excel exports plus manifest.json, which
// maps each file to an entity, each legacy column to a field, and legacy codes and status labels to this system's codes (the
// mapping tables are what make DQ-02, DQ-05 and DQ-07 checkable). See db/data-migration/README.md for the format.

export const DQ_IDS = ['DQ-01', 'DQ-02', 'DQ-03', 'DQ-04', 'DQ-05', 'DQ-06', 'DQ-07', 'DQ-08', 'DQ-09', 'DQ-10', 'DQ-11', 'DQ-12', 'DQ-13', 'DQ-14', 'DQ-15'] as const;
export type DqId = (typeof DQ_IDS)[number];

export const DQ_TITLES: Record<DqId, string> = {
  'DQ-01': 'Entity to screen',
  'DQ-02': 'Field meaning',
  'DQ-03': 'Mandatory consistency',
  'DQ-04': 'Type and format',
  'DQ-05': 'Reference data',
  'DQ-06': 'Relationships',
  'DQ-07': 'Status lifecycle',
  'DQ-08': 'Auditability',
  'DQ-09': 'Active archive deletion',
  'DQ-10': 'Duplicate prevention',
  'DQ-11': 'Calculation source',
  'DQ-12': 'Reporting reconciliation',
  'DQ-13': 'Historical preservation',
  'DQ-14': 'Role data visibility',
  'DQ-15': 'Integration categories',
};

export const MASTER_KINDS = ['department', 'location', 'designation', 'grade'] as const;
export type MasterKind = (typeof MASTER_KINDS)[number];
export const ENTITY_KINDS = [...MASTER_KINDS, 'employee', 'assignment_history', 'salary', 'leave_opening', 'loan'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export type FieldType = 'code' | 'text' | 'email' | 'date' | 'money' | 'units' | 'flag' | 'label' | 'identity' | 'employeeCode' | 'currency';
/** Coded values checked against a list (DQ-05); legacy values are translated through manifest.codeMaps[kind]. */
export const REF_KINDS = [...MASTER_KINDS, 'employmentType', 'leaveType', 'shift', 'loanKind', 'currency'] as const;
export type RefKind = (typeof REF_KINDS)[number];

export interface FieldSpec {
  type: FieldType;
  /** always; for an employee who will be active in the target (activation needs it); or for loans carried at their outstanding amount. */
  required?: 'always' | 'activeEmployee' | 'outstandingBasis';
  ref?: RefKind;
  maxLength?: number;
}

const master: Record<string, FieldSpec> = { code: { type: 'code', required: 'always' }, name: { type: 'text', required: 'always', maxLength: 200 }, active: { type: 'flag' } };

export const ENTITY_FIELDS: Record<EntityKind, Record<string, FieldSpec>> = {
  department: master,
  location: master,
  designation: master,
  grade: master,
  employee: {
    employeeCode: { type: 'employeeCode', required: 'always' },
    displayName: { type: 'text', required: 'always', maxLength: 200 },
    workEmail: { type: 'email', required: 'activeEmployee' },
    joiningDate: { type: 'date', required: 'always' },
    employmentType: { type: 'code', required: 'always', ref: 'employmentType' },
    status: { type: 'label', required: 'always' },
    departmentCode: { type: 'code', required: 'always', ref: 'department' },
    locationCode: { type: 'code', required: 'always', ref: 'location' },
    designationCode: { type: 'code', required: 'always', ref: 'designation' },
    gradeCode: { type: 'code', ref: 'grade' },
    managerEmployeeCode: { type: 'employeeCode' },
    managerFrom: { type: 'date' },
    shiftCode: { type: 'code', required: 'activeEmployee', ref: 'shift' },
    shiftFrom: { type: 'date' },
    // Used only to find one person under two codes (DQ-10); never loaded and never written to a report.
    identityNumber: { type: 'identity' },
  },
  assignment_history: {
    employeeCode: { type: 'employeeCode', required: 'always' },
    effectiveFrom: { type: 'date', required: 'always' },
    departmentCode: { type: 'code', required: 'always', ref: 'department' },
    locationCode: { type: 'code', required: 'always', ref: 'location' },
    designationCode: { type: 'code', required: 'always', ref: 'designation' },
    gradeCode: { type: 'code', ref: 'grade' },
  },
  salary: {
    employeeCode: { type: 'employeeCode', required: 'always' },
    effectiveFrom: { type: 'date', required: 'always' },
    annualCtc: { type: 'money', required: 'always' },
    monthlyGross: { type: 'money', required: 'always' },
    currency: { type: 'currency', required: 'always', ref: 'currency' },
  },
  leave_opening: {
    employeeCode: { type: 'employeeCode', required: 'always' },
    leaveType: { type: 'code', required: 'always', ref: 'leaveType' },
    units: { type: 'units', required: 'always' },
    // The cut-over date when not mapped.
    effectiveDate: { type: 'date' },
  },
  loan: {
    loanReference: { type: 'code', required: 'always' },
    employeeCode: { type: 'employeeCode', required: 'always' },
    loanKind: { type: 'code', required: 'always', ref: 'loanKind' },
    currency: { type: 'currency', required: 'always', ref: 'currency' },
    principal: { type: 'money', required: 'always' },
    outstanding: { type: 'money', required: 'outstandingBasis' },
    status: { type: 'label', required: 'always' },
    purpose: { type: 'text', required: 'always', maxLength: 900 },
    sanctionDate: { type: 'date' },
  },
};

/** Amount fields DQ-11 asks to classify as captured, derived or aggregated. */
export const AMOUNT_FIELDS: Partial<Record<EntityKind, readonly string[]>> = {
  salary: ['annualCtc', 'monthlyGross'],
  leave_opening: ['units'],
  loan: ['principal', 'outstanding'],
};

/** DQ-01: the business record, target screen and loading path of each entity. */
export const ENTITY_TARGET: Record<EntityKind, { record: string; screen: string; path: string }> = {
  department: { record: 'Department master', screen: 'Organisation masters (/org)', path: 'org master create (POST /v1/org/departments), created only when missing' },
  location: { record: 'Location master', screen: 'Organisation masters (/org)', path: 'org master create (POST /v1/org/locations), created only when missing' },
  designation: { record: 'Designation master', screen: 'Organisation masters (/org)', path: 'org master create (POST /v1/org/designations), created only when missing' },
  grade: { record: 'Grade master', screen: 'Organisation masters (/org)', path: 'org master create (POST /v1/org/grades), created only when missing' },
  employee: {
    record: 'Employee, joining assignment, shift, manager and status',
    screen: 'Employees (/employees) and the employee record',
    path: 'EMPLOYEE_ONBOARDING_V1, SHIFT_PLAN_V1, EMPLOYEE_UPDATE_V1 (managers), employee activation',
  },
  assignment_history: { record: 'Dated organisation placement (department, location, designation, grade)', screen: 'Employee record: employment history', path: 'EMPLOYEE_UPDATE_V1 (one dated change per round)' },
  salary: { record: 'Salary arrangement (annual CTC, monthly gross, currency, effective date)', screen: 'Salary master (/salary-master)', path: 'SALARY_MASTER_V1' },
  leave_opening: { record: 'Opening leave balance (ledger OPENING movement)', screen: 'Leave balances', path: 'LEAVE_OPENING_V1' },
  loan: { record: 'Loan or advance request', screen: 'Loans and advances (payroll outputs)', path: 'LOAN_REQUESTS_V1 (REQUESTED; decided independently in the system)' },
};

/** Target statuses of an employee (employee/status.ts catalogue) and of a loan (0046). */
export const EMPLOYEE_STATUSES = ['DRAFT', 'ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE', 'INACTIVE_SEPARATED', 'ARCHIVED'] as const;
export const EMPLOYEE_ACTIVE_STATUSES: readonly string[] = ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE'];
export const EMPLOYEE_ENDED_STATUSES: readonly string[] = ['INACTIVE_SEPARATED', 'ARCHIVED'];
export const LOAN_STATES = ['REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLED', 'DISBURSED', 'CLOSED'] as const;
/** Loans still owed or awaited; the others are settled or never happened and can only be excluded. */
export const LOAN_OPEN_STATES: readonly string[] = ['REQUESTED', 'APPROVED', 'DISBURSED'];
export const LOAN_KINDS: readonly string[] = ['LOAN', 'ADVANCE'];

/** Kinds of source rows that are deliberately not loaded; each needs an owner-approved declaration (DQ-09, ZT19). */
export const EXCLUSION_POLICIES = ['INACTIVE_EMPLOYEE', 'CLOSED_LOAN', 'INACTIVE_MASTER', 'SALARY_HISTORY', 'ZERO_LEAVE_BALANCE'] as const;
export type ExclusionPolicy = (typeof EXCLUSION_POLICIES)[number];

export interface Approval {
  reason: string;
  approvedBy: string;
  approvedOn: string;
}

export interface SignOff {
  reviewer: string;
  date: string;
  evidence?: string;
}

export interface FileMapping {
  file: string;
  entity: EntityKind;
  /** DQ-01 record owner (a role or a person). */
  owner?: string;
  /** Legacy column header -> field of the entity. */
  columns: Record<string, string>;
  /** Legacy columns deliberately not migrated (DQ-02: every column is either mapped or listed here). */
  ignoredColumns?: string[];
}

export interface ControlTotals {
  /** Data rows in the old system's own report of this entity. */
  rows?: number;
  /** Rows per legacy status label. */
  byStatus?: Record<string, number>;
  /** Employees per legacy department code. */
  byDepartment?: Record<string, number>;
  /** field -> currency (money) or legacy leave type (units) -> total as text. */
  amounts?: Record<string, Record<string, string>>;
}

export interface Disposition extends Approval {
  file: string;
  /** Spreadsheet line (the header is line 1). */
  line: number;
  action: 'EXCLUDE';
}

export interface Manifest {
  manifestVersion: 1;
  migrationId: string;
  sourceSystem: string;
  /** Target company code; the command line's --company must match when given. */
  company?: string;
  /** The date the old system stops; balances and the salary in force are taken as of this date. */
  cutoverDate: string;
  formats: { date: string; thousandsSeparator?: string; trueValues?: string[]; falseValues?: string[] };
  files: FileMapping[];
  ignoredFiles?: string[];
  codeMaps?: Partial<Record<RefKind, Record<string, string>>>;
  statusMaps?: { employee?: Record<string, string>; loan?: Record<string, string> };
  exclusionPolicies?: Partial<Record<ExclusionPolicy, Approval>>;
  policies?: { noManagerReason?: string; loanAmountBasis?: 'PRINCIPAL' | 'OUTSTANDING' };
  amountClassification?: Record<string, 'CAPTURED' | 'DERIVED' | 'AGGREGATED'>;
  controlTotals?: Partial<Record<EntityKind, ControlTotals>>;
  dispositions?: Disposition[];
  signOffs?: Partial<Record<DqId, SignOff>>;
}

export class ManifestError extends Error {
  constructor(readonly problems: string[]) {
    super(`The manifest is not usable:\n- ${problems.join('\n- ')}`);
  }
}

const MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TOP_KEYS = new Set([
  '$comment',
  'manifestVersion',
  'migrationId',
  'sourceSystem',
  'company',
  'cutoverDate',
  'formats',
  'files',
  'ignoredFiles',
  'codeMaps',
  'statusMaps',
  'exclusionPolicies',
  'policies',
  'amountClassification',
  'controlTotals',
  'dispositions',
  'signOffs',
]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringMap = (v: unknown) => isObject(v) && Object.values(v).every((x) => typeof x === 'string');

/**
 * Structural checks only (a manifest that cannot be read at all); what the mapping says about the data is checked by the DQ
 * checks (analyse.ts), so a mapping gap is reported with the other findings rather than stopping here.
 */
export function parseManifest(value: unknown): Manifest {
  const p: string[] = [];
  if (!isObject(value)) throw new ManifestError(['the manifest must be a JSON object']);
  for (const k of Object.keys(value)) if (!TOP_KEYS.has(k)) p.push(`unknown key "${k}"`);
  if (value.manifestVersion !== 1) p.push('manifestVersion must be 1');
  if (typeof value.migrationId !== 'string' || !MIGRATION_ID.test(value.migrationId)) p.push('migrationId: 1 to 60 letters, digits, "-" or "_", starting with a letter or digit');
  if (typeof value.sourceSystem !== 'string' || !value.sourceSystem.trim() || value.sourceSystem.length > 200) p.push('sourceSystem: the old system\'s name, up to 200 characters');
  if (value.company !== undefined && typeof value.company !== 'string') p.push('company must be a company code');
  if (typeof value.cutoverDate !== 'string' || !ISO_DATE.test(value.cutoverDate)) p.push('cutoverDate must be YYYY-MM-DD');
  const formats = value.formats;
  if (!isObject(formats) || typeof formats.date !== 'string' || !/(YYYY)/.test(formats.date)) p.push('formats.date must give the date pattern of the extract, e.g. "DD-MM-YYYY"');
  else {
    if (formats.thousandsSeparator !== undefined && ![',', ' ', '', "'"].includes(formats.thousandsSeparator as string)) p.push('formats.thousandsSeparator must be ",", " ", "\'" or ""');
    for (const k of ['trueValues', 'falseValues'] as const) {
      if (formats[k] !== undefined && !(Array.isArray(formats[k]) && (formats[k] as unknown[]).every((x) => typeof x === 'string'))) p.push(`formats.${k} must be a list of text values`);
    }
  }
  if (!Array.isArray(value.files) || value.files.length === 0) p.push('files must list at least one file');
  else {
    value.files.forEach((f, i) => {
      if (!isObject(f)) return p.push(`files[${i}] must be an object`);
      if (typeof f.file !== 'string' || !/\.csv$/i.test(f.file) || /[\\/]/.test(f.file)) p.push(`files[${i}].file must be a .csv file name in the extract folder`);
      if (!ENTITY_KINDS.includes(f.entity as EntityKind)) p.push(`files[${i}].entity must be one of ${ENTITY_KINDS.join(', ')}`);
      if (!isStringMap(f.columns)) p.push(`files[${i}].columns must map legacy column names to fields`);
      if (f.ignoredColumns !== undefined && !(Array.isArray(f.ignoredColumns) && f.ignoredColumns.every((c) => typeof c === 'string'))) p.push(`files[${i}].ignoredColumns must be a list of column names`);
      if (f.owner !== undefined && typeof f.owner !== 'string') p.push(`files[${i}].owner must be text`);
    });
  }
  if (value.codeMaps !== undefined) {
    if (!isObject(value.codeMaps)) p.push('codeMaps must be an object');
    else for (const [k, m] of Object.entries(value.codeMaps)) if (!REF_KINDS.includes(k as RefKind) || !isStringMap(m)) p.push(`codeMaps.${k}: a reference kind (${REF_KINDS.join(', ')}) mapping legacy codes to codes`);
  }
  if (value.statusMaps !== undefined) {
    if (!isObject(value.statusMaps)) p.push('statusMaps must be an object');
    else for (const [k, m] of Object.entries(value.statusMaps)) if (!['employee', 'loan'].includes(k) || !isStringMap(m)) p.push(`statusMaps.${k}: "employee" or "loan" mapping legacy labels to statuses`);
  }
  const approval = (a: unknown, where: string) => {
    if (!isObject(a) || typeof a.reason !== 'string' || typeof a.approvedBy !== 'string' || typeof a.approvedOn !== 'string') p.push(`${where} needs reason, approvedBy and approvedOn`);
  };
  if (value.exclusionPolicies !== undefined) {
    if (!isObject(value.exclusionPolicies)) p.push('exclusionPolicies must be an object');
    else for (const [k, a] of Object.entries(value.exclusionPolicies)) EXCLUSION_POLICIES.includes(k as ExclusionPolicy) ? approval(a, `exclusionPolicies.${k}`) : p.push(`exclusionPolicies.${k} is not one of ${EXCLUSION_POLICIES.join(', ')}`);
  }
  if (value.policies !== undefined) {
    const pol = value.policies;
    if (!isObject(pol)) p.push('policies must be an object');
    else {
      if (pol.noManagerReason !== undefined && (typeof pol.noManagerReason !== 'string' || !pol.noManagerReason.trim() || pol.noManagerReason.length > 500)) p.push('policies.noManagerReason: text up to 500 characters');
      for (const k of Object.keys(pol)) if (!['noManagerReason', 'loanAmountBasis'].includes(k)) p.push(`policies.${k} is not a policy (noManagerReason, loanAmountBasis)`);
      if (pol.loanAmountBasis !== undefined && !['PRINCIPAL', 'OUTSTANDING'].includes(pol.loanAmountBasis as string)) p.push('policies.loanAmountBasis is "PRINCIPAL" or "OUTSTANDING"');
    }
  }
  if (value.amountClassification !== undefined && !(isObject(value.amountClassification) && Object.values(value.amountClassification).every((c) => ['CAPTURED', 'DERIVED', 'AGGREGATED'].includes(c as string)))) {
    p.push('amountClassification maps "entity.field" to CAPTURED, DERIVED or AGGREGATED');
  }
  if (value.controlTotals !== undefined && !isObject(value.controlTotals)) p.push('controlTotals must be an object');
  if (value.dispositions !== undefined) {
    if (!Array.isArray(value.dispositions)) p.push('dispositions must be a list');
    else
      value.dispositions.forEach((d, i) => {
        if (!isObject(d) || typeof d.file !== 'string' || !Number.isInteger(d.line) || (d.line as number) < 2 || d.action !== 'EXCLUDE') p.push(`dispositions[${i}] needs file, line (2 or more) and action "EXCLUDE"`);
        else approval(d, `dispositions[${i}]`);
      });
  }
  if (value.signOffs !== undefined) {
    if (!isObject(value.signOffs)) p.push('signOffs must be an object');
    else
      for (const [k, s] of Object.entries(value.signOffs)) {
        if (!DQ_IDS.includes(k as DqId)) p.push(`signOffs.${k} is not a DQ check`);
        else if (!isObject(s) || typeof s.reviewer !== 'string' || typeof s.date !== 'string') p.push(`signOffs.${k} needs reviewer and date`);
      }
  }
  if (p.length > 0) throw new ManifestError(p);
  return value as unknown as Manifest;
}
