// Letters (FR-017, FR-018, FR-055; DB077). Templates are versioned like process templates and may use only the
// approved placeholders below (operational employee, company and exit fields: never salary, birth date, private
// contact or other confidential values). Every placeholder a template uses is mandatory unless the template lists
// it as optional; a missing mandatory value blocks final output. A preview renders without storing or sending
// anything. A final output stores the exact rendered text as a confidential attachment with the template code and
// revision, generator, assignment and time; regenerating creates a new output. Sending is a separate explicit
// action that is not built (FR-018 recipient review and delivery status; DF09/DF12 disable confidential e-mail).
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import { type AccessGrant, canAccessEmployee } from '../access/authorize.js';
import { lockTransaction } from '../workflow/engine.js';
import { actorOf, advisoryLock, assertInScope, assertNotSelf, audit } from './common.js';

type PlaceholderDictionary = Readonly<Record<string, { source: 'EMPLOYEE' | 'COMPANY' | 'EXIT' | 'LETTER' | 'OFFER'; label: string }>>;

/** Approved letter placeholders (FR-017 "permitted employee/company placeholders"; FR-055 approved exit data). */
export const LETTER_PLACEHOLDERS: PlaceholderDictionary = {
  employeeCode: { source: 'EMPLOYEE', label: 'Employee code' },
  employeeName: { source: 'EMPLOYEE', label: 'Employee name' },
  workEmail: { source: 'EMPLOYEE', label: 'Work email' },
  joiningDate: { source: 'EMPLOYEE', label: 'Joining date' },
  confirmationDate: { source: 'EMPLOYEE', label: 'Confirmation date' },
  employmentType: { source: 'EMPLOYEE', label: 'Employment type' },
  department: { source: 'EMPLOYEE', label: 'Department' },
  designation: { source: 'EMPLOYEE', label: 'Designation' },
  location: { source: 'EMPLOYEE', label: 'Work location' },
  companyName: { source: 'COMPANY', label: 'Company name' },
  companyCode: { source: 'COMPANY', label: 'Company code' },
  resignationDate: { source: 'EXIT', label: 'Resignation date (approved exit)' },
  lastWorkingDate: { source: 'EXIT', label: 'Approved last working date (inclusive)' },
  letterDate: { source: 'LETTER', label: 'Letter date' },
};

/**
 * The placeholders of an OFFER letter template (FR-017, FR-014; decided under owner delegation, 6 Nov 2026, docs/03 I-82 item
 * 1). An offer letter is issued before the candidate is an employee, from the offer alone (hiring/offer-letter.ts): the
 * candidate, the requisition's post and the terms and compensation of the approved offer revision, never a typed value. No
 * employee or exit placeholder applies, and no other letter type may use these.
 */
export const OFFER_LETTER_PLACEHOLDERS: PlaceholderDictionary = {
  candidateName: { source: 'OFFER', label: 'Candidate name' },
  candidateCode: { source: 'OFFER', label: 'Candidate code' },
  requisitionCode: { source: 'OFFER', label: 'Requisition code' },
  jobTitle: { source: 'OFFER', label: 'Job title (requisition)' },
  department: { source: 'OFFER', label: 'Department (requisition)' },
  designation: { source: 'OFFER', label: 'Designation (requisition)' },
  location: { source: 'OFFER', label: 'Work location (requisition)' },
  employmentType: { source: 'OFFER', label: 'Employment type (requisition)' },
  proposedJoiningDate: { source: 'OFFER', label: 'Proposed joining date (approved offer)' },
  offerRevision: { source: 'OFFER', label: 'Approved offer revision' },
  currencyCode: { source: 'OFFER', label: 'Currency (approved offer)' },
  annualCtc: { source: 'OFFER', label: 'Annual CTC (approved offer)' },
  monthlyGross: { source: 'OFFER', label: 'Monthly gross (approved offer)' },
  companyName: { source: 'COMPANY', label: 'Company name' },
  companyCode: { source: 'COMPANY', label: 'Company code' },
  letterDate: { source: 'LETTER', label: 'Letter date' },
};

/** The letter type whose templates use OFFER_LETTER_PLACEHOLDERS and are issued only from an approved offer. */
export const OFFER_LETTER_TYPE = 'OFFER';

/** The approved placeholders of a letter type. */
export const placeholdersFor = (letterType: string): PlaceholderDictionary => (letterType === OFFER_LETTER_TYPE ? OFFER_LETTER_PLACEHOLDERS : LETTER_PLACEHOLDERS);

/** FR-055: the letter types generated from approved exit data. */
const EXIT_LETTER_TYPES: readonly string[] = ['RELIEVING', 'EXPERIENCE'];
/** FR-055 acceptance "the letter shows the approved employment period": mandatory in such a letter, never optional. */
const EMPLOYMENT_PERIOD: readonly string[] = ['joiningDate', 'lastWorkingDate'];

function assertEmploymentPeriod(letterType: string, placeholders: readonly string[], optional: readonly string[]): void {
  if (!EXIT_LETTER_TYPES.includes(letterType)) return;
  const absent = EMPLOYMENT_PERIOD.filter((p) => !placeholders.includes(p) || optional.includes(p));
  if (absent.length > 0) throw new HttpError(422, 'EMPLOYMENT_PERIOD_REQUIRED', 'A relieving or experience letter must show the employment period as mandatory placeholders', { placeholders: absent });
}

const TOKEN = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;
const ANY_BRACES = /\{\{[^}]*\}\}/g;

/** The placeholders a body uses; unknown or malformed placeholders (for the letter type's dictionary) are refused. */
export function parsePlaceholders(body: string, dictionary: PlaceholderDictionary = LETTER_PLACEHOLDERS): string[] {
  const malformed = (body.match(ANY_BRACES) ?? []).filter((m) => !/^\{\{\s*[a-zA-Z][a-zA-Z0-9]*\s*\}\}$/.test(m));
  if (malformed.length > 0) throw new HttpError(422, 'MALFORMED_PLACEHOLDER', 'A placeholder is malformed', { placeholders: malformed });
  const used = [...new Set([...body.matchAll(TOKEN)].map((m) => m[1]!))];
  const unknown = used.filter((p) => !Object.hasOwn(dictionary, p));
  if (unknown.length > 0) throw new HttpError(422, 'UNKNOWN_PLACEHOLDER', 'Only approved placeholders may be used', { placeholders: unknown });
  return used.sort();
}

/** Renders a body: optional placeholders without a value render empty; missing mandatory ones are reported. */
export function renderLetter(body: string, optional: readonly string[], data: Readonly<Record<string, string>>): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const text = body.replace(TOKEN, (_m, key: string) => {
    const value = data[key];
    if (value === undefined || value === '') {
      if (!optional.includes(key)) missing.add(key);
      return '';
    }
    return value;
  });
  return { text, missing: [...missing].sort() };
}

/**
 * Placeholder values for an employee process: operational employee and company fields and approved exit data. FR-017
 * "generation substitutes correct employee data": department, designation and location are those in force on the
 * process's effective date (a future joiner's first assignment starts on the joining date, so a date before it reads the
 * joining date), never those of the day the letter happens to be issued: a transfer letter issued ahead of a future-dated
 * transfer names the new post, an onboarding letter for someone not yet joined names theirs.
 */
export async function letterData(db: Queryable, companyId: string, processId: string, letterDate: string): Promise<Record<string, string>> {
  const e = (
    await db.query<{
      employee_id: string;
      exit_case_id: string | null;
      employee_code: string;
      employee_name: string;
      work_email: string | null;
      joining_date: string;
      confirmation_date: string | null;
      employment_type: string;
      company_name: string;
      company_code: string;
      department: string | null;
      designation: string | null;
      location: string | null;
    }>(
      `select p.employee_id, p.exit_case_id, e.employee_code, e.display_name as employee_name, e.work_email, to_char(e.joining_date, 'YYYY-MM-DD') as joining_date,
              to_char(e.confirmation_date, 'YYYY-MM-DD') as confirmation_date, et.label as employment_type, c.name as company_name, c.code as company_code,
              d.name as department, g.name as designation, l.name as location
         from employee_process p
         join employee e on e.company_id = p.company_id and e.id = p.employee_id
         join reference_value et on et.company_id = e.company_id and et.id = e.employment_type_id
         join company c on c.id = p.company_id
         left join lateral (select ea.department_id, ea.designation_id, ea.location_id from employment_assignment ea
                             where ea.company_id = e.company_id and ea.employee_id = e.id and ea.effective_from <= greatest(p.effective_date, e.joining_date)
                             order by ea.effective_from desc limit 1) a on true
         left join department d on d.company_id = e.company_id and d.id = a.department_id
         left join designation g on g.company_id = e.company_id and g.id = a.designation_id
         left join location l on l.company_id = e.company_id and l.id = a.location_id
        where p.company_id = $1 and p.id = $2`,
      [companyId, processId],
    )
  ).rows[0];
  if (!e) throw notFound();
  // FR-055: the approved exit of this checklist, else the employee's approved (or completed) exit; never a proposal.
  const exit = (
    await db.query<{ request_date: string; approved_leaving_date: string }>(
      `select to_char(request_date, 'YYYY-MM-DD') as request_date, to_char(approved_leaving_date, 'YYYY-MM-DD') as approved_leaving_date from exit_case
        where company_id = $1 and employee_id = $2 and state in ('APPROVED', 'SEPARATED') and ($3::uuid is null or id = $3::uuid)
        order by approved_leaving_date desc limit 1`,
      [companyId, e.employee_id, e.exit_case_id],
    )
  ).rows[0];
  const data: Record<string, string> = {
    employeeCode: e.employee_code,
    employeeName: e.employee_name,
    joiningDate: e.joining_date,
    employmentType: e.employment_type,
    companyName: e.company_name,
    companyCode: e.company_code,
    letterDate,
  };
  const optional: Record<string, string | null | undefined> = {
    workEmail: e.work_email,
    confirmationDate: e.confirmation_date,
    department: e.department,
    designation: e.designation,
    location: e.location,
    resignationDate: exit?.request_date,
    lastWorkingDate: exit?.approved_leaving_date,
  };
  for (const [k, v] of Object.entries(optional)) if (v) data[k] = v;
  return data;
}

// ---------------------------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------------------------

async function loadTemplate(db: Queryable, companyId: string, id: string, lock = false) {
  const t = (
    await db.query<{ id: string; code: string; name: string; letter_type: string; active: boolean; version: number }>(
      `select lt.id, lt.code, lt.name, ty.code as letter_type, lt.active, lt.version
         from letter_template lt join reference_value ty on ty.company_id = lt.company_id and ty.id = lt.letter_type_id
        where lt.company_id = $1 and lt.id = $2 ${lock ? 'for update of lt' : ''}`,
      [companyId, id],
    )
  ).rows[0];
  if (!t) throw notFound();
  return t;
}

export async function letterTemplateDetail(db: Queryable, grant: AccessGrant, id: string) {
  const t = await loadTemplate(db, grant.companyId, id);
  const revisions = (
    await db.query(
      `select revision, state, body, placeholders, optional_placeholders as "optionalPlaceholders", published_at as "publishedAt", version
         from letter_template_revision where company_id = $1 and template_id = $2 order by revision`,
      [grant.companyId, id],
    )
  ).rows;
  return { id: t.id, code: t.code, name: t.name, letterType: t.letter_type, active: t.active, version: t.version, revisions };
}

export async function listLetterTemplates(db: Queryable, grant: AccessGrant) {
  const rows = await db.query(
    `select lt.id, lt.code, lt.name, ty.code as "letterType", lt.active, lt.version,
            (select max(r.revision) from letter_template_revision r where r.company_id = lt.company_id and r.template_id = lt.id and r.state = 'PUBLISHED') as "publishedRevision",
            (select max(r.revision) from letter_template_revision r where r.company_id = lt.company_id and r.template_id = lt.id and r.state = 'DRAFT') as "draftRevision"
       from letter_template lt join reference_value ty on ty.company_id = lt.company_id and ty.id = lt.letter_type_id
      where lt.company_id = $1 order by lt.code`,
    [grant.companyId],
  );
  return { items: rows.rows };
}

function checkOptional(placeholders: readonly string[], optional: readonly string[]): void {
  const stray = optional.filter((p) => !placeholders.includes(p));
  if (stray.length > 0) throw new HttpError(422, 'INVALID_OPTIONAL_PLACEHOLDER', 'Optional placeholders must be used by the template', { placeholders: stray });
}

export interface LetterDraftInput {
  body: string;
  optionalPlaceholders?: string[] | undefined;
}

export async function createLetterTemplate(tx: Queryable, grant: AccessGrant, input: LetterDraftInput & { code: string; name: string; letterType: string }) {
  const type = (await tx.query<{ id: string }>(`select id from reference_value_in_force where company_id = $1 and category = 'LETTER_TYPE' and code = $2`, [grant.companyId, input.letterType])).rows[0];
  if (!type) throw new HttpError(422, 'INVALID_REFERENCE', 'Unknown letter type');
  const exists = await tx.query(`select 1 from letter_template where company_id = $1 and code = $2`, [grant.companyId, input.code]);
  if ((exists.rowCount ?? 0) > 0) throw new HttpError(409, 'TEMPLATE_CODE_EXISTS', 'A letter template with this code exists');
  const placeholders = parsePlaceholders(input.body, placeholdersFor(input.letterType));
  const optional = [...new Set(input.optionalPlaceholders ?? [])].sort();
  checkOptional(placeholders, optional);
  const id = (
    await tx.query<{ id: string }>(
      `insert into letter_template (company_id, code, name, letter_type_id, active, created_by, updated_by) values ($1, $2, $3, $4, true, $5, $5) returning id`,
      [grant.companyId, input.code, input.name.trim(), type.id, grant.userId],
    )
  ).rows[0]!.id;
  await tx.query(
    `insert into letter_template_revision (company_id, template_id, revision, state, body, placeholders, optional_placeholders, created_by, updated_by)
     values ($1, $2, 1, 'DRAFT', $3, $4, $5, $6, $6)`,
    [grant.companyId, id, input.body, placeholders, optional, grant.userId],
  );
  await audit(tx, actorOf(grant), 'letter_template', id, 'CREATE', null, { operational: { code: input.code, letterType: input.letterType, revision: 1, placeholders } });
  return letterTemplateDetail(tx, grant, id);
}

/** Saves the draft revision (opening the next one when none is being edited). */
export async function saveLetterDraft(tx: Queryable, grant: AccessGrant, id: string, input: LetterDraftInput & { expectedVersion?: number | undefined }) {
  const template = await loadTemplate(tx, grant.companyId, id, true);
  const placeholders = parsePlaceholders(input.body, placeholdersFor(template.letter_type));
  const optional = [...new Set(input.optionalPlaceholders ?? [])].sort();
  checkOptional(placeholders, optional);
  const draft = (
    await tx.query<{ id: string; revision: number; version: number }>(`select id, revision, version from letter_template_revision where company_id = $1 and template_id = $2 and state = 'DRAFT' for update`, [
      grant.companyId,
      id,
    ])
  ).rows[0];
  let revision: number;
  if (draft) {
    if (input.expectedVersion === undefined || draft.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The draft changed; reload and retry');
    await tx.query(`update letter_template_revision set body = $3, placeholders = $4, optional_placeholders = $5, updated_by = $6 where company_id = $1 and id = $2`, [
      grant.companyId,
      draft.id,
      input.body,
      placeholders,
      optional,
      grant.userId,
    ]);
    revision = draft.revision;
  } else {
    revision = (
      await tx.query<{ revision: number }>(
        `insert into letter_template_revision (company_id, template_id, revision, state, body, placeholders, optional_placeholders, created_by, updated_by)
         select $1, $2, coalesce(max(revision), 0) + 1, 'DRAFT', $3, $4, $5, $6, $6 from letter_template_revision where company_id = $1 and template_id = $2
         returning revision`,
        [grant.companyId, id, input.body, placeholders, optional, grant.userId],
      )
    ).rows[0]!.revision;
  }
  await audit(tx, actorOf(grant), 'letter_template', id, 'SAVE_DRAFT', null, { operational: { revision, placeholders } });
  return letterTemplateDetail(tx, grant, id);
}

export async function publishLetterTemplate(tx: Queryable, grant: AccessGrant, id: string, input: { revision: number; expectedVersion: number }) {
  const template = await loadTemplate(tx, grant.companyId, id, true);
  await reassertAccess(tx, grant, 'letter_template', 'manage', ['operational']);
  const draft = (
    await tx.query<{ id: string; state: string; version: number; placeholders: string[]; optional_placeholders: string[] }>(
      `select id, state, version, placeholders, optional_placeholders from letter_template_revision where company_id = $1 and template_id = $2 and revision = $3 for update`,
      [grant.companyId, id, input.revision],
    )
  ).rows[0];
  if (!draft) throw notFound();
  if (draft.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft revision can be published');
  if (draft.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The draft changed; reload and retry');
  assertEmploymentPeriod(template.letter_type, draft.placeholders, draft.optional_placeholders);
  const retired = (
    await tx.query<{ revision: number }>(
      `update letter_template_revision set state = 'RETIRED', retired_at = now(), updated_by = $3 where company_id = $1 and template_id = $2 and state = 'PUBLISHED' returning revision`,
      [grant.companyId, id, grant.userId],
    )
  ).rows[0];
  await tx.query(`update letter_template_revision set state = 'PUBLISHED', published_at = now(), published_by = $3, updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, draft.id, grant.userId]);
  await audit(tx, actorOf(grant), 'letter_template', id, 'PUBLISH', { operational: { publishedRevision: retired?.revision ?? null } }, { operational: { publishedRevision: input.revision } });
  return letterTemplateDetail(tx, grant, id);
}

export async function updateLetterTemplate(tx: Queryable, grant: AccessGrant, id: string, input: { name?: string | undefined; active?: boolean | undefined; expectedVersion: number }) {
  const t = await loadTemplate(tx, grant.companyId, id, true);
  if (t.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The template changed; reload and retry');
  const name = input.name?.trim() ?? t.name;
  const active = input.active ?? t.active;
  await tx.query(`update letter_template set name = $3, active = $4, updated_by = $5 where company_id = $1 and id = $2`, [grant.companyId, id, name, active, grant.userId]);
  await audit(tx, actorOf(grant), 'letter_template', id, 'UPDATE', { operational: { name: t.name, active: t.active } }, { operational: { name, active } });
  return letterTemplateDetail(tx, grant, id);
}

// ---------------------------------------------------------------------------------------------------------------
// Preview, final output, reading
// ---------------------------------------------------------------------------------------------------------------

/**
 * The published revision of an active template. An OFFER template is issued only from an approved offer (hiring/offer-letter.ts,
 * I-82 item 1) and an employee process uses every other type, so each side refuses the other's.
 */
export async function publishedTemplate(db: Queryable, companyId: string, code: string, issuedFrom: 'PROCESS' | 'OFFER' = 'PROCESS') {
  const t = (
    await db.query<{ template_id: string; code: string; active: boolean; letter_type: string; revision_id: string | null; revision: number | null; body: string | null; optional: string[] | null }>(
      `select lt.id as template_id, lt.code, lt.active, ty.code as letter_type, r.id as revision_id, r.revision, r.body, r.optional_placeholders as optional
         from letter_template lt join reference_value ty on ty.company_id = lt.company_id and ty.id = lt.letter_type_id
         left join letter_template_revision r on r.company_id = lt.company_id and r.template_id = lt.id and r.state = 'PUBLISHED'
        where lt.company_id = $1 and lt.code = $2`,
      [companyId, code],
    )
  ).rows[0];
  if (!t) throw new HttpError(422, 'INVALID_REFERENCE', 'Unknown letter template');
  if (!t.active) throw new HttpError(422, 'TEMPLATE_INACTIVE', 'The letter template is inactive');
  if (!t.revision_id || t.revision === null || t.body === null) throw new HttpError(422, 'TEMPLATE_NOT_PUBLISHED', 'The letter template has no published revision');
  if (issuedFrom === 'OFFER' && t.letter_type !== OFFER_LETTER_TYPE) throw new HttpError(422, 'NOT_AN_OFFER_TEMPLATE', 'An offer letter uses a template of the offer letter type');
  if (issuedFrom === 'PROCESS' && t.letter_type === OFFER_LETTER_TYPE) throw new HttpError(422, 'OFFER_TEMPLATE', 'An offer letter is issued from the approved offer in hiring, not from an employee process');
  return { templateId: t.template_id, code: t.code, letterType: t.letter_type, revisionId: t.revision_id, revision: t.revision, body: t.body, optional: t.optional ?? [] };
}

/**
 * FR-055: a relieving or experience letter comes from approved exit data. Its template must show the employment period
 * (one published before this rule is refused here too), and the exit letterData reads must exist: the process's own
 * exit for a clearance checklist, else the employee's, approved or separated. Withdrawn or merely proposed exits give
 * no last working date, so they refuse the letter, for a preview as for the final output.
 */
function assertExitLetter(t: { letterType: string; body: string; optional: readonly string[] }, data: Readonly<Record<string, string>>): void {
  if (!EXIT_LETTER_TYPES.includes(t.letterType)) return;
  assertEmploymentPeriod(t.letterType, parsePlaceholders(t.body), t.optional);
  if (!data.lastWorkingDate) throw new HttpError(409, 'EXIT_NOT_APPROVED', 'This letter needs an approved exit of the employee');
}

async function scopedProcess(db: Queryable, grant: AccessGrant, processId: string) {
  const p = (await db.query<{ employee_id: string; transaction_id: string; state: string }>(`select employee_id, transaction_id, state from employee_process where company_id = $1 and id = $2`, [grant.companyId, processId])).rows[0];
  if (!p || !(await canAccessEmployee(db, grant, p.employee_id))) throw notFound();
  assertNotSelf(grant, p.employee_id);
  return p;
}

/** FR-018: a preview renders the letter for review; it is not stored and nothing is sent. */
export async function previewLetter(db: Queryable, grant: AccessGrant, processId: string, input: { templateCode: string }) {
  const p = await scopedProcess(db, grant, processId);
  const t = await publishedTemplate(db, grant.companyId, input.templateCode);
  const data = await letterData(db, grant.companyId, processId, grant.businessDate);
  assertExitLetter(t, data);
  const { text, missing } = renderLetter(t.body, t.optional, data);
  await audit(db, actorOf(grant), 'letter_output', processId, 'PREVIEW', null, { letter: { employeeId: p.employee_id, templateCode: t.code, templateRevision: t.revision, missing } });
  return { templateCode: t.code, templateRevision: t.revision, text, missing, ready: missing.length === 0, sent: false };
}

export async function generateLetter(tx: Queryable, grant: AccessGrant, files: FileStore, processId: string, input: { templateCode: string; idempotencyKey?: string | undefined }) {
  const p0 = await scopedProcess(tx, grant, processId);
  // Serialises output numbering with the process's other changes.
  await lockTransaction(tx, p0.transaction_id);
  await reassertAccess(tx, grant, 'letter', 'generate', ['letter']);
  if (input.idempotencyKey) {
    // A retried generation (e.g. after a lost answer) returns the output stored under its key; never a second one.
    await advisoryLock(tx, `letter_output:${grant.companyId}:${input.idempotencyKey}`);
    const prior = (
      await tx.query<{
        id: string;
        employee_process_id: string;
        template_code: string;
        template_revision: number;
        output_number: number;
        generated_at: Date;
        generated_by: string;
        checksum: string;
        byte_size: number;
        delivery_state: string;
      }>(
        `select o.id, o.employee_process_id, o.template_code, o.template_revision, o.output_number, o.generated_at, o.generated_by, o.checksum, a.byte_size, o.delivery_state
           from letter_output o join attachment a on a.company_id = o.company_id and a.id = o.attachment_id
          where o.company_id = $1 and o.idempotency_key = $2`,
        [grant.companyId, input.idempotencyKey],
      )
    ).rows[0];
    if (prior) {
      if (prior.employee_process_id !== processId || prior.template_code !== input.templateCode || prior.generated_by !== grant.userId) {
        throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for another letter');
      }
      return {
        id: prior.id,
        templateCode: prior.template_code,
        templateRevision: prior.template_revision,
        outputNumber: prior.output_number,
        generatedAt: prior.generated_at,
        generatedBy: prior.generated_by,
        checksum: prior.checksum,
        byteSize: prior.byte_size,
        deliveryState: prior.delivery_state,
        replayed: true,
      };
    }
  }
  const p = (await tx.query<{ state: string; employee_code: string }>(`select p.state, e.employee_code from employee_process p join employee e on e.company_id = p.company_id and e.id = p.employee_id where p.company_id = $1 and p.id = $2`, [grant.companyId, processId])).rows[0]!;
  if (p.state === 'CANCELLED') throw new HttpError(409, 'PROCESS_CANCELLED', 'The process was cancelled');
  const t = await publishedTemplate(tx, grant.companyId, input.templateCode);
  const data = await letterData(tx, grant.companyId, processId, grant.businessDate);
  assertExitLetter(t, data);
  const { text, missing } = renderLetter(t.body, t.optional, data);
  if (missing.length > 0) throw new HttpError(422, 'MISSING_PLACEHOLDER', 'Mandatory letter values are missing', { missing });
  const bytes = Buffer.from(text, 'utf8');
  const stored = await files.put(grant.companyId, bytes);
  const outputNumber = (
    await tx.query<{ n: number }>(`select coalesce(max(output_number), 0) + 1 as n from letter_output where company_id = $1 and employee_process_id = $2 and template_id = $3`, [
      grant.companyId,
      processId,
      t.templateId,
    ])
  ).rows[0]!.n;
  const fileName = `${t.code}-${p.employee_code}-${outputNumber}.txt`.replace(/[^A-Za-z0-9._-]/g, '_');
  const attachmentId = (
    await tx.query<{ id: string }>(
      `insert into attachment (company_id, owner_user_id, employee_id, content_reference, media_type, checksum, classification, file_name, byte_size, created_by, updated_by)
       values ($1, $2, $3, $4, 'text/plain', $5, 'CONFIDENTIAL', $6, $7, $2, $2) returning id`,
      [grant.companyId, grant.userId, p0.employee_id, stored.reference, stored.checksum, fileName, stored.byteSize],
    )
  ).rows[0]!.id;
  const output = (
    await tx.query<{ id: string; generated_at: Date }>(
      `insert into letter_output (company_id, employee_id, employee_process_id, template_id, template_revision_id, template_code, template_revision, output_number,
                                  attachment_id, checksum, generated_by, generated_assignment_id, created_by, idempotency_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $11, $13) returning id, generated_at`,
      [
        grant.companyId,
        p0.employee_id,
        processId,
        t.templateId,
        t.revisionId,
        t.code,
        t.revision,
        outputNumber,
        attachmentId,
        stored.checksum,
        grant.userId,
        grant.assignmentId,
        input.idempotencyKey ?? null,
      ],
    )
  ).rows[0]!;
  await audit(tx, actorOf(grant), 'letter_output', output.id, 'GENERATE', null, {
    letter: { employeeId: p0.employee_id, processId, templateCode: t.code, templateRevision: t.revision, outputNumber, checksum: stored.checksum },
  });
  return {
    id: output.id,
    templateCode: t.code,
    templateRevision: t.revision,
    outputNumber,
    generatedAt: output.generated_at,
    generatedBy: grant.userId,
    checksum: stored.checksum,
    byteSize: stored.byteSize,
    deliveryState: 'NOT_SENT',
    replayed: false,
  };
}

/** Letters answered without page/pageSize (the list's first answer before it could page). */
export const LETTER_LIST_CAP = 200;

/** An employee's generated letters, newest first: one page (FR-056), or the first 200 without page/pageSize; `total` counts all. */
export async function listLetterOutputs(db: Queryable, grant: AccessGrant, employeeId: string, paging: Paging = {}) {
  await assertInScope(db, grant, employeeId);
  assertNotSelf(grant, employeeId);
  return pageOf(
    db,
    `select o.id, o.employee_process_id as "processId", o.template_code as "templateCode", o.template_revision as "templateRevision", o.output_number as "outputNumber",
            o.generated_at as "generatedAt", o.generated_by as "generatedBy", o.checksum, a.byte_size as "byteSize",
            -- FR-018 (I-81 item 9): sent means delivered in-app to the employee's own self-service (ess_delivery).
            case when exists (select 1 from ess_delivery d where d.company_id = o.company_id and d.letter_output_id = o.id) then 'DELIVERED_IN_APP' else o.delivery_state end as "deliveryState"
       from letter_output o join attachment a on a.company_id = o.company_id and a.id = o.attachment_id
      where o.company_id = $1 and o.employee_id = $2`,
    [grant.companyId, employeeId],
    '"generatedAt" desc, id',
    paging,
    LETTER_LIST_CAP,
  );
}

export async function letterContent(db: Queryable, grant: AccessGrant, outputId: string) {
  const o = (
    await db.query<{ employee_id: string; content_reference: string; media_type: string; file_name: string | null }>(
      `select o.employee_id, a.content_reference, a.media_type, a.file_name from letter_output o join attachment a on a.company_id = o.company_id and a.id = o.attachment_id
        where o.company_id = $1 and o.id = $2`,
      [grant.companyId, outputId],
    )
  ).rows[0];
  if (!o || !(await canAccessEmployee(db, grant, o.employee_id))) throw notFound();
  assertNotSelf(grant, o.employee_id);
  return { employeeId: o.employee_id, reference: o.content_reference, mediaType: o.media_type, fileName: o.file_name };
}
