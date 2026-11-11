// Accepted statutory file formats (batch R4; migration 0300; decided under owner delegation, 6 Nov 2026). The bank file template
// pattern (payroll-outputs/bank.ts: a definition, a generated sample, a sample validated by a second person with a reference, then
// activation), lighter: the layout is the build's (outputs.ts), so a format record is a company's statement that one output is produced
// to a named format reference from a date, bound to the hash of the synthetic sample the build rendered when it was set up.
//
//   set up (payroll_statutory_format.define)   -> AWAITING_VALIDATION
//   accepted (payroll_statutory_format.accept) -> ACCEPTED: someone other than its author validated the sample, with a reference
//   withdrawn (payroll_statutory_format.accept, with a reason) -> WITHDRAWN, from any state, for good
//
// Never edited (append-only rows; a change is a new revision), effective-dated, and every step audited. The format in force for an
// output on a day is the ACCEPTED revision with the latest start on or before it (the highest revision among those of one date); it
// applies only while the build still renders the sample it was accepted on (else FORMAT_SAMPLE_CHANGED). Company configuration: an
// unrestricted company-scope assignment.
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import type { AccessGrant } from '../access/authorize.js';
import { type FileFormat, isOutputCode, OUTPUT_CODES, OUTPUTS, type OutputCode, sampleOf } from './outputs.js';

/** An unrestricted company-scope assignment without denied scopes: company configuration and company files need one. */
export function companyWide(grant: AccessGrant): boolean {
  const { departments, locations, employees } = grant.filters;
  return grant.scopeKind === 'COMPANY' && departments.length + locations.length + employees.length === 0 && grant.deniedScopes.length === 0;
}

export function requireCompanyWide(grant: AccessGrant): void {
  if (!companyWide(grant)) throw new HttpError(403, 'COMPANY_SCOPE_REQUIRED', 'This needs an assignment with unrestricted company scope');
}

const isIsoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

function text(value: unknown, field: string, max: number, required: true): string;
function text(value: unknown, field: string, max: number, required: false): string | null;
function text(value: unknown, field: string, max: number, required: boolean): string | null {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s === '') {
    if (required) throw new HttpError(422, 'INVALID_VALUE', `${field} is required (at most ${max} characters)`, { field });
    return null;
  }
  if (s.length > max || /[\u0000-\u001f\u007f]/.test(s)) throw new HttpError(422, 'INVALID_VALUE', `${field} is at most ${max} characters on one line`, { field });
  return s;
}

async function audit(tx: Queryable, grant: AccessGrant, recordKey: string, action: string, after: Record<string, unknown>, reason?: string | null) {
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'statutory_file_format',
    recordKey,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action,
    after: { operational: after },
    reason: reason ?? null,
  });
}

export interface FormatView {
  id: string;
  outputCode: OutputCode;
  revision: number;
  formatReference: string;
  effectiveFrom: string;
  layoutVersion: number;
  sampleHash: string;
  note: string | null;
  createdAt: string;
  createdBy: string;
  state: 'AWAITING_VALIDATION' | 'ACCEPTED' | 'WITHDRAWN';
  acceptedAt: string | null;
  acceptedBy: string | null;
  validationReference: string | null;
  withdrawnAt: string | null;
  withdrawnBy: string | null;
  withdrawalReason: string | null;
}

const VIEW = `select f.id, f.output_code as "outputCode", f.revision, f.format_reference as "formatReference", to_char(f.effective_from, 'YYYY-MM-DD') as "effectiveFrom",
    f.layout_version as "layoutVersion", f.sample_hash as "sampleHash", f.note, f.created_at as "createdAt", f.created_by as "createdBy",
    case when w.id is not null then 'WITHDRAWN' when a.id is not null then 'ACCEPTED' else 'AWAITING_VALIDATION' end as state,
    a.decided_at as "acceptedAt", a.decided_by as "acceptedBy", a.reference as "validationReference",
    w.decided_at as "withdrawnAt", w.decided_by as "withdrawnBy", w.reference as "withdrawalReason"
  from statutory_file_format f
  left join statutory_file_format_decision a on a.company_id = f.company_id and a.format_id = f.id and a.decision = 'ACCEPTED'
  left join statutory_file_format_decision w on w.company_id = f.company_id and w.format_id = f.id and w.decision = 'WITHDRAWN'`;

const IN_FORCE = `a.id is not null and w.id is null and f.effective_from <= $3::date`;

/** The accepted, not withdrawn revision of an output in force on `day` (null when none is). */
export async function formatInForce(db: Queryable, companyId: string, outputCode: OutputCode, day: string): Promise<FormatView | null> {
  return (
    (await db.query<FormatView>(`${VIEW} where f.company_id = $1 and f.output_code = $2 and ${IN_FORCE} order by f.effective_from desc, f.revision desc limit 1`, [companyId, outputCode, day])).rows[0] ??
    null
  );
}

/** Every revision of every output (or of one), newest first, and per output the revision in force today and whether it still applies. */
export async function listFormats(db: Queryable, grant: AccessGrant, outputCode?: string) {
  if (outputCode !== undefined && !isOutputCode(outputCode)) throw notFound();
  const items = (
    await db.query<FormatView>(`${VIEW} where f.company_id = $1 and ($2::text is null or f.output_code = $2) order by f.output_code, f.effective_from desc, f.revision desc`, [
      grant.companyId,
      outputCode ?? null,
    ])
  ).rows;
  const codes = outputCode ? [outputCode as OutputCode] : [...OUTPUT_CODES];
  const inForce = await Promise.all(
    codes.map(async (code) => {
      const f = await formatInForce(db, grant.companyId, code, grant.businessDate);
      return { outputCode: code, format: f, sampleCurrent: f ? f.sampleHash === sampleOf(code).hash : null };
    }),
  );
  return { asOf: grant.businessDate, inForce, items };
}

async function view(db: Queryable, companyId: string, id: string): Promise<FormatView> {
  const row = (await db.query<FormatView>(`${VIEW} where f.company_id = $1 and f.id = $2`, [companyId, id])).rows[0];
  if (!row) throw notFound();
  return row;
}

export interface NewFormat {
  outputCode: string;
  formatReference: string;
  effectiveFrom: string;
  note?: string | null | undefined;
}

/** Sets a format up (the maker): the next revision of the output, bound to the build's current sample. */
export async function createFormat(tx: Queryable, grant: AccessGrant, input: NewFormat): Promise<FormatView> {
  requireCompanyWide(grant);
  if (!isOutputCode(input.outputCode)) throw new HttpError(422, 'UNKNOWN_OUTPUT', 'Not a statutory file output', { field: 'outputCode' });
  if (!isIsoDate(input.effectiveFrom)) throw new HttpError(422, 'INVALID_DATE', 'effectiveFrom must be a date (YYYY-MM-DD)', { field: 'effectiveFrom' });
  const reference = text(input.formatReference, 'formatReference', 200, true);
  const note = text(input.note, 'note', 500, false);
  const code = input.outputCode;
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`statutory_file_format:${grant.companyId}:${code}`]);
  await reassertAccess(tx, grant, 'payroll_statutory_format', 'define', ['operational']);
  const sample = sampleOf(code);
  const layoutVersion = OUTPUTS[code].layoutVersion;
  const row = (
    await tx.query<{ id: string; revision: number }>(
      `insert into statutory_file_format (company_id, output_code, revision, format_reference, effective_from, layout_version, sample_hash, note, created_by, acting_assignment_id)
       select $1, $2, coalesce(max(revision), 0) + 1, $3, $4, $5, $6, $7, $8, $9 from statutory_file_format where company_id = $1 and output_code = $2
       returning id, revision`,
      [grant.companyId, code, reference, input.effectiveFrom, layoutVersion, sample.hash, note, grant.userId, grant.assignmentId],
    )
  ).rows[0]!;
  await audit(tx, grant, row.id, 'CREATE', { outputCode: code, revision: row.revision, formatReference: reference, effectiveFrom: input.effectiveFrom, layoutVersion, sampleHash: sample.hash });
  return view(tx, grant.companyId, row.id);
}

/** The synthetic sample of a format revision as the build renders it now, and whether that is still the sample it was set up with. */
export async function formatSample(db: Queryable, grant: AccessGrant, id: string) {
  const f = await view(db, grant.companyId, id);
  const sample = sampleOf(f.outputCode);
  return {
    label: 'SAMPLE_NOT_FOR_FILING',
    formatId: f.id,
    outputCode: f.outputCode,
    revision: f.revision,
    layoutVersion: OUTPUTS[f.outputCode].layoutVersion,
    sampleHash: sample.hash,
    recordedSampleHash: f.sampleHash,
    matchesRecorded: sample.hash === f.sampleHash,
    files: sample.files.map((file) => ({ format: file.format, fileName: file.fileName, mediaType: file.mediaType, ...(file.format === 'xlsx' ? {} : { content: file.bytes.toString('utf8') }) })),
  };
}

export async function formatSampleFile(db: Queryable, grant: AccessGrant, id: string, format: FileFormat): Promise<{ fileName: string; mediaType: string; bytes: Buffer }> {
  const f = await view(db, grant.companyId, id);
  const file = sampleOf(f.outputCode).files.find((x) => x.format === format);
  if (!file) throw notFound();
  return { fileName: file.fileName, mediaType: file.mediaType, bytes: file.bytes };
}

/**
 * The checker's acceptance: someone other than the format's author, who validated this sample (the hash they were shown) against the
 * portal's validator or the published specification, records their reference. The database refuses the author and another sample too.
 */
export async function acceptFormat(tx: Queryable, grant: AccessGrant, id: string, input: { sampleHash: string; validationReference: string }): Promise<FormatView> {
  requireCompanyWide(grant);
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`statutory_file_format_decision:${grant.companyId}:${id}`]);
  await reassertAccess(tx, grant, 'payroll_statutory_format', 'accept', ['operational']);
  const f = await view(tx, grant.companyId, id);
  if (f.state !== 'AWAITING_VALIDATION') throw new HttpError(409, 'INVALID_STATE', 'Only a format awaiting validation is accepted', { state: f.state });
  if (f.createdBy === grant.userId) throw new HttpError(403, 'NOT_INDEPENDENT', 'The person who set a format up does not validate its sample');
  const reference = text(input.validationReference, 'validationReference', 500, true);
  if (sampleOf(f.outputCode).hash !== f.sampleHash) {
    throw new HttpError(409, 'SAMPLE_CHANGED', 'This build renders a different sample than the format was set up with; set up a new revision and validate its sample');
  }
  if (input.sampleHash !== f.sampleHash) throw new HttpError(409, 'SAMPLE_MISMATCH', 'The validated sample is not the sample of this format revision');
  await tx.query(
    `insert into statutory_file_format_decision (company_id, format_id, decision, sample_hash, reference, decided_by, acting_assignment_id) values ($1, $2, 'ACCEPTED', $3, $4, $5, $6)`,
    [grant.companyId, id, f.sampleHash, reference, grant.userId, grant.assignmentId],
  );
  await audit(tx, grant, id, 'ACCEPT', { outputCode: f.outputCode, revision: f.revision, sampleHash: f.sampleHash, validationReference: reference });
  return view(tx, grant.companyId, id);
}

/** Withdraws a revision (accepted or not) for good, with a reason; an earlier accepted revision, if any, is in force again. */
export async function withdrawFormat(tx: Queryable, grant: AccessGrant, id: string, input: { reason: string }): Promise<FormatView> {
  requireCompanyWide(grant);
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`statutory_file_format_decision:${grant.companyId}:${id}`]);
  await reassertAccess(tx, grant, 'payroll_statutory_format', 'accept', ['operational']);
  const f = await view(tx, grant.companyId, id);
  if (f.state === 'WITHDRAWN') throw new HttpError(409, 'INVALID_STATE', 'The format is already withdrawn');
  const reason = text(input.reason, 'reason', 500, true);
  await tx.query(`insert into statutory_file_format_decision (company_id, format_id, decision, reference, decided_by, acting_assignment_id) values ($1, $2, 'WITHDRAWN', $3, $4, $5)`, [
    grant.companyId,
    id,
    reason,
    grant.userId,
    grant.assignmentId,
  ]);
  await audit(tx, grant, id, 'WITHDRAW', { outputCode: f.outputCode, revision: f.revision, priorState: f.state }, reason);
  return view(tx, grant.companyId, id);
}
