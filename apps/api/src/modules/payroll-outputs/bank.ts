// Bank files and the salary payment ledger (FR-102; DB112-DB114; DB118; H2 payroll journey and payment states;
// BR-052; CI27; CI28; DF07 outcome-ledger rules; H8 "accepted bank-format contract, independent validated sample").
//
// Journey: processed run (PROCESSED_LOCKED) -> non-payable draft preview (computed, never stored) -> final manifest
// prepared (VALIDATED: every row validated against the active template and the frozen approved bank revisions,
// count/currency/total reconciled; nothing reserved) -> independent authorisation (AUTHORIZED: the manifest is
// recomputed under the record locks and must be unchanged, then every line is RESERVED atomically) -> restricted file
// generated on first download (ISSUED, content hash fixed; the stored file is sealed, so clear bank values never
// rest outside an envelope) -> outcomes recorded line by line from external evidence by an independent Admin.
// Nothing here pays anything or marks anything paid: only a CONFIRMED event with its evidence does (DF07).
//
// Allocations. For each frozen payable record, available = net - live holds - pending reservations - net confirmed.
// The amount of each released hold that is not yet reserved or paid is its own allocation (H2: "release creates a
// new payment allocation"; key REL-<hold>-<n>, linked to the hold); the rest of the available amount is the record's
// allocation (PAY-<record>-<n>). A held amount is never included before its release, and a pending or confirmed
// allocation is never repeated: only a definitive FAILED or CANCELLED outcome (or a reversal) frees capacity for a
// replacement manifest, which is again independently authorised (BR-052).
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { openJson, sealJson } from '../../security/field-crypto.js';
import type { FileStore } from '../../storage/files.js';
import type { AccessGrant } from '../access/authorize.js';
import { actorOf, advisoryLock, assertInScope, assertNotSelf, audit, checkAmount, optionalKey, requireCompanyScope, requireRunScope, requireText } from '../payroll/common.js';
import { canonical, checkDefinition, type FormatDefinition, render, type RenderLine, type RowError, sampleFile, sha256 } from './bankformat.js';

const LIVE_HOLDS = ['PROPOSED', 'APPROVED_ACTIVE', 'EXPIRED_REVIEW'];
const PENDING = ['RESERVED', 'SUBMITTED', 'UNKNOWN'];
/** Lines listed per page (an engineering bound). */
const PAGE = 500;

/** Production refuses synthetic test-only templates (FR-102 brief; H8). */
export const isProduction = (): boolean => process.env.NODE_ENV === 'production';

const stale = (): never => {
  throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
};

const bankBinding = (companyId: string, employeeId: string, revisionId: string) => ({ purpose: 'private_profile.revision', companyId, ownerId: employeeId, recordId: revisionId });
const fileBinding = (companyId: string, batchId: string) => ({ purpose: 'payroll_bank.file', companyId, ownerId: batchId, recordId: batchId });

/** Whether the user is or was linked to any of the employees (C4: nobody prepares, authorises or confirms their own pay). */
async function linkedToAny(db: Queryable, companyId: string, userId: string, employeeIds: readonly string[]): Promise<boolean> {
  if (employeeIds.length === 0) return false;
  const r = await db.query(`select 1 from user_employee_link where company_id = $1 and user_id = $2 and employee_id = any($3::uuid[]) limit 1`, [companyId, userId, employeeIds]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * C4 / H2 / DF07 ("the entitlement approver cannot release its payment"; preparer, reviewer, approver and releaser
 * distinct): whoever created, calculated, reviewed or approved the payroll run (the core's run deciders, as for hold
 * decisions), or approved any of its approval or record-cover tasks, never authorises the release of its payments or
 * records their outcomes; nor does the delegator of such an approval a delegate took in their name (I-57 item 7).
 */
async function assertNotRunActor(db: Queryable, companyId: string, runId: string, userId: string): Promise<void> {
  const r = (
    await db.query<{ involved: boolean }>(
      `select exists (select 1 from payroll_run r where r.company_id = $1 and r.id = $2 and $3::uuid in (r.created_by, r.calculated_by, r.reviewed_by, r.approved_by))
           or exists (select 1 from approval_instance i
                        join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
                        join approval_decision d on d.company_id = t.company_id and d.task_id = t.id
                        left join delegation dl on dl.company_id = t.company_id and dl.id = t.delegation_id
                       where i.company_id = $1 and (d.actor_user_id = $3 or dl.delegator_user_id = $3) and d.decision = 'APPROVE'
                         and i.transaction_id in (select transaction_id from payroll_run where company_id = $1 and id = $2
                                                  union all select transaction_id from payroll_run_approval where company_id = $1 and run_id = $2
                                                  union all select transaction_id from payroll_record_cover where company_id = $1 and run_id = $2)) as involved`,
      [companyId, runId, userId],
    )
  ).rows[0];
  if (r?.involved) throw new HttpError(403, 'NOT_INDEPENDENT', 'The preparer, reviewer and approver of the payroll run do not release or confirm its payments');
}

// ---------------------------------------------------------------------------------------------------------------
// DB112 templates
// ---------------------------------------------------------------------------------------------------------------

const TEMPLATE_VIEW = `select id, template_code as "templateCode", template_version as "templateVersion", name, currency_code as "currencyCode",
    format_definition as "formatDefinition", definition_hash as "definitionHash", bank_specification_reference as "bankSpecificationReference",
    test_only as "testOnly", state, sample_hash as "sampleHash", sample_validation_reference as "sampleValidationReference",
    sample_validated_by as "sampleValidatedBy", sample_validated_at as "sampleValidatedAt", activated_by as "activatedBy", activated_at as "activatedAt",
    closed_at as "closedAt", close_reason as "closeReason", created_by as "createdBy", created_at as "createdAt", version
  from payroll_bank_template`;

export async function listTemplates(db: Queryable, grant: AccessGrant) {
  const rows = await db.query(`${TEMPLATE_VIEW} where company_id = $1 order by template_code, template_version desc`, [grant.companyId]);
  return { items: rows.rows };
}

export async function templateDetail(db: Queryable, grant: AccessGrant, id: string) {
  const row = (await db.query(`${TEMPLATE_VIEW} where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
  if (!row) throw notFound();
  return row;
}

export interface TemplateInput {
  templateCode: string;
  name: string;
  currencyCode: string;
  bankSpecificationReference: string;
  testOnly: boolean;
  formatDefinition: unknown;
}

export async function createTemplate(tx: Queryable, grant: AccessGrant, input: TemplateInput) {
  requireCompanyScope(grant);
  const code = input.templateCode.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(code)) throw new HttpError(422, 'INVALID_CODE', 'The template code is 2 to 40 capital letters, digits or underscores');
  const currency = input.currencyCode.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(422, 'INVALID_CURRENCY', 'The currency is an ISO 4217 code');
  const def = checkDefinition(input.formatDefinition);
  const name = requireText(input.name, 'name', 200, 'NAME_REQUIRED');
  const spec = requireText(input.bankSpecificationReference, 'bank specification reference', 500, 'BANK_SPECIFICATION_REQUIRED');
  await advisoryLock(tx, `payroll_bank_template:${grant.companyId}:${code}`);
  await reassertAccess(tx, grant, 'payroll_bank_template', 'manage', ['operational']);
  const next = (
    await tx.query<{ v: number }>(`select coalesce(max(template_version), 0) + 1 as v from payroll_bank_template where company_id = $1 and template_code = $2`, [grant.companyId, code])
  ).rows[0]!.v;
  const definitionHash = sha256(canonical(def));
  const id = (
    await tx.query<{ id: string }>(
      `insert into payroll_bank_template (company_id, template_code, template_version, name, currency_code, format_definition, definition_hash,
                                          bank_specification_reference, test_only, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) returning id`,
      [grant.companyId, code, next, name, currency, JSON.stringify(def), definitionHash, spec, input.testOnly, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, actorOf(grant), 'payroll_bank_template', id, 'CREATE', null, {
    operational: { templateCode: code, templateVersion: next, currencyCode: currency, testOnly: input.testOnly, definitionHash },
  });
  return templateDetail(tx, grant, id);
}

interface TemplateRow {
  id: string;
  template_code: string;
  template_version: number;
  currency_code: string;
  format_definition: FormatDefinition;
  test_only: boolean;
  state: string;
  sample_hash: string | null;
  created_by: string;
  version: number;
}

async function lockTemplate(tx: Queryable, companyId: string, id: string, mode: 'update' | 'share' = 'update'): Promise<TemplateRow> {
  const t = (
    await tx.query<TemplateRow>(
      `select id, template_code, template_version, currency_code, format_definition, test_only, state, sample_hash, created_by, version
         from payroll_bank_template where company_id = $1 and id = $2 for ${mode}`,
      [companyId, id],
    )
  ).rows[0];
  if (!t) throw notFound();
  return t;
}

/** The synthetic validation sample of a template (labelled not payable). */
export async function templateSample(db: Queryable, grant: AccessGrant, id: string) {
  const t = (await db.query<TemplateRow>(`select id, template_code, template_version, currency_code, format_definition, test_only, state from payroll_bank_template where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
  if (!t) throw notFound();
  const s = sampleFile(t.format_definition, t.currency_code);
  return {
    label: 'SAMPLE_NOT_PAYABLE',
    templateCode: t.template_code,
    templateVersion: t.template_version,
    fileName: `sample-${t.template_code}-v${t.template_version}.${t.format_definition.fileExtension}`,
    content: s.content,
    sampleHash: s.hash,
    errors: s.errors,
  };
}

export async function validateSample(tx: Queryable, grant: AccessGrant, id: string, input: { sampleHash: string; validationReference: string; expectedVersion: number }) {
  requireCompanyScope(grant);
  const t = await lockTemplate(tx, grant.companyId, id);
  await reassertAccess(tx, grant, 'payroll_bank_template', 'validate', ['operational']);
  if (t.version !== input.expectedVersion) stale();
  if (t.state !== 'DRAFT' || t.sample_hash) throw new HttpError(409, 'INVALID_STATE', 'Only an unvalidated draft template is sample-validated');
  if (t.created_by === grant.userId) throw new HttpError(403, 'NOT_INDEPENDENT', 'The author of a template does not validate its sample');
  const reference = requireText(input.validationReference, 'validation reference', 500, 'VALIDATION_REFERENCE_REQUIRED');
  const s = sampleFile(t.format_definition, t.currency_code);
  if (s.errors.length > 0) throw new HttpError(409, 'SAMPLE_INVALID', 'The sample cannot be rendered under this definition; create a corrected version', { errors: s.errors });
  if (s.hash !== input.sampleHash) throw new HttpError(409, 'SAMPLE_MISMATCH', 'The validated sample is not the sample of this template revision');
  await tx.query(
    `update payroll_bank_template set sample_hash = $3, sample_validation_reference = $4, sample_validated_by = $5, sample_validated_at = now(), updated_by = $5
      where company_id = $1 and id = $2`,
    [grant.companyId, id, s.hash, reference, grant.userId],
  );
  await audit(tx, actorOf(grant), 'payroll_bank_template', id, 'VALIDATE_SAMPLE', null, { operational: { sampleHash: s.hash, validationReference: reference } });
  return templateDetail(tx, grant, id);
}

export async function activateTemplate(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }) {
  requireCompanyScope(grant);
  const t = await lockTemplate(tx, grant.companyId, id);
  await advisoryLock(tx, `payroll_bank_template:${grant.companyId}:${t.template_code}`);
  await reassertAccess(tx, grant, 'payroll_bank_template', 'activate', ['operational']);
  if (t.version !== input.expectedVersion) stale();
  if (t.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft template is activated');
  if (!t.sample_hash) throw new HttpError(409, 'SAMPLE_NOT_VALIDATED', 'A template activates only after an independent sample validation');
  if (t.created_by === grant.userId) throw new HttpError(403, 'NOT_INDEPENDENT', 'The author of a template does not activate it');
  if (t.test_only && isProduction()) throw new HttpError(409, 'TEST_TEMPLATE_NOT_ACTIVATABLE', 'A synthetic test-only template is never activated in production');
  const previous = (
    await tx.query<{ id: string }>(
      `update payroll_bank_template set state = 'RETIRED', closed_by = $3, closed_at = now(), close_reason = $4, updated_by = $3
        where company_id = $1 and template_code = $2 and state = 'ACTIVE' returning id`,
      [grant.companyId, t.template_code, grant.userId, `Replaced by version ${t.template_version}`],
    )
  ).rows;
  await tx.query(`update payroll_bank_template set state = 'ACTIVE', activated_by = $3, activated_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [
    grant.companyId,
    id,
    grant.userId,
  ]);
  await audit(tx, actorOf(grant), 'payroll_bank_template', id, 'ACTIVATE', { operational: { state: 'DRAFT' } }, {
    operational: { state: 'ACTIVE', retiredTemplateIds: previous.map((p) => p.id) },
  });
  return templateDetail(tx, grant, id);
}

export async function retireTemplate(tx: Queryable, grant: AccessGrant, id: string, input: { reason: string; expectedVersion: number }) {
  requireCompanyScope(grant);
  const t = await lockTemplate(tx, grant.companyId, id);
  await reassertAccess(tx, grant, 'payroll_bank_template', 'manage', ['operational']);
  if (t.version !== input.expectedVersion) stale();
  const reason = requireText(input.reason, 'reason', 1000);
  const to = t.state === 'ACTIVE' ? 'RETIRED' : t.state === 'DRAFT' ? 'CANCELLED' : null;
  if (!to) throw new HttpError(409, 'INVALID_STATE', 'The template is already closed');
  await tx.query(`update payroll_bank_template set state = $3, closed_by = $4, closed_at = now(), close_reason = $5, updated_by = $4 where company_id = $1 and id = $2`, [
    grant.companyId,
    id,
    to,
    grant.userId,
    reason,
  ]);
  await audit(tx, actorOf(grant), 'payroll_bank_template', id, to === 'RETIRED' ? 'RETIRE' : 'CANCEL', { operational: { state: t.state } }, { operational: { state: to } }, reason);
  return templateDetail(tx, grant, id);
}

// ---------------------------------------------------------------------------------------------------------------
// Allocation planning
// ---------------------------------------------------------------------------------------------------------------

interface Candidate {
  record_id: string;
  employee_id: string;
  employee_code: string;
  currency_code: string;
  bank_status: string | null;
  bank_revision_id: string | null;
  release_bank_revision_id: string | null;
  payable: boolean;
  has_held: boolean;
  has_stop_hold: boolean;
  has_committed: boolean;
  releases: { holdId: string; amount: string }[];
  pay_amount: string;
  has_pay: boolean;
}

/** Every frozen calculated record of the run with its ledger position and allocation split, computed in numeric. */
async function candidates(db: Queryable, companyId: string, runId: string): Promise<Candidate[]> {
  return (
    await db.query<Candidate>(
      `with rec as (
         select r.id, r.employee_id, r.employee_code, r.currency_code, r.bank_status, r.bank_revision_id, r.net,
                coalesce(h.held, 0) as held, coalesce(h.stop_held, 0) as stop_held, hrms_payroll_payment_committed(r.company_id, r.id) as committed, sb.release_bank_revision_id
           from payroll_record r
           left join lateral (select sum(x.hold_amount) as held, sum(x.hold_amount) filter (where x.hold_kind = 'SALARY_STOP') as stop_held from payroll_hold x
                               where x.company_id = r.company_id and x.payroll_record_id = r.id and x.state = any($3::text[])) h on true
           left join lateral (select x.release_bank_revision_id from payroll_hold x
                               where x.company_id = r.company_id and x.payroll_record_id = r.id and x.hold_kind = 'PAYMENT_SAFETY_BLOCK' and x.state = 'RELEASED'
                               order by x.released_at desc, x.id desc limit 1) sb on true
          where r.company_id = $1 and r.run_id = $2 and r.calculation_status = 'CALCULATED' and r.frozen_at is not null
       ),
       avail as (select rec.*, greatest(rec.net - rec.held - rec.committed, 0) as available from rec),
       rel as (
         select h.id as hold_id, h.payroll_record_id, h.released_at,
                h.hold_amount - coalesce((select sum(case when l.payment_state = any($4::text[]) then l.payable_amount
                                                          when l.payment_state in ('CONFIRMED', 'REVERSED') then l.confirmed_amount - l.reversed_amount
                                                          else 0 end)
                                            from payroll_bank_line l where l.company_id = h.company_id and l.hold_id = h.id), 0) as outstanding
           from payroll_hold h where h.company_id = $1 and h.run_id = $2 and h.state = 'RELEASED'
       ),
       rel_cum as (
         select rel.*, coalesce(sum(rel.outstanding) over (partition by rel.payroll_record_id order by rel.released_at, rel.hold_id
                                                           rows between unbounded preceding and 1 preceding), 0) as before
           from rel where rel.outstanding > 0
       ),
       rel_lines as (
         select c.payroll_record_id, c.hold_id, c.released_at, least(c.outstanding, greatest(a.available - c.before, 0)) as amount
           from rel_cum c join avail a on a.id = c.payroll_record_id
       ),
       split as (
         select a.*,
                coalesce((select json_agg(json_build_object('holdId', rl.hold_id, 'amount', rl.amount::text) order by rl.released_at, rl.hold_id)
                            from rel_lines rl where rl.payroll_record_id = a.id and rl.amount > 0), '[]'::json) as releases,
                a.available - coalesce((select sum(rl.amount) from rel_lines rl where rl.payroll_record_id = a.id), 0) as pay_amount
           from avail a
       )
       select id as record_id, employee_id, employee_code, currency_code, bank_status, bank_revision_id, release_bank_revision_id,
              available > 0 as payable, held > 0 as has_held, stop_held > 0 as has_stop_hold, committed > 0 as has_committed, releases, pay_amount::text as pay_amount, pay_amount > 0 as has_pay
         from split order by employee_code, id`,
      [companyId, runId, LIVE_HOLDS, PENDING],
    )
  ).rows;
}

interface PlannedLine {
  recordId: string;
  employeeId: string;
  employeeCode: string;
  holdId: string | null;
  amount: string;
  bankRevisionId: string | null;
}

interface ExclusionSummary {
  held: number;
  /** FR-031: of `held`, the employees withheld by an approved salary stop. */
  heldBySalaryStop: number;
  reservedOrPaid: number;
  nothingPayable: number;
  excludedByPreparer: number;
  excludedEmployeeIds: string[];
  excludedEmployeeCodes: string[];
}

function plan(cands: readonly Candidate[], excluded: ReadonlySet<string>) {
  const lines: PlannedLine[] = [];
  const errors: RowError[] = [];
  const summary: ExclusionSummary = { held: 0, heldBySalaryStop: 0, reservedOrPaid: 0, nothingPayable: 0, excludedByPreparer: 0, excludedEmployeeIds: [], excludedEmployeeCodes: [] };
  for (const c of cands) {
    if (excluded.has(c.employee_id)) {
      summary.excludedByPreparer += 1;
      summary.excludedEmployeeIds.push(c.employee_id);
      summary.excludedEmployeeCodes.push(c.employee_code);
      continue;
    }
    if (!c.payable) {
      if (c.has_held) {
        summary.held += 1;
        if (c.has_stop_hold) summary.heldBySalaryStop += 1;
      } else if (c.has_committed) summary.reservedOrPaid += 1;
      else summary.nothingPayable += 1;
      continue;
    }
    // The approved instruction frozen with the record, or the one a payment safety block was released against.
    const bankRevisionId = c.bank_status === 'VERIFIED' ? c.bank_revision_id : c.release_bank_revision_id;
    if (!bankRevisionId) errors.push({ lineSequence: null, employeeCode: c.employee_code, code: 'BANK_VALUES_UNAVAILABLE', source: 'BANK_NOT_VERIFIED' });
    for (const r of c.releases) lines.push({ recordId: c.record_id, employeeId: c.employee_id, employeeCode: c.employee_code, holdId: r.holdId, amount: r.amount, bankRevisionId });
    if (c.has_pay) lines.push({ recordId: c.record_id, employeeId: c.employee_id, employeeCode: c.employee_code, holdId: null, amount: c.pay_amount, bankRevisionId });
  }
  return { lines, errors, summary };
}

const manifestHash = (runId: string, templateId: string, lines: readonly PlannedLine[]) =>
  sha256(canonical({ runId, templateId, lines: lines.map((l) => [l.recordId, l.holdId, l.amount, l.bankRevisionId]) }));

/** The approved bank values of the revisions, opened in memory only (null when a revision cannot be opened). */
async function bankValues(db: Queryable, companyId: string, revisionIds: readonly string[]): Promise<Map<string, RenderLine['bank']>> {
  const out = new Map<string, RenderLine['bank']>();
  const ids = [...new Set(revisionIds)];
  if (ids.length === 0) return out;
  const rows = (await db.query<{ id: string; employee_id: string; payload: string }>(`select id, employee_id, payload from employee_private_profile_revision where company_id = $1 and id = any($2::uuid[])`, [companyId, ids])).rows;
  for (const r of rows) {
    try {
      out.set(r.id, openJson<Record<string, unknown>>(r.payload, bankBinding(companyId, r.employee_id, r.id)));
    } catch {
      out.set(r.id, null);
    }
  }
  return out;
}

interface RunRow {
  id: string;
  state: string;
  currency_code: string;
  currency_minor_unit: number;
  payment_date: string;
  period_code: string;
  revision: number;
  lock_version: number | null;
}

async function runOf(db: Queryable, companyId: string, runId: string): Promise<RunRow> {
  const r = (
    await db.query<RunRow>(
      `select r.id, r.state, r.currency_code, r.currency_minor_unit, to_char(r.payment_date, 'YYYY-MM-DD') as payment_date, p.period_code, r.revision, r.lock_version
         from payroll_run r join payroll_period p on p.company_id = r.company_id and p.id = r.period_id where r.company_id = $1 and r.id = $2`,
      [companyId, runId],
    )
  ).rows[0];
  if (!r) throw notFound();
  return r;
}

/** Allocation keys continue each logical allocation's sequence (keys are never reused, H5). */
async function assignKeys(db: Queryable, companyId: string, runId: string, lines: readonly PlannedLine[]): Promise<string[]> {
  const used = new Map<string, number>();
  for (const r of (await db.query<{ k: string }>(`select allocation_key as k from payroll_bank_line where company_id = $1 and run_id = $2`, [companyId, runId])).rows) {
    const prefix = r.k.slice(0, r.k.lastIndexOf('-'));
    used.set(prefix, Math.max(used.get(prefix) ?? 0, Number(r.k.slice(r.k.lastIndexOf('-') + 1))));
  }
  return lines.map((l) => {
    const prefix = l.holdId ? `REL-${l.holdId}` : `PAY-${l.recordId}`;
    const n = (used.get(prefix) ?? 0) + 1;
    used.set(prefix, n);
    return `${prefix}-${n}`;
  });
}

const sumAmounts = async (db: Queryable, amounts: readonly string[]) =>
  (await db.query<{ t: string }>(`select coalesce(sum(x), 0)::text as t from unnest($1::numeric[]) x`, [amounts])).rows[0]!.t;

async function checkExclusions(db: Queryable, companyId: string, runId: string, ids: readonly string[] | undefined, reason: string | undefined) {
  const excluded = new Set(ids ?? []);
  if (excluded.size === 0) return { excluded, reason: null as string | null };
  const text = requireText(reason, 'exclusion reason', 1000, 'EXCLUSION_REASON_REQUIRED');
  const known = (await db.query(`select 1 from payroll_record where company_id = $1 and run_id = $2 and employee_id = any($3::uuid[])`, [companyId, runId, [...excluded]])).rowCount ?? 0;
  if (known !== excluded.size) throw new HttpError(422, 'UNKNOWN_EMPLOYEE', 'Only employees of the run can be excluded');
  return { excluded, reason: text };
}

// ---------------------------------------------------------------------------------------------------------------
// Preview and manifests
// ---------------------------------------------------------------------------------------------------------------

/** The non-payable draft preview (FR-102): computed, never stored, never reserved; bank values never returned. */
export async function previewManifest(db: Queryable, grant: AccessGrant, runId: string, q: { templateId?: string | undefined }) {
  const run = await runOf(db, grant.companyId, runId);
  await requireRunScope(db, grant, runId);
  if (run.state !== 'PROCESSED_LOCKED') throw new HttpError(409, 'RUN_NOT_PROCESSED', 'Bank output uses PROCESSED_LOCKED payroll records only');
  const p = plan(await candidates(db, grant.companyId, runId), new Set());
  const errors = [...p.errors];
  if (q.templateId) {
    const t = (await db.query<TemplateRow>(`select id, currency_code, format_definition from payroll_bank_template where company_id = $1 and id = $2`, [grant.companyId, q.templateId])).rows[0];
    if (!t) throw notFound();
    const banks = await bankValues(db, grant.companyId, p.lines.flatMap((l) => (l.bankRevisionId ? [l.bankRevisionId] : [])));
    const keys = await assignKeys(db, grant.companyId, runId, p.lines);
    const total = await sumAmounts(db, p.lines.map((l) => l.amount));
    errors.push(
      ...render(
        t.format_definition,
        { batchReference: 'PREVIEW-NOT-PAYABLE', currencyCode: run.currency_code, paymentDate: run.payment_date, recordCount: p.lines.length, totalAmount: total },
        p.lines.map((l, i) => ({ lineSequence: i + 1, allocationKey: keys[i]!, employeeCode: l.employeeCode, amount: l.amount, bank: l.bankRevisionId ? (banks.get(l.bankRevisionId) ?? null) : null })),
      ).errors,
    );
  }
  return {
    label: 'NON_PAYABLE_PREVIEW',
    payable: false,
    runId,
    currencyCode: run.currency_code,
    lineCount: p.lines.length,
    totalAmount: await sumAmounts(db, p.lines.map((l) => l.amount)),
    lines: p.lines.map((l) => ({ employeeCode: l.employeeCode, kind: l.holdId ? 'HOLD_RELEASE' : 'PAYROLL_NET', holdId: l.holdId, amount: l.amount })),
    excluded: { held: p.summary.held, heldBySalaryStop: p.summary.heldBySalaryStop, reservedOrPaid: p.summary.reservedOrPaid, nothingPayable: p.summary.nothingPayable },
    errors,
  };
}

export interface PrepareInput {
  templateId: string;
  excludeEmployeeIds?: string[] | undefined;
  exclusionReason?: string | undefined;
  supersedesBatchId?: string | undefined;
}

export async function prepareManifest(tx: Queryable, grant: AccessGrant, runId: string, input: PrepareInput) {
  const run = await runOf(tx, grant.companyId, runId);
  await requireRunScope(tx, grant, runId);
  // One preparation or authorisation per run at a time.
  await advisoryLock(tx, `payroll_bank:${grant.companyId}:${runId}`);
  await reassertAccess(tx, grant, 'payroll_bank', 'prepare', ['amount']);
  if (run.state !== 'PROCESSED_LOCKED') throw new HttpError(409, 'RUN_NOT_PROCESSED', 'Bank output uses PROCESSED_LOCKED payroll records only');
  const t = await lockTemplate(tx, grant.companyId, input.templateId, 'share');
  if (t.state !== 'ACTIVE') throw new HttpError(409, 'TEMPLATE_NOT_ACTIVE', 'Final manifests use an activated, validated template');
  if (t.test_only && isProduction()) throw new HttpError(409, 'TEST_TEMPLATE_NOT_ACTIVATABLE', 'A synthetic test-only template is never used in production');
  if (t.currency_code !== run.currency_code) throw new HttpError(422, 'CURRENCY_MISMATCH', 'Different currencies use separate templates and manifests');
  const open = await tx.query(`select 1 from payroll_bank_batch where company_id = $1 and run_id = $2 and state = 'VALIDATED'`, [grant.companyId, runId]);
  if (open.rowCount) throw new HttpError(409, 'MANIFEST_OPEN', 'A prepared manifest of this run awaits authorisation; authorise or cancel it first');
  if (input.supersedesBatchId) {
    const prior = (await tx.query<{ state: string }>(`select state from payroll_bank_batch where company_id = $1 and id = $2 and run_id = $3`, [grant.companyId, input.supersedesBatchId, runId])).rows[0];
    if (!prior) throw new HttpError(422, 'INVALID_SUPERSEDED_MANIFEST', 'A replacement references an earlier manifest of the same run');
  }
  const { excluded, reason } = await checkExclusions(tx, grant.companyId, runId, input.excludeEmployeeIds, input.exclusionReason);
  const p = plan(await candidates(tx, grant.companyId, runId), excluded);
  if (await linkedToAny(tx, grant.companyId, grant.userId, [...new Set(p.lines.map((l) => l.employeeId))])) {
    throw new HttpError(403, 'SELF_INCLUDED', 'Your own salary is in this manifest; exclude it so that someone else prepares it');
  }
  if (p.lines.length === 0 && p.errors.length === 0) throw new HttpError(422, 'NOTHING_PAYABLE', 'No ready allocation remains in this run', { excluded: p.summary });
  const keys = await assignKeys(tx, grant.companyId, runId, p.lines);
  const banks = await bankValues(tx, grant.companyId, p.lines.flatMap((l) => (l.bankRevisionId ? [l.bankRevisionId] : [])));
  const total = await sumAmounts(tx, p.lines.map((l) => l.amount));
  const revision = (
    await tx.query<{ n: number }>(`select coalesce(max(batch_revision), 0) + 1 as n from payroll_bank_batch where company_id = $1 and run_id = $2 and template_id = $3`, [
      grant.companyId,
      runId,
      t.id,
    ])
  ).rows[0]!.n;
  const rendered = render(
    t.format_definition,
    { batchReference: `${run.period_code}-${t.template_code}-${revision}`, currencyCode: run.currency_code, paymentDate: run.payment_date, recordCount: p.lines.length, totalAmount: total },
    p.lines.map((l, i) => ({ lineSequence: i + 1, allocationKey: keys[i]!, employeeCode: l.employeeCode, amount: l.amount, bank: l.bankRevisionId ? (banks.get(l.bankRevisionId) ?? null) : null })),
  );
  const errors = [...p.errors, ...rendered.errors];
  if (errors.length > 0) {
    throw new HttpError(422, 'BANK_FILE_VALIDATION_FAILED', 'Some rows are not valid; no manifest was prepared. Fix them or exclude the employees with a reason', { errors });
  }
  const id = (
    await tx.query<{ id: string }>(
      `insert into payroll_bank_batch (company_id, run_id, template_id, batch_revision, supersedes_batch_id, currency_code, payment_date, state, line_count, total_amount,
                                       manifest_hash, excluded_summary, exclusion_reason, prepared_by, prepared_assignment_id, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, 'VALIDATED', $8, $9::numeric, $10, $11, $12, $13, $14, $13, $13) returning id`,
      [
        grant.companyId,
        runId,
        t.id,
        revision,
        input.supersedesBatchId ?? null,
        run.currency_code,
        run.payment_date,
        p.lines.length,
        total,
        manifestHash(runId, t.id, p.lines),
        JSON.stringify(p.summary),
        reason,
        grant.userId,
        grant.assignmentId,
      ],
    )
  ).rows[0]!.id;
  await tx.query(
    `insert into payroll_bank_line (company_id, batch_id, run_id, line_sequence, allocation_key, payroll_record_id, employee_id, hold_id, bank_revision_id,
                                    payable_amount, currency_code, created_by, updated_by)
     select $1, $2, $3, l.seq, l.k, l.record_id, l.employee_id, l.hold_id, l.bank_revision_id, l.amount, $4, $5, $5
       from unnest($6::int[], $7::text[], $8::uuid[], $9::uuid[], $10::uuid[], $11::uuid[], $12::numeric[]) as l (seq, k, record_id, employee_id, hold_id, bank_revision_id, amount)`,
    [
      grant.companyId,
      id,
      runId,
      run.currency_code,
      grant.userId,
      p.lines.map((_, i) => i + 1),
      keys,
      p.lines.map((l) => l.recordId),
      p.lines.map((l) => l.employeeId),
      p.lines.map((l) => l.holdId),
      p.lines.map((l) => l.bankRevisionId),
      p.lines.map((l) => l.amount),
    ],
  );
  await audit(
    tx,
    actorOf(grant),
    'payroll_bank_batch',
    id,
    'PREPARE',
    null,
    {
      operational: {
        runId,
        runRevision: run.revision,
        lockVersion: run.lock_version,
        templateCode: t.template_code,
        templateVersion: t.template_version,
        batchRevision: revision,
        lineCount: p.lines.length,
        held: p.summary.held,
        reservedOrPaid: p.summary.reservedOrPaid,
        excludedByPreparer: p.summary.excludedByPreparer,
      },
      amount: { total, currencyCode: run.currency_code },
    },
    reason,
  );
  return batchDetail(tx, grant, id);
}

interface BatchRow {
  id: string;
  run_id: string;
  template_id: string;
  state: string;
  prepared_by: string;
  manifest_hash: string;
  excluded_summary: ExclusionSummary;
  content_hash: string | null;
  file_attachment_id: string | null;
  file_name: string | null;
  currency_code: string;
  payment_date: string;
  batch_revision: number;
  line_count: number;
  total_amount: string;
  version: number;
}

async function lockBatch(tx: Queryable, grant: AccessGrant, batchId: string, opts: { runLock: boolean }): Promise<BatchRow> {
  const head = (await tx.query<{ run_id: string }>(`select run_id from payroll_bank_batch where company_id = $1 and id = $2`, [grant.companyId, batchId])).rows[0];
  if (!head) throw notFound();
  await requireRunScope(tx, grant, head.run_id);
  if (opts.runLock) await advisoryLock(tx, `payroll_bank:${grant.companyId}:${head.run_id}`);
  return (
    await tx.query<BatchRow>(
      `select id, run_id, template_id, state, prepared_by, manifest_hash, excluded_summary, content_hash, file_attachment_id, file_name, currency_code,
              to_char(payment_date, 'YYYY-MM-DD') as payment_date, batch_revision, line_count, total_amount::text as total_amount, version
         from payroll_bank_batch where company_id = $1 and id = $2 for update`,
      [grant.companyId, batchId],
    )
  ).rows[0]!;
}

const batchEmployees = async (db: Queryable, companyId: string, batchId: string) =>
  (await db.query<{ e: string }>(`select distinct employee_id as e from payroll_bank_line where company_id = $1 and batch_id = $2`, [companyId, batchId])).rows.map((r) => r.e);

/**
 * Independent authorisation (H2 "independently authorize final manifest and reserved allocations"; H5 "authorizing
 * creates RESERVED events atomically with its lines"; "changed hold/bank/output state invalidates draft
 * authorization"): under the run lock and every record's lock, the manifest is recomputed and must be identical.
 */
export async function authorizeManifest(tx: Queryable, grant: AccessGrant, batchId: string, input: { expectedVersion: number }) {
  const b = await lockBatch(tx, grant, batchId, { runLock: true });
  await reassertAccess(tx, grant, 'payroll_bank', 'authorize', ['amount']);
  if (b.version !== input.expectedVersion) stale();
  if (b.state !== 'VALIDATED') throw new HttpError(409, 'INVALID_STATE', 'Only a prepared manifest is authorised');
  if (b.prepared_by === grant.userId) throw new HttpError(403, 'NOT_INDEPENDENT', 'The preparer of a manifest does not authorise it');
  await assertNotRunActor(tx, grant.companyId, b.run_id, grant.userId);
  const employees = await batchEmployees(tx, grant.companyId, b.id);
  if (await linkedToAny(tx, grant.companyId, grant.userId, employees)) throw new HttpError(403, 'SELF_INCLUDED', 'Your own salary is in this manifest; someone else authorises it');
  const t = await lockTemplate(tx, grant.companyId, b.template_id, 'share');
  if (t.state !== 'ACTIVE' || (t.test_only && isProduction())) throw new HttpError(409, 'TEMPLATE_NOT_ACTIVE', 'The manifest\'s template is no longer active; cancel and prepare again');
  // The same per-record locks hold proposals take, in a fixed order (no deadlock between authorisations).
  await tx.query(
    `select pg_advisory_xact_lock(hashtextextended('payroll_record:' || r.id::text, 0))
       from (select distinct payroll_record_id as id from payroll_bank_line where company_id = $1 and batch_id = $2 order by 1) r`,
    [grant.companyId, b.id],
  );
  const p = plan(await candidates(tx, grant.companyId, b.run_id), new Set(b.excluded_summary.excludedEmployeeIds ?? []));
  if (p.errors.length > 0 || manifestHash(b.run_id, b.template_id, p.lines) !== b.manifest_hash) {
    throw new HttpError(409, 'MANIFEST_STALE', 'Holds, payments or bank instructions changed since the manifest was prepared; cancel it and prepare a new one');
  }
  await tx.query(
    `insert into payroll_payment_event (company_id, bank_line_id, sequence, event_kind, event_key, amount, currency_code, event_time, evidence_reference,
                                        recorded_by, recorded_assignment_id, created_by)
     select l.company_id, l.id, 1, 'RESERVED', 'RSV:' || l.id::text, l.payable_amount, l.currency_code, now(), 'MANIFEST_AUTHORIZATION:' || l.batch_id::text, $3, $4, $3
       from payroll_bank_line l where l.company_id = $1 and l.batch_id = $2 order by l.line_sequence`,
    [grant.companyId, b.id, grant.userId, grant.assignmentId],
  );
  await tx.query(`update payroll_bank_batch set state = 'AUTHORIZED', authorized_by = $3, authorized_assignment_id = $4, authorized_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [
    grant.companyId,
    b.id,
    grant.userId,
    grant.assignmentId,
  ]);
  await audit(tx, actorOf(grant), 'payroll_bank_batch', b.id, 'AUTHORIZE', { operational: { state: 'VALIDATED' } }, {
    operational: { state: 'AUTHORIZED', lineCount: b.line_count, manifestHash: b.manifest_hash },
    amount: { total: b.total_amount, currencyCode: b.currency_code },
  });
  return batchDetail(tx, grant, b.id);
}

export async function cancelManifest(tx: Queryable, grant: AccessGrant, batchId: string, input: { reason: string; expectedVersion: number }) {
  const b = await lockBatch(tx, grant, batchId, { runLock: true });
  await reassertAccess(tx, grant, 'payroll_bank', 'prepare', ['amount']);
  if (b.version !== input.expectedVersion) stale();
  if (b.state !== 'VALIDATED') {
    throw new HttpError(409, 'INVALID_STATE', 'An authorised manifest is not cancelled as a whole; record a definitive CANCELLED or FAILED outcome per line from evidence');
  }
  const reason = requireText(input.reason, 'reason', 1000);
  await tx.query(`update payroll_bank_batch set state = 'CANCELLED', cancelled_by = $3, cancelled_at = now(), cancel_reason = $4, updated_by = $3 where company_id = $1 and id = $2`, [
    grant.companyId,
    b.id,
    grant.userId,
    reason,
  ]);
  await tx.query(`update payroll_bank_line set payment_state = 'CANCELLED', updated_by = $3 where company_id = $1 and batch_id = $2 and payment_state = 'READY'`, [grant.companyId, b.id, grant.userId]);
  await audit(tx, actorOf(grant), 'payroll_bank_batch', b.id, 'CANCEL', { operational: { state: 'VALIDATED' } }, { operational: { state: 'CANCELLED' } }, reason);
  return batchDetail(tx, grant, b.id);
}

/**
 * The restricted file (H2 "download restricted file"). Generated once from the authorised lines and the frozen
 * approved bank revisions; stored sealed; every later download returns the same bytes, checked against the content
 * hash. Downloading never changes a payment state (FR-102).
 */
export async function issueManifest(tx: Queryable, files: FileStore, grant: AccessGrant, batchId: string) {
  const b = await lockBatch(tx, grant, batchId, { runLock: false });
  await reassertAccess(tx, grant, 'payroll_bank', 'download', ['bank']);
  if (b.state === 'ISSUED') return { ...(await batchDetail(tx, grant, b.id)), replayed: true };
  if (b.state !== 'AUTHORIZED') throw new HttpError(409, 'NOT_AUTHORIZED', 'Only an authorised manifest has a payable file; use the non-payable preview before that');
  const t = (await tx.query<TemplateRow>(`select id, template_code, template_version, currency_code, format_definition from payroll_bank_template where company_id = $1 and id = $2`, [grant.companyId, b.template_id])).rows[0]!;
  const run = await runOf(tx, grant.companyId, b.run_id);
  const lines = (
    await tx.query<{ line_sequence: number; allocation_key: string; employee_code: string; amount: string; bank_revision_id: string }>(
      `select l.line_sequence, l.allocation_key, r.employee_code, l.payable_amount::text as amount, l.bank_revision_id
         from payroll_bank_line l join payroll_record r on r.company_id = l.company_id and r.id = l.payroll_record_id
        where l.company_id = $1 and l.batch_id = $2 order by l.line_sequence`,
      [grant.companyId, b.id],
    )
  ).rows;
  const banks = await bankValues(tx, grant.companyId, lines.map((l) => l.bank_revision_id));
  const out = render(
    t.format_definition,
    { batchReference: `${run.period_code}-${t.template_code}-${b.batch_revision}`, currencyCode: b.currency_code, paymentDate: b.payment_date, recordCount: b.line_count, totalAmount: b.total_amount },
    lines.map((l) => ({ lineSequence: l.line_sequence, allocationKey: l.allocation_key, employeeCode: l.employee_code, amount: l.amount, bank: banks.get(l.bank_revision_id) ?? null })),
  );
  if (out.errors.length > 0) throw new HttpError(409, 'BANK_FILE_VALIDATION_FAILED', 'The authorised manifest can no longer be rendered', { errors: out.errors });
  const bytes = Buffer.from(out.content, 'utf8');
  const contentHash = sha256(bytes);
  const sealed = Buffer.from(sealJson({ contentBase64: bytes.toString('base64') }, fileBinding(grant.companyId, b.id)), 'utf8');
  const stored = await files.put(grant.companyId, sealed);
  const fileName = `bank-${run.period_code}-${t.template_code}-v${t.template_version}-r${b.batch_revision}.${t.format_definition.fileExtension}`;
  const attachmentId = (
    await tx.query<{ id: string }>(
      `insert into attachment (company_id, owner_user_id, employee_id, content_reference, media_type, checksum, classification, file_name, byte_size, created_by, updated_by)
       values ($1, $2, null, $3, 'application/octet-stream', $4, 'CONFIDENTIAL', $5, $6, $2, $2) returning id`,
      [grant.companyId, grant.userId, stored.reference, stored.checksum, fileName, stored.byteSize <= 10_485_760 ? stored.byteSize : null],
    )
  ).rows[0]!.id;
  await tx.query(
    `update payroll_bank_batch set state = 'ISSUED', content_hash = $3, file_attachment_id = $4, file_name = $5, issued_by = $6, issued_at = now(), updated_by = $6
      where company_id = $1 and id = $2`,
    [grant.companyId, b.id, contentHash, attachmentId, fileName, grant.userId],
  );
  await audit(tx, actorOf(grant), 'payroll_bank_batch', b.id, 'ISSUE', { operational: { state: 'AUTHORIZED' } }, { operational: { state: 'ISSUED', contentHash, fileName } });
  return { ...(await batchDetail(tx, grant, b.id)), replayed: false };
}

/** Download of the issued file: the same bytes every time, checked against the content hash; never a payment. */
export async function manifestFile(tx: Queryable, files: FileStore, grant: AccessGrant, batchId: string): Promise<{ fileName: string; mediaType: string; bytes: Buffer }> {
  const b = await lockBatch(tx, grant, batchId, { runLock: false });
  await reassertAccess(tx, grant, 'payroll_bank', 'download', ['bank']);
  if (b.state !== 'ISSUED') throw new HttpError(409, 'NOT_ISSUED', 'The file of an authorised manifest is generated by issuing it first');
  const ext = (await tx.query<{ e: string }>(`select format_definition ->> 'fileExtension' as e from payroll_bank_template where company_id = $1 and id = $2`, [grant.companyId, b.template_id])).rows[0]!.e;
  const a = (await tx.query<{ content_reference: string }>(`select content_reference from attachment where company_id = $1 and id = $2`, [grant.companyId, b.file_attachment_id])).rows[0]!;
  const sealed = (await files.get(a.content_reference)).toString('utf8');
  const bytes = Buffer.from(openJson<{ contentBase64: string }>(sealed, fileBinding(grant.companyId, b.id)).contentBase64, 'base64');
  if (sha256(bytes) !== b.content_hash) throw new HttpError(409, 'FILE_INTEGRITY_FAILED', 'The stored file does not match its recorded hash');
  await audit(tx, actorOf(grant), 'payroll_bank_batch', b.id, 'DOWNLOAD', null, { operational: { contentHash: b.content_hash } });
  return { fileName: b.file_name!, mediaType: ext === 'csv' ? 'text/csv' : 'text/plain', bytes };
}

// ---------------------------------------------------------------------------------------------------------------
// DB118 outcomes from evidence
// ---------------------------------------------------------------------------------------------------------------

export type Outcome = 'SUBMITTED' | 'UNKNOWN' | 'CONFIRMED' | 'FAILED' | 'CANCELLED';
const FROM: Record<Outcome, readonly string[]> = {
  SUBMITTED: ['RESERVED'],
  UNKNOWN: ['RESERVED', 'SUBMITTED'],
  CONFIRMED: ['RESERVED', 'SUBMITTED', 'UNKNOWN'],
  FAILED: ['RESERVED', 'SUBMITTED', 'UNKNOWN'],
  CANCELLED: ['RESERVED', 'SUBMITTED', 'UNKNOWN'],
};

export interface OutcomeInput {
  lineId: string;
  outcome: Outcome;
  eventKey: string;
  evidenceReference: string;
  eventTime?: string | undefined;
}

interface LineRow {
  id: string;
  batch_id: string;
  employee_id: string;
  payment_state: string;
  payable_amount: string;
  currency_code: string;
  last_event_sequence: number;
}

async function replayOf(tx: Queryable, companyId: string, eventKey: string, lineId: string, kind: string): Promise<boolean> {
  const prior = (await tx.query<{ bank_line_id: string; event_kind: string }>(`select bank_line_id, event_kind from payroll_payment_event where company_id = $1 and event_key = $2`, [companyId, eventKey])).rows[0];
  if (!prior) return false;
  if (prior.bank_line_id !== lineId || prior.event_kind !== kind) throw new HttpError(409, 'EVIDENCE_KEY_REUSED', 'This evidence key already recorded another outcome');
  return true;
}

/** DF07: outcomes come from evidence and are recorded by an independent eligible Admin (never the preparer or the beneficiary). */
async function assertOutcomeRecorder(tx: Queryable, grant: AccessGrant, preparedBy: string, employeeIds: readonly string[]) {
  if (preparedBy === grant.userId) throw new HttpError(403, 'NOT_INDEPENDENT', 'The preparer of a manifest does not record its outcomes');
  if (await linkedToAny(tx, grant.companyId, grant.userId, employeeIds)) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot record the outcome of your own payment');
}

export async function recordOutcomes(tx: Queryable, grant: AccessGrant, batchId: string, input: { outcomes: OutcomeInput[] }) {
  const b = await lockBatch(tx, grant, batchId, { runLock: false });
  await reassertAccess(tx, grant, 'payroll_bank', 'record_outcome', ['amount']);
  if (b.state !== 'AUTHORIZED' && b.state !== 'ISSUED') throw new HttpError(409, 'NOT_AUTHORIZED', 'Outcomes are recorded for authorised manifests only');
  await assertNotRunActor(tx, grant.companyId, b.run_id, grant.userId);
  const seen = new Set<string>();
  const results: { lineId: string; outcome: string; replayed: boolean }[] = [];
  const counts: Record<string, number> = {};
  for (const o of input.outcomes) {
    const key = optionalKey(o.eventKey);
    if (!key) throw new HttpError(422, 'EVIDENCE_KEY_REQUIRED', 'Every outcome carries its evidence key');
    if (seen.has(o.lineId)) throw new HttpError(422, 'DUPLICATE_LINE', 'A line appears once per request');
    seen.add(o.lineId);
    const evidence = requireText(o.evidenceReference, 'evidence reference', 500, 'EVIDENCE_REQUIRED');
    const l = (
      await tx.query<LineRow>(
        `select id, batch_id, employee_id, payment_state, payable_amount::text as payable_amount, currency_code, last_event_sequence
           from payroll_bank_line where company_id = $1 and batch_id = $2 and id = $3 for update`,
        [grant.companyId, b.id, o.lineId],
      )
    ).rows[0];
    if (!l) throw notFound();
    // Independence first: a replayed key never lets a non-independent caller through.
    await assertOutcomeRecorder(tx, grant, b.prepared_by, [l.employee_id]);
    if (await replayOf(tx, grant.companyId, key, o.lineId, o.outcome)) {
      results.push({ lineId: o.lineId, outcome: o.outcome, replayed: true });
      continue;
    }
    // Only an issued file can have been submitted or paid; before issue, a reservation can only be cancelled.
    if (b.state !== 'ISSUED' && o.outcome !== 'CANCELLED') {
      throw new HttpError(409, 'FILE_NOT_ISSUED', 'Only a CANCELLED outcome is recorded before the file is issued', { lineId: l.id });
    }
    if (!FROM[o.outcome].includes(l.payment_state)) {
      throw new HttpError(409, 'INVALID_TRANSITION', `A ${l.payment_state} allocation cannot become ${o.outcome}`, { lineId: l.id, paymentState: l.payment_state });
    }
    await tx.query(
      `insert into payroll_payment_event (company_id, bank_line_id, sequence, event_kind, event_key, amount, currency_code, event_time, evidence_reference,
                                          recorded_by, recorded_assignment_id, created_by)
       values ($1, $2, $3, $4, $5, $6::numeric, $7, coalesce($8::timestamptz, now()), $9, $10, $11, $10)`,
      [grant.companyId, l.id, l.last_event_sequence + 1, o.outcome, key, l.payable_amount, l.currency_code, o.eventTime ?? null, evidence, grant.userId, grant.assignmentId],
    );
    counts[o.outcome] = (counts[o.outcome] ?? 0) + 1;
    results.push({ lineId: l.id, outcome: o.outcome, replayed: false });
  }
  if (Object.keys(counts).length > 0) await audit(tx, actorOf(grant), 'payroll_bank_batch', b.id, 'RECORD_OUTCOMES', null, { operational: { outcomes: counts } });
  return { batchId: b.id, results };
}

export async function reverseLine(tx: Queryable, grant: AccessGrant, lineId: string, input: { amount: string; eventKey: string; evidenceReference: string; reason: string }) {
  const head = (await tx.query<{ batch_id: string }>(`select batch_id from payroll_bank_line where company_id = $1 and id = $2`, [grant.companyId, lineId])).rows[0];
  if (!head) throw notFound();
  const b = await lockBatch(tx, grant, head.batch_id, { runLock: false });
  await reassertAccess(tx, grant, 'payroll_bank', 'record_outcome', ['amount']);
  await assertNotRunActor(tx, grant.companyId, b.run_id, grant.userId);
  const key = optionalKey(input.eventKey);
  if (!key) throw new HttpError(422, 'EVIDENCE_KEY_REQUIRED', 'A reversal carries its evidence key');
  const l = (
    await tx.query<LineRow & { minor: number; unreversed_ok: boolean }>(
      `select l.id, l.batch_id, l.employee_id, l.payment_state, l.payable_amount::text as payable_amount, l.currency_code, l.last_event_sequence, ru.currency_minor_unit as minor,
              l.confirmed_amount - l.reversed_amount >= $3::numeric as unreversed_ok
         from payroll_bank_line l join payroll_run ru on ru.company_id = l.company_id and ru.id = l.run_id
        where l.company_id = $1 and l.id = $2 for update of l`,
      [grant.companyId, lineId, /^\d{1,15}(\.\d{1,4})?$/.test(input.amount) ? input.amount : '0'],
    )
  ).rows[0]!;
  await assertOutcomeRecorder(tx, grant, b.prepared_by, [l.employee_id]);
  // Independence first: a replayed key never lets a non-independent caller through.
  if (await replayOf(tx, grant.companyId, key, lineId, 'REVERSED')) return { lineId, replayed: true, ...(await lineView(tx, grant.companyId, lineId)) };
  const amount = checkAmount(input.amount, l.minor);
  const evidence = requireText(input.evidenceReference, 'evidence reference', 500, 'EVIDENCE_REQUIRED');
  const reason = requireText(input.reason, 'reason', 1000);
  if (l.payment_state !== 'CONFIRMED') throw new HttpError(409, 'INVALID_TRANSITION', 'Only a confirmed payment is reversed');
  if (!l.unreversed_ok) throw new HttpError(422, 'EXCEEDS_CONFIRMED', 'A reversal cannot exceed the unreversed confirmed amount');
  const confirmation = (await tx.query<{ id: string }>(`select id from payroll_payment_event where company_id = $1 and bank_line_id = $2 and event_kind = 'CONFIRMED'`, [grant.companyId, lineId])).rows[0]!;
  await tx.query(
    `insert into payroll_payment_event (company_id, bank_line_id, sequence, event_kind, event_key, amount, currency_code, event_time, evidence_reference, reverses_event_id,
                                        reason, recorded_by, recorded_assignment_id, created_by)
     values ($1, $2, $3, 'REVERSED', $4, $5::numeric, $6, now(), $7, $8, $9, $10, $11, $10)`,
    [grant.companyId, lineId, l.last_event_sequence + 1, key, amount, l.currency_code, evidence, confirmation.id, reason, grant.userId, grant.assignmentId],
  );
  await audit(tx, actorOf(grant), 'payroll_bank_line', lineId, 'REVERSE', null, { operational: { batchId: b.id }, amount: { reversed: amount, currencyCode: l.currency_code } }, reason);
  return { lineId, replayed: false, ...(await lineView(tx, grant.companyId, lineId)) };
}

async function lineView(db: Queryable, companyId: string, lineId: string) {
  return (
    await db.query<{ paymentState: string; confirmedAmount: string; reversedAmount: string }>(
      `select payment_state as "paymentState", confirmed_amount::text as "confirmedAmount", reversed_amount::text as "reversedAmount" from payroll_bank_line where company_id = $1 and id = $2`,
      [companyId, lineId],
    )
  ).rows[0]!;
}

// ---------------------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------------------

export async function batchDetail(db: Queryable, grant: AccessGrant, batchId: string) {
  const b = (
    await db.query<Record<string, unknown> & { runId: string }>(
      `select b.id, b.run_id as "runId", b.template_id as "templateId", t.template_code as "templateCode", t.template_version as "templateVersion", t.test_only as "testOnly",
              b.batch_revision as "batchRevision", b.supersedes_batch_id as "supersedesBatchId", b.currency_code as "currencyCode",
              to_char(b.payment_date, 'YYYY-MM-DD') as "paymentDate", b.state, b.line_count as "lineCount", b.total_amount::text as "totalAmount",
              b.manifest_hash as "manifestHash", b.excluded_summary as "excluded", b.prepared_by as "preparedBy", b.prepared_at as "preparedAt",
              b.authorized_by as "authorizedBy", b.authorized_at as "authorizedAt", b.content_hash as "contentHash", b.file_name as "fileName",
              b.issued_by as "issuedBy", b.issued_at as "issuedAt", b.cancelled_at as "cancelledAt", b.version
         from payroll_bank_batch b join payroll_bank_template t on t.company_id = b.company_id and t.id = b.template_id
        where b.company_id = $1 and b.id = $2`,
      [grant.companyId, batchId],
    )
  ).rows[0];
  if (!b) throw notFound();
  await requireRunScope(db, grant, b.runId);
  const states = (
    await db.query<{ paymentState: string; lines: number; amount: string; netConfirmed: string }>(
      `select payment_state as "paymentState", count(*)::int as lines, sum(payable_amount)::text as amount, sum(confirmed_amount - reversed_amount)::text as "netConfirmed"
         from payroll_bank_line where company_id = $1 and batch_id = $2 group by payment_state order by payment_state`,
      [grant.companyId, batchId],
    )
  ).rows;
  // A file or a manifest is never a payment: the outcome states above are the only payment status (DF07).
  return { ...b, ledger: states, paymentStatusSource: 'RECORDED_OUTCOME_EVIDENCE_ONLY' };
}

export async function listBatches(db: Queryable, grant: AccessGrant, runId: string) {
  await runOf(db, grant.companyId, runId);
  await requireRunScope(db, grant, runId);
  const rows = await db.query(
    `select b.id, t.template_code as "templateCode", t.template_version as "templateVersion", b.batch_revision as "batchRevision", b.state, b.line_count as "lineCount",
            b.total_amount::text as "totalAmount", b.currency_code as "currencyCode", b.prepared_at as "preparedAt", b.authorized_at as "authorizedAt", b.issued_at as "issuedAt", b.version
       from payroll_bank_batch b join payroll_bank_template t on t.company_id = b.company_id and t.id = b.template_id
      where b.company_id = $1 and b.run_id = $2 order by b.prepared_at, b.id`,
    [grant.companyId, runId],
  );
  return { items: rows.rows };
}

export async function batchLines(db: Queryable, grant: AccessGrant, batchId: string, q: { after?: number | undefined }) {
  const b = (await db.query<{ run_id: string }>(`select run_id from payroll_bank_batch where company_id = $1 and id = $2`, [grant.companyId, batchId])).rows[0];
  if (!b) throw notFound();
  await requireRunScope(db, grant, b.run_id);
  // The caller's own line is never listed in this context (H1; recordPayment below).
  const rows = (
    await db.query(
      `select l.id, l.line_sequence as "lineSequence", l.allocation_key as "allocationKey", l.payroll_record_id as "recordId", l.employee_id as "employeeId",
              r.employee_code as "employeeCode", l.hold_id as "holdId", l.bank_revision_id as "bankRevisionId", l.payable_amount::text as amount,
              l.currency_code as "currencyCode", l.payment_state as "paymentState", l.confirmed_amount::text as "confirmedAmount", l.reversed_amount::text as "reversedAmount"
         from payroll_bank_line l join payroll_record r on r.company_id = l.company_id and r.id = l.payroll_record_id
        where l.company_id = $1 and l.batch_id = $2 and l.line_sequence > $3 and l.employee_id is distinct from $5::uuid order by l.line_sequence limit $4`,
      [grant.companyId, batchId, q.after ?? 0, PAGE, grant.linkedEmployeeId],
    )
  ).rows as { lineSequence: number }[];
  return { items: rows, next: rows.length === PAGE ? rows[rows.length - 1]!.lineSequence : null };
}

/**
 * H2 "payment per allocation" for one record: earned (frozen net), held (live holds), reserved (pending), paid (net
 * confirmed) and ready, with each hold and each line and its ledger state. Never the caller's own record: an employee
 * sees their payment through the Employee context, status only for holds (H1; I-43).
 */
export async function recordPayment(db: Queryable, grant: AccessGrant, recordId: string) {
  const r = (
    await db.query<{ id: string; employee_id: string; employee_code: string; run_id: string; run_state: string; currency_code: string; earned: string | null }>(
      `select r.id, r.employee_id, r.employee_code, r.run_id, ru.state as run_state, r.currency_code, r.net::text as earned
         from payroll_record r join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id where r.company_id = $1 and r.id = $2`,
      [grant.companyId, recordId],
    )
  ).rows[0];
  if (!r) throw notFound();
  await assertInScope(db, grant, r.employee_id);
  assertNotSelf(grant, r.employee_id);
  return { record: { id: r.id, employeeId: r.employee_id, employeeCode: r.employee_code, runId: r.run_id, runState: r.run_state, currencyCode: r.currency_code }, ...(await paymentPosition(db, grant.companyId, recordId)) };
}

/** Earned, held, reserved, paid and ready amounts of a record, and its allocations (numeric arithmetic in SQL). */
export async function paymentPosition(db: Queryable, companyId: string, recordId: string) {
  const totals = (
    await db.query<{ earned: string | null; held: string; reserved: string; paid: string; ready: string }>(
      `select r.net::text as earned,
              coalesce((select sum(hold_amount) from payroll_hold h where h.company_id = r.company_id and h.payroll_record_id = r.id and h.state = any($3::text[])), 0)::numeric(19, 4)::text as held,
              coalesce((select sum(payable_amount) from payroll_bank_line l where l.company_id = r.company_id and l.payroll_record_id = r.id and l.payment_state = any($4::text[])), 0)::numeric(19, 4)::text as reserved,
              coalesce((select sum(confirmed_amount - reversed_amount) from payroll_bank_line l where l.company_id = r.company_id and l.payroll_record_id = r.id), 0)::numeric(19, 4)::text as paid,
              greatest(coalesce(r.net, 0)
                       - coalesce((select sum(hold_amount) from payroll_hold h where h.company_id = r.company_id and h.payroll_record_id = r.id and h.state = any($3::text[])), 0)
                       - hrms_payroll_payment_committed(r.company_id, r.id), 0)::numeric(19, 4)::text as ready
         from payroll_record r where r.company_id = $1 and r.id = $2`,
      [companyId, recordId, LIVE_HOLDS, PENDING],
    )
  ).rows[0]!;
  const holds = (
    await db.query(
      `select id, hold_kind as "holdKind", state, scope, hold_amount::text as amount, review_due_on as "reviewDueOn", released_at as "releasedAt"
         from payroll_hold where company_id = $1 and payroll_record_id = $2 order by proposed_at, id`,
      [companyId, recordId],
    )
  ).rows;
  const lines = (
    await db.query(
      `select l.id, l.batch_id as "batchId", l.allocation_key as "allocationKey", l.hold_id as "holdId", l.payable_amount::text as amount, l.payment_state as "paymentState",
              l.confirmed_amount::text as "confirmedAmount", l.reversed_amount::text as "reversedAmount"
         from payroll_bank_line l where l.company_id = $1 and l.payroll_record_id = $2 order by l.created_at, l.line_sequence`,
      [companyId, recordId],
    )
  ).rows;
  return { ...totals, holds, allocations: lines };
}
