// Employee record sections and their field dictionary: family and dependants, qualifications, prior employment and payroll
// identifiers (FR-008 target sections; FR-007 exports). Decided under owner delegation, 6 Nov 2026 (docs/03 I-82 item 2,
// answering I-48 item 3); migration 0191. Common Indian HR practice, kept to what the BRD's clauses need.
//
// Classification (DF02 lists none of these as operational, so BR-043 makes each confidential):
//   employee.private     family, qualification and prior-employment values; payroll identifiers masked to their last four
//   employee.payroll_id  payroll identifiers in full (DF02 "bank/payment/tax identifiers ... remain confidential")
// Readers: an eligible Admin assignment holding the group with row scope (BR-044), and the employee's own Employee OWN context
// (H1/BR-053 "permitted own private profile values"), which never holds payroll_id, so its own identifiers stay masked.
// Changes: an eligible Admin holding employee.manage.private or employee.manage.payroll_id (DF04 "confidential field maintenance
// belongs to eligible Admins"), never on their own record; the employee never changes these directly (BR-054) and asks HR.
// Validation is the BRD's (FR-008 "invalid dates and unknown master references fail validation before save") plus the public
// format of each identifier, nothing statutory beyond it: no checksum, no PAN holder-type letter, no nominee shares, and no
// Aadhaar number (not collected: its storage carries legal conditions the owner has not decided). Payroll identifiers are
// optional here: DF04 makes them conditionally required only for enabled payroll processing, which is payroll's check.
// Entries are kept (DF08): an entry recorded in error is removed with a reason and stays on record, read only.
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { openJson, sealJson } from '../../security/field-crypto.js';
import { type AccessGrant, assertNotOwnRecord, canAccessEmployee } from '../access/authorize.js';
import { maskTail } from '../sensitive-change/fields.js';

type FieldKind = 'text' | 'reference' | 'date' | 'year' | 'boolean';

export interface SectionField {
  label: string;
  kind: FieldKind;
  required: boolean;
  /** text: the longest value. */
  max?: number;
  /** reference: the company's controlled list (DF04 "no free-text value silently creates a master"). */
  category?: string;
  column: string;
}

export interface ListSection {
  label: string;
  table: 'employee_family_member' | 'employee_qualification' | 'employee_prior_employment';
  /** The field group that reads the section; the same name with `manage` changes it. */
  fieldGroup: 'private';
  fields: Readonly<Record<string, SectionField>>;
}

/** The three list sections, keyed by their path segment. */
export const LIST_SECTIONS = {
  'family-members': {
    label: 'Family and dependants',
    table: 'employee_family_member',
    fieldGroup: 'private',
    fields: {
      relationship: { label: 'Relationship', kind: 'reference', category: 'FAMILY_RELATIONSHIP', required: true, column: 'relationship_id' },
      fullName: { label: 'Full name', kind: 'text', max: 200, required: true, column: 'full_name' },
      dateOfBirth: { label: 'Date of birth', kind: 'date', required: false, column: 'date_of_birth' },
      dependant: { label: 'Dependant', kind: 'boolean', required: true, column: 'dependant' },
    },
  },
  qualifications: {
    label: 'Qualifications',
    table: 'employee_qualification',
    fieldGroup: 'private',
    fields: {
      level: { label: 'Level', kind: 'reference', category: 'QUALIFICATION_LEVEL', required: true, column: 'level_id' },
      qualification: { label: 'Qualification', kind: 'text', max: 200, required: true, column: 'qualification' },
      specialisation: { label: 'Specialisation', kind: 'text', max: 200, required: false, column: 'specialisation' },
      institution: { label: 'Institution or board', kind: 'text', max: 200, required: false, column: 'institution' },
      completionYear: { label: 'Year of completion', kind: 'year', required: false, column: 'completion_year' },
    },
  },
  'prior-employments': {
    label: 'Prior employment',
    table: 'employee_prior_employment',
    fieldGroup: 'private',
    fields: {
      employerName: { label: 'Employer', kind: 'text', max: 200, required: true, column: 'employer_name' },
      designation: { label: 'Designation', kind: 'text', max: 200, required: false, column: 'designation' },
      fromDate: { label: 'From', kind: 'date', required: true, column: 'from_date' },
      toDate: { label: 'To (inclusive)', kind: 'date', required: true, column: 'to_date' },
    },
  },
} as const satisfies Readonly<Record<string, ListSection>>;

export type ListSectionKey = keyof typeof LIST_SECTIONS;
export const LIST_SECTION_KEYS = Object.keys(LIST_SECTIONS) as ListSectionKey[];

/** Payroll identifiers: optional, upper-cased, spaces removed, checked against each identifier's public format only. */
export const PAYROLL_IDENTIFIERS = {
  pan: { code: 'PAN', label: 'PAN (Permanent Account Number)', format: /^[A-Z]{5}[0-9]{4}[A-Z]$/, formatText: 'five letters, four digits and a letter' },
  uan: { code: 'UAN', label: 'UAN (EPF Universal Account Number)', format: /^[0-9]{12}$/, formatText: 'twelve digits' },
  esicIpNumber: { code: 'ESIC_IP', label: 'ESIC insurance (IP) number', format: /^[0-9]{10}$/, formatText: 'ten digits' },
} as const;
export type PayrollIdentifierKey = keyof typeof PAYROLL_IDENTIFIERS;
const IDENTIFIER_KEYS = Object.keys(PAYROLL_IDENTIFIERS) as PayrollIdentifierKey[];

/**
 * Fields held on the employee record itself rather than in a section, listed here so the dictionary names them too (I-83 item 5:
 * the DF16 extension "would join the employee field dictionary"). Operational work contacts (DF02), read with the record and
 * changed by HR with employee.update.operational; never on a section's confidential grants.
 */
export const RECORD_FIELDS = [
  {
    name: 'workPhoneExtension',
    label: 'Work phone extension',
    kind: 'digits',
    required: false,
    maxLength: 8,
    classification: 'OPERATIONAL',
    read: 'employee.read.operational',
    change: 'employee.update.operational',
    searchable: true,
    decidedUnder: 'Owner delegation, 6 Nov 2026 (I-89 item 5)',
  },
] as const;

/** The dictionary as data, for the screens and for the owner's review (no values). */
export function recordSectionDictionary() {
  return {
    decidedUnder: 'Owner delegation, 6 Nov 2026 (I-82 item 2)',
    recordFields: RECORD_FIELDS,
    sections: [
      ...LIST_SECTION_KEYS.map((key) => ({
        key,
        label: LIST_SECTIONS[key].label,
        classification: 'CONFIDENTIAL',
        read: 'employee.read.private',
        change: 'employee.manage.private',
        masked: false,
        fields: Object.entries(LIST_SECTIONS[key].fields as Readonly<Record<string, SectionField>>).map(([name, f]) => ({
          name,
          label: f.label,
          kind: f.kind,
          required: f.required,
          ...(f.max ? { maxLength: f.max } : {}),
          ...(f.category ? { list: f.category } : {}),
        })),
      })),
      {
        key: 'payroll-identifiers',
        label: 'Payroll identifiers',
        classification: 'CONFIDENTIAL',
        read: 'employee.read.payroll_id',
        readMasked: 'employee.read.private',
        change: 'employee.manage.payroll_id',
        masked: true,
        fields: IDENTIFIER_KEYS.map((name) => ({ name, label: PAYROLL_IDENTIFIERS[name].label, kind: 'identifier', required: false, format: PAYROLL_IDENTIFIERS[name].formatText })),
      },
    ],
  };
}

const isIsoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** Serialises every change to one employee's record sections. */
async function lockSections(tx: Queryable, companyId: string, employeeId: string): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('employee_record_section:' || $1 || ':' || $2, 0))`, [companyId, employeeId]);
}

async function inScope(db: Queryable, grant: AccessGrant, employeeId: string): Promise<{ joining_date: string; employee_code: string }> {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  return (await db.query<{ joining_date: string; employee_code: string }>(`select to_char(joining_date, 'YYYY-MM-DD') as joining_date, employee_code from employee where company_id = $1 and id = $2`, [grant.companyId, employeeId])).rows[0]!;
}

type Values = Record<string, string | number | boolean | null>;

/**
 * Validates a whole entry against the section's dictionary (unknown fields, required fields, kinds, dates, the company's
 * controlled lists) and returns the column values and the readable values for the audit. Nothing is saved on a failure.
 */
async function validateEntry(db: Queryable, grant: AccessGrant, section: ListSectionKey, input: Record<string, unknown>, joiningDate: string) {
  const fields = LIST_SECTIONS[section].fields as Readonly<Record<string, SectionField>>;
  for (const key of Object.keys(input)) if (!Object.hasOwn(fields, key)) throw new HttpError(422, 'UNKNOWN_FIELD', 'This field is not part of the section', { field: key });
  const columns: Record<string, unknown> = {};
  const values: Values = {};
  for (const [name, f] of Object.entries(fields)) {
    const raw = input[name];
    const fail = (code = 'INVALID_FIELD', message = `The ${f.label.toLowerCase()} is not valid`, details: Record<string, unknown> = {}): never => {
      throw new HttpError(422, code, message, { field: name, ...details });
    };
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      if (f.kind === 'boolean' && raw === undefined) {
        // An unstated dependant flag is "no" (the column default); it is still a required answer, never null.
        columns[f.column] = false;
        values[name] = false;
        continue;
      }
      if (f.required) fail('FIELD_REQUIRED', `The ${f.label.toLowerCase()} is required`);
      columns[f.column] = null;
      values[name] = null;
      continue;
    }
    switch (f.kind) {
      case 'text': {
        if (typeof raw !== 'string') fail();
        const v = (raw as string).trim();
        if (v.length > (f.max ?? 200) || /[\u0000-\u001f\u007f]/.test(v)) fail();
        columns[f.column] = v;
        values[name] = v;
        break;
      }
      case 'reference': {
        if (typeof raw !== 'string') fail();
        const code = (raw as string).trim().toUpperCase();
        const row = (await db.query<{ id: string }>(`select id from reference_value_in_force where company_id = $1 and category = $2 and code = $3`, [grant.companyId, f.category, code])).rows[0];
        if (!row) fail('INVALID_REFERENCE', `${code} is not an active ${f.label.toLowerCase()} value`, { category: f.category });
        columns[f.column] = row!.id;
        values[name] = code;
        break;
      }
      case 'date': {
        if (typeof raw !== 'string' || !isIsoDate(raw)) fail('INVALID_DATE', `The ${f.label.toLowerCase()} is not a valid calendar date`);
        if ((raw as string) > grant.businessDate) fail('INVALID_DATE', `The ${f.label.toLowerCase()} cannot be in the future`);
        columns[f.column] = raw;
        values[name] = raw as string;
        break;
      }
      case 'year': {
        const year = Number(grant.businessDate.slice(0, 4));
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1900 || raw > year) fail('INVALID_FIELD', `The ${f.label.toLowerCase()} is a year from 1900 to ${year}`);
        columns[f.column] = raw;
        values[name] = raw as number;
        break;
      }
      case 'boolean': {
        if (typeof raw !== 'boolean') fail();
        columns[f.column] = raw;
        values[name] = raw as boolean;
        break;
      }
    }
  }
  if (section === 'prior-employments') {
    const from = values.fromDate as string;
    const to = values.toDate as string;
    if (to < from) throw new HttpError(422, 'INVALID_PERIOD', 'The prior employment ends before it starts', { field: 'toDate' });
    // Prior means before this employment: it ends before the joining date.
    if (to >= joiningDate) throw new HttpError(422, 'CHRONOLOGY_CONFLICT', 'A prior employment ends before this employment’s joining date', { field: 'toDate', joiningDate });
  }
  return { columns, values };
}

async function audit(tx: Queryable, grant: AccessGrant, employeeId: string, resource: string, recordKey: string, action: string, before: Record<string, unknown> | null, after: Record<string, unknown>, reason?: string) {
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource,
    recordKey,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action,
    before,
    after: { ...after, operational: { employeeId, ...((after.operational as Record<string, unknown>) ?? {}) } },
    reason: reason ?? null,
  });
}

/** The guards every section change shares: scope, the current duty after the lock, never one's own record (BR-054, I-52). */
async function beginChange(tx: Queryable, grant: AccessGrant, employeeId: string, fieldGroup: 'private' | 'payroll_id') {
  const employee = await inScope(tx, grant, employeeId);
  await lockSections(tx, grant.companyId, employeeId);
  await reassertAccess(tx, grant, 'employee', 'manage', [fieldGroup]);
  await assertNotOwnRecord(tx, grant, employeeId);
  return employee;
}

export async function addSectionEntry(tx: Queryable, grant: AccessGrant, employeeId: string, section: ListSectionKey, input: Record<string, unknown>) {
  const employee = await beginChange(tx, grant, employeeId, 'private');
  const { columns, values } = await validateEntry(tx, grant, section, input, employee.joining_date);
  const def = LIST_SECTIONS[section];
  const names = Object.keys(columns);
  const id = (
    await tx.query<{ id: string }>(
      `insert into ${def.table} (company_id, employee_id, ${names.join(', ')}, created_by, updated_by)
       values ($1, $2, ${names.map((_, i) => `$${i + 4}`).join(', ')}, $3, $3) returning id`,
      [grant.companyId, employeeId, grant.userId, ...names.map((n) => columns[n])],
    )
  ).rows[0]!.id;
  await audit(tx, grant, employeeId, def.table, id, 'CREATE', null, { private: values });
  return { id, section };
}

async function lockEntry(tx: Queryable, grant: AccessGrant, employeeId: string, section: ListSectionKey, entryId: string, expectedVersion: number) {
  const def = LIST_SECTIONS[section];
  const row = (await tx.query<{ version: number; removed_at: Date | null }>(`select version, removed_at from ${def.table} where company_id = $1 and employee_id = $2 and id = $3 for update`, [grant.companyId, employeeId, entryId])).rows[0];
  if (!row) throw notFound();
  if (row.removed_at) throw new HttpError(409, 'ENTRY_REMOVED', 'This entry was removed and is kept as it was');
  if (row.version !== expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The entry changed; reload and retry');
}

export async function updateSectionEntry(tx: Queryable, grant: AccessGrant, employeeId: string, section: ListSectionKey, entryId: string, input: Record<string, unknown> & { expectedVersion: number }) {
  const employee = await beginChange(tx, grant, employeeId, 'private');
  const { expectedVersion, ...fields } = input;
  await lockEntry(tx, grant, employeeId, section, entryId, expectedVersion);
  const { columns, values } = await validateEntry(tx, grant, section, fields, employee.joining_date);
  const def = LIST_SECTIONS[section];
  const names = Object.keys(columns);
  // The values being replaced, for the audit record (grouped as confidential, like the new ones).
  const { id: _id, version: _v, createdAt: _c, updatedAt: _u, removedAt: _r, removalReason: _rr, ...prior } = (
    await tx.query<Record<string, unknown>>(`${SECTION_SELECT[section]} where x.company_id = $1 and x.id = $2`, [grant.companyId, entryId])
  ).rows[0]!;
  const version = (
    await tx.query<{ version: number }>(
      `update ${def.table} set ${names.map((n, i) => `${n} = $${i + 4}`).join(', ')}, updated_by = $3 where company_id = $1 and id = $2 returning version`,
      [grant.companyId, entryId, grant.userId, ...names.map((n) => columns[n])],
    )
  ).rows[0]!.version;
  await audit(tx, grant, employeeId, def.table, entryId, 'UPDATE', { private: prior, operational: { version: expectedVersion } }, { private: values });
  return { id: entryId, section, version };
}

export async function removeSectionEntry(tx: Queryable, grant: AccessGrant, employeeId: string, section: ListSectionKey, entryId: string, input: { reason: string; expectedVersion: number }) {
  await beginChange(tx, grant, employeeId, 'private');
  await lockEntry(tx, grant, employeeId, section, entryId, input.expectedVersion);
  const reason = input.reason.trim();
  if (!reason) throw new HttpError(422, 'FIELD_REQUIRED', 'Say why the entry is removed', { field: 'reason' });
  const def = LIST_SECTIONS[section];
  await tx.query(`update ${def.table} set removed_at = now(), removed_by = $3, removal_reason = $4, updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, entryId, grant.userId, reason]);
  await audit(tx, grant, employeeId, def.table, entryId, 'REMOVE', null, { operational: { removed: true } }, reason);
  return { id: entryId, section, removed: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Payroll identifiers
// ---------------------------------------------------------------------------------------------------------------

const identifierBinding = (companyId: string, employeeId: string) => ({ purpose: 'employee.payroll_identifier', companyId, ownerId: employeeId, recordId: employeeId });

type Identifiers = Partial<Record<PayrollIdentifierKey, string>>;

async function storedIdentifiers(db: Queryable, companyId: string, employeeId: string, lock = false): Promise<{ values: Identifiers; version: number } | null> {
  const row = (await db.query<{ payload: string; version: number }>(`select payload, version from employee_payroll_identifier where company_id = $1 and employee_id = $2 ${lock ? 'for update' : ''}`, [companyId, employeeId])).rows[0];
  return row ? { values: openJson<Identifiers>(row.payload, identifierBinding(companyId, employeeId)), version: row.version } : null;
}

export interface IdentifierInput {
  pan?: string | null | undefined;
  uan?: string | null | undefined;
  esicIpNumber?: string | null | undefined;
  /** The version read; absent while nothing is recorded yet. */
  expectedVersion?: number | undefined;
}

/** Sets or clears payroll identifiers (null clears one; an absent key keeps it). Audit names the identifiers only. */
export async function setPayrollIdentifiers(tx: Queryable, grant: AccessGrant, employeeId: string, input: IdentifierInput) {
  await beginChange(tx, grant, employeeId, 'payroll_id');
  const current = await storedIdentifiers(tx, grant.companyId, employeeId, true);
  if ((current?.version ?? undefined) !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The identifiers changed; reload and retry');
  const next: Identifiers = { ...(current?.values ?? {}) };
  const changed: string[] = [];
  for (const key of IDENTIFIER_KEYS) {
    const raw = input[key];
    if (raw === undefined) continue;
    const def = PAYROLL_IDENTIFIERS[key];
    let value: string | undefined;
    if (raw === null || raw.trim() === '') value = undefined;
    else {
      value = raw.replace(/\s+/g, '').toUpperCase();
      // The identifier's public format only; never the value in the answer.
      if (!def.format.test(value)) throw new HttpError(422, 'INVALID_IDENTIFIER', `The ${def.label} is ${def.formatText}`, { field: key });
    }
    if (value === next[key]) continue;
    if (value === undefined) delete next[key];
    else next[key] = value;
    changed.push(def.code);
  }
  if (changed.length === 0) throw new HttpError(422, 'NO_CHANGE', 'Nothing differs from the identifiers on record');
  const identifiers = IDENTIFIER_KEYS.filter((k) => next[k] !== undefined).map((k) => PAYROLL_IDENTIFIERS[k].code);
  const payload = sealJson(next, identifierBinding(grant.companyId, employeeId));
  const version = current
    ? (await tx.query<{ version: number }>(`update employee_payroll_identifier set payload = $3, identifiers = $4, updated_by = $5 where company_id = $1 and employee_id = $2 returning version`, [grant.companyId, employeeId, payload, identifiers, grant.userId])).rows[0]!.version
    : (await tx.query<{ version: number }>(`insert into employee_payroll_identifier (company_id, employee_id, payload, identifiers, created_by, updated_by) values ($1, $2, $3, $4, $5, $5) returning version`, [grant.companyId, employeeId, payload, identifiers, grant.userId])).rows[0]!.version;
  const before = current ? { operational: { recordedIdentifiers: IDENTIFIER_KEYS.filter((k) => current.values[k] !== undefined).map((k) => PAYROLL_IDENTIFIERS[k].code) } } : null;
  await audit(tx, grant, employeeId, 'employee_payroll_identifier', employeeId, current ? 'UPDATE' : 'CREATE', before, { operational: { changedIdentifiers: changed.sort(), recordedIdentifiers: identifiers } });
  return { employeeId, recorded: identifiers, changed: changed.sort(), version };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------

const ENTRY_META = `x.id, x.version, x.created_at as "createdAt", x.updated_at as "updatedAt", x.removed_at as "removedAt", x.removal_reason as "removalReason"`;

const SECTION_SELECT: Readonly<Record<ListSectionKey, string>> = {
  'family-members': `select ${ENTRY_META}, r.code as relationship, r.label as "relationshipLabel", x.full_name as "fullName", to_char(x.date_of_birth, 'YYYY-MM-DD') as "dateOfBirth", x.dependant
                       from employee_family_member x join reference_value r on r.company_id = x.company_id and r.id = x.relationship_id`,
  qualifications: `select ${ENTRY_META}, l.code as level, l.label as "levelLabel", x.qualification, x.specialisation, x.institution, x.completion_year as "completionYear"
                     from employee_qualification x join reference_value l on l.company_id = x.company_id and l.id = x.level_id`,
  'prior-employments': `select ${ENTRY_META}, x.employer_name as "employerName", x.designation, to_char(x.from_date, 'YYYY-MM-DD') as "fromDate", to_char(x.to_date, 'YYYY-MM-DD') as "toDate"
                          from employee_prior_employment x`,
};

const SECTION_ORDER: Readonly<Record<ListSectionKey, string>> = {
  'family-members': 'x.created_at, x.id',
  qualifications: 'x.completion_year desc nulls last, x.created_at, x.id',
  'prior-employments': 'x.from_date desc, x.id',
};

/**
 * The sections the grant reads (FR-008, FR-095/098: a group the grant does not hold is absent, not blanked). The list sections
 * need employee.private; the identifiers come masked with it and in full with employee.payroll_id. Removed entries are listed
 * with their reason only when asked for.
 */
export async function recordSections(db: Queryable, grant: AccessGrant, employeeId: string, options: { includeRemoved?: boolean | undefined } = {}) {
  await inScope(db, grant, employeeId);
  const showPrivate = grant.allowedFieldGroups.includes('private');
  const showFull = grant.allowedFieldGroups.includes('payroll_id');
  const out: Record<string, unknown> = { employeeId };
  if (showPrivate) {
    for (const key of LIST_SECTION_KEYS) {
      out[key] = (
        await db.query(`${SECTION_SELECT[key]} where x.company_id = $1 and x.employee_id = $2 ${options.includeRemoved ? '' : 'and x.removed_at is null'} order by ${SECTION_ORDER[key]}`, [grant.companyId, employeeId])
      ).rows;
    }
  }
  if (showPrivate || showFull) {
    const stored = await storedIdentifiers(db, grant.companyId, employeeId);
    const values = Object.fromEntries(IDENTIFIER_KEYS.map((k) => [k, showFull ? (stored?.values[k] ?? null) : maskTail(stored?.values[k])]));
    out['payroll-identifiers'] = { values, masked: !showFull, version: stored?.version ?? null };
  }
  return out;
}

/** FR-007 export rows of one list section: active entries of the employees the employee list's filters and scope select. */
export const SECTION_EXPORT_COLUMNS: Readonly<Record<ListSectionKey, string>> = {
  'family-members': `r.label as relationship, x.full_name, to_char(x.date_of_birth, 'YYYY-MM-DD') as date_of_birth, case when x.dependant then 'yes' else 'no' end as dependant`,
  qualifications: `l.label as level, x.qualification, x.specialisation, x.institution, x.completion_year::text as completion_year`,
  'prior-employments': `x.employer_name, x.designation, to_char(x.from_date, 'YYYY-MM-DD') as from_date, to_char(x.to_date, 'YYYY-MM-DD') as to_date`,
};

export const SECTION_EXPORT_JOINS: Readonly<Record<ListSectionKey, string>> = {
  'family-members': `join employee_family_member x on x.company_id = e.company_id and x.employee_id = e.id and x.removed_at is null
                     join reference_value r on r.company_id = x.company_id and r.id = x.relationship_id`,
  qualifications: `join employee_qualification x on x.company_id = e.company_id and x.employee_id = e.id and x.removed_at is null
                   join reference_value l on l.company_id = x.company_id and l.id = x.level_id`,
  'prior-employments': `join employee_prior_employment x on x.company_id = e.company_id and x.employee_id = e.id and x.removed_at is null`,
};

export const SECTION_EXPORT_ORDER = SECTION_ORDER;
