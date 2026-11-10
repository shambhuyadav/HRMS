// The DQ checks (BRD §9.4 DQ-01 to DQ-15) over an extract, and the load plan they leave behind. Pure: it reads the files and,
// when given, what the target company already holds (target.ts, read in a read-only transaction), and writes nothing.
// Every finding names the file, the spreadsheet line and the row's business key (employee code, master code, loan reference),
// never a personal value (CI16: "staging/error evidence must avoid real personal values in shared reports").
import { CsvError, parseCsv } from '../../apps/api/src/modules/employee/csv.js';
import { BASELINE_LEAVE_TYPES, BASELINE_REFERENCE_VALUES } from '../../apps/api/src/modules/access/baseline.js';
import {
  AMOUNT_FIELDS,
  type Approval,
  DQ_IDS,
  DQ_TITLES,
  type DqId,
  EMPLOYEE_ACTIVE_STATUSES,
  EMPLOYEE_ENDED_STATUSES,
  EMPLOYEE_STATUSES,
  ENTITY_FIELDS,
  ENTITY_TARGET,
  type EntityKind,
  type ExclusionPolicy,
  LOAN_KINDS,
  LOAN_OPEN_STATES,
  LOAN_STATES,
  type Manifest,
  MASTER_KINDS,
  type MasterKind,
  type RefKind,
  type SignOff,
} from './model.js';
import type { TargetFacts } from './target.js';
import { dateParser, EMAIL, EMPLOYEE_CODE, formatScaled, isoMinorUnit, LOAN_REFERENCE, normaliseIdentity, parseDecimal, parseFlag, sha256, TARGET_CODE } from './values.js';

export interface ExtractInput {
  manifest: Manifest;
  /** Every .csv file of the extract folder: name -> bytes. */
  files: Map<string, Buffer>;
}

export interface SourceRef {
  file: string;
  /** Spreadsheet line: the header is line 1, the first data row line 2. */
  line: number;
}

export interface Finding {
  check: DqId;
  /** FAIL blocks the load; UNVERIFIED needs the target (validate again with --company) or a person. */
  severity: 'FAIL' | 'UNVERIFIED';
  file?: string;
  line?: number;
  key?: string;
  field?: string;
  reason: string;
}

export type CheckStatus = 'PASS' | 'FAIL' | 'MANUAL';

export interface CheckResult {
  id: DqId;
  title: string;
  status: CheckStatus;
  /** What the toolkit checked by itself. */
  automated: string[];
  /** What a named person still confirms (MANUAL checks). */
  checklist: string[];
  findings: Finding[];
  signOff: SignOff | null;
}

export interface Exclusion {
  ref: SourceRef;
  entity: EntityKind;
  key: string;
  policy: ExclusionPolicy | 'DISPOSITION';
  reason: string;
  approvedBy: string | null;
  approvedOn: string | null;
}

export interface Placement {
  departmentCode: string;
  locationCode: string;
  designationCode: string;
  gradeCode: string;
}

export interface PlannedEmployee {
  ref: SourceRef;
  code: string;
  displayName: string;
  workEmail: string;
  joiningDate: string;
  employmentType: string;
  sourceStatus: string;
  targetStatus: string;
  /** Activated in the target (any active status); DRAFT employees stay drafts. */
  activate: boolean;
  /** Placement at joining (EMPLOYEE_ONBOARDING_V1). */
  joining: Placement;
  /** Later dated placements (EMPLOYEE_UPDATE_V1 rounds), oldest first. */
  changes: (Placement & { effectiveFrom: string; ref: SourceRef })[];
  managerCode: string | null;
  managerFrom: string | null;
  shiftCode: string | null;
  shiftFrom: string | null;
  /** Steps from the top of the reporting chain (0: no manager). */
  depth: number;
}

export interface PlannedSalary {
  ref: SourceRef;
  employeeCode: string;
  effectiveFrom: string;
  annualCtc: string;
  monthlyGross: string;
  currency: string;
}

export interface PlannedLeave {
  ref: SourceRef;
  employeeCode: string;
  leaveType: string;
  sourceType: string;
  units: string;
  effectiveDate: string;
}

export interface PlannedLoan {
  ref: SourceRef;
  loanReference: string;
  employeeCode: string;
  loanKind: string;
  currency: string;
  /** What is loaded: the principal or the outstanding amount (policies.loanAmountBasis). */
  amount: string;
  principal: string;
  outstanding: string | null;
  sourceStatus: string;
  targetStatus: string;
  purpose: string;
}

export interface Plan {
  masters: Record<MasterKind, { ref: SourceRef; code: string; name: string }[]>;
  employees: PlannedEmployee[];
  salaries: PlannedSalary[];
  leaveOpenings: PlannedLeave[];
  loans: PlannedLoan[];
}

export interface SourceFile {
  file: string;
  entity: EntityKind;
  sha256: string;
  rows: number;
}

export interface Analysis {
  migrationId: string;
  sourceSystem: string;
  cutoverDate: string;
  manifestSha256: string;
  /** Null when validated without the target company. */
  target: { companyCode: string } | null;
  sources: SourceFile[];
  checks: CheckResult[];
  failed: boolean;
  exclusions: Exclusion[];
  plan: Plan;
  /** The extract's own totals (DQ-11), whatever the manifest recorded. */
  totals: Partial<Record<EntityKind, { rows: number; byStatus?: Record<string, number>; byDepartment?: Record<string, number>; amounts?: Record<string, Record<string, string>> }>>;
}

const AUTOMATED: Record<DqId, string[]> = {
  'DQ-01': ['every extract file is declared with its entity, target screen and loading path', 'every declared file names its record owner'],
  'DQ-02': [
    'every declared file is present and every .csv file of the folder is declared or listed as ignored',
    'every legacy column is mapped to a field of its entity or listed as deliberately ignored; no field is mapped twice',
    'every field the loading path needs is mapped',
  ],
  'DQ-03': ['required values are present in every row (work email and shift for employees who will be active, as activation needs them)'],
  'DQ-04': [
    'files are UTF-8 CSV with the header\'s number of cells in every row',
    'dates match the declared pattern and are real calendar dates',
    'amounts are exact decimals with no more decimals than the currency allows; leave units have at most 4 decimals and are not negative',
    'codes, employee codes, work emails, flags and text lengths have the formats the import templates accept',
  ],
  'DQ-05': ['every coded value (masters, employment type, leave type, shift, loan kind, currency) exists in the extract\'s masters or the target company, directly or through manifest.codeMaps', 'a referenced master is active'],
  'DQ-06': ['managers exist in the employee file, are loaded and active, are not the employee, and form no cycle', 'salary, leave, loan and history rows name an employee of the employee file', 'top-of-chain active employees have the declared no-manager reason'],
  'DQ-07': ['every legacy employee and loan status label maps to a status of this system (manifest.statusMaps)', 'active statuses agree with the joining date; open loans have something outstanding'],
  'DQ-08': ['each load stage is recorded as an import batch (submitter, file checksum, row outcomes) and as a data_migration audit event naming the operator'],
  'DQ-09': ['every kind of row that is not loaded (separated employees, closed loans, inactive masters, earlier salary revisions, zero leave balances) has an owner-approved exclusion policy', 'every row disposition names an existing line and its approver'],
  'DQ-10': ['employee codes are unique in the extract and new to the target; work emails and identity numbers are unique among loaded employees and in the target', 'master codes, loan references, salary dates and leave types per employee are not repeated'],
  'DQ-11': ['the extract\'s row counts and totals equal the control totals recorded from the old system', 'every amount field is classified as captured, derived or aggregated', 'the loan amount basis is declared'],
  'DQ-12': ['reconcile compares the salary master report and headcounts with the loaded records (run after load)'],
  'DQ-13': ['assignment, salary, manager, shift, leave and loan dates are on or after joining, ordered and not repeated', 'the assignment history starts at joining and ends at the employee file\'s placement'],
  'DQ-14': ['the migration creates no role assignments or grants: loaded records are visible only through the target\'s existing access rules'],
  'DQ-15': ['the exchange is one-way and file based: the data categories, their owners and their outcomes are listed in this report'],
};

const CHECKLIST: Partial<Record<DqId, string[]>> = {
  'DQ-01': ['Each target screen listed shows the loaded records the way the old system\'s matching screen did, and the named owner accepts it'],
  'DQ-08': ['The old system\'s change history (who changed what and when) is exported and archived outside this system', 'The owner accepts that history in this system starts with the migration batches'],
  'DQ-12': ['The old system\'s reports for the cut-over date (headcount, salary register, leave balances, loan register) were compared with this system\'s reports'],
  'DQ-14': ['A walkthrough per role (HR, manager, employee, payroll) shows only the records and fields that role is approved to see'],
  'DQ-15': ['The owner confirms no other data category is exchanged with the old system and that its remaining interfaces are switched off at cut-over'],
};

const MANUAL_CHECKS: readonly DqId[] = ['DQ-01', 'DQ-08', 'DQ-12', 'DQ-14', 'DQ-15'];

const BASELINE_EMPLOYMENT_TYPES = new Set(Object.keys(BASELINE_REFERENCE_VALUES.EMPLOYMENT_TYPE ?? {}));
const BASELINE_LEAVE = new Set(BASELINE_LEAVE_TYPES.map((t) => t.code));
const REFERENCE_CODE = /^[A-Z0-9][A-Z0-9_]{0,59}$/;

interface Row {
  ref: SourceRef;
  entity: EntityKind;
  v: Record<string, string>;
}

const lookup = (map: Record<string, string> | undefined, raw: string): string | undefined => {
  if (!map) return undefined;
  if (raw in map) return map[raw];
  const k = Object.keys(map).find((x) => x.trim().toUpperCase() === raw.trim().toUpperCase());
  return k === undefined ? undefined : map[k];
};

const isApproved = (a: Approval | undefined): a is Approval => !!a && !!a.reason?.trim() && !!a.approvedBy?.trim() && /^\d{4}-\d{2}-\d{2}$/.test(a.approvedOn ?? '');

export function analyse(input: ExtractInput, target: TargetFacts | null = null): Analysis {
  const m = input.manifest;
  const findings: Finding[] = [];
  const add = (check: DqId, reason: string, at: { ref?: SourceRef; key?: string; field?: string; severity?: 'FAIL' | 'UNVERIFIED'; file?: string } = {}) => {
    const f: Finding = { check, severity: at.severity ?? 'FAIL', reason };
    const file = at.ref?.file ?? at.file;
    if (file !== undefined) f.file = file;
    if (at.ref) f.line = at.ref.line;
    if (at.key) f.key = at.key;
    if (at.field) f.field = at.field;
    findings.push(f);
  };
  const parseDate = dateParser(m.formats.date);
  const sep = m.formats.thousandsSeparator ?? '';
  const exclusions: Exclusion[] = [];
  const exclude = (ref: SourceRef, entity: EntityKind, key: string, policy: ExclusionPolicy, reason: string) => {
    const a = m.exclusionPolicies?.[policy];
    exclusions.push({ ref, entity, key, policy, reason: a?.reason?.trim() ? `${reason}: ${a.reason.trim()}` : reason, approvedBy: a?.approvedBy?.trim() || null, approvedOn: a?.approvedOn?.trim() || null });
  };

  // ---------------------------------------------------------------------------------------------- files, headers (DQ-01, DQ-02, DQ-04)
  const rows: Row[] = [];
  const sources: SourceFile[] = [];
  const declared = new Set<string>();
  const mappedFields = new Map<EntityKind, Set<string>>();
  const presentEntities = new Set<EntityKind>();
  for (const fm of m.files) {
    if (declared.has(fm.file)) add('DQ-02', `${fm.file} is declared twice`, { file: fm.file });
    declared.add(fm.file);
    if (!fm.owner?.trim()) add('DQ-01', `${fm.file} names no record owner`, { file: fm.file });
    const fields = ENTITY_FIELDS[fm.entity];
    const fieldSet = mappedFields.get(fm.entity) ?? new Set<string>();
    mappedFields.set(fm.entity, fieldSet);
    const byField = new Map<string, string>();
    for (const [column, field] of Object.entries(fm.columns)) {
      if (!(field in fields)) add('DQ-02', `column "${column}" maps to "${field}", which is not a field of ${fm.entity} (${Object.keys(fields).join(', ')})`, { file: fm.file, field });
      else if (byField.has(field)) add('DQ-02', `columns "${byField.get(field)}" and "${column}" both map to ${field}`, { file: fm.file, field });
      else byField.set(field, column);
      fieldSet.add(field);
    }
    for (const [field, spec] of Object.entries(fields)) {
      const needed = spec.required === 'always' || spec.required === 'activeEmployee' || (spec.required === 'outstandingBasis' && m.policies?.loanAmountBasis === 'OUTSTANDING');
      if (needed && !byField.has(field)) add('DQ-02', `no column is mapped to ${field}, which the loading path needs`, { file: fm.file, field });
    }
    const bytes = input.files.get(fm.file);
    if (!bytes) {
      add('DQ-02', `${fm.file} is declared but not in the extract folder`, { file: fm.file });
      continue;
    }
    presentEntities.add(fm.entity);
    let table: string[][];
    try {
      table = parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (err) {
      if (err instanceof CsvError) add('DQ-04', `${fm.file} is not valid CSV (${err.message})`, { file: fm.file });
      else add('DQ-04', `${fm.file} is not UTF-8 text: save it from Excel as "CSV UTF-8"`, { file: fm.file });
      sources.push({ file: fm.file, entity: fm.entity, sha256: sha256(bytes), rows: 0 });
      continue;
    }
    const [header = [], ...data] = table;
    const names = header.map((h) => h.trim());
    sources.push({ file: fm.file, entity: fm.entity, sha256: sha256(bytes), rows: data.length });
    const ignored = new Set((fm.ignoredColumns ?? []).map((c) => c.trim()));
    names.forEach((n, i) => {
      if (names.indexOf(n) !== i) add('DQ-02', `column "${n}" appears more than once`, { file: fm.file });
      if (!(n in fm.columns) && !ignored.has(n)) add('DQ-02', `column "${n}" is neither mapped nor listed in ignoredColumns`, { file: fm.file });
    });
    for (const column of Object.keys(fm.columns)) if (!names.includes(column)) add('DQ-02', `mapped column "${column}" is not in the file`, { file: fm.file });
    data.forEach((cells, i) => {
      const ref = { file: fm.file, line: i + 2 };
      if (cells.length !== names.length) add('DQ-04', `the row has ${cells.length} cells where the header has ${names.length}`, { ref });
      const v: Record<string, string> = {};
      for (const [column, field] of Object.entries(fm.columns)) {
        const at = names.indexOf(column);
        if (at >= 0) v[field] = (cells[at] ?? '').trim();
      }
      rows.push({ ref, entity: fm.entity, v });
    });
  }
  for (const name of input.files.keys()) {
    if (!declared.has(name) && !(m.ignoredFiles ?? []).includes(name)) add('DQ-02', `${name} is in the extract folder but neither declared in files nor listed in ignoredFiles`, { file: name });
  }

  // Owner-approved row dispositions (ZT19): the row is set aside before any other check, with its approval on record.
  const disposed = new Set<string>();
  for (const d of m.dispositions ?? []) {
    const row = rows.find((r) => r.ref.file === d.file && r.ref.line === d.line);
    if (!row) {
      add('DQ-09', `a disposition names line ${d.line} of ${d.file}, which is not a data row of the extract`, { file: d.file });
      continue;
    }
    if (!isApproved(d)) add('DQ-09', 'the disposition needs a reason, approvedBy and approvedOn (YYYY-MM-DD)', { ref: row.ref, key: keyOf(row) });
    disposed.add(`${d.file}:${d.line}`);
    exclusions.push({ ref: row.ref, entity: row.entity, key: keyOf(row), policy: 'DISPOSITION', reason: d.reason, approvedBy: d.approvedBy?.trim() || null, approvedOn: d.approvedOn?.trim() || null });
  }
  const live = (entity: EntityKind) => rows.filter((r) => r.entity === entity && !disposed.has(`${r.ref.file}:${r.ref.line}`));

  // ---------------------------------------------------------------------------------------------- value helpers (DQ-03, DQ-04, DQ-05)
  const required = (r: Row, field: string, key: string) => {
    if (!(field in r.v)) return false; // not mapped: reported once under DQ-02
    if (r.v[field] === '') {
      add('DQ-03', `${field} is required`, { ref: r.ref, key, field });
      return false;
    }
    return true;
  };
  const date = (r: Row, field: string, key: string): string | null => {
    const raw = r.v[field] ?? '';
    if (raw === '') return null;
    const iso = parseDate(raw);
    if (!iso) add('DQ-04', `${field} is not a date in the declared pattern ${m.formats.date}`, { ref: r.ref, key, field });
    return iso;
  };
  const textOk = (r: Row, field: string, key: string, max: number) => {
    const v = r.v[field] ?? '';
    if (v.length > max) add('DQ-04', `${field} is longer than ${max} characters`, { ref: r.ref, key, field });
  };
  const minorUnitOf = (currency: string): number | null => target?.currencies.get(currency) ?? isoMinorUnit(currency);
  const money = (r: Row, field: string, key: string, currency: string | null, opts: { positive: boolean }): string | null => {
    const raw = r.v[field] ?? '';
    if (raw === '') return null;
    const d = parseDecimal(raw, sep);
    if (!d || d.decimals > 4) {
      add('DQ-04', `${field} is not an amount`, { ref: r.ref, key, field });
      return null;
    }
    if (d.negative || (opts.positive && d.scaled === 0n)) {
      add('DQ-04', `${field} must be ${opts.positive ? 'more than zero' : 'zero or more'}`, { ref: r.ref, key, field });
      return null;
    }
    const minor = currency ? minorUnitOf(currency) : null;
    if (minor !== null && d.decimals > minor) add('DQ-04', `${field} has ${d.decimals} decimals; ${currency} allows ${minor}`, { ref: r.ref, key, field });
    if (d.text.replace(/\..*$/, '').length > 15) add('DQ-04', `${field} is too large`, { ref: r.ref, key, field });
    return d.text;
  };

  /** A legacy code translated through codeMaps (or taken as it is), then checked against what exists (DQ-05). */
  const masterIndex = {} as Record<MasterKind, Map<string, { active: boolean; name: string; ref: SourceRef }>>;
  const ref = (kind: RefKind, r: Row, field: string, key: string): string | null => {
    const raw = r.v[field] ?? '';
    if (raw === '') return null;
    const mapped = lookup(m.codeMaps?.[kind], raw);
    const code = (mapped ?? raw).trim().toUpperCase();
    const where = { ref: r.ref, key, field };
    const unknown = () => add('DQ-05', `${field} "${raw}" is not a known ${kind}${mapped === undefined ? ' and has no entry in codeMaps.' + kind : ` (mapped to ${code})`}`, where);
    const unverified = (what: string) => add('DQ-05', `${field} "${code}" ${what}: validate again with the target company`, { ...where, severity: 'UNVERIFIED' });
    if ((MASTER_KINDS as readonly string[]).includes(kind)) {
      const k = kind as MasterKind;
      if (!TARGET_CODE.test(code)) {
        add('DQ-04', `${field} "${code}" is not a valid code (letters, digits, "-" or "_", up to 40)`, where);
        return null;
      }
      const inExtract = masterIndex[k]?.get(code);
      const inTarget = target?.masters[k].get(code);
      if (inTarget) {
        if (!inTarget.active) add('DQ-05', `${k} ${code} exists in the target company but is inactive`, where);
      } else if (inExtract) {
        if (!inExtract.active) add('DQ-05', `${k} ${code} is inactive in the extract's ${k} file, so it is not created`, where);
      } else if (target) unknown();
      else unverified(`is not in the extract's ${k} file`);
      return code;
    }
    switch (kind) {
      case 'employmentType':
        if (!REFERENCE_CODE.test(code) || !(target ? target.employmentTypes : BASELINE_EMPLOYMENT_TYPES).has(code)) unknown();
        break;
      case 'leaveType':
        if (target ? !target.leaveTypes.has(code) : !BASELINE_LEAVE.has(code)) target || !REFERENCE_CODE.test(code) ? unknown() : unverified('is not a baseline leave type');
        break;
      case 'shift':
        if (!TARGET_CODE.test(code)) unknown();
        else if (!target) unverified('cannot be checked without the target company (shifts are not in the extract)');
        else if (!target.shifts.has(code)) unknown();
        break;
      case 'loanKind':
        if (!LOAN_KINDS.includes(code)) unknown();
        break;
      case 'currency':
        if (isoMinorUnit(code) === null && !target?.currencies.has(code)) unknown();
        else if (target && !target.currencies.has(code)) add('DQ-05', `currency ${code} is not in the target's currency reference`, where);
        else if (!target && code !== 'INR') unverified('is not checked against the target\'s currency reference');
        break;
    }
    return code;
  };

  // ---------------------------------------------------------------------------------------------- masters
  const plan: Plan = { masters: { department: [], location: [], designation: [], grade: [] }, employees: [], salaries: [], leaveOpenings: [], loans: [] };
  for (const kind of MASTER_KINDS) {
    masterIndex[kind] = new Map();
    for (const r of live(kind)) {
      const key = r.v.code ?? '';
      const ok = required(r, 'code', key) && required(r, 'name', key);
      textOk(r, 'name', key, 200);
      let active = true;
      if ((r.v.active ?? '') !== '') {
        const flag = parseFlag(r.v.active!, m.formats.trueValues, m.formats.falseValues);
        if (flag === null) add('DQ-04', `active "${r.v.active}" is not a declared true or false value`, { ref: r.ref, key, field: 'active' });
        else active = flag;
      }
      if (!ok) continue;
      const code = (lookup(m.codeMaps?.[kind], key) ?? key).trim().toUpperCase();
      if (!TARGET_CODE.test(code)) {
        add('DQ-04', `code "${code}" is not a valid code`, { ref: r.ref, key, field: 'code' });
        continue;
      }
      const seen = masterIndex[kind].get(code);
      if (seen) {
        if (seen.name !== r.v.name || seen.active !== active) add('DQ-10', `${kind} ${code} is repeated (line ${seen.ref.line}) with another name or state`, { ref: r.ref, key: code });
        continue;
      }
      masterIndex[kind].set(code, { active, name: r.v.name!, ref: r.ref });
      if (!active) exclude(r.ref, kind, code, 'INACTIVE_MASTER', `inactive ${kind} in the old system`);
      else plan.masters[kind].push({ ref: r.ref, code, name: r.v.name! });
    }
  }

  // ---------------------------------------------------------------------------------------------- employees
  interface Emp extends PlannedEmployee {
    identity: string | null;
    excluded: boolean;
  }
  const employees = new Map<string, Emp>();
  const allEmployeeRows = new Map<string, SourceRef[]>();
  const placementOf = (r: Row, key: string): Placement => ({
    departmentCode: ref('department', r, 'departmentCode', key) ?? '',
    locationCode: ref('location', r, 'locationCode', key) ?? '',
    designationCode: ref('designation', r, 'designationCode', key) ?? '',
    gradeCode: ref('grade', r, 'gradeCode', key) ?? '',
  });
  for (const r of live('employee')) {
    const raw = r.v.employeeCode ?? '';
    if (!required(r, 'employeeCode', raw)) continue;
    if (!EMPLOYEE_CODE.test(raw)) add('DQ-04', 'employeeCode is not a valid employee code (letters, digits, "-" or "_", up to 40)', { ref: r.ref, key: raw, field: 'employeeCode' });
    const code = raw.toUpperCase();
    allEmployeeRows.set(code, [...(allEmployeeRows.get(code) ?? []), r.ref]);
    if (employees.has(code)) continue; // reported under DQ-10 below
    let targetStatus = '';
    const label = r.v.status ?? '';
    if (required(r, 'status', code)) {
      const mapped = lookup(m.statusMaps?.employee, label);
      if (mapped === undefined) add('DQ-07', `status "${label}" has no entry in statusMaps.employee`, { ref: r.ref, key: code, field: 'status' });
      else if (!(EMPLOYEE_STATUSES as readonly string[]).includes(mapped)) add('DQ-07', `status "${label}" maps to ${mapped}, which is not an employee status (${EMPLOYEE_STATUSES.join(', ')})`, { ref: r.ref, key: code, field: 'status' });
      else targetStatus = mapped;
    }
    const excluded = EMPLOYEE_ENDED_STATUSES.includes(targetStatus);
    const e: Emp = {
      ref: r.ref,
      code,
      displayName: r.v.displayName ?? '',
      workEmail: (r.v.workEmail ?? '').toLowerCase(),
      joiningDate: '',
      employmentType: '',
      sourceStatus: label,
      targetStatus,
      activate: EMPLOYEE_ACTIVE_STATUSES.includes(targetStatus),
      joining: { departmentCode: '', locationCode: '', designationCode: '', gradeCode: '' },
      changes: [],
      managerCode: (r.v.managerEmployeeCode ?? '') === '' ? null : r.v.managerEmployeeCode!.toUpperCase(),
      managerFrom: null,
      shiftCode: null,
      shiftFrom: null,
      depth: 0,
      identity: (r.v.identityNumber ?? '') === '' ? null : normaliseIdentity(r.v.identityNumber!),
      excluded,
    };
    employees.set(code, e);
    if (excluded) {
      exclude(r.ref, 'employee', code, 'INACTIVE_EMPLOYEE', `${label} (${targetStatus}) in the old system`);
      continue;
    }
    required(r, 'displayName', code);
    textOk(r, 'displayName', code, 200);
    if (e.activate) {
      required(r, 'workEmail', code);
      required(r, 'shiftCode', code);
    }
    if (e.workEmail && (!EMAIL.test(e.workEmail) || e.workEmail.length > 254)) add('DQ-04', 'workEmail is not an email address', { ref: r.ref, key: code, field: 'workEmail' });
    if (required(r, 'joiningDate', code)) e.joiningDate = date(r, 'joiningDate', code) ?? '';
    if (required(r, 'employmentType', code)) e.employmentType = ref('employmentType', r, 'employmentType', code) ?? '';
    for (const f of ['departmentCode', 'locationCode', 'designationCode'] as const) required(r, f, code);
    e.joining = placementOf(r, code);
    e.shiftCode = ref('shift', r, 'shiftCode', code);
    e.managerFrom = date(r, 'managerFrom', code);
    e.shiftFrom = date(r, 'shiftFrom', code);
    if (e.activate && e.joiningDate && e.joiningDate > m.cutoverDate) {
      add('DQ-07', `status "${label}" is active but the employee joins after the cut-over date ${m.cutoverDate}; map a not-yet-joined status to DRAFT`, { ref: r.ref, key: code, field: 'status' });
    }
  }
  const loaded = [...employees.values()].filter((e) => !e.excluded && e.targetStatus !== '');
  // DQ-10: one code per person, one email, one identity.
  for (const [code, refs] of allEmployeeRows) {
    if (refs.length > 1) for (const at of refs.slice(1)) add('DQ-10', `employee code ${code} is repeated (first at line ${refs[0]!.line})`, { ref: at, key: code });
    const t = target?.employees.get(code);
    const e = employees.get(code);
    if (t && !t.migrated && e && !e.excluded) add('DQ-10', `employee code ${code} already exists in the target company`, { ref: e.ref, key: code });
  }
  const repeated = (label: string, valueOf: (e: Emp) => string | null) => {
    const firstAt = new Map<string, Emp>();
    for (const e of loaded) {
      const v = valueOf(e);
      if (!v) continue;
      const first = firstAt.get(v);
      if (first) add('DQ-10', `${label} repeats the one of ${first.code} (line ${first.ref.line})`, { ref: e.ref, key: e.code });
      else firstAt.set(v, e);
    }
  };
  repeated('work email', (e) => e.workEmail || null);
  repeated('identity number', (e) => e.identity);
  if (target) {
    for (const e of loaded) {
      const owner = e.workEmail ? target.emails.get(e.workEmail) : undefined;
      if (owner && owner !== e.code) add('DQ-10', `work email is already used by employee ${owner} in the target company`, { ref: e.ref, key: e.code, field: 'workEmail' });
    }
  }

  /** The loaded employee a dependent row names; a row of an excluded employee is excluded with it. */
  const owner = (r: Row, entity: EntityKind, key: string): Emp | null => {
    const code = (r.v.employeeCode ?? '').toUpperCase();
    if (!required(r, 'employeeCode', key)) return null;
    const e = employees.get(code);
    if (!e) {
      add('DQ-06', `employee ${code} is not in the employee file`, { ref: r.ref, key, field: 'employeeCode' });
      return null;
    }
    if (e.excluded) {
      exclude(r.ref, entity, key, 'INACTIVE_EMPLOYEE', `belongs to excluded employee ${code}`);
      return null;
    }
    return e.targetStatus ? e : null;
  };

  // ---------------------------------------------------------------------------------------------- assignment history (DQ-13)
  const history = new Map<string, { at: string; p: Placement; ref: SourceRef }[]>();
  for (const r of live('assignment_history')) {
    const e = owner(r, 'assignment_history', (r.v.employeeCode ?? '').toUpperCase());
    if (!e) continue;
    const at = required(r, 'effectiveFrom', e.code) ? date(r, 'effectiveFrom', e.code) : null;
    for (const f of ['departmentCode', 'locationCode', 'designationCode'] as const) required(r, f, e.code);
    const p = placementOf(r, e.code);
    if (at) history.set(e.code, [...(history.get(e.code) ?? []), { at, p, ref: r.ref }]);
  }
  const same = (a: Placement, b: Placement) => a.departmentCode === b.departmentCode && a.locationCode === b.locationCode && a.designationCode === b.designationCode && a.gradeCode === b.gradeCode;
  for (const [code, list] of history) {
    const e = employees.get(code)!;
    list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.ref.line - b.ref.line));
    list.forEach((h, i) => {
      const prev = list[i - 1];
      if (prev && prev.at === h.at) add('DQ-13', `two placements start on ${h.at} (lines ${prev.ref.line} and ${h.ref.line}): periods overlap`, { ref: h.ref, key: code });
      else if (prev && same(prev.p, h.p)) add('DQ-13', `the placement from ${h.at} does not change anything from line ${prev.ref.line}`, { ref: h.ref, key: code });
      // EMPLOYEE_UPDATE_V1 reads a blank cell as "no change", so a dated change cannot take a grade away.
      if (prev && prev.p.gradeCode && !h.p.gradeCode) add('DQ-13', `the placement from ${h.at} has no grade after line ${prev.ref.line} had one; a dated change cannot remove a grade`, { ref: h.ref, key: code });
    });
    const first = list[0]!;
    const last = list[list.length - 1]!;
    if (e.joiningDate && first.at !== e.joiningDate) add('DQ-13', `the assignment history starts on ${first.at}, not on the joining date ${e.joiningDate}`, { ref: first.ref, key: code });
    if (!same(last.p, e.joining)) add('DQ-13', `the last assignment history row differs from the employee file's placement (line ${e.ref.line})`, { ref: last.ref, key: code });
    e.joining = first.p;
    e.changes = list.slice(1).map((h) => ({ ...h.p, effectiveFrom: h.at, ref: h.ref }));
  }

  // ---------------------------------------------------------------------------------------------- managers (DQ-06, DQ-13)
  for (const e of loaded) {
    if (!e.managerCode) {
      if (e.activate && !m.policies?.noManagerReason?.trim()) add('DQ-06', 'has no manager; activation needs policies.noManagerReason for the top of the reporting chain', { ref: e.ref, key: e.code, field: 'managerEmployeeCode' });
      continue;
    }
    const mgr = employees.get(e.managerCode);
    if (e.managerCode === e.code) add('DQ-06', 'is their own manager', { ref: e.ref, key: e.code, field: 'managerEmployeeCode' });
    else if (!mgr) add('DQ-06', `manager ${e.managerCode} is not in the employee file`, { ref: e.ref, key: e.code, field: 'managerEmployeeCode' });
    else if (mgr.excluded) add('DQ-06', `manager ${e.managerCode} is excluded (${mgr.sourceStatus}), so the reporting line cannot be loaded`, { ref: e.ref, key: e.code, field: 'managerEmployeeCode' });
    else if (mgr.targetStatus && !mgr.activate) add('DQ-06', `manager ${e.managerCode} will not be active in the target (${mgr.targetStatus}); a manager must be active`, { ref: e.ref, key: e.code, field: 'managerEmployeeCode' });
    if (mgr && e.joiningDate && mgr.joiningDate) {
      const earliest = e.joiningDate > mgr.joiningDate ? e.joiningDate : mgr.joiningDate;
      if (e.managerFrom && e.managerFrom < earliest) add('DQ-13', `managerFrom ${e.managerFrom} is before both employments have started (${earliest})`, { ref: e.ref, key: e.code, field: 'managerFrom' });
      e.managerFrom ??= earliest;
      const latest = e.joiningDate > m.cutoverDate ? e.joiningDate : m.cutoverDate;
      if (e.activate && e.managerFrom > latest) add('DQ-13', `managerFrom ${e.managerFrom} is after the date activation checks (${latest})`, { ref: e.ref, key: e.code, field: 'managerFrom' });
    }
  }
  // Cycles: follow each chain; a chain that returns to a code it has seen is reported once, on each member.
  const inCycle = new Set<string>();
  for (const e of loaded) {
    const seen: string[] = [];
    let at: Emp | undefined = e;
    while (at?.managerCode && !seen.includes(at.code)) {
      seen.push(at.code);
      at = employees.get(at.managerCode);
    }
    const cycle = at && seen.includes(at.code) ? seen.slice(seen.indexOf(at.code)) : [];
    if (at && cycle.length > 0 && !inCycle.has(cycle[0]!)) {
      cycle.forEach((c) => inCycle.add(c));
      add('DQ-06', `reporting lines form a cycle: ${[...cycle, at.code].join(' -> ')}`, { ref: e.ref, key: e.code, field: 'managerEmployeeCode' });
    }
  }
  if (inCycle.size === 0) {
    const depthOf = (e: Emp, guard = 0): number => (!e.managerCode || guard > 10_000 ? 0 : 1 + depthOf(employees.get(e.managerCode) ?? { ...e, managerCode: null }, guard + 1));
    for (const e of loaded) e.depth = depthOf(e);
  }
  for (const e of loaded) {
    if (e.shiftFrom && e.joiningDate) {
      if (e.shiftFrom < e.joiningDate) add('DQ-13', `shiftFrom ${e.shiftFrom} is before joining`, { ref: e.ref, key: e.code, field: 'shiftFrom' });
      const latest = e.joiningDate > m.cutoverDate ? e.joiningDate : m.cutoverDate;
      if (e.activate && e.shiftFrom > latest) add('DQ-13', `shiftFrom ${e.shiftFrom} is after the date activation checks (${latest})`, { ref: e.ref, key: e.code, field: 'shiftFrom' });
    }
    if (e.shiftCode) e.shiftFrom ??= e.joiningDate;
  }

  // ---------------------------------------------------------------------------------------------- salary (DQ-04, DQ-05, DQ-10, DQ-13)
  const salaryBy = new Map<string, PlannedSalary[]>();
  for (const r of live('salary')) {
    const key = (r.v.employeeCode ?? '').toUpperCase();
    const e = owner(r, 'salary', key);
    if (!e) continue;
    const currency = required(r, 'currency', key) ? ref('currency', r, 'currency', key) : null;
    const s: PlannedSalary = {
      ref: r.ref,
      employeeCode: e.code,
      effectiveFrom: (required(r, 'effectiveFrom', key) && date(r, 'effectiveFrom', key)) || '',
      annualCtc: (required(r, 'annualCtc', key) && money(r, 'annualCtc', key, currency, { positive: true })) || '',
      monthlyGross: (required(r, 'monthlyGross', key) && money(r, 'monthlyGross', key, currency, { positive: true })) || '',
      currency: currency ?? '',
    };
    if (s.effectiveFrom && e.joiningDate && s.effectiveFrom < e.joiningDate) add('DQ-13', `salary effective ${s.effectiveFrom} is before joining`, { ref: r.ref, key });
    salaryBy.set(e.code, [...(salaryBy.get(e.code) ?? []), s]);
  }
  for (const [code, list] of salaryBy) {
    list.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0));
    list.forEach((s, i) => {
      if (i > 0 && s.effectiveFrom && s.effectiveFrom === list[i - 1]!.effectiveFrom) add('DQ-10', `two salary rows start on ${s.effectiveFrom} (line ${list[i - 1]!.ref.line})`, { ref: s.ref, key: code });
    });
    const inForce = list.filter((s) => s.effectiveFrom && s.effectiveFrom <= m.cutoverDate);
    for (const s of list.filter((x) => x.effectiveFrom > m.cutoverDate)) {
      if (list.length > 1) add('DQ-13', `a salary revision from ${s.effectiveFrom} is after the cut-over date; it goes through an increment case, not the salary master upload`, { ref: s.ref, key: code });
    }
    const chosen = list.length === 1 ? list[0]! : inForce[inForce.length - 1];
    if (!chosen) continue;
    for (const s of list) if (s !== chosen && s.effectiveFrom <= m.cutoverDate) exclude(s.ref, 'salary', code, 'SALARY_HISTORY', `earlier salary revision (from ${s.effectiveFrom}); SALARY_MASTER_V1 records one initial arrangement, the one in force at cut-over`);
    plan.salaries.push(chosen);
  }

  // ---------------------------------------------------------------------------------------------- leave openings
  const leaveSeen = new Map<string, SourceRef>();
  for (const r of live('leave_opening')) {
    const key = (r.v.employeeCode ?? '').toUpperCase();
    const e = owner(r, 'leave_opening', key);
    if (!e) continue;
    const type = required(r, 'leaveType', key) ? ref('leaveType', r, 'leaveType', key) : null;
    const effectiveDate = date(r, 'effectiveDate', key) ?? m.cutoverDate;
    if (e.joiningDate && effectiveDate < e.joiningDate) add('DQ-13', `opening balance dated ${effectiveDate} is before joining`, { ref: r.ref, key });
    if (!type || !required(r, 'units', key)) continue;
    const units = parseDecimal(r.v.units!, sep);
    if (!units || units.decimals > 4 || units.text.replace(/^-/, '').replace(/\..*$/, '').length > 4) {
      add('DQ-04', 'units is not a number of days with at most 4 digits and 4 decimals', { ref: r.ref, key, field: 'units' });
      continue;
    }
    if (units.negative) {
      add('DQ-04', 'an opening balance is never negative; record an adjustment after the migration instead', { ref: r.ref, key, field: 'units' });
      continue;
    }
    const dupKey = `${e.code}@${type}`;
    const prior = leaveSeen.get(dupKey);
    if (prior) {
      add('DQ-10', `a second opening balance for ${type} (line ${prior.line})`, { ref: r.ref, key });
      continue;
    }
    leaveSeen.set(dupKey, r.ref);
    if (units.scaled === 0n) {
      exclude(r.ref, 'leave_opening', dupKey, 'ZERO_LEAVE_BALANCE', 'zero opening balance: there is nothing to record');
      continue;
    }
    plan.leaveOpenings.push({ ref: r.ref, employeeCode: e.code, leaveType: type, sourceType: r.v.leaveType!, units: units.text, effectiveDate });
  }

  // ---------------------------------------------------------------------------------------------- loans
  const loanRefs = new Map<string, SourceRef>();
  const basis = m.policies?.loanAmountBasis;
  for (const r of live('loan')) {
    const reference = r.v.loanReference ?? '';
    if (!required(r, 'loanReference', reference)) continue;
    if (!LOAN_REFERENCE.test(reference)) add('DQ-04', 'loanReference is not a valid reference (letters, digits, ".", "/", "-" or "_", up to 40)', { ref: r.ref, key: reference, field: 'loanReference' });
    const prior = loanRefs.get(reference.toUpperCase());
    if (prior) add('DQ-10', `loan reference ${reference} is repeated (line ${prior.line})`, { ref: r.ref, key: reference });
    loanRefs.set(reference.toUpperCase(), r.ref);
    const label = r.v.status ?? '';
    let state = '';
    if (required(r, 'status', reference)) {
      const mapped = lookup(m.statusMaps?.loan, label);
      if (mapped === undefined) add('DQ-07', `loan status "${label}" has no entry in statusMaps.loan`, { ref: r.ref, key: reference, field: 'status' });
      else if (!(LOAN_STATES as readonly string[]).includes(mapped)) add('DQ-07', `loan status "${label}" maps to ${mapped}, which is not a loan state (${LOAN_STATES.join(', ')})`, { ref: r.ref, key: reference, field: 'status' });
      else state = mapped;
    }
    const e = owner(r, 'loan', reference);
    if (!e) continue;
    if (state && !LOAN_OPEN_STATES.includes(state)) {
      exclude(r.ref, 'loan', reference, 'CLOSED_LOAN', `${label} (${state}) in the old system: nothing is owed or awaited`);
      continue;
    }
    const kind = required(r, 'loanKind', reference) ? ref('loanKind', r, 'loanKind', reference) : null;
    const currency = required(r, 'currency', reference) ? ref('currency', r, 'currency', reference) : null;
    if (currency && target && !target.loanCurrencies.has(currency)) add('DQ-05', `no active payroll calendar pays in ${currency}, which a loan needs`, { ref: r.ref, key: reference, field: 'currency' });
    const principal = required(r, 'principal', reference) ? money(r, 'principal', reference, currency, { positive: true }) : null;
    const outstanding = basis === 'OUTSTANDING' ? (required(r, 'outstanding', reference) ? money(r, 'outstanding', reference, currency, { positive: false }) : null) : (r.v.outstanding ?? '') === '' ? null : money(r, 'outstanding', reference, currency, { positive: false });
    if (principal && outstanding && parseDecimal(outstanding)!.scaled > parseDecimal(principal)!.scaled) add('DQ-04', 'outstanding is more than the principal', { ref: r.ref, key: reference, field: 'outstanding' });
    required(r, 'purpose', reference);
    textOk(r, 'purpose', reference, 900);
    const sanctioned = date(r, 'sanctionDate', reference);
    if (sanctioned && e.joiningDate && sanctioned < e.joiningDate) add('DQ-13', `sanctionDate ${sanctioned} is before joining`, { ref: r.ref, key: reference, field: 'sanctionDate' });
    if (sanctioned && sanctioned > m.cutoverDate) add('DQ-13', `sanctionDate ${sanctioned} is after the cut-over date`, { ref: r.ref, key: reference, field: 'sanctionDate' });
    const amount = basis === 'OUTSTANDING' ? outstanding : principal;
    if (basis && amount !== null && parseDecimal(amount)!.scaled === 0n) add('DQ-07', `loan status "${label}" is open but nothing is outstanding; map it to CLOSED or correct the amount`, { ref: r.ref, key: reference, field: 'status' });
    if (!kind || !currency || !principal || !basis || amount === null) continue;
    plan.loans.push({
      ref: r.ref,
      loanReference: reference,
      employeeCode: e.code,
      loanKind: kind,
      currency,
      amount,
      principal,
      outstanding,
      sourceStatus: label,
      targetStatus: state,
      purpose: `${r.v.purpose ?? ''} ${loanMarker(m.migrationId, reference)}`,
    });
  }

  // ---------------------------------------------------------------------------------------------- DQ-09 exclusions declared
  const undeclared = new Map<ExclusionPolicy, number>();
  for (const x of exclusions) if (x.policy !== 'DISPOSITION' && !isApproved(m.exclusionPolicies?.[x.policy])) undeclared.set(x.policy, (undeclared.get(x.policy) ?? 0) + 1);
  for (const [policy, n] of undeclared) {
    add('DQ-09', `${n} row(s) fall under ${policy} but exclusionPolicies.${policy} is not declared with a reason, approvedBy and approvedOn (YYYY-MM-DD)`);
    for (const x of exclusions.filter((y) => y.policy === policy)) add('DQ-09', `not loaded (${policy}) without an approved policy`, { ref: x.ref, key: x.key });
  }

  // ---------------------------------------------------------------------------------------------- DQ-11 control totals
  const totals: Analysis['totals'] = {};
  for (const entity of presentEntities) {
    const all = rows.filter((r) => r.entity === entity);
    const t: NonNullable<Analysis['totals'][EntityKind]> = { rows: all.length };
    const count = (field: string) => {
      const c: Record<string, number> = {};
      for (const r of all) if ((r.v[field] ?? '') !== '') c[r.v[field]!] = (c[r.v[field]!] ?? 0) + 1;
      return c;
    };
    if (entity === 'employee' || entity === 'loan') t.byStatus = count('status');
    if (entity === 'employee') t.byDepartment = count('departmentCode');
    const amounts: Record<string, Record<string, bigint>> = {};
    for (const field of AMOUNT_FIELDS[entity] ?? []) {
      for (const r of all) {
        const d = parseDecimal(r.v[field] ?? '', sep);
        if (!d || d.decimals > 4) continue;
        const category = entity === 'leave_opening' ? (r.v.leaveType ?? '') : (lookup(m.codeMaps?.currency, r.v.currency ?? '') ?? r.v.currency ?? '').toUpperCase();
        amounts[field] ??= {};
        amounts[field][category] = (amounts[field][category] ?? 0n) + d.scaled;
      }
    }
    if (Object.keys(amounts).length) t.amounts = Object.fromEntries(Object.entries(amounts).map(([f, byCat]) => [f, Object.fromEntries(Object.entries(byCat).map(([c, v]) => [c, formatScaled(v)]))]));
    totals[entity] = t;
    const recorded = m.controlTotals?.[entity];
    if (!recorded || recorded.rows === undefined) {
      add('DQ-11', `no control total is recorded for ${entity} (controlTotals.${entity}.rows from the old system's own report); the extract has ${t.rows} row(s)`);
      continue;
    }
    if (recorded.rows !== t.rows) add('DQ-11', `${entity}: the extract has ${t.rows} row(s) where the old system reported ${recorded.rows}`);
    const compareCounts = (name: string, rec: Record<string, number> | undefined, got: Record<string, number> | undefined) => {
      if (!rec) return;
      for (const k of new Set([...Object.keys(rec), ...Object.keys(got ?? {})])) {
        if ((rec[k] ?? 0) !== (got?.[k] ?? 0)) add('DQ-11', `${entity} ${name} "${k}": the extract has ${got?.[k] ?? 0} where the old system reported ${rec[k] ?? 0}`);
      }
    };
    compareCounts('status', recorded.byStatus, t.byStatus);
    compareCounts('department', recorded.byDepartment, t.byDepartment);
    for (const [field, byCat] of Object.entries(recorded.amounts ?? {})) {
      for (const k of new Set([...Object.keys(byCat), ...Object.keys(t.amounts?.[field] ?? {})])) {
        const want = byCat[k] !== undefined ? parseDecimal(byCat[k]!, sep) : null;
        const got = t.amounts?.[field]?.[k];
        if (byCat[k] !== undefined && !want) add('DQ-11', `controlTotals.${entity}.amounts.${field}.${k} is not an amount`);
        else if ((want?.scaled ?? 0n) !== (got !== undefined ? parseDecimal(got)!.scaled : 0n)) add('DQ-11', `${entity} ${field} total for ${k}: the extract has ${got ?? '0'} where the old system reported ${byCat[k] ?? '0'}`);
      }
    }
  }
  for (const entity of presentEntities) {
    for (const field of AMOUNT_FIELDS[entity] ?? []) {
      if (mappedFields.get(entity)?.has(field) && !m.amountClassification?.[`${entity}.${field}`]) add('DQ-11', `amountClassification["${entity}.${field}"] must say whether the amount is CAPTURED, DERIVED or AGGREGATED in the old system`);
    }
  }
  if (presentEntities.has('loan') && !basis) add('DQ-11', 'policies.loanAmountBasis must say whether a loan is carried over at its PRINCIPAL or its OUTSTANDING amount');

  // ---------------------------------------------------------------------------------------------- results
  const loadedEmployees = loaded.map(({ identity: _identity, excluded: _excluded, ...e }) => e);
  plan.employees = loadedEmployees.sort((a, b) => a.depth - b.depth || a.ref.line - b.ref.line);
  const checks: CheckResult[] = DQ_IDS.map((id) => {
    const own = findings.filter((f) => f.check === id);
    const status: CheckStatus = own.some((f) => f.severity === 'FAIL') ? 'FAIL' : MANUAL_CHECKS.includes(id) || own.length > 0 ? 'MANUAL' : 'PASS';
    let checklist = CHECKLIST[id] ?? [];
    if (id === 'DQ-01') checklist = [...m.files.map((f) => `${f.file} -> ${ENTITY_TARGET[f.entity].record}; screen: ${ENTITY_TARGET[f.entity].screen}; loaded by ${ENTITY_TARGET[f.entity].path}; owner: ${f.owner ?? 'not named'}`), ...checklist];
    if (id === 'DQ-15') checklist = [...sources.map((s) => `${s.entity} (${s.file}, ${s.rows} rows, owner ${m.files.find((f) => f.file === s.file)?.owner ?? 'not named'}): validated by this report, loaded through ${ENTITY_TARGET[s.entity].path}; a failed batch is rejected whole with row codes`), ...checklist];
    if (own.some((f) => f.severity === 'UNVERIFIED')) checklist = [...checklist, 'Validate again against the target company (DATABASE_URL and --company) to settle the unverified findings'];
    return { id, title: DQ_TITLES[id], status, automated: AUTOMATED[id], checklist, findings: own, signOff: m.signOffs?.[id] ?? null };
  });
  return {
    migrationId: m.migrationId,
    sourceSystem: m.sourceSystem,
    cutoverDate: m.cutoverDate,
    manifestSha256: sha256(JSON.stringify(m)),
    target: target ? { companyCode: target.companyCode } : null,
    sources,
    checks,
    failed: checks.some((c) => c.status === 'FAIL'),
    exclusions,
    plan,
    totals,
  };
}

/** The business key a row is reported under: a loan's reference, a master's code, otherwise the employee code. */
function keyOf(r: Row): string {
  const key = r.entity === 'loan' ? r.v.loanReference : (MASTER_KINDS as readonly string[]).includes(r.entity) ? r.v.code : r.v.employeeCode;
  return (key ?? '').toUpperCase() || `line ${r.ref.line}`;
}

/** The provenance a migrated loan carries in its purpose (CI16): which migration and which legacy loan. */
export const loanMarker = (migrationId: string, reference: string) => `[migration ${migrationId} loan ${reference}]`;
export const LOAN_MARKER = /\[migration (\S+) loan (\S+)\]$/;

/** The reason every migrated opening balance carries (reconcile.ts finds them by it). */
export const openingReason = (migrationId: string, sourceSystem: string) => `Opening balance migrated by ${migrationId} from ${sourceSystem}`.slice(0, 500);
